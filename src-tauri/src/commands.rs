//! Everything the UI can ask of the backend. Async so none of it runs on the
//! window's thread.

use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{AppHandle, State};

use crate::fsx::{self, Drive, Folder, FolderInfo, Place};
use crate::hook::{self, HookStatus};
use crate::holster::{self, HolsterStatus};
use crate::pty::{SpawnRequest, SpawnResult, TermInfo};
use crate::settings::Settings;
use crate::shells::ShellInfo;
use crate::sounds::CustomSound;
use crate::Core;

type CoreState<'a> = State<'a, Arc<Core>>;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    data_dir: String,
}

#[tauri::command]
pub async fn app_info(core: CoreState<'_>) -> Result<AppInfo, String> {
    Ok(AppInfo { version: env!("CARGO_PKG_VERSION").into(), data_dir: core.data_dir.display().to_string() })
}

// ---- settings & workspace -------------------------------------------------------------

#[tauri::command]
pub async fn get_settings(core: CoreState<'_>) -> Result<Settings, String> {
    Ok(core.prefs.get())
}

#[tauri::command]
pub async fn update_settings(app: AppHandle, core: CoreState<'_>, patch: Value) -> Result<Settings, String> {
    let before = core.prefs.get();
    let after = core.prefs.patch(patch)?;
    crate::apply_settings_change(&app, &before, &after);
    Ok(after)
}

#[tauri::command]
pub async fn load_workspace(core: CoreState<'_>) -> Result<Option<Value>, String> {
    Ok(core.workspace.load())
}

#[tauri::command]
pub async fn save_workspace(app: AppHandle, core: CoreState<'_>, workspace: Value) -> Result<(), String> {
    core.workspace.save(workspace)?;
    holster::publish(&app);
    Ok(())
}

// ---- terminals --------------------------------------------------------------------------

#[tauri::command]
pub async fn list_shells(core: CoreState<'_>) -> Result<Vec<ShellInfo>, String> {
    Ok(core.shells.list())
}

#[tauri::command]
pub async fn pty_spawn(
    core: CoreState<'_>,
    request: SpawnRequest,
    on_data: Channel<InvokeResponseBody>,
) -> Result<SpawnResult, String> {
    let ptys = core.ptys.clone();
    tauri::async_runtime::spawn_blocking(move || ptys.spawn(request, on_data)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pty_write(core: CoreState<'_>, id: String, data: String) -> Result<(), String> {
    core.ptys.write(&id, data.as_bytes());
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(core: CoreState<'_>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    core.ptys.resize(&id, cols, rows);
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(core: CoreState<'_>, id: String) -> Result<(), String> {
    let ptys = core.ptys.clone();
    // Closing a console can block for a moment while its processes wind down.
    std::thread::spawn(move || ptys.kill(&id));
    Ok(())
}

#[tauri::command]
pub async fn pty_ack(core: CoreState<'_>, id: String) -> Result<(), String> {
    core.ptys.ack(&id);
    Ok(())
}

#[tauri::command]
pub async fn pty_focus(core: CoreState<'_>, id: Option<String>) -> Result<(), String> {
    core.ptys.set_focus(id);
    Ok(())
}

/// What's still running in a terminal besides its shell (e.g. "node"), so
/// closing it can ask first.
#[tauri::command]
pub async fn pty_busy(core: CoreState<'_>, id: String) -> Result<Option<String>, String> {
    let pid = core.ptys.list().into_iter().find(|t| t.id == id).and_then(|t| t.pid);
    Ok(pid.and_then(crate::pty::busy_child))
}

#[tauri::command]
pub async fn pty_list(core: CoreState<'_>) -> Result<Vec<TermInfo>, String> {
    Ok(core.ptys.list())
}

#[tauri::command]
pub async fn list_fonts() -> Result<Vec<crate::fonts::FontInfo>, String> {
    tauri::async_runtime::spawn_blocking(crate::fonts::list).await.map_err(|e| e.to_string())
}

// ---- folders -------------------------------------------------------------------------------

#[tauri::command]
pub async fn fs_list(path: String, hidden: bool) -> Result<Vec<Folder>, String> {
    tauri::async_runtime::spawn_blocking(move || fsx::list(&path, hidden)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_places() -> Result<Vec<Place>, String> {
    Ok(fsx::places())
}

#[tauri::command]
pub async fn fs_drives() -> Result<Vec<Drive>, String> {
    tauri::async_runtime::spawn_blocking(fsx::drives).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_complete(input: String) -> Result<Vec<Folder>, String> {
    tauri::async_runtime::spawn_blocking(move || fsx::complete(&input)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_projects(core: CoreState<'_>) -> Result<Vec<Folder>, String> {
    let s = core.prefs.get();
    let seeds: Vec<String> = s.pinned_folders.iter().chain(s.recent_folders.iter()).cloned().collect();
    tauri::async_runtime::spawn_blocking(move || fsx::projects(&seeds)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_create_dir(parent: String, name: String) -> Result<Folder, String> {
    fsx::create_dir(&parent, &name)
}

#[tauri::command]
pub async fn fs_info(path: String) -> Result<FolderInfo, String> {
    Ok(fsx::info(&path))
}

#[tauri::command]
pub async fn fs_reveal(path: String) -> Result<(), String> {
    fsx::open_in_explorer(&path)
}

#[tauri::command]
pub async fn note_recent(core: CoreState<'_>, path: String) -> Result<Settings, String> {
    core.prefs.note_recent(&path);
    Ok(core.prefs.get())
}

// ---- sounds ------------------------------------------------------------------------------

#[tauri::command]
pub async fn sounds_list(core: CoreState<'_>) -> Result<Vec<CustomSound>, String> {
    Ok(core.sounds.list())
}

#[tauri::command]
pub async fn sound_import(core: CoreState<'_>, path: String) -> Result<CustomSound, String> {
    core.sounds.import(&path)
}

#[tauri::command]
pub async fn sound_read(core: CoreState<'_>, id: String) -> Result<Response, String> {
    Ok(Response::new(core.sounds.read(&id)?))
}

#[tauri::command]
pub async fn sound_remove(core: CoreState<'_>, id: String) -> Result<(), String> {
    core.sounds.remove(&id)
}

// ---- integrations --------------------------------------------------------------------------

#[tauri::command]
pub async fn hook_status() -> Result<HookStatus, String> {
    Ok(hook::status())
}

#[tauri::command]
pub async fn hook_install() -> Result<HookStatus, String> {
    hook::install()
}

#[tauri::command]
pub async fn hook_remove() -> Result<HookStatus, String> {
    hook::remove()
}

#[tauri::command]
pub async fn codex_status() -> Result<hook::CodexStatus, String> {
    Ok(hook::codex_status())
}

#[tauri::command]
pub async fn codex_install() -> Result<hook::CodexStatus, String> {
    hook::codex_install()
}

#[tauri::command]
pub async fn codex_remove() -> Result<hook::CodexStatus, String> {
    hook::codex_remove()
}

#[tauri::command]
pub async fn holster_status() -> Result<HolsterStatus, String> {
    Ok(holster::status())
}

#[tauri::command]
pub async fn take_pending_open(core: CoreState<'_>) -> Result<Vec<String>, String> {
    Ok(std::mem::take(&mut *core.pending_open.lock().unwrap()))
}

#[tauri::command]
pub async fn explorer_status(core: CoreState<'_>) -> Result<crate::explorer::MenuStatus, String> {
    let side_by_side = core.side_by_side;
    tauri::async_runtime::spawn_blocking(move || crate::explorer::status(side_by_side)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn explorer_install(core: CoreState<'_>) -> Result<crate::explorer::MenuStatus, String> {
    let (dir, side_by_side) = (core.data_dir.clone(), core.side_by_side);
    tauri::async_runtime::spawn_blocking(move || crate::explorer::install(&dir, side_by_side)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn explorer_remove(core: CoreState<'_>) -> Result<crate::explorer::MenuStatus, String> {
    let side_by_side = core.side_by_side;
    tauri::async_runtime::spawn_blocking(move || crate::explorer::remove(side_by_side)).await.map_err(|e| e.to_string())?
}

// ---- window -----------------------------------------------------------------------------

#[tauri::command]
pub async fn window_hide(app: AppHandle) -> Result<(), String> {
    crate::window::hide(&app);
    Ok(())
}

#[tauri::command]
pub async fn app_quit(app: AppHandle) -> Result<(), String> {
    crate::quit(&app);
    Ok(())
}

// ---- updates ---------------------------------------------------------------------------

/// The newer version on GitHub, if there is one.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, crate::update::Pending>) -> Result<Option<crate::update::Available>, String> {
    crate::update::check(&app, &pending).await
}

/// Installs what `update_check` found; Track restarts as the new version.
#[tauri::command]
pub async fn update_install(app: AppHandle, core: CoreState<'_>, pending: State<'_, crate::update::Pending>) -> Result<(), String> {
    // The installer replaces the installed Track, never a dev build.
    if core.side_by_side {
        return Err("Track Dev doesn't update itself".into());
    }
    crate::update::install(&app, &pending).await
}
