//! The file system as Track's folder picker sees it: folders only, git repos
//! marked with their branch, known places, drives and path completion.

use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::Serialize;

const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub name: String,
    pub path: String,
    /// Branch (or short commit) when the folder is a git repository.
    pub git: Option<String>,
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub letter: String,
    pub label: String,
    pub path: String,
    /// "fixed" | "removable" | "network" | "other"
    pub kind: String,
}

/// Folder name for display (`E:\` for a drive root).
fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}

/// The branch checked out in `dir`, if it's a git repository (or worktree).
pub fn git_branch(dir: &Path) -> Option<String> {
    let dot = dir.join(".git");
    let meta = std::fs::metadata(&dot).ok()?;
    let git_dir = if meta.is_dir() {
        dot
    } else {
        // Worktrees and submodules: ".git" is a file pointing elsewhere.
        let text = std::fs::read_to_string(&dot).ok()?;
        let target = text.trim().strip_prefix("gitdir:")?.trim();
        let p = PathBuf::from(target);
        if p.is_absolute() {
            p
        } else {
            dir.join(p)
        }
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    Some(match head.strip_prefix("ref: refs/heads/") {
        Some(branch) => branch.to_string(),
        None => head.chars().take(7).collect(),
    })
}

pub fn list(path: &str, show_hidden: bool) -> Result<Vec<Folder>, String> {
    let dir = PathBuf::from(path);
    let entries = std::fs::read_dir(&dir).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => "Track isn't allowed to look inside this folder".to_string(),
        std::io::ErrorKind::NotFound => "This folder doesn't exist anymore".to_string(),
        _ => e.to_string(),
    })?;
    let mut out: Vec<Folder> = entries
        .flatten()
        .filter_map(|e| {
            let meta = std::fs::metadata(e.path()).ok()?;
            if !meta.is_dir() {
                return None;
            }
            let attrs = e.metadata().map(|m| m.file_attributes()).unwrap_or(0);
            let name = e.file_name().to_string_lossy().into_owned();
            let hidden = attrs & FILE_ATTRIBUTE_HIDDEN != 0 || name.starts_with('.');
            if attrs & FILE_ATTRIBUTE_SYSTEM != 0 && attrs & FILE_ATTRIBUTE_HIDDEN != 0 {
                return None; // $Recycle.Bin, System Volume Information…
            }
            if hidden && !show_hidden {
                return None;
            }
            let path = e.path();
            Some(Folder { git: git_branch(&path), name, path: path.display().to_string(), hidden })
        })
        .collect();
    out.sort_by_key(|f| f.name.to_lowercase());
    Ok(out)
}

pub fn places() -> Vec<Place> {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Profile, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
    };
    let known = [
        ("home", "Home", &FOLDERID_Profile),
        ("desktop", "Desktop", &FOLDERID_Desktop),
        ("documents", "Documents", &FOLDERID_Documents),
        ("downloads", "Downloads", &FOLDERID_Downloads),
    ];
    let mut out = Vec::new();
    for (id, name, folder) in known {
        unsafe {
            let mut p: windows_sys::core::PWSTR = std::ptr::null_mut();
            if SHGetKnownFolderPath(folder, KF_FLAG_DEFAULT as u32, std::ptr::null_mut(), &mut p) == 0 && !p.is_null() {
                let mut len = 0;
                while *p.add(len) != 0 {
                    len += 1;
                }
                let path = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
                if Path::new(&path).is_dir() {
                    out.push(Place { id: id.into(), name: name.into(), path });
                }
            }
            if !p.is_null() {
                CoTaskMemFree(p as *const _);
            }
        }
    }
    out
}

pub fn drives() -> Vec<Drive> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let root = format!("{letter}:\\");
        let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
        let kind = match unsafe { GetDriveTypeW(wide.as_ptr()) } {
            2 => "removable",
            3 => "fixed",
            4 => "network",
            5 => continue, // optical drives spin up and usually hold nothing
            _ => "other",
        };
        let mut label = [0u16; 261];
        let ok = unsafe {
            GetVolumeInformationW(
                wide.as_ptr(),
                label.as_mut_ptr(),
                label.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
            )
        };
        if ok == 0 && kind == "removable" {
            continue; // an empty card reader
        }
        let len = label.iter().position(|&c| c == 0).unwrap_or(0);
        let label = String::from_utf16_lossy(&label[..len]);
        let label = if label.is_empty() {
            match kind {
                "removable" => "USB drive".to_string(),
                "network" => "Network drive".to_string(),
                _ => "Local disk".to_string(),
            }
        } else {
            label
        };
        out.push(Drive { letter: letter.to_string(), label, path: root, kind: kind.into() });
    }
    out
}

/// Folders whose path starts with what's typed, for the path bar.
pub fn complete(input: &str) -> Vec<Folder> {
    let input = input.trim().trim_matches('"');
    if input.is_empty() {
        return Vec::new();
    }
    let expanded = expand_home(input);
    let (parent, prefix) = if expanded.ends_with(['\\', '/']) {
        (expanded.clone(), String::new())
    } else {
        let p = Path::new(&expanded);
        match (p.parent(), p.file_name()) {
            (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => {
                (parent.display().to_string(), name.to_string_lossy().to_lowercase())
            }
            _ => return Vec::new(),
        }
    };
    let Ok(items) = list(&parent, prefix.starts_with('.')) else { return Vec::new() };
    items.into_iter().filter(|f| f.name.to_lowercase().starts_with(&prefix)).take(8).collect()
}

pub fn expand_home(input: &str) -> String {
    if let Some(rest) = input.strip_prefix('~') {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            return format!("{}{}", PathBuf::from(home).display(), rest.replace('/', "\\"));
        }
    }
    input.to_string()
}

/// Git repositories next to the folders the user works in: the children of
/// the parents of recent and pinned repos (e.g. everything in `E:\GitProjects`).
pub fn projects(seeds: &[String]) -> Vec<Folder> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for seed in seeds {
        let p = Path::new(seed);
        if git_branch(p).is_some() {
            if let Some(parent) = p.parent() {
                if !roots.iter().any(|r| r == parent) {
                    roots.push(parent.to_path_buf());
                }
            }
        }
    }
    let mut out: Vec<Folder> = Vec::new();
    for root in roots.iter().take(4) {
        if let Ok(items) = list(&root.display().to_string(), false) {
            out.extend(items.into_iter().filter(|f| f.git.is_some()));
        }
    }
    out.sort_by_key(|f| f.name.to_lowercase());
    out.dedup_by(|a, b| a.path.eq_ignore_ascii_case(&b.path));
    out.truncate(40);
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub exists: bool,
    pub path: String,
    pub name: String,
    pub git: Option<String>,
}

pub fn info(path: &str) -> FolderInfo {
    let expanded = expand_home(path.trim().trim_matches('"'));
    let p = Path::new(&expanded);
    FolderInfo { exists: p.is_dir(), path: expanded.clone(), name: name_of(p), git: git_branch(p) }
}

/// Shows the folder in a new File Explorer window.
pub fn open_in_explorer(path: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let expanded = expand_home(path.trim().trim_matches('"'));
    if !Path::new(&expanded).is_dir() {
        return Err("This folder doesn't exist anymore".into());
    }
    // Quoted by hand: Explorer reads an unquoted comma as a switch separator.
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("\"{expanded}\""))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open File Explorer ({e})"))
}

/// Makes a new folder `name` inside `parent` (the picker's "New folder").
pub fn create_dir(parent: &str, name: &str) -> Result<Folder, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the folder a name".into());
    }
    if let Some(c) = name.chars().find(|c| r#"<>:"/\|?*"#.contains(*c) || c.is_control()) {
        return Err(format!("Folder names can't contain {c}"));
    }
    if name.ends_with('.') || name == ".." {
        return Err("Folder names can't end with a dot".into());
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        return Err(format!("Windows reserves the name {name}"));
    }
    let path = PathBuf::from(parent).join(name);
    if path.exists() {
        return Err("There's already something with that name here".into());
    }
    std::fs::create_dir(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => "Track isn't allowed to create a folder here".to_string(),
        _ => e.to_string(),
    })?;
    Ok(Folder { name: name.to_string(), path: path.display().to_string(), git: None, hidden: false })
}
