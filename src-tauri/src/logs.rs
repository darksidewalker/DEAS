//! One app-wide in-memory log of DEAS messages and child process output (ComfyUI, uv/git/pip),
//! read incrementally by the Logs view. Bounded by bytes; nothing is written to disk unless exported.
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Deas,
    Comfyui,
    Cli,
}

#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    pub seq: u64,
    pub time: u64,
    pub source: Source,
    pub text: String,
}

#[derive(Default)]
struct Store {
    entries: VecDeque<Entry>,
    bytes: usize,
    next: u64,
}

static STORE: Mutex<Store> = Mutex::new(Store {
    entries: VecDeque::new(),
    bytes: 0,
    next: 0,
});

fn store() -> std::sync::MutexGuard<'static, Store> {
    STORE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn push(source: Source, text: &str) {
    store().push(source, text);
}

impl Store {
    fn push(&mut self, source: Source, text: &str) {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        self.next += 1;
        let entry = Entry {
            seq: self.next,
            time,
            source,
            text: text.to_owned(),
        };
        self.bytes += entry.text.len();
        self.entries.push_back(entry);
        while self.bytes > MAX_BYTES {
            let Some(old) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= old.text.len();
        }
    }
}

pub(crate) fn after(seq: u64) -> Vec<Entry> {
    let s = store();
    // Entries are seq-ordered: skip the already delivered prefix.
    let start = s.entries.partition_point(|e| e.seq <= seq);
    s.entries.range(start..).cloned().collect()
}

/// Fixed, path-free UI diagnostic; cannot append arbitrary frontend text.
#[tauri::command]
pub fn native_logs_people_image_error() {
    static LAST: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last.is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(60)) {
        return;
    }
    *last = Some(std::time::Instant::now());
    push(
        Source::Deas,
        "ERROR: Studio PeopleBoxes image-load: reference image could not be decoded; box editing disabled (repeats limited to once per minute)",
    );
}

/// Fixed notes-storage failure; no prompt text or paths are accepted.
#[tauri::command]
pub fn native_logs_prompt_notes_error() {
    static LAST: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last.is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(60)) {
        return;
    }
    *last = Some(std::time::Instant::now());
    push(Source::Deas, "ERROR: Studio Notes operation=save local profile storage unavailable or full; unsaved draft retained (repeats limited to once per minute)");
}

/// Fixed Library outcomes; no filenames, clipboard data or user notes are accepted.
#[tauri::command]
pub fn native_logs_library_error(operation: String) {
    let (slot, message) = match operation.as_str() {
        "clipboard" => (0, "ERROR: Library gallery clipboard: copy failed; select and copy the text manually"),
        "listing" => (1, "ERROR: Library gallery listing: models folder could not be read; previous browsing snapshot retained if available"),
        "preview" => (2, "WARN: Library gallery preview: image unavailable; placeholder shown"),
        "selection" => (3, "ERROR: Library to Studio LoRA selection: request storage unavailable or queue full; addition was not applied"),
        "organization" => (4, "ERROR: Library favorites and organization operation=save failed"),
        "family" => (5, "ERROR: Library model family batch operation=write failed"),
        "preview-fetch" => (6, "WARN: Library could not save a local CivitAI preview; metadata remains available"),
        "open-link" => (7, "ERROR: Library could not open the requested folder or CivitAI page"),
        "files" => (8, "WARN: Library model file operation did not fully complete"),
        "lora-edit" => (9, "ERROR: Library could not save a LoRA edit"),
        "civitai-link" => (10, "ERROR: Library could not link the model to the pasted CivitAI page"),
        _ => return,
    };
    static LAST: Mutex<[Option<std::time::Instant>; 11]> = Mutex::new([None; 11]);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last[slot].is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(60)) {
        return;
    }
    last[slot] = Some(std::time::Instant::now());
    push(
        Source::Deas,
        &format!("{message} (repeats limited to once per operation per minute)"),
    );
}

/// Fixed Movie Maker story-planning notices; no story text, cast names, model output or endpoint address is accepted.
#[tauri::command]
pub fn native_logs_movie_notice(operation: String) {
    let (slot, message) = match operation.as_str() {
        "plan-remote" => (0, "INFO: Movie Maker story planning: the request was sent to the configured external LLM endpoint after explicit confirmation"),
        "plan-failed" => (1, "ERROR: Movie Maker story planning: the language model request failed"),
        "plan-invalid" => (2, "WARN: Movie Maker story planning: the answer did not form a valid plan; nothing was applied"),
        "plan-applied" => (3, "INFO: Movie Maker story planning: an approved plan was applied to the movie"),
        "join-blocked" => (4, "WARN: Movie Maker assembly: the shots were not joined (a shot is missing, outdated or its clip is unusable, or the join check refused them)"),
        "join-failed" => (5, "ERROR: Movie Maker assembly: copying the clips or running the join failed"),
        "join-done" => (6, "INFO: Movie Maker assembly: the shots were joined into one film"),
        "join-cancelled" => (7, "INFO: Movie Maker assembly: the join was stopped"),
        _ => return,
    };
    static LAST: Mutex<[Option<std::time::Instant>; 8]> = Mutex::new([None; 8]);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last[slot].is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(60)) {
        return;
    }
    last[slot] = Some(std::time::Instant::now());
    push(
        Source::Deas,
        &format!("{message} (repeats limited to once per operation per minute)"),
    );
}

/// Fixed beginner-interface diagnostics; never accept paths, prompts or remote error text.
#[tauri::command]
pub fn native_logs_beginner_error(operation: String) {
    static LAST: Mutex<[Option<std::time::Instant>; 2]> = Mutex::new([None; 2]);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    let (slot, message) = match operation.as_str() {
        "catalog" => (0, "ERROR: beginner Models catalog-read: native model catalog unavailable (repeats limited to once per minute)"),
        "download" => (1, "ERROR: beginner Models download: native browse, plan, transfer or status unavailable; inspect provider access and destination (repeats limited to once per minute)"),
        _ => return,
    };
    if last[slot].is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(60)) {
        return;
    }
    last[slot] = Some(std::time::Instant::now());
    push(Source::Deas, message);
}

/// Fixed reference-preview diagnostic; no media paths or frontend text cross this boundary.
#[tauri::command]
pub fn native_logs_reference_media_error() {
    static LAST: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last.is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(60)) {
        return;
    }
    *last = Some(std::time::Instant::now());
    push(
        Source::Deas,
        "ERROR: Studio ReferenceMedia preview/playback: reference media could not be decoded or played (repeats limited to once per minute)",
    );
}

/// Fixed local-editor drop diagnostic; never log file paths or workflow contents.
#[tauri::command]
pub fn native_logs_comfy_drop_error() {
    static LAST: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last.is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(60)) {
        return;
    }
    *last = Some(std::time::Instant::now());
    push(Source::Deas, "ERROR: Comfy file-drop: intake or editor dispatch failed; check the file, available RAM and connected editor (repeats limited to once per minute)");
}

/// Bounded frontend outcomes; no paths, prompts or remote error text cross this boundary.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContinuityJoinNotice {
    LoadFailed,
    FileBlocked,
    AddFailed,
    PreflightBlocked,
    PreflightFailed,
    PreparationFailed,
    AdmissionFailed,
    ExecutionFailed,
    CorrelationFailed,
    MissingBridge,
    Cancelled,
    CancelFailed,
}

#[tauri::command]
pub fn native_logs_continuity_join_notice(
    reason: ContinuityJoinNotice,
    job_id: Option<String>,
) -> Result<(), String> {
    if job_id
        .as_ref()
        .is_some_and(|id| !uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == *id))
    {
        return Err("Invalid ContinuityJoin job identity".into());
    }
    use ContinuityJoinNotice::*;
    let (slot, severity, operation, outcome) = match reason {
        LoadFailed => (0, "ERROR", "session-read", "session unavailable"),
        FileBlocked => (
            1,
            "WARN",
            "file-pick",
            "media validation blocked the selection",
        ),
        AddFailed => (2, "ERROR", "file-pick", "inspection or upload failed"),
        PreflightBlocked => (
            3,
            "WARN",
            "preflight",
            "assembly validation blocked execution",
        ),
        PreflightFailed => (4, "ERROR", "preflight", "assembly preflight unavailable"),
        PreparationFailed => (
            5,
            "ERROR",
            "prepare",
            "transition settings or references could not be prepared",
        ),
        AdmissionFailed => (
            6,
            "ERROR",
            "admission",
            "job admission or snapshot unavailable",
        ),
        ExecutionFailed => (
            7,
            "ERROR",
            "execute",
            "sequence stopped after a job or transport failure; inspect native job diagnostics",
        ),
        CorrelationFailed => (
            8,
            "ERROR",
            "observe",
            "returned job identity did not match the submitted job",
        ),
        MissingBridge => (
            9,
            "ERROR",
            "transition",
            "successful job returned no bridge",
        ),
        Cancelled => (
            10,
            "INFO",
            "cancel",
            "sequence cancelled; no further submissions",
        ),
        CancelFailed => (
            11,
            "ERROR",
            "cancel",
            "owned job cancellation could not be confirmed",
        ),
    };
    static LAST: Mutex<[Option<std::time::Instant>; 12]> = Mutex::new([None; 12]);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last[slot].is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(60)) {
        return Ok(());
    }
    last[slot] = Some(std::time::Instant::now());
    let correlation = job_id.map_or(String::new(), |id| format!(" job={id}"));
    push(Source::Deas, &format!("{severity}: Studio ContinuityJoin {operation}{correlation}: {outcome} (repeats limited to once per reason per minute)"));
    Ok(())
}

/// Entries newer than `after` (0 = everything still retained).
#[tauri::command]
pub fn native_logs(after: u64) -> Vec<Entry> {
    self::after(after)
}

/// Save the given (already filtered) log text through an OS save dialog; cancel returns false.
#[tauri::command]
pub async fn native_logs_export(title: String, text: String) -> Result<bool, String> {
    if title.chars().count() > 240 || title.chars().any(char::is_control) {
        return Err("Invalid save dialog title".into());
    }
    if text.len() > MAX_BYTES * 2 {
        return Err("Log export exceeds the size limit".into());
    }
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title(title)
        .add_filter("Text", &["txt"])
        .set_file_name("deas-logs.txt")
        .save_file()
        .await
    else {
        return Ok(false);
    };
    std::fs::write(file.path(), text).map_err(|e| format!("Cannot write log export: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn movie_notices_are_fixed_rate_limited_and_registered() {
        let start = native_logs(0).last().map_or(0, |e| e.seq);
        native_logs_movie_notice("my secret story".into());
        for op in [
            "plan-remote",
            "plan-failed",
            "plan-invalid",
            "plan-applied",
            "join-blocked",
            "join-failed",
            "join-done",
            "join-cancelled",
        ] {
            native_logs_movie_notice(op.into());
            native_logs_movie_notice(op.into());
        }
        let entries: Vec<_> = native_logs(start)
            .into_iter()
            .filter(|e| {
                e.text.contains("Movie Maker story planning")
                    || e.text.contains("Movie Maker assembly")
            })
            .collect();
        assert_eq!(entries.len(), 8);
        assert!(entries
            .iter()
            .all(|e| e.source == Source::Deas && !e.text.contains("secret")));
        assert!(include_str!("main.rs").contains("deas::native_logs_movie_notice"));
        assert!(include_str!("../permissions/logs.toml").contains("native_logs_movie_notice"));
    }

    #[test]
    fn library_gallery_errors_are_shared_fixed_and_rate_limited() {
        let start = native_logs(0).last().map_or(0, |e| e.seq);
        native_logs_library_error("secret-user-note".into());
        for operation in [
            "clipboard",
            "listing",
            "preview",
            "selection",
            "organization",
            "family",
        ] {
            native_logs_library_error(operation.into());
            native_logs_library_error(operation.into());
        }
        let entries: Vec<_> = native_logs(start)
            .into_iter()
            .filter(|e| {
                e.text.contains("Library gallery")
                    || e.text.contains("Library to Studio")
                    || e.text.contains("Library favorites")
                    || e.text.contains("Library model family")
            })
            .collect();
        assert_eq!(entries.len(), 6);
        assert!(entries
            .iter()
            .all(|e| e.source == Source::Deas && !e.text.contains("secret-user-note")));
        assert!(include_str!("main.rs").contains("deas::native_logs_library_error"));
    }

    #[test]
    fn continuity_join_notices_are_fixed_correlated_rate_limited_and_registered() {
        let id = "11111111-2222-4333-8444-555555555555";
        let cases = [
            ("load-failed", "ERROR", "session-read"),
            ("file-blocked", "WARN", "file-pick"),
            ("add-failed", "ERROR", "file-pick"),
            ("preflight-blocked", "WARN", "preflight"),
            ("preflight-failed", "ERROR", "preflight"),
            ("preparation-failed", "ERROR", "prepare"),
            ("admission-failed", "ERROR", "admission"),
            ("execution-failed", "ERROR", "execute"),
            ("correlation-failed", "ERROR", "observe"),
            ("missing-bridge", "ERROR", "transition"),
            ("cancelled", "INFO", "cancel"),
            ("cancel-failed", "ERROR", "cancel"),
        ];
        for (reason, _, _) in cases {
            let reason =
                serde_json::from_value::<ContinuityJoinNotice>(serde_json::json!(reason)).unwrap();
            native_logs_continuity_join_notice(reason, Some(id.into())).unwrap();
            native_logs_continuity_join_notice(reason, None).unwrap();
        }
        let reports: Vec<_> = native_logs(0)
            .into_iter()
            .filter(|e| e.text.contains(": Studio ContinuityJoin "))
            .collect();
        assert_eq!(reports.len(), cases.len());
        for (entry, (_, severity, operation)) in reports.iter().zip(cases) {
            assert_eq!(entry.source, Source::Deas);
            assert!(entry.text.starts_with(&format!(
                "{severity}: Studio ContinuityJoin {operation} job={id}:"
            )));
            assert!(entry
                .text
                .ends_with("(repeats limited to once per reason per minute)"));
            assert!(entry.text.len() < 300);
        }
        assert!(include_str!("main.rs").contains("deas::native_logs_continuity_join_notice,"));
        assert!(include_str!("lib.rs").contains("native_logs_continuity_join_notice"));
        assert!(include_str!("../permissions/logs.toml")
            .contains("\"native_logs_continuity_join_notice\""));
        assert!(include_str!("../capabilities/main.json").contains("\"allow-native-logs\""));
    }

    #[test]
    fn continuity_join_notices_reject_untrusted_reasons_and_job_identities() {
        for value in [
            serde_json::json!("/private/prompt token=secret"),
            serde_json::json!({"reason":"cancelled"}),
            serde_json::Value::Null,
        ] {
            assert!(serde_json::from_value::<ContinuityJoinNotice>(value).is_err());
        }
        for id in [
            "",
            "/private/movie.mp4",
            "secret\nERROR: forged",
            "11111111222243338444555555555555",
            "11111111-2222-4333-8444-AAAAAAAAAAAA",
        ] {
            assert_eq!(
                native_logs_continuity_join_notice(
                    ContinuityJoinNotice::MissingBridge,
                    Some(id.into())
                ),
                Err("Invalid ContinuityJoin job identity".into())
            );
        }
    }

    #[test]
    fn comfy_drop_errors_are_shared_rate_limited_and_registered() {
        native_logs_comfy_drop_error();
        native_logs_comfy_drop_error();
        let reports: Vec<_> = native_logs(0)
            .into_iter()
            .filter(|e| e.text.starts_with("ERROR: Comfy file-drop:"))
            .collect();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].source, Source::Deas);
        assert!(include_str!("main.rs").contains("deas::native_logs_comfy_drop_error,"));
        assert!(
            include_str!("../permissions/logs.toml").contains("\"native_logs_comfy_drop_error\"")
        );
    }

    #[test]
    fn beginner_catalog_errors_are_fixed_shared_and_rate_limited() {
        native_logs_beginner_error("secret arbitrary text".into());
        native_logs_beginner_error("catalog".into());
        native_logs_beginner_error("catalog".into());
        let reports: Vec<_> = native_logs(0)
            .into_iter()
            .filter(|e| e.text.starts_with("ERROR: beginner Models catalog-read:"))
            .collect();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].source, Source::Deas);
        assert!(!reports[0].text.contains("secret"));
        native_logs_beginner_error("download".into());
        native_logs_beginner_error("download".into());
        let downloads: Vec<_> = native_logs(0)
            .into_iter()
            .filter(|e| e.text.starts_with("ERROR: beginner Models download:"))
            .collect();
        assert_eq!(downloads.len(), 1);
        assert_eq!(downloads[0].source, Source::Deas);
    }

    #[test]
    fn people_image_error_is_fixed_shared_and_rate_limited() {
        native_logs_people_image_error();
        native_logs_people_image_error();
        let entries = native_logs(0);
        let reports: Vec<_> = entries
            .iter()
            .filter(|e| e.text.starts_with("ERROR: Studio PeopleBoxes image-load:"))
            .collect();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].source, Source::Deas);
        assert!(!reports[0].text.contains("private.png"));
    }

    #[test]
    fn reference_media_error_is_fixed_shared_and_rate_limited() {
        native_logs_reference_media_error();
        native_logs_reference_media_error();
        let entries = native_logs(0);
        let reports: Vec<_> = entries
            .iter()
            .filter(|e| {
                e.text
                    .starts_with("ERROR: Studio ReferenceMedia preview/playback:")
            })
            .collect();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].source, Source::Deas);
        assert!(!reports[0].text.contains("private.mp4"));
    }

    #[test]
    fn incremental_reads_and_byte_cap() {
        push(Source::Deas, "first");
        let seq = after(0).last().unwrap().seq;
        push(Source::Comfyui, "second");
        // Other tests share the global store: only assert on this test's own entries.
        assert!(after(seq)
            .iter()
            .any(|e| e.text == "second" && e.source == Source::Comfyui));
        assert!(after(seq).iter().all(|e| e.text != "first"));
    }

    #[test]
    fn byte_cap_evicts_oldest_entries() {
        // A private store: overflowing the shared one would evict entries other tests are reading.
        let mut s = Store::default();
        s.push(Source::Deas, "first");
        let line = "x".repeat(1024 * 1024);
        for _ in 0..12 {
            s.push(Source::Cli, &line);
        }
        assert!(s.bytes <= MAX_BYTES);
        assert_eq!(
            s.bytes,
            s.entries.iter().map(|e| e.text.len()).sum::<usize>()
        );
        assert!(s.entries.iter().all(|e| e.seq > 1));
    }
    #[test]
    fn prompt_notes_storage_error_is_fixed_and_rate_limited() {
        let start = native_logs(0).last().map_or(0, |entry| entry.seq);
        native_logs_prompt_notes_error();
        native_logs_prompt_notes_error();
        let entries: Vec<_> = native_logs(start)
            .into_iter()
            .filter(|entry| entry.text.contains("Studio Notes operation=save"))
            .collect();
        assert_eq!(entries.len(), 1);
        assert!(include_str!("main.rs").contains("deas::native_logs_prompt_notes_error"));
        assert!(include_str!("../permissions/logs.toml").contains("native_logs_prompt_notes_error"));
    }
}
