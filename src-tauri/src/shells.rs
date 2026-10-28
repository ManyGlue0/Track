//! Which shells this machine has, and how to start one. Track never ships a
//! shell of its own: it runs pwsh, Windows PowerShell, cmd, Git Bash or a WSL
//! distro exactly as installed, with a fresh copy of the user's environment.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::CommandBuilder;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(skip)]
    pub args: Vec<String>,
    /// "pwsh" | "powershell" | "cmd" | "bash" | "wsl"
    pub kind: String,
}

pub struct Shells {
    list: Mutex<Vec<ShellInfo>>,
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

impl Shells {
    /// Detects the fast ones now and WSL distros in the background (asking
    /// wsl.exe can take a moment, or hang when WSL is half installed).
    pub fn start() -> Arc<Self> {
        let me = Arc::new(Self { list: Mutex::new(detect_native()) });
        let bg = me.clone();
        std::thread::spawn(move || {
            let wsl = detect_wsl();
            if !wsl.is_empty() {
                bg.list.lock().unwrap().extend(wsl);
            }
        });
        me
    }

    pub fn list(&self) -> Vec<ShellInfo> {
        self.list.lock().unwrap().clone()
    }

    /// The shell for `id`, falling back to the preferred default, then the best available.
    pub fn resolve(&self, id: &str, default: &str) -> Option<ShellInfo> {
        let list = self.list.lock().unwrap();
        list.iter()
            .find(|s| s.id == id)
            .or_else(|| list.iter().find(|s| s.id == default))
            .or_else(|| list.first())
            .cloned()
    }
}

fn which(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(exe)).find(|p| p.is_file())
}

fn env_path(var: &str, rest: &str) -> Option<PathBuf> {
    let base = std::env::var_os(var)?;
    let p = PathBuf::from(base).join(rest);
    p.is_file().then_some(p)
}

fn detect_native() -> Vec<ShellInfo> {
    let mut out = Vec::new();
    let mut add = |id: &str, name: &str, path: PathBuf, args: &[&str], kind: &str| {
        out.push(ShellInfo {
            id: id.into(),
            name: name.into(),
            path: path.display().to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            kind: kind.into(),
        });
    };
    if let Some(p) = which("pwsh.exe")
        .or_else(|| env_path("ProgramFiles", "PowerShell\\7\\pwsh.exe"))
        .or_else(|| env_path("LOCALAPPDATA", "Microsoft\\WindowsApps\\pwsh.exe"))
    {
        add("pwsh", "PowerShell", p, &["-NoLogo"], "pwsh");
    }
    if let Some(p) = env_path("SystemRoot", "System32\\WindowsPowerShell\\v1.0\\powershell.exe") {
        add("powershell", "Windows PowerShell", p, &["-NoLogo"], "powershell");
    }
    let cmd = std::env::var_os("ComSpec").map(PathBuf::from).filter(|p| p.is_file());
    if let Some(p) = cmd.or_else(|| env_path("SystemRoot", "System32\\cmd.exe")) {
        add("cmd", "Command Prompt", p, &[], "cmd");
    }
    let git_bash = env_path("ProgramFiles", "Git\\bin\\bash.exe").or_else(|| {
        // git.exe lives in <Git>\cmd; bash in <Git>\bin.
        let git = which("git.exe")?;
        let p = git.parent()?.parent()?.join("bin").join("bash.exe");
        p.is_file().then_some(p)
    });
    if let Some(p) = git_bash {
        add("git-bash", "Git Bash", p, &["--login", "-i"], "bash");
    }
    out
}

fn detect_wsl() -> Vec<ShellInfo> {
    let Some(wsl) = env_path("SystemRoot", "System32\\wsl.exe") else { return Vec::new() };
    let Ok(mut child) = std::process::Command::new(&wsl)
        .args(["-l", "-q"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    else {
        return Vec::new();
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < Duration::from_secs(4) => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return Vec::new();
            }
        }
    }
    let mut raw = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        use std::io::Read;
        let _ = out.read_to_end(&mut raw);
    }
    // wsl.exe writes UTF-16LE.
    let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string())
        .filter(|l| !l.is_empty() && !l.starts_with("docker-desktop"))
        .map(|distro| ShellInfo {
            id: format!("wsl:{distro}"),
            name: distro.clone(),
            path: wsl.display().to_string(),
            args: vec!["-d".into(), distro],
            kind: "wsl".into(),
        })
        .collect()
}

/// Wraps the user's own prompt (after their profile ran) so it also reports
/// the folder with OSC 9;9, like Windows Terminal's documented snippet.
const PS_INTEGRATION: &str = r#"$global:__trackPrompt = $function:prompt
function global:prompt {
  $l = $executionContext.SessionState.Path.CurrentLocation
  if ($l.Provider.Name -eq 'FileSystem') { [Console]::Write("$([char]27)]9;9;`"$($l.ProviderPath)`"$([char]27)\") }
  & $global:__trackPrompt
}"#;

pub struct Launch<'a> {
    pub shell: &'a ShellInfo,
    pub cwd: Option<&'a Path>,
    pub integration: bool,
    pub term_id: &'a str,
    pub port: u16,
}

pub fn command(l: Launch) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&l.shell.path);
    cmd.env_clear();
    for (k, v) in fresh_env() {
        cmd.env(k, v);
    }
    cmd.args(&l.shell.args);
    match (l.shell.kind.as_str(), l.integration) {
        ("pwsh" | "powershell", true) => {
            cmd.args(["-NoExit", "-EncodedCommand", &utf16_base64(PS_INTEGRATION)]);
        }
        ("cmd", true) => {
            let user = cmd.get_env("PROMPT").and_then(|v| v.to_str()).unwrap_or("$P$G").to_string();
            cmd.env("PROMPT", format!("$e]9;9;$P$e\\{user}"));
        }
        ("bash", true) => {
            cmd.env("PROMPT_COMMAND", r#"printf '\e]9;9;%s\e\\' "$PWD""#);
        }
        _ => {}
    }
    if let Some(cwd) = l.cwd {
        cmd.cwd(cwd);
    } else if let Some(home) = std::env::var_os("USERPROFILE") {
        cmd.cwd(home);
    }
    if l.shell.kind == "bash" {
        cmd.env("TERM", "xterm-256color");
        // Keep Git Bash in the folder we chose instead of $HOME.
        cmd.env("CHERE_INVOKING", "1");
    }
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Track");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    cmd.env("TRACK_TERM", l.term_id);
    if l.port != 0 {
        cmd.env("TRACK_PORT", l.port.to_string());
    }
    cmd
}

/// The user's environment as it is *now* in the registry (like a fresh
/// Explorer window would get), so a PATH changed by an installer reaches new
/// terminals without restarting Track. Falls back to Track's own environment.
pub fn fresh_env() -> Vec<(String, String)> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::TOKEN_QUERY;
    use windows_sys::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut out = Vec::new();
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0 {
            let mut block: *mut std::ffi::c_void = std::ptr::null_mut();
            if CreateEnvironmentBlock(&mut block, token, 0) != 0 && !block.is_null() {
                let mut p = block as *const u16;
                loop {
                    let mut len = 0;
                    while *p.add(len) != 0 {
                        len += 1;
                    }
                    if len == 0 {
                        break;
                    }
                    let entry = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
                    // Skip the hidden per-drive entries ("=C:=C:\").
                    if let Some((k, v)) = entry.split_once('=').filter(|(k, _)| !k.is_empty()) {
                        out.push((k.to_string(), v.to_string()));
                    }
                    p = p.add(len + 1);
                }
                DestroyEnvironmentBlock(block);
            }
            CloseHandle(token);
        }
    }
    if out.is_empty() {
        out = std::env::vars().collect();
    }
    out
}

fn utf16_base64(s: &str) -> String {
    let bytes: Vec<u8> = s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64() {
        // "hi" as UTF-16LE is 68 00 69 00.
        assert_eq!(utf16_base64("hi"), "aABpAA==");
    }
}
