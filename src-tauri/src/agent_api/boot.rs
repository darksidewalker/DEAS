//! Boot wiring (API-DESIGN §3 step 1, §SR9): the resolver's [`resolver::IndexSource`]
//! derived from the stock planes, never a guessed path.
//!
//! The two inputs are stock homes, not restatements:
//!
//! * the index cache directory — the stock [`index::directory`] law (app cache dir plus
//!   the `model-index-v1` hint), taken through that function itself;
//! * the model roots — the saved `deas-settings.json` folders exactly as the Library UI
//!   passes them to `native_models_scan`: primary = `models` or the
//!   `{environment root}/ComfyUI/models` fallback, then `extraModels` verbatim. The
//!   index file name is the SHA-256 of the serialized roots array, so the vector must
//!   agree with the stock scan call byte for byte — hence the same fallback grammar.
//!
//! Honesty law: any missing or unreadable input (no approved environment, corrupt
//! settings file, a configured folder that no longer exists, a relative path) answers
//! `None`; the resolver then keeps answering the landed `libraryScanRequired` word.
//! Nothing here walks a model folder or runs a scan — the scan bridge is [`scan`].

use std::path::{Path, PathBuf};

use super::resolver::IndexSource;

/// The frontend's documented fallback for the primary models root when the saved
/// folders name none: `{environment root}/ComfyUI/models` (the same concatenation the
/// app shell builds before calling `native_models_scan`).
fn fallback_models_root(environment_root: &str) -> String {
    format!("{environment_root}/ComfyUI/models")
}

/// The pure half of the wiring: index cache dir plus the approved environment root
/// answer the live [`IndexSource`], or `None` when any input is missing or unreadable.
/// Split from the Tauri seam so the settings-to-roots law is unit-testable without an
/// app handle, a backend or a scan.
pub(crate) fn index_source(
    cache_dir: &Path,
    environment_root: Option<&str>,
) -> Option<IndexSource> {
    let environment_root = environment_root?;
    let environment_path = Path::new(environment_root);
    if !environment_path.is_dir() {
        return None;
    }
    let folders = crate::settings::read(environment_path).ok()?;
    let primary = folders
        .models
        .unwrap_or_else(|| fallback_models_root(environment_root));
    let primary = PathBuf::from(primary);
    if !primary.is_absolute() || !primary.is_dir() {
        return None;
    }
    let mut roots = vec![primary];
    for extra in folders.extra_models {
        let extra = PathBuf::from(extra);
        if !extra.is_absolute() || !extra.is_dir() {
            return None;
        }
        roots.push(extra);
    }
    Some(IndexSource {
        index_dir: cache_dir.to_path_buf(),
        roots,
    })
}

/// The thin Tauri seam: the stock index cache directory (index::directory) plus the
/// environment root of the currently approved DEAS environment (the install engine's
/// own plan). `None` whenever either seam is unavailable — a fresh boot before any
/// environment was opened or reconnected answers honestly, and because the plane
/// resolves through this function live, an environment opened later is picked up
/// without restarting DEAS.
pub(crate) fn from_app(app: &tauri::AppHandle) -> Option<IndexSource> {
    use tauri::Manager as _;
    let cache_dir = crate::downloads::models::index::directory(app).ok()?;
    let environment_root = app
        .state::<crate::install::Engine>()
        .approved_plan()
        .map(|plan| plan.request.storage_path)?;
    index_source(&cache_dir, Some(&environment_root))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An environment root with a saved folders file naming `models` and one extra
    /// root answers exactly the roots vector the Library UI would scan.
    #[test]
    fn saved_folders_shape_the_index_source() {
        let dir = tempfile::tempdir().expect("tempdir");
        let env = dir.path().join("env");
        let models = env.join("library");
        let extra = dir.path().join("extra");
        std::fs::create_dir_all(&models).expect("models dir");
        std::fs::create_dir_all(&extra).expect("extra dir");
        std::fs::write(
            env.join(crate::settings::FILE),
            format!(
                "{{\"models\": \"{}\", \"extraModels\": [\"{}\"]}}",
                models.to_string_lossy().replace('\\', "/"),
                extra.to_string_lossy().replace('\\', "/")
            ),
        )
        .expect("settings file");
        let cache = dir.path().join("cache");
        let source = index_source(&cache, Some(&env.to_string_lossy())).expect("wired");
        assert_eq!(source.index_dir, cache);
        assert_eq!(source.roots, vec![models, extra]);
    }

    /// No saved folders file means the documented environment fallback, exactly the
    /// shape the app shell passes to the stock scan.
    #[test]
    fn absent_saved_folders_fall_back_to_the_environment() {
        let dir = tempfile::tempdir().expect("tempdir");
        let env = dir.path().join("env");
        std::fs::create_dir_all(env.join("ComfyUI").join("models")).expect("fallback dir");
        let source =
            index_source(&dir.path().join("cache"), Some(&env.to_string_lossy())).expect("wired");
        assert_eq!(source.roots.len(), 1);
        assert_eq!(
            source.roots[0],
            PathBuf::from(format!("{}/ComfyUI/models", env.to_string_lossy()))
        );
    }

    /// Every unreadable or absent input answers the honest `None`: no environment,
    /// a corrupt settings file, a named models folder that no longer exists, and an
    /// extra root that vanished (the stock start law fails on it; so does the resolver
    /// source, rather than resolving over a different roots hash than the UI writes).
    #[test]
    fn missing_or_unreadable_inputs_answer_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cache = dir.path().join("cache");
        assert!(index_source(&cache, None).is_none(), "no environment open");

        let env = dir.path().join("env");
        std::fs::create_dir_all(&env).expect("env dir");
        std::fs::write(env.join(crate::settings::FILE), "{ not json").expect("corrupt settings");
        assert!(
            index_source(&cache, Some(&env.to_string_lossy())).is_none(),
            "corrupt settings file"
        );

        std::fs::write(
            env.join(crate::settings::FILE),
            "{\"models\": \"relative/path\"}",
        )
        .expect("relative models");
        assert!(
            index_source(&cache, Some(&env.to_string_lossy())).is_none(),
            "a relative configured root"
        );

        std::fs::write(
            env.join(crate::settings::FILE),
            format!(
                "{{\"models\": \"{}/library\", \"extraModels\": [\"{}/gone\"]}}",
                env.to_string_lossy().replace('\\', "/"),
                dir.path().to_string_lossy().replace('\\', "/")
            ),
        )
        .expect("stale extra root");
        assert!(
            index_source(&cache, Some(&env.to_string_lossy())).is_none(),
            "a configured extra root that no longer exists"
        );
    }
}
