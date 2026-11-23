//! Director *Create RefMod*: one isolated `DaSiWaH3RefModExport` prompt per request. It is never a
//! Workbench job, so it cannot enter generation history, the queue view or Stop all; the node itself
//! checks interruption before it writes and never overwrites an existing archive.
use super::*;
use std::path::Path;

const CONCEPTS: [&str; 5] = ["generic", "identity", "style", "motion", "audio"];
const OUTPUT: &str = "refmod";

/// Empty = the node picks a unique `director-<uuid>` name. Stricter than the node's own check on purpose.
fn bundle_name(n: &str) -> bool {
    n.is_empty()
        || (n.chars().count() <= 120
            && n == n.trim()
            && !n.starts_with('.')
            && !n.ends_with('.')
            && n.chars()
                .all(|c| c.is_alphanumeric() || " -_.()".contains(c)))
}

fn text(v: Option<&Value>, max: usize) -> Result<String, String> {
    match v {
        None => Ok(String::new()),
        Some(Value::String(s)) if s.chars().count() <= max => Ok(s.clone()),
        _ => Err(format!(
            "RefMod text fields must be strings of at most {max} characters"
        )),
    }
}

fn prompt_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Which VAE lanes a selection needs, read the same way by `compile()` and by the default resolver: a
/// picture or a video carrying picture content needs the video VAE, sound (its own file or a video's
/// audio) needs the audio VAE.
fn lane_flags(media: &[Value]) -> (bool, bool) {
    let mode = |m: &Value| m["mediaMode"].as_str().unwrap_or("video").to_owned();
    (
        media
            .iter()
            .any(|m| m["type"] == "image" || (m["type"] == "video" && mode(m) != "audio")),
        media
            .iter()
            .any(|m| m["type"] == "audio" || (m["type"] == "video" && mode(m) != "video")),
    )
}

/// `request`: `{name?, description?, conceptType?, media:[H3 media item + description?], refmods:[name], vae?, audioVae?}`.
pub(crate) fn compile(r: &Value, request_id: &str) -> Result<Value, String> {
    let o = r.as_object().ok_or("Invalid RefMod request")?;
    let known = [
        "name",
        "description",
        "conceptType",
        "media",
        "refmods",
        "vae",
        "audioVae",
    ];
    if o.keys().any(|k| !known.contains(&k.as_str())) {
        return Err("Unknown RefMod request field".into());
    }
    let name = text(o.get("name"), 120)?;
    if !bundle_name(&name) {
        return Err(
            "RefMod name: letters, digits, space, - _ . ( ) only, no leading/trailing dot or space"
                .into(),
        );
    }
    let description = text(o.get("description"), 4000)?;
    let concept = o
        .get("conceptType")
        .map_or(Some("generic"), Value::as_str)
        .unwrap_or_default();
    if !CONCEPTS.contains(&concept) {
        return Err("Invalid RefMod concept type".into());
    }
    let media = o
        .get("media")
        .and_then(Value::as_array)
        .ok_or("RefMod media must be an array")?;
    let rows = o
        .get("refmods")
        .and_then(Value::as_array)
        .ok_or("RefMod refmods must be an array")?;
    if media.is_empty() && rows.is_empty() {
        return Err("Select at least one reference or saved RefMod".into());
    }
    if rows.len() > 8 || !rows.iter().all(|n| n.as_str().is_some_and(model_name)) {
        return Err("Saved RefMods: up to 8 library names".into());
    }
    // Same item contract (deas-inputs/ files, lanes, modes, trims) as a REF2VA run; descriptions ride along.
    let mut plain = Vec::with_capacity(media.len());
    let mut descriptions = Vec::with_capacity(media.len());
    for m in media {
        let mut item = m.clone();
        let described = item
            .as_object_mut()
            .ok_or("Invalid RefMod media item")?
            .remove("description");
        descriptions.push(text(described.as_ref(), 2000)?);
        plain.push(item);
    }
    crate::jobs_video::validate_h3_media(&json!(plain), true, true)?;
    let (visual, audio) = lane_flags(&plain);
    // Both separator forms are valid input (see `comfy_model_name`) and the value is forwarded to the
    // graph unchanged: this backend matches its `VAELoader` enum exactly and lists `Minimax\file`.
    let vae = |key: &str| {
        o.get(key)
            .and_then(Value::as_str)
            .filter(|v| comfy_model_name(v))
    };
    let mut inputs = json!({"request_id":request_id,"name":name,"description":description,"concept_type":concept});
    let mut graph = json!({});
    for (needed, key, input, node) in [
        (visual, "vae", "vae", "V"),
        (audio, "audioVae", "audio_vae", "AV"),
    ] {
        if !needed {
            continue;
        }
        let file = vae(key).ok_or(if key == "vae" {
            "Video references need the MiniMax H3 video VAE"
        } else {
            "Audio references need the MiniMax H3 audio VAE"
        })?;
        graph[node] = json!({"class_type":"VAELoader","inputs":{"vae_name":file}});
        inputs[input] = json!([node, 0]);
    }
    // Director item contract, as in the REF2VA timeline: value = input-relative file, trims in seconds.
    let items: Vec<Value> = plain
        .iter()
        .zip(descriptions)
        .enumerate()
        .map(|(n, (m, description))| {
            let mut item = json!({"id":format!("m{n}"),"type":m["type"],"value":m["file"],"enabled":true,"description":description});
            for (from, to) in [("mediaMode", "media_mode"), ("trimStart", "trim_start"), ("trimEnd", "trim_end")] {
                if let Some(v) = m.get(from) {
                    item[to] = v.clone();
                }
            }
            item
        })
        .collect();
    let refmods: Vec<Value> = rows.iter().map(|n| json!({"name":n})).collect();
    inputs["timeline_data"] = json!(json!({"items":items,"refmods":refmods}).to_string());
    graph[OUTPUT] = json!({"class_type":"DaSiWaH3RefModExport","inputs":inputs});
    Ok(graph)
}

fn log(line: &str) {
    crate::logs::push(crate::logs::Source::Deas, line);
}

/// Prompts this app queued: status/cancel act only on these, with the exact graph the owned adapter verifies.
struct Submitted {
    prompt_id: String,
    base: reqwest::Url,
    client_id: String,
    graph: Value,
    active: bool,
}
static SUBMITTED: Mutex<Vec<Submitted>> = Mutex::new(Vec::new());

/// The exports this process currently holds (LEG AF2-M24b, owner law E28 — a
/// visibility-only read of the ledger for the drain's correlation law; nothing
/// here mutates, reorders or releases an entry, and no stock path calls it).
/// One name per ACTIVE entry: the minted backend prompt id once submit yielded
/// one, else the reserved `deas-refmod-<uuid>` client id — a reserved-but-
/// unanswered POST holds the backend queue exactly as `with_idle_media_edit`
/// already assumes, and naming the client id still gives the operator
/// something to find in the queue.
pub(crate) fn active_exports() -> Vec<String> {
    SUBMITTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|entry| entry.active)
        .map(|entry| {
            if entry.prompt_id.is_empty() {
                entry.client_id.clone()
            } else {
                entry.prompt_id.clone()
            }
        })
        .collect()
}

pub(crate) fn with_idle_media_edit<T>(
    edit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let submitted = SUBMITTED
        .lock()
        .map_err(|_| "RefMod ownership lock failed")?;
    if submitted.iter().any(|entry| entry.active) {
        return Err("Wait for RefMod exports to finish and check their status before deleting media; an uncertain submission requires checking the backend queue before restarting DEAS".into());
    }
    edit()
}

fn release_media(base: &reqwest::Url, id: &str) {
    if let Some(entry) = SUBMITTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter_mut()
        .find(|entry| &entry.base == base && entry.prompt_id == id)
    {
        entry.active = false;
    }
}

fn submitted(base: &reqwest::Url, prompt_id: &str) -> Result<(String, Value), String> {
    SUBMITTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|s| s.prompt_id == prompt_id && &s.base == base)
        .map(|s| (s.client_id.clone(), s.graph.clone()))
        .ok_or_else(|| "Unknown RefMod export".into())
}

/// The VAE names the backend advertises in its `VAELoader` combo.
fn advertised_vaes(v: &Value) -> Vec<String> {
    v["VAELoader"]["input"]["required"]["vae_name"][0]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// Default H3 VAE for one lane out of the advertised names, so nobody has to name them by hand. Only
/// MiniMax H3 VAEs qualify and lanes never cross: `LTX2/video_vae.safetensors` is another family, and
/// `taeh3.safetensors` carries the same `h3` token while being a preview decoder. Inside a lane a
/// `video` name wins, then the shortest name, then A-Z bytewise.
fn pick_h3_vae(catalog: &[String], want_audio: bool) -> Option<String> {
    catalog
        .iter()
        .filter_map(|name| {
            let lower = name.to_lowercase();
            let base = lower.rsplit(['/', '\\']).next().unwrap_or(lower.as_str());
            if !lower.contains("h3") || lower.contains("taeh3") || base.starts_with("tae") {
                return None;
            }
            (lower.contains("audio") == want_audio).then(|| {
                (
                    if lower.contains("video") { 0 } else { 1 },
                    name.len(),
                    name.as_str(),
                )
            })
        })
        .min()
        .map(|(_, _, name)| name.to_owned())
}

/// Whether the id is acceptable, and acceptable **in the form it arrives in**. ComfyUI matches a combo
/// value exactly, and a Windows backend lists `Minimax\file`, so the rule is the repo's own
/// (`comfy_model_name`): validate both separators, forward the exact ID. Rewriting `\` to `/` here used to
/// satisfy `compile()` and then fail the backend's enum check with "not in […\…]".
fn loadable(name: &str) -> Option<String> {
    let trimmed = name.trim();
    comfy_model_name(trimmed).then(|| trimmed.to_owned())
}

/// The VAE files the configured model folders already hold, named exactly as the backend on this machine
/// lists them (`Minimax\file` on Windows). The model library does not have to be scanned and the backend
/// does not have to be running: these are the folders `deas-settings.json` points at, walked through the
/// same category map that writes `deas-models.yaml` (so `vae_approx` also sees `vae`, where the tiny
/// decoders live).
fn disk_vaes(models: &Path) -> Vec<String> {
    let mut found = Vec::new();
    for (category, dir) in crate::settings::model_locations(models) {
        if category != "vae" && category != "vae_approx" {
            continue;
        }
        collect_vaes(&dir, &dir, 0, &mut found);
    }
    found.sort();
    found.dedup();
    found
}

/// One model folder, bounded: 4 levels deep and 512 files, so a misconfigured root can never turn a RefMod
/// click into a walk of the drive. Sidecars (`.deas.json`) are not models and never match.
fn collect_vaes(root: &Path, dir: &Path, depth: usize, found: &mut Vec<String>) {
    if depth > 3 || found.len() >= 512 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            collect_vaes(root, &path, depth + 1, found);
            continue;
        }
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !["safetensors", "sft", "ckpt", "pt", "pth", "gguf", "bin"].contains(&extension.as_str())
        {
            continue;
        }
        if let Ok(relative) = path.strip_prefix(root) {
            // Relative to the category folder, native separators: folder_paths values are exactly what is
            // on disk, and the prompt is validated against that list.
            found.push(relative.to_string_lossy().into_owned());
        }
    }
}

/// One lane's default and where it came from. The running backend goes first because its combo is what the
/// prompt is validated against; the folders on disk are the fallback, so a backend that is simply not
/// started never reports itself as a missing VAE.
fn resolve_lane(
    combo: &[String],
    disk: &[String],
    want_audio: bool,
) -> Option<(&'static str, String)> {
    pick_h3_vae(combo, want_audio)
        .map(|name| ("backend", name))
        .or_else(|| pick_h3_vae(disk, want_audio).map(|name| ("library", name)))
}

/// Why a lane stayed empty, in the words an operator needs: which sources were consulted and found nothing.
fn unresolved_reason(backend_unreachable: bool, models: Option<&Path>) -> String {
    let backend = if backend_unreachable {
        "backend not reachable"
    } else {
        "no MiniMax H3 file in the backend's VAE list"
    };
    match models {
        Some(dir) => format!("{backend}; none under {} either", dir.display()),
        None => format!("{backend}; no configured models folder was supplied"),
    }
}

/// Fills the lanes `compile()` would refuse on with the library's own H3 VAEs before it runs. An explicit
/// choice always wins; when neither source can name a file the request is left untouched so `compile()`
/// reports its existing reason, and every outcome is written to central Logs.
async fn fill_h3_vaes(base: &reqwest::Url, mut request: Value, models: Option<&Path>) -> Value {
    let (visual, audio) = request
        .as_object()
        .and_then(|o| o.get("media"))
        .and_then(Value::as_array)
        .map(|media| lane_flags(media))
        .unwrap_or((false, false));
    let lane = |want_audio: bool| if want_audio { "audio" } else { "video" };
    let mut combo: Option<Vec<String>> = None;
    let mut disk: Option<Vec<String>> = None;
    let mut unreachable = false;
    for (key, want_audio, needed) in [("vae", false, visual), ("audioVae", true, audio)] {
        if !needed {
            continue;
        }
        // An explicit choice always wins, carried in the exact form the app showed the user - the backend
        // matches its combo value character for character, so nothing here rewrites it.
        if let Some(given) = request.get(key).and_then(Value::as_str) {
            if !given.trim().is_empty() {
                if loadable(given).is_none() {
                    log(&format!(
                        "WARN: RefMod {} VAE {given} is not a loadable model id",
                        lane(want_audio)
                    ));
                }
                continue;
            }
        }
        if combo.is_none() {
            combo = Some(
                match request_json(base, "object_info/VAELoader", None).await {
                    Ok((status, v)) if status.is_success() => advertised_vaes(&v),
                    _ => {
                        unreachable = true;
                        Vec::new()
                    }
                },
            );
        }
        if disk.is_none() {
            disk = Some(models.map(disk_vaes).unwrap_or_default());
        }
        let Some((source, found)) =
            resolve_lane(combo.as_ref().unwrap(), disk.as_ref().unwrap(), want_audio)
        else {
            log(&format!(
                "WARN: RefMod {} VAE unresolved: {}",
                lane(want_audio),
                unresolved_reason(unreachable, models)
            ));
            continue;
        };
        let Some(name) = loadable(&found) else {
            log(&format!(
                "WARN: RefMod {} VAE resolved to {found}, which is not a loadable model id",
                lane(want_audio)
            ));
            continue;
        };
        log(&format!(
            "INFO: RefMod {} VAE resolved from {source}: {name}",
            lane(want_audio)
        ));
        if let Some(o) = request.as_object_mut() {
            o.insert(key.to_owned(), json!(name));
        }
    }
    request
}

/// Queue the export; the prompt runs in the backend's normal queue.
#[tauri::command]
pub async fn native_h3_refmod_submit(
    base_url: String,
    request: Value,
    models_dir: Option<String>,
) -> Result<Value, String> {
    let base = crate::validate_base_url(&base_url)?;
    let request = fill_h3_vaes(&base, request, models_dir.as_deref().map(Path::new)).await;
    let graph = compile(&request, &uuid::Uuid::new_v4().to_string())?;
    let client_id = format!("deas-refmod-{}", uuid::Uuid::new_v4());
    // Reserve before POST: a lost reply is not evidence the backend rejected the job.
    {
        let mut list = SUBMITTED
            .lock()
            .map_err(|_| "RefMod ownership lock failed")?;
        if list.len() >= 16 {
            let index = list
                .iter()
                .position(|entry| !entry.active)
                .ok_or("Check pending RefMod exports before submitting another")?;
            list.remove(index);
        }
        list.push(Submitted {
            prompt_id: String::new(),
            base: base.clone(),
            client_id: client_id.clone(),
            graph: graph.clone(),
            active: true,
        });
    }
    let (status, v) = request_json(
        &base,
        "prompt",
        Some(json!({"prompt":graph,"client_id":client_id})),
    )
    .await.inspect_err(|_| {
        log(&format!("ERROR: RefMod export operation=submit job={client_id} reply uncertain; media deletion remains blocked until backend ownership is reconciled"));
    })?;
    let id = v["prompt_id"].as_str().filter(|id| prompt_id(id));
    match (status.is_success(), id) {
        (true, Some(id)) => {
            let mut list = SUBMITTED.lock().unwrap_or_else(|e| e.into_inner());
            let entry = list
                .iter_mut()
                .find(|entry| entry.client_id == client_id)
                .ok_or("RefMod ownership reservation lost")?;
            entry.prompt_id = id.to_owned();
            log(&format!("INFO: RefMod export queued: prompt={id}"));
            Ok(json!({"promptId":id}))
        }
        _ => {
            // A successful HTTP reply without an id remains uncertain and must keep its reservation.
            if !status.is_success() {
                SUBMITTED
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .retain(|entry| entry.client_id != client_id);
            }
            let reason = bounded(&rejection(&v));
            log(&format!(
                "ERROR: RefMod export rejected (HTTP {status}): {reason}"
            ));
            Err(format!("RefMod export rejected: {reason}"))
        }
    }
}

/// ComfyUI names the failing node (missing DaSiWa pack, unknown VAE) in `error` + `node_errors`.
fn rejection(v: &Value) -> String {
    let Some(message) = v["error"]["message"].as_str() else {
        return v.to_string();
    };
    let nodes: Vec<&str> = v["node_errors"]
        .as_object()
        .into_iter()
        .flat_map(|n| n.values())
        .flat_map(|e| e["errors"].as_array().into_iter().flatten())
        .filter_map(|e| {
            e["details"]
                .as_str()
                .filter(|d| !d.is_empty())
                .or(e["message"].as_str())
        })
        .collect();
    if nodes.is_empty() {
        message.to_owned()
    } else {
        format!("{message}: {}", nodes.join("; "))
    }
}

async fn request_json(
    base: &reqwest::Url,
    path: &str,
    body: Option<Value>,
) -> Result<(reqwest::StatusCode, Value), String> {
    request(&client()?, base, path, body).await
}

/// Where the prompt is in the backend queue: `running`, `queued` or neither.
fn queued_state(queue: &Value, id: &str) -> Option<&'static str> {
    let has = |key: &str| {
        queue[key]
            .as_array()
            .is_some_and(|a| a.iter().any(|e| e[1] == id))
    };
    if has("queue_running") {
        Some("running")
    } else if has("queue_pending") {
        Some("queued")
    } else {
        None
    }
}

fn history_state(entry: &Value) -> Option<Value> {
    let failure = entry["status"]["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|m| {
            let kind = m[0].as_str()?;
            ["execution_error", "execution_interrupted"]
                .contains(&kind)
                .then_some((kind, &m[1]))
        });
    if let Some((kind, detail)) = failure {
        return Some(if kind == "execution_interrupted" {
            json!({"state":"cancelled"})
        } else {
            json!({"state":"failed","error":bounded(detail["exception_message"].as_str().unwrap_or("RefMod export failed"))})
        });
    }
    if let Some(r) = entry["outputs"][OUTPUT]["dasiwa_refmod_export"].get(0) {
        let name = r["name"].as_str().filter(|n| model_name(n));
        let members = r["members"].as_u64().filter(|n| (1..=256).contains(n));
        let count = |k: &str| r["counts"][k].as_u64().unwrap_or(0);
        return Some(match (name, members) {
            (Some(name), Some(members)) => {
                json!({"state":"done","result":{"name":name,"members":members,
                "counts":{"image":count("image"),"video":count("video"),"audio":count("audio")},
                "warnings":r["warnings"].as_array().into_iter().flatten().filter_map(Value::as_str).take(32).map(bounded).collect::<Vec<_>>()}})
            }
            _ => json!({"state":"failed","error":"RefMod export returned an invalid result"}),
        });
    }
    (entry["status"]["completed"] == true || entry["status"]["status_str"] == "error").then(|| {
        json!({"state":"failed","error":"RefMod export finished without a saved result; check the backend log"})
    })
}

/// `queued` | `running` | `done` (+result) | `failed` (+error) | `cancelled` | `missing` (left the queue without history).
#[tauri::command]
pub async fn native_h3_refmod_status(base_url: String, prompt_id: String) -> Result<Value, String> {
    let base = crate::validate_base_url(&base_url)?;
    submitted(&base, &prompt_id)?;
    let history = get(&client()?, &base, &format!("history/{prompt_id}")).await?;
    if let Some(state) = history.get(&prompt_id).and_then(history_state) {
        release_media(&base, &prompt_id);
        let detail = match state["state"].as_str() {
            Some("done") => format!(
                "INFO: RefMod export saved: {}.safetensors ({} members)",
                state["result"]["name"].as_str().unwrap_or_default(),
                state["result"]["members"]
            ),
            Some("failed") => format!(
                "ERROR: RefMod export failed: prompt={prompt_id}; {}",
                state["error"].as_str().unwrap_or_default()
            ),
            _ => format!("INFO: RefMod export cancelled: prompt={prompt_id}"),
        };
        log(&detail);
        return Ok(state);
    }
    let queue = get(&client()?, &base, "queue").await?;
    if !["queue_running", "queue_pending"].iter().all(|key| {
        queue[*key]
            .as_array()
            .is_some_and(|entries| entries.iter().all(|entry| entry[1].as_str().is_some()))
    }) {
        return Err("Invalid RefMod queue reply; media ownership remains active".into());
    }
    let state = queued_state(&queue, &prompt_id).unwrap_or("missing");
    if state == "missing" {
        release_media(&base, &prompt_id);
    }
    Ok(json!({"state":state}))
}

/// Scoped to this app's own prompt on the owned backend: a pending one is deleted, a running one goes through
/// the authenticated DEAS interrupt adapter, which re-checks prompt, client and graph. Never core `/interrupt`.
#[tauri::command]
pub async fn native_h3_refmod_cancel(
    engine: tauri::State<'_, crate::install::Engine>,
    base_url: String,
    prompt_id: String,
) -> Result<Value, String> {
    let base = crate::validate_base_url(&base_url)?;
    let (client_id, graph) = submitted(&base, &prompt_id)?;
    let queue = get(&client()?, &base, "queue").await?;
    let Some(state) = queued_state(&queue, &prompt_id) else {
        return Ok(json!({"cancelled":"none"}));
    };
    let http = client()?;
    let request = if state == "queued" {
        engine.backend.cancellation_owner()(&base)?;
        http.post(base.join("queue").map_err(|_| "Invalid backend endpoint")?)
            .json(&json!({"delete":[prompt_id]}))
    } else {
        let (_, token) = engine.backend.interruption_owner()(&base)?;
        let mut header = reqwest::header::HeaderValue::from_str(&token)
            .map_err(|_| "Invalid native interruption authority")?;
        header.set_sensitive(true);
        http.post(
            base.join("deas/jobs/interrupt")
                .map_err(|_| "Invalid backend endpoint")?,
        )
        .header("X-DEAS-Interrupt-Token", header)
        .json(&json!({"prompt_id":prompt_id,"client_id":client_id,"prompt":graph}))
    };
    let status = request
        .send()
        .await
        .map_err(|_| "RefMod cancel reply lost; check the queue")?
        .status();
    if !status.is_success() {
        return Err(format!("RefMod cancel rejected (HTTP {})", status.as_u16()));
    }
    log(&format!(
        "INFO: RefMod export cancel requested: prompt={prompt_id}; {state}"
    ));
    Ok(json!({"cancelled":state}))
}

#[cfg(test)]
#[path = "jobs_refmod_tests.rs"]
mod tests;
