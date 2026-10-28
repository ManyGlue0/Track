//! "Open in Track" at the top level of the Windows 11 Explorer context menu.
//!
//! Explorer only shows packaged verbs there, so Track registers a sparse
//! package (`sparse/AppxManifest.xml`): an identity-only package whose external
//! location is Track's own folder, declaring `track_shell.dll` (shell-ext) as
//! the verb for folders and folder backgrounds. Registering an unsigned
//! package from loose files needs Windows' Developer Mode.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::settings::write_if_changed;

const PACKAGE: &str = "Track.ExplorerMenu";
const MANIFEST: &str = include_str!("../sparse/AppxManifest.xml");
const ASSETS: [(&str, &[u8]); 3] = [
    ("StoreLogo.png", include_bytes!("../icons/StoreLogo.png")),
    ("Square150x150Logo.png", include_bytes!("../icons/Square150x150Logo.png")),
    ("Square44x44Logo.png", include_bytes!("../icons/Square44x44Logo.png")),
];
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuStatus {
    /// "on", "off", "outdated" (registered for another copy of Track) or "unavailable".
    pub state: String,
    pub message: Option<String>,
    pub developer_mode: bool,
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

fn developer_mode() -> bool {
    Command::new("reg")
        .args(["query", r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock", "/v", "AllowDevelopmentWithoutDevLicense"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("0x1"))
        .unwrap_or(false)
}

fn powershell(script: &str) -> Result<String, String> {
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        Ok(stdout)
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        // PowerShell errors are long; the first line says what happened.
        let first = err.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("PowerShell failed").to_string();
        Err(first)
    }
}

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The Track folder the registered menu runs (the package's external
/// location), if the menu is registered. `Get-AppxPackage` doesn't report it
/// (its InstallLocation comes back empty once the folder the manifest was
/// registered from is gone), but the package repository keeps it as
/// `PackageRootFolder`.
fn registered_dir() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::*;
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let repo = wide(r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages");
    let prefix = format!("{PACKAGE}_");
    unsafe {
        let mut key: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, repo.as_ptr(), 0, KEY_READ, &mut key) != 0 {
            return None;
        }
        let mut found = None;
        let mut name = [0u16; 512];
        for i in 0.. {
            let mut len = name.len() as u32;
            let r = RegEnumKeyExW(key, i, name.as_mut_ptr(), &mut len, std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
            if r != 0 {
                break;
            }
            let full = String::from_utf16_lossy(&name[..len as usize]);
            if !full.starts_with(&prefix) {
                continue;
            }
            let value = wide("PackageRootFolder");
            let mut buf = [0u16; 1024];
            let mut size = std::mem::size_of_val(&buf) as u32;
            let sub = wide(&full);
            if RegGetValueW(key, sub.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size) == 0 {
                let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                found = Some(PathBuf::from(String::from_utf16_lossy(&buf[..n])));
            }
            break;
        }
        RegCloseKey(key);
        found
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.display().to_string().trim_end_matches('\\').to_lowercase();
    norm(a) == norm(b)
}

/// `side_by_side`: this is Track Dev, which must never take the menu over from
/// the installed Track (the menu would then start a dev build).
pub fn status(side_by_side: bool) -> MenuStatus {
    let dev = developer_mode();
    let here = exe_dir();
    let dll_ok = here.as_ref().is_some_and(|d| d.join("track_shell.dll").is_file());
    let state = match registered_dir() {
        Some(dir) if here.as_ref().is_some_and(|h| same_dir(&dir, h)) => "on",
        _ if side_by_side => "unavailable",
        Some(_) => "outdated",
        None if !dll_ok => "unavailable",
        None => "off",
    };
    let message = match state {
        "unavailable" if side_by_side => Some("Track Dev leaves the Explorer menu to the installed Track".to_string()),
        "unavailable" => Some("This copy of Track is missing track_shell.dll".to_string()),
        "off" if !dev => Some("Needs Windows Developer Mode (Settings › System › For developers) for now".to_string()),
        _ => None,
    };
    MenuStatus { state: state.into(), message, developer_mode: dev }
}

pub fn install(data_dir: &Path, side_by_side: bool) -> Result<MenuStatus, String> {
    if side_by_side {
        return Err("Track Dev leaves the Explorer menu to the installed Track".into());
    }
    let ext = exe_dir().ok_or("Couldn't find Track's folder")?;
    if !ext.join("track_shell.dll").is_file() {
        return Err("track_shell.dll isn't next to track.exe (build it with `cargo build -p track-shell`)".into());
    }
    let root = data_dir.join("explorer-menu");
    let assets = root.join("Assets");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    for (name, bytes) in ASSETS {
        std::fs::write(assets.join(name), bytes).map_err(|e| e.to_string())?;
    }
    let manifest = root.join("AppxManifest.xml");
    write_if_changed(&manifest, MANIFEST).map_err(|e| e.to_string())?;
    let script = format!(
        "$ErrorActionPreference = 'Stop'; Get-AppxPackage -Name {PACKAGE} | Remove-AppxPackage; Add-AppxPackage -Register {} -ExternalLocation {}",
        ps_quote(&manifest.display().to_string()),
        ps_quote(&ext.display().to_string()),
    );
    powershell(&script).map_err(|e| {
        if developer_mode() {
            format!("Windows refused the menu: {e}")
        } else {
            "Turn on Developer Mode (Settings › System › For developers), then try again".to_string()
        }
    })?;
    Ok(status(false))
}

pub fn remove(side_by_side: bool) -> Result<MenuStatus, String> {
    powershell(&format!("Get-AppxPackage -Name {PACKAGE} | Remove-AppxPackage"))?;
    Ok(status(side_by_side))
}

/// Track moved (a new build or install folder), or the menu points at another
/// copy (a dev build): point it at this one.
pub fn refresh_if_registered(data_dir: &Path) {
    if status(false).state == "outdated" {
        if let Err(e) = install(data_dir, false) {
            eprintln!("explorer: couldn't update the menu: {e}");
        }
    }
}

/// Folders handed to Track on its command line: `--open <dir>` (from the
/// Explorer menu), or bare directory paths (`track .` from a shell).
pub fn folders_from_args(args: &[String], cwd: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut it = args.iter().skip(1).peekable();
    while let Some(a) = it.next() {
        let candidate = if a == "--open" {
            match it.next() {
                Some(p) => p.clone(),
                None => break,
            }
        } else if a.starts_with('-') {
            continue;
        } else {
            a.clone()
        };
        let p = Path::new(candidate.trim_matches('"'));
        let p = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
        if let Ok(full) = std::fs::canonicalize(&p) {
            if full.is_dir() {
                // canonicalize gives \\?\C:\…; Track wants the plain form.
                let s = full.display().to_string();
                out.push(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args() {
        let tmp = std::env::temp_dir();
        let t = tmp.display().to_string();
        let got = folders_from_args(&["track.exe".into(), "--open".into(), t.clone(), "--autostart".into()], &tmp);
        assert_eq!(got.len(), 1);
        assert!(got[0].eq_ignore_ascii_case(t.trim_end_matches('\\')));
        assert!(folders_from_args(&["track.exe".into(), "--hook".into()], &tmp).is_empty());
    }

    #[test]
    fn dirs() {
        assert!(same_dir(Path::new(r"C:\Users\A\AppData\Local\Track\"), Path::new(r"c:\users\a\appdata\local\track")));
        assert!(!same_dir(Path::new(r"E:\x\target\debug"), Path::new(r"C:\Users\A\AppData\Local\Track")));
    }
}
