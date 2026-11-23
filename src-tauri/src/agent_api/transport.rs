//! The `/v1` transport: an axum router over a loopback listener, with the auth wall and
//! the permit-lane gate installed as the only middleware.
//!
//! The route table IS the closed index: the router registers every `routes::ROUTE_INDEX`
//! row through its stored handler, so registration, lane gating and the discovery
//! surfaces read one table. Middleware order is law: the auth wall runs first
//! (outermost), the lane gate second. A request that is not in the closed route index
//! spends no permit and lands on the taxonomy fallback.

use axum::extract::{Request, State};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::MethodRouter;
use axum::Router;

use super::auth;
use super::routes;
use super::PlaneState;

/// Assembles the plane router from the closed route index, then adds the taxonomy
/// fallback and the walls.
///
/// One `MethodRouter` per distinct path: every index row naming that path folds its
/// method into it (axum rejects two `route()` registrations for one path), so GET and
/// POST on `/v1/defaults` coexist exactly as the index declares them.
///
/// The `MethodRouter` fallback is the plane's own, not axum's (LEG AF2-M18b B5): a
/// registered path asked for an unregistered method answers the closed taxonomy shape
/// with a 405, while an unregistered path still lands on the top-level [`routes::not_found`]
/// fallback. A wrong-method request matches no index row, so it spends no lane permit on
/// the way to either answer.
pub(crate) fn router(state: PlaneState) -> Router {
    let mut app = Router::new();
    let mut served_paths: Vec<&'static str> = Vec::new();
    for route in routes::ROUTE_INDEX {
        if !served_paths.contains(&route.path) {
            served_paths.push(route.path);
        }
    }
    for path in served_paths {
        let mut methods = MethodRouter::new();
        for route in routes::ROUTE_INDEX
            .iter()
            .filter(|route| route.path == path)
        {
            methods = methods.on(routes::route_filter(route.method), route.handler);
        }
        app = app.route(path, methods.fallback(routes::method_mismatch));
    }
    app.fallback(routes::not_found)
        .layer(middleware::from_fn_with_state(state.clone(), lane_gate))
        .layer(middleware::from_fn_with_state(state.clone(), auth_wall))
        .with_state(state)
}

/// Wall order exactly as specified: Origin → Host → standing key.
async fn auth_wall(State(state): State<PlaneState>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    if let Err(error) = auth::check_origin(
        headers,
        &state.settings.origin_allowlist,
        state.settings.standing_key.is_some(),
    ) {
        return error.into_response();
    }
    if let Err(error) = auth::check_host(headers) {
        return error.into_response();
    }
    if let Err(error) = auth::check_key(headers, state.settings.standing_key.as_deref()) {
        return error.into_response();
    }
    next.run(request).await
}

/// Takes one permit in the route's lane or refuses at the cap; unknown routes spend none.
async fn lane_gate(State(state): State<PlaneState>, request: Request, next: Next) -> Response {
    let Some(def) = routes::lookup(request.method().as_str(), request.uri().path()) else {
        return next.run(request).await;
    };
    let lanes = state.lanes.clone();
    let permit = match lanes.permit(def.lane) {
        Ok(permit) => permit,
        Err(error) => return error.into_response(),
    };
    // The permit lives until here: dropping it at the end of the handler releases the lane.
    let _permit = permit;
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::StatusCode;
    use serde_json::Value;
    use std::path::PathBuf;
    use tokio::sync::mpsc;
    use tower_service::Service;

    use super::super::config::AgentSettings;
    use super::super::cycle::{self, HealthProbe};
    use super::super::defaults;
    use super::super::errors::ALL_KINDS;
    use super::super::idempotency;
    use super::super::lanes::Lanes;
    use super::super::resolver::IndexSource;
    use super::super::resume;
    use super::super::scan::FakeScanBridge;
    use super::super::spool::{self, Spool};
    use super::super::uploads::{RecordingUploadBridge, UploadKind};
    use super::super::watchdog;
    use serde_json::json;
    use std::sync::Arc;

    fn state(allowlist: &[&str], standing_key: Option<&str>) -> PlaneState {
        PlaneState {
            settings: AgentSettings {
                enabled: true,
                port: 8790,
                standing_key: standing_key.map(str::to_owned),
                origin_allowlist: allowlist.iter().map(|value| (*value).to_owned()).collect(),

                component_overrides: Default::default(),
            },
            app_data: PathBuf::from("."),
            lanes: Arc::new(Lanes::new()),
            spool: Arc::new(Spool::new(&PathBuf::from("."))),
            cycle: Arc::new(cycle::CycleCell::new(&PathBuf::from("."))),
            cycle_seams: Arc::new(cycle::CycleSeams::defaults_for_tests()),
            watchdog: Arc::new(watchdog::Watchdog::new(
                &PathBuf::from("."),
                Arc::new(watchdog::WatchdogSeams::defaults_for_tests()),
            )),
            ledger: Arc::new(idempotency::Ledger::new(&PathBuf::from("."))),
            resume: Arc::new(resume::ResumeWatch::scripted_for_tests(Arc::new(
                resume::ScriptProbe::always(true),
            ))),
            results: Arc::new(super::super::results::FakeResultsBridge::healthy()),
            refmods: Arc::new(super::super::results::FakeRefmodBridge::healthy()),
            library: None,
            input_root: None,
            output_root: None,
            batch: Arc::new(super::super::caps::BatchLedger::new()),
            app: None,
            scan: Arc::new(FakeScanBridge::idle()),
            uploads: Arc::new(RecordingUploadBridge::accepting()),
        }
    }

    /// A plane state whose app-data points at a controlled tempdir (guard-file tests).
    /// The spool handle is rebuilt for the same reason: it captured the path at
    /// construction, so repointing `app_data` without it would leak rows into a
    /// shared file outside the tempdir.
    fn plane_with_app_data(dir: &std::path::Path) -> PlaneState {
        let mut plane = state(&["http://localhost:1420"], None);
        plane.app_data = dir.to_path_buf();
        plane.spool = Arc::new(Spool::new(&plane.app_data));
        plane.cycle = Arc::new(cycle::CycleCell::new(&plane.app_data));
        // The watchdog captured app-data at construction too: repointing it keeps its
        // journal inside the tempdir instead of the crate tree.
        plane.watchdog = Arc::new(watchdog::Watchdog::new(
            &plane.app_data,
            Arc::new(watchdog::WatchdogSeams::defaults_for_tests()),
        ));
        // The ledger captured app-data at construction too (file-backed state):
        // repointing keeps its rows inside the tempdir, never the crate tree.
        plane.ledger = Arc::new(idempotency::Ledger::new(&plane.app_data));
        plane
    }

    /// The real `lane_gate` plus the taxonomy fallback, with `/v1/cycle` replaced by a
    /// probe handler that takes a control-lane permit, signals through `ready`, and
    /// parks until the `release` watch fires. Each probe clones its own watch receiver,
    /// so several probes hold permits simultaneously and one release wakes them all.
    fn gated_probe(
        app_data: &std::path::Path,
    ) -> (Router, mpsc::Receiver<()>, tokio::sync::watch::Sender<bool>) {
        let (ready_tx, ready_rx) = mpsc::channel::<()>(4);
        let (release_tx, release_rx) = tokio::sync::watch::channel(false);
        // Handler closures must be Clone: the channel halves ride in Arc'd Mutexes and
        // each request clones only what it needs, so no lock lives across an await.
        let ready = Arc::new(std::sync::Mutex::new(ready_tx));
        let release = Arc::new(std::sync::Mutex::new(release_rx));
        let state = plane_with_app_data(app_data);
        let app = Router::new()
            .route(
                "/v1/cycle",
                MethodRouter::new().on(
                    routes::route_filter("GET"),
                    move |state: State<PlaneState>| {
                        let ready = Arc::clone(&ready);
                        let release = Arc::clone(&release);
                        async move {
                            // Past the lane gate: this request now holds one control permit.
                            let _ = state;
                            if let Ok(sender) = ready.lock() {
                                let _ = sender.try_send(());
                            } // guard dropped: no lock lives across an await
                            let mut receiver = match release.lock() {
                                Ok(guard) => {
                                    let receiver = guard.clone();
                                    drop(guard);
                                    receiver
                                }
                                Err(_) => return ().into_response(),
                            };
                            let _ = receiver.changed().await;
                            axum::Json(serde_json::json!({ "held": true })).into_response()
                        }
                    },
                ),
            )
            .fallback(routes::not_found)
            .layer(middleware::from_fn_with_state(state.clone(), lane_gate))
            .with_state(state);
        (app, ready_rx, release_tx)
    }

    /// Polls a future once with a noop waker.
    fn poll_once<F: std::future::Future + ?Sized>(
        future: std::pin::Pin<&mut F>,
    ) -> std::task::Poll<F::Output> {
        let waker = futures_util::task::noop_waker();
        let mut context = std::task::Context::from_waker(&waker);
        future.poll(&mut context)
    }

    /// Asserts a probe future parked. The router reaches the handler on the first
    /// poll and the handler parks on the release watch, so the outer future reports
    /// Pending; Ready means the probe finished without holding the lane — a broken
    /// test contract, not a lane state.
    fn assert_parked<F: std::future::Future + ?Sized>(future: std::pin::Pin<&mut F>) {
        if poll_once(future).is_ready() {
            panic!("probe completed before it was released");
        }
    }

    fn request(path: &str, origin: Option<&str>, host: &str, key: Option<&str>) -> Request {
        let mut builder = Request::builder()
            .method("GET")
            .uri(format!("http://127.0.0.1:8790{path}"))
            .header("host", host);
        if let Some(origin) = origin {
            builder = builder.header("origin", origin);
        }
        if let Some(key) = key {
            builder = builder.header("x-api-key", key);
        }
        builder.body(Body::empty()).expect("valid test request")
    }

    async fn call(app: &Router, request: Request) -> (StatusCode, Value) {
        let response = app.clone().call(request).await.expect("router answers");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body readable");
        let value: Value = serde_json::from_slice(&bytes).expect("json body");
        (status, value)
    }

    fn test_request(path: &str) -> Request {
        request(path, Some("http://localhost:1420"), "127.0.0.1:8790", None)
    }

    /// The hint text a plane refusal carries (every taxonomy answer names its cause).
    fn hint(body: &Value) -> &str {
        body["hint"].as_str().expect("a refusal carries a hint")
    }

    /// A POST request with a JSON body, same walls as [`test_request`].
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

    /// A DELETE request, same walls as [`test_request`].
    fn delete_request(path: &str) -> Request {
        Request::builder()
            .method("DELETE")
            .uri(format!("http://127.0.0.1:8790{path}"))
            .header("host", "127.0.0.1:8790")
            .header("origin", "http://localhost:1420")
            .body(Body::empty())
            .expect("valid test request")
    }

    /// A complete anima t2i request the door must accept: anima is a split-loader
    /// family, so all four resolver slots ride the request (P7: queued = drain-ready).
    const COMPLETE_ANIMA: &str = r#"{
        "family": "anima",
        "mode": "t2i",
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

    #[tokio::test]
    async fn defaults_get_answers_the_three_views() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, test_request("/v1/defaults")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        // stock: builtin.json verbatim, seeded with the anima defaults.
        let stock = body["stock"].as_array().expect("stock is an array");
        assert!(stock
            .iter()
            .any(|entry| entry["id"] == "anima" && entry["defaults"]["steps"] == 30));
        // configurable: an absent sheet answers the empty default sheet honestly.
        assert_eq!(body["configurable"]["version"], 2);
        assert_eq!(body["configurable"]["combos"], serde_json::json!({}));
        // preview: no query pair means the plane scope, per-field source tags present.
        assert_eq!(body["preview"]["scope"], "plane");
        assert!(body["preview"]["family"].is_null());
        let fields = body["preview"]["fields"].as_array().expect("fields array");
        let seed = fields
            .iter()
            .find(|field| field["field"] == "seedMode")
            .expect("seedMode is previewed");
        assert_eq!(seed["source"], "floor");
        assert_eq!(seed["value"], "random");
        let batch = fields
            .iter()
            .find(|field| field["field"] == "batch")
            .expect("batch floor is previewed");
        assert_eq!(batch["value"], 1);
    }

    #[tokio::test]
    async fn defaults_get_combo_preview_uses_the_sheet() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(super::super::defaults::FILE),
            r#"{"version": 2, "combos": { "anima:t2i": { "steps": 35 } }}"#,
        )
        .expect("test fixture writes the sheet");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, test_request("/v1/defaults?family=anima&mode=t2i")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["preview"]["scope"], "combo");
        assert_eq!(body["preview"]["family"], "anima");
        let fields = body["preview"]["fields"].as_array().expect("fields array");
        let steps = fields
            .iter()
            .find(|field| field["field"] == "steps")
            .expect("steps is previewed");
        assert_eq!(steps["source"], "combo");
        assert_eq!(steps["value"], 35);
        // A field the sheet never names still surfaces the stock seed tier.
        let width = fields
            .iter()
            .find(|field| field["field"] == "width")
            .expect("width is previewed");
        assert_eq!(width["source"], "stock");
        assert_eq!(width["value"], 1024);
    }

    #[tokio::test]
    async fn defaults_get_refuses_bad_preview_queries_with_body_invalid() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        for query in [
            "/v1/defaults?family=nope&mode=t2i",
            "/v1/defaults?family=anima&mode=t2o",
            "/v1/defaults?family=anima",
            "/v1/defaults?mode=t2i",
            "/v1/defaults?family=anima&mode=t2i&extra=1",
        ] {
            let (status, body) = call(&app, test_request(query)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
            assert_eq!(body["reason"], "bodyInvalid", "{query}");
        }
    }

    #[tokio::test]
    async fn defaults_post_writes_and_get_reads_the_combo_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(
            &app,
            post_request(
                "/v1/defaults",
                r#"{"confirm": true, "key": "anima:t2i", "dials": {"steps": 35, "sampler": "er_sde"}}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], true);
        assert_eq!(body["configurable"]["combos"]["anima:t2i"]["steps"], 35);
        // The file on disk carries the entry, and GET sees it in both views.
        let on_disk: serde_json::Value = serde_json::from_slice(
            &std::fs::read(dir.path().join(super::super::defaults::FILE)).expect("written"),
        )
        .expect("valid json");
        assert_eq!(on_disk["combos"]["anima:t2i"]["steps"], 35);
        let (status, body) = call(&app, test_request("/v1/defaults?family=anima&mode=t2i")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["configurable"]["combos"]["anima:t2i"]["sampler"],
            "er_sde"
        );
        let fields = body["preview"]["fields"].as_array().expect("fields array");
        let steps = fields
            .iter()
            .find(|field| field["field"] == "steps")
            .expect("steps is previewed");
        assert_eq!(steps["source"], "combo");
        assert_eq!(steps["value"], 35);
    }

    #[tokio::test]
    async fn defaults_post_refusals_carry_the_body_invalid_word() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        // Bad combo key: the key is named in the hint.
        let (status, body) = call(
            &app,
            post_request(
                "/v1/defaults",
                r#"{"confirm": true, "key": "anima:t2o", "dials": {"steps": 5}}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(
            body["hint"].as_str().expect("hint").contains("t2o"),
            "{body}"
        );
        // Unknown dial key: named.
        let (status, body) = call(
            &app,
            post_request(
                "/v1/defaults",
                r#"{"confirm": true, "key": "anima:t2i", "dials": {"stps": 5}}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(
            body["hint"].as_str().expect("hint").contains("stps"),
            "{body}"
        );
        // Missing confirm gate: refused, nothing written.
        let (status, body) = call(
            &app,
            post_request(
                "/v1/defaults",
                r#"{"key": "anima:t2i", "dials": {"steps": 5}}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(
            !dir.path().join(super::super::defaults::FILE).exists(),
            "a refused write writes nothing"
        );
    }

    #[tokio::test]
    async fn defaults_get_exposes_a_corrupt_sheet_without_repairing_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(super::super::defaults::FILE), "{ broken")
            .expect("test fixture writes garbage");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, test_request("/v1/defaults")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body["configurable"].is_null(),
            "corruption is exposed, not hidden"
        );
        assert!(body["configurableError"]
            .as_str()
            .expect("error text")
            .contains(super::super::defaults::FILE));
        // Never silently repaired: the garbage bytes are untouched.
        let on_disk = std::fs::read_to_string(dir.path().join(super::super::defaults::FILE))
            .expect("still there");
        assert_eq!(on_disk, "{ broken");
    }

    #[tokio::test]
    async fn post_defaults_participates_in_the_control_lane_budget() {
        // Both control permits are held at the lane source, so the POST row must be
        // refused with laneFull before its handler ever runs — the closed index lane
        // gate covers POST methods, not just the GET spine.
        let dir = tempfile::tempdir().expect("tempdir");
        let plane = plane_with_app_data(dir.path());
        let held: Vec<_> = (0..super::super::lanes::CONTROL_LANE_MAX)
            .map(|_| {
                plane
                    .lanes
                    .permit(super::super::lanes::Lane::Control)
                    .expect("under cap")
            })
            .collect();
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/defaults", "{}")).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
        assert_eq!(body["reason"], "laneFull");
        drop(held);
        // With the lane free again, the POST write answers.
        let (status, body) = call(
            &app,
            post_request(
                "/v1/defaults",
                r#"{"confirm": true, "key": "anima:t2i", "dials": {"steps": 35}}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    #[tokio::test]
    async fn health_answers_with_allowlisted_origin() {
        let app = router(state(&["http://localhost:1420"], None));
        let (status, body) = call(&app, test_request("/v1/health")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        assert_eq!(body["enabled"], true);
        assert_eq!(body["port"], 8790);
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn health_composes_the_posture_facts_the_other_doors_publish() {
        // M9g (API-DESIGN 4.1): the alive door answers the lane ceilings, the guard
        // posture and the cycle word — the SAME facts `/v1/status` and `/v1/cycle`
        // publish, read through their existing homes (no second posture calculator).
        // Absent guard is the honest unconfigured posture with the shipped degraded
        // cycle word (legs off).
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, test_request("/v1/health")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], true);
        assert_eq!(body["plane"], "deas-agent-api");
        assert_eq!(
            body["version"],
            env!("CARGO_PKG_VERSION"),
            "the plane version is byte-pinned to the crate"
        );
        assert_eq!(body["port"], 8790);
        assert_eq!(body["guardConfigured"], false);
        assert_eq!(
            body["autoCycleVram"], false,
            "no guard file means the degraded posture: no unload/restore legs"
        );
        assert_eq!(body["cycle"], "idle");
        assert_eq!(
            body["lanes"]["render"]["max"], 4,
            "the render-lane ceiling `/v1/status` answers"
        );
        assert_eq!(body["lanes"]["control"]["max"], 2);
        assert_eq!(body["watchdog"]["tripOpen"], false);
        assert!(
            body["watchdog"]["latchedTo"].is_null(),
            "an untripped judge is the watching posture (§8.1: no route disables the arm)"
        );
        assert_eq!(
            body["watchdog"]["journalDegraded"], false,
            "M18d: an absent journal is a healthy empty tail, no degradation note"
        );
        assert!(
            body["watchdog"].get("journalProblem").is_none(),
            "the problem word rides only when the tail is actually unreadable"
        );
    }

    /// M18d cleanup (LEG AF2-M19b): a journal the plane cannot read is called out
    /// on the watchdog posture block, problem verbatim — the doors that point at
    /// the journal stop pointing at a broken instrument silently.
    #[tokio::test]
    async fn the_health_watchdog_block_notes_a_corrupt_journal_verbatim() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(watchdog::JOURNAL_FILE), b"{ broken tail !!")
            .expect("corrupt journal staged");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, test_request("/v1/health")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["watchdog"]["journalDegraded"], true);
        let problem = body["watchdog"]["journalProblem"]
            .as_str()
            .expect("the problem rides verbatim");
        assert!(problem.contains(watchdog::JOURNAL_FILE), "{problem}");
        assert!(
            problem.contains("parse"),
            "the read law's own word: {problem}"
        );
    }

    #[tokio::test]
    async fn health_guard_posture_flips_with_the_guard_file() {
        // The flip rides the guard's single posture home (`guard::posture`), the same one
        // `/v1/cycle`'s `configured` reads: a valid file answers configured with its own
        // cycle word, a malformed file is unconfigured with the degraded word. The two
        // doors cannot disagree because neither computes the posture itself.
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        std::fs::write(
            dir.path().join(super::super::guard::FILE),
            r#"{"autoCycleVram": true, "unloadCommand": "u.bat", "restoreCommand": "r.bat",
                "readyUrl": "http://127.0.0.1:18502/health"}"#,
        )
        .expect("test fixture writes guard");
        let (status, body) = call(&app, test_request("/v1/health")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["guardConfigured"], true);
        assert_eq!(body["autoCycleVram"], true, "the file's own word");
        // The same door, the same answer `/v1/cycle` gives for the same file.
        let (_, cycle_body) = call(&app, test_request("/v1/cycle")).await;
        assert_eq!(cycle_body["configured"], true);
        // A malformed guard is unconfigured on BOTH doors, degraded word included.
        std::fs::write(dir.path().join(super::super::guard::FILE), "{ not json")
            .expect("test fixture corrupts the guard");
        let (_, body) = call(&app, test_request("/v1/health")).await;
        assert_eq!(body["guardConfigured"], false);
        assert_eq!(body["autoCycleVram"], false);
        let (_, cycle_body) = call(&app, test_request("/v1/cycle")).await;
        assert_eq!(cycle_body["configured"], false, "one posture home");
    }

    #[tokio::test]
    async fn health_names_the_live_cycle_word_the_cycle_door_answers() {
        // The §4.1 cycle word is `/v1/cycle`'s phase from the same live cell: a claimed
        // fence shows up on the alive door with no extra wiring.
        let dir = tempfile::tempdir().expect("tempdir");
        let plane = plane_with_app_data(dir.path());
        plane
            .cycle
            .claim(super::super::cycle_view::CyclePhase::Draining)
            .expect("claim takes the fence");
        let app = router(plane);
        let (status, body) = call(&app, test_request("/v1/health")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["cycle"], "draining");
        assert_eq!(
            body["guardConfigured"], false,
            "a claimed fence is not a guard"
        );
    }

    #[tokio::test]
    async fn origin_wall_runs_first() {
        let app = router(state(&["http://localhost:1420"], None));
        let (status, body) = call(
            &app,
            request(
                "/v1/health",
                Some("http://evil.example"),
                "127.0.0.1:8790",
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["reason"], "originDenied");
    }

    #[tokio::test]
    async fn host_wall_refuses_rebinding_hosts() {
        let app = router(state(&["http://localhost:1420"], None));
        let (status, body) = call(
            &app,
            request(
                "/v1/health",
                Some("http://localhost:1420"),
                "evil.example.com",
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["reason"], "hostDenied");
    }

    #[tokio::test]
    async fn missing_origin_without_key_is_refused() {
        let app = router(state(&["http://localhost:1420"], None));
        let (status, body) = call(&app, request("/v1/health", None, "127.0.0.1:8790", None)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["reason"], "originDenied");
    }

    #[tokio::test]
    async fn standing_key_missing_and_wrong_are_distinct_words() {
        let app = router(state(&[], Some("s3cret")));
        let (status, body) = call(&app, request("/v1/health", None, "127.0.0.1:8790", None)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["reason"], "keyMissing");
        let (status, body) = call(
            &app,
            request("/v1/health", None, "127.0.0.1:8790", Some("nope")),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["reason"], "keyInvalid");
    }

    #[tokio::test]
    async fn correct_standing_key_opens_the_plane() {
        let app = router(state(&[], Some("s3cret")));
        let (status, body) = call(
            &app,
            request("/v1/health", None, "127.0.0.1:8790", Some("s3cret")),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
    }

    #[tokio::test]
    async fn unknown_route_gets_the_taxonomy_404_not_html() {
        let app = router(state(&["http://localhost:1420"], None));
        let (status, body) = call(&app, test_request("/v1/nope")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "ROUTE_NOT_FOUND");
        assert_eq!(body["reason"], "routeNotFound");
    }

    #[tokio::test]
    async fn queue_post_spools_a_complete_intent_and_the_row_survives_a_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, post_request("/v1/queue", COMPLETE_ANIMA)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], true);
        assert_eq!(body["status"], "queued");
        assert!(
            body["seed"].is_number(),
            "the drawn seed echoes for reproducibility"
        );
        assert_eq!(
            body["envelope"]["mode"], "t2i",
            "the verdict record rides back"
        );
        let id = body["id"].as_str().expect("row id").to_owned();
        assert!(!id.is_empty());

        // The listing is cheap and honest: bounded fields, no envelope echo.
        let (status, body) = call(&app, test_request("/v1/queue")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["count"], 1);
        let row = &body["rows"][0];
        assert_eq!(row["id"], id);
        assert_eq!(row["status"], "queued");
        assert_eq!(row["family"], "anima");
        assert_eq!(row["mode"], "t2i");
        assert_eq!(row["promptPreview"], "a lighthouse at dusk");
        assert!(row["seed"].is_number());
        assert!(
            row.get("envelope").is_none(),
            "the listing never echoes the envelope"
        );

        // A restart — a fresh plane over the same app-data — still sees the row.
        let restarted = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&restarted, test_request("/v1/queue")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["count"], 1);
        assert_eq!(body["rows"][0]["id"], id);

        // The file on disk carries the versioned spool envelope.
        let on_disk: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(spool::FILE)).expect("written"))
                .expect("valid json");
        assert_eq!(on_disk["version"], 1);
        assert_eq!(
            on_disk["rows"][0]["slots"]["checkpoint"],
            "anima/something.safetensors"
        );
    }

    #[tokio::test]
    async fn queue_post_refuses_an_incomplete_intent_naming_the_open_slots() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(
            &app,
            post_request("/v1/queue", r#"{"family": "anima", "mode": "t2i"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "bodyInvalid");
        let hint = body["hint"].as_str().expect("hint");
        for slot in ["checkpoint", "positivePrompt", "outputPrefix", "diffusion"] {
            assert!(hint.contains(slot), "{slot} named in: {hint}");
        }
        assert!(
            !dir.path().join(spool::FILE).exists(),
            "a refused enqueue writes no spool"
        );
    }

    #[tokio::test]
    async fn queue_post_refuses_a_deferred_mode_with_mode_unsupported() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(
            &app,
            post_request("/v1/queue", r#"{"family": "anima", "mode": "refmod"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["reason"], "modeUnsupported");
    }

    #[tokio::test]
    async fn a_corrupt_spool_file_rides_maintenance_and_is_never_rewritten() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(spool::FILE), "{ broken").expect("fixture garbage");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, test_request("/v1/queue")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        assert!(
            body["hint"].as_str().expect("hint").contains(spool::FILE),
            "the hint names the file"
        );
        // POST refuses too, and nothing repairs or clobbers the bytes.
        let (status, body) = call(&app, post_request("/v1/queue", COMPLETE_ANIMA)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        let on_disk = std::fs::read_to_string(dir.path().join(spool::FILE)).expect("still there");
        assert_eq!(on_disk, "{ broken");
    }

    #[tokio::test]
    async fn queue_delete_removes_queued_rows_and_leaves_the_drains_own() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (_, body) = call(&app, post_request("/v1/queue", COMPLETE_ANIMA)).await;
        let id = body["id"].as_str().expect("row id").to_owned();

        // Unknown id first: the row identity word, not a 404.
        let (status, body) = call(&app, delete_request("/v1/queue/nope")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "jobUnknown");

        // The queued row deletes.
        let (status, body) = call(&app, delete_request(&format!("/v1/queue/{id}"))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["deleted"], id);
        let (_, body) = call(&app, test_request("/v1/queue")).await;
        assert_eq!(body["count"], 0);

        // A terminal row is not this route's to remove: re-enqueue, mark done on disk.
        let (_, body) = call(&app, post_request("/v1/queue", COMPLETE_ANIMA)).await;
        let second = body["id"].as_str().expect("row id").to_owned();
        let path = dir.path().join(spool::FILE);
        let mut on_disk: Value =
            serde_json::from_slice(&std::fs::read(&path).expect("written")).expect("valid json");
        on_disk["rows"][0]["status"] = Value::String("done".to_owned());
        std::fs::write(&path, serde_json::to_vec(&on_disk).expect("serialize")).expect("write");
        let (status, body) = call(&app, delete_request(&format!("/v1/queue/{second}"))).await;
        // AF2-M18b WORD-RULE-1 (manager adjudication): no cycle is in flight in this
        // fixture, so the door never claims one and never calls a known row unknown -
        // with the fence idle this DELETE is simply not a route the index carries for a
        // terminal row: 404 routeNotFound, the row's own state and rule ride the hint.
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["reason"], "routeNotFound");
        assert!(
            body["hint"].as_str().expect("hint").contains("done"),
            "the hint states the actual status"
        );
        let (_, body) = call(&app, test_request("/v1/queue")).await;
        assert_eq!(body["count"], 1, "the terminal row stays");
        // A wedged row answers the word that names its state.
        let mut on_disk: Value =
            serde_json::from_slice(&std::fs::read(&path).expect("written")).expect("valid json");
        on_disk["rows"][0]["status"] = Value::String("wedged".to_owned());
        std::fs::write(&path, serde_json::to_vec(&on_disk).expect("serialize")).expect("write");
        let (status, body) = call(&app, delete_request(&format!("/v1/queue/{second}"))).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert_eq!(body["reason"], "jobWedged");
        assert!(
            body["hint"].as_str().expect("hint").contains("wedged"),
            "{body}"
        );
    }

    /// AF2-M18b B5: a registered path asked for the wrong method answers the closed
    /// taxonomy shape with a 405 — never axum's empty `MethodRouter` body — and the detail
    /// names the method asked for plus every method that path IS registered for. An
    /// unknown path keeps the shipped 404 shape byte for byte.
    #[tokio::test]
    async fn a_wrong_method_on_a_registered_path_answers_the_closed_405_shape() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let probe = |method: &str, path: &str| {
            Request::builder()
                .method(method)
                .uri(format!("http://127.0.0.1:8790{path}"))
                .header("host", "127.0.0.1:8790")
                .header("origin", "http://localhost:1420")
                .body(Body::empty())
                .expect("valid test request")
        };
        for (method, path, allowed) in [
            ("PUT", "/v1/health", "GET"),
            ("DELETE", "/v1/defaults", "GET, POST"),
            ("OPTIONS", "/v1/generate", "POST"),
            (
                "POST",
                "/v1/queue/0f9e8d7c-1234-4abc-9def-0123456789ab",
                "DELETE",
            ),
            // AF2-M31: the join door is POST-only like its M25b sibling; a GET
            // there answers the same closed 405 shape, naming the one verb the
            // path serves (lane parity with the sibling doors).
            ("GET", "/v1/videos/join", "POST"),
            // AF2-M32: the story door is POST-only like its join sibling.
            ("GET", "/v1/videos/story", "POST"),
        ] {
            let (status, body) = call(&app, probe(method, path)).await;
            assert_eq!(
                status,
                StatusCode::METHOD_NOT_ALLOWED,
                "{method} {path}: {body}"
            );
            assert_eq!(body["error"], "ROUTE_NOT_FOUND", "{method} {path}");
            assert_eq!(body["reason"], "routeNotFound", "{method} {path}");
            let detail = hint(&body);
            assert!(
                detail.contains(path) && detail.contains(allowed) && detail.contains(method),
                "the 405 detail must name the path, the asked method and the allowed ones: {detail}"
            );
        }
        // The unknown-path posture is untouched.
        let (status, body) = call(&app, test_request("/v1/nope")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["error"], "ROUTE_NOT_FOUND");
        assert_eq!(body["reason"], "routeNotFound");
        assert_eq!(
            hint(&body),
            "no GET route at '/v1/nope' — the /v1 surface is closed by the route index"
        );
    }

    /// AF2-M18b B4: the closed mode wall runs BEFORE any placement, so a refused body
    /// leaves nothing on disk. The recording seam is the plane's only writer, so an empty
    /// placement list is the proof.
    #[tokio::test]
    async fn the_mode_wall_refuses_before_any_reference_lands_on_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("outside-source.png");
        std::fs::write(&source, PNG_BYTES).expect("source bytes");
        let mut plane = plane_with_app_data(dir.path());
        let bridge = std::sync::Arc::new(RecordingUploadBridge::accepting());
        plane.uploads = bridge.clone();
        let app = router(plane);
        let body = json!({
            "family": "anima",
            "mode": "sam3",
            "images": [source.to_string_lossy()],
        });
        let (status, answer) = call(&app, post_request("/v1/queue", &body.to_string())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{answer}");
        assert_eq!(answer["reason"], "bodyInvalid");
        assert!(
            hint(&answer).contains("outside the closed vocabulary"),
            "{answer}"
        );
        assert!(
            bridge.placements().is_empty(),
            "the refusal placed bytes on its way out: {:?}",
            bridge.placements()
        );
        let queued = call(&app, test_request("/v1/queue")).await.1;
        assert_eq!(queued["count"], 0, "a refused body never reaches the spool");
    }

    /// AF2-M20 F5: the walls that need NO placed bytes — the model resolve among them
    /// — run BEFORE the E24 placement law's output-copy arm, so a body the door
    /// refuses on its model never promotes a copy into the input plane. The existence
    /// law keeps its place after placement (it stats placed+named names, by design).
    #[tokio::test]
    async fn the_model_resolve_wall_refuses_before_the_output_copy_arm_lands_bytes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        let outputs = tempfile::tempdir().expect("output root");
        std::fs::create_dir_all(outputs.path().join("starred")).expect("folder");
        let source = outputs.path().join("starred").join("hero.png");
        std::fs::write(&source, b"png-bytes-not-used").expect("source bytes");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        plane.output_root = Some(outputs.path().to_path_buf());
        let app = router(plane);
        // Mode valid, family valid, the reference is a legitimate ARM 3 (inside the
        // output root — the copy arm WOULD take it); the model reference is what the
        // door refuses: no index source is wired on this plane, so the resolve wall
        // answers `libraryScanRequired` before placement ever runs.
        let body = json!({
            "family": "anima",
            "mode": "t2i",
            "model": "deadcafebabefeed",
            "images": [source.to_string_lossy()],
        });
        let (status, answer) = call(&app, post_request("/v1/queue", &body.to_string())).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{answer}");
        assert_eq!(answer["reason"], "libraryScanRequired", "{answer}");
        // The temp input plane is the proof: zero entries — the copy arm never ran.
        let placed = std::fs::read_dir(inputs.path())
            .expect("input plane still readable")
            .count();
        assert_eq!(placed, 0, "the refusal promoted a copy anyway: {answer}");
        // The output plane's original is untouched either way (containment law).
        assert!(source.exists(), "the door never moves what it reads");
    }

    /// AF2-M18b WORD-RULE-4: the served document advertises the port this plane was
    /// booted on, not the literal it used to carry.
    #[tokio::test]
    async fn the_served_openapi_names_the_port_this_plane_is_booted_on() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        plane.settings.port = 18790;
        let (status, body) = call(&router(plane), test_request("/v1/openapi.json")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["servers"][0]["url"], "http://127.0.0.1:18790");
    }

    /* ---------- the generate door and the cycle view (M4-prep-A) ---------- */

    #[tokio::test]
    async fn generate_refuses_retired_wait_unknown_fields_and_missing_guard() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        // wait:"none" is refused by name before anything else runs.
        let (status, body) = call(&app, post_request("/v1/generate", r#"{"wait": "none"}"#)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "waitRetired");
        // Closed body grammar: unknown fields name themselves.
        let (status, body) = call(&app, post_request("/v1/generate", r#"{"go": true}"#)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(body["hint"].as_str().expect("hint").contains("go"));
        // No guard file: the cycle words are operator config; the honest word is
        // guardUnconfigured and NOTHING was claimed (the fence stays free).
        let (status, body) = call(&app, post_request("/v1/generate", "")).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["reason"], "guardUnconfigured");
        let (_, view) = call(&app, test_request("/v1/cycle")).await;
        assert_eq!(view["phase"], "idle", "a refusal claims nothing");
    }

    #[tokio::test]
    async fn generate_fence_refuses_a_second_cycle_with_cycle_in_flight() {
        // LEG AF2-M18c (D-1): this test CLAIMS the cell, which takes the stock-facing
        // fence with it — one process-wide static, so it holds the test gate for its
        // whole claim-test span like every other fence-reaching test.
        let _gate = crate::resources::fence_test_gate();
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(super::super::guard::FILE),
            r#"{"autoCycleVram": false}"#,
        )
        .expect("test fixture writes guard");
        let plane = plane_with_app_data(dir.path());
        // The fence is already held by a claimed (draining) cycle.
        plane
            .cycle
            .claim(super::super::cycle_view::CyclePhase::Draining)
            .expect("claim");
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/generate", "")).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["reason"], "cycleInFlight");
        assert_eq!(
            body["retryAfterMs"], 2_000,
            "the generate-time collision carries the poll cadence (§10): {body}"
        );
    }

    #[tokio::test]
    async fn cycle_view_answers_the_persisted_terminal_report() {
        // The dropped-socket resume door: a finished cycle's terminal report is
        // readable through GET /v1/cycle without any live cycle in flight.
        let dir = tempfile::tempdir().expect("tempdir");
        let plane = plane_with_app_data(dir.path());
        plane.cycle.finish(json!({
            "ok": true,
            "cycleId": "cycle-seed-1",
            "modelRestored": true,
            "rows": [{"id": "row-a", "status": "done", "error": null}],
        }));
        let app = router(plane);
        let (status, body) = call(&app, test_request("/v1/cycle")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["phase"], "idle");
        assert_eq!(body["cycleId"], "cycle-seed-1");
        assert_eq!(body["report"]["cycleId"], "cycle-seed-1");
        assert_eq!(body["report"]["rows"][0]["status"], "done");
    }

    /* ---------- M6b: the idempotency ledger at the generate door ---------- */

    /// A guard file with a real readiness URL (the resume-door fixture posture).
    fn write_ready_guard(dir: &std::path::Path) {
        std::fs::write(
            dir.join(super::super::guard::FILE),
            r#"{"autoCycleVram": false, "readyUrl": "http://127.0.0.1:18502/health"}"#,
        )
        .expect("test fixture writes guard");
    }

    #[tokio::test]
    async fn generate_key_hit_running_attaches_the_live_cycle() {
        // (a) The key's cycle IS the live cell: 409 cycleInFlight, the hint names
        // the attached cycleId, the same cadence const as the plain collision.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(super::super::guard::FILE),
            r#"{"autoCycleVram": false}"#,
        )
        .expect("test fixture writes guard");
        let plane = plane_with_app_data(dir.path());
        let claimed = plane
            .cycle
            .claim(super::super::cycle_view::CyclePhase::Draining)
            .expect("claim takes the fence");
        plane
            .ledger
            .append_running("session-key", &claimed)
            .expect("running row");
        let app = router(plane);
        let (status, body) = call(
            &app,
            post_request("/v1/generate", r#"{"key": "session-key"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["reason"], "cycleInFlight");
        assert_eq!(
            body["retryAfterMs"], 2_000,
            "the attach answers on the same cadence const"
        );
        assert!(
            body["hint"].as_str().expect("hint").contains(&claimed),
            "the hint names the attached cycleId: {body}"
        );
    }

    #[tokio::test]
    async fn generate_key_hit_terminal_answers_duplicate_and_never_re_drains() {
        // (c) The key's cycle already answered: 200 duplicate/done, the spool
        // stays untouched, the fence is never claimed.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(super::super::guard::FILE),
            r#"{"autoCycleVram": false}"#,
        )
        .expect("test fixture writes guard");
        let plane = plane_with_app_data(dir.path());
        plane
            .ledger
            .append_running("kd", "cycle-done-1")
            .expect("row");
        plane
            .ledger
            .mark_terminal("cycle-done-1")
            .expect("terminal row");
        let spool = Arc::clone(&plane.spool);
        let cycle = Arc::clone(&plane.cycle);
        let app = router(plane);
        // A queued row is waiting: a re-drain would consume it, so its survival
        // proves the door never claimed.
        let (_, body) = call(&app, post_request("/v1/queue", COMPLETE_ANIMA)).await;
        let queued_id = body["id"].as_str().expect("row id").to_owned();
        let (status, body) = call(&app, post_request("/v1/generate", r#"{"key": "kd"}"#)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["duplicate"], true);
        assert_eq!(body["state"], "done");
        assert_eq!(body["cycleId"], "cycle-done-1");
        assert_eq!(
            cycle.live().phase,
            super::super::cycle_view::CyclePhase::Idle,
            "never claimed"
        );
        let rows = spool.snapshot().expect("spool readable");
        assert_eq!(rows.len(), 1, "the spool stayed untouched");
        assert_eq!(rows[0].id, queued_id, "the queued row is still queued");
    }

    #[tokio::test]
    async fn generate_key_hit_running_after_a_crash_answers_interrupted() {
        // (b) Simulated crash: a stale `running` row over a fresh idle cell. The
        // door answers the interrupted posture — never a second drain, and the
        // hint names the honest re-drain path (re-POST without the key).
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(super::super::guard::FILE),
            r#"{"autoCycleVram": false}"#,
        )
        .expect("test fixture writes guard");
        let plane = plane_with_app_data(dir.path());
        plane
            .ledger
            .append_running("kx", "cycle-lost-by-restart")
            .expect("stale running row");
        let spool = Arc::clone(&plane.spool);
        let cycle = Arc::clone(&plane.cycle);
        let app = router(plane);
        let (_, body) = call(&app, post_request("/v1/queue", COMPLETE_ANIMA)).await;
        let queued_id = body["id"].as_str().expect("row id").to_owned();
        let (status, body) = call(&app, post_request("/v1/generate", r#"{"key": "kx"}"#)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["duplicate"], true);
        assert_eq!(body["state"], "interrupted");
        assert_eq!(body["cycleId"], "cycle-lost-by-restart");
        assert!(
            body["hint"]
                .as_str()
                .expect("hint")
                .contains("without the key"),
            "the hint names the honest re-drain path: {body}"
        );
        // W3-12 (LEG AF2-M21a): the hint no longer claims the rows "stay queued"
        // (a boot sweep may already have swept them) — it points at the truth door.
        assert!(
            body["hint"].as_str().expect("hint").contains("/v1/queue"),
            "the hint points at GET /v1/queue for the real row posture: {body}"
        );
        assert_eq!(
            cycle.live().phase,
            super::super::cycle_view::CyclePhase::Idle,
            "never claimed"
        );
        let rows = spool.snapshot().expect("spool readable");
        assert_eq!(rows.len(), 1, "the rows stay spooled");
        assert_eq!(rows[0].id, queued_id);
    }

    #[tokio::test]
    async fn watchdog_sever_door_without_trip_or_body_answers_job_unknown() {
        // W3-11's wall stands: no trip AND no explicit jobId = jobUnknown, the
        // door still invents no target.
        let dir = tempfile::tempdir().expect("tempdir");
        let plane = plane_with_app_data(dir.path());
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/watchdog/sever", "")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "jobUnknown", "{body}");
        assert!(
            hint(&body).contains("two-fact judge"),
            "the closed-window posture names itself: {body}"
        );
        assert!(
            hint(&body).contains("jobId"),
            "the hint names the new escape hatch (W3-11): {body}"
        );
    }

    #[tokio::test]
    async fn watchdog_sever_door_explicit_job_id_arms_the_same_arm_once() {
        // W3-11 (LEG AF2-M21a): the telemetry-less-box / pure-stock-wedge escape.
        // Over a closed window the closed body {"jobId": "..."} runs the SAME arm
        // (sever.rs one home), the journal names the trigger, and W3-9's honest
        // posture rides the answer (the scripted plane has no restore word).
        // W3-10: a second door call answers jobUnknown — no double arm.
        let dir = tempfile::tempdir().expect("tempdir");
        let plane = plane_with_app_data(dir.path());
        let journal = Arc::clone(plane.watchdog.journal());
        let app = router(plane);
        let (status, body) = call(
            &app,
            post_request("/v1/watchdog/sever", r#"{"jobId":"stock-7"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["reason"], "jobWedged",
            "the shipped sever word: {body}"
        );
        assert_eq!(
            body["freed"], true,
            "the scripted plane acks the free: {body}"
        );
        assert_eq!(
            body["restored"], false,
            "W3-9: a free with no restore word behind it never claims true: {body}"
        );
        assert_eq!(body["cardAtRisk"], true, "{body}");
        assert_eq!(body["trigger"], "manual-explicit", "{body}");
        assert_eq!(
            body["severedRow"],
            serde_json::Value::Null,
            "the spool never recorded stock-7: the unattributed scoping, honestly null"
        );
        let rows = journal.rows().expect("journal readable");
        let sever = rows
            .iter()
            .rev()
            .find(|entry| entry["event"] == "watchdog-sever")
            .expect("the arm journalled its answer");
        assert_eq!(sever["detail"]["trigger"], "manual-explicit", "{sever}");
        // W3-10: the trip was consumed by nobody and opened by nobody — the door
        // over a closed window answers jobUnknown, NEVER a second arm.
        let (status, body) = call(&app, post_request("/v1/watchdog/sever", "")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "jobUnknown", "no double arm: {body}");
    }

    #[tokio::test]
    async fn watchdog_sever_door_explicit_body_refuses_a_trip_that_landed_mid_call() {
        // W4-D (LEG AF2-M22): the explicit jobId branch CONSUMES the trip (the
        // same atomic take_trip as the empty-body path), so a judge trip that
        // opens between the door's earlier posture read and this call cannot run
        // a second arm beside the tripped window. The take lands, the door
        // refuses the explicit body (the window is open: re-send the empty
        // body), NO arm starts, and the trip is left for the tripped arm.
        let _gate = crate::resources::fence_test_gate();
        let dir = tempfile::tempdir().expect("tempdir");
        let plane = plane_with_app_data(dir.path());
        let journal = Arc::clone(plane.watchdog.journal());
        plane.watchdog.inject_trip_for_tests(watchdog::Subject {
            key: "stock-8".to_owned(),
            row_id: Some("row-judged".to_owned()),
            confirmed_running: true,
        });
        let app = router(plane);
        let (status, body) = call(
            &app,
            post_request("/v1/watchdog/sever", r#"{"jobId":"stock-8"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "bodyInvalid", "{body}");
        assert!(
            hint(&body).contains("window is open"),
            "the tripped-window posture answers, exactly the peek-era wording: {body}"
        );
        let rows = journal.rows().expect("journal readable");
        assert!(
            rows.iter().all(|entry| entry["event"] != "watchdog-sever"),
            "the seam counts ZERO sever legs — no arm ran: {rows:?}"
        );
        let (status, body) = call(&app, post_request("/v1/watchdog/sever", "")).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "the tripped window survived the refusal: {body}"
        );
        assert_eq!(body["trigger"], "manual", "{body}");
        assert_eq!(body["severedRow"], "row-judged", "{body}");
    }

    #[tokio::test]
    async fn watchdog_sever_door_refuses_the_open_body_grammar() {
        // W3-11's closed grammar, wall for wall: unknown keys, wrong types, empty
        // ids, extra keys and non-objects are all bodyInvalid — the door never
        // interprets a body it did not ask for.
        for (label, text) in [
            ("unknown key", r#"{"jobIdx":"stock-7"}"#),
            ("non-string jobId", r#"{"jobId":7}"#),
            ("empty jobId", r#"{"jobId":""}"#),
            ("extra key", r#"{"jobId":"stock-7","wait":false}"#),
            ("not an object", "[]"),
            ("not JSON", "{ jobId"),
        ] {
            let dir = tempfile::tempdir().expect("tempdir");
            let plane = plane_with_app_data(dir.path());
            let app = router(plane);
            let (status, body) = call(&app, post_request("/v1/watchdog/sever", text)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{label}: {body}");
            assert_eq!(body["reason"], "bodyInvalid", "{label}: {body}");
        }
    }

    #[tokio::test]
    async fn generate_corrupt_ledger_refuses_a_keyed_door_fail_closed() {
        // Corrupt ledger = maintenanceActive, not a forgotten key: the fence
        // stays free and an unkeyed generate is untouched by the ledger law.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(super::super::guard::FILE),
            r#"{"autoCycleVram": false}"#,
        )
        .expect("test fixture writes guard");
        std::fs::write(dir.path().join(idempotency::FILE), "{ broken")
            .expect("test fixture corrupts the ledger");
        let plane = plane_with_app_data(dir.path());
        let cycle = Arc::clone(&plane.cycle);
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/generate", r#"{"key": "kk"}"#)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        assert!(
            body["hint"]
                .as_str()
                .expect("hint")
                .contains(idempotency::FILE),
            "the hint names the file an operator must repair"
        );
        assert_eq!(
            cycle.live().phase,
            super::super::cycle_view::CyclePhase::Idle,
            "refusal claims nothing"
        );
        let on_disk =
            std::fs::read_to_string(dir.path().join(idempotency::FILE)).expect("still there");
        assert_eq!(on_disk, "{ broken", "the failed read never touches bytes");
    }

    #[tokio::test]
    async fn generate_keyed_cycle_records_running_then_terminal_and_answers_done_afterwards() {
        // Full keyed cycle: the running row lands before the drive, the
        // completion hook flips it terminal, the re-POST answers the (c)
        // duplicate, and the durable bytes carry only the digest.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(super::super::guard::FILE),
            r#"{"autoCycleVram": false}"#,
        )
        .expect("test fixture writes guard");
        let plane = plane_with_app_data(dir.path());
        let cycle = Arc::clone(&plane.cycle);
        let app = router(plane);
        let (_, body) = call(&app, post_request("/v1/queue", COMPLETE_ANIMA)).await;
        let row_id = body["id"].as_str().expect("row id").to_owned();
        let (status, body) = call(
            &app,
            post_request("/v1/generate", r#"{"key": "session-key-9f"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let cycle_id = body["cycleId"].as_str().expect("cycle id").to_owned();
        // The terminal mark rode the completion hook.
        let bytes = std::fs::read_to_string(dir.path().join(idempotency::FILE)).expect("ledger");
        let file: Value = serde_json::from_str(&bytes).expect("valid json");
        assert_eq!(file["rows"][0]["state"], "terminal");
        assert_eq!(file["rows"][0]["cycleId"], cycle_id);
        assert!(
            !bytes.contains("session-key-9f"),
            "the durable bytes never carry the key plaintext"
        );
        assert!(
            bytes.contains(&idempotency::Ledger::digest("session-key-9f")),
            "the digest is the identity on disk"
        );
        // The re-POST answers the duplicate; no second cycle, the row stays done.
        let (status, body) = call(
            &app,
            post_request("/v1/generate", r#"{"key": "session-key-9f"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["duplicate"], true);
        assert_eq!(body["state"], "done");
        assert_eq!(
            body["cycleId"], cycle_id,
            "the same cycle, never a new claim"
        );
        assert_eq!(cycle.live().cycle_id.as_deref(), Some(cycle_id.as_str()));
        let view = std::fs::read_to_string(dir.path().join(super::super::spool::FILE))
            .expect("spool on disk");
        assert!(
            view.contains(&row_id),
            "the drained row keeps its terminal history"
        );
    }

    #[tokio::test]
    async fn generate_without_a_key_leaves_the_ledger_file_uncreated() {
        // The missing-key path is unchanged: no lookup, no append, no file.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(super::super::guard::FILE),
            r#"{"autoCycleVram": false}"#,
        )
        .expect("test fixture writes guard");
        let app = router(plane_with_app_data(dir.path()));
        let (_, body) = call(&app, post_request("/v1/queue", COMPLETE_ANIMA)).await;
        let _ = body;
        let (status, body) = call(&app, post_request("/v1/generate", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(
            !dir.path().join(idempotency::FILE).exists(),
            "an unkeyed generate never touches the ledger"
        );
    }

    /* ---------- M6b: GET /v1/resume — the seven-state operator posture ---------- */

    #[tokio::test]
    async fn resume_answers_not_watched_before_any_cycle() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_ready_guard(dir.path());
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, test_request("/v1/resume")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], "notWatched");
        assert_eq!(body["ready"], false);
        assert!(
            body.get("retryAfterMs").is_none(),
            "no retry promise while unwatched"
        );
    }

    #[tokio::test]
    async fn resume_answers_unconfigured_without_a_readiness_target() {
        // No guard file at all…
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, test_request("/v1/resume")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], "unconfigured");
        assert_eq!(body["ready"], false);
        assert!(
            body["hint"].as_str().expect("hint").contains("readyUrl"),
            "the hint names the missing config"
        );
        // …and a valid guard whose readyUrl is empty: same honest word.
        let dir2 = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir2.path().join(super::super::guard::FILE),
            r#"{"autoCycleVram": false}"#,
        )
        .expect("test fixture writes guard");
        let app2 = router(plane_with_app_data(dir2.path()));
        let (status, body) = call(&app2, test_request("/v1/resume")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], "unconfigured");
    }

    #[tokio::test]
    async fn resume_answers_failed_after_restore_exhaustion() {
        // §8.4: the persisted report names the exhaustion fault — the word the
        // operator reads is `failed`, with the cadence promise.
        let dir = tempfile::tempdir().expect("tempdir");
        write_ready_guard(dir.path());
        let plane = plane_with_app_data(dir.path());
        plane.cycle.finish(json!({
            "ok": false,
            "cycleId": "cycle-exhausted",
            "modelRestored": false,
            "rows": [],
            "fault": { "reason": "restoreExhausted", "detail": "test fixture" },
        }));
        let app = router(plane);
        let (status, body) = call(&app, test_request("/v1/resume")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], "failed");
        assert_eq!(body["ready"], false);
        assert_eq!(body["retryAfterMs"], 2_000);
    }

    #[tokio::test]
    async fn resume_answers_debt_outstanding_when_a_restore_is_owed() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_ready_guard(dir.path());
        let plane = plane_with_app_data(dir.path());
        plane.cycle.finish(json!({
            "ok": true,
            "cycleId": "cycle-debt",
            "modelRestored": false,
            "rows": [],
        }));
        let app = router(plane);
        let (status, body) = call(&app, test_request("/v1/resume")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], "debtOutstanding");
        assert_eq!(body["ready"], false);
        assert_eq!(
            body["retryAfterMs"], 2_000,
            "the debt posture carries the cadence"
        );
    }

    #[tokio::test]
    async fn resume_ready_last_fact_never_probes() {
        // The af-01 D5 law on the wire: between watches the last terminal
        // report's healthy fact answers `ready` — the probe seam stays silent.
        let dir = tempfile::tempdir().expect("tempdir");
        write_ready_guard(dir.path());
        let mut plane = plane_with_app_data(dir.path());
        let prober = Arc::new(resume::ScriptProbe::always(true));
        let probed: Arc<dyn HealthProbe> = prober.clone();
        plane.resume = Arc::new(resume::ResumeWatch::scripted_for_tests(probed));
        plane.cycle.finish(json!({
            "ok": true,
            "cycleId": "cycle-restored",
            "modelRestored": true,
            "rows": [],
        }));
        let app = router(plane);
        let (status, body) = call(&app, test_request("/v1/resume")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], "ready");
        assert_eq!(
            body["ready"], true,
            "ready is the only posture that says ready"
        );
        assert!(body.get("retryAfterMs").is_none());
        assert_eq!(
            prober.probes(),
            0,
            "the last-known fact owes the target no probe"
        );
    }

    #[tokio::test]
    async fn resume_restoring_leg_probes_once_and_parks_at_probing_when_down() {
        // Live restore leg + unhealthy target: `probing` with the cadence, and
        // two fast reads share ONE probe (the shipped seam's ≤1 per 2 s law).
        let dir = tempfile::tempdir().expect("tempdir");
        write_ready_guard(dir.path());
        let mut plane = plane_with_app_data(dir.path());
        let prober = Arc::new(resume::ScriptProbe::always(false));
        let probed: Arc<dyn HealthProbe> = prober.clone();
        plane.resume = Arc::new(resume::ResumeWatch::scripted_for_tests(probed));
        plane
            .cycle
            .claim(super::super::cycle_view::CyclePhase::Restoring)
            .expect("claim parks the cell in the restore leg");
        let app = router(plane);
        let (status, body) = call(&app, test_request("/v1/resume")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], "probing");
        assert_eq!(body["ready"], false);
        assert_eq!(body["retryAfterMs"], 2_000);
        let (status, body) = call(&app, test_request("/v1/resume")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], "probing");
        assert_eq!(prober.probes(), 1, "the cadence gate reused the fresh fact");
    }

    #[tokio::test]
    async fn resume_live_healthy_probe_answers_ready_on_the_spot() {
        // E5's zero settle window on the wire: a healthy probe during the
        // restore leg lands `ready` immediately (the settling word ships behind
        // the dial, pinned in the resume module's own tests).
        let dir = tempfile::tempdir().expect("tempdir");
        write_ready_guard(dir.path());
        let mut plane = plane_with_app_data(dir.path());
        plane.resume = Arc::new(resume::ResumeWatch::scripted_for_tests(Arc::new(
            resume::ScriptProbe::always(true),
        )));
        plane
            .cycle
            .claim(super::super::cycle_view::CyclePhase::Restoring)
            .expect("claim parks the cell in the restore leg");
        let app = router(plane);
        let (status, body) = call(&app, test_request("/v1/resume")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], "ready");
        assert_eq!(body["ready"], true);
    }

    #[tokio::test]
    async fn resume_is_registered_by_the_index_and_discovered_like_every_door() {
        let app = router(state(&["http://localhost:1420"], None));
        let (_, body) = call(&app, test_request("/v1/routes")).await;
        let resume_rows = body["routes"]
            .as_array()
            .expect("routes array")
            .iter()
            .filter(|row| row["path"] == "/v1/resume" && row["method"] == "GET")
            .count();
        assert_eq!(resume_rows, 1, "the index surfaces the resume door once");
    }

    #[tokio::test]
    async fn status_and_cycle_report_guard_truth() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, test_request("/v1/cycle")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["configured"], false);
        assert_eq!(body["phase"], "idle");
        let (status, body) = call(&app, test_request("/v1/status")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["backend"]["state"], "unknown");
        assert_eq!(body["lanes"]["render"]["max"], 4);
        assert_eq!(body["lanes"]["control"]["max"], 2);
        assert_eq!(body["cycle"]["phase"], "idle");
        assert_eq!(body["guard"]["configured"], false);
        // E25 (LEG AF2-M19b): the status composition carries NO `downloads` member —
        // the download doors are deleted, and an empty object would fake a surface
        // that no longer exists. Honest absence, pinned.
        assert!(
            body.get("downloads").is_none(),
            "the deleted surface must be absent, not empty: {body}"
        );
    }

    #[tokio::test]
    async fn errors_surface_lists_the_closed_taxonomy_exactly_once() {
        let app = router(state(&["http://localhost:1420"], None));
        let (status, body) = call(&app, test_request("/v1/errors")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        assert_eq!(body["count"], ALL_KINDS.len());
        assert_eq!(
            ALL_KINDS.len(),
            25,
            "the closed taxonomy is 25 words (LEG M12 grew prepareRefused + spoolFull; LEG MEDIA-1 grew inputMissing + capExceeded)"
        );
        let kinds = body["kinds"].as_array().expect("kinds array");
        assert_eq!(kinds.len(), ALL_KINDS.len());
        for kind in ALL_KINDS {
            let matches = kinds
                .iter()
                .filter(|row| {
                    row["reason"] == kind.reason()
                        && row["code"] == kind.code()
                        && row["status"] == i32::from(kind.status().as_u16())
                })
                .count();
            assert_eq!(matches, 1, "{} must appear exactly once", kind.reason());
        }
    }

    #[tokio::test]
    async fn routes_surface_equals_the_index_exactly() {
        let app = router(state(&["http://localhost:1420"], None));
        let (status, body) = call(&app, test_request("/v1/routes")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["count"], routes::ROUTE_INDEX.len());
        let served = body["routes"].as_array().expect("routes array");
        assert_eq!(served.len(), routes::ROUTE_INDEX.len());
        for (served, def) in served.iter().zip(routes::ROUTE_INDEX) {
            assert_eq!(served["method"], def.method);
            assert_eq!(served["path"], def.path);
            assert_eq!(served["lane"], super::super::lanes::lane_word(def.lane));
            assert_eq!(served["purpose"], def.purpose);
        }
    }

    #[tokio::test]
    async fn openapi_paths_match_the_served_index_and_error_taxonomy() {
        let app = router(state(&["http://localhost:1420"], None));
        let (status, body) = call(&app, test_request("/v1/openapi.json")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["openapi"], "3.1.0");
        // Source-lift gate: the served document's method+path pairs equal the closed
        // route index (one path can carry two rows, so pairs are counted, not paths).
        let paths = body["paths"].as_object().expect("paths object");
        let served_pairs: usize = paths
            .values()
            .map(|item| item.as_object().expect("method map").len())
            .sum();
        assert_eq!(served_pairs, routes::ROUTE_INDEX.len());
        for def in routes::ROUTE_INDEX {
            assert!(
                paths[def.path][def.method.to_lowercase()].is_object(),
                "openapi serves {} {}",
                def.method,
                def.path
            );
        }
        for (path, item) in paths {
            for method in item
                .as_object()
                .expect("method map")
                .keys()
                .map(|method| method.to_uppercase())
            {
                assert!(
                    routes::lookup(&method, path).is_some(),
                    "openapi pair {method} {path} is not in the closed index"
                );
            }
        }
        let reasons = body["components"]["schemas"]["ErrorBody"]["properties"]["reason"]["enum"]
            .as_array()
            .expect("reason enum");
        assert_eq!(reasons.len(), ALL_KINDS.len());
    }

    #[tokio::test]
    async fn help_at_v1_describes_the_plane_and_index() {
        let app = router(state(&["http://localhost:1420"], None));
        let (status, body) = call(&app, test_request("/v1")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        assert_eq!(body["plane"], "deas-agent-api");
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(body["enabled"], true);
        assert_eq!(body["port"], 8790);
        let routes_served = body["routes"].as_array().expect("routes array");
        assert_eq!(routes_served.len(), routes::ROUTE_INDEX.len());
        for (served, def) in routes_served.iter().zip(routes::ROUTE_INDEX) {
            assert_eq!(served["path"], def.path);
            assert_eq!(served["method"], def.method);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn control_lane_exhaustion_refuses_the_next_control_request() {
        // Current-thread runtime plus noop-waker polling: futures advance only when
        // this test drives them, so permit holdings are deterministic — no sleeps,
        // no racing against worker threads.
        let dir = tempfile::tempdir().expect("tempdir");
        let (app, mut ready, release) = gated_probe(dir.path());
        let mut first = Box::pin(call(&app, test_request("/v1/cycle")));
        let mut second = Box::pin(call(&app, test_request("/v1/cycle")));
        // Parked means: past the lane gate (permit held), signaled, waiting on the
        // release oneshot.
        assert_parked(first.as_mut());
        ready.recv().await.expect("first probe holds a permit");
        assert_parked(second.as_mut());
        ready.recv().await.expect("second probe holds a permit");
        // Both control permits are now provably held: the next control request is
        // refused with the laneFull word.
        let (status, body) = call(&app, test_request("/v1/cycle")).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
        assert_eq!(body["error"], "LANE_FULL");
        assert_eq!(body["reason"], "laneFull");
        // The 404 fallback spends no permit: it answers taxonomy even with the lane full.
        let (status, body) = call(&app, test_request("/v1/nope")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["reason"], "routeNotFound");
        // Release: the parked probes resume, answer, and their permits drop with them.
        release.send(true).expect("release both parked probes");
        let (first_status, first_body) = match poll_once(first.as_mut()) {
            std::task::Poll::Ready(value) => value,
            std::task::Poll::Pending => panic!("first probe did not resume after release"),
        };
        assert_eq!(first_status, StatusCode::OK, "{first_body}");
        let (second_status, second_body) = match poll_once(second.as_mut()) {
            std::task::Poll::Ready(value) => value,
            std::task::Poll::Pending => panic!("second probe did not resume after release"),
        };
        assert_eq!(second_status, StatusCode::OK, "{second_body}");
        // With both permits released the lane admits a fresh control request.
        let (status, _) = call(&app, test_request("/v1/cycle")).await;
        assert_eq!(status, StatusCode::OK);
    }

    /* ---------- the unified resolver at the queue door (M3b) ---------- */

    /// Writes a stock-shaped snapshot index over `root` into `index_dir` and points a
    /// plane at it. The index file name is the stock reader's own law: `models-` plus the
    /// SHA-256 of the serialized roots array; `detector` must equal the package version,
    /// exactly what the stock `read_any` compares. Nothing here walks a model folder or
    /// runs a scan: the resolver reads a pre-built index the way a scanned install
    /// presents it.
    fn plane_with_library(
        index_dir: &std::path::Path,
        root: &std::path::Path,
        records: &[Value],
    ) -> PlaneState {
        let mut plane = plane_with_app_data(index_dir);
        let roots = vec![root.to_path_buf()];
        let key = {
            use sha2::Digest as _;
            format!(
                "{:x}",
                sha2::Sha256::digest(serde_json::to_vec(&roots).expect("roots"))
            )
        };
        let index = json!({
            "schema": crate::downloads::models::index::SCHEMA,
            "detector": env!("CARGO_PKG_VERSION"),
            "roots": roots,
            "records": records,
        });
        std::fs::write(
            index_dir.join(format!("models-{key}.json")),
            serde_json::to_vec(&index).expect("index bytes"),
        )
        .expect("index file");
        plane.library = Some(IndexSource {
            index_dir: index_dir.to_path_buf(),
            roots,
        });
        plane
    }

    /// One snapshot record in the stock serialized shape: `path` under a root, `name` the
    /// ComfyUI-relative remainder (the stock reader proves `path` ends with `name`),
    /// `info.sha256` the fingerprint the §9 handle derives from.
    fn record(
        category: &str,
        name: &str,
        root: &std::path::Path,
        sha: Option<&str>,
        family: Option<&str>,
        component: Option<&str>,
    ) -> Value {
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
    }

    /// A library an anima request can fully resolve: the model plus its two split-loader
    /// components, each carrying the header-verified architecture the family accepts.
    fn anima_records(root: &std::path::Path) -> Vec<Value> {
        vec![
            record(
                "diffusion_models",
                "anima.safetensors",
                root,
                Some("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"),
                Some("anima"),
                None,
            ),
            record(
                "text_encoders",
                "qwen3-0.6b.safetensors",
                root,
                None,
                None,
                Some("qwen3-0.6b"),
            ),
            record(
                "vae",
                "wan_2.1_vae.safetensors",
                root,
                None,
                None,
                Some("wan-2.1-vae"),
            ),
        ]
    }

    /// A queue body naming ONLY the model reference: the resolver must supply the family
    /// word, the checkpoint slot and the diffusion recipe for the row to be drain-ready.
    const MODEL_ONLY: &str = r#"{
        "model": "a1b2c3d4e5f6",
        "mode": "t2i",
        "positivePrompt": "a lighthouse at dusk",
        "outputPrefix": "agent/run"
    }"#;

    #[tokio::test]
    async fn queue_post_resolves_a_model_handle_end_to_end() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let (status, body) = call(&app, post_request("/v1/queue", MODEL_ONLY)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], "queued");
        // The resolver's identity: the §9 handle from the library fingerprint.
        assert_eq!(body["modelHandle"], "a1b2c3d4e5f6");
        // The family word came from the library, not from the request.
        assert_eq!(body["envelope"]["family"], "anima");
        assert_eq!(body["envelope"]["missingSlots"], json!([]));
        // The row is in the durable spool like any other door-verified row.
        let (_, listed) = call(&app, test_request("/v1/queue")).await;
        assert_eq!(listed["count"], 1);
        assert_eq!(listed["rows"][0]["family"], "anima");
    }

    #[tokio::test]
    async fn queue_post_resolves_a_name_reference_to_the_same_entry() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let body = MODEL_ONLY.replace("\"a1b2c3d4e5f6\"", "\"anima.safetensors\"");
        let (status, answer) = call(&app, post_request("/v1/queue", &body)).await;
        assert_eq!(status, StatusCode::OK, "{answer}");
        assert_eq!(answer["envelope"]["family"], "anima");
        assert_eq!(answer["modelHandle"], "a1b2c3d4e5f6");
    }

    #[tokio::test]
    async fn queue_post_refuses_an_unknown_model_reference_as_scan_required() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let body = MODEL_ONLY.replace("a1b2c3d4e5f6", "ffffffffffff");
        let (status, answer) = call(&app, post_request("/v1/queue", &body)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{answer}");
        assert_eq!(answer["reason"], "libraryScanRequired");
        let (_, listed) = call(&app, test_request("/v1/queue")).await;
        assert_eq!(listed["count"], 0, "a refused resolve writes no row");
    }

    #[tokio::test]
    async fn queue_post_refuses_a_split_loader_model_without_its_components() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let records = vec![anima_records(root.path()).remove(0)];
        let app = router(plane_with_library(dir.path(), root.path(), &records));
        let (status, answer) = call(&app, post_request("/v1/queue", MODEL_ONLY)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{answer}");
        assert_eq!(answer["reason"], "libraryScanRequired");
        let hint = answer["hint"].as_str().unwrap_or_default();
        assert!(
            hint.contains("textEncoders") && hint.contains("qwen3-0.6b"),
            "{hint}"
        );
    }

    #[tokio::test]
    async fn queue_post_refuses_a_family_word_that_conflicts_with_the_library() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let body = MODEL_ONLY.replace("\"model\":", "\"family\": \"flux\", \"model\":");
        let (status, answer) = call(&app, post_request("/v1/queue", &body)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{answer}");
        assert_eq!(answer["reason"], "familyAmbiguous");
        let hint = answer["hint"].as_str().unwrap_or_default();
        assert!(hint.contains("flux") && hint.contains("anima"), "{hint}");
    }

    #[tokio::test]
    async fn queue_post_keeps_an_explicit_checkpoint_over_the_resolved_one() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let body = MODEL_ONLY.replace(
            "\"outputPrefix\": \"agent/run\"",
            "\"outputPrefix\": \"agent/run\", \"checkpoint\": \"my/pick.safetensors\"",
        );
        let (status, answer) = call(&app, post_request("/v1/queue", &body)).await;
        assert_eq!(status, StatusCode::OK, "{answer}");
        assert_eq!(answer["modelHandle"], "a1b2c3d4e5f6");
    }

    #[tokio::test]
    async fn queue_post_expands_turbo_through_the_builtin_variant() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let records = vec![
            record(
                "diffusion_models",
                "qwen.safetensors",
                root.path(),
                Some("bbbb0000111122223333444455556666777788889999aaaabbbbccccdddd"),
                Some("qwen-image-2.1"),
                None,
            ),
            record(
                "text_encoders",
                "qwen3vl.safetensors",
                root.path(),
                None,
                None,
                Some("qwen3-vl-8b"),
            ),
            record(
                "vae",
                "qwenimagevae.safetensors",
                root.path(),
                None,
                None,
                Some("qwen-image-2.1-vae"),
            ),
        ];
        let app = router(plane_with_library(dir.path(), root.path(), &records));
        let body = r#"{
            "model": "bbbb00001111",
            "mode": "t2i",
            "turbo": "--turbo",
            "positivePrompt": "a dune at noon",
            "outputPrefix": "agent/run"
        }"#;
        let (status, answer) = call(&app, post_request("/v1/queue", body)).await;
        assert_eq!(status, StatusCode::OK, "{answer}");
        // §9: turbo rewrote the family to the builtin variant; it set no flag.
        assert_eq!(answer["envelope"]["family"], "qwen-image-2.1-turbo");
        assert!(answer["envelope"]["extras"]
            .as_array()
            .is_some_and(|extras| extras.contains(&json!("sigmas"))));
        // The variant's own stock defaults drive the ladder (8 steps, CFG 1).
        let steps = answer["envelope"]["fields"]
            .as_array()
            .and_then(|fields| fields.iter().find(|field| field["field"] == "steps"))
            .expect("steps field");
        assert_eq!(steps["value"], 8);
        assert_eq!(steps["source"], "stock");
    }

    #[tokio::test]
    async fn queue_post_refuses_turbo_for_a_family_without_a_variant() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let body = MODEL_ONLY.replace("\"mode\":", "\"turbo\": true, \"mode\":");
        let (status, answer) = call(&app, post_request("/v1/queue", &body)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{answer}");
        assert_eq!(answer["reason"], "turboUnsupported");
        assert!(answer["hint"]
            .as_str()
            .unwrap_or_default()
            .contains("anima"));
    }

    #[tokio::test]
    async fn queue_post_without_a_model_or_a_family_word_is_body_invalid() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let body = r#"{ "mode": "t2i", "positivePrompt": "x", "outputPrefix": "agent/run" }"#;
        let (status, answer) = call(&app, post_request("/v1/queue", body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{answer}");
        assert_eq!(answer["reason"], "bodyInvalid");
    }

    #[tokio::test]
    async fn queue_post_with_a_model_over_an_unwired_library_is_scan_required() {
        let dir = tempfile::tempdir().expect("index dir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, answer) = call(&app, post_request("/v1/queue", MODEL_ONLY)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{answer}");
        assert_eq!(answer["reason"], "libraryScanRequired");
    }

    /* ---------- the library identity doors (M9d) ---------- */

    /// PRIVACY LAW (law-named): `GET /v1/models` serves identity, never a local path. The
    /// fake index's records carry the tempdir root in their `path` field; that string must
    /// appear nowhere in the answer, in either separator form.
    #[tokio::test]
    async fn models_door_never_leaks_a_library_path_and_answers_the_identity_shape() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let (status, body) = call(&app, test_request("/v1/models")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["ok"].as_bool().unwrap_or(false));
        assert_eq!(body["count"], 3);
        let text = body.to_string();
        let local = root.path().to_string_lossy().into_owned();
        assert!(
            !text.contains(&local),
            "a local model path reached the wire: {text}"
        );
        assert!(
            !text.contains(&local.replace('\\', "/")),
            "a local model path reached the wire in the other separator form"
        );
        // The §9 identity the agent keys on: handle, fingerprint, family, category, name.
        let anima = body["models"]
            .as_array()
            .expect("models")
            .iter()
            .find(|row| row["name"] == "anima.safetensors")
            .cloned()
            .unwrap_or(Value::Null);
        assert_eq!(anima["handle"], "a1b2c3d4e5f6");
        assert_eq!(anima["category"], "diffusion_models");
        // E26 (LEG AF2-M19b, additive): root-relative placement rides the row —
        // the category folder inside the models root, never the root itself.
        assert_eq!(anima["subfolder"], "diffusion_models", "{anima}");
        assert_eq!(anima["family"], "anima");
        assert_eq!(anima["detectedFamily"], "anima");
        assert!(anima.get("path").is_none(), "{anima}");
        // An entry the scan never fingerprinted answers the honest null pair.
        let vae = body["models"]
            .as_array()
            .expect("models")
            .iter()
            .find(|row| row["name"] == "wan_2.1_vae.safetensors")
            .cloned()
            .unwrap_or(Value::Null);
        assert_eq!(vae["handle"], Value::Null);
        assert_eq!(vae["sha256"], Value::Null);
    }

    #[tokio::test]
    async fn models_and_resolve_surface_indexed_trigger_words_additively() {
        // LEG M15 (design 12.1 addendum, API-DESIGN.md:444): the scan stores
        // sidecar trigger words on the snapshot record
        // (`downloads_models_index.rs:22`, written by `native_model_edit_lora`
        // downloads_models.rs:1610-1628). Both identity doors surface them
        // verbatim from the LOADED index — no sidecar walk, no new file read —
        // and an entry that stored none answers the honest null. The fold
        // itself stays trigger-free (the e16 `--lora` home carries the
        // ruling); triggers are surfaced, never injected.
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let mut records = anima_records(root.path());
        records[0]["model"]["triggerWords"] = json!(["fox form", "night howl"]);
        let app = router(plane_with_library(dir.path(), root.path(), &records));
        let (_, body) = call(&app, test_request("/v1/models")).await;
        let anima = body["models"]
            .as_array()
            .expect("models")
            .iter()
            .find(|row| row["name"] == "anima.safetensors")
            .cloned()
            .unwrap_or(Value::Null);
        assert_eq!(anima["triggerWords"], json!(["fox form", "night howl"]));
        let vae = body["models"]
            .as_array()
            .expect("models")
            .iter()
            .find(|row| row["name"] == "wan_2.1_vae.safetensors")
            .cloned()
            .unwrap_or(Value::Null);
        assert_eq!(
            vae["triggerWords"],
            Value::Null,
            "stored nothing answers null"
        );
        // The resolve echo is built by the same identity home, so the trigger
        // list reaches a stranger's lookup exactly as it reaches the listing.
        let (_, body) = call(&app, test_request("/v1/resolve/anima.safetensors")).await;
        assert_eq!(
            body["matches"][0]["triggerWords"],
            json!(["fox form", "night howl"]),
            "{body}"
        );
        // The resolve echo is the same identity home, so the E26 subfolder word
        // reaches a stranger's lookup exactly as it reaches the listing.
        assert_eq!(
            body["matches"][0]["subfolder"], "diffusion_models",
            "{body}"
        );
    }

    #[tokio::test]
    async fn models_door_filters_by_q_case_insensitively_and_names_the_remedy() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let (status, body) = call(&app, test_request("/v1/models?q=ANIMA")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["count"], 1, "the family word and the name both match");
        assert_eq!(body["models"][0]["name"], "anima.safetensors");
        let (_, body) = call(&app, test_request("/v1/models?q=vae")).await;
        assert_eq!(body["count"], 1, "the category is a filter field too");
        let (status, body) = call(&app, test_request("/v1/models?q=nomatch")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["count"], 0);
        assert!(
            body["nextMove"]
                .as_str()
                .unwrap_or_default()
                .contains("q filter"),
            "a filter miss says the filter missed, not that the library is empty: {body}"
        );
        let (status, body) = call(&app, test_request("/v1/models?q=a&q=b")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "bodyInvalid", "the query grammar is closed");
    }

    /// A plane with no index source answers the same honest word the queue door answers —
    /// no empty library is ever claimed over an unreadable index.
    #[tokio::test]
    async fn identity_doors_answer_scan_required_with_no_index_wired() {
        let dir = tempfile::tempdir().expect("index dir");
        let app = router(plane_with_app_data(dir.path()));
        for path in [
            "/v1/models",
            "/v1/models?q=anima",
            "/v1/resolve/a1b2c3d4e5f6",
        ] {
            let (status, body) = call(&app, test_request(path)).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{path}: {body}");
            assert_eq!(body["reason"], "libraryScanRequired", "{path}");
        }
    }

    #[tokio::test]
    async fn models_status_answers_the_stock_scan_words_plus_library_ready() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let plane = plane_with_library(dir.path(), root.path(), &anima_records(root.path()));
        let (status, body) = call(&router(plane), test_request("/v1/models/status")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        // The stock status shape rides verbatim, and idle never claims a cold library.
        assert_eq!(body["scan"]["state"], "idle");
        assert_eq!(body["scan"]["root"], "R:/models");
        assert_eq!(
            body["libraryReady"], true,
            "a readable non-empty index is ready"
        );
        assert!(
            body["note"]
                .as_str()
                .unwrap_or_default()
                .contains("no scan is running now"),
            "{body}"
        );
        // The same door over a plane with no index is honest the other way, still 200:
        // the scan slot posture is answerable even when the library is not.
        let (_, body) = call(
            &router(plane_with_app_data(dir.path())),
            test_request("/v1/models/status"),
        )
        .await;
        assert_eq!(body["libraryReady"], false, "{body}");
    }

    /// AF2-M27 (owner law 2026-11-22): the rescan door's body grammar is ZERO keys. Every
    /// key — including the stock scan's own `scope` and the E26-dead `root` — is refused BY
    /// NAME with the closed-grammar wording, and a non-object body rides the same word.
    #[tokio::test]
    async fn the_rescan_door_takes_zero_parameters_and_refuses_every_key_by_name() {
        let dir = tempfile::tempdir().expect("app data");
        let app = router(plane_with_app_data(dir.path()));
        for body_text in [
            r#"{"scope":"all"}"#,
            r#"{"root":"D:/models"}"#,
            r#"{"category":"vae"}"#,
            r#"{"force":true}"#,
            "[]",
            "null",
        ] {
            let (status, answer) = call(&app, post_request("/v1/models/refresh", body_text)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body_text}: {answer}");
            assert_eq!(answer["reason"], "bodyInvalid", "{body_text}");
            assert!(
                hint(&answer).contains("the rescan takes no parameters")
                    && hint(&answer).contains("saved model folders"),
                "{body_text}: {answer}"
            );
        }
        // A refused key is named, so the caller learns which parameter is dead.
        let (_, answer) = call(
            &app,
            post_request("/v1/models/refresh", r#"{"scope":"all"}"#),
        )
        .await;
        assert!(
            hint(&answer).contains("'scope'"),
            "names the dead key: {answer}"
        );
    }

    /// The rescan walks the engine's saved folders, so an unwired source is the identity
    /// doors' honest `libraryScanRequired` — never a walk of a guessed tree.
    #[tokio::test]
    async fn the_rescan_door_answers_scan_required_with_no_index_wired() {
        let dir = tempfile::tempdir().expect("app data");
        let (status, body) = call(
            &router(plane_with_app_data(dir.path())),
            post_request("/v1/models/refresh", "{}"),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["reason"], "libraryScanRequired");
        assert!(
            hint(&body).contains("saved model folders")
                && hint(&body).contains("open the DEAS environment"),
            "{body}"
        );
    }

    /// The door end-to-end over a real (tiny) saved folder: the walk runs on the blocking
    /// pool through the stock seam, the answer counts the rebuilt snapshot, and the E26
    /// privacy law holds — the answer carries positional saved-folder words and never
    /// utters the root it walked.
    #[tokio::test]
    async fn the_rescan_door_runs_the_stock_refresh_and_answers_the_fresh_count() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        std::fs::create_dir_all(root.path().join("checkpoints")).expect("category folder");
        std::fs::write(root.path().join("checkpoints/one.pt"), b"fixture").expect("model file");
        let app = router(plane_with_library(dir.path(), root.path(), &[]));
        let (status, body) = call(&app, post_request("/v1/models/refresh", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], true);
        assert_eq!(body["refreshed"], 1, "the rebuilt snapshot's entry count");
        assert_eq!(body["roots"], json!(["primary saved models folder"]));
        assert!(
            body["nextMove"]
                .as_str()
                .unwrap_or_default()
                .contains("GET /v1/models"),
            "{body}"
        );
        // PRIVACY LAW (E26 kin): the walked root is plane-side; no absolute path rides the
        // answer in either direction.
        assert!(
            !body
                .to_string()
                .contains(&root.path().to_string_lossy().into_owned()),
            "the answer never utters the root: {body}"
        );
    }

    /// The three §3 reference forms answer through the resolver's own lookup, and the
    /// answer is the same path-free identity row `GET /v1/models` serves.
    #[tokio::test]
    async fn resolve_door_answers_handle_name_and_path_form_alike() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let path_form = root
            .path()
            .join("diffusion_models")
            .join("anima.safetensors")
            .to_string_lossy()
            .into_owned();
        let probes = [
            "/v1/resolve/a1b2c3d4e5f6".to_owned(),
            "/v1/resolve/anima.safetensors".to_owned(),
            format!(
                "/v1/resolve/{}",
                path_form.replace('\\', "%5C").replace('/', "%2F")
            ),
        ];
        for probe in probes {
            let (status, body) = call(&app, test_request(&probe)).await;
            assert_eq!(status, StatusCode::OK, "{probe}: {body}");
            assert_eq!(body["count"], 1, "{probe}");
            assert_eq!(body["matches"][0]["name"], "anima.safetensors", "{probe}");
            assert_eq!(body["matches"][0]["handle"], "a1b2c3d4e5f6", "{probe}");
            let text = body.to_string();
            assert!(
                !text.contains(&path_form) && !text.contains(&path_form.replace('\\', "/")),
                "PRIVACY LAW: the resolve door leaked the path it was asked about: {text}"
            );
        }
    }

    #[tokio::test]
    async fn resolve_door_answers_zero_matches_empty_with_the_scan_remedy() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let (status, body) = call(&app, test_request("/v1/resolve/ffffffffffff")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], true);
        assert_eq!(body["count"], 0);
        assert_eq!(body["matches"], json!([]));
        assert!(
            body["nextMove"]
                .as_str()
                .unwrap_or_default()
                .contains("POST /v1/scan"),
            "{body}"
        );
    }

    /// One name carried by two library entries is the resolver's own honest word, with
    /// every candidate named — the identity door never picks a winner.
    #[tokio::test]
    async fn resolve_door_refuses_an_ambiguous_name_by_naming_every_candidate() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let mut records = anima_records(root.path());
        records.push(record(
            "checkpoints",
            "anima.safetensors",
            root.path(),
            Some("ffffffffffff0718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3"),
            Some("flux"),
            None,
        ));
        let app = router(plane_with_library(dir.path(), root.path(), &records));
        let (status, body) = call(&app, test_request("/v1/resolve/anima.safetensors")).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["reason"], "familyAmbiguous");
        let hint = body["hint"].as_str().unwrap_or_default();
        assert!(
            hint.contains("checkpoints") && hint.contains("diffusion_models"),
            "{hint}"
        );
        assert!(hint.contains("disambiguate"), "{hint}");
    }

    #[tokio::test]
    async fn resolve_door_refuses_a_malformed_percent_escape_and_a_two_segment_probe() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let (status, body) = call(&app, test_request("/v1/resolve/a1b2%zz")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "bodyInvalid");
        for probe in ["/v1/resolve/", "/v1/resolve/two/segments"] {
            let (status, body) = call(&app, test_request(probe)).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{probe}: {body}");
            assert_eq!(body["reason"], "routeNotFound", "{probe}");
        }
    }

    /// The uploads-grammar pin: the input inventory labels exactly what the stock
    /// placement seams mint, tags the origin honestly, and never emits the input root.
    #[tokio::test]
    async fn inputs_door_lists_grammar_rows_tagged_by_placement_and_never_a_root() {
        let dir = tempfile::tempdir().expect("app data");
        let input_root = tempfile::tempdir().expect("input root");
        let write = |relative: &str, bytes: &[u8]| {
            let target = input_root
                .path()
                .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
            std::fs::create_dir_all(target.parent().expect("folder")).expect("folder");
            std::fs::write(&target, bytes).expect("placed file");
        };
        write("deas-inputs/deas-input-1.png", b"\x89PNG fake");
        std::thread::sleep(std::time::Duration::from_millis(5));
        write("deas-masks/deas-mask-1.png", b"\x89PNG mask");
        std::thread::sleep(std::time::Duration::from_millis(5));
        write("deas-input-2.mp4", b"video bytes");
        std::thread::sleep(std::time::Duration::from_millis(5));
        write("operator-drop.png", b"not plane-placed");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(input_root.path().to_path_buf());
        let app = router(plane.clone());
        let (status, body) = call(&app, test_request("/v1/inputs")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["note"], super::super::inputs::ORIGIN_NOTE, "{body}");
        assert_eq!(body["count"], 3, "{body}");
        assert_eq!(body["truncated"], false);
        assert_eq!(
            body["unlisted"], 0,
            "a root drop with no prefix is not counted"
        );
        let kinds: Vec<&str> = body["inputs"]
            .as_array()
            .expect("inputs")
            .iter()
            .map(|row| row["kind"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(
            kinds,
            vec!["video", "mask", "image"],
            "most recent first (E22 recency law)"
        );
        for row in body["inputs"].as_array().expect("inputs") {
            assert_eq!(row["placedByGrammar"], true, "{row}");
            assert!(row["sizeBytes"].as_u64().unwrap_or(0) > 0, "{row}");
        }
        let text = body.to_string();
        let local = input_root.path().to_string_lossy().into_owned();
        assert!(
            !text.contains(&local),
            "the input root reached the wire: {text}"
        );
        // No parameters: the closed grammar is empty, and the refusal says so.
        let (status, body) = call(&router(plane), test_request("/v1/inputs?kind=image")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "bodyInvalid");
    }

    #[tokio::test]
    async fn inputs_door_answers_honestly_when_no_input_root_is_derivable() {
        let dir = tempfile::tempdir().expect("app data");
        let (status, body) = call(
            &router(plane_with_app_data(dir.path())),
            test_request("/v1/inputs"),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        assert!(
            body["hint"]
                .as_str()
                .unwrap_or_default()
                .contains("open the environment"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn fingerprint_door_starts_the_same_scan_the_ui_scan_files_call_makes() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let (status, body) = call(
            &app,
            post_request("/v1/fingerprint", r#"{"action":"start"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["scan"]["state"], "running", "{body}");
        assert_eq!(body["aliasOf"], "POST /v1/scan");
        assert_eq!(body["scope"], "all");
        // An empty body is the same door call: one closed grammar, no ceremony.
        let (status, body) = call(&app, post_request("/v1/fingerprint", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["scan"]["state"], "running");
    }

    /// The reserve law, surfaced verbatim: a second scan (checked at the door) answers the
    /// stock engine's own words, never a silent restart.
    #[tokio::test]
    async fn fingerprint_door_refuses_a_second_scan_with_the_stock_reserve_words() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let mut plane = plane_with_library(dir.path(), root.path(), &anima_records(root.path()));
        plane.scan = Arc::new(FakeScanBridge::running());
        let (status, body) = call(&router(plane), post_request("/v1/fingerprint", "{}")).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["reason"], "cycleInFlight");
        assert!(
            body["hint"]
                .as_str()
                .unwrap_or_default()
                .contains("A Library file scan is already running"),
            "the reserve refusal rides verbatim: {body}"
        );
    }

    /// The race path: the door's own check passed, the engine refused — its text surfaces
    /// unedited, still the in-flight word.
    #[tokio::test]
    async fn fingerprint_door_surfaces_the_reserve_refusal_the_engine_itself_answered() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let mut plane = plane_with_library(dir.path(), root.path(), &anima_records(root.path()));
        plane.scan = Arc::new(FakeScanBridge::refusing_start(
            "A Library file scan is already running",
        ));
        let (status, body) = call(&router(plane), post_request("/v1/fingerprint", "{}")).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["reason"], "cycleInFlight");
        assert!(
            body["hint"]
                .as_str()
                .unwrap_or_default()
                .contains("A Library file scan is already running"),
            "{body}"
        );
    }

    /// Pause honesty: stock has no pause verb, so the plane refuses with the taxonomy's
    /// unsupported-verb word and names the truth — it invents no control stock lacks.
    #[tokio::test]
    async fn fingerprint_door_refuses_pause_naming_the_no_stock_pause_truth() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        let (status, body) = call(
            &app,
            post_request("/v1/fingerprint", r#"{"action":"pause"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(
            body["hint"]
                .as_str()
                .unwrap_or_default()
                .contains("no pause verb"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn fingerprint_door_refuses_anything_outside_the_closed_body_grammar() {
        let dir = tempfile::tempdir().expect("index dir");
        let root = tempfile::tempdir().expect("model root");
        let app = router(plane_with_library(
            dir.path(),
            root.path(),
            &anima_records(root.path()),
        ));
        for body_text in [
            r#"{"action":"stop"}"#,
            r#"{"scope":"all"}"#,
            r#"[1,2]"#,
            r#"{"action":7}"#,
        ] {
            let (status, answer) = call(&app, post_request("/v1/fingerprint", body_text)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body_text}: {answer}");
            assert_eq!(answer["reason"], "bodyInvalid", "{body_text}");
        }
    }

    #[test]
    fn decode_reference_keeps_a_path_reference_in_one_segment() {
        let decoded =
            routes::decode_reference("C%3A%5Cmodels%5Canima.safetensors").expect("decodes");
        assert_eq!(decoded, "C:\\models\\anima.safetensors");
        assert_eq!(
            routes::decode_reference("anima.safetensors").expect("literal"),
            "anima.safetensors"
        );
        for malformed in ["a%zzb", "a%2", "a%"] {
            let error = routes::decode_reference(malformed).expect_err("malformed escape refuses");
            assert_eq!(error.body_json()["reason"], "bodyInvalid", "{malformed}");
        }
    }

    /// Index law: every M9d door is a control-lane door with a purpose and an operationId,
    /// so the discovery surfaces and the lane gate see them the moment they exist.
    #[test]
    fn the_library_identity_doors_are_indexed_control_lane_doors() {
        let indexed = [
            ("GET", "/v1/models"),
            ("GET", "/v1/models/status"),
            ("GET", "/v1/resolve/{q}"),
            ("GET", "/v1/inputs"),
            ("POST", "/v1/fingerprint"),
            ("POST", "/v1/refmods"),
        ];
        for (method, path) in indexed {
            let route = routes::lookup(method, path)
                .unwrap_or_else(|| panic!("{method} {path} is indexed"));
            assert_eq!(
                route.lane,
                super::super::lanes::Lane::Control,
                "{path} lane"
            );
            assert!(
                !route.purpose.is_empty() && !route.operation.is_empty(),
                "{path}"
            );
        }
        assert_eq!(
            routes::ROUTE_INDEX.len(),
            46,
            "the closed index: +3 RefMod doors (M9e, M9e-close), +4 MEDIA-1 byte doors (the outputs list, two byte reads, the promote door), +1 one-segment root output read (M16 FIX-A, the MEDIA-1 flag), +2 bench declutter doors (M17b, ruling E22: inputs + outputs), -5 download doors (E25, LEG AF2-M19b: the whole /v1/downloads set deleted — models are CALL + SCAN only over this API), +2 continuity doors (AF2-M25b: the sessions clip read and the video prepare), +1 rescan door (AF2-M27: POST /v1/models/refresh — the agent's own call for the stock index refresh that recomputes component and family stamps), and -1 row at AF2-M29: the M16 one-segment root read and the LEG MEDIA-1 two-segment output read RETIRE into one catch-all row GET /v1/files/outputs/{{*path}} (video-ready subfolder reads; the outputFileRead operation survives, outputFileReadRoot retires with its row), +1 join door (AF2-M31: POST /v1/videos/join - the final cut of the H3-continuity chain, one model-free DaSiWaH3ClipAssemble row), +1 story door (AF2-M32: POST /v1/videos/story - a whole H3 continuation chain as ONE atomic batch of ordinary accepted rows; the drain substitutes each step's parent clip id at resolution, stock validate_continuity re-runs on the resolved block before prepare, and an unreplaced '@story' is stock-illegal ON PURPOSE)"
        );
    }

    #[tokio::test]
    async fn families_surface_lists_modes_per_family_with_the_ace_music_leg_open() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, test_request("/v1/families")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["count"], 42);
        assert_eq!(body["modes"], json!(defaults::MODES));
        let families = body["families"].as_array().expect("families");
        let find = |id: &str| {
            families
                .iter()
                .find(|entry| entry["id"] == id)
                .cloned()
                .unwrap_or(Value::Null)
        };
        let anima = find("anima");
        assert_eq!(anima["loader"], "diffusion");
        assert_eq!(anima["defaults"]["steps"], 30);
        for mode in ["t2i", "i2i", "inpaint", "refine", "upscale"] {
            assert!(
                anima["modes"].as_array().unwrap().contains(&json!(mode)),
                "{anima}"
            );
        }
        // A video family with an i2i leg runs the image modes but never t2i.
        let h3 = find("minimax-h3");
        assert!(h3["modes"].as_array().unwrap().contains(&json!("i2i")));
        // The music arm (LEG M9e): YuE2 answers both music words. LEG M14b OPENED
        // the ACE-Step leg — the M9e-era negative pin on this very line (2307) is
        // retired: the seven ace-step rows answer the music words too, because the
        // queue door now runs the arm the surface promises (fill_plane
        // `runnable_modes_serves_both_music_words_for_yue2_and_every_ace_step_family`
        // is the fill-side twin).
        let yue2 = find("yue2");
        assert!(yue2["modes"].as_array().unwrap().contains(&json!("music")));
        assert!(yue2["modes"].as_array().unwrap().contains(&json!("t2m")));
        for ace in ["ace-step-1-0", "ace-step-1-5-xl-turbo"] {
            let modes = find(ace)["modes"].as_array().unwrap().clone();
            assert!(
                modes.contains(&json!("music")) && modes.contains(&json!("t2m")),
                "{ace} answers the opened music leg: {modes:?}"
            );
        }
        assert!(
            !h3["modes"].as_array().unwrap().contains(&json!("t2i")),
            "{h3}"
        );
        // minimax-h3 declares every video pipeline word, so the twelve-word
        // vocabulary's video arms all answer (the generic `video` word and the
        // three concrete t2v/i2v/v2v forms, M9c).
        for mode in ["ref2va", "video", "t2v", "i2v", "v2v"] {
            assert!(
                h3["modes"].as_array().unwrap().contains(&json!(mode)),
                "h3 declares the {mode} pipeline: {h3}"
            );
        }
        // Video-only families run no image mode at all (the door's fail-closed
        // law), but the video arms are live: wan declares exactly the `i2v`
        // pipeline word, so the surface answers the generic `video` word and
        // `i2v` in mode-table order — never `t2v`/`v2v`, never an image mode.
        let wan = find("wan");
        assert_eq!(wan["modes"], json!(["video", "i2v"]), "{wan}");
    }

    #[tokio::test]
    async fn families_route_is_closed_to_unindexed_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        // Only the exact indexed path is served: `/v1/families/{id}` is a §4 future row,
        // not a slice of this one, and the taxonomy answers rather than a default page.
        let (status, body) = call(&app, test_request("/v1/families/anima")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["reason"], "routeNotFound");
    }

    /* ---------- the scan bridge and uploads plane (M3c) ---------- */

    /// A POST with a raw body (the scan door takes an optional JSON object, the
    /// uploads door takes media bytes), same walls as [`test_request`].
    fn raw_post(path: &str, body_bytes: Vec<u8>) -> Request {
        Request::builder()
            .method("POST")
            .uri(format!("http://127.0.0.1:8790{path}"))
            .header("host", "127.0.0.1:8790")
            .header("origin", "http://localhost:1420")
            .body(Body::from(body_bytes))
            .expect("valid test request")
    }

    /// Magic-byte fixtures the stock sniffer recognizes: PNG, MP4 (`ftyp` at 4, not
    /// M4A/MOV brands), WAV.
    const PNG_BYTES: &[u8] = b"\x89PNG\r\n\x1a\n";
    const MP4_BYTES: &[u8] = b"\x00\x00\x00\x18ftypmp42";
    const WAV_BYTES: &[u8] = b"RIFF\x00\x00\x00\x00WAVE";

    #[tokio::test]
    async fn scan_get_answers_the_stock_status_shape_verbatim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, test_request("/v1/scan")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], true);
        // The fake engine sits idle: the honest boot posture (v0.3.14 has no
        // interrupted scan state — that posture belongs to the download engine).
        assert_eq!(body["scan"]["state"], "idle");
        assert_eq!(body["scan"]["root"], "R:/models");
        assert_eq!(body["scan"]["completed"], 0);
        assert!(body["scan"]["file"].is_null());
    }

    #[tokio::test]
    async fn scan_post_answers_the_initial_running_status_and_honors_the_scope_word() {
        // E26 (LEG AF2-M19b): no root parameter — the scan walks the engine's saved
        // model folders, so the fixture injects the saved root and the door must
        // start its scan over exactly that folder.
        let dir = tempfile::tempdir().expect("tempdir");
        let root = tempfile::tempdir().expect("saved model root");
        let mut plane = plane_with_app_data(dir.path());
        plane.library = Some(IndexSource {
            index_dir: dir.path().join("index-cache"),
            roots: vec![root.path().to_path_buf()],
        });
        let app = router(plane);
        let body_text = json!({ "scope": "loras" }).to_string();
        let (status, body) = call(&app, raw_post("/v1/scan", body_text.as_bytes().to_vec())).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["scan"]["state"], "running");
        assert_eq!(body["scan"]["id"], "fake-scan-1");
        // The saved root rides through to the stock-shaped status — the walk is
        // pinned to the folder the engine already knows, never a caller-named tree.
        assert_eq!(
            body["scan"]["root"],
            root.path().to_string_lossy().to_string()
        );
    }

    #[tokio::test]
    async fn scan_post_refuses_a_running_scan_as_cycle_in_flight_never_a_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = tempfile::tempdir().expect("saved model root");
        let mut plane = plane_with_app_data(dir.path());
        plane.library = Some(IndexSource {
            index_dir: dir.path().join("index-cache"),
            roots: vec![root.path().to_path_buf()],
        });
        plane.scan = std::sync::Arc::new(FakeScanBridge::running());
        let app = router(plane);
        let (status, body) = call(&app, raw_post("/v1/scan", Vec::new())).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["reason"], "cycleInFlight");
        assert!(
            body["hint"]
                .as_str()
                .expect("hint")
                .contains("already running"),
            "{body}"
        );
        // The stock engine's own refusal word maps to the same door word even when
        // the door check races past it (idle status, refusing start).
        let mut raced = plane_with_app_data(dir.path());
        raced.library = Some(IndexSource {
            index_dir: dir.path().join("index-cache"),
            roots: vec![root.path().to_path_buf()],
        });
        raced.scan = std::sync::Arc::new(FakeScanBridge::refusing_start(
            "A Library file scan is already running",
        ));
        let raced = router(raced);
        let (status, body) = call(&raced, raw_post("/v1/scan", Vec::new())).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["reason"], "cycleInFlight");
    }

    #[tokio::test]
    async fn scan_post_surfaces_stock_refusals_as_maintenance_naming_the_cause() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = tempfile::tempdir().expect("saved model root");
        let mut plane = plane_with_app_data(dir.path());
        plane.library = Some(IndexSource {
            index_dir: dir.path().join("index-cache"),
            roots: vec![root.path().to_path_buf()],
        });
        plane.scan = std::sync::Arc::new(FakeScanBridge::refusing_start(
            "Wait for downloads to finish before scanning files",
        ));
        let app = router(plane);
        let (status, body) = call(&app, raw_post("/v1/scan", Vec::new())).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        assert!(
            body["hint"].as_str().expect("hint").contains("downloads"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn scan_post_without_a_derivable_root_names_the_environment_remedy() {
        // No app handle, no injected library, no explicit root: no model root is
        // derivable, and the refusal names the honest remedy.
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, raw_post("/v1/scan", Vec::new())).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        assert!(
            body["hint"].as_str().expect("hint").contains("environment"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn scan_post_refuses_unknown_fields_scopes_and_relative_roots() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        for body_text in [
            r#"{"nope": 1}"#,
            r#"{"scope": "everything"}"#,
            r#"{"root": "relative/models"}"#,
            r#"{"authenticated": "yes"}"#,
            "{ broken",
        ] {
            let (status, body) =
                call(&app, raw_post("/v1/scan", body_text.as_bytes().to_vec())).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body_text}: {body}");
            assert_eq!(body["reason"], "bodyInvalid", "{body_text}");
        }
        // E26 (law-named, LEG AF2-M19b): the root parameter is DELETED, not
        // contained — a `root` arriving is refused BY NAME by the closed-body law.
        let (status, body) = call(
            &app,
            raw_post(
                "/v1/scan",
                json!({ "root": "C:\\Windows" })
                    .to_string()
                    .as_bytes()
                    .to_vec(),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "bodyInvalid");
        let problem = hint(&body);
        assert!(
            problem.contains("root"),
            "the refusal names 'root' by name: {problem}"
        );
        assert!(
            problem.contains("scope, authenticated"),
            "the closed grammar in the refusal is scope, authenticated: {problem}"
        );
    }

    #[tokio::test]
    async fn uploads_place_image_mask_and_video_under_their_stock_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        let bridge = std::sync::Arc::new(RecordingUploadBridge::accepting());
        plane.uploads = bridge.clone();
        let app = router(plane);

        let (status, body) =
            call(&app, raw_post("/v1/uploads?kind=image", PNG_BYTES.to_vec())).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["placement"], "deas-inputs/fake-image.png");
        assert_eq!(body["actual"], true, "a uuid placement never collides");
        assert_eq!(body["kind"], "image");
        assert_eq!(body["bytes"], PNG_BYTES.len());

        let (status, body) =
            call(&app, raw_post("/v1/uploads?kind=mask", PNG_BYTES.to_vec())).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["placement"], "deas-masks/fake-mask.png");

        let (status, body) =
            call(&app, raw_post("/v1/uploads?kind=video", MP4_BYTES.to_vec())).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        // Video lands at the input ROOT with the deas-input- prefix (stock placement
        // law: core LoadVideo lists top-level input files only).
        assert_eq!(body["placement"], "deas-input-fake-video.mp4");

        assert_eq!(
            bridge.placements(),
            vec![
                (UploadKind::Image, PNG_BYTES.len(), None),
                (UploadKind::Mask, PNG_BYTES.len(), None),
                (UploadKind::Video, MP4_BYTES.len(), None),
            ],
            "the seam receives exactly the bodies the door validated"
        );
    }

    #[tokio::test]
    async fn uploads_pathwall_refuses_traversal_separators_and_empty_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        let bridge = std::sync::Arc::new(RecordingUploadBridge::accepting());
        plane.uploads = bridge.clone();
        let app = router(plane);
        for name in ["../evil.png", "a/b.png", "..", "", "C:\\x.png"] {
            let (status, body) = call(
                &app,
                raw_post(
                    &format!("/v1/uploads?kind=image&name={name}"),
                    PNG_BYTES.to_vec(),
                ),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{name:?}: {body}");
            assert_eq!(body["reason"], "bodyInvalid", "{name:?}");
        }
        assert!(
            bridge.placements().is_empty(),
            "a refused name places nothing"
        );
        // A bare filename rides through untouched — and at the ROOT the E22 truth
        // stands: the name passes the pathwall, then the stock uuid-mint law owns
        // the placement (validated-then-discarded, exactly as before E22).
        let (status, body) = call(
            &app,
            raw_post("/v1/uploads?kind=image&name=photo.png", PNG_BYTES.to_vec()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["placement"], "deas-inputs/fake-image.png",
            "the root name is honored by no one: the uuid law owns the root"
        );
    }

    #[tokio::test]
    async fn uploads_content_table_binds_the_kind_word_to_the_body_magic() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        let bridge = std::sync::Arc::new(RecordingUploadBridge::accepting());
        plane.uploads = bridge.clone();
        let app = router(plane);
        // Kind claims video bytes as image: refused, both words named.
        let (status, body) =
            call(&app, raw_post("/v1/uploads?kind=image", MP4_BYTES.to_vec())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "bodyInvalid");
        let hint = body["hint"].as_str().expect("hint");
        assert!(hint.contains("image") && hint.contains("video"), "{hint}");
        // Unrecognized magic, an empty body, a mask over non-PNG, and a missing or
        // unknown kind word all refuse with the vocabulary in the hint.
        for (path, bytes) in [
            ("/v1/uploads?kind=image", b"just text, no magic".to_vec()),
            ("/v1/uploads?kind=image", Vec::new()),
            ("/v1/uploads?kind=mask", WAV_BYTES.to_vec()),
            ("/v1/uploads", PNG_BYTES.to_vec()),
            ("/v1/uploads?kind=file", PNG_BYTES.to_vec()),
        ] {
            let (status, body) = call(&app, raw_post(path, bytes)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {body}");
            assert_eq!(body["reason"], "bodyInvalid", "{path}");
        }
        assert!(
            bridge.placements().is_empty(),
            "refused bytes place nothing"
        );
    }

    #[tokio::test]
    async fn uploads_refuse_an_over_cap_body_naming_the_cap_with_the_cap_word() {
        // LEG MEDIA-1 restate: the over-cap body is no longer a bodyInvalid
        // shape complaint — it answers the taxonomy's capExceeded word at 413
        // (bytes arriving past a configured network cap).
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let mut oversized = PNG_BYTES.to_vec();
        // The §11 network cap rides the guard-file default (50 MiB), whose one home is
        // `caps` (LEG AF2-M19a deleted the plane's duplicate constant).
        oversized.resize(
            super::super::caps::Caps::bytes(super::super::caps::DEFAULT_UPLOAD_SINGLE_MIB) as usize
                + 1,
            0,
        );
        let (status, body) = call(&app, raw_post("/v1/uploads?kind=image", oversized)).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
        assert_eq!(body["reason"], "capExceeded");
        assert_eq!(body["error"], "CAP_EXCEEDED");
        assert!(hint(&body).contains("50 MiB"), "{body}");
    }

    #[tokio::test]
    async fn uploads_refuse_unknown_or_duplicated_query_keys() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        for path in [
            "/v1/uploads?kind=image&type=input",
            "/v1/uploads?kind=image&kind=video",
            "/v1/uploads?=x",
        ] {
            let (status, body) = call(&app, raw_post(path, PNG_BYTES.to_vec())).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {body}");
            assert_eq!(body["reason"], "bodyInvalid", "{path}");
        }
    }

    /// E22 (LEG M17a): `?subfolder=&name=` land together under deas-inputs/; the
    /// answer carries the backend's final `placement` and `actual`.
    #[tokio::test]
    async fn uploads_subfolder_grammar_places_nested_names_and_reports_actual() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        let bridge = std::sync::Arc::new(RecordingUploadBridge::accepting());
        plane.uploads = bridge.clone();
        let app = router(plane);

        let (status, body) = call(
            &app,
            raw_post(
                "/v1/uploads?kind=image&subfolder=project1&name=pic.png",
                PNG_BYTES.to_vec(),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["placement"], "deas-inputs/project1/pic.png");
        assert_eq!(body["actual"], true, "the requested name landed verbatim");
        assert_eq!(body["kind"], "image");
        assert_eq!(body["bytes"], PNG_BYTES.len());

        // E22 video asymmetry, honestly: a nested video PLACES (the H3 media
        // grammar resolves deas-inputs/<sub>/x.mp4); the core LoadVideo recipes
        // (LTX sourceVideo, faceRefine, sam3-video) refuse it at their own stock
        // compile walls — untouched by this door.
        let (status, body) = call(
            &app,
            raw_post(
                "/v1/uploads?kind=video&subfolder=project1&name=clip.mp4",
                MP4_BYTES.to_vec(),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["placement"], "deas-inputs/project1/clip.mp4");
        assert_eq!(body["actual"], true);

        // Nested audio rides the same grammar, multi-segment included.
        let (status, body) = call(
            &app,
            raw_post(
                "/v1/uploads?kind=audio&subfolder=project1/deep&name=song.wav",
                WAV_BYTES.to_vec(),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["placement"], "deas-inputs/project1/deep/song.wav");

        assert_eq!(
            bridge.placements(),
            vec![
                (
                    UploadKind::Image,
                    PNG_BYTES.len(),
                    Some("project1".to_owned())
                ),
                (
                    UploadKind::Video,
                    MP4_BYTES.len(),
                    Some("project1".to_owned())
                ),
                (
                    UploadKind::Audio,
                    WAV_BYTES.len(),
                    Some("project1/deep".to_owned())
                ),
            ],
            "the seam receives the validated scope verbatim"
        );
    }

    /// E22 scope walls: masks refuse subfolder (stock uuid law), the grammar
    /// refuses breaks, and a scope without a name is refused (the uuid-mint law
    /// is the root's, not the subfolder's).
    #[tokio::test]
    async fn uploads_subfolder_wall_refuses_mask_grammar_breaks_and_nameless_scopes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        let bridge = std::sync::Arc::new(RecordingUploadBridge::accepting());
        plane.uploads = bridge.clone();
        let app = router(plane);
        let long = "a".repeat(129);
        let paths: Vec<String> = [
            "/v1/uploads?kind=mask&subfolder=project1&name=m.png",
            "/v1/uploads?kind=image&subfolder=&name=pic.png",
            "/v1/uploads?kind=image&subfolder=project1",
            "/v1/uploads?kind=image&subfolder=..&name=pic.png",
            "/v1/uploads?kind=image&subfolder=.bench-x&name=pic.png",
            "/v1/uploads?kind=image&subfolder=a//b&name=pic.png",
            "/v1/uploads?kind=image&subfolder=a/b/c/d/e/f/g/h/i&name=pic.png",
            "/v1/uploads?kind=image&subfolder=project1&name=a/b.png",
            "/v1/uploads?kind=image&subfolder=project1&name=.hidden.png",
            "/v1/uploads?kind=image&subfolder=project1&name=",
        ]
        .into_iter()
        .map(str::to_owned)
        .chain(std::iter::once(format!(
            "/v1/uploads?kind=image&subfolder={long}&name=pic.png"
        )))
        .collect();
        for path in paths {
            let (status, body) = call(&app, raw_post(&path, PNG_BYTES.to_vec())).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {body}");
            assert_eq!(body["reason"], "bodyInvalid", "{path}");
        }
        assert!(
            bridge.placements().is_empty(),
            "a refused scope places nothing"
        );
    }

    /// The real collision rename is a LIVE-backend fact (server.py identical-hash
    /// keeps, ` (N)` loop otherwise); this seam-level pin holds the plane's
    /// honest reporting of the backend's final name. Window-side live collision
    /// stays open until a backend run (doc-flagged in the leg packet).
    #[tokio::test]
    async fn uploads_scoped_collision_rename_answers_actual_false_with_the_backends_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        plane.uploads = std::sync::Arc::new(RecordingUploadBridge::renaming());
        let app = router(plane);
        let (status, body) = call(
            &app,
            raw_post(
                "/v1/uploads?kind=image&subfolder=project1&name=pic.png",
                PNG_BYTES.to_vec(),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["placement"], "deas-inputs/project1/pic (1).png");
        assert_eq!(body["actual"], false, "the requested name collided");
    }

    #[tokio::test]
    async fn uploads_without_a_running_backend_ride_maintenance_with_the_seam_text() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        plane.uploads = std::sync::Arc::new(RecordingUploadBridge::refusing(
            "no owned backend is running; uploads place bytes into the running backend's input plane",
        ));
        let app = router(plane);
        let (status, body) =
            call(&app, raw_post("/v1/uploads?kind=image", PNG_BYTES.to_vec())).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        assert!(
            body["hint"].as_str().expect("hint").contains("backend"),
            "{body}"
        );
    }

    /* ------------------------- M9b result doors (§4.4) ------------------------- */

    use super::super::cycle_view::CyclePhase;
    use super::super::results::FakeResultsBridge;

    /// The auth wall is middleware: one stranger refusal on one new door pins the
    /// wall for the whole result surface (Origin → Host → key, never per-route).
    #[tokio::test]
    async fn stranger_origin_is_refused_at_the_wall_on_a_result_door() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(
            &app,
            request(
                "/v1/jobs",
                Some("http://not-on-the-allowlist.example"),
                "127.0.0.1:8790",
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["reason"], "originDenied");
    }

    #[tokio::test]
    async fn jobs_list_merges_workbench_and_root_rows_deduped_by_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        let app = router(plane.clone());
        let (status, body) = call(&app, test_request("/v1/jobs")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["count"], 2, "{body}");
        let ids: Vec<&str> = body["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| row["id"].as_str().expect("row id"))
            .collect();
        assert_eq!(
            ids,
            ["wb-row", "root-row"],
            "workbench first, root appended"
        );
        // A root row the workbench listing already carries is never doubled.
        plane.results = std::sync::Arc::new(
            FakeResultsBridge::healthy().with_current(json!({"id": "wb-row", "state": "queued"})),
        );
        let app = router(plane);
        let (status, body) = call(&app, test_request("/v1/jobs")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["count"], 1, "{body}");
    }

    #[tokio::test]
    async fn job_status_answers_the_row_and_unknown_ids_answer_job_unknown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        let app = router(plane.clone());
        let (status, body) = call(&app, test_request("/v1/jobs/wb-row")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["row"]["id"], "wb-row");
        plane.results =
            std::sync::Arc::new(FakeResultsBridge::healthy().status_refusing("Unknown native job"));
        let app = router(plane);
        let (status, body) = call(&app, test_request("/v1/jobs/no-such-row")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "jobUnknown", "the errors.rs single home");
        assert!(
            body["hint"]
                .as_str()
                .expect("hint")
                .contains("Unknown native job"),
            "the stock string rides verbatim: {body}"
        );
    }

    #[tokio::test]
    async fn cancel_picks_the_interrupt_for_a_running_row_never_the_pending_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        plane.results = std::sync::Arc::new(
            FakeResultsBridge::healthy()
                .with_status("run-row", Ok(json!({"id": "run-row", "state": "running"})))
                .interrupting_to(json!({"id": "run-row", "via": "interrupt"}))
                .cancel_refusing("the pending path must not run for a running row"),
        );
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/jobs/run-row/cancel", "{}")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["id"], "run-row");
        assert_eq!(body["snapshot"]["via"], "interrupt", "{body}");
    }

    #[tokio::test]
    async fn cancel_of_a_queued_row_runs_the_pending_path_and_stock_busy_refusals_pass_through() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        let app = router(plane.clone());
        let (status, body) = call(&app, post_request("/v1/jobs/wb-row/cancel", "{}")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["snapshot"]["state"], "cancelled");
        // A stock busy refusal keeps its stock string verbatim under the honest
        // maintenance word — the plane invents no reason and swallows no stock law.
        plane.results = std::sync::Arc::new(
            FakeResultsBridge::healthy()
                .cancel_refusing("Native Workbench job is busy; no cancellation sent"),
        );
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/jobs/busy-row/cancel", "{}")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        assert!(
            body["hint"]
                .as_str()
                .expect("hint")
                .contains("Native Workbench job is busy; no cancellation sent"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn stop_answers_the_stock_view_and_refuses_honestly_when_the_driver_refuses() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        let app = router(plane.clone());
        let (status, body) = call(&app, post_request("/v1/stop", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], true);
        assert_eq!(body["stop"]["stopped"], 1);
        plane.results =
            std::sync::Arc::new(FakeResultsBridge::healthy().stop_refusing(
                "Workbench admission epoch exhausted; Stop refused without mutation",
            ));
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/stop", "")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        assert!(
            body["hint"]
                .as_str()
                .expect("hint")
                .contains("admission epoch"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn free_answers_freed_over_the_shipped_door_with_no_retry_on_the_manual_wire() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        let door = std::sync::Arc::new(cycle::ScriptDoor::free_scripted([false]));
        plane.cycle_seams = std::sync::Arc::new(cycle::CycleSeams {
            door,
            ..cycle::CycleSeams::defaults_for_tests()
        });
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/free", "")).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(
            body["reason"], "handoffFailed",
            "the release wire refused: {body}"
        );
    }

    #[tokio::test]
    async fn free_is_refused_mid_cycle_naming_the_phase_and_never_touches_the_door() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        let door = std::sync::Arc::new(cycle::ScriptDoor::accepting());
        plane.cycle_seams = std::sync::Arc::new(cycle::CycleSeams {
            door: door.clone() as std::sync::Arc<dyn cycle::BackendDoor>,
            ..cycle::CycleSeams::defaults_for_tests()
        });
        plane.cycle.claim(CyclePhase::Draining).expect("claim");
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/free", "")).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["reason"], "cycleInFlight");
        assert!(
            body["hint"].as_str().expect("hint").contains("draining"),
            "the refusal names the phase: {body}"
        );
        assert_eq!(
            door.free_calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "the mid-cycle refusal never spends the free wire"
        );
    }

    #[tokio::test]
    async fn history_passes_the_stock_view_through_verbatim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, test_request("/v1/history")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["history"]["schemaVersion"], 1);
        assert_eq!(body["history"]["readOnly"], false);
        assert_eq!(
            body["history"]["records"]
                .as_array()
                .expect("records")
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn output_answers_base64_and_the_bytes_round_trip() {
        use base64::Engine as _;
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, test_request("/v1/outputs/row/0")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["jobId"], "row");
        assert_eq!(body["index"], 0);
        assert_eq!(body["mimeType"], "image/png");
        assert_eq!(body["width"], 8);
        assert_eq!(body["height"], 8);
        assert_eq!(body["sha256"], "ab12");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(body["bytesBase64"].as_str().expect("base64"))
            .expect("decodes");
        assert_eq!(decoded, vec![0x89, b'P', b'N', b'G'], "round trip");
    }

    #[tokio::test]
    async fn output_gate_refusal_answers_lane_full_with_the_stock_string_verbatim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        plane.results = std::sync::Arc::new(
            FakeResultsBridge::healthy().output_refusing("Another output fetch is in progress"),
        );
        let app = router(plane);
        let (status, body) = call(&app, test_request("/v1/outputs/row/1")).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
        assert_eq!(body["reason"], "laneFull", "the manager-approved mapping");
        assert!(
            body["hint"]
                .as_str()
                .expect("hint")
                .contains("Another output fetch is in progress"),
            "the stock gate string rides verbatim: {body}"
        );
        // The path shape is closed: a non-numeric index addresses no row.
        let (status, body) = call(&app, test_request("/v1/outputs/row/not-a-number")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["reason"], "routeNotFound");
    }

    #[tokio::test]
    async fn queue_clear_answers_zero_on_an_empty_spool_and_is_legal_idle() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(&app, post_request("/v1/queue/clear", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["cleared"], 0);
        assert!(body["ok"].as_bool().expect("ok"));
    }

    // ── The RefMod creation door (LEG M9e) ──────────────────────────────────────

    /// The door with a scripted submit seam, so the export shape and the taxonomy
    /// mapping run through the real walls with no backend and no card.
    fn refmod_plane(
        dir: &std::path::Path,
        bridge: std::sync::Arc<super::super::results::FakeRefmodBridge>,
    ) -> Router {
        let mut plane = plane_with_app_data(dir);
        plane.refmods = bridge;
        router(plane)
    }

    #[tokio::test]
    async fn the_refmod_door_submits_the_stock_export_shape_and_answers_the_prompt_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = std::sync::Arc::new(super::super::results::FakeRefmodBridge::healthy());
        let app = refmod_plane(dir.path(), std::sync::Arc::clone(&bridge));
        let (status, body) = call(
            &app,
            post_request(
                "/v1/refmods",
                r#"{"name":"hero","description":"a recurring lead character","conceptType":"identity",
                    "picture1":"deas-inputs/hero-front.png","audio1":"deas-inputs/hero-voice.flac",
                    "--refmod":"char-a.safetensors,char-b.safetensors:0.7","audioVae":"h3_audio_vae.safetensors"}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["ok"].as_bool().expect("ok"));
        assert_eq!(
            body["refmodId"], "3f2a1b6c-0000-4000-8000-000000000000",
            "the backend promptId, never a Workbench job id: {body}"
        );
        assert_eq!(
            body["status"], "queued",
            "the placement fact, not a polled state word"
        );
        let sent = bridge.submitted.lock().expect("test lock").clone();
        assert_eq!(sent.len(), 1, "one export per door call");
        let export = &sent[0];
        assert_eq!(export["name"], "hero");
        assert_eq!(export["conceptType"], "identity");
        // The E16 aliases became Director media rows (lane order, per-lane slots), and
        // the folded --refmod rows were read down to the stock bare-name list.
        assert_eq!(
            export["media"],
            json!([
                {"type": "image", "file": "deas-inputs/hero-front.png", "slot": 0},
                {"type": "audio", "file": "deas-inputs/hero-voice.flac", "slot": 0}
            ]),
            "{export}"
        );
        assert_eq!(
            export["refmods"],
            json!(["char-a.safetensors", "char-b.safetensors"]),
            "names out of the folded rows"
        );
        assert_eq!(export["audioVae"], "h3_audio_vae.safetensors");
        assert!(
            export.get("vae").is_none(),
            "an absent lane is never invented"
        );
    }

    #[tokio::test]
    async fn the_refmod_door_walls_are_the_closed_stock_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        // LEG AF2-M19a (ruling E24): the placement law now resolves a RELATIVE reference
        // against the engine's input root, so this plane carries one. The walls under test
        // are the closed STOCK set — a missing root would answer `maintenanceActive` from
        // the placement law and hide the wall this test is about.
        let inputs = tempfile::tempdir().expect("input root");
        let mut plane = plane_with_app_data(dir.path());
        plane.refmods = std::sync::Arc::new(super::super::results::FakeRefmodBridge::healthy());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        let (status, body) = call(
            &app,
            post_request(
                "/v1/refmods",
                r#"{"conceptType":"vibe","picture1":"deas-inputs/a.png"}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(
            hint(&body).contains("generic|identity|style|motion|audio"),
            "the five stock words: {body}"
        );
        let long = "x".repeat(4001);
        let (status, body) = call(
            &app,
            post_request(
                "/v1/refmods",
                &format!(r#"{{"description":"{long}","picture1":"deas-inputs/a.png"}}"#),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(hint(&body).contains("4000"), "the stock cap rides: {body}");
        let nine: Vec<String> = (0..9)
            .map(|index| format!("saved-{index}.safetensors"))
            .collect();
        let (status, body) = call(
            &app,
            post_request(
                "/v1/refmods",
                &format!(r#"{{"--refmod":"{}"}}"#, nine.join(",")),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(hint(&body).contains("8"), "the stock eight: {body}");
        // Nothing to export: stock's own refusal, named at the door.
        let (status, body) = call(&app, post_request("/v1/refmods", "{}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(hint(&body).contains("at least one reference"), "{body}");
        // An unknown field is stock's refusal cause, not a silent drop.
        let (status, body) = call(
            &app,
            post_request(
                "/v1/refmods",
                r#"{"checkpoint":"anything.safetensors","picture1":"deas-inputs/a.png"}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(
            hint(&body).contains("unknown RefMod request field"),
            "{body}"
        );
        // The placement law is the same one the queue door runs: a name that is not a
        // placed input is refused naming the law. E24 re-pinned (LEG AF2-M19a): the name
        // first passes the placement door UNCHANGED (a relative name resolves inside the
        // input root, so it normalizes to identity and copies nothing) and the refusal is
        // the stock reference grammar naming the placement folders — the door did not fetch
        // it from anywhere, and the input plane stayed empty.
        let (status, body) = call(
            &app,
            post_request("/v1/refmods", r#"{"picture1":"elsewhere/a.png"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(hint(&body).contains("deas-inputs/"), "{body}");
        assert!(
            super::super::inputs::inventory(inputs.path())
                .expect("the injected root is readable")
                .rows
                .is_empty(),
            "E24: the placement law copied nothing for a name that is not on disk"
        );
    }

    #[tokio::test]
    async fn the_refmod_door_answers_maintenance_when_the_submit_refuses() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = refmod_plane(
            dir.path(),
            std::sync::Arc::new(super::super::results::FakeRefmodBridge::refusing(
                "no owned backend is running (state 'stopped')",
            )),
        );
        let (status, body) = call(
            &app,
            post_request("/v1/refmods", r#"{"picture1":"deas-inputs/a.png"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive", "no word is invented");
        assert!(
            hint(&body).contains("no owned backend is running"),
            "the stock string rides verbatim: {body}"
        );
    }

    #[tokio::test]
    async fn the_refmod_door_refuses_mid_cycle_with_the_existing_word() {
        let dir = tempfile::tempdir().expect("tempdir");
        let plane = plane_with_app_data(dir.path());
        // The same fact `/free` and the settings bridge read: a live cycle owns the card,
        // and a RefMod export posts straight into the backend's own queue.
        plane
            .cycle
            .claim(super::super::cycle_view::CyclePhase::Draining)
            .expect("claim");
        let app = router(plane);
        let (status, body) = call(
            &app,
            post_request("/v1/refmods", r#"{"picture1":"deas-inputs/a.png"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["reason"], "cycleInFlight");
    }

    // ── The RefMod posture and cancel doors (LEG M9e-close) ──────────────────────

    #[tokio::test]
    async fn the_refmod_status_door_answers_the_stock_view_verbatim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = refmod_plane(
            dir.path(),
            std::sync::Arc::new(super::super::results::FakeRefmodBridge::healthy()),
        );
        let (status, body) = call(
            &app,
            test_request("/v1/refmods/3f2a1b6c-0000-4000-8000-000000000000"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["ok"].as_bool().expect("ok"));
        // The stock status value rides verbatim: state word plus the stock result
        // descriptors; the plane expands no path and re-validates nothing.
        assert_eq!(body["refmod"]["state"], "done");
        assert_eq!(body["refmod"]["result"]["name"], "hero");
        assert_eq!(body["refmod"]["result"]["members"], 2);
    }

    #[tokio::test]
    async fn the_refmod_status_door_answers_jobunknown_naming_an_unknown_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = refmod_plane(
            dir.path(),
            std::sync::Arc::new(
                super::super::results::FakeRefmodBridge::healthy()
                    .status_refusing("Unknown RefMod export"),
            ),
        );
        let (status, body) = call(&app, test_request("/v1/refmods/no-such-export")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(
            body["reason"], "jobUnknown",
            "the existing word, never a new one"
        );
        assert!(
            hint(&body).contains("no-such-export") && hint(&body).contains("Unknown RefMod export"),
            "the hint names the id and rides the stock refusal string: {body}"
        );
    }

    #[tokio::test]
    async fn the_refmod_cancel_door_answers_the_stock_word_and_honours_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = refmod_plane(
            dir.path(),
            std::sync::Arc::new(super::super::results::FakeRefmodBridge::healthy()),
        );
        let (status, body) = call(
            &app,
            post_request(
                "/v1/refmods/3f2a1b6c-0000-4000-8000-000000000000/cancel",
                "",
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["cancelled"], "running",
            "the adapter's placement word, never a completion claim"
        );
        // A prompt already gone from the queue: the stock {"cancelled":"none"} shape
        // passes through honestly.
        let dir = tempfile::tempdir().expect("tempdir");
        let app = refmod_plane(
            dir.path(),
            std::sync::Arc::new(
                super::super::results::FakeRefmodBridge::healthy()
                    .cancelling_to(serde_json::json!({"cancelled": "none"})),
            ),
        );
        let (status, body) = call(&app, post_request("/v1/refmods/gone-export/cancel", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["cancelled"], "none");
        assert!(body["ok"].as_bool().expect("ok"));
    }

    #[tokio::test]
    async fn the_refmod_cancel_door_answers_jobunknown_naming_an_unknown_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = refmod_plane(
            dir.path(),
            std::sync::Arc::new(
                super::super::results::FakeRefmodBridge::healthy()
                    .cancel_refusing("Unknown RefMod export"),
            ),
        );
        let (status, body) =
            call(&app, post_request("/v1/refmods/no-such-export/cancel", "")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "jobUnknown");
        assert!(
            hint(&body).contains("no-such-export"),
            "the id is named: {body}"
        );
    }

    #[tokio::test]
    async fn the_refmod_closure_doors_pass_other_stock_refusals_through_verbatim() {
        // A refusal that is not the unknown-row shape keeps the honest
        // maintenanceActive word with the stock string verbatim in the hint.
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = std::sync::Arc::new(
            super::super::results::FakeRefmodBridge::healthy()
                .status_refusing("Invalid RefMod queue reply; media ownership remains active")
                .cancel_refusing("RefMod cancel rejected (HTTP 500)"),
        );
        let app = refmod_plane(dir.path(), std::sync::Arc::clone(&bridge));
        let (status, body) = call(&app, test_request("/v1/refmods/some-export")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        assert!(
            hint(&body).contains("Invalid RefMod queue reply"),
            "the stock string rides verbatim: {body}"
        );
        let (status, body) = call(&app, post_request("/v1/refmods/some-export/cancel", "")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        assert!(
            hint(&body).contains("RefMod cancel rejected (HTTP 500)"),
            "the stock string rides verbatim: {body}"
        );
    }

    /* ================= LEG MEDIA-1: caps, batch, existence, byte doors ================= */

    /// Writes an operator guard whose only role here is the caps block (cycle off).
    fn write_guard_caps(dir: &std::path::Path, caps_json: &str) {
        std::fs::write(
            dir.join(super::super::guard::FILE),
            format!(r#"{{"autoCycleVram": false, "caps": {caps_json}}}"#),
        )
        .expect("guard write");
    }

    /// A GET with extra headers (the Range law needs one).
    fn get_request_with(path: &str, headers: &[(&str, &str)]) -> Request {
        let mut builder = Request::builder()
            .method("GET")
            .uri(format!("http://127.0.0.1:8790{path}"))
            .header("host", "127.0.0.1:8790")
            .header("origin", "http://localhost:1420");
        for (key, value) in headers {
            builder = builder.header(*key, *value);
        }
        builder.body(Body::empty()).expect("valid test request")
    }

    /// The byte-door answer shape: status, headers, raw bytes (never JSON).
    async fn call_raw(
        app: &Router,
        request: Request,
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let response = app.clone().call(request).await.expect("router answers");
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024 * 1024)
            .await
            .expect("body readable");
        (status, headers, bytes.to_vec())
    }

    /// A media-shaped body of `len` bytes: PNG magic, then zeros.
    fn png_body(len: usize) -> Vec<u8> {
        let mut body = PNG_BYTES.to_vec();
        body.resize(len, 0);
        body
    }

    #[tokio::test]
    async fn guard_caps_restate_the_upload_wall_and_a_broken_caps_block_refuses_the_door() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        plane.uploads = std::sync::Arc::new(RecordingUploadBridge::accepting());
        let app = router(plane);
        write_guard_caps(dir.path(), r#"{"uploadSingleMiB": 1}"#);
        let (status, body) = call(
            &app,
            raw_post("/v1/uploads?kind=image", png_body(1024 * 1024 + 1)),
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
        assert_eq!(body["reason"], "capExceeded");
        assert!(
            hint(&body).contains("1 MiB"),
            "the override is named: {body}"
        );
        // An out-of-bounds cap number is a config refusal, and the upload door
        // refuses honestly rather than guessing past a guard it cannot trust.
        write_guard_caps(dir.path(), r#"{"jobUploadMiB": 9000}"#);
        let (status, body) =
            call(&app, raw_post("/v1/uploads?kind=image", PNG_BYTES.to_vec())).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["reason"], "guardUnconfigured");
        assert!(hint(&body).contains("caps.jobUploadMiB"), "{body}");
    }

    #[tokio::test]
    async fn the_batch_ledger_accumulates_labels_and_the_refusal_names_the_standing_total() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        let bridge = std::sync::Arc::new(RecordingUploadBridge::accepting());
        plane.uploads = bridge.clone();
        let app = router(plane);
        write_guard_caps(dir.path(), r#"{"uploadSingleMiB": 1, "jobUploadMiB": 1}"#);
        let first = call(
            &app,
            raw_post("/v1/uploads?kind=image&batch=run-1", png_body(600_000)),
        )
        .await;
        assert_eq!(first.0, StatusCode::OK, "{:?}", first.1);
        // The second charge breaches the 1 MiB batch budget: the refusal names
        // the label and the standing total the next upload would join.
        let (status, body) = call(
            &app,
            raw_post("/v1/uploads?kind=image&batch=run-1", png_body(600_000)),
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
        assert_eq!(body["reason"], "capExceeded");
        let hint_text = hint(&body);
        assert!(hint_text.contains("run-1"), "{body}");
        assert!(
            hint_text.contains("1200000"),
            "the standing total is named: {body}"
        );
        // A different label is its own budget; the refused charge never landed.
        let (status, body) = call(
            &app,
            raw_post("/v1/uploads?kind=image&batch=run-2", png_body(600_000)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        // A non-bare label is the grammar wall, before any byte arrives.
        for label in ["..", "a/b", "..."] {
            let (status, body) = call(
                &app,
                raw_post(
                    &format!("/v1/uploads?kind=image&batch={label}"),
                    PNG_BYTES.to_vec(),
                ),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{label}: {body}");
            assert_eq!(body["reason"], "bodyInvalid");
        }
        assert_eq!(
            bridge.placements().len(),
            2,
            "only the two accepted bodies reached the seam"
        );
    }

    #[tokio::test]
    async fn the_existence_law_refuses_absent_named_inputs_naming_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        // The e16 shorthand is FOLDED first, so the picture1 alias faces the law
        // as its placement name; the refusal is the 422 class naming the ghost.
        let (status, body) = call(
            &app,
            post_request(
                "/v1/queue",
                r#"{"family":"anima","mode":"t2i","positivePrompt":"x","outputPrefix":"agent/run","picture1":"deas-inputs/ghost.png"}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["reason"], "inputMissing");
        assert_eq!(body["error"], "INPUT_MISSING");
        let hint_text = hint(&body);
        assert!(hint_text.contains("deas-inputs/ghost.png"), "{body}");
        assert!(
            !dir.path().join(super::super::spool::FILE).exists(),
            "the refused enqueue writes no spool"
        );
    }

    #[tokio::test]
    async fn the_existence_law_accepts_placed_references_whose_size_the_upload_caps_would_refuse() {
        // ON-DISK REUSE COSTS NOTHING: the caps drop to 1 MiB, the placed file
        // stands at 2 MiB (the cheap stand-in for the heavy-fixture class), and
        // the queue door still waves it through — neither inputMissing nor
        // capExceeded may answer a reference that is already here.
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        std::fs::create_dir_all(inputs.path().join("deas-inputs")).expect("folder");
        let big = inputs.path().join("deas-inputs").join("big.png");
        let handle = std::fs::File::create(&big).expect("file");
        handle.set_len(2 * 1024 * 1024).expect("2 MiB");
        drop(handle);
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        write_guard_caps(dir.path(), r#"{"uploadSingleMiB": 1, "jobUploadMiB": 1}"#);
        let (status, body) = call(
            &app,
            post_request(
                "/v1/queue",
                r#"{"family":"anima","mode":"t2i","images":["deas-inputs/big.png"]}"#,
            ),
        )
        .await;
        assert_ne!(body["reason"], "inputMissing", "{body}");
        assert_ne!(body["reason"], "capExceeded", "{body}");
        let _ = status;
    }

    #[tokio::test]
    async fn named_inputs_without_a_derivable_environment_refuse_maintenance_not_a_guess() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path())); // input_root: None, app: None
        let (status, body) = call(
            &app,
            post_request(
                "/v1/queue",
                r#"{"family":"anima","mode":"t2i","images":["deas-inputs/x.png"]}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        assert!(hint(&body).contains("deas-inputs/x.png"), "{body}");
    }

    /* ---- THE E24 PLACEMENT CONTAINMENT LAW at the doors (LEG AF2-M19a, ruling E24) ---- */

    /// ARM 1 end to end at the queue door: a stranger absolute path — a real file, in a
    /// real folder, just not one the engine owns — is refused naming the two-folder law,
    /// and the recording seam (the plane's only byte writer) saw NOTHING. Before E24 this
    /// body read the file and handed it to the upload seam; the door no longer reaches
    /// past the engine's two folders, and there is no toggle.
    #[tokio::test]
    async fn a_stranger_path_reference_refuses_at_the_queue_door_and_places_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        let outputs = tempfile::tempdir().expect("output root");
        let stranger = tempfile::tempdir().expect("stranger root");
        let outside = stranger.path().join("notepad.png");
        std::fs::write(&outside, b"png bytes").expect("stranger file");
        let mut plane = plane_with_app_data(dir.path());
        let bridge = std::sync::Arc::new(RecordingUploadBridge::accepting());
        plane.uploads = bridge.clone();
        plane.input_root = Some(inputs.path().to_path_buf());
        plane.output_root = Some(outputs.path().to_path_buf());
        let app = router(plane);
        let (status, body) = call(
            &app,
            post_request(
                "/v1/queue",
                &json!({
                    "family": "anima",
                    "mode": "t2i",
                    "images": [outside.to_string_lossy()],
                })
                .to_string(),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "bodyInvalid", "{body}");
        let text = hint(&body);
        for word in [
            "input folder",
            "output folder",
            "POST /v1/uploads",
            "local agent",
        ] {
            assert!(text.contains(word), "the door names {word}: {text}");
        }
        assert!(
            text.contains(&outside.to_string_lossy().into_owned()),
            "the caller's own string rides verbatim: {text}"
        );
        assert!(
            !text.contains(&inputs.path().to_string_lossy().into_owned()),
            "no served root reaches the wire: {text}"
        );
        assert!(
            bridge.placements().is_empty(),
            "the seam never saw a byte for a refused reference"
        );
        assert!(
            std::fs::read_dir(inputs.path()).is_ok_and(|mut entries| entries.next().is_none()),
            "the input plane holds exactly what the fixture left it: nothing"
        );
    }

    /// ARMS 2 + 5 end to end: a reference that ALREADY sits in the input plane is
    /// rewritten to its placement name at the door and satisfies the existence law — no
    /// upload seam call at all, and no size cap even with the guard-file caps at 1 MiB
    /// (rulings E21 + E24: an on-disk file costs nothing; the caps are network caps).
    #[tokio::test]
    async fn an_input_root_path_reference_queues_without_an_upload_and_without_a_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        std::fs::create_dir_all(inputs.path().join("deas-inputs")).expect("folder");
        let big = inputs.path().join("deas-inputs").join("big.png");
        let handle = std::fs::File::create(&big).expect("file");
        handle.set_len(2 * 1024 * 1024).expect("2 MiB");
        drop(handle);
        let mut plane = plane_with_app_data(dir.path());
        let bridge = std::sync::Arc::new(RecordingUploadBridge::accepting());
        plane.uploads = bridge.clone();
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        write_guard_caps(dir.path(), r#"{"uploadSingleMiB": 1, "jobUploadMiB": 1}"#);
        let (status, body) = call(
            &app,
            post_request(
                "/v1/queue",
                &json!({
                    "family": "anima",
                    "mode": "t2i",
                    "images": [big.to_string_lossy()],
                })
                .to_string(),
            ),
        )
        .await;
        assert_ne!(body["reason"], "inputMissing", "{body}");
        assert_ne!(body["reason"], "capExceeded", "{body}");
        assert!(
            !hint(&body).contains("input folder"),
            "the door did not treat a reference inside the input plane as outside: {body}"
        );
        assert!(
            bridge.placements().is_empty(),
            "arm 2 copies nothing: the bytes never moved"
        );
        assert!(
            big.exists(),
            "the file the door read is the file that stays"
        );
        let _ = status;
    }

    /// ARM 3 end to end: a reference sitting in the OUTPUT plane is server-side COPIED
    /// into a fresh placement under the input plane — no upload seam, no cap — the copy
    /// leaves the original in place, and the copied placement name satisfies the existence
    /// law, which is the whole point of the arm (ruling E21 reuse, forced by E24 to the
    /// two folders the engine owns).
    #[tokio::test]
    async fn an_output_root_reference_copies_server_side_at_the_door_with_no_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        let outputs = tempfile::tempdir().expect("output root");
        std::fs::create_dir_all(outputs.path().join("starred")).expect("folder");
        let source = outputs.path().join("starred").join("hero.png");
        let handle = std::fs::File::create(&source).expect("file");
        handle.set_len(2 * 1024 * 1024).expect("2 MiB");
        drop(handle);
        let mut plane = plane_with_app_data(dir.path());
        let bridge = std::sync::Arc::new(RecordingUploadBridge::accepting());
        plane.uploads = bridge.clone();
        plane.input_root = Some(inputs.path().to_path_buf());
        plane.output_root = Some(outputs.path().to_path_buf());
        let app = router(plane);
        write_guard_caps(dir.path(), r#"{"uploadSingleMiB": 1, "jobUploadMiB": 1}"#);
        let (status, body) = call(
            &app,
            post_request(
                "/v1/queue",
                &json!({
                    "family": "anima",
                    "mode": "t2i",
                    "images": [source.to_string_lossy()],
                })
                .to_string(),
            ),
        )
        .await;
        assert_ne!(body["reason"], "inputMissing", "{body}");
        assert_ne!(body["reason"], "capExceeded", "{body}");
        assert!(
            bridge.placements().is_empty(),
            "the copy is a filesystem copy, not an upload: no byte crossed the seam"
        );
        assert!(
            source.exists(),
            "a COPY, not a move: the output plane keeps its file"
        );
        let placed: Vec<std::path::PathBuf> = std::fs::read_dir(inputs.path().join("deas-inputs"))
            .expect("the copy created the placement folder")
            .flatten()
            .map(|entry| entry.path())
            .collect();
        assert_eq!(
            placed.len(),
            1,
            "exactly one fresh placement landed: {placed:?}"
        );
        assert_eq!(
            std::fs::metadata(&placed[0]).expect("the copy").len(),
            2 * 1024 * 1024,
            "the copy carries the whole file: {placed:?}"
        );
        let _ = status;
    }

    #[tokio::test]
    async fn the_input_byte_door_serves_exact_bytes_ranges_and_the_containment_wall() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        std::fs::create_dir_all(inputs.path().join("deas-inputs")).expect("folder");
        std::fs::write(
            inputs.path().join("deas-inputs").join("hero.png"),
            b"0123456789",
        )
        .expect("hero");
        std::fs::create_dir_all(inputs.path().join("deas-inputs").join("project1"))
            .expect("nested folder");
        std::fs::write(
            inputs
                .path()
                .join("deas-inputs")
                .join("project1")
                .join("picture1.jpg"),
            b"nested jpeg",
        )
        .expect("nested");
        std::fs::write(inputs.path().join("deas-input-video.mp4"), b"video bytes").expect("video");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        let (status, headers, bytes) = call_raw(
            &app,
            test_request("/v1/files/inputs/deas-inputs%2Fhero.png"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{status}");
        assert_eq!(bytes, b"0123456789");
        assert_eq!(headers["accept-ranges"], "bytes");
        assert_eq!(headers["content-length"], "10");
        assert_eq!(headers["content-type"], "image/png");
        // A Range window answers the 206 with the exact slice and the range law.
        let (status, headers, bytes) = call_raw(
            &app,
            get_request_with(
                "/v1/files/inputs/deas-inputs%2Fhero.png",
                &[("range", "bytes=2-5")],
            ),
        )
        .await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(bytes, b"2345");
        assert_eq!(headers["content-range"], "bytes 2-5/10");
        // The root-level video grammar rides the same door unencoded.
        let (status, _, bytes) =
            call_raw(&app, test_request("/v1/files/inputs/deas-input-video.mp4")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, b"video bytes");
        // E22: a NESTED placement name rides the same percent-encoded door — the
        // containment law is already multi-segment, the subfolders ride the form.
        let (status, _, bytes) = call_raw(
            &app,
            test_request("/v1/files/inputs/deas-inputs%2Fproject1%2Fpicture1.jpg"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{status}");
        assert_eq!(bytes, b"nested jpeg");
        // The containment wall: traversal, absolute forms, and dot forms refuse;
        // a missing name is the honest 404.
        for path in [
            "/v1/files/inputs/..%2Fsecret.png",
            "/v1/files/inputs/%2E%2E",
            "/v1/files/inputs/C%3A%5Cwindows.png",
            "/v1/files/inputs/%2Froot.png",
        ] {
            let (status, body) = call(&app, test_request(path)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {body}");
            assert_eq!(body["reason"], "bodyInvalid");
        }
        let (status, body) = call(
            &app,
            test_request("/v1/files/inputs/deas-inputs%2Fgone.png"),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["reason"], "routeNotFound");
    }

    #[tokio::test]
    async fn the_output_door_lists_descriptor_words_and_serves_bytes_under_one_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outputs = tempfile::tempdir().expect("output root");
        std::fs::create_dir_all(outputs.path().join("starred")).expect("folder");
        std::fs::write(outputs.path().join("hero.png"), b"root hero").expect("hero");
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(
            outputs.path().join("starred").join("keep.mp4"),
            b"kept video",
        )
        .expect("keep");
        let mut plane = plane_with_app_data(dir.path());
        plane.output_root = Some(outputs.path().to_path_buf());
        let app = router(plane);
        let (status, body) = call(&app, test_request("/v1/outputs")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["count"], 2);
        assert_eq!(body["cap"], 500);
        // E22 recency law: the freshest row answers first (keep.mp4 was written
        // after hero.png), the older root row follows.
        let row = &body["outputs"][0];
        assert_eq!(row["subfolder"], "starred");
        assert_eq!(row["filename"], "keep.mp4");
        assert_eq!(row["type"], "video");
        assert_eq!(row["sizeBytes"], 10);
        assert!(row["mtimeMs"].is_number());
        assert_eq!(body["outputs"][1]["filename"], "hero.png");
        let wire = serde_json::to_string(&body).expect("wire");
        assert!(
            !wire.contains(&outputs.path().to_string_lossy().into_owned()),
            "the privacy law holds: {wire}"
        );
        // The byte door under the same root: the subfolder row rides the
        // catch-all grammar plainly (AF2-M29 superseded the two-segment row).
        let (status, _, bytes) =
            call_raw(&app, test_request("/v1/files/outputs/starred/keep.mp4")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, b"kept video");
        // M16 FIX-A (the MEDIA-1 flag): a listed root-level row (subfolder "")
        // is reachable by bare name — the listed name round-trips to its bytes
        // through the real router wall, Range law intact.
        let (status, headers, bytes) =
            call_raw(&app, test_request("/v1/files/outputs/hero.png")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, b"root hero");
        assert_eq!(headers["accept-ranges"], "bytes");
        // A nested name rides the shared handler percent-encoded, exactly as
        // the inputs door carries placement names.
        let (status, _, bytes) =
            call_raw(&app, test_request("/v1/files/outputs/starred%2Fkeep.mp4")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, b"kept video");
        // The containment wall on the one-segment form refuses the same words
        // the inputs door refuses.
        for path in [
            "/v1/files/outputs/..%2Fsecret.png",
            "/v1/files/outputs/%2E%2E",
            "/v1/files/outputs/C%3A%5Cwindows.png",
            "/v1/files/outputs/%2Froot.png",
        ] {
            let (status, body) = call(&app, test_request(path)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {body}");
            assert_eq!(body["reason"], "bodyInvalid");
        }
        // A missing root name is the honest 404; a deeper missing path now
        // lands on the catch-all row and answers the same honest word — the
        // missing component, not an unindexed grammar (AF2-M29).
        let (status, body) = call(&app, test_request("/v1/files/outputs/gone.png")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["reason"], "routeNotFound");
        let (status, body) = call(&app, test_request("/v1/files/outputs/a/b/c.png")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["reason"], "routeNotFound");
    }

    #[tokio::test]
    async fn the_output_door_serves_video_in_subfolders_by_plain_relative_path() {
        // AF2-M29, the live-proof shape: the first agent-queued H3 row's
        // descriptor {subfolder: "raw/video", filename: "DEAS-00001-audio.mp4"}
        // must round-trip to bytes through the API door.
        let dir = tempfile::tempdir().expect("tempdir");
        let outputs = tempfile::tempdir().expect("output root");
        std::fs::create_dir_all(outputs.path().join("raw").join("video")).expect("raw/video");
        std::fs::write(
            outputs
                .path()
                .join("raw")
                .join("video")
                .join("DEAS-00001-audio.mp4"),
            b"agent video bytes",
        )
        .expect("fixture");
        let mut plane = plane_with_app_data(dir.path());
        plane.output_root = Some(outputs.path().to_path_buf());
        let app = router(plane);
        let (status, headers, bytes) = call_raw(
            &app,
            test_request("/v1/files/outputs/raw/video/DEAS-00001-audio.mp4"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{status}");
        assert_eq!(headers["content-type"], "video/mp4");
        assert_eq!(headers["accept-ranges"], "bytes");
        assert_eq!(bytes, b"agent video bytes");
        // The percent form still lands on the same door (the M16 idiom rides).
        let (status, _, bytes) = call_raw(
            &app,
            test_request("/v1/files/outputs/raw%2Fvideo/DEAS-00001-audio.mp4"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, b"agent video bytes");
        // Eight segments is the grammar ceiling: a/b/c/d/e/f/g/leaf.mp4.
        std::fs::create_dir_all(
            outputs
                .path()
                .join("a")
                .join("b")
                .join("c")
                .join("d")
                .join("e")
                .join("f")
                .join("g"),
        )
        .expect("deep folders");
        std::fs::write(
            outputs
                .path()
                .join("a")
                .join("b")
                .join("c")
                .join("d")
                .join("e")
                .join("f")
                .join("g")
                .join("leaf.mp4"),
            b"deep bytes",
        )
        .expect("deep fixture");
        let (status, _, bytes) = call_raw(
            &app,
            test_request("/v1/files/outputs/a/b/c/d/e/f/g/leaf.mp4"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{status}");
        assert_eq!(bytes, b"deep bytes");
        // Nine segments is refused naming the grammar wall.
        let (status, body) = call(
            &app,
            test_request("/v1/files/outputs/a/b/c/d/e/f/g/h/leaf.mp4"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint(&body).contains("segments"), "names the wall: {body}");
    }

    #[tokio::test]
    async fn the_output_door_refuses_traversal_forms_naming_the_path_law() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outputs = tempfile::tempdir().expect("output root");
        std::fs::create_dir_all(outputs.path().join("raw").join("video")).expect("raw/video");
        std::fs::write(outputs.path().join("secret.png"), b"root secret").expect("secret");
        std::fs::write(
            outputs.path().join("raw").join("video").join("keep.mp4"),
            b"kept video",
        )
        .expect("keep");
        let mut plane = plane_with_app_data(dir.path());
        plane.output_root = Some(outputs.path().to_path_buf());
        let app = router(plane);
        // Dot-dot plain and percented, a dot segment, backslash forms, and the
        // absolute forms — every one refuses with the SAME containment-law words
        // the existing byte doors answer (files::contained's hint home).
        for path in [
            "/v1/files/outputs/raw/../secret.png",
            "/v1/files/outputs/raw/%2E%2E/secret.png",
            "/v1/files/outputs/%2E/raw/video/keep.mp4",
            "/v1/files/outputs/raw%5Cvideo%5Ckeep.mp4",
            "/v1/files/outputs/%2Fsecret.png",
            "/v1/files/outputs/C%3A%5Csecret.png",
        ] {
            let (status, body) = call(&app, test_request(path)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {body}");
            assert_eq!(body["reason"], "bodyInvalid", "{path}");
            assert!(
                hint(&body).contains("closed grammar allows")
                    || hint(&body).contains("filesystem path"),
                "{path} names the path law: {}",
                hint(&body)
            );
        }
    }

    #[tokio::test]
    async fn the_output_door_refuses_extensions_outside_the_closed_media_map() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outputs = tempfile::tempdir().expect("output root");
        std::fs::create_dir_all(outputs.path().join("raw")).expect("raw");
        std::fs::write(outputs.path().join("raw").join("notes.txt"), b"not media").expect("txt");
        std::fs::write(outputs.path().join("raw").join("keep.mp4"), b"kept video").expect("mp4");
        let mut plane = plane_with_app_data(dir.path());
        plane.output_root = Some(outputs.path().to_path_buf());
        let app = router(plane);
        let (status, body) = call(&app, test_request("/v1/files/outputs/raw/notes.txt")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "bodyInvalid");
        let hint_text = hint(&body);
        assert!(
            hint_text.contains("closed output media map"),
            "names the closed map: {hint_text}"
        );
        assert!(hint_text.contains("mp4"), "spells the map: {hint_text}");
        // An inside extension still answers its honest type beside the refusal.
        let (status, headers, bytes) =
            call_raw(&app, test_request("/v1/files/outputs/raw/keep.mp4")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], "video/mp4");
        assert_eq!(bytes, b"kept video");
    }

    #[tokio::test]
    async fn the_read_cap_bites_the_byte_doors_with_the_409_restate_naming_size_and_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        let outputs = tempfile::tempdir().expect("output root");
        let huge = inputs.path().join("huge.png");
        let handle = std::fs::File::create(&huge).expect("file");
        handle.set_len(2 * 1024 * 1024).expect("2 MiB");
        drop(handle);
        std::fs::create_dir_all(outputs.path().join("raw").join("video")).expect("raw/video");
        let huge_video = outputs.path().join("raw").join("video").join("huge.mp4");
        let video_handle = std::fs::File::create(&huge_video).expect("video file");
        video_handle.set_len(2 * 1024 * 1024).expect("2 MiB video");
        drop(video_handle);
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        plane.output_root = Some(outputs.path().to_path_buf());
        let app = router(plane);
        write_guard_caps(dir.path(), r#"{"downloadSingleMiB": 1}"#);
        let (status, body) = call(&app, test_request("/v1/files/inputs/huge.png")).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["reason"], "capExceeded");
        let hint_text = hint(&body);
        assert!(hint_text.contains("2097152"), "names the size: {body}");
        assert!(hint_text.contains("1 MiB"), "names the cap: {body}");
        // AF2-M29: the catch-all output door answers the SAME cap restate at
        // the SAME constant (caps.downloadSingleMiB) through the same wall.
        let (status, body) = call(&app, test_request("/v1/files/outputs/raw/video/huge.mp4")).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["reason"], "capExceeded");
        let hint_text = hint(&body);
        assert!(hint_text.contains("2097152"), "names the size: {body}");
        assert!(hint_text.contains("1 MiB"), "names the cap: {body}");
    }

    #[tokio::test]
    async fn the_promote_door_copies_server_side_and_answers_a_legal_placement_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outputs = tempfile::tempdir().expect("output root");
        let inputs = tempfile::tempdir().expect("input root");
        std::fs::create_dir_all(outputs.path().join("starred")).expect("folder");
        std::fs::write(outputs.path().join("starred").join("hero.png"), b"png hero").expect("hero");
        let mut plane = plane_with_app_data(dir.path());
        plane.output_root = Some(outputs.path().to_path_buf());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        let (status, body) = call(
            &app,
            post_request(
                "/v1/inputs/promote",
                r#"{"subfolder":"starred","name":"hero.png"}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let name = body["name"].as_str().expect("placement name");
        assert!(
            name.starts_with("deas-inputs/") && name.ends_with(".png"),
            "{name}"
        );
        let copied = inputs
            .path()
            .join(name.replace('/', std::path::MAIN_SEPARATOR_STR));
        assert_eq!(
            std::fs::read(&copied).expect("the copy landed"),
            b"png hero"
        );
        assert_eq!(body["bytes"], 8);
        // The answered name is a legal queue reference: the same queue that
        // answers inputMissing for an absent file now rides past the law.
        let (status, body) = call(
            &app,
            post_request(
                "/v1/queue",
                &format!(r#"{{"family":"anima","mode":"t2i","picture1":"{name}"}}"#),
            ),
        )
        .await;
        assert_ne!(body["reason"], "inputMissing", "{body}");
        let _ = status;
        // The promote source faces the same containment wall as the reads.
        let (status, body) = call(
            &app,
            post_request(
                "/v1/inputs/promote",
                r#"{"subfolder":"../secrets","name":"x.png"}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "bodyInvalid");
    }

    /* ---- BENCH DOOR tests (LEG M17b ruling E22 BENCH; WHOLE-ROOT SWEEP
    restate — owner ruling 2026-11-22: no body list, one call sweeps the whole
    root into one dated folder inside the .bench parent) ---- */

    /// The input bench door end to end, sweep law: an EMPTY body sweeps the
    /// whole input root — every file moves into ONE `.bench/<UTC stamp>` folder
    /// keeping its full source-relative name — the answer carries honest
    /// counts, `rowsTruncated` and the sweep note, the listing goes blind to
    /// the folder (dot law), the byte door reaches the benched bytes by
    /// explicit percent-form name (the OLD spelling 404s), and the OLD
    /// placement name now fails the existence law (422 `inputMissing`) while
    /// the benched NEW name is not placement-form and never even reaches that
    /// law (benched = hidden from new references; no unbench door).
    #[tokio::test]
    async fn the_inputs_bench_door_moves_declutters_answers_partials_and_hides_the_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        bench_place(
            inputs.path(),
            "deas-inputs/project1/pic.jpg",
            b"nested jpeg",
        );
        bench_place(inputs.path(), "deas-input-clip.mp4", b"video bytes");
        bench_place(inputs.path(), "loose.png", b"loose");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/inputs/bench", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["moved"], 3, "the sweep moves the WHOLE plane: {body}");
        assert_eq!(body["refused"], 0);
        assert_eq!(
            body["rowsTruncated"], false,
            "a small plane is never truncated"
        );
        let folder = body["folder"]
            .as_str()
            .expect("the stamped folder")
            .to_owned();
        assert_eq!(
            folder.chars().count(),
            23,
            "the closed shape .bench/YYYYMMDDTHHMMSSZ (7-char parent + 16-char stamp): {folder}"
        );
        assert!(
            folder.starts_with(".bench/") && folder.ends_with('Z'),
            "the stamp folder rides the .bench parent: {folder}"
        );
        assert!(hint_absent(&body), "a 200 answer carries no refusal hint");
        let note = body["note"].as_str().expect("the note");
        assert!(
            note.contains("takes NO body") && note.contains(".bench/YYYYMMDDTHHMMSSZ"),
            "the note carries the sweep law: {note}"
        );
        let rows = body["rows"].as_array().expect("rows");
        assert_eq!(rows.len(), 3);
        for old in [
            "deas-inputs/project1/pic.jpg",
            "deas-input-clip.mp4",
            "loose.png",
        ] {
            assert_eq!(
                rows.iter()
                    .find(|row| row["old"] == old)
                    .expect("the swept name answers a row")["new"],
                format!("{folder}/{old}"),
                "the full source-relative name rides under the stamp folder"
            );
            assert!(
                !inputs
                    .path()
                    .join(old.replace('/', std::path::MAIN_SEPARATOR_STR))
                    .exists(),
                "a MOVE, not a copy: {old} is gone from its old path"
            );
        }
        // Both listing law pins from the door side: the folder and its contents
        // are absent from GET /v1/inputs (the dot law M17a pre-positioned).
        let (status, listed) = call(&app, test_request("/v1/inputs")).await;
        assert_eq!(status, StatusCode::OK);
        let wire = serde_json::to_string(&listed).expect("wire");
        assert!(
            !wire.contains(".bench") && listed["count"] == 0,
            "the bench parent hides itself from the walk: {wire}"
        );
        // The byte door reaches the benched path by explicit percent-form name.
        // The input template is ONE segment, so the stamp folder's '/' rides the
        // percent form too (the M16 idiom, now two levels deep).
        let wire_folder = folder.replace('/', "%2F");
        let (status, _, bytes) = call_raw(
            &app,
            test_request(&format!(
                "/v1/files/inputs/{wire_folder}%2Fdeas-inputs%2Fproject1%2Fpic.jpg"
            )),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "byte doors reach benched paths: {status}"
        );
        assert_eq!(bytes, b"nested jpeg");
        // The existence law consequence: the queue naming the OLD placement name
        // answers 422 inputMissing — the old path is gone, and the word names it.
        let (status, body) = call(
            &app,
            post_request(
                "/v1/queue",
                r#"{"family":"anima","mode":"t2i","images":["deas-inputs/project1/pic.jpg"]}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["reason"], "inputMissing");
        assert!(
            hint(&body).contains("deas-inputs/project1/pic.jpg"),
            "the refusal names what the sweep moved away: {body}"
        );
        // The NEW name is not placement-form (leading dot): the existence law
        // never collects it, so it never reaches inputMissing — hidden from new
        // references by law, never a silent referenceable file.
        let (status, body) = call(
            &app,
            post_request(
                "/v1/queue",
                &format!(
                    r#"{{"family":"anima","mode":"t2i","images":["{folder}/deas-inputs/project1/pic.jpg"]}}"#
                ),
            ),
        )
        .await;
        assert_ne!(
            body["reason"], "inputMissing",
            "a benched name is not a placement reference: {body}"
        );
        let _ = status;
    }

    /// Places one file under `root`, creating the placement folders on the way.
    fn bench_place(root: &std::path::Path, rel: &str, bytes: &[u8]) {
        let target = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("folder");
        }
        std::fs::write(&target, bytes).expect("placed file");
    }

    /// A drain-ready i2i row naming exactly one input reference — the shape that
    /// puts a placement name into the spool exactly the way the existence law
    /// stat-validated it at the queue door (LEG AF2-M18c fixtures).
    fn i2i_row_naming(name: &str) -> String {
        format!(
            r#"{{"family":"anima","mode":"i2i","checkpoint":"anima/something.safetensors","positivePrompt":"a lighthouse at dusk","outputPrefix":"agent/run","diffusion":{{"textEncoder":"qwen3-0.6b.safetensors","clipType":"stable_diffusion","vae":"wan_2.1_vae.safetensors","family":"anima"}},"inputImage":"{name}","dials":{{"denoise":0.6}}}}"#
        )
    }

    /// True when the answer carries no `hint` member (200 bodies are clean).
    fn hint_absent(body: &Value) -> bool {
        body["hint"].is_null()
    }

    /// THE CLAIM GUARD (LEG AF2-M18c, the bench-vs-spool TOCTOU, sweep law): the
    /// existence law stats an input at QUEUE time, the drain reads it at DRAIN
    /// time, so a name a live spool row still references is refused per-row as
    /// `claimedByQueue` naming that row — while every OTHER file in the swept
    /// plane moves exactly as it did before the guard (the claim check and the
    /// renames ride one pass; a claim never half-sweeps a call).
    #[tokio::test]
    async fn a_queued_rows_input_is_claimed_and_stays_put_while_the_rest_move() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        bench_place(inputs.path(), "deas-inputs/proj/a.png", b"claimed");
        bench_place(inputs.path(), "deas-inputs/free.png", b"decluttered");
        bench_place(inputs.path(), "deas-inputs/other.png", b"decluttered too");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        let (status, answer) = call(
            &app,
            post_request("/v1/queue", &i2i_row_naming("deas-inputs/proj/a.png")),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "the row queues: {answer}");
        let row = answer["id"].as_str().expect("row id").to_owned();
        let (status, body) = call(&app, post_request("/v1/inputs/bench", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["moved"], 2, "the unclaimed files still move: {body}");
        assert_eq!(body["refused"], 1);
        let folder = body["folder"].as_str().expect("the stamped folder");
        let rows = body["rows"].as_array().expect("rows");
        let claimed = rows
            .iter()
            .find(|row| row["old"] == "deas-inputs/proj/a.png")
            .expect("the swept plane answers a row per file");
        assert_eq!(claimed["error"], "claimedByQueue", "{body}");
        assert_eq!(
            claimed["claimedBy"], row,
            "the refusal names the row that still needs the input"
        );
        assert_eq!(
            rows.iter()
                .find(|row| row["old"] == "deas-inputs/free.png")
                .expect("free row")["new"],
            format!("{folder}/deas-inputs/free.png"),
            "the rest of the sweep proceeds"
        );
        assert!(
            inputs
                .path()
                .join("deas-inputs")
                .join("proj")
                .join("a.png")
                .exists(),
            "the claimed input stayed exactly where the drain will look for it"
        );
        assert!(
            !inputs
                .path()
                .join(folder.replace('/', std::path::MAIN_SEPARATOR_STR))
                .join("deas-inputs")
                .join("proj")
                .join("a.png")
                .exists(),
            "and nothing was moved into the stamp folder behind the claim"
        );
        assert!(
            inputs
                .path()
                .join(folder.replace('/', std::path::MAIN_SEPARATOR_STR))
                .join("deas-inputs")
                .join("free.png")
                .exists(),
            "the unclaimed name really moved"
        );
        // The drain still finds its row's input: the row is intact and queued.
        let (_, listed) = call(&app, test_request("/v1/queue")).await;
        assert_eq!(listed["rows"][0]["status"], "queued", "{listed}");
        assert_eq!(listed["rows"][0]["id"], row);
    }

    /// A TERMINAL row claims nothing: the batch read its inputs (or died trying),
    /// so the sweep must still be able to tidy the plane after it (`done` is the
    /// terminal arm; `failed`/`cancelled` ride the same match) — the owner law:
    /// the sweep never tracks items that were already generated.
    #[tokio::test]
    async fn a_done_rows_input_is_not_claimed_and_the_bench_moves_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        bench_place(inputs.path(), "deas-inputs/proj/a.png", b"finished");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let spool = Arc::clone(&plane.spool);
        let app = router(plane);
        let (_, answer) = call(
            &app,
            post_request("/v1/queue", &i2i_row_naming("deas-inputs/proj/a.png")),
        )
        .await;
        let row = answer["id"].as_str().expect("row id").to_owned();
        assert!(
            spool
                .set_status(&row, spool::RowStatus::Queued, spool::RowStatus::Done)
                .expect("status write"),
            "the row was queued and flips to done"
        );
        let (status, body) = call(&app, post_request("/v1/inputs/bench", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["moved"], 1, "a terminal row does not claim: {body}");
        assert!(
            !inputs
                .path()
                .join("deas-inputs")
                .join("proj")
                .join("a.png")
                .exists(),
            "the finished input moved"
        );
    }

    /// Test 3 — the NESTED placement form matches (the E22 subfolder grammar
    /// lands names like `deas-inputs/project1/deep/pic.jpg`, and the claim set
    /// holds them exactly as the existence law spelled them), and a swept name
    /// that merely CONTAINS a claimed placement as a whole segment run is
    /// refused too: over-refusing one row is cheap, moving a file the drain
    /// needs is the race. Under the sweep law all three files are collected by
    /// the walk — the claims law, not the body grammar, is what keeps them put.
    #[tokio::test]
    async fn a_nested_placement_name_is_claimed_and_so_is_a_deeper_path_over_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        let nested = "deas-inputs/project1/deep/pic.jpg";
        bench_place(inputs.path(), nested, b"nested claimed");
        bench_place(inputs.path(), "deas-inputs/project1/pic.jpg", b"sibling");
        bench_place(
            inputs.path(),
            "archive/deas-inputs/project1/deep/pic.jpg",
            b"mirror",
        );
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        let (_, answer) = call(&app, post_request("/v1/queue", &i2i_row_naming(nested))).await;
        let row = answer["id"].as_str().expect("row id").to_owned();
        let (status, body) = call(&app, post_request("/v1/inputs/bench", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["moved"], 1, "only the sibling moved: {body}");
        assert_eq!(body["refused"], 2, "both claimed paths stayed put: {body}");
        let folder = body["folder"].as_str().expect("folder");
        let rows = body["rows"].as_array().expect("rows");
        let row_for = |name: &str| {
            rows.iter()
                .find(|candidate| candidate["old"] == name)
                .unwrap_or_else(|| panic!("the sweep answers a row for {name}: {rows:?}"))
                .clone()
        };
        let claimed = row_for(nested);
        assert_eq!(
            claimed["error"], "claimedByQueue",
            "the nested form: {body}"
        );
        assert_eq!(claimed["claimedBy"], row);
        assert_eq!(
            row_for("deas-inputs/project1/pic.jpg")["new"]
                .as_str()
                .expect("the sibling is not the claimed name"),
            format!("{folder}/deas-inputs/project1/pic.jpg")
        );
        let mirror = row_for("archive/deas-inputs/project1/deep/pic.jpg");
        assert_eq!(
            mirror["error"], "claimedByQueue",
            "a deeper name whose path contains the claimed placement as a segment run"
        );
        assert_eq!(mirror["claimedBy"], row);
        assert!(
            inputs
                .path()
                .join("deas-inputs")
                .join("project1")
                .join("deep")
                .join("pic.jpg")
                .exists(),
            "the nested claimed input stayed put"
        );
        assert!(
            inputs
                .path()
                .join("archive")
                .join("deas-inputs")
                .join("project1")
                .join("deep")
                .join("pic.jpg")
                .exists(),
            "and the containing path stayed put too"
        );
    }

    /// The output bench door, sweep law: a ZERO-KEY body sweeps the WHOLE
    /// output tree (the promote door's grammar is one way the file got there),
    /// every file lands under `.bench/<stamp>/<original relative path>`, the
    /// listing goes blind to it (dot law), and the catch-all byte door (AF2-
    /// M29) reaches the benched file ONLY at its `.bench/<stamp>/...` spelling
    /// — the old spelling 404s.
    #[tokio::test]
    async fn the_outputs_bench_door_moves_the_promote_grammar_and_the_byte_door_reaches_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outputs = tempfile::tempdir().expect("output root");
        bench_place(outputs.path(), "starred/keep.mp4", b"kept video");
        bench_place(outputs.path(), "root.png", b"root hero");
        let mut plane = plane_with_app_data(dir.path());
        plane.output_root = Some(outputs.path().to_path_buf());
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/outputs/bench", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["moved"], 2, "the sweep takes the whole tree: {body}");
        assert_eq!(body["refused"], 0);
        let folder = body["folder"]
            .as_str()
            .expect("the stamped folder")
            .to_owned();
        let rows = body["rows"].as_array().expect("rows");
        assert_eq!(rows.len(), 2);
        for name in ["starred/keep.mp4", "root.png"] {
            assert_eq!(
                rows.iter()
                    .find(|row| row["old"] == name)
                    .expect("a row per swept file")["new"],
                format!("{folder}/{name}"),
                "the original relative path rides under the stamp folder"
            );
        }
        // The listing skips the dot parent every level (M17a pre-positioned).
        let (status, listed) = call(&app, test_request("/v1/outputs")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed["count"], 0, "{listed}");
        let wire = serde_json::to_string(&listed).expect("wire");
        assert!(!wire.contains(".bench"), "{wire}");
        // The catch-all byte door reaches the benched file ONLY at the new
        // spelling: the percent form and the subfolder form of
        // `.bench/<stamp>/starred/keep.mp4` both serve; the OLD spelling 404s.
        let (status, _, bytes) = call_raw(
            &app,
            test_request(&format!("/v1/files/outputs/{folder}%2Fstarred/keep.mp4")),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "the subfolder form reaches the benched file: {status}"
        );
        assert_eq!(bytes, b"kept video");
        let (status, _, bytes) = call_raw(
            &app,
            test_request(&format!("/v1/files/outputs/{folder}%2Fstarred%2Fkeep.mp4")),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, b"kept video");
        let (status, _) = call(&app, test_request("/v1/files/outputs/starred/keep.mp4")).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "the old spelling is gone: the bytes live under .bench/<stamp>/ only"
        );
    }

    /// M18d pin (LEG AF2-M19b, the spool-corrupt arm of the claim guard, sweep
    /// law): an unreadable spool means the sweep door cannot see which live rows
    /// still claim their inputs, so it refuses the WHOLE call —
    /// `maintenanceActive` naming the unreadable spool (the same word
    /// `GET /v1/queue` answers), and nothing moves.
    #[tokio::test]
    async fn an_unreadable_spool_refuses_the_whole_inputs_bench_by_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        bench_place(inputs.path(), "deas-inputs/keep.png", b"stays put");
        std::fs::write(dir.path().join(spool::FILE), b"{ broken spool !!")
            .expect("corrupt spool staged");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/inputs/bench", "")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        let problem = hint(&body);
        assert!(
            problem.contains("spool is unreadable"),
            "the refusal names the unreadable spool: {problem}"
        );
        assert!(
            inputs.path().join("deas-inputs").join("keep.png").exists(),
            "a door that cannot check its claims moves nothing"
        );
    }

    /// Bench-leg P1 (the live-observed empty-folder flaw, door level, sweep
    /// law): a sweep whose every swept file is claimed answers an honest 200
    /// partial (moved:0, refused:1) AND leaves NO `.bench` entry on disk. The
    /// stamp folder is minted lazily at the first real move; the answered
    /// `folder` word is the name a move would have used, not a promise that it
    /// exists. (The outputs half of the old pick-list version of this test died
    /// with the body grammar: an outputs sweep with an empty tree answers an
    /// EMPTY row set — the audited output claim set is empty — and the same
    /// lazy-folder law for both doors is pinned at the code level by
    /// `files::a_fully_refused_bench_call_leaves_no_folder_on_disk`.)
    #[tokio::test]
    async fn an_all_refused_bench_call_leaves_no_folder_on_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        bench_place(inputs.path(), "deas-inputs/here.png", b"here");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        let (status, answer) = call(
            &app,
            post_request("/v1/queue", &i2i_row_naming("deas-inputs/here.png")),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "the row claims the only file: {answer}"
        );
        let (status, body) = call(&app, post_request("/v1/inputs/bench", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["moved"], 0, "{body}");
        assert_eq!(
            body["refused"], 1,
            "the claimed file is the whole sweep: {body}"
        );
        assert_eq!(body["rows"][0]["error"], "claimedByQueue", "{body}");
        assert!(
            std::fs::read_dir(inputs.path())
                .expect("root readable")
                .flatten()
                .all(|entry| entry.file_name() != ".bench"),
            "an all-refused sweep minted the .bench parent (the live-observed empty-folder flaw)"
        );
    }

    /// Bench-leg P1 (same-second reuse law, door level, sweep law): two sweep
    /// calls land in the SAME stamp folder whenever the wall-clock second does
    /// not roll over between them — never an error, never a minted suffix — and
    /// the second call's sweep finds only the files the first call left behind
    /// (the .bench parent and everything inside it are never re-swept). Every
    /// file rides exactly one folder; the .bench parent is minted once.
    #[tokio::test]
    async fn two_bench_calls_inside_one_stamp_second_share_the_same_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        bench_place(inputs.path(), "deas-inputs/a.png", b"a");
        bench_place(inputs.path(), "deas-inputs/b.png", b"b");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        let before = spool::now_ms();
        let (_, first) = call(&app, post_request("/v1/inputs/bench", "")).await;
        // A fresh file lands between the calls: the second sweep's sweep set is
        // exactly the leftovers the first call did not move (which, by the
        // dot law, never include the first call's bench folder).
        bench_place(inputs.path(), "deas-inputs/c.png", b"c");
        let (_, second) = call(&app, post_request("/v1/inputs/bench", "")).await;
        let after = spool::now_ms();
        let stamp = |at: u64| super::super::files::bench_folder_name(at);
        let first_folder = first["folder"].as_str().expect("first folder").to_owned();
        let second_folder = second["folder"].as_str().expect("second folder").to_owned();
        if stamp(before) == stamp(after) {
            assert_eq!(
                first_folder, second_folder,
                "one wall-clock second spanned both calls — they must share ONE folder: {first} / {second}"
            );
        }
        assert_eq!(first["moved"], 2, "the first sweep took a and b: {first}");
        assert_eq!(second["moved"], 1, "the second sweep took only c: {second}");
        for (name, folder) in [
            ("a.png", &first_folder),
            ("b.png", &first_folder),
            ("c.png", &second_folder),
        ] {
            assert!(
                inputs
                    .path()
                    .join(folder.replace('/', std::path::MAIN_SEPARATOR_STR))
                    .join("deas-inputs")
                    .join(name)
                    .exists(),
                "{name} rides its call's folder {folder}"
            );
        }
        let mut stamp_folders: Vec<String> = std::fs::read_dir(inputs.path().join(".bench"))
            .expect("the .bench parent readable")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        stamp_folders.sort();
        let mut expected: Vec<String> = vec![
            first_folder.split('/').nth(1).expect("stamp").to_owned(),
            second_folder.split('/').nth(1).expect("stamp").to_owned(),
        ];
        expected.sort();
        expected.dedup();
        assert_eq!(
            stamp_folders, expected,
            "no collision suffix was minted — the stamp set inside .bench is exactly the answered folders"
        );
    }

    /// Bench-leg P2 (valid=movable, the draining arm, sweep law): a `draining`
    /// row claims its input exactly like a queued one — the batch reads each row
    /// at its own turn — so inside an otherwise fully swept plane the claimed
    /// file stays put (`moved:N refused:1 claimedByQueue`) where the batch will
    /// read it. (The `queued` arm and the terminal `done` arm keep their
    /// sibling tests; `wedged` rides the same non-terminal match.)
    #[tokio::test]
    async fn a_draining_row_still_claims_its_input_to_the_bench() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        bench_place(inputs.path(), "deas-inputs/proj/a.png", b"mid-batch");
        bench_place(inputs.path(), "deas-inputs/free-1.png", b"goes");
        bench_place(inputs.path(), "deas-inputs/free-2.png", b"goes too");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let spool = Arc::clone(&plane.spool);
        let app = router(plane);
        let (_, answer) = call(
            &app,
            post_request("/v1/queue", &i2i_row_naming("deas-inputs/proj/a.png")),
        )
        .await;
        let row = answer["id"].as_str().expect("row id").to_owned();
        assert!(
            spool
                .set_status(&row, spool::RowStatus::Queued, spool::RowStatus::Draining)
                .expect("status write"),
            "the row was queued and flips to draining"
        );
        let (status, body) = call(&app, post_request("/v1/inputs/bench", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["moved"], 2, "the plane swept around the claim: {body}");
        assert_eq!(body["refused"], 1, "a draining row claims: {body}");
        let rows = body["rows"].as_array().expect("rows");
        let claimed = rows
            .iter()
            .find(|row| row["old"] == "deas-inputs/proj/a.png")
            .expect("the claimed file answers a row");
        assert_eq!(claimed["error"], "claimedByQueue", "{body}");
        assert_eq!(claimed["claimedBy"], row, "{body}");
        assert!(
            inputs
                .path()
                .join("deas-inputs")
                .join("proj")
                .join("a.png")
                .exists(),
            "the mid-batch input stayed where the batch will read it"
        );
    }

    /// Bench-leg P2 (the outputs mirror wiring is REAL, not decorative, sweep
    /// law): the outputs door reads the live rows under the spool write window
    /// before it renames, so an unreadable spool refuses the WHOLE call with the
    /// same honest word the inputs door answers, and nothing moves.
    #[tokio::test]
    async fn an_unreadable_spool_refuses_the_whole_outputs_bench_by_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outputs = tempfile::tempdir().expect("output root");
        bench_place(outputs.path(), "starred/keep.mp4", b"stays put");
        std::fs::write(dir.path().join(spool::FILE), b"{ broken spool !!")
            .expect("corrupt spool staged");
        let mut plane = plane_with_app_data(dir.path());
        plane.output_root = Some(outputs.path().to_path_buf());
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/outputs/bench", "")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        let problem = hint(&body);
        assert!(
            problem.contains("spool is unreadable"),
            "the refusal names the unreadable spool: {problem}"
        );
        assert!(
            outputs.path().join("starred").join("keep.mp4").exists(),
            "a door that cannot check its claims moves nothing"
        );
        assert!(
            std::fs::read_dir(outputs.path())
                .expect("root readable")
                .flatten()
                .all(|entry| entry.file_name() != ".bench"),
            "the refused call left no folder behind"
        );
    }

    /// The walk law at the door: a root the sweep cannot open refuses the WHOLE
    /// call as `maintenanceActive` naming the root — a door that cannot see the
    /// plane will not half-sweep it — and nothing moves.
    #[tokio::test]
    async fn an_unwalkable_root_refuses_the_whole_inputs_bench_by_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        // The served "root" is a regular file: the walk cannot open it at all.
        let not_a_root = inputs.path().join("not-a-directory");
        std::fs::write(&not_a_root, b"a file where the walk expects a root").expect("file");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(not_a_root.clone());
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/inputs/bench", "")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        let problem = hint(&body);
        assert!(
            problem.contains("the input root cannot be walked")
                && problem.contains("not-a-directory"),
            "the refusal names the unwalkable root: {problem}"
        );
        assert_eq!(
            std::fs::read(&not_a_root).expect("the file is untouched"),
            b"a file where the walk expects a root",
            "a refused sweep touched nothing"
        );
    }

    /// Bench-leg P2 (the mirror audit pinned at the door, sweep law): chain and
    /// continuity references are CLIP IDS the drain resolves against the stock
    /// session ledger, not output-root files — a queued join row with a `chain`
    /// arm claims NOTHING to the outputs door, and the sweep moves the file the
    /// clip's old export used to name. Benching output files never breaks a
    /// story chain.
    #[tokio::test]
    async fn a_queued_join_row_with_clip_ids_does_not_claim_output_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outputs = tempfile::tempdir().expect("output root");
        bench_place(outputs.path(), "c-0-export.mp4", b"elder export");
        let mut plane = plane_with_app_data(dir.path());
        plane.output_root = Some(outputs.path().to_path_buf());
        let app = router(plane);
        let (status, answer) = call(
            &app,
            post_request(
                "/v1/videos/join",
                r#"{"kind":"segments","session":"story-1","chain":["c-0","c-1"]}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "the join row queues: {answer}");
        let (status, body) = call(&app, post_request("/v1/outputs/bench", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["moved"], 1,
            "the queued chain row claims clip ids, never output paths: {body}"
        );
        assert_eq!(body["rows"][0]["error"], Value::Null, "{body}");
    }

    /// The bench walls in order (sweep law): auth first (the transport's wall
    /// stands before any body parse), then the ZERO-KEY body law — the OLD
    /// pick-list bodies (`{"names":[...]}`, `{"items":[...]}`) are now the
    /// refused bodies, named by the sweep law — then the root law, and every
    /// refusal touches NO disk: nothing moved, no folder minted.
    #[tokio::test]
    async fn the_bench_walls_stand_auth_first_and_never_move_on_a_refused_body() {
        // Auth-first: the standing key wall answers before the handler parses
        // (the origin is allowlisted so the KEY wall is the wall under test).
        let keyed = router(state(&["http://localhost:1420"], Some("s3cret")));
        let (status, body) = call(&keyed, post_request("/v1/inputs/bench", "")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body["reason"], "keyMissing");
        let (status, body) = call(&keyed, post_request("/v1/outputs/bench", "")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body["reason"], "keyMissing");
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        bench_place(inputs.path(), "deas-inputs/here.png", b"here");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        // The zero-key law, both doors: ANY key refuses naming the sweep law —
        // the pick-list bodies the doors used to serve are now the refused
        // bodies, and the hint tells the stale client what to drop.
        for (path, body_text, key) in [
            (
                "/v1/inputs/bench",
                r#"{"names":["deas-inputs/here.png"]}"#,
                "names",
            ),
            (
                "/v1/inputs/bench",
                r#"{"items":[{"name":"x.png"}]}"#,
                "items",
            ),
            ("/v1/inputs/bench", r#"{"folder":"mine"}"#, "folder"),
            (
                "/v1/outputs/bench",
                r#"{"items":[{"name":"here.png"}]}"#,
                "items",
            ),
            ("/v1/outputs/bench", r#"{"names":["here.png"]}"#, "names"),
        ] {
            let (status, body) = call(&app, post_request(path, body_text)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body_text}: {body}");
            assert_eq!(body["reason"], "bodyInvalid", "{body_text}");
            let problem = hint(&body);
            assert!(
                problem.contains("the bench sweep takes no body")
                    && problem.contains(&format!("drop the field '{key}'")),
                "the refusal names the key and the sweep law: {problem}"
            );
        }
        // Malformed shapes and over-cap bodies are the same honest word; the
        // cap only walls out hostile streams now — sweeps themselves are
        // unbounded (the old 100-entry body cap no longer exists).
        let huge = format!(r#"{{"junk":"{}"}}"#, "x".repeat(65_536));
        for body_text in [r#"{"names"#, r#"[]"#, r#""bench""#, &huge] {
            let (status, body) = call(&app, post_request("/v1/inputs/bench", body_text)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body_text}: {body}");
            assert_eq!(body["reason"], "bodyInvalid", "{body_text}");
        }
        // The grammar wall stands BEFORE the root law: a list body on a plane
        // with no derivable root still answers its grammar word, not a root one.
        let bare = router(plane_with_app_data(dir.path()));
        let (status, body) = call(
            &bare,
            post_request("/v1/inputs/bench", r#"{"names":["x.png"]}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["reason"], "bodyInvalid");
        // Nothing moved, no folder minted: every refusal above was hoisted
        // before a walk or a rename.
        assert!(inputs.path().join("deas-inputs").join("here.png").exists());
        assert!(
            std::fs::read_dir(inputs.path())
                .expect("root readable")
                .flatten()
                .all(|entry| entry.file_name() != ".bench"),
            "a refused sweep body never even mints the .bench parent"
        );
        // The root law: no derivable environment answers maintenanceActive, not
        // a guessed folder (the door idiom, both doors).
        let (status, body) = call(&bare, post_request("/v1/inputs/bench", "")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
        let (status, body) = call(&bare, post_request("/v1/outputs/bench", "")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["reason"], "maintenanceActive");
    }

    /// The SWEEP dot law at the door: the legacy `.bench-<stamp>` folders from
    /// the pre-sweep grammar (and any dot state) stay EXACTLY where they are —
    /// the walk never descends into a dot entry, so a sweep moves only the
    /// non-dot plane and the legacy group remains findable by its old name.
    #[tokio::test]
    async fn a_legacy_bench_dot_folder_is_never_re_swept() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        bench_place(
            inputs.path(),
            ".bench-20260101T000000Z/old.png",
            b"elder bench",
        );
        bench_place(inputs.path(), "deas-inputs/now.png", b"live plane");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        let (status, body) = call(&app, post_request("/v1/inputs/bench", "")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["moved"], 1, "only the non-dot file swept: {body}");
        let folder = body["folder"].as_str().expect("the stamped folder");
        assert_eq!(body["rows"][0]["old"], "deas-inputs/now.png");
        assert_eq!(
            body["rows"][0]["new"],
            format!("{folder}/deas-inputs/now.png")
        );
        assert!(
            inputs
                .path()
                .join(".bench-20260101T000000Z")
                .join("old.png")
                .exists(),
            "the legacy dot folder and its file stayed exactly where they were"
        );
        // The byte door still reaches the legacy path by its OLD spelling.
        let (status, _, bytes) = call_raw(
            &app,
            test_request("/v1/files/inputs/.bench-20260101T000000Z%2Fold.png"),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "the legacy bytes stay served: {status}"
        );
        assert_eq!(bytes, b"elder bench");
    }

    /// The parent law at the door: after a sweep the disk shape is
    /// `<root>/.bench/<stamp>/<rel>` — a SECOND sweep creates a SECOND stamp
    /// folder INSIDE THE SAME `.bench` parent (never a second parent, never a
    /// sibling beside it). If the wall-clock second never rolls over between
    /// the calls the two stamps legitimately coincide (the reuse law), so the
    /// test asserts the parent share in that case, matching the stamp-test
    /// idiom for second-rolling.
    #[tokio::test]
    async fn the_bench_parent_nests_the_stamp_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = tempfile::tempdir().expect("input root");
        bench_place(inputs.path(), "deas-inputs/first.png", b"first");
        let mut plane = plane_with_app_data(dir.path());
        plane.input_root = Some(inputs.path().to_path_buf());
        let app = router(plane);
        let (status, first) = call(&app, post_request("/v1/inputs/bench", "")).await;
        assert_eq!(status, StatusCode::OK, "{first}");
        assert_eq!(first["moved"], 1, "{first}");
        let first_folder = first["folder"].as_str().expect("first folder").to_owned();
        assert_eq!(
            std::fs::read(
                inputs
                    .path()
                    .join(first_folder.replace('/', std::path::MAIN_SEPARATOR_STR))
                    .join("deas-inputs")
                    .join("first.png")
            )
            .expect("the disk shape is <root>/.bench/<stamp>/<rel>"),
            b"first",
            "the benched bytes ride the nested path"
        );
        // The next second gets a fresh file and a fresh call; whether the stamp
        // rolls over is the clock's, not the door's.
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        bench_place(inputs.path(), "deas-inputs/second.png", b"second");
        let (status, second) = call(&app, post_request("/v1/inputs/bench", "")).await;
        assert_eq!(status, StatusCode::OK, "{second}");
        assert_eq!(second["moved"], 1, "{second}");
        let second_folder = second["folder"].as_str().expect("second folder").to_owned();
        assert!(
            first_folder.starts_with(".bench/") && second_folder.starts_with(".bench/"),
            "both stamps nest in the SAME .bench parent: {first_folder} / {second_folder}"
        );
        let parents: Vec<String> = std::fs::read_dir(inputs.path())
            .expect("root readable")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".bench"))
            .collect();
        assert_eq!(
            parents,
            vec![".bench".to_owned()],
            "exactly ONE .bench parent on disk — legacy .bench-<stamp> siblings are never minted again"
        );
        let mut stamp_folders: Vec<String> = std::fs::read_dir(inputs.path().join(".bench"))
            .expect("the parent readable")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        stamp_folders.sort();
        stamp_folders.dedup();
        if first_folder == second_folder {
            assert_eq!(
                stamp_folders,
                vec![first_folder.split('/').nth(1).expect("stamp")],
                "one second, one stamp folder (the reuse law)"
            );
        } else {
            assert_eq!(
                stamp_folders.len(),
                2,
                "two seconds, TWO stamp folders inside the ONE .bench parent: {stamp_folders:?}"
            );
        }
    }

    #[tokio::test]
    async fn the_preview_door_grows_the_config_leg_of_the_min_law() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut plane = plane_with_app_data(dir.path());
        // A fake preview above the smallest legal configured cap (1 MiB): the
        // stock ceilings stay the outer wall, the config leg bites only when it
        // is the smaller number, and the answer is the 409 capExceeded restate.
        plane.results =
            std::sync::Arc::new(FakeResultsBridge::healthy().with_output_bytes(1024 * 1024 + 1));
        let app = router(plane);
        // The OK step answers a ~1.4 MiB base64 envelope — past the JSON `call`
        // helper's 64 KiB read, so the raw helper carries it.
        let (status, _, _) = call_raw(&app, test_request("/v1/outputs/row/0")).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "under the 500 MiB default: {status}"
        );
        write_guard_caps(dir.path(), r#"{"downloadSingleMiB": 1}"#);
        let (status, body) = call(&app, test_request("/v1/outputs/row/0")).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["reason"], "capExceeded");
        assert!(hint(&body).contains("1 MiB"), "{body}");
    }

    #[tokio::test]
    async fn the_story_door_refuses_its_closed_grammar_naming_every_offender() {
        // AF2-M32 door law: unknown fields at body and step level are refused
        // BY NAME, the sourceId must be the 64-lowercase-hex the prepare door
        // answers, the step seconds range is integer 1..=15, steps must hold
        // 1..=16 objects, and nothing queues on the way out. Every refusal is
        // bodyInvalid; all fire BEFORE any resolve, so a bare plane suffices.
        let cases: [(&str, &str); 6] = [
            (
                r#"{"session":"s1","sourceId":"ab12","steps":[],"base":{}}"#,
                "64-lowercase-hex",
            ),
            (
                r#"{"session":"_imports","sourceId":"ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34","steps":[{"seconds":3,"action":"a"}],"base":{}}"#,
                "_imports",
            ),
            (
                r#"{"session":"s1","sourceId":"ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34","steps":[{"seconds":3,"action":"a","seed":7}],"base":{}}"#,
                "'seed'",
            ),
            (
                r#"{"session":"s1","sourceId":"ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34","steps":[{"seconds":16,"action":"a"}],"base":{}}"#,
                "1..=15",
            ),
            (
                r#"{"session":"s1","sourceId":"ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34","steps":[],"base":{}}"#,
                "1..=16 step objects",
            ),
            (
                r#"{"session":"s1","sourceId":"ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34","steps":[{"seconds":3,"action":"a"}],"base":{},"storyId":"mine"}"#,
                "'storyId'",
            ),
        ];
        for (index, (body_text, word)) in cases.into_iter().enumerate() {
            let dir = tempfile::tempdir().expect("tempdir");
            let app = router(plane_with_app_data(dir.path()));
            let (status, body) = call(&app, post_request("/v1/videos/story", body_text)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "case {index}: {body}");
            assert_eq!(body["reason"], "bodyInvalid", "case {index}: {body}");
            assert!(
                hint(&body).contains(word),
                "case {index} must name '{word}': {}",
                hint(&body)
            );
        }
    }

    #[tokio::test]
    async fn the_story_door_refuses_a_base_that_carries_its_own_continuity() {
        // The door builds each step's continuity; a base that smuggles one is
        // refused naming the door's role (no second continuity law anywhere).
        let dir = tempfile::tempdir().expect("tempdir");
        let app = router(plane_with_app_data(dir.path()));
        let (status, body) = call(
            &app,
            post_request(
                "/v1/videos/story",
                r#"{"session":"s1","sourceId":"ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34","steps":[{"seconds":3,"action":"a"}],"base":{"mode":"ref2va","family":"minimax-h3","h3":{"continuity":{"session":"sneaky"}}}}"#,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(hint(&body).contains("continuity"), "{body}");
    }

    /// The plane as it actually runs on a real machine: `mod.rs` binds
    /// `127.0.0.1:<port>` and serves this router, so here the walls, the doors and the
    /// taxonomy are proven over a REAL loopback TCP socket instead of only through
    /// `Service::call`. A browser-shaped request with no allowlisted Origin is refused
    /// before any door runs; the same door answers once the Origin is allowlisted; and a
    /// foreign `Host` is refused at the socket even though the connection itself came
    /// from loopback (the DNS-rebinding wall is the header, not the route).
    #[tokio::test]
    async fn a_served_plane_answers_over_a_loopback_socket_and_its_walls_hold_there() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let dir = tempfile::tempdir().expect("tempdir");
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("the same loopback bind mod.rs performs");
        let addr = listener.local_addr().expect("the bound address");
        assert_eq!(
            addr.ip(),
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            "the plane's bind form is loopback, never a wildcard"
        );
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router(plane_with_app_data(dir.path()))).await;
        });
        let client = reqwest::Client::new();

        // Wall 1 on the wire: no Origin and no standing key configured => refused before
        // any door runs, in the closed taxonomy shape.
        let anonymous = client
            .get(format!("http://{addr}/v1/health"))
            .send()
            .await
            .expect("served");
        assert_eq!(anonymous.status(), StatusCode::FORBIDDEN);
        let anonymous: Value = anonymous.json().await.expect("json answer");
        assert_eq!(anonymous["reason"], "originDenied", "{anonymous}");

        // The same socket, the same door, an allowlisted Origin: the plane answers.
        let allowed = client
            .get(format!("http://{addr}/v1/health"))
            .header("origin", "http://localhost:1420")
            .send()
            .await
            .expect("served")
            .error_for_status()
            .expect("200");
        let health: Value = allowed.json().await.expect("json answer");
        assert_eq!(health["ok"], true, "{health}");
        assert_eq!(health["plane"], "deas-agent-api");

        // Wall 2 on the wire: a hand-written request from the same loopback connection
        // naming a foreign Host never reaches a door (`Connection: close` lets axum end
        // the keep-alive so the read terminates).
        let mut stream = tokio::net::TcpStream::connect(addr)
            .await
            .expect("connectable");
        stream
            .write_all(
                b"GET /v1/health HTTP/1.1\r\nHost: deas.example.com\r\nOrigin: http://localhost:1420\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("request written");
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.expect("answer readable");
        let raw = String::from_utf8_lossy(&raw).into_owned();
        assert!(raw.contains(" 400 "), "foreign Host is refused: {raw}");
        assert!(raw.contains("hostDenied"), "the named wall answers: {raw}");
        assert!(raw.contains("loopback form"), "the remedy is named: {raw}");

        server.abort();
    }
}
