//! Per-environment folder settings: where ComfyUI keeps models, input and output.
//! Stored as `deas-settings.json` beside the environment; the owned backend reads it at start.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const FILE: &str = "deas-settings.json";
const MODEL_FOLDERS: [&str; 14] = [
    "checkpoints",
    "diffusion_models",
    "loras",
    "vae",
    "text_encoders",
    "clip",
    "clip_vision",
    "controlnet",
    "upscale_models",
    "embeddings",
    "unet",
    "style_models",
    "gligen",
    "hypernetworks",
];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Folders {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

fn existing_dir(value: &Option<String>) -> Result<(), String> {
    let Some(path) = value else { return Ok(()) };
    let path = Path::new(path);
    if !path.is_absolute() || path.to_str().is_none() {
        return Err("Folder must be an absolute path".into());
    }
    if !path.is_dir() {
        return Err(format!("{}: not an existing directory", path.display()));
    }
    Ok(())
}

fn root_dir(root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root);
    if !root.is_absolute() {
        return Err("Environment root must be absolute".into());
    }
    Ok(root)
}

pub fn read(root: &Path) -> Result<Folders, String> {
    match std::fs::read(root.join(FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("Invalid {FILE}: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Folders::default()),
        Err(e) => Err(format!("{FILE}: {e}")),
    }
}

#[path = "settings_move.rs"]
mod relocation;
pub use relocation::{move_folders, validate, MoveReport};

pub fn write(root: &Path, folders: Folders) -> Result<Folders, String> {
    relocation::save(root, folders)
}

/// Extra ComfyUI launch arguments honouring the saved folders; empty when nothing is set.
pub fn backend_args(root: &Path) -> Result<Vec<String>, String> {
    let folders = read(root)?;
    for value in [&folders.models, &folders.input, &folders.output] {
        existing_dir(value)?; // a folder removed since saving must fail the start, not silently fall back
    }
    let mut args = vec![];
    if let Some(input) = folders.input {
        args.extend(["--input-directory".to_owned(), input]);
    }
    if let Some(output) = folders.output {
        args.extend(["--output-directory".to_owned(), output]);
    }
    if let Some(models) = folders.models {
        // ComfyUI's extra_model_paths format: one named block with base_path + folder keys.
        let quoted = serde_json::to_string(&models).map_err(|e| e.to_string())?;
        let mut yaml = format!("deas:\n  base_path: {quoted}\n");
        for folder in MODEL_FOLDERS {
            yaml.push_str(&format!("  {folder}: {folder}\n"));
        }
        let file = root.join("deas-models.yaml");
        std::fs::write(&file, yaml).map_err(|e| e.to_string())?;
        args.extend([
            "--extra-model-paths-config".to_owned(),
            file.to_str().ok_or("Non-UTF-8 root")?.to_owned(),
        ]);
    }
    Ok(args)
}

#[tauri::command]
pub fn native_settings_read(root: String) -> Result<Folders, String> {
    read(&root_dir(&root)?)
}
#[tauri::command]
pub fn native_settings_write(
    root: String,
    folders: Folders,
    operations: tauri::State<'_, crate::FolderOperations>,
) -> Result<Folders, String> {
    let _guard = operations.enter()?;
    write(&root_dir(&root)?, folders)
}
/// Which of the given absolute file paths already exist; used to mark library items as local.
#[tauri::command]
pub fn native_files_present(paths: Vec<String>) -> Result<Vec<bool>, String> {
    paths
        .iter()
        .take(500)
        .map(|p| {
            let path = Path::new(p);
            if !path.is_absolute() {
                return Err("Path must be absolute".into());
            }
            Ok(path.is_file())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_roundtrip_validation_and_backend_args() {
        let root = tempfile::tempdir().unwrap();
        let models = tempfile::tempdir().unwrap();
        assert_eq!(read(root.path()).unwrap(), Folders::default());
        assert!(backend_args(root.path()).unwrap().is_empty());
        assert!(write(
            root.path(),
            Folders {
                models: Some("relative".into()),
                ..Default::default()
            }
        )
        .is_err());
        assert!(write(
            root.path(),
            Folders {
                input: Some(root.path().join("missing").to_str().unwrap().into()),
                ..Default::default()
            }
        )
        .is_err());
        let saved = write(
            root.path(),
            Folders {
                models: Some(models.path().to_str().unwrap().into()),
                output: Some(root.path().to_str().unwrap().into()),
                input: None,
            },
        )
        .unwrap();
        assert_eq!(read(root.path()).unwrap(), saved);
        let args = backend_args(root.path()).unwrap();
        assert_eq!(
            args[0..2],
            [
                "--output-directory".to_owned(),
                root.path().to_str().unwrap().to_owned()
            ]
        );
        assert_eq!(args[2], "--extra-model-paths-config");
        let yaml = std::fs::read_to_string(&args[3]).unwrap();
        assert!(yaml.starts_with(&format!(
            "deas:\n  base_path: {}\n  checkpoints: checkpoints\n",
            serde_json::to_string(models.path().to_str().unwrap()).unwrap()
        )));
        assert!(yaml.contains("  loras: loras\n"));
        let present = native_files_present(vec![
            args[3].clone(),
            root.path().join("nope").to_str().unwrap().into(),
        ])
        .unwrap();
        assert_eq!(present, vec![true, false]);
        assert!(native_files_present(vec!["relative".into()]).is_err());
        assert!(native_settings_read("relative".into()).is_err());
        drop(models);
        assert!(backend_args(root.path()).is_err());
    }
}
