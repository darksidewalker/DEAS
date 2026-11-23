//! The result doors (API-DESIGN §4.4): the `/v1` retrieval-and-control surface over
//! the stock native job plane — job rows, one row's status, scoped cancel, whole
//! Workbench Stop, the manual free, the durable history read, one output preview,
//! the spool clear, and (LEG AF2-M25b) one H3 continuity session's clip read plus
//! one placed-video preparation.
//!
//! In-process law: every stock verb here is a DIRECT Rust call over the Tauri
//! managed states (the cycle.rs seam idiom — `app.state::<Jobs>()` handed to the
//! stock `native_*` command fns), never an IPC hop, never a re-implementation of a
//! stock law. State-gate semantics stay stock: the doors pick the scoped-cancellation
//! KIND from the row's state word and let `jobs_cancel.rs`/`jobs_stop.rs` own the
//! one-attempt bound, the submitting/polling refusal, the terminal no-mutation
//! snapshot and the 40 s deadline.
//!
//! Mapping law (manager-approved, closed taxonomy unchanged): a stock "Unknown
//! native job"/"Unknown native Workbench job"/"Unknown RefMod export" refusal answers
//! `jobUnknown`; the
//! outputs single-fetch gate refusal ("Another output fetch is in progress")
//! answers `laneFull` with the stock string verbatim in the hint; every other
//! stock refusal answers `maintenanceActive` with the stock string verbatim in the
//! hint — the plane never invents a word and never swallows a stock reason.
//!
//! `ResultsBridge` is the test seam (the scan.rs/uploads.rs idiom): production runs
//! the stock commands through the managed states; tests fake the plane without a
//! backend. The manual free does NOT grow its own seam: it drives ONE attempt over
//! the already-shipped [`super::cycle::BackendDoor::free`] the cycle machine uses,
//! so there is exactly one `/free` wire on the plane.

use futures_util::future::BoxFuture;
use serde_json::{json, Map, Value};

use super::cycle_view::CyclePhase;
use super::e16;
use super::errors::{ApiError, ErrorKind};
use super::fill_plane;
use super::PlaneState;
use axum::body;
use axum::extract::Request;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use futures_util::FutureExt as _;

/// The narrow consumed view of a fetched stock preview: the F2 accessor
/// (`OutputPreview::parts`) unpacked into owned fields so the fake bridge can
/// fabricate one without touching stock field visibility beyond the one approved
/// accessor.
pub(crate) struct OutputParts {
    pub(crate) job_id: String,
    pub(crate) index: usize,
    pub(crate) mime_type: &'static str,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) sha256: String,
    pub(crate) bytes: Vec<u8>,
}

/// The stock verbs the result doors need, boxed so one `dyn` seam covers the
/// synchronous reads and the asynchronous row drivers.
pub(crate) trait ResultsBridge: Send + Sync {
    /// The stock workbench listing verbatim (`workbench_current`): the `jobs[]`
    /// snapshots plus the capacity/epoch facts.
    fn workbench_current(&self) -> Result<Value, String>;
    /// The root session's current row snapshot; `Null` when no row is held (the
    /// stock `Session::snapshot` posture the UI's `job_current` reads).
    fn job_current(&self) -> Result<Value, String>;
    /// One row through the stock P6 row driver (`status_for`).
    fn job_status(&self, job_id: String) -> BoxFuture<'static, Result<Value, String>>;
    /// Scoped pending cancellation, agent-confirmed (the door call IS the operator
    /// intent; `confirmed: true` is never negotiable here).
    fn cancel_pending(&self, job_id: String) -> BoxFuture<'static, Result<Value, String>>;
    /// Scoped running interruption, agent-confirmed.
    fn interrupt_running(&self, job_id: String) -> BoxFuture<'static, Result<Value, String>>;
    /// Whole-Workbench Stop, agent-confirmed: THE `jobUnknown` remedy door (M9a).
    fn stop(&self) -> BoxFuture<'static, Result<Value, String>>;
    /// The durable native history view verbatim (read-only; the stock record cap
    /// and descriptor-word law ride the stock view itself).
    fn history(&self) -> Result<Value, String>;
    /// One output preview through the stock (job_id, index)-addressed fetch with
    /// its stock size/validation bounds.
    fn output(
        &self,
        job_id: String,
        index: usize,
    ) -> BoxFuture<'static, Result<OutputParts, String>>;
    /// One H3 continuity session's normalized clip view through the stock native
    /// read (`native_h3_session`, LEG AF2-M25b): read-only by stock law, it never
    /// mutates a session; the session grammar and the normalization stay one home
    /// stock-side.
    fn session(&self, session: String) -> BoxFuture<'static, Result<Value, String>>;
    /// One placed input video through the stock native preparation
    /// (`native_h3_video_prepare`, LEG AF2-M25b): the 64-hex sourceId view. Hash
    /// plus a bounded PyAV probe only — zero VRAM, so it is safe beside a live
    /// cycle and takes no plane gate; the native client owns the deadline.
    fn prepare(&self, filename: String) -> BoxFuture<'static, Result<Value, String>>;
}

/// Production bridge: the stock command fns called in-process over the managed
/// `Jobs` and `Engine` states (the cycle.rs `StockSubmitChain` idiom). The owners
/// `cancel`/`stop` need come from the managed engine's
/// `cancellation_owner()`/`interruption_owner()` exactly as the UI's calls receive
/// them — the plane mints no second authority.
pub(crate) struct StockResultsBridge {
    app: tauri::AppHandle,
}

impl StockResultsBridge {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl ResultsBridge for StockResultsBridge {
    fn workbench_current(&self) -> Result<Value, String> {
        use tauri::Manager as _;
        crate::jobs::native_workbench_current(self.app.state::<crate::jobs::Jobs>())
    }

    fn job_current(&self) -> Result<Value, String> {
        use tauri::Manager as _;
        crate::jobs::native_job_current(self.app.state::<crate::jobs::Jobs>())
    }

    fn job_status(&self, job_id: String) -> BoxFuture<'static, Result<Value, String>> {
        let app = self.app.clone();
        Box::pin(async move {
            use tauri::Manager as _;
            crate::jobs::native_job_status(app.state::<crate::jobs::Jobs>(), job_id).await
        })
    }

    fn cancel_pending(&self, job_id: String) -> BoxFuture<'static, Result<Value, String>> {
        let app = self.app.clone();
        Box::pin(async move {
            use tauri::Manager as _;
            crate::jobs::native_workbench_cancel_pending(
                app.state::<crate::jobs::Jobs>(),
                app.state::<crate::install::Engine>(),
                job_id,
                true,
            )
            .await
        })
    }

    fn interrupt_running(&self, job_id: String) -> BoxFuture<'static, Result<Value, String>> {
        let app = self.app.clone();
        Box::pin(async move {
            use tauri::Manager as _;
            crate::jobs::native_workbench_interrupt_running(
                app.state::<crate::jobs::Jobs>(),
                app.state::<crate::install::Engine>(),
                job_id,
                true,
            )
            .await
        })
    }

    fn stop(&self) -> BoxFuture<'static, Result<Value, String>> {
        let app = self.app.clone();
        Box::pin(async move {
            use tauri::Manager as _;
            crate::jobs::native_workbench_stop(
                app.state::<crate::jobs::Jobs>(),
                app.state::<crate::install::Engine>(),
                true,
            )
            .await
        })
    }

    fn history(&self) -> Result<Value, String> {
        use tauri::Manager as _;
        serde_json::to_value(crate::jobs::native_jobs_history(
            self.app.state::<crate::jobs::Jobs>(),
        ))
        .map_err(|problem| format!("history view is not serializable: {problem}"))
    }

    fn session(&self, session: String) -> BoxFuture<'static, Result<Value, String>> {
        let app = self.app.clone();
        Box::pin(async move { session_view(&app, session).await })
    }

    fn prepare(&self, filename: String) -> BoxFuture<'static, Result<Value, String>> {
        let app = self.app.clone();
        Box::pin(async move {
            // FAST read, no gate: the preparation is a hash and a PyAV probe
            // (zero VRAM), and the native client carries its own deadline.
            let base_url = endpoint_now(&app)?;
            crate::jobs::native_h3_video_prepare(base_url, filename).await
        })
    }

    fn output(
        &self,
        job_id: String,
        index: usize,
    ) -> BoxFuture<'static, Result<OutputParts, String>> {
        let app = self.app.clone();
        Box::pin(async move {
            use tauri::Manager as _;
            let preview =
                crate::jobs::native_job_output(app.state::<crate::jobs::Jobs>(), job_id, index)
                    .await?;
            let (part_job, part_index, mime_type, width, height, sha256, bytes) = preview.parts();
            Ok(OutputParts {
                job_id: part_job.to_owned(),
                index: part_index,
                mime_type,
                width,
                height,
                sha256: sha256.to_owned(),
                bytes: bytes.to_vec(),
            })
        })
    }
}

/// The running owned backend's base URL, honest when none runs (the refusal every
/// fast-read door maps to `maintenanceActive` with the string verbatim in the
/// hint). A plain fast read for the READ doors — the RefMod status/cancel arms and
/// the continuity session read and video preparation of LEG AF2-M25b: they must
/// answer honestly and immediately, never stand in the ready window. Only `submit`
/// gates (E29 — the law is a before-submit law).
fn endpoint_now(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager as _;
    let status = app.state::<crate::install::Engine>().backend.status();
    match (status.state.as_str(), status.endpoint) {
        ("running", Some(endpoint)) => Ok(endpoint),
        (state, _) => Err(format!("no owned backend is running (state '{state}')")),
    }
}

/// The stock continuity session read as ONE named leg (LEG AF2-M32 extraction,
/// visibility-only — the body is the shipped `StockResultsBridge::session` leg
/// verbatim): the FAST [`endpoint_now`] read (no gate, no ready-window wait — a
/// session read is not a submit, E29 is a before-submit law) plus the stock
/// `native_h3_session`. The §4.4 session door and the drain's story resolution
/// (cycle.rs `StockSessionReader`) ride THIS one leg, so the plane has one
/// session-read home: mid-drain the endpoint is up by construction, the read is
/// zero-VRAM and read-only (E20), and no new timer exists anywhere on it.
pub(crate) async fn session_view(app: &tauri::AppHandle, session: String) -> Result<Value, String> {
    let base_url = endpoint_now(app)?;
    crate::jobs::native_h3_session(base_url, session).await
}

// ── The RefMod creation seam (LEG M9e) ───────────────────────────────────────────

/// The Director *Create RefMod* verb the creation door needs, behind the same boxed
/// seam shape as [`ResultsBridge`] (the scan.rs/uploads.rs idiom): production runs the
/// stock native command in-process, a test fakes it with no backend and no card.
pub(crate) trait RefmodBridge: Send + Sync {
    /// Queue one isolated RefMod export through the stock native submit. Everything
    /// this plane must not duplicate stays stock: the H3 VAE lane fill, the graph
    /// compile, the `deas-refmod-<uuid>` client id, the ≤ 16 in-flight reservation and
    /// the reserve-before-POST law. The answer carries the backend `promptId` only.
    fn submit(&self, request: Value) -> BoxFuture<'static, Result<Value, String>>;

    /// One submitted export's posture through the stock native status: the history
    /// view when the backend has one, else the queue placement word, else `missing`.
    /// The stock `submitted()` law refuses an id this process never submitted with
    /// "Unknown RefMod export" — the closed `jobUnknown` cause. No list form exists
    /// stock-side, so this is a read of a known id only, never a row discovery.
    fn status(&self, prompt_id: String) -> BoxFuture<'static, Result<Value, String>>;

    /// Cancel one export through the stock scoped adapter: a pending row is deleted
    /// from the backend queue, a running row goes through the authenticated DEAS
    /// interrupt adapter (never core `/interrupt`). The stock `submitted()` law
    /// refuses an unknown id with the same "Unknown RefMod export" string. A prompt
    /// already gone from the queue answers `{"cancelled":"none"}`.
    fn cancel(&self, prompt_id: String) -> BoxFuture<'static, Result<Value, String>>;
}

/// Production bridge: `crate::jobs::native_h3_refmod_submit` called in-process (the fn
/// is `pub` and takes no `State`, so the only managed state it needs is the running
/// backend's endpoint — the uploads.rs/cycle.rs running-endpoint read, never a
/// hardcoded port). `models_dir` stays `None` on purpose: the stock submit resolves the
/// H3 VAE lanes from the backend's own `object_info/VAELoader` list first, and adding a
/// disk walk here would put a second model authority on the plane.
pub(crate) struct StockRefmodBridge {
    app: tauri::AppHandle,
}

impl StockRefmodBridge {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    /// The E29-gated base URL for the SUBMIT leg only: the RefMod export posts
    /// straight into that endpoint's `/prompt` queue, so it stands under the same
    /// "no submit before the readiness facts" ruling as a drain row (the old single
    /// status read here was the same W-L2 defect class). An expired window keeps the
    /// honest maintenance posture: the fault detail (last state word + stage +
    /// window) rides the hint verbatim, through the cycle's ONE gate home
    /// ([`super::cycle::ready_backend`]).
    async fn endpoint_gated(app: &tauri::AppHandle) -> Result<String, String> {
        use tauri::Manager as _;
        let engine = app.state::<crate::install::Engine>();
        let read_status = || {
            let status = engine.backend.status();
            async move { (status.state, status.endpoint) }
        };
        let liveness = super::cycle::StockQueueLiveness::new();
        super::cycle::ready_backend(
            read_status,
            &mut |base: String| liveness.probe(base),
            super::cycle::BACKEND_READY_POLL_MS,
            super::cycle::BACKEND_READY_TIMEOUT_MS,
        )
        .await
        .map(|base| base.into())
        .map_err(|fault| fault.detail())
    }
}

impl RefmodBridge for StockRefmodBridge {
    fn submit(&self, request: Value) -> BoxFuture<'static, Result<Value, String>> {
        let app = self.app.clone();
        Box::pin(async move {
            let base_url = Self::endpoint_gated(&app).await?;
            crate::jobs::native_h3_refmod_submit(base_url, request, None).await
        })
    }

    fn status(&self, prompt_id: String) -> BoxFuture<'static, Result<Value, String>> {
        let app = self.app.clone();
        Box::pin(async move {
            let base_url = endpoint_now(&app)?;
            crate::jobs::native_h3_refmod_status(base_url, prompt_id).await
        })
    }

    fn cancel(&self, prompt_id: String) -> BoxFuture<'static, Result<Value, String>> {
        let app = self.app.clone();
        Box::pin(async move {
            let base_url = endpoint_now(&app)?;
            // The stock command's `State<Engine>` arg is the same managed state
            // `Self::endpoint` already reads (the results.rs in-process idiom —
            // `app.state::<Jobs>()` handed straight to the native fn), so the cancel
            // adapter (cancellation_owner / interruption_owner) runs without an IPC hop.
            use tauri::Manager as _;
            crate::jobs::native_h3_refmod_cancel(
                app.state::<crate::install::Engine>(),
                base_url,
                prompt_id,
            )
            .await
        })
    }
}

/// The closed `conceptType` vocabulary, mirrored from `jobs_refmod::CONCEPTS` (five
/// words; nothing else compiles). A law-named test pins the five against that home.
/// `pub(crate)` from LEG AF2-M24c: the queue door's refmod-row grammar (fill_plane's
/// `fill_refmod` arm) reads the SAME five words — SINGLE-HOME LAW, one author per
/// grammar, never a restatement in two doors.
pub(crate) static REFMOD_CONCEPTS: [&str; 5] = ["generic", "identity", "style", "motion", "audio"];

/// The stock RefMod request field list (`jobs_refmod::compile`'s `known` array). An
/// unknown key is a stock refusal, so the door refuses it by the same cause instead of
/// letting the compiler's one sentence arrive over a POST.
static REFMOD_FIELDS: [&str; 7] = [
    "name",
    "description",
    "conceptType",
    "media",
    "refmods",
    "vae",
    "audioVae",
];

/// The stock description cap (`jobs_refmod::text(…, 4000)`), and the stock saved-RefMod
/// cap (`rows.len() > 8`) — the E16 `--refmod` fold enforces the same eight on the
/// shorthand side, so the door's wall mirrors stock, it is never the only guard.
const REFMOD_DESCRIPTION_CHARS: usize = 4_000;
const REFMOD_MAX_SAVED: usize = 8;

/// Body cap for `POST /v1/refmods`: a 4000-character description, twelve placed media
/// references and eight saved names cannot honestly exceed 64 KiB.
const MAX_REFMOD_BODY: usize = 64 * 1024;

/// A stock refusal that is not an unknown-row refusal: the plane passes the stock
/// string through verbatim under the honest maintenance word.
fn stock_fault(problem: String) -> ApiError {
    ApiError::new(ErrorKind::MaintenanceActive)
        .with_hint(format!("native job plane refused: {problem}"))
}

/// Whether a stock refusal string is the unknown-row shape (the stock "Unknown
/// native…" homes plus the RefMod home's "Unknown RefMod export"); such refusals
/// answer the closed `jobUnknown` word. A law-named test pins each prefix against
/// its stock source.
fn is_unknown_row(problem: &str) -> bool {
    problem.starts_with("Unknown native job")
        || problem.starts_with("Unknown native Workbench job")
        || problem.starts_with("Unknown RefMod export")
}

/// Maps a stock row-verb refusal to the closed taxonomy without inventing a word.
fn map_row_refusal(problem: String) -> ApiError {
    if is_unknown_row(&problem) {
        return ApiError::new(ErrorKind::JobUnknown).with_hint(format!(
            "{problem}; GET /v1/jobs lists the rows this plane may see"
        ));
    }
    stock_fault(problem)
}

/// Extracts one non-empty id segment from a template path, mirroring the
/// `queue_delete` law: exactly one segment, never empty, never spanning a slash.
fn path_segment<'a>(path: &'a str, prefix: &str, suffix: &str) -> Option<&'a str> {
    let rest = path.strip_prefix(prefix)?.strip_suffix(suffix)?;
    (!rest.is_empty() && !rest.contains('/')).then_some(rest)
}

/// The pure §4.4 row merge: workbench snapshots plus the root session row when one
/// is present, deduped by id (a row can be listed by only one home; the workbench
/// scan answered first). Rows without an id are dropped honestly — a snapshot the
/// plane cannot address is not a row.
pub(crate) fn merge_job_rows(workbench: &Value, current: Value) -> Vec<Value> {
    let mut rows: Vec<Value> = workbench["jobs"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row.is_object() && row.get("id").is_some())
        .collect();
    if let Value::Object(row) = current {
        let addressable = row.get("id").is_some();
        let fresh = row
            .get("id")
            .is_none_or(|id| !rows.iter().any(|held| held.get("id") == Some(id)));
        if addressable && fresh {
            rows.push(Value::Object(row));
        }
    }
    rows
}

/// `GET /v1/jobs` — the rows the agent may see: the stock workbench snapshots plus
/// the root session row (where the drain's rows live), deduped by id.
pub(crate) async fn jobs_list(State(state): State<PlaneState>) -> Result<Json<Value>, ApiError> {
    let workbench = state.results.workbench_current().map_err(stock_fault)?;
    let current = state.results.job_current().map_err(stock_fault)?;
    let rows = merge_job_rows(&workbench, current);
    Ok(Json(
        json!({ "ok": true, "count": rows.len(), "rows": rows }),
    ))
}

/// `GET /v1/jobs/{id}` — one row through the stock row driver; an unknown id
/// answers the closed `jobUnknown` word (503 per the errors.rs single home).
pub(crate) async fn job_status(
    State(state): State<PlaneState>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let Some(id) = path_segment(request.uri().path(), "/v1/jobs/", "") else {
        return Err(ApiError::new(ErrorKind::RouteNotFound)
            .with_hint("GET /v1/jobs/{id} takes exactly one row id segment"));
    };
    match state.results.job_status(id.to_owned()).await {
        Ok(row) => Ok(Json(json!({ "ok": true, "row": row }))),
        Err(problem) => Err(map_row_refusal(problem)),
    }
}

/// `POST /v1/jobs/{id}/cancel` — the scoped cancel door. The door picks the KIND
/// from the row's state word (queued → pending-cancel, running → interrupt); every
/// other word stays with the stock pending path, whose gates are the law:
/// submitting/polling refuses, terminal answers the snapshot without mutation,
/// one attempt per kind, a blown 40 s bound lands `unknown`. The call itself is
/// the explicit confirmation (`confirmed: true`); the answer is the stock snapshot.
pub(crate) async fn job_cancel(
    State(state): State<PlaneState>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let Some(id) = path_segment(request.uri().path(), "/v1/jobs/", "/cancel") else {
        return Err(ApiError::new(ErrorKind::RouteNotFound).with_hint(
            "POST /v1/jobs/{id}/cancel takes exactly one row id segment before /cancel",
        ));
    };
    let before = state
        .results
        .job_status(id.to_owned())
        .await
        .map_err(map_row_refusal)?;
    let id = id.to_owned();
    let snapshot = if before["state"].as_str() == Some("running") {
        state.results.interrupt_running(id.clone()).await
    } else {
        state.results.cancel_pending(id.clone()).await
    };
    match snapshot {
        Ok(snapshot) => Ok(Json(json!({ "ok": true, "id": id, "snapshot": snapshot }))),
        Err(problem) => Err(map_row_refusal(problem)),
    }
}

/// `POST /v1/stop` — the whole-Workbench Stop through the stock driver, confirmed
/// by the call itself. This is the `jobUnknown` remedy door the M9a drain law
/// names: it clears held rows a drain cannot correlate. Bodyless POST (the
/// watchdog-sever idiom): the call itself is the confirmation.
pub(crate) async fn stop(State(state): State<PlaneState>) -> Result<Json<Value>, ApiError> {
    match state.results.stop().await {
        Ok(view) => Ok(Json(json!({ "ok": true, "stop": view }))),
        Err(problem) => Err(map_row_refusal(problem)),
    }
}

/// `POST /v1/free` — the manual free: ONE attempt over the shipped
/// `BackendDoor::free` wire, refused while a cycle owns the card (the
/// settings_bridge mid-cycle law, same fact `GET /v1/cycle` answers). No retry
/// loop lives here — the bound belongs to the machine.
pub(crate) async fn free(State(state): State<PlaneState>) -> Result<Json<Value>, ApiError> {
    let live = state.cycle.live();
    if live.phase != CyclePhase::Idle {
        return Err(ApiError::new(ErrorKind::CycleInFlight).with_hint(format!(
            "a VRAM cycle is live (phase '{}', cycle '{}'); the manual free is refused until the cycle answers idle",
            super::cycle::phase_word(live.phase),
            live.cycle_id.clone().unwrap_or_default(),
        )));
    }
    // The exact stock two-key body (cycle.rs free_leg idiom).
    let body = json!({ "unload_models": true, "free_memory": true });
    match state.cycle_seams.door.free(body).await {
        Ok(()) => Ok(Json(json!({ "ok": true, "freed": true }))),
        Err(problem) if problem.starts_with("no owned backend is running") => Err(ApiError::new(
            ErrorKind::MaintenanceActive,
        )
        .with_hint(format!(
            "the manual free found no running backend: {problem}"
        ))),
        Err(problem) => Err(ApiError::new(ErrorKind::HandoffFailed)
            .with_hint(format!("the release wire did not acknowledge: {problem}"))),
    }
}

/// `GET /v1/history` — the durable native history view passed through verbatim:
/// the stock record cap, descriptor words and read-only posture ride the stock
/// view; the plane never expands a path and never re-validates a record.
pub(crate) async fn history(State(state): State<PlaneState>) -> Result<Json<Value>, ApiError> {
    let view = state.results.history().map_err(stock_fault)?;
    Ok(Json(json!({ "ok": true, "history": view })))
}

/// The stock single-fetch-gate refusal string, verbatim (jobs_outputs.rs).
const OUTPUT_FETCH_GATE: &str = "Another output fetch is in progress";

/// `GET /v1/outputs/{id}/{index}` — one output preview through the stock fetch.
/// The answer is JSON `{ok, jobId, index, mimeType, width, height, sha256,
/// bytesBase64}`: the base64 field is additive over the stock preview descriptors;
/// the stock PNG/FLAC size bounds and validation refusals pass through honestly,
/// and the stock single-fetch gate answers `laneFull` (429) with the stock string
/// verbatim in the hint (manager-approved mapping; closed taxonomy unchanged).
pub(crate) async fn output(
    State(state): State<PlaneState>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let Some(rest) = request.uri().path().strip_prefix("/v1/outputs/") else {
        return Err(ApiError::new(ErrorKind::RouteNotFound)
            .with_hint("GET /v1/outputs/{id}/{index} takes one row id and one index segment"));
    };
    let Some((id, index)) = rest.split_once('/') else {
        return Err(ApiError::new(ErrorKind::RouteNotFound)
            .with_hint("GET /v1/outputs/{id}/{index} takes one row id and one index segment"));
    };
    let Some(index) = (!id.is_empty() && !id.contains('/'))
        .then(|| index.parse::<usize>().ok())
        .flatten()
    else {
        return Err(ApiError::new(ErrorKind::RouteNotFound).with_hint(
            "the outputs path takes exactly one row id segment and one numeric index segment",
        ));
    };
    match state.results.output(id.to_owned(), index).await {
        Ok(parts) => {
            // The preview door grows the config leg of `min(configured, stock
            // ceilings)` (LEG MEDIA-1): the stock fetch already refuses past the
            // stock ceilings (jobs_outputs PNG/DECODE/FLAC limits) and those
            // refusals ride through verbatim; `caps.downloadSingleMiB` bites
            // FIRST only when it is the smaller number, answering the 409
            // capExceeded restate (the bytes are already inside the process —
            // the remedy is the guard-file cap, not a smaller fetch).
            let caps = super::caps::resolve(&state.app_data)?;
            let cap_bytes = super::caps::Caps::bytes(caps.download_single_mib);
            if parts.bytes.len() as u64 > cap_bytes {
                return Err(ApiError::new(ErrorKind::CapExceeded)
                    .with_hint(format!(
                        "the preview is {} bytes at the {} MiB configured download cap (the stock ceilings stay the outer wall); raise caps.downloadSingleMiB in the guard file or read the file through GET /v1/files/outputs/... instead of base64",
                        parts.bytes.len(),
                        caps.download_single_mib,
                    ))
                    .with_status(axum::http::StatusCode::CONFLICT));
            }
            let encoded = BASE64_STANDARD.encode(&parts.bytes);
            Ok(Json(json!({
                "ok": true,
                "jobId": parts.job_id,
                "index": parts.index,
                "mimeType": parts.mime_type,
                "width": parts.width,
                "height": parts.height,
                "sha256": parts.sha256,
                "bytesBase64": encoded,
            })))
        }
        Err(problem) if problem == OUTPUT_FETCH_GATE => Err(
            ApiError::new(ErrorKind::LaneFull).with_hint(format!(
                "{OUTPUT_FETCH_GATE}; the stock plane fetches one output at a time; retry after the in-flight fetch answers"
            )),
        ),
        Err(problem) => Err(map_row_refusal(problem)),
    }
}

/// `POST /v1/queue/clear` — flip every still-queued spool row to cancelled in one
/// gated rewrite; draining and terminal rows are the drain's and stay untouched.
/// Legal in any cycle phase: rows outside a claimed batch are not in flight.
pub(crate) async fn queue_clear(State(state): State<PlaneState>) -> Result<Json<Value>, ApiError> {
    let cleared = state.spool.clear_queued().map_err(|problem| {
        ApiError::new(ErrorKind::MaintenanceActive).with_hint(format!(
            "queue spool write failed; operator attention required: {problem}"
        ))
    })?;
    Ok(Json(json!({ "ok": true, "cleared": cleared })))
}

/// `POST /v1/refmods` — the RefMod creation door (LEG M9e): one Director *Create
/// RefMod* export, submitted in-process through the stock native command.
///
/// Why a door and not a mode word: a RefMod export is never a Workbench job (stock
/// `jobs_refmod` states it outright — it cannot enter generation history, the queue
/// view or Stop all). It gets its own backend `client_id` and its own ≤ 16 in-flight
/// reservation, both stock-side, so it never becomes a spool row and never rides the
/// cycle. `mode: "refmod"` in the generation vocabulary still means *use* a RefMod in a
/// generation job, and that leg stays unbuilt; creating one lives here.
///
/// Body: the E16 surface, folded exactly as `POST /v1/queue` folds it —
/// `{name?, description?, conceptType?, pictureN/audioN/videoN or images/videos/audio,
/// --refmod "a,b" or refmods:[rows], vae?, audioVae?}`. Media rows come from
/// [`fill_plane::lane_media_items`], the same single home the REF2VA arm builds from
/// (so the placement law and the lane/slot grammar have one author), and the saved bag
/// becomes the stock bare-name list by reading each folded row's `name` — the manager
/// call for this leg: `--refmod` folds to `{slot,name,strength}` rows for the h3 modes,
/// this door wants names, and a bare string entry is accepted too.
///
/// Two facts a reader must not misread:
///
/// * **The drain cannot see this work.** A running RefMod export never appears in
///   `Jobs::active_job_ids` (it is not a Workbench job), so the M9a correlation gate
///   and the `jobUnknown` law ignore it by construction: nothing here refuses a drain
///   because an export is live, and `POST /v1/stop` cannot cancel one. The card-physics
///   proof stays window-side — the cycle owns the card, the stock submit posts into the
///   backend's own queue.
/// * **Mid-cycle it is refused anyway**, by the fact `/free` and the settings bridge
///   already state: the stock submit takes no plane compute gate, so an export beside a
///   live cycle would be an unaccounted prompt. `cycleInFlight` is the existing word.
///   The two closure doors (LEG M9e-close) state the same honesty: `GET
///   /v1/refmods/{id}` and `POST /v1/refmods/{id}/cancel` take no plane gate either —
///   both touch only the backend's own queue and history, never the Workbench, so the
///   drain law neither sees nor blocks them.
///
/// M9e's own "one export's later posture is not served this leg" sentence and its
/// "`POST /v1/stop` cannot cancel one" claim are superseded below by
/// [`refmod_status`] and [`refmod_cancel`]: an export stays invisible to the row doors
/// and to Stop (it is never a Workbench row), but its posture and its cancel now ride
/// the refmod-keyed doors by the backend prompt id the creation answer carries.
pub(crate) async fn refmod_create(
    State(state): State<PlaneState>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let bytes = body::to_bytes(request.into_body(), MAX_REFMOD_BODY)
        .await
        .map_err(|error| {
            invalid(format!(
                "body unreadable or over {MAX_REFMOD_BODY} bytes: {error}"
            ))
        })?;
    let mut body: Map<String, Value> = serde_json::from_slice(&bytes).map_err(|error| {
        invalid(format!(
            "body must be a JSON object: name?, description?, conceptType?, the reference arrays, refmods[], vae?, audioVae?: {error}"
        ))
    })?;
    // One E16 surface, one fold: numbered aliases into the canonical arrays, the caps
    // wall, `--refmod` into rows, then the E24 placement containment law (LEG AF2-M19a)
    // that rewrites a local-path reference to a placed input name — only when it already
    // lives under the engine's input or output folder (the law is `e16`'s single home,
    // never restated here), over the same two roots every other fs door reads.
    e16::fold(&mut body)?;
    e16::place_references(
        &mut body,
        state.input_root().as_deref(),
        state.output_root().as_deref(),
    )?;
    for key in body.keys() {
        let known = REFMOD_FIELDS.contains(&key.as_str())
            || e16::REFERENCE_KEYS
                .iter()
                .any(|(array, _)| *array == key.as_str());
        if !known {
            return Err(invalid(format!(
                "unknown RefMod request field '{key}'; the closed set is {} plus the reference arrays",
                REFMOD_FIELDS.join(", ")
            )));
        }
    }
    check_refmod_word_walls(&body)?;
    // The mid-cycle law `/free` already states: same fact `GET /v1/cycle` answers.
    let live = state.cycle.live();
    if live.phase != CyclePhase::Idle {
        return Err(ApiError::new(ErrorKind::CycleInFlight).with_hint(format!(
            "a VRAM cycle is live (phase '{}', cycle '{}'); a RefMod export posts straight into the backend queue, so it is refused until the cycle answers idle",
            super::cycle::phase_word(live.phase),
            live.cycle_id.clone().unwrap_or_default(),
        )));
    }
    let export = build_refmod_export(&body)?;
    match state.refmods.submit(export).await {
        Ok(answer) => Ok(Json(json!({
            // The id is a BACKEND prompt id, not a Workbench job id: the §4.4 row
            // doors answer `jobUnknown` for it, by construction (see above); the
            // refmod-keyed doors ([`refmod_status`], [`refmod_cancel`]) are its home.
            "ok": true,
            "refmodId": answer["promptId"].clone(),
            // The stock submit answer carries `promptId` only, so `queued` is the
            // honest placement fact — the export prompt was accepted into the backend
            // queue — not a polled state word. Later posture rides `GET
            // /v1/refmods/{id}` (the stock status verb by this same id); the stock
            // verb still has no list form, so this id is the only way in.
            "status": "queued",
        }))),
        Err(problem) => Err(stock_fault(problem)),
    }
}

/// `GET /v1/refmods/{id}` — one export's posture by its backend prompt id (LEG
/// M9e-close): the stock `native_h3_refmod_status` value passed through verbatim
/// (`{state, result?, error?}` — the detail words are stock INFO/ERR log strings
/// already, so the plane expands no path and re-validates nothing). The stock
/// `submitted()` law refuses an id this process never submitted; that string is the
/// closed `jobUnknown` cause, the hint naming the id. There is no list form stock-side,
/// so the creation answer's id is the only way in — an honest gap, not an omission.
pub(crate) async fn refmod_status(
    State(state): State<PlaneState>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let Some(id) = path_segment(request.uri().path(), "/v1/refmods/", "") else {
        return Err(ApiError::new(ErrorKind::RouteNotFound)
            .with_hint("GET /v1/refmods/{id} takes exactly one prompt id segment"));
    };
    match state.refmods.status(id.to_owned()).await {
        Ok(refmod) => Ok(Json(json!({ "ok": true, "refmod": refmod }))),
        Err(problem) => Err(refmod_unknown(problem, id)),
    }
}

/// `POST /v1/refmods/{id}/cancel` — cancel one export through the stock scoped
/// adapter (LEG M9e-close): a pending row is deleted from the backend's own queue,
/// a running row goes through the authenticated DEAS interrupt adapter (never core
/// `/interrupt`). The answer passes the stock shape verbatim: `{cancelled: "queued"|
/// "running"}` is the adapter's placement word — never a completion claim — and
/// `{cancelled: "none"}` is honest for a prompt already gone from the queue. The stock
/// `submitted()` law refuses an unknown id; same `jobUnknown` mapping. The same
/// drain-law honesty as the status door: this fn touches only the backend queue — it
/// is not a Workbench row, takes no plane compute gate, and `POST /v1/stop` still
/// cannot reach it.
pub(crate) async fn refmod_cancel(
    State(state): State<PlaneState>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let Some(id) = path_segment(request.uri().path(), "/v1/refmods/", "/cancel") else {
        return Err(ApiError::new(ErrorKind::RouteNotFound).with_hint(
            "POST /v1/refmods/{id}/cancel takes exactly one prompt id segment before /cancel",
        ));
    };
    match state.refmods.cancel(id.to_owned()).await {
        Ok(cancelled) => Ok(Json(
            json!({ "ok": true, "cancelled": cancelled["cancelled"].clone() }),
        )),
        Err(problem) => Err(refmod_unknown(problem, id)),
    }
}

/// Maps a RefMod row-verb refusal: the stock unknown-export string answers the closed
/// `jobUnknown` word with the id named in the hint; everything else rides
/// [`stock_fault`] verbatim.
fn refmod_unknown(problem: String, id: &str) -> ApiError {
    if is_unknown_row(&problem) {
        return ApiError::new(ErrorKind::JobUnknown).with_hint(format!(
            "{problem}: '{id}' is not a RefMod export this plane submitted (the creation answer's promptId is the only key; there is no list form)"
        ));
    }
    stock_fault(problem)
}

/* -------- THE SHARED REFMOD EXPORT GRAMMAR (SINGLE-HOME LAW, LEG AF2-M24c) --------

The `POST /v1/refmods` creation door and the `POST /v1/queue` mode-`refmod` row
(fill_plane's `fill_refmod` arm, E28/manager ruling 1-4) validate the SAME request
grammar and build the SAME closed export map. Where the two doors need identical
grammar the grammar lives HERE, once — restating a wall in both doors is the drift
the M24b `REFMOD_FIELDS == REFMOD_EXPORT_KEYS` pin exists to catch; these fns are
that pin's runtime half. None of this changes what the creation door answers: the
helpers hold its shipped sentences verbatim (pinned by the refmod door tests in
this file and in transport.rs, which this leg left unmodified).
*/

/// The `conceptType` vocabulary wall and the description cap wall, over any folded
/// body carrying the keys. Both doors read the same five words and the same 4000.
///
/// # Errors
///
/// `bodyInvalid` naming the vocabulary or the cap, verbatim from the creation door.
pub(crate) fn check_refmod_word_walls(body: &Map<String, Value>) -> Result<(), ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    if body.get("conceptType").is_some_and(|word| {
        !word
            .as_str()
            .is_some_and(|word| REFMOD_CONCEPTS.contains(&word))
    }) {
        return Err(invalid(format!(
            "conceptType must be one of {}",
            REFMOD_CONCEPTS.join("|")
        )));
    }
    if body
        .get("description")
        .and_then(Value::as_str)
        .is_some_and(|text| text.chars().count() > REFMOD_DESCRIPTION_CHARS)
    {
        return Err(invalid(format!(
            "description: at most {REFMOD_DESCRIPTION_CHARS} characters"
        )));
    }
    Ok(())
}

/// Folds the `refmods` bag to the stock bare-name list — a bare string entry or a
/// `{name, ...}` row (the shape the E16 `--refmod` shorthand mints) becomes its
/// name; an empty name is refused. Then the stock caps: at most eight saved names,
/// every one passing the stock model grammar. One fold for both doors (manager
/// ruling for M9e, widened by M24c to the queue row): the creation door reads the
/// folded `--refmod` rows down to names, and the queue arm must read them the same
/// way or the two doors drift.
///
/// # Errors
///
/// `bodyInvalid` for a non-array bag, the eight-name cap, or a name the stock
/// grammar refuses.
pub(crate) fn fold_saved_refmods(body: &Map<String, Value>) -> Result<Vec<String>, ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let saved: Vec<String> = match body.get("refmods") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(rows)) => rows
            .iter()
            .map(|row| match row {
                Value::String(name) => name.to_owned(),
                Value::Object(object) => object
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                _ => String::new(),
            })
            .collect(),
        Some(_) => {
            return Err(invalid(
                "refmods must be an array of saved RefMod library names (or --refmod \"a,b\")"
                    .to_owned(),
            ));
        }
    };
    if saved.len() > REFMOD_MAX_SAVED {
        return Err(invalid(format!(
            "a RefMod export carries at most {REFMOD_MAX_SAVED} saved RefMods (the stock cap)"
        )));
    }
    if saved
        .iter()
        .any(|name| name.is_empty() || !crate::jobs::model_name(name))
    {
        return Err(invalid(
            "every saved RefMod must be a library name the stock model grammar accepts".to_owned(),
        ));
    }
    Ok(saved)
}

/// Builds the closed export map from a folded/placed body — the exact
/// `jobs_refmod::compile`-shaped request [`super::spool::Spool::append_refmod_row`]
/// takes and [`super::spool::flat_intent`] round-trips byte-equal. One home for the
/// whole build leg both doors share: read the E16 reference arrays
/// ([`reference_names`]), mint the Director rows ([`fill_plane::lane_media_items`],
/// the one media-row home), fold the saved bag ([`fold_saved_refmods`]), hold the
/// at-least-one wall, then assemble. The five optional scalars ride the body
/// VERBATIM when the request carried them; the reference arrays never ride raw —
/// the client sends references, the door mints the media rows. The at-least-one
/// wall is door-side so the mistake bounces as a refusal, never as
/// `prepareRefused` poison fuel (stock compile holds the same wall at submit; the
/// spool helper holds it again as envelope-shape defense).
///
/// # Errors
///
/// `bodyInvalid`: a malformed reference array entry, a refused saved name, or both
/// the reference arrays and the saved bag empty.
pub(crate) fn build_refmod_export(body: &Map<String, Value>) -> Result<Value, ApiError> {
    let saved = fold_saved_refmods(body)?;
    // The refmod door keeps STRING-only reference arrays (owner ruling): an
    // entry object refuses at `reference_names`. The plain names become plain
    // entries so both doors share the one `lane_media_items` row home.
    let images = reference_names(body, "images")?;
    let videos: Vec<fill_plane::RefEntry> = reference_names(body, "videos")?
        .into_iter()
        .map(fill_plane::plain_entry)
        .collect();
    let audio: Vec<fill_plane::RefEntry> = reference_names(body, "audio")?
        .into_iter()
        .map(fill_plane::plain_entry)
        .collect();
    let media = fill_plane::lane_media_items(&images, &videos, &audio)?;
    if saved.is_empty() && images.is_empty() && videos.is_empty() && audio.is_empty() {
        return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(
            "a RefMod export needs at least one reference (images/videos/audio, or pictureN/videoN/audioN aliases) or one saved RefMod name".to_owned(),
        ));
    }
    let mut export = Map::new();
    for key in ["name", "description", "conceptType", "vae", "audioVae"] {
        if let Some(value) = body.get(key) {
            export.insert(key.to_owned(), value.clone());
        }
    }
    export.insert("media".to_owned(), media);
    export.insert(
        "refmods".to_owned(),
        Value::Array(saved.into_iter().map(Value::String).collect()),
    );
    Ok(Value::Object(export))
}

/// Reads one canonical reference array of the E16 surface into its strings. `e16::fold`
/// has already refused anything that is not an array of non-empty strings, so this only
/// extracts.
fn reference_names(body: &Map<String, Value>, key: &str) -> Result<Vec<String>, ApiError> {
    let Some(items) = body.get(key).map(|value| value.as_array().cloned()) else {
        return Ok(Vec::new());
    };
    let items = items.ok_or_else(|| {
        ApiError::new(ErrorKind::BodyInvalid)
            .with_hint(format!("'{key}' must be an array of reference strings"))
    })?;
    items
        .iter()
        .map(|item| {
            item.as_str().map(str::to_owned).ok_or_else(|| {
                ApiError::new(ErrorKind::BodyInvalid)
                    .with_hint(format!("every '{key}' entry must be a reference string"))
            })
        })
        .collect()
}

// ── The continuity read/prepare doors (LEG AF2-M25b, M25 gaps b+c) ───────────────

/// The session grammar at the door, MIRRORING — never replacing — the stock wall:
/// `native_h3_session` re-validates through `jobs_video::continuity_id` (the id
/// alphabet's single home), and the h3.continuity row law (`validate_continuity`)
/// holds the same grammar for the queue side. This wall only bounces a malformed
/// id before an endpoint hop exists, carrying the native's own refusal words
/// ("Invalid continuity session") and naming the grammar; `_imports` is the
/// imports folder, never a session — the same exclusion the row law states.
/// `pub(crate)` since LEG AF2-M32 (visibility-only, the M15/M25a precedent): the
/// story door (`routes.rs::video_story`) reads the SAME mirrored sentence for its
/// `session` field — one home for the mirror, never a second copy of it.
pub(crate) fn session_wall(session: &str) -> Result<(), ApiError> {
    if !crate::jobs_video::continuity_id(session) || session == "_imports" {
        return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "Invalid continuity session: '{session}' is not a continuity id (alphanumeric, '-', '_', at most 80 bytes, never '_imports' — that name is the imports folder, not a session)"
        )));
    }
    Ok(())
}

/// `GET /v1/sessions/{id}` — one H3 continuity session's clips through the stock
/// native read (LEG AF2-M25b): `native_h3_session`'s normalized view passed through
/// verbatim (`{latestId, clips[]}` — the clip descriptors and the importedVideo
/// provenance arm are the stock shape; the plane expands no path and re-validates
/// nothing, matching the refmod status door's posture). READ-ONLY by stock law:
/// the native GETs `df_h3_continuity/session/{id}` and never mutates; the plane
/// writes no file (E20) and never starts or stops the backend (E27). No E29 gate:
/// a read of the backend's own clip store is not a submit, so the FAST
/// [`endpoint_now`] read answers honestly or refuses `maintenanceActive` with the
/// stock string verbatim (the mapping law above).
pub(crate) async fn session_get(
    State(state): State<PlaneState>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let Some(session) = path_segment(request.uri().path(), "/v1/sessions/", "") else {
        return Err(ApiError::new(ErrorKind::RouteNotFound)
            .with_hint("GET /v1/sessions/{id} takes exactly one session id segment"));
    };
    session_wall(session)?;
    match state.results.session(session.to_owned()).await {
        Ok(view) => Ok(Json(json!({ "ok": true, "session": view }))),
        Err(problem) => Err(stock_fault(problem)),
    }
}

/// Body cap for `POST /v1/videos/prepare`: a placement name at the stock 4096-byte
/// ceiling cannot honestly exceed 8 KiB of JSON.
const MAX_PREPARE_BODY: usize = 8 * 1024;

/// The stock filename ceiling (`native_h3_video_prepare`, jobs.rs — mirrored, not
/// restated authority). A law-named test pins the number against the native source.
const PREPARE_MAX_NAME_BYTES: usize = 4_096;

/// The placement-name wall at the door, mirroring `native_h3_video_prepare`'s
/// filename wall (jobs.rs — the conditions verbatim: non-empty, at most 4096
/// bytes, no control chars, no backslash or colon, no empty/./.. segment, never
/// ending in "[output]"/"[temp]"). The native stays the single grammar home and
/// re-checks on its own leg; this wall only bounces a bad name before an endpoint
/// hop exists. The door then adds its OWN narrower root law: the native would
/// accept a subfolder path, but the uploads plane never mints one for video —
/// videos land at the input ROOT as `deas-input-<uuid>.<ext>` because core
/// `LoadVideo` lists top-level input files only (uploads.rs placement law), and
/// `deas-inputs/` is the images subfolder: a name under it is the wrong
/// placement for this door, and the refusal says so.
fn prepare_name_wall(name: &str) -> Result<(), ApiError> {
    let invalid = ApiError::new(ErrorKind::BodyInvalid);
    if name.is_empty()
        || name.len() > PREPARE_MAX_NAME_BYTES
        || name.chars().any(|c| c.is_control() || "\\:".contains(c))
        || name
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        || ["[output]", "[temp]"]
            .iter()
            .any(|marker| name.trim_end().ends_with(marker))
    {
        return Err(invalid.with_hint(format!(
            "Invalid input-relative video filename: '{name}'; the file must be a video placed at the input ROOT by POST /v1/uploads (videos land as deas-input-<uuid>.<ext> at the root; 'deas-inputs/' is the images subfolder and is the wrong placement here — LoadVideo lists top-level input files only)"
        )));
    }
    if name.contains('/') {
        return Err(invalid.with_hint(format!(
            "'{name}' is not an input-ROOT placement: this door prepares ROOT names only (the uploads law lands videos at the input root as deas-input-<uuid>.<ext>; 'deas-inputs/' is the images subfolder); use the placement name the upload answer reports"
        )));
    }
    Ok(())
}

/// `POST /v1/videos/prepare` — turn one placed input video into the 64-hex
/// `sourceId` an `h3.continuity` row names (LEG AF2-M25b): the stock
/// `native_h3_video_prepare` leg verbatim, and its normalized source view
/// `{sourceId, filename, sha256, width, height, fps, seconds, hasAudio}` passed
/// through under the plane's object posture with a `nextMove` naming the
/// follow-up. NO E29 gate and no `cycleInFlight` wall: preparation is a
/// double-hash plus a PyAV probe backend-side — ZERO VRAM, safe beside a live
/// cycle — and E29 is a before-submit law. The handler runs in the Control lane
/// (max 2) and grows no timeout machinery: the native client already carries the
/// 180 s deadline for the double-hash — the deadline home is the native.
/// Every native refusal — endpoint/transport failures and malformed backend
/// answers like "Malformed video preparation response" — keeps the honest
/// `maintenanceActive` word with the stock string verbatim (the mapping law
/// above); the door mints no `bodyInvalid` past its own walls.
pub(crate) async fn video_prepare(
    State(state): State<PlaneState>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let bytes = body::to_bytes(request.into_body(), MAX_PREPARE_BODY)
        .await
        .map_err(|error| {
            invalid(format!(
                "body unreadable or over {MAX_PREPARE_BODY} bytes: {error}"
            ))
        })?;
    let body: Map<String, Value> = serde_json::from_slice(&bytes).map_err(|error| {
        invalid(format!(
            "the prepare body is closed to the single key \"file\" (a placed input name): {error}"
        ))
    })?;
    if body.len() != 1 || !body.contains_key("file") {
        let seen: Vec<&str> = body.keys().map(String::as_str).collect();
        return Err(invalid(format!(
            "the prepare body is closed to the single \"file\" key; keys seen: {}",
            seen.join(", ")
        )));
    }
    let Some(name) = body.get("file").and_then(Value::as_str) else {
        return Err(invalid(
            "\"file\" must be a placed input ROOT name (a string)".to_owned(),
        ));
    };
    prepare_name_wall(name)?;
    match state.results.prepare(name.to_owned()).await {
        Ok(prepared) => Ok(Json(json!({
            "ok": true,
            "prepared": prepared,
            "nextMove": "use the 64-hex sourceId on a queued row: h3.continuity {sourceId, sourceKind: \"video\", session, capture, action, outputMode} (POST /v1/queue); GET /v1/sessions/{session} reads the clips that session already holds",
        }))),
        Err(problem) => Err(stock_fault(problem)),
    }
}

// ── The join door (LEG AF2-M31, H3-continuity closure) ──────────────────────────

/// Body cap for `POST /v1/videos/join`: 100 ids (or media rows) at the stock
/// ceilings - a continuity id is <= 80 bytes, a join `filename` <= 1024 - cannot
/// honestly exceed 64 KiB of JSON; the stock law that actually binds is
/// `jobs_video::validate_join`'s 64 KiB `assembly_data` budget, measured over the
/// BUILT rows at the wall below.
const MAX_JOIN_BODY: usize = 64 * 1024;

/// The door body's CLOSED key set (E26 kin): the two arms' keys exactly as the
/// pinned stock UI intent shape carries them - `H3JoinIntentV1`
/// (`src/lib/videoIntent.ts`, the plan the stock `join()` consumes): camel-case
/// wire throughout (`copyVideo`, `smoothAudioSeams`, `filenamePrefix`,
/// `trimStart`/`trimEnd` inside a files row; `recipeId`/`version` are the door's
/// own assembly, never body keys). The SNAKE-case words (`copy_video`,
/// `audio_policy`, `trim_start`, `repair_transitions`) are the COMPILED
/// `assembly_data` shape `join()` emits for the pack - they never appear on this
/// wire. Unknown keys refuse BY NAME at the door (the M27 zero-key / M30
/// unknown-keys idiom); stock `join()` itself never refused unknown keys inside
/// the join block, so this wall is the door's own and names the closed set.
const JOIN_BODY_KEYS: [&str; 7] = [
    "kind",
    "session",
    "chain",
    "files",
    "copyVideo",
    "smoothAudioSeams",
    "filenamePrefix",
];

/// `POST /v1/videos/join` - assemble one H3 continuity session's clips (or placed
/// input files) into ONE joined video (LEG AF2-M31, the final cut of the M25b
/// chain: prepare -> continuity rows -> session read -> join). The door mints no
/// grammar of its own: the body's closed-shape wall runs first (refusing an
/// unknown key BY NAME), then the assembled stock intent rides
/// `crate::jobs_video::validate_join` - the ONE home of the join law (AF2-M31
/// extraction of `jobs_video::join`'s validation half, the M25a
/// `validate_continuity` precedent) - so a grammar-bad body answers `bodyInvalid`
/// at the door NAMING THE STOCK WORDS ("Invalid h3.join.session",
/// "h3.join.chain needs 1..=100 clip ids", "h3.join.files trim must end after its
/// start", the 64 KiB budget sentence, verbatim) instead of burning the poison-row
/// guard as prepareRefused at drain. Queueing (E29: this is a submit-side row, and
/// the cycle's `ready_backend` law already precedes every submit, so the door
/// grows NO gate and NO `cycleInFlight` wall - the join lands beside a live cycle
/// and drains inside one, like any row): the intent
/// `{recipeId:"h3-join",version:1,h3:{join:<body verbatim>}}` - the exact
/// `H3JoinIntentV1` shape the stock UI's Join clips button feeds `compile` - is
/// minted through `spool::Spool::append_join_row` and drains through the ORDINARY
/// render arm: `flat_intent` rebuilds the intent BYTE-EQUAL to the door's (pinned
/// by the round-trip test), `Jobs::prepare_with_models` compiles it through the
/// SAME stock entry every video row rides (`jobs::compile`, whose `is_join` branch
/// is the UI's own path), and the ONE compiled DaSiWaH3ClipAssemble job rides the
/// cycle like any row. NO chain execution in the plane: N clips, one job.
///
/// The answer is the same row receipt `POST /v1/queue` answers ({id, status,
/// createdAt, envelope}); `seed`/`modelHandle` answer honest null - a model-free
/// assembly carries neither (the refmod row's answer law).
pub(crate) async fn video_join(
    State(state): State<PlaneState>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let bytes = body::to_bytes(request.into_body(), MAX_JOIN_BODY)
        .await
        .map_err(|error| {
            invalid(format!(
                "body unreadable or over {MAX_JOIN_BODY} bytes: {error}"
            ))
        })?;
    let body: Map<String, Value> = serde_json::from_slice(&bytes).map_err(|error| {
        invalid(format!(
            "the join body is closed to the h3.join arms ({}): {error}",
            JOIN_BODY_KEYS.join(", ")
        ))
    })?;
    // The closed grammar first, refusing BY NAME (the promote/bench doors' idiom):
    // unknown keys, then a missing/misplaced `kind`, then the per-arm walls. The
    // arms are exclusive on the wire exactly as `H3JoinIntentV1` declares them.
    for key in body.keys() {
        if !JOIN_BODY_KEYS.contains(&key.as_str()) {
            return Err(invalid(format!(
                "unknown join field '{key}'; the closed grammar is {}",
                JOIN_BODY_KEYS.join(", ")
            )));
        }
    }
    let kind = body
        .get("kind")
        .and_then(Value::as_str)
        .filter(|k| *k == "segments" || *k == "files")
        .ok_or_else(|| {
            invalid("\"kind\" is required and must be \"segments\" or \"files\"".to_owned())
        })?;
    if kind == "segments" {
        if !body.contains_key("session") || !body.contains_key("chain") {
            return Err(invalid(
                "the segments arm carries \"session\" and \"chain\" (the stock join law names the grammar)"
                    .to_owned(),
            ));
        }
        if body.contains_key("files") {
            return Err(invalid(
                "\"files\" belongs to the files arm; the segments arm carries \"session\" and \"chain\" only"
                    .to_owned(),
            ));
        }
    } else {
        if !body.contains_key("files") {
            return Err(invalid(
                "the files arm carries \"files\" (the stock join law names the grammar)".to_owned(),
            ));
        }
        if body.contains_key("session") || body.contains_key("chain") {
            return Err(invalid(
                "\"session\"/\"chain\" belong to the segments arm; the files arm carries \"files\" only"
                    .to_owned(),
            ));
        }
    }
    // Assemble the CLOSED stock intent around the body VERBATIM (the camel wire
    // stays untouched; the door translates nothing), then pay the stock law once,
    // at the door, through its single home. A refusal rides the stock sentence
    // verbatim in the hint - the plane restates no grammar, it only moves the wall
    // ahead of the spool.
    let intent = json!({
        "recipeId": "h3-join",
        "version": 1,
        "h3": { "join": Value::Object(body) },
    });
    if let Err(problem) = crate::jobs_video::validate_join(&intent) {
        return Err(invalid(format!(
            "stock join law refused the body: {problem}"
        )));
    }
    // The prefix law is the SAME stock home `join()` calls at emission (the
    // charset wall never moved); the door only moves it ahead of the spool so a
    // bad prefix answers here with the stock sentence, never at drain.
    if let Some(join_block) = intent["h3"]["join"].as_object() {
        let answer = crate::jobs_video::filename_prefix(
            &Value::Object(join_block.clone()),
            "H3_Joined",
            "h3.join",
        );
        if let Err(problem) = answer {
            return Err(invalid(format!(
                "stock join law refused the body: {problem}"
            )));
        }
    }
    let row = state.spool.append_join_row(&intent).map_err(|problem| {
        ApiError::new(ErrorKind::MaintenanceActive).with_hint(format!(
            "spool record build failed; operator attention required: {problem}"
        ))
    })?;
    Ok(Json(json!({
        "ok": true,
        "id": row.id,
        "status": super::spool::RowStatus::Queued.word(),
        "createdAt": row.created_at,
        "seed": Value::Null,
        "modelHandle": Value::Null,
        "envelope": row.envelope,
        "nextMove": "drain the row with POST /v1/generate (one model-free DaSiWaH3ClipAssemble job, no models to resolve); its outputs land through the ordinary job doors - GET /v1/jobs/{id}, then GET /v1/files/outputs/{path}",
    })))
}

/// Route wrappers: each pins its handler to the uniform index shape.
pub(crate) fn jobs_list_route(
    state: State<PlaneState>,
    _request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(jobs_list(state).map(IntoResponse::into_response))
}

pub(crate) fn job_status_route(
    state: State<PlaneState>,
    request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(job_status(state, request).map(IntoResponse::into_response))
}

pub(crate) fn job_cancel_route(
    state: State<PlaneState>,
    request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(job_cancel(state, request).map(IntoResponse::into_response))
}

pub(crate) fn stop_route(
    state: State<PlaneState>,
    _request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(stop(state).map(IntoResponse::into_response))
}

pub(crate) fn free_route(
    state: State<PlaneState>,
    _request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(free(state).map(IntoResponse::into_response))
}

pub(crate) fn history_route(
    state: State<PlaneState>,
    _request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(history(state).map(IntoResponse::into_response))
}

pub(crate) fn output_route(
    state: State<PlaneState>,
    request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(output(state, request).map(IntoResponse::into_response))
}

pub(crate) fn queue_clear_route(
    state: State<PlaneState>,
    _request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(queue_clear(state).map(IntoResponse::into_response))
}

pub(crate) fn refmod_create_route(
    state: State<PlaneState>,
    request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(refmod_create(state, request).map(IntoResponse::into_response))
}

pub(crate) fn refmod_status_route(
    state: State<PlaneState>,
    request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(refmod_status(state, request).map(IntoResponse::into_response))
}

pub(crate) fn refmod_cancel_route(
    state: State<PlaneState>,
    request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(refmod_cancel(state, request).map(IntoResponse::into_response))
}

pub(crate) fn session_get_route(
    state: State<PlaneState>,
    request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(session_get(state, request).map(IntoResponse::into_response))
}

pub(crate) fn video_prepare_route(
    state: State<PlaneState>,
    request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(video_prepare(state, request).map(IntoResponse::into_response))
}

pub(crate) fn video_join_route(
    state: State<PlaneState>,
    request: Request,
) -> BoxFuture<'static, Response> {
    Box::pin(video_join(state, request).map(IntoResponse::into_response))
}

/// Test double: scripted postures for every stock verb, so the doors' mapping and
/// gate logic runs through the real walls without any Tauri context or backend.
#[cfg(test)]
pub(crate) struct FakeResultsBridge {
    workbench: Value,
    current: Value,
    status: std::collections::BTreeMap<String, Result<Value, String>>,
    status_default: Result<Value, String>,
    cancel: Result<Value, String>,
    interrupt: Result<Value, String>,
    stop: Result<Value, String>,
    history: Value,
    output: Result<OutputParts, String>,
    session: Result<Value, String>,
    prepare: Result<Value, String>,
    /// Every continuity verb a door actually drove (`session:<id>` /
    /// `prepare:<name>`), in call order — the "no endpoint touch" proof for the
    /// grammar walls. Public on purpose (the `FakeRefmodBridge::submitted` idiom).
    pub(crate) continuity: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

#[cfg(test)]
impl FakeResultsBridge {
    /// A healthy plane: one workbench row, one root row, per-id status answers,
    /// success for every mutation, an empty history view, one preview.
    pub(crate) fn healthy() -> Self {
        Self {
            workbench: json!({"jobs": [
                {"id": "wb-row", "state": "queued", "outputs": [], "intent": {}},
            ], "preparing": 0, "capacity": 20, "stopAvailable": true}),
            current: json!({"id": "root-row", "state": "running", "outputs": [], "intent": {}}),
            status: [
                (
                    "wb-row".to_owned(),
                    Ok(json!({"id": "wb-row", "state": "queued"})),
                ),
                (
                    "root-row".to_owned(),
                    Ok(json!({"id": "root-row", "state": "running"})),
                ),
                (
                    "busy-row".to_owned(),
                    Ok(json!({"id": "busy-row", "state": "queued"})),
                ),
            ]
            .into_iter()
            .collect(),
            status_default: Ok(json!({"id": "any-row", "state": "queued"})),
            cancel: Ok(json!({"id": "row", "state": "cancelled"})),
            interrupt: Ok(json!({"id": "row", "state": "cancelled"})),
            stop: Ok(json!({"stopped": 1, "discarded": 0})),
            history: json!({"schemaVersion": 1, "records": [], "readOnly": false, "error": null}),
            output: Ok(OutputParts {
                job_id: "row".to_owned(),
                index: 0,
                mime_type: "image/png",
                width: 8,
                height: 8,
                sha256: "ab12".to_owned(),
                bytes: vec![0x89, b'P', b'N', b'G'],
            }),
            // LEG AF2-M25b: the stock normalized shapes verbatim — the session
            // view the native GET mints, and the source view the preparation
            // answer carries (64-hex sourceId, PyAV probe facts).
            session: Ok(json!({
                "latestId": "drill-1",
                "clips": [{
                    "clipId": "drill-1",
                    "parent": null,
                    "frames": 121,
                    "completed": 1_700_000_000_u64,
                    "export": null,
                }],
            })),
            prepare: Ok(json!({
                "sourceId": "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34",
                "filename": "deas-input-fake-video.mp4",
                "sha256": "0f1e2d3c0f1e2d3c0f1e2d3c0f1e2d3c0f1e2d3c0f1e2d3c0f1e2d3c0f1e2d3c",
                "width": 1024,
                "height": 1024,
                "fps": 24.0,
                "seconds": 5.0,
                "hasAudio": false,
            })),
            continuity: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    /// Every row verb answers the stock unknown refusal for unknown ids; the
    /// per-id map still serves the known ones.
    pub(crate) fn status_refusing(mut self, problem: &str) -> Self {
        self.status_default = Err(problem.to_owned());
        self
    }

    pub(crate) fn cancel_refusing(mut self, problem: &str) -> Self {
        self.cancel = Err(problem.to_owned());
        self
    }

    pub(crate) fn interrupting_to(mut self, snapshot: Value) -> Self {
        self.interrupt = Ok(snapshot);
        self
    }

    pub(crate) fn stop_refusing(mut self, problem: &str) -> Self {
        self.stop = Err(problem.to_owned());
        self
    }

    pub(crate) fn output_refusing(mut self, problem: &str) -> Self {
        self.output = Err(problem.to_owned());
        self
    }

    /// A session read refusing with the stock string it would carry; the honest
    /// no-backend posture is `no owned backend is running (state 'stopped')`.
    pub(crate) fn session_refusing(mut self, problem: &str) -> Self {
        self.session = Err(problem.to_owned());
        self
    }

    /// A preparation refusing with the stock string it would carry.
    pub(crate) fn prepare_refusing(mut self, problem: &str) -> Self {
        self.prepare = Err(problem.to_owned());
        self
    }

    /// LEG MEDIA-1: a preview whose bytes sit ABOVE the smallest legal
    /// configured cap (1 MiB), so the door's config leg of `min(configured,
    /// stock ceilings)` has an honest over-cap fixture without a backend.
    pub(crate) fn with_output_bytes(mut self, len: usize) -> Self {
        self.output = Ok(OutputParts {
            job_id: "row".to_owned(),
            index: 0,
            mime_type: "image/png",
            width: 8,
            height: 8,
            sha256: "ab12".to_owned(),
            bytes: vec![b'x'; len],
        });
        self
    }

    pub(crate) fn with_status(mut self, id: &str, answer: Result<Value, String>) -> Self {
        self.status.insert(id.to_owned(), answer);
        self
    }

    pub(crate) fn with_current(mut self, current: Value) -> Self {
        self.current = current;
        self
    }
}

#[cfg(test)]
impl ResultsBridge for FakeResultsBridge {
    fn workbench_current(&self) -> Result<Value, String> {
        Ok(self.workbench.clone())
    }

    fn job_current(&self) -> Result<Value, String> {
        Ok(self.current.clone())
    }

    fn job_status(&self, job_id: String) -> BoxFuture<'static, Result<Value, String>> {
        let answer = self
            .status
            .get(&job_id)
            .cloned()
            .unwrap_or_else(|| self.status_default.clone());
        Box::pin(async move { answer })
    }

    fn cancel_pending(&self, _job_id: String) -> BoxFuture<'static, Result<Value, String>> {
        let answer = self.cancel.clone();
        Box::pin(async move { answer })
    }

    fn interrupt_running(&self, _job_id: String) -> BoxFuture<'static, Result<Value, String>> {
        let answer = self.interrupt.clone();
        Box::pin(async move { answer })
    }

    fn stop(&self) -> BoxFuture<'static, Result<Value, String>> {
        let answer = self.stop.clone();
        Box::pin(async move { answer })
    }

    fn history(&self) -> Result<Value, String> {
        Ok(self.history.clone())
    }

    fn output(
        &self,
        _job_id: String,
        _index: usize,
    ) -> BoxFuture<'static, Result<OutputParts, String>> {
        let answer = match &self.output {
            Ok(parts) => Ok(OutputParts {
                job_id: parts.job_id.clone(),
                index: parts.index,
                mime_type: parts.mime_type,
                width: parts.width,
                height: parts.height,
                sha256: parts.sha256.clone(),
                bytes: parts.bytes.clone(),
            }),
            Err(problem) => Err(problem.clone()),
        };
        Box::pin(async move { answer })
    }

    fn session(&self, session: String) -> BoxFuture<'static, Result<Value, String>> {
        self.continuity
            .lock()
            .unwrap_or_else(|entry| entry.into_inner())
            .push(format!("session:{session}"));
        let answer = match &self.session {
            Ok(value) => Ok(value.clone()),
            Err(problem) => Err(problem.clone()),
        };
        Box::pin(async move { answer })
    }

    fn prepare(&self, filename: String) -> BoxFuture<'static, Result<Value, String>> {
        self.continuity
            .lock()
            .unwrap_or_else(|entry| entry.into_inner())
            .push(format!("prepare:{filename}"));
        let answer = match &self.prepare {
            Ok(value) => Ok(value.clone()),
            Err(problem) => Err(problem.clone()),
        };
        Box::pin(async move { answer })
    }
}

/// Test double for the creation door: one scripted submit answer plus every request the
/// door actually built, so the E16 fold, the placement law, the closed-vocabulary walls
/// and the taxonomy mapping all run through the real router with no backend and no card.
#[cfg(test)]
pub(crate) struct FakeRefmodBridge {
    answer: Result<Value, String>,
    status: Result<Value, String>,
    cancel: Result<Value, String>,
    /// Every export request the door submitted, in call order. Public on purpose: the
    /// tests hold the concrete `Arc` and read what the seam received.
    pub(crate) submitted: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
}

#[cfg(test)]
impl FakeRefmodBridge {
    /// A healthy owned backend: the stock submit answer, verbatim.
    pub(crate) fn healthy() -> Self {
        Self {
            answer: Ok(json!({"promptId": "3f2a1b6c-0000-4000-8000-000000000000"})),
            status: Ok(json!({"state": "done", "result": {
                "name": "hero", "members": 2,
                "counts": {"image": 1, "video": 0, "audio": 0}, "warnings": []
            }})),
            cancel: Ok(json!({"cancelled": "running"})),
            submitted: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    /// A submit that refuses with the stock string it would carry; the honest
    /// no-backend posture is `no owned backend is running (state 'stopped')`.
    pub(crate) fn refusing(problem: &str) -> Self {
        Self {
            answer: Err(problem.to_owned()),
            status: Err(problem.to_owned()),
            cancel: Err(problem.to_owned()),
            submitted: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    /// A status verb refusing with the stock string it would carry for an id the
    /// stock `submitted()` law has never seen.
    pub(crate) fn status_refusing(mut self, problem: &str) -> Self {
        self.status = Err(problem.to_owned());
        self
    }

    /// A cancel verb refusing with the stock unknown-export string.
    pub(crate) fn cancel_refusing(mut self, problem: &str) -> Self {
        self.cancel = Err(problem.to_owned());
        self
    }

    /// A cancel verb answering the stock `{"cancelled": word}` shape.
    pub(crate) fn cancelling_to(mut self, answer: Value) -> Self {
        self.cancel = Ok(answer);
        self
    }
}

#[cfg(test)]
impl RefmodBridge for FakeRefmodBridge {
    fn submit(&self, request: Value) -> BoxFuture<'static, Result<Value, String>> {
        self.submitted
            .lock()
            .unwrap_or_else(|entry| entry.into_inner())
            .push(request.clone());
        let answer = match &self.answer {
            Ok(value) => Ok(value.clone()),
            Err(problem) => Err(problem.clone()),
        };
        Box::pin(async move { answer })
    }

    fn status(&self, _prompt_id: String) -> BoxFuture<'static, Result<Value, String>> {
        let answer = match &self.status {
            Ok(value) => Ok(value.clone()),
            Err(problem) => Err(problem.clone()),
        };
        Box::pin(async move { answer })
    }

    fn cancel(&self, _prompt_id: String) -> BoxFuture<'static, Result<Value, String>> {
        let answer = match &self.cancel {
            Ok(value) => Ok(value.clone()),
            Err(problem) => Err(problem.clone()),
        };
        Box::pin(async move { answer })
    }
}

#[cfg(test)]
mod tests {
    use super::super::config::AgentSettings;
    use super::super::cycle;
    use super::super::idempotency;
    use super::super::lanes::Lanes;
    use super::super::resume;
    use super::super::scan::FakeScanBridge;
    use super::super::spool::Spool;
    use super::super::uploads::RecordingUploadBridge;
    use super::super::watchdog;
    use super::*;
    use axum::body::Body;
    use std::sync::Arc;

    #[test]
    fn the_refmod_door_vocabulary_mirrors_the_stock_refmod_module() {
        // Source-lift gate (law): the five concept words, the seven request fields, the
        // 4000-character description cap and the eight saved-RefMod cap all come from
        // `jobs_refmod`; this door may never widen one of them, and if stock moves, the
        // mirror has to move with it.
        const SOURCE: &str = include_str!("../jobs_refmod.rs");
        assert_eq!(
            REFMOD_CONCEPTS,
            ["generic", "identity", "style", "motion", "audio"]
        );
        assert!(
            SOURCE.contains(r#"const CONCEPTS: [&str; 5] = ["generic", "identity", "style", "motion", "audio"];"#),
            "the stock concept list moved; the door's mirror must move with it"
        );
        for field in REFMOD_FIELDS {
            assert!(
                SOURCE.contains(&format!("\"{field}\"")),
                "{field} is no longer a stock RefMod request field"
            );
        }
        assert!(
            SOURCE.contains(r#"text(o.get("description"), 4000)"#),
            "the stock description cap moved"
        );
        assert_eq!(REFMOD_DESCRIPTION_CHARS, 4_000);
        assert!(
            SOURCE.contains("rows.len() > 8"),
            "the stock saved-RefMod cap moved"
        );
        assert_eq!(REFMOD_MAX_SAVED, 8);
    }

    #[test]
    fn the_unknown_row_refusal_words_are_pinned_to_their_stock_homes() {
        // Source-lift gate (law): the closed `jobUnknown` mapping fires on each stock
        // unknown-row refusal string; if any home renames its refusal, the mapping
        // goes stale silently — this test refuses that drift.
        const JOBS: &str = include_str!("../jobs_refmod.rs");
        assert!(
            JOBS.contains("\"Unknown RefMod export\""),
            "jobs_refmod renamed its unknown-id refusal; the mapping prefix must move with it"
        );
        assert!(is_unknown_row("Unknown RefMod export"));
        assert!(is_unknown_row("Unknown native job"));
        assert!(is_unknown_row("Unknown native Workbench job"));
        assert!(!is_unknown_row("RefMod cancel rejected (HTTP 500)"));
    }

    #[test]
    fn the_export_row_arm_mirrors_the_door_refmod_field_home() {
        // E28 (LEG AF2-M24b): the drainable-row arm rebuilds the same closed
        // seven the creation door validates (fill_plane::REFMOD_EXPORT_KEYS is
        // the spool/cycle arm's home, REFMOD_FIELDS this door's). One drift and
        // the spool arm would hand stock compile a request its `known` array
        // refuses — this test refuses that drift between the two mirrors.
        assert_eq!(REFMOD_FIELDS, fill_plane::REFMOD_EXPORT_KEYS);
    }

    #[test]
    fn an_unknown_refmod_id_answers_jobunknown_naming_the_id() {
        let error = refmod_unknown("Unknown RefMod export".to_owned(), "no-such-id");
        let body = error.body_json();
        assert_eq!(
            body["reason"], "jobUnknown",
            "the existing word, never a new one"
        );
        assert!(
            body["hint"].as_str().is_some_and(
                |hint| hint.contains("no-such-id") && hint.contains("Unknown RefMod export")
            ),
            "the hint names the id and rides the stock string verbatim"
        );
        // Every other refusal keeps the honest maintenance word verbatim.
        let other = refmod_unknown("Invalid backend endpoint".to_owned(), "id").body_json();
        assert_eq!(other["reason"], "maintenanceActive");
    }

    /* ---------- LEG AF2-M25b: the continuity read/prepare doors ---------- */

    /// The test-plane fixture the transport tests spin (the `state(...)` idiom
    /// copied, app-data in a caller-owned tempdir like `plane_with_app_data` /
    /// `refmod_plane`): every seam is a fake, so the continuity doors' walls and
    /// taxonomy mapping run with no Tauri context and no backend. The `results`
    /// seam is taken as a concrete handle so a test can read the continuity call
    /// log.
    fn plane_with_results(
        results: Arc<FakeResultsBridge>,
        app_data: &std::path::Path,
    ) -> PlaneState {
        PlaneState {
            settings: AgentSettings {
                enabled: true,
                port: 8790,
                standing_key: None,
                origin_allowlist: vec!["http://localhost:1420".to_owned()],

                component_overrides: Default::default(),
            },
            app_data: app_data.to_path_buf(),
            lanes: Arc::new(Lanes::new()),
            spool: Arc::new(Spool::new(app_data)),
            cycle: Arc::new(cycle::CycleCell::new(app_data)),
            cycle_seams: Arc::new(cycle::CycleSeams::defaults_for_tests()),
            watchdog: Arc::new(watchdog::Watchdog::new(
                app_data,
                Arc::new(watchdog::WatchdogSeams::defaults_for_tests()),
            )),
            ledger: Arc::new(idempotency::Ledger::new(app_data)),
            resume: Arc::new(resume::ResumeWatch::scripted_for_tests(Arc::new(
                resume::ScriptProbe::always(true),
            ))),
            results,
            refmods: Arc::new(FakeRefmodBridge::healthy()),
            library: None,
            input_root: None,
            output_root: None,
            batch: Arc::new(super::super::caps::BatchLedger::new()),
            app: None,
            scan: Arc::new(FakeScanBridge::idle()),
            uploads: Arc::new(RecordingUploadBridge::accepting()),
        }
    }

    fn door_get(path: &str) -> Request {
        Request::builder()
            .method("GET")
            .uri(path)
            .body(Body::empty())
            .expect("GET request")
    }

    fn door_post(path: &str, body_text: &str) -> Request {
        Request::builder()
            .method("POST")
            .uri(path)
            .body(Body::from(body_text.to_owned()))
            .expect("POST request")
    }

    fn continuity_calls(bridge: &Arc<FakeResultsBridge>) -> Vec<String> {
        bridge
            .continuity
            .lock()
            .unwrap_or_else(|entry| entry.into_inner())
            .clone()
    }

    #[test]
    fn the_continuity_door_walls_mirror_the_stock_native_homes() {
        // Source-lift gate (law): the session alphabet (`jobs_video::continuity_id`)
        // and the preparation filename wall (`native_h3_video_prepare`) each have
        // ONE stock home; the doors mirror them, so if stock moves, the mirrors
        // move with it — this test refuses the drift.
        const JOBS: &str = include_str!("../jobs.rs");
        const VIDEO: &str = include_str!("../jobs_video.rs");
        assert!(
            JOBS.contains("Invalid continuity session"),
            "native_h3_session renamed its refusal; the door's mirror words must move with it"
        );
        assert!(
            JOBS.contains("Invalid input-relative video filename"),
            "native_h3_video_prepare renamed its refusal"
        );
        assert!(
            JOBS.contains("filename.len() > 4096"),
            "the stock filename ceiling moved"
        );
        assert_eq!(PREPARE_MAX_NAME_BYTES, 4_096);
        assert!(
            JOBS.contains(r#""\\:".contains(c)"#),
            "the stock backslash/colon arm moved"
        );
        assert!(
            JOBS.contains(r#""[output]", "[temp]""#),
            "the stock output/temp placement-mark refusal moved"
        );
        assert!(
            VIDEO.contains("s.len() <= 80"),
            "the continuity id ceiling moved"
        );
        assert!(
            VIDEO.contains("never '_imports'"),
            "the imports-folder exclusion moved"
        );
        assert!(crate::jobs_video::continuity_id("drill-1"));
        assert!(!crate::jobs_video::continuity_id("bad.name"));
    }

    #[tokio::test]
    async fn the_sessions_door_refuses_a_malformed_id_before_touching_the_endpoint() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = Arc::new(FakeResultsBridge::healthy());
        let plane = plane_with_results(Arc::clone(&bridge), dir.path());
        let Err(error) = session_get(State(plane), door_get("/v1/sessions/bad.name")).await else {
            panic!("a dotted id is not a continuity id; the wall must bounce it");
        };
        let body = error.body_json();
        assert_eq!(body["reason"], "bodyInvalid", "{body}");
        let hint = body["hint"].as_str().expect("hint");
        assert!(
            hint.contains("Invalid continuity session") && hint.contains("continuity id"),
            "the native's refusal words ride the hint and it names the session grammar: {body}"
        );
        assert!(
            continuity_calls(&bridge).is_empty(),
            "the wall answers before any endpoint touch"
        );
    }

    #[tokio::test]
    async fn the_sessions_door_refuses_the_imports_folder_as_a_session() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = Arc::new(FakeResultsBridge::healthy());
        let plane = plane_with_results(Arc::clone(&bridge), dir.path());
        let Err(error) = session_get(State(plane), door_get("/v1/sessions/_imports")).await else {
            panic!("the imports folder is not a session");
        };
        let body = error.body_json();
        assert_eq!(body["reason"], "bodyInvalid", "{body}");
        assert!(
            body["hint"].as_str().expect("hint").contains("_imports"),
            "the hint names the exclusion: {body}"
        );
        assert!(continuity_calls(&bridge).is_empty());
    }

    #[tokio::test]
    async fn the_sessions_door_answers_maintenance_active_when_no_backend_runs() {
        // The refmod closure doors' fixture posture: the honest no-backend string
        // rides the hint verbatim under the existing word — never a new one.
        let bridge = Arc::new(
            FakeResultsBridge::healthy()
                .session_refusing("no owned backend is running (state 'stopped')"),
        );
        let dir = tempfile::tempdir().expect("tempdir");
        let plane = plane_with_results(Arc::clone(&bridge), dir.path());
        let Err(error) = session_get(State(plane), door_get("/v1/sessions/drill-1")).await else {
            panic!("the read must answer honestly when no backend runs");
        };
        let body = error.body_json();
        assert_eq!(body["reason"], "maintenanceActive", "{body}");
        assert!(
            body["hint"]
                .as_str()
                .expect("hint")
                .contains("no owned backend is running"),
            "the stock string rides verbatim: {body}"
        );
        // The grammar passed, so the endpoint leg WAS driven (the seam is the
        // stand-in for it) — the refusal is the bridge's, not the wall's.
        assert_eq!(continuity_calls(&bridge), vec!["session:drill-1"]);
    }

    #[tokio::test]
    async fn the_sessions_door_answers_the_stock_clip_view_verbatim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = Arc::new(FakeResultsBridge::healthy());
        let plane = plane_with_results(Arc::clone(&bridge), dir.path());
        let Ok(Json(answer)) = session_get(State(plane), door_get("/v1/sessions/drill-1")).await
        else {
            panic!("the healthy seam answers the stock view");
        };
        assert_eq!(answer["ok"], true);
        assert_eq!(answer["session"]["latestId"], "drill-1");
        assert_eq!(answer["session"]["clips"][0]["clipId"], "drill-1");
        assert_eq!(answer["session"]["clips"][0]["frames"], 121);
    }

    #[tokio::test]
    async fn the_prepare_door_refuses_a_name_the_placement_law_cannot_accept() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = Arc::new(FakeResultsBridge::healthy());
        let plane = plane_with_results(Arc::clone(&bridge), dir.path());
        let Err(error) = video_prepare(
            State(plane),
            door_post("/v1/videos/prepare", r#"{"file":"bad\\name.mp4"}"#),
        )
        .await
        else {
            panic!("a backslash name is refused by the mirrored wall");
        };
        let body = error.body_json();
        assert_eq!(body["reason"], "bodyInvalid", "{body}");
        let hint = body["hint"].as_str().expect("hint");
        assert!(
            hint.contains("Invalid input-relative video filename"),
            "the native's refusal words ride the hint: {body}"
        );
        assert!(
            hint.contains("input ROOT") && hint.contains("deas-input-"),
            "the hint names the LoadVideo placement law (videos land at the input root as deas-input-<uuid>.<ext>): {body}"
        );
        assert!(
            continuity_calls(&bridge).is_empty(),
            "the wall answers before any endpoint touch"
        );
    }

    #[tokio::test]
    async fn the_prepare_door_refuses_an_images_subfolder_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = Arc::new(FakeResultsBridge::healthy());
        let plane = plane_with_results(Arc::clone(&bridge), dir.path());
        let Err(error) = video_prepare(
            State(plane),
            door_post("/v1/videos/prepare", r#"{"file":"deas-inputs/x.png"}"#),
        )
        .await
        else {
            panic!("deas-inputs/ is the images subfolder, not the video root placement");
        };
        let body = error.body_json();
        assert_eq!(body["reason"], "bodyInvalid", "{body}");
        let hint = body["hint"].as_str().expect("hint");
        assert!(
            hint.contains("input-ROOT") && hint.contains("images subfolder"),
            "the refusal names root-vs-subfolder: {body}"
        );
        assert!(continuity_calls(&bridge).is_empty());
    }

    #[tokio::test]
    async fn the_prepare_door_refuses_any_key_outside_the_closed_single_key_set() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = Arc::new(FakeResultsBridge::healthy());
        let plane = plane_with_results(Arc::clone(&bridge), dir.path());
        let Err(error) = video_prepare(
            State(plane),
            door_post(
                "/v1/videos/prepare",
                r#"{"file":"deas-input-7db0.mp4","extra":true}"#,
            ),
        )
        .await
        else {
            panic!("the body is closed to the one file key");
        };
        let body = error.body_json();
        assert_eq!(body["reason"], "bodyInvalid", "{body}");
        assert!(
            body["hint"]
                .as_str()
                .expect("hint")
                .contains("single \"file\" key"),
            "the hint names the closed one-key set: {body}"
        );
        assert!(continuity_calls(&bridge).is_empty());
    }

    #[tokio::test]
    async fn the_prepare_door_answers_maintenance_active_when_no_backend_runs() {
        let bridge = Arc::new(
            FakeResultsBridge::healthy()
                .prepare_refusing("no owned backend is running (state 'stopped')"),
        );
        let dir = tempfile::tempdir().expect("tempdir");
        let plane = plane_with_results(Arc::clone(&bridge), dir.path());
        let Err(error) = video_prepare(
            State(plane),
            door_post(
                "/v1/videos/prepare",
                r#"{"file":"deas-input-fake-video.mp4"}"#,
            ),
        )
        .await
        else {
            panic!("the read must answer honestly when no backend runs");
        };
        let body = error.body_json();
        assert_eq!(body["reason"], "maintenanceActive", "{body}");
        assert!(
            body["hint"]
                .as_str()
                .expect("hint")
                .contains("no owned backend is running"),
            "the stock string rides verbatim: {body}"
        );
        assert_eq!(
            continuity_calls(&bridge),
            vec!["prepare:deas-input-fake-video.mp4"]
        );
    }

    #[tokio::test]
    async fn the_prepare_door_answers_the_stock_source_view_and_the_next_move() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = Arc::new(FakeResultsBridge::healthy());
        let plane = plane_with_results(Arc::clone(&bridge), dir.path());
        let Ok(Json(answer)) = video_prepare(
            State(plane),
            door_post(
                "/v1/videos/prepare",
                r#"{"file":"deas-input-fake-video.mp4"}"#,
            ),
        )
        .await
        else {
            panic!("the healthy seam answers the stock source view");
        };
        assert_eq!(answer["ok"], true);
        let source_id = answer["prepared"]["sourceId"].as_str().expect("sourceId");
        assert!(
            source_id.len() == 64
                && source_id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "the 64-lowercase-hex sourceId the h3.continuity row needs: {source_id}"
        );
        assert_eq!(answer["prepared"]["filename"], "deas-input-fake-video.mp4");
        assert_eq!(answer["prepared"]["hasAudio"], false);
        let next_move = answer["nextMove"].as_str().expect("nextMove");
        assert!(
            next_move.contains("h3.continuity") && next_move.contains("sourceKind"),
            "the nextMove names the row use: {next_move}"
        );
    }

    /* ---------- LEG AF2-M31: the join door (POST /v1/videos/join) ---------- */

    /// A legal segments arm (the live-proven aqua-story shape: clips of one
    /// session, chained) — the door's own fixture for the happy paths.
    const JOIN_SEGMENTS_OK: &str =
        r#"{"kind":"segments","session":"aqua-story","chain":["f579b09e","4c9c8088"]}"#;

    /// The closed body grammar the door pins, mirrored here so a silent widening
    /// of the door's set and this test cannot drift apart (the door's set carries
    /// the stock arm keys only; the stock refusal words for the GRAMMAR itself live
    /// in `jobs_video::validate_join`, single home).
    #[test]
    fn the_join_door_body_grammar_is_the_closed_seven_words() {
        assert_eq!(
            JOIN_BODY_KEYS,
            [
                "kind",
                "session",
                "chain",
                "files",
                "copyVideo",
                "smoothAudioSeams",
                "filenamePrefix"
            ]
        );
        // Single-home pin (the AF2-M30 `H3_KEYS` idiom): the join law's ONE home is
        // `jobs_video::validate_join`, and `join()` calls it before emitting - a
        // second grammar pasted into the door or the spool arm is drift this names.
        let video = include_str!("../jobs_video.rs");
        assert!(
            video.contains("pub(crate) fn validate_join(i: &Value) -> Result<Vec<Value>, String>"),
            "the join law's single home moved out of jobs_video"
        );
        assert!(
            video.contains("let rows = validate_join(i)?;"),
            "join() no longer calls validate_join: the single home broke"
        );
        // The camel/snake law: the wire is camel (the UI intent home), the compiled
        // assembly_data is snake (the pack contract). The door never translates.
        let ui = include_str!("../../../src/lib/videoIntent.ts");
        assert!(
            ui.contains("recipeId:'h3-join'")
                && ui.contains("smoothAudioSeams?:boolean")
                && ui.contains("filenamePrefix?:string"),
            "the pinned H3JoinIntentV1 wire moved; the door's closed set must move with it"
        );
    }

    #[tokio::test]
    async fn the_join_door_refuses_unknown_body_keys_naming_them() {
        // Each unknown key alone, so the refusal must NAME it (the shipped
        // closed-grammar idiom refuses the first unknown key it walks - the
        // bench/promote doors' law - and never queues anything on the way).
        let cases: [(&str, &str); 4] = [
            (
                r#"{"kind":"segments","session":"aqua-story","chain":["clip_1"],"mode":"join"}"#,
                "'mode'",
            ),
            (
                r#"{"kind":"segments","session":"aqua-story","chain":["clip_1"],"seed":7}"#,
                "'seed'",
            ),
            (
                r#"{"kind":"files","files":[{"filename":"a.mp4"}],"trimStart":1}"#,
                "'trimStart'",
            ),
            (
                r#"{"kind":"segments","session":"aqua-story","chain":["clip_1"],"copy_video":true}"#,
                "'copy_video'",
            ),
        ];
        for (body_text, named) in cases {
            let dir = tempfile::tempdir().expect("tempdir");
            let bridge = Arc::new(FakeResultsBridge::healthy());
            let plane = plane_with_results(Arc::clone(&bridge), dir.path());
            let Err(error) = video_join(
                State(plane.clone()),
                door_post("/v1/videos/join", body_text),
            )
            .await
            else {
                panic!("the body carries a key outside the closed grammar: {body_text}");
            };
            let body = error.body_json();
            assert_eq!(body["reason"], "bodyInvalid", "{body}");
            let hint = body["hint"].as_str().expect("hint");
            assert!(
                hint.contains(named),
                "the refusal names the key {named}: {hint}"
            );
            assert!(
                hint.contains(
                    "kind, session, chain, files, copyVideo, smoothAudioSeams, filenamePrefix"
                ),
                "the hint names the closed set: {hint}"
            );
            assert!(
                plane.spool.snapshot().expect("the spool reads").is_empty(),
                "an unknown key never queues a row: {body_text}"
            );
        }
    }

    #[tokio::test]
    async fn the_join_door_refuses_a_bad_segments_arm_naming_the_stock_law() {
        let cases: Vec<(String, &str)> = vec![
            // The empty/_imports walls are stock's own ("Invalid h3.join.session").
            (
                r#"{"kind":"segments","session":"","chain":["clip_1"]}"#.to_owned(),
                "Invalid h3.join.session",
            ),
            (
                r#"{"kind":"segments","session":"_imports","chain":["clip_1"]}"#.to_owned(),
                "Invalid h3.join.session",
            ),
            (
                r#"{"kind":"segments","session":"aqua.story","chain":["clip_1"]}"#.to_owned(),
                "Invalid h3.join.session",
            ),
            (
                format!(
                    r#"{{"kind":"segments","session":"{}","chain":["clip_1"]}}"#,
                    "s".repeat(81)
                ),
                "Invalid h3.join.session",
            ),
            // The empty chain and the 101-entry chain: stock's own sentence.
            (
                r#"{"kind":"segments","session":"aqua-story","chain":[]}"#.to_owned(),
                "h3.join.chain needs 1..=100 clip ids",
            ),
            (
                format!(
                    r#"{{"kind":"segments","session":"aqua-story","chain":[{}]}}"#,
                    (1..=101)
                        .map(|n| format!("\"clip_{n}\""))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                "h3.join.chain needs 1..=100 clip ids",
            ),
        ];
        for (index, (body_text, stock_word)) in cases.into_iter().enumerate() {
            let dir = tempfile::tempdir().expect("tempdir");
            let bridge = Arc::new(FakeResultsBridge::healthy());
            let plane = plane_with_results(Arc::clone(&bridge), dir.path());
            let Err(error) =
                video_join(State(plane), door_post("/v1/videos/join", &body_text)).await
            else {
                panic!("case {index} is grammar-bad; the door must refuse: {body_text}");
            };
            let body = error.body_json();
            assert_eq!(body["reason"], "bodyInvalid", "case {index}: {body}");
            let hint = body["hint"].as_str().expect("hint");
            assert!(
                hint.contains(stock_word),
                "case {index}: the hint carries the stock refusal verbatim ({stock_word}): {hint}"
            );
        }
    }

    #[tokio::test]
    async fn the_join_door_refuses_a_bad_files_arm_naming_the_stock_law() {
        let cases: [(&str, &str); 2] = [
            (
                r#"{"kind":"files","files":[{"filename":"../outside.mp4"}]}"#,
                "Invalid h3.join.files.filename",
            ),
            (
                r#"{"kind":"files","files":[{"filename":"deas-input-1.mp4","trimStart":5,"trimEnd":5}]}"#,
                "h3.join.files trim must end after its start",
            ),
        ];
        for (body_text, stock_word) in cases {
            let dir = tempfile::tempdir().expect("tempdir");
            let bridge = Arc::new(FakeResultsBridge::healthy());
            let plane = plane_with_results(Arc::clone(&bridge), dir.path());
            let Err(error) =
                video_join(State(plane), door_post("/v1/videos/join", body_text)).await
            else {
                panic!("case is grammar-bad; the door must refuse: {body_text}");
            };
            let body = error.body_json();
            assert_eq!(body["reason"], "bodyInvalid", "{body}");
            assert!(
                body["hint"].as_str().expect("hint").contains(stock_word),
                "the hint carries the stock refusal verbatim ({stock_word}): {}",
                body["hint"]
            );
        }
    }

    #[tokio::test]
    async fn the_join_door_refuses_a_bad_prefix_naming_the_stock_law() {
        // The `filenamePrefix` charset wall is the stock home's, called at the
        // door: a bad prefix answers the stock sentence and nothing queues.
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = Arc::new(FakeResultsBridge::healthy());
        let plane = plane_with_results(Arc::clone(&bridge), dir.path());
        let Err(error) = video_join(
            State(plane.clone()),
            door_post(
                "/v1/videos/join",
                r#"{"kind":"files","files":[{"filename":"a.mp4"}],"filenamePrefix":"final.cut"}"#,
            ),
        )
        .await
        else {
            panic!("a dotted prefix is outside the pack's charset");
        };
        let body = error.body_json();
        assert_eq!(body["reason"], "bodyInvalid", "{body}");
        assert!(
            body["hint"]
                .as_str()
                .expect("hint")
                .contains("Invalid h3.join.filenamePrefix"),
            "the stock prefix sentence rides the hint verbatim: {}",
            body["hint"]
        );
        assert!(
            plane.spool.snapshot().expect("spool").is_empty(),
            "nothing queued"
        );
    }

    #[tokio::test]
    async fn the_join_door_refuses_mixed_arms_before_the_stock_law() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = Arc::new(FakeResultsBridge::healthy());
        let plane = plane_with_results(Arc::clone(&bridge), dir.path());
        let Err(error) = video_join(
            State(plane),
            door_post(
                "/v1/videos/join",
                r#"{"kind":"segments","session":"aqua-story","chain":["clip_1"],"files":[{"filename":"a.mp4"}]}"#,
            ),
        )
        .await
        else {
            panic!("the arms are exclusive; a segments body never carries files");
        };
        let body = error.body_json();
        assert_eq!(body["reason"], "bodyInvalid", "{body}");
        assert!(
            body["hint"]
                .as_str()
                .expect("hint")
                .contains("belongs to the files arm"),
            "the hint names the arm law: {}",
            body["hint"]
        );
    }

    /// INTENT-TRUTH LAW (the campaign's pattern): the intent the door assembles is
    /// the intent the drain submits (the spool round-trip pins byte-equality), and
    /// running it through the stock compile entry every video row rides yields
    /// EXACTLY the graph the stock join home produces - equality, not similarity.
    #[test]
    fn the_join_door_intent_compiles_to_the_exact_stock_join_graph() {
        let intent = json!({
            "recipeId": "h3-join",
            "version": 1,
            "h3": {
                "join": {
                    "kind": "segments",
                    "session": "aqua-story",
                    "chain": ["f579b09e", "4c9c8088"],
                    "copyVideo": true,
                }
            },
        });
        crate::jobs_video::validate_join(&intent).expect("the door's fixture passes the stock law");
        // The same entry the drain's prepare rides: `jobs::compile`, whose
        // `is_join` branch dispatches to the join home (jobs.rs:463 -> jobs_video).
        let via_plane = crate::jobs::compile(&intent).expect("the door's intent compiles");
        let graph = via_plane.as_object().expect("a graph object");
        assert_eq!(
            graph.keys().collect::<Vec<_>>(),
            vec!["7"],
            "node 7 is the house saver id, and the join graph is exactly one node"
        );
        assert_eq!(graph["7"]["class_type"], "DaSiWaH3ClipAssemble");
        assert_eq!(graph["7"]["inputs"]["filename_prefix"], "H3_Joined");
        let assembly: Value = serde_json::from_str(
            graph["7"]["inputs"]["assembly_data"]
                .as_str()
                .expect("assembly_data"),
        )
        .expect("assembly_data is the pack's JSON");
        assert_eq!(assembly["version"], 1);
        assert_eq!(assembly["repair_transitions"], false);
        assert_eq!(
            assembly["copy_video"], true,
            "the camel wire copies into the snake graph"
        );
        assert_eq!(assembly["audio_policy"], "preserve");
        assert_eq!(
            assembly["rows"],
            json!([
                {"kind": "checkpoint", "session": "aqua-story", "clip_id": "f579b09e"},
                {"kind": "checkpoint", "session": "aqua-story", "clip_id": "4c9c8088"},
            ]),
            "chain order rides verbatim"
        );
    }

    /// The door answers the queue door's row receipt and the row is a real spool
    /// row; the flat intent the drain rebuilds is the door's intent BYTE-EQUAL
    /// (the intent-truth hinge between the door and the drain).
    #[tokio::test]
    async fn the_join_door_mints_the_row_the_drain_rebuilds_byte_equal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = Arc::new(FakeResultsBridge::healthy());
        let plane = plane_with_results(Arc::clone(&bridge), dir.path());
        let Ok(Json(answer)) = video_join(
            State(plane.clone()),
            door_post("/v1/videos/join", JOIN_SEGMENTS_OK),
        )
        .await
        else {
            panic!("a legal segments body queues");
        };
        assert_eq!(answer["ok"], true);
        assert_eq!(answer["status"], "queued");
        assert!(answer["id"].as_str().is_some(), "row receipt: {answer}");
        assert!(
            answer["seed"].is_null() && answer["modelHandle"].is_null(),
            "{answer}"
        );
        let rows = plane.spool.snapshot().expect("the spool reads back");
        assert_eq!(rows.len(), 1, "exactly one row landed");
        let rebuilt = super::super::spool::flat_intent(&rows[0])
            .expect("the row is drain-ready by construction");
        let door_intent: Value = serde_json::from_str(&format!(
            r#"{{"recipeId":"h3-join","version":1,"h3":{{"join":{JOIN_SEGMENTS_OK}}}}}"#
        ))
        .expect("the door's intent shape");
        assert_eq!(
            serde_json::to_string(&rebuilt).expect("serialize rebuilt"),
            serde_json::to_string(&door_intent).expect("serialize door intent"),
            "the drain's flat intent is the door's intent byte-equal"
        );
        assert!(
            super::super::spool::is_join_row_intent(&rebuilt)
                && !super::super::spool::is_refmod_export_intent(&rebuilt),
            "the row arms through the render arm's prepare/submit, never the export arm"
        );
        assert!(crate::jobs_video::is_join(&rebuilt), "the stock word fires");
    }

    /// The join door is a Control-lane, POST-only row like its M25b siblings: the
    /// closed index answers the method wall for a GET (the 405 shape itself is
    /// pinned end-to-end in transport.rs; this pins the index side).
    #[test]
    fn the_join_door_is_an_indexed_control_lane_post_only_row() {
        let row = super::super::routes::lookup("POST", "/v1/videos/join").expect("indexed row");
        assert_eq!(row.operation, "joinSubmit");
        assert_eq!(row.lane, super::super::lanes::Lane::Control);
        assert!(
            super::super::routes::registered_methods("/v1/videos/join") == vec!["POST"],
            "the path serves POST only; every other method rides the closed 405"
        );
    }
}
