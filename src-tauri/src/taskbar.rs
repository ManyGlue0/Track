//! Taskbar thumbnail and peek for the main window.
//!
//! Track's background is the accent-policy acrylic, which Windows leaves out
//! of the peek preview (hovering the taskbar thumbnail): the window showed as
//! see-through glass over the desktop. Track hands Windows its own bitmaps
//! instead, captured with PrintWindow, which draws the acrylic's tint as a
//! solid background.

use std::sync::Mutex;

use windows_sys::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows_sys::Win32::Graphics::Dwm::{
    DwmInvalidateIconicBitmaps, DwmSetIconicLivePreviewBitmap, DwmSetIconicThumbnail, DwmSetWindowAttribute,
    DWMWA_FORCE_ICONIC_REPRESENTATION, DWMWA_HAS_ICONIC_BITMAP,
};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, HBITMAP,
};
use windows_sys::Win32::Storage::Xps::{PrintWindow, PW_CLIENTONLY};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClientRect, IsIconic, IsWindowVisible, KillTimer, SetTimer, PW_RENDERFULLCONTENT, WM_DWMSENDICONICLIVEPREVIEWBITMAP,
    WM_DWMSENDICONICTHUMBNAIL, WM_TIMER,
};

/// Refreshes the bitmaps a moment after Windows took them, so a thumbnail
/// left open keeps up and the next hover is current.
const REFRESH_TIMER: usize = 0x7EA1;
const REFRESH_MS: u32 = 1000;

/// The last capture: a minimized window can't be captured, so it shows this.
static LAST: Mutex<Option<Shot>> = Mutex::new(None);

struct Shot {
    w: i32,
    h: i32,
    px: Vec<u32>,
}

pub fn install(hwnd: HWND) {
    let on: i32 = 1;
    unsafe {
        for attr in [DWMWA_FORCE_ICONIC_REPRESENTATION, DWMWA_HAS_ICONIC_BITMAP] {
            DwmSetWindowAttribute(hwnd, attr as u32, &on as *const _ as *const _, 4);
        }
    }
}

/// Handles Windows' requests for the bitmaps; `None` for every other message.
pub unsafe fn on_message(hwnd: HWND, msg: u32, wparam: usize, lparam: LPARAM) -> Option<isize> {
    match msg {
        WM_DWMSENDICONICTHUMBNAIL => {
            let (max_w, max_h) = (((lparam >> 16) & 0xFFFF) as i32, (lparam & 0xFFFF) as i32);
            with_shot(hwnd, |shot| {
                let (w, h) = fit(shot.w, shot.h, max_w, max_h);
                if let Some((bmp, bits)) = dib(w, h) {
                    scale_into(shot, bits, w, h);
                    DwmSetIconicThumbnail(hwnd, bmp, 0);
                    DeleteObject(bmp);
                }
            });
            Some(0)
        }
        WM_DWMSENDICONICLIVEPREVIEWBITMAP => {
            with_shot(hwnd, |shot| {
                if let Some((bmp, bits)) = dib(shot.w, shot.h) {
                    std::ptr::copy_nonoverlapping(shot.px.as_ptr(), bits, shot.px.len());
                    let origin = POINT { x: 0, y: 0 };
                    DwmSetIconicLivePreviewBitmap(hwnd, bmp, &origin, 0);
                    DeleteObject(bmp);
                }
            });
            Some(0)
        }
        WM_TIMER if wparam == REFRESH_TIMER => {
            KillTimer(hwnd, REFRESH_TIMER);
            DwmInvalidateIconicBitmaps(hwnd);
            Some(0)
        }
        _ => None,
    }
}

/// Runs `f` on a fresh capture (or the last one while minimized).
unsafe fn with_shot(hwnd: HWND, f: impl FnOnce(&Shot)) {
    let mut last = LAST.lock().unwrap();
    if IsIconic(hwnd) == 0 && IsWindowVisible(hwnd) != 0 {
        if let Some(shot) = capture(hwnd) {
            *last = Some(shot);
        }
        SetTimer(hwnd, REFRESH_TIMER, REFRESH_MS, None);
    }
    if let Some(shot) = last.as_ref() {
        f(shot);
    }
}

unsafe fn capture(hwnd: HWND) -> Option<Shot> {
    // The client area only: the window rect adds the invisible resize
    // borders, and Windows lines the peek bitmap up with the client area.
    let mut r: RECT = std::mem::zeroed();
    GetClientRect(hwnd, &mut r);
    let (w, h) = (r.right - r.left, r.bottom - r.top);
    let (bmp, bits) = dib(w, h)?;
    let dc = CreateCompatibleDC(std::ptr::null_mut());
    let old = SelectObject(dc, bmp);
    let ok = PrintWindow(hwnd, dc, PW_CLIENTONLY | PW_RENDERFULLCONTENT) != 0;
    SelectObject(dc, old);
    DeleteDC(dc);
    let shot = ok.then(|| {
        let mut px = std::slice::from_raw_parts(bits, (w * h) as usize).to_vec();
        // Opaque, whatever the capture left in alpha.
        px.iter_mut().for_each(|p| *p |= 0xFF00_0000);
        Shot { w, h, px }
    });
    DeleteObject(bmp);
    shot
}

/// A top-down 32-bit DIB and its pixels.
unsafe fn dib(w: i32, h: i32) -> Option<(HBITMAP, *mut u32)> {
    if w <= 0 || h <= 0 {
        return None;
    }
    let mut info: BITMAPINFO = std::mem::zeroed();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        ..std::mem::zeroed()
    };
    let mut bits = std::ptr::null_mut();
    let bmp = CreateDIBSection(std::ptr::null_mut(), &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
    (!bmp.is_null() && !bits.is_null()).then_some((bmp, bits as *mut u32))
}

/// The largest size with the window's proportions that fits the slot.
fn fit(w: i32, h: i32, max_w: i32, max_h: i32) -> (i32, i32) {
    if w <= 0 || h <= 0 || max_w <= 0 || max_h <= 0 {
        return (max_w.max(1), max_h.max(1));
    }
    let scale = (max_w as f64 / w as f64).min(max_h as f64 / h as f64).min(1.0);
    (((w as f64 * scale).round() as i32).max(1), ((h as f64 * scale).round() as i32).max(1))
}

/// Area-averaged downscale, so small text stays smooth in the thumbnail.
unsafe fn scale_into(shot: &Shot, out: *mut u32, w: i32, h: i32) {
    let (sw, sh) = (shot.w as usize, shot.h as usize);
    let (w, h) = (w as usize, h as usize);
    for y in 0..h {
        let (y0, y1) = (y * sh / h, ((y + 1) * sh / h).max(y * sh / h + 1).min(sh));
        for x in 0..w {
            let (x0, x1) = (x * sw / w, ((x + 1) * sw / w).max(x * sw / w + 1).min(sw));
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for sy in y0..y1 {
                for &p in &shot.px[sy * sw + x0..sy * sw + x1] {
                    r += (p >> 16) & 0xFF;
                    g += (p >> 8) & 0xFF;
                    b += p & 0xFF;
                    n += 1;
                }
            }
            *out.add(y * w + x) = 0xFF00_0000 | ((r / n) << 16) | ((g / n) << 8) | (b / n);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits() {
        assert_eq!(fit(1280, 800, 200, 120), (192, 120));
        assert_eq!(fit(1280, 800, 300, 300), (300, 188));
        assert_eq!(fit(100, 50, 300, 300), (100, 50));
    }

    #[test]
    fn averages() {
        let shot = Shot { w: 2, h: 2, px: vec![0xFF000000, 0xFF0000FF, 0xFF0000FF, 0xFF000000] };
        let mut out = [0u32; 1];
        unsafe { scale_into(&shot, out.as_mut_ptr(), 1, 1) };
        assert_eq!(out[0], 0xFF00007F);
    }
}
