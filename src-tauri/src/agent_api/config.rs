//! Operator settings plane for the agent API: `deas-agent-settings.json` in app-data.
//!
//! The file is the activation gate for the whole `/v1` surface: only `{"enabled": true}`
//! brings the plane up. Unknown fields are refused rather than ignored, so a misspelled key
//! cannot silently change the plane's posture.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// File name of the agent settings plane, beside the DEAS settings.
pub(crate) const FILE: &str = "deas-agent-settings.json";

/// Default `/v1` port; the operator file may override it.
pub(crate) const DEFAULT_PORT: u16 = 8790;

/// Operator opt-in for the agent plane: enable, port, standing key, origin allowlist.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub(crate) struct AgentSettings {
    /// Sole activation switch: the plane starts only when this is true.
    pub(crate) enabled: bool,
    /// TCP port for the loopback bind; 0 is refused (a deterministic port is required).
    pub(crate) port: u16,
    /// When set, every request must present it (constant-time compared).
    pub(crate) standing_key: Option<String>,
    /// Browser origins allowed to reach the plane; absent means deny all cross-origin.
    pub(crate) origin_allowlist: Vec<String>,
    /// Operator component overrides (owner ruling 2026-11-22): family id -> slot word
    /// (`textEncoders` / `vaes` / `audioVaes` / `textProjections`) -> the category-relative
    /// file name the library index already carries. The resolver accepts an overridden entry
    /// for that slot WITHOUT the header-verified architecture stamp, because the operator
    /// asserts the pairing; the stock backend stays the last arbiter — a file it refuses
    /// fails its row honestly. An override naming an entry absent from the index is still
    /// the honest `libraryScanRequired` posture. Empty by default: no override is implied.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) component_overrides: BTreeMap<String, BTreeMap<String, String>>,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            standing_key: None,
            origin_allowlist: Vec::new(),
            component_overrides: BTreeMap::new(),
        }
    }
}

/// Reads the settings file from app-data.
///
/// Returns `Ok(None)` when the file is absent or `enabled` is false (zero plane startup),
/// and `Err` with a human-readable cause when the file exists but cannot be trusted.
///
/// # Errors
///
/// Reports a parse or validation failure describing the refused field or JSON problem.
pub(crate) fn load(app_data: &Path) -> Result<Option<AgentSettings>, String> {
    let path = app_data.join(FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let settings: AgentSettings = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    if !settings.enabled {
        return Ok(None);
    }
    validate_enabled(&settings)
        .map_err(|problem| format!("parse {}: {problem}", path.display()))?;
    Ok(Some(settings))
}

/// The validation the `enabled` posture owes its operator: a deterministic port and
/// a non-empty standing key. [`load`] applies it behind its `enabled` gate, and the
/// native settings bridge applies the same law at its write wall, so a panel can
/// never park bytes on disk that startup would refuse.
///
/// # Errors
///
/// Names each refused field with the reason an operator can act on.
pub(crate) fn validate_enabled(settings: &AgentSettings) -> Result<(), String> {
    if settings.port == 0 {
        return Err("port must not be 0".to_owned());
    }
    if settings.standing_key.as_deref() == Some("") {
        return Err("standingKey must not be empty when present".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, text: &str) {
        std::fs::write(dir.join(FILE), text).expect("test fixture writes settings");
    }

    #[test]
    fn absent_file_means_no_plane() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(load(dir.path()).expect("absent is not an error"), None);
    }

    #[test]
    fn disabled_settings_mean_no_plane() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), r#"{"enabled": false, "port": 8790}"#);
        assert_eq!(load(dir.path()).expect("disabled is not an error"), None);
    }

    #[test]
    fn enabled_settings_start_with_default_port() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), r#"{"enabled": true}"#);
        let settings = load(dir.path()).expect("valid").expect("enabled");
        assert_eq!(settings.port, DEFAULT_PORT);
        assert_eq!(settings.standing_key, None);
        assert!(settings.origin_allowlist.is_empty());
    }

    #[test]
    fn full_settings_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"enabled": true, "port": 9111, "standingKey": "s3cret",
                "originAllowlist": ["http://localhost:1420"]}"#,
        );
        let settings = load(dir.path()).expect("valid").expect("enabled");
        assert_eq!(settings.port, 9111);
        assert_eq!(settings.standing_key.as_deref(), Some("s3cret"));
        assert_eq!(settings.origin_allowlist, ["http://localhost:1420"]);
    }

    #[test]
    fn component_overrides_round_trip_and_default_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"enabled": true, "componentOverrides": {"qwen-image-2.1": {"textEncoders": "qwen21/qwenImage21TextEncoderOriginal_v10_3241874.safetensors"}}}"#,
        );
        let settings = load(dir.path()).expect("valid").expect("enabled");
        let slot = settings
            .component_overrides
            .get("qwen-image-2.1")
            .expect("family block");
        assert_eq!(
            slot.get("textEncoders").map(String::as_str),
            Some("qwen21/qwenImage21TextEncoderOriginal_v10_3241874.safetensors")
        );
        // Absent block stays empty and never serializes noise.
        let plain_dir = tempfile::tempdir().expect("tempdir");
        write(plain_dir.path(), r#"{"enabled": true, "port": 8790}"#);
        let plain = load(plain_dir.path()).expect("valid").expect("enabled");
        assert!(plain.component_overrides.is_empty());
        let serialized = serde_json::to_string(&plain).expect("serialize");
        assert!(!serialized.contains("componentOverrides"));
    }

    #[test]
    fn malformed_json_fails_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), r#"{"enabled": tru}"#);
        assert!(load(dir.path()).is_err());
    }

    #[test]
    fn unknown_field_fails_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), r#"{"enabled": true, "pot": 9999}"#);
        assert!(load(dir.path()).is_err());
    }

    #[test]
    fn zero_port_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), r#"{"enabled": true, "port": 0}"#);
        assert!(load(dir.path()).is_err());
    }

    #[test]
    fn empty_standing_key_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), r#"{"enabled": true, "standingKey": ""}"#);
        assert!(load(dir.path()).is_err());
    }
}
