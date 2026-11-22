//! The watchdog (API-DESIGN §8): the two-fact quiet-window judge plus the sever arm.
//!
//! Why two facts and never one (§8.1, the D10 root): a render leg can hold GPU
//! utilization near zero while the card keeps moving (VRAM churn) and can hold VRAM
//! flat while the GPU is loud. Either single fact false-trips on a real workload, so
//! the judge trips only when BOTH hold over a FULL window: the median GPU utilization
//! under `utilMedianPct` AND the `memory.used` span (max-min) at or under
//! `vramStaticMiB`. The window is one sample per second for `windowSec` seconds
//! (default 60, clamped to 30..=1800); `graceSec` (120) keeps the load-heavy first
//! legs out of the sample set — the sawtooth false-trip class, physics P11.
//!
//! Unknowns are never quiet: a GPU that reports no utilization or no memory (an AMD
//! host, a missing `nvidia-smi`, a timeout) poisons the window and the judge stands
//! down. The watchdog cannot blind a host into a sever, and never trips on AMD at all.
//!
//! Eligibility (§8.1, unchanged): a `running` attributed row only — in this build the
//! attributed in-flight row is the spool row in `draining` status, which is API-owned
//! by construction. One latch per row. Never while the cycle cell sits in
//! `unloading`/`restoring` (the card-held-by-cycle disqualification) or `severing`
//! (one arm at a time). With the default `guardOwnRuns=true`, user-launched
//! non-API renders are not attributed and never severed; `false` lets an unattributed
//! render be judged too (the operator asked for it, the row is then named `null`).
//!
//! One sampler slot (§2 physics): this loop IS the 1 s sampler for its own purpose —
//! it calls [`crate::monitoring::sample`] once per tick and only while it is actually
//! watching. `monitoring::spawn_job_sampler` is never called from here; a second
//! always-on 1 s sampler is what the law forbids.
//!
//! The arm's order is law (§8.2): `cancel → confirm → clear → free → RESTORE →
//! answer → journal`, and the journal file is the instrument that proves it — every
//! step appends its own closed-word row (`watchdog-*`) before the next step starts,
//! so the durable record cannot disagree with the code path. The restore leg is the
//! shipped one ([`cycle::restore_leg`]: bounded 3 attempts, 90 s apart, stop at the
//! first healthy answer); §8.4 exhaustion posture rides the answer's `restored:false`,
//! never a new word.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use futures_util::future::BoxFuture;
use serde::Deserialize;
use serde_json::{json, Value};

use super::cycle::{self, CycleCell, CycleSeams};
use super::cycle_view::CyclePhase;
use super::guard::GuardConfig;
use super::spool::{now_ms, QueueRow, RowStatus, Spool};
use crate::logs::{self, Source};

/* ------------------------------ configuration ------------------------------ */

/// Owner defaults (API-DESIGN §8.1); the numbers are engineered, not preferences.
pub(crate) const DEFAULT_WINDOW_SEC: u32 = 60;
/// The window range §8.1 allows: 30 s to 1800 s.
pub(crate) const MIN_WINDOW_SEC: u32 = 30;
pub(crate) const MAX_WINDOW_SEC: u32 = 1800;
/// Median GPU utilization under this percent is fact one of the two-fact AND.
pub(crate) const DEFAULT_UTIL_MEDIAN_PCT: u32 = 20;
/// `memory.used` span (max-min) at or under this many MiB is fact two.
pub(crate) const DEFAULT_VRAM_STATIC_MIB: u64 = 3_072;
/// In-flight age before a row is even eligible to trip (§8.1, stays 120).
pub(crate) const DEFAULT_GRACE_SEC: u64 = 120;

/// The one tick per second — the sampler slot's cadence (§2 physics: one 1 s sampler).
pub(crate) const TICK_MS: u64 = 1_000;

/// The MiB divisor for the stock `Gpu::memory_used` bytes (monitoring.rs reports
/// bytes; the owner's `vramStaticMiB` number is MiB).
const MIB: u64 = 1024 * 1024;

/// The watchdog's own numbers, hot-reloaded from the guard file's `watchdog` block
/// every tick. An absent block is these defaults; a malformed block is these
/// defaults plus one honest log line (never a config that silently changes the trip
/// posture, and never a reason to disable the watchdog — §8.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WatchdogConfig {
    /// Samples (one per second) that must all be quiet before a trip is possible.
    pub(crate) window_sec: u32,
    /// Fact one: median GPU utilization must be strictly under this percent.
    pub(crate) util_median_pct: u32,
    /// Fact two: the window's `memory.used` span must be at or under this many MiB.
    pub(crate) vram_static_mib: u64,
    /// In-flight seconds before eligibility (protects the load-heavy first legs).
    pub(crate) grace_sec: u64,
    /// True (default): only API-owned rows are attributed, so user-launched non-API
    /// renders are never severed. False: an unattributed live render may trip too.
    pub(crate) guard_own_runs: bool,
}

impl Default for WatchdogConfig {
    fn default() -> Self {
        Self {
            window_sec: DEFAULT_WINDOW_SEC,
            util_median_pct: DEFAULT_UTIL_MEDIAN_PCT,
            vram_static_mib: DEFAULT_VRAM_STATIC_MIB,
            grace_sec: DEFAULT_GRACE_SEC,
            guard_own_runs: true,
        }
    }
}

/// One raw `watchdog` block; every field optional, unknown fields refused so a typo
/// surfaces as the honest malformed note instead of a silent default.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct WatchdogBlock {
    window_sec: u32,
    util_median_pct: u32,
    /// Named by hand: the owner's word is `vramStaticMiB` (§8.1), and serde's
    /// camelCase of `vram_static_mib` would be `vramStaticMib` — the same trap as the
    /// `MiB` unit the guard file carries nowhere else.
    #[serde(rename = "vramStaticMiB")]
    vram_static_mib: u64,
    grace_sec: u64,
    guard_own_runs: bool,
}

impl Default for WatchdogBlock {
    fn default() -> Self {
        let config = WatchdogConfig::default();
        Self {
            window_sec: config.window_sec,
            util_median_pct: config.util_median_pct,
            vram_static_mib: config.vram_static_mib,
            grace_sec: config.grace_sec,
            guard_own_runs: config.guard_own_runs,
        }
    }
}

impl WatchdogConfig {
    /// Reads the block out of the guard file's parsed JSON. The second element is the
    /// honest note an operator can act on (`None` when the block was absent or clean):
    /// a malformed block keeps the defaults, an out-of-range window is clamped into
    /// the §8.1 range. Callers log the note; the hot-reload loop dedupes it per tick.
    pub(crate) fn from_raw(raw: Option<&Value>) -> (Self, Option<String>) {
        let Some(raw) = raw else {
            return (Self::default(), None);
        };
        let block: WatchdogBlock = match serde_json::from_value(raw.clone()) {
            Ok(block) => block,
            Err(problem) => {
                return (
                    Self::default(),
                    Some(format!(
                        "watchdog block is malformed, defaults in force: {problem}"
                    )),
                );
            }
        };
        let mut note = None;
        if block.window_sec < MIN_WINDOW_SEC || block.window_sec > MAX_WINDOW_SEC {
            note = Some(format!(
                "watchdog windowSec {} is outside {MIN_WINDOW_SEC}..={MAX_WINDOW_SEC}; clamped",
                block.window_sec
            ));
        }
        let config = Self {
            window_sec: clamp_window(block.window_sec),
            util_median_pct: block.util_median_pct,
            vram_static_mib: block.vram_static_mib,
            grace_sec: block.grace_sec,
            guard_own_runs: block.guard_own_runs,
        };
        (config, note)
    }
}

/// The §8.1 window clamp, one home for the range.
pub(crate) fn clamp_window(seconds: u32) -> u32 {
    seconds.clamp(MIN_WINDOW_SEC, MAX_WINDOW_SEC)
}

/* ------------------------------ the sampler seam ------------------------------ */

/// One GPU's readable facts. `None` means unreadable, which is NOT quiet (§8.1:
/// unknown != quiet). The stock [`crate::monitoring::Gpu`] shape carries exactly this
/// `Option` posture (a missing `nvidia-smi` field is `[N/A]`, never a zero).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct GpuFacts {
    /// Utilization percent.
    pub(crate) utilization: Option<f64>,
    /// Framebuffer in use, MiB (the stock bytes divided down to the owner's unit).
    pub(crate) memory_used_mib: Option<u64>,
}

/// One tick's GPU facts across every GPU the host reports.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SampleFacts {
    pub(crate) gpus: Vec<GpuFacts>,
}

impl SampleFacts {
    /// The single per-tick sample the judge keeps, or `None` when any part of it is
    /// unknown. Utilization is folded with MAX across GPUs (never quiet while any card
    /// works) and memory with MAX too (the loaded card is the one whose span matters).
    fn known(&self) -> Option<Sample> {
        let mut util: Option<f64> = None;
        let mut mem: Option<u64> = None;
        for gpu in &self.gpus {
            let (Some(u), Some(m)) = (gpu.utilization, gpu.memory_used_mib) else {
                return None;
            };
            util = Some(util.map_or(u, |held| held.max(u)));
            mem = Some(mem.map_or(m, |held| held.max(m)));
        }
        // An empty GPU list is the AMD/absent-tool posture: no facts, no trip.
        Some(Sample {
            util_pct: util?,
            mem_used_mib: mem?,
        })
    }
}

/// One kept sample: the folded facts of a tick.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Sample {
    pub(crate) util_pct: f64,
    pub(crate) mem_used_mib: u64,
}

/// The 1 s GPU read. Production is the stock sampler; tests script the facts.
pub(crate) trait GpuSampler: Send + Sync {
    /// One sample of every GPU's readable facts.
    fn sample(&self) -> BoxFuture<'static, SampleFacts>;
}

/// Production sampler: the stock `monitoring::sample` (the same read the stock panel
/// uses) with its GPU legs narrowed to the two facts the judge owns.
pub(crate) struct StockGpuSampler;

impl GpuSampler for StockGpuSampler {
    fn sample(&self) -> BoxFuture<'static, SampleFacts> {
        Box::pin(async move {
            let sample = crate::monitoring::sample(None).await;
            SampleFacts {
                gpus: sample
                    .gpus
                    .iter()
                    .map(|gpu| GpuFacts {
                        utilization: gpu.utilization,
                        memory_used_mib: gpu.memory_used.map(|bytes| bytes / MIB),
                    })
                    .collect(),
            }
        })
    }
}

/* ------------------------------ the wedge control seam ------------------------------ */

/// The stock cancel surface, scoped: the token-gated workbench verbs ([`crate::jobs`]
/// `native_workbench_interrupt_running` / `native_workbench_cancel_pending`, the
/// pending path being the backend's `{"delete":[prompt_id]}` mutation) plus the row
/// driver read that confirms a terminal word. The watchdog never posts a global
/// interrupt and never clears the backend queue.
pub(crate) trait WedgeControl: Send + Sync {
    /// The live native jobs as `(job id, state word)`; only `running`/`queued` matter.
    fn live_jobs(&self) -> BoxFuture<'static, Vec<(String, String)>>;
    /// Scoped interruption of one running job (the stock token-gated path).
    fn interrupt_running(&self, job_id: &str) -> BoxFuture<'static, Result<(), String>>;
    /// Scoped pending cancellation — the `{"delete"}` mutation — of one queued job.
    fn cancel_pending(&self, job_id: &str) -> BoxFuture<'static, Result<(), String>>;
    /// The row driver's terminal word for one job (`None` while it is still live,
    /// `Some("cancelled" | "failed" | "succeeded" | "unknown")` once terminal).
    fn confirm_terminal(&self, job_id: &str) -> BoxFuture<'static, Option<String>>;
}

/* ------------------------------ the judge ------------------------------ */

/// The median of the window's utilization samples (even count: mean of the two
/// middle values, the ordinary median — not a mode, not a tail pick).
pub(crate) fn median_util(samples: &[Sample]) -> f64 {
    let mut values: Vec<f64> = samples.iter().map(|sample| sample.util_pct).collect();
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len() % 2 == 1 {
        values[middle]
    } else {
        // Two finite readings averaged; the samples are telemetry, never NaN-carrying.
        (values[middle - 1] + values[middle]) / 2.0
    }
}

/// The window's `memory.used` span: max minus min, in MiB.
pub(crate) fn mem_span(samples: &[Sample]) -> u64 {
    let min = samples
        .iter()
        .map(|sample| sample.mem_used_mib)
        .min()
        .unwrap_or_default();
    let max = samples
        .iter()
        .map(|sample| sample.mem_used_mib)
        .max()
        .unwrap_or_default();
    max.saturating_sub(min)
}

/// The two-fact AND over a FULL window (§8.1). A short window is never quiet: the
/// sample count is the window, so the first `windowSec` eligible ticks are the
/// earliest possible trip.
pub(crate) fn window_is_quiet(samples: &[Sample], config: &WatchdogConfig) -> bool {
    samples.len() >= usize::try_from(config.window_sec).unwrap_or(usize::MAX)
        && median_util(samples) < f64::from(config.util_median_pct)
        && mem_span(samples) <= config.vram_static_mib
}

/* ------------------------------ the journal ------------------------------ */

/// The watchdog's own journal, beside the spool/guard/cell files in app-data. Closed
/// vocabulary (`watchdog-*`), written with the spool's atomic staging + rename idiom:
/// the journal is the durable proof of the arm's step order.
pub(crate) const JOURNAL_FILE: &str = "deas-agent-watchdog.json";
/// The journal file schema version; only this one is understood.
pub(crate) const JOURNAL_VERSION: u32 = 1;
/// Rows kept: the journal is an audit tail, not an unbounded history.
pub(crate) const JOURNAL_CAP: usize = 200;

/// The closed journal vocabulary. One home for the words; the wire text is pinned by
/// test against the enum so a rename cannot half-happen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum JournalEvent {
    /// Both facts went quiet over a full window after grace: the trip latched.
    Trip,
    /// The scoped interrupt / pending-cancel mutations went out.
    Cancel,
    /// The row driver confirmed the terminal words.
    Confirm,
    /// The spool was cleared: remaining queued rows cancelled, the latched row wedged.
    Clear,
    /// The idle proof passed and `/free` was acknowledged.
    Free,
    /// The restore leg answered (healthy, or exhausted under §8.4).
    Restore,
    /// The sever's terminal answer — the row the held caller and the door read.
    Sever,
    /// The judge stood down (phase disqualification, unknown facts, nothing running).
    StandDown,
}

impl JournalEvent {
    /// The journal word for this event.
    pub(crate) fn word(self) -> &'static str {
        match self {
            Self::Trip => "watchdog-trip",
            Self::Cancel => "watchdog-cancel",
            Self::Confirm => "watchdog-confirm",
            Self::Clear => "watchdog-clear",
            Self::Free => "watchdog-free",
            Self::Restore => "watchdog-restore",
            Self::Sever => "watchdog-sever",
            Self::StandDown => "watchdog-standdown",
        }
    }
}

/// The append-only audit tail. Reads fail closed naming the path (the spool's law); a
/// corrupt journal is never repaired behind the operator, the next append replaces
/// nothing and the log surfaces the problem.
#[derive(Debug)]
pub(crate) struct Journal {
    app_data: PathBuf,
    gate: Mutex<()>,
}

impl Journal {
    pub(crate) fn new(app_data: &Path) -> Self {
        Self {
            app_data: app_data.to_path_buf(),
            gate: Mutex::new(()),
        }
    }

    /// Appends one row atomically: read, extend, rewrite under the staging + rename
    /// idiom, capped to the last [`JOURNAL_CAP`] rows.
    ///
    /// # Errors
    ///
    /// Reports an unreadable, unparseable or wrong-version journal naming the path, or
    /// the write failure; on either, the target keeps its bytes.
    pub(crate) fn record(&self, event: JournalEvent, detail: Value) -> Result<(), String> {
        let _gate = self.lock_gate();
        let path = self.app_data.join(JOURNAL_FILE);
        let rows = Self::read_rows(&path)?;
        let mut rows = rows;
        rows.push(json!({ "at": now_ms(), "event": event.word(), "detail": detail }));
        if rows.len() > JOURNAL_CAP {
            let excess = rows.len() - JOURNAL_CAP;
            rows.drain(0..excess);
        }
        let staging = path.with_file_name(format!("{JOURNAL_FILE}.{}.tmp", std::process::id()));
        let bytes = serde_json::to_vec_pretty(&json!({
            "version": JOURNAL_VERSION,
            "rows": rows,
        }))
        .map_err(|problem| format!("serialize {JOURNAL_FILE}: {problem}"))?;
        let write = std::fs::write(&staging, &bytes)
            .map_err(|problem| format!("write {}: {problem}", staging.display()))
            .and_then(|()| {
                std::fs::rename(&staging, &path)
                    .map_err(|problem| format!("rename onto {}: {problem}", path.display()))
            });
        if write.is_err() {
            let _ = std::fs::remove_file(&staging);
        }
        write
    }

    /// The journal rows, oldest first.
    #[cfg(test)]
    pub(crate) fn rows(&self) -> Result<Vec<Value>, String> {
        let _gate = self.lock_gate();
        Self::read_rows(&self.app_data.join(JOURNAL_FILE))
    }

    /// M18d cleanup (LEG AF2-M19b): the honest corruption probe the doors consult —
    /// `Some(problem)` when the journal file is unreadable (unreadable bytes,
    /// unparseable, or a version this plane does not understand), the problem
    /// verbatim from the same read law [`Self::record`] enforces. Read-only and
    /// fail-closed: a corrupt journal is never repaired behind the operator, the
    /// doors just stop claiming it is readable.
    pub(crate) fn corruption_note(&self) -> Option<String> {
        let _gate = self.lock_gate();
        Self::read_rows(&self.app_data.join(JOURNAL_FILE)).err()
    }

    /// Reads and validates the rows. Caller holds the gate.
    fn read_rows(path: &Path) -> Result<Vec<Value>, String> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("read {}: {error}", path.display())),
        };
        let file: Value = serde_json::from_slice(&bytes)
            .map_err(|problem| format!("parse {}: {problem}", path.display()))?;
        if file["version"].as_u64() != Some(u64::from(JOURNAL_VERSION)) {
            return Err(format!(
                "validate {}: version {:?} is not supported (expected {JOURNAL_VERSION})",
                path.display(),
                file["version"]
            ));
        }
        Ok(file["rows"].as_array().cloned().unwrap_or_default())
    }

    fn lock_gate(&self) -> MutexGuard<'_, ()> {
        self.gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The sever reason word the answer and the cycle fault carry: [`super::errors::ErrorKind::JobWedged`]
/// ships already (§8.2's word), so no taxonomy word is coined here.
pub(crate) const FAULT_SEVER: &str = "jobWedged";

/* ------------------------------ the live state ------------------------------ */

/// What one tick decided. Closed: the loop either stands down, keeps watching, or
/// trips (and the trip names the subject the arm acts on).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Tick {
    /// Nothing eligible to watch (no attributed row, phase disqualification).
    StandDown,
    /// Watching: the window grew, no trip.
    Watching,
    /// Both facts quiet over a full window after grace, on a not-yet-latched subject.
    Tripped { key: String },
}

/// The subject of the current window: a key the latch is held against plus the row the
/// arm will name (`None` for an unattributed live render, the `guardOwnRuns:false`
/// posture). Spool rows key on the row id; unattributed renders on the stock job id.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Subject {
    pub(crate) key: String,
    pub(crate) row_id: Option<String>,
    /// W3-7 (LEG AF2-M21a): the subject's render is CONFIRMED RUNNING — for a
    /// spool row, its correlated stock job (`jobId`, written by the drain's
    /// correlation the moment the id exists) appears in the live job facts with
    /// the stock status word `running`; the unattributed posture is confirmed by
    /// construction (the seam only names running jobs). The grace clock starts at
    /// confirmation, NEVER at the first tick that saw the row `draining`: a row
    /// parked on the stock compute gate or behind a long compile holds a healthy
    /// batch, and a grace window started there severs it (the C-W3 false-sever
    /// class). Unconfirmed keeps the window stood-down — no samples, no trip.
    pub(crate) confirmed_running: bool,
}

/// The trip the operator door (`POST /v1/watchdog/sever`) acts on.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Trip {
    pub(crate) subject: Subject,
    pub(crate) at_ms: u64,
}

/// The loop's in-memory posture: one window, one latch, one open trip.
#[derive(Debug, Default)]
struct LoopState {
    /// The subject the window belongs to; `None` while nothing is watched.
    subject: Option<Subject>,
    /// The tick the current subject was CONFIRMED running (epoch ms): the grace
    /// clock (W3-7, LEG AF2-M21a — formerly first-observed-`draining`, which ran
    /// the clock while a healthy row waited on the stock compute gate or a
    /// compile). The row's own `createdAt` is the enqueue stamp, not the in-flight
    /// stamp, so the grace window measures confirmed in-flight time — the
    /// load-heavy legs, which is what grace protects.
    seen_at_ms: u64,
    /// One sample per eligible tick, oldest first, capped at `windowSec`.
    samples: VecDeque<Sample>,
    /// The subject already tripped: one latch per row, never a second trip.
    latched: Option<String>,
    /// The trip awaiting the arm (cleared when the arm has answered).
    trip: Option<Trip>,
}

impl LoopState {
    /// Folds one tick into the window and answers what the tick decided (§8.1).
    ///
    /// `facts` unknown poisons the window: unknown is never quiet, so the sample set
    /// restarts from the next eligible tick.
    fn observe(
        &mut self,
        subject: Option<Subject>,
        facts: &SampleFacts,
        config: &WatchdogConfig,
        now_ms: u64,
    ) -> Tick {
        let Some(subject) = subject else {
            self.stand_down();
            return Tick::StandDown;
        };
        if !subject.confirmed_running {
            // W3-7 (LEG AF2-M21a): a `draining` row whose stock job is not (yet)
            // confirmed running is not a wedge candidate — it is a healthy batch
            // queued on the compute gate or compiling. The window stays
            // stood-down: no samples accumulate, no grace clock runs, no trip.
            // The clock starts on the first confirmed tick.
            self.stand_down();
            return Tick::StandDown;
        }
        if self
            .subject
            .as_ref()
            .is_some_and(|held| held.key != subject.key)
        {
            // A new subject is a new window on a new grace clock.
            self.subject = Some(subject.clone());
            self.seen_at_ms = now_ms;
            self.samples.clear();
        } else if self.subject.is_none() {
            self.subject = Some(subject.clone());
            self.seen_at_ms = now_ms;
        }
        let Some(sample) = facts.known() else {
            // Unknown facts poison the window: the judge cannot read quiet there.
            self.samples.clear();
            return Tick::Watching;
        };
        let capacity = usize::try_from(config.window_sec).unwrap_or(usize::MAX);
        self.samples.push_back(sample);
        while self.samples.len() > capacity {
            self.samples.pop_front();
        }
        let in_flight_ms = now_ms.saturating_sub(self.seen_at_ms);
        let grace_ms = config.grace_sec.saturating_mul(1_000);
        let samples: Vec<Sample> = self.samples.iter().copied().collect();
        if in_flight_ms < grace_ms || !window_is_quiet(&samples, config) {
            return Tick::Watching;
        }
        if self.latched.as_deref() == Some(subject.key.as_str()) {
            // One latch per row: the trip already fired for this subject.
            return Tick::Watching;
        }
        self.latched = Some(subject.key.clone());
        self.trip = Some(Trip {
            subject: subject.clone(),
            at_ms: now_ms,
        });
        Tick::Tripped {
            key: subject.key.clone(),
        }
    }

    /// Drops the window: nothing eligible is in flight.
    fn stand_down(&mut self) {
        self.subject = None;
        self.samples.clear();
        self.seen_at_ms = 0;
    }

    /// The subject already tripped, if any (the operator door's latch read).
    #[cfg(test)]
    fn latched(&self) -> Option<&str> {
        self.latched.as_deref()
    }
}

/* ------------------------------ the plane handle ------------------------------ */

/// The watchdog's own seam pair: the 1 s GPU read and the scoped cancel surface.
pub(crate) struct WatchdogSeams {
    pub(crate) sampler: Arc<dyn GpuSampler>,
    pub(crate) control: Arc<dyn WedgeControl>,
}

impl WatchdogSeams {
    /// Production kit: the stock monitoring read and the token-gated stock verbs.
    pub(crate) fn stock(app: tauri::AppHandle) -> Self {
        Self {
            sampler: Arc::new(StockGpuSampler),
            control: Arc::new(StockWedgeControl { app }),
        }
    }
}

#[cfg(test)]
impl WatchdogSeams {
    /// The inert kit for plane-level (transport) tests: the card reports nothing, so
    /// the judge never trips, and the control surface answers nothing.
    pub(crate) fn defaults_for_tests() -> Self {
        Self {
            sampler: Arc::new(fakes::ScriptSampler::new([], fakes::unknown())),
            control: Arc::new(fakes::ScriptControl::default()),
        }
    }
}

/// The plane-held watchdog handle: judge state, journal, and the seams both the loop
/// and the operator door run over. Cheap to `Arc`; `PlaneState` carries one.
pub(crate) struct Watchdog {
    app_data: PathBuf,
    state: Mutex<LoopState>,
    journal: Arc<Journal>,
    seams: Arc<WatchdogSeams>,
}

impl Watchdog {
    pub(crate) fn new(app_data: &Path, seams: Arc<WatchdogSeams>) -> Self {
        Self {
            app_data: app_data.to_path_buf(),
            state: Mutex::new(LoopState::default()),
            journal: Arc::new(Journal::new(app_data)),
            seams,
        }
    }

    pub(crate) fn journal(&self) -> &Arc<Journal> {
        &self.journal
    }

    fn lock(&self) -> MutexGuard<'_, LoopState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The trip the operator door acts on (`None` when nothing has latched).
    pub(crate) fn trip(&self) -> Option<Trip> {
        self.lock().trip.clone()
    }

    /// W3-10 (LEG AF2-M21a): the CONSUME-the-trip law, one home. Whichever path
    /// runs the arm — the judge's tick or the manual door — takes the trip under
    /// the same mutex lock that holds it; from that instant every other reader
    /// sees a closed window. The old peek-then-`clear_trip`-after-the-answer
    /// sequence left a window where the door could re-run the whole arm for a
    /// second pair of bats right after the auto arm answered.
    pub(crate) fn take_trip(&self) -> Option<Trip> {
        self.lock().trip.take()
    }

    /// W4-D (LEG AF2-M22): put a trip BACK iff the window is still closed — the
    /// refuse-path of the explicit-jobId door. The door had to CONSUME atomically
    /// (a peek cannot close the double-arm race), but a refusal must not steal the
    /// judge's window: the operator's next move is the empty body, which must find
    /// the trip it was promised. Never clobbers a trip another taker opened in the
    /// meantime (an absent slot is the only slot this fills).
    pub(crate) fn restore_trip_if_absent(&self, trip: Trip) {
        let mut state = self.lock();
        if state.trip.is_none() {
            state.trip = Some(trip);
        }
    }

    /// Test-only trip injector (W4-D, LEG AF2-M22): opens a window without running
    /// the judge, so the door drills can stand a trip in the exact instant between
    /// a peek and a consume. The judge's own latch path is `observe`'s;
    /// production never calls this.
    #[cfg(test)]
    pub(crate) fn inject_trip_for_tests(&self, subject: Subject) {
        self.lock().trip = Some(Trip {
            subject,
            at_ms: now_ms(),
        });
    }

    /// The row this watchdog has already latched (one trip per row).
    #[cfg(test)]
    pub(crate) fn latched(&self) -> Option<String> {
        self.lock().latched().map(str::to_owned)
    }

    /// The judge stands down: no eligible subject, so no window is kept.
    pub(crate) fn stand_down(&self) {
        self.lock().stand_down();
    }

    /// Folds one tick. The guard file is re-read per tick (hot reload, §8.1); an
    /// absent block keeps the defaults and a malformed one is the same with one
    /// honest log line, deduped per distinct problem.
    fn observe_tick(
        &self,
        subject: Option<Subject>,
        facts: &SampleFacts,
        config: &WatchdogConfig,
        now_ms: u64,
    ) -> Tick {
        self.lock().observe(subject, facts, config, now_ms)
    }

    /// The app-data home the loop re-reads every tick: the guard file's `watchdog`
    /// block is the live config (hot reload, §8.1). The watchdog has no off switch a
    /// route can reach; only the operator file moves its numbers.
    pub(crate) fn app_data(&self) -> &Path {
        &self.app_data
    }
}

/* ------------------------------ the run loop ------------------------------ */

/// The handles the loop drives over: the cell whose phase disqualifies it, the spool
/// that carries attribution, and the cycle seam kit the arm reuses (pacer, door,
/// commands, health, gate). Cheap to clone: every handle is an `Arc`, and the
/// per-tick containment in [`tick_guarded`] needs to hand a set to the tick's own task.
#[derive(Clone)]
pub(crate) struct LoopPlane {
    pub(crate) cell: Arc<CycleCell>,
    pub(crate) spool: Arc<Spool>,
    pub(crate) seams: Arc<CycleSeams>,
}

/// Spawns the watchdog loop when the plane starts. The loop owns its own 1 s tick and
/// never calls `monitoring::spawn_job_sampler`: one sampler slot (§2 physics).
///
/// W3: every tick body is panic-contained by [`tick_guarded`]. The bare loop used to
/// await `tick` inline, so one panic in the judge, a seam or the arm ended the task and
/// the plane went blind to wedges for the rest of its life — and if the panic landed
/// after `take_cell`, the cell stayed parked in `severing`, every later tick stood down
/// under that phase and every later claim answered 409 forever. Both are closed: the
/// tick runs as its own task (a panic becomes a `JoinError` the loop names and keeps
/// running over), and the arm's [`SeverGuard`] parks the cell honestly on the way out.
pub(crate) fn spawn(watchdog: Arc<Watchdog>, plane: LoopPlane) {
    tauri::async_runtime::spawn(async move {
        loop {
            plane.seams.pacer.pause(TICK_MS).await;
            tick_guarded(&watchdog, &plane).await;
        }
    });
}

/// One tick, panic-contained (W3). Spawning the tick turns an unwinding seam into a
/// `JoinError` this loop can log and survive; the await keeps the loop single-worker,
/// so no second arm can ever overlap the first (§8.2: the loop is the watchdog's only
/// worker). A contained panic is logged through the plane's log idiom and the loop
/// ticks on: the watchdog is the plane's only wedge authority and it does not get to
/// die quietly.
async fn tick_guarded(watchdog: &Arc<Watchdog>, plane: &LoopPlane) {
    let owned_watchdog = Arc::clone(watchdog);
    let owned_plane = plane.clone();
    let joined = tokio::spawn(async move { tick(&owned_watchdog, &owned_plane).await }).await;
    if let Err(problem) = joined {
        logs::push(
            Source::Deas,
            &format!(
                "agent-api: watchdog tick unwound and was contained; the loop keeps watching: {problem}"
            ),
        );
    }
}

/// One tick: phase law, attribution, the 1 s read, the judge, and (on a trip) the arm
/// run inline — the loop is the watchdog's only worker, so no second arm can overlap.
pub(crate) async fn tick(watchdog: &Arc<Watchdog>, plane: &LoopPlane) {
    // §8.3 + §8.1: never while the card is held by a cycle leg, and never a second arm.
    if matches!(
        plane.cell.live().phase,
        CyclePhase::Unloading | CyclePhase::Restoring | CyclePhase::Severing
    ) {
        watchdog.stand_down();
        return;
    }
    // One guard read per tick serves both the numbers (hot reload, §8.1) and the arm.
    // W3-4 (LEG AF2-M21a): CORRUPT is not ABSENT. An absent or refused-to-exist
    // file is the operator's "no cycle words yet" posture — the shipped defaults,
    // legs off, nothing flagged, exactly as shipped. A file that EXISTS but cannot
    // be parsed is a damaged config: the numbers still stay defaults (the plane
    // never invents commands, §8.1), but the arm is latched `guard_corrupt` — an
    // arm that frees under an unreadable guard has no trustworthy restore word
    // behind it and must never claim a restore it cannot run.
    let (guard, guard_corrupt) = match super::guard::load(watchdog.app_data()) {
        Ok(Some(guard)) => (guard, false),
        Ok(None) => (GuardConfig::default(), false),
        Err(problem) => {
            logs::push(
                Source::Deas,
                &format!(
                    "agent-api: watchdog guard unreadable ({problem}); the judge keeps the shipped numbers and the sever arm runs flagged cardAtRisk"
                ),
            );
            (GuardConfig::default(), true)
        }
    };
    let config = guard.watchdog;
    let subject = attributed_subject(&watchdog.seams.control, &plane.spool, &config).await;
    let facts = watchdog.seams.sampler.sample().await;
    let decision = watchdog.observe_tick(subject, &facts, &config, now_ms());
    let Tick::Tripped { key } = decision else {
        return;
    };
    // W3-10 (LEG AF2-M21a): take the trip BEFORE answering anything — the arm
    // belongs to the taker, and the manual door immediately sees the closed
    // posture (jobUnknown with no explicit jobId) instead of a second arm.
    let Some(trip) = watchdog.take_trip() else {
        return;
    };
    // W3-15 (LEG AF2-M21a): the trip row's write failure is never swallowed — it
    // rides the arm's `journalError` surfacing path verbatim, the same home the
    // leg rows' failures already reach.
    let mut pre_journal_problems: Vec<String> = Vec::new();
    if let Err(problem) = watchdog.journal().record(
        JournalEvent::Trip,
        json!({
            "row": trip.subject.row_id,
            "key": key,
            "windowSec": config.window_sec,
            "utilMedianPct": config.util_median_pct,
            "vramStaticMib": config.vram_static_mib,
            "graceSec": config.grace_sec,
        }),
    ) {
        pre_journal_problems.push(problem);
    }
    sever(&SeverRun {
        cell: plane.cell.clone(),
        spool: plane.spool.clone(),
        cycle_seams: plane.seams.clone(),
        watchdog: watchdog.clone(),
        guard,
        guard_corrupt,
        trigger: "judge",
        pre_journal_problems,
        row_id: trip.subject.row_id.clone(),
    })
    .await;
}

/// The attribution door: an API-owned row in `draining` status is the only running
/// subject by default (`guardOwnRuns` true, §8.1). With `false`, an unattributed live
/// stock render may be judged too and the severed row is named `null`.
async fn attributed_subject(
    control: &Arc<dyn WedgeControl>,
    spool: &Spool,
    config: &WatchdogConfig,
) -> Option<Subject> {
    let draining: Vec<QueueRow> = spool
        .snapshot()
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row.status == RowStatus::Draining)
        .collect();
    // C2: the YOUNGEST draining row is the subject, never the first in file order. A
    // `draining` row the boot pass could not reach (a panic between the CAS and the
    // terminal write, inside this same process) is an orphan: the driver that owned it
    // is gone and nothing will drive it terminal. As the subject it would hijack the
    // grace clock — its age is the previous render's, already past grace — and the arm
    // would sever a row that is not actually running. Newest-first is the honest pick;
    // the id is the tie-break so the choice is deterministic.
    if let Some(row) = draining.into_iter().max_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    }) {
        // W3-7 (LEG AF2-M21a): confirmation. The row is the SUBJECT either way,
        // but the grace clock only starts once its correlated stock job (the
        // `jobId` the drain writes the moment the stock id exists) is seen in the
        // live facts with the stock status word `running`. A row parked on the
        // stock compute gate, queued behind another render, or compiling is a
        // HEALTHY batch — judging it on its row age would sever it. NOTE
        // (live-realism): the status words come from the managed Jobs row driver
        // through the wedge-control seam — the running/queued correlation is
        // pinned by seam test here, never against a live backend in this build.
        let confirmed_running = match row.job_id.as_deref() {
            None => false,
            Some(job_id) => control
                .live_jobs()
                .await
                .iter()
                .any(|(id, state)| id == job_id && state == "running"),
        };
        return Some(Subject {
            key: row.id.clone(),
            row_id: Some(row.id.clone()),
            confirmed_running,
        });
    }
    if config.guard_own_runs {
        // A live render with no API row is the user's own work: not attributed,
        // never judged, never severed.
        return None;
    }
    control
        .live_jobs()
        .await
        .into_iter()
        .find(|(_, state)| state == "running")
        .map(|(job_id, _)| Subject {
            key: job_id.clone(),
            row_id: None,
            // The seam only offers this posture for a job the stock row driver
            // already calls `running` — confirmed by construction (W3-7).
            confirmed_running: true,
        })
}

/// The arm's hold on the cycle cell: either it claimed a free fence, or it borrowed
/// the fence the drain already owns and hands the phase back when it is done.
#[derive(Debug)]
enum Hold {
    Claimed {
        cycle_id: String,
    },
    Borrowed {
        phase_before: CyclePhase,
    },
    /// A stock stage holds the fence: the arm stands down honestly.
    Refused,
}

fn take_cell(cell: &CycleCell) -> Hold {
    let phase_before = cell.live().phase;
    if phase_before == CyclePhase::Idle {
        return match cell.claim(CyclePhase::Severing) {
            Ok(cycle_id) => Hold::Claimed { cycle_id },
            Err(_) => Hold::Refused,
        };
    }
    cell.set_phase(CyclePhase::Severing);
    Hold::Borrowed { phase_before }
}

/// RAII finalizer for one sever arm (W3), created the moment the arm takes the cell.
/// The normal path consumes it through [`SeverGuard::complete`]. If the arm instead
/// unwinds — a panicking seam, a panicking stock verb — `Drop` sees an unconsumed hold
/// and parks the posture honestly: nothing the arm did can be claimed to have
/// completed, so `freed:false, restored:false`, the row it was scoped to is named, and
/// the cell LEAVES `severing` (a phase the judge stands down under forever would wedge
/// the whole plane). The arm's own answer path is not re-run here: the guard never puts
/// the cell back into a live-cycle owner's hands, it leaves the sever visible through
/// [`CycleCell::sever`] so the drain's posture records the fault and the cycle ends
/// normally — the same contract the arm's `Hold::Borrowed` finish uses.
#[derive(Debug)]
struct SeverGuard {
    cell: Arc<CycleCell>,
    journal: Arc<Journal>,
    /// `None` once the arm answered: the guard then has nothing left to finalize.
    hold: Option<Hold>,
    row_id: Option<String>,
}

impl SeverGuard {
    fn new(
        cell: Arc<CycleCell>,
        journal: Arc<Journal>,
        hold: Hold,
        row_id: Option<String>,
    ) -> Self {
        Self {
            cell,
            journal,
            hold: Some(hold),
            row_id,
        }
    }

    /// The hold the arm runs its legs under.
    fn hold(&self) -> &Hold {
        self.hold
            .as_ref()
            .expect("the guard owns the hold until the arm answers")
    }

    /// Normal completion: the arm answered, so the guard finalizes nothing.
    fn complete(&mut self) {
        self.hold = None;
    }
}

impl Drop for SeverGuard {
    fn drop(&mut self) {
        let Some(hold) = self.hold.take() else {
            return;
        };
        let subject = self
            .row_id
            .clone()
            .unwrap_or_else(|| "(unattributed)".to_owned());
        logs::push(
            Source::Deas,
            &format!(
                "agent-api: watchdog sever arm unwound before it could answer (row {subject}); the cell posture was parked honestly (freed false, restored false)"
            ),
        );
        let answer = json!({
            "ok": false,
            "reason": FAULT_SEVER,
            "severedRow": self.row_id,
            "freed": false,
            "restored": false,
            // W3-9 (LEG AF2-M21a): an unwound arm proved nothing — the card
            // posture it leaves is unknown, and unknown is card-at-risk.
            "cardAtRisk": true,
            "at": now_ms(),
            "detail": "the sever arm unwound before it could finish its legs",
        });
        match hold {
            Hold::Claimed { cycle_id } => {
                // The arm owned the fence: close the cycle with the unwound-arm posture,
                // the same shape the drive guard uses for an unwound drive leg.
                self.cell.finish(json!({
                    "ok": false,
                    "cycleId": cycle_id,
                    "completedAt": now_ms(),
                    "freed": false,
                    "modelRestored": false,
                    "cardAtRisk": true,
                    "rows": [],
                    "fault": {
                        "reason": FAULT_SEVER,
                        "detail": "the sever arm unwound before it could finish its legs",
                    },
                }));
            }
            Hold::Borrowed { phase_before } => {
                // The drain owns this cycle: hand the phase back and leave the latch in
                // the cell, so the drain records the fault and skips its own legs.
                self.cell.set_phase(phase_before);
                self.cell.note_sever(answer.clone());
            }
            Hold::Refused => {}
        }
        if let Err(problem) = self.journal.record(JournalEvent::Sever, answer) {
            // M18d cleanup (LEG AF2-M19b): an unwind path has no wire answer for a
            // failed journal row to ride — so the DEAS log carries the problem
            // verbatim instead of the failure vanishing behind `let _ =`.
            logs::push(
                Source::Deas,
                &format!(
                    "agent-api: watchdog sever journal row lost on the unwind path: {problem}"
                ),
            );
        }
    }
}

/* ------------------------------ the sever arm ------------------------------ */

/// Everything one sever run needs. Built by the trip path or the operator door, over
/// the same handles the plane shares — the arm is one code path, never two.
pub(crate) struct SeverRun {
    pub(crate) cell: Arc<CycleCell>,
    pub(crate) spool: Arc<Spool>,
    pub(crate) cycle_seams: Arc<CycleSeams>,
    pub(crate) watchdog: Arc<Watchdog>,
    pub(crate) guard: GuardConfig,
    /// W3-4 (LEG AF2-M21a): the guard file EXISTS but could not be parsed — the
    /// shipped numbers ran, and the honest posture says so: an arm that freed
    /// under an unreadable guard answers restored:false + cardAtRisk:true with
    /// the `guard unreadable - restore bat unavailable` detail. An absent file is
    /// NOT corrupt (the operator's own legs-off posture, nothing flagged).
    pub(crate) guard_corrupt: bool,
    /// W3-11 (LEG AF2-M21a): what ran this arm — `judge` (the two-fact window),
    /// `manual` (the door on an open trip), or `manual-explicit` (the door with
    /// an operator-named jobId over a closed window). Rides the journal's sever
    /// row so the audit tail names its own trigger.
    pub(crate) trigger: &'static str,
    /// W3-15 (LEG AF2-M21a): journal failures the caller met BEFORE the arm
    /// started (the tick's trip row). The arm's `journalError` surfacing is one
    /// home; these seed it instead of vanishing behind a `let _ =`.
    pub(crate) pre_journal_problems: Vec<String>,
    /// The spool row the sever is scoped to (`None` = an unattributed render, only
    /// reachable with `guardOwnRuns:false`, or an explicit jobId the spool never
    /// recorded).
    pub(crate) row_id: Option<String>,
}

/// The sever arm, order is law (§8.2): `cancel → confirm → clear → free → RESTORE →
/// answer → journal`. Each step journals its own row before the next starts, so the
/// durable journal is the instrument that pins the order. The restore leg is the
/// shipped bounded leg reused verbatim; the answer carries `restored:false` when it
/// exhausts (§8.4), never a coined word.
pub(crate) async fn sever(run: &SeverRun) -> Value {
    let hold = take_cell(&run.cell);
    if matches!(hold, Hold::Refused) {
        logs::push(
            Source::Deas,
            "agent-api: watchdog sever refused — a stock admission holds the card fence",
        );
        let mut answer = json!({
            "ok": false,
            "reason": "cycleInFlight",
            "detail": "a stock admission holds the card fence; nothing was severed",
        });
        // M18d cleanup (LEG AF2-M19b): journal writes never pass silently — even
        // the refusal answer carries the write problem verbatim when the audit
        // tail cannot be written.
        if let Err(problem) = run.watchdog.journal().record(
            JournalEvent::StandDown,
            json!({ "reason": "a stock admission holds the card fence; no mutation sent" }),
        ) {
            answer["journalError"] = json!(problem);
        }
        return answer;
    }
    // W3: from here the arm owns the cell's posture. If it unwinds before answering,
    // [`SeverGuard`]'s Drop parks the facts honestly and moves the cell out of
    // `severing` — no later tick stands down forever, no later claim 409s forever.
    let mut guard = SeverGuard::new(
        Arc::clone(&run.cell),
        Arc::clone(run.watchdog.journal()),
        hold,
        run.row_id.clone(),
    );
    // F1 (LEG AF2-M20): publish a PROVISIONAL latch the moment the arm owns the cell.
    // `take_cell` parks the phase at `severing`, but the phase alone never reaches the
    // drain — the M18a probes read the LATCH. Until now every probe through the arm's
    // cancel/confirm/clear/free/restore legs (seconds to minutes) saw `None`: the C1
    // per-row stop was inert exactly while the arm ran, a row CAS+submit after the trip
    // escaped the arm's cancel snapshot AND its clear (Draining rows skipped), and the
    // drain's post-free/idle checks could stack its own free/restore legs onto the
    // arm's — two bats, double-load, the exact C1 class. The completed arm overwrites
    // this with its real answer verbatim (the `Hold::Borrowed` `note_sever` in
    // [`sever_legs`]); an unwound arm's [`SeverGuard::Drop`] replaces it the same way
    // it replaces the latch today — never a double-note. The stand-down law (a tick
    // never runs under `Unloading`/`Restoring`/`Severing`) plus this latch make the
    // arm the only in-control worker from the trip onward: every drain exit that
    // consults `sever()` sees `Some`, stops, and hands the legs over.
    run.cell.note_sever(json!({
        "provisional": true,
        "severedRow": run.row_id,
        "freed": false,
        "restored": false,
        "phase": "arm-running",
    }));
    let answer = sever_legs(run, guard.hold()).await;
    guard.complete();
    answer
}

/// over. Journal rows are the instrument that pins the order.
async fn sever_legs(run: &SeverRun, hold: &Hold) -> Value {
    let control = &run.watchdog.seams.control;
    let journal = run.watchdog.journal().clone();
    // M18d cleanup (LEG AF2-M19b): a journal write failure never rides silently —
    // every leg's failed row is collected here verbatim, and the terminal sever
    // answer carries them all in `journalError`. The arms still run: the audit
    // tail breaking does not cancel the card's recovery; it just gets told.
    // W3-15 (LEG AF2-M21a): the seed is the caller's pre-arm failures (the tick's
    // trip row) — one surfacing home, never a swallowed `let _ =` upstream.
    let mut journal_problems: Vec<String> = run.pre_journal_problems.clone();

    // 1. cancel: the scoped interrupt on the running job, the `{"delete"}` cancel on
    //    every pending job. Scoped verbs only — never a global interrupt.
    let live = control.live_jobs().await;
    let running: Vec<String> = live
        .iter()
        .filter(|(_, state)| state == "running")
        .map(|(job_id, _)| job_id.clone())
        .collect();
    let pending: Vec<String> = live
        .iter()
        .filter(|(_, state)| state == "queued")
        .map(|(job_id, _)| job_id.clone())
        .collect();
    let mut cancel_errors: Vec<String> = Vec::new();
    for job_id in &running {
        if let Err(problem) = control.interrupt_running(job_id).await {
            cancel_errors.push(format!("interrupt {job_id}: {problem}"));
        }
    }
    for job_id in &pending {
        if let Err(problem) = control.cancel_pending(job_id).await {
            cancel_errors.push(format!("cancel {job_id}: {problem}"));
        }
    }
    if let Err(problem) = journal.record(
        JournalEvent::Cancel,
        json!({
            "row": run.row_id,
            "running": running,
            "pending": pending,
            "errors": cancel_errors,
        }),
    ) {
        journal_problems.push(problem);
    }

    // 2. confirm: terminal truth comes from the stock row driver, never a private
    //    read of the wire (P6 law). Bounded polls per job: the stock mutation is
    //    asynchronous, and a job the driver never answers terminal must not park the
    //    arm — the same never-forever posture as §8.4.
    let mut confirmed = serde_json::Map::new();
    for job_id in running.iter().chain(pending.iter()) {
        let mut word = None;
        for probe in 1..=CONFIRM_PROBE_BOUND {
            word = control.confirm_terminal(job_id).await;
            if word.is_some() || probe == CONFIRM_PROBE_BOUND {
                break;
            }
            run.cycle_seams
                .pacer
                .pause(cycle::HEALTH_PROBE_GAP_MS)
                .await;
        }
        confirmed.insert(job_id.clone(), json!(word));
    }
    if let Err(problem) = journal.record(
        JournalEvent::Confirm,
        json!({ "jobs": Value::Object(confirmed) }),
    ) {
        journal_problems.push(problem);
    }

    // 3. clear: every remaining queued row the spool holds is cancelled with the
    //    `jobWedged` reason (durable in the queue file plus the journal row); the
    //    latched row itself goes to the `wedged` wire word.
    let mut cancelled_rows: Vec<String> = Vec::new();
    let mut clear_errors: Vec<String> = Vec::new();
    match run.spool.snapshot() {
        Ok(rows) => {
            for row in rows.iter().filter(|row| row.status == RowStatus::Queued) {
                match run
                    .spool
                    .set_status(&row.id, RowStatus::Queued, RowStatus::Cancelled)
                {
                    Ok(true) => cancelled_rows.push(row.id.clone()),
                    Ok(false) => clear_errors.push(format!("{}: no longer queued", row.id)),
                    Err(problem) => clear_errors.push(format!("{}: {problem}", row.id)),
                }
            }
        }
        Err(problem) => clear_errors.push(problem),
    }
    if let Some(row_id) = &run.row_id {
        match run
            .spool
            .set_status(row_id, RowStatus::Draining, RowStatus::Wedged)
        {
            Ok(true) => {}
            Ok(false) => clear_errors.push(format!(
                "{row_id}: not draining (the drain answered it first)"
            )),
            Err(problem) => clear_errors.push(format!("{row_id}: {problem}")),
        }
    }
    if let Err(problem) = journal.record(
        JournalEvent::Clear,
        json!({
            "reason": FAULT_SEVER,
            "cancelled": cancelled_rows,
            "wedged": run.row_id,
            "errors": clear_errors,
        }),
    ) {
        journal_problems.push(problem);
    }

    // 4. free: only after the backend idle proof, and only the exact two-key body
    //    (the resources.rs wire law). The compute permit is taken for the legs the
    //    same way the cycle takes it; the fence this arm holds already keeps stock
    //    stages out, so a busy permit is surfaced honestly rather than blocking the
    //    recovery the card needs.
    let _permit = run.cycle_seams.gate.reserve().ok();
    let idle_proof = run.cycle_seams.door.queue_idle_proof().await;
    let mut freed = false;
    // W4-A (LEG AF2-M22): the arm's free-fault settle verdict. `true` once the
    // settle has NEVER proved the queue idle; the restore decision below treats it
    // exactly like a QueueLive proof failure — the NEVER-co-resident law does not
    // care whether the live queue was seen by the gate proof or by a settle
    // re-probe after the cancel legs.
    let mut free_settle_unproven = false;
    let mut free_detail: Option<String> = idle_proof.as_ref().err().map(ToString::to_string);
    if free_detail.is_none() {
        let body = json!({ "unload_models": true, "free_memory": true });
        match run.cycle_seams.door.free(body).await {
            Ok(()) => freed = true,
            Err(problem) => {
                free_detail = Some(problem);
                // W3-5 (LEG AF2-M21a): the arm's single-attempt free now shares the
                // ONE fault-path settle home with the cycle's free leg (the old
                // asymmetry was the F4/P5 race in miniature — a free APPLIED with
                // the ack lost, then a bat stacked onto the post-free cache reset).
                // Bounded, honest-log per probe; the arm's fault stands regardless.
                // W4-A (LEG AF2-M22): the verdict gates the arm's restore leg —
                // never proven idle means a live queue landed after the gate
                // proof, and no bat may stack beside it.
                if !cycle::free_fault_settle(&run.cycle_seams).await {
                    free_settle_unproven = true;
                }
            }
        }
    }
    if let Err(problem) = journal.record(
        JournalEvent::Free,
        json!({ "freed": freed, "detail": free_detail }),
    ) {
        journal_problems.push(problem);
    }

    // 5. RESTORE — one law across every end path (W3-2 + W3-9 + W3-4, LEG
    //    AF2-M21a): the posture derives from DID-RESTORE, and CAUSE gates the
    //    bat. The NEVER-co-resident law outranks the recovery urge: an idle
    //    proof that failed while the backend was still answering (`queueLive`)
    //    means a live stock queue on the card, and no restore bat may spawn
    //    beside it — the arm answers restored:false + cardAtRisk:true honestly.
    //    Where the free landed, the card went DOWN: with the operator's restore
    //    word, the shipped bounded leg MUST end it restored (§8.4 exhaustion
    //    rides restored:false + cardAtRisk); with NO restore word behind the
    //    free, the arm never claims `true` — config never proves the card came
    //    up. Neither freed nor queue-live: the inherited posture stands, and the
    //    crash-recovery restore (backendDown proof failure, the drain's own
    //    unload) runs when the word runs bats.
    let proof_says_queue_live = matches!(
        &idle_proof,
        Err(fault) if fault.class == cycle::ProofFault::QueueLive
    );
    let mut restored = true;
    let mut card_at_risk = false;
    let mut restore_detail: Option<String> = None;
    if proof_says_queue_live {
        restored = false;
        card_at_risk = true;
        if let Err(fault) = &idle_proof {
            restore_detail = Some(format!(
                "restore skipped: the backend is still answering with a live queue ({fault}) - no restore bat beside it"
            ));
        }
    } else if free_settle_unproven {
        // W4-A (LEG AF2-M22): the gate proof passed, the free was attempted and
        // never acked, and the shared settle never proved the queue idle — a live
        // job answered after the proof. Same law, same honesty: the arm already
        // cleared its spool rows, so no auto driver will return; resume answers
        // the owed restore from this report (modelRestored:false, W3-9's law).
        restored = false;
        card_at_risk = true;
        restore_detail = Some(
            "restore skipped: the free-fault settle never proved the queue idle - no restore bat beside an unproven queue, debt owed"
                .to_owned(),
        );
    } else if freed {
        if run.guard.auto_cycle_vram {
            run.cell.set_phase(CyclePhase::Restoring);
            restored = matches!(
                cycle::restore_leg(&run.cycle_seams, &run.guard, None).await,
                cycle::RestoreOutcome::Restored
            );
            if !restored {
                card_at_risk = true;
            }
        } else {
            restored = false;
            card_at_risk = true;
            if run.guard_corrupt {
                // W3-4: the guard exists but cannot be parsed — the shipped
                // defaults ran, and that is exactly why no restore bat exists.
                restore_detail = Some("guard unreadable - restore bat unavailable".to_owned());
            }
        }
    } else if run.guard.auto_cycle_vram {
        run.cell.set_phase(CyclePhase::Restoring);
        restored = matches!(
            cycle::restore_leg(&run.cycle_seams, &run.guard, None).await,
            cycle::RestoreOutcome::Restored
        );
        if !restored {
            card_at_risk = true;
        }
    }
    if let Err(problem) = journal.record(
        JournalEvent::Restore,
        json!({
            "restored": restored,
            "autoCycleVram": run.guard.auto_cycle_vram,
            "cardAtRisk": card_at_risk,
            "detail": restore_detail,
        }),
    ) {
        journal_problems.push(problem);
    }

    // 6/7. answer, then journal it: the same object the held caller reads, the cell
    //      persists, and the journal carries. The journal row is written BEFORE the
    //      answer gains its `journalError` member — the tail cannot carry the fact
    //      of its own failed write; the wire answer can.
    let mut answer = json!({
        "ok": false,
        "reason": FAULT_SEVER,
        "severedRow": run.row_id,
        "freed": freed,
        "restored": restored,
        // W3-9 (LEG AF2-M21a): the posture derives from DID-RESTORE — the card
        // flag rides every arm answer, honest by construction.
        "cardAtRisk": card_at_risk,
        // W3-11: the audit tail names its own trigger; the latch payload and the
        // journal row carry the same object the caller reads.
        "trigger": run.trigger,
        "at": now_ms(),
    });
    if let Some(detail) = &restore_detail {
        answer["detail"] = json!(detail);
    }
    match hold {
        Hold::Claimed { cycle_id, .. } => {
            let mut report = answer.clone();
            report["cycleId"] = json!(cycle_id);
            report["modelRestored"] = json!(restored);
            report["autoCycleVram"] = json!(run.guard.auto_cycle_vram);
            report["freeOnQueueEnd"] = json!(run.guard.free_on_queue_end);
            report["rows"] = json!([]);
            report["completedAt"] = json!(now_ms());
            report["fault"] = json!({
                "reason": FAULT_SEVER,
                "detail": format!(
                    "the watchdog severed row {}; freed {freed}, restored {restored}{}",
                    run.row_id.as_deref().unwrap_or("(unattributed)"),
                    restore_detail
                        .as_deref()
                        .map_or_else(String::new, |detail| format!("; {detail}")),
                ),
            });
            run.cell.finish(report);
        }
        Hold::Borrowed { phase_before } => {
            // The drain owns this cycle: hand the phase back and leave the answer in
            // the cell, so the drain's finish path reports the sever as its fault
            // instead of re-running the legs this arm just ran (§8.4 rationale: never
            // spam-load an engine the arm already restored).
            run.cell.set_phase(*phase_before);
            run.cell.note_sever(answer.clone());
        }
        Hold::Refused => {}
    }
    if let Err(problem) = journal.record(JournalEvent::Sever, answer.clone()) {
        journal_problems.push(problem);
    }
    if !journal_problems.is_empty() {
        // Verbatim problems, joined — the plane paraphrases no write failure.
        answer["journalError"] = json!(journal_problems.join("; "));
    }
    answer
}

/* ------------------------------ production wedge control ------------------------------ */

/// Confirmation polls per job after the cancel mutation. Bounded, so a job whose row
/// driver never answers terminal cannot park the arm — the same bounded-never-forever
/// posture as §8.4.
const CONFIRM_PROBE_BOUND: u32 = 5;

/// The stock job states the row driver treats as terminal (the words P6 names).
const TERMINAL_WORDS: [&str; 4] = ["succeeded", "failed", "cancelled", "unknown"];

/// Production control: the token-gated stock workbench verbs called in-process (the
/// scan.rs managed-state idiom), plus the stock row-driver read for confirmation.
/// Scoped mutations only — the watchdog never posts a global interrupt and never
/// clears the backend queue (§8.3).
pub(crate) struct StockWedgeControl {
    app: tauri::AppHandle,
}

impl StockWedgeControl {
    /// The managed Jobs state, taken per call the way every other stock bridge in
    /// this plane takes it.
    fn jobs(app: &tauri::AppHandle) -> tauri::State<'_, crate::jobs::Jobs> {
        use tauri::Manager as _;
        app.state::<crate::jobs::Jobs>()
    }
}

impl WedgeControl for StockWedgeControl {
    fn live_jobs(&self) -> BoxFuture<'static, Vec<(String, String)>> {
        let app = self.app.clone();
        Box::pin(async move {
            let ids = Self::jobs(&app).active_job_ids();
            let mut live = Vec::with_capacity(ids.len());
            for id in ids {
                if let Ok(status) =
                    crate::jobs::native_job_status(Self::jobs(&app), id.clone()).await
                {
                    if let Some(state) = status["state"].as_str() {
                        live.push((id, state.to_owned()));
                    }
                }
            }
            live
        })
    }

    fn interrupt_running(&self, job_id: &str) -> BoxFuture<'static, Result<(), String>> {
        let app = self.app.clone();
        let job_id = job_id.to_owned();
        Box::pin(async move {
            use tauri::Manager as _;
            crate::jobs::native_workbench_interrupt_running(
                Self::jobs(&app),
                app.state::<crate::install::Engine>(),
                job_id,
                true,
            )
            .await
            .map(|_| ())
        })
    }

    fn cancel_pending(&self, job_id: &str) -> BoxFuture<'static, Result<(), String>> {
        let app = self.app.clone();
        let job_id = job_id.to_owned();
        Box::pin(async move {
            use tauri::Manager as _;
            crate::jobs::native_workbench_cancel_pending(
                Self::jobs(&app),
                app.state::<crate::install::Engine>(),
                job_id,
                true,
            )
            .await
            .map(|_| ())
        })
    }

    fn confirm_terminal(&self, job_id: &str) -> BoxFuture<'static, Option<String>> {
        let app = self.app.clone();
        let job_id = job_id.to_owned();
        Box::pin(async move {
            let status = crate::jobs::native_job_status(Self::jobs(&app), job_id)
                .await
                .ok()?;
            let word = status["state"].as_str()?;
            TERMINAL_WORDS.contains(&word).then(|| word.to_owned())
        })
    }
}

#[cfg(test)]
mod fakes {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;

    /// Scripted GPU facts, consumed in tick order; the fallback posture answers once
    /// the script runs out (an endless quiet script needs no endless vector).
    pub(crate) struct ScriptSampler {
        pub(crate) facts: Mutex<VecDeque<SampleFacts>>,
        pub(crate) fallback: SampleFacts,
        pub(crate) samples: AtomicU32,
    }

    impl ScriptSampler {
        pub(crate) fn new(
            scripted: impl IntoIterator<Item = SampleFacts>,
            fallback: SampleFacts,
        ) -> Self {
            Self {
                facts: Mutex::new(scripted.into_iter().collect()),
                fallback,
                samples: AtomicU32::new(0),
            }
        }
    }

    impl GpuSampler for ScriptSampler {
        fn sample(&self) -> BoxFuture<'static, SampleFacts> {
            self.samples.fetch_add(1, Ordering::SeqCst);
            let facts = self
                .facts
                .lock()
                .expect("sampler script")
                .pop_front()
                .unwrap_or_else(|| self.fallback.clone());
            Box::pin(async move { facts })
        }
    }

    /// The quiet posture: 5 % util, 12 000 MiB held (a still card).
    pub(crate) fn quiet() -> SampleFacts {
        SampleFacts {
            gpus: vec![GpuFacts {
                utilization: Some(5.0),
                memory_used_mib: Some(12_000),
            }],
        }
    }

    /// Fact one broken: the GPU is loud, VRAM still flat.
    pub(crate) fn loud() -> SampleFacts {
        SampleFacts {
            gpus: vec![GpuFacts {
                utilization: Some(85.0),
                memory_used_mib: Some(12_000),
            }],
        }
    }

    /// One GPU reading; the truth table builds windows out of these.
    pub(crate) fn facts(util: f64, mem_mib: u64) -> SampleFacts {
        SampleFacts {
            gpus: vec![GpuFacts {
                utilization: Some(util),
                memory_used_mib: Some(mem_mib),
            }],
        }
    }

    /// The AMD / absent-tool posture: the card reports nothing readable.
    pub(crate) fn unknown() -> SampleFacts {
        SampleFacts {
            gpus: vec![GpuFacts {
                utilization: None,
                memory_used_mib: None,
            }],
        }
    }

    /// Records the arm's every control call in order and answers scripted postures.
    #[derive(Default)]
    pub(crate) struct ScriptControl {
        pub(crate) calls: Mutex<Vec<String>>,
        pub(crate) live: Vec<(String, String)>,
        pub(crate) fail: Vec<String>,
        pub(crate) terminal: Vec<String>,
        /// F1 (LEG AF2-M20) probe mount: when set, the seam snapshots the cell's
        /// sever latch at every arm-leg call, so a test reads exactly what a
        /// CONCURRENT drain probe would see DURING the arm. Unset everywhere else.
        pub(crate) probe_cell: Mutex<Option<Arc<CycleCell>>>,
        pub(crate) latches: Mutex<Vec<Option<Value>>>,
    }

    impl ScriptControl {
        pub(crate) fn one_running() -> Self {
            Self {
                live: vec![
                    ("job-run".to_owned(), "running".to_owned()),
                    ("job-queue".to_owned(), "queued".to_owned()),
                ],
                terminal: vec!["cancelled".to_owned(), "cancelled".to_owned()],
                ..Self::default()
            }
        }
    }

    impl WedgeControl for ScriptControl {
        fn live_jobs(&self) -> BoxFuture<'static, Vec<(String, String)>> {
            self.calls
                .lock()
                .expect("control log")
                .push("live".to_owned());
            if let Some(cell) = self.probe_cell.lock().expect("probe cell").clone() {
                self.latches.lock().expect("latch log").push(cell.sever());
            }
            let live = self.live.clone();
            Box::pin(async move { live })
        }
        fn interrupt_running(&self, job_id: &str) -> BoxFuture<'static, Result<(), String>> {
            self.calls
                .lock()
                .expect("control log")
                .push(format!("interrupt {job_id}"));
            let fails = self.fail.iter().any(|id| id == job_id);
            Box::pin(async move {
                if fails {
                    Err("scripted: interrupt refused".to_owned())
                } else {
                    Ok(())
                }
            })
        }
        fn cancel_pending(&self, job_id: &str) -> BoxFuture<'static, Result<(), String>> {
            self.calls
                .lock()
                .expect("control log")
                .push(format!("cancel {job_id}"));
            Box::pin(async move { Ok(()) })
        }
        fn confirm_terminal(&self, job_id: &str) -> BoxFuture<'static, Option<String>> {
            self.calls
                .lock()
                .expect("control log")
                .push(format!("confirm {job_id}"));
            let word = self.terminal.first().cloned();
            Box::pin(async move { word })
        }
    }
}

// The cycle module's re-export idiom, matched: the plane-level tests (transport,
// M8 acceptance) drive the judge over these scripted seams without reaching into
// the private fakes module.
#[cfg(test)]
pub(crate) use fakes::{quiet, ScriptControl, ScriptSampler};

#[cfg(test)]
mod tests {
    use super::super::cycle::{
        ScriptChain, ScriptCommands, ScriptCorrelation, ScriptDoor, ScriptGate, ScriptHealth,
        ScriptPacer,
    };
    use super::super::fill_plane::Slots;
    use super::super::spool::QueueRow;
    use super::fakes::*;
    use super::*;
    use serde_json::Map;

    fn config(window_sec: u32, grace_sec: u64) -> WatchdogConfig {
        WatchdogConfig {
            window_sec,
            grace_sec,
            ..WatchdogConfig::default()
        }
    }

    fn subject(id: &str) -> Subject {
        Subject {
            key: id.to_owned(),
            row_id: Some(id.to_owned()),
            confirmed_running: true,
        }
    }

    /// Feeds `n` identical ticks and returns the last verdict.
    fn feed(state: &mut LoopState, n: u32, facts: &SampleFacts, cfg: &WatchdogConfig) -> Tick {
        let mut last = Tick::StandDown;
        for index in 0..n {
            last = state.observe(
                Some(subject("row-a")),
                facts,
                cfg,
                1_000 + u64::from(index) * 1_000,
            );
        }
        last
    }

    #[test]
    fn quiet_util_over_moving_vram_never_trips() {
        let _gate = crate::resources::fence_test_gate();
        // Fact one alone: the GPU idles, but the card keeps churning (> 3 GiB span).
        let mut state = LoopState::default();
        let cfg = config(5, 0);
        for index in 0..5 {
            let moved = facts(5.0, 12_000 + index * 2_000);
            let verdict = state.observe(Some(subject("row-a")), &moved, &cfg, 1_000 * (index + 1));
            assert_eq!(verdict, Tick::Watching, "one fact is not a wedge");
        }
        assert_eq!(state.trip, None);
    }

    #[test]
    fn loud_util_over_static_vram_never_trips() {
        let _gate = crate::resources::fence_test_gate();
        // Fact two alone: the card is flat, but the GPU is plainly working.
        let mut state = LoopState::default();
        let verdict = feed(&mut state, 5, &loud(), &config(5, 0));
        assert_eq!(verdict, Tick::Watching);
        assert_eq!(state.trip, None);
    }

    #[test]
    fn both_facts_quiet_over_a_full_window_trips() {
        let _gate = crate::resources::fence_test_gate();
        let mut state = LoopState::default();
        let verdict = feed(&mut state, 5, &quiet(), &config(5, 0));
        assert_eq!(
            verdict,
            Tick::Tripped {
                key: "row-a".to_owned()
            }
        );
        let trip = state.trip.clone().expect("trip recorded");
        assert_eq!(trip.subject.row_id.as_deref(), Some("row-a"));
    }

    #[test]
    fn a_short_window_is_never_quiet() {
        let _gate = crate::resources::fence_test_gate();
        // The sample count IS the window: one tick short of full cannot trip.
        let mut state = LoopState::default();
        let verdict = feed(&mut state, 4, &quiet(), &config(5, 0));
        assert_eq!(verdict, Tick::Watching);
    }

    #[test]
    fn unknown_facts_poison_the_window_and_never_trip() {
        let _gate = crate::resources::fence_test_gate();
        // The AMD posture: nothing readable, so never quiet, whatever came before.
        let mut state = LoopState::default();
        let cfg = config(5, 0);
        feed(&mut state, 4, &quiet(), &cfg);
        assert_eq!(
            state.observe(Some(subject("row-a")), &unknown(), &cfg, 6_000),
            Tick::Watching
        );
        assert!(state.samples.is_empty(), "the window restarted, poisoned");
        // An empty GPU list is the missing-nvidia-smi shape: also unknown.
        assert_eq!(
            state.observe(
                Some(subject("row-a")),
                &SampleFacts { gpus: vec![] },
                &cfg,
                7_000
            ),
            Tick::Watching
        );
        assert!(state.samples.is_empty());
        assert_eq!(state.trip, None, "blindness never trips");
    }

    #[test]
    fn grace_holds_the_trip_off_during_the_load_heavy_leg() {
        let _gate = crate::resources::fence_test_gate();
        // 40 s of both-facts-quiet with grace 120: eligible only once the clock passes.
        let mut state = LoopState::default();
        let cfg = config(5, 120);
        let mut verdict = Tick::Watching;
        for second in 1..=40 {
            verdict = state.observe(Some(subject("row-a")), &quiet(), &cfg, second * 1_000);
        }
        assert_eq!(verdict, Tick::Watching, "the grace window protects the leg");
        assert_eq!(state.trip, None);
        verdict = state.observe(Some(subject("row-a")), &quiet(), &cfg, 121_000);
        assert_eq!(
            verdict,
            Tick::Tripped {
                key: "row-a".to_owned()
            }
        );
    }

    #[test]
    fn one_latch_per_row() {
        let _gate = crate::resources::fence_test_gate();
        let mut state = LoopState::default();
        let cfg = config(3, 0);
        feed(&mut state, 3, &quiet(), &cfg);
        // The window keeps satisfying the facts; the second trip must not fire.
        for second in 4..=10 {
            assert_eq!(
                state.observe(Some(subject("row-a")), &quiet(), &cfg, second * 1_000),
                Tick::Watching,
                "the latch is once per row"
            );
        }
        // A different row is a different subject: it may latch too.
        assert_eq!(
            state.observe(Some(subject("row-b")), &quiet(), &cfg, 11_000),
            Tick::Watching,
            "a new subject starts a new window"
        );
        assert_eq!(state.latched.as_deref(), Some("row-a"));
    }

    #[test]
    fn the_median_and_span_the_judge_reads() {
        let _gate = crate::resources::fence_test_gate();
        let samples = [
            Sample {
                util_pct: 3.0,
                mem_used_mib: 10_000,
            },
            Sample {
                util_pct: 90.0,
                mem_used_mib: 10_100,
            },
            Sample {
                util_pct: 5.0,
                mem_used_mib: 9_900,
            },
        ];
        // Median of a loud outlier set stays quiet: that is why the judge takes the
        // median and not the mean.
        assert_eq!(median_util(&samples), 5.0);
        assert_eq!(mem_span(&samples), 200);
        assert!(window_is_quiet(&samples, &config(3, 0)));
    }

    #[test]
    fn the_window_clamps_to_the_owner_range() {
        let _gate = crate::resources::fence_test_gate();
        let (low, note) = WatchdogConfig::from_raw(Some(&json!({ "windowSec": 5 })));
        assert_eq!(low.window_sec, MIN_WINDOW_SEC);
        assert!(note.expect("clamp is honest").contains("clamped"));
        let (high, _) = WatchdogConfig::from_raw(Some(&json!({ "windowSec": 9_999 })));
        assert_eq!(high.window_sec, MAX_WINDOW_SEC);
        assert_eq!(clamp_window(60), 60, "an in-range window passes through");
    }

    #[test]
    fn a_malformed_block_is_defaults_plus_the_honest_note() {
        let _gate = crate::resources::fence_test_gate();
        let (cfg, note) = WatchdogConfig::from_raw(Some(&json!({ "windowSec": "sixty" })));
        assert_eq!(cfg, WatchdogConfig::default());
        assert!(note.expect("note").contains("malformed"));
        // An unknown key is refused the same way: a typo surfaces, it does not vanish.
        let (cfg, note) = WatchdogConfig::from_raw(Some(&json!({ "quietTicks": 3 })));
        assert_eq!(cfg, WatchdogConfig::default());
        assert!(note.expect("note").contains("quietTicks"));
        // Absent is the defaults with no note (the shipped posture, no log noise).
        let (cfg, note) = WatchdogConfig::from_raw(None);
        assert_eq!(cfg, WatchdogConfig::default());
        assert!(note.is_none());
    }

    #[test]
    fn the_hot_reloaded_block_moves_the_numbers() {
        let _gate = crate::resources::fence_test_gate();
        let dir = tempfile::tempdir().expect("tempdir");
        // Guard absent: the watchdog numbers are the shipped defaults.
        let absent = super::super::guard::load(dir.path())
            .expect("absent is not an error")
            .is_none();
        assert!(absent);
        std::fs::write(
            dir.path().join(super::super::guard::FILE),
            r#"{"autoCycleVram": false, "watchdog": {"windowSec": 45, "utilMedianPct": 8,
               "vramStaticMiB": 512, "graceSec": 30, "guardOwnRuns": false}}"#,
        )
        .expect("guard file");
        let loaded = super::super::guard::load(dir.path())
            .expect("valid")
            .expect("present");
        assert_eq!(
            loaded.watchdog,
            WatchdogConfig {
                window_sec: 45,
                util_median_pct: 8,
                vram_static_mib: 512,
                grace_sec: 30,
                guard_own_runs: false,
            }
        );
    }

    /* ------------------------------ the arm ------------------------------ */

    struct Harness {
        dir: tempfile::TempDir,
        spool: Arc<Spool>,
        cell: Arc<CycleCell>,
        commands: Arc<ScriptCommands>,
        door: Arc<ScriptDoor>,
        health: Arc<ScriptHealth>,
        pacer: Arc<ScriptPacer>,
        gate: Arc<ScriptGate>,
        control: Arc<ScriptControl>,
        watchdog: Arc<Watchdog>,
    }

    fn row(id: &str, status: RowStatus) -> QueueRow {
        QueueRow {
            id: id.to_owned(),
            created_at: 1_700_000_000_000,
            status,
            envelope: json!({ "apiVersion": 1, "family": "anima", "mode": "t2i" }),
            slots: Slots::default(),
            extras: Map::new(),
            job_id: None,
            story_link: None,
        }
    }

    impl Harness {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let spool = Arc::new(Spool::new(dir.path()));
            let cell = Arc::new(CycleCell::new(dir.path()));
            let control = Arc::new(ScriptControl::one_running());
            let sampler: Arc<dyn GpuSampler> = Arc::new(ScriptSampler::new(Vec::new(), quiet()));
            let control_dyn: Arc<dyn WedgeControl> = control.clone();
            let seams = Arc::new(WatchdogSeams {
                sampler,
                control: control_dyn,
            });
            // Built before the struct literal moves `dir`: the watchdog and its
            // journal keep their own copies of the app-data path.
            let watchdog = Arc::new(Watchdog::new(dir.path(), seams));
            Self {
                dir,
                spool,
                cell,
                commands: Arc::new(ScriptCommands::clean()),
                door: Arc::new(ScriptDoor::accepting()),
                health: Arc::new(ScriptHealth::always_healthy()),
                pacer: Arc::new(ScriptPacer::recording()),
                gate: Arc::new(ScriptGate::open()),
                control,
                watchdog,
            }
        }

        fn cycle_seams(&self) -> Arc<CycleSeams> {
            // The fakes enter the kit as trait objects; the annotations are the
            // coercion sites (the kit is a struct, so inference alone will not do it).
            let commands: Arc<dyn cycle::CommandRunner> = self.commands.clone();
            let chain: Arc<dyn cycle::SubmitChain> = Arc::new(ScriptChain::all_done());
            let door: Arc<dyn cycle::BackendDoor> = self.door.clone();
            let correlation: Arc<dyn cycle::RowCorrelation> = Arc::new(ScriptCorrelation::clean());
            let gate: Arc<dyn cycle::ComputeGate> = self.gate.clone();
            let health: Arc<dyn cycle::HealthProbe> = self.health.clone();
            let pacer: Arc<dyn cycle::Pacer> = self.pacer.clone();
            // The sever arm's own free leg has its OWN fault home (a single attempt,
            // `jobWedged` + the `freed:false` answer), not the cycle free-leg
            // exhaustion the startup-preset cause belongs to — so this home stays
            // unreadable: the sever never carries a `blockedOn` it did not earn.
            let startup: Arc<dyn cycle::StartupPreset> =
                Arc::new(cycle::FixedStartupPreset::unreadable());
            Arc::new(CycleSeams {
                commands,
                chain,
                door,
                correlation,
                gate,
                health,
                pacer,
                startup,
            })
        }

        fn guard(auto: bool) -> GuardConfig {
            GuardConfig {
                unload_command: "unload.bat /agent".to_owned(),
                restore_command: "restore.bat /agent".to_owned(),
                ready_url: "http://127.0.0.1:18502/health".to_owned(),
                auto_cycle_vram: auto,
                free_on_queue_end: true,
                watchdog: WatchdogConfig::default(),
                caps: super::super::caps::Caps::default(),
            }
        }

        async fn run_async(&self, auto: bool) -> Value {
            self.run_async_fully(auto, false, Vec::new()).await
        }

        /// The full posture (W3-4 corrupt flag, W3-15 pre-seeded journal problems):
        /// the fields the judge's tick fills from the guard read and the trip-row
        /// write, spelled by hand for the arm drills.
        async fn run_async_fully(
            &self,
            auto: bool,
            guard_corrupt: bool,
            pre_journal_problems: Vec<String>,
        ) -> Value {
            sever(&SeverRun {
                cell: Arc::clone(&self.cell),
                spool: Arc::clone(&self.spool),
                cycle_seams: self.cycle_seams(),
                watchdog: Arc::clone(&self.watchdog),
                guard: Self::guard(auto),
                guard_corrupt,
                trigger: "judge",
                pre_journal_problems,
                row_id: Some("row-a".to_owned()),
            })
            .await
        }

        fn journal_words(&self) -> Vec<String> {
            self.watchdog
                .journal()
                .rows()
                .expect("journal")
                .iter()
                .map(|entry| entry["event"].as_str().unwrap_or_default().to_owned())
                .collect()
        }

        /// The control surface's call log as plain words, so the assertions read as
        /// the arm's law order instead of as slice gymnastics.
        fn control_calls(&self) -> Vec<String> {
            self.control.calls.lock().expect("control log").clone()
        }
    }

    /// A word list in the shape the call log carries, so assertions stay readable.
    fn words(items: &[&str]) -> Vec<String> {
        items.iter().map(|word| (*word).to_owned()).collect()
    }

    #[tokio::test]
    async fn the_sever_order_is_the_law_and_the_journal_proves_it() {
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        harness
            .spool
            .append(&row("row-a", RowStatus::Draining))
            .expect("row");
        harness
            .spool
            .append(&row("row-b", RowStatus::Queued))
            .expect("row");
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("borrowed hold");
        let answer = harness.run_async(true).await;

        // §8.2: cancel -> confirm -> clear -> free -> restore -> answer/journal.
        assert_eq!(
            harness.journal_words(),
            [
                "watchdog-cancel",
                "watchdog-confirm",
                "watchdog-clear",
                "watchdog-free",
                "watchdog-restore",
                "watchdog-sever",
            ]
        );
        // The control calls themselves: scoped interrupt first, the `{"delete"}`
        // pending cancel next, then the row-driver confirmation.
        assert_eq!(
            harness.control_calls(),
            words(&[
                "live",
                "interrupt job-run",
                "cancel job-queue",
                "confirm job-run",
                "confirm job-queue",
            ]),
            "scoped interrupt, then the pending delete, then the row-driver reads"
        );
        // The answer the held caller reads.
        assert_eq!(answer["reason"], FAULT_SEVER);
        assert_eq!(answer["severedRow"], "row-a");
        assert_eq!(answer["freed"], true);
        assert_eq!(answer["restored"], true);
        // W3-9 (LEG AF2-M21a): the card flag rides every arm answer — here the
        // restore landed, so it is honestly false; W3-11: the trigger names what
        // ran the arm, so the audit tail cannot lose its own cause.
        assert_eq!(answer["cardAtRisk"], false, "{answer}");
        assert_eq!(answer["trigger"], "judge", "{answer}");
    }

    #[tokio::test]
    async fn the_spool_clear_is_durable_and_names_the_reason() {
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        harness
            .spool
            .append(&row("row-a", RowStatus::Draining))
            .expect("row");
        harness
            .spool
            .append(&row("row-b", RowStatus::Queued))
            .expect("row");
        harness
            .spool
            .append(&row("row-c", RowStatus::Queued))
            .expect("row");
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("borrowed hold");
        harness.run_async(false).await;

        // A fresh handle over the same app-data is the restart read: the clear is on
        // disk, not in memory.
        let reopened = Spool::new(harness.dir.path());
        let rows = reopened.snapshot().expect("healthy");
        let status = |id: &str| {
            rows.iter()
                .find(|row| row.id == id)
                .expect("row survives")
                .status
        };
        assert_eq!(status("row-a"), RowStatus::Wedged, "the latched row");
        assert_eq!(
            status("row-b"),
            RowStatus::Cancelled,
            "the remaining queued rows"
        );
        assert_eq!(status("row-c"), RowStatus::Cancelled);
        let clear = harness
            .watchdog
            .journal()
            .rows()
            .expect("journal")
            .into_iter()
            .find(|entry| entry["event"] == "watchdog-clear")
            .expect("clear row");
        assert_eq!(
            clear["detail"]["reason"], FAULT_SEVER,
            "durable reason word"
        );
        assert_eq!(clear["detail"]["wedged"], "row-a");
    }

    #[tokio::test]
    async fn a_sever_under_the_cycle_word_ends_restored() {
        let _gate = crate::resources::fence_test_gate();
        // §8.2 step 5 + §8.4: autoCycleVram true means the recovery arm MUST end
        // restored — the shipped bounded leg runs, not a reinvention.
        let harness = Harness::new();
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("borrowed hold");
        let answer = harness.run_async(true).await;
        assert_eq!(answer["restored"], true, "{answer}");
        let bats = harness.commands.runs.lock().expect("bat log");
        assert_eq!(
            bats.as_slice(),
            ["restore.bat /agent"],
            "the restore bat ran once and health answered healthy at once"
        );
        assert_eq!(
            harness
                .health
                .probes
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        // The arm hands the phase back to the drain and leaves its answer in the cell,
        // so the drain's finish path reports the sever instead of re-running the legs.
        assert_eq!(harness.cell.live().phase, CyclePhase::Draining);
        assert_eq!(harness.cell.sever().expect("noted")["reason"], FAULT_SEVER);
    }

    #[tokio::test]
    async fn the_free_leg_keeps_the_two_key_wire_and_the_gate() {
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("borrowed hold");
        harness.run_async(true).await;
        let bodies = harness.door.free_bodies.lock().expect("free log");
        assert_eq!(bodies.len(), 1);
        assert_eq!(
            bodies[0],
            json!({ "unload_models": true, "free_memory": true })
        );
        assert_eq!(
            harness
                .gate
                .reserves
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(
            harness
                .door
                .proof_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[tokio::test]
    async fn the_arm_latches_provisionally_at_its_start_and_its_answer_replaces_it() {
        let _gate = crate::resources::fence_test_gate();
        // F1 (LEG AF2-M20): the latch must be visible to a concurrent drain probe from
        // the trip onward, not only at the arm's last step. The probe-mounted seam
        // reads the cell from INSIDE the arm's first leg (the cancel step's
        // `live_jobs`): the provisional is already there, honestly claiming nothing
        // while the legs run. The completed arm then OVERWRITES the latch with its
        // real answer verbatim — the final fields ride, the provisional marker does
        // not.
        let harness = Harness::new();
        harness
            .spool
            .append(&row("row-a", RowStatus::Draining))
            .expect("row");
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("the drain owns the fence");
        *harness.control.probe_cell.lock().expect("probe mount") = Some(Arc::clone(&harness.cell));
        let answer = harness.run_async(true).await;
        // Mid-arm: the arm's own first leg saw a Some latch (the C1 fix's inert window,
        // closed — a drain probing at this instant stops and hands the legs over).
        let latches = harness.control.latches.lock().expect("latch log").clone();
        let seen = latches
            .first()
            .and_then(|latch| latch.clone())
            .expect("the arm's first leg saw a latch");
        assert_eq!(seen["provisional"], true, "{seen}");
        assert_eq!(seen["phase"], "arm-running");
        assert_eq!(seen["severedRow"], "row-a");
        assert_eq!(
            seen["freed"], false,
            "nothing is claimed while the legs run"
        );
        assert_eq!(seen["restored"], false);
        // Completion: the latch is the arm's real answer, verbatim — no provisional
        // marker survives it, and the answer fields ride exactly as the caller reads.
        assert_eq!(
            harness.cell.sever().expect("the answer is latched"),
            answer,
            "the completed arm overwrote the provisional verbatim"
        );
        let latch = harness.cell.sever().expect("latched");
        assert!(
            latch.get("provisional").is_none(),
            "the provisional marker is gone: {latch}"
        );
        assert_eq!(latch["reason"], FAULT_SEVER);
        assert_eq!(latch["severedRow"], "row-a");
        assert_eq!(
            latch["freed"], true,
            "the arm's finished fact rides the latch"
        );
        assert_eq!(latch["restored"], true);
        assert_eq!(
            harness.cell.live().phase,
            CyclePhase::Draining,
            "the phase is handed back for the drain's finish path"
        );
    }

    #[tokio::test]
    async fn an_idle_cell_takes_its_own_fence_and_answers_a_report() {
        let _gate = crate::resources::fence_test_gate();
        // No drain in flight (the unattributed posture): the arm claims, runs, and
        // closes the cycle so GET /v1/cycle answers the sever as its terminal report.
        let harness = Harness::new();
        let answer = harness.run_async(true).await;
        assert_eq!(answer["reason"], FAULT_SEVER);
        let live = harness.cell.live();
        assert_eq!(live.phase, CyclePhase::Idle, "the fence released");
        let report = live.report.expect("terminal persisted");
        assert_eq!(report["fault"]["reason"], FAULT_SEVER);
        assert_eq!(report["modelRestored"], true);
    }

    #[tokio::test]
    async fn a_refused_fence_severs_nothing() {
        let _gate = crate::resources::fence_test_gate();
        // Stock admission holds the fence: the arm stands down honestly, no mutation.
        let harness = Harness::new();
        crate::resources::fence_claim();
        let answer = harness.run_async(true).await;
        assert_eq!(answer["reason"], "cycleInFlight");
        assert_eq!(
            harness.control_calls(),
            Vec::<String>::new(),
            "refused before any mutation"
        );
        assert_eq!(
            harness
                .door
                .free_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert!(harness
            .journal_words()
            .contains(&"watchdog-standdown".to_owned()));
        crate::resources::fence_release();
    }

    /* ------------------------------ the loop law ------------------------------ */

    /// A plane whose guard file names the smallest window and no grace, so 30 quiet
    /// ticks are enough to trip without a wall-clock wait.
    fn armed_harness() -> Harness {
        let harness = Harness::new();
        std::fs::write(
            harness.dir.path().join(super::super::guard::FILE),
            r#"{"autoCycleVram": false, "watchdog": {"windowSec": 30, "graceSec": 0}}"#,
        )
        .expect("guard file");
        harness
    }

    async fn drive_ticks(watchdog: &Arc<Watchdog>, plane: &LoopPlane, times: u32) {
        for _ in 0..times {
            tick(watchdog, plane).await;
        }
    }

    #[tokio::test]
    async fn a_tripped_window_runs_the_arm_once_and_latches() {
        let _gate = crate::resources::fence_test_gate();
        let harness = armed_harness();
        harness
            .spool
            .append(&row("row-a", RowStatus::Draining))
            .expect("row");
        // W3-7 (LEG AF2-M21a): the window needs a CONFIRMED-running subject — the
        // row's jobId correlated to the seam's live `running` fact (the scripted
        // control names `job-run` running).
        harness
            .spool
            .set_job_id("row-a", "job-run")
            .expect("job correlated");
        let plane = LoopPlane {
            cell: Arc::clone(&harness.cell),
            spool: Arc::clone(&harness.spool),
            seams: harness.cycle_seams(),
        };
        drive_ticks(&harness.watchdog, &plane, 30).await;
        assert_eq!(
            harness.journal_words().first().map(String::as_str),
            Some("watchdog-trip"),
            "the trip row leads the record: {:?}",
            harness.journal_words()
        );
        // The row is wedged and the trip cleared: a second round of ticks does not
        // sever it again.
        let rows = harness.spool.snapshot().expect("healthy");
        assert_eq!(rows[0].status, RowStatus::Wedged);
        assert!(harness.watchdog.trip().is_none());
        assert_eq!(
            harness.watchdog.latched().as_deref(),
            Some("row-a"),
            "the latch names the row it took"
        );
        drive_ticks(&harness.watchdog, &plane, 30).await;
        assert_eq!(
            harness
                .journal_words()
                .iter()
                .filter(|word| word.as_str() == "watchdog-trip")
                .count(),
            1,
            "one latch per row"
        );
    }

    #[tokio::test]
    async fn the_judge_never_runs_under_an_unload_or_a_restore() {
        let _gate = crate::resources::fence_test_gate();
        // §8.3: the card-held-by-cycle disqualification, phase for phase.
        for phase in [CyclePhase::Unloading, CyclePhase::Restoring] {
            let harness = armed_harness();
            harness
                .spool
                .append(&row("row-a", RowStatus::Draining))
                .expect("row");
            harness.cell.claim(phase).expect("claim");
            let plane = LoopPlane {
                cell: Arc::clone(&harness.cell),
                spool: Arc::clone(&harness.spool),
                seams: harness.cycle_seams(),
            };
            drive_ticks(&harness.watchdog, &plane, 60).await;
            assert!(
                harness
                    .watchdog
                    .journal()
                    .rows()
                    .expect("journal")
                    .is_empty(),
                "{phase:?} disqualified"
            );
            assert_eq!(
                harness.cell.live().phase,
                phase,
                "the leg was not disturbed"
            );
            harness.cell.finish(json!({"cycleId": "x", "ok": true}));
        }
    }

    #[tokio::test]
    async fn a_user_launched_render_is_not_attributed_by_default() {
        let _gate = crate::resources::fence_test_gate();
        // guardOwnRuns true (the shipped default): live stock jobs, no API row in the
        // spool — nothing is attributed, so nothing is ever judged or severed.
        let harness = Harness::new();
        let plane = LoopPlane {
            cell: Arc::clone(&harness.cell),
            spool: Arc::clone(&harness.spool),
            seams: harness.cycle_seams(),
        };
        drive_ticks(&harness.watchdog, &plane, 5).await;
        assert_eq!(
            harness.control_calls(),
            Vec::<String>::new(),
            "not attributed, so not even read: the user's own render is invisible to the arm"
        );
        assert!(harness.watchdog.journal().rows().expect("empty").is_empty());
    }

    #[test]
    fn the_journal_words_are_closed_and_the_tail_is_bounded() {
        let _gate = crate::resources::fence_test_gate();
        let dir = tempfile::tempdir().expect("tempdir");
        let journal = Journal::new(dir.path());
        for _ in 0..(JOURNAL_CAP + 5) {
            journal
                .record(JournalEvent::Trip, json!({ "row": "row-a" }))
                .expect("append");
        }
        let rows = journal.rows().expect("healthy");
        assert_eq!(rows.len(), JOURNAL_CAP, "an audit tail, not a history");
        assert_eq!(rows[0]["event"], JournalEvent::Trip.word());
        assert_eq!(JournalEvent::Sever.word(), "watchdog-sever");
        // Absent is a healthy empty journal, and a fresh handle reads the same bytes.
        let reopened = Journal::new(dir.path());
        assert_eq!(reopened.rows().expect("healthy").len(), JOURNAL_CAP);
    }

    /// M18d cleanup (LEG AF2-M19b): the corruption probe the doors consult. Absent
    /// is healthy, readable is healthy, and an unreadable tail names its own
    /// problem verbatim — the same problem `record` reports, never a paraphrase.
    #[test]
    fn the_corruption_note_names_an_unreadable_journal_verbatim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let journal = Journal::new(dir.path());
        assert_eq!(
            journal.corruption_note(),
            None,
            "an absent journal is a healthy empty tail"
        );
        journal
            .record(JournalEvent::Trip, json!({ "row": "row-a" }))
            .expect("first row");
        assert_eq!(
            journal.corruption_note(),
            None,
            "a healthy tail carries no note"
        );
        std::fs::write(dir.path().join(JOURNAL_FILE), b"{ broken tail !!").expect("corrupt staged");
        let note = journal.corruption_note().expect("the corruption is named");
        assert!(note.contains(JOURNAL_FILE), "names the file: {note}");
        assert!(note.contains("parse"), "the read law's own word: {note}");
        // Fail closed: the probe reads, it never repairs behind the operator.
        assert_eq!(
            std::fs::read_to_string(dir.path().join(JOURNAL_FILE)).expect("still there"),
            "{ broken tail !!",
            "the corrupt bytes stay exactly as they were"
        );
    }

    /// M18d cleanup (LEG AF2-M19b): journal writes never pass silently. With the
    /// audit tail unreadable, the sever arm still runs its legs (a broken journal
    /// must not cancel the card's recovery), and the terminal answer carries
    /// `journalError` — the write problems verbatim, joined — so the operator
    /// learns from the SAME answer that the durable proof is missing.
    #[tokio::test]
    async fn a_corrupt_journal_still_runs_the_arms_and_the_answer_names_the_problems() {
        let _gate = crate::resources::fence_test_gate();
        let harness = Harness::new();
        harness
            .spool
            .append(&row("row-a", RowStatus::Draining))
            .expect("row");
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("borrowed hold");
        std::fs::write(harness.dir.path().join(JOURNAL_FILE), b"{ broken tail !!")
            .expect("corrupt journal staged");
        let answer = harness.run_async(false).await;
        // The legs ran: the answer reports the arm's real facts.
        assert_eq!(answer["reason"], FAULT_SEVER, "{answer}");
        assert_eq!(answer["freed"], true, "the free leg still ran: {answer}");
        assert_eq!(
            answer["severedRow"], "row-a",
            "the scoping still rides: {answer}"
        );
        // And the write failures surface, verbatim, on the answer.
        let problem = answer["journalError"]
            .as_str()
            .expect("journalError carries the write problems");
        assert!(problem.contains(JOURNAL_FILE), "names the file: {problem}");
        assert!(
            problem.contains("parse"),
            "the read law's own word: {problem}"
        );
        assert!(
            problem.contains(';'),
            "every leg's failed row is kept, not just the last: {problem}"
        );
    }

    #[tokio::test]
    async fn the_drain_law_reads_its_own_seam_and_never_the_wedge_controls_live_jobs() {
        let _gate = crate::resources::fence_test_gate();
        // M9a: the correlation probe is a seam of its own (a spool/stock read). The
        // watchdog's live-job seam — the arm's scoped-cancel target set — stays the
        // only reader of that fact, so the drain law cannot disturb what the judge
        // would see. The scripted control here reports a live running/pending pair,
        // and the law still never touches it.
        let harness = Harness::new();
        let seams = harness.cycle_seams();
        cycle::refuse_uncorrelated(&seams)
            .await
            .expect("a clean correlation read is the go-ahead");
        let calls = harness.control.calls.lock().expect("control log").clone();
        assert!(
            calls.is_empty(),
            "the drain law never rides the wedge control: {calls:?}"
        );
    }

    #[tokio::test]
    async fn attribution_takes_the_youngest_draining_row_never_the_oldest() {
        let _gate = crate::resources::fence_test_gate();
        // C2: an orphaned `draining` row left inside the same process (a panic between
        // the drain's CAS and its terminal write, which the drive guard contains but the
        // row's status outlives) must not hijack the subject. The row that is actually
        // running is the newest one, so the oldest-first pick would sever a row nobody
        // owns and let the live one wedge unwatched.
        let harness = Harness::new();
        let mut oldest = row("row-old", RowStatus::Draining);
        oldest.created_at = 1_700_000_000_000;
        let mut youngest = row("row-new", RowStatus::Draining);
        youngest.created_at = 1_700_000_900_000;
        // File order is deliberately oldest-first, so a `first()` pick would pass this.
        harness.spool.append(&oldest).expect("old row lands");
        harness.spool.append(&youngest).expect("new row lands");
        let subject = attributed_subject(
            &harness.watchdog.seams.control,
            &harness.spool,
            &WatchdogConfig::default(),
        )
        .await
        .expect("a draining row is a subject");
        assert_eq!(subject.key, "row-new", "the newest row is the subject");
        assert_eq!(subject.row_id.as_deref(), Some("row-new"));
    }

    #[tokio::test]
    async fn an_unwound_arm_that_borrowed_the_drain_fence_hands_the_phase_back_with_its_latch() {
        let _gate = crate::resources::fence_test_gate();
        // W3: the arm took the cell and never answered. The guard's Drop must not leave
        // the cell in `severing` — every later tick stands down under that phase and
        // every later claim answers 409 forever. The latch it leaves is the honest one:
        // nothing is claimed to have been freed or restored, and the drain's sever
        // posture (cycle.rs) then records it as the cycle's fault.
        let harness = Harness::new();
        harness
            .spool
            .append(&row("row-a", RowStatus::Draining))
            .expect("row");
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("the drain owns the fence");
        let hold = take_cell(&harness.cell);
        assert!(
            matches!(
                hold,
                Hold::Borrowed {
                    phase_before: CyclePhase::Draining
                }
            ),
            "a live cycle is the borrowed hold"
        );
        drop(SeverGuard::new(
            Arc::clone(&harness.cell),
            Arc::clone(harness.watchdog.journal()),
            hold,
            Some("row-a".to_owned()),
        ));
        assert_eq!(
            harness.cell.live().phase,
            CyclePhase::Draining,
            "the cell left severing; the judge is eligible again"
        );
        let latch = harness
            .cell
            .sever()
            .expect("the latch is visible to the drain");
        assert_eq!(latch["reason"], FAULT_SEVER);
        assert_eq!(latch["severedRow"], "row-a");
        assert_eq!(
            latch["freed"], false,
            "an unwound arm claims nothing was freed"
        );
        assert_eq!(
            latch["restored"], false,
            "an unwound arm claims nothing was restored"
        );
        assert!(
            harness
                .journal_words()
                .contains(&JournalEvent::Sever.word().to_owned()),
            "the unwind is journalled: {:?}",
            harness.journal_words()
        );
    }

    #[tokio::test]
    async fn an_unwound_arm_that_claimed_its_own_fence_closes_the_cycle() {
        let _gate = crate::resources::fence_test_gate();
        // The other hold: with no drain in flight the arm owned the fence, so the guard
        // closes the cycle with the unwound-arm posture and lowers the stock-facing
        // fence — a dead arm must not park every stock gate.
        let harness = Harness::new();
        let hold = take_cell(&harness.cell);
        assert!(
            matches!(hold, Hold::Claimed { .. }),
            "an idle cell is claimed"
        );
        drop(SeverGuard::new(
            Arc::clone(&harness.cell),
            Arc::clone(harness.watchdog.journal()),
            hold,
            None,
        ));
        let live = harness.cell.live();
        assert_eq!(
            live.phase,
            CyclePhase::Idle,
            "the fence went down with the arm"
        );
        let report = live.report.expect("the cycle answered");
        assert_eq!(report["fault"]["reason"], FAULT_SEVER);
        assert_eq!(report["freed"], false);
        assert_eq!(report["modelRestored"], false);
        assert!(
            !crate::resources::fence_held(),
            "an unwound arm must not strand the stock-facing fence"
        );
        assert_eq!(
            harness.cell.sever(),
            None,
            "a closed cycle carries no latch for a later one to trip over"
        );
    }

    /// A GPU seam that panics on its first calls: the seam-side simulation of the panic
    /// W3 contains. In production the panic can come from anywhere in the tick — the
    /// judge, a seam, the arm — and the law is the same: the loop survives it.
    struct PanickingSampler {
        calls: std::sync::atomic::AtomicU32,
        panics_first: u32,
        facts: SampleFacts,
    }

    impl GpuSampler for PanickingSampler {
        fn sample(&self) -> BoxFuture<'static, SampleFacts> {
            let seen = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if seen < self.panics_first {
                panic!("test seam: the tick unwinds here");
            }
            let facts = self.facts.clone();
            Box::pin(async move { facts })
        }
    }

    #[tokio::test]
    async fn a_panicking_tick_is_contained_and_the_loop_keeps_watching() {
        let _gate = crate::resources::fence_test_gate();
        // W3: a panic inside the tick used to end the watchdog task for the life of the
        // process (and could park the cell in `severing` on the way out). Contained, the
        // plane names it and stays armed: the same loop goes on to trip and sever normally
        // once the seam answers again.
        let harness = armed_harness();
        harness
            .spool
            .append(&row("row-a", RowStatus::Draining))
            .expect("row");
        harness
            .spool
            .set_job_id("row-a", "job-run")
            .expect("job correlated (W3-7 confirmation)");
        let control = harness.control.clone();
        let control_dyn: Arc<dyn WedgeControl> = control;
        let armed = Arc::new(WatchdogSeams {
            sampler: Arc::new(PanickingSampler {
                calls: std::sync::atomic::AtomicU32::new(0),
                panics_first: 1,
                facts: quiet(),
            }),
            control: control_dyn,
        });
        let watchdog = Arc::new(Watchdog::new(harness.dir.path(), armed));
        let plane = LoopPlane {
            cell: Arc::clone(&harness.cell),
            spool: Arc::clone(&harness.spool),
            seams: harness.cycle_seams(),
        };
        // The first tick unwinds inside the seam. `tick_guarded` must not let that reach
        // the caller — if it did, this test would abort instead of asserting below.
        tick_guarded(&watchdog, &plane).await;
        assert!(
            harness
                .watchdog
                .journal()
                .rows()
                .expect("journal")
                .is_empty(),
            "the panicking tick journalled nothing: no trip, no arm"
        );
        // The loop survived: the armed window's 30 quiet ticks (grace 0) still satisfy
        // the judge and run the arm exactly once.
        for _ in 0..30 {
            tick_guarded(&watchdog, &plane).await;
        }
        assert!(
            harness
                .journal_words()
                .contains(&"watchdog-trip".to_owned()),
            "the loop kept watching after the panic: {:?}",
            harness.journal_words()
        );
        assert_eq!(
            harness.spool.snapshot().expect("rows")[0].status,
            RowStatus::Wedged,
            "and the arm did its job once the seam answered again"
        );
    }

    #[tokio::test]
    async fn the_sever_s_restore_leg_carries_the_same_budget_as_the_cycle_s() {
        let _gate = crate::resources::fence_test_gate();
        // W1: the arm reuses the shipped restore leg (§8.2 step 5), so the bat budget
        // covers the arm's leg too — a hung restore bat cannot park a sever either.
        let harness = Harness::new();
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("borrowed hold");
        harness.run_async(true).await;
        assert_eq!(
            harness
                .commands
                .budgets
                .lock()
                .expect("budget log")
                .as_slice(),
            [cycle::RESTORE_TIMEOUT_MS],
            "the arm's one restore leg names the restore budget"
        );
    }

    #[test]
    fn the_fault_word_the_sever_carries_already_ships() {
        let _gate = crate::resources::fence_test_gate();
        assert!(super::super::errors::ALL_KINDS
            .iter()
            .any(|kind| kind.reason() == FAULT_SEVER));
    }

    /* ---------------------- LEG AF2-M21a (WALK 3 adjudication) ---------------------- */

    #[test]
    fn an_unconfirmed_subject_keeps_the_window_stood_down_and_never_trips() {
        let _gate = crate::resources::fence_test_gate();
        // W3-7 (LEG AF2-M21a): a `draining` row whose correlated stock job is not
        // (yet) running — parked on the stock compute gate, queued behind another
        // render, or compiling — is a HEALTHY batch. Whatever the row's age and
        // whatever the GPU facts: no samples, no grace clock, no trip (the C-W3
        // false-sever class this fix closes).
        let mut state = LoopState::default();
        let cfg = config(5, 0);
        let unconfirmed = Subject {
            key: "row-gate".to_owned(),
            row_id: Some("row-gate".to_owned()),
            confirmed_running: false,
        };
        for index in 0..20 {
            let verdict = state.observe(
                Some(unconfirmed.clone()),
                &quiet(),
                &cfg,
                1_000 * (index + 1),
            );
            assert_eq!(verdict, Tick::StandDown, "unconfirmed never feeds a window");
        }
        assert!(state.samples.is_empty(), "no samples accumulate");
        assert_eq!(state.trip, None, "no trip, ever");
    }

    #[test]
    fn grace_runs_from_confirmation_not_from_first_sighting() {
        let _gate = crate::resources::fence_test_gate();
        // W3-7: the grace clock starts at the CONFIRMED tick, not at the first tick
        // that saw the row `draining`. Ten unconfirmed ticks age nothing; the clock
        // starts at confirmation (t = 11 000), grace (3 s) closes at 14 000, and
        // the five-sample window completes at 15 000 — never before.
        let mut state = LoopState::default();
        let cfg = config(5, 3); // window 5 s, grace 3 s
        let unconfirmed = Subject {
            confirmed_running: false,
            ..subject("row-a")
        };
        for index in 0..10 {
            let verdict = state.observe(
                Some(unconfirmed.clone()),
                &quiet(),
                &cfg,
                1_000 * (index + 1),
            );
            assert_eq!(verdict, Tick::StandDown);
        }
        for index in 11..15 {
            let verdict = state.observe(Some(subject("row-a")), &quiet(), &cfg, 1_000 * index);
            assert_eq!(
                verdict,
                Tick::Watching,
                "grace runs from 11 000, not from 1 000 (t = {})",
                1_000 * index
            );
        }
        let verdict = state.observe(Some(subject("row-a")), &quiet(), &cfg, 15_000);
        assert_eq!(
            verdict,
            Tick::Tripped {
                key: "row-a".to_owned()
            },
            "trip only after grace AND the full window, both from confirmation"
        );
    }

    #[tokio::test]
    async fn a_draining_row_is_confirmed_only_when_its_correlated_job_runs() {
        let _gate = crate::resources::fence_test_gate();
        // W3-7 seam pin: the draining row is the subject either way, but
        // confirmation needs the row's recorded jobId in the live facts with the
        // stock status word `running`. No jobId: unconfirmed. Correlated to a
        // `running` job: confirmed. Correlated but `queued` (the stock gate wait):
        // still unconfirmed — a healthy queue posture, never a wedge candidate.
        let harness = Harness::new();
        harness
            .spool
            .append(&row("row-a", RowStatus::Draining))
            .expect("row");
        let subject = attributed_subject(
            &harness.watchdog.seams.control,
            &harness.spool,
            &WatchdogConfig::default(),
        )
        .await
        .expect("a draining row is a subject");
        assert_eq!(subject.key, "row-a");
        assert!(
            !subject.confirmed_running,
            "no jobId yet: parked on the gate or compiling, unconfirmed"
        );
        harness
            .spool
            .set_job_id("row-a", "job-run")
            .expect("job correlated");
        let subject = attributed_subject(
            &harness.watchdog.seams.control,
            &harness.spool,
            &WatchdogConfig::default(),
        )
        .await
        .expect("subject");
        assert!(
            subject.confirmed_running,
            "the correlated job answers running"
        );
        let queued_control: Arc<dyn WedgeControl> = Arc::new(ScriptControl {
            live: vec![("job-run".to_owned(), "queued".to_owned())],
            ..ScriptControl::default()
        });
        let subject =
            attributed_subject(&queued_control, &harness.spool, &WatchdogConfig::default())
                .await
                .expect("subject");
        assert!(
            !subject.confirmed_running,
            "correlated but queued is the healthy gate wait, never a wedge candidate"
        );
    }

    #[tokio::test]
    async fn the_arm_skips_restore_beside_a_live_queue_proof_failure() {
        let _gate = crate::resources::fence_test_gate();
        // W3-2 in the watchdog arm (the same law as the cycle end legs): an
        // idle-proof failure the backend ANSWERED through means a live stock
        // queue — free stays gated (unchanged) AND restore is skipped: the arm
        // answers restored:false + cardAtRisk:true with the cause word in the
        // detail, zero restore bats, zero health probes.
        let mut harness = Harness::new();
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("borrowed hold");
        harness.door = Arc::new(ScriptDoor::proof_failing(cycle::ProofFault::QueueLive));
        let answer = harness.run_async(true).await;
        assert_eq!(
            answer["freed"], false,
            "free stays gated on the proof: {answer}"
        );
        assert_eq!(
            answer["restored"], false,
            "W3-2: no restore bat beside a live queue"
        );
        assert_eq!(answer["cardAtRisk"], true, "{answer}");
        assert!(
            answer["detail"]
                .as_str()
                .expect("detail")
                .contains("queueLive"),
            "the cause word rides: {answer}"
        );
        let bats = harness.commands.runs.lock().expect("bat log");
        assert!(
            bats.is_empty(),
            "the restore bat NEVER spawns beside a live backend queue: {bats:?}"
        );
        assert_eq!(
            harness
                .health
                .probes
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "no health poll behind a skipped restore"
        );
    }

    #[tokio::test]
    async fn the_arm_keeps_the_crash_recovery_restore_on_a_backend_down_proof_failure() {
        let _gate = crate::resources::fence_test_gate();
        // W3-2's other class in the arm, behavior preserved: the backend itself is
        // gone, its queue hosts nothing live, and the operator's restore word runs
        // the bounded leg — that is how the engine comes back.
        let mut harness = Harness::new();
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("borrowed hold");
        harness.door = Arc::new(ScriptDoor::proof_failing(cycle::ProofFault::BackendDown));
        let answer = harness.run_async(true).await;
        assert_eq!(
            answer["freed"], false,
            "free skipped against a dead backend: {answer}"
        );
        assert_eq!(answer["restored"], true, "crash recovery ran");
        assert_eq!(answer["cardAtRisk"], false, "{answer}");
        let bats = harness.commands.runs.lock().expect("bat log");
        assert_eq!(bats.as_slice(), ["restore.bat /agent"]);
    }

    #[tokio::test]
    async fn an_arm_free_with_no_restore_word_behind_the_free_ends_restored_false() {
        let _gate = crate::resources::fence_test_gate();
        // W3-9 (LEG AF2-M21a): autoCycleVram:false and the free landed — the
        // model is off the card and NOTHING will bring it back. The arm answers
        // restored:false + cardAtRisk:true (the posture derives from DID-RESTORE,
        // never from the config word), and the journal's restore row carries it.
        // An ABSENT guard is this same legs-off posture honestly: no corrupt note.
        let harness = Harness::new();
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("borrowed hold");
        let answer = harness.run_async(false).await;
        assert_eq!(answer["freed"], true, "the free ran: {answer}");
        assert_eq!(
            answer["restored"], false,
            "nothing restored the card: {answer}"
        );
        assert_eq!(answer["cardAtRisk"], true, "{answer}");
        assert!(
            answer.get("detail").is_none(),
            "absent guard is not corrupt — nothing to name: {answer}"
        );
        let rows = harness.watchdog.journal().rows().expect("journal");
        let restore = rows
            .iter()
            .rev()
            .find(|entry| entry["event"] == "watchdog-restore")
            .expect("restore row journalled");
        assert_eq!(restore["detail"]["restored"], false);
        assert_eq!(restore["detail"]["cardAtRisk"], true);
    }

    #[tokio::test]
    async fn a_corrupt_guard_arm_that_freed_names_the_unreadable_guard() {
        let _gate = crate::resources::fence_test_gate();
        // W3-4 (LEG AF2-M21a): corrupt is NOT absent. The guard file EXISTS but
        // cannot be parsed — the tick latches the corrupt flag (the numbers stay
        // defaults: the plane never invents commands), and an arm that freed under
        // it answers restored:false + cardAtRisk:true with the named honesty
        // detail; the journal's restore row carries the same facts.
        let harness = Harness::new();
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("borrowed hold");
        std::fs::write(
            harness.dir.path().join(super::super::guard::FILE),
            b"{ not a guard !!",
        )
        .expect("corrupt guard staged");
        let answer = harness.run_async_fully(false, true, Vec::new()).await;
        assert_eq!(answer["freed"], true, "the free leg still ran: {answer}");
        assert_eq!(
            answer["restored"], false,
            "no restore bat exists under an unreadable guard"
        );
        assert_eq!(answer["cardAtRisk"], true);
        assert!(
            answer["detail"]
                .as_str()
                .expect("detail")
                .contains("guard unreadable - restore bat unavailable"),
            "{answer}"
        );
        let rows = harness.watchdog.journal().rows().expect("journal");
        let restore = rows
            .iter()
            .rev()
            .find(|entry| entry["event"] == "watchdog-restore")
            .expect("restore row");
        assert_eq!(restore["detail"]["restored"], false);
        assert_eq!(restore["detail"]["cardAtRisk"], true);
        assert!(
            restore["detail"]["detail"]
                .as_str()
                .expect("row detail")
                .contains("guard unreadable"),
            "{restore}"
        );
    }

    #[tokio::test]
    async fn the_arm_free_fault_settles_through_the_shared_home_and_gates_restore() {
        let _gate = crate::resources::fence_test_gate();
        // W3-5 + W3-17 (LEG AF2-M21a): the arm's single-attempt free now runs the
        // SAME fault-path settle home as the cycle free leg. The gate proof answers
        // (the free is legal to attempt), the free is never acked, and the settle's
        // re-probes stay unproven to the bound — down-hold per probe, bounded,
        // every probe an honest log line. W4-A (LEG AF2-M22) CHANGED the tail:
        // the unproven verdict gates the restore leg — the arm answers
        // restored:false + cardAtRisk:true with the honesty word, zero restore
        // bats, and the debt rides the journal + the persisted report.
        let mut harness = Harness::new();
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("borrowed hold");
        harness.door = Arc::new(ScriptDoor {
            free_fallback: false,
            proof_script: Mutex::new(
                [
                    Ok(()),
                    Err(cycle::IdleProofFault::new(
                        cycle::ProofFault::QueueLive,
                        "scripted: settle probe unproven",
                    )),
                    Err(cycle::IdleProofFault::new(
                        cycle::ProofFault::QueueLive,
                        "scripted: settle probe unproven",
                    )),
                    Err(cycle::IdleProofFault::new(
                        cycle::ProofFault::QueueLive,
                        "scripted: settle probe unproven",
                    )),
                    Err(cycle::IdleProofFault::new(
                        cycle::ProofFault::QueueLive,
                        "scripted: settle probe unproven",
                    )),
                ]
                .into_iter()
                .collect(),
            ),
            ..ScriptDoor::accepting()
        });
        let answer = harness.run_async(true).await;
        assert_eq!(
            answer["freed"], false,
            "the arm's single free attempt was not acked: {answer}"
        );
        let pauses = harness.pacer.pauses.lock().expect("pacer log");
        assert_eq!(
            pauses
                .iter()
                .filter(|millis| **millis == cycle::DOWN_HOLD_MS)
                .count(),
            cycle::FREE_FAULT_SETTLE_PROBE_BOUND as usize,
            "the shared settle holds once per re-probe, bounded: {pauses:?}"
        );
        assert_eq!(
            harness
                .door
                .proof_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            1 + cycle::FREE_FAULT_SETTLE_PROBE_BOUND,
            "gate proof plus every settle re-probe, never one more"
        );
        assert_eq!(
            answer["restored"], false,
            "W4-A: the settle never proved the queue idle, so no bat: {answer}"
        );
        assert_eq!(answer["cardAtRisk"], true, "{answer}");
        assert!(
            answer["detail"]
                .as_str()
                .expect("detail")
                .contains("settle never proved the queue idle"),
            "the honesty word rides the answer: {answer}"
        );
        let bats = harness.commands.runs.lock().expect("bat log");
        assert_eq!(
            bats.as_slice(),
            [] as [String; 0],
            "W4-A: the restore bat NEVER spawns beside an unproven queue: {bats:?}"
        );
        let rows = harness.watchdog.journal().rows().expect("journal");
        let restore = rows
            .iter()
            .rev()
            .find(|entry| entry["event"] == "watchdog-restore")
            .expect("restore row journalled");
        assert_eq!(restore["detail"]["restored"], false, "{restore}");
        assert_eq!(restore["detail"]["cardAtRisk"], true, "{restore}");
    }

    #[tokio::test]
    async fn an_unproven_settle_on_a_claimed_hold_persists_model_restored_false() {
        let _gate = crate::resources::fence_test_gate();
        // W4-A (LEG AF2-M22) verification the brief demands: the arm's CLAIMED-hold
        // report (the object GET /v1/cycle persists and /v1/resume reads) carries
        // modelRestored:false when the settle verdict is false — the arm cleared
        // the spool rows, so no auto driver returns and resume must answer the
        // owed restore from this report.
        let mut harness = Harness::new();
        harness.door = Arc::new(ScriptDoor {
            free_fallback: false,
            proof_script: Mutex::new(
                [
                    Ok(()),
                    Err(cycle::IdleProofFault::new(
                        cycle::ProofFault::QueueLive,
                        "scripted: settle probe unproven",
                    )),
                    Err(cycle::IdleProofFault::new(
                        cycle::ProofFault::QueueLive,
                        "scripted: settle probe unproven",
                    )),
                    Err(cycle::IdleProofFault::new(
                        cycle::ProofFault::QueueLive,
                        "scripted: settle probe unproven",
                    )),
                    Err(cycle::IdleProofFault::new(
                        cycle::ProofFault::QueueLive,
                        "scripted: settle probe unproven",
                    )),
                ]
                .into_iter()
                .collect(),
            ),
            ..ScriptDoor::accepting()
        });
        // Unclaimed cell: the arm takes its own fence — the Claimed-hold shape.
        let answer = harness.run_async(true).await;
        assert_eq!(answer["restored"], false, "{answer}");
        let live = harness.cell.live();
        assert_eq!(live.phase, CyclePhase::Idle, "the arm closed its own cycle");
        let report = live.report.expect("terminal persisted");
        assert_eq!(
            report["modelRestored"], false,
            "the persisted report carries the debt: {report}"
        );
        assert_eq!(report["cardAtRisk"], true, "{report}");
        let bats = harness.commands.runs.lock().expect("bat log");
        assert_eq!(
            bats.as_slice(),
            [] as [String; 0],
            "no restore bat in the claimed posture either: {bats:?}"
        );
    }

    #[test]
    fn consuming_the_trip_leaves_no_second_arm_for_a_later_taker() {
        let _gate = crate::resources::fence_test_gate();
        // W3-10 (LEG AF2-M21a): the arm belongs to whoever TAKES the trip, at the
        // instant of the take. The old peek-then-clear-after-the-answer sequence
        // left a window where the manual door saw tripOpen and re-ran the whole
        // arm — a second pair of bats for one wedge. The take is one lock, one
        // verdict: first taker gets it, everyone else sees the closed posture
        // (jobUnknown at the door when no jobId is carried).
        let harness = Harness::new();
        {
            let mut state = harness.watchdog.lock();
            state.trip = Some(Trip {
                subject: subject("row-a"),
                at_ms: now_ms(),
            });
        }
        let taken = harness
            .watchdog
            .take_trip()
            .expect("the first taker gets the trip");
        assert_eq!(taken.subject.row_id.as_deref(), Some("row-a"));
        assert!(
            harness.watchdog.take_trip().is_none(),
            "a second taker sees the closed window, mid-arm or after"
        );
        assert!(
            harness.watchdog.trip().is_none(),
            "no open trip survives the take"
        );
    }

    #[test]
    fn a_refused_explicit_door_puts_the_trip_back_and_never_clobbers_a_new_one() {
        let _gate = crate::resources::fence_test_gate();
        // W4-D (LEG AF2-M22): the explicit-jobId branch consumes atomically to
        // close the double-arm race, but a refusal owes the window back: the
        // restore fills ONLY an absent slot — a trip another taker opened in the
        // meantime is never clobbered.
        let harness = Harness::new();
        let trip = Trip {
            subject: subject("row-a"),
            at_ms: now_ms(),
        };
        harness.watchdog.restore_trip_if_absent(trip.clone());
        assert_eq!(
            harness
                .watchdog
                .trip()
                .expect("the refused window is back")
                .subject
                .row_id
                .as_deref(),
            Some("row-a"),
            "the operator's empty body finds the window it was promised"
        );
        // A newer window stands: the restore never overwrites it.
        let newer = Trip {
            subject: subject("row-b"),
            at_ms: now_ms(),
        };
        harness.watchdog.restore_trip_if_absent(newer);
        assert_eq!(
            harness
                .watchdog
                .trip()
                .expect("still open")
                .subject
                .row_id
                .as_deref(),
            Some("row-a"),
            "an absent slot is the only slot the restore fills"
        );
    }

    #[tokio::test]
    async fn a_pre_arm_journal_failure_rides_the_answer_through_the_one_home() {
        let _gate = crate::resources::fence_test_gate();
        // W3-15 (LEG AF2-M21a): the tick's trip-row write failure used to vanish
        // behind a `let _ =`; it now SEEDS the arm's journalError surfacing home,
        // so the trip answer (and the latch/report it becomes) carries it —
        // health already reveals the corruption, now the answer does too.
        let harness = Harness::new();
        harness
            .cell
            .claim(CyclePhase::Draining)
            .expect("borrowed hold");
        let answer = harness
            .run_async_fully(true, false, vec!["trip row: parse boom".to_owned()])
            .await;
        let problem = answer["journalError"]
            .as_str()
            .expect("the pre-arm failure rides out verbatim: {answer}");
        assert!(problem.contains("trip row: parse boom"), "{problem}");
    }
}
