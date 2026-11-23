//! The idempotency ledger (API-DESIGN §11, §7.3 dropped-socket law): the key the
//! generate door validates but M4..M6 never recorded. One durable row per keyed
//! generate — `deas-agent-idempotency.json` in app-data, the spool's exact atomic
//! staging + rename idiom, one process-level gate, poisoned-guard recovery, the
//! file as the state (every leg reads and mutates through this same handle).
//!
//! The ledger stores the SHA-256 digest of the key, never the key: the file is a
//! durable artifact in a user-readable app-data folder, and a plaintext key there
//! would leak the caller's secret to anything that reads the directory (pinned by
//! test against the file bytes, not the parse). The digest is the lookup identity:
//! a re-POST digests the same, so attach/duplicate postures answer without ever
//! comparing the key itself.
//!
//! Cap 128 rows, oldest evicted (§11): the ledger is a crash-recovery window, not
//! an archive; the journal stays the audit spine. A corrupt or wrong-version file
//! is reported, never hand-repaired: the generate door answers the fail-closed
//! `maintenanceActive` posture rather than silently forgetting keys — forgetting
//! the key is exactly the double-generation the ledger exists to prevent.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::spool::now_ms;
use crate::logs::{self, Source};

/// The durable ledger file, beside the spool/guard/cycle files in app-data.
pub(crate) const FILE: &str = "deas-agent-idempotency.json";
/// The ledger file schema version; only this one is understood.
pub(crate) const LEDGER_VERSION: u32 = 1;
/// Maximum retained rows (§11 "ledger max 128"); the oldest is evicted on append.
pub(crate) const LEDGER_CAP: usize = 128;

/// The two row states. A `running` row whose cycle is the live cell attaches; one
/// whose cycle is gone is the interrupted posture. A `terminal` row is the closed
/// answer: that key's drain already completed, forever.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum KeyState {
    /// The cycle claimed under this key has not answered yet.
    Running,
    /// The cycle answered terminal (the generate-side completion hook marked it).
    Terminal,
}

/// One ledger row: the key's digest, the cycle it claimed, the append stamp, the
/// state. Wire names are camelCase; the key itself is nowhere.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeyRow {
    /// SHA-256 hex of the key string — the only trace the key leaves.
    pub(crate) key_digest: String,
    /// The cycle this key claimed (or attached to).
    pub(crate) cycle_id: String,
    /// Epoch millis of the append.
    pub(crate) at_ms: u64,
    /// Running until the generate-side completion hook marks it terminal.
    pub(crate) state: KeyState,
}

/// The file shape: `{version, rows}` exactly like the spool's `{version, rows}`.
#[derive(Debug, Serialize, Deserialize)]
struct LedgerFile {
    version: u32,
    rows: Vec<KeyRow>,
}

/// The durable ledger handle: app-data location plus the one mutation gate. Cheap
/// to `Arc`; the plane shares one instance through [`super::PlaneState`].
#[derive(Debug)]
pub(crate) struct Ledger {
    app_data: PathBuf,
    gate: Mutex<()>,
}

impl Ledger {
    /// Points a ledger at an app-data directory. Touches nothing; an absent file is
    /// the empty ledger, created on the first keyed claim.
    pub(crate) fn new(app_data: &Path) -> Self {
        Self {
            app_data: app_data.to_path_buf(),
            gate: Mutex::new(()),
        }
    }

    /// The lookup identity: SHA-256 hex of the key, the shipped [`sha2`] dependency
    /// (the same idiom the library index cache uses in [`super::transport`]).
    pub(crate) fn digest(key: &str) -> String {
        use sha2::Digest as _;
        format!("{:x}", sha2::Sha256::digest(key.as_bytes()))
    }

    /// The newest row whose digest matches the key, read under the gate. `Ok(None)`
    /// is the honest miss (the key was never seen, or its row aged out past the
    /// cap); `Err` names the corrupt or unreadable file so the door can answer the
    /// fail-closed posture instead of treating corruption as a miss.
    ///
    /// # Errors
    ///
    /// Reports an unreadable, unparseable or wrong-version file naming the path,
    /// exactly as [`super::spool::Spool::snapshot`] does.
    pub(crate) fn lookup(&self, key: &str) -> Result<Option<KeyRow>, String> {
        let _gate = self.lock_gate();
        let rows = self.read_rows()?;
        let digest = Self::digest(key);
        Ok(rows.into_iter().rev().find(|row| row.key_digest == digest))
    }

    /// Appends the `running` row for a fresh keyed claim: read, extend, cap-evict
    /// the oldest, atomic rewrite, all under the gate. Callers append BEFORE the
    /// drive task starts, so a crash mid-cycle leaves a `running` row (the
    /// interrupted posture) rather than a lost key.
    ///
    /// # Errors
    ///
    /// Reports a corrupt file or a write failure; on either, the target keeps its
    /// bytes (a failed append never rewrites a ledger the door already trusted).
    pub(crate) fn append_running(&self, key: &str, cycle_id: &str) -> Result<(), String> {
        let _gate = self.lock_gate();
        let mut rows = self.read_rows()?;
        rows.push(KeyRow {
            key_digest: Self::digest(key),
            cycle_id: cycle_id.to_owned(),
            at_ms: now_ms(),
            state: KeyState::Running,
        });
        if rows.len() > LEDGER_CAP {
            // Age out the oldest (§11 cap): the window is crash-recovery depth, not
            // history. The journal keeps the audit trail regardless.
            let excess = rows.len() - LEDGER_CAP;
            rows.drain(0..excess);
            logs::push(
                Source::Deas,
                &format!("agent-api: idempotency ledger at cap {LEDGER_CAP}; oldest rows aged out"),
            );
        }
        self.write_rows(&rows)
    }

    /// Marks the cycle's row `terminal` (the generate-side completion hook; one
    /// home, cited in [`super::routes`]). A cycle claimed without a key has no row
    /// and this is an honest no-op.
    ///
    /// # Errors
    ///
    /// Reports a corrupt file or a write failure, as [`Self::append_running`].
    pub(crate) fn mark_terminal(&self, cycle_id: &str) -> Result<(), String> {
        let _gate = self.lock_gate();
        let mut rows = self.read_rows()?;
        let mut touched = false;
        for row in &mut rows {
            if row.cycle_id == cycle_id && row.state != KeyState::Terminal {
                row.state = KeyState::Terminal;
                touched = true;
            }
        }
        if !touched {
            return Ok(());
        }
        self.write_rows(&rows)
    }

    /// The ledger file path.
    fn path(&self) -> PathBuf {
        self.app_data.join(FILE)
    }

    /// Takes the mutation gate, recovering a poisoned guard (the spool's law: the
    /// guarded data is file-backed and re-read per operation, so a panicked holder
    /// strands nothing); no guard is ever held across an `await`.
    fn lock_gate(&self) -> MutexGuard<'_, ()> {
        self.gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reads and validates the rows. Caller holds the gate. An absent file is the
    /// empty ledger; anything unreadable, unparseable or foreign-version is an
    /// error naming the path — the fail-closed posture's fact.
    fn read_rows(&self) -> Result<Vec<KeyRow>, String> {
        let path = self.path();
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("read {}: {error}", path.display())),
        };
        let file: LedgerFile = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parse {}: {error}", path.display()))?;
        if file.version != LEDGER_VERSION {
            return Err(format!(
                "validate {}: version {} is not supported (expected {LEDGER_VERSION})",
                path.display(),
                file.version
            ));
        }
        Ok(file.rows)
    }

    /// Rewrites the whole file atomically: staging file in app-data, then rename
    /// over the target. Caller holds the gate. Mirrors [`super::spool::Spool`]
    /// exactly (staging name carries the process id; the target keeps its previous
    /// bytes on any failure).
    fn write_rows(&self, rows: &[KeyRow]) -> Result<(), String> {
        let path = self.path();
        let staging = path.with_file_name(format!("{FILE}.{}.tmp", std::process::id()));
        let file = LedgerFile {
            version: LEDGER_VERSION,
            rows: rows.to_vec(),
        };
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|error| format!("serialize {FILE}: {error}"))?;
        let result = std::fs::write(&staging, &bytes)
            .map_err(|error| format!("write {}: {error}", staging.display()))
            .and_then(|()| {
                std::fs::rename(&staging, &path)
                    .map_err(|error| format!("rename onto {}: {error}", path.display()))
            });
        if result.is_err() {
            // Best-effort cleanup of the staging file; the target keeps its previous bytes.
            let _ = std::fs::remove_file(&staging);
        }
        result
    }
}

#[cfg(test)]
impl Ledger {
    /// Test-only window into the rows (the gate-free read is private by design;
    /// tests over the public surface go through `lookup`).
    fn read_rows_for_test(&self) -> Vec<KeyRow> {
        let _gate = self.lock_gate();
        self.read_rows().expect("test ledger is readable")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger_in(dir: &Path) -> Ledger {
        Ledger::new(dir)
    }

    fn on_disk(dir: &tempfile::TempDir) -> String {
        std::fs::read_to_string(dir.path().join(FILE)).expect("ledger written")
    }

    #[test]
    fn absent_file_is_the_empty_ledger() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ledger = ledger_in(dir.path());
        assert_eq!(ledger.lookup("never-seen").expect("empty read"), None);
        assert!(
            !dir.path().join(FILE).exists(),
            "a read never creates the file"
        );
    }

    #[test]
    fn append_running_lands_a_digest_row_and_lookup_finds_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ledger = ledger_in(dir.path());
        ledger
            .append_running("my-session-key", "cycle-1")
            .expect("first append");
        let row = ledger
            .lookup("my-session-key")
            .expect("readable")
            .expect("row");
        assert_eq!(row.key_digest, Ledger::digest("my-session-key"));
        assert_eq!(row.cycle_id, "cycle-1");
        assert_eq!(row.state, KeyState::Running);
        assert!(row.at_ms > 0, "the append stamps the clock");
        // A different key is an honest miss, not a fuzzy match.
        assert!(ledger.lookup("other-key").expect("readable").is_none());
    }

    #[test]
    fn digest_only_storage_pins_the_key_out_of_the_file_bytes() {
        // The law: the durable file never carries the key plaintext — only its
        // digest. Pinned against the bytes, not against the parse.
        let dir = tempfile::tempdir().expect("tempdir");
        let ledger = ledger_in(dir.path());
        let secret = "super-secret-session-key-9f3a";
        ledger.append_running(secret, "cycle-1").expect("append");
        ledger.mark_terminal("cycle-1").expect("terminal");
        let bytes = on_disk(&dir);
        assert!(
            !bytes.contains(secret),
            "the ledger bytes must never contain the key"
        );
        assert!(
            bytes.contains(&Ledger::digest(secret)),
            "the digest is the stored identity"
        );
        assert!(bytes.contains("keyDigest"), "the wire field names ship");
    }

    #[test]
    fn cap_evicts_the_oldest_rows_beyond_128() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ledger = ledger_in(dir.path());
        for index in 0..=(LEDGER_CAP as u32 + 1) {
            ledger
                .append_running(&format!("key-{index}"), &format!("cycle-{index}"))
                .expect("append within cap");
        }
        let newest = on_disk(&dir);
        let file: LedgerFile = serde_json::from_str(&newest).expect("valid json");
        assert_eq!(file.rows.len(), LEDGER_CAP, "the cap holds at 128");
        // The first two appends aged out; the newest survived.
        assert!(ledger.lookup("key-0").expect("readable").is_none());
        assert!(ledger.lookup("key-1").expect("readable").is_none());
        let last = format!("key-{}", LEDGER_CAP + 1);
        let row = ledger
            .lookup(&last)
            .expect("readable")
            .expect("newest row survives eviction");
        assert_eq!(row.cycle_id, format!("cycle-{}", LEDGER_CAP + 1));
    }

    #[test]
    fn mark_terminal_flips_only_the_matching_cycle() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ledger = ledger_in(dir.path());
        ledger.append_running("ka", "cycle-a").expect("append a");
        ledger.append_running("kb", "cycle-b").expect("append b");
        ledger.mark_terminal("cycle-a").expect("terminal a");
        let rows = ledger.read_rows_for_test();
        assert_eq!(rows[0].state, KeyState::Terminal);
        assert_eq!(rows[1].state, KeyState::Running, "the other row stays");
        // An unkeyed cycle has no row: the hook is an honest no-op, never an error.
        ledger.mark_terminal("cycle-no-keys").expect("no-op");
    }

    #[test]
    fn corrupt_ledger_is_reported_never_repaired() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(FILE), "{ not json").expect("fixture write");
        let ledger = ledger_in(dir.path());
        let problem = ledger.lookup("any-key").expect_err("corrupt must error");
        assert!(problem.contains(FILE), "the problem names the file");
        let on_disk = std::fs::read_to_string(dir.path().join(FILE)).expect("still there");
        assert_eq!(on_disk, "{ not json", "a failed read never touches bytes");
        // A foreign version is the same honest refusal (fail-closed, no repair).
        std::fs::write(dir.path().join(FILE), r#"{"version": 99, "rows": []}"#)
            .expect("fixture write");
        assert!(ledger.lookup("any-key").is_err(), "version 99 is refused");
    }

    #[test]
    fn row_state_words_are_the_closed_two() {
        let value =
            serde_json::to_value([KeyState::Running, KeyState::Terminal]).expect("serializable");
        assert_eq!(value, serde_json::json!(["running", "terminal"]));
    }

    #[test]
    fn reused_digest_lookups_answer_the_newest_row() {
        // After eviction a key can re-enter: lookups scan from the tail so the
        // freshest claim is the one the door answers from.
        let dir = tempfile::tempdir().expect("tempdir");
        let ledger = ledger_in(dir.path());
        ledger.append_running("twice", "cycle-old").expect("first");
        ledger.mark_terminal("cycle-old").expect("terminal");
        ledger.append_running("twice", "cycle-new").expect("second");
        let row = ledger.lookup("twice").expect("readable").expect("row");
        assert_eq!(row.cycle_id, "cycle-new");
        assert_eq!(row.state, KeyState::Running);
    }
}
