//! Per-environment folder settings: where ComfyUI keeps models, input and output.
//! Stored as `deas-settings.json` beside the environment; the owned backend reads it at start.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const FILE: &str = "deas-settings.json";
pub(crate) const MODEL_FOLDERS: [&str; 14] = [
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
    /// Additional model roots on other drives, registered beside the primary models root in
    /// ComfyUI's extra_model_paths.yaml and scanned by the model library. They are external
    /// folders: the folder mover never copies, deletes or relocates them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_models: Vec<String>,
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

fn existing_root(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute() || path.to_str().is_none() {
        return Err("Folder must be an absolute path".into());
    }
    if !path.is_dir() {
        return Err(format!("{}: not an existing directory", path.display()));
    }
    Ok(path.to_owned())
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
    for extra in &folders.extra_models {
        existing_root(extra)?;
    }
    let mut args = vec![];
    if let Some(input) = folders.input {
        args.extend(["--input-directory".to_owned(), input]);
    }
    if let Some(output) = folders.output {
        args.extend(["--output-directory".to_owned(), output]);
    }
    // ComfyUI's extra_model_paths format: one named block per root with base_path + folder keys.
    let mut yaml = String::new();
    if let Some(models) = &folders.models {
        yaml.push_str(&format!(
            "deas:\n  base_path: {}\n",
            serde_json::to_string(models).map_err(|e| e.to_string())?
        ));
        for folder in MODEL_FOLDERS {
            yaml.push_str(&format!("  {folder}: {folder}\n"));
        }
        // The node pack's Prompt Forge reads `llm`; not in MODEL_FOLDERS so model scans skip LLM weights.
        yaml.push_str("  llm: llm\n");
    }
    for (index, extra) in folders.extra_models.iter().enumerate() {
        yaml.push_str(&format!(
            "deas-extra-{}:\n  base_path: {}\n",
            index + 1,
            serde_json::to_string(extra).map_err(|e| e.to_string())?
        ));
        for folder in MODEL_FOLDERS {
            yaml.push_str(&format!("  {folder}: {folder}\n"));
        }
    }
    if !yaml.is_empty() {
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
    use tempfile::TempDir;
    #[test]
    fn extra_model_roots_register_beside_the_primary_root() {
        let tmp = TempDir::new().unwrap();
        let extra = tmp.path().join("extra drive models");
        std::fs::create_dir_all(extra.join("diffusion_models")).unwrap();
        let folders = Folders {
            extra_models: vec![extra.to_str().unwrap().into()],
            ..Folders::default()
        };
        validate(&folders).unwrap();
        write(tmp.path(), folders.clone()).unwrap();
        let args = backend_args(tmp.path()).unwrap();
        let yaml = std::fs::read_to_string(&args[1]).unwrap();
        assert!(yaml.contains("deas-extra-1:\n"));
        // Saved folders are canonical (Windows temp may be an 8.3 short path), so compare that form.
        let saved = dunce::canonicalize(&extra).unwrap();
        assert!(yaml.contains(&format!(
            "base_path: {}",
            serde_json::to_string(&saved.to_str().unwrap()).unwrap()
        )));
        assert!(yaml.contains("  diffusion_models: diffusion_models\n"));
        let missing = Folders {
            extra_models: vec![tmp.path().join("gone").to_str().unwrap().into()],
            ..Folders::default()
        };
        assert!(validate(&missing).is_err());
        assert!(write(tmp.path(), missing).is_err());
        std::fs::remove_dir_all(&extra).unwrap();
        assert!(backend_args(tmp.path()).is_err());
    }
    #[test]
    fn settings_roundtrip_validation_and_backend_args() {
        // Saved folders are canonical (Windows: long names, no \\?\ prefix), so compare against that form.
        let (root_dir, models_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let root = dunce::canonicalize(root_dir.path()).unwrap();
        let models = dunce::canonicalize(models_dir.path()).unwrap();
        assert_eq!(read(root.as_path()).unwrap(), Folders::default());
        assert!(backend_args(root.as_path()).unwrap().is_empty());
        assert!(write(
            root.as_path(),
            Folders {
                models: Some("relative".into()),
                ..Default::default()
            }
        )
        .is_err());
        assert!(write(
            root.as_path(),
            Folders {
                input: Some(root.as_path().join("missing").to_str().unwrap().into()),
                ..Default::default()
            }
        )
        .is_err());
        let saved = write(
            root.as_path(),
            Folders {
                models: Some(models.as_path().to_str().unwrap().into()),
                output: Some(root.as_path().to_str().unwrap().into()),
                input: None,
                extra_models: vec![],
            },
        )
        .unwrap();
        assert_eq!(read(root.as_path()).unwrap(), saved);
        let args = backend_args(root.as_path()).unwrap();
        assert_eq!(
            args[0..2],
            [
                "--output-directory".to_owned(),
                root.as_path().to_str().unwrap().to_owned()
            ]
        );
        assert_eq!(args[2], "--extra-model-paths-config");
        let yaml = std::fs::read_to_string(&args[3]).unwrap();
        assert!(yaml.starts_with(&format!(
            "deas:\n  base_path: {}\n  checkpoints: checkpoints\n",
            serde_json::to_string(models.as_path().to_str().unwrap()).unwrap()
        )));
        assert!(yaml.contains("  loras: loras\n"));
        assert!(yaml.contains("  llm: llm\n"));
        let present = native_files_present(vec![
            args[3].clone(),
            root.as_path().join("nope").to_str().unwrap().into(),
        ])
        .unwrap();
        assert_eq!(present, vec![true, false]);
        assert!(native_files_present(vec!["relative".into()]).is_err());
        assert!(native_settings_read("relative".into()).is_err());
        drop(models_dir);
        assert!(backend_args(root.as_path()).is_err());
    }
}
