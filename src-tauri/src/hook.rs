//! The Claude Code hook. Installed into `~/.claude/settings.json`, Claude Code
//! runs `track.exe --hook <event>` on its session, prompt, notification, tool and
//! stop events.
//! That process (see `run_client`) finds which Track terminal it's in from the
//! environment the terminal was started with, reports to Track's loopback
//! listener and exits at once. Outside Track it does nothing.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::settings::write_atomic;

/// Claude Code event → the name Track's listener knows it by. SessionStart and
/// SessionEnd tell Track which chat runs in a terminal, so it can resume it.
/// PostToolUse says Claude is at work again after you answered a permission
/// prompt (nothing else does until it stops).
const EVENTS: [(&str, &str); 6] = [
    ("SessionStart", "session-start"),
    ("UserPromptSubmit", "prompt"),
    ("Notification", "notification"),
    ("PostToolUse", "tool-done"),
    ("Stop", "stop"),
    ("SessionEnd", "session-end"),
];

/// Runs as `track.exe --hook <event> [args…]`. Always exits 0: a hook must never
/// get in the agent's way.
///
/// Claude Code sends its event as JSON on stdin. Codex calls its `notify`
/// program with the JSON as the last argument; Track's Codex entry is
/// `--hook codex --then <the previous notify program…>`, and that program is
/// started too, so whatever was set up before keeps working.
pub fn run_client(event: &str, rest: &[String]) -> i32 {
    let mut body = Vec::new();
    if event == "codex" {
        let json = rest.last().filter(|a| a.trim_start().starts_with('{')).cloned().unwrap_or_default();
        if let Some(then) = rest.iter().position(|a| a == "--then") {
            let chain: Vec<&String> = rest[then + 1..].iter().filter(|a| **a != json).collect();
            if let Some((prog, args)) = chain.split_first() {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new(prog.as_str())
                    .args(args.iter().map(|a| a.as_str()))
                    .arg(&json)
                    .creation_flags(0x0800_0000)
                    .spawn();
            }
        }
        body = json.into_bytes();
    }
    let term = std::env::var("TRACK_TERM").unwrap_or_default();
    let port = std::env::var("TRACK_PORT").ok().and_then(|p| p.parse::<u16>().ok());
    let (Some(port), false) = (port, term.is_empty()) else { return 0 };
    let safe = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !safe(&term) || !safe(event) {
        return 0;
    }
    if event != "codex" {
        let _ = std::io::stdin().take(256 * 1024).read_to_end(&mut body);
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    if let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(800)) {
        let _ = s.set_write_timeout(Some(Duration::from_secs(1)));
        let _ = s.set_read_timeout(Some(Duration::from_secs(1)));
        let head = format!(
            "POST /hook/{event}?term={term} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        if s.write_all(head.as_bytes()).is_ok() && s.write_all(&body).is_ok() {
            let mut sink = [0u8; 256];
            let _ = s.read(&mut sink);
        }
    }
    0
}

fn settings_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir).join("settings.json"));
    }
    std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join(".claude").join("settings.json"))
}

fn exe_path() -> String {
    // Forward slashes read the same in cmd and in Git Bash, which Claude Code
    // may use to run hooks on Windows.
    std::env::current_exe().map(|p| p.display().to_string().replace('\\', "/")).unwrap_or_default()
}

fn command_for(event: &str) -> String {
    format!("\"{}\" --hook {event}", exe_path())
}

fn is_ours(cmd: &str) -> bool {
    cmd.to_lowercase().contains("track.exe\" --hook ")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    /// "missing" (Claude Code isn't set up here), "off", "on", "outdated"
    /// (installed for another copy of Track) or "error".
    pub state: String,
    pub path: String,
    pub message: Option<String>,
}

fn read_settings() -> Result<(PathBuf, Value), String> {
    let path = settings_path().ok_or("Couldn't find your user folder")?;
    let value = match std::fs::read_to_string(&path) {
        Ok(text) if text.trim().is_empty() => json!({}),
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("Claude Code's settings.json isn't valid JSON ({e}). Fix it, then try again."))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e.to_string()),
    };
    Ok((path, value))
}

/// Every command string in `hooks.<event>[].hooks[].command`.
fn commands(settings: &Value, event: &str) -> Vec<String> {
    settings
        .pointer(&format!("/hooks/{event}"))
        .and_then(Value::as_array)
        .map(|groups| {
            groups
                .iter()
                .filter_map(|g| g.get("hooks").and_then(Value::as_array))
                .flatten()
                .filter_map(|h| h.get("command").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn status() -> HookStatus {
    let path = settings_path().map(|p| p.display().to_string()).unwrap_or_default();
    let claude_dir = settings_path().and_then(|p| p.parent().map(|d| d.is_dir())).unwrap_or(false);
    match read_settings() {
        Err(message) => HookStatus { state: "error".into(), path, message: Some(message) },
        Ok((_, settings)) => {
            let ours: Vec<Vec<String>> = EVENTS
                .iter()
                .map(|(ev, _)| commands(&settings, ev).into_iter().filter(|c| is_ours(c)).collect())
                .collect();
            let state = if ours.iter().all(|c| c.is_empty()) {
                if claude_dir { "off" } else { "missing" }
            } else if EVENTS.iter().zip(&ours).all(|((_, name), cmds)| cmds.iter().any(|c| *c == command_for(name))) {
                "on"
            } else {
                "outdated"
            };
            HookStatus { state: state.into(), path, message: None }
        }
    }
}

/// Removes Track's hook entries, leaving everything else as it was.
fn strip(settings: &mut Value) {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else { return };
    for (event, _) in EVENTS {
        let Some(groups) = hooks.get_mut(event).and_then(Value::as_array_mut) else { continue };
        for g in groups.iter_mut() {
            if let Some(list) = g.get_mut("hooks").and_then(Value::as_array_mut) {
                list.retain(|h| !h.get("command").and_then(Value::as_str).is_some_and(is_ours));
            }
        }
        groups.retain(|g| g.get("hooks").and_then(Value::as_array).is_none_or(|l| !l.is_empty()));
        if groups.is_empty() {
            hooks.remove(event);
        }
    }
    if hooks.is_empty() {
        if let Some(obj) = settings.as_object_mut() {
            obj.remove("hooks");
        }
    }
}

pub fn install() -> Result<HookStatus, String> {
    let (path, mut settings) = read_settings()?;
    if !settings.is_object() {
        return Err("Claude Code's settings.json isn't an object".into());
    }
    strip(&mut settings);
    let obj = settings.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(Map::new());
    }
    let hooks = hooks.as_object_mut().unwrap();
    for (event, name) in EVENTS {
        let entry = json!({ "hooks": [{ "type": "command", "command": command_for(name), "timeout": 5 }] });
        match hooks.get_mut(event).and_then(Value::as_array_mut) {
            Some(groups) => groups.push(entry),
            None => {
                hooks.insert(event.into(), json!([entry]));
            }
        }
    }
    write(&path, &settings)?;
    Ok(status())
}

pub fn remove() -> Result<HookStatus, String> {
    let (path, mut settings) = read_settings()?;
    strip(&mut settings);
    if path.exists() {
        write(&path, &settings)?;
    }
    Ok(status())
}

fn write(path: &PathBuf, settings: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())? + "\n";
    write_atomic(path, &text).map_err(|e| format!("Couldn't write Claude Code's settings: {e}"))
}

/// Track moved (an update, a new install folder): point the hook at this copy.
pub fn refresh_if_installed() {
    if status().state == "outdated" {
        if let Err(e) = install() {
            eprintln!("hook: couldn't update the Claude Code hook: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_keeps_other_hooks() {
        let mut s = json!({
            "model": "x",
            "hooks": {
                "Stop": [
                    { "hooks": [{ "type": "command", "command": "\"C:/T/track.exe\" --hook stop" }] },
                    { "hooks": [{ "type": "command", "command": "say done" }] }
                ],
                "Notification": [{ "hooks": [{ "type": "command", "command": "\"C:/T/track.exe\" --hook notification" }] }]
            }
        });
        strip(&mut s);
        assert_eq!(s, json!({ "model": "x", "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] } }));
    }
}

// ---- Codex -----------------------------------------------------------------------

/// Codex's config: `notify` runs one program per finished turn.
fn codex_config() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("CODEX_HOME") {
        return Some(PathBuf::from(home).join("config.toml"));
    }
    std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join(".codex").join("config.toml"))
}

fn exe_native() -> String {
    std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
}

fn read_notify(doc: &toml_edit::DocumentMut) -> Vec<String> {
    doc.get("notify")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn is_ours_notify(notify: &[String]) -> bool {
    notify.first().is_some_and(|p| p.to_lowercase().ends_with("track.exe")) && notify.get(1).map(String::as_str) == Some("--hook")
}

/// What ran before Track joined in (kept and called after Track).
fn chained(notify: &[String]) -> Vec<String> {
    if is_ours_notify(notify) {
        notify.iter().position(|a| a == "--then").map(|i| notify[i + 1..].to_vec()).unwrap_or_default()
    } else {
        notify.to_vec()
    }
}

fn read_codex() -> Result<(PathBuf, toml_edit::DocumentMut), String> {
    let path = codex_config().ok_or("Couldn't find your user folder")?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.to_string()),
    };
    let doc = text.parse::<toml_edit::DocumentMut>().map_err(|e| format!("Codex's config.toml doesn't parse ({e})"))?;
    Ok((path, doc))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    /// "missing" (no Codex here), "off", "on", "outdated", "error".
    pub state: String,
    /// The program Codex already notifies, which Track keeps calling.
    pub chained: Option<String>,
    pub message: Option<String>,
}

pub fn codex_status() -> CodexStatus {
    let installed = codex_config().and_then(|p| p.parent().map(|d| d.is_dir())).unwrap_or(false);
    match read_codex() {
        Err(message) => CodexStatus { state: "error".into(), chained: None, message: Some(message) },
        Ok((_, doc)) => {
            let notify = read_notify(&doc);
            let chain = chained(&notify);
            let state = if is_ours_notify(&notify) {
                if notify[0].eq_ignore_ascii_case(&exe_native()) { "on" } else { "outdated" }
            } else if installed {
                "off"
            } else {
                "missing"
            };
            let chained = chain.first().map(|p| {
                Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone())
            });
            CodexStatus { state: state.into(), chained, message: None }
        }
    }
}

pub fn codex_install() -> Result<CodexStatus, String> {
    let (path, mut doc) = read_codex()?;
    let chain = chained(&read_notify(&doc));
    let mut notify = toml_edit::Array::new();
    for part in [exe_native(), "--hook".into(), "codex".into()] {
        notify.push(part);
    }
    if !chain.is_empty() {
        notify.push("--then");
        for part in chain {
            notify.push(part);
        }
    }
    doc["notify"] = toml_edit::value(notify);
    write_text(&path, &doc.to_string())?;
    Ok(codex_status())
}

pub fn codex_remove() -> Result<CodexStatus, String> {
    let (path, mut doc) = read_codex()?;
    let notify = read_notify(&doc);
    if !is_ours_notify(&notify) {
        return Ok(codex_status());
    }
    let chain = chained(&notify);
    if chain.is_empty() {
        doc.remove("notify");
    } else {
        let mut arr = toml_edit::Array::new();
        for part in chain {
            arr.push(part);
        }
        doc["notify"] = toml_edit::value(arr);
    }
    write_text(&path, &doc.to_string())?;
    Ok(codex_status())
}

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    write_atomic(path, text).map_err(|e| format!("Couldn't write Codex's config: {e}"))
}

pub fn codex_refresh_if_installed() {
    if codex_status().state == "outdated" {
        if let Err(e) = codex_install() {
            eprintln!("hook: couldn't update the Codex hook: {e}");
        }
    }
}

#[cfg(test)]
mod codex_tests {
    use super::*;

    #[test]
    fn chaining() {
        let theirs = vec![r"C:\x\computer-use.exe".to_string(), "turn-ended".into()];
        assert_eq!(chained(&theirs), theirs);
        let ours = vec![r"C:\T\track.exe".to_string(), "--hook".into(), "codex".into(), "--then".into(), r"C:\x\computer-use.exe".into(), "turn-ended".into()];
        assert!(is_ours_notify(&ours));
        assert_eq!(chained(&ours), theirs);
    }
}
