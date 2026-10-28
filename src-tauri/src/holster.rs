//! Holster integration: Track is one of the dock's tiles, in window mode.
//!
//! - A loopback-only listener serves `/holster/health` for Holster and
//!   `/hook/<event>` for the Claude Code hook running inside terminals.
//! - The manifest goes to `%APPDATA%\Holster\apps\track.json` on every start,
//!   only when Holster is installed.
//! - The preview is a page on disk in `<data dir>\holster-preview\`, next to a
//!   `state.json` snapshot: terminals that need you first, otherwise screens.
//! - When a terminal needs you and the window isn't in front, Holster shows a
//!   notification (its tab glows instead if you turned them off or muted
//!   Track). "Show" opens Track on that terminal; once you've looked at it in
//!   Track, the notification is taken back.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    body::Bytes,
    extract::{Path as UrlPath, Query, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::pty::Attention;
use crate::settings::write_if_changed;
use crate::Core;

pub const ID: &str = "track";
const NAME: &str = "Track";
const PREFERRED_PORT: u16 = 47352;
/// Pitch black: the tile Track's colored mark sits on.
const COLOR: &str = "#000000";
/// The full-color mark (four pastel terminals), drawn untinted on the tile.
const ICON_SVG: &str = include_str!("../icons/track-icon.svg");
const PREVIEW_HTML: &str = include_str!("../holster-preview/index.html");
const PREVIEW_WIDTH: u32 = 300;
/// Holster's tab glows at most this often for Track.
const SIGNAL_EVERY: Duration = Duration::from_secs(6);

static PORT: AtomicU16 = AtomicU16::new(0);

/// The loopback port terminals report hook events to (0 until listening).
pub fn port() -> u16 {
    PORT.load(Ordering::SeqCst)
}

fn preview_height(rows: usize) -> u32 {
    let n = rows.clamp(1, 3) as u32;
    // padding 14 + head 16 + gap 10 + rows (46 each, 6 apart) + padding 14
    14 + 16 + 10 + n * 46 + (n - 1) * 6 + 14
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HolsterStatus {
    pub installed: bool,
    pub registered: bool,
    pub error: Option<String>,
    pub warnings: Vec<String>,
    pub port: u16,
}

struct Holster {
    dir: PathBuf,
    status: Mutex<HolsterStatus>,
    last_signal: Mutex<Option<Instant>>,
    /// Terminals with a notification out in Holster.
    cards: Mutex<HashSet<String>>,
}

static HOLSTER: OnceLock<Arc<Holster>> = OnceLock::new();

fn holster_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Holster")).filter(|d| d.is_dir())
}

/// Holster's API base from `holster.json`, read fresh every time: its port
/// changes on every start.
fn holster_api() -> Option<String> {
    let text = std::fs::read_to_string(holster_dir()?.join("holster.json")).ok()?;
    let api = serde_json::from_str::<Value>(&text).ok()?.get("api")?.as_str()?.trim_end_matches('/').to_string();
    api.starts_with("http://127.0.0.1:").then_some(api)
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_millis(1500)).no_proxy().build().unwrap_or_default())
}

/// Starts the listener, writes the preview and registers with Holster.
pub fn start(app: AppHandle, data_dir: &Path, register: bool) {
    let me = Arc::new(Holster {
        dir: data_dir.join("holster-preview"),
        status: Mutex::new(HolsterStatus::default()),
        last_signal: Mutex::new(None),
        cards: Mutex::new(HashSet::new()),
    });
    let _ = HOLSTER.set(me.clone());
    let _ = std::fs::create_dir_all(&me.dir);
    for (name, text) in [("index.html", PREVIEW_HTML), ("icon.svg", ICON_SVG)] {
        if let Err(e) = write_if_changed(&me.dir.join(name), text) {
            eprintln!("holster: couldn't write {name}: {e}");
        }
    }
    publish(&app);
    tauri::async_runtime::spawn(async move {
        let port = match serve(app).await {
            Ok(port) => port,
            Err(e) => {
                eprintln!("holster: couldn't listen on loopback: {e}");
                return;
            }
        };
        PORT.store(port, Ordering::SeqCst);
        me.status.lock().unwrap().port = port;
        if register {
            me.register(port).await;
        }
    });
}

pub fn status() -> HolsterStatus {
    let mut st = HOLSTER.get().map(|h| h.status.lock().unwrap().clone()).unwrap_or_default();
    st.installed = holster_dir().is_some();
    st
}

/// The name a terminal goes by: what the user called it, else what the
/// program running in it calls itself, else the shell.
pub fn display_name(custom: &str, title: &str, shell: &str) -> String {
    let title = clean_title(title);
    let name = [custom.trim(), title.as_str(), shell.trim()].into_iter().find(|s| !s.is_empty()).unwrap_or("Terminal");
    name.to_string()
}

/// Shell titles are often just the exe path or the shell's own name; keep
/// what's meaningful (the same rule as the window's cell headers).
fn clean_title(title: &str) -> String {
    let t = title.trim();
    let lower = t.to_lowercase();
    let exe_path = t.len() > 3 && t.as_bytes()[1] == b':' && lower.ends_with(".exe");
    let shell_name = matches!(
        lower.strip_prefix("administrator: ").unwrap_or(&lower),
        "windows powershell" | "powershell" | "command prompt"
    );
    if exe_path || shell_name {
        return String::new();
    }
    t.trim_start_matches(['✳', '✻', '✽', '✶', '✢', '·', '*']).trim_start().to_string()
}

/// Rewrites `state.json` for the preview.
pub fn publish(app: &AppHandle) {
    let Some(me) = HOLSTER.get() else { return };
    let Some(core) = app.try_state::<Arc<Core>>() else { return };
    let ws = core.workspace.summary();
    let infos = core.ptys.infos();

    let mut needs: Vec<Value> = Vec::new();
    for screen in &ws.screens {
        for term in &screen.terminals {
            let Some(info) = infos.get(term) else { continue };
            let Some(att) = &info.attention else { continue };
            let meta = ws.terms.get(term).cloned().unwrap_or_default();
            needs.push(json!({
                "name": display_name(&meta.name, &info.title, &info.shell_name),
                "screen": screen.name,
                "color": meta.color.or(screen.color.clone()),
                "kind": att.kind,
                "message": att.message,
                "at": att.at,
            }));
        }
    }
    needs.sort_by_key(|n| std::cmp::Reverse(n.get("at").and_then(Value::as_u64).unwrap_or(0)));

    let live: HashMap<&str, bool> = infos.keys().map(|k| (k.as_str(), true)).collect();
    let screens: Vec<Value> = ws
        .screens
        .iter()
        .map(|s| {
            let working = s
                .terminals
                .iter()
                .filter(|t| infos.get(*t).is_some_and(|i| i.agent.as_deref() == Some("working")))
                .count();
            json!({
                "name": s.name,
                "color": s.color,
                "count": s.terminals.len(),
                "running": s.terminals.iter().filter(|t| live.contains_key(t.as_str())).count(),
                "working": working,
                "active": s.id == ws.active_screen,
            })
        })
        .collect();
    let state = json!({ "version": 1, "needs": needs, "screens": screens });
    let text = serde_json::to_string(&state).unwrap_or_default();
    if let Err(e) = write_if_changed(&me.dir.join("state.json"), &text) {
        eprintln!("holster: couldn't write the preview state: {e}");
    }
}

/// A terminal raised attention: refresh the preview and, if the window isn't
/// in front, tell the user through Holster: a notification, or the tab's glow.
pub fn on_attention(app: &AppHandle, term: &str, att: &Attention) {
    publish(app);
    if HOLSTER.get().is_none() || crate::window::is_active() {
        return;
    }
    let Some(core) = app.try_state::<Arc<Core>>() else { return };
    let prefs = core.prefs.get();
    // A bell is too small a thing for a card.
    let card = (prefs.holster_notify && att.kind != "bell").then(|| card_for(&core, term, att)).flatten();
    let Some(card) = card else {
        if prefs.holster_glow {
            glow();
        }
        return;
    };
    let (term, glow_fallback) = (term.to_string(), prefs.holster_glow);
    tauri::async_runtime::spawn(async move {
        let sent = match holster_api() {
            Some(api) => match client().post(format!("{api}/apps/{ID}/notify")).json(&card).send().await {
                Ok(resp) if resp.status().is_success() => {
                    let body: Value = resp.json().await.unwrap_or(Value::Null);
                    !body.get("muted").and_then(Value::as_bool).unwrap_or(false)
                }
                _ => false,
            },
            None => false,
        };
        if sent {
            if let Some(me) = HOLSTER.get() {
                me.cards.lock().unwrap().insert(term);
            }
        } else if glow_fallback {
            glow();
        }
    });
}

/// The notification for a terminal's attention: what happened as the title,
/// where as the text, and a button that opens Track on it.
fn card_for(core: &Core, term: &str, att: &Attention) -> Option<Value> {
    let ws = core.workspace.summary();
    let info = core.ptys.infos().remove(term)?;
    let meta = ws.terms.get(term).cloned().unwrap_or_default();
    let name = display_name(&meta.name, &info.title, &info.shell_name);
    let screen = ws.screens.iter().find(|s| s.terminals.iter().any(|t| t == term)).map(|s| s.name.clone());
    let place = match &screen {
        Some(screen) => format!("{name} · {screen}"),
        None => name.clone(),
    };
    let (title, body, timeout) = match att.kind.as_str() {
        // Blocked on you: it stays until you deal with it.
        "waiting" => (att.message.clone(), place, 0),
        "done" => (format!("{name} is done"), screen.map(|s| format!("In {s}")).unwrap_or_default(), 10),
        _ => (att.message.clone(), place, 10),
    };
    let mut card = json!({
        "id": card_id(term),
        "title": clip(&title, 120),
        "buttons": [{ "id": "show", "label": "Show", "primary": true, "open": true }],
        "timeout": timeout,
    });
    if !body.is_empty() {
        card["body"] = json!(clip(&body, 500));
    }
    Some(card)
}

fn card_id(term: &str) -> String {
    format!("term-{}", term.chars().take(59).collect::<String>())
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max - 1).collect::<String>() + "…"
    }
}

/// Holster's tab glows in Track's color (at most every few seconds).
fn glow() {
    let Some(me) = HOLSTER.get() else { return };
    {
        let mut last = me.last_signal.lock().unwrap();
        if last.is_some_and(|t| t.elapsed() < SIGNAL_EVERY) {
            return;
        }
        *last = Some(Instant::now());
    }
    tauri::async_runtime::spawn(async {
        let Some(api) = holster_api() else { return };
        let _ = client().post(format!("{api}/apps/{ID}/signal")).json(&json!({ "kind": "activity" })).send().await;
    });
}

/// The terminal no longer needs you (you looked at it, or it moved on): take
/// its notification back, if one is out.
pub fn retract(app: &AppHandle, term: &str) {
    publish(app);
    let Some(me) = HOLSTER.get() else { return };
    if !me.cards.lock().unwrap().remove(term) {
        return;
    }
    let id = card_id(term);
    tauri::async_runtime::spawn(async move {
        let Some(api) = holster_api() else { return };
        let _ = client().delete(format!("{api}/apps/{ID}/notify/{id}")).send().await;
    });
}

/// What happened to a notification (Holster tells `notify.url`).
fn on_card_event(app: &AppHandle, event: &Value) {
    let Some(term) = event.get("id").and_then(Value::as_str).and_then(|id| id.strip_prefix("term-")) else { return };
    if let Some(me) = HOLSTER.get() {
        me.cards.lock().unwrap().remove(term);
    }
    let action = event.get("event").and_then(Value::as_str) == Some("action");
    if action && event.get("button").and_then(Value::as_str) == Some("show") {
        let (handle, term) = (app.clone(), term.to_string());
        let _ = app.run_on_main_thread(move || {
            crate::window::show(&handle);
            let _ = handle.emit("show-terminal", term);
        });
    }
}

impl Holster {
    async fn register(&self, port: u16) {
        let Some(dir) = holster_dir() else { return };
        let apps = dir.join("apps");
        let exe = std::env::current_exe().ok();
        let base = format!("http://127.0.0.1:{port}/holster");
        let rows = std::fs::read_to_string(self.dir.join("state.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .map(|v| {
                let needs = v.get("needs").and_then(Value::as_array).map_or(0, Vec::len);
                let screens = v.get("screens").and_then(Value::as_array).map_or(0, Vec::len);
                if needs > 0 { needs } else { screens }
            })
            .unwrap_or(1);
        let manifest = json!({
            "schema": 1,
            "id": ID,
            "name": NAME,
            "icon": { "path": self.dir.join("icon.svg"), "size": "62%" },
            "color": COLOR,
            "health": format!("{base}/health"),
            "preview": { "path": self.dir.join("index.html"), "width": PREVIEW_WIDTH, "height": preview_height(rows) },
            "open": { "mode": "window" },
            "launch": { "exe": exe, "args": [] },
            "notify": { "url": format!("{base}/notify") },
        });
        let text = serde_json::to_string_pretty(&manifest).unwrap_or_default() + "\n";
        let written = std::fs::create_dir_all(&apps).and_then(|_| write_if_changed(&apps.join(format!("{ID}.json")), &text));
        if let Err(e) = written {
            eprintln!("holster: couldn't write the manifest: {e}");
            self.status.lock().unwrap().error = Some(format!("Couldn't register with Holster: {e}"));
            return;
        }
        self.status.lock().unwrap().registered = true;

        let Some(api) = holster_api() else { return };
        let Ok(resp) = client().post(format!("{api}/apps/{ID}/reload")).send().await else { return };
        let ok = resp.status().is_success();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        let mut st = self.status.lock().unwrap();
        st.warnings = body
            .get("warnings")
            .and_then(Value::as_array)
            .map(|w| w.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        st.error = if ok {
            None
        } else {
            Some(body.get("error").and_then(Value::as_str).unwrap_or("Holster rejected the manifest").to_string())
        };
        for w in &st.warnings {
            eprintln!("holster: {w}");
        }
        if let Some(e) = &st.error {
            eprintln!("holster: {e}");
        }
    }
}

// ---- loopback listener -------------------------------------------------------------

async fn serve(app: AppHandle) -> std::io::Result<u16> {
    // Loopback only. The preferred port keeps the manifest stable.
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).await {
        Ok(l) => l,
        Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
    };
    let port = listener.local_addr()?.port();
    let card_app = app.clone();
    let router = Router::new()
        .route("/holster/health", get(|| async { "ok" }))
        .route(
            "/holster/notify",
            post(move |body: Bytes| {
                let app = card_app.clone();
                async move {
                    if let Ok(event) = serde_json::from_slice::<Value>(&body) {
                        on_card_event(&app, &event);
                    }
                    StatusCode::NO_CONTENT
                }
            }),
        )
        .route(
            "/hook/{event}",
            post(move |UrlPath(event): UrlPath<String>, Query(q): Query<HashMap<String, String>>, body: Bytes| {
                let app = app.clone();
                async move {
                    let payload: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    if let (Some(term), Some(core)) = (q.get("term"), app.try_state::<Arc<Core>>()) {
                        core.ptys.hook(term, &event, &payload);
                    }
                    StatusCode::NO_CONTENT
                }
            }),
        )
        .fallback(|| async { (StatusCode::NOT_FOUND, "Not found") })
        .layer(middleware::from_fn_with_state(port, guard));
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(port)
}

fn is_loopback_origin(origin: &str) -> bool {
    ["http://127.0.0.1", "http://localhost"].iter().any(|base| {
        origin
            .strip_prefix(base)
            .is_some_and(|rest| rest.is_empty() || (rest.starts_with(':') && rest[1..].bytes().all(|b| b.is_ascii_digit())))
    })
}

/// DNS-rebinding and cross-site guard: the Host must be this loopback port,
/// and a browser request must come from a loopback page.
async fn guard(State(port): State<u16>, req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    let host_ok = host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}");
    let origin_ok = req
        .headers()
        .get(header::ORIGIN)
        .map(|o| o.to_str().is_ok_and(is_loopback_origin))
        .unwrap_or(true);
    if !host_ok || !origin_ok {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_origins() {
        assert!(is_loopback_origin("http://127.0.0.1:52710"));
        assert!(!is_loopback_origin("http://127.0.0.1.evil.com"));
        assert!(!is_loopback_origin("null"));
    }

    #[test]
    fn clipping() {
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("abcdefghijkl", 5), "abcd…");
        assert_eq!(card_id("t1abc"), "term-t1abc");
    }

    #[test]
    fn names() {
        assert_eq!(display_name("", "claude", "PowerShell"), "claude");
        assert_eq!(display_name(" api ", "claude", "PowerShell"), "api");
        assert_eq!(display_name("", "", "PowerShell"), "PowerShell");
        assert_eq!(display_name("", r"C:\Program Files\PowerShell\7\pwsh.exe", "PowerShell"), "PowerShell");
        assert_eq!(display_name("", "Administrator: Windows PowerShell", "PowerShell"), "PowerShell");
        assert_eq!(display_name("", "✳ Fix the login bug", "PowerShell"), "Fix the login bug");
    }
}
