//! DEAS Agent API — the `/v1` agent plane.
//!
//! A loopback-only HTTP surface for automation agents. The plane starts only when the
//! operator file `deas-agent-settings.json` (beside the DEAS settings, in app-data) opts in
//! with `{"enabled": true}`; absent or disabled means zero agent-plane startup and no bound
//! port. Operator cycle commands and the readiness URL live in `deas-agent-guard.json` and
//! are never hardcoded into the binary.

#[cfg(test)]
mod acceptance;
mod auth;
mod boot;
mod caps;
mod config;
mod cycle;
mod cycle_view;
mod defaults;
mod e16;
mod errors;
mod files;
mod fill_plane;
mod guard;
mod idempotency;
mod inputs;
/// LEG M11a: the intent-truth harness (door-filled intents through the stock compile
/// gate, differential against the stock fixtures). Test-only home: it exists to prove
/// the fill chain lands intents the stock compiler accepts, never to run in a build.
#[cfg(test)]
mod intent_truth;
/// LEG M13: the settings-truth harness (resolution + output settings per mode and
/// family, landed where stock lands them: graph node classes and input VALUES, with
/// both walls for every refusal). Test-only home; it reuses the M11a pipeline.
#[cfg(test)]
mod intent_truth_settings;
mod lanes;
mod library;
mod resolver;
mod results;
mod resume;
mod routes;
mod scan;
pub mod settings_bridge;
mod spool;
mod transport;
mod uploads;
mod wait;
mod watchdog;

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use crate::logs::{self, Source};

use self::lanes::Lanes;

/// Shared state of one live `/v1` plane; cheap to clone for axum extractors.
#[derive(Clone)]
pub(crate) struct PlaneState {
    settings: config::AgentSettings,
    app_data: PathBuf,
    lanes: Arc<Lanes>,
    /// The durable spool handle (API-DESIGN §5): one process-level gate inside; the
    /// file is the state, so every leg reads and mutates through this same handle.
    spool: Arc<spool::Spool>,
    /// The cycle cell (§7): the fence, the live phase and the persisted terminal
    /// report. One per plane; the fence claim is the CAS, `GET /v1/cycle` is the
    /// resume read.
    cycle: Arc<cycle::CycleCell>,
    /// The cycle machine's seam kit (command bats, submit chain, backend door,
    /// compute gate, health probe, pacer): production stock impls at boot, fakes
    /// in tests — the machine logic itself lives in `cycle.rs` over the traits.
    cycle_seams: Arc<cycle::CycleSeams>,
    /// The watchdog (§8): the two-fact judge's live state, its durable journal, and
    /// the run loop's handle. The `POST /v1/watchdog/sever` door and the loop act on
    /// this same instance, so the operator and the judge can never disagree.
    watchdog: Arc<watchdog::Watchdog>,
    /// The idempotency ledger (§11, §7.3): the durable keyDigest -> cycle rows the
    /// generate door consults before the fence claim, so a re-POST with a known key
    /// can never start a second drain. One instance per plane; the file is the state.
    ledger: Arc<idempotency::Ledger>,
    /// The restore-watch posture reader for `GET /v1/resume`: the one shared
    /// health-probe seam plus its ≤1/[`cycle::HEALTH_PROBE_GAP_MS`] cadence gate,
    /// so resume never invents a second prober and never out-probes the machine.
    resume: Arc<resume::ResumeWatch>,
    /// The §4.4 result doors' bridge to the stock native job plane (jobs list,
    /// row status, scoped cancel, Stop, history, one output preview): production
    /// calls the stock commands in-process over the managed states; tests fake the
    /// plane. The manual free does NOT live here — it drives ONE attempt over the
    /// already-shipped `cycle_seams.door` free wire, so the plane keeps exactly
    /// one `/free` path.
    results: Arc<dyn results::ResultsBridge>,
    /// The RefMod creation door's bridge to the stock native RefMod submit (LEG M9e):
    /// production calls `native_h3_refmod_submit` in-process over the managed Engine;
    /// tests fake it. Deliberately separate from `results` — an export is not a
    /// Workbench row, so it must never be reachable through the row doors' verbs.
    refmods: Arc<dyn results::RefmodBridge>,
    /// Injected library index source for the unified resolver (§3 step 1). Tests and
    /// direct construction set it; the production plane leaves it `None` and resolves
    /// live through `app` (see [`Self::index_source`]), so an environment opened after
    /// boot is seen without a restart. A model reference over no source answers the
    /// honest `libraryScanRequired`.
    library: Option<resolver::IndexSource>,
    /// The injected input root for the `GET /v1/inputs` inventory. Tests and direct
    /// construction set it; the production plane leaves it `None` and resolves the root
    /// live through `app` (see [`Self::input_root`]), so an environment opened after boot
    /// is seen without a restart. `None` everywhere is the honest "no owned environment
    /// is readable" posture — the door refuses rather than walking a guessed folder.
    input_root: Option<PathBuf>,
    /// The injected output root for the MEDIA-1 byte doors (`GET /v1/outputs`,
    /// `GET /v1/files/outputs/...`, `POST /v1/inputs/promote`). Same injection
    /// law as [`Self::input_root`]: production resolves it live through `app`
    /// (see [`Self::output_root`]), tests inject.
    output_root: Option<PathBuf>,
    /// The per-batch upload ledger (ruling E21: uploads sharing a `?batch=`
    /// label accumulate against `caps.jobUploadMiB`). In-memory per process —
    /// the documented best-effort network budget, never a durable quota.
    batch: Arc<caps::BatchLedger>,
    /// The Tauri app handle behind the stock seams this plane bridges: the boot
    /// wiring's index cache dir and approved environment root (boot), the library
    /// scan engine (scan), the owned backend lifecycle and upload placement
    /// (uploads). `None` only in tests; production wires it from the M1a
    /// registration point.
    app: Option<tauri::AppHandle>,
    /// The `/v1/scan` pair's bridge to the stock library-scan engine.
    scan: Arc<dyn scan::ScanBridge>,
    /// The `/v1/uploads` bridge to the stock upload placement seam.
    uploads: Arc<dyn uploads::UploadBridge>,
}

impl PlaneState {
    /// The resolver's live index source: the injected one when set, else the boot
    /// wiring recomputed from the app handle per request (settings and approved
    /// environment are read lazily, the same pattern as the cycle view's guard read).
    /// `None` keeps the honest `libraryScanRequired` posture.
    pub(crate) fn index_source(&self) -> Option<resolver::IndexSource> {
        self.library
            .clone()
            .or_else(|| self.app.as_ref().and_then(boot::from_app))
    }

    /// The input root `GET /v1/inputs` walks: the injected one when set, else the stock
    /// input-root law ([`crate::media::intake::input_root`]: the approved environment's
    /// saved `input` folder, or its `ComfyUI/input` fallback) read per request, never a
    /// guessed path. `None` is the honest no-readable-environment posture.
    pub(crate) fn input_root(&self) -> Option<PathBuf> {
        self.input_root.clone().or_else(|| {
            use tauri::Manager as _;
            let app = self.app.as_ref()?;
            crate::media::intake::input_root(&app.state::<crate::install::Engine>()).ok()
        })
    }

    /// The output root the MEDIA-1 byte doors walk: the injected one when set,
    /// else the stock output-root law ([`crate::media::star::output_root`]: the
    /// approved environment's saved `output` folder, or its `ComfyUI/output`
    /// fallback — the same home the media dock stars in) read per request, never
    /// a guessed path. `None` is the honest no-readable-environment posture.
    pub(crate) fn output_root(&self) -> Option<PathBuf> {
        self.output_root.clone().or_else(|| {
            use tauri::Manager as _;
            let app = self.app.as_ref()?;
            crate::media::star::output_root(&app.state::<crate::install::Engine>()).ok()
        })
    }

    /// The live cycle cell behind this plane. The native settings bridge reads it
    /// for the mid-cycle law: a guard or defaults write is refused while the cell's
    /// phase is not idle (the same fact `GET /v1/cycle` answers).
    pub(crate) fn cycle_cell(&self) -> &cycle::CycleCell {
        &self.cycle
    }
}

/// The plane bound by the most recent successful [`start_if_enabled`]. At most one
/// per process: the plane binds once at startup and never rebinds in-process, so a
/// `OnceLock` is the honest shape. The native settings bridge consults it for the
/// live cycle cell; `None` means the plane never bound (disabled, absent or refused
/// settings) — the operator files are still readable and writable on disk, because
/// the panel configures before it enables.
static LIVE_PLANE: OnceLock<PlaneState> = OnceLock::new();

/// The live plane, `None` while no `/v1` plane has bound.
pub(crate) fn live_plane() -> Option<&'static PlaneState> {
    LIVE_PLANE.get()
}

/// The seven plane files whose atomic writers stage beside the target (every
/// `with_file_name(format!("{FILE}…​.tmp"))` home in the plane). The W3-16 boot sweep
/// matches ONLY these families, prefix-exact.
const STAGING_FAMILIES: [&str; 7] = [
    spool::FILE,
    cycle::FILE,
    defaults::FILE,
    idempotency::FILE,
    watchdog::JOURNAL_FILE,
    guard::FILE,
    config::FILE,
];

/// The exact staging shapes: `{family}.{digits}.tmp` (the pid-only writers) and
/// `{family}.{digits}.{digits}.tmp` (defaults' pid+sequence). Digit runs only — a
/// foreign `notes.5.tmp`, a name-less `{family}.tmp`, a non-numeric middle or a third
/// run never matches, so the sweep cannot touch anything but the plane's own failed
/// staging artifacts.
fn is_plane_staging_temp(name: &str) -> bool {
    let Some(stripped) = name.strip_suffix(".tmp") else {
        return false;
    };
    STAGING_FAMILIES.iter().any(|family| {
        let Some(rest) = stripped.strip_prefix(&format!("{family}.")) else {
            return false;
        };
        let runs: Vec<&str> = rest.split('.').collect();
        (runs.len() == 1 || runs.len() == 2)
            && runs
                .iter()
                .all(|run| !run.is_empty() && run.bytes().all(|byte| byte.is_ascii_digit()))
            // W4-F (LEG AF2-M22): every plane writer embeds ITS OWN pid as the
            // first digit run ({family}.{pid}[.{seq}].tmp), so a digit run that
            // names a DIFFERENT process is another DEAS instance's in-flight
            // staging — sweeping it would race that live writer's rename. Only
            // the current pid's shapes are ours. (The seq second run stays a
            // plain digit-run check: it carries no process identity.)
            && runs[0].parse::<u32>().is_ok_and(|pid| pid == std::process::id())
    })
}

/// Removes the plane's orphaned staging temps from app-data, returning the names it
/// took (the boot log names what vanished; a write failure on one litter file is
/// silent-by-design — the next boot tries again, and a stuck temp is inert).
fn sweep_staging_litter(app_data: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(app_data) else {
        return Vec::new();
    };
    let mut swept = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_plane_staging_temp(&name) {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            swept.push(name);
        }
    }
    swept
}

/// Starts the `/v1` plane when — and only when — operator settings opt in.
///
/// An absent, disabled or malformed `deas-agent-settings.json` returns without binding
/// anything; malformed settings are surfaced to the DEAS log and fail closed, so a typo
/// never opens a plane on guessed defaults.
///
/// The app handle carries the boot wiring: the stock index cache dir, the approved
/// environment's saved model folders (the resolver's [`resolver::IndexSource`]), and
/// the managed states behind the scan and upload bridges. A plane that boots with no
/// environment open logs that honestly and keeps the `libraryScanRequired` posture
/// until one opens — the wiring is read live, not frozen at boot.
///
/// The bind address is constructed here as `127.0.0.1:<port>`: the settings file carries a
/// port, never an address, so a non-loopback bind is structurally impossible.
pub fn start_if_enabled(app: &tauri::AppHandle, app_data: &Path) {
    let settings = match config::load(app_data) {
        Ok(Some(settings)) => settings,
        Ok(None) => return,
        Err(reason) => {
            logs::push(
                Source::Deas,
                &format!("agent-api: settings refused startup: {reason}"),
            );
            return;
        }
    };
    match boot::from_app(app) {
        Some(source) => logs::push(
            Source::Deas,
            &format!(
                "agent-api: library index source wired over {} model root(s); index cache {}",
                source.roots.len(),
                source.index_dir.display()
            ),
        ),
        None => logs::push(
            Source::Deas,
            "agent-api: no library index source at boot (no approved environment or unreadable saved folders); model references answer libraryScanRequired until an environment opens",
        ),
    }
    let port = settings.port;
    let watchdog_seams = Arc::new(watchdog::WatchdogSeams::stock(app.clone()));
    // The spool handle exists before the seam kit: the submit chain correlates the row
    // it submits (M9a) and the correlation probe reads what the spool already records.
    let spool = Arc::new(spool::Spool::new(app_data));
    // The cycle seam kit is built first: the resume watch reuses its health probe
    // (one prober on the plane, never a second).
    let cycle_seams = Arc::new(cycle::CycleSeams::stock(app.clone(), Arc::clone(&spool)));
    let state = PlaneState {
        settings,
        app_data: app_data.to_path_buf(),
        lanes: Arc::new(Lanes::new()),
        spool: Arc::clone(&spool),
        cycle: Arc::new(cycle::CycleCell::new(app_data)),
        cycle_seams: Arc::clone(&cycle_seams),
        watchdog: Arc::new(watchdog::Watchdog::new(
            app_data,
            Arc::clone(&watchdog_seams),
        )),
        ledger: Arc::new(idempotency::Ledger::new(app_data)),
        resume: Arc::new(resume::ResumeWatch::new(Arc::clone(&cycle_seams.health))),
        results: Arc::new(results::StockResultsBridge::new(app.clone())),
        refmods: Arc::new(results::StockRefmodBridge::new(app.clone())),
        // The production plane resolves the index source live through `app` (boot
        // wiring per read, not frozen at construction); `library` stays the direct
        // injection channel for tests and pinned sources.
        library: None,
        // Same law for the input root: the stock input-root seam answers per request, so
        // an environment opened after boot is seen; the field stays the test channel.
        input_root: None,
        // The output root rides the identical per-request law (MEDIA-1 byte doors).
        output_root: None,
        // The batch ledger is plane-lifetime RAM (ruling E21's per-process budget).
        batch: Arc::new(caps::BatchLedger::new()),
        app: Some(app.clone()),
        scan: Arc::new(scan::StockScanBridge::new(app.clone())),
        uploads: Arc::new(uploads::StockUploadBridge::new(app.clone())),
    };
    let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
    // The watchdog's one sampler slot: the loop starts with the plane, not before it
    // (a plane that never bound never watches a card). §8.1: no route disables it.
    let watchdog_loop = watchdog::LoopPlane {
        cell: Arc::clone(&state.cycle),
        spool: Arc::clone(&state.spool),
        seams: Arc::clone(&state.cycle_seams),
    };
    let watchdog_handle = Arc::clone(&state.watchdog);
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => listener,
            Err(error) => {
                // F6 (LEG AF2-M20): a bind failure ends the task here — the plane never
                // starts, `LIVE_PLANE` stays unset, the watchdog never arms, and NO
                // orphan sweep has run. That is the whole point of the F6 reorder: a
                // SECOND enabled DEAS instance loses the port to the live plane and
                // must not touch the LIVE instance's rows. Before M20 the sweep ran
                // before the bind, so the loser flipped the winner's `draining` rows
                // to failed from behind its still-running driver.
                logs::push(
                    Source::Deas,
                    &format!("agent-api: bind {addr} failed: {error}"),
                );
                return;
            }
        };
        // C2 (LEG AF2-M18a) + F6 reorder (LEG AF2-M20): the orphan sweep runs AFTER a
        // successful bind and before anything can read the queue — the router is not
        // serving yet, the watchdog loop starts after it, and `LIVE_PLANE` is set after
        // it. A `draining` row means a driver owned it and no driver survived the
        // restart, so this instance's own boot sweep still precedes its every door.
        // A corrupt spool is logged and left exactly as it is — the spool's own
        // fail-closed law answers every door until the operator fixes the file, and
        // the sweep never repairs bytes behind them.
        match state.spool.recover_draining_orphans() {
            Ok(orphans) if orphans.is_empty() => {}
            Ok(orphans) => logs::push(
                Source::Deas,
                &format!(
                    "agent-api: boot recovered {} spool row(s) left `draining` by the previous process and failed them as orphans: {}",
                    orphans.len(),
                    orphans.join(", ")
                ),
            ),
            Err(problem) => logs::push(
                Source::Deas,
                &format!(
                    "agent-api: boot could not sweep the spool for draining orphans: {problem}"
                ),
            ),
        }
        // W3-16 (LEG AF2-M21b): the plane's own staging litter. A crash between an
        // atomic writer's staging write and its rename leaves `{FILE}.{pid}[.{seq}].tmp`
        // bytes behind forever (spool 454, cycle 601, defaults 252, idempotency 206,
        // watchdog 393, settings_bridge 178). The sweep runs HERE — after the bind, so
        // a second instance can never sweep a LIVE instance's staging files (the F6
        // law this sits under), and before `LIVE_PLANE` is set, so no door can race it.
        // E23 stays clean BY PATTERN: production `remove_file` still runs only on the
        // plane's OWN staging temps — bytes these very writers minted with the rename
        // that never landed, never saved content, and never anything whose name is not
        // prefix-exact below. No delete door exists or ships.
        let litter = sweep_staging_litter(&state.app_data);
        if !litter.is_empty() {
            logs::push(
                Source::Deas,
                &format!(
                    "agent-api: boot swept {} orphaned staging temp(s) left between write and rename: {}",
                    litter.len(),
                    litter.join(", ")
                ),
            );
        }
        // The native settings bridge reads the live cell from here: the bind
        // succeeded, so this plane is the process' cycle authority.
        let _ = LIVE_PLANE.set(state.clone());
        logs::push(
            Source::Deas,
            &format!("agent-api: /v1 plane listening on http://{addr}"),
        );
        watchdog::spawn(watchdog_handle, watchdog_loop);
        logs::push(
            Source::Deas,
            "agent-api: watchdog armed (two-fact judge, 1 s slot; operator numbers live in the guard file's watchdog block)",
        );
        if let Err(error) = axum::serve(listener, transport::router(state)).await {
            logs::push(
                Source::Deas,
                &format!("agent-api: serve loop ended: {error}"),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// W3-16 pin (LEG AF2-M21b), re-pinned by W4-F (LEG AF2-M22): every own-family
    /// staging shape carrying the CURRENT process's pid sweeps; foreign `.tmp`
    /// files, half-matching names, the plane files themselves, AND another
    /// process's staging temps (a live sibling DEAS instance's in-flight writes)
    /// survive.
    #[test]
    fn the_boot_sweep_takes_only_the_plane_s_own_staging_shapes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid = std::process::id();
        let swept_in = [
            format!("deas-agent-queue.json.{pid}.tmp"),
            format!("deas-agent-defaults.json.{pid}.7.tmp"),
            format!("deas-agent-cycle.json.{pid}.tmp"),
            format!("deas-agent-watchdog.json.{pid}.tmp"),
            format!("deas-agent-idempotency.json.{pid}.tmp"),
            format!("deas-agent-guard.json.{pid}.tmp"),
            format!("deas-agent-settings.json.{pid}.tmp"),
        ];
        let mut kept = vec![
            "deas-agent-queue.json".to_owned(),
            "deas-agent-guard.json".to_owned(),
            "deas-agent-queue.json.tmp".to_owned(),
            "deas-agent-queue.json.abc.tmp".to_owned(),
            "deas-agent-queue.json.1.2.3.tmp".to_owned(),
            "deas-agent-queueXjson.5.tmp".to_owned(),
            "notes.tmp".to_owned(),
            "notes.5.tmp".to_owned(),
            "deas-agent-backup-plan.5.tmp".to_owned(),
            // W4-F: a foreign pid on a real family shape — another DEAS instance
            // mid-write. The sweep must never touch it.
            format!("deas-agent-queue.json.{}.tmp", pid.wrapping_add(999_999)),
            format!(
                "deas-agent-defaults.json.{}.4.tmp",
                pid.wrapping_add(999_999)
            ),
        ];
        for name in kept.iter().chain(swept_in.iter()) {
            std::fs::write(dir.path().join(name), b"x").expect("fixture");
        }
        let mut swept = sweep_staging_litter(dir.path());
        swept.sort();
        let mut want = swept_in;
        want.sort();
        assert_eq!(swept, want, "only the plane's own staging temps sweep");
        kept.sort();
        for name in &kept {
            assert!(dir.path().join(name).exists(), "{name} must survive");
        }
    }
}
