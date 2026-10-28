//! Installed font families, for the font picker. Monospaced ones are flagged
//! so the picker can lead with them.

use serde::Serialize;
use windows_sys::Win32::Foundation::LPARAM;
use windows_sys::Win32::Graphics::Gdi::{
    EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, FIXED_PITCH, LOGFONTW, RASTER_FONTTYPE, TEXTMETRICW,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct FontInfo {
    pub name: String,
    pub mono: bool,
}

pub fn list() -> Vec<FontInfo> {
    unsafe extern "system" fn cb(lf: *const LOGFONTW, _tm: *const TEXTMETRICW, kind: u32, data: LPARAM) -> i32 {
        let out = &mut *(data as *mut Vec<FontInfo>);
        let lf = &*lf;
        // Bitmap fonts (Terminal, Fixedsys) don't scale; skip them.
        if kind & RASTER_FONTTYPE != 0 {
            return 1;
        }
        let len = lf.lfFaceName.iter().position(|&c| c == 0).unwrap_or(lf.lfFaceName.len());
        let name = String::from_utf16_lossy(&lf.lfFaceName[..len]);
        // "@Name" entries are the vertical-writing variants.
        if !name.is_empty() && !name.starts_with('@') {
            out.push(FontInfo { name, mono: (lf.lfPitchAndFamily as u32 & 0x3) == FIXED_PITCH as u32 });
        }
        1
    }
    let mut out: Vec<FontInfo> = Vec::new();
    unsafe {
        let hdc = GetDC(std::ptr::null_mut());
        let mut lf: LOGFONTW = std::mem::zeroed();
        lf.lfCharSet = DEFAULT_CHARSET as u8;
        EnumFontFamiliesExW(hdc, &lf, Some(cb), &mut out as *mut _ as LPARAM, 0);
        ReleaseDC(std::ptr::null_mut(), hdc);
    }
    out.sort_by_key(|f| (f.name.to_lowercase(), !f.mono));
    // A family is enumerated once per script; keep one, monospaced if any says so.
    out.dedup_by(|b, a| {
        if a.name.eq_ignore_ascii_case(&b.name) {
            a.mono |= b.mono;
            true
        } else {
            false
        }
    });
    out
}
