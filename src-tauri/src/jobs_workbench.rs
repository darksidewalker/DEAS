//! Workbench opt-in: each Run owns an existing exclusive lifecycle, never a deferred FIFO.
use super::*;

const WORKBENCH_LIMIT: usize = 20;

// Shared Workbench failure log limiter: once per minute.
static WORKBENCH_FAILURE_LAST: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// Test-only: log assertions run in one process sharing this limiter.
#[cfg(test)]
pub(super) fn reset_workbench_failure_logging() {
    *WORKBENCH_FAILURE_LAST.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

impl Session {
    pub(super) fn workbench_busy(&self) -> Result<bool, String> {
        for held in &self.workbench {
            if held.lock()?.job.as_ref().is_none_or(|job| !job.terminal()) {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

impl Jobs {
    pub(super) fn workbench_job(&self, id: &str) -> Result<Option<Arc<Jobs>>, String> {
        for held in &self.lock()?.workbench {
            if held.lock()?.job.as_ref().is_some_and(|job| job.id == id) {
                return Ok(Some(held.clone()));
            }
        }
        Ok(None)
    }

    pub(super) fn workbench_current(&self) -> Result<Value, String> {
        let session = self.lock()?;
        let mut jobs = Vec::new();
        let mut preparing = 0;
        for held in &session.workbench {
            if let Some(job) = &held.lock()?.job {
                jobs.push(job.snapshot());
            } else {
                preparing += 1;
            }
        }
        Ok(
            json!({"jobs":jobs,"preparing":preparing,"capacity":WORKBENCH_LIMIT,"stopAvailable":false}),
        )
    }

    pub(super) async fn status_for(&self, job_id: String) -> Result<Value, String> {
        if let Some(held) = self.workbench_job(&job_id)? {
            let before = held.current()?;
            let result = held.status(job_id).await?;
            if before["state"] != result["state"] || before["error"] != result["error"] {
                report_job("status", &result);
            }
            return Ok(result);
        }
        self.status(job_id).await
    }

    pub(super) async fn workbench_run(
        &self,
        base_url: String,
        intent: Value,
        confirmed: bool,
        engine: Option<&crate::install::Engine>,
    ) -> Result<Value, String> {
        let result = self
            .workbench_run_inner(base_url, intent, confirmed, engine)
            .await;
        match &result {
            Ok(job) => report_job("run", job),
            Err(_) => {
                let mut last = WORKBENCH_FAILURE_LAST.lock().unwrap_or_else(|e| e.into_inner());
                if last.is_none_or(|at| at.elapsed() >= Duration::from_secs(60)) {
                    *last = Some(std::time::Instant::now());
                    crate::logs::push(crate::logs::Source::Deas, "ERROR: Workbench run: preparation or admission failed; see operation result (repeats limited to once per minute)");
                }
            }
        }
        result
    }

    async fn workbench_run_inner(
        &self,
        base_url: String,
        intent: Value,
        confirmed: bool,
        engine: Option<&crate::install::Engine>,
    ) -> Result<Value, String> {
        if !confirmed {
            return Err("Explicit Workbench submission confirmation is required".into());
        }
        let held = Arc::new(Jobs::default());
        {
            let mut session = self.lock()?;
            if session.preparing.is_some() || session.job.as_ref().is_some_and(|j| !j.terminal()) {
                return Err("An exclusive diagnostic operation is in flight or unknown".into());
            }
            if session.workbench.len() == WORKBENCH_LIMIT {
                let mut evict = None;
                for (index, entry) in session.workbench.iter().enumerate() {
                    if entry.lock()?.job.as_ref().is_some_and(Job::terminal) {
                        evict = Some(index);
                        break;
                    }
                }
                let index = evict.ok_or(
                    "Workbench queue capacity reached; active and unknown jobs are retained",
                )?;
                session.workbench.remove(index);
            }
            session.workbench.push(held.clone());
        }
        let plan = match held.prepare(base_url, intent).await {
            Ok(plan) => plan,
            Err(error) => {
                self.lock()?
                    .workbench
                    .retain(|entry| !Arc::ptr_eq(entry, &held));
                return Err(error);
            }
        };
        if let Some(engine) = engine {
            let mut session = held.lock()?;
            let plan = session.plan.as_mut().ok_or("Missing Workbench plan")?;
            plan.media_root = job_outputs::MediaRoot::owned(engine, plan.base.as_str());
        }
        let result = held
            .submit(plan["id"].as_str().unwrap().to_owned(), true)
            .await;
        if result.is_err() && held.lock()?.job.is_none() {
            self.lock()?
                .workbench
                .retain(|entry| !Arc::ptr_eq(entry, &held));
        }
        result
    }
}

fn report_job(operation: &str, job: &Value) {
    // Never forward backend errors, prompts, filenames or endpoints to the shared log.
    let level = if matches!(job["state"].as_str(), Some("unknown" | "failed")) {
        "ERROR"
    } else {
        "INFO"
    };
    crate::logs::push(
        crate::logs::Source::Deas,
        &format!(
            "{level}: Workbench {operation}: job={} state={}",
            job["id"].as_str().unwrap_or("unknown"),
            job["state"].as_str().unwrap_or("unknown")
        ),
    );
}

/// One explicit Run prepares and immediately submits an immutable native intent.
#[tauri::command]
pub async fn native_workbench_run(
    state: tauri::State<'_, Jobs>,
    engine: tauri::State<'_, crate::install::Engine>,
    base_url: String,
    intent: Value,
    confirmed: bool,
) -> Result<Value, String> {
    state
        .workbench_run(base_url, intent, confirmed, Some(&engine))
        .await
}

/// Session recovery only: no backend requests, automatic retries, or cancellation.
#[tauri::command]
pub fn native_workbench_current(state: tauri::State<'_, Jobs>) -> Result<Value, String> {
    state.workbench_current()
}
