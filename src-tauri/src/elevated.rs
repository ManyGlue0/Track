//! Administrator terminals. Windows won't let a normal process host an
//! elevated shell, so Track starts a copy of itself elevated (`track
//! --elevated-host <pipe> <token>`, one UAC prompt) and that helper runs the
//! admin shells' consoles, streaming them back over a named pipe. Scanning,
//! attention and hooks stay in Track: to it they're ordinary sessions.
//!
//! The helper ends with Track (the pipe breaks) and a minute after its last
//! shell, so it never lingers elevated on its own.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc as tmpsc;

/// The terminal may not ask for administrator rights right now (it was
/// reopened with Track): the UI offers a button instead of a surprise prompt.
pub const NEEDS_CONSENT: &str = "admin-consent";

const HELLO: u8 = b'H';
const SPAWN: u8 = b'S';
const INPUT: u8 = b'I';
const RESIZE: u8 = b'R';
const KILL: u8 = b'K';
const CLOSE: u8 = b'C';
const SPAWNED: u8 = b'P';
const OUTPUT: u8 = b'O';
const EXIT: u8 = b'X';
const EOF: u8 = b'E';

const MAX_FRAME: usize = 16 << 20;
/// How long the helper stays after its last shell (so a second admin
/// terminal shortly after doesn't ask again).
const IDLE_EXIT: Duration = Duration::from_secs(60);

// ---- wire format: [u32 length][u8 kind][payload] -----------------------------------

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(5 + payload.len());
    f.extend_from_slice(&((payload.len() + 1) as u32).to_le_bytes());
    f.push(kind);
    f.extend_from_slice(payload);
    f
}

/// A frame about one terminal: [u8 id length][id][data].
fn tagged(kind: u8, id: &str, data: &[u8]) -> Vec<u8> {
    let mut p = Vec::with_capacity(1 + id.len() + data.len());
    p.push(id.len() as u8);
    p.extend_from_slice(id.as_bytes());
    p.extend_from_slice(data);
    frame(kind, &p)
}

fn untag(p: &[u8]) -> Option<(String, &[u8])> {
    let n = *p.first()? as usize;
    let id = std::str::from_utf8(p.get(1..1 + n)?).ok()?.to_string();
    Some((id, &p[1 + n..]))
}

fn json<T: Serialize>(kind: u8, v: &T) -> Vec<u8> {
    frame(kind, &serde_json::to_vec(v).unwrap_or_default())
}

async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<(u8, Vec<u8>)> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let len = u32::from_le_bytes(len) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "bad frame"));
    }
    let kind = r.read_u8().await?;
    let mut buf = vec![0u8; len - 1];
    r.read_exact(&mut buf).await?;
    Ok((kind, buf))
}

#[derive(Serialize, Deserialize)]
struct SpawnMsg {
    id: String,
    argv: Vec<String>,
    env: Vec<(String, String)>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
}

#[derive(Serialize, Deserialize)]
struct SpawnedMsg {
    id: String,
    pid: Option<u32>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ResizeMsg {
    id: String,
    cols: u16,
    rows: u16,
}

#[derive(Serialize, Deserialize)]
struct ExitMsg {
    id: String,
    code: i64,
}

// ---- Track's side --------------------------------------------------------------------

#[derive(Default)]
struct Route {
    out: Option<mpsc::Sender<Vec<u8>>>,
    exit: Option<mpsc::Sender<i64>>,
    spawned: Option<mpsc::Sender<Result<Option<u32>, String>>>,
}

struct Conn {
    tx: tmpsc::UnboundedSender<Vec<u8>>,
    routes: Mutex<HashMap<String, Route>>,
    alive: AtomicBool,
}

impl Conn {
    fn send(&self, f: Vec<u8>) {
        let _ = self.tx.send(f);
    }

    /// The helper is gone: every admin terminal ends.
    fn lost(&self) {
        self.alive.store(false, Ordering::SeqCst);
        self.routes.lock().unwrap().clear();
    }
}

static HOST: Mutex<Option<Arc<Conn>>> = Mutex::new(None);
/// One launch at a time: two admin terminals opening together share one prompt.
static LAUNCH: Mutex<()> = Mutex::new(());

/// An admin shell, as the pieces a session is made of.
pub struct Remote {
    pub pid: Option<u32>,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub console: Box<dyn crate::pty::Console>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
    pub wait: Box<dyn FnOnce() -> i64 + Send>,
}

/// Starts `cmd` elevated. `may_ask`: a UAC prompt may appear if the helper
/// isn't running yet; otherwise this fails with [`NEEDS_CONSENT`].
pub fn spawn(id: &str, cmd: &CommandBuilder, cols: u16, rows: u16, may_ask: bool) -> Result<Remote, String> {
    let conn = connect(may_ask)?;
    let (out_tx, out_rx) = mpsc::channel();
    let (exit_tx, exit_rx) = mpsc::channel();
    let (sp_tx, sp_rx) = mpsc::channel();
    conn.routes
        .lock()
        .unwrap()
        .insert(id.to_string(), Route { out: Some(out_tx), exit: Some(exit_tx), spawned: Some(sp_tx) });
    let msg = SpawnMsg {
        id: id.to_string(),
        argv: cmd.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect(),
        env: cmd.iter_full_env_as_str().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        cwd: cmd.get_cwd().map(|c| c.to_string_lossy().into_owned()),
        cols,
        rows,
    };
    conn.send(json(SPAWN, &msg));
    let pid = match sp_rx.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(pid)) => pid,
        Ok(Err(e)) => {
            conn.routes.lock().unwrap().remove(id);
            return Err(e);
        }
        Err(_) => {
            conn.routes.lock().unwrap().remove(id);
            return Err("The administrator helper didn't answer".into());
        }
    };
    Ok(Remote {
        pid,
        reader: Box::new(PipeReader { rx: out_rx, buf: Vec::new(), pos: 0 }),
        writer: Box::new(PipeWriter { conn: conn.clone(), id: id.to_string() }),
        console: Box::new(PipeConsole { conn: conn.clone(), id: id.to_string() }),
        killer: Box::new(PipeKiller { conn, id: id.to_string() }),
        wait: Box::new(move || exit_rx.recv().unwrap_or(-1)),
    })
}

fn connect(may_ask: bool) -> Result<Arc<Conn>, String> {
    let _one = LAUNCH.lock().unwrap();
    if let Some(c) = HOST.lock().unwrap().as_ref().filter(|c| c.alive.load(Ordering::SeqCst)) {
        return Ok(c.clone());
    }
    if !may_ask {
        return Err(NEEDS_CONSENT.into());
    }
    let name = format!(r"\\.\pipe\track-admin-{}", random_hex());
    let token = random_hex();

    use tokio::net::windows::named_pipe::ServerOptions;
    let server = tauri::async_runtime::block_on(async {
        ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true).max_instances(1).create(&name)
    })
    .map_err(|e| format!("Couldn't prepare the administrator helper: {e}"))?;

    let launched = launch_elevated(&format!("--elevated-host {name} {token}"));
    // The UAC prompt takes the foreground and doesn't give it back to Track.
    // On success the helper hands it over before saying hello (below).
    if launched.is_err() {
        crate::window::take_focus_later();
    }
    launched?;

    let conn = tauri::async_runtime::block_on(async move {
        let handshake = async {
            let mut server = server;
            server.connect().await?;
            let (kind, payload) = read_frame(&mut server).await?;
            if kind != HELLO || payload != token.as_bytes() {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "unexpected helper"));
            }
            Ok::<_, io::Error>(server)
        };
        let server = match tokio::time::timeout(Duration::from_secs(30), handshake).await {
            Ok(Ok(s)) => {
                crate::window::take_focus_later();
                s
            }
            Ok(Err(e)) => return Err(format!("The administrator helper didn't connect: {e}")),
            Err(_) => return Err("The administrator helper didn't start".to_string()),
        };
        let (mut rd, mut wr) = tokio::io::split(server);
        let (tx, mut rx) = tmpsc::unbounded_channel::<Vec<u8>>();
        let conn = Arc::new(Conn { tx, routes: Mutex::new(HashMap::new()), alive: AtomicBool::new(true) });
        let c = conn.clone();
        tokio::spawn(async move {
            while let Some(f) = rx.recv().await {
                if wr.write_all(&f).await.is_err() {
                    break;
                }
            }
            c.lost();
        });
        let c = conn.clone();
        tokio::spawn(async move {
            while let Ok((kind, p)) = read_frame(&mut rd).await {
                dispatch(&c, kind, &p);
            }
            c.lost();
        });
        Ok(conn)
    })?;
    *HOST.lock().unwrap() = Some(conn.clone());
    Ok(conn)
}

fn dispatch(c: &Conn, kind: u8, p: &[u8]) {
    let mut routes = c.routes.lock().unwrap();
    match kind {
        OUTPUT => {
            if let Some((id, data)) = untag(p) {
                if let Some(out) = routes.get(&id).and_then(|r| r.out.as_ref()) {
                    let _ = out.send(data.to_vec());
                }
            }
        }
        SPAWNED => {
            if let Ok(m) = serde_json::from_slice::<SpawnedMsg>(p) {
                if let Some(tx) = routes.get_mut(&m.id).and_then(|r| r.spawned.take()) {
                    let _ = tx.send(match m.error {
                        Some(e) => Err(e),
                        None => Ok(m.pid),
                    });
                }
            }
        }
        EXIT => {
            if let Ok(m) = serde_json::from_slice::<ExitMsg>(p) {
                if let Some(tx) = routes.get_mut(&m.id).and_then(|r| r.exit.take()) {
                    let _ = tx.send(m.code);
                }
            }
        }
        EOF => {
            if let Ok(id) = std::str::from_utf8(p) {
                routes.remove(id);
            }
        }
        _ => {}
    }
}

/// Runs Track again with administrator rights (the UAC prompt).
fn launch_elevated(params: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let wide = |s: &std::ffi::OsStr| {
        use std::os::windows::ffi::OsStrExt;
        s.encode_wide().chain(Some(0)).collect::<Vec<u16>>()
    };
    // Dev builds can run the helper unelevated, to test it without a UAC prompt.
    let skip_uac = cfg!(debug_assertions) && std::env::var_os("TRACK_ADMIN_WITHOUT_UAC").is_some();
    let verb = wide(if skip_uac { "open" } else { "runas" }.as_ref());
    let file = wide(exe.as_os_str());
    let args = wide(params.as_ref());
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.hwnd = crate::window::main_hwnd() as _;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = args.as_ptr();
        info.nShow = SW_HIDE;
        if ShellExecuteExW(&mut info) == 0 {
            let err = GetLastError();
            return Err(if err == ERROR_CANCELLED {
                "Administrator rights weren't given".into()
            } else {
                format!("Couldn't start as administrator ({})", io::Error::from_raw_os_error(err as i32))
            });
        }
        if !info.hProcess.is_null() {
            CloseHandle(info.hProcess);
        }
    }
    Ok(())
}

fn random_hex() -> String {
    (0..16).map(|_| format!("{:02x}", rand::random::<u8>())).collect()
}

struct PipeReader {
    rx: mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}

impl Read for PipeReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.buf.len() {
            match self.rx.recv() {
                Ok(b) => {
                    self.buf = b;
                    self.pos = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

struct PipeWriter {
    conn: Arc<Conn>,
    id: String,
}

impl Write for PipeWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if !self.conn.alive.load(Ordering::SeqCst) {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        self.conn.send(tagged(INPUT, &self.id, buf));
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct PipeConsole {
    conn: Arc<Conn>,
    id: String,
}

impl crate::pty::Console for PipeConsole {
    fn resize(&self, cols: u16, rows: u16) {
        self.conn.send(json(RESIZE, &ResizeMsg { id: self.id.clone(), cols, rows }));
    }
}

impl Drop for PipeConsole {
    fn drop(&mut self) {
        self.conn.send(frame(CLOSE, self.id.as_bytes()));
    }
}

struct PipeKiller {
    conn: Arc<Conn>,
    id: String,
}

impl std::fmt::Debug for PipeKiller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PipeKiller({})", self.id)
    }
}

impl ChildKiller for PipeKiller {
    fn kill(&mut self) -> io::Result<()> {
        self.conn.send(frame(KILL, self.id.as_bytes()));
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(PipeKiller { conn: self.conn.clone(), id: self.id.clone() })
    }
}

// ---- the elevated helper ---------------------------------------------------------------

struct HostSession {
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

type Sessions = Arc<Mutex<HashMap<String, HostSession>>>;

/// The helper starts with the foreground the UAC prompt hands back, but has no
/// window. Lets the Track at the other end of the pipe take it instead.
fn give_back_foreground(client: &tokio::net::windows::named_pipe::NamedPipeClient) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;
    let mut pid = 0u32;
    unsafe {
        if GetNamedPipeServerProcessId(client.as_raw_handle() as _, &mut pid) != 0 {
            AllowSetForegroundWindow(pid);
        }
    }
}

/// `track --elevated-host <pipe> <token>`: serves admin shells to the Track
/// that started it, until that Track goes away.
pub fn run_host(args: &[String]) -> i32 {
    let (Some(name), Some(token)) = (args.first(), args.get(1)) else { return 2 };
    let Ok(rt) = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() else { return 1 };
    rt.block_on(host(name.clone(), token.clone()))
}

async fn host(name: String, token: String) -> i32 {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_PIPE_BUSY: i32 = 231;
    let client = loop {
        match ClientOptions::new().open(&name) {
            Ok(c) => break c,
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => tokio::time::sleep(Duration::from_millis(50)).await,
            Err(_) => return 1,
        }
    };
    give_back_foreground(&client);
    let (mut rd, mut wr) = tokio::io::split(client);
    let (tx, mut rx) = tmpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Some(f) = rx.recv().await {
            if wr.write_all(&f).await.is_err() {
                break;
            }
        }
    });
    let _ = tx.send(frame(HELLO, token.as_bytes()));

    let sessions: Sessions = Arc::default();
    // Bumped by every new shell: an idle countdown only ends the helper if
    // nothing started since.
    let generation = Arc::new(AtomicU64::new(0));

    while let Ok((kind, p)) = read_frame(&mut rd).await {
        match kind {
            SPAWN => {
                let Ok(m) = serde_json::from_slice::<SpawnMsg>(&p) else { continue };
                generation.fetch_add(1, Ordering::SeqCst);
                let id = m.id.clone();
                let reply = match host_spawn(m, &tx, &sessions, &generation) {
                    Ok(pid) => SpawnedMsg { id, pid, error: None },
                    Err(e) => SpawnedMsg { id, pid: None, error: Some(e) },
                };
                let _ = tx.send(json(SPAWNED, &reply));
            }
            INPUT => {
                if let Some((id, data)) = untag(&p) {
                    if let Some(w) = sessions.lock().unwrap().get_mut(&id).and_then(|s| s.writer.as_mut()) {
                        let _ = w.write_all(data);
                        let _ = w.flush();
                    }
                }
            }
            RESIZE => {
                if let Ok(m) = serde_json::from_slice::<ResizeMsg>(&p) {
                    if let Some(master) = sessions.lock().unwrap().get(&m.id).and_then(|s| s.master.as_ref()) {
                        let _ = master.resize(PtySize { rows: m.rows.max(2), cols: m.cols.max(10), pixel_width: 0, pixel_height: 0 });
                    }
                }
            }
            KILL | CLOSE => {
                let id = String::from_utf8_lossy(&p).into_owned();
                if let Some(s) = sessions.lock().unwrap().get_mut(&id) {
                    if kind == KILL {
                        let _ = s.killer.kill();
                    }
                    s.writer.take();
                    s.master.take();
                }
            }
            _ => {}
        }
    }

    // Track went away: its admin shells end with it.
    for (_, mut s) in sessions.lock().unwrap().drain() {
        let _ = s.killer.kill();
    }
    0
}

fn host_spawn(m: SpawnMsg, tx: &tmpsc::UnboundedSender<Vec<u8>>, sessions: &Sessions, generation: &Arc<AtomicU64>) -> Result<Option<u32>, String> {
    let mut cmd = CommandBuilder::from_argv(m.argv.into_iter().map(OsString::from).collect());
    cmd.env_clear();
    for (k, v) in m.env {
        cmd.env(k, v);
    }
    if let Some(cwd) = m.cwd {
        cmd.cwd(cwd);
    }
    let pair = native_pty_system()
        .openpty(PtySize { rows: m.rows.max(2), cols: m.cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Couldn't open a terminal: {e}"))?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("Couldn't start the shell: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let pid = child.process_id();
    let id = m.id;
    sessions
        .lock()
        .unwrap()
        .insert(id.clone(), HostSession { master: Some(pair.master), writer: Some(writer), killer: child.clone_killer() });

    let (out, all, gen, sid) = (tx.clone(), sessions.clone(), generation.clone(), id.clone());
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = out.send(tagged(OUTPUT, &sid, &buf[..n]));
                }
            }
        }
        let _ = out.send(frame(EOF, sid.as_bytes()));
        let empty = {
            let mut map = all.lock().unwrap();
            map.remove(&sid);
            map.is_empty()
        };
        if empty {
            let seen = gen.load(Ordering::SeqCst);
            std::thread::sleep(IDLE_EXIT);
            if gen.load(Ordering::SeqCst) == seen && all.lock().unwrap().is_empty() {
                std::process::exit(0);
            }
        }
    });

    let (out, all) = (tx.clone(), sessions.clone());
    std::thread::spawn(move || {
        let code = child.wait().map(|st| st.exit_code() as i64).unwrap_or(-1);
        let _ = out.send(json(EXIT, &ExitMsg { id: id.clone(), code }));
        // Let the last output drain, then close the console so the reader ends.
        std::thread::sleep(Duration::from_millis(60));
        if let Some(s) = all.lock().unwrap().get_mut(&id) {
            s.writer.take();
            s.master.take();
        }
    });
    Ok(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let f = tagged(OUTPUT, "t42", b"hello");
        let len = u32::from_le_bytes(f[..4].try_into().unwrap()) as usize;
        assert_eq!(len, f.len() - 4);
        assert_eq!(f[4], OUTPUT);
        let (id, data) = untag(&f[5..]).unwrap();
        assert_eq!(id, "t42");
        assert_eq!(data, b"hello");
    }
}
