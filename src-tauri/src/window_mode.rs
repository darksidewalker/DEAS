//! How DEAS's own main window opens: windowed, maximized or fullscreen. The choice must be known before the
//! window exists, so it lives in DEAS's app-data folder instead of the webview's storage; the interface writes
//! it and the next start reads it. Nothing else about the window (size, position, monitor) is DEAS's business.
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

pub const FILE: &str = "deas-window.json";
pub const MODES: [&str; 3] = ["windowed", "maximized", "fullscreen"];
/// A small floating window was the complaint; the whole screen with its frame is the normal case.
pub const DEFAULT_MODE: &str = "maximized";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_mode: Option<String>,
}

/// Only the three offered modes; anything else is refused instead of guessing.
pub fn validate(mode: &str) -> Result<String, String> {
    if MODES.contains(&mode) {
        Ok(mode.to_owned())
    } else {
        Err("Start window must be windowed, maximized or fullscreen".into())
    }
}

/// The mode the next start should use. An absent, unreadable or foreign file falls back to the default,
/// because a damaged preference may never stop the app from opening.
pub fn read_mode(root: &Path) -> String {
    let stored = std::fs::read(root.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<WindowSettings>(&bytes).ok())
        .and_then(|settings| settings.start_mode)
        .unwrap_or_default();
    if MODES.contains(&stored.as_str()) {
        stored
    } else {
        DEFAULT_MODE.to_owned()
    }
}

fn write(root: &Path, mode: &str) -> Result<(), String> {
    let target = root.join(FILE);
    let bytes = serde_json::to_vec(&WindowSettings {
        start_mode: Some(mode.to_owned()),
    })
    .map_err(|_| "Cannot build window settings".to_string())?;
    std::fs::create_dir_all(root)
        .map_err(|_| "Cannot create the DEAS preferences folder".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(root)
        .map_err(|_| "Cannot create a window settings file".to_string())?;
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| "Cannot write window settings".to_string())?;
    temporary
        .persist(&target)
        .map_err(|_| "Cannot replace window settings".to_string())?;
    Ok(())
}

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate DEAS preferences directory".into())
}

/// Fixed window diagnostics; no free text, path or remote error string crosses this boundary.
fn log_error(operation: &str) {
    static LAST: Mutex<[Option<Instant>; 2]> = Mutex::new([None; 2]);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    let (slot, message) = match operation {
        "fullscreen" => (
            0,
            "ERROR: DEAS window: fullscreen could not be changed; the window kept its current state",
        ),
        "start-mode" => (
            1,
            "ERROR: DEAS window: the start-window choice could not be stored; the next start keeps the previous choice",
        ),
        _ => return,
    };
    if last[slot].is_some_and(|at| at.elapsed() < Duration::from_secs(60)) {
        return;
    }
    last[slot] = Some(Instant::now());
    crate::logs::push(crate::logs::Source::Deas, message);
}

/// Called by the interface when the window itself refused fullscreen (a Tauri core call, not DEAS code).
#[tauri::command]
pub fn native_logs_window_error(operation: String) {
    log_error(&operation);
}

/// The mode this installation starts with, as the select shows it.
#[tauri::command]
pub fn native_window_read(app: tauri::AppHandle) -> Result<String, String> {
    Ok(read_mode(&path(&app)?))
}

/// Stored for the next start; the current window is deliberately left alone, so a fullscreen choice can
/// never hide the interface without an explicit restart.
#[tauri::command]
pub fn native_window_write(app: tauri::AppHandle, start_mode: String) -> Result<String, String> {
    let mode = validate(&start_mode)?;
    write(&path(&app)?, &mode).inspect_err(|_| log_error("start-mode"))?;
    Ok(mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_three_modes_are_accepted() {
        for mode in MODES {
            assert_eq!(validate(mode).unwrap(), mode);
        }
        for value in ["", "Maximized", "maximised", "full screen", "windowed "].iter() {
            assert!(validate(value).is_err(), "{value}");
        }
    }

    #[test]
    fn a_missing_or_damaged_file_starts_maximized() {
        let root = std::env::temp_dir().join(format!("deas-window-{}-missing", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(read_mode(&root), DEFAULT_MODE);
        for broken in [
            "",
            "not json",
            "{\"startMode\":\"fullscreenized\"}",
            "{\"start_mode\":\"fullscreen\"}",
            "{\"unexpected\":1}",
            "[]",
        ] {
            std::fs::write(root.join(FILE), broken).unwrap();
            assert_eq!(read_mode(&root), DEFAULT_MODE, "{broken}");
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_written_mode_survives_a_reload_and_stays_the_only_field() {
        let root =
            std::env::temp_dir().join(format!("deas-window-{}-roundtrip", std::process::id()));
        for mode in MODES {
            write(&root, mode).unwrap();
            assert_eq!(read_mode(&root), mode);
            let text = std::fs::read_to_string(root.join(FILE)).unwrap();
            assert_eq!(text, format!("{{\"startMode\":\"{mode}\"}}"));
        }
        std::fs::remove_dir_all(&root).ok();
    }
}
