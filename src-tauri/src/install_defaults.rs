//! Read-only recommendations; never authorizes or writes an installation.
use crate::install::torch_profile::{self, Gpu};
use crate::install::Backend;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallDefaults {
    pub storage_path: String,
    pub backend: Backend,
    pub hardware: Option<Gpu>,
    pub warnings: Vec<String>,
}

fn recommend(
    executable: &Path,
    probe: Result<Vec<Gpu>, String>,
) -> Result<InstallDefaults, String> {
    let parent = executable
        .parent()
        .filter(|path| path.is_absolute())
        .ok_or("Cannot determine executable directory")?;
    let target = parent.join("deas-environment");
    let mut warnings = Vec::new();
    let (backend, hardware) = match probe {
        Ok(gpus) if gpus.len() == 1 => {
            let hardware = gpus.into_iter().next().unwrap();
            match torch_profile::select(&hardware.hardware()) {
                Ok(_) => (Backend::Nvidia, Some(hardware)),
                Err(error) => {
                    warnings.push(format!(
                        "CPU recommended because NVIDIA compatibility checks failed: {error}"
                    ));
                    (Backend::Cpu, Some(hardware))
                }
            }
        }
        Ok(gpus) => match torch_profile::pick(&gpus) {
            Ok(best) => {
                warnings.push(format!(
                    "Multiple NVIDIA GPUs detected; {} selected by default — choose another GPU in the Backend tab after installation",
                    best.name
                ));
                (Backend::Nvidia, Some(best))
            }
            Err(error) => {
                warnings.push(format!(
                    "CPU recommended because NVIDIA compatibility checks failed: {error}"
                ));
                (Backend::Cpu, None)
            }
        },
        #[cfg(target_os = "linux")]
        Err(nvidia_error) => match crate::amd::probe_amd() {
            Ok(found) => {
                warnings.push(format!(
                    "AMD ROCm recommended from the detected GPU ({}); verify the amdgpu driver and /dev/kfd access before installing",
                    found.compute_capability
                ));
                (Backend::Amd, Some(found))
            }
            Err(_) => {
                warnings.push(format!(
                    "CPU recommended as the conservative supported baseline; no compatible NVIDIA or AMD device was verified: {}",
                    nvidia_error
                ));
                (Backend::Cpu, None)
            }
        },
        #[cfg(not(target_os = "linux"))]
        Err(error) => {
            warnings.push(format!("CPU recommended as the conservative supported baseline; no compatible NVIDIA device was verified: {error}"));
            (Backend::Cpu, None)
        }
    };
    if std::fs::symlink_metadata(&target).is_ok() {
        warnings.push("Default environment already exists; DEAS will check it for reuse. It is never reinstalled, renamed, overwritten or wiped.".into());
    }
    Ok(InstallDefaults {
        storage_path: target
            .to_str()
            .ok_or("Executable directory must be UTF-8")?
            .into(),
        backend,
        hardware,
        warnings,
    })
}

/// Recommendations only. The immutable plan independently validates everything
/// again; a suggested CPU backend is not a claim that a CPU/GPU was detected.
#[tauri::command]
pub async fn native_install_defaults() -> Result<InstallDefaults, String> {
    let executable =
        std::env::current_exe().map_err(|e| format!("Cannot locate executable: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || recommend(&executable, torch_profile::probe_all()))
        .await
        .map_err(|e| format!("Default recommendation worker failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_command_is_registered_and_scoped_to_local_install_permission() {
        assert!(include_str!("main.rs").contains("deas::native_install_defaults,"));
        assert!(include_str!("../permissions/install.toml").contains("\"native_install_defaults\""));
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(capability["local"], true);
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert!(capability.get("remote").is_none());
    }

    #[tokio::test]
    #[ignore = "Read-only executable/GPU recommendation on actual host"]
    async fn live_install_defaults_are_read_only() {
        let before = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join("deas-environment")
            .exists();
        let defaults = native_install_defaults().await.unwrap();
        assert_eq!(
            std::path::Path::new(&defaults.storage_path).exists(),
            before
        );
        println!("{}", serde_json::to_string(&defaults).unwrap());
    }

    #[test]
    fn defaults_use_executable_parent_not_working_directory_without_writes() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("DEAS");
        std::fs::write(&executable, "fixture").unwrap();
        let defaults = recommend(&executable, Err("No NVIDIA probe".into())).unwrap();
        assert_eq!(
            defaults.storage_path,
            root.path().join("deas-environment").to_str().unwrap()
        );
        assert!(matches!(defaults.backend, Backend::Cpu));
        assert!(defaults.hardware.is_none());
        assert!(defaults.warnings.iter().any(|w| w.contains("CPU")));
        assert!(!root.path().join("deas-environment").exists());
    }

    #[test]
    fn defaults_recommend_only_a_compatible_nvidia_profile() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("DEAS");
        let valid =
            torch_profile::parse("GPU-fixture, 32 GB test GPU, 615.71.09, 12.0, 8192").unwrap();
        let defaults = recommend(&executable, Ok(vec![valid])).unwrap();
        assert!(matches!(defaults.backend, Backend::Nvidia));
        assert_eq!(defaults.hardware.unwrap().uuid, "GPU-fixture");
        let old_driver =
            torch_profile::parse("GPU-fixture, 32 GB test GPU, 550.1, 12.0, 8192").unwrap();
        let fallback = recommend(&executable, Ok(vec![old_driver])).unwrap();
        assert!(matches!(fallback.backend, Backend::Cpu));
        assert!(fallback.hardware.is_some());
        assert!(fallback
            .warnings
            .iter()
            .any(|w| w.contains("NVIDIA_DRIVER")));
    }

    #[test]
    fn defaults_pick_the_best_passing_gpu_on_multi_gpu_hosts() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("DEAS");
        let older = torch_profile::parse("GPU-old, RTX 2080 SUPER, 615.71.09, 7.5, 8192").unwrap();
        let newer = torch_profile::parse("GPU-new, RTX 5060 Ti, 615.71.09, 12.0, 16384").unwrap();
        let defaults = recommend(&executable, Ok(vec![older.clone(), newer.clone()])).unwrap();
        assert!(matches!(defaults.backend, Backend::Nvidia));
        assert_eq!(defaults.hardware.unwrap().uuid, "GPU-new");
        assert!(defaults
            .warnings
            .iter()
            .any(|w| w.contains("Multiple NVIDIA GPUs")));
        // No passing GPU: CPU recommendation with the first gate error, no silent fallback card.
        let old_driver = torch_profile::parse("GPU-old, RTX 4090, 570.1.0, 8.9, 24576").unwrap();
        let legacy = torch_profile::parse("GPU-legacy, GTX 980, 615.71.09, 5.2, 8192").unwrap();
        let fallback = recommend(&executable, Ok(vec![old_driver, legacy])).unwrap();
        assert!(matches!(fallback.backend, Backend::Cpu));
        assert!(fallback.hardware.is_none());
        assert!(fallback.warnings.iter().any(|w| w.contains("NVIDIA")));
    }

    #[test]
    fn existing_default_directory_is_reported_not_adopted_or_renamed() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("deas-environment");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep"), "untouched").unwrap();
        let defaults = recommend(&root.path().join("DEAS"), Err("No GPU".into())).unwrap();
        assert_eq!(defaults.storage_path, target.to_str().unwrap());
        assert!(defaults.warnings.iter().any(|w| w.contains("exists")));
        assert_eq!(
            std::fs::read_to_string(target.join("keep")).unwrap(),
            "untouched"
        );
    }
}
