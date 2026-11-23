//! The cycle machine (API-DESIGN §3 PHASE 2, §7): one driver drains the whole spool
//! under ONE VRAM handoff.
//!
//! The cell is the fence and the answer. [`CycleCell::claim`] is the fence CAS: a
//! second claim while a cycle runs answers `cycleInFlight` (409), and exactly one
//! driver owns the batch. The terminal batch report is the cycle's answer, persisted
//! to `deas-agent-cycle.json` beside the spool with the spool's own atomic staging +
//! rename idiom. The dropped-socket law (§7.3) lives here: a caller socket dying
//! changes nothing — the driver runs server-side regardless, and `GET /v1/cycle`
//! reads the live phase or the persisted terminal report from this cell.
//!
//! The machine is ONE sequence with the legs switched off by the guard word
//! (`autoCycleVram`, §7.2), never a second code path: unload bat → serial drain →
//! file-stability walk → idle-proof → settle → free → down-hold + patience → restore
//! bat → health poll.
//!
//! The file-stability walk (LEG AF2-M33) is a DELAY, never a verdict: a stock row can
//! read terminal (`succeeded`) while the backend's post-graph writer threads — SaveVideo,
//! the audio mux, the H3 encode — still hold the GPU finishing the file, and the queue
//! idle proof cannot see that writer (the job has left both queue lists). The walk waits
//! on the FILES the terminal rows named, bounded and fail-open, before the end legs are
//! entered; it changes no row, no fault and no wire.
//! Batch semantics (§10): a row failing mid-drain is recorded and the drain
//! CONTINUES; an empty batch is no cycle at all (no bat, no free, no restore —
//! immediate report).
//!
//! The compute gate (§SR3, P1 co-residency law): the cycle holds
//! [`crate::resources::reserve_compute`] across its legs, but MUST release it for
//! the drain itself — the stock submit chain acquires the SAME process-wide gate
//! inside `submit_inner` (jobs.rs:2192; the managed `Jobs` carries the global gate
//! because `Compute::default` returns `COMPUTE.clone()` outside `cfg(test)`), so a
//! cycle held across submit would busy-refuse every row the batch dispatches. The
//! permit covers unload, then is reacquired for the free/restore legs. This
//! deviation from a literal whole-cycle hold is measured, not guessed.
//!
//! All physics runs over the seams below (production impls thin, logic here):
//! [`CommandRunner`] (operator bats — NEVER executed in unit tests; the bat strings
//! are operator config), [`SubmitChain`] (the stock prepare/submit/status trio),
//! [`BackendDoor`] (queue idle proof + the AF2-M33 output-stability read + the two-key
//! `/free` wire), plus the compute gate, the health probe and the pacer. The fake postures drive every timing and
//! retry law in the tests below without a GPU, a backend or a bat.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde_json::{json, Value};

use super::cycle_view::{CyclePhase, LiveCycle};
use super::errors::{ApiError, ErrorKind};
use super::guard::GuardConfig;
use super::results::RefmodBridge;
use super::spool::{now_ms, QueueRow, RowStatus, Spool};
use crate::logs::{self, Source};

/// The persisted cycle-cell file, beside the spool/guard/defaults files in app-data.
pub(crate) const FILE: &str = "deas-agent-cycle.json";
/// The cell file schema version; only this one is understood.
pub(crate) const CELL_VERSION: u32 = 1;

/// Timing consts, verbatim from API-DESIGN §7.1 (pinned by test; these numbers are
/// measured physics, not preferences).
pub(crate) const SETTLE_MS: u64 = 2_000;
/// AF2-M33 (the H3 mux race): the read gap of the output-stability walk. The stock
/// snapshot word `succeeded` lands BEFORE the backend's post-graph writers finish the
/// file — the `-audio` outputs prove the mux runs post-graph, and the H3 encode follows
/// it — so every row can read terminal while a render still holds the GPU. [`SETTLE_MS`]
/// (2 s) is nowhere near an H3 mux, and the queue idle proof never sees the writer (the
/// job has already left `queue_running`/`queue_pending`), so the end legs wait on the
/// files: a file is settled when two reads this far apart report identical size AND
/// identical mtime.
pub(crate) const STABILITY_POLL_MS: u64 = 2_000;
/// The whole-walk bound (AF2-M33), fail-open by law: an outputs descriptor naming a file
/// the backend never wrote — or never finishes writing — must not park the card forever.
/// At this bound the walk stops, every unsettled file rides an honest detail on the
/// report's `stability` key, and the end legs proceed.
pub(crate) const STABILITY_TIMEOUT_MS: u64 = 60_000;
/// The walk's wait budget, derived from the pair: `60 000 / 2 000 = 30` gaps. The bound
/// is counted so tests pin it through the pacer fake without a wall clock (the module's
/// bounded-attempt idiom); the wall clock is the second, never-loser ceiling for the case
/// where the reads themselves are slow.
pub(crate) const STABILITY_WAIT_BOUND: u64 = STABILITY_TIMEOUT_MS / STABILITY_POLL_MS;
/// Down-hold after the free ack, before the patience window.
pub(crate) const DOWN_HOLD_MS: u64 = 500;
/// W3-17 (LEG AF2-M21a): the bounded re-probe count of the free-FAULT-path
/// settle ([`free_fault_settle`]) — raised from the F4 single look to the acked
/// path's patience class, same [`DOWN_HOLD_MS`] rhythm, still bounded.
pub(crate) const FREE_FAULT_SETTLE_PROBE_BOUND: u32 = 4;
/// Fixed post-free patience: welded 2 500 + 2 000 (free-ack to restore-started was
/// measured at 5 007 ms; §12-E4).
pub(crate) const PATIENCE_MS: u64 = 2_500 + 2_000;
/// Health probes run at no more than one per this gap.
pub(crate) const HEALTH_PROBE_GAP_MS: u64 = 2_000;
/// The `retryAfterMs` cadence the 409 `cycleInFlight` answers carry (§10
/// double-generate row): the caller-facing poll promise for `GET /v1/cycle`, welded
/// to the same 2 000 ms rhythm as [`HEALTH_PROBE_GAP_MS`] but homed separately on
/// purpose — that const is the machine's internal probe spacing; this one is the
/// promise made to the client (§7.3: poll at 1–2 s). One home, cited here.
pub(crate) const CYCLE_RETRY_AFTER_MS: u64 = 2_000;
/// Restore is re-triggered at most this many times per cycle (§8.4).
pub(crate) const RESTORE_ATTEMPT_BOUND: u32 = 3;
/// The free wire is attempted at most this many times per cycle (§10 `free ack
/// missing`: retry free, bound 3 per cycle, then the terminal cycle-fault answer).
pub(crate) const FREE_ATTEMPT_BOUND: u32 = 3;
/// Spacing between restore re-triggers (§8.4: 90 s, never forever).
pub(crate) const RESTORE_GAP_MS: u64 = 90_000;
/// Health window per restore attempt: probes at ≤1/[`HEALTH_PROBE_GAP_MS`] for this
/// long; an attempt whose window expires is an unhealthy attempt under the §8.4 bound.
/// LEG AF2-M20 (TIMING pass): raised from the 4 500 ms patience weld to 15 000 ms per
/// attempt — the weld measured a warm restart, a cold-cache model load needs room to
/// answer. The attempt count stays bounded (RESTORE_ATTEMPT_BOUND 3, 90 s apart), so
/// the extra width costs a dead target nothing it was not already paying.
const HEALTH_WINDOW_MS: u64 = 15_000;
/// Poll gap for the production row driver ([`StockSubmitChain`] polling the stock
/// `native_job_status` row driver; mirrors the health probe's ≤1/2 s cadence).
const ROW_POLL_GAP_MS: u64 = 2_000;
/// The hard per-row render deadline (LEG AF2-M18a W2). The watchdog covers IDLE wedges
/// — its two-fact judge needs the card to go quiet — so a row hot-wedged on a busy
/// backend (median utilization high, fact two fails) never trips it and the row poll
/// loop would be the fence's own lease for nothing. This const is the backstop that
/// guarantees the loop ends. LEG AF2-M20 F2: 30 min → 60 min — P6 measured legitimate
/// 26-minute rows (video/ref2va class), and the expiry now scoped-cancels the live
/// job before the cycle's end legs, so the deadline is a true safety net, never a cap
/// on slow-but-live work.
pub(crate) const ROW_DEADLINE_MS: u64 = 3_600_000;
/// The queued-stall bound (W4-E, LEG AF2-M22): a correlated job whose stock status
/// word stays `queued` (never seen `running`) keeps the watchdog's judge stood down —
/// W3-7's confirmation never happens, so the two-fact arm never trips — and before
/// this const such a submit-stuck row rode the 60-min row deadline with nobody
/// watching. A job that has not STARTED within 10 minutes is not slow-but-live; it
/// is stuck, and `cancel_pending` is exactly the verb for it. The running-row
/// [`ROW_DEADLINE_MS`] law is untouched: the first non-queued word closes this
/// deadline for good.
pub(crate) const QUEUED_STALL_MS: u64 = 600_000;
/// The unload-bat budget (LEG AF2-M18a W1). A hung unload leg used to wait forever in
/// `.output()`, parking the cycle in `unloading` with the fence held while the
/// watchdog stands down under that same phase — nobody drives it, a deterministic
/// wedge. The leg now ends by itself, at this bound, and the fault machinery treats it
/// like any other failed leg.
pub(crate) const UNLOAD_TIMEOUT_MS: u64 = 120_000;
/// The restore-bat budget (W1), the same never-forever law on the other leg and sized
/// above the unload leg on purpose: the weights go up slower than they come down. The
/// watchdog's sever arm runs this SAME leg (§8.2 step 5), so the bound covers it too.
/// LEG AF2-M20 (TIMING pass): 300 000 → 900 000 — Strata's own model-load idiom is
/// 900 s and a cold-cache 30 B load measured past the old budget, so a slow-but-live
/// load is no longer killed into the bounded retry loop.
pub(crate) const RESTORE_TIMEOUT_MS: u64 = 900_000;
/// The backend-ready gate window (E29, LEG AF2-M24a): submit is fact-gated, never
/// timer-gated. Boot on this class of machine takes 30-60 s, so a fixed sleep is
/// worthless — the wait is bounded by this window instead, and an expired window
/// answers honestly (the row fails `submit_failed`, the bridge answers its
/// maintenance word) with the last state word observed.
pub(crate) const BACKEND_READY_TIMEOUT_MS: u64 = 180_000;
/// The gate's re-read cadence (E29): one Engine status read per gap, plus a
/// `/queue` probe whenever the word is `running` with an endpoint. Injectable so
/// tests run the same loop in milliseconds.
pub(crate) const BACKEND_READY_POLL_MS: u64 = 2_000;
/// How often the bat monitor checks its child (W1). Cheap: one `try_wait` per gap.
const BAT_POLL_GAP_MS: u64 = 500;
/// Polls spent reaping a child the monitor killed, so the OS handle goes down with the
/// leg instead of dangling. Bounded: the reap is housekeeping, never a new wait.
const BAT_REAP_POLLS: u32 = 4;

/// The fault words a report may carry, each a closed-taxonomy member (§11):
/// [`ErrorKind::MaintenanceActive`] for generic cycle faults, [`ErrorKind::RestoreExhausted`]
/// for §8.4 exhaustion, and [`ErrorKind::HandoffFailed`] for the §10 unload-bat wedge
/// (manager-ruled wire word, 2026-11-21): a non-zero unload exit means the card never
/// went down, so the fence releases, the spool stays honestly queued, and the held
/// caller answers 409 `handoffFailed` with the retry safe under key idempotency (ledger).
pub(crate) const FAULT_CYCLE: &str = "maintenanceActive";
pub(crate) const FAULT_RESTORE: &str = "restoreExhausted";
pub(crate) const FAULT_HANDOFF: &str = "handoffFailed";

/// The CLOSED known-wedge startup set (design 10 §14.6): the three ComfyUI launch
/// flags whose memory posture is known to wedge the stock release pass, so a
/// free-leg exhaustion can name a CAUSE instead of only the symptom. `--highvram`
/// pins the models resident (nothing to unload), `--reserve-vram <GB>` holds a slab
/// back from the release, `--disable-smart-memory` keeps every unloaded model in
/// VRAM. The list is closed at three members: the effective preset may carry any of
/// the other flags [`crate::startup`] allows (its `GROUPS`) and none of them is ever
/// blamed here. Adding a member needs a ruling, not a grep.
pub(crate) const STARTUP_WEDGE_FLAGS: [&str; 3] =
    ["--highvram", "--reserve-vram", "--disable-smart-memory"];
/// The additive fault key a free-leg exhaustion carries when a wedge flag is present
/// (design 10 §14.6): `"blockedOn": "startupPreset:<flag>"`. Skip-when-absent, the
/// same posture as the M9g row `outputs` key — an unattributed fault stays exactly
/// the two-key `{reason, detail}` shape it always was.
pub(crate) const BLOCKED_ON: &str = "blockedOn";
/// The cause family the [`BLOCKED_ON`] value names: a flag the stock backend was
/// launched with, i.e. the operator's startup preset, not a runtime condition.
pub(crate) const BLOCKED_ON_STARTUP_PRESET: &str = "startupPreset";

/// The startup-preset cause of a free-leg fault: the FIRST member of the closed
/// [`STARTUP_WEDGE_FLAGS`] set found in `args`, in scan order — the order the launch
/// args were assembled in, so the first offender is the first flag ComfyUI parses.
/// Matching is case-sensitive and exact: `--HighVRAM`, `--highvram=true` or
/// `extra--highvram` are not the flag this knowledge is about, and guessing would
/// blame an operator choice that was never made. `None` is an honest answer, not a
/// failure: no known culprit, so the fault keeps its plain shape.
///
/// Pure by law — no state, no I/O — so the closed set and the first-offender
/// ordering are pinned by test without a backend, a bat or an environment.
#[must_use]
pub(crate) fn startup_preset_cause(args: &[String]) -> Option<&'static str> {
    args.iter().find_map(|arg| {
        STARTUP_WEDGE_FLAGS
            .iter()
            .copied()
            .find(|flag| *flag == arg.as_str())
    })
}

/// One operator cycle bat, run verbatim and exit-waited (§7.1 `cmd /C`). Production
/// executes the operator's string; tests fake the exit and never touch a shell —
/// the bat strings are operator config and are never run in unit tests.
pub(crate) trait CommandRunner: Send + Sync {
    /// Run one command to completion, bounded by `timeout_ms`; the answer is the exit
    /// code. `Err` when the command could not be spawned at all OR when it outlived its
    /// budget and was killed (W1) — both are leg failures the caller's existing fault
    /// posture already knows how to record. The budget rides the call, not the seam, so
    /// the caller states which leg it is: [`UNLOAD_TIMEOUT_MS`] for an unload, for the
    /// restore leg [`RESTORE_TIMEOUT_MS`].
    fn run(&self, command: &str, timeout_ms: u64) -> BoxFuture<'static, Result<i32, String>>;
}

/// The terminal outcome of one drained row: the batch records it and continues.
#[derive(Clone, Debug)]
pub(crate) struct RowOutcome {
    /// True when the row reached the stock terminal word `succeeded`.
    pub(crate) succeeded: bool,
    /// The failure excerpt (stock error text or chain problem) for a failed row.
    pub(crate) detail: Option<String>,
    /// The closed taxonomy word classifying the failure when one applies (LEG M12):
    /// `prepareRefused` for a stock prepare/prereq/allowlist refusal reached after
    /// admission. `None` keeps the plain-string detail exactly as it shipped before
    /// — an unclassified failure is byte-identical to the pre-M12 wire.
    pub(crate) error_kind: Option<ErrorKind>,
    /// True when the row failed at SUBMIT/compile (no intent, prepare or submit
    /// refused, missing ids, no running backend) rather than after the backend
    /// started rendering. The §5/§10 poison-row guard counts only these; a row
    /// that reached the backend and failed there is ordinary batch semantics.
    pub(crate) submit_failed: bool,
    /// The stock job id the row became, when a stock job was ever minted (M9a): the
    /// same id the chain welded onto the spool row the instant submit yielded it.
    /// The terminal report carries it so every answered row names its correlation;
    /// `None` means no stock job existed (refused at prepare/submit, or a chain that
    /// never reached one).
    pub(crate) job_id: Option<String>,
    /// The stock output descriptors the row produced (M9g: the discovery half of §4.4
    /// results retrieval). The terminal snapshot's `outputs` list, passed through
    /// VERBATIM — the stock descriptor words ([`crate::jobs`] `Job::snapshot`, built by
    /// `jobs_outputs`: `filename`/`subfolder`/`type` plus optional `format`/`role`) and
    /// never a path this plane invented. `None` is the honest nothing-to-show posture:
    /// a failed row, a chain that never polled a snapshot, or a snapshot that carried
    /// no list. The terminal report skips the key instead of answering `[]` for silence.
    pub(crate) outputs: Option<Value>,
}

/// The submit trio plus the row driver, as one per-row verb (P6 law: terminal truth
/// comes from the stock row driver, never from a private read of the wire).
pub(crate) trait SubmitChain: Send + Sync {
    /// Prepare, submit and poll one intent to its terminal word. Chain-level
    /// failures arrive as `succeeded: false` with the excerpt — batch semantics
    /// never abort the drain on one row.
    ///
    /// `row_id` is the spool row being drained: the chain correlates the stock job id
    /// it mints to that row ([`Spool::set_job_id`]) the moment submit yields it, so the
    /// id survives a wedged render or a dropped socket (M9a).
    fn run_row(&self, row_id: &str, intent: Value) -> BoxFuture<'static, RowOutcome>;
}

/// The READ-ONLY H3 continuity session view (LEG AF2-M32 story chaining): the
/// same stock native read the `GET /v1/sessions/{id}` door drives
/// (`results::session_view` -> `jobs::native_h3_session`), boxed behind a seam
/// so the drain's resolution leg is testable with a scripted view and no
/// network. The law this seam must never grow: reads only (E20 — the plane
/// writes nothing), zero VRAM, no gate and no timer (the endpoint is up
/// mid-drain by construction; `endpoint_now` posture, E27 untouched), and it
/// starts nothing (E27) and submits nothing (E29 is a before-submit law).
pub(crate) trait SessionRead: Send + Sync {
    /// One session's normalized clip view verbatim (`{latestId, clips[]}`).
    fn session(&self, session: String) -> BoxFuture<'static, Result<Value, String>>;
}

/// Production session reader: the shipped `results::session_view` leg over the
/// managed engine's running endpoint. A plane without an app handle (the test
/// planes) answers the honest refusal — a story row draining there fails as an
/// ordinary row failure, never a silent placeholder submit.
pub(crate) struct StockSessionReader {
    app: Option<tauri::AppHandle>,
}

impl StockSessionReader {
    pub(crate) fn new(app: Option<tauri::AppHandle>) -> Self {
        Self { app }
    }
}

impl SessionRead for StockSessionReader {
    fn session(&self, session: String) -> BoxFuture<'static, Result<Value, String>> {
        let Some(app) = self.app.clone() else {
            return Box::pin(async move {
                Err("no app handle is wired; the continuity session read cannot run".to_owned())
            });
        };
        Box::pin(async move { super::results::session_view(&app, session).await })
    }
}

/// The scoped-cancel surface for an EXPIRED row (LEG AF2-M20 F2): the same two stock
/// workbench verbs the watchdog's arm drives (the `jobs_cancel.rs` natives
/// `native_workbench_cancel_pending` / `native_workbench_interrupt_running`), called
/// in-process against the same managed states. Not a public door — the deadline path
/// reaches only the stock job id already correlated to the row it is failing, the same
/// scoping law §8.3 carries for the arm (never a global interrupt, never a queue clear).
pub(crate) trait ScopedCancel: Send + Sync {
    /// Cancel the backend-queue pending copy of one job (the `{"delete"}` mutation).
    fn cancel_pending(&self, job_id: &str) -> BoxFuture<'static, Result<(), String>>;
    /// Scoped interruption of one running render (the stock token-gated path).
    fn interrupt_running(&self, job_id: &str) -> BoxFuture<'static, Result<(), String>>;
}

/// The class of a failed idle proof — W3-2 (LEG AF2-M21a), one home for the
/// classification. The end legs branch on CAUSE: the never-co-resident law (§7.1)
/// forbids restoring the model beside a live backend queue, while a backend that
/// is itself gone is the crash-recovery class where the restore bat is exactly how
/// the engine comes back. The door classifies at the source of the fact — a caller
/// never greps an error string to learn which world it is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProofFault {
    /// The backend itself is not answering: the managed Engine reports no running
    /// backend, or the connection failed at connect time (refused — the process is
    /// gone). Nothing is live on its queue.
    BackendDown,
    /// The backend is answering, but its queue cannot be proven idle: rows live, or
    /// the answer is one this plane cannot trust (refused, unparseable, missing
    /// lists, a timeout inside the read window). Untrusted is treated as live,
    /// fail closed: no restore bat spawns beside it.
    QueueLive,
}

impl ProofFault {
    /// The closed seam word the fault detail carries.
    #[must_use]
    pub(crate) fn word(self) -> &'static str {
        match self {
            Self::BackendDown => "backendDown",
            Self::QueueLive => "queueLive",
        }
    }
}

/// A failed idle proof: the class plus the honest detail from its source.
#[derive(Clone, Debug)]
pub(crate) struct IdleProofFault {
    pub(crate) class: ProofFault,
    pub(crate) detail: String,
}

impl IdleProofFault {
    pub(crate) fn new(class: ProofFault, detail: impl Into<String>) -> Self {
        Self {
            class,
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for IdleProofFault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.class.word(), self.detail)
    }
}

/// The owned backend's three cycle verbs: the idle proof, the output-file stability
/// read (AF2-M33) and the free wire. All three are facts about the SAME owned backend;
/// the stability read rides this seam rather than a new kit field because the door is
/// the one handle that already owns the engine (the output root law is engine-owned) and
/// both impls live in this module.
pub(crate) trait BackendDoor: Send + Sync {
    /// Prove both backend queue lists (`queue_running`, `queue_pending`) are empty.
    /// Foreign rows delay the drain's end honestly (§10) — this proof is the only
    /// completion fact. A failure carries its [`ProofFault`] class: the end legs
    /// must know whether the backend is down (restore may run) or its queue is
    /// live (restore must not).
    fn queue_idle_proof(&self) -> BoxFuture<'static, Result<(), IdleProofFault>>;
    /// POST `/free` with exactly the two-key body the machine supplies; `Ok(())`
    /// only on the stock ack shape (HTTP 200 with an empty body, resources.rs law).
    fn free(&self, body: Value) -> BoxFuture<'static, Result<(), String>>;
    /// One metadata read of one output descriptor (LEG AF2-M33): the stock
    /// `subfolder`/`filename` words the terminal row carried, read under the engine's
    /// OWN output root — the same root law the §4 byte doors walk
    /// ([`crate::media::star::output_root`]), never a guessed path. `Ok(Some(_))` is
    /// the size+mtime pair the stability law compares; `Ok(None)` is the honest
    /// not-on-disk answer; `Err` is an unreadable fact (no approved environment, a
    /// refused traversal, a metadata failure). `None` and `Err` are the SAME class to
    /// the walk: they ride the report's `stability` key and the legs proceed — a row's
    /// outputs descriptor is the backend's claim about a file, not filesystem
    /// authority, and neither shape may fail a row or wedge the card.
    fn output_stat(
        &self,
        subfolder: &str,
        filename: &str,
    ) -> BoxFuture<'static, Result<Option<OutputStat>, String>>;
}

/// Handle on the app-wide compute gate (production: [`crate::resources::reserve_compute`]).
pub(crate) trait ComputeGate: Send + Sync {
    /// Try to take the one compute permit; `Err` when another native stage holds it.
    fn reserve(&self) -> Result<tokio::sync::OwnedSemaphorePermit, String>;
}

/// The correlation read of the M9a drain law: which stock jobs are active RIGHT NOW
/// that this plane has never recorded on a spool row. The §4 result doors
/// (`GET /v1/jobs/{id}`, cancel, history, outputs) key on the stock job id, so an
/// unrecorded active job is a render this plane cannot wait for, cannot cancel by row
/// and cannot release the card under — the drain refuses it instead of unloading the
/// card out from under somebody else's work.
pub(crate) trait RowCorrelation: Send + Sync {
    /// The active stock job ids no spool row carries as its `jobId`. An empty answer
    /// is the drain's go-ahead; `Err` is an unreadable fact, which fails closed.
    fn uncorrelated_rows(&self) -> BoxFuture<'static, Result<Vec<String>, String>>;

    /// The RefMod exports this process currently holds that no spool row is
    /// correlated to (E28, LEG AF2-M24b). A live export became a real mid-drain
    /// hazard with the drainable-row ruling: the creation door can leave one
    /// running, and the export posts into the owned backend's own queue — the
    /// same queue the drain drives. A row's OWN export excuses itself exactly
    /// like a row's own stock job (its `jobId` IS the backend prompt id, the
    /// carve-out in [`run_refmod_row`]); an unreadable ledger fails closed.
    fn active_refmod_exports(&self) -> BoxFuture<'static, Result<Vec<String>, String>>;
}

/// One readiness probe against the operator's `readyUrl` (loopback wall enforced in
/// production; §7.4).
pub(crate) trait HealthProbe: Send + Sync {
    /// True when the readiness target answered HTTP 200.
    fn probe(&self, url: &str) -> BoxFuture<'static, bool>;
}

/// Sleep seam: production is the tokio timer; fakes record the durations the machine
/// asked for, so the timing consts are pinned by their call sites, not by wall clock.
pub(crate) trait Pacer: Send + Sync {
    /// Wait for `millis` before the machine proceeds.
    fn pause(&self, millis: u64) -> BoxFuture<'static, ()>;
}

/// The in-process home of the EFFECTIVE startup-preset args — the same argv tail
/// `backend.rs:817` hands the backend at launch, re-derived from the saved
/// `deas-startup.json` plus the approved plan rather than from a recorded argv (stock
/// snapshots its argv only for the child it is spawning, never durably, so the
/// honest degraded posture is the SAVED preset: if the operator edits the preset
/// while the backend runs, the attribution names what the environment is configured
/// with, not what the live child received).
///
/// Best-effort by contract: `None` whenever the args cannot be read (no approved
/// environment, unreadable settings file, a validation refusal). The fault path NEVER
/// fails because of this read and never retries it — an unreadable preset is the
/// no-cause fallback, exactly the shape a clean environment produces.
pub(crate) trait StartupPreset: Send + Sync {
    /// The effective launch args, or `None` when they are unreadable in-process.
    fn effective_args(&self) -> Option<Vec<String>>;
}

/// The seam kit one plane shares; the drive takes it by reference so every cycle
/// runs over the same handles the routes use.
pub(crate) struct CycleSeams {
    pub(crate) commands: Arc<dyn CommandRunner>,
    pub(crate) chain: Arc<dyn SubmitChain>,
    pub(crate) door: Arc<dyn BackendDoor>,
    /// The M9a correlation probe the generate door consults before it claims the fence.
    pub(crate) correlation: Arc<dyn RowCorrelation>,
    pub(crate) gate: Arc<dyn ComputeGate>,
    pub(crate) health: Arc<dyn HealthProbe>,
    pub(crate) pacer: Arc<dyn Pacer>,
    /// The startup-preset cause home the free fault consults (design 10 §14.6).
    pub(crate) startup: Arc<dyn StartupPreset>,
}

impl CycleSeams {
    /// Production kit: the stock commands, the owned backend, the global compute
    /// gate, the loopback readiness probe and the real timer. The spool handle rides
    /// in because two seams are spool-facing now: the submit chain correlates the row
    /// it submits, and the correlation probe reads every id the spool already records.
    pub(crate) fn stock(app: tauri::AppHandle, spool: Arc<Spool>) -> Self {
        Self {
            commands: Arc::new(StockCommandRunner),
            chain: Arc::new(StockSubmitChain {
                app: app.clone(),
                spool: Arc::clone(&spool),
                refmods: Arc::new(super::results::StockRefmodBridge::new(app.clone())),
            }),
            door: Arc::new(StockBackendDoor { app: app.clone() }),
            correlation: Arc::new(StockRowCorrelation {
                app: app.clone(),
                spool,
            }),
            gate: Arc::new(StockComputeGate),
            health: Arc::new(StockHealthProbe),
            pacer: Arc::new(TokioPacer),
            startup: Arc::new(StockStartupPreset { app }),
        }
    }
}

#[cfg(test)]
impl CycleSeams {
    /// The benign kit for plane-level (transport) tests: everything accepts, nothing
    /// sleeps. A transport test that needs fault postures builds its own kit from the
    /// `fakes` parts directly.
    pub(crate) fn defaults_for_tests() -> Self {
        Self {
            commands: Arc::new(fakes::ScriptCommands::clean()),
            chain: Arc::new(fakes::ScriptChain::all_done()),
            door: Arc::new(fakes::ScriptDoor::accepting()),
            correlation: Arc::new(fakes::ScriptCorrelation::clean()),
            gate: Arc::new(fakes::ScriptGate::open()),
            health: Arc::new(fakes::ScriptHealth::always_healthy()),
            pacer: Arc::new(fakes::ScriptPacer::recording()),
            startup: Arc::new(fakes::FixedStartupPreset::unreadable()),
        }
    }
}

/* ------------------------------ the cycle cell ------------------------------ */

#[derive(Debug)]
struct CellState {
    phase: CyclePhase,
    cycle_id: Option<String>,
    terminal: Option<Value>,
    /// The watchdog sever that latched onto this in-flight cycle (M5, §8.2). The
    /// drain reads it at its finish path: the arm already ran cancel/clear/free/
    /// restore, so the drain records the sever as the cycle's fault instead of
    /// re-running legs that would re-load the engine the arm just restored.
    sever: Option<Value>,
}

/// The fence plus the persisted answer. One instance per plane, shared through
/// [`super::PlaneState`]; every mutation runs under one process-level mutex with the
/// spool's poisoning-recovery idiom (short synchronous sections, never across await).
#[derive(Debug)]
pub(crate) struct CycleCell {
    app_data: PathBuf,
    /// W3-1 (LEG AF2-M21b) boot epoch: one identity per process boot of the plane,
    /// minted here and written INTO every persisted cell record. A report this file
    /// carries from a DIFFERENT epoch cannot prove the current card posture.
    boot_epoch: String,
    state: Mutex<CellState>,
}

/// The W3-3 law (LEG AF2-M21b): a persisted terminal report written by a PREVIOUS
/// boot (or by a pre-M21b build that stamped no epoch at all — an absent epoch can
/// never match a fresh one, so it is a previous boot by the same law) may not carry
/// a `ready` promise. A crash between the free ack and the proven restore leaves
/// the previous cycle's `modelRestored:true` on disk while the card is down, and
/// `GET /v1/resume` would then answer Ready on a down card. The downgrade lands
/// HERE, at the cell's boot, so every reader of the terminal report — resume, the
/// cycle view, any later busy posture — sees one truth: the restore is owed. The
/// honesty note rides the report verbatim.
///
/// Design choice — ADDITIVE FIELD, no `CELL_VERSION` bump. A version bump makes the
/// load law ignore the whole record, so every pre-M21b report would posture
/// `notWatched`: an owed restore (`modelRestored:false`) or an exhaustion
/// (`restoreExhausted`) is REAL information a bump would silently drop. The
/// additive epoch keeps every honest posture and downgrades only the one claim a
/// foreign boot cannot prove. A version mismatch (the bump path) stays the honest
/// ignore it always was — that is the law this choice deliberately did NOT widen.
fn downgrade_foreign_boot_report(report: &mut Value) {
    if report.get("modelRestored").and_then(Value::as_bool) != Some(true) {
        return;
    }
    report["modelRestored"] = json!(false);
    report["bootEpochNote"] = json!(
        "report is from a previous boot; a crash between free and restore cannot be ruled out"
    );
}

impl CycleCell {
    /// Points a cell at app-data and loads a persisted terminal report if one is
    /// there. A corrupt cell file is surfaced to the log, never hand-repaired: the
    /// next terminal cycle write replaces the bytes with new truth (the file is the
    /// cycle's own record, unlike the operator-owned spool).
    pub(crate) fn new(app_data: &Path) -> Self {
        let boot_epoch = uuid::Uuid::new_v4().to_string();
        let mut terminal = None;
        let mut cycle_id = None;
        let path = app_data.join(FILE);
        match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(record)
                    if record["version"].as_u64() == Some(u64::from(CELL_VERSION))
                        && record["report"].is_object() =>
                {
                    let mut report = record["report"].clone();
                    if record["bootEpoch"].as_str() != Some(boot_epoch.as_str()) {
                        downgrade_foreign_boot_report(&mut report);
                    }
                    terminal = Some(report);
                    cycle_id = record["cycleId"].as_str().map(str::to_owned);
                }
                Ok(_) => logs::push(
                    Source::Deas,
                    &format!(
                        "agent-api: cycle cell {} has an unsupported version; ignoring it",
                        path.display()
                    ),
                ),
                Err(problem) => logs::push(
                    Source::Deas,
                    &format!(
                        "agent-api: cycle cell {} unreadable: {problem}",
                        path.display()
                    ),
                ),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => logs::push(
                Source::Deas,
                &format!(
                    "agent-api: cycle cell {} unreadable: {error}",
                    path.display()
                ),
            ),
        }
        Self {
            app_data: app_data.to_path_buf(),
            boot_epoch,
            state: Mutex::new(CellState {
                phase: CyclePhase::Idle,
                cycle_id,
                terminal,
                sever: None,
            }),
        }
    }

    /// The fence CAS: claim the cycle if idle, mint the id and set the first live
    /// phase. A second claim while a cycle runs is the 409 `cycleInFlight` refusal,
    /// carrying the `retryAfterMs` poll cadence ([`CYCLE_RETRY_AFTER_MS`], §10).
    ///
    /// The claim also takes the stock-facing mirror in [`crate::resources`] (§14.6/E14)
    /// so stock admission, submission and maintenance gates see the same fact. No stock
    /// path ever claims that mirror - only this plane's own claim does (plus the
    /// watchdog's borrowed hold) - so a lost CAS here means the fence is already held by
    /// an in-flight cycle of THIS plane. The cell rolls back to idle and the caller gets
    /// the identical `cycleInFlight` answer; this rollback branch is a plane-internal
    /// walk-back, never a collision with a stock stage.
    ///
    /// # Errors
    ///
    /// [`ErrorKind::CycleInFlight`] when the fence is held.
    pub(crate) fn claim(&self, first_phase: CyclePhase) -> Result<String, ApiError> {
        debug_assert!(
            first_phase != CyclePhase::Idle,
            "a claim never parks at idle"
        );
        let mut state = self.lock();
        if state.phase != CyclePhase::Idle {
            return Err(ApiError::new(ErrorKind::CycleInFlight)
                .with_retry_after_ms(CYCLE_RETRY_AFTER_MS)
                .with_hint(format!(
                    "a cycle (id {}) is already in flight at phase '{}'; poll GET /v1/cycle — re-POSTing never starts a second one",
                    state.cycle_id.clone().unwrap_or_default(),
                    phase_word(state.phase),
                )));
        }
        if !crate::resources::fence_claim() {
            // A stock stage is mid-admission behind the fence: put the cell back exactly
            // as it was, terminal cycle identity included, and answer the same 409 word.
            return Err(ApiError::new(ErrorKind::CycleInFlight)
                .with_retry_after_ms(CYCLE_RETRY_AFTER_MS)
                .with_hint(
                    "a stock admission holds the card fence; poll GET /v1/cycle and retry the batch"
                        .to_owned(),
                ));
        }
        let cycle_id = uuid::Uuid::new_v4().to_string();
        state.phase = first_phase;
        state.cycle_id = Some(cycle_id.clone());
        state.sever = None;
        Ok(cycle_id)
    }

    /// Records the watchdog sever for the in-flight cycle (§8.2). Only a cell that
    /// already owns the fence can carry one — the arm's borrowed hold — so a note on
    /// an idle cell is dropped rather than parked for a later cycle to trip over.
    pub(crate) fn note_sever(&self, answer: Value) {
        let mut state = self.lock();
        if state.phase != CyclePhase::Idle {
            state.sever = Some(answer);
        }
    }

    /// The sever latched onto the current cycle, if any (the drain's finish path).
    pub(crate) fn sever(&self) -> Option<Value> {
        self.lock().sever.clone()
    }

    /// Whether a sever has latched, without cloning its payload: the cheap probe the
    /// drain runs before every row submit (C1). One mutex read and one discriminant
    /// test, so the per-row cost of closing the sever/drain race is noise.
    #[must_use]
    pub(crate) fn sever_latched(&self) -> bool {
        self.lock().sever.is_some()
    }

    /// Advance the live phase mid-cycle.
    pub(crate) fn set_phase(&self, phase: CyclePhase) {
        let mut state = self.lock();
        if state.phase != CyclePhase::Idle {
            state.phase = phase;
        }
    }

    /// The live posture for `/v1/cycle` and `/v1/status`.
    pub(crate) fn live(&self) -> LiveCycle {
        let state = self.lock();
        LiveCycle {
            phase: state.phase,
            cycle_id: state.cycle_id.clone(),
            report: state.terminal.clone(),
        }
    }

    /// Close the cycle: persist the terminal report durably (staging + rename, the
    /// spool's atomic idiom), then release the fence. The report is returned so the
    /// held caller gets the same object the file carries (the dropped-socket law:
    /// the caller and the file can never disagree).
    pub(crate) fn finish(&self, report: Value) -> Value {
        let cycle_id = report["cycleId"].as_str().unwrap_or_default().to_owned();
        let completed_at = now_ms();
        // §14.6/E14: the stock-facing mirror goes down with the cell's own fence, before
        // the durability write, so stock admission resumes as soon as the card posture is
        // terminal rather than waiting on a file rename.
        crate::resources::fence_release();
        {
            let mut state = self.lock();
            state.phase = CyclePhase::Idle;
            state.sever = None;
            // The terminal cycle's id rides the report: after the finish, the view
            // names the cycle that answered (a caller that never claims, only
            // reads, still sees WHICH cycle finished).
            if let Some(id) = report["cycleId"].as_str() {
                state.cycle_id = Some(id.to_owned());
            }
            state.terminal = Some(report.clone());
        }
        let path = self.app_data.join(FILE);
        let staging = path.with_file_name(format!("{FILE}.{}.tmp", std::process::id()));
        let record = json!({
            "version": CELL_VERSION,
            "cycleId": cycle_id,
            "completedAt": completed_at,
            "bootEpoch": self.boot_epoch,
            "report": report,
        });
        let write = serde_json::to_vec_pretty(&record)
            .map_err(|problem| format!("serialize {FILE}: {problem}"))
            .and_then(|bytes| {
                std::fs::write(&staging, bytes)
                    .map_err(|problem| format!("write {}: {problem}", staging.display()))
                    .and_then(|()| {
                        std::fs::rename(&staging, &path)
                            .map_err(|problem| format!("rename onto {}: {problem}", path.display()))
                    })
            });
        if let Err(problem) = write {
            // The cycle still closes: the memory posture is right and the log names
            // the durability failure; the next terminal write replaces the file.
            let _ = std::fs::remove_file(&staging);
            logs::push(
                Source::Deas,
                &format!("agent-api: cycle terminal report could not persist: {problem}"),
            );
        }
        report
    }

    /// Wrap a claimed cycle's drive leg in a [`DriveGuard`]. The guard is the drive's
    /// own abort path: if any seam panics and the leg unwinds before `finish` runs, the
    /// guard closes the cell so the stock-facing fence is never stranded and `/v1/cycle`
    /// shows a failed terminal cycle instead of a phase no driver will ever advance.
    pub(crate) fn begin(self: &Arc<CycleCell>) -> DriveGuard {
        DriveGuard {
            cell: Arc::clone(self),
            done: false,
        }
    }

    fn lock(&self) -> MutexGuard<'_, CellState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Drop for CycleCell {
    /// `finish` is the release. This is the backstop: a cell that dies mid-cycle (a
    /// panicked leg, an abandoned run in tests) must not strand the stock-facing fence,
    /// because a fence with no owner parks every stock gate forever. Only a cell that
    /// still believes it is mid-cycle may lower the mirror.
    fn drop(&mut self) {
        if self.lock().phase != CyclePhase::Idle {
            crate::resources::fence_release();
        }
    }
}

/// RAII finalizer for one drive leg (§3 PHASE 2), created by [`CycleCell::begin`]. The
/// normal path consumes it through [`DriveGuard::finish`]. If the leg instead unwinds -
/// a panicking seam, which tokio catches as a `JoinError` and unwinds (the dev profile
/// keeps `panic = unwind`; no profile in this crate sets `panic = "abort"`) - `Drop` sees
/// `done == false` and finalizes: a minimal free-fault terminal report (`maintenanceActive`
/// / "drive leg unwound"), the fence lowered, the cell parked at idle. A crashed driver
/// can never strand the card nor leave a cycle in flight that will never answer.
#[derive(Debug)]
pub(crate) struct DriveGuard {
    cell: Arc<CycleCell>,
    done: bool,
}

impl DriveGuard {
    /// Normal completion: mark the leg finished, then close the cell with its real report.
    /// Marking first means a panic inside `finish` itself (the durability write) cannot
    /// trigger a second, faulted finalize - the fence and idle parking already ran.
    fn finish(mut self, report: Value) -> Value {
        self.done = true;
        self.cell.finish(report)
    }
}

impl Drop for DriveGuard {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        // The leg unwound before it could answer. Close honestly with a minimal free-fault
        // report so the resume posture reads a failed cycle; `finish` lowers the fence and
        // parks the cell at idle in one step. The row list cannot be reconstructed from an
        // unwound leg, so it is empty - the fault word, not the rows, carries the truth.
        let cycle_id = self.cell.lock().cycle_id.clone().unwrap_or_default();
        let report = json!({
            "ok": false,
            "cycleId": cycle_id,
            "completedAt": now_ms(),
            "freed": false,
            "modelRestored": false,
            "rows": [],
            "fault": { "reason": FAULT_CYCLE, "detail": "drive leg unwound" },
        });
        self.cell.finish(report);
    }
}

/// The wire word for a phase; mirrors the serde vocabulary of [`CyclePhase`] without
/// serializing a whole value. Also read by the native settings bridge, whose stock-
/// shaped refusals name the live phase without the HTTP taxonomy.
pub(crate) fn phase_word(phase: CyclePhase) -> &'static str {
    match phase {
        CyclePhase::Idle => "idle",
        CyclePhase::Unloading => "unloading",
        CyclePhase::Draining => "draining",
        CyclePhase::Freeing => "freeing",
        CyclePhase::Restoring => "restoring",
        CyclePhase::Severing => "severing",
    }
}

/* ------------------------------ the machine ------------------------------ */

/// Everything one drive needs; built once at the route after the claim succeeds.
pub(crate) struct CycleRun {
    pub(crate) cell: Arc<CycleCell>,
    pub(crate) seams: Arc<CycleSeams>,
    pub(crate) spool: Arc<Spool>,
    pub(crate) guard: GuardConfig,
    pub(crate) cycle_id: String,
    /// The AF2-M32 story-chaining read: the READ-ONLY continuity session view
    /// the drain's resolution leg consults for story rows. Ordinary rows never
    /// touch it; no cycle law (watchdog, end-legs, cause-aware end,
    /// dropped-socket, E27/E28/E29) reads or is read by it.
    pub(crate) sessions: Arc<dyn SessionRead>,
}

/// One batch row's recorded result for the report.
struct RowResult {
    id: String,
    status: RowStatus,
    detail: Option<String>,
    /// The report-side carrier of [`RowOutcome::error_kind`] (LEG M12).
    error_kind: Option<ErrorKind>,
    /// The stock job id the row became, when a stock job ever existed (M9a).
    job_id: Option<String>,
    /// The stock output descriptors the row produced, when it produced any (M9g).
    outputs: Option<Value>,
}

/// The correlation law's arithmetic, kept pure so it is pinned by test without a
/// managed `Jobs` state: an active stock id is excused exactly when some spool row
/// records it as its `jobId` — a row whose `jobId` is `None` excuses nothing, and a
/// terminal row's recorded id excuses just as well as a draining one (the point of the
/// chain: the row an earlier cycle submitted is still a job this plane owns the answer
/// to). Foreign ids come back in stock order, deduplicated, so the hint names what the
/// operator can act on.
pub(crate) fn uncorrelated_ids(
    active: impl IntoIterator<Item = String>,
    recorded: impl IntoIterator<Item = String>,
) -> Vec<String> {
    let recorded: HashSet<String> = recorded.into_iter().collect();
    let mut answered: HashSet<String> = HashSet::new();
    active
        .into_iter()
        .filter(|id| !recorded.contains(id))
        .filter(|id| answered.insert(id.clone()))
        .collect()
}

/// The jobUnknown DRAIN LAW (M9a): no batch starts while the stock session holds an
/// active job no spool row is correlated to. The generate door calls this BEFORE
/// [`CycleCell::claim`] — the position that cannot leave a half-run cycle: a refusal
/// there has claimed nothing, parked nothing and lowered no fence, and every queued row
/// stays honestly queued. A refusal after the claim would owe the fence a walk back
/// down, a second release path for no added safety.
///
/// # Errors
///
/// [`ErrorKind::JobUnknown`] naming the foreign ids and the remedy, or
/// [`ErrorKind::MaintenanceActive`] when the correlation fact is unreadable: an
/// unreadable fact is never read as "clean".
pub(crate) async fn refuse_uncorrelated(seams: &CycleSeams) -> Result<(), ApiError> {
    match seams.correlation.uncorrelated_rows().await {
        Ok(ids) if ids.is_empty() => {}
        Ok(ids) => {
            return Err(ApiError::new(ErrorKind::JobUnknown).with_hint(format!(
                "{} active stock job(s) are not correlated to any agent row: {}; the drain stays blocked while they run. nextMove: POST /v1/jobs/{{id}}/cancel for one named id, or POST /v1/stop — a row this plane submitted already excuses its own id",
                ids.len(),
                ids.join(", ")
            )))
        }
        Err(problem) => {
            return Err(ApiError::new(ErrorKind::MaintenanceActive).with_hint(format!(
                "stock job correlation could not be read, so the drain cannot prove the card is unheld: {problem}"
            )))
        }
    }
    // E28 (LEG AF2-M24b): the law widened by the drainable-row ruling. A live
    // RefMod export — the creation door can leave one, and the drain's own
    // export rows are excused by their recorded prompt id (the correlation
    // carve-out) — is held work on the owned backend's queue exactly like an
    // uncorrelated render, so it blocks a drain start with the SAME error-shape
    // family: `jobUnknown` naming the ids and the remedy, `maintenanceActive`
    // when the fact is unreadable (an unreadable fact is never read as clean).
    match seams.correlation.active_refmod_exports().await {
        Ok(ids) if ids.is_empty() => Ok(()),
        Ok(ids) => Err(ApiError::new(ErrorKind::JobUnknown).with_hint(format!(
            "{} live RefMod export(s) submitted by this process are not correlated to any agent row: {}; the drain stays blocked while they hold the backend queue. nextMove: POST /v1/refmods/{{id}}/cancel for one named id — a row this plane submitted already excuses its own export",
            ids.len(),
            ids.join(", ")
        ))),
        Err(problem) => Err(ApiError::new(ErrorKind::MaintenanceActive).with_hint(format!(
            "RefMod export ownership could not be read, so the drain cannot prove the card is unheld: {problem}"
        ))),
    }
}

/// Drive one claimed cycle to its terminal report (§3 PHASE 2, §7.1). The caller
/// owns the claim; this function owns every leg and always finishes the cell — the
/// report is the answer the held caller and the persisted cell share.
pub(crate) async fn drive(run: CycleRun) -> Value {
    let guard = run.cell.begin();
    let report = drive_inner(&run).await;
    guard.finish(report)
}

struct BatchResult {
    rows: Vec<RowResult>,
    model_restored: bool,
    freed: bool,
    /// W3-9 (LEG AF2-M21a): the model went off the card and no restore ran to
    /// bring it back — skipped by cause (a live backend queue, W3-2), skipped by
    /// exhaustion (§8.4), or skipped because the free happened with no restore
    /// word behind it. The honest posture derives from DID-RESTORE, never from
    /// config. Skip-when-absent on the report; `true` is the only time it rides.
    card_at_risk: bool,
    /// W4-A (LEG AF2-M22): the NEVER-co-resident law gates restore on more than the
    /// drain's own idle proof — when the free-fault settle ([`free_fault_settle`])
    /// never proves the queue idle, the free leg records this flag and the drive's
    /// restore gate skips the bat. The end legs' local mirror lives at the gate;
    /// this field is how the free leg's verdict crosses into it.
    restore_forbidden: bool,
    fault: Option<(&'static str, String)>,
    /// The cause the fault is blocked on, when a known culprit is present (design 10
    /// §14.6). `None` renders no key: the fault keeps its two-key shape.
    blocked_on: Option<String>,
    /// The honest problems the AF2-M33 file-stability walk rode (a descriptor naming a
    /// file that is not on disk, or one that never stopped changing inside the bound).
    /// Skip-when-absent on the report — an empty list renders no `stability` key at all,
    /// so a clean cycle's report is byte-identical to the pre-M33 shape. The walk never
    /// faults the cycle: these entries are disclosures, not failures.
    stability_problems: Vec<String>,
}

impl BatchResult {
    fn fault(&mut self, reason: &'static str, detail: impl Into<String>) {
        // First fault wins: it is the cause; the rest is the machine cleaning up.
        if self.fault.is_none() {
            self.fault = Some((reason, detail.into()));
        }
    }
}

async fn drive_inner(run: &CycleRun) -> Value {
    let guard = &run.guard;
    // The batch snapshot: Queued rows only, taken at start. Rows arriving after this
    // point wait for the next batch (§3: "stop adding new rows once drain started" —
    // they stay Queued and the next claim's snapshot picks them up).
    let queued: Vec<QueueRow> = match run.spool.snapshot() {
        Ok(rows) => rows
            .into_iter()
            .filter(|row| row.status == RowStatus::Queued)
            .collect(),
        Err(problem) => {
            return fault_report(
                &run.cycle_id,
                guard,
                Vec::new(),
                FAULT_CYCLE,
                format!("spool unreadable; the drain could not start: {problem}"),
            );
        }
    };
    if queued.is_empty() {
        // Empty batch = no cycle at all: no bat, no free, no restore (§brief 2).
        return report(
            &run.cycle_id,
            guard,
            &[],
            BatchResult {
                rows: Vec::new(),
                model_restored: true,
                freed: false,
                card_at_risk: false,
                restore_forbidden: false,
                fault: None,
                blocked_on: None,
                stability_problems: Vec::new(),
            },
        );
    }

    let mut result = BatchResult {
        rows: Vec::new(),
        // Nothing has gone down yet: the honest posture is restored-until-proven-
        // otherwise. The end legs flip it to false at exhaustion, at a cause-
        // skipped restore (W3-2), or when a free took the model down with no
        // restore leg behind it (W3-9) — the posture derives from DID-RESTORE.
        model_restored: true,
        freed: false,
        card_at_risk: false,
        restore_forbidden: false,
        fault: None,
        blocked_on: None,
        stability_problems: Vec::new(),
    };

    // Compute gate: held across the cycle's legs, released for the drain (the stock
    // submit chain takes the same global gate inside submit_inner; a cycle held
    // across submit would busy-refuse every row). See the module doc.
    let mut permit = match run.seams.gate.reserve() {
        Ok(permit) => Some(permit),
        Err(problem) => {
            result.fault(
                FAULT_CYCLE,
                format!("compute gate busy; the drain could not start: {problem}"),
            );
            return report(&run.cycle_id, guard, &queued, result);
        }
    };

    if guard.auto_cycle_vram {
        // Unload leg (claim already set phase `unloading`). W1 bounds the bat: a hung
        // unload must fail the leg, not park the cycle in `unloading` forever.
        match run
            .seams
            .commands
            .run(&guard.unload_command, UNLOAD_TIMEOUT_MS)
            .await
        {
            Ok(0) => {}
            Ok(code) => {
                // §10 `unload bat non-zero exit`: the handoff failed, nothing else ran.
                result.fault(
                    FAULT_HANDOFF,
                    format!("unload command exited {code}; aborted before any GPU work; the spool is intact — every row is still queued"),
                );
                // Nothing went down, so nothing must be restored (§brief 2).
                return report(&run.cycle_id, guard, &queued, result);
            }
            Err(problem) => {
                result.fault(
                    FAULT_CYCLE,
                    format!("unload command could not run: {problem}; the spool is intact — every row is still queued"),
                );
                return report(&run.cycle_id, guard, &queued, result);
            }
        }
    }

    // Drain: release the gate first — the stock submit chain owns it per submit.
    drop(permit.take());
    run.cell.set_phase(CyclePhase::Draining);
    drain_rows(run, &queued, &mut result).await;

    // Drain complete = every dispatched row terminal AND backend idle-proved (§7.1).
    // A watchdog sever that latched onto this cycle (§8.2) already ran the arm's own
    // cancel/clear/free/restore sequence in its law order; re-running these legs here
    // would re-load the engine the arm just restored (§8.4 rationale: never spam-load
    // a live engine), so the drain records the sever as the cycle's fault and answers.
    //
    // C1: one check could not cover the race — the arm's legs take seconds, so a latch
    // can land while the drain is still submitting rows. `drain_rows` probes the latch
    // before every submit and stops there; this is the gate in front of the drain's own
    // handoff legs, and the one after the idle proof below closes the last await window
    // before `free`. With a latch set, the drain runs NO legs of its own.
    if let Some(sever) = run.cell.sever() {
        record_sever(&mut result, &sever);
        return report(&run.cycle_id, guard, &queued, result);
    }
    // LEG AF2-M33 (the file-stability end leg): every row is terminal, yet the
    // backend's post-graph writer threads may still be finishing an output file the
    // snapshot already reported. The walk DELAYS entry into the end legs; it decides
    // nothing about them. It sits BEFORE the idle proof on purpose: the proof's own
    // await window stays the last one before `free`, so the C1 latch law ("the probe
    // after the idle proof closes the last await window before free") is untouched —
    // the walk adds no new window behind that final probe. It takes no compute permit
    // (a metadata read is not compute), never faults the cycle, and is skipped whole
    // when no row produced outputs.
    stability_leg(run, &mut result).await;
    let idle_proof = run.seams.door.queue_idle_proof().await;
    // W3-2 (LEG AF2-M21a): cause-aware end legs, the NEVER-co-resident law.
    // A `queueLive` proof failure means the backend is still answering with
    // work on it (a foreign pending job, a cancel-refused survivor, a lost
    // response whose job stays unknown): restoring the model beside that queue
    // is exactly the co-residency the whole handoff exists to prevent, so the
    // end legs run NEITHER free NOR restore. The answer carries
    // `modelRestored:false` and the persisted report keeps the debt visible —
    // `GET /v1/resume` derives `debtOutstanding` from it (resume.rs, pinned).
    // A `backendDown` proof failure is the crash-recovery class: the backend
    // itself is gone, nothing lives on its queue, and the restore bat is how
    // the engine comes back — that path keeps running restore.
    let mut restore_forbidden = false;
    if let Err(fault) = &idle_proof {
        match fault.class {
            ProofFault::QueueLive => {
                restore_forbidden = true;
                if guard.auto_cycle_vram {
                    // The cycle's own unload took the model down; it will not be
                    // brought back beside a live queue. The debt stays visible.
                    result.model_restored = false;
                    result.card_at_risk = true;
                }
                result.fault(
                    FAULT_CYCLE,
                    format!(
                        "backend idle proof failed after the drain while the backend was still answering ({fault}); free and restore both skipped - the plane will not reload the model next to a live backend queue",
                    ),
                );
            }
            ProofFault::BackendDown => {
                result.fault(
                    FAULT_CYCLE,
                    format!(
                        "backend idle proof failed after the drain: the backend itself is not answering ({fault}); free skipped, restore still runs to bring the engine back",
                    ),
                );
            }
        }
    }
    // The proof call is an await window: an arm that latched inside it has already run
    // its own free/restore legs, so the drain must still answer with the arm's facts
    // instead of starting a second handoff (C1).
    if let Some(sever) = run.cell.sever() {
        record_sever(&mut result, &sever);
        return report(&run.cycle_id, guard, &queued, result);
    }

    let want_free = guard.free_on_queue_end && idle_proof.is_ok();
    if want_free {
        // Reacquire the gate for the free/restore legs (release/reacquire around the
        // stock submit is the measured deviation documented at the module head).
        permit = match run.seams.gate.reserve() {
            Ok(permit) => Some(permit),
            Err(problem) => {
                result.fault(
                    FAULT_CYCLE,
                    format!("compute gate busy at the free leg: {problem}; free skipped, restore still runs"),
                );
                None
            }
        };
        if permit.is_some() {
            free_leg(run, &mut result).await;
        }
    }

    // W3-9 (LEG AF2-M21a): the posture derives from DID-RESTORE, not from
    // config. A free took the models off the card; with no restore word behind
    // it, none will bring them back — the honest answer is restored:false with
    // the card flagged, never the config-derived `true` this used to echo.
    if result.freed && !guard.auto_cycle_vram {
        result.model_restored = false;
        result.card_at_risk = true;
    }

    // W4-A (LEG AF2-M22): the free leg's settle verdict gates the bat too. A free
    // that exhausted its attempts may still have LANDED, and the settle's re-probes
    // may all come back unproven (a foreign job landed after the drain's proof):
    // that is the same live-queue posture as the QueueLive law above, so the last
    // co-residency window closes here — no restore bat beside an unproven queue.
    let restore_forbidden = restore_forbidden || result.restore_forbidden;
    if guard.auto_cycle_vram && !restore_forbidden {
        // W3-6 (LEG AF2-M21a): the last latch probe of the end legs. The arm can
        // latch during the drain's own free/settle awaits; from here the restore
        // bat is the double-load the provisional latch exists to close, so the
        // drain hands the legs over BEFORE any bat can spawn.
        if let Some(sever) = run.cell.sever() {
            record_sever(&mut result, &sever);
            return report(&run.cycle_id, guard, &queued, result);
        }
        run.cell.set_phase(CyclePhase::Restoring);
        match restore_leg(&run.seams, guard, Some(&run.cell)).await {
            RestoreOutcome::Restored => {}
            RestoreOutcome::Exhausted => {
                result.model_restored = false;
                result.card_at_risk = true;
                result.fault(
                    FAULT_RESTORE,
                    format!(
                        "restore attempts exhausted ({RESTORE_ATTEMPT_BOUND} attempts, {RESTORE_GAP_MS} ms apart); the readiness target never answered 200"
                    ),
                );
            }
            RestoreOutcome::ArmOwns => {
                // The latch landed between the probe and a restore attempt: the
                // arm owns the bat; its facts ride the report, never a second one.
                if let Some(sever) = run.cell.sever() {
                    record_sever(&mut result, &sever);
                } else {
                    result.model_restored = false;
                }
                return report(&run.cycle_id, guard, &queued, result);
            }
        }
    }

    report(&run.cycle_id, guard, &queued, result)
}

/// The posture a latched watchdog sever forces on the cycle: the arm already ran
/// `cancel → confirm → clear → free → RESTORE` in its law order (§8.2), so the drain
/// records the sever as the cycle's own fault and runs no legs of its own — a second
/// free/restore pair would re-load the engine the arm just restored (§8.4). One home
/// for the posture because the latch is legitimately seen at three points: mid-drain
/// (the drain stops), after the drain loop, and after the idle proof.
///
/// A PROVISIONAL latch (LEG AF2-M20 F1 — the arm published it at its start, its legs
/// still ahead of it) reads honestly: nothing is claimed freed or restored, because
/// the arm has not answered yet. The posture still runs NO drain legs of its own —
/// the arm owns the free/restore work, and a drain leg stacked onto the arm's is the
/// exact two-bats double-load the provisional latch exists to close.
fn record_sever(result: &mut BatchResult, sever: &Value) {
    if sever["provisional"].as_bool().unwrap_or(false) {
        result.freed = false;
        result.model_restored = false;
        result.fault(
            super::watchdog::FAULT_SEVER,
            format!(
                "the watchdog sever arm was running when this drain stopped (row {}); the arm owns the free and restore legs",
                sever["severedRow"].as_str().unwrap_or("(unattributed)"),
            ),
        );
        return;
    }
    result.freed = sever["freed"].as_bool().unwrap_or(false);
    // W3-9 (LEG AF2-M21a): fail closed. A latch payload that carries no
    // `restored` word proved nothing about a restore — claiming `true` there was
    // the config-shaped lie this fix removes; the posture derives from DID-RESTORE.
    result.model_restored = sever["restored"].as_bool().unwrap_or(false);
    result.fault(
        super::watchdog::FAULT_SEVER,
        format!(
            "the watchdog severed row {}; freed {}, restored {}",
            sever["severedRow"].as_str().unwrap_or("(unattributed)"),
            result.freed,
            result.model_restored
        ),
    );
}

// ── AF2-M32 story chaining: the resolution legs ───────────────────────────

/// The per-story clip ledger of one drain (AF2-M32): the chain of clip ids the
/// stock session view says this story minted, in step order. `prepared` is the
/// 64-hex the story opened from (carried on every row's `StoryLink`, so a
/// later cycle rebuilds the ledger from the session alone).
#[derive(Clone, Debug)]
struct StoryLedger {
    prepared: String,
    clips: Vec<String>,
}

/// The clip-identification law, C0 arm (cited per the mission ruling): step 0's
/// continuation clip is the clip whose PARENT is the session's import clip
/// carrying `importedVideo.sourceId == prepared`. A session can hold several
/// import clips (the same video prepared twice, or different videos); the
/// prepared id picks this story's own. If several continuation clips share that
/// parent (a re-run branches the chain), pick the one with an `export`, newest
/// `completed` stamp among those; if none carries an export, the newest
/// `completed` stands.
fn imported_child_clip(view: &Value, prepared: &str) -> Option<String> {
    let clips = view["clips"].as_array()?;
    let parents: Vec<&str> = clips
        .iter()
        .filter(|clip| clip["importedVideo"]["sourceId"].as_str() == Some(prepared))
        .filter_map(|clip| clip["clipId"].as_str())
        .collect();
    pick_child(clips, &parents)
}

/// The clip-identification law, chain arm: step k's continuation clip is the
/// clip whose `parent` equals the previous step's clip id (linear scan — a
/// session is bounded at 200 clips by the stock read itself). Same ambiguity
/// rule as `imported_child_clip`.
fn chain_child_clip(view: &Value, parent: &str) -> Option<String> {
    let clips = view["clips"].as_array()?;
    pick_child(clips, &[parent])
}

fn pick_child(clips: &[Value], parents: &[&str]) -> Option<String> {
    let mut candidates: Vec<(&Value, &str)> = clips
        .iter()
        .filter(|clip| {
            clip["parent"]
                .as_str()
                .is_some_and(|p| parents.contains(&p))
        })
        .filter_map(|clip| clip["clipId"].as_str().map(|id| (clip, id)))
        .collect();
    match candidates.len() {
        0 => None,
        1 => candidates[0].1.to_owned().into(),
        _ => {
            // Ambiguous: prefer exported clips, then the newest `completed`.
            candidates.sort_by_key(|(clip, _)| {
                (
                    clip["export"].is_object(),
                    clip["completed"].as_u64().unwrap_or(0),
                )
            });
            candidates.last().map(|(_, id)| (*id).to_owned())
        }
    }
}

/// Extend the ledger to at least `up_to` clip ids (clips[0..up_to]), deriving
/// every missing step from ONE session view in chain order — the same one read
/// serves the post-completion record and a cross-cycle recovery alike (the
/// intermediate steps are completed rows, so their clips are already in the
/// stock session graph the read answers).
fn extend_story_ledger(
    view: &Value,
    ledger: &mut StoryLedger,
    up_to: usize,
    session: &str,
) -> Result<(), String> {
    while ledger.clips.len() < up_to {
        let next = if ledger.clips.is_empty() {
            imported_child_clip(view, &ledger.prepared).ok_or_else(|| {
                format!(
                    "the session '{session}' holds no continuation clip off the prepared source {}; step {} of the story has not completed a parent render (or its clip is unidentifiable in the stock clip graph)",
                    ledger.prepared,
                    ledger.clips.len()
                )
            })?
        } else {
            chain_child_clip(view, ledger.clips.last().expect("checked non-empty")).ok_or_else(|| {
                format!(
                    "the session '{session}' holds no continuation clip whose parent is {}; step {} of the story has not completed a parent render",
                    ledger.clips.last().expect("checked non-empty"),
                    ledger.clips.len()
                )
            })?
        };
        ledger.clips.push(next);
    }
    Ok(())
}

/// The PURE substitution core (testable without any seam or network): a story
/// row's flat intent, its ledger, and the step's place in the chain — the
/// placeholder `sourceId` becomes the previous step's clip id, then the stock
/// continuity law (`jobs_video::validate_continuity`, the M25a single home)
/// runs on the RESOLVED h3 block. Stock's refusal words ride the error
/// verbatim; the door's context names the row around them. `@story` can never
/// survive this leg: it is substituted before validation, and were the leg
/// ever skipped, the placeholder is stock-illegal and dies at `jobs::compile`
/// with the stock sentence (defense in depth, pinned by test).
fn apply_story_resolution(
    row: &QueueRow,
    intent: &mut Value,
    ledger: &StoryLedger,
) -> Result<(), String> {
    let link = row
        .story_link
        .as_ref()
        .expect("apply_story_resolution runs only on story rows");
    if link.step_index > 0 {
        let parent = ledger.clips.get(link.step_index - 1).ok_or_else(|| {
            format!(
                "story chaining: no recorded parent clip for step {} of story {}",
                link.step_index, link.story_id
            )
        })?;
        let continuity = intent
            .pointer_mut("/h3/continuity")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                format!(
                    "story row {} carries no h3.continuity block; the spool row is corrupt",
                    row.id
                )
            })?;
        continuity.insert("sourceId".to_owned(), json!(parent));
    }
    // The stock law, single home, on the RESOLVED block — BEFORE the intent
    // reaches `native_job_prepare`. The refusal string is stock verbatim; the
    // row-failure detail names the row around it.
    crate::jobs_video::validate_continuity(&intent["h3"]).map_err(|problem| {
        format!(
            "{problem} (story chaining: the stock continuity law refused story row {} step {} at resolution; the row failed before prepare)",
            row.id, link.step_index
        )
    })
}

/// The drain-side resolution leg: story rows only. Step 0 rides the prepared
/// 64-hex the door already put in the row (no substitution); step k>0 reads the
/// session once IF the in-cycle ledger has not yet recorded k clips, re-derives
/// the chain, substitutes the parent, and re-pays the stock law. Ordinary rows
/// pass through byte-identical — the leg is invisible to every non-story cycle
/// law.
async fn resolve_story_row(
    run: &CycleRun,
    row: &QueueRow,
    mut intent: Value,
    stories: &mut HashMap<String, StoryLedger>,
) -> Result<Value, String> {
    let Some(link) = row.story_link.as_ref() else {
        return Ok(intent);
    };
    let ledger = stories
        .entry(link.story_id.clone())
        .or_insert_with(|| StoryLedger {
            prepared: link.prepared_source.clone(),
            clips: Vec::new(),
        });
    if link.step_index > 0 && ledger.clips.len() < link.step_index {
        let view = run
            .sessions
            .session(link.session.clone())
            .await
            .map_err(|problem| {
                format!(
                    "story chaining: the continuity session read for '{}' refused: {problem}",
                    link.session
                )
            })?;
        extend_story_ledger(&view, ledger, link.step_index, &link.session)?;
    }
    apply_story_resolution(row, &mut intent, ledger)?;
    Ok(intent)
}

/// The post-completion clip record (mission step 4): one session read extends
/// the ledger through this step. Failure is logged, never a row fault — the
/// row is already terminal-Done, and the next step's resolution re-derives the
/// chain from the stock clip graph on its own read.
async fn record_story_clip(
    run: &CycleRun,
    row: &QueueRow,
    stories: &mut HashMap<String, StoryLedger>,
) {
    let Some(link) = row.story_link.as_ref() else {
        return;
    };
    let Some(ledger) = stories.get_mut(&link.story_id) else {
        return;
    };
    match run.sessions.session(link.session.clone()).await {
        Ok(view) => {
            if let Err(problem) =
                extend_story_ledger(&view, ledger, link.step_index + 1, &link.session)
            {
                logs::push(
                    Source::Deas,
                    &format!(
                        "agent-api: story chaining could not record the clip of row {} step {}: {problem}",
                        row.id, link.step_index
                    ),
                );
            }
        }
        Err(problem) => {
            logs::push(
                Source::Deas,
                &format!(
                    "agent-api: story chaining could not read session '{}' to record the clip of row {} step {}: {problem}",
                    link.session, row.id, link.step_index
                ),
            );
        }
    }
}

/// The serial drain. A row failing mid-drain is recorded and the batch CONTINUES
/// (§10 batch semantics); every row is CAS-guarded so a concurrently deleted row
/// skips cleanly instead of racing the batch. The one lawful abort is the §5/§10
/// poison-row guard: rows failing at SUBMIT/compile are counted, and once at least
/// two failures cover at least half of what the drain has started, the batch is
/// poison — the not-yet-started rows are left honestly Queued (never marked failed)
/// and the machine proceeds to its free/restore legs so the card still comes back.
async fn drain_rows(run: &CycleRun, queued: &[QueueRow], result: &mut BatchResult) {
    let mut started: usize = 0;
    let mut submit_failures: usize = 0;
    // AF2-M32 story chaining: the clip ids already-completed story steps minted,
    // keyed by storyId. In-memory for the cycle on purpose: a story row that
    // reaches a LATER cycle (the poison guard left it Queued, a restart re-
    // drains it) re-reads the session and re-derives the chain from the stock
    // clip graph — the placeholder law guarantees a stale chain can never
    // submit a wrong parent silently, only fail honestly.
    let mut stories: HashMap<String, StoryLedger> = HashMap::new();
    for (index, row) in queued.iter().enumerate() {
        // C1 (the sever/drain race): the post-loop check cannot cover a latch that
        // lands while this loop is still submitting, and the arm's legs take seconds.
        // Probe the latch before every row and stop here when it is set — the arm has
        // already cancelled the card's work and run its own free/restore, so
        // submitting another row would drive a render onto a card the arm just
        // restored, and the drain would then run a SECOND handoff over it.
        //
        // The probe sits BEFORE the Queued->Draining CAS on purpose: a latch caught
        // here creates no new `draining` row (the orphan class C2 removes), and the
        // rows the drain never reached stay honestly Queued for the next batch. The
        // fault itself is recorded by the caller's check, which then skips its own
        // free/restore legs; the posture is identical to an early check.
        if run.cell.sever_latched() {
            for row in &queued[index..] {
                result.rows.push(RowResult {
                    id: row.id.clone(),
                    status: RowStatus::Queued,
                    detail: Some(
                        "not started: the watchdog severed this cycle mid-drain".to_owned(),
                    ),
                    error_kind: None,
                    job_id: None,
                    outputs: None,
                });
            }
            return;
        }
        match run
            .spool
            .set_status(&row.id, RowStatus::Queued, RowStatus::Draining)
        {
            Ok(true) => {}
            Ok(false) => {
                result.rows.push(RowResult {
                    id: row.id.clone(),
                    status: RowStatus::Cancelled,
                    detail: Some("row left the spool before the drain reached it".to_owned()),
                    error_kind: None,
                    job_id: None,
                    outputs: None,
                });
                continue;
            }
            Err(problem) => {
                result.rows.push(RowResult {
                    id: row.id.clone(),
                    status: RowStatus::Failed,
                    detail: Some(format!("spool CAS (queued->draining) failed: {problem}")),
                    error_kind: None,
                    job_id: None,
                    outputs: None,
                });
                continue;
            }
        }
        let outcome = match super::spool::flat_intent(row) {
            Ok(intent) => {
                // AF2-M32: story rows pass through the resolution leg BEFORE
                // prepare ever sees the block (see `resolve_story_row`); every
                // other row is returned unchanged, untouched by the leg.
                match resolve_story_row(run, row, intent, &mut stories).await {
                    Ok(intent) => {
                        let outcome = run.seams.chain.run_row(&row.id, intent).await;
                        if outcome.succeeded && row.story_link.is_some() {
                            // Post-completion clip recording (one session read,
                            // same helper); a failed record NEVER fails the row
                            // (the row is already terminal-Done) — the next
                            // step's resolution re-derives the chain honestly.
                            record_story_clip(run, row, &mut stories).await;
                        }
                        outcome
                    }
                    Err(problem) => RowOutcome {
                        succeeded: false,
                        detail: Some(problem),
                        error_kind: None,
                        // Refused before submit, exactly like a flat_intent
                        // failure: counted by the poison guard the same way.
                        // The safety argument the guard relies on: a story row
                        // that PASSES this leg has already had the very stock
                        // law stock prepare applies (`jobs_video::
                        // validate_continuity`, single home) run on its
                        // RESOLVED h3 block right here — so a resolved row can
                        // never arrive at submit and come back prepareRefused.
                        // Resolution failures are the only story-side poison
                        // fuel, and they are pre-submit by construction.
                        submit_failed: true,
                        job_id: None,
                        outputs: None,
                    },
                }
            }
            Err(problem) => RowOutcome {
                succeeded: false,
                detail: Some(problem),
                error_kind: None,
                // No intent, no submit: a compile-side failure, counted by the
                // poison guard exactly like a refused submit.
                submit_failed: true,
                job_id: None,
                outputs: None,
            },
        };
        started += 1;
        if outcome.submit_failed {
            submit_failures += 1;
        }
        let status = if outcome.succeeded {
            RowStatus::Done
        } else {
            RowStatus::Failed
        };
        if let Err(problem) = run.spool.set_status(&row.id, RowStatus::Draining, status) {
            // The row's fate is recorded either way; the CAS failure rides the detail.
            result.rows.push(RowResult {
                id: row.id.clone(),
                status,
                detail: Some(match outcome.detail {
                    Some(detail) => format!(
                        "{detail}; spool CAS to '{}' failed: {problem}",
                        status.word()
                    ),
                    None => format!("spool CAS (draining->{}) failed: {problem}", status.word()),
                }),
                error_kind: outcome.error_kind,
                job_id: outcome.job_id,
                outputs: outcome.outputs,
            });
            continue;
        }
        result.rows.push(RowResult {
            id: row.id.clone(),
            status,
            detail: outcome.detail,
            error_kind: outcome.error_kind,
            job_id: outcome.job_id,
            outputs: outcome.outputs,
        });
        // The poison check runs after each submitted attempt: two submit-side
        // failures are the floor (one flaky submit never aborts a fresh batch) and
        // they must cover at least half of the rows the drain has started.
        if queued.len() >= 2 && submit_failures >= 2 && submit_failures * 2 >= started {
            result.fault(
                FAULT_CYCLE,
                format!(
                    "poison-row guard aborted the drain: {submit_failures} of {started} started rows failed at submit; the remaining rows were never submitted and stay queued; the cycle still runs its free and restore legs"
                ),
            );
            for row in &queued[index + 1..] {
                result.rows.push(RowResult {
                    id: row.id.clone(),
                    status: RowStatus::Queued,
                    detail: Some("not started: the poison-row guard aborted the drain".to_owned()),
                    error_kind: None,
                    job_id: None,
                    outputs: None,
                });
            }
            return;
        }
    }
}

/* ------------------------- the file-stability end leg (LEG AF2-M33) ------------------------- */

/// One read of one output file: exactly the two facts the stability law compares. A
/// plain value, never a path this plane invented — the walk resolves the stock
/// descriptor words under the engine-owned output root and reads the metadata there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct OutputStat {
    /// Bytes on disk at read time.
    pub(crate) size_bytes: u64,
    /// Last-modified time in unix milliseconds at read time.
    pub(crate) modified_ms: u64,
}

/// What the stability law concludes from one file's previous read and its newest read.
/// The whole law is here, pure, so it is pinned by test without a filesystem.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Stability {
    /// Two consecutive reads reported identical size AND identical mtime: the writer is
    /// done with this file.
    Stable,
    /// The file is there and this is its first read: the baseline the next read must
    /// confirm.
    Baseline(OutputStat),
    /// The file is there but its facts moved since the previous read: still being
    /// written — the mux/encode class this leg exists for.
    Moving(OutputStat),
    /// The file is not on disk, or its metadata cannot be read. ONE class, both shapes:
    /// an outputs descriptor is the backend's claim about a file, not filesystem
    /// authority, so this is the honest-detail posture, never a wedge and never a fault.
    Absent(String),
}

/// The pure half of the AF2-M33 stability law: two consecutive reads of one file decide.
/// `previous` is the last read of the SAME file (`None` before the first), `read` is this
/// one. A file that vanished between two reads lands in [`Stability::Absent`] — the
/// writer that opened it and never closed it is exactly the honest case the detail names.
#[must_use]
fn stability_vote(
    previous: Option<OutputStat>,
    read: Result<Option<OutputStat>, String>,
) -> Stability {
    let stat = match read {
        Ok(Some(stat)) => stat,
        Ok(None) => return Stability::Absent("the named file is not on disk".to_owned()),
        Err(problem) => return Stability::Absent(problem),
    };
    match previous {
        None => Stability::Baseline(stat),
        Some(before) if before == stat => Stability::Stable,
        Some(_) => Stability::Moving(stat),
    }
}

/// One output descriptor the walk waits on: the stock words the terminal row carried,
/// plus the row that named it (for the honest detail).
#[derive(Debug)]
struct StabilityTarget {
    row_id: String,
    subfolder: String,
    filename: String,
}

/// The descriptor name as the detail states it: the stock `subfolder` word joined to the
/// filename, or the bare filename when the subfolder is the empty string stock mints for
/// root-level outputs.
fn descriptor_name(target: &StabilityTarget) -> String {
    if target.subfolder.is_empty() {
        target.filename.clone()
    } else {
        format!("{}/{}", target.subfolder, target.filename)
    }
}

/// Every output descriptor every drained row carried, deduplicated on
/// (`subfolder`, `filename`) with the first namer kept for the detail. The walk runs
/// ONCE per cycle over this list, never per row. Rows that published nothing contribute
/// nothing; a list element that names no usable filename names no file to wait on and is
/// skipped — the list is passed through verbatim from the stock snapshot (M9g), so this
/// plane never expands, repairs or invents a path from it. Failed rows are NOT excused:
/// a cancelled or failed row can still carry descriptors, and a half-written file whose
/// writer has died settles on the next read anyway.
fn stability_targets(rows: &[RowResult]) -> Vec<StabilityTarget> {
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut targets = Vec::new();
    for row in rows {
        let Some(list) = row.outputs.as_ref().and_then(Value::as_array) else {
            continue;
        };
        for descriptor in list {
            let Some(filename) = descriptor.get("filename").and_then(Value::as_str) else {
                continue;
            };
            let subfolder = descriptor
                .get("subfolder")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let key = (subfolder.clone(), filename.to_owned());
            if !seen.insert(key) {
                continue;
            }
            targets.push(StabilityTarget {
                row_id: row.id.clone(),
                subfolder,
                filename: filename.to_owned(),
            });
        }
    }
    targets
}

/// The stock descriptor guard: `subfolder` + `filename` joined into ONE relative path
/// under the owned output root. Refused (the honest-detail class — never a filesystem
/// touch): an empty filename, a NUL or control character, a `.`/`..` or empty segment, a
/// drive- or UNC-shaped name. The walk reads the engine-owned outputs folder and nothing
/// outside it — the containment posture the §4 byte doors hold (`files::contained`), kept
/// local here because that grammar also refuses the LEGITIMATE empty `subfolder` stock
/// mints for root-level outputs.
fn descriptor_path(subfolder: &str, filename: &str) -> Result<PathBuf, String> {
    let refuse = |segment: &str, why: &str| {
        Err(format!(
            "descriptor segment '{segment}' is refused ({why}); the walk reads only the \
             engine-owned output root and one relative path inside it"
        ))
    };
    if filename.is_empty() {
        return refuse(filename, "empty filename");
    }
    let mut parts: Vec<&str> = Vec::new();
    if !subfolder.is_empty() {
        parts.extend(subfolder.split('/'));
    }
    parts.push(filename);
    let mut path = PathBuf::new();
    for segment in parts {
        if segment.is_empty() || segment == "." || segment == ".." {
            return refuse(segment, "empty or traversal segment");
        }
        if segment.contains('/')
            || segment.contains('\\')
            || segment.contains(':')
            || segment.chars().any(char::is_control)
        {
            // A `/` inside a segment is the traversal form the split above never
            // produces (`filename: "../secret"`), so it is refused, not walked into.
            return refuse(segment, "not a plain relative name");
        }
        path.push(segment);
    }
    Ok(path)
}

/// LEG AF2-M33, the file-stability end leg: after every drained row is terminal and
/// BEFORE the end legs are entered, walk every output the rows named and wait for each
/// file to stop changing. The race this exists for: the stock snapshot answers
/// `succeeded` while the backend's post-graph SaveVideo / audio-mux / H3-encode threads
/// are still writing the mp4 (the `-audio` outputs prove the mux runs post-graph), and
/// the queue idle proof cannot see that writer — the job has left both queue lists. So
/// `free` (and then the restore bat loading the LLM back onto the card) used to fire
/// beside a live render: competition, slow renders, model-restore pressure. A 2 s settle
/// is nowhere near an H3 mux, so the machine waits on the FILES.
///
/// The laws of this leg, all of them:
/// * ONCE per cycle over every terminal row's descriptors — never per row.
/// * Skipped whole when no row produced outputs: no read, no wait, no report key.
/// * A file is settled when it exists and two consecutive reads [`STABILITY_POLL_MS`]
///   apart report identical size AND identical mtime (see [`stability_vote`]).
/// * Bounded: [`STABILITY_TIMEOUT_MS`] of waiting, counted as
///   [`STABILITY_WAIT_BOUND`] gaps plus a never-loser wall-clock ceiling.
/// * FAIL-OPEN at the bound, and fail-open on a missing/unreadable file: the honest
///   detail rides the report's additive `stability` key and the legs proceed anyway. An
///   agent row naming a file the backend never wrote must not hold the card hostage.
/// * The leg DELAYS entry into the end legs and touches nothing else: not `poll_row`,
///   not the terminal words, not the poison guard, not the deadline/stall postures, not
///   the M32 story legs, not the watchdog, not the free wire body, not the restore bat.
///   It takes no compute permit and it never faults the cycle.
async fn stability_leg(run: &CycleRun, result: &mut BatchResult) {
    let targets = stability_targets(&result.rows);
    if targets.is_empty() {
        // No file named, no wait owed: the cycle's report shape is untouched and the
        // seam is never called.
        return;
    }
    let started = Instant::now();
    let mut previous: Vec<Option<OutputStat>> = vec![None; targets.len()];
    let mut open: Vec<usize> = (0..targets.len()).collect();
    let mut waits: u64 = 0;
    loop {
        let mut undecided = Vec::new();
        for index in open {
            let target = &targets[index];
            let read = run
                .seams
                .door
                .output_stat(&target.subfolder, &target.filename)
                .await;
            match stability_vote(previous[index], read) {
                // Settled with nothing to say: the writer finished this file.
                Stability::Stable => {}
                // Settled with the honest disclosure: the file is not there to wait on.
                Stability::Absent(problem) => result.stability_problems.push(format!(
                    "output '{}' named by row '{}' is not on disk ({problem}) - a row's outputs descriptor is not filesystem authority; the end legs proceed",
                    descriptor_name(target), target.row_id
                )),
                // Still owed a confirming read.
                Stability::Baseline(stat) | Stability::Moving(stat) => {
                    previous[index] = Some(stat);
                    undecided.push(index);
                }
            }
        }
        open = undecided;
        if open.is_empty() {
            break;
        }
        if waits >= STABILITY_WAIT_BOUND
            || started.elapsed() >= Duration::from_millis(STABILITY_TIMEOUT_MS)
        {
            // The bound is the fail-open law, never a fault: name every unsettled file
            // honestly and let the end legs run.
            for index in open {
                let target = &targets[index];
                let last = previous[index].map_or_else(
                    || "never readable".to_owned(),
                    |stat| format!("{} bytes", stat.size_bytes),
                );
                result.stability_problems.push(format!(
                    "output '{}' named by row '{}' never stopped changing within {STABILITY_TIMEOUT_MS} ms (last read: {last}) - a render may still be writing it; the end legs proceeded anyway",
                    descriptor_name(target), target.row_id
                ));
            }
            break;
        }
        waits += 1;
        run.seams.pacer.pause(STABILITY_POLL_MS).await;
    }
    if !result.stability_problems.is_empty() {
        logs::push(
            Source::Deas,
            &format!(
                "agent-api: cycle {} file-stability walk rode {} honest problem(s) ({}); the end legs proceed",
                run.cycle_id,
                result.stability_problems.len(),
                result.stability_problems.join("; ")
            ),
        );
    }
}

/// settle → free → down-hold → patience (§7.1). A missing free ack is retried on the
/// exact same two-key wire over the same door, bounded to [`FREE_ATTEMPT_BOUND`]
/// attempts per cycle (§10 `free ack missing`), with an honest log per attempt — the
/// §8.4 posture: surface, answer the caller, never a silent loop. Only after the
/// bound is it the terminal cycle fault; the restore leg still runs so the card
/// never stays down.
async fn free_leg(run: &CycleRun, result: &mut BatchResult) {
    run.cell.set_phase(CyclePhase::Freeing);
    run.seams.pacer.pause(SETTLE_MS).await;
    // The FREE wire law: the body is exactly these two keys (resources.rs:313-325).
    // Every retry re-sends that exact body; only the attempt count moves.
    let body = json!({ "unload_models": true, "free_memory": true });
    let mut last_problem = String::new();
    for attempt in 1..=FREE_ATTEMPT_BOUND {
        match run.seams.door.free(body.clone()).await {
            Ok(()) => {
                result.freed = true;
                run.seams.pacer.pause(DOWN_HOLD_MS).await;
                run.seams.pacer.pause(PATIENCE_MS).await;
                return;
            }
            Err(problem) => {
                logs::push(
                    Source::Deas,
                    &format!(
                        "agent-api: free attempt {attempt}/{FREE_ATTEMPT_BOUND} was not acknowledged (200 + empty body): {problem}"
                    ),
                );
                last_problem = problem;
            }
        }
    }
    result.fault(
        FAULT_CYCLE,
        format!(
            "free was not acknowledged after {FREE_ATTEMPT_BOUND} attempts (200 + empty body): {last_problem}"
        ),
    );
    // The startup-preset cause (design 10 §14.6): when the backend was launched with a
    // flag from the closed known-wedge set, the answer names the culprit next to the
    // symptom, so the operator's next move is a preset switch rather than a guess.
    // The read is best-effort and CANNOT fail this path: unreadable or clean args
    // leave the fault exactly as the exhaustion alone described it.
    if let Some(flag) = run
        .seams
        .startup
        .effective_args()
        .as_deref()
        .and_then(startup_preset_cause)
    {
        result.blocked_on = Some(format!("{BLOCKED_ON_STARTUP_PRESET}:{flag}"));
    }
    // F4 (LEG AF2-M20), one-homed and raised by W3-5/W3-17 (LEG AF2-M21a):
    // the shared fault-path settle runs before any caller touches restore.
    // W4-A (LEG AF2-M22): the VERDICT is no longer dropped. A settle that never
    // proves the queue idle means the card is answering with work on it — a
    // foreign job landed after the drain's (already-consumed) idle proof — and the
    // restore bat beside it is the last co-residency window the law exists to
    // close. The verdict rides the result: the drive's restore gate reads
    // `result.restore_forbidden` and skips the bat.
    if !free_fault_settle(&run.seams).await {
        logs::push(
            Source::Deas,
            "agent-api: free fault settle never proved the queue idle - restore skipped, debt owed",
        );
        result.restore_forbidden = true;
        if run.guard.auto_cycle_vram {
            // The cycle's own unload took the model down; nothing brings it back
            // beside an unproven queue. The debt rides the report and resume.
            result.model_restored = false;
            result.card_at_risk = true;
        }
    }
}

/// Re-probes after a FAULTED free before any restore bat can load beside the
/// backend's post-free cache reset (F4, the P5 wedge class: the free may have been
/// APPLIED with only the ack lost on the wire). One home serves BOTH free homes
/// (W3-5, LEG AF2-M21a): the cycle free-leg exhaustion here and the watchdog
/// arm's single-attempt free. W3-17 raised it from one 500 ms look to the acked
/// path's patience class: a down-hold on [`DOWN_HOLD_MS`] before each of at most
/// [`FREE_FAULT_SETTLE_PROBE_BOUND`] idle re-probes over the same door — never a
/// re-proved free, never an unbounded loop, every probe an honest log line. The
/// caller's fault stands whatever this returns; the card never stays down because
/// a settle grew impatient.
///
/// W4-A (LEG AF2-M22): the BOOL IS A VERDICT, not a footnote. `true` = the queue
/// was proven idle inside the bounded re-probes; `false` = never proven — the
/// backend is still answering with work on the card — and NO restore bat may spawn
/// on the caller's word that this settle gated (both free homes honour it: the
/// cycle's free leg records `BatchResult::restore_forbidden`, the watchdog arm
/// skips its restore leg). The verdict gates the bat, never the fault text.
pub(crate) async fn free_fault_settle(seams: &CycleSeams) -> bool {
    for probe in 1..=FREE_FAULT_SETTLE_PROBE_BOUND {
        seams.pacer.pause(DOWN_HOLD_MS).await;
        match seams.door.queue_idle_proof().await {
            Ok(()) => {
                logs::push(
                    Source::Deas,
                    &format!(
                        "agent-api: free-fault settle: backend queue proven idle before restore (re-probe {probe}/{FREE_FAULT_SETTLE_PROBE_BOUND})"
                    ),
                );
                return true;
            }
            Err(problem) => logs::push(
                Source::Deas,
                &format!(
                    "agent-api: free-fault settle: re-probe {probe}/{FREE_FAULT_SETTLE_PROBE_BOUND} did not prove an idle queue: {problem}"
                ),
            ),
        }
    }
    false
}

/// What one restore leg decided (W3-6, LEG AF2-M21a). `ArmOwns` exists because
/// the leg is latch-aware now: a watchdog sever latched between attempts means the
/// arm owns the bat, and a second spawn stacked onto the arm's is the exact
/// double-load the latch law closes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RestoreOutcome {
    /// The readiness target answered inside a health window.
    Restored,
    /// Every bounded attempt failed (§8.4 exhaustion).
    Exhausted,
    /// A sever latched onto the cell; the arm owns restore from here.
    ArmOwns,
}

/// Restore bat + health poll, bounded (§8.4): at most [`RESTORE_ATTEMPT_BOUND`]
/// attempts, [`RESTORE_GAP_MS`] apart; the health poll probes at ≤1 per
/// [`HEALTH_PROBE_GAP_MS`] within a [`HEALTH_WINDOW_MS`] window and STOPS at the
/// first healthy answer (owner law: never keep loading a target that answered).
/// The watchdog sever arm runs this SAME leg after a wedge (§8.2 step 5) — one
/// restore posture, never a second code path. W3-6 (LEG AF2-M21a): the DRAIN
/// passes its cell and the leg re-probes the sever latch before EVERY attempt —
/// a latch that lands mid-leg hands the bat to the arm instead of stacking a
/// second one. The arm passes `None`: its own provisional latch would otherwise
/// veto its restore.
pub(crate) async fn restore_leg(
    seams: &CycleSeams,
    guard: &GuardConfig,
    drain_cell: Option<&CycleCell>,
) -> RestoreOutcome {
    for attempt in 1..=RESTORE_ATTEMPT_BOUND {
        if drain_cell.is_some_and(|cell| cell.sever_latched()) {
            logs::push(
                Source::Deas,
                "agent-api: restore leg hands over to the watchdog arm (sever latched); no bat spawns here",
            );
            return RestoreOutcome::ArmOwns;
        }
        match seams
            .commands
            .run(&guard.restore_command, RESTORE_TIMEOUT_MS)
            .await {
            Ok(0) => {
                if health_window(seams, guard).await {
                    return RestoreOutcome::Restored;
                }
            }
            Ok(code) => logs::push(
                Source::Deas,
                &format!(
                    "agent-api: restore command exited {code} (attempt {attempt}/{RESTORE_ATTEMPT_BOUND})"
                ),
            ),
            Err(problem) => logs::push(
                Source::Deas,
                &format!(
                    "agent-api: restore command could not run (attempt {attempt}/{RESTORE_ATTEMPT_BOUND}): {problem}"
                ),
            ),
        }
        if attempt < RESTORE_ATTEMPT_BOUND {
            seams.pacer.pause(RESTORE_GAP_MS).await;
        }
    }
    RestoreOutcome::Exhausted
}

async fn health_window(seams: &CycleSeams, guard: &GuardConfig) -> bool {
    // Probes land at t = 0, GAP, 2*GAP … while the probe time stays inside the
    // window; the first healthy answer stops everything immediately.
    let mut next_probe_at: u64 = 0;
    loop {
        if seams.health.probe(&guard.ready_url).await {
            return true;
        }
        next_probe_at += HEALTH_PROBE_GAP_MS;
        if next_probe_at > HEALTH_WINDOW_MS {
            return false;
        }
        seams.pacer.pause(HEALTH_PROBE_GAP_MS).await;
    }
}

/// The terminal batch report (§4 contract): per-row status, the restore posture and
/// the fault word+detail when the cycle faulted. One shape for the held caller, the
/// persisted cell and `GET /v1/cycle`.
fn report(cycle_id: &str, guard: &GuardConfig, queued: &[QueueRow], result: BatchResult) -> Value {
    let rows: Vec<Value> = match result.rows.is_empty() {
        // A fault that skipped the drain leaves every snapshotted row queued; the
        // report says so honestly instead of echoing empty.
        true if result.fault.is_some() && !queued.is_empty() => queued
            .iter()
            .map(|row| {
                json!({
                    "id": row.id,
                    "status": RowStatus::Queued.word(),
                    "error": null,
                    "jobId": row.job_id,
                })
            })
            .collect(),
        _ => result
            .rows
            .iter()
            .map(|row| {
                // LEG M12: a classified failure rides the structured {kind, detail}
                // object; every other detail stays the plain string. The
                // unclassified shape is byte-identical to what shipped before —
                // skip-when-absent applies to the classification, never the detail.
                // LEG M14c (additive): a prepareRefused row also carries the
                // repair hint the §12.1 addendum names; the {kind, detail} pair
                // itself is untouched, and every other classification is
                // byte-identical to M12.
                let error = match (row.error_kind, &row.detail) {
                    (Some(ErrorKind::PrepareRefused), Some(detail)) => json!({
                        "kind": ErrorKind::PrepareRefused.reason(),
                        "detail": detail,
                        "hint": PREPARE_REFUSAL_HINT,
                    }),
                    (Some(kind), Some(detail)) => {
                        json!({ "kind": kind.reason(), "detail": detail })
                    }
                    (_, detail) => json!(detail),
                };
                let mut body = json!({
                    "id": row.id,
                    "status": row.status.word(),
                    "error": error,
                    "jobId": row.job_id,
                });
                // M9g additive discovery key, skip-when-absent: the stock descriptors
                // verbatim, so the row names WHICH outputs it produced (the byte doors
                // are index-addressed). A row with nothing to show carries no key.
                if let Some(outputs) = &row.outputs {
                    body["outputs"] = outputs.clone();
                }
                body
            })
            .collect(),
    };
    let mut body = json!({
        "ok": result.fault.is_none(),
        "cycleId": cycle_id,
        "autoCycleVram": guard.auto_cycle_vram,
        "freeOnQueueEnd": guard.free_on_queue_end,
        "freed": result.freed,
        "modelRestored": result.model_restored,
        "rows": rows,
        "completedAt": now_ms(),
    });
    // W3-9 additive key, skip-when-absent: the model went off the card and no
    // restore landed — the honest posture says so out loud instead of letting a
    // `modelRestored:false` stand unexplained.
    if result.card_at_risk {
        body["cardAtRisk"] = json!(true);
    }
    // AF2-M33 additive key, skip-when-absent (the same posture as the row `outputs`
    // key): the walk only ever speaks when it rode a problem, and it says so with
    // `ok:false` plus one honest entry per unsettled descriptor. A clean walk — and a
    // cycle with no outputs at all — carries no key, so every pre-M33 report is
    // byte-identical.
    if !result.stability_problems.is_empty() {
        body["stability"] = json!({ "ok": false, "problems": result.stability_problems });
    }
    if let Some((reason, detail)) = &result.fault {
        let mut fault = json!({ "reason": reason, "detail": detail });
        // Additive cause key, skip-when-absent: an unattributed fault is byte-for-byte
        // the fault that shipped before the startup-preset cause existed.
        if let Some(cause) = &result.blocked_on {
            fault[BLOCKED_ON] = json!(cause);
        }
        body["fault"] = fault;
        let suffix = result
            .blocked_on
            .as_deref()
            .map_or_else(String::new, |cause| format!(" blockedOn {cause}"));
        logs::push(
            Source::Deas,
            &format!("agent-api: cycle {cycle_id} faulted ({reason}): {detail}{suffix}"),
        );
    }
    body
}

/// Pre-drain refusals (spool unreadable, gate busy) still produce the one report shape.
fn fault_report(
    cycle_id: &str,
    guard: &GuardConfig,
    queued: Vec<QueueRow>,
    reason: &'static str,
    detail: String,
) -> Value {
    report(
        cycle_id,
        guard,
        &queued,
        BatchResult {
            rows: Vec::new(),
            model_restored: true,
            freed: false,
            card_at_risk: false,
            restore_forbidden: false,
            fault: Some((reason, detail)),
            blocked_on: None,
            stability_problems: Vec::new(),
        },
    )
}

/* ------------------------------ production seams ------------------------------ */

/// Production bats: the operator's command string, verbatim through the platform
/// shell, exit-waited UNDER THE LEG'S OWN BUDGET (§7.1 `cmd /C`, W1). Operator config
/// — never run in unit tests.
pub(crate) struct StockCommandRunner;

/// The child-process verbs the bat monitor needs, split from the monitor loop so
/// the deadline law is pinned by test without spawning anything (box law: no spawns at
/// test time). Production is `std::process::Child` itself; the fakes are the hung bat
/// and the honest one.
trait BatHandle {
    /// `None` while the child still runs; `Some(exit code)` once it has been reaped.
    fn try_exit(&mut self) -> Result<Option<i32>, String>;
    /// The child's OS pid. `0` means "no pid to offer a tree kill" — the fakes, which
    /// no spawn is ever aimed at (box law); a real child always advertises its pid.
    /// Read only by [`kill_bat_tree`]'s `cfg(windows)` arm (the unix leg kills the child
    /// directly), so on a non-Windows build the method is intentionally unread.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn pid(&self) -> u32;
    /// Force the child down — the only thing that ends a hung leg.
    fn kill(&mut self) -> Result<(), String>;
}

impl BatHandle for std::process::Child {
    fn try_exit(&mut self) -> Result<Option<i32>, String> {
        self.try_wait()
            .map(|status| status.map(|status| status.code().unwrap_or(-1)))
            .map_err(|problem| format!("could not poll the command child: {problem}"))
    }

    fn pid(&self) -> u32 {
        self.id()
    }

    fn kill(&mut self) -> Result<(), String> {
        self.kill()
            .map_err(|problem| format!("could not kill the command child: {problem}"))
    }
}

/// One home for the hung-bat kill (F3, LEG AF2-M20): on Windows the whole process
/// TREE goes down, not just the shell child. The bat is spawned through `cmd /C`, and
/// `Child::kill` drops only cmd.exe — the bat's own children (the model loaders the
/// unload/restore legs actually run) survive with their parent gone, and the RESTORE
/// retry 90 s later can double-load the card behind them. `taskkill /T /F /PID` kills
/// the tree; when taskkill itself cannot run, the direct `Child::kill` is the fallback
/// (honest: the child at least goes down; the survivor class rides the leg's error
/// note). On unix the direct kill stays. The seam's kill arm is what the tests pin —
/// the taskkill branch is production-only by the no-spawn-at-test-time law.
fn kill_bat_tree(child: &mut impl BatHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let pid = child.pid();
        if pid != 0 {
            return match run_taskkill_tree(pid) {
                Ok(()) => Ok(()),
                Err(problem) => {
                    logs::push(
                        Source::Deas,
                        &format!(
                            "agent-api: bat tree kill (taskkill /PID {pid}) failed ({problem}); falling back to the direct child kill"
                        ),
                    );
                    child.kill()
                }
            };
        }
    }
    child.kill()
}

/// `taskkill /T /F /PID <pid>`, stdio nulled for the same reader-thread reason
/// [`run_bat`] nulls the bat's (a kill tool that writes must not be able to wedge the
/// leg whose whole job is ending the writer). Errors are captured for the caller's
/// fallback, never swallowed.
#[cfg(windows)]
fn run_taskkill_tree(pid: u32) -> Result<(), String> {
    let answer = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID"])
        .arg(pid.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|problem| format!("could not run taskkill: {problem}"))?;
    if answer.status.success() {
        Ok(())
    } else {
        Err(format!(
            "taskkill exited {}",
            answer.status.code().unwrap_or(-1)
        ))
    }
}

/// Watch one bat child to its exit or to its budget, in that order (W1). Expiry kills
/// the child, spends a bounded tail reaping it, and answers `Err` naming the timeout —
/// the fault machinery then does with it what it already does with any failed leg: the
/// unload leg faults the cycle and releases the fence, the restore leg moves to its
/// bounded retry. Nothing parks.
fn wait_for_bat(
    child: &mut impl BatHandle,
    timeout_ms: u64,
    gap_ms: u64,
    reap_polls: u32,
) -> Result<i32, String> {
    let started = Instant::now();
    loop {
        if let Some(code) = child.try_exit()? {
            return Ok(code);
        }
        if started.elapsed() >= Duration::from_millis(timeout_ms) {
            let killed = kill_bat_tree(child);
            for _ in 0..reap_polls {
                if matches!(child.try_exit(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(gap_ms));
            }
            let note = match killed {
                Ok(()) => String::new(),
                Err(problem) => format!(" ({problem})"),
            };
            return Err(format!(
                "timed out after {timeout_ms} ms and was killed{note}"
            ));
        }
        std::thread::sleep(Duration::from_millis(gap_ms));
    }
}

/// Spawn the operator's bat and hand it to the monitor. The child's stdio is null on
/// purpose: this plane never consumed the bat's output (the pre-W1 code captured it and
/// discarded it), and null pipes remove the reader-thread failure class the deadline
/// law must not inherit — a bat that writes must not be able to wedge the leg whose
/// whole job is to time it out.
fn run_bat(command: &str, timeout_ms: u64) -> Result<i32, String> {
    #[cfg(windows)]
    let mut builder = {
        // W-1 LAW (af-01's paid-for lesson, af01 agent_handoff.rs:509): operator text
        // goes to cmd via raw_arg, NEVER .arg(). .arg() escapes the inner quotes to \"
        // and cmd takes them literally - a stored "C:\...\bat" /yes reaches cmd broken
        // and answers 'not recognized', exit 1, before the bat body ever runs. raw_arg
        // puts the stored string on the command line byte-for-byte: what the operator
        // writes is what the shell parses, DEAS adds nothing.
        use std::os::windows::process::CommandExt as _;
        let mut builder = std::process::Command::new("cmd");
        builder.raw_arg("/C");
        builder.raw_arg(command);
        builder
    };
    #[cfg(not(windows))]
    let mut builder = {
        let mut builder = std::process::Command::new("sh");
        builder.args(["-c", command]);
        builder
    };
    let mut child = builder
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|problem| format!("command could not be spawned: {problem}"))?;
    wait_for_bat(&mut child, timeout_ms, BAT_POLL_GAP_MS, BAT_REAP_POLLS)
}

impl CommandRunner for StockCommandRunner {
    fn run(&self, command: &str, timeout_ms: u64) -> BoxFuture<'static, Result<i32, String>> {
        let command = command.to_owned();
        Box::pin(async move {
            // Blocking wait on a dedicated thread keeps the async runtime free while
            // the operator's bat runs its (potentially long, now bounded) load/unload
            // sequence.
            tokio::task::spawn_blocking(move || run_bat(&command, timeout_ms))
                .await
                .map_err(|_| "the command task panicked".to_owned())?
        })
    }
}

/// Production chain: the stock `native_job_prepare` / `native_job_submit` /
/// `native_job_status` trio called in-process (the scan.rs managed-state idiom),
/// gated by the E29 backend-ready law through [`pre_submit_leg`] (LEG AF2-M24a),
/// then the row driver polled to its terminal word (P6: terminal truth comes from
/// the stock driver, never a private read of the wire). The Jobs session is
/// single-plan serial, which is exactly the serial-drain law.
pub(crate) struct StockSubmitChain {
    app: tauri::AppHandle,
    /// The durable spool handle: the correlation write lands on the row being drained
    /// the instant the stock submit mints the job id (M9a), before the poll loop.
    spool: Arc<Spool>,
    /// The RefMod export verbs (E28, LEG AF2-M24b): the drainable-row arm of
    /// [`Self::run_row`] reaches submit/status/cancel through the SAME
    /// [`RefmodBridge`] seam the refmod doors use (`results.rs`), mirroring how
    /// `PlaneState` holds its own `refmods` handle — a fresh thin AppHandle
    /// holder, deliberately not a new global. The cycle tests run a fake bridge
    /// through the same seam shape the arm takes as a parameter.
    refmods: Arc<dyn RefmodBridge>,
}

/// The M9g capture law: the terminal snapshot's `outputs` list rides the row outcome
/// verbatim ([`RowOutcome::outputs`]). Only a NON-EMPTY list counts; a missing key, a
/// non-list or an empty list is `None`, so the report cannot present "the backend said
/// nothing" as "the row produced nothing". Kept pure — the production chain needs a live
/// backend to poll, this law does not.
fn snapshot_outputs(snapshot: &Value) -> Option<Value> {
    snapshot
        .get("outputs")
        .filter(|outputs| matches!(outputs, Value::Array(list) if !list.is_empty()))
        .cloned()
}

/// The LEG M12 mapping of a stock-side prepare/prereq/allowlist refusal reached
/// AFTER admission: the row detail becomes the structured `{kind, detail}` pair the
/// terminal report carries — the stock string VERBATIM, never a paraphrase — and the
/// row stays failed + submit_failed: the §5 poison law counts it exactly as the old
/// free-form `"prepare failed: …"` string did. Pure by law and pinned by test; the
/// live prepare call needs a running backend, this mapping does not.
fn prepare_refused(problem: String) -> RowOutcome {
    RowOutcome {
        succeeded: false,
        detail: Some(problem),
        error_kind: Some(ErrorKind::PrepareRefused),
        submit_failed: true,
        job_id: None,
        outputs: None,
    }
}

/// The stock row-driver words that END one row (P6: terminal truth comes from the stock
/// driver, never a private read of the wire). `unknown` is deliberately NOT a member:
/// the stock driver answers it while the row is not yet in history, which is the same
/// non-terminal posture the poll loop has always kept.
const TERMINAL_ROW_WORDS: [&str; 3] = ["succeeded", "failed", "cancelled"];

/// The stock `native_h3_refmod_status` words that END a RefMod export row (LEG
/// AF2-M24b, owner law E28): the export verb answers its own closed vocabulary
/// — `queued`/`running` keep the poll going, the four here end it (`results.rs`
/// door docs; `jobs_refmod::history_state` / `queued_state` mint the words).
/// `missing` is terminal — the prompt left the backend queue without a history
/// entry, the stock verb's honest nothing — and `done` replaces `succeeded` as
/// the success word. The two sets NEVER cross; a law-named test pins that.
const TERMINAL_REFMOD_WORDS: [&str; 4] = ["done", "failed", "cancelled", "missing"];

/// What one row poll ended on.
#[derive(Debug)]
enum RowPoll {
    /// The driver answered a terminal word; the snapshot carries it (and the outputs).
    Terminal(Value),
    /// The driver itself became unreadable.
    Unreadable(String),
    /// The driver answered an object with no state word at all — the honest fail-fast
    /// the loop has always had, kept as its own case so the wire text does not move.
    NoStateWord,
    /// W2: the driver kept answering non-terminal words past [`ROW_DEADLINE_MS`].
    Expired,
    /// W4-E (LEG AF2-M22): the word stayed `queued` (never seen `running`) past
    /// [`QUEUED_STALL_MS`] — a submit-stuck job the judge cannot watch and the
    /// running-row deadline would hold the fence for an hour.
    QueuedStalled,
}

/// Poll a row driver to its terminal word, bounded by `deadline_ms`. Split from
/// the production chain so the deadline law is pinned by test: the live loop needs a
/// running backend, the law does not. `gap_ms` keeps the ≤1/2 s cadence, `deadline_ms`
/// is the hot-wedge backstop the two-fact judge cannot cover (a hot-wedged row is busy,
/// so fact two never goes quiet) and the fence's lease can never be indefinite.
/// `terminal_words` is the vocabulary that ENDS this poll: [`TERMINAL_ROW_WORDS`]
/// for the Workbench row driver, [`TERMINAL_REFMOD_WORDS`] for the RefMod status
/// verb (LEG AF2-M24b) — the physics (cadence, deadline, queued-stall) stay ONE
/// home, only the words differ.
async fn poll_row<Read, ReadFut>(
    mut read: Read,
    gap_ms: u64,
    deadline_ms: u64,
    queued_stall_ms: u64,
    terminal_words: &[&str],
) -> RowPoll
where
    Read: FnMut() -> ReadFut,
    ReadFut: std::future::Future<Output = Result<Value, String>>,
{
    let started = Instant::now();
    // W4-E (LEG AF2-M22): the first tick that found the job `queued`. `None` means
    // the poll has never seen the queued word (or the job already started): the
    // stall clock only runs while the job has NEVER been seen running, so a live
    // render keeps its full [`ROW_DEADLINE_MS`] lease.
    let mut queued_since: Option<Instant> = None;
    loop {
        let snapshot = match read().await {
            Ok(snapshot) => snapshot,
            Err(problem) => return RowPoll::Unreadable(problem),
        };
        let Some(word) = snapshot["state"].as_str() else {
            return RowPoll::NoStateWord;
        };
        if terminal_words.contains(&word) {
            return RowPoll::Terminal(snapshot);
        }
        if word == "queued" {
            // The first queued sighting starts the stall clock; later queued ticks
            // read it. Any non-queued word leaves the stamp frozen — a job that
            // started and fell back to `queued` (a posture the stock driver does
            // not answer) never re-arms the stall; the row deadline carries it.
            queued_since = Some(queued_since.unwrap_or(started));
        }
        if started.elapsed() >= Duration::from_millis(deadline_ms) {
            return RowPoll::Expired;
        }
        // W4-E: the stall bound sits behind the row-decline check on purpose — a
        // row deadline shorter than the stall bound (the injected drill class)
        // still answers the W2 deadline law first, never the stall.
        if queued_since
            .is_some_and(|since| since.elapsed() >= Duration::from_millis(queued_stall_ms))
        {
            return RowPoll::QueuedStalled;
        }
        tokio::time::sleep(Duration::from_millis(gap_ms)).await;
    }
}

/// W2's row posture for an expired poll: the row reached the backend (it carries a
/// correlation id) and never answered terminal, so it is a render-side failure —
/// `submit_failed: false` keeps it out of the poison guard, `job_id: Some` keeps the §4
/// result doors able to name what this plane stopped waiting on. The row lands `failed`
/// through the ordinary per-row outcome path and the cycle proceeds to its end legs.
/// F2 (LEG AF2-M20): the scoped cancel of the live job has already RUN before this
/// posture is recorded — a row marked failed must not leave a render behind it, or the
/// idle proof fails, free is skipped, and the restore loads the model NEXT TO a live
/// render (the never-co-resident law broken by our own safety net). Any stock verb
/// that refused rides the detail honestly ("cancel problem: …"): the answer cannot
/// claim a quiet card it did not get.
fn deadline_outcome(job_id: &str, deadline_ms: u64, cancel_problems: &[String]) -> RowOutcome {
    let mut detail = format!(
        "the row driver never reached a terminal word for job {job_id} within the {deadline_ms} ms row deadline; the cycle stopped waiting and scoped-cancelled the live job before its end legs"
    );
    if !cancel_problems.is_empty() {
        detail.push_str(&format!(
            "; deadline hit; cancel problem: {}",
            cancel_problems.join("; ")
        ));
    }
    RowOutcome {
        succeeded: false,
        detail: Some(detail),
        error_kind: None,
        submit_failed: false,
        job_id: Some(job_id.to_owned()),
        outputs: None,
    }
}

/// W4-E (LEG AF2-M22): the queued-stall posture. Same render-side family as the
/// deadline row — the row reached the backend (it carries a correlation), so it is
/// never poison-guard fuel — but the detail names the STALL, not the hour-bound, so
/// an operator never reads "60 minutes" for a job that never started.
fn queued_stall_outcome(job_id: &str, cancel_problems: &[String]) -> RowOutcome {
    let mut detail = format!(
        "queued stall: job {job_id} never started within the {} ms queued-stall bound (the stock word stayed 'queued' the whole window); the row was failed and scoped-cancelled (pending cancel is the verb for a queued job)",
        QUEUED_STALL_MS
    );
    if !cancel_problems.is_empty() {
        detail.push_str(&format!("; cancel problem: {}", cancel_problems.join("; ")));
    }
    RowOutcome {
        succeeded: false,
        detail: Some(detail),
        error_kind: None,
        submit_failed: false,
        job_id: Some(job_id.to_owned()),
        outputs: None,
    }
}

/// The arm-order law applied to one correlated job (F2): the `{"delete"}` pending
/// cancel first, then the scoped running interrupt — both aimed at the row's own stock
/// id, never a global interrupt, never a queue clear (the §8.3 posture). Both verbs
/// are attempted: a pending cancel against a running job refuses honestly, and it is
/// the interrupt that reaches the render. Refusals come back verbatim for the row
/// detail; the deadline row is recorded either way (the never-forever law stands).
async fn scope_cancel_expired(control: &dyn ScopedCancel, job_id: &str) -> Vec<String> {
    let mut problems = Vec::new();
    if let Err(problem) = control.cancel_pending(job_id).await {
        problems.push(format!("pending cancel: {problem}"));
    }
    if let Err(problem) = control.interrupt_running(job_id).await {
        problems.push(format!("running interrupt: {problem}"));
    }
    problems
}

/// Map one ended row poll to the row's outcome. The arms carry the shipped wire
/// texts; the Expired arm runs the F2 scoped cancel through `cancel` before the
/// deadline posture, and every other arm sends no mutation anywhere. Split from the
/// production chain so the deadline law, the cancel order, and the cancel-on-expiry-
/// ONLY law are all pinned by test with no live backend.
async fn poll_outcome(poll: RowPoll, job_id: &str, cancel: &dyn ScopedCancel) -> RowOutcome {
    let render_failed = |detail: String| RowOutcome {
        succeeded: false,
        detail: Some(detail),
        error_kind: None,
        submit_failed: false,
        job_id: Some(job_id.to_owned()),
        outputs: None,
    };
    match poll {
        RowPoll::Terminal(snapshot) => match snapshot["state"].as_str() {
            Some("succeeded") => RowOutcome {
                succeeded: true,
                detail: None,
                error_kind: None,
                submit_failed: false,
                job_id: Some(job_id.to_owned()),
                // M9g: the same snapshot the terminal word came from names the
                // row's outputs, so the terminal report lets a stranger address
                // `GET /v1/outputs/{jobId}/{index}` from the index the row itself
                // published.
                outputs: snapshot_outputs(&snapshot),
            },
            Some(word) => {
                let excerpt = snapshot["error"].as_str().unwrap_or(word).to_owned();
                render_failed(format!("row ended '{word}': {excerpt}"))
            }
            // `poll_row` only answers `Terminal` on a word; the arm stays honest
            // rather than unreachable-by-assertion.
            None => render_failed(format!(
                "the stock row driver answered no state word for job {job_id}"
            )),
        },
        RowPoll::Unreadable(problem) => render_failed(format!(
            "row driver became unreadable for job {job_id}: {problem}"
        )),
        RowPoll::NoStateWord => render_failed(format!(
            "the stock row driver answered no state word for job {job_id}"
        )),
        RowPoll::Expired => {
            // W2 + F2: the hot-wedge backstop. The row lands failed with its
            // correlation, and the cycle moves to its end legs instead of holding the
            // fence for a render that will never answer — but ONLY after the scoped
            // cancel has taken the render itself down (arm order: pending cancel,
            // then running interrupt), so the end legs never restore beside a live job.
            let problems = scope_cancel_expired(cancel, job_id).await;
            deadline_outcome(job_id, ROW_DEADLINE_MS, &problems)
        }
        RowPoll::QueuedStalled => {
            // W4-E: the same scoped-cancel drill as the deadline arm (pending
            // cancel first — the verb a queued job actually answers — then the
            // running interrupt, which refuses honestly and rides the detail).
            let problems = scope_cancel_expired(cancel, job_id).await;
            queued_stall_outcome(job_id, &problems)
        }
    }
}

/// The M24b outputs law for a succeeded RefMod export row (E28): the stock
/// status verb's `result.name` becomes the honest descriptor
/// `[{filename: "<name>.safetensors", subfolder: "refmods"}]`. LAW (manager
/// ruling, pinned here because the row report is where an operator reads it):
/// the safetensors lands in the backend's MODELS folder under the `refmods`
/// subfolder (on this box: `F:\Comfy Models\refmods`), NOT the ComfyUI output
/// root — so the §4.4 byte doors honestly do NOT serve it, and `GET
/// /v1/models?q=<name>` is its read home. The name rides the stock answer
/// VERBATIM (`jobs_refmod::history_state` already validated it against the
/// model grammar before ever answering `done`); this function invents no path
/// and re-validates nothing. A `done` answer without a usable name is the
/// honest nothing-to-show posture (`None`), mirroring the render arm's
/// [`snapshot_outputs`] law.
fn refmod_outputs(snapshot: &Value) -> Option<Value> {
    let name = snapshot.get("result")?.get("name")?.as_str()?;
    Some(json!([{ "filename": format!("{name}.safetensors"), "subfolder": "refmods" }]))
}

/// Maps a stock RefMod cancel refusal for the row detail (LEG AF2-M24b, item 6):
/// the stock `submitted()` law refuses an id this process never submitted, and
/// the §4 refmod doors answer that exact string with the closed `jobUnknown`
/// cause (results.rs, pinned by its source-lift test) — the row arm maps it the
/// same way, stock string verbatim behind the word. Every other refusal rides
/// verbatim.
fn export_cancel_refusal(problem: String, prompt_id: &str) -> String {
    if problem.starts_with("Unknown RefMod export") {
        return format!(
            "jobUnknown: {problem}; '{prompt_id}' is not a RefMod export this plane submitted"
        );
    }
    problem
}

/// The scoped cancel for an export row (item 6, LEG AF2-M24b): ONE call to the
/// stock scoped verb through the SAME bridge seam the row submitted through,
/// keyed by the backend prompt id the row carries. The stock verb decides the
/// placement itself — pending rows get the `{"delete"}` mutation, running rows
/// the authenticated DEAS interrupt adapter, a gone prompt answers
/// `{"cancelled":"none"}` — so the render arm's two-verb drill
/// ([`scope_cancel_expired`]) is stock-redundant here and one verb is the
/// honest arm. An acked posture leaves no problem note; a refusal rides
/// [`export_cancel_refusal`].
async fn scope_cancel_export(bridge: &dyn RefmodBridge, prompt_id: &str) -> Vec<String> {
    match bridge.cancel(prompt_id.to_owned()).await {
        Ok(_) => Vec::new(),
        Err(problem) => vec![export_cancel_refusal(problem, prompt_id)],
    }
}

/// Map one ended export poll to the row's outcome (LEG AF2-M24b) — the RefMod
/// sibling of [`poll_outcome`], split for the same reason: the word sets and the
/// outputs law differ, while the deadline/stall physics and the §5 poison
/// accounting stay shared. `done` is success with the [`refmod_outputs`]
/// descriptor; `failed`/`cancelled`/`missing` keep the stock detail words
/// verbatim (the excerpt law mirrors the render arm: the `error` word when the
/// answer carries one, else the state word). Every arm past submit is
/// render-side — `submit_failed: false`, correlation intact — exactly the §5
/// parity the manager ruled for export rows.
async fn refmod_poll_outcome(
    poll: RowPoll,
    prompt_id: &str,
    bridge: &dyn RefmodBridge,
) -> RowOutcome {
    let export_failed = |detail: String| RowOutcome {
        succeeded: false,
        detail: Some(detail),
        error_kind: None,
        submit_failed: false,
        job_id: Some(prompt_id.to_owned()),
        outputs: None,
    };
    match poll {
        RowPoll::Terminal(snapshot) => match snapshot["state"].as_str() {
            Some("done") => RowOutcome {
                succeeded: true,
                detail: None,
                error_kind: None,
                submit_failed: false,
                job_id: Some(prompt_id.to_owned()),
                outputs: refmod_outputs(&snapshot),
            },
            Some(word) => {
                let excerpt = snapshot["error"].as_str().unwrap_or(word).to_owned();
                export_failed(format!("export ended '{word}': {excerpt}"))
            }
            None => export_failed(format!(
                "the RefMod status verb answered no state word for export {prompt_id}"
            )),
        },
        RowPoll::Unreadable(problem) => export_failed(format!(
            "the RefMod status verb became unreadable for export {prompt_id}: {problem}"
        )),
        RowPoll::NoStateWord => export_failed(format!(
            "the RefMod status verb answered no state word for export {prompt_id}"
        )),
        RowPoll::Expired => {
            let problems = scope_cancel_export(bridge, prompt_id).await;
            deadline_outcome(prompt_id, ROW_DEADLINE_MS, &problems)
        }
        RowPoll::QueuedStalled => {
            let problems = scope_cancel_export(bridge, prompt_id).await;
            queued_stall_outcome(prompt_id, &problems)
        }
    }
}

/// The repair hint every prepareRefused report row carries (LEG M14c;
/// API-DESIGN §12.1 addendum: "`install_repair` surfaced on prereq refusals
/// ('update required' + repair hint)"). RULING this leg: the HINT is surfaced,
/// NOT a repair door. Stock `native_install_repair` (install.rs:1063) mutates
/// the DEAS environment: it passes `update_fence_gate` (install.rs:1078-1080,
/// refused while the cycle fence holds — the M10a D4 gate order, fence before
/// arming), arms the one-time pin through the confirm-gated `arm_pin_repair`,
/// then routes the whole `native_install_update` fetch-and-replace. That is an
/// owner-UI action with a full confirm wall behind it; exposing it on /v1 would
/// need the entire wall built here, and the design line asks only that the
/// refusal NAME the remedy. The hint is conditional in its own wording — the
/// update-required class is named when it applies, and a plain missing-model
/// refusal is not told it needs a repair.
const PREPARE_REFUSAL_HINT: &str = "if this refusal names DEAS-managed pieces that are missing or stale, it is the update-required class: repair the environment from the DEAS UI (install_repair re-fetches the pinned node packs and keeps models, inputs and outputs); the repair verb is deliberately not exposed on /v1 — environment mutation stays an owner action";

impl SubmitChain for StockSubmitChain {
    fn run_row(&self, row_id: &str, intent: Value) -> BoxFuture<'static, RowOutcome> {
        let app = self.app.clone();
        let spool = Arc::clone(&self.spool);
        let refmods = Arc::clone(&self.refmods);
        let row_id = row_id.to_owned();
        Box::pin(async move {
            use tauri::Manager as _;
            // E28 (LEG AF2-M24b): the RefMod export row arm — a drainable row
            // whose submission is the stock refmod export, not a Workbench
            // render. The shape law (`super::spool::is_refmod_export_intent`)
            // is the discriminator because the closed compile request never
            // carries the plane's recipe word. The arm runs its own gate +
            // bridge leg ([`run_refmod_row`]); the render path below it is
            // untouched, so every render-row law keeps its exact shipped wire.
            if super::spool::is_refmod_export_intent(&intent) {
                let engine = app.state::<crate::install::Engine>();
                let read_status = || {
                    let status = engine.backend.status();
                    async move { (status.state, status.endpoint) }
                };
                let liveness = StockQueueLiveness::new();
                return run_refmod_row(
                    &refmods,
                    &spool,
                    &row_id,
                    intent,
                    read_status,
                    &mut |base: String| liveness.probe(base),
                    BACKEND_READY_POLL_MS,
                    BACKEND_READY_TIMEOUT_MS,
                )
                .await;
            }
            let failed = |detail: String| RowOutcome {
                succeeded: false,
                detail: Some(detail),
                error_kind: None,
                submit_failed: true,
                job_id: None,
                outputs: None,
            };
            // E29 (LEG AF2-M24a): the gate and the prepare share one leg so the
            // readiness law is one home and one testable seam (W-L2: the old
            // single status read failed rows while the backend answered
            // `starting`). Failures before the row reached the backend count
            // toward the poison guard (§5: it guards submit, not mid-render).
            let engine = app.state::<crate::install::Engine>();
            let read_status = || {
                let status = engine.backend.status();
                async move { (status.state, status.endpoint) }
            };
            let liveness = StockQueueLiveness::new();
            let (plan_id, _prepared) = match pre_submit_leg(
                read_status,
                &mut |base: String| liveness.probe(base),
                BACKEND_READY_POLL_MS,
                BACKEND_READY_TIMEOUT_MS,
                intent,
                |base_url, intent| {
                    crate::jobs::native_job_prepare(
                        app.state::<crate::jobs::Jobs>(),
                        app.state::<crate::install::Engine>(),
                        base_url,
                        intent,
                    )
                },
            )
            .await
            {
                Ok(leg) => leg,
                Err(outcome) => return outcome,
            };
            // §14.6/E14: the drain rides the fence its own cell claimed — submit_inner's
            // stock gate refuses stock submitters, and this window is the cycle driver's
            // pass. Narrow on purpose: open for the submit call, closed for the poll loop.
            let pass = crate::resources::fence_owner_pass();
            let submitted = match crate::jobs::native_job_submit(
                app.state::<crate::jobs::Jobs>(),
                app.state::<crate::install::Engine>(),
                plan_id,
                true,
            )
            .await
            {
                Ok(submitted) => submitted,
                Err(problem) => return failed(format!("submit failed: {problem}")),
            };
            drop(pass);
            let job_id = match submitted["id"].as_str() {
                Some(job_id) => job_id.to_owned(),
                None => return failed("the stock submit answer carries no job id".to_owned()),
            };
            // M9a CORRELATION: weld the stock id to the spool row BEFORE the poll loop
            // starts, so the chain row id -> stock jobId -> HistoryRecord.id ->
            // outputs/cancel survives a wedged render, a dropped socket or a restart.
            // A failed correlation write is logged honestly and NEVER fails the row:
            // the row is already live on the backend, and a correlation gap is not a
            // render failure (the drain law simply cannot excuse that stock row later).
            if let Err(problem) = spool.set_job_id(&row_id, &job_id) {
                logs::push(
                    Source::Deas,
                    &format!(
                        "agent-api: could not correlate row {row_id} to stock job {job_id}: {problem}"
                    ),
                );
            }
            // From here the row is at the backend: its failures are ordinary batch
            // semantics, never poison-guard fuel, and they carry the correlation.
            // P6: terminal truth comes from the stock row driver, polled to its terminal
            // word under the row deadline (W2). `poll_row` owns the loop so the deadline
            // law is pinned by test without a live backend.
            let poll = poll_row(
                || crate::jobs::native_job_status(app.state::<crate::jobs::Jobs>(), job_id.clone()),
                ROW_POLL_GAP_MS,
                ROW_DEADLINE_MS,
                QUEUED_STALL_MS,
                &TERMINAL_ROW_WORDS,
            )
            .await;
            // The poll's end is the async block's tail: every arm answers the row's
            // outcome, and an expiry (F2, LEG AF2-M20) scoped-cancels the live job
            // through the stock workbench verbs BEFORE the deadline row rides the
            // report — the cycle's end legs never restore beside a live render.
            poll_outcome(poll, &job_id, &ChainScopedCancel { app: app.clone() }).await
        })
    }
}

/// The production surface behind the deadline path's scoped cancel: the same stock
/// workbench natives the watchdog's `StockWedgeControl` drives (the `jobs_cancel.rs`
/// `native_workbench_cancel_pending` / `native_workbench_interrupt_running`, called
/// in-process over the managed states with the same `confirmed=true` posture). Not a
/// new door: these verbs reach only the job id this plane correlated to the expired
/// row, and the fence the cycle holds keeps stock submitters out of the window.
struct ChainScopedCancel {
    app: tauri::AppHandle,
}

impl ScopedCancel for ChainScopedCancel {
    fn cancel_pending(&self, job_id: &str) -> BoxFuture<'static, Result<(), String>> {
        let app = self.app.clone();
        let job_id = job_id.to_owned();
        Box::pin(async move {
            use tauri::Manager as _;
            crate::jobs::native_workbench_cancel_pending(
                app.state::<crate::jobs::Jobs>(),
                app.state::<crate::install::Engine>(),
                job_id,
                true,
            )
            .await
            .map(|_| ())
        })
    }

    fn interrupt_running(&self, job_id: &str) -> BoxFuture<'static, Result<(), String>> {
        let app = self.app.clone();
        let job_id = job_id.to_owned();
        Box::pin(async move {
            use tauri::Manager as _;
            crate::jobs::native_workbench_interrupt_running(
                app.state::<crate::jobs::Jobs>(),
                app.state::<crate::install::Engine>(),
                job_id,
                true,
            )
            .await
            .map(|_| ())
        })
    }
}

/// Production startup-preset home: the approved environment's effective launch args,
/// read in-process through the managed Engine (the `native_startup_read` idiom —
/// [`crate::startup::args`] composes the same argv tail the launch passes, and every
/// input it needs is a file on disk plus the approved plan, so NO live backend is
/// asked and no process is started). `None` on any refusal: this is attribution, never
/// a dependency of the fault path.
pub(crate) struct StockStartupPreset {
    app: tauri::AppHandle,
}

impl StartupPreset for StockStartupPreset {
    fn effective_args(&self) -> Option<Vec<String>> {
        use tauri::Manager as _;
        let engine = self.app.try_state::<crate::install::Engine>()?;
        let plan = engine.approved_plan()?;
        crate::startup::args(Path::new(&plan.request.storage_path), Some(&plan)).ok()
    }
}

/// Production door: the owned backend's queue lists and the two-key `/free` wire.
/// The endpoint comes from the managed Engine, never a hardcoded port (the
/// uploads.rs running-endpoint idiom); the client mirrors resources.rs (no proxy,
/// no redirects).
pub(crate) struct StockBackendDoor {
    app: tauri::AppHandle,
}

/// Why the production door cannot address the backend — the W3-2 classification
/// lives here, at the source of the fact. The Engine reporting a backend that is
/// not running is the dead-backend class (crash recovery: the restore bat is how
/// the engine comes back). A backend CLAIMING `running` with an endpoint this
/// plane cannot address is an untrusted fact — it fail-closes to the queue-live
/// class, because the plane cannot prove nothing lives on that queue.
enum BaseFault {
    NotRunning(String),
    Unusable(String),
}

impl BaseFault {
    /// The honest detail either verb carries; the free door keeps its shipped
    /// wording verbatim through this split.
    fn detail(&self) -> &str {
        match self {
            Self::NotRunning(problem) | Self::Unusable(problem) => problem,
        }
    }
}

impl StockBackendDoor {
    /// The running owned backend's base URL, read from the managed Engine (the
    /// uploads.rs running-endpoint idiom; never a hardcoded port).
    fn base(app: &tauri::AppHandle) -> Result<reqwest::Url, BaseFault> {
        use tauri::Manager as _;
        let status = app.state::<crate::install::Engine>().backend.status();
        match (status.state.as_str(), status.endpoint) {
            ("running", Some(endpoint)) => reqwest::Url::parse(&endpoint).map_err(|problem| {
                BaseFault::Unusable(format!(
                    "backend endpoint '{endpoint}' is not a URL: {problem}"
                ))
            }),
            ("running", None) => Err(BaseFault::Unusable(
                "the owned backend reports running with no endpoint to reach".to_owned(),
            )),
            (state, _) => Err(BaseFault::NotRunning(format!(
                "no owned backend is running (state '{state}')"
            ))),
        }
    }

    pub(crate) fn client() -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|problem| format!("http client build failed: {problem}"))
    }
}

/* --------------------------- the backend-ready gate (E29) --------------------------- */

/// Where the backend-ready gate (E29) died when its window expired: the word stage
/// never saw the Engine answer `running` with an endpoint at all; the probe stage
/// did, but that endpoint's `/queue` never answered 200 — or `running` carried no
/// endpoint to probe, which is a wire-stage fact by the same door reading
/// ([`BaseFault::Unusable`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReadyStage {
    /// No tick ever yielded the `("running", Some(endpoint))` pair inside the window.
    Word,
    /// A tick yielded `running`, but the `/queue` probe never answered 200 inside
    /// the window (including `running` with no endpoint to address).
    Probe,
}

/// An expired backend-ready window: the LAST state word observed and the stage the
/// wait died at — the honest submit_failed/maintenanceActive detail E29 demands,
/// never a bare timeout. `window_ms` is the injected window (the production consts
/// at the call sites), `elapsed_ms` what the wait actually spent.
#[derive(Clone, Debug)]
pub(crate) struct BackendReadyFault {
    pub(crate) stage: ReadyStage,
    pub(crate) last_word: String,
    pub(crate) elapsed_ms: u64,
    pub(crate) window_ms: u64,
}

impl BackendReadyFault {
    /// The honest hint both wired callers carry: the last state word, the stage
    /// (never-ready vs ready-but-queue-never-answered) and the window that expired.
    pub(crate) fn detail(&self) -> String {
        match self.stage {
            ReadyStage::Word => format!(
                "the backend never reported running with an endpoint inside the {} ms ready window ({} ms elapsed; last state word '{}')",
                self.window_ms, self.elapsed_ms, self.last_word
            ),
            ReadyStage::Probe => format!(
                "the backend reported running but its /queue endpoint never answered inside the {} ms ready window ({} ms elapsed; last state word '{}')",
                self.window_ms, self.elapsed_ms, self.last_word
            ),
        }
    }
}

/// The gate's `/queue` liveness probe: true on HTTP 200; every wire failure (bad
/// route, refused connect, timeout, non-200) is a false tick, never an early exit.
/// `+ Send` on the dyn: the drain's row future is boxed `Send`, so the seam must
/// cross the task boundary like every other cycle seam.
pub(crate) type ReadyProbe<'a, ProbeFut> = &'a mut (dyn FnMut(String) -> ProbeFut + Send);

/// E29's ONE home: the bounded fact-wait every submit path runs before it hands a
/// row to the backend. Accepts ONLY the `("running", Some(endpoint))` pair AND a
/// 200 from that endpoint's own `/queue`; a warm backend passes on the first pair
/// of facts (zero added latency). Cadence and window are injectable — production
/// passes [`BACKEND_READY_POLL_MS`] / [`BACKEND_READY_TIMEOUT_MS`], tests run the
/// loop in milliseconds. The gate only ever READS status and probes: it never
/// starts, stops or restarts the backend (E27 law — the gate waits on facts, it
/// does not act). Mid-drain, every row passes through here; warm, that costs the
/// single status read the pre-E29 chain already made, plus the `/queue` proof.
pub(crate) async fn ready_backend<Read, ReadFut, ProbeFut>(
    mut read_status: Read,
    probe_queue: ReadyProbe<'_, ProbeFut>,
    poll_ms: u64,
    timeout_ms: u64,
) -> Result<reqwest::Url, BackendReadyFault>
where
    Read: FnMut() -> ReadFut,
    ReadFut: std::future::Future<Output = (String, Option<String>)> + Send,
    ProbeFut: std::future::Future<Output = bool> + Send,
{
    let started = Instant::now();
    // The last word seen on any tick: assigned on every iteration before any
    // read, declared uninit on purpose — there is no honest pre-first-tick word
    // to name, and the dead `None` store trips `unused_assignments`.
    let mut last_word: String;
    let mut stage = ReadyStage::Word;
    loop {
        let (state, endpoint) = read_status().await;
        if let Some(endpoint) = endpoint.filter(|_| state == "running") {
            // The word stage passed on this tick; the fact is only complete when
            // the endpoint answers its own queue. `running` with no endpoint is
            // the same wire-stage reading the door's `base` fail-close uses.
            stage = ReadyStage::Probe;
            last_word = "running".to_owned();
            match reqwest::Url::parse(&endpoint) {
                Ok(base) => {
                    if probe_queue(
                        base.join("queue")
                            .map(|queue| queue.into())
                            .unwrap_or(endpoint),
                    )
                    .await
                    {
                        return Ok(base);
                    }
                }
                Err(_) => {
                    // An endpoint that is not a URL cannot be probed at all.
                }
            }
        } else {
            last_word = state;
        }
        if started.elapsed() >= Duration::from_millis(timeout_ms) {
            // Checked BEFORE the sleep: a backend that turns ready on the final tick
            // must be caught, not slept past, and an expired window is exceeded by
            // at most one status read + probe, never by an extra sleep.
            return Err(BackendReadyFault {
                stage,
                last_word,
                elapsed_ms: started.elapsed().as_millis() as u64,
                window_ms: timeout_ms,
            });
        }
        tokio::time::sleep(Duration::from_millis(poll_ms)).await;
    }
}

/// The one `/queue` liveness probe, built once over the door's client idiom (no
/// proxy, no redirects): 200 answers true; an invalid route, any wire failure or
/// a non-200 answers a false tick — the gate polls on to its bound. Both wired
/// callers (the drain chain and the RefMod bridge) hand this to the gate, so the
/// probe is one home like the wait itself. It never starts, stops or restarts
/// anything (E27): a pure read.
pub(crate) struct StockQueueLiveness {
    client: Result<reqwest::Client, String>,
}

impl StockQueueLiveness {
    pub(crate) fn new() -> Self {
        Self {
            client: StockBackendDoor::client(),
        }
    }

    /// The gate-shaped probe: the route is resolved eagerly and the returned
    /// future owns it (the client stays borrowed via `&self`), so the probe is a
    /// re-entrant `FnMut` seam tick.
    pub(crate) fn probe(&self, base: String) -> impl std::future::Future<Output = bool> + '_ {
        let attempt = match self.client.as_ref() {
            Ok(client) => reqwest::Url::parse(&base)
                .and_then(|base| base.join("queue"))
                .ok()
                .map(|route| (client, route)),
            Err(_) => None,
        };
        async move {
            match attempt {
                Some((client, route)) => match client.get(route).send().await {
                    Ok(response) => response.status() == reqwest::StatusCode::OK,
                    Err(_) => false,
                },
                None => false,
            }
        }
    }
}

/// The pre-submit leg of the production chain, split from `run_row` the way
/// `poll_row` was: the gate law (E29) and the stock prepare each arrive through a
/// closure, so the whole leg — gate first, prepare only on ready facts — is
/// pinned by test without a live backend or managed states. The row is gated,
/// then prepared; BOTH failures stay `submit_failed` — the poison guard (§5)
/// counts anything that never reached a render, exactly as before this split.
pub(crate) async fn pre_submit_leg<Read, ReadFut, ProbeFut, Prepare, PrepareFut>(
    read_status: Read,
    probe_queue: ReadyProbe<'_, ProbeFut>,
    poll_ms: u64,
    timeout_ms: u64,
    intent: Value,
    prepare: Prepare,
) -> Result<(String, Value), RowOutcome>
where
    Read: FnMut() -> ReadFut,
    ReadFut: std::future::Future<Output = (String, Option<String>)> + Send,
    ProbeFut: std::future::Future<Output = bool> + Send,
    Prepare: FnOnce(String, Value) -> PrepareFut,
    PrepareFut: std::future::Future<Output = Result<Value, String>> + Send,
{
    let failed = |detail: String| RowOutcome {
        succeeded: false,
        detail: Some(detail),
        error_kind: None,
        submit_failed: true,
        job_id: None,
        outputs: None,
    };
    // E29: no submit before the readiness facts — the single status read that used
    // to stand here answered `starting` during a 30-60 s boot and failed the row
    // live (W-L2). The gate waits on the same facts inside the bounded window.
    let base_url = match ready_backend(read_status, probe_queue, poll_ms, timeout_ms).await {
        Ok(base) => base.into(),
        Err(fault) => return Err(failed(fault.detail())),
    };
    let prepared = match prepare(base_url, intent).await {
        Ok(prepared) => prepared,
        // The stock prepare answer refused the admitted intent (prereq,
        // allowlist, any prepare-side wall): taxonomy word + stock string
        // verbatim on the report row (LEG M12).
        Err(problem) => return Err(prepare_refused(problem)),
    };
    match prepared["id"].as_str() {
        Some(plan_id) => Ok((plan_id.to_owned(), prepared)),
        None => Err(failed(
            "the stock prepare answer carries no plan id".to_owned(),
        )),
    }
}

/// E28 (LEG AF2-M24b, owner law "REFMOD = DRAINABLE ROW for consistency"): the
/// RefMod export row arm of the production chain, split from `run_row` the way
/// [`pre_submit_leg`] and [`poll_row`] were — gate law, bridge verbs and
/// outcome mapping stay one seam testable with fake bridges, no backend and no
/// card.
///
/// The shape: the row's submission is the stock export, so the E29 gate runs
/// FIRST (the same [`ready_backend`] home, ready-only per E27) and there is NO
/// prepare step — the stock submit does `fill_h3_vaes` + `compile` internally.
/// This is therefore the GATE-ONLY sibling of [`pre_submit_leg`]. Both gate
/// expiry and submit refusal keep `submit_failed: true`: the §5 poison guard
/// counts export submits and render submits with one floor and one arithmetic.
/// The production bridge's own submit re-probes readiness (`endpoint_gated`,
/// LEG AF2-M24a): under this arm that costs one extra status read + `/queue`
/// probe on a warm backend (the gate fast path) and buys the honest posture if
/// the backend dies between the gate and the POST. Two probes, one law, no race.
///
/// CORRELATION CARVE-OUT (the M9a spine, widened by the manager for E28): the
/// row's `job_id` field carries the BACKEND PROMPT ID, not a Workbench job id.
/// The §4.4 job-keyed doors (`GET /v1/jobs/{id}`, cancel, outputs) answer
/// `jobUnknown` for it BY CONSTRUCTION — an export is never a Workbench row —
/// and the refmod-keyed doors (`GET /v1/refmods/{id}`,
/// `POST /v1/refmods/{id}/cancel`) are its read and cancel home. The write
/// stays the same [`Spool::set_job_id`] seam before the poll loop, so a wedged
/// export, a dropped socket or a restart still leaves the row traceable.
// Seam-injection family (the `pre_submit_leg`/`poll_row` idiom): every leg part
// stays a flat parameter so fakes drive each one independently — bundling the
// gate windows or the seam kit into a struct would hide the very seams the
// tests exist to pin. The lint exemption is stated, not silent: eight flat
// seams beat seven bundled ones here.
#[allow(clippy::too_many_arguments)]
async fn run_refmod_row<Read, ReadFut, ProbeFut>(
    bridge: &Arc<dyn RefmodBridge>,
    spool: &Spool,
    row_id: &str,
    request: Value,
    read_status: Read,
    probe_queue: ReadyProbe<'_, ProbeFut>,
    gate_poll_ms: u64,
    gate_timeout_ms: u64,
) -> RowOutcome
where
    Read: FnMut() -> ReadFut,
    ReadFut: std::future::Future<Output = (String, Option<String>)> + Send,
    ProbeFut: std::future::Future<Output = bool> + Send,
{
    let failed = |detail: String| RowOutcome {
        succeeded: false,
        detail: Some(detail),
        error_kind: None,
        submit_failed: true,
        job_id: None,
        outputs: None,
    };
    // E29 first: the export posts straight into the owned backend's `/prompt`
    // queue, so it stands under the same no-submit-before-readiness law as a
    // render row. An expired window carries the SAME fault words the render
    // arm reports (last state word, stage, window) and stays poison fuel.
    if let Err(fault) = ready_backend(read_status, probe_queue, gate_poll_ms, gate_timeout_ms).await
    {
        return failed(fault.detail());
    }
    let answer = match bridge.submit(request).await {
        Ok(answer) => answer,
        // The stock submit refused (compile wall, backend rejection, lost
        // reply): the stock sentence rides verbatim, the row is submit-side —
        // poison parity with the render arm's `submit failed:` posture.
        Err(problem) => return failed(format!("submit failed: {problem}")),
    };
    let prompt_id = match answer["promptId"].as_str() {
        Some(prompt_id) => prompt_id.to_owned(),
        None => return failed("the RefMod submit answer carries no prompt id".to_owned()),
    };
    // The correlation carve-out write (see the law comment on this function):
    // same seam, same before-the-poll position, same honest log-never-fails
    // law as the render arm — the export is already live on the backend.
    if let Err(problem) = spool.set_job_id(row_id, &prompt_id) {
        logs::push(
            Source::Deas,
            &format!(
                "agent-api: could not correlate row {row_id} to RefMod export {prompt_id}: {problem}"
            ),
        );
    }
    // P6 holds for exports too: terminal truth comes from the stock status
    // verb, polled on the render arm's cadence and deadline ([`ROW_DEADLINE_MS`]
    // — the row-class bound every drained row shares) with the EXPORT word set
    // ([`TERMINAL_REFMOD_WORDS`]): `queued`/`running` keep polling, the
    // queued-stall and row-deadline backstops are the same physics.
    let poll_bridge = Arc::clone(bridge);
    let poll = poll_row(
        {
            let prompt_id = prompt_id.clone();
            move || {
                let bridge = Arc::clone(&poll_bridge);
                let prompt_id = prompt_id.clone();
                bridge.status(prompt_id)
            }
        },
        ROW_POLL_GAP_MS,
        ROW_DEADLINE_MS,
        QUEUED_STALL_MS,
        &TERMINAL_REFMOD_WORDS,
    )
    .await;
    refmod_poll_outcome(poll, &prompt_id, bridge.as_ref()).await
}

impl BackendDoor for StockBackendDoor {
    fn queue_idle_proof(&self) -> BoxFuture<'static, Result<(), IdleProofFault>> {
        let app = self.app.clone();
        Box::pin(async move {
            let base = match Self::base(&app) {
                Ok(base) => base,
                Err(BaseFault::NotRunning(detail)) => {
                    return Err(IdleProofFault::new(ProofFault::BackendDown, detail))
                }
                Err(BaseFault::Unusable(detail)) => {
                    return Err(IdleProofFault::new(ProofFault::QueueLive, detail))
                }
            };
            let client = Self::client()
                .map_err(|problem| IdleProofFault::new(ProofFault::QueueLive, problem))?;
            let response = client
                .get(base.join("queue").map_err(|_| {
                    IdleProofFault::new(ProofFault::QueueLive, "invalid /queue route".to_owned())
                })?)
                .send()
                .await
                // W3-2 at the source: a CONNECT failure (refused — the process is
                // gone) is the dead-backend class. A timeout or any other wire
                // problem leaves the queue unproven, and unproven fail-closes to
                // queueLive: the plane will not restore beside a backend it merely
                // failed to reach inside the read window.
                .map_err(|problem| {
                    IdleProofFault::new(
                        if problem.is_connect() {
                            ProofFault::BackendDown
                        } else {
                            ProofFault::QueueLive
                        },
                        format!("queue read failed: {problem}"),
                    )
                })?
                .error_for_status()
                .map_err(|problem| {
                    IdleProofFault::new(
                        ProofFault::QueueLive,
                        format!("queue read refused: {problem}"),
                    )
                })?;
            let lists: Value = response.json().await.map_err(|problem| {
                IdleProofFault::new(
                    ProofFault::QueueLive,
                    format!("queue answer is not JSON: {problem}"),
                )
            })?;
            let running = lists["queue_running"].as_array().ok_or_else(|| {
                IdleProofFault::new(
                    ProofFault::QueueLive,
                    "backend queue answer carries no queue_running list".to_owned(),
                )
            })?;
            let pending = lists["queue_pending"].as_array().ok_or_else(|| {
                IdleProofFault::new(
                    ProofFault::QueueLive,
                    "backend queue answer carries no queue_pending list".to_owned(),
                )
            })?;
            if running.is_empty() && pending.is_empty() {
                Ok(())
            } else {
                Err(IdleProofFault::new(
                    ProofFault::QueueLive,
                    format!(
                        "backend queue not idle: {} running, {} pending",
                        running.len(),
                        pending.len()
                    ),
                ))
            }
        })
    }

    fn free(&self, body: Value) -> BoxFuture<'static, Result<(), String>> {
        let app = self.app.clone();
        Box::pin(async move {
            let base = Self::base(&app).map_err(|fault| fault.detail().to_owned())?;
            let client = Self::client()?;
            let response = client
                .post(
                    base.join("free")
                        .map_err(|_| "invalid /free route".to_owned())?,
                )
                .json(&body)
                .send()
                .await
                .map_err(|problem| format!("free request failed: {problem}"))?;
            // The stock ack shape (resources.rs): HTTP 200 with an EMPTY body.
            let status = response.status();
            let bytes = response
                .bytes()
                .await
                .map_err(|problem| format!("free answer unreadable: {problem}"))?;
            if status != reqwest::StatusCode::OK || !bytes.is_empty() {
                return Err(format!(
                    "backend did not acknowledge the release (status {status}, {} body bytes)",
                    bytes.len()
                ));
            }
            Ok(())
        })
    }

    fn output_stat(
        &self,
        subfolder: &str,
        filename: &str,
    ) -> BoxFuture<'static, Result<Option<OutputStat>, String>> {
        let app = self.app.clone();
        let subfolder = subfolder.to_owned();
        let filename = filename.to_owned();
        Box::pin(async move {
            let candidate = descriptor_path(&subfolder, &filename)?;
            // THE same root law the §4 byte doors walk: the approved environment's saved
            // `output` folder, its `ComfyUI/output` fallback otherwise — engine-owned,
            // read per call, never a guessed path (`media_star::output_root`, the home
            // [`super::PlaneState::output_root`] reads for the output bytes doors).
            let root = {
                use tauri::Manager as _;
                crate::media::star::output_root(&app.state::<crate::install::Engine>())
                    .map_err(|problem| format!("the owned output root is unreadable: {problem}"))?
            };
            let path = root.join(candidate);
            // A metadata read is a blocking fs call, so it goes off the task thread —
            // the same idiom [`StockCommandRunner::run`] uses for the operator's bat.
            tokio::task::spawn_blocking(move || stat_of(&path))
                .await
                .map_err(|problem| format!("the metadata read never ran: {problem}"))?
        })
    }
}

/// One metadata read of one candidate path: the size+mtime pair the AF2-M33 stability
/// law compares. `Ok(None)` is the honest not-on-disk answer (the file simply is not
/// there yet, or never was); `Err` is an unreadable fact — a permission denial, a
/// directory where a file was named, an mtime the platform will not state. Both shapes
/// are the walk's fail-open class; neither may fault a cycle.
fn stat_of(path: &Path) -> Result<Option<OutputStat>, String> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(problem) if problem.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(problem) => return Err(format!("metadata read failed: {problem}")),
    };
    if !meta.is_file() {
        return Err("the named descriptor is not a regular file".to_owned());
    }
    let modified_ms = meta
        .modified()
        .map_err(|problem| format!("mtime unreadable: {problem}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|problem| format!("mtime predates the unix epoch: {problem}"))?
        .as_millis();
    Ok(Some(OutputStat {
        size_bytes: meta.len(),
        modified_ms: u64::try_from(modified_ms).unwrap_or(u64::MAX),
    }))
}

/// Production correlation: the managed `Jobs` session's active ids (the same durable
/// fact the watchdog's wedge control reads, read here without touching that seam)
/// MINUS every id the spool already records, through the pure [`uncorrelated_ids`]
/// arithmetic. A row whose `jobId` is `None` excuses nothing; a terminal row's recorded
/// id excuses as well as a draining one.
pub(crate) struct StockRowCorrelation {
    app: tauri::AppHandle,
    spool: Arc<Spool>,
}

impl RowCorrelation for StockRowCorrelation {
    fn uncorrelated_rows(&self) -> BoxFuture<'static, Result<Vec<String>, String>> {
        let app = self.app.clone();
        let spool = Arc::clone(&self.spool);
        Box::pin(async move {
            use tauri::Manager as _;
            let active = app.state::<crate::jobs::Jobs>().active_job_ids();
            if active.is_empty() {
                // The common case needs no spool read at all: nothing held, nothing
                // to correlate, the drain is clear.
                return Ok(Vec::new());
            }
            let recorded = spool.snapshot()?.into_iter().filter_map(|row| row.job_id);
            Ok(uncorrelated_ids(active, recorded))
        })
    }

    fn active_refmod_exports(&self) -> BoxFuture<'static, Result<Vec<String>, String>> {
        let spool = Arc::clone(&self.spool);
        Box::pin(async move {
            // The ledger read is the process-local static beside the stock
            // verbs themselves (`jobs_refmod::active_exports`, LEG AF2-M24b,
            // visibility-only): this process submitted what it holds, so the
            // fact is OWNERSHIP, not queue state — no endpoint read is needed
            // or wanted, and the common empty answer needs no spool read.
            let exports = crate::jobs::refmod::active_exports();
            if exports.is_empty() {
                return Ok(Vec::new());
            }
            // The same excusing arithmetic as the render law: an export whose
            // backend prompt id a spool row already records is that row's own
            // (E28 correlation carve-out) — a refmod row excuses its own
            // export exactly like a render row excuses its own stock job.
            let recorded = spool.snapshot()?.into_iter().filter_map(|row| row.job_id);
            Ok(uncorrelated_ids(exports, recorded))
        })
    }
}

/// Production gate: the app-wide compute semaphore (resources.rs:28).
pub(crate) struct StockComputeGate;

impl ComputeGate for StockComputeGate {
    fn reserve(&self) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
        crate::resources::reserve_compute()
    }
}

/// Production health probe: loopback-only (§7.4 wall). A non-loopback `readyUrl`
/// never leaves the machine — the probe honestly answers unhealthy.
pub(crate) struct StockHealthProbe;

impl StockHealthProbe {
    fn loopback(url: &reqwest::Url) -> bool {
        match url.host_str() {
            Some(host) => {
                let host = host.trim_matches(['[', ']']);
                host == "localhost"
                    || host == "::1"
                    || host
                        .parse::<std::net::Ipv4Addr>()
                        .is_ok_and(|v4| v4.is_loopback())
                    || host
                        .parse::<std::net::Ipv6Addr>()
                        .is_ok_and(|v6| v6.is_loopback())
            }
            None => false,
        }
    }
}

impl HealthProbe for StockHealthProbe {
    fn probe(&self, url: &str) -> BoxFuture<'static, bool> {
        let url = url.to_owned();
        Box::pin(async move {
            let parsed = match reqwest::Url::parse(&url) {
                Ok(parsed) if Self::loopback(&parsed) => parsed,
                _ => return false,
            };
            let client = match reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()
            {
                Ok(client) => client,
                Err(_) => return false,
            };
            match client.get(parsed).send().await {
                Ok(response) => response.status() == reqwest::StatusCode::OK,
                Err(_) => false,
            }
        })
    }
}

/// Production timer.
pub(crate) struct TokioPacer;

impl Pacer for TokioPacer {
    fn pause(&self, millis: u64) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(Duration::from_millis(millis)))
    }
}

/* ------------------------------ test seams ------------------------------ */

#[cfg(test)]
mod fakes {
    use super::*;

    /// Scripted continuity session views (AF2-M32 test seam): answers one canned
    /// view for any session id and records every id read — the proof the resolution
    /// leg touches the endpoint exactly when the law says and never otherwise.
    pub(crate) struct ScriptSessions {
        pub(crate) answer: std::sync::Mutex<Result<Value, String>>,
        pub(crate) reads: Mutex<Vec<String>>,
    }

    #[cfg(test)]
    impl ScriptSessions {
        /// The honest idle posture: a test that never queues a story row never
        /// reaches this seam; one that does without scripting a view gets the
        /// refusal (an ordinary row failure, never a silent pass).
        pub(crate) fn idle() -> Self {
            Self {
                answer: Mutex::new(Err("no scripted session view".to_owned())),
                reads: Mutex::new(Vec::new()),
            }
        }
        /// The scripted stock view, verbatim.
        pub(crate) fn viewing(view: Value) -> Self {
            Self {
                answer: Mutex::new(Ok(view)),
                reads: Mutex::new(Vec::new()),
            }
        }
    }

    #[cfg(test)]
    impl SessionRead for ScriptSessions {
        fn session(&self, session: String) -> BoxFuture<'static, Result<Value, String>> {
            self.reads
                .lock()
                .unwrap_or_else(|entry| entry.into_inner())
                .push(session);
            let answer = self
                .answer
                .lock()
                .unwrap_or_else(|entry| entry.into_inner())
                .clone();
            Box::pin(async move { answer })
        }
    }

    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

    /// Records every bat argv, answers scripted exits. The operator's strings are
    /// never executed in tests (the brief's law).
    pub(crate) struct ScriptCommands {
        pub(crate) runs: Mutex<Vec<String>>,
        /// The per-leg timeout each call carried (W1): the seam-boundary proof that the
        /// unload leg gets the unload budget and every restore leg — the cycle's and the
        /// watchdog arm's — gets the restore one.
        pub(crate) budgets: Mutex<Vec<u64>>,
        pub(crate) unload_exit: std::sync::atomic::AtomicI32,
        pub(crate) restore_exit: std::sync::atomic::AtomicI32,
    }

    impl ScriptCommands {
        pub(crate) fn clean() -> Self {
            Self {
                runs: Mutex::new(Vec::new()),
                budgets: Mutex::new(Vec::new()),
                unload_exit: std::sync::atomic::AtomicI32::new(0),
                restore_exit: std::sync::atomic::AtomicI32::new(0),
            }
        }
        /// The scripted unload exit, set after construction (plane-level drills).
        pub(crate) fn set_unload_exit(&self, exit: i32) {
            self.unload_exit
                .store(exit, std::sync::atomic::Ordering::SeqCst);
        }
    }

    impl CommandRunner for ScriptCommands {
        fn run(&self, command: &str, timeout_ms: u64) -> BoxFuture<'static, Result<i32, String>> {
            let exit = if command.contains("unload") {
                self.unload_exit.load(std::sync::atomic::Ordering::SeqCst)
            } else {
                self.restore_exit.load(std::sync::atomic::Ordering::SeqCst)
            };
            self.runs
                .lock()
                .expect("command log")
                .push(command.to_owned());
            self.budgets.lock().expect("budget log").push(timeout_ms);
            Box::pin(async move { Ok(exit) })
        }
    }

    /// Scripted per-row terminal postures, consumed in drain order. `with_spool`
    /// wires the M9a correlation drill: the fake then performs the correlation write
    /// at the SAME point the production chain does — the moment the stock id exists,
    /// before it "polls" — and parks what the row carried at that instant, so the
    /// ORDER is pinned by test and not just the end state.
    pub(crate) struct ScriptChain {
        pub(crate) script: Mutex<VecDeque<RowOutcome>>,
        pub(crate) seen: Mutex<Vec<Value>>,
        pub(crate) spool: Mutex<Option<Arc<Spool>>>,
        pub(crate) recorded: Mutex<Vec<(String, Option<String>)>>,
    }

    impl ScriptChain {
        pub(crate) fn all_done() -> Self {
            Self {
                script: Mutex::new(VecDeque::new()),
                seen: Mutex::new(Vec::new()),
                spool: Mutex::new(None),
                recorded: Mutex::new(Vec::new()),
            }
        }
        pub(crate) fn scripted(script: Vec<RowOutcome>) -> Self {
            Self {
                script: Mutex::new(script.into()),
                seen: Mutex::new(Vec::new()),
                spool: Mutex::new(None),
                recorded: Mutex::new(Vec::new()),
            }
        }
        /// Mounts the spool the correlation write lands on (drills for the M9a law).
        pub(crate) fn with_spool(self, spool: Arc<Spool>) -> Self {
            *self.spool.lock().expect("spool slot") = Some(spool);
            self
        }
        /// The `&self` mount (LEG AF2-M24c): a chain already behind an `Arc` — the
        /// RefMod arm-selecting chain holds its render chain by value — still gets
        /// the correlation spool.
        pub(crate) fn mount_spool(&self, spool: Arc<Spool>) {
            *self.spool.lock().expect("spool slot") = Some(spool);
        }
    }

    impl SubmitChain for ScriptChain {
        fn run_row(&self, row_id: &str, intent: Value) -> BoxFuture<'static, RowOutcome> {
            self.seen.lock().expect("chain log").push(intent);
            let outcome = self
                .script
                .lock()
                .expect("chain script")
                .pop_front()
                .unwrap_or(RowOutcome {
                    succeeded: true,
                    detail: None,
                    error_kind: None,
                    submit_failed: false,
                    job_id: None,
                    outputs: None,
                });
            if let Some(spool) = self.spool.lock().expect("spool slot").clone() {
                if let Some(job_id) = outcome.job_id.as_deref() {
                    spool
                        .set_job_id(row_id, job_id)
                        .expect("the scripted chain correlates a draining row");
                }
                self.recorded.lock().expect("record log").push((
                    row_id.to_owned(),
                    spool
                        .snapshot()
                        .expect("healthy")
                        .into_iter()
                        .find(|row| row.id == row_id)
                        .and_then(|row| row.job_id),
                ));
            }
            Box::pin(async move { outcome })
        }
    }

    /// The E28 arm-selecting test chain (LEG AF2-M24c): the shipped
    /// `StockSubmitChain::run_row` discriminator, replayed over scripted seams —
    /// a RefMod export intent (the `spool::is_refmod_export_intent` shape law,
    /// the ONE discriminator) runs the REAL `run_refmod_row` leg (E29 gate ->
    /// bridge submit -> poll -> terminal outcome) over the harness's RefMod
    /// bridge; every other intent delegates to the inner scripted chain. The
    /// acceptance harness needs exactly this: without it a refmod ROW would
    /// drain through the render fake and never touch the export arm, so the
    /// queue-door-to-terminal-report chain (the E28 promise) could not be
    /// pinned end to end. The gate legs answer the ready facts a warm owned
    /// backend states (the same posture the cycle seams' healthy fakes hold);
    /// the timing consts are the shipped ones, like production.
    pub(crate) struct ScriptRefmodChain {
        pub(crate) bridge: Arc<dyn RefmodBridge>,
        pub(crate) render: Arc<ScriptChain>,
    }

    impl ScriptRefmodChain {
        pub(crate) fn over(bridge: Arc<dyn RefmodBridge>) -> Self {
            Self {
                bridge,
                render: Arc::new(ScriptChain::all_done()),
            }
        }
    }

    impl SubmitChain for ScriptRefmodChain {
        fn run_row(&self, row_id: &str, intent: Value) -> BoxFuture<'static, RowOutcome> {
            if !super::super::spool::is_refmod_export_intent(&intent) {
                return self.render.run_row(row_id, intent);
            }
            let bridge = Arc::clone(&self.bridge);
            let spool = self
                .render
                .spool
                .lock()
                .expect("spool slot")
                .clone()
                .expect("the refmod chain drains a mounted spool");
            let row_id = row_id.to_owned();
            Box::pin(async move {
                run_refmod_row(
                    &bridge,
                    &spool,
                    &row_id,
                    intent,
                    || async {
                        (
                            "running".to_owned(),
                            Some("http://127.0.0.1:8188".to_owned()),
                        )
                    },
                    &mut |_base: String| async { true },
                    BACKEND_READY_POLL_MS,
                    BACKEND_READY_TIMEOUT_MS,
                )
                .await
            })
        }
    }

    /// Scripted ack postures; records the free body bytes for the wire-law test.
    /// `free_postures` is consumed one entry per attempt, in order; when the script
    /// runs out, `free_fallback` answers (an accepting door needs no script).
    /// A fixed startup-preset home. `None` is the unreadable posture — the fault must
    /// keep its exact two-key shape through it, never a new failure.
    pub(crate) struct FixedStartupPreset {
        pub(crate) args: Option<Vec<String>>,
    }

    impl FixedStartupPreset {
        /// The degraded posture: the effective args cannot be read in-process.
        pub(crate) fn unreadable() -> Self {
            Self { args: None }
        }
        /// The saved-preset args, verbatim (flags and values alike).
        pub(crate) fn with(args: &[&str]) -> Self {
            Self {
                args: Some(args.iter().map(|arg| (*arg).to_owned()).collect()),
            }
        }
    }

    impl StartupPreset for FixedStartupPreset {
        fn effective_args(&self) -> Option<Vec<String>> {
            self.args.clone()
        }
    }

    pub(crate) struct ScriptDoor {
        pub(crate) idle_ok: bool,
        /// W3-2: the class a scripted proof failure carries (`accepting()` defaults
        /// to the queue-live posture — the wording of the shipped script).
        pub(crate) idle_class: ProofFault,
        /// Per-call proof postures consumed in order (W3-5 drills: first the
        /// drain's proof, then the settle's re-probes); when empty, the `idle_ok`
        /// fallback answers every call.
        pub(crate) proof_script: Mutex<VecDeque<Result<(), IdleProofFault>>>,
        /// W3-6 drill mount: when set, the door notes a completed sever latch onto
        /// this cell from INSIDE the free call — the await window the end-leg
        /// latch probes exist to close. Unset everywhere else.
        pub(crate) latch_on_free: Mutex<Option<Arc<CycleCell>>>,
        pub(crate) free_postures: Mutex<VecDeque<bool>>,
        pub(crate) free_fallback: bool,
        pub(crate) free_bodies: Mutex<Vec<Value>>,
        pub(crate) free_calls: AtomicU32,
        pub(crate) proof_calls: AtomicU32,
        /// AF2-M33 scripted stability postures: `stat_script` is consumed one entry per
        /// output read (whatever descriptor is read — the drills drive one file), `None`
        /// answering the honest not-on-disk class. When the script runs out,
        /// `stat_growing` answers a file that gets bigger on EVERY read (the never-
        /// settling mux class the walk bound exists to fail open on), else
        /// `stat_fallback` answers unchanged (the accepting posture: identical twice,
        /// settled in one gap). `stat_reads` records every (`subfolder`, `filename`)
        /// pair the walk addressed and `stat_calls` counts the reads, so "never called
        /// when no row produced outputs" is pinned by the counter, not by timing.
        pub(crate) stat_script: Mutex<VecDeque<Option<OutputStat>>>,
        pub(crate) stat_growing: bool,
        pub(crate) stat_fallback: OutputStat,
        pub(crate) stat_reads: Mutex<Vec<(String, String)>>,
        pub(crate) stat_calls: AtomicU32,
        pub(crate) stat_tally: AtomicU64,
    }

    impl ScriptDoor {
        pub(crate) fn accepting() -> Self {
            Self {
                idle_ok: true,
                idle_class: ProofFault::QueueLive,
                proof_script: Mutex::new(VecDeque::new()),
                latch_on_free: Mutex::new(None),
                free_postures: Mutex::new(VecDeque::new()),
                free_fallback: true,
                free_bodies: Mutex::new(Vec::new()),
                free_calls: AtomicU32::new(0),
                proof_calls: AtomicU32::new(0),
                stat_script: Mutex::new(VecDeque::new()),
                stat_growing: false,
                stat_fallback: OutputStat {
                    size_bytes: 4096,
                    modified_ms: 1_700_000_000_000,
                },
                stat_reads: Mutex::new(Vec::new()),
                stat_calls: AtomicU32::new(0),
                stat_tally: AtomicU64::new(0),
            }
        }
        /// An accepting door whose free acks follow the scripted postures, in order.
        pub(crate) fn free_scripted(postures: impl IntoIterator<Item = bool>) -> Self {
            let door = Self::accepting();
            *door.free_postures.lock().expect("free script") = postures.into_iter().collect();
            door
        }
        /// A door whose idle proof fails with the scripted class (W3-2 drills).
        pub(crate) fn proof_failing(class: ProofFault) -> Self {
            let mut door = Self::accepting();
            door.idle_ok = false;
            door.idle_class = class;
            door
        }
        /// A door whose output reads follow the scripted stability postures, in order
        /// (AF2-M33 drills): each entry is one read's answer, `None` = not on disk.
        pub(crate) fn stats(script: impl IntoIterator<Item = Option<OutputStat>>) -> Self {
            let door = Self::accepting();
            *door.stat_script.lock().expect("stat script") = script.into_iter().collect();
            door
        }
        /// A door whose output reads NEVER settle: every read reports a bigger file —
        /// the never-ending mux/encode class the walk bound exists to fail open on.
        pub(crate) fn stats_growing() -> Self {
            let mut door = Self::accepting();
            door.stat_growing = true;
            door
        }
    }

    impl BackendDoor for ScriptDoor {
        fn queue_idle_proof(&self) -> BoxFuture<'static, Result<(), IdleProofFault>> {
            self.proof_calls.fetch_add(1, Ordering::SeqCst);
            let scripted = self.proof_script.lock().expect("proof script").pop_front();
            let ok = self.idle_ok;
            let class = self.idle_class;
            Box::pin(async move {
                if let Some(posture) = scripted {
                    return posture;
                }
                if ok {
                    Ok(())
                } else {
                    Err(IdleProofFault::new(
                        class,
                        "scripted: foreign rows hold the backend queue",
                    ))
                }
            })
        }
        fn free(&self, body: Value) -> BoxFuture<'static, Result<(), String>> {
            self.free_calls.fetch_add(1, Ordering::SeqCst);
            self.free_bodies.lock().expect("free log").push(body);
            // W3-6 drill: an arm latching DURING the drain's free await — the exact
            // window between the drain's post-proof latch check and its restore
            // gate. Only the latch-mid-free test mounts this.
            if let Some(cell) = self.latch_on_free.lock().expect("latch mount").clone() {
                cell.note_sever(json!({
                    "reason": super::super::watchdog::FAULT_SEVER,
                    "severedRow": "row-a",
                    "freed": true,
                    "restored": true,
                }));
            }
            let ok = self
                .free_postures
                .lock()
                .expect("free script")
                .pop_front()
                .unwrap_or(self.free_fallback);
            Box::pin(async move {
                if ok {
                    Ok(())
                } else {
                    Err("scripted: no ack (200 + empty body)".to_owned())
                }
            })
        }
        fn output_stat(
            &self,
            subfolder: &str,
            filename: &str,
        ) -> BoxFuture<'static, Result<Option<OutputStat>, String>> {
            self.stat_calls.fetch_add(1, Ordering::SeqCst);
            self.stat_reads
                .lock()
                .expect("stat log")
                .push((subfolder.to_owned(), filename.to_owned()));
            let scripted = self.stat_script.lock().expect("stat script").pop_front();
            let growing = self.stat_growing;
            let fallback = self.stat_fallback;
            let read = self.stat_tally.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if let Some(posture) = scripted {
                    return Ok(posture);
                }
                if growing {
                    return Ok(Some(OutputStat {
                        size_bytes: fallback.size_bytes + read + 1,
                        modified_ms: fallback.modified_ms,
                    }));
                }
                Ok(Some(fallback))
            })
        }
    }

    /// Scripted correlation postures for the M9a drain law: the foreign ids the stock
    /// session would report as active-but-uncorrelated. `clean` is the go-ahead; a
    /// `unreadable` seam pins the fail-closed half of the law.
    pub(crate) struct ScriptCorrelation {
        pub(crate) uncorrelated: Mutex<Vec<String>>,
        pub(crate) problem: Mutex<Option<String>>,
        /// E28 (LEG AF2-M24b): the scripted live-export postures for the
        /// widened law — `clean()`/`foreign()`/`unreadable()` hold none (the
        /// go-ahead), `with_exports` seeds them, `exports_unreadable` pins the
        /// fail-closed half of the export read alone.
        pub(crate) exports: Mutex<Vec<String>>,
        pub(crate) exports_problem: Mutex<Option<String>>,
        pub(crate) calls: AtomicU32,
    }

    impl ScriptCorrelation {
        pub(crate) fn clean() -> Self {
            Self {
                uncorrelated: Mutex::new(Vec::new()),
                problem: Mutex::new(None),
                exports: Mutex::new(Vec::new()),
                exports_problem: Mutex::new(None),
                calls: AtomicU32::new(0),
            }
        }
        /// A session holding active stock jobs no spool row is correlated to.
        pub(crate) fn foreign(ids: impl IntoIterator<Item = impl Into<String>>) -> Self {
            Self {
                uncorrelated: Mutex::new(ids.into_iter().map(Into::into).collect()),
                problem: Mutex::new(None),
                exports: Mutex::new(Vec::new()),
                exports_problem: Mutex::new(None),
                calls: AtomicU32::new(0),
            }
        }
        /// The correlation fact itself cannot be read (a corrupt spool, a lost
        /// session): the law must fail closed, never treat the unknown as clean.
        pub(crate) fn unreadable(problem: &str) -> Self {
            Self {
                uncorrelated: Mutex::new(Vec::new()),
                problem: Mutex::new(Some(problem.to_owned())),
                exports: Mutex::new(Vec::new()),
                exports_problem: Mutex::new(None),
                calls: AtomicU32::new(0),
            }
        }
        /// A live RefMod export no spool row is correlated to (E28, LEG
        /// AF2-M24b): the door-path hazard the drain must refuse while it runs.
        pub(crate) fn with_exports(ids: impl IntoIterator<Item = impl Into<String>>) -> Self {
            Self {
                uncorrelated: Mutex::new(Vec::new()),
                problem: Mutex::new(None),
                exports: Mutex::new(ids.into_iter().map(Into::into).collect()),
                exports_problem: Mutex::new(None),
                calls: AtomicU32::new(0),
            }
        }
        /// The export ledger alone cannot be read: the same fail-closed law on
        /// the widened half.
        pub(crate) fn exports_unreadable(problem: &str) -> Self {
            Self {
                uncorrelated: Mutex::new(Vec::new()),
                problem: Mutex::new(None),
                exports: Mutex::new(Vec::new()),
                exports_problem: Mutex::new(Some(problem.to_owned())),
                calls: AtomicU32::new(0),
            }
        }
    }

    impl RowCorrelation for ScriptCorrelation {
        fn uncorrelated_rows(&self) -> BoxFuture<'static, Result<Vec<String>, String>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(problem) = self.problem.lock().expect("correlation script").clone() {
                return Box::pin(async move { Err(problem) });
            }
            let ids = self
                .uncorrelated
                .lock()
                .expect("correlation script")
                .clone();
            Box::pin(async move { Ok(ids) })
        }

        fn active_refmod_exports(&self) -> BoxFuture<'static, Result<Vec<String>, String>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(problem) = self.exports_problem.lock().expect("export script").clone() {
                return Box::pin(async move { Err(problem) });
            }
            let ids = self.exports.lock().expect("export script").clone();
            Box::pin(async move { Ok(ids) })
        }
    }

    /// A private gate with more permits than one cycle ever takes; records the
    /// reserve count so the release/reacquire dance around the submit legs is
    /// visible to tests without touching the process-wide compute semaphore.
    pub(crate) struct ScriptGate {
        pub(crate) inner: std::sync::Arc<tokio::sync::Semaphore>,
        pub(crate) reserves: AtomicU32,
    }

    impl ScriptGate {
        pub(crate) fn open() -> Self {
            Self {
                inner: std::sync::Arc::new(tokio::sync::Semaphore::new(8)),
                reserves: AtomicU32::new(0),
            }
        }
    }

    impl ComputeGate for ScriptGate {
        fn reserve(&self) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
            self.reserves.fetch_add(1, Ordering::SeqCst);
            self.inner
                .clone()
                .try_acquire_owned()
                .map_err(|_| "scripted gate busy".to_owned())
        }
    }

    /// Scripted readiness postures; counts probes so the stop-at-first-healthy law
    /// is pinned by the probe count, never by timing. When the script runs out the
    /// fallback posture answers (healthy fakes never need an endless script).
    pub(crate) struct ScriptHealth {
        pub(crate) posture: Mutex<VecDeque<bool>>,
        pub(crate) fallback: bool,
        pub(crate) probes: AtomicU32,
    }

    impl ScriptHealth {
        pub(crate) fn always_healthy() -> Self {
            Self {
                posture: Mutex::new(VecDeque::new()),
                fallback: true,
                probes: AtomicU32::new(0),
            }
        }
        pub(crate) fn scripted(postures: impl IntoIterator<Item = bool>) -> Self {
            Self {
                posture: Mutex::new(postures.into_iter().collect()),
                fallback: false,
                probes: AtomicU32::new(0),
            }
        }
    }

    impl HealthProbe for ScriptHealth {
        fn probe(&self, _url: &str) -> BoxFuture<'static, bool> {
            self.probes.fetch_add(1, Ordering::SeqCst);
            let answer = self
                .posture
                .lock()
                .expect("health script")
                .pop_front()
                .unwrap_or(self.fallback);
            Box::pin(async move { answer })
        }
    }

    /// Records every duration the machine asked for; returns instantly, so the
    /// timing consts are pinned by their recorded call values, not by wall clock.
    pub(crate) struct ScriptPacer {
        pub(crate) pauses: Mutex<Vec<u64>>,
    }

    impl ScriptPacer {
        pub(crate) fn recording() -> Self {
            Self {
                pauses: Mutex::new(Vec::new()),
            }
        }
    }

    impl Pacer for ScriptPacer {
        fn pause(&self, millis: u64) -> BoxFuture<'static, ()> {
            self.pauses.lock().expect("pacer log").push(millis);
            Box::pin(async move {})
        }
    }
}

#[cfg(test)]
pub(crate) use fakes::{
    FixedStartupPreset, ScriptChain, ScriptCommands, ScriptCorrelation, ScriptDoor, ScriptGate,
    ScriptHealth, ScriptPacer, ScriptRefmodChain,
};

#[cfg(test)]
mod tests {
    use super::super::fill_plane;
    use super::*;
    use crate::agent_api::defaults::DefaultsSheet;
    use std::sync::atomic::Ordering;

    /// A door-complete row for the tempdir spool (same fixture shape as spool.rs).
    fn queued_row(id: &str) -> QueueRow {
        let extras: serde_json::Map<String, Value> = serde_json::from_value(json!({
            "checkpoint": "anima/something.safetensors",
            "positivePrompt": format!("row {id}"),
            "outputPrefix": "agent/run",
            "diffusion": {
                "textEncoder": "qwen3-0.6b.safetensors",
                "clipType": "stable_diffusion",
                "vae": "wan_2.1_vae.safetensors",
                "family": "anima"
            }
        }))
        .expect("fixture extras");
        let plan = fill_plane::fill(
            "anima",
            "t2i",
            None,
            &DefaultsSheet::default(),
            Some(&extras),
        )
        .expect("fixture fills")
        .plan();
        let mut row = QueueRow::from_plan(&plan).expect("row builds");
        row.id = id.to_owned();
        row
    }

    fn guard(auto: bool, free_on_end: bool) -> GuardConfig {
        GuardConfig {
            unload_command: "unload.bat /agent".to_owned(),
            restore_command: "restore.bat /agent".to_owned(),
            ready_url: "http://127.0.0.1:18502/health".to_owned(),
            auto_cycle_vram: auto,
            free_on_queue_end: free_on_end,
            watchdog: super::super::watchdog::WatchdogConfig::default(),
            caps: super::super::caps::Caps::default(),
        }
    }

    struct Harness {
        dir: tempfile::TempDir,
        spool: Arc<Spool>,
        cell: Arc<CycleCell>,
        commands: Arc<ScriptCommands>,
        door: Arc<ScriptDoor>,
        correlation: Arc<ScriptCorrelation>,
        health: Arc<ScriptHealth>,
        pacer: Arc<ScriptPacer>,
        gate: Arc<ScriptGate>,
        startup: Arc<FixedStartupPreset>,
    }

    impl Harness {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let spool = Arc::new(Spool::new(dir.path()));
            let cell = Arc::new(CycleCell::new(dir.path()));
            let commands = Arc::new(ScriptCommands::clean());
            let door = Arc::new(ScriptDoor::accepting());
            let correlation = Arc::new(ScriptCorrelation::clean());
            let health = Arc::new(ScriptHealth::always_healthy());
            let pacer = Arc::new(ScriptPacer::recording());
            let gate = Arc::new(ScriptGate::open());
            let startup = Arc::new(FixedStartupPreset::unreadable());
            Self {
                dir,
                spool,
                cell,
                commands,
                door,
                correlation,
                health,
                pacer,
                gate,
                startup,
            }
        }

        fn seams(&self, chain: Arc<ScriptChain>) -> Arc<CycleSeams> {
            Arc::new(CycleSeams {
                commands: self.commands.clone(),
                chain,
                door: self.door.clone(),
                correlation: self.correlation.clone(),
                gate: self.gate.clone(),
                health: self.health.clone(),
                pacer: self.pacer.clone(),
                startup: self.startup.clone(),
            })
        }

        async fn run(&self, chain: ScriptChain, guard: GuardConfig) -> Value {
            for id in ["row-a", "row-b", "row-c"] {
                // Rows are id-pinned; the harness drives them in spool order.
                self.spool.append(&queued_row(id)).expect("row queued");
            }
            let first_phase = if guard.auto_cycle_vram {
                CyclePhase::Unloading
            } else {
                CyclePhase::Draining
            };
            let cycle_id = self.cell.claim(first_phase).expect("claim");
            let seams = self.seams(Arc::new(chain));
            drive(CycleRun {
                cell: self.cell.clone(),
                seams,
                spool: self.spool.clone(),
                guard,
                cycle_id,
                sessions: Arc::new(fakes::ScriptSessions::idle()),
            })
            .await
        }
    }

    #[test]
    fn timing_consts_are_pinned_to_the_measured_numbers() {
        let _gate = crate::resources::fence_test_gate();
        assert_eq!(SETTLE_MS, 2_000);
        assert_eq!(DOWN_HOLD_MS, 500);
        assert_eq!(PATIENCE_MS, 4_500);
        assert_eq!(PATIENCE_MS, 2_500 + 2_000, "welded, not rounded");
        assert_eq!(HEALTH_PROBE_GAP_MS, 2_000);
        assert_eq!(RESTORE_ATTEMPT_BOUND, 3);
        assert_eq!(FREE_ATTEMPT_BOUND, 3, "§10: retry free, bound 3 per cycle");
        assert_eq!(RESTORE_GAP_MS, 90_000);
        // The never-forever budgets (LEG AF2-M18a): the row poll's hot-wedge backstop
        // and the two bat legs. These are the numbers that keep a wedge from becoming a
        // parked fence, so they are pinned, not left to drift.
        assert_eq!(
            ROW_DEADLINE_MS, 3_600_000,
            "60 min (LEG AF2-M20 F2/TIMING): the watchdog covers idle wedges, this covers the hot ones, and the scoped cancel on expiry makes it a true safety net, not a cap on P6's measured 26-min rows"
        );
        assert_eq!(
            UNLOAD_TIMEOUT_MS, 120_000,
            "a hung unload bat cannot park the fence"
        );
        assert_eq!(
            RESTORE_TIMEOUT_MS, 900_000,
            "the restore leg ends at its own budget too; 900 s is Strata's model-load idiom (TIMING pass)"
        );
        assert_eq!(
            HEALTH_WINDOW_MS, 15_000,
            "the per-attempt ready window (TIMING pass); attempts stay RESTORE_ATTEMPT_BOUND at RESTORE_GAP_MS apart"
        );
        assert_eq!(BAT_POLL_GAP_MS, 500, "the bat monitor's poll cadence");
        assert_eq!(BAT_REAP_POLLS, 4, "the reap tail is bounded");
        // W4-E (LEG AF2-M22): the queued-stall bound is pinned next to the running-
        // row deadline it sits inside; 10 min is the honest "never started" number
        // for a submit-stuck job (compiles and gate waits stay well under it).
        assert_eq!(
            QUEUED_STALL_MS, 600_000,
            "10 min: a job never seen running in 10 minutes is stuck, not slow"
        );
    }

    #[tokio::test]
    async fn one_cycle_per_batch_n_rows_one_unload_one_restore_one_free() {
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        let report = harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(report["ok"], true, "{report}");
        assert_eq!(report["modelRestored"], true);
        assert_eq!(report["freed"], true);
        assert_eq!(report["rows"].as_array().expect("rows").len(), 3);
        for row in report["rows"].as_array().expect("rows") {
            assert_eq!(row["status"], "done");
        }
        // Exactly one handoff for the whole batch: 1 unload + 1 restore, 1 free.
        let runs = harness.commands.runs.lock().expect("bat log");
        assert_eq!(runs.len(), 2, "unload + restore, once each: {runs:?}");
        assert!(runs[0].contains("unload"));
        assert!(runs[1].contains("restore"));
        assert_eq!(harness.door.free_calls.load(Ordering::SeqCst), 1);
        assert_eq!(harness.door.proof_calls.load(Ordering::SeqCst), 1);
        // The settle/hold/patience durations ride the pacer record, in order.
        let pauses = harness.pacer.pauses.lock().expect("pacer log");
        assert_eq!(pauses[0], SETTLE_MS);
        assert_eq!(pauses[1], DOWN_HOLD_MS);
        assert_eq!(pauses[2], PATIENCE_MS);
        // Every spool row reached `done` durably.
        let rows = harness.spool.snapshot().expect("healthy");
        assert!(rows.iter().all(|row| row.status == RowStatus::Done));
    }

    #[tokio::test]
    async fn empty_batch_is_no_cycle_at_all() {
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        let cycle_id = harness.cell.claim(CyclePhase::Unloading).expect("claim");
        let seams = harness.seams(Arc::new(ScriptChain::all_done()));
        let report = drive(CycleRun {
            cell: harness.cell.clone(),
            seams,
            spool: harness.spool.clone(),
            guard: guard(true, true),
            cycle_id,
            sessions: Arc::new(fakes::ScriptSessions::idle()),
        })
        .await;
        assert_eq!(report["ok"], true, "{report}");
        assert_eq!(report["rows"].as_array().expect("rows").len(), 0);
        assert_eq!(report["freed"], false);
        assert_eq!(report["modelRestored"], true);
        assert!(harness.commands.runs.lock().expect("bat log").is_empty());
        assert_eq!(harness.door.free_calls.load(Ordering::SeqCst), 0);
        assert_eq!(harness.door.proof_calls.load(Ordering::SeqCst), 0);
        assert!(harness.pacer.pauses.lock().expect("pacer log").is_empty());
    }

    #[test]
    fn fence_refuses_a_second_claim_with_the_cycle_in_flight_word() {
        let _gate = crate::resources::fence_test_gate();
        let dir = tempfile::tempdir().expect("tempdir");
        let cell = CycleCell::new(dir.path());
        let first = cell.claim(CyclePhase::Unloading).expect("first claim");
        let error = cell
            .claim(CyclePhase::Draining)
            .expect_err("the fence is held");
        assert_eq!(error.body_json()["reason"], "cycleInFlight");
        assert_eq!(error.body_json()["error"], "CYCLE_IN_FLIGHT");
        // The live view names the in-flight id and phase; finish releases the fence,
        // and a fresh claim mints a new id.
        let live = cell.live();
        assert_eq!(live.phase, CyclePhase::Unloading);
        assert_eq!(live.cycle_id.as_deref(), Some(first.as_str()));
        cell.finish(json!({ "ok": true, "cycleId": first }));
        assert_eq!(cell.live().phase, CyclePhase::Idle);
        assert!(cell.claim(CyclePhase::Draining).is_ok());
    }

    #[test]
    fn claim_takes_the_stock_facing_fence_and_finish_clears_it() {
        let _gate = crate::resources::fence_test_gate();
        // §14.6/E14: the cell fence and the stock mirror in `crate::resources` move as one —
        // one driver owns both, so stock admission, submission and maintenance commands see
        // the same fact the API answers `cycleInFlight` for.
        let dir = tempfile::tempdir().expect("tempdir");
        let cell = CycleCell::new(dir.path());
        assert!(
            !crate::resources::fence_held(),
            "an idle cell leaves every stock path open"
        );
        let cycle_id = cell.claim(CyclePhase::Unloading).expect("claim");
        assert!(
            crate::resources::fence_held(),
            "a running cycle is visible to the stock gates"
        );
        assert!(crate::resources::fence_wait("stock admission").is_some());
        cell.finish(json!({ "ok": true, "cycleId": cycle_id }));
        assert!(
            !crate::resources::fence_held(),
            "finish releases the mirror"
        );
    }

    #[test]
    fn cycle_in_flight_answers_carry_the_retry_after_ms_cadence() {
        let _gate = crate::resources::fence_test_gate();
        // §10 double-generate row: the 409 names WHEN to come back, at both claim
        // collision paths — the cell's own fence and the stock-facing mirror.
        assert_eq!(CYCLE_RETRY_AFTER_MS, 2_000, "the poll cadence, pinned");
        let dir = tempfile::tempdir().expect("tempdir");
        let cell = CycleCell::new(dir.path());
        let first = cell.claim(CyclePhase::Unloading).expect("first claim");
        let collision = cell
            .claim(CyclePhase::Draining)
            .expect_err("the cell fence is held");
        let body = collision.body_json();
        assert_eq!(body["reason"], "cycleInFlight");
        assert_eq!(
            body["retryAfterMs"], CYCLE_RETRY_AFTER_MS,
            "the cell-claim collision names the cadence: {body}"
        );
        cell.finish(json!({ "ok": true, "cycleId": first }));
        // The same law on the stock-mirror collision half of the claim.
        assert!(
            crate::resources::fence_claim(),
            "a stock stage holds the fence"
        );
        let collision = cell
            .claim(CyclePhase::Unloading)
            .expect_err("held by a stock stage");
        assert_eq!(
            collision.body_json()["retryAfterMs"],
            CYCLE_RETRY_AFTER_MS,
            "the generate-time collision names the same cadence"
        );
        crate::resources::fence_release();
    }

    #[test]
    fn a_stock_stage_holding_the_fence_answers_the_same_cycle_in_flight_word() {
        let _gate = crate::resources::fence_test_gate();
        // The rare collision half of E14: a stock stage is mid-admission behind the fence, so
        // the claim never parks the cell — it answers the same 409 word and leaves the cell
        // idle with no minted id, exactly as before the attempt.
        let dir = tempfile::tempdir().expect("tempdir");
        let cell = CycleCell::new(dir.path());
        assert!(
            crate::resources::fence_claim(),
            "a stock stage holds the fence"
        );
        let error = cell
            .claim(CyclePhase::Unloading)
            .expect_err("the fence is held by stock");
        assert_eq!(error.body_json()["reason"], "cycleInFlight");
        assert_eq!(error.body_json()["error"], "CYCLE_IN_FLIGHT");
        assert_eq!(cell.live().phase, CyclePhase::Idle, "the cell rolled back");
        assert_eq!(
            cell.live().cycle_id,
            None,
            "no id survived the refused claim"
        );
        crate::resources::fence_release();
        // The retry claims normally once the stock stage is through.
        let cycle_id = cell.claim(CyclePhase::Unloading).expect("retry claim");
        assert!(crate::resources::fence_held());
        cell.finish(json!({ "ok": true, "cycleId": cycle_id }));
        assert!(!crate::resources::fence_held());
    }

    #[test]
    fn a_cell_that_dies_mid_cycle_does_not_strand_the_stock_fence() {
        let _gate = crate::resources::fence_test_gate();
        // `finish` is the release; the Drop backstop keeps a panicked or abandoned leg from
        // parking every stock gate forever behind an owner that no longer exists.
        let dir = tempfile::tempdir().expect("tempdir");
        {
            let cell = CycleCell::new(dir.path());
            cell.claim(CyclePhase::Draining).expect("claim");
            assert!(crate::resources::fence_held());
        }
        assert!(
            !crate::resources::fence_held(),
            "the drop backstop lowered the mirror"
        );
    }

    /// A seam that panics on the first row, so a drive leg unwinds mid-drain - the exact
    /// failure the `DriveGuard` exists to contain.
    struct PanickingChain;

    impl SubmitChain for PanickingChain {
        fn run_row(&self, _row_id: &str, _intent: Value) -> BoxFuture<'static, RowOutcome> {
            panic!("test seam: the drive leg unwinds mid-drain");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_panicking_drive_leg_finalizes_the_cell_and_lowers_the_fence() {
        let _gate = crate::resources::fence_test_gate();
        // D4: a panicking seam unwinds out of `drive`. The DriveGuard's Drop closes the
        // cell - phase back to idle, a faulted terminal report, fence lowered - so a
        // crashed driver never strands the stock fence nor leaves a cycle in flight.
        let harness = Harness::new();
        harness.spool.append(&queued_row("row-a")).expect("queued");
        let cycle_id = harness.cell.claim(CyclePhase::Draining).expect("claim");
        let seams = Arc::new(CycleSeams {
            chain: Arc::new(PanickingChain),
            ..seams_of(&harness)
        });
        let cell = harness.cell.clone();
        let spool = harness.spool.clone();
        let joined = tokio::spawn(async move {
            drive(CycleRun {
                cell,
                seams,
                spool,
                guard: guard(false, false),
                cycle_id,
                sessions: Arc::new(fakes::ScriptSessions::idle()),
            })
            .await
        });
        let join_error = joined.await.expect_err("the drive task panicked");
        assert!(
            join_error.is_panic(),
            "the seam panic surfaces as a JoinError"
        );

        // The cell is closed, not parked mid-cycle.
        let live = harness.cell.live();
        assert_eq!(
            live.phase,
            CyclePhase::Idle,
            "the unwound guard parked idle"
        );
        // The stock-facing fence is free again: a fresh claim is accepted. A cycle that
        // stranded the fence would make this claim fail.
        assert!(
            crate::resources::fence_claim(),
            "the unwound guard lowered the fence"
        );
        crate::resources::fence_release();
        // The terminal report names the unwound leg, so the resume posture reads a failure.
        let report = live
            .report
            .expect("a terminal report was persisted for the unwound cycle");
        assert_eq!(report["ok"], false);
        assert_eq!(report["fault"]["reason"], FAULT_CYCLE);
        assert_eq!(report["fault"]["detail"], "drive leg unwound", "{report}");
    }

    #[tokio::test]
    async fn cas_transitions_apply_and_refuse_wrong_expect_from() {
        let _gate = crate::resources::fence_test_gate();
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        spool.append(&queued_row("row-a")).expect("row queued");
        assert!(
            spool
                .set_status("row-a", RowStatus::Queued, RowStatus::Draining)
                .expect("healthy"),
            "the queued->draining CAS applies"
        );
        assert!(
            !spool
                .set_status("row-a", RowStatus::Queued, RowStatus::Draining)
                .expect("healthy"),
            "a second CAS on the same row refuses: expect_from no longer matches"
        );
        assert!(
            !spool
                .set_status("nope", RowStatus::Queued, RowStatus::Draining)
                .expect("healthy"),
            "an unknown id refuses"
        );
        assert!(
            spool
                .set_status("row-a", RowStatus::Draining, RowStatus::Done)
                .expect("healthy"),
            "the draining->done CAS applies"
        );
        let rows = spool.snapshot().expect("healthy");
        assert_eq!(rows[0].status, RowStatus::Done);
        // The refusal rewrites nothing: the durable file still says done.
        let on_disk: Value = serde_json::from_slice(
            &std::fs::read(dir.path().join(super::super::spool::FILE)).expect("written"),
        )
        .expect("valid json");
        assert_eq!(on_disk["rows"][0]["status"], "done");
    }

    #[tokio::test]
    async fn a_failing_row_is_recorded_and_the_batch_continues() {
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        let report = harness
            .run(
                ScriptChain::scripted(vec![
                    RowOutcome {
                        succeeded: true,
                        detail: None,
                        error_kind: None,
                        submit_failed: false,
                        job_id: Some("stock-1".to_owned()),
                        outputs: None,
                    },
                    RowOutcome {
                        succeeded: false,
                        detail: Some("scripted backend row failure".to_owned()),
                        error_kind: None,
                        submit_failed: false,
                        job_id: Some("stock-2".to_owned()),
                        outputs: None,
                    },
                    RowOutcome {
                        succeeded: true,
                        detail: None,
                        error_kind: None,
                        submit_failed: false,
                        job_id: Some("stock-3".to_owned()),
                        outputs: None,
                    },
                ]),
                guard(true, true),
            )
            .await;
        // Batch semantics: the cycle itself is ok; the failure is per-row.
        assert_eq!(report["ok"], true, "{report}");
        let statuses: Vec<&str> = report["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| row["status"].as_str().expect("word"))
            .collect();
        assert_eq!(statuses, ["done", "failed", "done"]);
        assert!(report["rows"][1]["error"]
            .as_str()
            .expect("detail")
            .contains("scripted backend row failure"));
        // Only one unload/restore pair ran: the batch is still ONE cycle.
        assert_eq!(harness.commands.runs.lock().expect("bat log").len(), 2);
    }

    #[tokio::test]
    async fn the_free_body_is_exactly_the_two_key_wire() {
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        let bodies = harness.door.free_bodies.lock().expect("free log");
        let body = &bodies[0];
        let object = body.as_object().expect("object body");
        assert_eq!(object.len(), 2, "exactly the two keys: {body}");
        assert_eq!(object["unload_models"], json!(true));
        assert_eq!(object["free_memory"], json!(true));
        assert_eq!(
            serde_json::to_string(body).expect("serialize"),
            r#"{"free_memory":true,"unload_models":true}"#
        );
    }

    #[tokio::test]
    async fn health_polling_stops_at_the_first_healthy_answer() {
        let _gate = crate::resources::fence_test_gate();
        let mut harness = Harness::new();
        harness.health = Arc::new(ScriptHealth::scripted([false, false, true]));
        let report = harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(report["ok"], true, "{report}");
        assert_eq!(report["modelRestored"], true);
        // Three probes ran and polling STOPPED there: the script held more answers,
        // but none were consumed after the healthy one (restore ran once).
        assert_eq!(harness.health.probes.load(Ordering::SeqCst), 3);
        assert_eq!(harness.commands.runs.lock().expect("bat log").len(), 2);
        // The two unhealthy gaps paced at exactly the probe gap, after the free-leg
        // cadence (settle, hold, patience) — the whole pacer record pinned.
        let pauses = harness.pacer.pauses.lock().expect("pacer log");
        assert_eq!(
            pauses.as_slice(),
            [
                SETTLE_MS,
                DOWN_HOLD_MS,
                PATIENCE_MS,
                HEALTH_PROBE_GAP_MS,
                HEALTH_PROBE_GAP_MS
            ]
        );
    }

    #[tokio::test]
    async fn restore_is_bounded_to_three_attempts_then_the_exhausted_word() {
        let _gate = crate::resources::fence_test_gate();
        let mut harness = Harness::new();
        // Never healthy (fallback false): every attempt burns its health window.
        harness.health = Arc::new(ScriptHealth::scripted([false; 12]));
        let report = harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(report["ok"], false, "{report}");
        assert_eq!(report["modelRestored"], false);
        assert_eq!(report["fault"]["reason"], FAULT_RESTORE);
        assert_eq!(
            report["fault"]["reason"], "restoreExhausted",
            "existing taxonomy word"
        );
        // The restore bat ran exactly RESTORE_ATTEMPT_BOUND times (plus the one unload).
        assert_eq!(harness.commands.runs.lock().expect("bat log").len(), 4);
        // Two 90 s gaps between the three attempts.
        let pauses = harness.pacer.pauses.lock().expect("pacer log");
        assert_eq!(
            pauses
                .iter()
                .copied()
                .filter(|p| *p == RESTORE_GAP_MS)
                .count(),
            2
        );
        // The rows still drained and freed: exhaustion is the restore leg only.
        assert_eq!(report["freed"], true);
        assert_eq!(report["rows"].as_array().expect("rows").len(), 3);
    }

    #[tokio::test]
    async fn auto_cycle_off_skips_both_bats_but_still_frees() {
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        let report = harness
            .run(ScriptChain::all_done(), guard(false, true))
            .await;
        assert_eq!(report["ok"], true, "{report}");
        assert!(
            harness.commands.runs.lock().expect("bat log").is_empty(),
            "no bats"
        );
        assert_eq!(
            harness.door.free_calls.load(Ordering::SeqCst),
            1,
            "freeOnQueueEnd keeps the card clean"
        );
        assert_eq!(
            report["modelRestored"], false,
            "W3-9 (LEG AF2-M21a): the free took the models off the card and no restore leg exists behind it — the posture derives from DID-RESTORE, not from the config word"
        );
        assert_eq!(
            report["cardAtRisk"], true,
            "the honest posture names the card"
        );
        assert_eq!(report["freed"], true);
        // No health probes without the restore leg.
        assert_eq!(harness.health.probes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn auto_cycle_off_with_free_off_skips_every_leg() {
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        let report = harness
            .run(ScriptChain::all_done(), guard(false, false))
            .await;
        assert_eq!(report["ok"], true, "{report}");
        assert_eq!(harness.door.free_calls.load(Ordering::SeqCst), 0);
        assert!(harness.pacer.pauses.lock().expect("pacer log").is_empty());
        assert_eq!(report["freed"], false);
    }

    #[tokio::test]
    async fn unload_fault_aborts_before_gpu_work_and_runs_no_restore() {
        let _gate = crate::resources::fence_test_gate();
        let mut harness = Harness::new();
        harness.commands = Arc::new(ScriptCommands {
            runs: Mutex::new(Vec::new()),
            budgets: Mutex::new(Vec::new()),
            unload_exit: std::sync::atomic::AtomicI32::new(3),
            restore_exit: std::sync::atomic::AtomicI32::new(0),
        });
        let report = harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(report["ok"], false, "{report}");
        assert_eq!(report["fault"]["reason"], FAULT_HANDOFF);
        assert_eq!(
            report["fault"]["reason"], "handoffFailed",
            "the §10 unload-fault wire word (manager-ruled)"
        );
        // Fence released: the drive finished, so the cell is idle again and stock
        // paths see an open fence — the refusal cost one 409, not a parked card.
        assert_eq!(harness.cell.live().phase, CyclePhase::Idle);
        assert!(
            !crate::resources::fence_held(),
            "the handoff fault releases the fence"
        );
        // Nothing ran: no submit, no free, no restore, and the spool stays intact.
        assert!(report["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .all(|row| row["status"] == "queued"));
        assert_eq!(harness.door.free_calls.load(Ordering::SeqCst), 0);
        assert_eq!(harness.health.probes.load(Ordering::SeqCst), 0);
        let runs = harness.commands.runs.lock().expect("bat log");
        assert_eq!(runs.len(), 1, "only the unload bat ran: {runs:?}");
        let rows = harness.spool.snapshot().expect("healthy");
        assert!(rows.iter().all(|row| row.status == RowStatus::Queued));
        assert_eq!(
            report["modelRestored"], true,
            "nothing was unloaded, so nothing to restore"
        );
    }

    #[tokio::test]
    async fn free_ack_fault_is_a_cycle_fault_but_restore_still_runs() {
        let _gate = crate::resources::fence_test_gate();
        let mut harness = Harness::new();
        harness.door = Arc::new(ScriptDoor {
            free_fallback: false,
            ..ScriptDoor::accepting()
        });
        let report = harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(report["ok"], false, "{report}");
        assert_eq!(report["fault"]["reason"], FAULT_CYCLE);
        // The bound is the law: every attempt rides the same door, then the fault
        // is terminal — no silent fourth try, no endless loop.
        assert_eq!(
            harness.door.free_calls.load(Ordering::SeqCst),
            FREE_ATTEMPT_BOUND,
            "three attempts, exactly"
        );
        // The rows still drained; the restore leg ran regardless (the card never
        // stays down on a faulted free).
        assert_eq!(report["rows"].as_array().expect("rows").len(), 3);
        assert_eq!(report["modelRestored"], true);
        assert_eq!(report["freed"], false);
        assert_eq!(harness.commands.runs.lock().expect("bat log").len(), 2);
        // F4 (LEG AF2-M20), one-homed and re-probed to the bound by W3-5/W3-17
        // (LEG AF2-M21a): the fault path does not sprint into restore. A free that
        // was APPLIED with only the ack lost needs the acked path's settle before
        // the restore bat can load beside ComfyUI's post-free cache reset (the P5
        // wedge class): down-hold, then a bounded re-probe over the same door — and
        // this door PROVES the queue idle on the first re-probe, so exactly one
        // hold and one probe are spent. Never a re-proved free, never a loop.
        let pauses = harness.pacer.pauses.lock().expect("pacer log");
        assert_eq!(
            pauses.as_slice(),
            [SETTLE_MS, DOWN_HOLD_MS],
            "the settle lands on the fault path too, stopping at the first proven-idle answer: {pauses:?}"
        );
        assert_eq!(
            harness.door.proof_calls.load(Ordering::SeqCst),
            2,
            "the drain's own proof plus exactly one fault-path re-probe (idle proven)"
        );
    }

    #[tokio::test]
    async fn the_free_fault_settle_re_probes_to_the_bound_before_restore() {
        let _gate = crate::resources::fence_test_gate();
        // W3-5 + W3-17 (LEG AF2-M21a): when the queue is NOT proven idle, the
        // fault-path settle spends its full bounded patience — a down-hold before
        // each of FREE_FAULT_SETTLE_PROBE_BOUND re-probes — one home shared by both
        // free legs, every probe an honest log line. W4-A (LEG AF2-M22) CHANGED
        // the tail this test used to assert: the unproven verdict now GATES THE
        // BAT — restore skips, the report answers modelRestored:false +
        // cardAtRisk:true, and the debt rides the persisted report to resume.
        let mut harness = Harness::new();
        harness.door = Arc::new(ScriptDoor {
            free_fallback: false,
            // The drain's own proof answers first (free is legal to attempt); the
            // settle's four re-probes all come back unproven — the bound's class.
            proof_script: Mutex::new(
                [
                    Ok(()),
                    Err(IdleProofFault::new(
                        ProofFault::QueueLive,
                        "scripted: settle probe unproven",
                    )),
                    Err(IdleProofFault::new(
                        ProofFault::QueueLive,
                        "scripted: settle probe unproven",
                    )),
                    Err(IdleProofFault::new(
                        ProofFault::QueueLive,
                        "scripted: settle probe unproven",
                    )),
                    Err(IdleProofFault::new(
                        ProofFault::QueueLive,
                        "scripted: settle probe unproven",
                    )),
                ]
                .into_iter()
                .collect(),
            ),
            ..ScriptDoor::accepting()
        });
        let report = harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(report["fault"]["reason"], FAULT_CYCLE);
        assert_eq!(
            harness.door.free_calls.load(Ordering::SeqCst),
            FREE_ATTEMPT_BOUND,
            "the free leg exhausted exactly (the drain's proof had passed, so the free was legal to attempt)"
        );
        let pauses = harness.pacer.pauses.lock().expect("pacer log");
        assert_eq!(
            pauses
                .iter()
                .filter(|millis| **millis == DOWN_HOLD_MS)
                .count(),
            FREE_FAULT_SETTLE_PROBE_BOUND as usize,
            "the settle holds once per re-probe, bounded: {pauses:?}"
        );
        assert_eq!(
            harness.door.proof_calls.load(Ordering::SeqCst),
            1 + FREE_FAULT_SETTLE_PROBE_BOUND,
            "the drain's proof plus every settle re-probe, never one more"
        );
        assert_eq!(
            report["modelRestored"], false,
            "W4-A: the settle verdict gates the bat"
        );
        assert_eq!(
            report["cardAtRisk"], true,
            "the debt is named out loud: {report}"
        );
        let bats = harness.commands.runs.lock().expect("bat log");
        assert_eq!(
            bats.as_slice(),
            ["unload.bat /agent"],
            "W4-A (LEG AF2-M22): the unload ran, NO restore bat beside an unproven queue: {bats:?}"
        );
        // The persisted terminal report carries the same posture `GET /v1/resume`
        // reads — a modelRestored:false terminal cycle is the report shape its
        // debtOutstanding law (pinned in resume.rs) turns into an owed restore.
        let persisted = harness
            .cell
            .live()
            .report
            .expect("terminal report persisted");
        assert_eq!(
            persisted["modelRestored"], false,
            "the debt survives to resume"
        );
    }

    #[tokio::test]
    async fn a_settle_that_proves_idle_on_its_second_re_probe_still_runs_the_restore() {
        let _gate = crate::resources::fence_test_gate();
        // W4-A (LEG AF2-M22) positive control: the settle's FIRST re-probe comes
        // back unproven, the SECOND proves the queue idle — the verdict is true,
        // the bat runs, the posture stays restored. The gate closes on NEVER
        // PROVEN, not on one noisy probe.
        let mut harness = Harness::new();
        harness.door = Arc::new(ScriptDoor {
            free_fallback: false,
            proof_script: Mutex::new(
                [
                    Ok(()), // the drain's own proof: the free is legal to attempt
                    Err(IdleProofFault::new(
                        ProofFault::QueueLive,
                        "scripted: first settle probe unproven",
                    )),
                    Ok(()), // proven idle on re-probe 2: the settle stops there
                ]
                .into_iter()
                .collect(),
            ),
            ..ScriptDoor::accepting()
        });
        let report = harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(report["fault"]["reason"], FAULT_CYCLE, "{report}");
        assert_eq!(
            report["modelRestored"], true,
            "proven idle within the bound: the restore leg runs: {report}"
        );
        assert!(
            report.get("cardAtRisk").is_none(),
            "no debt to name: {report}"
        );
        assert_eq!(
            harness.door.proof_calls.load(Ordering::SeqCst),
            3,
            "drain proof + two settle re-probes, stopping at the first proven-idle answer"
        );
        let bats = harness.commands.runs.lock().expect("bat log");
        assert_eq!(
            bats.as_slice(),
            ["unload.bat /agent", "restore.bat /agent"],
            "the bat runs when the settle proves the queue idle: {bats:?}"
        );
    }

    #[tokio::test]
    async fn the_free_fault_names_the_startup_preset_cause_when_a_wedge_flag_is_present() {
        let _gate = crate::resources::fence_test_gate();
        // Design 10 §14.6: a free-leg exhaustion with a known wedge flag in the
        // effective preset names the CAUSE, not just the symptom. The preset order is
        // the launch order, so the FIRST offender is the flag that gets named.
        let mut harness = Harness::new();
        harness.door = Arc::new(ScriptDoor {
            free_fallback: false,
            ..ScriptDoor::accepting()
        });
        harness.startup = Arc::new(FixedStartupPreset::with(&[
            "--bf16-vae",
            "--disable-smart-memory",
            "--highvram",
        ]));
        let report = harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(report["fault"]["reason"], FAULT_CYCLE);
        assert_eq!(
            report["fault"]["blockedOn"], "startupPreset:--disable-smart-memory",
            "{report}: the first offending flag wins"
        );
    }

    #[tokio::test]
    async fn an_unattributable_free_fault_keeps_its_exact_two_key_shape() {
        let _gate = crate::resources::fence_test_gate();
        // The no-cause fallback, both postures: unreadable args (the degraded home) and
        // clean args (a preset with nothing to blame). Neither adds a key, neither
        // changes the fault, and neither can fail the fault path.
        for preset in [
            FixedStartupPreset::unreadable(),
            FixedStartupPreset::with(&["--use-ck-attention", "--fast", "fp16_accumulation"]),
        ] {
            let mut harness = Harness::new();
            harness.door = Arc::new(ScriptDoor {
                free_fallback: false,
                ..ScriptDoor::accepting()
            });
            harness.startup = Arc::new(preset);
            let report = harness
                .run(ScriptChain::all_done(), guard(true, true))
                .await;
            assert_eq!(report["fault"]["reason"], FAULT_CYCLE);
            let mut keys: Vec<&str> = report["fault"]
                .as_object()
                .expect("fault object")
                .keys()
                .map(String::as_str)
                .collect();
            keys.sort_unstable();
            assert_eq!(keys, ["detail", "reason"], "{report}: no key is invented");
        }
    }

    #[test]
    fn the_startup_preset_cause_scans_the_closed_set_case_sensitive_and_exact() {
        let _gate = crate::resources::fence_test_gate();
        // The closed set is three flags exactly, and the scan walks the ARGS in launch
        // order rather than the list.
        assert_eq!(
            STARTUP_WEDGE_FLAGS.len(),
            3,
            "closed set, ruled in design 10"
        );
        for flag in STARTUP_WEDGE_FLAGS {
            assert_eq!(
                startup_preset_cause(&["--listen".into(), "127.0.0.1".into(), flag.into()]),
                Some(flag),
                "{flag} is a known wedge culprit"
            );
        }
        assert_eq!(
            startup_preset_cause(&["--highvram".into(), "--disable-smart-memory".into()]),
            Some("--highvram"),
            "first offender in scan order, whatever the list order is"
        );
        assert_eq!(
            startup_preset_cause(&["--reserve-vram".into(), "8".into(), "--highvram".into()]),
            Some("--reserve-vram"),
            "the flag is named, never its GB value"
        );
        // Nothing to blame: an empty preset, and a preset of only non-wedge flags.
        assert_eq!(startup_preset_cause(&[]), None);
        assert_eq!(
            startup_preset_cause(&["--use-ck-attention".into(), "--bf16-vae".into()]),
            None,
            "a flag outside the closed set is never blamed"
        );
        // Exact, case-sensitive matching: a near-miss is not the flag this knows.
        for near_miss in [
            "--HighVRAM",
            "--highvram=true",
            "-highvram",
            "--disable-smart-memory-x",
            "--reserve-vram=8",
        ] {
            assert_eq!(
                startup_preset_cause(&[near_miss.into()]),
                None,
                "{near_miss} is not in the closed set"
            );
        }
    }

    #[tokio::test]
    async fn free_ack_retry_recovers_when_a_later_attempt_acks() {
        let _gate = crate::resources::fence_test_gate();
        // §10 `free ack missing`: two missing acks, then the third attempt lands —
        // the cycle proceeds as if the wire answered first try.
        let mut harness = Harness::new();
        harness.door = Arc::new(ScriptDoor::free_scripted([false, false, true]));
        let report = harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(report["ok"], true, "{report}");
        assert_eq!(report["freed"], true);
        assert_eq!(report["modelRestored"], true);
        assert_eq!(
            harness.door.free_calls.load(Ordering::SeqCst),
            3,
            "two failures then the ack: three door calls, never a fourth"
        );
        // Every attempt re-sent the exact same two-key wire over the same door.
        let bodies = harness.door.free_bodies.lock().expect("free log");
        assert_eq!(bodies.len(), 3);
        assert!(
            bodies.windows(2).all(|pair| pair[0] == pair[1]),
            "same body, same door: the retry never reshapes the wire: {bodies:?}"
        );
        // The down-hold/patience cadence follows the successful ack, unchanged.
        let pauses = harness.pacer.pauses.lock().expect("pacer log");
        assert_eq!(
            &pauses[..3],
            [SETTLE_MS, DOWN_HOLD_MS, PATIENCE_MS],
            "the free-leg cadence is untouched by the retries"
        );
    }

    #[tokio::test]
    async fn a_queue_live_idle_proof_fault_skips_free_and_restore() {
        let _gate = crate::resources::fence_test_gate();
        // W3-2 (LEG AF2-M21a), the NEVER-co-resident law: an idle-proof failure the
        // backend is still ANSWERING through (foreign pending job, cancel-refused
        // survivor, lost-response unknown job) means a live stock queue on the card.
        // The end legs run neither free nor restore — a restore bat beside that
        // queue is the exact co-residency the handoff exists to prevent. The answer
        // carries modelRestored:false + cardAtRisk:true and the fault names the
        // cause word; `GET /v1/resume` derives debtOutstanding from the persisted
        // report (pinned in resume.rs).
        let mut harness = Harness::new();
        harness.door = Arc::new(ScriptDoor::proof_failing(ProofFault::QueueLive));
        let report = harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(report["ok"], false, "{report}");
        assert_eq!(report["fault"]["reason"], FAULT_CYCLE);
        assert!(
            report["fault"]["detail"]
                .as_str()
                .expect("detail")
                .contains("queueLive"),
            "the fault names the cause class: {report}"
        );
        assert_eq!(
            harness.door.free_calls.load(Ordering::SeqCst),
            0,
            "free skipped: the proof is the only completion fact"
        );
        assert_eq!(
            report["modelRestored"], false,
            "restore skipped: never co-resident with a live queue"
        );
        assert_eq!(report["cardAtRisk"], true, "the debt is named out loud");
        let bats = harness.commands.runs.lock().expect("bat log");
        assert_eq!(
            bats.as_slice(),
            ["unload.bat /agent"],
            "the unload ran; NO restore bat beside the live queue"
        );
    }

    #[tokio::test]
    async fn a_backend_down_idle_proof_fault_keeps_the_restore_leg() {
        let _gate = crate::resources::fence_test_gate();
        // W3-2's other class, behavior preserved: the backend itself is not
        // answering (the crash-recovery class). Nothing lives on its queue, so the
        // restore bat is exactly how the engine comes back — free stays skipped
        // (there is nothing to acknowledge against), restore runs.
        let mut harness = Harness::new();
        harness.door = Arc::new(ScriptDoor::proof_failing(ProofFault::BackendDown));
        let report = harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(report["ok"], false, "{report}");
        assert!(
            report["fault"]["detail"]
                .as_str()
                .expect("detail")
                .contains("backendDown"),
            "the fault names the cause class: {report}"
        );
        assert_eq!(
            harness.door.free_calls.load(Ordering::SeqCst),
            0,
            "free skipped: the proof is the only completion fact"
        );
        assert_eq!(report["modelRestored"], true, "restore still ran");
        assert!(report.get("cardAtRisk").is_none(), "the debt was paid");
        assert_eq!(harness.commands.runs.lock().expect("bat log").len(), 2);
    }

    #[tokio::test]
    async fn a_watchdog_sever_answers_the_held_call_and_runs_no_second_legs() {
        let _gate = crate::resources::fence_test_gate();
        // §8.2: the sever arm already ran cancel/clear/free/restore in its law order.
        // The drain's finish path records the sever as the cycle's fault (so the held
        // generate call answers 500 `jobWedged`) and skips its own free/restore legs —
        // re-running them would spam-load the engine the arm just restored (§8.4).
        let harness = Harness::new();
        for id in ["row-a", "row-b", "row-c"] {
            harness.spool.append(&queued_row(id)).expect("row queued");
        }
        let cycle_id = harness.cell.claim(CyclePhase::Unloading).expect("claim");
        harness.cell.note_sever(json!({
            "reason": super::super::watchdog::FAULT_SEVER,
            "severedRow": "row-a",
            "freed": true,
            "restored": true,
        }));
        let report = drive(CycleRun {
            cell: harness.cell.clone(),
            seams: harness.seams(Arc::new(ScriptChain::all_done())),
            spool: harness.spool.clone(),
            guard: guard(true, true),
            cycle_id,
            sessions: Arc::new(fakes::ScriptSessions::idle()),
        })
        .await;
        assert_eq!(
            report["fault"]["reason"],
            super::super::watchdog::FAULT_SEVER,
            "{report}"
        );
        assert!(
            report["fault"]["detail"]
                .as_str()
                .expect("detail")
                .contains("row-a"),
            "the answer names the row it took: {report}"
        );
        assert_eq!(report["freed"], true, "the arm's fact rides the report");
        assert_eq!(report["modelRestored"], true, "the arm restored the model");
        assert_eq!(
            harness.door.free_calls.load(Ordering::SeqCst),
            0,
            "no second free leg under a sever"
        );
        assert_eq!(
            harness.health.probes.load(Ordering::SeqCst),
            0,
            "no second health poll under a sever"
        );
        let bats = harness.commands.runs.lock().expect("bat log");
        assert_eq!(
            bats.as_slice(),
            ["unload.bat /agent"],
            "only the cycle's own unload ran; the restore bat is the arm's"
        );
        // The note is per-cycle: the next claim starts clean, so a later batch cannot
        // inherit an old sever.
        let fresh = harness.cell.clone();
        fresh.finish(report.clone());
        assert!(fresh.sever().is_none(), "the finish clears the sever");
        let next = fresh.claim(CyclePhase::Draining).expect("next claim");
        assert!(fresh.sever().is_none(), "the claim clears the sever");
        fresh.finish(json!({ "cycleId": next, "ok": true }));
    }

    #[tokio::test]
    async fn a_sever_latched_during_the_free_leg_spawns_no_restore_bat() {
        let _gate = crate::resources::fence_test_gate();
        // W3-6 (LEG AF2-M21a): the last latch window of the end legs. The arm can
        // latch during the drain's own free await (seconds of leg time after the
        // post-proof latch check). The drain's restore gate probes the latch before
        // setting the `restoring` phase, and restore_leg re-probes it before every
        // attempt — here the latch lands mid-free and the drain must hand the legs
        // over with zero bats of its own.
        let harness = Harness::new();
        for id in ["row-a", "row-b", "row-c"] {
            harness.spool.append(&queued_row(id)).expect("row queued");
        }
        let cycle_id = harness.cell.claim(CyclePhase::Unloading).expect("claim");
        *harness.door.latch_on_free.lock().expect("latch mount") = Some(Arc::clone(&harness.cell));
        let report = drive(CycleRun {
            cell: harness.cell.clone(),
            seams: harness.seams(Arc::new(ScriptChain::all_done())),
            spool: harness.spool.clone(),
            guard: guard(true, true),
            cycle_id,
            sessions: Arc::new(fakes::ScriptSessions::idle()),
        })
        .await;
        assert_eq!(
            report["fault"]["reason"],
            super::super::watchdog::FAULT_SEVER,
            "{report}: the latch caught the restore gate"
        );
        let bats = harness.commands.runs.lock().expect("bat log");
        assert_eq!(
            bats.as_slice(),
            ["unload.bat /agent"],
            "the restore bat is the arm's, never the drain's"
        );
        assert_eq!(
            harness.health.probes.load(Ordering::SeqCst),
            0,
            "no health poll behind a latched handoff"
        );
        assert_eq!(
            report["modelRestored"], true,
            "the arm's completed answer rides the report verbatim"
        );
    }

    #[tokio::test]
    async fn poison_row_guard_aborts_the_drain_and_still_brings_the_card_back() {
        let _gate = crate::resources::fence_test_gate();
        // §5/§10: two of three rows fail AT SUBMIT — the third is never submitted
        // and stays Queued, the terminal rows keep their statuses, the fault names
        // the guard (no new wire word), and the machine STILL runs free + restore.
        let harness = Harness::new();
        let submit_failure = || RowOutcome {
            succeeded: false,
            detail: Some("scripted submit failure".to_owned()),
            error_kind: None,
            submit_failed: true,
            // Refused at submit: no stock job was ever minted, so nothing to correlate.
            job_id: None,
            outputs: None,
        };
        for id in ["row-a", "row-b", "row-c"] {
            harness.spool.append(&queued_row(id)).expect("row queued");
        }
        let chain = Arc::new(ScriptChain::scripted(vec![
            submit_failure(),
            submit_failure(),
        ]));
        let cycle_id = harness.cell.claim(CyclePhase::Unloading).expect("claim");
        let report = drive(CycleRun {
            cell: harness.cell.clone(),
            seams: harness.seams(chain.clone()),
            spool: harness.spool.clone(),
            guard: guard(true, true),
            cycle_id,
            sessions: Arc::new(fakes::ScriptSessions::idle()),
        })
        .await;
        assert_eq!(report["ok"], false, "{report}");
        assert_eq!(
            report["fault"]["reason"], FAULT_CYCLE,
            "the poison fault reuses the cycle word: no new wire word"
        );
        assert!(
            report["fault"]["detail"]
                .as_str()
                .expect("detail")
                .contains("poison-row guard"),
            "the hint names the guard: {report}"
        );
        // Row 3 never reached the submit chain: the drain aborted after two.
        assert_eq!(
            chain.seen.lock().expect("chain log").len(),
            2,
            "the third row was never submitted"
        );
        // The un-started row is Queued durably — the guard never marks it failed.
        let rows = harness.spool.snapshot().expect("healthy");
        let row_c = rows
            .iter()
            .find(|row| row.id == "row-c")
            .expect("row c still spooled");
        assert_eq!(
            row_c.status,
            RowStatus::Queued,
            "not failed, honestly queued"
        );
        // Already-submitted rows keep their terminal statuses durably.
        assert_eq!(
            rows.iter()
                .filter(|row| row.status == RowStatus::Failed)
                .count(),
            2,
            "the two poisoned rows stay failed"
        );
        // The report answers all three rows: two failed, one not started.
        let report_rows = report["rows"].as_array().expect("rows");
        assert_eq!(report_rows.len(), 3);
        let not_started = report_rows
            .iter()
            .find(|row| row["id"] == "row-c")
            .expect("row c in the report");
        assert_eq!(not_started["status"], "queued");
        // The card still comes back: the free and restore legs ran for the full cycle.
        assert_eq!(report["freed"], true, "{report}");
        assert_eq!(report["modelRestored"], true);
        assert_eq!(harness.door.free_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            harness.commands.runs.lock().expect("bat log").len(),
            2,
            "unload + restore: the handoff closes even on a poisoned batch"
        );
    }

    #[tokio::test]
    async fn a_prepare_refusal_lands_on_the_report_row_with_its_taxonomy_word() {
        let _gate = crate::resources::fence_test_gate();
        // LEG M12 (reviewer (3)): the drain no longer answers a bare
        // "prepare failed: {free string}". The report row carries the closed word
        // beside the stock string verbatim, and the row posture stays failed.
        let harness = Harness::new();
        harness
            .spool
            .append(&queued_row("row-p"))
            .expect("row queued");
        let stock_string = "Invalid model: 'weird.safetensors' is not in the allowlist";
        let chain = ScriptChain::scripted(vec![prepare_refused(stock_string.to_owned())]);
        let report = harness.run(chain, guard(true, true)).await;
        let report_rows = report["rows"].as_array().expect("rows");
        let row = &report_rows[0];
        assert_eq!(row["id"], "row-p");
        assert_eq!(row["status"], "failed", "the row posture is unchanged");
        let error = &row["error"];
        assert_eq!(error["kind"], "prepareRefused", "{report}");
        assert_eq!(
            error["detail"], stock_string,
            "the stock string rides verbatim"
        );
        // LEG M14c: the §12.1 addendum's repair hint rides the same row — the
        // hint is surfaced, no repair door is.
        assert_eq!(
            error["hint"].as_str().expect("repair hint"),
            PREPARE_REFUSAL_HINT,
            "{report}"
        );
        // No stock job was minted; one refused row in a one-row batch is ordinary
        // batch semantics (the poison floor is two), so the cycle stays ok.
        assert!(row["jobId"].is_null(), "{report}");
        assert_eq!(report["ok"], true, "{report}");
    }

    #[tokio::test]
    async fn the_poison_guard_counts_prepare_refusals_too() {
        let _gate = crate::resources::fence_test_gate();
        // The poison law rides `submit_failed`, not the detail shape: two
        // prepare-refusals of three abort the drain exactly like two plain submit
        // failures did, and the third row stays queued.
        let harness = Harness::new();
        for id in ["row-a", "row-b", "row-c"] {
            harness.spool.append(&queued_row(id)).expect("row queued");
        }
        let chain = Arc::new(ScriptChain::scripted(vec![
            prepare_refused("scripted prepare refusal one".to_owned()),
            prepare_refused("scripted prepare refusal two".to_owned()),
        ]));
        let cycle_id = harness.cell.claim(CyclePhase::Unloading).expect("claim");
        let report = drive(CycleRun {
            cell: harness.cell.clone(),
            seams: harness.seams(chain.clone()),
            spool: harness.spool.clone(),
            guard: guard(true, true),
            cycle_id,
            sessions: Arc::new(fakes::ScriptSessions::idle()),
        })
        .await;
        assert_eq!(report["fault"]["reason"], FAULT_CYCLE, "{report}");
        assert!(
            report["fault"]["detail"]
                .as_str()
                .expect("detail")
                .contains("poison-row guard"),
            "the guard counts classified refusals exactly as before: {report}"
        );
        assert_eq!(chain.seen.lock().expect("chain log").len(), 2);
        // Both poisoned rows carry the word on the report; the un-started row keeps
        // the plain-string posture.
        let report_rows = report["rows"].as_array().expect("rows");
        let refused = report_rows
            .iter()
            .filter(|row| row["error"]["kind"] == "prepareRefused")
            .count();
        assert_eq!(refused, 2, "both refusals name the word: {report}");
        assert!(
            report_rows
                .iter()
                .filter(|row| row["error"]["kind"] == "prepareRefused")
                .all(|row| row["error"]["hint"].is_string()),
            "M14c: every classified refusal row also carries the repair hint: {report}"
        );
        let not_started = report_rows
            .iter()
            .find(|row| row["status"] == "queued")
            .expect("the un-started row is reported queued");
        assert_eq!(
            not_started["error"]["kind"],
            Value::Null,
            "not-started rows stay unclassified"
        );
    }

    #[tokio::test]
    async fn one_submit_failure_never_trips_the_poison_guard() {
        let _gate = crate::resources::fence_test_gate();
        // The floor of two: a lone poisoned submit is ordinary batch semantics;
        // the drain continues and the cycle stays fault-free.
        let harness = Harness::new();
        let chain = ScriptChain::scripted(vec![
            RowOutcome {
                succeeded: false,
                detail: Some("scripted submit failure".to_owned()),
                error_kind: None,
                submit_failed: true,
                job_id: None,
                outputs: None,
            },
            RowOutcome {
                succeeded: true,
                detail: None,
                error_kind: None,
                submit_failed: false,
                job_id: Some("stock-ok".to_owned()),
                outputs: None,
            },
        ]);
        let report = harness.run(chain, guard(true, true)).await;
        assert_eq!(report["ok"], true, "{report}");
        assert!(report.get("fault").is_none(), "no abort for one failure");
        assert_eq!(report["rows"].as_array().expect("rows").len(), 3);
        let rows = harness.spool.snapshot().expect("healthy");
        assert!(
            rows.iter()
                .all(|row| matches!(row.status, RowStatus::Done | RowStatus::Failed)),
            "the whole batch drained"
        );
    }

    #[tokio::test]
    async fn post_render_failures_never_count_toward_the_poison_guard() {
        let _gate = crate::resources::fence_test_gate();
        // §5's carve-out, pinned: two rows reach the backend and fail there —
        // submit-side counting stays at zero, the drain completes normally.
        let harness = Harness::new();
        let post_failure = |job: &str| RowOutcome {
            succeeded: false,
            detail: Some("scripted mid-render failure".to_owned()),
            error_kind: None,
            submit_failed: false,
            // A row that reached the backend has a stock job: its failure carries the
            // correlation even though it never succeeded.
            job_id: Some(job.to_owned()),
            outputs: None,
        };
        let report = harness
            .run(
                ScriptChain::scripted(vec![
                    post_failure("stock-mid-1"),
                    post_failure("stock-mid-2"),
                ]),
                guard(true, true),
            )
            .await;
        assert_eq!(report["ok"], true, "{report}");
        assert!(
            report.get("fault").is_none(),
            "post-render is batch semantics"
        );
        assert_eq!(report["rows"].as_array().expect("rows").len(), 3);
        let rows = harness.spool.snapshot().expect("healthy");
        assert!(
            rows.iter()
                .all(|row| matches!(row.status, RowStatus::Done | RowStatus::Failed)),
            "every row ran: nothing was skipped"
        );
    }

    #[tokio::test]
    async fn dropped_caller_law_terminal_report_persists_and_reads_back() {
        let _gate = crate::resources::fence_test_gate();
        // The drive ran with no caller attached (poll posture): the terminal answer
        // must live in memory AND on disk beside the spool, and a fresh cell over
        // the same app-data (the restart/read-back path behind GET /v1/cycle) must
        // answer it verbatim.
        let harness = Harness::new();
        let report = harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        let cycle_id = report["cycleId"].as_str().expect("id").to_owned();
        let live = harness.cell.live();
        assert_eq!(live.phase, CyclePhase::Idle, "the fence released");
        let persisted = live.report.expect("terminal persisted");
        assert_eq!(persisted["cycleId"], cycle_id);
        assert_eq!(persisted["rows"].as_array().expect("rows").len(), 3);

        // The file carries the versioned cell record.
        let on_disk: Value = serde_json::from_slice(
            &std::fs::read(harness.dir.path().join(FILE)).expect("cell file written"),
        )
        .expect("valid json");
        assert_eq!(on_disk["version"], CELL_VERSION);
        assert_eq!(on_disk["cycleId"], cycle_id);
        assert_eq!(on_disk["report"]["ok"], true);

        // A fresh cell (the read door) answers the same terminal report.
        let reopened = CycleCell::new(harness.dir.path());
        let live = reopened.live();
        assert_eq!(live.phase, CyclePhase::Idle);
        assert_eq!(live.cycle_id.as_deref(), Some(cycle_id.as_str()));
        assert_eq!(
            live.report.expect("read back")["rows"]
                .as_array()
                .expect("rows")
                .len(),
            3
        );
    }

    /// W3-1 boot-epoch truth (LEG AF2-M21b): a READY report from a PREVIOUS boot is
    /// not a ready fact about THIS boot's card — a crash between the free ack and the
    /// proven restore leaves the old `modelRestored:true` on disk. The cell's boot
    /// downgrades it; `GET /v1/resume` then owes the restore instead of lying.
    #[test]
    fn a_persisted_ready_report_from_a_previous_boot_downgrades_at_the_next_boot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = CycleCell::new(dir.path());
        first
            .claim(CyclePhase::Draining)
            .expect("the first boot claims");
        first.finish(json!({"cycleId": "first-boot-cycle", "ok": true, "modelRestored": true}));
        let on_disk: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).expect("cell file"))
                .expect("cell bytes");
        assert!(
            on_disk["bootEpoch"].is_string(),
            "the finish stamps the boot epoch into the durable record: {on_disk}"
        );

        let second = CycleCell::new(dir.path());
        let live = second.live();
        let report = live.report.expect("the record still reads back");
        assert_eq!(
            report["modelRestored"], false,
            "the foreign-boot ready claim is downgraded to an owed restore"
        );
        assert_eq!(
            report["bootEpochNote"],
            "report is from a previous boot; a crash between free and restore cannot be ruled out"
        );
        assert_eq!(
            report["cycleId"], "first-boot-cycle",
            "the identity survives"
        );
        // The resume law over the downgraded report: debt, never ready.
        assert_eq!(
            super::super::resume::posture(
                "http://127.0.0.1:18502/health",
                CyclePhase::Idle,
                Some(&report),
                None,
                0,
            ),
            super::super::resume::ResumeState::DebtOutstanding,
            "resume cannot answer Ready on a report this boot cannot vouch for"
        );
    }

    /// The same-boot path: the cell's OWN finish keeps its ready promise intact (no
    /// downgrade, no note) and the epoch on disk matches the live cell's boot.
    #[test]
    fn a_ready_report_from_the_current_boot_stands_and_stays_ready() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cell = CycleCell::new(dir.path());
        cell.claim(CyclePhase::Draining).expect("claim");
        cell.finish(json!({"cycleId": "this-boot-cycle", "ok": true, "modelRestored": true}));
        let report = cell.live().report.expect("terminal in memory");
        assert_eq!(
            report["modelRestored"], true,
            "this boot proved the restore"
        );
        assert!(
            report.get("bootEpochNote").is_none(),
            "no honesty note on a same-boot report: {report}"
        );
        assert_eq!(
            super::super::resume::posture(
                "http://127.0.0.1:18502/health",
                CyclePhase::Idle,
                Some(&report),
                None,
                0,
            ),
            super::super::resume::ResumeState::Ready
        );
    }

    /// The legacy half of the law pinned honestly: a pre-M21b record carries no
    /// `bootEpoch`, so it is a foreign boot by the same rule — a ready claim
    /// downgrades, a debt claim (the honest half) rides through UNTOUCHED.
    #[test]
    fn a_report_without_a_boot_epoch_is_a_foreign_boot_and_postures_honestly() {
        let dir = tempfile::tempdir().expect("tempdir");
        for (name, restored, want_ready_after) in
            [("legacy-ready", true, false), ("legacy-debt", false, false)]
        {
            std::fs::write(
                dir.path().join(FILE),
                serde_json::to_vec(&json!({
                    "version": CELL_VERSION,
                    "cycleId": name,
                    "completedAt": 1,
                    "report": {"cycleId": name, "ok": !restored, "modelRestored": restored},
                }))
                .expect("legacy bytes"),
            )
            .expect("legacy record lands");
            let cell = CycleCell::new(dir.path());
            let report = cell.live().report.expect("legacy record reads");
            assert_eq!(
                report["modelRestored"], want_ready_after,
                "{name}: {report}"
            );
            assert_eq!(
                report.get("bootEpochNote").is_some(),
                restored,
                "{name}: only a ready claim gets the note"
            );
            assert_eq!(
                super::super::resume::posture(
                    "http://127.0.0.1:18502/health",
                    CyclePhase::Idle,
                    Some(&report),
                    None,
                    0,
                ),
                super::super::resume::ResumeState::DebtOutstanding,
                "{name}: neither legacy shape may posture Ready"
            );
        }
    }

    #[tokio::test]
    async fn rows_arriving_after_the_snapshot_wait_for_the_next_batch() {
        let _gate = crate::resources::fence_test_gate();
        // The batch snapshot is taken at start; rows appended while the drain runs
        // stay queued for the next claim.
        let harness = Harness::new();
        for id in ["row-a", "row-b", "row-c"] {
            harness.spool.append(&queued_row(id)).expect("queued");
        }
        let cycle_id = harness.cell.claim(CyclePhase::Unloading).expect("claim");
        let late = queued_row("row-late");
        // The mid-drain append seam: the first row's chain call appends the late
        // arrival while the snapshot-driven drain is already running.
        let chain_late = Arc::new(LateAppendingChain {
            spool: harness.spool.clone(),
            late: Mutex::new(Some(late)),
        });
        let seams = Arc::new(CycleSeams {
            chain: chain_late,
            ..seams_of(&harness)
        });
        let report = drive(CycleRun {
            cell: harness.cell.clone(),
            seams,
            spool: harness.spool.clone(),
            guard: guard(false, true),
            cycle_id,
            sessions: Arc::new(fakes::ScriptSessions::idle()),
        })
        .await;
        assert_eq!(report["ok"], true, "{report}");
        assert_eq!(
            report["rows"].as_array().expect("rows").len(),
            3,
            "only the snapshot drained"
        );
        let rows = harness.spool.snapshot().expect("healthy");
        let late_row = rows
            .iter()
            .find(|row| row.id == "row-late")
            .expect("late row exists");
        assert_eq!(
            late_row.status,
            RowStatus::Queued,
            "the late row waits for the next batch"
        );
    }

    /// A chain that appends one late row into the spool on its second call, so the
    /// snapshot-vs-live race is exercised mid-drain, not around it.
    struct LateAppendingChain {
        spool: Arc<Spool>,
        late: Mutex<Option<QueueRow>>,
    }

    impl SubmitChain for LateAppendingChain {
        fn run_row(&self, _row_id: &str, _intent: Value) -> BoxFuture<'static, RowOutcome> {
            if let Some(row) = self.late.lock().expect("late slot").take() {
                self.spool.append(&row).expect("late append");
            }
            Box::pin(async move {
                RowOutcome {
                    succeeded: true,
                    detail: None,
                    error_kind: None,
                    submit_failed: false,
                    job_id: None,
                    outputs: None,
                }
            })
        }
    }

    fn seams_of(harness: &Harness) -> CycleSeams {
        CycleSeams {
            commands: harness.commands.clone(),
            chain: Arc::new(ScriptChain::all_done()),
            door: harness.door.clone(),
            correlation: harness.correlation.clone(),
            gate: harness.gate.clone(),
            health: harness.health.clone(),
            pacer: harness.pacer.clone(),
            startup: harness.startup.clone(),
        }
    }

    #[tokio::test]
    async fn the_compute_permit_is_released_for_the_drain_and_reacquired_for_free() {
        let _gate = crate::resources::fence_test_gate();
        // The measured deviation: reserve (legs) -> release (drain, the stock submit
        // chain owns the same gate) -> reacquire (free/restore legs).
        let harness = Harness::new();
        harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(
            harness.gate.reserves.load(Ordering::SeqCst),
            2,
            "one for the legs before the drain, one reacquired for free/restore"
        );
    }

    #[tokio::test]
    async fn the_drain_records_the_stock_job_id_on_the_row_while_the_row_is_still_running() {
        let _gate = crate::resources::fence_test_gate();
        // M9a correlation spine: the chain writes the stock id the moment submit
        // yields it — before the poll loop starts — so the row is traceable even if the
        // render is later wedged, cancelled or lost across a restart.
        let harness = Harness::new();
        for id in ["row-a", "row-b", "row-c"] {
            harness.spool.append(&queued_row(id)).expect("row queued");
        }
        let scripted = ["stock-a", "stock-b", "stock-c"]
            .into_iter()
            .map(|job| RowOutcome {
                succeeded: true,
                detail: None,
                error_kind: None,
                submit_failed: false,
                job_id: Some(job.to_owned()),
                outputs: None,
            })
            .collect();
        let chain =
            Arc::new(ScriptChain::scripted(scripted).with_spool(Arc::clone(&harness.spool)));
        let cycle_id = harness.cell.claim(CyclePhase::Draining).expect("claim");
        let seams = harness.seams(chain.clone());
        let report = drive(CycleRun {
            cell: harness.cell.clone(),
            seams,
            spool: harness.spool.clone(),
            guard: guard(false, false),
            cycle_id,
            sessions: Arc::new(fakes::ScriptSessions::idle()),
        })
        .await;
        assert_eq!(report["ok"], true, "{report}");
        // The report names the correlation for every row it answers (additive key).
        let pairs: Vec<(&str, &str)> = report["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| {
                (
                    row["id"].as_str().expect("row id"),
                    row["jobId"].as_str().expect("jobId rides the report"),
                )
            })
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("row-a", "stock-a"),
                ("row-b", "stock-b"),
                ("row-c", "stock-c")
            ]
        );
        // The durable row carries its stock id, and the chain's own mid-run record
        // proves the ORDER: at the instant the chain stood where the production poll
        // loop starts, the row already carried the id.
        let rows = harness.spool.snapshot().expect("healthy");
        let durable: Vec<(&str, Option<&str>)> = rows
            .iter()
            .map(|row| (row.id.as_str(), row.job_id.as_deref()))
            .collect();
        assert_eq!(
            durable,
            vec![
                ("row-a", Some("stock-a")),
                ("row-b", Some("stock-b")),
                ("row-c", Some("stock-c"))
            ]
        );
        let observed = chain.recorded.lock().expect("record log").clone();
        assert_eq!(
            observed,
            vec![
                ("row-a".to_owned(), Some("stock-a".to_owned())),
                ("row-b".to_owned(), Some("stock-b".to_owned())),
                ("row-c".to_owned(), Some("stock-c".to_owned())),
            ],
            "recorded before the poll, not after the row ended"
        );
    }

    #[tokio::test]
    async fn the_terminal_report_names_each_row_s_produced_outputs_verbatim() {
        let _gate = crate::resources::fence_test_gate();
        // M9g, the discovery half of §4.4 results retrieval: the persisted terminal report
        // says WHICH outputs a row produced, so a stranger can address
        // `GET /v1/outputs/{jobId}/{index}` from the row instead of guessing indexes. The
        // descriptors are the stock snapshot words verbatim (this plane never expands a
        // path), and the skip law keeps a row that published nothing free of the key:
        // silence is not an empty list.
        let harness = Harness::new();
        let descriptors = json!([
            {"filename": "deas-00001.png", "subfolder": "deas", "type": "output"},
            {"filename": "clip.webm", "subfolder": "", "type": "output", "format": "video/webm"},
        ]);
        let chain = ScriptChain::scripted(vec![
            RowOutcome {
                succeeded: true,
                detail: None,
                error_kind: None,
                submit_failed: false,
                job_id: Some("stock-out".to_owned()),
                outputs: Some(descriptors.clone()),
            },
            RowOutcome {
                succeeded: true,
                detail: None,
                error_kind: None,
                submit_failed: false,
                job_id: Some("stock-quiet".to_owned()),
                outputs: None,
            },
            // The third row takes the chain's scripted-fallback posture: done, nothing
            // published — the same shape an old (pre-M9g) chain answers.
        ]);
        let report = harness.run(chain, guard(false, false)).await;
        let rows = report["rows"].as_array().expect("rows");
        assert_eq!(rows.len(), 3, "{report}");
        assert_eq!(
            rows[0]["outputs"], descriptors,
            "the stock words ride verbatim"
        );
        assert!(
            rows[1].get("outputs").is_none(),
            "skip law: a row that published nothing carries no key"
        );
        assert!(
            rows[2].get("outputs").is_none(),
            "same for the fallback posture"
        );
    }

    #[test]
    fn the_capture_law_passes_a_non_empty_snapshot_list_and_skips_silence() {
        let _gate = crate::resources::fence_test_gate();
        // The production chain's capture law, pinned pure: polling a live backend is not a
        // unit-test subject (no GPU, no backend here), the law is. A NON-EMPTY `outputs`
        // list passes through untouched; every silence shape — absent key, empty list,
        // null, an object — becomes `None`, which the report renders as an absent key.
        let published = json!([{"filename": "a.png", "subfolder": "", "type": "output"}]);
        let snapshot = json!({"state": "succeeded", "outputs": published});
        assert_eq!(
            snapshot_outputs(&snapshot).expect("a published list rides"),
            published,
            "no field added, no field reshaped"
        );
        for silence in [
            json!({"state": "succeeded"}),
            json!({"state": "succeeded", "outputs": []}),
            json!({"state": "succeeded", "outputs": null}),
            json!({"state": "succeeded", "outputs": {"7": []}}),
        ] {
            assert!(snapshot_outputs(&silence).is_none(), "{silence} is silence");
        }
    }

    #[test]
    fn the_correlation_law_excuses_only_ids_a_spool_row_records() {
        let _gate = crate::resources::fence_test_gate();
        // The arithmetic of the drain law, pure so it is pinned without a managed
        // `Jobs` state: recorded excuses, unrecorded does not, order and dedup stand.
        let active = ["foreign-1", "mine", "foreign-2", "foreign-1"]
            .into_iter()
            .map(str::to_owned);
        let ids = uncorrelated_ids(active, ["mine".to_owned()]);
        assert_eq!(ids, vec!["foreign-1".to_owned(), "foreign-2".to_owned()]);
        assert!(
            uncorrelated_ids(["mine".to_owned()], ["mine".to_owned()]).is_empty(),
            "a fully correlated session is the drain's go-ahead"
        );
        assert!(uncorrelated_ids(Vec::new(), Vec::new()).is_empty());
    }

    #[test]
    fn a_previous_cycles_terminal_row_still_excuses_its_stock_job_id() {
        let _gate = crate::resources::fence_test_gate();
        // The point of the chain: the row an EARLIER cycle submitted is still a job
        // this plane owns the answer for, so its recorded id excuses it even after the
        // row went terminal.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let mut row = queued_row("row-past");
        row.status = RowStatus::Draining;
        spool.append(&row).expect("append lands");
        spool
            .set_job_id("row-past", "stock-past")
            .expect("correlation lands while draining");
        spool
            .set_status("row-past", RowStatus::Draining, RowStatus::Done)
            .expect("terminal");
        let recorded: Vec<String> = spool
            .snapshot()
            .expect("healthy")
            .into_iter()
            .filter_map(|row| row.job_id)
            .collect();
        assert_eq!(recorded, vec!["stock-past".to_owned()]);
        assert!(
            uncorrelated_ids(["stock-past".to_owned()], recorded).is_empty(),
            "the drain law excuses its own submitted job"
        );
    }

    #[test]
    fn a_row_that_never_reached_submit_excuses_no_active_stock_id() {
        let _gate = crate::resources::fence_test_gate();
        // `jobId: None` is the honest uncorrelated posture: a queued row (or an old row
        // written before the field shipped) cannot stand in for somebody else's job.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        spool
            .append(&queued_row("row-queued"))
            .expect("append lands");
        let recorded: Vec<String> = spool
            .snapshot()
            .expect("healthy")
            .into_iter()
            .filter_map(|row| row.job_id)
            .collect();
        assert!(recorded.is_empty());
        assert_eq!(
            uncorrelated_ids(["stock-foreign".to_owned()], recorded),
            vec!["stock-foreign".to_owned()],
            "the foreign id stays named"
        );
    }

    #[tokio::test]
    async fn the_drain_law_refuses_uncorrelated_active_stock_jobs_by_name() {
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        let seams = CycleSeams {
            correlation: Arc::new(ScriptCorrelation::foreign([
                "stock-foreign-1",
                "stock-foreign-2",
            ])),
            ..seams_of(&harness)
        };
        let error = refuse_uncorrelated(&seams)
            .await
            .expect_err("a held card is not the drain's to take");
        assert_eq!(error.body_json()["reason"], "jobUnknown");
        assert_eq!(error.body_json()["error"], "JOB_UNKNOWN");
        let hint = error.body_json()["hint"].as_str().expect("hint").to_owned();
        assert!(
            hint.contains("stock-foreign-1") && hint.contains("stock-foreign-2"),
            "{hint} names the foreign ids"
        );
        assert!(
            hint.contains("POST /v1/stop") && hint.contains("POST /v1/jobs/{id}/cancel"),
            "{hint} names the remedy the next leg ships"
        );
        // The law refuses without touching the fence: the cell never moved off idle.
        assert_eq!(phase_word(harness.cell.live().phase), "idle");
    }

    #[tokio::test]
    async fn an_unreadable_correlation_fact_fails_closed_instead_of_reading_clean() {
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        let seams = CycleSeams {
            correlation: Arc::new(ScriptCorrelation::unreadable("spool is corrupt")),
            ..seams_of(&harness)
        };
        let error = refuse_uncorrelated(&seams)
            .await
            .expect_err("an unreadable fact is never read as clean");
        assert_eq!(error.body_json()["reason"], "maintenanceActive");
        assert!(
            error.body_json()["hint"]
                .as_str()
                .expect("hint")
                .contains("spool is corrupt"),
            "the honest reason rides the hint"
        );
    }

    #[tokio::test]
    async fn a_clean_correlation_read_is_the_drains_go_ahead() {
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        let seams = seams_of(&harness);
        refuse_uncorrelated(&seams)
            .await
            .expect("nothing held, nothing uncorrelated: the drain may start");
        assert_eq!(
            harness
                .correlation
                .calls
                .load(std::sync::atomic::Ordering::SeqCst),
            2,
            "one render-correlation read, one export-ledger read (E28, LEG AF2-M24b widened the law to both facts)"
        );
    }

    /// A chain that latches a watchdog sever onto the cell on its FIRST row: the
    /// mid-drain arm C1 exists for. The scripted answer is the arm's own posture — it
    /// already ran `cancel → confirm → clear → free → RESTORE` in its law order, and it
    /// says what the card looks like from its side.
    struct SeveringChain {
        cell: Arc<CycleCell>,
        seen: Mutex<Vec<String>>,
        /// True drives the F1 posture: the latch is the arm's PROVISIONAL one —
        /// published at the arm's start, its free/restore legs still ahead of it.
        provisional: bool,
    }

    impl SubmitChain for SeveringChain {
        fn run_row(&self, row_id: &str, _intent: Value) -> BoxFuture<'static, RowOutcome> {
            self.seen.lock().expect("seen log").push(row_id.to_owned());
            if self.seen.lock().expect("seen log").len() == 1 {
                if self.provisional {
                    self.cell.note_sever(json!({
                        "provisional": true,
                        "severedRow": row_id,
                        "freed": false,
                        "restored": false,
                        "phase": "arm-running",
                    }));
                } else {
                    self.cell.note_sever(json!({
                        "reason": super::super::watchdog::FAULT_SEVER,
                        "severedRow": row_id,
                        "freed": true,
                        "restored": true,
                    }));
                }
            }
            Box::pin(async move {
                RowOutcome {
                    succeeded: true,
                    detail: None,
                    error_kind: None,
                    submit_failed: false,
                    job_id: None,
                    outputs: None,
                }
            })
        }
    }

    #[tokio::test]
    async fn a_sever_latched_mid_drain_stops_the_drain_before_the_next_submit() {
        let _gate = crate::resources::fence_test_gate();
        // C1 (the sever/drain race): the arm's legs take seconds, so a latch can land
        // while the drain is still submitting rows. The per-row probe must stop the drain
        // there — no further row is submitted, the arm's facts ride the report as the
        // cycle's fault, and the drain runs NO free/restore legs of its own. A second
        // handoff under a card the arm just restored is exactly the double handoff this
        // fix closes.
        let harness = Harness::new();
        for id in ["row-a", "row-b", "row-c"] {
            harness.spool.append(&queued_row(id)).expect("row queued");
        }
        let cycle_id = harness.cell.claim(CyclePhase::Unloading).expect("claim");
        let chain = Arc::new(SeveringChain {
            cell: Arc::clone(&harness.cell),
            seen: Mutex::new(Vec::new()),
            provisional: false,
        });
        let report = drive(CycleRun {
            cell: harness.cell.clone(),
            seams: Arc::new(CycleSeams {
                chain: chain.clone(),
                ..seams_of(&harness)
            }),
            spool: harness.spool.clone(),
            guard: guard(true, true),
            cycle_id,
            sessions: Arc::new(fakes::ScriptSessions::idle()),
        })
        .await;
        assert_eq!(
            report["fault"]["reason"],
            super::super::watchdog::FAULT_SEVER,
            "{report}: the sever is the cycle's fault"
        );
        assert!(
            report["fault"]["detail"]
                .as_str()
                .expect("detail")
                .contains("row-a"),
            "the answer names the row the arm took: {report}"
        );
        assert_eq!(report["freed"], true, "the arm's fact rides the report");
        assert_eq!(report["modelRestored"], true, "the arm restored the model");
        let seen = chain.seen.lock().expect("seen log").clone();
        assert_eq!(
            seen.as_slice(),
            ["row-a"],
            "the drain stopped before the second submit: {seen:?}"
        );
        assert_eq!(
            harness.door.free_calls.load(Ordering::SeqCst),
            0,
            "no second free leg under a sever that already freed"
        );
        assert_eq!(
            harness.door.proof_calls.load(Ordering::SeqCst),
            0,
            "not even the idle proof runs once the latch is seen"
        );
        assert_eq!(
            harness.health.probes.load(Ordering::SeqCst),
            0,
            "no second health poll under a sever"
        );
        let bats = harness.commands.runs.lock().expect("bat log");
        assert_eq!(
            bats.as_slice(),
            ["unload.bat /agent"],
            "the restore bat is the arm's, never the drain's"
        );
        // The rows the drain never reached are reported queued and stay queued durably;
        // the abort leaves no `draining` orphan behind (the C2 class).
        let statuses: Vec<(&str, &str)> = report["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| {
                (
                    row["id"].as_str().expect("id"),
                    row["status"].as_str().expect("word"),
                )
            })
            .collect();
        assert_eq!(
            statuses.as_slice(),
            [("row-a", "done"), ("row-b", "queued"), ("row-c", "queued")],
            "{report}"
        );
        let rows = harness.spool.snapshot().expect("healthy");
        assert_eq!(
            rows.iter()
                .filter(|row| row.status == RowStatus::Queued)
                .count(),
            2,
            "the un-submitted rows wait for the next batch, honestly queued"
        );
        assert!(
            rows.iter().all(|row| row.status != RowStatus::Draining),
            "a sever abort creates no new draining orphan"
        );
    }

    #[tokio::test]
    async fn a_provisional_sever_latch_stops_the_drain_and_hands_the_legs_to_the_arm() {
        let _gate = crate::resources::fence_test_gate();
        // F1 (LEG AF2-M20): the arm publishes its latch the moment it takes the cell,
        // with its free/restore legs still ahead of it. A drain that notices the latch
        // mid-leg must (a) stop submitting, (b) record the honest PROVISIONAL posture —
        // nothing freed, nothing restored, the fault naming the RUNNING arm — and
        // (c) run ZERO legs of its own: the arm owns those legs, and a second free/
        // restore pair stacked onto the arm's is the two-bats double-load this latch
        // exists to close.
        let harness = Harness::new();
        for id in ["row-a", "row-b", "row-c"] {
            harness.spool.append(&queued_row(id)).expect("row queued");
        }
        let cycle_id = harness.cell.claim(CyclePhase::Unloading).expect("claim");
        let chain = Arc::new(SeveringChain {
            cell: Arc::clone(&harness.cell),
            seen: Mutex::new(Vec::new()),
            provisional: true,
        });
        let report = drive(CycleRun {
            cell: harness.cell.clone(),
            seams: Arc::new(CycleSeams {
                chain: chain.clone(),
                ..seams_of(&harness)
            }),
            spool: harness.spool.clone(),
            guard: guard(true, true),
            cycle_id,
            sessions: Arc::new(fakes::ScriptSessions::idle()),
        })
        .await;
        assert_eq!(
            report["fault"]["reason"],
            super::super::watchdog::FAULT_SEVER,
            "{report}: the running arm is still the cycle's fault"
        );
        let detail = report["fault"]["detail"].as_str().expect("detail");
        assert!(
            detail.contains("sever arm was running"),
            "the answer names the running arm, not a finished sever: {report}"
        );
        assert!(detail.contains("row-a"), "the row the arm took: {report}");
        assert_eq!(
            report["freed"], false,
            "nothing is claimed freed while the arm's legs run"
        );
        assert_eq!(
            report["modelRestored"], false,
            "nothing is claimed restored while the arm's legs run"
        );
        // CRITICAL: on the provisional latch the drain still runs NO legs of its own.
        assert_eq!(
            harness.door.free_calls.load(Ordering::SeqCst),
            0,
            "the free legs belong to the arm"
        );
        assert_eq!(
            harness.door.proof_calls.load(Ordering::SeqCst),
            0,
            "not even the idle proof runs under the latch"
        );
        assert_eq!(
            harness.health.probes.load(Ordering::SeqCst),
            0,
            "the restore leg belongs to the arm"
        );
        let bats = harness.commands.runs.lock().expect("bat log");
        assert_eq!(
            bats.as_slice(),
            ["unload.bat /agent"],
            "the drain never fires a restore bat beside the arm's"
        );
        // The rows the drain never reached are reported queued and stay queued.
        let statuses: Vec<(&str, &str)> = report["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| {
                (
                    row["id"].as_str().expect("id"),
                    row["status"].as_str().expect("word"),
                )
            })
            .collect();
        assert_eq!(
            statuses.as_slice(),
            [("row-a", "done"), ("row-b", "queued"), ("row-c", "queued")],
            "{report}"
        );
        let rows = harness.spool.snapshot().expect("healthy");
        assert!(
            rows.iter().all(|row| row.status != RowStatus::Draining),
            "the handoff leaves no draining orphan"
        );
    }

    /// The hung-bat posture (W1): a child that never exits. Production reaches this
    /// through a real process, which tests never spawn (box law), so the MONITOR law is
    /// pinned here instead — the seam boundary is the whole point of the fix.
    struct HungBat {
        polls: u32,
        killed: bool,
        kills: u32,
    }

    impl BatHandle for HungBat {
        fn try_exit(&mut self) -> Result<Option<i32>, String> {
            self.polls += 1;
            Ok(None)
        }
        fn pid(&self) -> u32 {
            // No pid to aim a tree kill at: the fake bat is never a real process, and
            // no spawn is ever run at test time (box law). This is also exactly the
            // shape the taskkill FAILURE path takes — straight to the fallback kill.
            0
        }
        fn kill(&mut self) -> Result<(), String> {
            self.killed = true;
            self.kills += 1;
            Ok(())
        }
    }

    /// The honest bat: it exits at its scripted poll with its scripted code.
    struct ExitingBat {
        polls: u32,
        exits_at: u32,
        code: i32,
        killed: bool,
    }

    impl BatHandle for ExitingBat {
        fn try_exit(&mut self) -> Result<Option<i32>, String> {
            self.polls += 1;
            if self.polls >= self.exits_at {
                Ok(Some(self.code))
            } else {
                Ok(None)
            }
        }
        fn pid(&self) -> u32 {
            0
        }
        fn kill(&mut self) -> Result<(), String> {
            self.killed = true;
            Ok(())
        }
    }

    #[test]
    fn a_hung_bat_is_killed_at_its_deadline_instead_of_parking_the_leg() {
        let _gate = crate::resources::fence_test_gate();
        // W1: a hung unload bat used to wait in `.output()` forever, which parked the
        // cycle in `unloading` with the fence held while the watchdog stood down under
        // that same phase — nobody drives it, a deterministic wedge. The monitor ends it.
        let mut bat = HungBat {
            polls: 0,
            killed: false,
            kills: 0,
        };
        let problem = wait_for_bat(&mut bat, 5, 0, 2)
            .expect_err("a bat that never exits must end at its budget");
        assert!(
            problem.contains("timed out after 5 ms") && problem.contains("killed"),
            "{problem} names the budget and the kill"
        );
        assert!(bat.killed, "the hung child was killed, not abandoned");
        assert_eq!(
            bat.kills, 1,
            "F3: the expiry path routes the kill through kill_bat_tree exactly once"
        );
        assert!(
            bat.polls >= 3,
            "the monitor polled the child ({} times) before and after the kill", // reap tail included
            bat.polls
        );
    }

    #[test]
    fn kill_bat_tree_falls_back_to_the_direct_kill_when_the_handle_offers_no_pid() {
        let _gate = crate::resources::fence_test_gate();
        // F3 (LEG AF2-M20), the wrapper's one home. A real Windows bat child
        // advertises its pid and goes down by TREE (`taskkill /T /F /PID`); the fakes
        // advertise pid 0 precisely so tests never aim a spawn at anything (box law),
        // landing on the same direct-kill arm the taskkill-FALLBACK path takes. The
        // taskkill branch itself is production-only by that same law.
        let mut bat = HungBat {
            polls: 0,
            killed: false,
            kills: 0,
        };
        kill_bat_tree(&mut bat).expect("the fallback kill answers");
        assert!(bat.killed, "the direct kill ran through the wrapper");
        assert_eq!(bat.kills, 1, "exactly once — no double-kill");
    }

    #[test]
    fn a_bat_that_exits_keeps_its_exit_code_and_is_never_killed() {
        let _gate = crate::resources::fence_test_gate();
        // The other half: the budget must not touch an honest leg.
        let mut bat = ExitingBat {
            polls: 0,
            exits_at: 3,
            code: 7,
            killed: false,
        };
        assert_eq!(
            wait_for_bat(&mut bat, 60_000, 0, 2).expect("the bat answered on its own"),
            7
        );
        assert_eq!(
            bat.polls, 3,
            "the monitor stopped the moment the child answered"
        );
        assert!(!bat.killed, "a bat that exits on its own is never killed");
    }

    #[tokio::test]
    async fn the_unload_leg_carries_the_unload_budget_and_the_restore_leg_the_restore_budget() {
        let _gate = crate::resources::fence_test_gate();
        // W1 at the seam boundary: the budget is stated by the CALLER, so each leg names
        // its own physics. The watchdog's sever arm runs `restore_leg` itself, so the
        // restore budget covers the arm's leg too (pinned in watchdog.rs).
        let harness = Harness::new();
        harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(
            harness
                .commands
                .budgets
                .lock()
                .expect("budget log")
                .as_slice(),
            [UNLOAD_TIMEOUT_MS, RESTORE_TIMEOUT_MS],
            "one unload, one restore, each with its own budget"
        );
    }

    #[tokio::test]
    async fn a_row_driver_that_never_goes_terminal_expires_at_the_deadline() {
        let _gate = crate::resources::fence_test_gate();
        // W2: a hot-wedged row keeps the backend busy, so the watchdog's fact two never
        // goes quiet and no arm ever trips — the poll loop was then the fence's lease for
        // nothing. The injected short deadline runs the same law the production call runs
        // with [`ROW_DEADLINE_MS`].
        let mut polls: u32 = 0;
        let poll = poll_row(
            || {
                polls += 1;
                async move { Ok(json!({ "state": "running" })) }
            },
            0,
            20,
            600_000,
            &TERMINAL_ROW_WORDS,
        )
        .await;
        assert!(matches!(poll, RowPoll::Expired), "{poll:?}");
        assert!(polls > 1, "the loop polled the driver {polls} times first");
    }

    #[tokio::test]
    async fn the_row_poll_returns_the_terminal_snapshot_and_stops_there() {
        let _gate = crate::resources::fence_test_gate();
        let mut polls: u32 = 0;
        let poll = poll_row(
            || {
                polls += 1;
                let snapshot = if polls == 1 {
                    json!({ "state": "running" })
                } else {
                    json!({ "state": "succeeded", "outputs": [{ "filename": "a.png" }] })
                };
                async move { Ok(snapshot) }
            },
            0,
            60_000,
            600_000,
            &TERMINAL_ROW_WORDS,
        )
        .await;
        match poll {
            RowPoll::Terminal(snapshot) => assert_eq!(snapshot["state"], "succeeded"),
            other => panic!("the terminal word must end the poll: {other:?}"),
        }
        assert_eq!(polls, 2, "the loop stopped at the terminal word");
    }

    #[tokio::test]
    async fn an_unreadable_row_driver_ends_the_poll_at_once() {
        let _gate = crate::resources::fence_test_gate();
        let poll = poll_row(
            || async { Err("the row driver is gone".to_owned()) },
            0,
            60_000,
            600_000,
            &TERMINAL_ROW_WORDS,
        )
        .await;
        match poll {
            RowPoll::Unreadable(problem) => assert_eq!(problem, "the row driver is gone"),
            other => panic!("an unreadable driver is named, never retried forever: {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_answer_with_no_state_word_fails_fast_rather_than_polling_on() {
        let _gate = crate::resources::fence_test_gate();
        let poll = poll_row(
            || async { Ok(json!({ "no state here": true })) },
            0,
            60_000,
            600_000,
            &TERMINAL_ROW_WORDS,
        )
        .await;
        assert!(matches!(poll, RowPoll::NoStateWord), "{poll:?}");
    }

    #[tokio::test]
    async fn a_job_never_seen_running_stalls_out_at_the_queued_bound() {
        let _gate = crate::resources::fence_test_gate();
        // W4-E (LEG AF2-M22): a submit-stuck job whose word stays `queued` keeps
        // the judge stood down (W3-7's confirmation never lands) — without this
        // bound the row rides the 60-min running deadline with nobody watching.
        // The absolute [QUEUED_STALL_MS] bound fires inside the (injected, larger)
        // row deadline — the same precedence production runs with 600_000 inside
        // ROW_DEADLINE_MS. The injected short stall bound keeps the drill fast;
        // production passes the pinned const.
        let mut polls: u32 = 0;
        let poll = poll_row(
            || {
                polls += 1;
                async move { Ok(json!({ "state": "queued" })) }
            },
            0,
            60_000,
            20,
            &TERMINAL_ROW_WORDS,
        )
        .await;
        assert!(matches!(poll, RowPoll::QueuedStalled), "{poll:?}");
        assert!(
            polls > 1,
            "the loop polled the queued word {polls} times first"
        );
    }

    #[tokio::test]
    async fn a_queued_job_that_starts_keeps_the_running_row_deadline_untouched() {
        let _gate = crate::resources::fence_test_gate();
        // W4-E's boundary: the stall clock only runs while the job has NEVER been
        // seen running. `queued` then `running` past the (injected) queued bound
        // must answer the RUNNING law — RowPoll::Expired, the W2/F2 deadline —
        // never the stall. The 60-min running law stands unchanged.
        let mut polls: u32 = 0;
        let poll = poll_row(
            || {
                polls += 1;
                let snapshot = if polls == 1 {
                    json!({ "state": "queued" })
                } else {
                    json!({ "state": "running" })
                };
                async move { Ok(snapshot) }
            },
            0,
            20,
            20,
            &TERMINAL_ROW_WORDS,
        )
        .await;
        assert!(matches!(poll, RowPoll::Expired), "{poll:?}");
    }

    #[tokio::test]
    async fn the_ready_gate_passes_a_warm_backend_on_one_status_read_and_one_probe() {
        let _gate = crate::resources::fence_test_gate();
        // E29 fast path: a warm backend must not slow or change posture — the
        // first ("running", endpoint) pair plus the first /queue 200 pass the
        // gate with ZERO extra reads and zero sleeps.
        let mut reads: u32 = 0;
        let mut probes: u32 = 0;
        let base = ready_backend(
            || {
                reads += 1;
                async {
                    (
                        "running".to_owned(),
                        Some("http://127.0.0.1:8188".to_owned()),
                    )
                }
            },
            &mut |_endpoint: String| {
                probes += 1;
                async { true }
            },
            0,
            5_000,
        )
        .await
        .expect("a warm backend is ready");
        assert_eq!(base.as_str(), "http://127.0.0.1:8188/");
        assert_eq!(reads, 1, "one status read on the fast path");
        assert_eq!(probes, 1, "one /queue proof on the fast path");
    }

    #[tokio::test]
    async fn the_ready_gate_waits_through_starting_ticks_until_running_then_probes() {
        let _gate = crate::resources::fence_test_gate();
        // E29's whole point (the W-L2 live class): a booting backend answering
        // `starting` is WAITED on, never failed — the gate accepts the first
        // ("running", endpoint) tick and completes on that tick's /queue 200.
        let mut reads: u32 = 0;
        let mut probes: u32 = 0;
        let base = ready_backend(
            || {
                reads += 1;
                let tick = reads;
                async move {
                    if tick < 3 {
                        ("starting".to_owned(), None)
                    } else {
                        (
                            "running".to_owned(),
                            Some("http://127.0.0.1:8188".to_owned()),
                        )
                    }
                }
            },
            &mut |_endpoint: String| {
                probes += 1;
                async { true }
            },
            1,
            30_000,
        )
        .await
        .expect("the gate rides starting ticks to a ready backend");
        assert_eq!(base.as_str(), "http://127.0.0.1:8188/");
        assert_eq!(reads, 3, "two starting ticks, then the running tick");
        assert_eq!(probes, 1, "exactly one /queue proof, on the running tick");
    }

    #[tokio::test]
    async fn the_ready_gate_expires_honestly_naming_the_last_state_word() {
        let _gate = crate::resources::fence_test_gate();
        // E29's honest expiry: a backend that never reaches `running` fails the
        // window with the LAST word observed and the word stage named — the
        // submit-side failure the poison guard counts, never a silent timeout.
        let mut reads: u32 = 0;
        let fault = ready_backend(
            || {
                reads += 1;
                async { ("starting".to_owned(), None) }
            },
            &mut |_endpoint: String| async { unreachable!("never running, never probed") },
            0,
            20,
        )
        .await
        .expect_err("a never-running backend must expire, not pass");
        assert_eq!(fault.stage, ReadyStage::Word);
        assert_eq!(fault.last_word, "starting", "the hint names the last word");
        assert!(reads > 1, "the gate polled the word {reads} times first");
        let detail = fault.detail();
        assert!(detail.contains("never reported running"), "{detail}");
        assert!(detail.contains("'starting'"), "{detail} names the word");
        assert!(detail.contains("20 ms"), "{detail} names the window");
    }

    #[tokio::test]
    async fn the_ready_gate_expires_at_the_probe_stage_when_the_queue_never_answers() {
        let _gate = crate::resources::fence_test_gate();
        // E29's second expiry class: the word is `running` but the endpoint's
        // own /queue never answers 200 — the fact is incomplete, the gate polls
        // to its bound and names the PROBE stage, never the word stage.
        let mut reads: u32 = 0;
        let mut probes: u32 = 0;
        let fault = ready_backend(
            || {
                reads += 1;
                async {
                    (
                        "running".to_owned(),
                        Some("http://127.0.0.1:8188".to_owned()),
                    )
                }
            },
            &mut |_endpoint: String| {
                probes += 1;
                async { false }
            },
            0,
            20,
        )
        .await
        .expect_err("running-with-a-deaf-queue must expire at the probe");
        assert_eq!(fault.stage, ReadyStage::Probe);
        assert_eq!(fault.last_word, "running");
        assert!(probes > 1, "the gate probed {probes} times first");
        let detail = fault.detail();
        assert!(
            detail.contains("never answered"),
            "{detail} names the probe stage"
        );
    }

    #[tokio::test]
    async fn the_ready_gate_passes_when_the_queue_starts_answering_after_several_ticks() {
        let _gate = crate::resources::fence_test_gate();
        // The backend answers the word early but its HTTP surface lags (boot
        // class: the port opens after the process registers): the gate polls the
        // probe until one 200 lands, then passes.
        let mut probes: u32 = 0;
        let base = ready_backend(
            || async {
                (
                    "running".to_owned(),
                    Some("http://127.0.0.1:8188".to_owned()),
                )
            },
            &mut |_endpoint: String| {
                probes += 1;
                let answered = probes >= 4;
                async move { answered }
            },
            1,
            30_000,
        )
        .await
        .expect("the first answering tick completes the gate");
        assert_eq!(base.as_str(), "http://127.0.0.1:8188/");
        assert_eq!(probes, 4, "three deaf ticks, then the answering one");
    }

    #[tokio::test]
    async fn the_ready_gate_never_polls_past_its_window_plus_one() {
        let _gate = crate::resources::fence_test_gate();
        // E29 bounded-window law: status reads never exceed window/poll + 1 —
        // the wait is a backstop, never a new unbounded loop.
        const WINDOW_MS: u64 = 50;
        const POLL_MS: u64 = 5;
        let mut reads: u32 = 0;
        let fault = ready_backend(
            || {
                reads += 1;
                async { ("starting".to_owned(), None) }
            },
            &mut |_endpoint: String| async { unreachable!("never running, never probed") },
            POLL_MS,
            WINDOW_MS,
        )
        .await
        .expect_err("the window must expire");
        assert_eq!(fault.window_ms, WINDOW_MS);
        assert!(fault.elapsed_ms >= WINDOW_MS, "the window was honored");
        assert!(
            reads <= (WINDOW_MS / POLL_MS + 1) as u32,
            "the gate polled {reads} times past the {} ms window at {} ms cadence",
            WINDOW_MS,
            POLL_MS
        );
    }

    #[tokio::test]
    async fn a_booting_backend_no_longer_fails_the_row_before_prepare() {
        let _gate = crate::resources::fence_test_gate();
        // W-L2, the live finding this leg exists for: the drain submitted while
        // the backend answered `starting`, the single status read failed 2/2
        // rows with "no owned backend is running" and the poison guard aborted
        // the cycle. Through the chain's pre-submit leg (the seam-designed home
        // of gate + prepare), the same class of status script — `starting`
        // first, then `running` with an endpoint — must REACH THE SUBMIT SIDE:
        // the scripted prepare verb runs (it receives the gate's endpoint) and
        // the row never carries the old gate-side posture.
        let mut reads: u32 = 0;
        let handed = std::cell::RefCell::new(String::new());
        let outcome = pre_submit_leg(
            || {
                reads += 1;
                let tick = reads;
                async move {
                    if tick == 1 {
                        ("starting".to_owned(), None)
                    } else {
                        (
                            "running".to_owned(),
                            Some("http://127.0.0.1:8188".to_owned()),
                        )
                    }
                }
            },
            &mut |_endpoint: String| async { true },
            1,
            30_000,
            json!({ "graph": {} }),
            |base_url, _intent| {
                *handed.borrow_mut() = base_url;
                async { Err("SCRIPTED PREPARE REACHED".to_owned()) }
            },
        )
        .await
        .expect_err("the scripted prepare refuses honestly");
        assert_eq!(reads, 2, "the gate rode the starting tick to running");
        assert!(
            handed.borrow().starts_with("http://127.0.0.1:8188"),
            "the gate handed the ready endpoint to the submit side: {}",
            handed.borrow()
        );
        assert!(outcome.submit_failed, "a prepare refusal stays poison fuel");
        let detail = outcome.detail.expect("the honest prepare refusal");
        assert!(
            detail.contains("SCRIPTED PREPARE REACHED"),
            "the row reached the submit side instead of dying at the gate: {detail}"
        );
        assert!(
            !detail.contains("no owned backend is running") && !detail.contains("ready window"),
            "the row must not die at the gate while the backend boots: {detail}"
        );
    }

    #[test]
    fn the_row_deadline_outcome_is_a_render_side_failure_with_its_correlation() {
        let _gate = crate::resources::fence_test_gate();
        // The posture an expiry maps to: failed, render-side (so the poison guard must
        // not count it), correlation intact so the §4 result doors can still name the
        // job this plane stopped waiting on.
        let outcome = deadline_outcome("stock-hot-wedge", ROW_DEADLINE_MS, &[]);
        assert!(!outcome.succeeded, "the row is a failure");
        assert!(
            !outcome.submit_failed,
            "the row reached the backend, so it is not poison-guard fuel"
        );
        assert_eq!(outcome.job_id.as_deref(), Some("stock-hot-wedge"));
        assert_eq!(outcome.error_kind, None, "no taxonomy word is coined here");
        assert!(outcome.outputs.is_none(), "nothing was published");
        let detail = outcome.detail.expect("the detail names the deadline");
        assert!(
            detail.contains("row deadline") && detail.contains("stock-hot-wedge"),
            "{detail} names the deadline and the correlation"
        );
        assert!(
            detail.contains("scoped-cancelled"),
            "F2: the answer states the cancel ran: {detail}"
        );
        assert!(
            !detail.contains("cancel problem"),
            "acked verbs leave no problem note: {detail}"
        );
    }

    /// The deadline path's scoped-cancel seam: records the two verbs in call order
    /// and answers scripted postures per job id.
    #[derive(Default)]
    struct ScriptCancel {
        calls: Mutex<Vec<String>>,
        /// Job ids whose verbs refuse (both of them — the drill is the honest detail).
        fail: Vec<String>,
    }

    impl ScopedCancel for ScriptCancel {
        fn cancel_pending(&self, job_id: &str) -> BoxFuture<'static, Result<(), String>> {
            self.calls
                .lock()
                .expect("cancel log")
                .push(format!("cancel-pending {job_id}"));
            let fails = self.fail.iter().any(|id| id == job_id);
            Box::pin(async move {
                if fails {
                    Err("scripted: pending cancel refused".to_owned())
                } else {
                    Ok(())
                }
            })
        }
        fn interrupt_running(&self, job_id: &str) -> BoxFuture<'static, Result<(), String>> {
            self.calls
                .lock()
                .expect("cancel log")
                .push(format!("interrupt-running {job_id}"));
            let fails = self.fail.iter().any(|id| id == job_id);
            Box::pin(async move {
                if fails {
                    Err("scripted: running interrupt refused".to_owned())
                } else {
                    Ok(())
                }
            })
        }
    }

    #[tokio::test]
    async fn an_expired_row_poll_scoped_cancels_the_live_job_in_the_arm_order() {
        let _gate = crate::resources::fence_test_gate();
        // F2 (LEG AF2-M20): the deadline must not abandon a live render. The row's own
        // correlated job goes down through the stock workbench verbs before the
        // deadline posture is recorded: pending cancel first, then the running
        // interrupt (the arm's order law), both scoped to this job id alone.
        let cancel = ScriptCancel::default();
        let outcome = poll_outcome(RowPoll::Expired, "stock-zombie", &cancel).await;
        assert_eq!(
            cancel.calls.lock().expect("cancel log").as_slice(),
            [
                "cancel-pending stock-zombie",
                "interrupt-running stock-zombie",
            ],
            "both verbs, in the arm's order, scoped to the correlated id"
        );
        assert!(!outcome.succeeded, "the row lands failed");
        assert!(
            !outcome.submit_failed,
            "the row reached the backend: not poison-guard fuel"
        );
        assert_eq!(outcome.job_id.as_deref(), Some("stock-zombie"));
        let detail = outcome.detail.expect("the detail names the deadline");
        assert!(
            detail.contains("row deadline") && detail.contains("stock-zombie"),
            "{detail}"
        );
        assert!(
            !detail.contains("cancel problem"),
            "the verbs acked, so no problem note: {detail}"
        );
    }

    #[tokio::test]
    async fn a_queued_stall_scoped_cancels_and_names_the_stall_not_the_hour() {
        let _gate = crate::resources::fence_test_gate();
        // W4-E (LEG AF2-M22): the stall arm runs the same scoped-cancel drill (the
        // pending cancel FIRST — the verb a queued job actually answers — then the
        // running interrupt, honest even when it refuses), and the row's detail
        // names the STALL, never the 60-min running bound, so an operator reading
        // the answer sees what actually happened.
        let cancel = ScriptCancel::default();
        let outcome = poll_outcome(RowPoll::QueuedStalled, "stock-stuck", &cancel).await;
        assert_eq!(
            cancel.calls.lock().expect("cancel log").as_slice(),
            [
                "cancel-pending stock-stuck",
                "interrupt-running stock-stuck",
            ],
            "both verbs, in the arm's order, scoped to the correlated id"
        );
        assert!(!outcome.succeeded, "the row lands failed");
        assert!(
            !outcome.submit_failed,
            "the row reached the backend: not poison-guard fuel"
        );
        assert_eq!(outcome.job_id.as_deref(), Some("stock-stuck"));
        let detail = outcome.detail.expect("the detail names the stall");
        assert!(detail.contains("queued stall"), "{detail}");
        assert!(detail.contains("never started"), "{detail}");
        assert!(
            !detail.contains("row deadline"),
            "the hour-bound wording belongs to the running law alone: {detail}"
        );
    }

    #[tokio::test]
    async fn the_deadline_detail_names_cancel_refusals_verbatim() {
        let _gate = crate::resources::fence_test_gate();
        // Honest even when the card will not hear: the deadline row still records
        // (never-forever law), and the answer says the scoped cancel was refused,
        // naming BOTH verbs' stock problems verbatim.
        let cancel = ScriptCancel {
            fail: vec!["stock-deaf".to_owned()],
            ..Default::default()
        };
        let outcome = poll_outcome(RowPoll::Expired, "stock-deaf", &cancel).await;
        assert_eq!(
            cancel.calls.lock().expect("cancel log").as_slice(),
            ["cancel-pending stock-deaf", "interrupt-running stock-deaf",],
            "refused verbs were still attempted, in order"
        );
        let detail = outcome.detail.expect("the detail is honest");
        assert!(detail.contains("cancel problem"), "{detail}");
        assert!(
            detail.contains("pending cancel: scripted: pending cancel refused"),
            "{detail}"
        );
        assert!(
            detail.contains("running interrupt: scripted: running interrupt refused"),
            "{detail}"
        );
    }

    #[tokio::test]
    async fn a_non_expired_row_poll_fires_no_scoped_cancel() {
        let _gate = crate::resources::fence_test_gate();
        // The cancel belongs to the expiry arms alone (the deadline AND the W4-E
        // queued stall — both tested separately): a poll that ended on a terminal
        // word, an unreadable driver, or a missing state word sends no mutation
        // anywhere.
        let cancel = ScriptCancel::default();
        let done = poll_outcome(
            RowPoll::Terminal(json!({ "state": "succeeded" })),
            "job-1",
            &cancel,
        )
        .await;
        assert!(done.succeeded, "the terminal word still ends the row");
        let ended = poll_outcome(
            RowPoll::Terminal(json!({ "state": "cancelled", "error": "gone" })),
            "job-2",
            &cancel,
        )
        .await;
        assert!(!ended.succeeded);
        let unreadable = poll_outcome(
            RowPoll::Unreadable("driver gone".to_owned()),
            "job-3",
            &cancel,
        )
        .await;
        assert!(!unreadable.succeeded);
        let no_word = poll_outcome(RowPoll::NoStateWord, "job-4", &cancel).await;
        assert!(!no_word.succeeded);
        assert!(
            cancel.calls.lock().expect("cancel log").is_empty(),
            "no verb for a non-expired poll: {:?}",
            cancel.calls.lock().expect("cancel log")
        );
    }

    #[test]
    fn the_fault_words_the_report_carries_already_ship_in_the_taxonomy() {
        let _gate = crate::resources::fence_test_gate();
        // Every fault word the report carries is a taxonomy member (one home each).
        assert!(super::super::errors::ALL_KINDS
            .iter()
            .any(|kind| kind.reason() == FAULT_CYCLE));
        assert!(super::super::errors::ALL_KINDS
            .iter()
            .any(|kind| kind.reason() == FAULT_RESTORE));
        assert!(super::super::errors::ALL_KINDS
            .iter()
            .any(|kind| kind.reason() == FAULT_HANDOFF));
        assert!(super::super::errors::ALL_KINDS
            .iter()
            .any(|kind| kind.reason() == super::super::watchdog::FAULT_SEVER));
    }

    /* ------------------- the RefMod export row arm (LEG AF2-M24b) ------------------- */

    /// Scripted RefMod export verbs (E28, LEG AF2-M24b): per-verb postures
    /// consumed in order, every call recorded with its key, so the arm's
    /// gate -> submit -> poll -> (cancel) law is pinned without a backend, a
    /// card or the stock ledger. Exhausting a script answers the honest nothing
    /// (a refused submit / a `missing` status / an acked-none cancel), never a
    /// silent success.
    #[derive(Default)]
    struct ScriptRefmodBridge {
        submits: Mutex<std::collections::VecDeque<Result<Value, String>>>,
        statuses: Mutex<std::collections::VecDeque<Result<Value, String>>>,
        cancels: Mutex<std::collections::VecDeque<Result<Value, String>>>,
        calls: Mutex<Vec<String>>,
    }

    impl ScriptRefmodBridge {
        fn scripted(
            submits: Vec<Result<Value, String>>,
            statuses: Vec<Result<Value, String>>,
            cancels: Vec<Result<Value, String>>,
        ) -> Arc<Self> {
            Arc::new(Self {
                submits: Mutex::new(submits.into()),
                statuses: Mutex::new(statuses.into()),
                cancels: Mutex::new(cancels.into()),
                calls: Mutex::new(Vec::new()),
            })
        }
    }

    impl RefmodBridge for ScriptRefmodBridge {
        fn submit(&self, request: Value) -> BoxFuture<'static, Result<Value, String>> {
            self.calls.lock().expect("bridge log").push(format!(
                "submit {}",
                serde_json::to_string(&request).expect("request json")
            ));
            let posture = self
                .submits
                .lock()
                .expect("bridge script")
                .pop_front()
                .unwrap_or_else(|| Err("script exhausted: no submit posture".to_owned()));
            Box::pin(async move { posture })
        }

        fn status(&self, prompt_id: String) -> BoxFuture<'static, Result<Value, String>> {
            self.calls
                .lock()
                .expect("bridge log")
                .push(format!("status {prompt_id}"));
            let posture = self
                .statuses
                .lock()
                .expect("bridge script")
                .pop_front()
                .unwrap_or_else(|| Ok(json!({ "state": "missing" })));
            Box::pin(async move { posture })
        }

        fn cancel(&self, prompt_id: String) -> BoxFuture<'static, Result<Value, String>> {
            self.calls
                .lock()
                .expect("bridge log")
                .push(format!("cancel {prompt_id}"));
            let posture = self
                .cancels
                .lock()
                .expect("bridge script")
                .pop_front()
                .unwrap_or_else(|| Ok(json!({ "cancelled": "none" })));
            Box::pin(async move { posture })
        }
    }

    /// A backend prompt id in the stock `prompt_id()` grammar (36 hex/dash
    /// chars) — the shape the stock submit yields and the carve-out law stores.
    const EXPORT_PROMPT_ID: &str = "0f3c7a3e-1a2b-4c5d-8e9f-0123456789ab";

    /// The closed export fixture: the seven closed keys, one media row, one
    /// saved name (same shape as the spool round-trip fixture).
    fn export_fixture() -> Value {
        json!({
            "name": "my bundle",
            "description": "a drain-export fixture",
            "conceptType": "identity",
            "media": [{ "type": "image", "file": "ref_a.png", "mediaMode": "video" }],
            "refmods": ["saved_one.safetensors"],
            "vae": "Minimax\\video_vae.safetensors",
            "audioVae": "Minimax\\audio_vae.safetensors"
        })
    }

    /// A spool holding one `draining` RefMod row: the arm's correlation write
    /// needs the row `draining` exactly like the render arm does.
    fn draining_refmod_row(spool: &Spool) -> QueueRow {
        let row = spool
            .append_refmod_row(&export_fixture())
            .expect("row lands");
        assert!(
            spool
                .set_status(&row.id, RowStatus::Queued, RowStatus::Draining)
                .expect("CAS"),
            "the row is the drain's"
        );
        row
    }

    #[tokio::test]
    async fn the_refmod_word_set_ends_the_export_poll_where_the_render_set_polls_on() {
        let _gate = crate::resources::fence_test_gate();
        // The two vocabularies NEVER cross: `done` ends the export poll on the
        // export word set, and the same answer is NOT terminal under the render
        // set (it polls on to its deadline). The cadence/deadline physics are
        // one home; only the word set differs.
        let mut polls: u32 = 0;
        let poll = poll_row(
            || {
                polls += 1;
                async move {
                    Ok(json!({ "state": "done", "result": { "name": "my bundle", "members": 3 } }))
                }
            },
            0,
            60_000,
            600_000,
            &TERMINAL_REFMOD_WORDS,
        )
        .await;
        match poll {
            RowPoll::Terminal(snapshot) => assert_eq!(snapshot["state"], "done"),
            other => panic!("'done' is the export's terminal word: {other:?}"),
        }
        assert_eq!(polls, 1, "the loop stopped at the first export word");
        let mut polls: u32 = 0;
        let poll = poll_row(
            || {
                polls += 1;
                async move { Ok(json!({ "state": "done" })) }
            },
            0,
            20,
            600_000,
            &TERMINAL_ROW_WORDS,
        )
        .await;
        assert!(
            matches!(poll, RowPoll::Expired),
            "the render set never treats 'done' as terminal: {poll:?}"
        );
        assert!(polls > 1, "the render poll polled on past the export word");
    }

    #[tokio::test]
    async fn a_refmod_row_drains_through_the_bridge_and_publishes_its_descriptor() {
        let _gate = crate::resources::fence_test_gate();
        // The whole arm on fakes: gate-ok -> submit -> queued -> running ->
        // done. The bridge receives EXACTLY the flat intent (the closed request
        // with the plane words stripped); the row correlates to the BACKEND
        // PROMPT ID (the E28 carve-out), and the terminal outputs descriptor
        // names the stock result's safetensors in the `refmods` model subfolder
        // — the byte doors' no-serve law, never a path this plane invents.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let row = draining_refmod_row(&spool);
        let request = super::super::spool::flat_intent(&row).expect("an export row is drain-ready");
        let fake = ScriptRefmodBridge::scripted(
            vec![Ok(json!({ "promptId": EXPORT_PROMPT_ID }))],
            vec![
                Ok(json!({ "state": "queued" })),
                Ok(json!({ "state": "running" })),
                Ok(json!({
                    "state": "done",
                    "result": { "name": "my bundle", "members": 3 }
                })),
            ],
            vec![],
        );
        let bridge: Arc<dyn RefmodBridge> = fake.clone();
        let outcome = run_refmod_row(
            &bridge,
            &spool,
            &row.id,
            request,
            || async {
                (
                    "running".to_owned(),
                    Some("http://127.0.0.1:8188".to_owned()),
                )
            },
            &mut |_base: String| async { true },
            0,
            5_000,
        )
        .await;
        assert!(outcome.succeeded, "{outcome:?}");
        assert!(!outcome.submit_failed, "the row reached the backend");
        assert_eq!(
            outcome.job_id.as_deref(),
            Some(EXPORT_PROMPT_ID),
            "the correlation is the backend prompt id, not a Workbench job id"
        );
        assert_eq!(
            outcome
                .outputs
                .expect("the descriptor rides the terminal report"),
            json!([{ "filename": "my bundle.safetensors", "subfolder": "refmods" }]),
            "the stock result name rides the descriptor verbatim"
        );
        // The correlation write landed on the spool row before the poll ended.
        let rows = spool.snapshot().expect("healthy");
        assert_eq!(rows[0].job_id.as_deref(), Some(EXPORT_PROMPT_ID));
        // One submit with the closed request, then three status polls keyed by
        // the prompt id — nothing else crossed the seam.
        let calls = fake.calls.lock().expect("bridge log").clone();
        assert_eq!(calls.len(), 4, "submit + three status polls: {calls:?}");
        let sent: Value = serde_json::from_str(
            calls[0]
                .strip_prefix("submit ")
                .expect("the submit call is logged"),
        )
        .expect("request json");
        assert_eq!(
            sent,
            export_fixture(),
            "the bridge carried the closed request"
        );
        for call in &calls[1..] {
            assert_eq!(
                call,
                &format!("status {EXPORT_PROMPT_ID}"),
                "polled by prompt id"
            );
        }
    }

    #[tokio::test]
    async fn a_refmod_row_past_the_ready_window_stays_poison_fuel_like_a_render_row() {
        let _gate = crate::resources::fence_test_gate();
        // The gate-expiry half of the §5 parity: an export row whose backend
        // never reached ready fails at submit with the SAME fault words (last
        // state word, window) the render arm carries — and the bridge never
        // sees a submit (the E29 law is a before-submit law).
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let row = draining_refmod_row(&spool);
        let fake = ScriptRefmodBridge::scripted(vec![], vec![], vec![]);
        let bridge: Arc<dyn RefmodBridge> = fake.clone();
        let mut reads: u32 = 0;
        let outcome = run_refmod_row(
            &bridge,
            &spool,
            &row.id,
            export_fixture(),
            || {
                reads += 1;
                async { ("starting".to_owned(), None) }
            },
            &mut |_base: String| async { unreachable!("never running, never probed") },
            0,
            20,
        )
        .await;
        assert!(!outcome.succeeded);
        assert!(
            outcome.submit_failed,
            "the poison guard counts gate failures the same for export rows"
        );
        assert_eq!(outcome.job_id, None, "nothing reached the backend");
        let detail = outcome.detail.expect("the fault words ride verbatim");
        assert!(
            detail.contains("never reported running")
                && detail.contains("'starting'")
                && detail.contains("20 ms"),
            "{detail} names the same maintenanceActive-path fault as a render row"
        );
        assert!(reads > 1, "the gate polled the word {reads} times first");
        let calls = fake.calls.lock().expect("bridge log").clone();
        assert!(
            calls.is_empty(),
            "the gate refused before any submit: {calls:?}"
        );
        assert_eq!(spool.snapshot().expect("healthy")[0].job_id, None);
    }

    #[tokio::test]
    async fn a_refused_export_submit_keeps_the_stock_words_verbatim_and_counts_as_poison() {
        let _gate = crate::resources::fence_test_gate();
        // The stock submit refused (compile wall or backend rejection):
        // `submit_failed: true` exactly like the render arm's refused submit,
        // the stock sentence passed through VERBATIM, no correlation, no poll.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let row = draining_refmod_row(&spool);
        let fake = ScriptRefmodBridge::scripted(
            vec![Err(
                "RefMod export rejected: Node not found: DaSiWaH3RefModExport".to_owned(),
            )],
            vec![],
            vec![],
        );
        let bridge: Arc<dyn RefmodBridge> = fake.clone();
        let outcome = run_refmod_row(
            &bridge,
            &spool,
            &row.id,
            export_fixture(),
            || async {
                (
                    "running".to_owned(),
                    Some("http://127.0.0.1:8188".to_owned()),
                )
            },
            &mut |_base: String| async { true },
            0,
            5_000,
        )
        .await;
        assert!(!outcome.succeeded);
        assert!(
            outcome.submit_failed,
            "submit-side: poison-guard fuel, one floor"
        );
        let detail = outcome.detail.expect("the stock refusal rides");
        assert!(
            detail.contains("RefMod export rejected: Node not found: DaSiWaH3RefModExport"),
            "{detail} passes the stock sentence verbatim"
        );
        assert_eq!(outcome.job_id, None, "no prompt id was minted");
        let calls = fake.calls.lock().expect("bridge log").clone();
        assert_eq!(
            calls.len(),
            1,
            "submit only — the poll never started: {calls:?}"
        );
    }

    #[tokio::test]
    async fn the_export_words_failed_cancelled_and_missing_map_to_the_stock_words() {
        let _gate = crate::resources::fence_test_gate();
        // The three stock failure postures map to failed rows, render-side
        // (past submit — never poison fuel), correlation intact, the stock
        // detail words verbatim and no invented paths.
        for (answer, expected) in [
            (
                json!({ "state": "failed", "error": "VAELoader: no such file" }),
                "VAELoader: no such file",
            ),
            (json!({ "state": "cancelled" }), "cancelled"),
            (json!({ "state": "missing" }), "missing"),
        ] {
            let dir = tempfile::tempdir().expect("tempdir");
            let spool = Spool::new(dir.path());
            let row = draining_refmod_row(&spool);
            let fake = ScriptRefmodBridge::scripted(
                vec![Ok(json!({ "promptId": EXPORT_PROMPT_ID }))],
                vec![Ok(answer.clone())],
                vec![],
            );
            let bridge: Arc<dyn RefmodBridge> = fake.clone();
            let outcome = run_refmod_row(
                &bridge,
                &spool,
                &row.id,
                export_fixture(),
                || async {
                    (
                        "running".to_owned(),
                        Some("http://127.0.0.1:8188".to_owned()),
                    )
                },
                &mut |_base: String| async { true },
                0,
                5_000,
            )
            .await;
            assert!(!outcome.succeeded, "{answer}");
            assert!(
                !outcome.submit_failed,
                "{answer}: past submit, ordinary batch semantics"
            );
            assert_eq!(outcome.job_id.as_deref(), Some(EXPORT_PROMPT_ID));
            assert!(outcome.outputs.is_none(), "nothing was published");
            let detail = outcome.detail.expect("the stock word rides");
            assert!(
                detail.contains("export ended") && detail.contains(expected),
                "{detail} names '{expected}' verbatim"
            );
        }
    }

    #[tokio::test]
    async fn an_expired_export_row_is_cancelled_by_prompt_id_and_the_stock_answer_rides() {
        let _gate = crate::resources::fence_test_gate();
        // The deadline arm reaches the stock scoped verb through the SAME
        // bridge seam, keyed by the backend prompt id. The stock verb decides
        // the placement (`cancelled: "queued"|"running"|"none"` are placement
        // words, never completion claims); an acked verb leaves no problem
        // note. The unknown-id class — the stock `submitted()` law — maps to
        // the closed `jobUnknown` cause exactly like the door's mapping, stock
        // string verbatim.
        let fake = ScriptRefmodBridge::scripted(
            vec![],
            vec![],
            vec![Ok(json!({ "cancelled": "queued" }))],
        );
        let outcome = refmod_poll_outcome(RowPoll::Expired, EXPORT_PROMPT_ID, fake.as_ref()).await;
        assert!(!outcome.succeeded);
        assert!(
            !outcome.submit_failed,
            "the row reached the backend — not poison fuel"
        );
        assert_eq!(outcome.job_id.as_deref(), Some(EXPORT_PROMPT_ID));
        let calls = fake.calls.lock().expect("bridge log").clone();
        assert_eq!(
            calls.as_slice(),
            [format!("cancel {EXPORT_PROMPT_ID}")],
            "one scoped verb, keyed by the prompt id"
        );
        let detail = outcome.detail.expect("the deadline posture");
        assert!(
            detail.contains("scoped-cancelled") && !detail.contains("cancel problem"),
            "{detail}"
        );
        // The stock submitted() refusal: the closed jobUnknown cause, stock
        // words verbatim — the same mapping the refmod doors make.
        let fake = ScriptRefmodBridge::scripted(
            vec![],
            vec![],
            vec![Err("Unknown RefMod export".to_owned())],
        );
        let outcome = refmod_poll_outcome(RowPoll::Expired, "never-submitted", fake.as_ref()).await;
        let detail = outcome.detail.expect("the refusal rides the detail");
        assert!(
            detail.contains("jobUnknown") && detail.contains("Unknown RefMod export"),
            "{detail} maps the closed cause, stock words verbatim"
        );
        // The queued-stall arm takes the same single verb; `cancelled: "none"`
        // (a prompt already gone from the queue) is an ack, not a problem.
        let fake =
            ScriptRefmodBridge::scripted(vec![], vec![], vec![Ok(json!({ "cancelled": "none" }))]);
        let outcome =
            refmod_poll_outcome(RowPoll::QueuedStalled, EXPORT_PROMPT_ID, fake.as_ref()).await;
        assert!(!outcome.succeeded);
        assert!(
            !outcome
                .detail
                .expect("the stall posture")
                .contains("cancel problem"),
            "an acked verb leaves no note"
        );
    }

    #[tokio::test]
    async fn a_live_refmod_export_blocks_the_drain_start_like_an_uncorrelated_job() {
        let _gate = crate::resources::fence_test_gate();
        // The E28 widening: the creation door can leave an export live, and it
        // holds the owned backend's queue — the drain refuses a start while it
        // runs, with the SAME error-shape family the render law answers.
        let harness = Harness::new();
        let seams = CycleSeams {
            correlation: Arc::new(ScriptCorrelation::with_exports([EXPORT_PROMPT_ID])),
            ..seams_of(&harness)
        };
        let error = refuse_uncorrelated(&seams)
            .await
            .expect_err("a held export is not the drain's to walk past");
        assert_eq!(error.body_json()["reason"], "jobUnknown");
        assert_eq!(error.body_json()["error"], "JOB_UNKNOWN");
        let hint = error.body_json()["hint"].as_str().expect("hint").to_owned();
        assert!(
            hint.contains(EXPORT_PROMPT_ID),
            "{hint} names the live export"
        );
        assert!(
            hint.contains("POST /v1/refmods/"),
            "{hint} names the remedy the refmod door ships"
        );
        assert_eq!(
            phase_word(harness.cell.live().phase),
            "idle",
            "the law refuses without touching the fence"
        );
    }

    #[tokio::test]
    async fn an_unreadable_export_ledger_fails_the_drain_closed_too() {
        let _gate = crate::resources::fence_test_gate();
        // The fail-closed half of the widened fact: an export ownership read
        // that cannot be made is never read as "nothing held".
        let harness = Harness::new();
        let seams = CycleSeams {
            correlation: Arc::new(ScriptCorrelation::exports_unreadable(
                "the RefMod ownership lock failed",
            )),
            ..seams_of(&harness)
        };
        let error = refuse_uncorrelated(&seams)
            .await
            .expect_err("an unreadable fact is never read as clean");
        assert_eq!(error.body_json()["reason"], "maintenanceActive");
        assert!(
            error.body_json()["hint"]
                .as_str()
                .expect("hint")
                .contains("the RefMod ownership lock failed"),
            "the honest reason rides the hint"
        );
    }

    /* ---------- LEG AF2-M32: story chaining (the resolution legs) ---------- */

    /// The 64-hex prepared source the story fixture opens from.
    const STORY_PREPARED: &str = "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34";

    /// A minted story row (the shape `routes::video_story` mints, built here
    /// through the SAME ordinary acceptance the door rides).`step_index 0`
    /// carries the prepared hex + sourceKind; later steps carry the
    /// placeholder without it.
    fn story_row(step_index: usize, story_id: &str) -> QueueRow {
        let extras: serde_json::Map<String, Value> = serde_json::from_str(
            r#"{
                "checkpoint": "minimax_h3/model.safetensors",
                "positivePrompt": "a story shot",
                "outputPrefix": "agent/story",
                "videos": ["deas-input-fake-story.mp4"],
                "diffusion": {
                    "textEncoder": "minimax_h3.safetensors",
                    "clipType": "minimax",
                    "vae": "h3_video_vae.safetensors"
                },
                "h3": {
                    "audioVae": "h3_audio_vae.safetensors",
                    "shiftVideo": 1.0,
                    "shiftAudio": 1.0
                }
            }"#,
        )
        .expect("fixture parses");
        let plan = super::super::fill_plane::fill(
            "minimax-h3",
            "ref2va",
            None,
            &super::super::defaults::DefaultsSheet::default(),
            Some(&extras),
        )
        .expect("the fixture fills")
        .plan();
        let mut row = QueueRow::from_plan(&plan).expect("the plan is complete");
        let mut continuity = serde_json::Map::new();
        continuity.insert("session".to_owned(), json!("story-session"));
        continuity.insert(
            "sourceId".to_owned(),
            json!(if step_index == 0 {
                STORY_PREPARED.to_owned()
            } else {
                super::super::spool::STORY_SOURCE_PLACEHOLDER.to_owned()
            }),
        );
        if step_index == 0 {
            continuity.insert("sourceKind".to_owned(), json!("video"));
        }
        continuity.insert("capture".to_owned(), json!(step_index == 0));
        continuity.insert(
            "action".to_owned(),
            json!(format!("continue shot {step_index}")),
        );
        continuity.insert("outputMode".to_owned(), json!("full"));
        continuity.insert("durationSeconds".to_owned(), json!(3));
        row.extras
            .get_mut("h3")
            .and_then(Value::as_object_mut)
            .expect("the h3 block rides the plan")
            .insert("continuity".to_owned(), Value::Object(continuity));
        row.story_link = Some(super::super::spool::StoryLink {
            story_id: story_id.to_owned(),
            session: "story-session".to_owned(),
            step_index,
            prepared_source: STORY_PREPARED.to_owned(),
        });
        row
    }

    /// The stock session view shape (`native_h3_session` normalization):
    /// import clip + continuation chain, plus a deliberate ambiguity branch.
    fn story_session_view() -> Value {
        json!({
            "latestId": "c-1",
            "clips": [
                {
                    "clipId": "import-1",
                    "parent": null,
                    "frames": 121,
                    "completed": 1_000_u64,
                    "importedVideo": {"sourceId": STORY_PREPARED, "width": 512, "height": 512, "modeFamily": "ref2va"},
                },
                {"clipId": "c-0", "parent": "import-1", "frames": 73, "completed": 2_000_u64, "export": {"filename": "c-0.mp4", "subfolder": "", "type": "output"}},
                {"clipId": "c-0-take2", "parent": "import-1", "frames": 73, "completed": 3_000_u64},
                {"clipId": "c-1", "parent": "c-0", "frames": 107, "completed": 4_000_u64, "export": {"filename": "c-1.mp4", "subfolder": "", "type": "output"}},
            ],
        })
    }

    #[test]
    fn the_story_ledger_derives_the_chain_from_the_stock_view() {
        // C0 rule (cited): the continuation clip off the IMPORT clip whose
        // importedVideo.sourceId names the prepared source — the ambiguity
        // branch (c-0-take2, no export, newer) loses to the exported c-0 by
        // the stated disambiguation (exported first, then newest completed).
        let view = story_session_view();
        let mut ledger = StoryLedger {
            prepared: STORY_PREPARED.to_owned(),
            clips: Vec::new(),
        };
        extend_story_ledger(&view, &mut ledger, 2, "story-session").expect("the chain derives");
        assert_eq!(
            ledger.clips,
            vec!["c-0", "c-1"],
            "parent-linked chain, one read"
        );
        // A foreign prepared source has no import clip here: honest refusal.
        let mut foreign = StoryLedger {
            prepared: "ff00".repeat(16),
            clips: Vec::new(),
        };
        let problem = extend_story_ledger(&view, &mut foreign, 1, "story-session")
            .expect_err("no import clip off that source");
        assert!(
            problem.contains("no continuation clip off the prepared source"),
            "{problem}"
        );
    }

    #[test]
    fn the_story_resolution_substitutes_the_parent_clip_and_the_stock_law_judges_the_resolved_block(
    ) {
        // Mission duty (4), pure half: substitution picks the parent-linked
        // clip, `validate_continuity` runs on the RESOLVED block, and
        // '@story' never survives into the intent that reaches prepare.
        let row = story_row(1, "story-pure");
        let mut intent =
            super::super::spool::flat_intent(&row).expect("minted rows are drain-ready");
        assert_eq!(
            intent["h3"]["continuity"]["sourceId"],
            super::super::spool::STORY_SOURCE_PLACEHOLDER
        );
        let ledger = StoryLedger {
            prepared: STORY_PREPARED.to_owned(),
            clips: vec!["c-0".to_owned()],
        };
        apply_story_resolution(&row, &mut intent, &ledger)
            .expect("the resolved block passes the stock law");
        assert_eq!(
            intent["h3"]["continuity"]["sourceId"], "c-0",
            "the parent clip id stands"
        );
        assert!(
            !serde_json::to_string(&intent)
                .expect("serialize")
                .contains("@story"),
            "the placeholder never survives resolution"
        );
        // A resolution answer that is NOT a continuity id dies here, with the
        // stock sentence leading the detail verbatim — before prepare.
        let bad = StoryLedger {
            prepared: STORY_PREPARED.to_owned(),
            clips: vec!["bad.parent".to_owned()],
        };
        let mut intent =
            super::super::spool::flat_intent(&row).expect("minted rows are drain-ready");
        let problem =
            apply_story_resolution(&row, &mut intent, &bad).expect_err("stock law refuses it");
        assert!(
            problem.starts_with("Invalid h3.continuity.sourceId"),
            "the stock words ride verbatim: {problem}"
        );
    }

    #[tokio::test]
    async fn a_story_batch_drains_in_one_cycle_and_the_placeholder_never_reaches_the_chain() {
        // End-to-end through the real drain: two story rows, one cycle. Step 0
        // rides the prepared hex untouched; step 1 arrives at the chain with
        // the session-read parent substituted; the session is read for
        // resolution AND for the post-completion record of step 0.
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        harness
            .spool
            .append_story_rows(&[story_row(0, "story-e2e"), story_row(1, "story-e2e")])
            .expect("the story batch lands");
        let chain = Arc::new(ScriptChain::all_done());
        let sessions = Arc::new(fakes::ScriptSessions::viewing(story_session_view()));
        let cycle_id = harness.cell.claim(CyclePhase::Draining).expect("claim");
        let report = drive(CycleRun {
            cell: harness.cell.clone(),
            seams: harness.seams(Arc::clone(&chain)),
            spool: harness.spool.clone(),
            guard: guard(false, false),
            cycle_id,
            sessions: Arc::clone(&sessions) as Arc<dyn SessionRead>,
        })
        .await;
        assert_eq!(report["ok"], true, "{report}");
        let seen = chain.seen.lock().expect("chain log").clone();
        assert_eq!(seen.len(), 2, "both rows reach the chain");
        assert_eq!(
            seen[0]["h3"]["continuity"]["sourceId"], STORY_PREPARED,
            "step 0 rides the prepared hex the door put in"
        );
        assert_eq!(
            seen[1]["h3"]["continuity"]["sourceId"], "c-0",
            "step 1 arrives with the parent clip the session read identified"
        );
        for intent in seen.iter() {
            assert!(
                !serde_json::to_string(intent)
                    .expect("serialize")
                    .contains("@story"),
                "the placeholder never reaches the chain"
            );
        }
        let reads = sessions.reads.lock().expect("reads log").clone();
        assert_eq!(
            reads,
            vec!["story-session", "story-session"],
            "resolution read + record read"
        );
    }

    #[tokio::test]
    async fn a_story_row_without_a_resolvable_parent_fails_honestly_and_the_batch_continues() {
        // Batch semantics stay: a story row whose parent never rendered fails
        // as an ordinary row failure (the session read answers an empty chain);
        // the cycle still runs its legs and the other rows keep their posture.
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        harness
            .spool
            .append_story_rows(&[story_row(1, "story-orphan")])
            .expect("the orphan row lands");
        let chain = Arc::new(ScriptChain::all_done());
        let sessions = Arc::new(fakes::ScriptSessions::viewing(
            json!({"latestId": null, "clips": []}),
        ));
        let cycle_id = harness.cell.claim(CyclePhase::Draining).expect("claim");
        let report = drive(CycleRun {
            cell: harness.cell.clone(),
            seams: harness.seams(Arc::clone(&chain)),
            spool: harness.spool.clone(),
            guard: guard(false, false),
            cycle_id,
            sessions: Arc::clone(&sessions) as Arc<dyn SessionRead>,
        })
        .await;
        // One failed row is batch semantics (the poison floor is two); the
        // chain saw nothing, the row is failed with the honest detail.
        assert!(
            chain.seen.lock().expect("chain log").is_empty(),
            "never reached the chain"
        );
        let rows = harness.spool.snapshot().expect("healthy");
        assert_eq!(rows[0].status, RowStatus::Failed, "the row failed honestly");
        // M12 shape law: a classified failure rides {kind, detail}; an
        // unclassified one is the plain string. Read both.
        let error = &report["rows"][0]["error"];
        let detail = error
            .as_str()
            .map(str::to_owned)
            .or_else(|| error["detail"].as_str().map(str::to_owned))
            .expect("detail")
            .to_owned();
        assert!(
            detail.contains("no continuation clip off the prepared source"),
            "the detail names why: {detail}"
        );
    }

    /* ------------------------- LEG AF2-M33: the file-stability end leg ------------------------- */

    #[test]
    fn the_stability_pair_and_its_derived_bound_are_pinned() {
        let _gate = crate::resources::fence_test_gate();
        // AF2-M33: the pair is the walk's physics (2 s between confirming reads, a
        // 60 s whole-walk bound) and the bound is DERIVED, so the two numbers can
        // never drift apart into different laws.
        assert_eq!(STABILITY_POLL_MS, 2_000, "the confirming read's gap");
        assert_eq!(STABILITY_TIMEOUT_MS, 60_000, "the whole-walk bound");
        assert_eq!(
            STABILITY_WAIT_BOUND,
            STABILITY_TIMEOUT_MS / STABILITY_POLL_MS,
            "the wait budget is derived from the pair, never hand-set"
        );
        assert_eq!(STABILITY_WAIT_BOUND, 30, "30 gaps is 60 s of waiting");
        // The law's rationale, stated where the numbers live: the 2 s settle this leg
        // sits in front of was nowhere near an H3 mux, which is the race the leg exists
        // for. The pair and its derived bound are the pin; the ratio is arithmetic.
    }

    #[test]
    fn the_stability_law_settles_on_two_identical_reads_and_waits_while_the_file_moves() {
        let _gate = crate::resources::fence_test_gate();
        // The pure half of AF2-M33: two consecutive reads of one file decide, size AND
        // mtime, and the file settles the moment it STOPPS moving — not after a fixed
        // number of looks.
        let first = OutputStat {
            size_bytes: 100,
            modified_ms: 10,
        };
        let bigger = OutputStat {
            size_bytes: 200,
            modified_ms: 10,
        };
        let newer = OutputStat {
            size_bytes: 100,
            modified_ms: 11,
        };
        assert_eq!(
            stability_vote(None, Ok(Some(first))),
            Stability::Baseline(first),
            "the first read is a baseline, never a verdict"
        );
        assert_eq!(
            stability_vote(Some(first), Ok(Some(first))),
            Stability::Stable,
            "identical size AND mtime twice: the writer is done"
        );
        assert_eq!(
            stability_vote(Some(first), Ok(Some(bigger))),
            Stability::Moving(bigger),
            "a growing file is still being written"
        );
        assert_eq!(
            stability_vote(Some(first), Ok(Some(newer))),
            Stability::Moving(newer),
            "mtime alone moving is enough to keep waiting"
        );
        assert_eq!(
            stability_vote(Some(bigger), Ok(Some(bigger))),
            Stability::Stable,
            "it settles as soon as the growth stops"
        );
    }

    #[test]
    fn the_stability_law_calls_missing_and_unreadable_one_honest_class() {
        let _gate = crate::resources::fence_test_gate();
        // AF2-M33 fail-open law, pure: a descriptor naming no file, a file that
        // vanished between reads and an unreadable fact are the SAME class — the
        // honest detail — never a wedge and never a fault.
        let before = OutputStat {
            size_bytes: 100,
            modified_ms: 10,
        };
        assert_eq!(
            stability_vote(None, Ok(None)),
            Stability::Absent("the named file is not on disk".to_owned()),
            "missing at the first check: the descriptor is not filesystem authority"
        );
        assert_eq!(
            stability_vote(Some(before), Ok(None)),
            Stability::Absent("the named file is not on disk".to_owned()),
            "a file that vanished between reads is the same class"
        );
        assert_eq!(
            stability_vote(Some(before), Err("mtime unreadable".to_owned())),
            Stability::Absent("mtime unreadable".to_owned()),
            "an unreadable fact rides the detail too"
        );
    }

    #[test]
    fn the_walk_addresses_every_row_s_descriptors_once_and_names_its_first_namer() {
        let _gate = crate::resources::fence_test_gate();
        // The walk is ONCE per cycle: every descriptor every drained row carried,
        // deduplicated on (subfolder, filename) with the first namer kept for the
        // honest detail. A row that published nothing contributes nothing; a list
        // element that names no filename names no file to wait on.
        let row = |id: &str, outputs: Value| RowResult {
            id: id.to_owned(),
            status: RowStatus::Done,
            detail: None,
            error_kind: None,
            job_id: None,
            outputs: Some(outputs),
        };
        let quiet = RowResult {
            id: "row-c".to_owned(),
            status: RowStatus::Done,
            detail: None,
            error_kind: None,
            job_id: None,
            outputs: None,
        };
        let rows = vec![
            row(
                "row-a",
                json!([
                    { "filename": "clip.webm", "subfolder": "deas", "type": "output" },
                    { "filename": "clip-audio.webm", "subfolder": "deas", "type": "output" },
                    { "filename": "clip.webm", "subfolder": "deas", "type": "output" },
                    { "type": "output" }
                ]),
            ),
            row(
                "row-b",
                json!([{ "filename": "clip.webm", "subfolder": "deas", "type": "output" }]),
            ),
            quiet,
        ];
        let targets = stability_targets(&rows);
        assert_eq!(targets.len(), 2, "deduplicated, once each: {targets:?}");
        assert_eq!(
            targets[0].row_id, "row-a",
            "the first namer owns the detail"
        );
        assert_eq!(targets[0].subfolder, "deas");
        assert_eq!(targets[0].filename, "clip.webm");
        assert_eq!(targets[1].filename, "clip-audio.webm");
        assert_eq!(
            descriptor_name(&targets[0]),
            "deas/clip.webm",
            "the detail states the stock words as one name"
        );
        let bare = StabilityTarget {
            row_id: "row-a".to_owned(),
            subfolder: String::new(),
            filename: "root.png".to_owned(),
        };
        assert_eq!(
            descriptor_name(&bare),
            "root.png",
            "the empty subfolder stock mints for root-level outputs stays bare"
        );
    }

    #[test]
    fn the_descriptor_guard_reads_only_relative_stock_words() {
        let _gate = crate::resources::fence_test_gate();
        // The containment posture: the walk touches the engine-owned output root and
        // nothing outside it. The stock words — a bare filename and a `subfolder`
        // word, including the empty subfolder stock mints at root level — pass;
        // every traversal or path-shaped form is refused as the honest-detail class.
        assert_eq!(
            descriptor_path("", "a.png").expect("the root-level stock word"),
            PathBuf::from("a.png")
        );
        assert_eq!(
            descriptor_path("deas", "a.png").expect("the subfolder stock word"),
            PathBuf::from("deas").join("a.png")
        );
        for (subfolder, filename) in [
            ("", ""),
            ("", "../secret"),
            ("..", "a.png"),
            ("deas/..", "a.png"),
            ("deas/", "a.png"),
            ("deas", "nested/a.png"),
            ("C:", "a.png"),
            ("", "a\\b.png"),
            ("", "."),
            ("", ".."),
        ] {
            let refused = descriptor_path(subfolder, filename);
            assert!(refused.is_err(), "'{subfolder}' + '{filename}' is refused");
        }
    }

    /// A successful row that produced exactly one output descriptor (AF2-M33 drills).
    fn produced_row(job_id: &str, subfolder: &str, filename: &str) -> RowOutcome {
        RowOutcome {
            succeeded: true,
            detail: None,
            error_kind: None,
            submit_failed: false,
            job_id: Some(job_id.to_owned()),
            outputs: Some(json!([
                { "filename": filename, "subfolder": subfolder, "type": "output" }
            ])),
        }
    }

    #[tokio::test]
    async fn the_walk_waits_for_a_growing_file_and_only_then_enters_the_end_legs() {
        let _gate = crate::resources::fence_test_gate();
        // AF2-M33, the happy path: the file grows for two gaps and freezes, so the
        // walk settles it and the end legs run with nothing to disclose. The pacer
        // record is the ordering proof — every walk gap lands BEFORE the free leg's
        // settle (STABILITY_POLL_MS and SETTLE_MS are the same number, so position,
        // not value, is what pins the order).
        let stat = |size_bytes: u64, modified_ms: u64| {
            Some(OutputStat {
                size_bytes,
                modified_ms,
            })
        };
        let mut harness = Harness::new();
        harness.door = Arc::new(ScriptDoor::stats([
            stat(100, 10),
            stat(200, 10),
            stat(300, 11),
            stat(300, 11),
        ]));
        let report = harness
            .run(
                ScriptChain::scripted(vec![produced_row("stock-mux", "deas", "clip.webm")]),
                guard(true, true),
            )
            .await;
        assert_eq!(report["ok"], true, "{report}");
        assert_eq!(report["freed"], true, "free_leg was reached");
        assert_eq!(report["modelRestored"], true, "restore_leg was reached");
        assert!(
            report.get("stability").is_none(),
            "a settled walk says nothing at all: {report}"
        );
        assert_eq!(harness.door.stat_calls.load(Ordering::SeqCst), 4);
        let reads = harness.door.stat_reads.lock().expect("stat log");
        assert_eq!(
            reads[0],
            ("deas".to_owned(), "clip.webm".to_owned()),
            "the stock words are addressed as the stock words"
        );
        drop(reads);
        let pauses = harness.pacer.pauses.lock().expect("pacer log");
        assert_eq!(
            pauses.as_slice(),
            [
                STABILITY_POLL_MS,
                STABILITY_POLL_MS,
                STABILITY_POLL_MS,
                SETTLE_MS,
                DOWN_HOLD_MS,
                PATIENCE_MS
            ],
            "three confirming gaps, THEN the free-leg cadence: {pauses:?}"
        );
        assert_eq!(harness.door.free_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_file_that_never_settles_times_out_at_the_bound_and_the_legs_still_run() {
        let _gate = crate::resources::fence_test_gate();
        // AF2-M33, the fail-open half: a file that never stops changing burns exactly
        // the derived wait budget, rides an honest `stability` detail, and the end
        // legs proceed anyway — an agent row naming a file the backend never finishes
        // must not hold the card hostage. The cycle stays `ok`.
        let mut harness = Harness::new();
        harness.door = Arc::new(ScriptDoor::stats_growing());
        let report = harness
            .run(
                ScriptChain::scripted(vec![produced_row("stock-mux", "", "clip.webm")]),
                guard(true, true),
            )
            .await;
        assert_eq!(
            report["ok"], true,
            "the bound is a disclosure, never a fault"
        );
        assert_eq!(report["freed"], true, "the legs still ran");
        assert_eq!(report["modelRestored"], true);
        assert!(report.get("fault").is_none(), "{report}");
        assert_eq!(report["stability"]["ok"], false, "{report}");
        let problems = report["stability"]["problems"]
            .as_array()
            .expect("problems")
            .clone();
        assert_eq!(problems.len(), 1, "{problems:?}");
        let detail = problems[0].as_str().expect("string detail");
        assert!(detail.contains("clip.webm"), "{detail}");
        assert!(detail.contains("never stopped changing"), "{detail}");
        assert!(detail.contains("row 'row-a'"), "{detail}");
        // Exactly the derived budget was spent: 30 gaps of STABILITY_POLL_MS, then
        // the free leg's own cadence — the walk delayed entry, it never replaced it.
        let pauses = harness.pacer.pauses.lock().expect("pacer log");
        assert_eq!(
            pauses.len(),
            STABILITY_WAIT_BOUND as usize + 3,
            "{pauses:?}"
        );
        assert!(
            pauses[..STABILITY_WAIT_BOUND as usize]
                .iter()
                .all(|pause| *pause == STABILITY_POLL_MS),
            "every walk gap is the pair's gap: {pauses:?}"
        );
        assert_eq!(
            pauses[STABILITY_WAIT_BOUND as usize], SETTLE_MS,
            "the settle is the FIRST end-leg pause, after the whole walk: {pauses:?}"
        );
        // One read per gap plus the baseline read, then the bound stopped the walk.
        assert_eq!(
            harness.door.stat_calls.load(Ordering::SeqCst),
            u32::try_from(STABILITY_WAIT_BOUND + 1).expect("the bound fits a u32 counter"),
            "31 reads for 30 gaps: the bound is counted, not timed"
        );
    }

    #[tokio::test]
    async fn a_descriptor_naming_no_file_rides_the_detail_and_never_waits() {
        let _gate = crate::resources::fence_test_gate();
        // The missing-at-first-check class: the row's outputs descriptor is not
        // filesystem authority. One read decides it, no gap is ever spent waiting for
        // a file that is not there, the detail rides the report and the legs proceed.
        let mut harness = Harness::new();
        harness.door = Arc::new(ScriptDoor::stats([None]));
        let report = harness
            .run(
                ScriptChain::scripted(vec![produced_row("stock-ghost", "deas", "ghost.mp4")]),
                guard(true, true),
            )
            .await;
        assert_eq!(report["ok"], true, "{report}");
        assert_eq!(report["freed"], true);
        assert_eq!(report["stability"]["ok"], false);
        let problems = report["stability"]["problems"]
            .as_array()
            .expect("problems");
        assert_eq!(problems.len(), 1, "{problems:?}");
        let detail = problems[0].as_str().expect("string detail");
        assert!(detail.contains("deas/ghost.mp4"), "{detail}");
        assert!(detail.contains("not on disk"), "{detail}");
        assert_eq!(harness.door.stat_calls.load(Ordering::SeqCst), 1);
        // No waiting at all: the ONLY 2 000 ms pause in the record is the free leg's
        // own settle (the walk's gap value is welded to it, so the count is the pin).
        let pauses = harness.pacer.pauses.lock().expect("pacer log");
        assert_eq!(
            pauses.as_slice(),
            [SETTLE_MS, DOWN_HOLD_MS, PATIENCE_MS],
            "a missing file is decided on one read: {pauses:?}"
        );
    }

    #[tokio::test]
    async fn a_cycle_that_produced_no_outputs_never_touches_the_stability_seam() {
        let _gate = crate::resources::fence_test_gate();
        // The skip law: no row produced outputs, so the walk makes no read, waits for
        // nothing, and the report's shape is byte-identical to the pre-M33 shape —
        // no `stability` key, no extra row key, no extra pause.
        let harness = Harness::new();
        let report = harness
            .run(ScriptChain::all_done(), guard(true, true))
            .await;
        assert_eq!(report["ok"], true, "{report}");
        assert_eq!(harness.door.stat_calls.load(Ordering::SeqCst), 0);
        assert!(harness.door.stat_reads.lock().expect("stat log").is_empty());
        assert!(
            report.get("stability").is_none(),
            "skip-when-absent: no key at all"
        );
        let mut keys: Vec<String> = report
            .as_object()
            .expect("an object report")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "autoCycleVram",
                "completedAt",
                "cycleId",
                "freeOnQueueEnd",
                "freed",
                "modelRestored",
                "ok",
                "rows"
            ],
            "the report key set is exactly what it was before this leg"
        );
        let row_keys = report["rows"][0]
            .as_object()
            .expect("a row object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            row_keys,
            ["error", "id", "jobId", "status"],
            "and so is a row's"
        );
        // The end-leg cadence is untouched: no walk gap sits in front of the settle.
        let pauses = harness.pacer.pauses.lock().expect("pacer log");
        assert_eq!(
            pauses.as_slice(),
            [SETTLE_MS, DOWN_HOLD_MS, PATIENCE_MS],
            "{pauses:?}"
        );
    }
}
