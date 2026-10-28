pub mod elevated;
pub mod hook;

mod commands;
mod explorer;
mod fonts;
mod fsx;
mod holster;
mod pty;
mod scan;
mod settings;
mod shells;
mod sounds;
mod taskbar;
mod update;
mod window;
mod workspace;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;

use crate::settings::{Prefs, Settings};

pub struct Core {
    pub prefs: Arc<Prefs>,
    pub ptys: Arc<pty::Ptys>,
    pub shells: Arc<shells::Shells>,
    pub workspace: Arc<workspace::Store>,
    pub sounds: Arc<sounds::Sounds>,
    pub data_dir: PathBuf,
    /// Folders Track was started with (Explorer's "Open in Track"), until the UI takes them.
    pub pending_open: std::sync::Mutex<Vec<String>>,
    /// Track Dev (tauri.dev.json): runs beside the installed Track and never
    /// takes over its Holster tile, hooks or Explorer menu.
    pub side_by_side: bool,
}

/// Side effects of a settings change.
pub fn apply_settings_change(app: &AppHandle, before: &Settings, after: &Settings) {
    if before.theme != after.theme {
        window::apply_theme(app, &after.theme);
    }
    if before.launch_at_startup != after.launch_at_startup {
        sync_autostart(app, after.launch_at_startup);
    }
}

fn sync_autostart(app: &AppHandle, enabled: bool) {
    // Dev builds would register target/debug; only touch autostart in release.
    if cfg!(debug_assertions) {
        return;
    }
    let al = app.autolaunch();
    let _ = if enabled { al.enable() } else { al.disable() };
}

/// Quits for real: ends every shell, then the app.
pub fn quit(app: &AppHandle) {
    window::save_bounds(app);
    if let Some(core) = app.try_state::<Arc<Core>>() {
        core.ptys.set_shutting_down();
        core.ptys.kill_all();
    }
    app.exit(0);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Track", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Track", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &settings, &PredefinedMenuItem::separator(app)?, &quit_item])?;
    TrayIconBuilder::with_id("track")
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("Track")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => window::show(app),
            "settings" => {
                window::show(app);
                let _ = app.emit("navigate", "settings");
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                window::toggle(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // A second launch: hand its folders ("Open in Track") to this one.
            let folders = explorer::folders_from_args(&args, std::path::Path::new(&cwd));
            window::show(app);
            if !folders.is_empty() {
                let _ = app.emit("open-folders", folders);
            }
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let prefs = Arc::new(Prefs::load(&data_dir));
            let settings = prefs.get();
            let shells = shells::Shells::start();
            let side_by_side = app.config().identifier.ends_with(".dev");
            let core = Arc::new(Core {
                ptys: pty::Ptys::new(handle.clone(), prefs.clone(), shells.clone()),
                prefs: prefs.clone(),
                shells,
                workspace: Arc::new(workspace::Store::new(&data_dir)),
                sounds: Arc::new(sounds::Sounds::new(&data_dir)),
                data_dir: data_dir.clone(),
                pending_open: std::sync::Mutex::new(explorer::folders_from_args(
                    &std::env::args().collect::<Vec<_>>(),
                    &std::env::current_dir().unwrap_or_default(),
                )),
                side_by_side,
            });
            app.manage(core.clone());
            app.manage(update::Pending::default());

            window::install(&handle, &prefs);
            let main = app.get_webview_window("main").expect("main window");
            let events_app = handle.clone();
            let events_window = main.clone();
            main.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    window::hide(&events_app);
                }
                WindowEvent::Focused(on) => window::set_focused(&events_app, *on),
                WindowEvent::ThemeChanged(_) => window::apply_material(&events_window),
                _ => {}
            });

            build_tray(&handle)?;
            // A side-by-side dev identity (tauri.dev.json) must never repoint
            // the real Track's Holster tile, hooks or Explorer menu at itself.
            holster::start(handle.clone(), &data_dir, !side_by_side);
            if !side_by_side {
                std::thread::spawn(|| {
                    hook::refresh_if_installed();
                    hook::codex_refresh_if_installed();
                });
                let menu_dir = data_dir.clone();
                std::thread::spawn(move || explorer::refresh_if_registered(&menu_dir));
            }
            sync_autostart(&handle, settings.launch_at_startup);
            // At sign-in Track waits in the tray; otherwise it opens.
            if !std::env::args().any(|a| a == "--autostart") {
                window::show(&handle);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::update_settings,
            commands::load_workspace,
            commands::save_workspace,
            commands::list_shells,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_ack,
            commands::pty_focus,
            commands::pty_list,
            commands::pty_busy,
            commands::list_fonts,
            commands::fs_list,
            commands::fs_places,
            commands::fs_drives,
            commands::fs_complete,
            commands::fs_projects,
            commands::fs_info,
            commands::fs_reveal,
            commands::fs_create_dir,
            commands::codex_status,
            commands::codex_install,
            commands::codex_remove,
            commands::note_recent,
            commands::sounds_list,
            commands::sound_import,
            commands::sound_read,
            commands::sound_remove,
            commands::hook_status,
            commands::hook_install,
            commands::hook_remove,
            commands::holster_status,
            commands::take_pending_open,
            commands::explorer_status,
            commands::explorer_install,
            commands::explorer_remove,
            commands::window_hide,
            commands::app_quit,
            commands::update_check,
            commands::update_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Track");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(core) = app.try_state::<Arc<Core>>() {
                core.ptys.set_shutting_down();
                core.ptys.kill_all();
            }
        }
    });
}
