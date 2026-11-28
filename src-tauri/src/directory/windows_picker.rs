use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf};
use windows::{
    core::{Result, HRESULT, HSTRING},
    Win32::{
        Foundation::ERROR_CANCELLED,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
        },
        UI::Shell::{
            FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PICKFOLDERS,
            SIGDN_FILESYSPATH,
        },
    },
};

struct Apartment;

impl Apartment {
    fn init() -> Result<Self> {
        // The picker runs on a new thread and releases COM before returning its result.
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok()? };
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

// The caller keeps its COM apartment alive for the lifetime of the dialog.
unsafe fn folder_dialog() -> Result<IFileOpenDialog> {
    let dialog: IFileOpenDialog =
        unsafe { CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)? };
    let defaults = unsafe { dialog.GetOptions()? };
    // Windows can lock a folder while it is a process's working directory.
    unsafe {
        dialog.SetOptions(defaults | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR)?;
    }
    Ok(dialog)
}

pub(super) fn pick(title: &str) -> Result<Option<PathBuf>> {
    let _apartment = Apartment::init()?;
    unsafe {
        let dialog = folder_dialog()?;
        dialog.SetTitle(&HSTRING::from(title))?;
        match dialog.Show(None) {
            Ok(()) => {}
            Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => {
                return Ok(None)
            }
            Err(error) => return Err(error),
        }

        let selection = dialog.GetResult()?;
        let path = selection.GetDisplayName(SIGDN_FILESYSPATH)?;
        let owned_path = PathBuf::from(OsString::from_wide(path.as_wide()));
        CoTaskMemFree(Some(path.as_ptr().cast()));
        Ok(Some(owned_path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_dialog_preserves_working_directory() {
        let _apartment = Apartment::init().unwrap();
        let dialog = unsafe { folder_dialog() }.unwrap();
        let options = unsafe { dialog.GetOptions() }.unwrap();
        assert!(options.contains(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR));
    }
}
