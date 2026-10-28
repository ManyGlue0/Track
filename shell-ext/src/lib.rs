//! "Open in Track" for the Windows 11 File Explorer context menu.
//!
//! Windows 11 only shows packaged verbs at the top level of the menu: this DLL
//! implements the verb as an `IExplorerCommand`, and a sparse package (see
//! `src-tauri/sparse/AppxManifest.xml`) registers it for folders and folder
//! backgrounds. Explorer loads it in a surrogate process; invoking it starts
//! `track.exe --open <folder>` from the same directory, which hands the folder
//! to the running Track (or starts it).

#![allow(non_snake_case)]

use std::ffi::c_void;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;

use windows::core::{implement, Interface, Ref, Result, GUID, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_FAIL, E_NOINTERFACE, E_NOTIMPL, E_POINTER, HINSTANCE, S_FALSE,
};
use windows::Win32::System::Com::{CoTaskMemAlloc, IBindCtx, IClassFactory, IClassFactory_Impl, IServiceProvider};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::System::Ole::{IObjectWithSite, IObjectWithSite_Impl};
use windows::Win32::System::Threading::{
    CreateProcessW, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
};
use windows::Win32::UI::Shell::{
    IEnumExplorerCommand, IExplorerCommand, IExplorerCommand_Impl, IFolderView, IShellItem, IShellItemArray, ECF_DEFAULT,
    ECS_ENABLED, SIGDN_FILESYSPATH,
};
use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Com::CoTaskMemFree;

/// Must match the `Clsid` in the sparse package manifest.
pub const CLSID_OPEN_IN_TRACK: GUID = GUID::from_u128(0x6f1c3a52_8d4e_4b7a_9c2f_7a1e5b3d9c01);

static MODULE: AtomicIsize = AtomicIsize::new(0);

#[no_mangle]
extern "system" fn DllMain(module: HINSTANCE, reason: u32, _reserved: *mut c_void) -> i32 {
    const DLL_PROCESS_ATTACH: u32 = 1;
    if reason == DLL_PROCESS_ATTACH {
        MODULE.store(module.0 as isize, Ordering::SeqCst);
    }
    1
}

/// `track.exe`, next to this DLL.
fn track_exe() -> Option<String> {
    let mut buf = [0u16; 1024];
    let n = unsafe { GetModuleFileNameW(Some(windows::Win32::Foundation::HMODULE(MODULE.load(Ordering::SeqCst) as *mut c_void)), &mut buf) };
    if n == 0 {
        return None;
    }
    let dll = String::from_utf16_lossy(&buf[..n as usize]);
    let dir = dll.rsplit_once('\\')?.0;
    Some(format!("{dir}\\track.exe"))
}

/// A string Explorer will free with CoTaskMemFree.
fn co_string(s: &str) -> Result<PWSTR> {
    let wide: Vec<u16> = s.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let p = CoTaskMemAlloc(wide.len() * 2) as *mut u16;
        if p.is_null() {
            return Err(E_FAIL.into());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), p, wide.len());
        Ok(PWSTR(p))
    }
}

fn path_of(item: &IShellItem) -> Option<String> {
    unsafe {
        let p = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const c_void));
        s
    }
}

/// Quotes one argument for CreateProcess (a trailing backslash would escape the quote).
fn quote(arg: &str) -> String {
    let trailing = arg.chars().rev().take_while(|&c| c == '\\').count();
    format!("\"{}{}\"", arg, "\\".repeat(trailing))
}

#[implement(IExplorerCommand, IObjectWithSite)]
#[derive(Default)]
struct OpenInTrack {
    site: Mutex<Option<windows::core::IUnknown>>,
}

impl OpenInTrack {
    /// The folders to open: the selection, or (right-click on a folder's
    /// background) the folder being shown.
    fn folders(&self, items: Option<&IShellItemArray>) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(items) = items {
            unsafe {
                let count = items.GetCount().unwrap_or(0).min(16);
                for i in 0..count {
                    if let Some(p) = items.GetItemAt(i).ok().and_then(|it| path_of(&it)) {
                        out.push(p);
                    }
                }
            }
        }
        if out.is_empty() {
            let site = self.site.lock().unwrap().clone();
            if let Some(site) = site {
                unsafe {
                    let folder = site
                        .cast::<IServiceProvider>()
                        .and_then(|sp| sp.QueryService::<IFolderView>(&IFolderView::IID))
                        .and_then(|fv| fv.GetFolder::<IShellItem>());
                    if let Some(p) = folder.ok().and_then(|f| path_of(&f)) {
                        out.push(p);
                    }
                }
            }
        }
        out
    }
}

impl IExplorerCommand_Impl for OpenInTrack_Impl {
    fn GetTitle(&self, _items: Ref<IShellItemArray>) -> Result<PWSTR> {
        co_string("Open in Track")
    }

    fn GetIcon(&self, _items: Ref<IShellItemArray>) -> Result<PWSTR> {
        let exe = track_exe().ok_or(windows::core::Error::from(E_FAIL))?;
        co_string(&format!("{exe},0"))
    }

    fn GetToolTip(&self, _items: Ref<IShellItemArray>) -> Result<PWSTR> {
        Err(E_NOTIMPL.into())
    }

    fn GetCanonicalName(&self) -> Result<GUID> {
        Ok(CLSID_OPEN_IN_TRACK)
    }

    fn GetState(&self, _items: Ref<IShellItemArray>, _ok_to_be_slow: windows::core::BOOL) -> Result<u32> {
        Ok(ECS_ENABLED.0 as u32)
    }

    fn Invoke(&self, items: Ref<IShellItemArray>, _bind: Ref<IBindCtx>) -> Result<()> {
        let folders = self.folders(items.as_ref());
        if folders.is_empty() {
            return Ok(());
        }
        let exe = track_exe().ok_or(windows::core::Error::from(E_FAIL))?;
        let mut cmd = quote(&exe);
        for f in &folders {
            cmd.push_str(" --open ");
            cmd.push_str(&quote(f));
        }
        let mut wide: Vec<u16> = cmd.encode_utf16().chain(Some(0)).collect();
        unsafe {
            // Let Track take the foreground: the user just asked for it.
            let _ = AllowSetForegroundWindow(ASFW_ANY);
            let si = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, ..Default::default() };
            let mut pi = PROCESS_INFORMATION::default();
            CreateProcessW(
                PCWSTR::null(),
                Some(PWSTR(wide.as_mut_ptr())),
                None,
                None,
                false,
                CREATE_UNICODE_ENVIRONMENT,
                None,
                PCWSTR::null(),
                &si,
                &mut pi,
            )?;
            let _ = CloseHandle(pi.hThread);
            let _ = CloseHandle(pi.hProcess);
        }
        Ok(())
    }

    fn GetFlags(&self) -> Result<u32> {
        Ok(ECF_DEFAULT.0 as u32)
    }

    fn EnumSubCommands(&self) -> Result<IEnumExplorerCommand> {
        Err(E_NOTIMPL.into())
    }
}

impl IObjectWithSite_Impl for OpenInTrack_Impl {
    fn SetSite(&self, site: Ref<windows::core::IUnknown>) -> Result<()> {
        *self.site.lock().unwrap() = site.cloned();
        Ok(())
    }

    fn GetSite(&self, riid: *const GUID, out: *mut *mut c_void) -> Result<()> {
        if out.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe { *out = std::ptr::null_mut() };
        match self.site.lock().unwrap().as_ref() {
            Some(site) => unsafe { site.query(riid, out).ok() },
            None => Err(E_NOINTERFACE.into()),
        }
    }
}

#[implement(IClassFactory)]
struct Factory;

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(&self, outer: Ref<windows::core::IUnknown>, riid: *const GUID, out: *mut *mut c_void) -> Result<()> {
        if out.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe { *out = std::ptr::null_mut() };
        if outer.is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let cmd: IExplorerCommand = OpenInTrack::default().into();
        unsafe { cmd.query(riid, out).ok() }
    }

    fn LockServer(&self, _lock: windows::core::BOOL) -> Result<()> {
        Ok(())
    }
}

#[no_mangle]
unsafe extern "system" fn DllGetClassObject(clsid: *const GUID, riid: *const GUID, out: *mut *mut c_void) -> HRESULT {
    if out.is_null() {
        return E_POINTER;
    }
    *out = std::ptr::null_mut();
    if clsid.is_null() || *clsid != CLSID_OPEN_IN_TRACK {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    let factory: IClassFactory = Factory.into();
    factory.query(riid, out)
}

#[no_mangle]
extern "system" fn DllCanUnloadNow() -> HRESULT {
    // The surrogate process decides when to go; staying loaded is harmless.
    S_FALSE
}

#[cfg(test)]
mod tests {
    use super::quote;

    #[test]
    fn quoting() {
        assert_eq!(quote("E:\\"), "\"E:\\\\\"");
        assert_eq!(quote("C:\\My Dir"), "\"C:\\My Dir\"");
    }
}
