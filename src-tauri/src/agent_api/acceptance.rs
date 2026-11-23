//! M8 acceptance harness (API-DESIGN §13): the stranger script and its failure
//! drills, run over the SAME seams the shipped plane runs over.
//!
//! The spine is the door tests' spine, one idiom: [`super::transport::router`]
//! assembled over a [`super::PlaneState`] built like `transport::tests` build their
//! test plane (tempdir app-data, every handle repointed inside it), driven through
//! the REAL wall stack (auth wall, lane gate, closed route index) with
//! `tower_service::Service::call` requests. Nothing here mocks a route: the requests
//! enter through the router and land on the same handlers the live plane serves.
//!
//! The machine legs run over the shipped fakes — [`super::cycle::ScriptCommands`],
//! [`super::cycle::ScriptChain`], [`super::cycle::ScriptDoor`],
//! [`super::cycle::ScriptGate`], [`super::cycle::ScriptHealth`],
//! [`super::cycle::ScriptPacer`] — plus the watchdog's own scripted seams
//! ([`super::watchdog`]'s sampler/control fakes). The cycle's resume watch is wired
//! over the SAME scripted health prober the cycle seams carry: the one-prober law,
//! kept honest in the harness exactly as at boot. The only new fake is a parking
//! submit chain (the wedge and dropped-socket drills need a row that is verifiably
//! mid-render while the judge watches); it implements the shipped `SubmitChain`
//! trait, no parallel seam.
//!
//! Drill timing is scripted, never wall-clock: the pacer fake records the durations
//! the machine asked for, so the timing consts are pinned by their call sites.
//!
//! The `#[ignore]`d test at the end is the SAME script shape against the real plane
//! for the live window — unearthing, not rebuilding.

#![cfg(test)]

use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::Router;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use tower_service::Service as _;

use super::config::AgentSettings;
use super::cycle;
use super::cycle::{
    ScriptChain, ScriptCommands, ScriptCorrelation, ScriptDoor, ScriptGate, ScriptHealth,
    ScriptPacer, ScriptRefmodChain,
};
use super::defaults;
use super::guard;
use super::idempotency;
use super::lanes::Lanes;
use super::resolver::IndexSource;
use super::resume::{self, ScriptProbe};
use super::scan::FakeScanBridge;
use super::spool::{self, RowStatus, Spool};
use super::transport::router;
use super::uploads::RecordingUploadBridge;
use super::watchdog::{self, Watchdog, WatchdogSeams};
use super::watchdog::{quiet, ScriptControl, ScriptSampler};
use super::PlaneState;

/* ------------------------------ the scripted parking chain ------------------------------ */

/// A `SubmitChain` whose rows park inside `run_row` until the harness releases a
/// permit — the mid-render fact the wedge and dropped-socket drills need. It
/// implements the shipped trait over the plane's real drain; it is not a parallel
/// seam. Rows park in drain order; `release()` admits exactly one parked row.
struct ParkingChain {
    gate: Arc<tokio::sync::Semaphore>,
    started: std::sync::atomic::AtomicU32,
    /// W3-7 (LEG AF2-M21a): the plane's spool handle, mounted once so a parked
    /// row carries its stock jobId exactly as production correlates before the
    /// long render wait (M9a law). OnceLock: set behind &self, Sync-clean.
    spool: std::sync::OnceLock<Arc<Spool>>,
}

impl ParkingChain {
    fn new() -> Self {
        Self {
            gate: Arc::new(tokio::sync::Semaphore::new(0)),
            started: std::sync::atomic::AtomicU32::new(0),
            spool: std::sync::OnceLock::new(),
        }
    }

    fn release(&self) {
        self.gate.add_permits(1);
    }

    fn started(&self) -> u32 {
        self.started.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Mount the plane's spool so `run_row` can correlate the parked row with
    /// the `job-run` id the fixture's `one_running` control reports RUNNING.
    fn correlate_parked(&self, spool: Arc<Spool>) {
        let _ = self.spool.set(spool);
    }
}

impl cycle::SubmitChain for ParkingChain {
    fn run_row(
        &self,
        row_id: &str,
        _intent: Value,
    ) -> futures_util::future::BoxFuture<'static, cycle::RowOutcome> {
        self.started
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let gate = Arc::clone(&self.gate);
        let correlation = self.spool.get().cloned();
        let row_id = row_id.to_owned();
        Box::pin(async move {
            if let Some(spool) = correlation {
                let _ = spool.set_job_id(&row_id, "job-run");
            }
            let permit = gate
                .acquire()
                .await
                .expect("the parking chain is never closed");
            drop(permit);
            cycle::RowOutcome {
                succeeded: false,
                detail: Some("scripted: the render ended after the harness released it".to_owned()),
                error_kind: None,
                submit_failed: false,
                // No stock job is scripted here: the drills that use this chain watch
                // a row mid-render, not a correlation chain.
                job_id: None,
                outputs: None,
            }
        })
    }
}

/* ------------------------------ the test plane ------------------------------ */

/// The model handle the fake library index resolves: the §9 handle is the SHA-256
/// prefix, so the reference and the record fingerprint must agree.
const ANIMA_SHA: &str = "b7e2c9a4f10d18293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3";
const ANIMA_HANDLE: &str = "b7e2c9a4f10d";

/// The `{model, mode, prompt}` body a stranger sends: the resolver supplies the
/// family word, the checkpoint slot and the diffusion recipe; the ladder fills the
/// rest. `outputPrefix` is the one extra the §5 door has always demanded.
const STRANGER_BODY: &str = r#"{
    "model": "b7e2c9a4f10d",
    "mode": "t2i",
    "positivePrompt": "a lighthouse at dusk",
    "outputPrefix": "agent/run"
}"#;

/// The full fixture kit: tempdir app-data plus every scripted seam the plane holds,
/// named so each drill scripts its own fault posture. The chain slot is boxed so a
/// drill can mount a parking chain at construction; the plane's seam kit is built
/// once (an `Arc<CycleSeams>` is shared by every leg, so slots are not swapped live).
struct Kit {
    dir: tempfile::TempDir,
    commands: Arc<ScriptCommands>,
    chain: Arc<dyn cycle::SubmitChain>,
    door: Arc<ScriptDoor>,
    correlation: Arc<ScriptCorrelation>,
    gate: Arc<ScriptGate>,
    health: Arc<ScriptHealth>,
    pacer: Arc<ScriptPacer>,
    sampler: Arc<ScriptSampler>,
    control: Arc<ScriptControl>,
    /// E28 (LEG AF2-M24c): set when the plane's chain is the RefMod arm-selecting
    /// chain — the handle the export drills read (what crossed the bridge seam).
    refmod: Option<Arc<ScriptRefmodChain>>,
    refmod_bridge: Option<Arc<super::results::FakeRefmodBridge>>,
}

impl Kit {
    /// The benign kit: everything accepts, the card reports nothing, nothing sleeps.
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("tempdir"),
            commands: Arc::new(ScriptCommands::clean()),
            chain: Arc::new(ScriptChain::all_done()),
            door: Arc::new(ScriptDoor::accepting()),
            correlation: Arc::new(ScriptCorrelation::clean()),
            gate: Arc::new(ScriptGate::open()),
            health: Arc::new(ScriptHealth::always_healthy()),
            pacer: Arc::new(ScriptPacer::recording()),
            sampler: Arc::new(ScriptSampler::new([], quiet())),
            control: Arc::new(ScriptControl::default()),
            refmod: None,
            refmod_bridge: None,
        }
    }

    /// The wedge posture: rows park verifiably mid-render inside the shipped
    /// drain, so the judge has an attributed, in-flight subject to watch — and the
    /// control seam reports a live running/pending pair, the scoped-cancel target
    /// set the arm acts on (the same `one_running` fixture the watchdog module's
    /// own tests drive).
    fn parking() -> (Self, Arc<ParkingChain>) {
        let mut kit = Self::new();
        kit.control = Arc::new(ScriptControl::one_running());
        let chain = Arc::new(ParkingChain::new());
        kit.chain = Arc::clone(&chain) as Arc<dyn cycle::SubmitChain>;
        (kit, chain)
    }

    /// The poison posture: scripted per-row outcomes consumed in drain order.
    fn scripted_chain(script: Vec<cycle::RowOutcome>) -> Self {
        let mut kit = Self::new();
        kit.chain = Arc::new(ScriptChain::scripted(script));
        kit
    }

    /// The E28 posture (LEG AF2-M24c): the chain routes RefMod export intents
    /// through the REAL `run_refmod_row` leg over the harness's RefMod bridge
    /// (render intents keep the benign all-done chain). The bridge answers
    /// `posture` — healthy exports land `done`, a refusing one answers the
    /// stock submit sentence (the poison-parity drill).
    fn refmod_bridge(bridge: super::results::FakeRefmodBridge) -> Self {
        let mut kit = Self::new();
        let bridge = Arc::new(bridge);
        let chain = Arc::new(ScriptRefmodChain::over(
            Arc::clone(&bridge) as Arc<dyn super::results::RefmodBridge>
        ));
        // The correlation mount: `run_refmod_row` writes the backend prompt id
        // onto the draining row through the chain's own spool handle — the same
        // journal file the plane reads (the parking-chain drills' idiom).
        chain
            .render
            .mount_spool(Arc::new(Spool::new(kit.dir.path())));
        kit.refmod = Some(Arc::clone(&chain));
        kit.refmod_bridge = Some(bridge);
        kit.chain = chain;
        kit
    }

    /// The foreign-row posture (M9a): the stock session holds active jobs no spool row
    /// is correlated to, so the drain law must refuse the batch before it claims.
    fn foreign_stock_jobs(ids: impl IntoIterator<Item = impl Into<String>>) -> Self {
        let mut kit = Self::new();
        kit.correlation = Arc::new(ScriptCorrelation::foreign(ids));
        kit
    }
}

/// Builds the test plane over the kit: the transport tests' construction path
/// (tempdir app-data, every file-backed handle captured inside it), with the plane's
/// cycle seam kit and the resume watch wired over the SAME scripted health prober
/// the machine drives its restore leg through.
fn plane_with(kit: &Kit) -> PlaneState {
    let app_data = kit.dir.path();
    let resume_probe = Arc::new(ScriptProbe::always(true));
    // E28 (LEG AF2-M24c): the RefMod arm-selecting chain already carries its
    // mounted spool handle (the correlation write inside `run_refmod_row` is
    // the row's home) — the same journal file the plane's spool handle reads,
    // exactly how the parking-chain drills mount theirs. Nothing extra to wire
    // here; the note exists so the mount in `Kit::refmod_bridge` is not read
    // as decorative.
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
        cycle_seams: Arc::new(cycle::CycleSeams {
            commands: Arc::clone(&kit.commands) as Arc<dyn cycle::CommandRunner>,
            chain: Arc::clone(&kit.chain) as Arc<dyn cycle::SubmitChain>,
            door: Arc::clone(&kit.door) as Arc<dyn cycle::BackendDoor>,
            correlation: Arc::clone(&kit.correlation) as Arc<dyn cycle::RowCorrelation>,
            gate: Arc::clone(&kit.gate) as Arc<dyn cycle::ComputeGate>,
            health: Arc::clone(&kit.health) as Arc<dyn cycle::HealthProbe>,
            pacer: Arc::clone(&kit.pacer) as Arc<dyn cycle::Pacer>,
            // The acceptance kit drives cycle postures, never startup attribution: the
            // unreadable home keeps every fault in this file at its plain two-key shape.
            startup: Arc::new(cycle::FixedStartupPreset::unreadable()),
        }),
        watchdog: Arc::new(Watchdog::new(
            app_data,
            Arc::new(WatchdogSeams {
                sampler: Arc::clone(&kit.sampler) as Arc<dyn watchdog::GpuSampler>,
                control: Arc::clone(&kit.control) as Arc<dyn watchdog::WedgeControl>,
            }),
        )),
        ledger: Arc::new(idempotency::Ledger::new(app_data)),
        resume: Arc::new(resume::ResumeWatch::scripted_for_tests(resume_probe)),
        results: Arc::new(super::results::FakeResultsBridge::healthy()),
        refmods: Arc::clone(kit.refmod_bridge.as_ref().unwrap_or(
            &(Arc::new(super::results::FakeRefmodBridge::healthy()))
                as &Arc<super::results::FakeRefmodBridge>,
        )) as Arc<dyn super::results::RefmodBridge>,
        library: None,
        input_root: None,
        output_root: None,
        batch: Arc::new(super::caps::BatchLedger::new()),
        app: None,
        scan: Arc::new(FakeScanBridge::idle()),
        uploads: Arc::new(RecordingUploadBridge::accepting()),
    }
}

/// The whole acceptance fixture: plane and the kit's seam handles. The router is
/// assembled by [`Self::serve`] AFTER the library injection, so the plane the walls
/// wrap carries the same `library` handle the resolver reads.
struct Fixture {
    kit: Kit,
    plane: PlaneState,
}

impl Fixture {
    fn new() -> Self {
        Self::from_kit(Kit::new())
    }

    /// W3-7 (LEG AF2-M21a) correlation mount: the parking chain writes the stock
    /// jobId (`job-run`, the id the `one_running` control reports RUNNING) onto
    /// the row it parks, so the judge sees a correlated running subject and the
    /// grace clock starts honestly — the production correlation law (M9a).
    fn correlate_parking(&self, chain: &Arc<ParkingChain>) {
        chain.correlate_parked(Arc::clone(&self.plane.spool));
    }

    /// The wedge/dropped-socket posture: the plane's chain parks rows mid-render.
    fn parking() -> (Self, Arc<ParkingChain>) {
        let (kit, chain) = Kit::parking();
        (Self::from_kit(kit), chain)
    }

    /// A plane whose drain answers a scripted per-row outcome script.
    fn scripted_chain(script: Vec<cycle::RowOutcome>) -> Self {
        Self::from_kit(Kit::scripted_chain(script))
    }

    /// A plane whose stock session holds uncorrelated active jobs (M9a drain law).
    fn foreign_stock_jobs(ids: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self::from_kit(Kit::foreign_stock_jobs(ids))
    }

    fn from_kit(kit: Kit) -> Self {
        let plane = plane_with(&kit);
        Self { kit, plane }
    }

    /// E28 (LEG AF2-M24c): a plane whose drain routes RefMod export rows through
    /// the real `run_refmod_row` leg over this bridge.
    fn refmod_bridge(bridge: super::results::FakeRefmodBridge) -> Self {
        Self::from_kit(Kit::refmod_bridge(bridge))
    }

    /// The export bridge handle (reads what the drain submitted).
    fn refmod_submitted(&self) -> Vec<Value> {
        self.kit
            .refmod_bridge
            .as_ref()
            .expect("a refmod-kit fixture")
            .submitted
            .lock()
            .unwrap_or_else(|entry| entry.into_inner())
            .clone()
    }

    fn app_data(&self) -> &Path {
        self.kit.dir.path()
    }

    /// The plane under the real wall stack: the closed route index, the auth wall,
    /// the lane gate — the router the live plane serves, as a value.
    fn serve(&self) -> Router {
        router(self.plane.clone())
    }

    /// Writes the minimal operator guard file: the cycle word on with FAKE bat
    /// strings (the ScriptCommands fake records them and never spawns a shell —
    /// the brief's law), a loopback readiness URL, and an optional watchdog window.
    fn write_guard(&self, window_sec: Option<u32>) {
        let watchdog_block = match window_sec {
            Some(window) => format!(r#", "watchdog": {{"windowSec": {window}, "graceSec": 0}}"#),
            None => String::new(),
        };
        std::fs::write(
            self.app_data().join(guard::FILE),
            format!(
                r#"{{"unloadCommand": "fake-unload.bat /agent", "restoreCommand": "fake-restore.bat /agent", "readyUrl": "http://127.0.0.1:18502/health", "autoCycleVram": true, "freeOnQueueEnd": true{watchdog_block}}}"#
            ),
        )
        .expect("guard file");
    }

    /// Points a fake library index at the resolver, exactly the door tests' shape:
    /// the stock snapshot file name, the package-version detector, one anima model
    /// plus its two split-loader components. The model reference then resolves.
    fn with_fake_library(mut self, root: &Path) -> Self {
        self.install_fake_library(root);
        self
    }

    fn install_fake_library(&mut self, root: &Path) {
        let index_dir = self.app_data();
        let roots = vec![root.to_path_buf()];
        let key = {
            use sha2::Digest as _;
            format!(
                "{:x}",
                sha2::Sha256::digest(serde_json::to_vec(&roots).expect("roots"))
            )
        };
        let record = |category: &str,
                      name: &str,
                      sha: Option<&str>,
                      family: Option<&str>,
                      component: Option<&str>| {
            json!({
                "stamp": null,
                "model": {
                    "category": category,
                    "name": name,
                    "path": root.join(category).join(name).to_string_lossy(),
                    "size": 1024,
                    "info": sha.map(|sha| json!({"sha256": sha, "size": 1024, "fetchedAt": 1})),
                    "detectedFamily": family,
                    "component": component,
                }
            })
        };
        let index = json!({
            "schema": crate::downloads::models::index::SCHEMA,
            "detector": env!("CARGO_PKG_VERSION"),
            "roots": roots,
            "records": [
                record("diffusion_models", "anima.safetensors", Some(ANIMA_SHA), Some("anima"), None),
                record("text_encoders", "qwen3-0.6b.safetensors", None, None, Some("qwen3-0.6b")),
                record("vae", "wan_2.1_vae.safetensors", None, None, Some("wan-2.1-vae")),
            ],
        });
        std::fs::write(
            index_dir.join(format!("models-{key}.json")),
            serde_json::to_vec(&index).expect("index bytes"),
        )
        .expect("index file");
        self.plane.library = Some(IndexSource {
            index_dir: index_dir.to_path_buf(),
            roots,
        });
    }

    /// One watchdog tick over the plane's own handles — the shipped loop body,
    /// driven by hand because the harness owns no tauri async runtime slot.
    async fn tick(&self) {
        let loop_plane = watchdog::LoopPlane {
            cell: Arc::clone(&self.plane.cycle),
            spool: Arc::clone(&self.plane.spool),
            seams: Arc::clone(&self.plane.cycle_seams),
        };
        watchdog::tick(&self.plane.watchdog, &loop_plane).await;
    }

    /// Reads the journal event words, oldest first — the durable instrument.
    fn journal_words(&self) -> Vec<String> {
        self.plane
            .watchdog
            .journal()
            .rows()
            .expect("journal readable")
            .iter()
            .map(|row| row["event"].as_str().unwrap_or_default().to_owned())
            .collect()
    }
}

/* ------------------------------ the request idiom (one, the door tests') ------------------------------ */

fn get_request(path: &str) -> Request {
    Request::builder()
        .method("GET")
        .uri(format!("http://127.0.0.1:8790{path}"))
        .header("host", "127.0.0.1:8790")
        .header("origin", "http://localhost:1420")
        .body(Body::empty())
        .expect("valid test request")
}

fn post_request(path: &str, body_text: &str) -> Request {
    Request::builder()
        .method("POST")
        .uri(format!("http://127.0.0.1:8790{path}"))
        .header("host", "127.0.0.1:8790")
        .header("origin", "http://localhost:1420")
        .header("content-type", "application/json")
        .body(Body::from(body_text.to_owned()))
        .expect("valid test request")
}

async fn call(mut app: Router, request: Request) -> (StatusCode, Value) {
    let response = app.call(request).await.expect("router answers");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("body readable");
    let value: Value = serde_json::from_slice(&bytes).expect("json body");
    (status, value)
}

/// Polls `GET /v1/cycle` until the cell answers terminal (idle with a persisted
/// report), the caller's side of the `wait:"poll"` contract. The scripted pacer
/// never sleeps, so a small bounded budget is plenty; the budget failing is a
/// harness bug, not a plane posture.
async fn await_terminal(app: &Router, cycle_id: &str) -> Value {
    for _ in 0..200_u32 {
        let (status, view) = call(app.clone(), get_request("/v1/cycle")).await;
        assert_eq!(status, StatusCode::OK, "{view}");
        if view["phase"] == json!("idle") && view["report"].is_object() {
            assert_eq!(
                view["cycleId"].as_str(),
                Some(cycle_id),
                "the terminal cycle names the cycle the door claimed"
            );
            return view["report"].clone();
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    panic!("the cycle never answered terminal: {cycle_id}");
}

/// Reads the durable spool bytes: the file IS the state, and the drills assert on
/// the bytes, not only the listing.
fn spool_rows(app_data: &Path) -> Vec<Value> {
    let bytes = std::fs::read(app_data.join(spool::FILE)).expect("spool on disk");
    let file: Value = serde_json::from_slice(&bytes).expect("valid spool json");
    file["rows"].as_array().cloned().unwrap_or_default()
}

fn status_of(rows: &[Value], id: &str) -> String {
    rows.iter()
        .find(|row| row["id"].as_str() == Some(id))
        .and_then(|row| row["status"].as_str())
        .unwrap_or_default()
        .to_owned()
}

/* ------------------------------ 1. the stranger happy path ------------------------------ */

#[tokio::test]
async fn stranger_from_fresh_posture_reaches_resume_ready_through_fake_cycle_legs() {
    let _gate = crate::resources::fence_test_gate();
    let fixture = Fixture::new();

    // Fresh posture: no settings, no guard, no defaults, no spool, no ledger. The
    // honest refusals answer BEFORE any operator file exists — the plane guesses
    // nothing. An empty plane lists an empty spool.
    let app = fixture.serve();

    // Fresh posture: no settings, no guard, no defaults, no spool, no ledger. The
    // honest refusals answer BEFORE any operator file exists — the plane guesses
    // nothing. An empty plane lists an empty spool.
    assert!(!fixture.app_data().join(super::config::FILE).exists());
    assert!(!fixture.app_data().join(guard::FILE).exists());
    assert!(!fixture.app_data().join(defaults::FILE).exists());
    let (status, body) = call(app.clone(), get_request("/v1/queue")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["count"], 0);
    let (status, body) = call(app.clone(), get_request("/v1/cycle")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["configured"], false, "no guard file yet");
    assert_eq!(body["phase"], "idle");
    // The drain door without operator config is `guardUnconfigured` (409), honest
    // and actionable; the cycle never starts on invented commands.
    let (status, body) = call(app.clone(), post_request("/v1/generate", "")).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["reason"], "guardUnconfigured");
    // A model reference over an unwired library is `libraryScanRequired` (422).
    let (status, body) = call(app.clone(), post_request("/v1/queue", STRANGER_BODY)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["reason"], "libraryScanRequired");

    // The operator writes the minimal files: the guard with FAKE bat commands
    // (never spawned — the scripted CommandRunner records them) and autoCycleVram
    // true, plus the fake library index the resolver reads. The plane posture in
    // this harness is the test plane the door tests build: same construction path,
    // faked cycle seams mounted where the stock kit sits at boot.
    fixture.write_guard(None);
    let root = tempfile::tempdir().expect("model root");
    let fixture = fixture.with_fake_library(root.path());
    let app = fixture.serve();

    // POST /v1/queue with {model, mode, prompt} ONLY (plus the prefix the §5 door
    // has always demanded): the ladder resolves the family, the slots and the
    // recipe; the row lands drain-ready.
    let (status, body) = call(app.clone(), post_request("/v1/queue", STRANGER_BODY)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "queued");
    assert_eq!(body["modelHandle"], ANIMA_HANDLE);
    assert_eq!(body["envelope"]["family"], "anima");
    assert_eq!(body["envelope"]["missingSlots"], json!([]));
    let row_id = body["id"].as_str().expect("row id").to_owned();
    assert_eq!(
        status_of(&spool_rows(fixture.app_data()), &row_id),
        "queued"
    );

    // POST /v1/generate wait:"poll" -> 202 + cycleId; the driver runs detached.
    let (status, body) = call(
        app.clone(),
        post_request(
            "/v1/generate",
            r#"{"wait": "poll", "key": "stranger-key-01"}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(body["wait"], "poll");
    let cycle_id = body["cycleId"].as_str().expect("cycle id").to_owned();

    // The cycle legs run over the fakes and answer terminal: ok, freed, restored.
    let report = await_terminal(&app, &cycle_id).await;
    assert_eq!(report["ok"], true, "{report}");
    assert_eq!(
        report["freed"], true,
        "the free leg acked through the fake door"
    );
    assert_eq!(report["modelRestored"], true);
    assert_eq!(report["autoCycleVram"], true);
    let rows = report["rows"].as_array().expect("report rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"].as_str(), Some(row_id.as_str()));
    assert_eq!(rows[0]["status"], "done");

    // GET /v1/resume answers ready.
    let (status, body) = call(app.clone(), get_request("/v1/resume")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["state"], "ready");
    assert_eq!(body["ready"], true);

    // GET /v1/queue: the drained row keeps terminal history; NOTHING stays queued
    // (M4 housekeeping law), so the spool holds no drain-ready work.
    let (status, body) = call(app.clone(), get_request("/v1/queue")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["count"], 1);
    assert_eq!(body["rows"][0]["status"], "done");
    let listed = spool_rows(fixture.app_data());
    assert_eq!(status_of(&listed, &row_id), "done");
    assert!(
        listed
            .iter()
            .all(|row| row["status"].as_str() != Some(RowStatus::Queued.word())),
        "no queued row survives the drain"
    );

    // The idempotency ledger is terminal for the key's cycle, and the journal
    // files keep their own counsel: the cycle cell file exists, the watchdog
    // journal stays uncreated (no tick ran — the plane's legs never touch it).
    let ledger_bytes =
        std::fs::read(fixture.app_data().join(idempotency::FILE)).expect("ledger on disk");
    let ledger: Value = serde_json::from_slice(&ledger_bytes).expect("valid ledger json");
    assert_eq!(ledger["rows"][0]["state"], "terminal");
    assert_eq!(ledger["rows"][0]["cycleId"], cycle_id.as_str());
    assert!(
        fixture.app_data().join(cycle::FILE).exists(),
        "the terminal report is durable in the cell file"
    );
    assert!(
        !fixture.app_data().join(watchdog::JOURNAL_FILE).exists(),
        "the watchdog journal stays untouched by an unwatched plane"
    );
}
/* --------------------- 1b. the E28 RefMod export row (queue door -> drain) --------------------- */

/// The queue body a stranger sends for the drainable RefMod export ROW (mode
/// `refmod`, E28 / LEG AF2-M24c): no model, no prompt, no dials — the five
/// optionals, the E16 reference surface and the saved bag.
const REFMOD_ROW_BODY: &str = r#"{
    "family": "minimax-h3",
    "mode": "refmod",
    "name": "hero",
    "description": "main cast",
    "conceptType": "identity",
    "refmods": ["old-set.safetensors"]
}"#;

#[tokio::test]
async fn a_queued_refmod_row_drains_to_done_with_its_outputs_descriptor() {
    let _gate = crate::resources::fence_test_gate();
    let fixture = Fixture::refmod_bridge(super::results::FakeRefmodBridge::healthy());
    fixture.write_guard(None);
    let app = fixture.serve();

    // The queue door mints the row (answer shape parity with a render row: id,
    // status word, envelope; `seed`/`modelHandle` answer honestly null).
    let (status, body) = call(app.clone(), post_request("/v1/queue", REFMOD_ROW_BODY)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "queued");
    assert!(body["id"].is_string(), "the row keeps the row identity");
    assert_eq!(body["seed"], Value::Null, "an export carries no seed");
    assert_eq!(
        body["modelHandle"],
        Value::Null,
        "an export resolves no model"
    );
    assert_eq!(body["envelope"]["mode"], "refmod");
    assert_eq!(body["envelope"]["recipe"]["recipeId"], "refmod-export");
    let row_id = body["id"].as_str().expect("row id").to_owned();

    // The drain rides the REAL refmod arm (`ScriptRefmodChain` replays the
    // shipped chain's discriminator over the fake bridge): E29 gate -> submit
    // -> poll -> terminal. The row answers done with the outputs descriptor
    // naming the stock result's safetensors in the `refmods` model subfolder.
    let (status, body) = call(
        app.clone(),
        post_request(
            "/v1/generate",
            r#"{"wait": "poll", "key": "refmod-key-01"}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let cycle_id = body["cycleId"].as_str().expect("cycle id").to_owned();
    let report = await_terminal(&app, &cycle_id).await;
    assert_eq!(report["ok"], true, "{report}");
    let rows = report["rows"].as_array().expect("report rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"].as_str(), Some(row_id.as_str()));
    assert_eq!(rows[0]["status"], "done", "{report}");
    assert_eq!(
        rows[0]["outputs"],
        json!([{ "filename": "hero.safetensors", "subfolder": "refmods" }]),
        "the M24b descriptor law rides the queue-door row verbatim"
    );
    assert_eq!(
        rows[0]["jobId"],
        json!("3f2a1b6c-0000-4000-8000-000000000000"),
        "the correlation is the BACKEND PROMPT ID (the E28 carve-out)"
    );

    // The bridge received the CLOSED compile request the door built — the same
    // map the envelope carries and `flat_intent` rebuilds (the spool leg pins
    // the byte-equality; this is the door-to-bridge half).
    let submitted = fixture.refmod_submitted();
    assert_eq!(submitted.len(), 1, "exactly one export crossed the seam");
    assert_eq!(
        submitted[0],
        json!({
            "name": "hero",
            "description": "main cast",
            "conceptType": "identity",
            "media": [],
            "refmods": ["old-set.safetensors"]
        }),
        "the closed request, plane words stripped, no ladder keys"
    );

    // Durable state: the row is done on disk, correlated to the prompt id.
    let listed = spool_rows(fixture.app_data());
    assert_eq!(status_of(&listed, &row_id), "done");
    let correlated = listed
        .iter()
        .find(|row| row["id"].as_str() == Some(row_id.as_str()))
        .expect("the row");
    assert_eq!(
        correlated["jobId"].as_str(),
        Some("3f2a1b6c-0000-4000-8000-000000000000")
    );
}

#[tokio::test]
async fn a_refmod_row_refused_at_submit_fails_with_poison_parity() {
    let _gate = crate::resources::fence_test_gate();
    // The stock no-backend sentence, refused at the bridge submit: the row
    // fails at SUBMIT exactly like a render row that never reached the backend
    // — the detail names `submit failed:` (poison-guard fuel, §5), the cycle
    // still runs its free and restore legs.
    let fixture = Fixture::refmod_bridge(super::results::FakeRefmodBridge::refusing(
        "no owned backend is running (state 'stopped')",
    ));
    fixture.write_guard(None);
    let app = fixture.serve();
    let (status, body) = call(app.clone(), post_request("/v1/queue", REFMOD_ROW_BODY)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let row_id = body["id"].as_str().expect("row id").to_owned();

    let (status, body) = call(
        app.clone(),
        post_request(
            "/v1/generate",
            r#"{"wait": "poll", "key": "refmod-key-02"}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let cycle_id = body["cycleId"].as_str().expect("cycle id").to_owned();
    let report = await_terminal(&app, &cycle_id).await;
    let rows = report["rows"].as_array().expect("report rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"].as_str(), Some(row_id.as_str()));
    assert_eq!(rows[0]["status"], "failed", "{report}");
    assert_eq!(rows[0]["outputs"], Value::Null, "nothing was produced");
    // The report's wire key for a failed row is `error` (M12 shape: a plain
    // string when unclassified, {kind,detail} when classified).
    let detail = rows[0]["error"]
        .as_str()
        .or_else(|| rows[0]["error"]["detail"].as_str())
        .unwrap_or_default();
    assert!(
        detail.contains("submit failed: no owned backend is running"),
        "the stock sentence rides verbatim, submit-side: {}",
        rows[0]["error"]
    );
    assert_eq!(
        status_of(&spool_rows(fixture.app_data()), &row_id),
        "failed"
    );
}

#[tokio::test]
async fn a_refmod_row_queues_beside_a_live_cycle_and_renders_like_any_row() {
    let _gate = crate::resources::fence_test_gate();
    // Ruling 7: unlike the one-shot door, the ROW door takes NO cycleInFlight
    // wall — the whole point of E28 is that the row waits in the spool and
    // drains inside a later cycle. And ruling (e): the queue answer and the
    // `GET /v1/queue` listing render the export row with the same identity and
    // status words as a render row.
    let fixture = Fixture::refmod_bridge(super::results::FakeRefmodBridge::healthy());
    fixture.write_guard(None);

    // A render row (so one cycle has real batch work) plus a first export row.
    let root = tempfile::tempdir().expect("model root");
    let fixture = fixture.with_fake_library(root.path());
    let app = fixture.serve();
    let (status, render) = call(app.clone(), post_request("/v1/queue", STRANGER_BODY)).await;
    assert_eq!(status, StatusCode::OK, "{render}");
    let (status, first) = call(app.clone(), post_request("/v1/queue", REFMOD_ROW_BODY)).await;
    assert_eq!(status, StatusCode::OK, "{first}");

    let (status, body) = call(
        app.clone(),
        post_request(
            "/v1/generate",
            r#"{"wait": "poll", "key": "refmod-key-03"}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let cycle_id = body["cycleId"].as_str().expect("cycle id").to_owned();

    // Determinism before the mid-cycle POST: the batch is claimed when the
    // drive reaches `draining`, so the second row provably arrives AFTER the
    // claim — without this park the membership of the first report races the
    // append (the claim is async behind ACCEPTED).
    for _ in 0..200 {
        let view = call(app.clone(), get_request("/v1/cycle")).await.1;
        if view["phase"].as_str() == Some("draining") {
            break;
        }
        tokio::task::yield_now().await;
    }

    // Mid-cycle queueing: the door answers the row, never `cycleInFlight`.
    // (The batch snapshot is the cycle's start list, so this row honestly
    // waits for the next batch — queued, not refused.)
    let (status, second) = call(app.clone(), post_request("/v1/queue", REFMOD_ROW_BODY)).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_ne!(second["reason"].as_str(), Some("cycleInFlight"), "{second}");
    let second_id = second["id"].as_str().expect("row id").to_owned();

    let report = await_terminal(&app, &cycle_id).await;
    assert_eq!(report["ok"], true, "{report}");
    assert_eq!(report["rows"].as_array().expect("report rows").len(), 2);

    // Answer-shape parity in the listing: both rows carry the identity and the
    // lifecycle words a render row carries (the export's family/seed/prompt are
    // honestly null — the export has no model and no prompt).
    let (status, body) = call(app.clone(), get_request("/v1/queue")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["count"], 3, "{body}");
    let export_rows: Vec<&Value> = body["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .filter(|row| row["mode"] == json!("refmod"))
        .collect();
    assert_eq!(export_rows.len(), 2);
    for row in &export_rows {
        assert!(row["id"].is_string() && row["createdAt"].is_number());
        assert!(
            matches!(row["status"].as_str(), Some("done") | Some("queued")),
            "{row}"
        );
    }
    let listed = spool_rows(fixture.app_data());
    assert_eq!(
        status_of(&listed, &second_id),
        "queued",
        "the mid-cycle row waits honestly"
    );

    // The next batch drains it: the spool holds queued work, the cycle takes it.
    let (status, body) = call(
        app.clone(),
        post_request(
            "/v1/generate",
            r#"{"wait": "poll", "key": "refmod-key-04"}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let cycle_id = body["cycleId"].as_str().expect("cycle id").to_owned();
    let report = await_terminal(&app, &cycle_id).await;
    let rows = report["rows"].as_array().expect("report rows");
    assert_eq!(rows.len(), 1, "{report}");
    assert_eq!(rows[0]["id"].as_str(), Some(second_id.as_str()));
    assert_eq!(rows[0]["status"], "done", "{report}");
    // Both exports crossed the bridge; nothing else did.
    assert_eq!(fixture.refmod_submitted().len(), 2);
}

#[tokio::test]
async fn the_refmod_row_rides_the_e16_alias_and_the_e24_placement_law_like_every_door() {
    let _gate = crate::resources::fence_test_gate();
    // E16 (ruling 4): the `pictureN` alias folds into the canonical arrays at
    // this door exactly as at every other. E24: a local-path reference is
    // CONTAINED — rewritten to the placed form inside the input root, and
    // server-side copied from the output root into a fresh placement. The
    // envelope's media rows carry the PLACED names, never the caller's path.
    let mut fixture = Fixture::refmod_bridge(super::results::FakeRefmodBridge::healthy());
    fixture.write_guard(None);
    let inputs = tempfile::tempdir().expect("input root");
    let outputs = tempfile::tempdir().expect("output root");
    let inputs_dir = inputs.path().join("deas-inputs");
    std::fs::create_dir(&inputs_dir).expect("deas-inputs");
    std::fs::write(inputs_dir.join("a.png"), b"fixture bytes").expect("input file");
    std::fs::write(outputs.path().join("clip.mp4"), b"fixture bytes").expect("output file");
    fixture.plane.input_root = Some(inputs.path().to_path_buf());
    fixture.plane.output_root = Some(outputs.path().to_path_buf());
    let app = fixture.serve();

    let body = json!({
        "family": "minimax-h3",
        "mode": "refmod",
        "name": "hero",
        "picture1": inputs_dir.join("a.png").to_string_lossy(),
        "video1": outputs.path().join("clip.mp4").to_string_lossy(),
    })
    .to_string();
    let (status, answer) = call(app.clone(), post_request("/v1/queue", &body)).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    // The guard writes autoCycleVram: true, but the door-driven cycle is the
    // honest way to reach the terminal report in a drill: start it explicitly
    // and await it (the same wait-poll posture every failure drill uses) — an
    // assertion on the bridge before the drain finishes would race the spawn.
    let (status, body) = call(
        app.clone(),
        post_request(
            "/v1/generate",
            r#"{"wait": "poll", "key": "refmod-key-05"}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let cycle_id = body["cycleId"].as_str().expect("cycle id").to_owned();
    let report = await_terminal(&app, &cycle_id).await;
    assert_eq!(report["ok"], true, "{report}");
    let rows = report["rows"].as_array().expect("report rows");
    assert_eq!(rows.len(), 1, "{report}");
    assert_eq!(rows[0]["status"], "done", "{report}");
    let fields = answer["envelope"]["fields"].as_array().expect("fields");
    let media_row = fields
        .iter()
        .find(|entry| entry["field"] == "media")
        .expect("the media field rides the envelope");
    let media = media_row["value"].as_array().expect("media rows");
    assert_eq!(
        media[0],
        json!({ "type": "image", "file": "deas-inputs/a.png", "slot": 0 }),
        "the alias folded and the input-root path rewrote to the placed form: {media_row}"
    );
    // E24's copy arm: the output-root clip became a fresh placement the door
    // itself minted — a `deas-inputs/<uuid>.mp4` name under the input
    // root (the stock uuid placement grammar, stem not carried), never the
    // caller's path, and the bytes now sit there (the E24 copy arm, one home,
    // riding this door like every other).
    assert_eq!(media[1]["type"], "video", "{media_row}");
    assert_eq!(
        media[1]["slot"], 0,
        "lane slots are own-lane zero-based (lane_media_items, the one home): image lane slot 0, video lane slot 0"
    );
    let placed_name = media[1]["file"].as_str().expect("a placed name");
    assert!(
        placed_name.starts_with("deas-inputs/") && placed_name.ends_with(".mp4"),
        "the output-root copy became a fresh uuid placement: {placed_name}"
    );
    assert!(
        !placed_name.contains("clip"),
        "the E24 copy arm mints its own uuid name, never the caller's stem: {placed_name}"
    );
    assert!(
        inputs.path().join(placed_name.replace('/', "\\")).exists(),
        "the copied bytes live under the engine's input folder: {placed_name}"
    );
    let submitted = fixture.refmod_submitted();
    assert_eq!(
        submitted.len(),
        1,
        "the row queued and drained exactly once"
    );
    assert_eq!(submitted[0]["media"], media_row["value"]);
}

/* ------------------------------ 2. the failure drills ------------------------------ */

/// Queues `STRANGER_BODY` once and returns the row id.
async fn queue_stranger(app: &Router) -> String {
    let (status, body) = call(app.clone(), post_request("/v1/queue", STRANGER_BODY)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["id"].as_str().expect("row id").to_owned()
}

/// Counts the recorded bat runs whose command contains `needle` (the scripted
/// CommandRunner records every operator string; none is ever spawned).
fn command_runs(fixture: &Fixture, needle: &str) -> usize {
    fixture
        .kit
        .commands
        .runs
        .lock()
        .expect("command log")
        .iter()
        .filter(|run| run.contains(needle))
        .count()
}

#[tokio::test]
async fn an_unload_bat_nonzero_exit_hands_off_a_409_and_the_spool_stays_queued() {
    let _gate = crate::resources::fence_test_gate();
    let fixture = Fixture::new();
    fixture.write_guard(None);
    let root = tempfile::tempdir().expect("model root");
    let fixture = fixture.with_fake_library(root.path());
    let app = fixture.serve();
    let first = queue_stranger(&app).await;
    let second = queue_stranger(&app).await;

    // The drill posture: the unload bat exits non-zero at the fake command seam.
    fixture.kit.commands.set_unload_exit(3);
    let (status, body) = call(
        app.clone(),
        post_request("/v1/generate", r#"{"wait": "cycle"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["reason"], "handoffFailed");
    assert!(
        body["hint"]
            .as_str()
            .expect("hint")
            .contains("unload command exited 3"),
        "the hint names the exit"
    );

    // The cycle answered terminal with the handoff fault; nothing else ran.
    let view = call(app.clone(), get_request("/v1/cycle")).await.1;
    assert_eq!(
        view["phase"], "idle",
        "the fence released with the terminal cycle"
    );
    let report = view.get("report").expect("terminal persisted").clone();
    assert_eq!(report["ok"], false);
    assert_eq!(report["fault"]["reason"], "handoffFailed");
    assert_eq!(report["rows"].as_array().expect("rows").len(), 2);
    assert!(
        report["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .all(|row| row["status"] == "queued"),
        "the report says honestly that every row is still queued: {report}"
    );

    // The durable spool is intact: both rows still `queued`, never rewritten.
    let rows = spool_rows(fixture.app_data());
    assert_eq!(status_of(&rows, &first), "queued");
    assert_eq!(status_of(&rows, &second), "queued");

    // The fence is provably released: the next batch claims and drains.
    fixture.kit.commands.set_unload_exit(0);
    let (status, body) = call(
        app.clone(),
        post_request("/v1/generate", r#"{"wait": "cycle"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);
    let rows = spool_rows(fixture.app_data());
    assert_eq!(status_of(&rows, &first), "done");
    assert_eq!(status_of(&rows, &second), "done");
}

#[tokio::test]
async fn the_backend_door_nacking_free_twice_completes_on_the_third_same_wire_attempt() {
    let _gate = crate::resources::fence_test_gate();
    let fixture = Fixture::new();
    *fixture.kit.door.free_postures.lock().expect("free script") = vec![false, false, true].into();
    fixture.write_guard(None);
    let root = tempfile::tempdir().expect("model root");
    let fixture = fixture.with_fake_library(root.path());
    let app = fixture.serve();
    queue_stranger(&app).await;

    let (status, body) = call(
        app.clone(),
        post_request("/v1/generate", r#"{"wait": "cycle"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["ok"], true,
        "two nacks inside the bound are retried, not faulted"
    );
    assert_eq!(body["freed"], true);
    assert_eq!(body["modelRestored"], true);
    assert_eq!(
        fixture
            .kit
            .door
            .free_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        3,
        "exactly three free attempts: nack, nack, ack"
    );

    // Every attempt rode the exact same two-key body (the resources.rs wire law).
    let bodies = fixture
        .kit
        .door
        .free_bodies
        .lock()
        .expect("free log")
        .clone();
    assert_eq!(bodies.len(), 3);
    for attempt_body in &bodies {
        assert_eq!(
            attempt_body,
            &json!({"unload_models": true, "free_memory": true}),
            "retry re-sends the exact two-key wire, never a new shape"
        );
    }

    // The pacer script proves the leg order: settle, then the down-hold and the
    // patience after the ack — the shipped consts, named by their recorded values.
    let pauses = fixture.kit.pacer.pauses.lock().expect("pacer log").clone();
    assert_eq!(pauses.first(), Some(&cycle::SETTLE_MS));
    let tail = &pauses[pauses.len() - 2..];
    assert_eq!(tail, [cycle::DOWN_HOLD_MS, cycle::PATIENCE_MS]);
}

#[tokio::test]
async fn two_submit_failures_of_three_poison_the_drain_and_the_third_row_stays_queued() {
    let _gate = crate::resources::fence_test_gate();
    let outcome = |detail: &str| cycle::RowOutcome {
        succeeded: false,
        detail: Some(detail.to_owned()),
        error_kind: None,
        submit_failed: true,
        job_id: None,
        outputs: None,
    };
    let fixture = Fixture::scripted_chain(vec![
        outcome("scripted: compile refused"),
        outcome("scripted: submit refused"),
    ]);
    fixture.write_guard(None);
    let root = tempfile::tempdir().expect("model root");
    let fixture = fixture.with_fake_library(root.path());
    let app = fixture.serve();
    let first = queue_stranger(&app).await;
    let second = queue_stranger(&app).await;
    let third = queue_stranger(&app).await;

    let (status, body) = call(
        app.clone(),
        post_request("/v1/generate", r#"{"wait": "cycle"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["reason"], "maintenanceActive");
    assert!(
        body["hint"]
            .as_str()
            .expect("hint")
            .contains("poison-row guard"),
        "the hint names the guard: {}",
        body["hint"]
    );

    // The first two rows are terminal-failed; the third was NEVER started and the
    // durable spool keeps it honestly `queued`.
    let rows = spool_rows(fixture.app_data());
    assert_eq!(status_of(&rows, &first), "failed");
    assert_eq!(status_of(&rows, &second), "failed");
    assert_eq!(
        status_of(&rows, &third),
        "queued",
        "the poison guard never marks the unstarted row"
    );
    let report = call(app.clone(), get_request("/v1/cycle")).await.1["report"].clone();
    let report_rows = report["rows"].as_array().cloned().expect("report rows");
    assert_eq!(report_rows.len(), 3);
    assert_eq!(report_rows[2]["status"], "queued");

    // The legs still ran: the card comes back after a poison abort (free acked,
    // unload and restore bats recorded at the fake command seam).
    assert_eq!(command_runs(&fixture, "unload"), 1);
    assert_eq!(command_runs(&fixture, "restore"), 1);
    assert_eq!(
        report["freed"], true,
        "the free leg ran after the poison abort"
    );
    assert_eq!(report["modelRestored"], true);
    assert_eq!(
        fixture
            .kit
            .door
            .free_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

#[tokio::test]
async fn an_uncorrelated_active_stock_job_refuses_the_drain_by_name_and_never_claims_the_fence() {
    // M9a jobUnknown drain law, over the real door: a stock job this plane never
    // recorded on a row is a render it cannot see, cannot wait for and cannot release
    // the card under, so `POST /v1/generate` refuses while it is active. The refusal
    // lands BEFORE the fence claim: nothing is claimed, nothing is parked, no bat runs
    // and every queued row stays honestly queued.
    let fixture = Fixture::foreign_stock_jobs(["foreign-job-1", "foreign-job-2"]);
    fixture.write_guard(None);
    let root = tempfile::tempdir().expect("model root");
    let fixture = fixture.with_fake_library(root.path());
    let app = fixture.serve();
    let row_id = queue_stranger(&app).await;
    let (status, body) = call(
        app.clone(),
        post_request("/v1/generate", r#"{"wait": "poll"}"#),
    )
    .await;
    // The word and its taxonomy status (one home: errors.rs maps `jobUnknown`).
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["reason"], "jobUnknown", "{body}");
    assert_eq!(body["error"], "JOB_UNKNOWN", "{body}");
    let hint = body["hint"].as_str().expect("the hint names the ids");
    assert!(
        hint.contains("foreign-job-1") && hint.contains("foreign-job-2"),
        "{hint} names both foreign ids"
    );
    assert!(
        hint.contains("/v1/stop") && hint.contains("/v1/jobs/{id}/cancel"),
        "{hint} names the operator's remedy"
    );
    // The law is consulted exactly once, at the door, before the claim.
    assert_eq!(
        fixture
            .kit
            .correlation
            .calls
            .load(std::sync::atomic::Ordering::SeqCst),
        1,
        "one correlation read per generate"
    );
    // The cell is idle with nothing persisted: the refusal claimed no fence.
    let (view_status, view) = call(app.clone(), get_request("/v1/cycle")).await;
    assert_eq!(view_status, StatusCode::OK, "{view}");
    assert_eq!(view["phase"], "idle", "the fence was never claimed: {view}");
    assert!(view["report"].is_null(), "no cycle answered: {view}");
    assert_eq!(command_runs(&fixture, "unload"), 0, "no leg ran");
    assert_eq!(
        fixture.kit.commands.runs.lock().expect("command log").len(),
        0
    );
    let rows = spool_rows(fixture.app_data());
    assert_eq!(
        status_of(&rows, &row_id),
        "queued",
        "the row waits honestly for a drain that is allowed to start"
    );
}

#[tokio::test]
async fn a_quiet_wedge_on_an_attributed_row_severs_in_the_law_order_and_the_held_caller_answers_jobwedged(
) {
    let _gate = crate::resources::fence_test_gate();
    // §8.2 order is law; the durable journal is the instrument that proves it.
    let (fixture, chain) = Fixture::parking();
    // W3-7 (LEG AF2-M21a): the grace clock starts only at a CORRELATED running
    // subject — mount the correlation so this drill scripts a row whose stock
    // job is genuinely seen running (the `one_running` pair above).
    fixture.correlate_parking(&chain);
    // The shipped floor for the window is 30 s (the clamp law), so the judge needs
    // 30 quiet ticks; the ticks run back to back here, the pacer never sleeps.
    fixture.write_guard(Some(watchdog::MIN_WINDOW_SEC));
    let root = tempfile::tempdir().expect("model root");
    let fixture = fixture.with_fake_library(root.path());
    let app = fixture.serve();
    let row_id = queue_stranger(&app).await;

    // The held generate: wait:"cycle" parks inside the render while the judge
    // watches the attributed, in-flight row.
    let caller = tokio::spawn(call(
        app.clone(),
        post_request("/v1/generate", r#"{"wait": "cycle"}"#),
    ));
    let mut drained = false;
    for _ in 0..200_u32 {
        if status_of(&spool_rows(fixture.app_data()), &row_id) == RowStatus::Draining.word() {
            drained = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    assert!(
        drained,
        "the row reached the render before the judge watched"
    );

    // The scripted card is quiet, and the guard file's watchdog block carries no
    // grace, so the shipped window floor (30 s) is the earliest lawful trip: 30
    // back-to-back ticks (the pacer fake never sleeps). The arm runs inline in the
    // tick, exactly as the shipped loop runs it.
    let mut tripped = false;
    for _ in 0..60 {
        fixture.tick().await;
        if !fixture.journal_words().is_empty() {
            tripped = true;
            break;
        }
    }
    assert!(tripped, "the quiet window never tripped the judge");

    // The journal pins the order: trip, then cancel → confirm → clear → free →
    // RESTORE, then the answer row (sever) last.
    let words = fixture.journal_words();
    assert_eq!(
        words,
        vec![
            "watchdog-trip",
            "watchdog-cancel",
            "watchdog-confirm",
            "watchdog-clear",
            "watchdog-free",
            "watchdog-restore",
            "watchdog-sever",
        ],
        "the arm's step order, straight off the durable journal"
    );
    // The scoped cancel verbs hit the running job, and the latched row went to the
    // durable `wedged` word.
    let control_calls = fixture
        .kit
        .control
        .calls
        .lock()
        .expect("control log")
        .clone();
    assert!(control_calls.contains(&"interrupt job-run".to_owned()));
    assert_eq!(
        status_of(&spool_rows(fixture.app_data()), &row_id),
        "wedged"
    );

    // The arm restored the model (fake bats, fake health): the drain's finish path
    // records the sever as the cycle's fault instead of re-running the legs, and
    // the held caller is answered with the taxonomy's sever word.
    chain.release();
    let (status, body) = caller.await.expect("held generate answered");
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert_eq!(body["reason"], "jobWedged");
    assert_eq!(body["error"], "JOB_WEDGED");

    // The resume posture after the sever is `ready`: the arm restored the model and
    // the terminal report carries it.
    let (status, body) = call(app.clone(), get_request("/v1/resume")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["state"], "ready",
        "the sever's restore lands the ready posture"
    );
    let view = call(app.clone(), get_request("/v1/cycle")).await.1;
    assert_eq!(view["phase"], "idle", "the drain closed the borrowed cycle");
    assert_eq!(
        view.get("report").expect("report")["fault"]["reason"],
        watchdog::FAULT_SEVER,
        "the drain records the sever as the cycle's fault, never a coined word"
    );
}

#[tokio::test]
async fn restore_exhaustion_runs_exactly_three_attempts_and_resume_never_answers_ready() {
    let _gate = crate::resources::fence_test_gate();
    // The readiness target NEVER answers: an all-false script whose fallback is
    // also false, so the posture cannot drift back to healthy when the script
    // runs out (the health fake's own fallback law).
    let health = Arc::new(ScriptHealth::scripted(vec![false; 64]));
    let mut kit = Kit::new();
    kit.health = health;
    let fixture = Fixture::from_kit(kit);
    fixture.write_guard(None);
    let root = tempfile::tempdir().expect("model root");
    let fixture = fixture.with_fake_library(root.path());
    let app = fixture.serve();
    queue_stranger(&app).await;

    let (status, body) = call(
        app.clone(),
        post_request("/v1/generate", r#"{"wait": "cycle"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["reason"], "restoreExhausted");

    // §8.4: the bound is exactly three attempts, the gaps between them the shipped
    // RESTORE_GAP_MS recorded on the pacer seam — never a fourth attempt.
    assert_eq!(command_runs(&fixture, "restore"), 3);
    let gaps = fixture
        .kit
        .pacer
        .pauses
        .lock()
        .expect("pacer log")
        .iter()
        .filter(|pause| **pause == cycle::RESTORE_GAP_MS)
        .count();
    assert_eq!(gaps, 2, "three attempts carry exactly two gaps");

    // The debt is visible on the durable report, and resume answers the §8.4 word:
    // `failed` — never `ready` while the target never answered.
    let report = call(app.clone(), get_request("/v1/cycle")).await.1["report"].clone();
    assert_eq!(report["ok"], false);
    assert_eq!(report["fault"]["reason"], "restoreExhausted");
    assert_eq!(
        report["modelRestored"], false,
        "the owed restore is on the record"
    );
    let (status, body) = call(app.clone(), get_request("/v1/resume")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["state"], "failed");
    assert_eq!(body["ready"], false);
}

#[tokio::test]
async fn a_dropped_generate_socket_never_cancels_the_cycle_the_cycle_door_still_answers() {
    let _gate = crate::resources::fence_test_gate();
    // §7.3 dropped-socket law: the caller going away is not a cancel and not a
    // re-run license — the machine keeps the cycle and the terminal report
    // persists for the resume read. The harness models the caller's disappearance
    // by dropping its JoinHandle (a detached task keeps running); ABORTING it
    // would be a cancel, which is exactly the power the law denies a caller.
    let (fixture, chain) = Fixture::parking();
    fixture.write_guard(None);
    let root = tempfile::tempdir().expect("model root");
    let fixture = fixture.with_fake_library(root.path());
    let app = fixture.serve();
    let row_id = queue_stranger(&app).await;

    let caller = tokio::spawn(call(
        app.clone(),
        post_request("/v1/generate", r#"{"wait": "cycle"}"#),
    ));
    let mut started = false;
    for _ in 0..200_u32 {
        if chain.started() >= 1 {
            started = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    assert!(started, "the render started before the socket dropped");
    let claimed = call(app.clone(), get_request("/v1/cycle")).await.1;
    assert_eq!(claimed["phase"], "draining", "the live phase is answerable");
    let cycle_id = claimed["cycleId"].as_str().expect("cycle id").to_owned();

    // The socket drops mid-drive: the caller is gone, the machine is not even
    // told. Dropping the handle detaches the task — no cancel, no re-run.
    drop(caller);

    // The plane answers the live phase for the SAME cycle — still draining, the
    // row still the drain's property.
    let live = call(app.clone(), get_request("/v1/cycle")).await.1;
    assert_eq!(live["phase"], "draining");
    assert_eq!(live["cycleId"].as_str(), Some(cycle_id.as_str()));
    assert_eq!(
        status_of(&spool_rows(fixture.app_data()), &row_id),
        "draining"
    );

    // The driver finishes on its own terms and the terminal report persists: the
    // resume door reads the answer the dropped caller never got.
    chain.release();
    let report = await_terminal(&app, &cycle_id).await;
    assert_eq!(
        status_of(&spool_rows(fixture.app_data()), &row_id),
        "failed",
        "the scripted render ended failed"
    );
    assert_eq!(report["cycleId"], cycle_id.as_str());
    let (_, resume) = call(app.clone(), get_request("/v1/resume")).await;
    assert_eq!(resume["state"], "ready", "the fake legs restored the model");
}

#[tokio::test]
async fn a_keyed_repost_after_the_terminal_answer_dupes_done_and_never_touches_the_spool() {
    let _gate = crate::resources::fence_test_gate();
    let fixture = Fixture::new();
    fixture.write_guard(None);
    let root = tempfile::tempdir().expect("model root");
    let fixture = fixture.with_fake_library(root.path());
    let app = fixture.serve();
    queue_stranger(&app).await;

    let (status, body) = call(
        app.clone(),
        post_request(
            "/v1/generate",
            r#"{"wait": "poll", "key": "idempotency-drill-key"}"#,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let cycle_id = body["cycleId"].as_str().expect("cycle id").to_owned();
    let report = await_terminal(&app, &cycle_id).await;
    assert_eq!(report["ok"], true);

    // The ledger row is terminal, and the key itself never rides the bytes.
    let bytes = std::fs::read_to_string(fixture.app_data().join(idempotency::FILE))
        .expect("ledger on disk");
    assert!(bytes.contains("terminal") && !bytes.contains("idempotency-drill-key"));

    // The same key re-POSTs: the (c) duplicate posture — done, the same cycle —
    // structurally incapable of a second drain (the ledger wall runs before the
    // fence claim), and the durable spool is byte-identical across the attempt.
    let before = std::fs::read(fixture.app_data().join(spool::FILE)).expect("spool bytes");
    let (status, body) = call(
        app.clone(),
        post_request("/v1/generate", r#"{"key": "idempotency-drill-key"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["duplicate"], true);
    assert_eq!(body["state"], "done");
    assert_eq!(body["cycleId"], cycle_id.as_str());
    let after = std::fs::read(fixture.app_data().join(spool::FILE)).expect("spool bytes");
    assert_eq!(before, after, "the duplicate never touched the spool");
    let view = call(app.clone(), get_request("/v1/cycle")).await.1;
    assert_eq!(
        view["cycleId"].as_str(),
        Some(cycle_id.as_str()),
        "never a second claim"
    );
}

/* ------------------------------ 3. the live-window hook ------------------------------ */

/// The SAME stranger script against the REAL plane — the M8 live window's script,
/// ignored in the suite so the window run is unearthing, not rebuilding.
///
/// Prerequisites (owner window only, never a normal CI run):
/// * DEAS running with the `/v1` plane enabled: a real `deas-agent-settings.json`
///   in DEAS app-data (`{"enabled": true, "port": 8790, ...}`), the standing key
///   read from the same file when one is set.
/// * A real `deas-agent-guard.json` whose unload/restore bats and `readyUrl` are
///   the owner's genuine commands (Strata/ComfyUI handoff) — the real CommandRunner
///   spawns them; this test never fakes a leg.
/// * A scanned library so the resolver can answer the model reference (pass the
///   handle or name as `DEAS_ACCEPT_MODEL`; run `POST /v1/scan` first if cold).
/// * The card free for a real cycle: this generates REAL GPU work end to end.
///
/// It is listed among the ignored tests by design; the window runs it with
/// `cargo test --lib acceptance::live_acceptance_script -- --ignored --test-threads=1`
/// after the owner confirms the guard file and the model reference.
#[tokio::test]
#[ignore = "live M8 window: real plane, real bats, real GPU cycle (owner-confirmed guard file and model only)"]
async fn live_acceptance_script() {
    // DEAS app-data: the same home `start_if_enabled` reads the operator files
    // from (the tauri identifier's path, %APPDATA%-based on Windows).
    let app_data = std::path::Path::new(
        &std::env::var("APPDATA").expect("APPDATA resolves to the real app-data homes"),
    )
    .join("com.dasiwa.deas");
    let settings_bytes = std::fs::read(app_data.join(super::config::FILE))
        .expect("the live plane needs real settings");
    let settings: Value = serde_json::from_slice(&settings_bytes).expect("valid settings json");
    assert_eq!(
        settings["enabled"].as_bool(),
        Some(true),
        "the plane must be enabled"
    );
    let port = settings["port"].as_u64().unwrap_or(8790);
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();
    let standing_key = settings["standingKey"].as_str().map(str::to_owned);

    // The stranger's three-key body over the REAL resolver and the REAL ladder.
    let model =
        std::env::var("DEAS_ACCEPT_MODEL").expect("pass DEAS_ACCEPT_MODEL for the live run");
    let queue_body = json!({
        "model": model,
        "mode": "t2i",
        "positivePrompt": "a lighthouse at dusk",
        "outputPrefix": "agent/live-accept",
    });
    let mut request = client
        .post(format!("{base}/v1/queue"))
        .header("origin", "http://localhost:1420")
        .json(&queue_body);
    if let Some(key) = standing_key.as_deref() {
        request = request.header("x-api-key", key);
    }
    let answer: Value = request
        .send()
        .await
        .expect("plane answers")
        .json()
        .await
        .expect("json");
    assert_eq!(answer["status"], "queued", "{answer}");

    // The real cycle, held to its terminal report (wait: cycle; the dropped-socket
    // law would make GET /v1/cycle the resume read instead).
    let mut generate = client
        .post(format!("{base}/v1/generate"))
        .header("origin", "http://localhost:1420")
        .json(&json!({"wait": "cycle"}));
    if let Some(key) = standing_key.as_deref() {
        generate = generate.header("x-api-key", key);
    }
    let response = generate.send().await.expect("the cycle answers");
    let status = response.status();
    let report: Value = response.json().await.expect("json");
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "live cycle refused: {report}"
    );
    assert_eq!(report["ok"], true, "{report}");

    // The resume posture and the empty spool, read for real.
    let mut resume = client
        .get(format!("{base}/v1/resume"))
        .header("origin", "http://localhost:1420");
    if let Some(key) = standing_key.as_deref() {
        resume = resume.header("x-api-key", key);
    }
    let posture: Value = resume
        .send()
        .await
        .expect("resume answers")
        .json()
        .await
        .expect("json");
    assert_eq!(posture["state"], "ready", "{posture}");

    let mut queue = client
        .get(format!("{base}/v1/queue"))
        .header("origin", "http://localhost:1420");
    if let Some(key) = standing_key.as_deref() {
        queue = queue.header("x-api-key", key);
    }
    let listed: Value = queue
        .send()
        .await
        .expect("queue answers")
        .json()
        .await
        .expect("json");
    assert!(
        listed["rows"]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .all(|row| row["status"] != "queued"),
        "no queued row survives a live drain: {listed}"
    );
}
