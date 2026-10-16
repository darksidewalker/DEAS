//! Serialize folder changes against native writer startup without stopping any service.
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::Manager;

#[derive(Clone, Default)]
pub struct FolderOperations(Arc<Mutex<()>>);
impl FolderOperations {
    pub fn enter(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.0
            .try_lock()
            .map_err(|_| "A folder operation is in progress; retry after it finishes".into())
    }
}
#[tauri::command]
pub async fn native_settings_move(
    root: String,
    folders: crate::settings::Folders,
    confirmed: bool,
    app: tauri::AppHandle,
) -> Result<crate::settings::MoveReport, String> {
    if !confirmed {
        return Err("Explicit folder move confirmation is required".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let operations = app.state::<FolderOperations>();
        let _guard = operations.enter()?;
        if !app.state::<crate::install::Engine>().folders_idle()
            || app.state::<crate::downloads::DownloadEngine>().status()?.state == "running" {
            return Err("Stop the owned backend and wait for installations/downloads before moving folders. No service was stopped.".into());
        }
        crate::settings::move_folders(std::path::Path::new(&root), folders)
    }).await.map_err(|e| format!("Folder move worker failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folder_operation_excludes_other_writers_until_released() {
        let operations = FolderOperations::default();
        let clone = operations.clone();
        let guard = operations.enter().unwrap();
        assert!(clone.enter().is_err());
        drop(guard);
        assert!(clone.enter().is_ok());
    }
}
