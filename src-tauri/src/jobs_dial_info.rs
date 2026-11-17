//! Experimental dial info (docs/DIALS.md): what each dial file says about itself (side labels,
//! useful and overcook strengths, evidence, notes, per-pipeline measurements), read from the node
//! pack's catalog route on the backend (`GET /mainodes/dials/catalog`). Read-only. The answer is
//! reduced to the fields Studio shows, every text bounded and every number checked against the
//! compiler's limits; without the pack or the route the command fails closed and Studio keeps its
//! fallbacks.
use super::dial_presets::{fetch, NoAnswer};
use crate::jobs_video::{dial_file, DIAL_BLEND_STEPS, DIAL_LEVEL};
use serde_json::{json, Map, Value};
use std::{collections::HashSet, sync::Mutex, time::Duration};

const ROUTE: &str = "mainodes/dials/catalog";
/// Dials handed to Studio. The pack lists every file in `loras/dials/`; a rack holds 8 rows.
const LISTED: usize = 1000;
/// The pack's `core.check_dial_info` text limits (characters).
const DESCRIPTION: usize = 2000;
const LABEL: usize = 60;
const NOTES: usize = 500;
/// `model_family` is free text of the dial file's maker.
const FAMILY: usize = 64;
/// The pack's `INFO_EVIDENCE`, `INFO_KINDS`, `INFO_PIPELINES` and `KEY_SUFFIX` keys.
const EVIDENCE: [&str; 4] = ["creator", "one-seed", "multi-seed", "multi-scene"];
const KINDS: [&str; 7] = [
    "look", "light", "weather", "motion", "camera", "voice", "other",
];
const PIPELINES: [&str; 3] = ["t2v", "ref2v", "fl2v"];
const MODES: [&str; 2] = ["pre", "post"];

#[derive(Clone, Copy)]
enum Failure {
    Endpoint,
    Transport,
    TooLarge,
    Unavailable,
    Http,
    Shape,
    /// Not a failure of the call: some entries were left out of a readable catalog.
    LeftOut,
}

impl Failure {
    fn code(self) -> &'static str {
        match self {
            Failure::Endpoint => "DIAL_INFO_ENDPOINT",
            Failure::Transport => "DIAL_INFO_UNREACHABLE",
            Failure::TooLarge => "DIAL_INFO_TOO_LARGE",
            Failure::Unavailable => "DIAL_INFO_UNAVAILABLE",
            Failure::Http => "DIAL_INFO_FAILED",
            Failure::Shape => "DIAL_INFO_MALFORMED",
            Failure::LeftOut => "DIAL_INFO_LEFT_OUT",
        }
    }
    fn diagnostic(self) -> &'static str {
        match self {
            Failure::Endpoint => "WARN: Dial info catalog: invalid backend endpoint",
            Failure::Transport => "ERROR: Dial info catalog: backend request failed",
            Failure::TooLarge => "WARN: Dial info catalog: answer above the 1 MiB limit, not read",
            Failure::Unavailable => {
                "WARN: Dial info catalog: the backend has no dial catalog route (pack not installed or older)"
            }
            Failure::Http => "ERROR: Dial info catalog: unexpected backend answer",
            Failure::Shape => "ERROR: Dial info catalog: malformed response",
            Failure::LeftOut => "WARN: Dial info catalog: entries outside what DEAS reads were left out",
        }
    }
}

/// Central Logs entry: origin, severity, operation and counts; never the URL or the backend's
/// text. One slot per cause: the first occurrence and its first repeat are immediate, further
/// repeats once per minute (the catalog is read every time the Dials tab opens).
fn log(cause: Failure, extra: &str) {
    static LAST: Mutex<[(Option<std::time::Instant>, u64); 7]> = Mutex::new([(None, 0); 7]);
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
        crate::logs::push(
            crate::logs::Source::Deas,
            &format!(
                "{}{extra}; repeated={repeats}; repeats in the minute before={earlier} (further repeats limited to once per minute)",
                cause.diagnostic()
            ),
        );
    }
}

fn fail(cause: Failure, detail: &str) -> String {
    log(cause, "");
    format!("{}: {detail}", cause.code())
}

/// Text of the dial file's maker: control characters become spaces, the length is the pack's own
/// limit. Anything that is not text reads as empty.
fn text(v: &Value, limit: usize) -> String {
    v.as_str()
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(limit)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// A recorded strength: above 0 and within the compiler's row strength bound, else unknown.
fn strength(v: &Value) -> Value {
    v.as_f64()
        .filter(|n| n.is_finite() && *n > 0.0 && *n <= DIAL_LEVEL)
        .map_or(Value::Null, |n| json!(n))
}

/// `{useful, overcook}`; an overcook strength below the useful one is not a measurement DEAS can
/// draw, so it reads as unknown.
fn strengths(v: &Value) -> Value {
    let useful = strength(&v["useful"]);
    let mut overcook = strength(&v["overcook"]);
    if useful
        .as_f64()
        .zip(overcook.as_f64())
        .is_some_and(|(u, o)| o < u)
    {
        overcook = Value::Null;
    }
    json!({"useful":useful,"overcook":overcook})
}

fn evidence(v: &Value) -> Value {
    v.as_str()
        .filter(|e| EVIDENCE.contains(e))
        .map_or(Value::Null, |e| json!(e))
}

/// The pack's info v2 reduced to what Studio shows; `None` for anything that is not info v2.
fn info(v: &Value) -> Option<Value> {
    if !v.is_object() || v["version"].as_u64() != Some(2) {
        return None;
    }
    let mut out = json!({
        "version":2,
        "description":text(&v["description"], DESCRIPTION),
        "negative":text(&v["negative"], LABEL),
        "positive":text(&v["positive"], LABEL),
        "pipeline":text(&v["pipeline"], LABEL),
        "notes":text(&v["notes"], NOTES),
        "neg":strengths(&v["neg"]),
        "pos":strengths(&v["pos"]),
        "evidence":evidence(&v["evidence"]),
    });
    if let Some(kind) = v["kind"].as_str().filter(|k| KINDS.contains(k)) {
        out["kind"] = json!(kind);
    }
    if let Some(pipelines) = v["pipelines"].as_object() {
        let mut measured = Map::new();
        for key in PIPELINES {
            let Some(p) = pipelines.get(key).filter(|p| p.is_object()) else {
                continue;
            };
            let mut one = strengths(p);
            // Blend steps a time curve needs there: a whole number the compiler could send.
            if let Some(steps) = p["steps"]
                .as_u64()
                .filter(|n| (1..=DIAL_BLEND_STEPS).contains(n))
            {
                one["steps"] = json!(steps);
            }
            one["evidence"] = evidence(&p["evidence"]);
            one["notes"] = json!(text(&p["notes"], NOTES));
            measured.insert(key.to_owned(), one);
        }
        if !measured.is_empty() {
            out["pipelines"] = Value::Object(measured);
        }
    }
    Some(out)
}

/// `{"dials":[{dial, family, mode, info}], …}` of the pack → the entries DEAS lists (the
/// compiler's dial file rule, folders starting with `_` left out as in Studio's own list), each
/// once, at most `LISTED`. `dropped` counts entries that were not read.
fn catalog(v: &Value) -> Option<Value> {
    let entries = v["dials"].as_array()?;
    let (mut seen, mut dials, mut dropped, mut truncated) =
        (HashSet::new(), Vec::new(), 0usize, false);
    for entry in entries {
        let name = entry["dial"].as_str().map(|d| d.replace('\\', "/"));
        let read = name
            .filter(|d| {
                // Folders between `dials/` and the file; the file's own name may start with `_`.
                let folders = d.rsplit_once('/').map_or("", |(folders, _)| folders);
                dial_file(d) && !folders.split('/').skip(1).any(|f| f.starts_with('_'))
            })
            .and_then(|d| Some((d, info(&entry["info"])?)));
        let Some((dial, info)) = read else {
            dropped += 1;
            continue;
        };
        if seen.contains(&dial) {
            dropped += 1;
            continue;
        }
        if dials.len() >= LISTED {
            truncated = true;
            continue;
        }
        seen.insert(dial.clone());
        dials.push(json!({
            "dial":dial,
            "family":text(&entry["family"], FAMILY),
            "mode":entry["mode"].as_str().filter(|m| MODES.contains(m)).unwrap_or_default(),
            "info":info,
        }));
    }
    if dropped > 0 || truncated {
        log(
            Failure::LeftOut,
            &format!(
                "; kept={}; not read={dropped}; above the limit of {LISTED}={truncated}",
                dials.len()
            ),
        );
    }
    Some(json!({"dials":dials,"dropped":dropped,"truncated":truncated}))
}

/// What the dial files on the backend say about themselves (`GET /mainodes/dials/catalog`),
/// read-only and bounded. Fails closed: a backend without the route is `DIAL_INFO_UNAVAILABLE`.
#[tauri::command]
pub async fn native_dial_catalog(base_url: String) -> Result<Value, String> {
    let base = crate::validate_base_url(&base_url).map_err(|e| fail(Failure::Endpoint, &e))?;
    let (status, value) = fetch(&base, ROUTE, None).await.map_err(|e| match e {
        NoAnswer::Transport => fail(
            Failure::Transport,
            "The backend did not answer the dial info request",
        ),
        NoAnswer::TooLarge => fail(
            Failure::TooLarge,
            "The backend's dial catalog is larger than 1 MiB and was not read",
        ),
    })?;
    match (status, value) {
        (200, Some(value)) => catalog(&value).ok_or_else(|| {
            fail(
                Failure::Shape,
                "The backend's dial catalog is malformed",
            )
        }),
        (200, None) => Err(fail(
            Failure::Shape,
            "The backend's dial catalog answer is not JSON",
        )),
        (404 | 405, _) => Err(fail(
            Failure::Unavailable,
            "This backend has no dial catalog route. It comes with the Dial Rack nodes (ComfyUI-Dials or ComfyUI-MAINodes), which DEAS does not install yet",
        )),
        (status, _) => Err(fail(
            Failure::Http,
            &format!("The backend answered HTTP {status} to the dial info request"),
        )),
    }
}

#[cfg(test)]
#[path = "jobs_dial_info_tests.rs"]
mod tests;
