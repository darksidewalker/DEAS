//! Native-owned classic diagnostic execution; never accepts a frontend graph.
use serde_json::{json, Value};
use std::{
    sync::{Mutex, MutexGuard},
    time::Duration,
};

#[path = "jobs_outputs.rs"]
mod job_outputs;
pub use job_outputs::{native_job_export, native_job_output, OutputPreview};

const RESPONSE_LIMIT: usize = 1024 * 1024;
const REQUIRED_NODES: [&str; 6] = [
    "CheckpointLoaderSimple",
    "CLIPTextEncode",
    "EmptyLatentImage",
    "KSampler",
    "VAEDecode",
    "SaveImage",
];

#[derive(Default)]
pub struct Jobs(Mutex<Session>, tokio::sync::Mutex<()>);

#[derive(Default)]
struct Session {
    preparing: Option<String>,
    plan: Option<Plan>,
    job: Option<Job>,
    output: Option<std::sync::Arc<job_outputs::CachedOutput>>,
}

#[derive(Clone)]
struct Plan {
    id: String,
    base: reqwest::Url,
    intent: Value,
    graph: Value,
    consumed: bool,
}

impl Plan {
    fn snapshot(&self) -> Value {
        json!({"id":self.id,"baseUrl":self.base.as_str(),"intent":self.intent,"graph":self.graph,"generationReady":false})
    }
}

#[derive(Clone)]
struct Job {
    id: String,
    plan: Plan,
    client_id: String,
    prompt_id: Option<String>,
    state: &'static str,
    outputs: Vec<Value>,
    error: Option<String>,
    submitting: bool,
    polling: bool,
}

impl Job {
    fn terminal(&self) -> bool {
        matches!(self.state, "succeeded" | "failed")
    }
    fn snapshot(&self) -> Value {
        json!({"id":self.id,"baseUrl":self.plan.base.as_str(),"promptId":self.prompt_id,"state":self.state,"outputs":self.outputs,"error":self.error,"generationReady":false})
    }
    fn unknown(&mut self, error: String) {
        self.state = "unknown";
        self.outputs.clear();
        self.error = Some(bounded(&error));
    }
}

fn bounded(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(800).collect()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .build()
        .map_err(|_| "Could not create diagnostic HTTP client".into())
}

async fn request(
    client: &reqwest::Client,
    base: &reqwest::Url,
    path: &str,
    body: Option<Value>,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = base.join(path).map_err(|_| "Invalid native job endpoint")?;
    let request = if let Some(body) = body {
        client.post(url).json(&body)
    } else {
        client.get(url)
    };
    // Do not echo URLs/transport internals into the frontend.
    let mut response = request
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| "Native job request failed; execution may be unknown")?;
    let status = response.status();
    if status.is_redirection() {
        return Err(format!(
            "Native job endpoint returned HTTP {status}; redirects forbidden"
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > RESPONSE_LIMIT as u64)
    {
        return Err("Native job response size limit exceeded".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Native job response interrupted")?
    {
        if chunk.len() > RESPONSE_LIMIT - bytes.len() {
            return Err("Native job response size limit exceeded".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice(&bytes)
        .map_err(|_| format!("Native job endpoint returned invalid JSON (HTTP {status})"))?;
    Ok((status, value))
}

async fn get(client: &reqwest::Client, base: &reqwest::Url, path: &str) -> Result<Value, String> {
    let (status, value) = request(client, base, path, None).await?;
    if !status.is_success() {
        return Err(format!("Native job endpoint returned HTTP {status}"));
    }
    Ok(value)
}

fn compile(i: &Value) -> Result<Value, String> {
    const FIELDS: [&str; 13] = [
        "recipeId",
        "version",
        "positivePrompt",
        "negativePrompt",
        "checkpoint",
        "seed",
        "width",
        "height",
        "steps",
        "cfg",
        "sampler",
        "scheduler",
        "outputPrefix",
    ];
    let fields = &FIELDS;
    let object = i.as_object().ok_or("Expected a diagnostic intent object")?;
    if object.len() != fields.len() || fields.iter().any(|key| !object.contains_key(*key)) {
        return Err("Missing or unknown diagnostic intent fields".into());
    }
    if i["recipeId"] != "checkpoint-text-to-image-diagnostic" || i["version"].as_f64() != Some(1.0)
    {
        return Err("Unsupported diagnostic recipe or version".into());
    }
    for field in ["positivePrompt", "negativePrompt"] {
        if !i[field]
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() <= 16384 && !s.contains('\0'))
        {
            return Err(format!(
                "Invalid {field}: maximum 16384 UTF-16 units, no NUL"
            ));
        }
    }
    if !i["checkpoint"]
        .as_str()
        .is_some_and(|s| s.len() <= 255 && safe_path(s, false))
    {
        return Err("Unsafe checkpoint identifier".into());
    }
    for (field, min, max, integer, alignment) in [
        ("seed", 0.0, 9_007_199_254_740_991.0, true, 1.0),
        ("width", 64.0, 2048.0, true, 8.0),
        ("height", 64.0, 2048.0, true, 8.0),
        ("steps", 1.0, 150.0, true, 1.0),
        ("cfg", 0.0, 30.0, false, 1.0),
    ] {
        if !i[field].as_f64().is_some_and(|n| {
            n.is_finite() && n >= min && n <= max && (!integer || n % alignment == 0.0)
        }) {
            return Err(format!("Invalid diagnostic {field}"));
        }
    }
    if !["euler", "euler_ancestral", "dpmpp_2m"]
        .iter()
        .any(|s| i["sampler"] == *s)
        || !["normal", "karras", "simple"]
            .iter()
            .any(|s| i["scheduler"] == *s)
    {
        return Err("Unsupported sampler or scheduler".into());
    }
    if !i["outputPrefix"].as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    }) {
        return Err("Unsafe output prefix".into());
    }
    Ok(json!({
        "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":i["checkpoint"]}},
        "2":{"class_type":"CLIPTextEncode","inputs":{"text":i["positivePrompt"],"clip":["1",1]}},
        "3":{"class_type":"CLIPTextEncode","inputs":{"text":i["negativePrompt"],"clip":["1",1]}},
        "4":{"class_type":"EmptyLatentImage","inputs":{"width":i["width"],"height":i["height"],"batch_size":1}},
        "5":{"class_type":"KSampler","inputs":{"model":["1",0],"positive":["2",0],"negative":["3",0],"latent_image":["4",0],"seed":i["seed"],"steps":i["steps"],"cfg":i["cfg"],"sampler_name":i["sampler"],"scheduler":i["scheduler"],"denoise":1}},
        "6":{"class_type":"VAEDecode","inputs":{"samples":["5",0],"vae":["1",2]}},
        "7":{"class_type":"SaveImage","inputs":{"images":["6",0],"filename_prefix":i["outputPrefix"]}}
    }))
}

fn safe_path(s: &str, empty: bool) -> bool {
    (empty && s.is_empty())
        || s.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        })
}

impl Jobs {
    fn current(&self) -> Result<Value, String> {
        Ok(self
            .lock()?
            .job
            .as_ref()
            .map(Job::snapshot)
            .unwrap_or(Value::Null))
    }

    fn lock(&self) -> Result<MutexGuard<'_, Session>, String> {
        self.0
            .lock()
            .map_err(|_| "Native job state unavailable".into())
    }

    async fn prepare(&self, base_url: String, intent: Value) -> Result<Value, String> {
        let base = crate::validate_base_url(&base_url)?;
        let graph = compile(&intent)?;
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut session = self.lock()?;
            if session.job.as_ref().is_some_and(|j| !j.terminal()) {
                return Err("An in-flight or unknown native job must not be replaced".into());
            }
            session.plan = None;
            session.preparing = Some(id.clone());
        }
        let prerequisites =
            crate::recipe_prerequisites::native_recipe_prerequisites(base.to_string()).await?;
        let allow = &prerequisites["allowlist"];
        for (field, required) in [
            ("nodes", REQUIRED_NODES.to_vec()),
            ("checkpoints", vec![intent["checkpoint"].as_str().unwrap()]),
            ("samplers", vec![intent["sampler"].as_str().unwrap()]),
            ("schedulers", vec![intent["scheduler"].as_str().unwrap()]),
        ] {
            let available = allow[field]
                .as_array()
                .ok_or("Malformed native prerequisites")?;
            if required
                .iter()
                .any(|name| !available.iter().any(|v| v.as_str() == Some(*name)))
            {
                return Err(format!(
                    "Diagnostic {field} are not available on this backend"
                ));
            }
        }
        let plan = Plan {
            id: id.clone(),
            base,
            intent,
            graph,
            consumed: false,
        };
        let mut session = self.lock()?;
        if session.preparing.as_deref() != Some(id.as_str()) {
            return Err("Diagnostic preparation was superseded".into());
        }
        session.preparing = None;
        let snapshot = plan.snapshot();
        session.plan = Some(plan);
        Ok(snapshot)
    }

    async fn submit(&self, plan_id: String, confirmed: bool) -> Result<Value, String> {
        if !confirmed {
            return Err("Explicit diagnostic submission confirmation is required".into());
        }
        let client = client()?;
        // Consume before the first await: a lost response must never authorize a retry.
        let mut job = {
            let mut session = self.lock()?;
            if session.job.as_ref().is_some_and(|j| !j.terminal()) {
                return Err("A native job is already in flight or unknown".into());
            }
            let plan = session
                .plan
                .as_mut()
                .filter(|p| p.id == plan_id)
                .ok_or("Unknown or stale native plan")?;
            if plan.consumed {
                return Err("This native plan was already submitted; retries are forbidden".into());
            }
            plan.consumed = true;
            let job = Job {
                id: uuid::Uuid::new_v4().to_string(),
                plan: plan.clone(),
                client_id: uuid::Uuid::new_v4().to_string(),
                prompt_id: None,
                state: "unknown",
                outputs: vec![],
                error: Some("Submission in progress; do not retry".into()),
                submitting: true,
                polling: false,
            };
            session.output = None;
            session.job = Some(job.clone());
            job
        };
        let result = request(
            &client,
            &job.plan.base,
            "prompt",
            Some(json!({"prompt":job.plan.graph,"client_id":job.client_id})),
        )
        .await;
        match result {
            Ok((status, value)) => {
                let rejected = value.get("error").is_some_and(|e| !e.is_null())
                    || value["node_errors"]
                        .as_object()
                        .is_some_and(|e| !e.is_empty());
                if (status.is_success() || status == reqwest::StatusCode::BAD_REQUEST) && rejected {
                    job.state = "failed";
                    job.error = Some(bounded(&format!(
                        "Backend rejected diagnostic: error={}, node_errors={}",
                        value["error"], value["node_errors"]
                    )));
                } else if status.is_success()
                    && value["node_errors"]
                        .as_object()
                        .is_some_and(|e| e.is_empty())
                    && value["number"]
                        .as_f64()
                        .is_some_and(|n| n.is_finite() && n >= 0.0)
                    && value["prompt_id"].as_str().is_some_and(canonical_uuid)
                {
                    job.prompt_id = value["prompt_id"].as_str().map(str::to_owned);
                    job.state = "queued";
                    job.error = None;
                } else {
                    job.unknown(format!(
                        "Unrecognized submission reply (HTTP {status}); do not retry"
                    ));
                }
            }
            Err(error) => job.unknown(error),
        }
        job.submitting = false;
        let result = job.snapshot();
        self.lock()?.job = Some(job);
        Ok(result)
    }

    async fn status(&self, job_id: String) -> Result<Value, String> {
        let mut job = {
            let mut session = self.lock()?;
            let job = session
                .job
                .as_mut()
                .filter(|j| j.id == job_id)
                .ok_or("Unknown native job")?;
            if job.terminal() || job.submitting || job.polling || job.prompt_id.is_none() {
                return Ok(job.snapshot());
            }
            job.polling = true;
            job.clone()
        };
        let result = tokio::time::timeout(Duration::from_secs(15), poll(&mut job)).await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => job.unknown(error),
            Err(_) => job.unknown("Native job status deadline exceeded".into()),
        }
        job.polling = false;
        let mut session = self.lock()?;
        let current = session
            .job
            .as_mut()
            .filter(|j| j.id == job_id)
            .ok_or("Native job changed during status request")?;
        *current = job;
        Ok(current.snapshot())
    }
}

fn canonical_uuid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
}

fn correlate(tuple: &Value, job: &Job) -> Result<(), String> {
    let tuple = tuple
        .as_array()
        .filter(|t| (5..=6).contains(&t.len()))
        .ok_or("Malformed backend prompt tuple")?;
    if !tuple[0].as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)
        || tuple[1].as_str() != job.prompt_id.as_deref()
        || tuple[2] != job.plan.graph
        || tuple[3]["client_id"].as_str() != Some(job.client_id.as_str())
        || !tuple[4]
            .as_array()
            .is_some_and(|v| v.iter().all(Value::is_string))
    {
        return Err("Backend prompt/client/graph correlation failed; foreign job refused".into());
    }
    Ok(())
}

fn outputs(entry: &Value) -> Result<Vec<Value>, String> {
    let all = entry["outputs"]
        .as_object()
        .ok_or("Malformed history outputs")?;
    let Some(node) = all.get("7") else {
        return Ok(vec![]);
    };
    let images = node["images"]
        .as_array()
        .ok_or("Malformed diagnostic image outputs")?;
    if images.len() > 64 {
        return Err("Too many diagnostic image outputs".into());
    }
    images
        .iter()
        .map(|image| {
            let filename = image["filename"]
                .as_str()
                .ok_or("Missing output filename")?;
            let subfolder = image["subfolder"]
                .as_str()
                .ok_or("Missing output subfolder")?;
            if filename.len() > 255
                || filename.contains('/')
                || !safe_path(filename, false)
                || subfolder.len() > 255
                || !safe_path(subfolder, true)
                || image["type"] != "output"
            {
                return Err("Unsafe diagnostic output reference".into());
            }
            Ok(json!({"filename":filename,"subfolder":subfolder,"type":"output"}))
        })
        .collect()
}

async fn poll(job: &mut Job) -> Result<(), String> {
    let client = client()?;
    let prompt_id = job.prompt_id.as_deref().ok_or("No correlated prompt ID")?;
    let history = get(&client, &job.plan.base, &format!("history/{prompt_id}")).await?;
    let entries = history.as_object().ok_or("Malformed backend history")?;
    if entries.keys().any(|id| id != prompt_id) {
        return Err("Foreign prompt in backend history".into());
    }
    if let Some(entry) = entries.get(prompt_id) {
        correlate(&entry["prompt"], job)?;
        let status = &entry["status"];
        let completed = status["completed"]
            .as_bool()
            .ok_or("Missing history completion flag")?;
        let messages = status["messages"]
            .as_array()
            .ok_or("Malformed history status messages")?;
        match status["status_str"].as_str() {
            Some("error") => {
                job.state = "failed";
                let diagnostic = messages
                    .iter()
                    .find(|m| m[0] == "execution_error")
                    .map(|m| {
                        format!(
                            "node {} ({}): {}: {}",
                            m[1]["node_id"],
                            m[1]["node_type"],
                            m[1]["exception_type"],
                            m[1]["exception_message"]
                        )
                    })
                    .unwrap_or_else(|| "Backend reported diagnostic execution error".into());
                job.error = Some(bounded(&diagnostic));
                job.outputs.clear();
                return Ok(());
            }
            Some("success") if completed => {
                let images = outputs(entry)?;
                if images.is_empty() {
                    return Err("Completed history has no diagnostic image output".into());
                }
                job.outputs = images;
                job.state = "succeeded";
                job.error = None;
                return Ok(());
            }
            Some("success") => {}
            _ => return Err("Malformed history execution status".into()),
        }
    }
    let queue = get(&client, &job.plan.base, "queue").await?;
    let mut found = None;
    for (field, state) in [("queue_running", "running"), ("queue_pending", "queued")] {
        let entries = queue[field].as_array().ok_or("Malformed backend queue")?;
        for tuple in entries {
            if tuple.get(1).and_then(Value::as_str) == job.prompt_id.as_deref() {
                correlate(tuple, job)?;
                if found.is_some() {
                    return Err("Duplicate prompt ID in backend queue".into());
                }
                found = Some(state);
            }
        }
    }
    job.state =
        found.ok_or("Correlated prompt absent from history and queue; execution unknown")?;
    job.error = None;
    job.outputs.clear();
    Ok(())
}

#[tauri::command]
pub async fn native_job_prepare(
    state: tauri::State<'_, Jobs>,
    base_url: String,
    intent: Value,
) -> Result<Value, String> {
    state.prepare(base_url, intent).await
}
#[tauri::command]
pub async fn native_job_submit(
    state: tauri::State<'_, Jobs>,
    plan_id: String,
    confirmed: bool,
) -> Result<Value, String> {
    state.submit(plan_id, confirmed).await
}
#[tauri::command]
pub async fn native_job_status(
    state: tauri::State<'_, Jobs>,
    job_id: String,
) -> Result<Value, String> {
    state.status(job_id).await
}

/// Read the last native session job without contacting or adopting a backend.
#[tauri::command]
pub fn native_job_current(state: tauri::State<'_, Jobs>) -> Result<Value, String> {
    state.current()
}

#[cfg(test)]
#[path = "jobs_tests.rs"]
mod tests;
