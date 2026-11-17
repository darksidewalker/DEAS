//! Experimental Dial Rack presets (docs/DIALS.md): the node pack's own preset files, reached only
//! through the pack's routes on the backend (`/mainodes/dials/presets`), never through the models
//! folder. The pack validates, hashes the dial files and refuses to overwrite; DEAS lists, loads and
//! saves, and fails closed when the pack or the route is missing.
use super::{bounded, client, RESPONSE_LIMIT};
use serde_json::{json, Value};
use std::{sync::Mutex, time::Duration};

const ROUTE: &str = "mainodes/dials/presets";
/// The pack's `FORMAT` / `VERSION` (`dials/presets.py`).
const FORMAT: &str = "MAIDialRack preset";
const VERSION: u64 = 1;
/// Bound on what one preset may bring back; a rack DEAS can send holds 8 rows.
const LOADED_ROWS: usize = 64;
const LISTED: usize = 500;

#[derive(Clone, Copy)]
enum Failure {
    Endpoint,
    Name,
    Rows,
    Transport,
    Unavailable,
    NotFound,
    Exists,
    Refused,
    Http,
    Shape,
}

impl Failure {
    fn code(self) -> &'static str {
        match self {
            Failure::Endpoint => "DIAL_PRESETS_ENDPOINT",
            Failure::Name => "DIAL_PRESET_NAME",
            Failure::Rows => "DIAL_PRESET_ROWS",
            Failure::Transport => "DIAL_PRESETS_UNREACHABLE",
            Failure::Unavailable => "DIAL_PRESETS_UNAVAILABLE",
            Failure::NotFound => "DIAL_PRESET_NOT_FOUND",
            Failure::Exists => "DIAL_PRESET_EXISTS",
            Failure::Refused => "DIAL_PRESET_REFUSED",
            Failure::Http => "DIAL_PRESETS_FAILED",
            Failure::Shape => "DIAL_PRESETS_MALFORMED",
        }
    }
    fn diagnostic(self) -> &'static str {
        match self {
            Failure::Endpoint => "WARN: Dial presets {op}: invalid backend endpoint",
            Failure::Name => "WARN: Dial presets {op}: invalid preset name",
            Failure::Rows => "WARN: Dial presets {op}: rows outside what DEAS sends",
            Failure::Transport => "ERROR: Dial presets {op}: backend request failed",
            Failure::Unavailable => {
                "WARN: Dial presets {op}: the backend has no rack preset route (pack not installed)"
            }
            Failure::NotFound => "WARN: Dial presets {op}: preset not found",
            Failure::Exists => "WARN: Dial presets {op}: preset already exists, nothing written",
            Failure::Refused => "WARN: Dial presets {op}: refused by the node pack",
            Failure::Http => "ERROR: Dial presets {op}: unexpected backend answer",
            Failure::Shape => "ERROR: Dial presets {op}: malformed response",
        }
    }
}

/// The pack's `core.NAME`: preset, dial and folder names.
fn preset_name(name: &str) -> bool {
    (1..=80).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Central Logs entry for a failed preset operation: origin, severity, operation and the preset
/// name (validated, so it is safe to print); never the URL or the backend's text. One slot per
/// cause: the first failure and its first repeat are immediate, further repeats once per minute.
fn fail(op: &str, name: Option<&str>, cause: Failure, detail: &str) -> String {
    static LAST: Mutex<[(Option<std::time::Instant>, u64); 10]> = Mutex::new([(None, 0); 10]);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    let (at, repeats) = &mut last[cause as usize];
    let recurring = at.is_some_and(|at| at.elapsed() < Duration::from_secs(60));
    let earlier = if recurring {
        *repeats = repeats.saturating_add(1);
        0
    } else {
        *at = Some(std::time::Instant::now());
        std::mem::take(repeats)
    };
    if *repeats <= 1 {
        let preset = name
            .filter(|n| preset_name(n))
            .map(|n| format!("; preset={n}"))
            .unwrap_or_default();
        crate::logs::push(
            crate::logs::Source::Deas,
            &format!(
                "{}{preset}; repeated={repeats}; repeats in the minute before={earlier} (further repeats limited to once per minute)",
                cause.diagnostic().replace("{op}", op)
            ),
        );
    }
    format!("{}: {detail}", cause.code())
}

/// One request to the pack's route. `Ok((status, json))`: `json` is `None` when the body is not
/// JSON (a backend without the route answers 404 with plain text).
async fn fetch(
    base: &reqwest::Url,
    path: &str,
    body: Option<&Value>,
) -> Result<(u16, Option<Value>), ()> {
    let url = base.join(path).map_err(|_| ())?;
    let client = client().map_err(|_| ())?;
    let request = match body {
        Some(body) => client.post(url).json(body),
        None => client.get(url),
    };
    let mut response = request
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| ())?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if chunk.len() > RESPONSE_LIMIT - bytes.len() {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, serde_json::from_slice(&bytes).ok()))
}

/// Sorts an answer of the pack's routes into success or one failure, with the text shown to the
/// person. The pack answers `{"error": reason}` with 400 (refused), 404 (no such preset) or 409
/// (name taken); a 404/405 without that shape means the route itself is not there.
async fn call(
    op: &str,
    name: Option<&str>,
    base_url: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    let base =
        crate::validate_base_url(base_url).map_err(|e| fail(op, name, Failure::Endpoint, &e))?;
    let (status, value) = fetch(&base, path, body).await.map_err(|()| {
        fail(
            op,
            name,
            Failure::Transport,
            "The backend did not answer the rack preset request",
        )
    })?;
    let reason = value
        .as_ref()
        .and_then(|v| v["error"].as_str())
        .map(|e| bounded(e).chars().take(300).collect::<String>());
    match (status, value, reason) {
        (200, Some(value), _) => Ok(value),
        (200, None, _) => Err(fail(op, name, Failure::Shape, "The backend's rack preset answer is not JSON")),
        (404, _, Some(reason)) if name.is_some() => Err(fail(op, name, Failure::NotFound, &reason)),
        (409, _, Some(reason)) => Err(fail(op, name, Failure::Exists, &reason)),
        (400, _, Some(reason)) => Err(fail(op, name, Failure::Refused, &reason)),
        (404 | 405, _, _) => Err(fail(op, name, Failure::Unavailable,
            "This backend has no rack preset route. It comes with the Dial Rack nodes (ComfyUI-Dials or ComfyUI-MAINodes), which DEAS does not install yet")),
        (status, _, _) => Err(fail(op, name, Failure::Http, &format!("The backend answered HTTP {status} to the rack preset request"))),
    }
}

/// `{preset: {format, version, rows}, warnings}` of the pack, reduced to bounded rows and the two
/// warnings the pack gives per row (file missing, tensors changed since the preset was saved).
fn preset_answer(v: &Value) -> Option<Value> {
    let preset = &v["preset"];
    let rows = preset["rows"].as_array()?;
    if preset["format"] != FORMAT
        || preset["version"].as_u64() != Some(VERSION)
        || rows.len() > LOADED_ROWS
        || !rows.iter().all(Value::is_object)
    {
        return None;
    }
    let warnings: Vec<Value> = v["warnings"]
        .as_array()?
        .iter()
        .filter_map(|w| {
            let row = w["row"].as_u64().filter(|n| (*n as usize) < rows.len())?;
            let reason = match w["reason"].as_str()? {
                "missing" => "missing",
                "sha256 mismatch" => "changed",
                _ => return None,
            };
            Some(json!({"row":row,"reason":reason}))
        })
        .collect();
    Some(json!({"rows":rows,"warnings":warnings}))
}

/// Names of the rack presets on the backend (`GET /mainodes/dials/presets`), read-only.
#[tauri::command]
pub async fn native_dial_presets(base_url: String) -> Result<Value, String> {
    let value = call("list", None, &base_url, ROUTE, None).await?;
    let names = value.as_array().ok_or_else(|| {
        fail(
            "list",
            None,
            Failure::Shape,
            "The backend's rack preset list is malformed",
        )
    })?;
    Ok(names
        .iter()
        .filter_map(Value::as_str)
        .filter(|n| preset_name(n))
        .take(LISTED)
        .collect())
}

/// One preset as the pack returns it (`GET /mainodes/dials/presets/{name}`): its rows untouched,
/// for Studio to convert and report on, and the pack's per-row warnings.
#[tauri::command]
pub async fn native_dial_preset_load(base_url: String, name: String) -> Result<Value, String> {
    if !preset_name(&name) {
        return Err(fail(
            "load",
            None,
            Failure::Name,
            "Preset names use letters, digits, '_' and '-' only (1 to 80)",
        ));
    }
    let value = call(
        "load",
        Some(&name),
        &base_url,
        &format!("{ROUTE}/{name}"),
        None,
    )
    .await?;
    preset_answer(&value).ok_or_else(|| {
        fail(
            "load",
            Some(&name),
            Failure::Shape,
            "The backend's rack preset is not a MAIDialRack preset v1 of at most 64 rows",
        )
    })
}

/// Saves rows under a new name (`POST /mainodes/dials/presets/{name}`). Only rows the compiler
/// accepts are sent, so a preset written by DEAS holds nothing DEAS cannot run. The pack creates the
/// file exclusively (an existing name answers 409 and nothing is written) and computes each row's
/// `sha256` from the dial file itself; DEAS sends none.
#[tauri::command]
pub async fn native_dial_preset_save(
    base_url: String,
    name: String,
    rows: Value,
) -> Result<Value, String> {
    if !preset_name(&name) {
        return Err(fail(
            "save",
            None,
            Failure::Name,
            "Preset names use letters, digits, '_' and '-' only (1 to 80)",
        ));
    }
    let list = rows
        .as_array()
        .filter(|r| (1..=crate::jobs_video::DIAL_ROWS).contains(&r.len()));
    let Some(list) = list else {
        return Err(fail(
            "save",
            Some(&name),
            Failure::Rows,
            "A preset holds 1 to 8 rows",
        ));
    };
    for row in list {
        crate::jobs_video::validate_dial_row(row)
            .map_err(|e| fail("save", Some(&name), Failure::Rows, &e))?;
    }
    let value = call(
        "save",
        Some(&name),
        &base_url,
        &format!("{ROUTE}/{name}"),
        Some(&rows),
    )
    .await?;
    let answer = preset_answer(&value).ok_or_else(|| {
        fail(
            "save",
            Some(&name),
            Failure::Shape,
            "The backend's answer to the save is malformed; check the preset list",
        )
    })?;
    crate::logs::push(
        crate::logs::Source::Deas,
        &format!(
            "INFO: Dial presets save: saved; preset={name}; rows={}",
            list.len()
        ),
    );
    Ok(answer)
}

#[cfg(test)]
#[path = "jobs_dial_presets_tests.rs"]
mod tests;
