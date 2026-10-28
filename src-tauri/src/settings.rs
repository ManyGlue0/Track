//! User preferences, one JSON file in the app data folder. Every field has a
//! default, so files written by older versions keep loading.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// "system" | "light" | "dark"
    pub theme: String,
    /// Shell id from the detected list; empty picks the best one available.
    pub default_shell: String,
    /// "click": cells keep their size. "popout": the focused terminal springs
    /// into a large centered card over the dimmed grid.
    pub focus_mode: String,
    /// Font family for terminals; empty uses Cascadia Mono.
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
    /// "bar" | "block" | "underline"
    pub cursor_style: String,
    pub cursor_blink: bool,
    /// WebGL rendering: faster under heavy output, slightly heavier text.
    pub gpu_rendering: bool,
    pub scrollback: u32,
    pub copy_on_select: bool,
    pub right_click_paste: bool,
    /// Teach pwsh, cmd and Git Bash to report their folder, so cells show it
    /// and a restart reopens there.
    pub shell_integration: bool,
    pub sounds: bool,
    pub volume: f64,
    /// Notifications in Holster while Track is in the background.
    pub holster_notify: bool,
    /// Holster's tab glows (when notifications are off or Track is muted there).
    pub holster_glow: bool,
    /// Reopen AI chats (Claude Code, Codex) when Track reopens their terminals.
    pub resume_chats: bool,
    /// What to type to resume a chat; `{id}` is the chat's id.
    pub claude_resume: String,
    pub codex_resume: String,
    pub launch_at_startup: bool,
    pub pinned_folders: Vec<String>,
    pub recent_folders: Vec<String>,
    /// Action id to accelerator, only for the ones the user changed.
    pub shortcuts: BTreeMap<String, String>,
    pub window: Option<WindowBounds>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub maximized: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            default_shell: String::new(),
            focus_mode: "click".into(),
            font_family: String::new(),
            font_size: 13.0,
            line_height: 1.2,
            cursor_style: "bar".into(),
            cursor_blink: true,
            gpu_rendering: false,
            scrollback: 10_000,
            copy_on_select: false,
            right_click_paste: false,
            shell_integration: true,
            sounds: true,
            volume: 0.7,
            holster_notify: true,
            holster_glow: true,
            resume_chats: true,
            claude_resume: "claude --resume {id}".into(),
            codex_resume: "codex resume {id}".into(),
            launch_at_startup: false,
            pinned_folders: Vec::new(),
            recent_folders: Vec::new(),
            shortcuts: BTreeMap::new(),
            window: None,
        }
    }
}

pub const MAX_RECENT: usize = 12;

pub struct Prefs {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl Prefs {
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("settings.json");
        let current = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Settings>(&t).ok())
            .unwrap_or_default();
        Self { path, current: Mutex::new(current) }
    }

    pub fn get(&self) -> Settings {
        self.current.lock().unwrap().clone()
    }

    pub fn update(&self, f: impl FnOnce(&mut Settings)) -> Settings {
        let mut cur = self.current.lock().unwrap();
        f(&mut cur);
        let snapshot = cur.clone();
        drop(cur);
        self.save(&snapshot);
        snapshot
    }

    /// Merges a partial JSON object from the UI (nested objects merge too).
    pub fn patch(&self, patch: Value) -> Result<Settings, String> {
        let mut cur = self.current.lock().unwrap();
        let mut value = serde_json::to_value(&*cur).map_err(|e| e.to_string())?;
        merge(&mut value, patch);
        let next: Settings = serde_json::from_value(value).map_err(|e| format!("Invalid settings: {e}"))?;
        *cur = next.clone();
        drop(cur);
        self.save(&next);
        Ok(next)
    }

    fn save(&self, s: &Settings) {
        if let Ok(text) = serde_json::to_string_pretty(s) {
            if let Err(e) = write_atomic(&self.path, &text) {
                eprintln!("settings: couldn't save: {e}");
            }
        }
    }

    pub fn note_recent(&self, folder: &str) {
        let folder = folder.trim_end_matches(['\\', '/']).to_string();
        if folder.is_empty() {
            return;
        }
        let folder = if folder.ends_with(':') { format!("{folder}\\") } else { folder };
        self.update(|s| {
            s.recent_folders.retain(|f| !f.eq_ignore_ascii_case(&folder));
            s.recent_folders.insert(0, folder);
            s.recent_folders.truncate(MAX_RECENT);
        });
    }
}

fn merge(base: &mut Value, patch: Value) {
    match (base, patch) {
        (Value::Object(b), Value::Object(p)) => {
            for (k, v) in p {
                // Shortcut overrides replace wholesale so a reset can remove keys.
                if k == "shortcuts" {
                    b.insert(k, v);
                    continue;
                }
                merge(b.entry(k).or_insert(Value::Null), v);
            }
        }
        (b, p) => *b = p,
    }
}

/// Temp file, then rename: a crash never leaves half a file behind. Each
/// write gets its own temp name, so two threads saving at once can't collide.
pub fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(".{name}.{}-{n}.tmp", std::process::id()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// Like `write_atomic`, but skips the write when nothing changed.
pub fn write_if_changed(path: &Path, text: &str) -> std::io::Result<()> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(text) {
        return Ok(());
    }
    write_atomic(path, text)
}
