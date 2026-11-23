//! The DURABLE SPOOL (API-DESIGN §5, ruling E1): the file-backed job queue that is the
//! batch drain's single source of truth.
//!
//! `deas-agent-queue.json` lives in app-data and is rewritten atomically on every
//! mutation — staging file then rename over the target, the same discipline as
//! [`super::defaults::write`]. Rows survive a DEAS restart (the file *is* the state: no
//! in-memory cache to go stale, no panel-edit surprise). A corrupt file is never
//! repaired behind the operator's back: reads fail closed naming the path, and nothing
//! rewrites the bytes; the plane rides `maintenanceActive` until the operator fixes it.
//! An absent or empty file is a healthy empty queue.
//!
//! The enqueue law is P7: the door ran [`fill_plane::fill`] and
//! [`IntentPlan::complete_or_refuse`](super::fill_plane::IntentPlan::complete_or_refuse)
//! before a row is ever built, so every `queued` row is drain-ready by construction.
//! The row stores the versioned fill-plane envelope, the four resolver slot values and
//! the validated passthrough extras — together enough for [`flat_intent`] to rebuild
//! the exact compile-ready intent from the row alone (pinned byte-equal by the
//! round-trip test). M4 reads and drains through this same handle; it never re-parses
//! the file by hand.
//!
//! Locking choice, stated for the record: every mutation runs under one process-level
//! [`std::sync::Mutex`] inside the `Arc`'d handle (chosen over a per-call OS file lock).
//! The plane is single-process, every critical section is pure synchronous file IO, and
//! no guard is ever held across an `await` — an OS-level lock would add a failure mode
//! without adding safety. A poisoned gate recovers its guard: every mutation path
//! returns `Err` instead of panicking, so poisoning can only originate outside this
//! module, and the file stays the authority either way.

// The drain leg (M4) is the consumer of the row reconstruction (`flat_intent`,
// `envelope_field`) and of the CAS primitive (`set_status`); the allow stays as
// documented insurance for vocabulary fields not yet read on every target. The lint
// is silenced deliberately and documented rather than leaking as an accidental
// warning: nothing below is unreachable by design (same precedent as `fill_plane`'s
// module-level allow).
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::fill_plane::{self, IntentPlan, Slots};

/// The spool file, beside the settings/defaults/guard files in app-data.
pub(crate) const FILE: &str = "deas-agent-queue.json";
/// The spool file schema version; only this one is understood.
///
/// Version discipline, ruled when the row grew `jobId` (the M9a correlation spine):
/// a field that a pre-existing file can never carry and every reader can default
/// (`#[serde(default)]`) is a LOAD-compatible growth, not a new schema — bumping the
/// number here would refuse the operator's existing version-1 file outright, which is
/// the opposite of what a compatible growth owes them. A bump is for a change an old
/// file cannot be read under: a renamed field, a retyped value, a closed word that
/// moves. This one is not.
pub(crate) const QUEUE_VERSION: u32 = 1;

/// The ceiling on LIVE rows the spool accepts (LEG M12, red-team W5,
/// owner-approved): a queue is bounded on purpose — an unbounded spool is an
/// unbounded batch the plane cannot reason about, and the file is rewritten whole
/// on every mutation. Only `queued` and `draining` rows count; terminal rows
/// (`done`, `failed`, `cancelled`, `wedged`) are history and ride past the cap in
/// the file. The refusal is the closed taxonomy word `spoolFull` (409), mapped by
/// the one route that appends; the queue and clear doors themselves are untouched
/// — the remedy is to take rows OUT (`POST /v1/generate` or `POST /v1/queue/clear`).
pub(crate) const CAP: usize = 512;

/// The append verdict, typed so the cap refusal has ONE home the route can map —
/// string-matching a free-form error to pick a taxonomy word would be a second,
/// weaker authority over the wire.
#[derive(Clone, Debug)]
pub(crate) enum AppendError {
    /// The spool already holds `live` live rows at [`CAP`]; the row was refused and
    /// the file keeps its bytes.
    Full {
        /// The live-row count that blocks the append.
        live: usize,
    },
    /// A corrupt file or a write failure, named verbatim as [`Spool::snapshot`]
    /// names it.
    Problem(String),
}

impl std::fmt::Display for AppendError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Full { live } => write!(
                formatter,
                "the spool holds {live} live rows at the cap {}; the append was refused",
                CAP
            ),
            Self::Problem(problem) => write!(formatter, "{problem}"),
        }
    }
}

impl std::error::Error for AppendError {}

/// AF2-M32 (story chaining): the sentinel an unresolved story row carries in
/// `h3.continuity.sourceId`. The word is OUTSIDE the stock id alphabet ON PURPOSE
/// (`jobs_video::continuity_id` has no `@`, and `validate_continuity` refuses it at
/// stock prepare): if the drain's resolution leg (cycle.rs) ever failed to run, the
/// row dies at compile with the stock sentence before any render starts — defense
/// in depth, never a silent `@story` submit. ONE home: the mint (routes.rs's story
/// door), the drain (cycle.rs's substitution) and the tests all read this const.
pub(crate) const STORY_SOURCE_PLACEHOLDER: &str = "@story";

/// AF2-M32: the ceiling on steps one story may chain. The door refuses a longer
/// list BY COUNT; the spool helper re-pays it as envelope-shape defense. The
/// number is the mission's law (16 segments maximum per queued story).
pub(crate) const STORY_MAX_STEPS: usize = 16;

/// AF2-M32: the per-row story-chain link written by the story door and read by
/// the drain's resolution leg. A DEFAULTED field like `job_id`: a pre-story
/// version-1 file loads honestly with `None`, no schema bump.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoryLink {
    /// One uuid v4 the story door mints; every row of one story carries it.
    pub(crate) story_id: String,
    /// The continuity session the chain renders into (validated at the door).
    pub(crate) session: String,
    /// Zero-based position in the chain; the drain's substitution reads it.
    pub(crate) step_index: usize,
    /// The 64-hex prepared `sourceId` the story opens from (POST
    /// /v1/videos/prepare). It rides EVERY row — not just step 0, which already
    /// carries it in its own continuity — so a story whose drain spans more than
    /// one cycle can still identify its import clip in the session read: the
    /// prepared id is the only story fact a mid-chain row can reach after a
    /// restart, and the clip-identification law names it.
    pub(crate) prepared_source: String,
}

/// Row lifecycle states. This leg only ever writes `Queued`; `Draining`, `Done`,
/// `Failed` and `Cancelled` are the M4 drain's payload vocabulary, typed here once so
/// the file schema stays closed across legs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RowStatus {
    /// Spooled and drain-ready; waiting for the M4 drain.
    Queued,
    /// The drain owns this row right now (M4 only).
    Draining,
    /// Compiled, submitted and finished (M4 only).
    Done,
    /// Failed at drain with the stock error excerpt in the batch report (M4 only).
    Failed,
    /// Ended by cancel or watchdog before completion (M4 only).
    Cancelled,
    /// The watchdog sever latched onto this row while it was in flight (M5, §8.2):
    /// the row the card went quiet on. Durable like every other status, so a restart
    /// still names which row the wedge took.
    Wedged,
}

impl RowStatus {
    /// The wire word for this status. Pinned against the serde vocabulary by test so
    /// the two homes can never disagree.
    pub(crate) fn word(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Draining => "draining",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Wedged => "wedged",
        }
    }
}

/// One spooled job: everything the drain needs, and nothing else.
///
/// `envelope` is the fill-plane versioned record ([`IntentPlan::envelope`]) as JSON;
/// `slots` and `extras` carry the values the envelope only names, so the flat intent
/// reconstructs from this row alone. Unknown fields are refused at parse time — the
/// schema stays closed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QueueRow {
    /// Row identity: a uuid v4 drawn at enqueue.
    pub(crate) id: String,
    /// Creation time, epoch milliseconds.
    pub(crate) created_at: u64,
    /// Lifecycle state; `queued` on arrival.
    pub(crate) status: RowStatus,
    /// The fill-plane envelope record (API-DESIGN §5's versioned intent record).
    pub(crate) envelope: Value,
    /// The four resolver slot values as the door received them.
    pub(crate) slots: Slots,
    /// The validated request-side passthrough keys and values (the envelope records
    /// their names only; the values ride here so reconstruction is complete).
    #[serde(default)]
    pub(crate) extras: Map<String, Value>,
    /// The stock job id this row was submitted as — the correlation link of the M9a
    /// spine (`row id -> stock jobId -> HistoryRecord.id -> outputs/cancel`). The
    /// drain writes it the instant the stock submit mints it (cycle.rs, before the
    /// poll loop starts), so a wedged render, a dropped socket or a restart still
    /// leaves the row traceable through the §4 result doors. `None` for a row that
    /// never reached submit, and for every row written before this field shipped
    /// (`#[serde(default)]`: an old file loads, honestly uncorrelated).
    #[serde(default)]
    pub(crate) job_id: Option<String>,
    /// The AF2-M32 story-chain link (`#[serde(default)]`, the `job_id` growth
    /// discipline: load-compatible, no version bump). `Some` on every row the
    /// story door mints; `None` on every other row, forever.
    #[serde(default)]
    pub(crate) story_link: Option<StoryLink>,
}

impl QueueRow {
    /// Builds a queued row from a door-verified plan.
    ///
    /// Callers must hold the [`IntentPlan`] from a `complete_or_refuse` that returned
    /// `Ok` — this function does not re-verify drain-readiness, the door does.
    ///
    /// # Errors
    ///
    /// Reports the envelope serialization failure; in practice the envelope schema is
    /// all-serialize, so this is defensive.
    pub(crate) fn from_plan(plan: &IntentPlan) -> Result<Self, String> {
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now_ms(),
            status: RowStatus::Queued,
            envelope: serde_json::to_value(plan.envelope())
                .map_err(|error| format!("serialize envelope: {error}"))?,
            slots: plan.slots().clone(),
            extras: plan.extras().clone(),
            // No stock job exists until the drain submits this row; the drain records
            // it with [`Spool::set_job_id`] the moment one does. And no story link
            // exists unless the story door stamps one after the plan build (AF2-M32).
            job_id: None,
            story_link: None,
        })
    }
}

/// The on-disk shape: a versioned envelope around the rows.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueFile {
    version: u32,
    rows: Vec<QueueRow>,
}

/// The outcome of a delete request, mapped to the closed taxonomy by the route.
pub(crate) enum DeleteOutcome {
    /// The row was queued and is now gone.
    Deleted,
    /// No row carries that id.
    UnknownId,
    /// The row exists but is not queued; the payload names its status.
    NotQueued(RowStatus),
}

/// The durable spool handle: app-data location plus the one mutation gate. Cheap to
/// `Arc`; the plane shares one instance through [`super::PlaneState`].
#[derive(Debug)]
pub(crate) struct Spool {
    app_data: PathBuf,
    gate: Mutex<()>,
}

impl Spool {
    /// Points a spool at an app-data directory. Touches nothing; an absent file is the
    /// empty queue, created on the first append.
    pub(crate) fn new(app_data: &Path) -> Self {
        Self {
            app_data: app_data.to_path_buf(),
            gate: Mutex::new(()),
        }
    }

    /// The rows as the file holds them, read under the gate.
    ///
    /// # Errors
    ///
    /// Reports an unreadable, unparseable or wrong-version file naming the path. The
    /// file bytes are never touched by a failed read.
    pub(crate) fn snapshot(&self) -> Result<Vec<QueueRow>, String> {
        let _gate = self.lock_gate();
        self.read_rows()
    }

    /// Appends one row: read, extend, atomic rewrite, all under the gate.
    ///
    /// # Errors
    ///
    /// Reports [`AppendError::Full`] when the spool already holds [`CAP`] live
    /// (queued + draining) rows — the file keeps its bytes — or
    /// [`AppendError::Problem`] for the [`Self::snapshot`] failure (a corrupt file
    /// refuses the append rather than repairing it) or the write failure; on
    /// either, the target keeps its bytes.
    pub(crate) fn append(&self, row: &QueueRow) -> Result<(), AppendError> {
        let _gate = self.lock_gate();
        let mut rows = self.read_rows().map_err(AppendError::Problem)?;
        let live = rows
            .iter()
            .filter(|row| matches!(row.status, RowStatus::Queued | RowStatus::Draining))
            .count();
        if live >= CAP {
            return Err(AppendError::Full { live });
        }
        rows.push(row.clone());
        self.write_rows(&rows).map_err(AppendError::Problem)
    }

    /// The input bench door's serialized window (W3-13, LEG AF2-M21b): the live rows
    /// are read AND `run` — the claim check plus the renames — executes under the SAME
    /// write gate every mutation (`append`, `delete_queued`, `set_status`) takes. The
    /// inverse TOCTOU dies here: a queue body that passed the existence law can never
    /// land between the bench's claim check and the rename that moves its file, and an
    /// append blocked for the window's lifetime (at most 100 same-root renames, all
    /// synchronous) is the honest serialization the race needs. One home, one gate:
    /// the design deliberately adds NO second mutex — a `bench_gate` the append also
    /// took would be a second lock order over the same fact. `run` must not call back
    /// into this spool (the gate is not reentrant); the bench door's fs renames never
    /// do.
    pub(crate) fn with_bench_window<T>(
        &self,
        run: impl FnOnce(&[QueueRow]) -> T,
    ) -> Result<T, String> {
        let _gate = self.lock_gate();
        let rows = self.read_rows()?;
        Ok(run(&rows))
    }

    /// Removes a queued row by id; draining and terminal rows are the drain's, not
    /// this door's, so they come back untouched with their status named.
    ///
    /// # Errors
    ///
    /// Reports a corrupt file or a write failure, as [`Self::append`].
    pub(crate) fn delete_queued(&self, id: &str) -> Result<DeleteOutcome, String> {
        let _gate = self.lock_gate();
        let mut rows = self.read_rows()?;
        let Some(position) = rows.iter().position(|row| row.id == id) else {
            return Ok(DeleteOutcome::UnknownId);
        };
        if rows[position].status != RowStatus::Queued {
            return Ok(DeleteOutcome::NotQueued(rows[position].status));
        }
        rows.remove(position);
        self.write_rows(&rows)?;
        Ok(DeleteOutcome::Deleted)
    }

    /// Compare-and-set one row's status: applies `expect_from -> to` atomically over
    /// the same staging + rename write as [`Self::append`]. The answer is whether the
    /// CAS applied: `false` means the row is gone or no longer carries `expect_from`
    /// (a concurrent delete, or a drain race) — the durable file keeps its bytes then.
    /// The M4 cycle machine is the only caller; every transition it makes is CAS-guarded
    /// so two drivers can never both own one row.
    ///
    /// # Errors
    ///
    /// Reports a corrupt file or a write failure, as [`Self::append`].
    pub(crate) fn set_status(
        &self,
        id: &str,
        expect_from: RowStatus,
        to: RowStatus,
    ) -> Result<bool, String> {
        let _gate = self.lock_gate();
        let mut rows = self.read_rows()?;
        let Some(position) = rows.iter().position(|row| row.id == id) else {
            return Ok(false);
        };
        if rows[position].status != expect_from {
            return Ok(false);
        }
        rows[position].status = to;
        self.write_rows(&rows)?;
        Ok(true)
    }

    /// Records the stock job id on the row the drain currently owns — the correlation
    /// write of the M9a spine. CAS-shaped like [`Self::set_status`], over the same
    /// staging + rename write, and it lands only on a `draining` row exactly once:
    ///
    /// * `Ok(true)` — the id was written, or already stood there: re-recording the
    ///   same id is idempotent and rewrites nothing.
    /// * `Ok(false)` — no row carries that id (it left the spool; there is nothing to
    ///   correlate, and that is the drain's honest skip, not a fault).
    /// * `Err` — the row exists but is not `draining`, or already carries a
    ///   *different* id. One row drives at most one stock job: a second submit is a
    ///   bug worth naming out loud, never a silent overwrite of the link the §4
    ///   result doors depend on.
    ///
    /// # Errors
    ///
    /// Reports the illegal-target refusals above, a corrupt file, or a write failure
    /// (as [`Self::append`]).
    pub(crate) fn set_job_id(&self, id: &str, job_id: &str) -> Result<bool, String> {
        let _gate = self.lock_gate();
        let mut rows = self.read_rows()?;
        let Some(position) = rows.iter().position(|row| row.id == id) else {
            return Ok(false);
        };
        if rows[position].status != RowStatus::Draining {
            return Err(format!(
                "row {id} carries status '{}'; a jobId lands only on the row the drain owns (draining)",
                rows[position].status.word()
            ));
        }
        if let Some(existing) = &rows[position].job_id {
            if existing == job_id {
                return Ok(true);
            }
            return Err(format!(
                "row {id} already carries jobId {existing}; one row drives one stock job, so {job_id} is refused"
            ));
        }
        rows[position].job_id = Some(job_id.to_owned());
        self.write_rows(&rows)?;
        Ok(true)
    }

    /// E28 (LEG AF2-M24b, owner law "REFMOD = DRAINABLE ROW for consistency"):
    /// enqueue a drainable RefMod export row — a queue row whose submission is
    /// the stock refmod export instead of a Workbench render. LEG AF2-M24c
    /// landed the queue-door grammar (mode `refmod` now carries the
    /// `RefmodExport` target), and this helper stayed the ONLY constructor of
    /// such a row — the door's export map (fill_plane's `fill_refmod`) is
    /// minted through here, never through the render plan path. The row rides
    /// the ordinary spool lifecycle (`Queued` -> `Draining`
    /// -> terminal) under the same [`CAP`], CAS and boot-sweep law as a render
    /// row. The envelope records the recipe word (the drain's arm selector,
    /// never a request key) plus the closed export fields in the same
    /// `{field,value}` shape the render envelope carries, so one
    /// [`envelope_field`] lookup covers both arms.
    ///
    /// Validation here is the envelope SHAPE only: the closed key set, the two
    /// arrays present, at least one of them non-empty. Every stock compile law
    /// (name grammar, model names, the media contract, the at-least-one-
    /// reference wall) stays stock-side in `jobs_refmod::compile`, enforced at
    /// submit — this helper never restates it.
    ///
    /// # Errors
    ///
    /// Names a shape refusal, or carries [`Self::append`]'s failure (the
    /// [`AppendError::Full`] cap refusal included) as its display text.
    pub(crate) fn append_refmod_row(&self, export: &Value) -> Result<QueueRow, String> {
        let fields = export
            .as_object()
            .ok_or("a RefMod export row needs a JSON object of export fields")?;
        for key in fields.keys() {
            if !fill_plane::REFMOD_EXPORT_KEYS.contains(&key.as_str()) {
                return Err(format!(
                    "unknown RefMod export field '{key}'; the closed set is {}",
                    fill_plane::REFMOD_EXPORT_KEYS.join(", ")
                ));
            }
        }
        for key in ["media", "refmods"] {
            if !matches!(fields.get(key), Some(Value::Array(_))) {
                return Err(format!("a RefMod export row needs a '{key}' array"));
            }
        }
        if ["media", "refmods"].iter().all(|key| {
            fields
                .get(*key)
                .is_some_and(|value| value.as_array().is_some_and(Vec::is_empty))
        }) {
            return Err(
                "a RefMod export row needs at least one reference or saved RefMod".to_owned(),
            );
        }
        let field_rows: Vec<Value> = fill_plane::REFMOD_EXPORT_KEYS
            .iter()
            .filter_map(|key| {
                fields
                    .get(*key)
                    .map(|value| json!({ "field": key, "value": value.clone() }))
            })
            .collect();
        let row = QueueRow {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now_ms(),
            status: RowStatus::Queued,
            envelope: json!({
                "apiVersion": fill_plane::ENVELOPE_VERSION,
                "recipe": { "recipeId": fill_plane::REFMOD_RECIPE_ID, "version": 1 },
                "mode": "refmod",
                "fields": field_rows,
            }),
            slots: Slots::default(),
            extras: Map::new(),
            job_id: None,
            story_link: None,
        };
        self.append(&row).map_err(|problem| problem.to_string())?;
        Ok(row)
    }

    /// AF2-M31 (LEG, H3-continuity closure): the ONE constructor of a drainable
    /// H3 join row - a queued row whose submission is the model-free stock
    /// `jobs_video::join` compile (recipeId `h3-join`, the stock `is_join` word)
    /// dispatched through the ORDINARY render arm (prepare -> submit -> poll:
    /// `Jobs::prepare_with_models` compiles through `jobs::compile`, whose join
    /// branch the UI's own Join clips button rides; `requirements()` is empty and
    /// the DaSiWa assembly nodes ride the `H3_CONTINUITY_NODES` evidence the
    /// prepare's node census already reads). The row rides the ordinary spool
    /// lifecycle (`Queued` -> `Draining` -> terminal) under the same [`CAP`], CAS
    /// and boot-sweep law as a render row.
    ///
    /// Validation here is the envelope SHAPE only: the closed three-key intent
    /// (`recipeId`/`version`/`h3`, the stock UI intent shape `H3JoinIntentV1`
    /// pinned in `src/lib/videoIntent.ts`), the stock recipe word, the version
    /// `1`, the `h3` block carrying ONLY `join`. Every stock join law (session /
    /// chain grammar, file names, trims, the 64 KiB budget) stays stock-side in
    /// `jobs_video::validate_join` - the door runs it before calling this helper,
    /// the drain re-pays it inside `compile` - this helper never restates it.
    ///
    /// # Errors
    ///
    /// Names a shape refusal, or carries [`Self::append`]'s failure (the
    /// [`AppendError::Full`] cap refusal included) as its display text.
    pub(crate) fn append_join_row(&self, intent: &Value) -> Result<QueueRow, String> {
        let fields = intent
            .as_object()
            .ok_or("an H3 join row needs a JSON object of intent keys")?;
        let allowed = ["recipeId", "version", "h3"];
        for key in fields.keys() {
            if !allowed.contains(&key.as_str()) {
                return Err(format!(
                    "unknown H3 join intent key '{key}'; the closed set is {}",
                    allowed.join(", ")
                ));
            }
        }
        if !crate::jobs_video::is_join(intent) {
            return Err("an H3 join row carries recipeId 'h3-join' (the stock join word)".into());
        }
        if fields["version"].as_f64() != Some(1.0) {
            return Err("an H3 join row carries version 1".into());
        }
        let h3 = fields["h3"]
            .as_object()
            .filter(|h| h.len() == 1 && h.contains_key("join"))
            .ok_or("an H3 join row's h3 block carries only the join block")?;
        let field_rows: Vec<Value> = [("h3", Value::Object(h3.clone()))]
            .into_iter()
            .map(|(key, value)| json!({ "field": key, "value": value }))
            .collect();
        let row = QueueRow {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now_ms(),
            status: RowStatus::Queued,
            envelope: json!({
                "apiVersion": fill_plane::ENVELOPE_VERSION,
                "recipe": { "recipeId": "h3-join", "version": 1 },
                "fields": field_rows,
            }),
            slots: Slots::default(),
            extras: Map::new(),
            job_id: None,
            story_link: None,
        };
        self.append(&row).map_err(|problem| problem.to_string())?;
        Ok(row)
    }

    /// AF2-M32 (story chaining): the ONE constructor of a story batch — N rows
    /// land in ONE gated read + extend + rewrite, so a story is minted atomically
    /// or not at all. Appending the steps one-by-one through [`Self::append`]
    /// would let the [`CAP`] refusal strand a PARTIAL story in the spool (steps
    /// 0..k queued, step k refused, chain broken with no honest head to name);
    /// the cap law here counts the whole batch: `live + rows.len() <= CAP` or
    /// nothing writes.
    ///
    /// Validation here is the batch SHAPE only: 1..=[`STORY_MAX_STEPS`] rows, each
    /// carrying a [`StoryLink`], all links sharing one `storyId`, `stepIndex`
    /// exactly equal to the row's position (0-based, chain order is the file
    /// order the drain reads). Every row grammar law (the closed step object, the
    /// continuity block, the stock REF2VA walls) was paid at the story door
    /// through the ORDINARY acceptance path — the rows are indistinguishable
    /// from ordinary accepted rows except for `story_link` and the
    /// [`STORY_SOURCE_PLACEHOLDER`] riding in a step row's continuity — and the
    /// stock continuity law runs again at drain resolution (cycle.rs) and at
    /// compile. This helper never restates any of it.
    ///
    /// # Errors
    ///
    /// Reports [`AppendError::Full`] when the live rows plus the whole batch
    /// exceed [`CAP`] (the file keeps its bytes), [`AppendError::Problem`] for a
    /// shape refusal or the [`Self::append`]-class file problems.
    pub(crate) fn append_story_rows(&self, rows: &[QueueRow]) -> Result<(), AppendError> {
        if rows.is_empty() || rows.len() > STORY_MAX_STEPS {
            return Err(AppendError::Problem(format!(
                "a story batch holds 1..={STORY_MAX_STEPS} rows; {} is refused",
                rows.len()
            )));
        }
        let first = rows[0].story_link.as_ref().ok_or_else(|| {
            AppendError::Problem(
                "a story batch row carries no storyLink; the story door stamps one".to_owned(),
            )
        })?;
        for (position, row) in rows.iter().enumerate() {
            let link = row
                .story_link
                .as_ref()
                .expect("the loop starts at row 0, checked above");
            if link.story_id != first.story_id || link.session != first.session {
                return Err(AppendError::Problem(format!(
                    "story batch row {position} carries a different storyId/session than row 0; one batch is one story"
                )));
            }
            // Chain order is CONTIGUOUS ASCENT, not zero-anchoring: a story
            // may resume mid-chain (its ledger derives the parent chain from
            // the stock session view, not from this batch), so a batch's steps
            // must run first, first+1, first+2... The story door always mints
            // from 0; a drained continuation may start anywhere.
            if link.step_index != first.step_index + position {
                return Err(AppendError::Problem(format!(
                    "story batch row {position} carries stepIndex {}; the batch must ascend contiguously in chain order from stepIndex {}",
                    link.step_index, first.step_index
                )));
            }
        }
        let _gate = self.lock_gate();
        let mut stored = self.read_rows().map_err(AppendError::Problem)?;
        let live = stored
            .iter()
            .filter(|row| matches!(row.status, RowStatus::Queued | RowStatus::Draining))
            .count();
        if live + rows.len() > CAP {
            return Err(AppendError::Full { live });
        }
        stored.extend(rows.iter().cloned());
        self.write_rows(&stored).map_err(AppendError::Problem)
    }

    /// Flips every still-`Queued` row to `Cancelled` in one gated rewrite (the
    /// §5 `POST /v1/queue/clear` door). Draining, done, failed and wedged rows are
    /// the drain's — never touched. The answer is how many rows flipped; an empty
    /// spool or an all-terminal spool answers `0` and rewrites nothing. Legal in
    /// any cycle phase: a row outside a claimed batch is not in flight (§5).
    ///
    /// # Errors
    ///
    /// Reports a corrupt file or a write failure, as [`Self::append`].
    pub(crate) fn clear_queued(&self) -> Result<usize, String> {
        let _gate = self.lock_gate();
        let mut rows = self.read_rows()?;
        let mut cleared = 0;
        for row in &mut rows {
            if row.status == RowStatus::Queued {
                row.status = RowStatus::Cancelled;
                cleared += 1;
            }
        }
        if cleared == 0 {
            return Ok(0);
        }
        self.write_rows(&rows)?;
        Ok(cleared)
    }

    /// The boot sweep for rows a previous process left mid-render (LEG AF2-M18a, C2).
    /// A `draining` row means some driver owned it, and no driver survives a restart, so
    /// the row is an orphan forever unless someone says so: it counts toward [`CAP`], the
    /// next cycle's snapshot takes `queued` rows only so nothing ever drives it terminal,
    /// and the watchdog's attribution would judge it on a grace clock that belongs to a
    /// dead process. The sweep names it what it is — `RowStatus::Failed` — and returns the
    /// ids so the caller can log the honest words. No new status word and no new taxonomy
    /// word is coined for the occasion; the row schema carries no detail field, so the
    /// words ride the log line.
    ///
    /// Every other status stands: `queued` rows wait for the next batch, `wedged` rows
    /// already name their wedge, and terminal rows are history.
    ///
    /// # Errors
    ///
    /// Reports a corrupt file or a write failure, as [`Self::append`]. An absent spool
    /// answers empty and writes no file.
    pub(crate) fn recover_draining_orphans(&self) -> Result<Vec<String>, String> {
        let _gate = self.lock_gate();
        let mut rows = self.read_rows()?;
        let mut orphans: Vec<String> = Vec::new();
        for row in &mut rows {
            if row.status == RowStatus::Draining {
                row.status = RowStatus::Failed;
                orphans.push(row.id.clone());
            }
        }
        if orphans.is_empty() {
            return Ok(orphans);
        }
        self.write_rows(&rows)?;
        Ok(orphans)
    }

    /// The spool file path.
    fn path(&self) -> PathBuf {
        self.app_data.join(FILE)
    }

    /// Takes the mutation gate, recovering a poisoned guard (see the module doc for
    /// why that is safe); no guard is ever held across an `await`.
    fn lock_gate(&self) -> MutexGuard<'_, ()> {
        self.gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reads and validates the rows. Caller holds the gate.
    fn read_rows(&self) -> Result<Vec<QueueRow>, String> {
        let path = self.path();
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("read {}: {error}", path.display())),
        };
        let file: QueueFile = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parse {}: {error}", path.display()))?;
        if file.version != QUEUE_VERSION {
            return Err(format!(
                "validate {}: version {} is not supported (expected {QUEUE_VERSION})",
                path.display(),
                file.version
            ));
        }
        Ok(file.rows)
    }

    /// Rewrites the whole file atomically: staging file in app-data, then rename over
    /// the target. Caller holds the gate. Mirrors [`super::defaults::write`] exactly.
    fn write_rows(&self, rows: &[QueueRow]) -> Result<(), String> {
        let path = self.path();
        let staging = path.with_file_name(format!("{FILE}.{}.tmp", std::process::id()));
        let file = QueueFile {
            version: QUEUE_VERSION,
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

/// Rebuilds the compile-ready flat intent from the stored row alone.
///
/// This is a deliberate mirror of [`IntentPlan::complete_or_refuse`]
/// (super::fill_plane.rs `intent_values`) over stored parts instead of the live plan:
/// the 13 required fields from envelope + slots, the ladder-supplied optional keys from
/// the envelope fields, the stored extras, and the `family` key the fill plane owns.
/// The row round-trip test pins the two byte-equal, so the mirror cannot silently
/// drift from the door.
///
/// # Errors
///
/// Names the still-open keys when a row is not drain-ready — unreachable for rows the
/// door built (P7 refuses an incomplete intent at enqueue), defensive for hand-edited
/// files, where honesty beats emitting a half intent to the drain.
pub(crate) fn flat_intent(row: &QueueRow) -> Result<Value, String> {
    let envelope = &row.envelope;
    let recipe_id = envelope
        .pointer("/recipe/recipeId")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("row {}: envelope carries no recipeId", row.id))?;
    // E28 (LEG AF2-M24b): the RefMod export row arms off BEFORE the render
    // ladder — its flat intent is the closed `jobs_refmod::compile` request
    // map, not a render intent. The required-fields ladder, the slots and the
    // extras merge all belong to the render arms; the export arm rebuilds only
    // the closed keys and strips every plane-only envelope word (recipeId,
    // family, seed, version): stock compile refuses unknown request keys, so
    // what the drain hands the bridge carries the closed seven and nothing
    // else. The round-trip test pins the map byte-equal.
    if recipe_id == fill_plane::REFMOD_RECIPE_ID {
        return refmod_request(row);
    }
    // AF2-M31 (H3-continuity closure): the join row arms off the render ladder
    // too - its flat intent is the CLOSED stock join intent, the exact map
    // `jobs_video::compile`'s `is_join` branch compiles (recipeId, version, the
    // single `h3.join` block; camel-case wire, per the pinned UI intent home
    // `H3JoinIntentV1` in `src/lib/videoIntent.ts`). The join block rides the
    // envelope VERBATIM from the door's validated intent; there are no slots, no
    // ladder fields, no extras and no plane-only words to strip (the recipeId
    // and version here ARE stock request keys, unlike the refmod arm's).
    // Byte-equal reconstruction is pinned by the door round-trip test.
    if recipe_id == "h3-join" {
        return join_request(row);
    }
    let recipe_version = envelope
        .pointer("/recipe/version")
        .cloned()
        .unwrap_or(Value::Null);
    let family = envelope
        .pointer("/family")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("row {}: envelope carries no family", row.id))?;
    let seed = envelope
        .pointer("/seed/value")
        .cloned()
        .filter(|value| !value.is_null())
        .ok_or_else(|| format!("row {}: envelope carries no seed value", row.id))?;

    let mut values = Map::new();
    let mut missing: Vec<&str> = Vec::new();
    // The row's recipe selects the key law: the image arm's 13 required fields, the
    // video arm's 17 (LEG M9c), the music arm's 16 — the YuE2 list or the ACE-Step
    // list (LEG M14b; the family word picks the arm exactly as stock
    // `jobs_music::compile` dispatches) — the same lists the fill plane emitted over.
    let video = recipe_id == fill_plane::VIDEO_RECIPE_ID;
    let music = recipe_id == fill_plane::MUSIC_RECIPE_ID;
    let music_ace = music && fill_plane::is_ace_music_family(family);
    let required: &[&str] = if video {
        &fill_plane::VIDEO_REQUIRED_FIELDS
    } else if music_ace {
        &fill_plane::MUSIC_ACE_REQUIRED_FIELDS
    } else if music {
        &fill_plane::MUSIC_REQUIRED_FIELDS
    } else {
        &fill_plane::REQUIRED_FIELDS
    };
    for &field in required {
        let value = match field {
            "recipeId" => Some(json!(recipe_id)),
            "version" => Some(recipe_version.clone()),
            "seed" => Some(seed.clone()),
            "family" => Some(json!(family)),
            // The video model identity rides the slots exactly as the door built it:
            // checkpoint is the model file, the component recipe the encoder/VAE.
            "model" => row.slots.checkpoint.clone().map(Value::String),
            "textEncoder" => row
                .slots
                .diffusion
                .as_ref()
                .and_then(|diffusion| diffusion.get("textEncoder"))
                .cloned(),
            "vae" => row
                .slots
                .diffusion
                .as_ref()
                .and_then(|diffusion| diffusion.get("vae"))
                .cloned(),
            "positivePrompt" => row.slots.positive_prompt.clone().map(Value::String),
            "checkpoint" => row.slots.checkpoint.clone().map(Value::String),
            "outputPrefix" => row.slots.output_prefix.clone().map(Value::String),
            // The door's floor for an unnamed negative prompt is the empty string;
            // complete_or_refuse applies the same law, so the mirror must too.
            "negativePrompt" => {
                Some(envelope_field(envelope, "negativePrompt").unwrap_or_else(|| json!("")))
            }
            // The music arm's door-owned words (`mode`, `planning`) and its
            // door-completed scalars (`style`, `lyrics`, `maxDuration`, the
            // `generation{}` sub-dials) ride the envelope's field list exactly as the
            // ladder dials do, so one lookup covers them all.
            other => envelope_field(envelope, other),
        };
        match value {
            Some(value) => {
                values.insert((*field).to_string(), value);
            }
            None => missing.push(field),
        }
    }
    // The split-loader component recipe rides the slots; the ladder-supplied optional
    // keys ride the envelope fields — exactly the door's key law. The video recipe
    // counts neither the `diffusion` key nor the image-only optional trio, the YuE2
    // music struct (`deny_unknown_fields`) counts no ladder-supplied key and no
    // `diffusion` at all, and the ACE struct counts exactly one optional key: the
    // 1.5 split triple from the slot (LEG M14b).
    if !video && !(music && !music_ace) {
        if let Some(diffusion) = &row.slots.diffusion {
            values.insert("diffusion".to_string(), diffusion.clone());
        }
    } else if video {
        // The video arm's optional `outputPrefix` slot, mirroring `intent_values`.
        if let Some(prefix) = &row.slots.output_prefix {
            values.insert("outputPrefix".to_string(), json!(prefix));
        }
    }
    let ladder_optionals: &[&str] = if video {
        &["options"]
    } else if music {
        &[]
    } else {
        &["denoise", "imageFormat", "imageCompression", "options"]
    };
    for name in ladder_optionals {
        if let Some(value) = envelope_field(envelope, name) {
            values.insert(name.to_string(), value);
        }
    }
    for (key, value) in &row.extras {
        values.insert(key.clone(), value.clone());
    }
    // The fill plane owns the family key; the request never carried one.
    values.insert("family".to_string(), json!(family));
    if !missing.is_empty() {
        missing.sort_unstable();
        missing.dedup();
        return Err(format!(
            "row {} is not drain-ready; missing {}",
            row.id,
            missing.join(", ")
        ));
    }
    Ok(Value::Object(values))
}

/// The RefMod export arm of [`flat_intent`] (E28, LEG AF2-M24b): rebuild the
/// closed compile request from the envelope's field list. Exactly the seven
/// keys stock `compile` names ([`fill_plane::REFMOD_EXPORT_KEYS`]), each one
/// present only when the envelope carries it; `media` and `refmods` are the two
/// arrays the stock compiler demands whatever else rides, so a row missing
/// either is honestly not drain-ready. Values ride VERBATIM — every compile-side
/// law (name grammar, model names, the media contract, the at-least-one-
/// reference wall) is enforced by stock at submit, never restated here.
fn refmod_request(row: &QueueRow) -> Result<Value, String> {
    let envelope = &row.envelope;
    let mut request = Map::new();
    for key in fill_plane::REFMOD_EXPORT_KEYS {
        if let Some(value) = envelope_field(envelope, key) {
            request.insert((*key).to_string(), value);
        }
    }
    for key in ["media", "refmods"] {
        if !matches!(request.get(key), Some(Value::Array(_))) {
            return Err(format!(
                "row {} is not drain-ready; the RefMod export envelope carries no '{key}' array",
                row.id
            ));
        }
    }
    Ok(Value::Object(request))
}

/// The join arm of [`flat_intent`] (AF2-M31): rebuild the closed stock join
/// intent from the envelope's field list - exactly the one `h3` field the mint
/// stored, plus the recipe word and version the recipe record carries. Values
/// ride VERBATIM; every join law (session/chain grammar, file names, trims, the
/// 64 KiB budget) is enforced stock-side by `jobs_video::validate_join` at the
/// door and inside `compile` at drain, never restated here.
fn join_request(row: &QueueRow) -> Result<Value, String> {
    let envelope = &row.envelope;
    let mut request = Map::new();
    request.insert(
        "recipeId".to_owned(),
        envelope
            .pointer("/recipe/recipeId")
            .cloned()
            .unwrap_or(Value::Null),
    );
    request.insert(
        "version".to_owned(),
        envelope
            .pointer("/recipe/version")
            .cloned()
            .unwrap_or(Value::from(1)),
    );
    let Some(h3) = envelope_field(envelope, "h3") else {
        return Err(format!(
            "row {} is not drain-ready; the H3 join envelope carries no 'h3' block",
            row.id
        ));
    };
    request.insert("h3".to_owned(), h3);
    Ok(Value::Object(request))
}

/// The drain-side shape law selecting the join arm of a queued row (AF2-M31):
/// the flat intent of such a row is the closed stock join request - the stock
/// recipe word (`crate::jobs_video::is_join`, the compile dispatch's own
/// predicate, so door, spool and stock compile read ONE word), version 1, and an
/// `h3.join` object. No render intent carries `h3.join`: `jobs_video::validate_h3`
/// refuses a join block beside a generation's h3 keys (pinned stock-side by
/// `h3_join_rejects_invalid_blocks`), so the shape cannot catch a render row.
pub(crate) fn is_join_row_intent(intent: &Value) -> bool {
    crate::jobs_video::is_join(intent)
        && intent["version"].as_f64() == Some(1.0)
        && intent["h3"]["join"].is_object()
}

/// The drain-side shape law selecting the chain arm for a RefMod export row
/// (E28, LEG AF2-M24b): the flat intent of such a row is the closed compile map
/// — `media` plus `refmods` arrays and NO `recipeId` (the plane's recipe word
/// never reaches the request; stock compile refuses unknown keys). No render-arm
/// intent carries `media`, and no compile-shaped export request lacks it: the
/// shape is the discriminator, with this one home, read by the production
/// chain's `run_row` to pick its arm.
pub(crate) fn is_refmod_export_intent(intent: &Value) -> bool {
    intent.get("recipeId").is_none()
        && intent.get("media").is_some_and(Value::is_array)
        && intent.get("refmods").is_some_and(Value::is_array)
}

/// The effective value of one envelope ladder field (`None` when cleared or unsupplied).
/// Mirrors `IntentPlan::dial` over the serialized `fields` array.
fn envelope_field(envelope: &Value, name: &str) -> Option<Value> {
    envelope
        .pointer("/fields")?
        .as_array()?
        .iter()
        .find(|entry| entry["field"] == name && !entry["value"].is_null())
        .map(|entry| entry["value"].clone())
}

/// Epoch milliseconds; `0` on a clock set before the POSIX epoch (a hostile-clock
/// honesty marker, never a panic). Shared with the cycle cell's report stamps.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::super::defaults::DefaultsSheet;
    use super::*;

    /// A complete anima t2i request: anima is a split-loader family, so `diffusion`
    /// is one of the four slots the door demands.
    const COMPLETE_ANIMA: &str = r#"{
        "checkpoint": "anima/something.safetensors",
        "positivePrompt": "a lighthouse at dusk",
        "outputPrefix": "agent/run",
        "diffusion": {
            "textEncoder": "qwen3-0.6b.safetensors",
            "clipType": "stable_diffusion",
            "vae": "wan_2.1_vae.safetensors",
            "family": "anima"
        },
        "loras": [{"name": "test_lora.safetensors", "strength": 0.8}]
    }"#;

    fn extras(text: &str) -> Map<String, Value> {
        serde_json::from_str(text).expect("test fixture extras parse")
    }

    /// A door-complete anima t2i plan.
    fn complete_plan() -> IntentPlan {
        fill_plane::fill(
            "anima",
            "t2i",
            None,
            &DefaultsSheet::default(),
            Some(&extras(COMPLETE_ANIMA)),
        )
        .expect("fixture is a complete intent")
        .plan()
    }

    fn fixture_row(id: &str) -> QueueRow {
        QueueRow {
            id: id.to_owned(),
            created_at: 1_700_000_000_000,
            status: RowStatus::Queued,
            envelope: json!({ "apiVersion": 1, "family": "anima", "mode": "t2i" }),
            slots: Slots::default(),
            extras: Map::new(),
            job_id: None,
            story_link: None,
        }
    }

    #[test]
    fn absent_file_loads_as_a_healthy_empty_queue() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        assert!(spool.snapshot().expect("absent is healthy").is_empty());
        assert!(!dir.path().join(FILE).exists(), "a read creates nothing");
    }

    /// W3-13 seam (LEG AF2-M21b): while the bench window is open, the spool's ONE
    /// write gate is held — the same gate `append` takes — so the claim-check and the
    /// renames cannot interleave with a queue append. `try_lock` names the hold
    /// without blocking the test; the window closes on command, never on a timeout.
    #[test]
    fn the_bench_window_holds_the_write_gate_a_concurrent_append_needs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = std::sync::Arc::new(Spool::new(dir.path()));
        let (held_tx, held_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let window = {
            let spool = std::sync::Arc::clone(&spool);
            std::thread::spawn(move || {
                spool
                    .with_bench_window(|_rows| {
                        held_tx.send(()).expect("window signal");
                        release_rx.recv().expect("window release")
                    })
                    .expect("the empty spool reads under the window")
            })
        };
        held_rx.recv().expect("the window is open");
        assert!(
            spool.gate.try_lock().is_err(),
            "the open window holds the spool's write gate — the gate append takes"
        );
        release_tx.send(()).expect("the release lands");
        window.join().expect("the window closes");
        assert!(
            spool.gate.try_lock().is_ok(),
            "the gate is free the moment the window closes"
        );
    }

    #[test]
    fn append_persists_and_a_fresh_spool_sees_the_row() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        spool.append(&fixture_row("row-a")).expect("append lands");
        // A "restart" is a brand-new handle over the same app-data.
        let reopened = Spool::new(dir.path());
        let rows = reopened.snapshot().expect("healthy");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "row-a");
        assert_eq!(rows[0].status, RowStatus::Queued);
        let on_disk: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).expect("written"))
                .expect("valid json");
        assert_eq!(on_disk["version"], QUEUE_VERSION);
        assert_eq!(on_disk["rows"][0]["id"], "row-a");
    }

    #[test]
    fn corrupt_file_fails_closed_and_is_never_rewritten() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(FILE), "{ broken").expect("fixture writes garbage");
        let spool = Spool::new(dir.path());
        let problem = spool.snapshot().expect_err("garbage fails closed");
        assert!(problem.contains(FILE), "{problem} names the path");
        spool
            .append(&fixture_row("row-a"))
            .expect_err("append refuses too");
        let on_disk = std::fs::read_to_string(dir.path().join(FILE)).expect("still there");
        assert_eq!(on_disk, "{ broken", "a refused mutation rewrites nothing");
    }

    #[test]
    fn wrong_version_is_refused_not_repaired() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(FILE), r#"{"version": 99, "rows": []}"#)
            .expect("fixture writes a future schema");
        let spool = Spool::new(dir.path());
        let problem = spool.snapshot().expect_err("unknown version fails closed");
        assert!(problem.contains("version"), "{problem}");
    }

    #[test]
    fn unknown_row_field_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(FILE),
            r#"{"version": 1, "rows": [{"id": "x", "createdAt": 1, "status": "queued",
                "envelope": {}, "slots": {}, "extras": {}, "sneaky": 1}]}"#,
        )
        .expect("fixture writes an unknown key");
        let spool = Spool::new(dir.path());
        assert!(spool.snapshot().is_err(), "the row schema stays closed");
    }

    #[test]
    fn unknown_status_word_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(FILE),
            r#"{"version": 1, "rows": [{"id": "x", "createdAt": 1, "status": "wobbly",
                "envelope": {}, "slots": {}, "extras": {}}]}"#,
        )
        .expect("fixture writes a fake status");
        let spool = Spool::new(dir.path());
        assert!(
            spool.snapshot().is_err(),
            "the status vocabulary stays closed"
        );
    }

    #[test]
    fn status_words_match_the_serde_vocabulary() {
        for status in [
            RowStatus::Queued,
            RowStatus::Draining,
            RowStatus::Done,
            RowStatus::Failed,
            RowStatus::Cancelled,
            RowStatus::Wedged,
        ] {
            let value = serde_json::to_value(status).expect("status serializes");
            assert_eq!(value, status.word(), "one vocabulary home, pinned");
        }
    }

    #[test]
    fn wedged_status_round_trips_through_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let mut row = fixture_row("row-wedged");
        row.status = RowStatus::Draining;
        spool.append(&row).expect("append lands");
        assert!(spool
            .set_status("row-wedged", RowStatus::Draining, RowStatus::Wedged)
            .expect("healthy"));
        let reopened = Spool::new(dir.path());
        let rows = reopened.snapshot().expect("healthy");
        assert_eq!(rows[0].status, RowStatus::Wedged);
        let on_disk: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).expect("written"))
                .expect("valid json");
        assert_eq!(on_disk["rows"][0]["status"], "wedged", "the wire word");
    }

    #[test]
    fn the_job_id_round_trips_through_the_file_on_a_draining_row() {
        // The M9a correlation write: the row the drain owns carries the stock id,
        // durably, under the wire word the §4 doors and the operator both read.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let mut row = fixture_row("row-corr");
        row.status = RowStatus::Draining;
        spool.append(&row).expect("append lands");
        assert!(
            spool
                .set_job_id("row-corr", "stock-job-1")
                .expect("healthy"),
            "a draining row takes its jobId"
        );
        let reopened = Spool::new(dir.path());
        let rows = reopened.snapshot().expect("healthy");
        assert_eq!(rows[0].job_id.as_deref(), Some("stock-job-1"));
        let on_disk: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).expect("written"))
                .expect("valid json");
        assert_eq!(on_disk["rows"][0]["jobId"], "stock-job-1", "the wire word");
        // Re-recording the same id is idempotent: the bytes stay, no write churn.
        assert!(
            spool
                .set_job_id("row-corr", "stock-job-1")
                .expect("still healthy"),
            "the same id re-records cleanly"
        );
    }

    #[test]
    fn a_row_written_before_the_job_id_field_still_loads_uncorrelated() {
        // Back-compat law: the field is a default, not a schema bump — a version-1
        // file that never heard of jobId loads with the honest `None`.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(FILE),
            r#"{"version": 1, "rows": [{"id": "old-row", "createdAt": 1, "status": "done",
                "envelope": {}, "slots": {}, "extras": {}}]}"#,
        )
        .expect("fixture writes a pre-M9a row");
        let spool = Spool::new(dir.path());
        let rows = spool.snapshot().expect("an old file is a healthy file");
        assert_eq!(rows[0].id, "old-row");
        assert_eq!(rows[0].job_id, None, "unknown correlation is honest None");
        assert_eq!(QUEUE_VERSION, 1, "the growth needed no version bump");
    }

    #[test]
    fn set_job_id_refuses_a_row_that_is_not_the_drains() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        // Queued: the drain does not own it yet.
        spool
            .append(&fixture_row("row-queued"))
            .expect("append lands");
        let problem = spool
            .set_job_id("row-queued", "stock-job-x")
            .expect_err("a queued row is not the drain's");
        assert!(problem.contains("queued"), "{problem} names the status");
        // Terminal: the row is history; its correlation was settled in its cycle.
        let mut done = fixture_row("row-done");
        done.status = RowStatus::Done;
        spool.append(&done).expect("append lands");
        assert!(spool
            .set_job_id("row-done", "stock-job-y")
            .expect_err("a terminal row is not the drain's")
            .contains("done"));
        // Gone: the honest skip, not a fault.
        assert!(
            !spool
                .set_job_id("row-gone", "stock-job-z")
                .expect("healthy file"),
            "no row, nothing to correlate"
        );
        let rows = spool.snapshot().expect("healthy");
        assert!(
            rows.iter().all(|row| row.job_id.is_none()),
            "a refused record writes nothing"
        );
    }

    #[test]
    fn a_second_different_job_id_is_refused_and_the_first_stands() {
        // One row drives one stock job: a resubmit would silently orphan the first
        // job's outputs, so the link is write-once and the bug is named.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let mut row = fixture_row("row-once");
        row.status = RowStatus::Draining;
        spool.append(&row).expect("append lands");
        spool.set_job_id("row-once", "stock-job-1").expect("lands");
        let problem = spool
            .set_job_id("row-once", "stock-job-2")
            .expect_err("a second stock job for one row is refused");
        assert!(problem.contains("stock-job-1"), "{problem} names the id");
        let rows = spool.snapshot().expect("healthy");
        assert_eq!(rows[0].job_id.as_deref(), Some("stock-job-1"));
    }

    #[test]
    fn delete_removes_a_queued_row_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        spool.append(&fixture_row("row-a")).expect("append lands");
        let mut draining = fixture_row("row-b");
        draining.status = RowStatus::Done;
        spool.append(&draining).expect("append lands");

        assert!(matches!(
            spool.delete_queued("row-a").expect("healthy"),
            DeleteOutcome::Deleted
        ));
        assert!(matches!(
            spool.delete_queued("row-b").expect("healthy"),
            DeleteOutcome::NotQueued(RowStatus::Done)
        ));
        assert!(matches!(
            spool.delete_queued("nope").expect("healthy"),
            DeleteOutcome::UnknownId
        ));
        let rows = spool.snapshot().expect("healthy");
        assert_eq!(rows.len(), 1, "the terminal row stays with the drain");
        assert_eq!(rows[0].id, "row-b");
    }

    #[test]
    fn two_threads_appending_at_once_both_rows_land() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = std::sync::Arc::new(Spool::new(dir.path()));
        let handles: Vec<_> = (0..2)
            .map(|index| {
                let spool = std::sync::Arc::clone(&spool);
                std::thread::spawn(move || {
                    let row = fixture_row(&format!("thread-{index}"));
                    spool
                        .append(&row)
                        .expect("the gate serializes the mutation");
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("thread lands");
        }
        let mut ids: Vec<String> = spool
            .snapshot()
            .expect("healthy")
            .into_iter()
            .map(|row| row.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["thread-0".to_owned(), "thread-1".to_owned()]);
    }

    #[test]
    fn row_round_trips_to_a_byte_equal_flat_intent() {
        let plan = complete_plan();
        let intent = plan.complete_or_refuse().expect("fixture is complete");
        let row = QueueRow::from_plan(&plan).expect("row builds");
        // Persisted bytes -> fresh load (the restart path) -> rebuild.
        let stored = serde_json::to_vec(&row).expect("row serializes");
        let reread: QueueRow = serde_json::from_slice(&stored).expect("row reloads");
        let rebuilt = flat_intent(&reread).expect("door-complete rows are drain-ready");
        assert_eq!(rebuilt, intent, "structure must equal the door's intent");
        assert_eq!(
            serde_json::to_vec(&rebuilt).expect("serialize"),
            serde_json::to_vec(&intent).expect("serialize"),
            "byte-equal: the mirror cannot drift from complete_or_refuse"
        );
        // The passthrough extras (loras) ride the row, not just the envelope.
        assert_eq!(rebuilt["loras"][0]["name"], "test_lora.safetensors");
        assert_eq!(rebuilt["family"], "anima");
    }

    #[test]
    fn an_incomplete_plan_never_reaches_a_row() {
        let refused = fill_plane::fill("anima", "t2i", None, &DefaultsSheet::default(), None)
            .expect("bare anima t2i fills the plan shape")
            .plan();
        let missing = refused.complete_or_refuse().expect_err("slots stay open");
        assert!(missing.contains(&"checkpoint"));
        assert!(missing.contains(&"positivePrompt"));
        assert!(missing.contains(&"outputPrefix"));
        assert!(missing.contains(&"diffusion"));
    }

    #[test]
    fn the_cap_refuses_the_513th_live_row_and_writes_nothing() {
        // Red-team W5, owner-approved: the loop is cheap here (one tempdir, tiny
        // fixture rows) and pins the exact boundary: 512 land, 513 is refused.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        for index in 0..CAP {
            spool
                .append(&fixture_row(&format!("row-{index}")))
                .unwrap_or_else(|problem| panic!("live row {index} lands: {problem}"));
        }
        let refused = spool
            .append(&fixture_row("row-over"))
            .expect_err("the cap refuses the next live row");
        match refused {
            AppendError::Full { live } => assert_eq!(live, CAP, "the refusal names the count"),
            other => panic!("expected the cap refusal, got {other:?}"),
        }
        let rows = spool.snapshot().expect("healthy");
        assert_eq!(rows.len(), CAP, "a refused append writes nothing");
        assert!(
            rows.iter().all(|row| row.id != "row-over"),
            "the refused row is not in the file"
        );
    }

    #[test]
    fn terminal_rows_do_not_count_toward_the_cap() {
        // Only queued + draining are live. Terminal history (done here; the same
        // law covers failed/cancelled/wedged) rides past the cap in the file, and
        // the cap fires on LIVE rows alone.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        for index in 0..(CAP + 64) {
            let mut row = fixture_row(&format!("done-{index}"));
            row.status = RowStatus::Done;
            spool.append(&row).expect("terminal rows never hit the cap");
        }
        // One draining row plus CAP-1 queued rows fill the live budget exactly.
        let mut draining = fixture_row("drain-one");
        draining.status = RowStatus::Draining;
        spool.append(&draining).expect("the first live row lands");
        for index in 0..(CAP - 1) {
            spool
                .append(&fixture_row(&format!("q-{index}")))
                .unwrap_or_else(|problem| panic!("live row {index} lands: {problem}"));
        }
        let refused = spool
            .append(&fixture_row("q-over"))
            .expect_err("live rows alone reach the cap");
        assert!(matches!(refused, AppendError::Full { live } if live == CAP));
    }

    #[test]
    fn the_boot_sweep_flips_a_draining_orphan_to_failed_and_leaves_the_rest_alone() {
        // C2: a row the previous process left `draining` has no driver to finish it. The
        // sweep fails it honestly at boot; queued, wedged and terminal rows are untouched.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let mut orphan = fixture_row("row-orphan");
        orphan.status = RowStatus::Draining;
        orphan.job_id = Some("stock-orphan".to_owned());
        spool.append(&orphan).expect("append lands");
        spool
            .append(&fixture_row("row-queued"))
            .expect("append lands");
        let mut wedged = fixture_row("row-wedged");
        wedged.status = RowStatus::Draining;
        spool.append(&wedged).expect("append lands");
        assert!(spool
            .set_status("row-wedged", RowStatus::Draining, RowStatus::Wedged)
            .expect("CAS"));
        let mut done = fixture_row("row-done");
        done.status = RowStatus::Done;
        spool.append(&done).expect("append lands");

        let orphans = spool.recover_draining_orphans().expect("healthy file");
        assert_eq!(
            orphans,
            vec!["row-orphan".to_owned()],
            "the sweep names what it took"
        );

        // Durable: a fresh handle (the restart read) answers the flip, not the memory.
        let reopened = Spool::new(dir.path());
        let rows = reopened.snapshot().expect("healthy");
        let status_of = |id: &str| {
            rows.iter()
                .find(|row| row.id == id)
                .expect("row kept")
                .status
        };
        assert_eq!(status_of("row-orphan"), RowStatus::Failed);
        assert_eq!(status_of("row-queued"), RowStatus::Queued);
        assert_eq!(status_of("row-wedged"), RowStatus::Wedged);
        assert_eq!(status_of("row-done"), RowStatus::Done);
        // The correlation survives the flip: the §4 result doors can still name the job
        // the dead process left behind.
        assert_eq!(
            rows.iter()
                .find(|row| row.id == "row-orphan")
                .expect("row kept")
                .job_id
                .as_deref(),
            Some("stock-orphan"),
            "the sweep rewrites the status only"
        );
        let on_disk: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).expect("written"))
                .expect("valid json");
        assert_eq!(on_disk["rows"][0]["status"], "failed", "the wire word");
        // A second sweep has nothing left to take, and rewrites nothing.
        assert!(
            spool.recover_draining_orphans().expect("again").is_empty(),
            "no orphan, no churn"
        );
    }

    #[test]
    fn the_boot_sweep_on_an_absent_spool_answers_nothing_and_writes_no_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        assert!(spool
            .recover_draining_orphans()
            .expect("absent is healthy")
            .is_empty());
        assert!(
            !dir.path().join(FILE).exists(),
            "an empty spool answers nothing and grows no file"
        );
    }

    #[test]
    fn the_boot_sweep_refuses_a_corrupt_file_and_rewrites_nothing() {
        // The spool's fail-closed law, unchanged: the sweep never repairs bytes behind the
        // operator; the caller logs the refusal and the doors keep answering it.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(FILE), "{ broken").expect("fixture writes garbage");
        let spool = Spool::new(dir.path());
        let problem = spool
            .recover_draining_orphans()
            .expect_err("garbage fails closed");
        assert!(problem.contains(FILE), "{problem} names the path");
        let on_disk = std::fs::read_to_string(dir.path().join(FILE)).expect("still there");
        assert_eq!(on_disk, "{ broken", "a refused sweep rewrites nothing");
    }

    #[test]
    fn clear_queued_flips_only_queued_rows_and_returns_the_count() {
        let root = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(root.path());
        spool.append(&fixture_row("q1")).expect("append q1");
        spool.append(&fixture_row("q2")).expect("append q2");
        spool.append(&fixture_row("owned")).expect("append owned");
        spool.append(&fixture_row("wedged")).expect("append wedged");
        // Rows the drain owns (or the watchdog latched) are never the clear door's.
        assert!(spool
            .set_status("owned", RowStatus::Queued, RowStatus::Draining)
            .expect("CAS"));
        assert!(spool
            .set_status("owned", RowStatus::Draining, RowStatus::Done)
            .expect("CAS"));
        assert!(spool
            .set_status("wedged", RowStatus::Queued, RowStatus::Draining)
            .expect("CAS"));
        assert!(spool
            .set_status("wedged", RowStatus::Draining, RowStatus::Wedged)
            .expect("CAS"));
        assert_eq!(spool.clear_queued().expect("clear"), 2);
        let rows = spool.snapshot().expect("snapshot");
        let status_of = |id: &str| {
            rows.iter()
                .find(|row| row.id == id)
                .expect("row kept")
                .status
                .word()
        };
        assert_eq!(status_of("q1"), "cancelled");
        assert_eq!(status_of("q2"), "cancelled");
        assert_eq!(status_of("owned"), "done");
        assert_eq!(status_of("wedged"), "wedged");
        // A second clear has nothing queued left: zero, and the rows stand.
        assert_eq!(spool.clear_queued().expect("clear again"), 0);
        assert_eq!(spool.snapshot().expect("snapshot").len(), 4);
    }

    #[test]
    fn clear_queued_on_an_absent_spool_answers_zero_and_writes_no_file() {
        let root = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(root.path());
        assert_eq!(spool.clear_queued().expect("clear"), 0);
        assert!(
            !root.path().join(FILE).exists(),
            "an empty spool answers zero and grows no file"
        );
    }

    /// The closed seven-key export fixture (E28, LEG AF2-M24b): the shape the
    /// creation door's bridge submit takes, so the row's rebuild must equal it.
    const EXPORT_FIXTURE: &str = r#"{
        "name": "my bundle",
        "description": "a drain-export fixture",
        "conceptType": "identity",
        "media": [{"type": "image", "file": "ref_a.png", "mediaMode": "video"}],
        "refmods": ["saved_one.safetensors"],
        "vae": "Minimax\\video_vae.safetensors",
        "audioVae": "Minimax\\audio_vae.safetensors"
    }"#;

    #[test]
    fn the_refmod_row_round_trips_to_the_closed_compile_request() {
        // (a) E28: the export row is built from the closed seven and rebuilds
        // byte-equal — and the rebuild carries ONLY them: the plane's envelope
        // words (recipeId, family, seed, version) never reach the request that
        // stock `jobs_refmod::compile` would otherwise refuse.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let export: Value = serde_json::from_str(EXPORT_FIXTURE).expect("fixture parses");
        let row = spool
            .append_refmod_row(&export)
            .expect("the helper enqueues");
        assert_eq!(
            row.status,
            RowStatus::Queued,
            "a fresh row waits like any other"
        );
        assert_eq!(
            row.job_id, None,
            "no export exists until the drain submits one"
        );
        // Persisted bytes -> fresh handle (the restart path) -> rebuild.
        let reread = Spool::new(dir.path())
            .snapshot()
            .expect("healthy")
            .into_iter()
            .next()
            .expect("one row");
        let rebuilt = flat_intent(&reread).expect("an export row is drain-ready");
        assert_eq!(rebuilt, export, "structure must equal the closed request");
        assert_eq!(
            serde_json::to_vec(&rebuilt).expect("serialize"),
            serde_json::to_vec(&export).expect("serialize"),
            "byte-equal: the mirror cannot drift from the door's export map"
        );
        let keys = rebuilt.as_object().expect("object");
        assert_eq!(
            keys.len(),
            fill_plane::REFMOD_EXPORT_KEYS.len(),
            "only the closed keys ride"
        );
        for plane_word in ["recipeId", "family", "seed", "version"] {
            assert!(
                !keys.contains_key(plane_word),
                "{plane_word} is plane-only and must be stripped"
            );
        }
        // The shape law that selects the chain arm fires on this and only this.
        assert!(
            is_refmod_export_intent(&rebuilt),
            "the export shape is the discriminator"
        );
        let render_plan = complete_plan();
        let render_row = QueueRow::from_plan(&render_plan).expect("render row builds");
        let render = flat_intent(&render_row).expect("render intent");
        assert!(
            !is_refmod_export_intent(&render),
            "a render intent is never the export shape"
        );
    }

    /// AF2-M31 (H3-continuity closure): the join row's mint/rebuild pair is the
    /// door's contract with the drain - the envelope stores the validated join
    /// block verbatim, `flat_intent` rebuilds the CLOSED stock join intent
    /// byte-equal, and the stock word (`jobs_video::is_join`) fires so the
    /// production chain's render arm (`Jobs::prepare_with_models` ->
    /// `jobs::compile`) is the compile entry the row rides.
    #[test]
    fn the_join_row_round_trips_to_the_closed_stock_join_intent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let intent = json!({
            "recipeId": "h3-join",
            "version": 1,
            "h3": {
                "join": {
                    "kind": "segments",
                    "session": "aqua-story",
                    "chain": ["f579b09e", "4c9c8088"],
                    "smoothAudioSeams": true,
                    "filenamePrefix": "final_cut-1",
                }
            },
        });
        let row = spool
            .append_join_row(&intent)
            .expect("a closed join intent mints");
        assert_eq!(row.status, RowStatus::Queued);
        assert!(row.job_id.is_none(), "no stock job exists until the drain");
        let rebuilt = flat_intent(&row).expect("the join row is drain-ready");
        assert_eq!(
            serde_json::to_string(&rebuilt).expect("serialize rebuilt"),
            serde_json::to_string(&intent).expect("serialize door intent"),
            "byte-equal: the drain submits exactly what the door validated"
        );
        assert!(is_join_row_intent(&rebuilt), "the join shape law fires");
        assert!(
            crate::jobs_video::is_join(&rebuilt),
            "the stock compile predicate fires on the rebuilt intent"
        );
        assert!(
            !is_refmod_export_intent(&rebuilt),
            "the export arm never catches a join row"
        );
        // The stock grammar runs on the REBUILT intent, at drain: the same entry
        // `Jobs::prepare_with_models` calls for every video row.
        let graph =
            crate::jobs::compile(&rebuilt).expect("the row compiles through the stock entry");
        assert_eq!(graph["7"]["class_type"], "DaSiWaH3ClipAssemble");
        // A join block never rides a render row: the shape law cannot catch a
        // generation intent (no `h3.join` object reaches a render row).
        assert!(
            !is_join_row_intent(&json!({"recipeId": "video-generation", "version": 1, "h3": {}})),
            "a render intent is never the join shape"
        );
    }

    #[test]
    fn the_join_helper_refuses_anything_outside_the_closed_intent_shape() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        // An unknown top-level intent key is refused by name (the row's closed set
        // is the stock intent's three keys).
        let problem = spool
            .append_join_row(
                &json!({"recipeId": "h3-join", "version": 1, "h3": {"join": {}}, "seed": 3}),
            )
            .expect_err("the closed intent set refuses seed");
        assert!(
            problem.contains("unknown H3 join intent key 'seed'"),
            "{problem}"
        );
        // The stock recipe word, the version and the single h3 block are shape law.
        assert!(spool
            .append_join_row(
                &json!({"recipeId": "video-generation", "version": 1, "h3": {"join": {}}})
            )
            .expect_err("the join row carries the stock join word")
            .contains("h3-join"));
        assert!(spool
            .append_join_row(&json!({"recipeId": "h3-join", "version": 2, "h3": {"join": {}}}))
            .expect_err("the join row carries version 1")
            .contains("version 1"));
        assert!(spool
            .append_join_row(
                &json!({"recipeId": "h3-join", "version": 1, "h3": {"join": {}, "media": []}})
            )
            .expect_err("the h3 block carries only the join block")
            .contains("only the join block"));
    }

    #[test]
    fn a_join_row_rides_the_cap_and_the_ordinary_lifecycle_like_any_row() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let intent = json!({
            "recipeId": "h3-join",
            "version": 1,
            "h3": {"join": {"kind": "files", "files": [{"filename": "deas-input-1.mp4"}]}},
        });
        let row = spool.append_join_row(&intent).expect("the row lands");
        let snapshot = spool.snapshot().expect("the spool reads back");
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].id, row.id);
        // The listing door's envelope reads stay honest for a row with no
        // family/mode/seed pointers (they answer null, never a wrong value).
        assert!(snapshot[0].envelope.pointer("/family").is_none());
        assert!(snapshot[0].envelope.pointer("/seed/value").is_none());
    }

    #[test]
    fn the_refmod_helper_refuses_anything_outside_the_closed_shape() {
        // The envelope SHAPE wall only (compile's own laws stay stock-side): the
        // closed key set, the two arrays, and the door's at-least-one wall.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let refused = spool
            .append_refmod_row(&json!({ "media": [], "refmods": ["a.safetensors"], "seed": 7 }))
            .expect_err("seed is a plane word, not an export field");
        assert!(refused.contains("seed"), "{refused} names the key");
        let refused = spool
            .append_refmod_row(&json!({ "media": "not-an-array", "refmods": [] }))
            .expect_err("the arrays are required");
        assert!(refused.contains("media"), "{refused} names the array");
        let refused = spool
            .append_refmod_row(&json!({ "media": [], "refmods": [] }))
            .expect_err("an export needs at least one reference");
        assert!(refused.contains("at least one"), "{refused}");
        assert!(
            spool.snapshot().expect("healthy").is_empty(),
            "a refused helper call writes no row"
        );
    }

    #[test]
    fn a_door_validated_refmod_body_mints_the_row_the_drain_rebuilds_byte_equal() {
        // The M24c door-to-wire pin (test duty (a)): the SAME body the queue
        // door hands `fill_plane::fill` (post-fold) becomes the export map, the
        // export map becomes the envelope through the ONLY row constructor,
        // and `flat_intent` rebuilds the closed compile request BYTE-EQUAL to
        // the map the door's grammar filled. Door -> spool -> drain, one chain,
        // no restated grammar anywhere on it.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let mut body: Map<String, Value> = serde_json::from_str(
            r#"{
                "name": "hero",
                "description": "main cast",
                "conceptType": "identity",
                "images": ["deas-inputs/a.png"],
                "refmods": [{"slot": 1, "name": "old-set.safetensors", "strength": 0.7}]
            }"#,
        )
        .expect("a stranger's folded body");
        super::super::e16::fold(&mut body).expect("the door's fold lands first");
        let export = match fill_plane::fill(
            "minimax-h3",
            "refmod",
            None,
            &DefaultsSheet::default(),
            Some(&body),
        )
        .expect("the queue grammar fills")
        {
            fill_plane::FillOutcome::Export(export) => export,
            fill_plane::FillOutcome::Plan(_) => panic!("the refmod arm never fills a plan"),
        };
        let row = spool
            .append_refmod_row(&export)
            .expect("the door mints the row");
        assert_eq!(row.status, RowStatus::Queued, "the row lands queued");
        let reread = Spool::new(dir.path())
            .snapshot()
            .expect("healthy")
            .into_iter()
            .next()
            .expect("one row");
        let rebuilt = flat_intent(&reread).expect("an export row is drain-ready");
        assert_eq!(rebuilt, export, "the drain rebuilds the door's map");
        assert_eq!(
            serde_json::to_vec(&rebuilt).expect("serialize"),
            serde_json::to_vec(&export).expect("serialize"),
            "byte-equal door-to-wire"
        );
        assert_eq!(
            rebuilt["media"],
            json!([{ "type": "image", "file": "deas-inputs/a.png", "slot": 0 }]),
            "the door built the Director row"
        );
        assert_eq!(
            rebuilt["refmods"],
            json!(["old-set.safetensors"]),
            "the saved bag folded to the stock bare-name list"
        );
        assert!(is_refmod_export_intent(&rebuilt), "the chain arm fires");
    }

    #[test]
    fn a_refmod_row_rides_the_cap_and_the_ordinary_lifecycle_like_any_row() {
        // E28's consistency law: the export row is a ROW — CAS, status words and
        // the live-row cap all apply unchanged.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let export: Value = serde_json::from_str(EXPORT_FIXTURE).expect("fixture parses");
        let row = spool.append_refmod_row(&export).expect("row lands");
        assert!(spool
            .set_status(&row.id, RowStatus::Queued, RowStatus::Draining)
            .expect("CAS queued->draining"));
        assert!(spool
            .set_job_id(&row.id, "backend-prompt-id")
            .expect("the drain's correlation write accepts an export row"));
        assert!(spool
            .set_status(&row.id, RowStatus::Draining, RowStatus::Done)
            .expect("CAS draining->done"));
        let reread = Spool::new(dir.path()).snapshot().expect("healthy");
        assert_eq!(reread[0].status, RowStatus::Done);
        assert_eq!(reread[0].job_id.as_deref(), Some("backend-prompt-id"));
    }

    /* ---------- LEG AF2-M32: story chaining (the batch mint) ---------- */

    /// A complete minimax-h3 ref2va plan fixture (the shape the story door's
    /// base template rides): slots inline, so no library index is needed.
    fn ref2va_plan(prompt: &str) -> IntentPlan {
        let extras: Map<String, Value> = serde_json::from_str(&format!(
            r#"{{
                "checkpoint": "minimax_h3/model.safetensors",
                "positivePrompt": "{prompt}",
                "outputPrefix": "agent/story",
                "videos": ["deas-input-fake-story.mp4"],
                "diffusion": {{
                    "textEncoder": "minimax_h3.safetensors",
                    "clipType": "minimax",
                    "vae": "h3_video_vae.safetensors"
                }},
                "h3": {{
                    "audioVae": "h3_audio_vae.safetensors",
                    "shiftVideo": 1.0,
                    "shiftAudio": 1.0
                }}
            }}"#
        ))
        .expect("fixture parses");
        fill_plane::fill(
            "minimax-h3",
            "ref2va",
            None,
            &DefaultsSheet::default(),
            Some(&extras),
        )
        .expect("the fixture fills")
        .plan()
    }

    /// A minted story row: ordinary accepted plan + the door's continuity
    /// stamp + the chain link (step 0 carries the prepared 64-hex and
    /// `sourceKind: "video"`, later steps carry the placeholder).
    fn story_row(step_index: usize, story_id: &str, prepared: &str) -> QueueRow {
        let mut row = QueueRow::from_plan(&ref2va_plan(&format!("story step {step_index}")))
            .expect("the plan is complete");
        let source_id = if step_index == 0 {
            prepared.to_owned()
        } else {
            STORY_SOURCE_PLACEHOLDER.to_owned()
        };
        let mut continuity = Map::new();
        continuity.insert("session".to_owned(), json!("story-session"));
        continuity.insert("sourceId".to_owned(), json!(source_id));
        if step_index == 0 {
            continuity.insert("sourceKind".to_owned(), json!("video"));
        }
        continuity.insert("capture".to_owned(), json!(step_index != 1));
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
        row.story_link = Some(StoryLink {
            story_id: story_id.to_owned(),
            session: "story-session".to_owned(),
            step_index,
            prepared_source: prepared.to_owned(),
        });
        row
    }

    #[test]
    fn the_story_link_round_trips_and_a_pre_story_row_loads_honest_none() {
        // The `job_id` growth discipline again: additive defaulted field, no
        // schema bump — a version-1 file that never heard of storyLink loads.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let prepared = "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34";
        let rows = vec![
            story_row(0, "story-1", prepared),
            story_row(1, "story-1", prepared),
        ];
        spool.append_story_rows(&rows).expect("the batch lands");
        let reopened = Spool::new(dir.path());
        let stored = reopened.snapshot().expect("healthy");
        assert_eq!(stored.len(), 2, "chain order is file order");
        assert_eq!(stored[0].story_link.as_ref().expect("link").step_index, 0);
        assert_eq!(stored[1].story_link.as_ref().expect("link").step_index, 1);
        assert_eq!(
            stored[0].story_link.as_ref().expect("link").prepared_source,
            prepared
        );
        let on_disk: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).expect("written"))
                .expect("valid json");
        assert_eq!(
            on_disk["rows"][0]["storyLink"]["storyId"], "story-1",
            "the wire word"
        );
        assert_eq!(QUEUE_VERSION, 1, "the growth needed no version bump");
        std::fs::write(
            dir.path().join(FILE),
            r#"{"version": 1, "rows": [{"id": "old-row", "createdAt": 1, "status": "done",
                "envelope": {}, "slots": {}, "extras": {}, "jobId": "stock-old"}]}"#,
        )
        .expect("fixture writes a pre-story row");
        let rows = spool.snapshot().expect("an old file is a healthy file");
        assert_eq!(rows[0].story_link, None, "unknown link is honest None");
    }

    #[test]
    fn the_story_batch_lands_in_chain_order_and_refuses_a_broken_shape() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let prepared = "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34";
        // Out of order: stepIndex must equal the position.
        let problem = spool
            .append_story_rows(&[
                story_row(1, "story-x", prepared),
                story_row(0, "story-x", prepared),
            ])
            .expect_err("the batch lands in chain order");
        assert!(problem.to_string().contains("chain order"), "{problem}");
        // Two stories in one batch: refused.
        let problem = spool
            .append_story_rows(&[
                story_row(0, "story-a", prepared),
                story_row(1, "story-b", prepared),
            ])
            .expect_err("one batch is one story");
        assert!(problem.to_string().contains("one story"), "{problem}");
        // No link: not a story batch.
        let problem = spool
            .append_story_rows(&[fixture_row("plain")])
            .expect_err("a story batch row carries a storyLink");
        assert!(problem.to_string().contains("storyLink"), "{problem}");
        // 17 steps and the empty batch: both refused by count.
        let problem = spool
            .append_story_rows(&[])
            .expect_err("an empty batch is refused");
        assert!(problem.to_string().contains("1..=16"), "{problem}");
        assert!(
            spool.snapshot().expect("healthy").is_empty(),
            "a refused batch writes nothing"
        );
    }

    #[test]
    fn the_story_cap_writes_no_partial_story() {
        // The atomism law: the cap counts the WHOLE batch; a refusal at the
        // boundary lands zero rows, never a story with its head and no tail.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        for index in 0..(CAP - 1) {
            spool
                .append(&fixture_row(&format!("live-{index}")))
                .unwrap_or_else(|problem| panic!("live row {index} lands: {problem}"));
        }
        let prepared = "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34";
        let refused = spool
            .append_story_rows(&[
                story_row(0, "story-cap", prepared),
                story_row(1, "story-cap", prepared),
            ])
            .expect_err("two rows do not fit beside one free seat");
        assert!(matches!(refused, AppendError::Full { live } if live == CAP - 1));
        assert_eq!(
            spool.snapshot().expect("healthy").len(),
            CAP - 1,
            "a refused batch writes nothing"
        );
    }

    #[test]
    fn an_unresolved_story_intent_is_refused_by_stock_compile_with_stock_words() {
        // DEFENSE IN DEPTH (mission duty 5): if resolution ever failed to run,
        // the '@story' placeholder is stock-illegal ON PURPOSE — the ordinary
        // compile entry (`jobs::compile`, the same entry the drain's prepare
        // rides) refuses it with the stock sentence before any render starts.
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::new(dir.path());
        let prepared = "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34";
        let row = story_row(1, "story-compile", prepared);
        spool.append(&row).expect("the row lands");
        let rebuilt = flat_intent(&row).expect("the row is drain-ready by construction");
        assert_eq!(
            rebuilt["h3"]["continuity"]["sourceId"], STORY_SOURCE_PLACEHOLDER,
            "the placeholder rides the rebuilt intent — resolution is what replaces it"
        );
        let problem =
            crate::jobs::compile(&rebuilt).expect_err("'@story' is outside the stock id alphabet");
        // The stock truth: validate_h3 folds the continuity arm into its GENERIC
        // sentence (the cont_ok arm feeds the big conditional) - the placeholder
        // is refused, and the exact words are whatever stock says, pinned here.
        assert!(
            problem.starts_with("Invalid h3:"),
            "the stock refusal words ride verbatim: {problem}"
        );
    }

    #[test]
    fn a_story_row_is_an_ordinary_video_row_except_for_the_link_and_the_placeholder() {
        // The differential pin (mission duty 3, spool side): the story arm is
        // NOT a flat_intent arm — the row rides the ordinary video rebuild.
        // Minted the same way as the door mints (probe fill of the same base),
        // the story row's flat intent equals the ordinary row's intent plus
        // the injected continuity, byte-for-byte.
        let prepared = "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34";
        let ordinary =
            QueueRow::from_plan(&ref2va_plan("story step 1")).expect("ordinary row builds");
        let ordinary_intent = flat_intent(&ordinary).expect("ordinary row is drain-ready");
        let story = story_row(1, "story-diff", prepared);
        let story_intent = flat_intent(&story).expect("story row is drain-ready");
        let mut expected = ordinary_intent.clone();
        expected["h3"]["continuity"] = story_intent["h3"]["continuity"].clone();
        // The seed is per-row door randomness (seedMode random mints a fresh
        // seed per plan), not a shape difference: normalize it out of the
        // byte-equality pin - everything else must match exactly.
        expected["seed"] = story_intent["seed"].clone();
        assert_eq!(
            serde_json::to_string(&expected).expect("serialize expected"),
            serde_json::to_string(&story_intent).expect("serialize story"),
            "the story row's flat intent is the ordinary intent plus the continuity block, nothing else"
        );
        assert!(ordinary_intent["h3"].get("continuity").is_none());
    }
}
