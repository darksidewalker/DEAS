//! Operator guard file: `deas-agent-guard.json` in app-data.
//!
//! Carries the per-install unload/restore commands and the readiness URL for the VRAM
//! cycle. These values are operator config and are never hardcoded, never edited by the
//! plane, and read lazily by the cycle legs that need them. An absent file is not an
//! error: cycle features honestly report "not configured".

use std::path::Path;

use serde::Deserialize;

use super::caps;
use super::watchdog;
use crate::logs::{self, Source};

/// File name of the operator guard plane.
pub(crate) const FILE: &str = "deas-agent-guard.json";

/// Validated operator cycle configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GuardConfig {
    /// Command that unloads the agent model off the card; executed verbatim, exit-waited.
    pub(crate) unload_command: String,
    /// Command that restores the agent model; executed verbatim, exit-waited.
    pub(crate) restore_command: String,
    /// HTTP(S) readiness URL polled after restore.
    pub(crate) ready_url: String,
    /// The cycle word (§7.2): `true` runs the full unload/restore legs; `false`
    /// switches the legs off (one machine, legs off — never a second code path).
    /// Default true; `true` with empty commands is refused (`guardUnconfigured`).
    pub(crate) auto_cycle_vram: bool,
    /// Free the owned backend at drain end even without the unload/restore legs
    /// (§7.2: free is nearly free and keeps the backend clean). Default true.
    pub(crate) free_on_queue_end: bool,
    /// The watchdog's numbers (§8.1), read from the same operator file. The block is
    /// optional: absent is the shipped defaults, malformed is the same defaults with
    /// one honest log line — a broken watchdog block never disables the watchdog and
    /// never changes the cycle's own posture.
    pub(crate) watchdog: watchdog::WatchdogConfig,
    /// The network caps (owner ruling E21 + E21-AMENDMENT, LEG MEDIA-1): the
    /// upload single-body / per-batch-upload / single-file-download ceilings, in
    /// MiB. Optional block, absent keys keep the shipped defaults; an
    /// out-of-bounds number is a config refusal (unlike the watchdog block,
    /// caps never default-past a broken value — a cap the plane cannot trust
    /// is a broken guard, and byte doors refuse honestly rather than guess).
    pub(crate) caps: caps::Caps,
}

/// The degraded posture the sever arm falls back to when the guard file vanished
/// mid-flight: the legs that need operator commands switch off (the cycle word off),
/// the free word keeps its shipped default, and the commands stay empty because the
/// plane never invents one.
impl Default for GuardConfig {
    fn default() -> Self {
        Self {
            unload_command: String::new(),
            restore_command: String::new(),
            ready_url: String::new(),
            auto_cycle_vram: false,
            free_on_queue_end: true,
            watchdog: watchdog::WatchdogConfig::default(),
            caps: caps::Caps::default(),
        }
    }
}

/// API-DESIGN §7.1: a cycle bat is executed `cmd /C` verbatim; 4096 characters is
/// the cap, enforced at validation so an over-long bat is a config refusal, never a
/// truncated surprise at drive time.
const MAX_COMMAND_CHARS: usize = 4096;

impl GuardConfig {
    /// Validates the raw operator strings. With `autoCycleVram` true (the default)
    /// the laws are the shipped ones: commands non-empty, readyUrl http(s) — an
    /// empty-command file that wants the cycle is the `guardUnconfigured` posture
    /// surfaced as a validation refusal. With `autoCycleVram` false the legs are
    /// switched off, so the commands and the readiness URL may stay empty; anything
    /// that IS present is still validated to the same laws.
    ///
    /// # Errors
    ///
    /// Names each refused field with the reason an operator can act on.
    fn validate(self) -> Result<Self, String> {
        let mut problems: Vec<String> = Vec::new();
        if self.auto_cycle_vram {
            if self.unload_command.trim().is_empty() {
                problems.push(
                    "unloadCommand must be a non-empty string when autoCycleVram is true"
                        .to_owned(),
                );
            }
            if self.restore_command.trim().is_empty() {
                problems.push(
                    "restoreCommand must be a non-empty string when autoCycleVram is true"
                        .to_owned(),
                );
            }
            if self.ready_url.trim().is_empty() {
                problems.push(
                    "readyUrl must be a non-empty string when autoCycleVram is true".to_owned(),
                );
            }
        }
        if !self.unload_command.is_empty()
            && self.unload_command.chars().count() > MAX_COMMAND_CHARS
        {
            problems.push(format!(
                "unloadCommand exceeds the {MAX_COMMAND_CHARS}-character cap"
            ));
        }
        if !self.restore_command.is_empty()
            && self.restore_command.chars().count() > MAX_COMMAND_CHARS
        {
            problems.push(format!(
                "restoreCommand exceeds the {MAX_COMMAND_CHARS}-character cap"
            ));
        }
        if !self.ready_url.trim().is_empty() {
            if let Err(problem) = validate_ready_url(&self.ready_url) {
                problems.push(problem);
            }
        }
        self.caps.validate(&mut problems);
        if problems.is_empty() {
            Ok(self)
        } else {
            Err(problems.join("; "))
        }
    }
}

/// Parses `readyUrl` as an absolute http(s) URL.
fn validate_ready_url(value: &str) -> Result<(), String> {
    match reqwest::Url::parse(value) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => Ok(()),
        Ok(url) => Err(format!("readyUrl scheme '{}' is not http(s)", url.scheme())),
        Err(error) => Err(format!("readyUrl must parse as an http(s) URL: {error}")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct GuardFile {
    unload_command: String,
    restore_command: String,
    ready_url: String,
    auto_cycle_vram: bool,
    free_on_queue_end: bool,
    /// The watchdog block, kept raw so a malformed block costs the watchdog its
    /// defaults (plus one honest log line) instead of refusing the whole cycle file.
    watchdog: Option<serde_json::Value>,
    /// The network-cap block (LEG MEDIA-1). Unlike the watchdog block this one
    /// is typed: an out-of-bounds cap is a config refusal, never a defaulting
    /// note, so a byte door can never serve past a cap the operator wrote but
    /// the plane could not honor.
    caps: Option<caps::CapsFile>,
}

// `#[derive(Default)]` would default the two cycle words to false; §7.2 makes both
// default-true, so the Default impl is hand-written and the struct-level serde
// `default` reads it (an absent field keeps the shipped law, not a zero value).
impl Default for GuardFile {
    fn default() -> Self {
        Self {
            unload_command: String::new(),
            restore_command: String::new(),
            ready_url: String::new(),
            auto_cycle_vram: true,
            free_on_queue_end: true,
            watchdog: None,
            caps: None,
        }
    }
}

/// Reads the guard file from app-data, lazily, on demand.
///
/// Returns `Ok(None)` when the file is absent (cycle features report not-configured
/// honestly) and `Err` when it exists but fails validation, so a half-filled file is
/// surfaced instead of silently disabling the cycle.
///
/// # Errors
///
/// Reports the JSON or field-validation problem with the offending field named.
pub(crate) fn load(app_data: &Path) -> Result<Option<GuardConfig>, String> {
    let path = app_data.join(FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let file: GuardFile = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    match finish(file) {
        Ok(config) => Ok(Some(config)),
        Err(problem) => Err(format!("{}: {problem}", path.display())),
    }
}

/// The guard's two posture words a reader needs without holding the whole config.
/// One home, so `/v1/cycle`, `/v1/status` and `/v1/health` can never disagree about
/// what the operator file says:
/// - `configured`: the file EXISTS and VALIDATES (the `guardUnconfigured` posture is
///   an absent or malformed file, never a guess).
/// - `auto_cycle_vram`: the file's word when configured; otherwise the shipped
///   degraded default ([`GuardConfig::default`] — legs off), because a plane with no
///   usable guard runs no unload/restore legs. A malformed file logs its reason once,
///   the posture the cycle view has always surfaced.
#[derive(Clone, Copy, Debug)]
pub(crate) struct GuardPosture {
    /// The file exists AND validates — the `guardUnconfigured` posture is an absent or
    /// malformed file, never a guess.
    pub(crate) configured: bool,
    /// The cycle word (§7.2) the machine would run under.
    pub(crate) auto_cycle_vram: bool,
}

/// Reads the guard posture through [`load`], the single validation home.
#[must_use]
pub(crate) fn posture(app_data: &Path) -> GuardPosture {
    let degraded = GuardConfig::default();
    match load(app_data) {
        Ok(Some(config)) => GuardPosture {
            configured: true,
            auto_cycle_vram: config.auto_cycle_vram,
        },
        Ok(None) => GuardPosture {
            configured: false,
            auto_cycle_vram: degraded.auto_cycle_vram,
        },
        Err(problem) => {
            logs::push(
                Source::Deas,
                &format!("agent-api: guard refused: {problem}"),
            );
            GuardPosture {
                configured: false,
                auto_cycle_vram: degraded.auto_cycle_vram,
            }
        }
    }
}

/// Validates a raw candidate object with the boot laws (shape, watchdog block,
/// commands, readiness URL). [`load`] and the native settings bridge share this
/// single home, so a panel write cannot park bytes startup would refuse — the
/// `autoCycleVram`-with-empty-commands posture is refused at write time.
///
/// # Errors
///
/// Reports the JSON shape or field-validation problem with the offending field named.
pub(crate) fn validate_value(raw: &serde_json::Value) -> Result<GuardConfig, String> {
    let file: GuardFile = serde_json::from_value(raw.clone())
        .map_err(|error| format!("validate: guard file shape: {error}"))?;
    finish(file)
}

/// The shared tail: watchdog block (defaults plus one honest log line), the
/// validated config build, and the boot-law validation.
fn finish(file: GuardFile) -> Result<GuardConfig, String> {
    let (watchdog_config, note) = watchdog::WatchdogConfig::from_raw(file.watchdog.as_ref());
    if let Some(note) = note {
        logs::push(Source::Deas, &format!("agent-api: {note}"));
    }
    let config = GuardConfig {
        unload_command: file.unload_command,
        restore_command: file.restore_command,
        ready_url: file.ready_url,
        auto_cycle_vram: file.auto_cycle_vram,
        free_on_queue_end: file.free_on_queue_end,
        watchdog: watchdog_config,
        caps: file.caps.map(caps::Caps::from).unwrap_or_default(),
    };
    config
        .validate()
        .map_err(|problem| format!("validate: {problem}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, text: &str) {
        std::fs::write(dir.join(FILE), text).expect("test fixture writes guard");
    }

    #[test]
    fn absent_guard_is_not_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(load(dir.path()).expect("absent is not an error"), None);
    }

    #[test]
    fn posture_answers_the_file_word_only_while_the_file_validates() {
        // The single posture home the cycle view, `/v1/status` and `/v1/health` all read:
        // configured + the cycle word. Absent or malformed is unconfigured with the
        // shipped degraded word (legs off) — never the previous file's word, never a
        // guess at what the operator "probably meant".
        let dir = tempfile::tempdir().expect("tempdir");
        let absent = posture(dir.path());
        assert!(!absent.configured);
        assert!(
            !absent.auto_cycle_vram,
            "no guard means no unload/restore legs"
        );
        write(
            dir.path(),
            r#"{"autoCycleVram": true, "unloadCommand": "u.bat", "restoreCommand": "r.bat",
                "readyUrl": "http://127.0.0.1:18502/health"}"#,
        );
        let on = posture(dir.path());
        assert!(on.configured);
        assert!(on.auto_cycle_vram, "a validating file answers its own word");
        write(dir.path(), "{ not json");
        let broken = posture(dir.path());
        assert!(!broken.configured);
        assert!(
            !broken.auto_cycle_vram,
            "the degraded default, not the last good word"
        );
    }

    #[test]
    fn valid_guard_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"unloadCommand": "\"C:/ops/unload.bat\" /yes",
                "restoreCommand": "\"C:/ops/restore.bat\" /yes",
                "readyUrl": "http://127.0.0.1:18502/health"}"#,
        );
        let config = load(dir.path()).expect("valid").expect("present");
        assert_eq!(config.ready_url, "http://127.0.0.1:18502/health");
        assert!(config.unload_command.contains("unload.bat"));
        assert!(config.restore_command.contains("restore.bat"));
    }

    #[test]
    fn empty_unload_command_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"unloadCommand": "  ", "restoreCommand": "r.bat",
                "readyUrl": "http://127.0.0.1:18502/health"}"#,
        );
        let error = load(dir.path()).expect_err("blank command refused");
        assert!(
            error.contains("unloadCommand"),
            "error names field: {error}"
        );
    }

    #[test]
    fn empty_restore_command_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"unloadCommand": "u.bat", "restoreCommand": "",
                "readyUrl": "http://127.0.0.1:18502/health"}"#,
        );
        let error = load(dir.path()).expect_err("empty command refused");
        assert!(
            error.contains("restoreCommand"),
            "error names field: {error}"
        );
    }

    #[test]
    fn non_http_ready_url_scheme_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"unloadCommand": "u.bat", "restoreCommand": "r.bat",
                "readyUrl": "ftp://127.0.0.1/health"}"#,
        );
        let error = load(dir.path()).expect_err("ftp scheme refused");
        assert!(error.contains("readyUrl"), "error names field: {error}");
    }

    #[test]
    fn unparseable_ready_url_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"unloadCommand": "u.bat", "restoreCommand": "r.bat",
                "readyUrl": "not a url"}"#,
        );
        assert!(load(dir.path()).is_err());
    }

    #[test]
    fn https_ready_url_is_accepted() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"unloadCommand": "u.bat", "restoreCommand": "r.bat",
                "readyUrl": "https://localhost:9/health"}"#,
        );
        assert!(load(dir.path()).expect("valid").is_some());
    }

    #[test]
    fn cycle_words_default_true_and_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"unloadCommand": "u.bat", "restoreCommand": "r.bat",
                "readyUrl": "http://127.0.0.1:18502/health"}"#,
        );
        let config = load(dir.path()).expect("valid").expect("present");
        assert!(
            config.auto_cycle_vram,
            "absent autoCycleVram means the full cycle"
        );
        assert!(
            config.free_on_queue_end,
            "absent freeOnQueueEnd keeps the free leg on"
        );
    }

    #[test]
    fn cycle_off_tolerates_empty_commands_and_ready_url() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), r#"{"autoCycleVram": false}"#);
        let config = load(dir.path()).expect("valid").expect("present");
        assert!(!config.auto_cycle_vram);
        assert!(config.unload_command.is_empty());
        assert!(config.ready_url.is_empty());
    }

    #[test]
    fn cycle_on_with_empty_commands_is_the_guard_unconfigured_shape() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), r#"{"autoCycleVram": true}"#);
        let error = load(dir.path()).expect_err("true with no commands is refused");
        assert!(error.contains("unloadCommand"), "{error}");
        assert!(error.contains("restoreCommand"), "{error}");
        assert!(error.contains("readyUrl"), "{error}");
    }

    #[test]
    fn free_on_queue_end_can_be_switched_off() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"unloadCommand": "u.bat", "restoreCommand": "r.bat",
                "readyUrl": "http://127.0.0.1:18502/health",
                "freeOnQueueEnd": false}"#,
        );
        let config = load(dir.path()).expect("valid").expect("present");
        assert!(!config.free_on_queue_end);
    }

    #[test]
    fn an_over_long_command_is_refused_at_the_4096_char_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let long = "x".repeat(4097);
        write(
            dir.path(),
            &format!(
                r#"{{"unloadCommand": "{long}", "restoreCommand": "r.bat",
                  "readyUrl": "http://127.0.0.1:18502/health"}}"#
            ),
        );
        let error = load(dir.path()).expect_err("cap enforced at config time");
        assert!(error.contains("4096"), "{error}");
    }

    #[test]
    fn unknown_field_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"unloadCommand": "u.bat", "restoreCommand": "r.bat",
                "readyUrl": "http://x/health", "quietTicks": 2}"#,
        );
        assert!(load(dir.path()).is_err());
    }

    // The network caps (LEG MEDIA-1, owner ruling E21): optional block, absent
    // keys keep the shipped defaults, out-of-bounds numbers are config refusals
    // naming the key and the closed bound.

    #[test]
    fn an_absent_caps_block_is_the_shipped_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), r#"{"autoCycleVram": false}"#);
        let config = load(dir.path()).expect("valid").expect("present");
        assert_eq!(config.caps, caps::Caps::default());
    }

    #[test]
    fn a_partial_caps_block_keeps_one_default_per_absent_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"autoCycleVram": false, "caps": {"uploadSingleMiB": 10, "downloadSingleMiB": 2000}}"#,
        );
        let config = load(dir.path()).expect("valid").expect("present");
        assert_eq!(config.caps.upload_single_mib, 10);
        assert_eq!(config.caps.download_single_mib, 2000);
        assert_eq!(
            config.caps.job_upload_mib,
            caps::DEFAULT_JOB_UPLOAD_MIB,
            "the absent key keeps the shipped number"
        );
    }

    #[test]
    fn an_out_of_bounds_cap_is_a_config_refusal_naming_the_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"autoCycleVram": false, "caps": {"jobUploadMiB": 8193}}"#,
        );
        let error = load(dir.path()).expect_err("an over-bound cap is refused");
        assert!(error.contains("caps.jobUploadMiB"), "{error}");
        assert!(error.contains("8192"), "{error} names the bound");
        write(
            dir.path(),
            r#"{"autoCycleVram": false, "caps": {"uploadSingleMiB": 0}}"#,
        );
        let error = load(dir.path()).expect_err("zero is below the bound");
        assert!(error.contains("caps.uploadSingleMiB"), "{error}");
    }

    #[test]
    fn an_unknown_cap_key_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            r#"{"autoCycleVram": false, "caps": {"burstMiB": 10}}"#,
        );
        assert!(load(dir.path()).is_err());
    }
}
