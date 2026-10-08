//! A native folder chooser, not a browser upload or a filesystem mutation.
use std::path::PathBuf;

fn validate_title(title: &str) -> Result<(), String> {
    if title.trim().is_empty() || title.len() > 240 || title.chars().any(char::is_control) {
        return Err("Directory chooser title must be nonempty, at most 240 bytes and contain no control characters".into());
    }
    Ok(())
}

fn selected_directory(path: Option<PathBuf>) -> Result<Option<String>, String> {
    let Some(path) = path else { return Ok(None) };
    if !path.is_absolute() || !path.is_dir() {
        return Err("The chooser did not return an existing absolute directory".into());
    }
    path.to_str()
        .map(|value| Some(value.to_owned()))
        .ok_or_else(|| "The selected directory cannot be represented as a UTF-8 path".into())
}

/// Selecting a parent never creates or installs anything; cancellation is null.
#[tauri::command]
pub async fn native_pick_directory(title: String) -> Result<Option<String>, String> {
    validate_title(&title)?;
    let chosen = rfd::AsyncFileDialog::new()
        .set_title(title)
        .set_can_create_directories(false)
        .pick_folder()
        .await;
    selected_directory(chosen.map(|handle| handle.path().to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_not_a_path_or_error() {
        assert_eq!(selected_directory(None).unwrap(), None);
    }

    #[test]
    fn returns_exact_existing_parent_without_creating_target() {
        let parent = tempfile::tempdir().unwrap();
        let selected = selected_directory(Some(parent.path().to_owned()))
            .unwrap()
            .unwrap();
        assert_eq!(selected, parent.path().to_str().unwrap());
        assert!(!parent.path().join("deas-environment").exists());
        assert!(selected_directory(Some(parent.path().join("missing"))).is_err());
        let file = parent.path().join("not-a-directory");
        std::fs::write(&file, b"fixture").unwrap();
        assert!(selected_directory(Some(file)).is_err());
        assert!(selected_directory(Some(PathBuf::from("relative"))).is_err());
    }

    #[test]
    fn validates_dialog_title_before_opening() {
        assert!(validate_title("Speicherordner wählen").is_ok());
        for title in ["", " ", "bad\ntext", "bad\0title"] {
            assert!(validate_title(title).is_err());
        }
        assert!(validate_title(&"x".repeat(241)).is_err());
    }

    #[tokio::test]
    #[ignore = "Opens a real OS directory chooser; explicitly select or cancel"]
    async fn native_directory_picker_interactive() {
        let chosen = native_pick_directory("DEAS — directory picker verification".into())
            .await
            .unwrap();
        println!("Native picker returned: {chosen:?}");
        if let Some(path) = chosen {
            assert!(std::path::Path::new(&path).is_dir());
        }
    }
}
