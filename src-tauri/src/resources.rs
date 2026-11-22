//! Native admission for dependent work. Caller holds Jobs' serial pipeline guard through execution.
//! `/free` only acknowledges flags: main.py's idle worker resets caches/GC later; telemetry is proof.
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

#[derive(Clone, Copy, Debug)]
pub(crate) struct Need {
    pub ram_bytes: u64,
    pub vram_bytes: u64,
    /// Physical telemetry index, not CUDA's remapped visible index.
    pub device_index: Option<u32>,
}

static CONTEXT: Mutex<Option<crate::install::Engine>> = Mutex::new(None);
static COMPUTE: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)));

/// Hold through native admission + inference, or backend admission + submit response.
/// Never acquire this gate for Stop/cancel; busy callers defer rather than block a runtime.
pub(crate) fn reserve_compute() -> Result<tokio::sync::OwnedSemaphorePermit, String> {
    Compute(COMPUTE.clone()).reserve()
}

/// Jobs' handle on the compute gate: the app-wide gate in production; tests get a private
/// gate per Jobs tree so parallel tests cannot see each other's submissions as busy.
#[derive(Clone)]
pub(crate) struct Compute(std::sync::Arc<tokio::sync::Semaphore>);

impl Default for Compute {
    fn default() -> Self {
        #[cfg(not(test))]
        return Self(COMPUTE.clone());
        #[cfg(test)]
        Self(std::sync::Arc::new(tokio::sync::Semaphore::new(1)))
    }
}

impl Compute {
    /// Same contract as `reserve_compute`.
    pub(crate) fn reserve(&self) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
        self.0.clone().try_acquire_owned().map_err(|_| {
            "RESOURCE_BUSY: Another native compute stage is active; retry after it finishes".into()
        })
    }
}

/* ---------------- cycle fence (STOCK-REFERENCE §14.6, API-DESIGN §12 E14) --------------

The agent-API drain cycle owns the card end to end (§7.1). Stock paths never saw that
ownership: `forge/gpu_swap` and `audio_runtime` admitted through here (and posted `/free`)
inside the cycle's queue-empty windows, and the restart/update/move commands could tear
the environment down mid-handoff. The fence lives in this module — the stock compute
authority's own home — so stock never depends on `agent_api`. The API's cycle driver is
the single owner: it claims the mirror on its cell's CAS-success path and releases it at
`finish`; the gates below answer stock callers while it holds.
*/

static CYCLE_FENCE: AtomicBool = AtomicBool::new(false);
/// The fence owner's own submit rides the fence: the cycle's drain reaches the card
/// through the same stock path (`agent_api::cycle::StockSubmitChain` -> `jobs::native_job_submit`
/// -> `jobs::submit_inner`). Exactly one driver owns the fence, so at most one pass
/// window can be open; stock submitters never get one.
static CYCLE_FENCE_PASS: AtomicBool = AtomicBool::new(false);

/// Claim the stock-facing fence. `false` means it is already held by a cycle.
pub(crate) fn fence_claim() -> bool {
    CYCLE_FENCE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

/// Release the fence and any pass window with it; only the fence owner calls this.
pub(crate) fn fence_release() {
    CYCLE_FENCE_PASS.store(false, Ordering::Release);
    CYCLE_FENCE.store(false, Ordering::Release);
}

/// `true` while an agent-API cycle owns the card.
pub(crate) fn fence_held() -> bool {
    CYCLE_FENCE.load(Ordering::Acquire)
}

/// E14 stock entry gate: `Some(refusal)` when `operation` must wait for the cycle. The
/// wording is stock's own (`CYCLE_FENCE: ...`), never the API's error taxonomy.
#[must_use = "a held fence is a refusal; return it to the caller"]
pub(crate) fn fence_wait(operation: &str) -> Option<String> {
    fence_held().then(|| fence_refusal(operation))
}

/// The same gate for submission, which the fence owner may ride (§14.6).
#[must_use = "a held fence is a refusal; return it to the caller"]
pub(crate) fn fence_wait_for_submit(operation: &str) -> Option<String> {
    (fence_held() && !CYCLE_FENCE_PASS.load(Ordering::Acquire)).then(|| fence_refusal(operation))
}

fn fence_refusal(operation: &str) -> String {
    format!("CYCLE_FENCE: An agent-API cycle owns the card; {operation} waits until it finishes")
}

/// RAII pass window for the fence owner's own stock submit (see `CYCLE_FENCE_PASS`).
#[derive(Debug)]
pub(crate) struct FencePass;

impl Drop for FencePass {
    fn drop(&mut self) {
        CYCLE_FENCE_PASS.store(false, Ordering::Release);
    }
}

/// Grants the fence owner a pass window; `None` for anyone else, so a stock caller can
/// never open one by accident. The window closes when the returned guard drops.
///
/// CALLER DISCIPLINE (I-3 note, LEG AF2-M19b): any caller inside this crate passes
/// while the fence is held — the door is authority-by-fence, not authority-by-module,
/// so the plane keeping its SINGLE driver (cycle.rs owns the pass today) is a law of
/// care, not of type. Before growing the caller set, re-check this note: a second
/// concurrent pass-holder would let two drivers submit under one fence.
pub(crate) fn fence_owner_pass() -> Option<FencePass> {
    fence_held().then(|| {
        CYCLE_FENCE_PASS.store(true, Ordering::Release);
        FencePass
    })
}

/* ---- TEST-ONLY serialization gate for the process-global fence (LEG AF2-M18c, D-1) ---- */

/// `CYCLE_FENCE` is one static per test binary, so every test that claims the fence —
/// directly, or through `CycleCell::claim`, which takes the stock mirror on its
/// CAS-success path — races every other such test under cargo's default multi-threaded
/// runner. Measured on the pre-fix tree: `cargo test --lib fence` on the DEFAULT runner
/// failed 11 tests that pass one-by-one and pass under `--test-threads=1` — 4 in
/// `agent_api::cycle`, 2 in `agent_api::watchdog`, 1 in `agent_api::transport`, 1 in the
/// jobs stop surface, and victims in the very files that own the gates (`app_update`,
/// `install`, `resources`). Wrapping only half the claimers is worse than wrapping none:
/// the wrapped tests become victims of the unwrapped ones. So EVERY fence-reaching test
/// now takes this gate across its whole claim-test-release span: `resources_tests` (4),
/// `jobs_tests` (1), `jobs_stop_tests` (1), `app_update_tests` (1), `install_update_tests`
/// (3), `environment_move` (1), every test in the `agent_api::cycle` and
/// `agent_api::watchdog` test modules (there the fence is reached through the cell, never
/// by name, so name-matching cannot find the claim sites), and the fence-touching tests in
/// `agent_api::transport`. The `--test-threads=1` law in the build gates stays (belt and
/// braces — it is also what makes a stranded-fence failure deterministic).
///
/// The lock payload is a unit and the fence is an atomic no test can leave corrupt, so a
/// poisoned lock carries nothing worth halting a binary over: take the inner value and let
/// the run continue. (A test that PANICS while holding the fence leaves it claimed for the
/// rest of the binary — that is already a named failure on the report, and
/// `--test-threads=1` keeps what follows deterministic.)
#[cfg(test)]
pub(crate) static FENCE_TEST_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The ticket [`fence_test_gate`] hands out: it holds the gate for the caller's whole span
/// and returns it when it drops. A newtype rather than the raw `MutexGuard` on purpose:
/// clippy's `await_holding_lock` is production law about real locks, while a fence test
/// parking on this ticket across an await IS the point of the ticket — not a hazard to
/// annotate away across thirty test bodies.
#[cfg(test)]
pub(crate) struct FenceTicket(Option<std::sync::MutexGuard<'static, ()>>);

#[cfg(test)]
impl Drop for FenceTicket {
    fn drop(&mut self) {
        let _ = self.0.take();
    }
}

/// Takes [`FENCE_TEST_GATE`], poison-tolerant. Bind the returned ticket for the whole
/// fence-touching span: `let _gate = fence_test_gate();` as the first statement.
#[cfg(test)]
#[must_use = "the gate only serializes the fence while the ticket is alive"]
pub(crate) fn fence_test_gate() -> FenceTicket {
    FenceTicket(Some(
        FENCE_TEST_GATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    ))
}

/// Native authority for admissions: only the approved owned environment may release memory.
pub(crate) fn owned_venv_python() -> Option<std::path::PathBuf> {
    let engine = CONTEXT.lock().ok()?.clone()?;
    let plan = engine.approved_plan()?;
    let python = std::path::PathBuf::from(plan.request.storage_path).join(if cfg!(windows) {
        "venv/Scripts/python.exe"
    } else {
        "venv/bin/python"
    });
    python.is_file().then_some(python)
}

/// Binds the shared native Engine authority for memory admissions (called once at startup).
pub fn bind_resource_authority(engine: crate::install::Engine) {
    configure_context(engine);
}

/// Bind native authority, never a frontend URL. Rebinding affects only subsequent admissions.
pub(crate) fn configure_context(engine: crate::install::Engine) {
    *CONTEXT.lock().unwrap_or_else(|e| e.into_inner()) = Some(engine);
}

/// Blocking-worker entry point; never call from a Tokio runtime thread.
pub(crate) fn admit(need: Need, cancel: &AtomicBool) -> Result<(), String> {
    // §14.6/E14: the fence gate covers every stock admission caller (forge gpu_swap,
    // audio smoke/check_memory/separate) at one entry point; nothing below runs.
    if let Some(refusal) = fence_wait("stock admission") {
        return Err(refusal);
    }
    let result = (|| {
        cancelled(cancel)?;
        let engine = CONTEXT
            .lock()
            .map_err(|_| "RESOURCE_CONTEXT: Native context unavailable")?
            .clone();
        let base = engine
            .as_ref()
            .and_then(|e| {
                let status = e.backend.status();
                (status.state == "running")
                    .then_some(status.endpoint)
                    .flatten()
            })
            .map(|s| Url::parse(&s).map_err(|_| "RESOURCE_OWNER: Invalid native endpoint"))
            .transpose()?;
        let owner = |base: &Url| {
            let engine = engine
                .as_ref()
                .ok_or("RESOURCE_OWNER: No owned backend configured")?;
            let inner = crate::install::lock(&engine.inner);
            let approved = inner
                .approved
                .as_ref()
                .ok_or("RESOURCE_OWNER: No approved environment")?;
            approved
                .validate()
                .map_err(|_| "RESOURCE_OWNER: Approved environment changed")?;
            drop(inner);
            engine.backend.cancellation_owner()(base)
                .map_err(|_| "RESOURCE_OWNER: Owned endpoint or lifecycle changed".into())
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "RESOURCE_RUNTIME: Cannot create admission runtime")?;
        runtime.block_on(interruptible(cancel, async {
            run(
                need,
                cancel,
                base.as_ref(),
                &owner,
                || crate::monitoring::sample(None),
                Duration::from_secs(20),
            )
            .await
        }))
    })();
    let message = match &result {
        Ok(()) => "resources info admission: available RAM/VRAM budget satisfied",
        Err(_) if cancel.load(Ordering::Acquire) => "resources info admission: cancelled",
        Err(_) => "resources warn admission: deferred; resource budget, telemetry or owned-idle proof unavailable",
    };
    // No endpoint, remote body, path or transport error reaches the shared log.
    crate::logs::push(crate::logs::Source::Deas, message);
    result
}

fn cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("RESOURCE_CANCELLED: Admission cancelled".into())
    } else {
        Ok(())
    }
}

async fn interruptible<T>(
    cancel: &AtomicBool,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::pin!(future);
    loop {
        cancelled(cancel)?;
        tokio::select! {
            result = &mut future => { cancelled(cancel)?; return result; }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }
}

fn enough(need: Need, sample: &crate::monitoring::Sample) -> Result<bool, String> {
    // Spend at most 90% of currently available memory; no absolute host/device caps.
    let fits = |required: u64, total: u64, used: u64| -> Result<bool, String> {
        if total == 0 || used > total {
            return Err("RESOURCE_TELEMETRY: Invalid memory sample".into());
        }
        let available = total - used;
        Ok(u128::from(required) * 10 <= u128::from(available) * 9)
    };
    let ram_ok = if need.ram_bytes == 0 {
        true
    } else {
        let ram = sample
            .ram
            .as_ref()
            .ok_or("RESOURCE_TELEMETRY: RAM availability unavailable")?;
        fits(need.ram_bytes, ram.total, ram.used)?
    };
    let gpu_ok = if need.vram_bytes == 0 {
        true
    } else {
        let index = need
            .device_index
            .ok_or("RESOURCE_DEVICE: A physical GPU index is required")?;
        let gpu = sample
            .gpus
            .iter()
            .find(|gpu| gpu.index == index)
            .ok_or("RESOURCE_TELEMETRY: Selected GPU unavailable")?;
        fits(
            need.vram_bytes,
            gpu.memory_total
                .ok_or("RESOURCE_TELEMETRY: VRAM total unavailable")?,
            gpu.memory_used
                .ok_or("RESOURCE_TELEMETRY: VRAM usage unavailable")?,
        )?
    };
    Ok(ram_ok && gpu_ok)
}

fn same_owner(
    base: &Url,
    owner: &impl Fn(&Url) -> Result<u64, String>,
    epoch: u64,
) -> Result<(), String> {
    if owner(base)? != epoch {
        return Err("RESOURCE_OWNER: Owned lifecycle changed".into());
    }
    Ok(())
}

async fn body(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "RESOURCE_HTTP: Response read failed")?
    {
        if bytes.len().saturating_add(chunk.len()) > 65536 {
            return Err("RESOURCE_HTTP: Response exceeded limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn idle(
    client: &Client,
    base: &Url,
    owner: &impl Fn(&Url) -> Result<u64, String>,
    epoch: u64,
) -> Result<(), String> {
    same_owner(base, owner, epoch)?;
    let response = client
        .get(
            base.join("queue")
                .map_err(|_| "RESOURCE_HTTP: Invalid route")?,
        )
        .send()
        .await
        .map_err(|_| "RESOURCE_HTTP: Queue probe failed")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("RESOURCE_HTTP: Queue probe refused".into());
    }
    let queue: Value = serde_json::from_slice(&body(response).await?)
        .map_err(|_| "RESOURCE_QUEUE: Invalid queue response")?;
    same_owner(base, owner, epoch)?;
    for key in ["queue_running", "queue_pending"] {
        let entries = queue[key]
            .as_array()
            .ok_or("RESOURCE_QUEUE: Missing queue state")?;
        if !entries.is_empty() {
            return Err(
                "RESOURCE_BUSY: Backend has running or pending work; retry after it finishes"
                    .into(),
            );
        }
    }
    Ok(())
}

async fn run<F, S>(
    need: Need,
    cancel: &AtomicBool,
    base: Option<&Url>,
    owner: &impl Fn(&Url) -> Result<u64, String>,
    mut sample: S,
    wait: Duration,
) -> Result<(), String>
where
    F: Future<Output = crate::monitoring::Sample>,
    S: FnMut() -> F,
{
    cancelled(cancel)?;
    let available = enough(need, &sample().await)?;
    cancelled(cancel)?;
    let Some(base) = base else {
        return if available {
            Ok(())
        } else {
            Err("RESOURCE_INSUFFICIENT: Insufficient available memory and no running owned backend to release".into())
        };
    };
    // Defense in depth even though production derives the URL solely from Engine.
    if base.scheme() != "http"
        || base.host_str() != Some("127.0.0.1")
        || base.path() != "/"
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err("RESOURCE_OWNER: Expected native owned loopback endpoint".into());
    }
    let epoch = owner(base)?;
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|_| "RESOURCE_HTTP: Cannot create client")?;
    idle(&client, base, owner, epoch).await?;
    if available {
        return Ok(());
    }
    // Remeasure after the idle probe: another process may already have released memory.
    if enough(need, &sample().await)? {
        cancelled(cancel)?;
        return Ok(());
    }
    idle(&client, base, owner, epoch).await?;
    cancelled(cancel)?;
    same_owner(base, owner, epoch)?;
    let response = client
        .post(
            base.join("free")
                .map_err(|_| "RESOURCE_HTTP: Invalid route")?,
        )
        .json(&json!({"unload_models": true, "free_memory": true}))
        .send()
        .await
        .map_err(|_| "RESOURCE_HTTP: Release request failed; not retried")?;
    // Upstream server.py returns an empty HTTP 200: this is acknowledgement, not completion.
    if response.status() != reqwest::StatusCode::OK || !body(response).await?.is_empty() {
        return Err("RESOURCE_ACK: Backend did not acknowledge memory release".into());
    }
    same_owner(base, owner, epoch)?;
    crate::logs::push(
        crate::logs::Source::Deas,
        "resources info release: owned idle backend acknowledged; waiting for measured memory",
    );
    let deadline = tokio::time::Instant::now() + wait;
    let verify = async {
        loop {
            cancelled(cancel)?;
            idle(&client, base, owner, epoch).await?;
            let available = enough(need, &sample().await)?;
            same_owner(base, owner, epoch)?;
            if available {
                cancelled(cancel)?;
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    tokio::time::timeout_at(deadline, verify).await
        .map_err(|_| "RESOURCE_INSUFFICIENT: Release acknowledged but measured available RAM/VRAM remains below the 90% safety budget".to_string())?
}

#[cfg(test)]
#[path = "resources_tests.rs"]
mod tests;
