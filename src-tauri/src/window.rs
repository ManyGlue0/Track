//! The main window: a frameless, resizable acrylic window. Closing hides it to
//! the tray (shells keep running); its placement is remembered across runs.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, Theme};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};
use windows_sys::Win32::Graphics::Gdi::{MonitorFromRect, MONITOR_DEFAULTTONULL};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

use crate::settings::{Prefs, WindowBounds};
use crate::Core;

static FOCUSED: AtomicBool = AtomicBool::new(false);
/// The main window, for asking Windows directly whether it's in front.
static MAIN: AtomicIsize = AtomicIsize::new(0);

const WM_TAKE_FOCUS: u32 = WM_APP + 8;

fn hwnd_of(app: &AppHandle) -> Option<HWND> {
    app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as HWND)
}

/// Track's main window (null before it exists), e.g. to own a UAC prompt.
pub fn main_hwnd() -> isize {
    MAIN.load(Ordering::SeqCst)
}

/// Brings the main window to the front from any thread, e.g. after a UAC
/// prompt took the foreground.
pub fn take_focus_later() {
    match MAIN.load(Ordering::SeqCst) {
        0 => {}
        h => unsafe {
            PostMessageW(h as HWND, WM_TAKE_FOCUS, 0, 0);
        },
    }
}

/// The window is in front and focused: the user can see what's in it.
/// Windows is asked directly: the focus events don't arrive for every way of
/// leaving (minimizing from the taskbar, for one).
pub fn is_active() -> bool {
    match MAIN.load(Ordering::SeqCst) {
        0 => FOCUSED.load(Ordering::SeqCst),
        h => unsafe { GetForegroundWindow() as isize == h && IsIconic(h as HWND) == 0 },
    }
}

pub fn set_focused(app: &AppHandle, on: bool) {
    FOCUSED.store(on, Ordering::SeqCst);
    if on {
        if let Some(core) = app.try_state::<Arc<Core>>() {
            core.ptys.on_window_active();
        }
    }
}

pub fn install(app: &AppHandle, prefs: &Prefs) {
    let Some(w) = app.get_webview_window("main") else { return };
    let Some(hwnd) = hwnd_of(app) else { return };
    unsafe {
        let pref = DWMWCP_ROUND;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &pref as *const _ as *const _,
            std::mem::size_of_val(&pref) as u32,
        );
        SetWindowSubclass(hwnd, Some(subclass_proc), 1, 0);
        crate::taskbar::install(hwnd);
        MAIN.store(hwnd as isize, Ordering::SeqCst);
    }
    let settings = prefs.get();
    apply_theme(app, &settings.theme);
    if let Some(b) = settings.window.as_ref().filter(|b| on_screen(b)) {
        unsafe {
            let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
            wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
            GetWindowPlacement(hwnd, &mut wp);
            wp.showCmd = SW_HIDE as u32;
            wp.rcNormalPosition = RECT { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
            SetWindowPlacement(hwnd, &wp);
        }
    } else {
        let _ = w.center();
    }
}

fn on_screen(b: &WindowBounds) -> bool {
    let r = RECT { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    b.right - b.left >= 200 && b.bottom - b.top >= 150 && unsafe { !MonitorFromRect(&r, MONITOR_DEFAULTTONULL).is_null() }
}

pub fn save_bounds(app: &AppHandle) {
    let Some(hwnd) = hwnd_of(app) else { return };
    let Some(core) = app.try_state::<Arc<Core>>() else { return };
    unsafe {
        if IsWindowVisible(hwnd) == 0 {
            return;
        }
        let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
        wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
        if GetWindowPlacement(hwnd, &mut wp) == 0 {
            return;
        }
        let r = wp.rcNormalPosition;
        let bounds = WindowBounds {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            maximized: IsZoomed(hwnd) != 0,
        };
        if core.prefs.get().window.as_ref() != Some(&bounds) {
            core.prefs.update(|s| s.window = Some(bounds));
        }
    }
}

pub fn show(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let first = !w.is_visible().unwrap_or(false);
    let _ = w.show();
    if w.is_minimized().unwrap_or(false) {
        let _ = w.unminimize();
    }
    if first {
        let maximized = app
            .try_state::<Arc<Core>>()
            .and_then(|c| c.prefs.get().window.map(|b| b.maximized))
            .unwrap_or(false);
        if maximized {
            let _ = w.maximize();
        }
    }
    // Focus must be taken on the window's own thread to be honored while
    // another app owns the foreground.
    if let Some(h) = hwnd_of(app) {
        unsafe { PostMessageW(h, WM_TAKE_FOCUS, 0, 0) };
    }
    let _ = app.emit("window-shown", ());
}

pub fn hide(app: &AppHandle) {
    save_bounds(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    set_focused(app, false);
}

pub fn toggle(app: &AppHandle) {
    let shown = hwnd_of(app).is_some_and(|h| unsafe { IsWindowVisible(h) != 0 && IsIconic(h) == 0 });
    if shown && is_active() {
        hide(app);
    } else {
        show(app);
    }
}

pub fn apply_theme(app: &AppHandle, theme: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_theme(match theme {
            "light" => Some(Theme::Light),
            "dark" => Some(Theme::Dark),
            _ => None,
        });
        apply_material(&w);
    }
}

/// Tints the frosted material for the effective (light/dark) theme.
pub fn apply_material(w: &tauri::WebviewWindow) {
    let dark = w.theme().map(|t| t == Theme::Dark).unwrap_or(false);
    if let Ok(hwnd) = w.hwnd() {
        if !acrylic(hwnd.0 as isize, dark) {
            let tint = if dark { (28, 26, 26, 160) } else { (244, 244, 246, 160) };
            let _ = window_vibrancy::apply_blur(w, Some(tint));
        }
    }
}

/// Frosted acrylic via the window accent policy: unlike the DWM system
/// backdrop it stays frosted while the window is inactive.
fn acrylic(hwnd: isize, dark: bool) -> bool {
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    #[repr(C)]
    struct AccentPolicy {
        state: u32,
        flags: u32,
        gradient: u32,
        animation: u32,
    }
    #[repr(C)]
    struct WinCompAttrData {
        attrib: u32,
        data: *mut std::ffi::c_void,
        size: usize,
    }
    type SetWca = unsafe extern "system" fn(HWND, *mut WinCompAttrData) -> i32;
    unsafe {
        let none: u32 = 1; // DWMSBT_NONE: keep the system backdrop out of the way
        DwmSetWindowAttribute(hwnd as HWND, 38, &none as *const _ as *const _, 4);
        let user32: Vec<u16> = "user32.dll\0".encode_utf16().collect();
        let module = GetModuleHandleW(user32.as_ptr());
        let Some(proc) = GetProcAddress(module, c"SetWindowCompositionAttribute".as_ptr() as *const u8) else {
            return false;
        };
        let set: SetWca = std::mem::transmute(proc);
        // ABGR. The window resizes a lot, so the veil is baked into the tint
        // (no CSS veil): edges exposed mid-resize already look finished.
        let gradient = if dark { 0xB01D1919u32 } else { 0xC2F9F7F7u32 };
        let mut policy = AccentPolicy { state: 4, flags: 2, gradient, animation: 0 };
        let mut data = WinCompAttrData {
            attrib: 19, // WCA_ACCENT_POLICY
            data: &mut policy as *mut _ as *mut _,
            size: std::mem::size_of::<AccentPolicy>(),
        };
        set(hwnd as HWND, &mut data) != 0
    }
}

/// Brings the window to the foreground. Attaching to the foreground thread's
/// input lets Windows accept the switch even when another app is in front.
unsafe fn take_focus(hwnd: HWND) {
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    let fg = GetForegroundWindow();
    if fg != hwnd {
        let me = GetCurrentThreadId();
        let other = if fg.is_null() { 0 } else { GetWindowThreadProcessId(fg, std::ptr::null_mut()) };
        let attached = other != 0 && other != me && AttachThreadInput(me, other, 1) != 0;
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        if attached {
            AttachThreadInput(me, other, 0);
        }
    }
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if let Some(handled) = crate::taskbar::on_message(hwnd, msg, wparam, lparam) {
        return handled;
    }
    match msg {
        // Keep the acrylic in its active look while another window has focus.
        WM_NCACTIVATE => return DefSubclassProc(hwnd, msg, 1, lparam),
        WM_TAKE_FOCUS => {
            take_focus(hwnd);
            return 0;
        }
        // A lone Alt press would open the system menu; in a terminal, Alt
        // belongs to the shell. Alt+Space (lParam = ' ') still opens it.
        WM_SYSCOMMAND if (wparam & 0xFFF0) as u32 == SC_KEYMENU && lparam == 0 => return 0,
        _ => {}
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}
