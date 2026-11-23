//! The scan bridge (API-DESIGN §4 "start/poll the MODEL scan", §SR14.3): the
//! `/v1/scan` pair over the stock library-scan engine, so `libraryScanRequired` can
//! START its own remedy instead of only naming it.
//!
//! Stock truths this seam keeps:
//!
//! * `native_model_scan_start` and the managed `ModelScanEngine` are the only scan
//!   home — the plane never walks a model folder and never restates the command's
//!   checks (download-running refusal, CivitAI provider lookup, credential wall).
//! * One scan at a time is the stock engine's own `reserve` law; the door checks it
//!   too, so a second `POST /v1/scan` cannot even race a silent restart.
//! * The status shape is the stock `ModelScanStatus` serialized verbatim (state, root,
//!   current file, counters). v0.3.14 has no `interrupted` scan state: at boot the
//!   engine honestly reports `idle`. The interrupted-at-boot posture named in
//!   STOCK-REFERENCE §15.2/§15.3 belongs to the *download* engine — which this API
//!   no longer bridges at all (ruling E25, LEG AF2-M19b: the `/v1/downloads` set is
//!   deleted; models are CALL + SCAN only); this bridge surfaces that engine only
//!   through the stock start refusal it triggers ("Wait for downloads to finish
//!   before scanning files").
//!
//! `ScanBridge` is the test seam: production runs the stock command through the Tauri
//! managed states; tests fake the engine without a backend or a scan.
//!
//! LEG M15 scan-pairing ruling (design 12.1 addendum, API-DESIGN.md:437): no
//! `/v1/scan/change` route this leg — ROUTE_INDEX stays 40. Measurement against
//! the tip: `native_model_files_change` (downloads_model_files.rs:262) is NOT
//! the pure-index primitive the addendum line assumes. It is a FILE MUTATION
//! command — `change_files` (:209-255) MOVES model files (with covers and
//! sidecars) or DELETES them outright, and only then applies the in-place index
//! update (`index::apply_file_changes`, :256) as its second phase. Its gates
//! (confirm `:274-276`, download/scan-running refusal `:277-279`) protect
//! destroying weights, not refreshing a snapshot. The addendum's claim "the
//! index refresh primitive now exists" is true of `apply_file_changes` alone,
//! but the command offers no index-only verb: bridging it behind M14c's
//! in-process `confirmed:true` idiom would put model-file deletion one POST from
//! a stranger with the standing key. Deferred to the owner: a safe pairing needs
//! either a stock index-only command or a two-leg plan/execute door mirroring
//! the downloads split (preview the move/delete set, then execute) plus the
//! running-engine posture checks — a leg of its own, not a scan.rs arm.

use futures_util::future::BoxFuture;

pub(crate) use crate::downloads::models::background::{ModelScanStatus, ScanScope};

/// The two stock verbs `/v1/scan` needs, boxed so one `dyn` seam covers both the
/// synchronous status read and the asynchronous start.
pub(crate) trait ScanBridge: Send + Sync {
    /// The engine's current status verbatim; `Err` only when the bridge itself is
    /// unavailable, never for a merely idle or failed scan.
    fn status(&self) -> Result<ModelScanStatus, String>;
    /// Start one metadata scan over `root`; the answer is the stock initial status
    /// (state `running`, fresh id), exactly what the UI's start call receives.
    fn start(
        &self,
        root: String,
        scope: ScanScope,
        authenticated: bool,
    ) -> BoxFuture<'static, Result<ModelScanStatus, String>>;
}

/// Production bridge: the Tauri-managed `ModelScanEngine` plus the stock
/// `native_model_scan_start` command called in-process. The command keeps its own
/// laws (a running download refuses the scan, the catalog must carry the CivitAI
/// provider, credentials only when the caller asks authenticated), so the plane
/// surfaces exactly the posture the UI would see.
pub(crate) struct StockScanBridge {
    app: tauri::AppHandle,
}

impl StockScanBridge {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl ScanBridge for StockScanBridge {
    fn status(&self) -> Result<ModelScanStatus, String> {
        use tauri::Manager as _;
        Ok(self
            .app
            .state::<crate::downloads::models::background::ModelScanEngine>()
            .status())
    }

    fn start(
        &self,
        root: String,
        scope: ScanScope,
        authenticated: bool,
    ) -> BoxFuture<'static, Result<ModelScanStatus, String>> {
        let app = self.app.clone();
        Box::pin(async move {
            use tauri::Manager as _;
            crate::downloads::models::background::native_model_scan_start(
                app.clone(),
                app.state::<crate::downloads::models::background::ModelScanEngine>(),
                app.state::<crate::downloads::DownloadEngine>(),
                app.state::<crate::auth::AuthState>(),
                root,
                scope,
                authenticated,
                None,
                None,
                None,
            )
            .await
        })
    }
}

/// Test double: a fixed engine posture with a scripted start outcome. The route-level
/// refusals (one-scan-at-a-time, bridge-unavailable) run over this without any Tauri
/// context, backend or scan.
#[cfg(test)]
pub(crate) struct FakeScanBridge {
    status_state: &'static str,
    status_root: &'static str,
    start_error: Option<&'static str>,
}

#[cfg(test)]
impl FakeScanBridge {
    pub(crate) const fn idle() -> Self {
        Self {
            status_state: "idle",
            status_root: "R:/models",
            start_error: None,
        }
    }

    pub(crate) const fn running() -> Self {
        Self {
            status_state: "running",
            status_root: "R:/models",
            start_error: Some("A Library file scan is already running"),
        }
    }

    pub(crate) const fn refusing_start(problem: &'static str) -> Self {
        Self {
            status_state: "idle",
            status_root: "R:/models",
            start_error: Some(problem),
        }
    }
}

#[cfg(test)]
impl ScanBridge for FakeScanBridge {
    fn status(&self) -> Result<ModelScanStatus, String> {
        Ok(ModelScanStatus {
            id: "fake-scan-status".to_owned(),
            root: self.status_root.to_owned(),
            state: self.status_state.to_owned(),
            file: None,
            completed: 0,
            total: 0,
            remaining: 0,
            failed: 0,
        })
    }

    fn start(
        &self,
        root: String,
        _scope: ScanScope,
        _authenticated: bool,
    ) -> BoxFuture<'static, Result<ModelScanStatus, String>> {
        let error = self.start_error;
        Box::pin(async move {
            match error {
                Some(problem) => Err(problem.to_owned()),
                None => Ok(ModelScanStatus {
                    id: "fake-scan-1".to_owned(),
                    root,
                    state: "running".to_owned(),
                    file: None,
                    completed: 0,
                    total: 0,
                    remaining: 0,
                    failed: 0,
                }),
            }
        })
    }
}
