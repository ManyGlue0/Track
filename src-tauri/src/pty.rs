//! Terminal sessions: one ConPTY per terminal, owned here so shells keep
//! running while the window is hidden (and survive a webview reload: the UI
//! reattaches by id and gets the recent output replayed).
//!
//! Output goes to the UI as raw bytes over a per-terminal channel. On the way
//! it passes through a small scanner that raises "attention" (bell, OSC
//! notifications) and tracks titles, folders and progress. The Claude Code
//! hook feeds the same attention model with precise states.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

use crate::scan::{ScanEvent, Scanner};
use crate::settings::Prefs;
use crate::shells::{self, Shells};

/// Output kept per terminal for reattaching after a reload.
const REPLAY_CAP: usize = 512 * 1024;
/// A hook report makes the scanner's bell/notify redundant for a moment
/// (Claude Code may ring the bell for the same event).
const HOOK_SHADOW: Duration = Duration::from_secs(3);
/// The same attention isn't raised twice in a row this fast (bell storms).
const REPEAT_GUARD: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    /// "bell" | "notify" | "waiting" | "done"
    pub kind: String,
    pub message: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub state: u8,
    pub value: u8,
}

/// An AI chat running in a terminal, enough to pick it up again later.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    /// "claude" | "codex"
    pub tool: String,
    pub id: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
    pub id: String,
    pub pid: Option<u32>,
    pub shell: String,
    pub shell_name: String,
    pub shell_kind: String,
    pub title: String,
    pub cwd: String,
    pub attention: Option<Attention>,
    /// What a Claude Code session in this terminal is doing: "working" between
    /// a prompt and its answer.
    pub agent: Option<String>,
    pub progress: Option<Progress>,
    pub exit_code: Option<i64>,
    /// The AI chat in front in this terminal, if any.
    pub agent_session: Option<AgentSession>,
}

/// The console a shell runs in: a local ConPTY, or one the administrator
/// helper hosts (see elevated.rs). Dropping it closes the console.
pub trait Console: Send {
    fn resize(&self, cols: u16, rows: u16);
}

struct LocalConsole(Box<dyn MasterPty + Send>);

impl Console for LocalConsole {
    fn resize(&self, cols: u16, rows: u16) {
        let _ = self.0.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 });
    }
}

struct Out {
    replay: Vec<u8>,
    sink: Option<Channel<InvokeResponseBody>>,
}

struct Session {
    info: Mutex<TermInfo>,
    master: Mutex<Option<Box<dyn Console>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    out: Mutex<Out>,
    last_hook: Mutex<Option<Instant>>,
    last_raise: Mutex<Option<(String, Instant)>>,
    /// A command to type at the first prompt (resuming a chat), and the chat it resumes.
    startup: Mutex<Option<(String, Option<AgentSession>)>>,
}

impl Session {
    fn type_line(&self, line: &str) {
        if let Some(w) = self.writer.lock().unwrap().as_mut() {
            let _ = w.write_all(format!("{line}\r").as_bytes());
            let _ = w.flush();
        }
    }
}

impl Session {
    fn output(&self, chunk: &[u8]) {
        let mut out = self.out.lock().unwrap();
        out.replay.extend_from_slice(chunk);
        if out.replay.len() > REPLAY_CAP + REPLAY_CAP / 4 {
            let cut = out.replay.len() - REPLAY_CAP;
            // Start the replay on a line boundary so it doesn't begin mid-sequence.
            let cut = out.replay[cut..].iter().position(|&b| b == b'\n').map(|p| cut + p + 1).unwrap_or(cut);
            out.replay.drain(..cut);
        }
        if let Some(sink) = &out.sink {
            if sink.send(InvokeResponseBody::Raw(chunk.to_vec())).is_err() {
                out.sink = None;
            }
        }
    }

    fn close_console(&self) {
        // Dropping the master closes the pseudoconsole: every process attached
        // to it gets CTRL_CLOSE_EVENT, and the reader sees EOF.
        self.writer.lock().unwrap().take();
        self.master.lock().unwrap().take();
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub id: String,
    pub shell: String,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// Typed at the first prompt of a fresh shell (never on reattach).
    #[serde(default)]
    pub startup: Option<String>,
    /// The chat `startup` resumes.
    #[serde(default)]
    pub resume: Option<AgentSession>,
    /// Run the shell as administrator.
    #[serde(default)]
    pub admin: bool,
    /// An admin shell may show the UAC prompt now (the user just opened it,
    /// rather than Track reopening it at start).
    #[serde(default)]
    pub ask: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub info: TermInfo,
    /// The session already existed (the UI reloaded) and its output was replayed.
    pub reattached: bool,
}

pub struct Ptys {
    app: AppHandle,
    prefs: Arc<Prefs>,
    shells: Arc<Shells>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    focused: Mutex<Option<String>>,
    /// Track is quitting: agents ending now are being closed by us, not by the user.
    shutting_down: AtomicBool,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Ptys {
    pub fn new(app: AppHandle, prefs: Arc<Prefs>, shells: Arc<Shells>) -> Arc<Self> {
        Arc::new(Self {
            app,
            prefs,
            shells,
            sessions: Mutex::new(HashMap::new()),
            focused: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
        })
    }

    fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    pub fn spawn(self: &Arc<Self>, req: SpawnRequest, sink: Channel<InvokeResponseBody>) -> Result<SpawnResult, String> {
        if let Some(existing) = self.get(&req.id) {
            if existing.info.lock().unwrap().exit_code.is_none() {
                let mut out = existing.out.lock().unwrap();
                if !out.replay.is_empty() {
                    let _ = sink.send(InvokeResponseBody::Raw(out.replay.clone()));
                }
                out.sink = Some(sink);
                drop(out);
                self.resize(&req.id, req.cols, req.rows);
                return Ok(SpawnResult { info: existing.info.lock().unwrap().clone(), reattached: true });
            }
            self.sessions.lock().unwrap().remove(&req.id);
        }

        let settings = self.prefs.get();
        let shell = self
            .shells
            .resolve(&req.shell, &settings.default_shell)
            .ok_or_else(|| "No shell found on this PC".to_string())?;
        let cwd = req
            .cwd
            .as_deref()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from));

        let cmd = shells::command(shells::Launch {
            shell: &shell,
            cwd: cwd.as_deref(),
            integration: settings.shell_integration,
            term_id: &req.id,
            port: crate::holster::port(),
        });
        let (pid, reader, writer, console, killer, wait) = if req.admin {
            let r = crate::elevated::spawn(&req.id, &cmd, req.cols.max(10), req.rows.max(2), req.ask)?;
            (r.pid, r.reader, r.writer, r.console, r.killer, r.wait)
        } else {
            let pair = native_pty_system()
                .openpty(PtySize { rows: req.rows.max(2), cols: req.cols.max(10), pixel_width: 0, pixel_height: 0 })
                .map_err(|e| format!("Couldn't open a terminal: {e}"))?;
            let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("Couldn't start {}: {e}", shell.name))?;
            drop(pair.slave);
            let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
            let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
            let killer = child.clone_killer();
            let pid = child.process_id();
            let wait: Box<dyn FnOnce() -> i64 + Send> = Box::new(move || child.wait().map(|st| st.exit_code() as i64).unwrap_or(-1));
            (pid, reader, writer, Box::new(LocalConsole(pair.master)) as Box<dyn Console>, killer, wait)
        };

        let info = TermInfo {
            id: req.id.clone(),
            pid,
            shell: shell.id.clone(),
            shell_name: shell.name.clone(),
            shell_kind: shell.kind.clone(),
            cwd: cwd.map(|p| p.display().to_string()).unwrap_or_default(),
            ..Default::default()
        };
        let session = Arc::new(Session {
            info: Mutex::new(info.clone()),
            master: Mutex::new(Some(console)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(killer),
            out: Mutex::new(Out { replay: Vec::new(), sink: Some(sink) }),
            last_hook: Mutex::new(None),
            last_raise: Mutex::new(None),
            startup: Mutex::new(req.startup.clone().filter(|c| !c.trim().is_empty()).map(|c| (c, req.resume.clone()))),
        });
        self.sessions.lock().unwrap().insert(req.id.clone(), session.clone());

        // Reader: pump output to the UI and the scanner until EOF.
        let me = self.clone();
        let s = session.clone();
        std::thread::Builder::new()
            .name(format!("pty-read-{}", req.id))
            .spawn(move || {
                let mut reader = reader;
                let mut buf = vec![0u8; 64 * 1024];
                let mut scanner = Scanner::default();
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let chunk = &buf[..n];
                            let events = scanner.feed(chunk);
                            s.output(chunk);
                            if !events.is_empty() {
                                me.apply_scan(&s, events);
                            }
                        }
                    }
                }
                me.finish(&s);
            })
            .map_err(|e| e.to_string())?;

        // The startup command waits for the shell's first prompt (shell
        // integration reports it). Without integration, or if the prompt never
        // reports, it goes after a moment anyway.
        if session.startup.lock().unwrap().is_some() {
            let me = self.clone();
            let s = session.clone();
            let integrated = settings.shell_integration && shell.kind != "wsl";
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(if integrated { 6000 } else { 1500 }));
                me.run_startup(&s);
            });
        }

        // Waiter: when the shell exits, close the console so the reader ends.
        let s = session.clone();
        std::thread::Builder::new()
            .name(format!("pty-wait-{}", req.id))
            .spawn(move || {
                let code = wait();
                s.info.lock().unwrap().exit_code = Some(code);
                // Let the last output drain before the pipe closes.
                std::thread::sleep(Duration::from_millis(60));
                s.close_console();
            })
            .map_err(|e| e.to_string())?;

        Ok(SpawnResult { info, reattached: false })
    }

    fn finish(&self, s: &Arc<Session>) {
        let info = {
            let mut info = s.info.lock().unwrap();
            if info.exit_code.is_none() {
                info.exit_code = Some(-1);
            }
            info.progress = None;
            info.agent = None;
            info.clone()
        };
        s.out.lock().unwrap().sink = None;
        {
            let mut map = self.sessions.lock().unwrap();
            if map.get(&info.id).is_some_and(|cur| Arc::ptr_eq(cur, s)) {
                map.remove(&info.id);
            }
        }
        let _ = self.app.emit("term-exit", &info);
        crate::holster::publish(&self.app);
    }

    pub fn write(&self, id: &str, data: &[u8]) {
        if let Some(s) = self.get(id) {
            if let Some(w) = s.writer.lock().unwrap().as_mut() {
                let _ = w.write_all(data);
                let _ = w.flush();
            }
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if let Some(s) = self.get(id) {
            if let Some(m) = s.master.lock().unwrap().as_ref() {
                m.resize(cols, rows);
            }
        }
    }

    pub fn kill(&self, id: &str) {
        if let Some(s) = self.get(id) {
            let _ = s.killer.lock().unwrap().kill();
            s.close_console();
            crate::holster::retract(&self.app, id);
        }
    }

    pub fn kill_all(&self) {
        let all: Vec<Arc<Session>> = self.sessions.lock().unwrap().values().cloned().collect();
        for s in all {
            let _ = s.killer.lock().unwrap().kill();
            s.close_console();
        }
    }

    pub fn list(&self) -> Vec<TermInfo> {
        self.sessions.lock().unwrap().values().map(|s| s.info.lock().unwrap().clone()).collect()
    }

    pub fn infos(&self) -> HashMap<String, TermInfo> {
        self.sessions.lock().unwrap().iter().map(|(k, s)| (k.clone(), s.info.lock().unwrap().clone())).collect()
    }

    fn emit_info(&self, s: &Session) {
        let info = s.info.lock().unwrap().clone();
        let _ = self.app.emit("term-info", &info);
    }

    fn apply_scan(&self, s: &Arc<Session>, events: Vec<ScanEvent>) {
        let mut changed = false;
        for ev in events {
            match ev {
                ScanEvent::Title(t) => {
                    let mut info = s.info.lock().unwrap();
                    if info.title != t {
                        info.title = t;
                        changed = true;
                    }
                }
                ScanEvent::Cwd(p) => {
                    {
                        let mut info = s.info.lock().unwrap();
                        if info.cwd != p {
                            info.cwd = p;
                            changed = true;
                        }
                    }
                    // Shell integration reports the folder each time the prompt
                    // is drawn: whatever ran in front (an AI chat too) is over.
                    if s.startup.lock().unwrap().is_some() {
                        self.run_startup(s);
                    } else if s.info.lock().unwrap().agent_session.is_some() {
                        self.set_agent_session(s, None);
                    }
                }
                ScanEvent::Progress(state, value) => {
                    let mut info = s.info.lock().unwrap();
                    info.progress = (state != 0).then_some(Progress { state, value });
                    changed = true;
                }
                ScanEvent::Bell | ScanEvent::Notify(_) => {
                    let shadowed = s.last_hook.lock().unwrap().is_some_and(|t| t.elapsed() < HOOK_SHADOW);
                    if !shadowed {
                        let (kind, msg) = match ev {
                            ScanEvent::Notify(m) => ("notify", m),
                            _ => ("bell", String::new()),
                        };
                        self.raise(s, kind, msg);
                    }
                }
            }
        }
        if changed {
            self.emit_info(s);
        }
    }

    fn run_startup(&self, s: &Arc<Session>) {
        let Some((line, resume)) = s.startup.lock().unwrap().take() else { return };
        s.type_line(&line);
        // Counts as running until the prompt comes back (resumed, or failed).
        if resume.is_some() {
            self.set_agent_session(s, resume);
        }
    }

    fn set_agent_session(&self, s: &Arc<Session>, session: Option<AgentSession>) {
        let changed = {
            let mut info = s.info.lock().unwrap();
            let changed = info.agent_session != session;
            info.agent_session = session.clone();
            changed
        };
        if changed {
            let id = s.info.lock().unwrap().id.clone();
            let _ = self.app.emit("term-agent", serde_json::json!({ "id": id, "session": session }));
        }
    }

    pub fn set_shutting_down(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
    }

    /// The user is looking at this terminal right now.
    fn watched(&self, id: &str) -> bool {
        crate::window::is_active() && self.focused.lock().unwrap().as_deref() == Some(id)
    }

    fn raise(&self, s: &Arc<Session>, kind: &str, message: String) {
        let id = s.info.lock().unwrap().id.clone();
        if self.watched(&id) {
            return;
        }
        {
            let mut last = s.last_raise.lock().unwrap();
            if last.as_ref().is_some_and(|(k, t)| k == kind && t.elapsed() < REPEAT_GUARD) {
                return;
            }
            *last = Some((kind.to_string(), Instant::now()));
        }
        let attention = Attention { kind: kind.into(), message, at: now_ms() };
        s.info.lock().unwrap().attention = Some(attention.clone());
        self.emit_info(s);
        let _ = self.app.emit("term-attention", serde_json::json!({ "id": id, "attention": attention }));
        crate::holster::on_attention(&self.app, &id, &attention);
    }

    pub fn ack(&self, id: &str) {
        if let Some(s) = self.get(id) {
            let had = s.info.lock().unwrap().attention.take().is_some();
            if had {
                self.emit_info(&s);
                crate::holster::retract(&self.app, id);
            }
        }
    }

    pub fn set_focus(&self, id: Option<String>) {
        if let Some(id) = &id {
            if crate::window::is_active() {
                self.ack(id);
            }
        }
        *self.focused.lock().unwrap() = id;
    }

    /// The window came to the front: what's focused there is being looked at.
    pub fn on_window_active(&self) {
        let focused = self.focused.lock().unwrap().clone();
        if let Some(id) = focused {
            self.ack(&id);
        }
    }

    /// A report from the Claude Code hook running inside terminal `id`.
    pub fn hook(&self, id: &str, event: &str, payload: &Value) {
        let Some(s) = self.get(id) else { return };
        *s.last_hook.lock().unwrap() = Some(Instant::now());
        let field = |names: &[&str]| names.iter().find_map(|n| payload.get(*n).and_then(Value::as_str)).map(str::to_string);
        // Every Claude Code event names its session; Codex's names its thread.
        if event == "codex" {
            if let Some(thread) = field(&["thread-id", "thread_id", "session-id", "session_id", "conversation-id"]) {
                self.set_agent_session(&s, Some(AgentSession { tool: "codex".into(), id: thread }));
            }
        } else if event != "session-end" {
            if let Some(sid) = field(&["session_id"]) {
                self.set_agent_session(&s, Some(AgentSession { tool: "claude".into(), id: sid }));
            }
        }
        match event {
            "session-end" => {
                // Ended by the user (/exit, Ctrl+D…): don't bring it back. When
                // Track itself is closing the terminal, keep it for next time.
                let reason = field(&["reason"]).unwrap_or_default();
                if !self.shutting_down.load(Ordering::SeqCst) && reason != "clear" {
                    self.set_agent_session(&s, None);
                }
                s.info.lock().unwrap().agent = None;
                self.emit_info(&s);
            }
            "codex" => {
                let kind = field(&["type"]).unwrap_or_default();
                if kind == "agent-turn-complete" || kind.is_empty() {
                    self.raise(&s, "done", "Finished".into());
                }
            }
            "prompt" => {
                {
                    let mut info = s.info.lock().unwrap();
                    info.agent = Some("working".into());
                    info.attention = None;
                }
                self.emit_info(&s);
                crate::holster::retract(&self.app, id);
            }
            "stop" => {
                s.info.lock().unwrap().agent = None;
                self.emit_info(&s);
                self.raise(&s, "done", "Finished".into());
            }
            "tool-done" => {
                // A tool ran: Claude is working, and a permission prompt it
                // was waiting on has been answered.
                let changed = {
                    let mut info = s.info.lock().unwrap();
                    let answered = info.attention.as_ref().is_some_and(|a| a.kind == "waiting");
                    if answered {
                        info.attention = None;
                    }
                    let was_idle = info.agent.as_deref() != Some("working");
                    info.agent = Some("working".into());
                    answered || was_idle
                };
                if changed {
                    self.emit_info(&s);
                    crate::holster::retract(&self.app, id);
                }
            }
            "notification" => {
                let message = payload.get("message").and_then(Value::as_str).unwrap_or("Needs your attention").to_string();
                match notification_need(field(&["notification_type"]).as_deref(), &message) {
                    Need::You => {
                        s.info.lock().unwrap().agent = None;
                        self.raise(&s, "waiting", message);
                    }
                    Need::Note => self.raise(&s, "notify", message),
                    Need::Nothing => {}
                }
            }
            _ => {}
        }
    }
}

#[derive(Debug, PartialEq)]
enum Need {
    /// Claude is blocked on you: a permission prompt, a question.
    You,
    /// Something to read, nothing to answer (Claude's own push notification).
    Note,
    /// Reminders and status: "waiting for your input" a minute after it
    /// finished, sign-in done, quota resumed…
    Nothing,
}

/// What a Claude Code notification asks of you, by its `notification_type`.
/// Older versions don't send one: only their idle reminder can be told apart.
fn notification_need(kind: Option<&str>, message: &str) -> Need {
    match kind {
        Some(
            "permission_prompt" | "worker_permission_prompt" | "elicitation_dialog" | "elicitation_url_dialog"
            | "agent_needs_input",
        ) => Need::You,
        Some("push_notification") => Need::Note,
        Some(_) => Need::Nothing,
        None if message.to_lowercase().contains("waiting for your input") => Need::Nothing,
        None => Need::You,
    }
}

/// The first program running under a shell (its child processes, minus the
/// console host), by name without ".exe".
pub fn busy_child(shell_pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut procs: Vec<(u32, u32, String)> = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut e) != 0 {
            loop {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                procs.push((e.th32ProcessID, e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..len])));
                if Process32NextW(snap, &mut e) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    let ignored = |n: &str| {
        let n = n.to_lowercase();
        n == "conhost.exe" || n == "openconsole.exe"
    };
    procs
        .iter()
        .find(|(_, parent, name)| *parent == shell_pid && !ignored(name))
        .map(|(_, _, name)| name.trim_end_matches(".exe").trim_end_matches(".EXE").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_notifications_need() {
        assert_eq!(notification_need(Some("permission_prompt"), "Claude needs your permission to use Bash"), Need::You);
        assert_eq!(notification_need(Some("elicitation_dialog"), "Claude has a question"), Need::You);
        assert_eq!(notification_need(Some("idle_prompt"), "Claude is waiting for your input"), Need::Nothing);
        assert_eq!(notification_need(Some("auth_success"), "Signed in"), Need::Nothing);
        assert_eq!(notification_need(Some("push_notification"), "Build is green"), Need::Note);
        assert_eq!(notification_need(None, "Claude is waiting for your input"), Need::Nothing);
        assert_eq!(notification_need(None, "Claude needs your permission to use Bash"), Need::You);
    }
}
