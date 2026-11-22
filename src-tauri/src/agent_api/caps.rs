//! The configurable network caps (owner ruling E21 + E21-AMENDMENT, API-DESIGN:
//! caps are NETWORK caps, not storage caps).
//!
//! Three numbers ride the operator guard file (`deas-agent-guard.json`, `caps` block,
//! all keys optional — absent is the shipped default, out-of-bounds is a config
//! refusal mirroring the cycle-bat cap honesty, never a silent clamp):
//!
//! * `uploadSingleMiB` (default 50) — one `POST /v1/uploads` body.
//! * `jobUploadMiB` (default 100) — the per-batch upload budget: uploads that share
//!   `?batch=<label>` accumulate against it. The ledger is IN-MEMORY (a
//!   [`BatchLedger`], LRU-capped at [`MAX_BATCH_LABELS`] labels): per-process
//!   best-effort network accounting, deliberately not durable — a restart is a
//!   fresh budget, and that is the documented reset semantics.
//! * `downloadSingleMiB` (default 500) — one byte-door read
//!   (`GET /v1/files/inputs/...`, `GET /v1/files/outputs/...`, and the preview
//!   door's config leg under `min(configured, stock ceilings)`).
//!
//! ON-DISK files cost nothing: a reference already placed on disk (placed by an
//! earlier upload, an absolute-path reference folded at the queue door, or a
//! generated output moved in by `POST /v1/inputs/promote`) gets NO size cap — the
//! walls sit only where bytes cross the network or leave the process.

use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::Mutex;

use serde::Deserialize;

use super::errors::{ApiError, ErrorKind};
use super::guard;

/// Shipped default for one upload body (the §11 50 MiB law, now configurable).
pub(crate) const DEFAULT_UPLOAD_SINGLE_MIB: u64 = 50;
/// Shipped default for the per-batch upload budget (the §11 100 MiB job law).
pub(crate) const DEFAULT_JOB_UPLOAD_MIB: u64 = 100;
/// Shipped default for one byte-door download.
pub(crate) const DEFAULT_DOWNLOAD_SINGLE_MIB: u64 = 500;

/// The closed bound every cap key shares: a whole number of MiB, 1..=8192.
pub(crate) const CAP_MIN_MIB: u64 = 1;
pub(crate) const CAP_MAX_MIB: u64 = 8192;

/// LRU ceiling of the batch ledger: 256 labels, oldest-touched evicted first.
pub(crate) const MAX_BATCH_LABELS: usize = 256;

/// The three network caps as resolved integers of MiB.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Caps {
    /// One `POST /v1/uploads` body.
    pub(crate) upload_single_mib: u64,
    /// The accumulated upload budget under one `?batch=` label.
    pub(crate) job_upload_mib: u64,
    /// One byte-door file read.
    pub(crate) download_single_mib: u64,
}

impl Default for Caps {
    fn default() -> Self {
        Self {
            upload_single_mib: DEFAULT_UPLOAD_SINGLE_MIB,
            job_upload_mib: DEFAULT_JOB_UPLOAD_MIB,
            download_single_mib: DEFAULT_DOWNLOAD_SINGLE_MIB,
        }
    }
}

impl Caps {
    /// One cap in bytes; the 1..=8192 MiB bound keeps the product far inside `u64`.
    pub(crate) const fn bytes(mib: u64) -> u64 {
        mib * 1024 * 1024
    }

    /// The config-refusal law, mirroring the bat-cap honesty at [`guard`]'s
    /// command cap: an out-of-bounds number names its key and the closed bound,
    /// never a clamp, never a silent default.
    pub(crate) fn validate(&self, problems: &mut Vec<String>) {
        for (key, value) in [
            ("caps.uploadSingleMiB", self.upload_single_mib),
            ("caps.jobUploadMiB", self.job_upload_mib),
            ("caps.downloadSingleMiB", self.download_single_mib),
        ] {
            if !(CAP_MIN_MIB..=CAP_MAX_MIB).contains(&value) {
                problems.push(format!(
                    "{key} must be an integer number of MiB between {CAP_MIN_MIB} and {CAP_MAX_MIB} (got {value})"
                ));
            }
        }
    }
}

/// The raw `caps` block of the guard file: every key optional (absent keeps the
/// shipped default), a non-integer value is the shape refusal serde already
/// produces, an out-of-bounds integer is refused by [`Caps::validate`]. The wire
/// keys are named one by one (NOT `rename_all = "camelCase"`: that would mint
/// `uploadSingleMib`, and the ruling spells them `uploadSingleMiB`).
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub(crate) struct CapsFile {
    #[serde(default, rename = "uploadSingleMiB")]
    pub(crate) upload_single_mib: Option<u64>,
    #[serde(default, rename = "jobUploadMiB")]
    pub(crate) job_upload_mib: Option<u64>,
    #[serde(default, rename = "downloadSingleMiB")]
    pub(crate) download_single_mib: Option<u64>,
}

impl From<CapsFile> for Caps {
    fn from(file: CapsFile) -> Self {
        let defaults = Self::default();
        Self {
            upload_single_mib: file.upload_single_mib.unwrap_or(defaults.upload_single_mib),
            job_upload_mib: file.job_upload_mib.unwrap_or(defaults.job_upload_mib),
            download_single_mib: file
                .download_single_mib
                .unwrap_or(defaults.download_single_mib),
        }
    }
}

/// Reads the caps through the guard file's single validation home. Absent file or
/// absent block is the shipped default (additive backward-compat); a malformed
/// guard is the honest `guardUnconfigured` refusal — a caps-bearing door never
/// guesses past a broken operator file it cannot trust.
///
/// # Errors
///
/// Reports the guard file's own validation problem beside the word.
pub(crate) fn resolve(app_data: &Path) -> Result<Caps, ApiError> {
    match guard::load(app_data) {
        Ok(None) => Ok(Caps::default()),
        Ok(Some(config)) => Ok(config.caps),
        Err(problem) => Err(ApiError::new(ErrorKind::GuardUnconfigured).with_hint(problem)),
    }
}

/// The batch-upload ledger: `label -> accumulated arrived bytes`, in-memory,
/// LRU-capped. The budget counts bytes that ARRIVED at the door (the wall is the
/// network, not storage), and a refusal charge never lands (the over-budget body
/// is refused whole). Reset semantics are per-process by design: the ledger is
/// RAM, so a plane restart starts every label at zero — the documented,
/// best-effort posture, not a durable quota.
pub(crate) struct BatchLedger {
    state: Mutex<LedgerState>,
}

#[derive(Default)]
struct LedgerState {
    totals: BTreeMap<String, u64>,
    /// Touch order: front is the least-recently-touched label (the LRU victim).
    order: VecDeque<String>,
}

impl BatchLedger {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Charges `bytes` against `label` under `cap_bytes`. Returns the new label
    /// total when the charge fits; `None` when it would breach the cap (nothing
    /// is charged, and the door answers `capExceeded` naming the standing total).
    #[must_use]
    pub(crate) fn try_charge(&self, label: &str, bytes: u64, cap_bytes: u64) -> Option<u64> {
        let mut state = self.state.lock().expect("batch ledger lock");
        let current = state.totals.get(label).copied().unwrap_or(0);
        let next = current.checked_add(bytes)?;
        if next > cap_bytes {
            return None;
        }
        state.totals.insert(label.to_owned(), next);
        if state.order.iter().any(|held| held == label) {
            state.order.retain(|held| held != label);
        }
        state.order.push_back(label.to_owned());
        while state.totals.len() > MAX_BATCH_LABELS {
            if let Some(evicted) = state.order.pop_front() {
                state.totals.remove(&evicted);
            }
        }
        Some(next)
    }

    /// The standing total for a label (0 when unknown); the refusal hint reads it
    /// so the caller sees the budget the NEXT upload joins.
    #[must_use]
    pub(crate) fn total(&self, label: &str) -> u64 {
        self.state
            .lock()
            .expect("batch ledger lock")
            .totals
            .get(label)
            .copied()
            .unwrap_or(0)
    }
}

impl Default for BatchLedger {
    fn default() -> Self {
        Self {
            state: Mutex::new(LedgerState::default()),
        }
    }
}

/// The batch-label grammar: a bare token, at most 64 bytes — letters, digits,
/// `-`, `_`, and interior dots; no separators, no control characters, no
/// traversal forms. The label is never composed into a path anywhere; the
/// grammar stands so it can never even present one.
///
/// # Errors
///
/// `bodyInvalid` naming the closed grammar, the same family as the uploads
/// pathwall at [`super::uploads::check_name`].
pub(crate) fn check_label(label: &str) -> Result<(), ApiError> {
    let refusal = |why: &str| {
        ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "the batch parameter must be a bare label of at most 64 bytes ({why}); the closed grammar allows no paths"
        ))
    };
    if label.is_empty() {
        return Err(refusal("it is empty"));
    }
    if label.len() > 64 {
        return Err(refusal("it exceeds 64 bytes"));
    }
    if label.contains(['/', '\\']) {
        return Err(refusal("it contains a path separator"));
    }
    if label.chars().any(char::is_control) {
        return Err(refusal("it contains control characters"));
    }
    if !label
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(refusal(
            "only letters, digits, '-', '_' and '.' are allowed",
        ));
    }
    if label == "." || label == ".." || label.bytes().all(|c| c == b'.') {
        return Err(refusal("it is a traversal name"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_defaults_are_the_design_numbers() {
        let caps = Caps::default();
        assert_eq!(caps.upload_single_mib, 50);
        assert_eq!(caps.job_upload_mib, 100);
        assert_eq!(caps.download_single_mib, 500);
        let mut problems = Vec::new();
        caps.validate(&mut problems);
        assert!(problems.is_empty(), "the defaults validate clean");
    }

    #[test]
    fn an_out_of_bounds_cap_names_its_key_and_the_closed_bound() {
        let caps = Caps {
            upload_single_mib: 0,
            job_upload_mib: 8193,
            download_single_mib: 500,
        };
        let mut problems = Vec::new();
        caps.validate(&mut problems);
        let text = problems.join("; ");
        assert!(text.contains("caps.uploadSingleMiB"), "{text}");
        assert!(text.contains("caps.jobUploadMiB"), "{text}");
        assert!(text.contains("1 and 8192"), "{text}");
        assert!(
            !text.contains("caps.downloadSingleMiB"),
            "the in-bounds key is not named: {text}"
        );
    }

    #[test]
    fn an_absent_cap_key_keeps_the_shipped_default() {
        let file: CapsFile =
            serde_json::from_str(r#"{"jobUploadMiB": 25}"#).expect("partial block parses");
        let caps = Caps::from(file);
        assert_eq!(caps.job_upload_mib, 25);
        assert_eq!(caps.upload_single_mib, DEFAULT_UPLOAD_SINGLE_MIB);
        assert_eq!(caps.download_single_mib, DEFAULT_DOWNLOAD_SINGLE_MIB);
    }

    #[test]
    fn a_fractional_cap_is_a_shape_refusal_not_a_round() {
        let error = serde_json::from_str::<CapsFile>(r#"{"uploadSingleMiB": 2.5}"#)
            .expect_err("a float is not an integer MiB count");
        assert!(error.to_string().contains("floating point"), "{error}");
    }

    #[test]
    fn an_unknown_cap_key_is_refused() {
        assert!(serde_json::from_str::<CapsFile>(r#"{"burstMiB": 10}"#).is_err());
    }

    /// The RESET law, doc-pinned: the ledger is RAM, so a fresh ledger starts
    /// every label at zero — the per-process best-effort posture the module
    /// carries. Restart semantics need no code: no persistence exists.
    #[test]
    fn a_fresh_ledger_starts_every_label_at_zero() {
        let filled = BatchLedger::new();
        assert_eq!(
            filled.try_charge("run-a", 7, Caps::bytes(1)).expect("fits"),
            7
        );
        let restarted = BatchLedger::new();
        assert_eq!(restarted.total("run-a"), 0, "the budget is per-process");
    }

    #[test]
    fn the_batch_wall_sums_a_label_and_a_refusal_charge_never_lands() {
        let ledger = BatchLedger::new();
        let cap = 1_000_000_u64;
        assert_eq!(
            ledger.try_charge("run", 600_000, cap).expect("fits"),
            600_000
        );
        assert_eq!(
            ledger.try_charge("run", 400_000, cap).expect("fits"),
            1_000_000
        );
        assert!(
            ledger.try_charge("run", 1, cap).is_none(),
            "the label total would breach the cap"
        );
        assert_eq!(
            ledger.total("run"),
            1_000_000,
            "the refused charge never landed"
        );
        // A different label is its own budget.
        assert_eq!(ledger.try_charge("other", 1, cap).expect("fits"), 1);
    }

    #[test]
    fn the_ledger_evicts_least_recently_touched_labels_past_the_cap() {
        let ledger = BatchLedger::new();
        for index in 0..MAX_BATCH_LABELS {
            let label = format!("batch-{index}");
            assert!(ledger
                .try_charge(&label, 1, u64::MAX)
                .is_some_and(|total| total == 1));
        }
        // Touch the oldest label, then push one past the 256-label ceiling: the
        // eviction victim is the LEAST recently touched, not the first minted.
        assert!(ledger
            .try_charge("batch-0", 1, u64::MAX)
            .is_some_and(|total| total == 2));
        assert!(ledger
            .try_charge("batch-256", 1, u64::MAX)
            .is_some_and(|total| total == 1));
        assert_eq!(ledger.total("batch-1"), 0, "the LRU victim was evicted");
        assert_eq!(ledger.total("batch-0"), 2, "the touched label survived");
        assert_eq!(ledger.total("batch-256"), 1);
    }

    #[test]
    fn the_label_grammar_is_bare_and_bounded() {
        assert!(check_label("run-1").is_ok());
        assert!(check_label("owner_run.a").is_ok());
        assert!(check_label(&"x".repeat(64)).is_ok());
        for bad in [
            "",
            &"x".repeat(65),
            "../evil",
            "a/b",
            "a\\b",
            ".",
            "..",
            "...",
            "space label",
            "bad\u{0}",
            "pct%20",
        ] {
            let error = check_label(bad).expect_err("grammar refuses");
            assert_eq!(
                error.body_json()["reason"],
                "bodyInvalid",
                "{bad:?}: the label grammar rides the bodyInvalid word"
            );
        }
    }
}
