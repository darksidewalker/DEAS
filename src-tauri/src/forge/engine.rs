//! One Prompt Forge write for an image model, start to finish: character
//! canon, the system prompt for the segments asked for, the writing loop with
//! the tag-search and guidance tools, the segment contract, then the
//! mechanical clean-up. Ported from PromptForge's handleGenerate.

use super::canon::{character_block, CanonTable, Corrections};
use super::character::{self, Resolved};
use super::message::{self, Controls};
use super::pack::{segment_tail, Pack, PackModel, SEPARATOR};
use super::segments::{self, Segment};
use super::{chat, clean, tools};
use crate::llm::{LlmConfig, Provider};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

const ROUND_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRequest {
    /// `illustrious`, `anima`, `krea2` or `moss`.
    pub target: String,
    pub brief: String,
    /// The LLM model id on the configured server.
    pub model: String,
    #[serde(default)]
    pub mode: Option<String>,
    /// Optional segments to write. Absent = PromptForge's default for a person
    /// who never touched the switches.
    #[serde(default)]
    pub segments_on: Option<Vec<String>>,
    #[serde(default)]
    pub controls: Controls,
}

#[derive(Debug, Serialize)]
pub struct ToolUse {
    pub name: String,
    pub queries: Vec<String>,
    pub document: Option<String>,
    pub ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub segments: Vec<Segment>,
    pub refused: bool,
    /// The prompt itself (Positive prompt / Enhanced prompt).
    pub prompt: String,
    pub negative: Option<String>,
    pub characters: Vec<String>,
    pub tools: Vec<ToolUse>,
    pub rounds: usize,
    pub warnings: Vec<String>,
    pub fixes: Vec<String>,
}

/// Where the data pack and databases live: `DEAS_FORGE_DATA`, else
/// `<environment>/forge-data`.
pub fn data_dir(root: &Path) -> PathBuf {
    std::env::var_os("DEAS_FORGE_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("forge-data"))
}

fn log(text: &str) {
    crate::logs::push(
        crate::logs::Source::Deas,
        &format!("INFO: Prompt Forge: {text}"),
    );
}

pub struct Data {
    pub pack: Pack,
    pub tags: Option<super::tags::TagStore>,
    pub canon: Option<CanonTable>,
}

impl Data {
    pub fn load(dir: &Path) -> Result<Self, String> {
        let pack = Pack::load(&dir.join("forge-pack.json"))?;
        let tags = super::tags::TagStore::open(&dir.join("tags.sqlite"))
            .inspect_err(|e| {
                log(&format!(
                    "no tag database, tools and tag checks are off ({e})"
                ))
            })
            .ok();
        let corrections: Corrections = std::fs::read(dir.join("character-corrections.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let canon = CanonTable::open(&dir.join("character_traits.sqlite"), corrections)
            .inspect_err(|e| log(&format!("no character table, canon is off ({e})")))
            .ok();
        Ok(Self { pack, tags, canon })
    }
}

fn spared(controls: &Controls) -> Vec<String> {
    let mut v = vec![controls.positive.clone().unwrap_or_default()];
    v.extend(controls.tags.iter().cloned());
    v
}

pub async fn write(
    data: &Data,
    config: &LlmConfig,
    req: &WriteRequest,
) -> Result<WriteResult, String> {
    let pack = &data.pack;
    let model: &PackModel = pack
        .models
        .get(&req.target)
        .ok_or_else(|| format!("Prompt Forge has no writer for \"{}\"", req.target))?;
    if req.brief.trim().is_empty() {
        return Err("Write a brief first.".into());
    }
    let mode = req
        .mode
        .clone()
        .or_else(|| model.str("default_mode").map(String::from))
        .filter(|m| model.modes().contains(m));
    // An unset control means the model's default, as PromptForge's form always sends one:
    // a quality preset left out entirely lets the model add a ladder of its own.
    let mut filled = req.controls.clone();
    if filled.quality_preset.is_none()
        && model
            .entry
            .get("quality_presets")
            .is_some_and(Value::is_object)
    {
        filled.quality_preset = Some(
            model
                .str("default_quality_preset")
                .unwrap_or("none")
                .to_string(),
        );
    }
    if filled.style.is_none() {
        filled.style = model.str("default_style").map(String::from);
    }
    let controls = &filled;
    let tag_style = model.tag_style();
    let mut warnings = vec![];
    let mut fixes = vec![];

    // The contract for this request, minus what is switched off.
    let expected = model.expected(mode.as_deref());
    let optional = model.optional();
    let default_off = pack
        .defaults
        .get("optional_segments_default")
        .and_then(Value::as_str)
        == Some("off");
    let wanted: Vec<String> = expected
        .iter()
        .filter(|l| {
            !optional.contains(l)
                || req
                    .segments_on
                    .as_ref()
                    .map_or(!default_off, |on| on.contains(l))
        })
        .cloned()
        .collect();
    let discard: Vec<String> = expected
        .iter()
        .filter(|l| !wanted.contains(l))
        .cloned()
        .collect();

    // Character canon, from the local tables only.
    let characters_on = pack
        .config
        .get("characters")
        .and_then(|c| c.get("enabled"))
        .and_then(Value::as_bool)
        != Some(false);
    let (resolved, ambiguous): (Vec<Resolved>, Vec<character::Ambiguous>) =
        match (&data.tags, characters_on && controls.tags.is_empty()) {
            (Some(store), true) => {
                character::resolve(&req.brief, store, &character::Options::default())
            }
            _ => (vec![], vec![]),
        };
    let character_text = character_block(
        data.canon.as_ref(),
        data.tags.as_ref(),
        &resolved,
        &ambiguous,
        tag_style == Some("underscore"),
    );
    for r in &resolved {
        log(&format!("{}: {} via {}", req.target, r.tag, r.via));
    }

    // Tools, when the model takes them and there is a database behind them.
    let tools_on = pack
        .config
        .get("tools")
        .and_then(|t| t.get("enabled"))
        .and_then(Value::as_bool)
        != Some(false);
    let mut offered: Vec<Value> = vec![];
    if tools_on && model.flag("tools") && data.tags.is_some() {
        offered.extend(model.search_tool.iter().cloned());
    }
    if tools_on && !model.guidance_docs.is_empty() {
        offered.extend(model.guidance_tool.iter().cloned());
    }
    let offers = |name: &str| offered.iter().any(|t| t["function"]["name"] == name);
    let guide: Vec<&str> = [
        offers("search_tags")
            .then_some(pack.shared.tag_search.as_deref())
            .flatten(),
        offers("read_guidance")
            .then_some(pack.shared.guidance.as_deref())
            .flatten(),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut system = [
        model.system_for(mode.as_deref()).to_string(),
        segment_tail(pack, model, &wanted),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(SEPARATOR);
    if !guide.is_empty() {
        system = format!("{system}{SEPARATOR}{}", guide.join(SEPARATOR));
    }

    let canvas = canvas_line(model, mode.as_deref(), controls);
    let negative_written = wanted.iter().any(|l| l.to_lowercase().contains("negative"));
    let user = message::build(
        pack,
        model,
        &req.brief,
        controls,
        negative_written,
        &character_text,
        canvas,
    );
    let (temperature, top_p) = message::sampling(pack, model, controls.creativity);

    let max_rounds = pack
        .config
        .get("tools")
        .and_then(|t| t.get("max_rounds"))
        .and_then(Value::as_u64)
        .unwrap_or(3) as usize;
    let max_calls = pack
        .config
        .get("tools")
        .and_then(|t| t.get("max_calls"))
        .and_then(Value::as_u64)
        .unwrap_or(24) as usize;
    let ollama = config.provider == Provider::Ollama;
    let mut messages = vec![
        json!({ "role": "system", "content": system }),
        json!({ "role": "user", "content": user }),
    ];
    let mut used: Vec<ToolUse> = vec![];
    let mut rounds = 0;
    let mut tools_left = !offered.is_empty();
    let reply = loop {
        let reply = chat::round(chat::Round {
            config,
            model: &req.model,
            messages: &messages,
            tools: tools_left.then_some(offered.as_slice()),
            temperature,
            top_p,
            timeout: ROUND_TIMEOUT,
        })
        .await?;
        if !tools_left || reply.calls.is_empty() {
            break reply;
        }
        rounds += 1;
        messages.push(chat::assistant_turn(&reply.content, &reply.calls, ollama));
        for call in &reply.calls {
            let out = if call.name == "read_guidance" {
                tools::read_guidance(model, &call.arguments)
            } else {
                match &data.tags {
                    Some(store) => {
                        tools::search_tags(store, &call.arguments, tag_style == Some("space"))
                    }
                    None => tools::Outcome {
                        ok: false,
                        content: "The tag database is unavailable.".into(),
                        queries: vec![],
                        document: None,
                    },
                }
            };
            log(&format!(
                "{}: {}{}{}",
                req.target,
                call.name,
                out.document
                    .as_deref()
                    .map(|d| format!(" → {d}"))
                    .unwrap_or_default(),
                if out.queries.is_empty() {
                    String::new()
                } else {
                    format!(" → {}", out.queries.join(", "))
                }
            ));
            messages.push(chat::tool_result(call, &out.content));
            used.push(ToolUse {
                name: call.name.clone(),
                queries: out.queries,
                document: out.document,
                ok: out.ok,
            });
        }
        // Checked after the results go back, never before: a model left waiting
        // on an unanswered call writes nothing.
        if rounds >= max_rounds || used.len() >= max_calls {
            tools_left = false;
            messages.push(json!({
                "role": "user",
                "content": "You have used all the tag searches available for this prompt. Do not call search_tags again. Write the finished prompt now, in the exact segment format your instructions specify, using the tags you have already confirmed."
            }));
        }
    };

    let wanted_refs: Vec<&str> = wanted.iter().map(String::as_str).collect();
    let discard_refs: Vec<&str> = discard.iter().map(String::as_str).collect();
    let (mut segs, refused) = segments::parse(&reply.content, &wanted_refs, &discard_refs)
        .map_err(|e| {
            if reply.truncated {
                format!("The answer was cut off before it finished. {e}")
            } else {
                e.to_string()
            }
        })?;

    if !refused {
        post_process(
            data,
            model,
            mode.as_deref(),
            controls,
            &req.brief,
            &mut segs,
            &mut warnings,
            &mut fixes,
        );
    }
    for f in &fixes {
        log(&format!("{}: {f}", req.target));
    }

    let meta = model.strings("meta_segments");
    let prompt = segs
        .iter()
        .find(|s| {
            !meta.contains(&s.label)
                && !s.label.to_lowercase().contains("negative")
                && s.label != "Layout JSON"
        })
        .map(|s| s.body.clone())
        .unwrap_or_default();
    let negative = segs
        .iter()
        .find(|s| s.label == "Negative prompt")
        .map(|s| s.body.clone());
    Ok(WriteResult {
        segments: segs,
        refused,
        prompt,
        negative,
        characters: resolved.into_iter().map(|r| r.tag).collect(),
        tools: used,
        rounds,
        warnings,
        fixes,
    })
}

fn canvas_line(model: &PackModel, mode: Option<&str>, controls: &Controls) -> Option<String> {
    if !model.expected(mode).iter().any(|l| l == "Layout JSON") {
        return None;
    }
    let table = model.entry.get("layout_canvas")?;
    let size = table
        .get(controls.aspect_ratio.as_deref().unwrap_or("N/A"))
        .or_else(|| table.get("N/A"))?
        .as_array()?;
    let (w, h) = (size.first()?.as_i64()?, size.get(1)?.as_i64()?);
    Some(format!(
        "Canvas: {w}×{h} — measure every Layout JSON bbox on this canvas: x from -{} to {}, y from -{} to {}, origin at the centre.",
        w / 2, w / 2, h / 2, h / 2
    ))
}

#[allow(clippy::too_many_arguments)]
fn post_process(
    data: &Data,
    model: &PackModel,
    mode: Option<&str>,
    controls: &Controls,
    brief: &str,
    segs: &mut [Segment],
    warnings: &mut Vec<String>,
    fixes: &mut Vec<String>,
) {
    let tag_style = model.tag_style();
    let store = data.tags.as_ref();
    let known_fn = |t: &str| store.is_some_and(|s| s.post_count(t) > 0);
    let known: Option<&dyn Fn(&str) -> bool> = if tag_style.is_some() && store.is_some() {
        Some(&known_fn)
    } else {
        None
    };
    let spared = spared(controls);
    let spared_refs: Vec<&str> = spared.iter().map(String::as_str).collect();
    let is_prompt = |l: &str| {
        matches!(
            l,
            "Positive prompt" | "Enhanced prompt" | "Enhanced paragraph"
        )
    };

    for s in segs.iter_mut() {
        s.body = clean::tidy_commas(&s.body);
    }
    if let Some(seg) = segs.iter_mut().find(|s| s.label == "Layout JSON") {
        if let Some(w) = tidy_layout(model, mode, controls, &mut seg.body) {
            warnings.push(w);
        }
    }
    if let Some(aspect) = controls
        .aspect_ratio
        .as_deref()
        .filter(|a| *a != "N/A" && !a.is_empty())
    {
        let mut protected = spared_refs.clone();
        protected.push(brief);
        for s in segs.iter_mut().filter(|s| is_prompt(&s.label)) {
            let (body, removed) = clean::strip_aspect(&s.body, aspect, &protected);
            if !removed.is_empty() {
                s.body = body;
                fixes.push(format!("removed leaked ratio {}", removed.join(", ")));
            }
        }
    }
    if tag_style == Some("space") {
        let protected = [
            controls.positive.as_deref().unwrap_or(""),
            controls.negative.as_deref().unwrap_or(""),
        ];
        let mut protected: Vec<&str> = protected.to_vec();
        protected.extend(controls.tags.iter().map(String::as_str));
        for s in segs
            .iter_mut()
            .filter(|s| s.label == "Positive prompt" || s.label == "Negative prompt")
        {
            let (text, changed) = clean::space_underscores(&s.body, &protected);
            if changed > 0 {
                s.body = text;
                fixes.push(format!(
                    "{changed} tag(s) respelled with spaces in {}",
                    s.label
                ));
            }
        }
    }
    if let Some(s) = segs.iter_mut().find(|s| s.label == "Positive prompt") {
        let mut protected = spared_refs.clone();
        protected.push(brief);
        let out = clean::clean_positive(&s.body, known, &protected);
        if !out.duplicates.is_empty() || !out.invented.is_empty() {
            s.body = out.text;
            if !out.duplicates.is_empty() {
                fixes.push(format!("removed {} duplicate tag(s)", out.duplicates.len()));
            }
            if !out.invented.is_empty() {
                fixes.push(format!("removed invented {}", out.invented.join(", ")));
            }
        }
    }
    let positive = segs
        .iter()
        .find(|s| s.label == "Positive prompt")
        .map(|s| s.body.clone())
        .unwrap_or_default();
    if let Some(s) = segs.iter_mut().find(|s| s.label == "Negative prompt") {
        let mut positives = vec![positive.as_str()];
        positives.extend(controls.tags.iter().map(String::as_str));
        let defaults = model.str("negative_defaults").unwrap_or("");
        let custom = controls.negative.as_deref().unwrap_or("");
        let out = clean::clean_negative(&s.body, &positives, known, &[defaults, custom]);
        if !out.duplicates.is_empty() || !out.contradictions.is_empty() {
            fixes.push(format!(
                "negative: dropped {} duplicate(s), {} contradicting the positive",
                out.duplicates.len(),
                out.contradictions.len()
            ));
        }
        let floor = [defaults, custom]
            .iter()
            .filter(|s| !s.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(", ");
        let (text, added) = clean::ensure_defaults(&out.text, &floor, &positives);
        if !added.is_empty() {
            fixes.push(format!("negative: restored {}", added.join(", ")));
        }
        let allowance = model
            .entry
            .get("negative_extra_max")
            .and_then(Value::as_u64)
            .or_else(|| {
                data.pack
                    .config
                    .get("negative")
                    .and_then(|n| n.get("extra_max"))
                    .and_then(Value::as_u64)
            })
            .unwrap_or(0) as usize;
        let (text, dropped) = clean::cap_extras(&text, &floor, allowance);
        if !dropped.is_empty() {
            fixes.push(format!(
                "negative: dropped {} tag(s) past the allowance of {allowance}",
                dropped.len()
            ));
        }
        s.body = text;
    }
    if model
        .entry
        .get("weight_range")
        .is_some_and(|w| !w.is_null())
    {
        for s in segs
            .iter_mut()
            .filter(|s| s.label == "Positive prompt" || s.label == "Negative prompt")
        {
            let (text, escaped) = clean::escape_literal_parens(&s.body);
            if !escaped.is_empty() {
                s.body = text;
                fixes.push(format!("escaped {}", escaped.join(", ")));
            }
        }
    }
    if let Some(block) = message::pasted_style(model, controls) {
        let meta = model.strings("meta_segments");
        let label = model
            .strings("segments")
            .into_iter()
            .find(|l| !meta.contains(l));
        if let Some(seg) = segs.iter_mut().find(|s| Some(&s.label) == label.as_ref()) {
            let body = seg.body.replace(&block, "").trim().to_string();
            let stop = body.ends_with(['.', '!', '?', '"', '\'', ')', ']']);
            seg.body = if body.is_empty() {
                block
            } else {
                format!("{body}{} {block}", if stop { "" } else { "." })
            };
        }
    }
    keep_as_written(model, controls, segs, fixes);
}

/// Custom positive, negative and camera picks, as typed, whatever the model did.
fn keep_as_written(
    model: &PackModel,
    controls: &Controls,
    segs: &mut [Segment],
    fixes: &mut Vec<String>,
) {
    let norm = |t: &str| {
        t.to_lowercase()
            .replace("\\(", "(")
            .replace("\\)", ")")
            .replace('_', " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let split = |s: &str| {
        s.split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(String::from)
            .collect::<Vec<_>>()
    };
    let positive = controls
        .positive
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    if let Some(pos) = segs
        .iter_mut()
        .find(|s| s.label == "Positive prompt" || s.label == "Enhanced prompt")
    {
        if model.tag_style().is_some() {
            let mut want = split(&positive);
            want.extend(
                message::camera_picks(model, controls)
                    .iter()
                    .flat_map(|c| split(c))
                    .map(|t| {
                        if model.tag_style() == Some("underscore") {
                            t.replace(' ', "_")
                        } else {
                            t
                        }
                    }),
            );
            let mut have: std::collections::HashSet<String> =
                split(&pos.body).iter().map(|t| norm(t)).collect();
            let missing: Vec<String> = want.into_iter().filter(|t| have.insert(norm(t))).collect();
            if !missing.is_empty() {
                let base = pos.body.trim().trim_end_matches(',').trim().to_string();
                pos.body = std::iter::once(base)
                    .filter(|b| !b.is_empty())
                    .chain(missing.iter().cloned())
                    .collect::<Vec<_>>()
                    .join(", ");
                fixes.push(format!("put back {}", missing.join(", ")));
            }
        } else if !positive.is_empty()
            && !pos.body.to_lowercase().contains(&positive.to_lowercase())
        {
            pos.body = format!("{} {positive}", pos.body.trim()).trim().to_string();
            fixes.push(format!("put back {positive}"));
        }
    }
    // A negative switched off is not added back here: the hammer leaves
    // Generate's own negative alone, and the tab shows only what was written.
    let negative = controls
        .negative
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    if !negative.is_empty() {
        if let Some(neg) = segs.iter_mut().find(|s| s.label == "Negative prompt") {
            let mut have: std::collections::HashSet<String> =
                split(&neg.body).iter().map(|t| norm(t)).collect();
            let missing: Vec<String> = split(&negative)
                .into_iter()
                .filter(|t| have.insert(norm(t)))
                .collect();
            if !missing.is_empty() {
                let base = neg.body.trim().trim_end_matches(',').trim().to_string();
                neg.body = std::iter::once(base)
                    .filter(|b| !b.is_empty())
                    .chain(missing.iter().cloned())
                    .collect::<Vec<_>>()
                    .join(", ");
            }
        }
    }
}

/// MOSS Layout JSON: fixed fields, boxes rounded and inside the canvas.
fn tidy_layout(
    model: &PackModel,
    mode: Option<&str>,
    controls: &Controls,
    body: &mut String,
) -> Option<String> {
    let table = model.entry.get("layout_canvas")?;
    let size = table
        .get(controls.aspect_ratio.as_deref().unwrap_or("N/A"))
        .or_else(|| table.get("N/A"))?
        .as_array()?;
    let (w, h) = (size.first()?.as_f64()?, size.get(1)?.as_f64()?);
    let _ = mode;
    let raw = body
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let obj: Option<Value> = match (raw.find('{'), raw.rfind('}')) {
        (Some(a), Some(b)) if b > a => serde_json::from_str(&raw[a..=b]).ok(),
        _ => None,
    };
    let Some(Value::Object(obj)) = obj else {
        return Some("The Layout JSON did not come back as valid JSON — regenerate, or use the prose prompt on its own.".into());
    };
    let clamp = |v: &Value, lim: f64| (v.as_f64().unwrap_or(0.0).round()).clamp(-lim, lim) as i64;
    let items: Vec<Value> = obj
        .get("items")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .take(100)
                .filter_map(|i| {
                    let b = i.get("bbox")?.as_array().filter(|b| b.len() == 4)?;
                    let (mut y0, mut y1) = (clamp(&b[0], h / 2.0), clamp(&b[2], h / 2.0));
                    let (mut x0, mut x1) = (clamp(&b[1], w / 2.0), clamp(&b[3], w / 2.0));
                    if y0 > y1 {
                        std::mem::swap(&mut y0, &mut y1);
                    }
                    if x0 > x1 {
                        std::mem::swap(&mut x0, &mut x1);
                    }
                    let label = if i.get("label").and_then(Value::as_str) == Some("text") { "text" } else { "object" };
                    let mut out = json!({ "label": label, "caption": i.get("caption").and_then(Value::as_str).unwrap_or("") });
                    if label == "text" {
                        out["text"] = json!(i.get("text").and_then(Value::as_str).unwrap_or(""));
                    }
                    out["bbox"] = json!([y0, x0, y1, x1]);
                    Some(out)
                })
                .collect()
        })
        .unwrap_or_default();
    let mut summary = obj
        .get("summary")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let meta = match summary.remove("meta") {
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| json!(v.as_str().map_or(v.to_string(), String::from)))
            .collect(),
        Some(Value::Null) | None => vec![],
        Some(v) => vec![json!(v.as_str().map_or(v.to_string(), String::from))],
    };
    let caption = summary
        .remove("caption")
        .and_then(|c| c.as_str().map(String::from))
        .unwrap_or_default();
    let mut s = serde_json::Map::new();
    s.insert("meta".into(), Value::Array(meta));
    s.extend(summary);
    s.insert("canvas".into(), json!("single"));
    s.insert("caption".into(), json!(caption));
    let out = json!({ "summary": s, "items": items, "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx" });
    let pretty = serde_json::to_string_pretty(&out).unwrap_or_default();
    // Each bbox on one line, as the guide prints them.
    let mut tidy = String::new();
    let mut rest = pretty.as_str();
    while let Some(at) = rest.find("\"bbox\": [") {
        let start = at + "\"bbox\": [".len();
        tidy.push_str(&rest[..start]);
        let end = rest[start..].find(']').map_or(rest.len(), |e| start + e);
        let nums: Vec<&str> = rest[start..end].split(',').map(str::trim).collect();
        tidy.push_str(&nums.join(", "));
        rest = &rest[end..];
    }
    tidy.push_str(rest);
    *body = tidy;
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real write against a real server, printed in full:
    /// `DEAS_FORGE_DATA=<dir> DEAS_FORGE_LLM=<openai base url> DEAS_FORGE_MODEL=<id>
    ///  DEAS_FORGE_TARGETS=illustrious,anima cargo test -- --ignored live_write --nocapture`
    #[tokio::test]
    #[ignore = "needs a live LLM server and the data pack"]
    async fn live_write() {
        let data = Data::load(&PathBuf::from(std::env::var("DEAS_FORGE_DATA").unwrap())).unwrap();
        let config = LlmConfig {
            provider: Provider::Openai,
            base_url: std::env::var("DEAS_FORGE_LLM").unwrap(),
        };
        let model = std::env::var("DEAS_FORGE_MODEL").unwrap();
        let targets = std::env::var("DEAS_FORGE_TARGETS")
            .unwrap_or_else(|_| "illustrious,anima,krea2,moss".into());
        let briefs = [
            "frieren sitting by a campfire at night in a forest, fern asleep against her shoulder",
            "a girl in a yellow raincoat waiting at a rural bus stop in heavy rain, puddles, overcast",
            "moody cyberpunk alley, neon signs reflected in wet asphalt, a lone figure with an umbrella, cinematic",
        ];
        for target in targets.split(',') {
            for brief in briefs {
                let req = WriteRequest {
                    target: target.into(),
                    brief: brief.into(),
                    model: model.clone(),
                    mode: None,
                    segments_on: Some(vec!["Negative prompt".into()]),
                    controls: Controls {
                        detail: Some(5),
                        creativity: Some(5),
                        ..Default::default()
                    },
                };
                let started = std::time::Instant::now();
                match write(&data, &config, &req).await {
                    Ok(r) => {
                        println!(
                            "=== {target} | {}s | {} rounds, {} tool calls | {brief}",
                            started.elapsed().as_secs(),
                            r.rounds,
                            r.tools.len()
                        );
                        for t in &r.tools {
                            println!(
                                "  tool {} {}{}",
                                t.name,
                                t.queries.join(", "),
                                t.document.as_deref().unwrap_or("")
                            );
                        }
                        if !r.characters.is_empty() {
                            println!("  canon: {}", r.characters.join(", "));
                        }
                        for f in &r.fixes {
                            println!("  fixed: {f}");
                        }
                        for s in &r.segments {
                            println!("--- {}\n{}", s.label, s.body);
                        }
                        println!();
                    }
                    Err(e) => println!("=== {target} | ERROR | {brief}\n{e}\n"),
                }
            }
        }
    }
}

#[tauri::command]
pub async fn native_forge_write(
    root: String,
    request: WriteRequest,
) -> Result<WriteResult, String> {
    let root = PathBuf::from(root);
    let config = crate::llm::read(&root)?;
    let dir = data_dir(&root);
    let data = tokio::task::spawn_blocking(move || Data::load(&dir))
        .await
        .map_err(|_| "Prompt Forge data failed to load")??;
    write(&data, &config, &request).await.inspect_err(|e| {
        crate::logs::push(
            crate::logs::Source::Deas,
            &format!("ERROR: Prompt Forge {}: {e}", request.target),
        );
    })
}

/// Which image models this install can write for, from the data pack.
#[tauri::command]
pub async fn native_forge_targets(root: String) -> Result<Value, String> {
    let dir = data_dir(Path::new(&root));
    let pack = tokio::task::spawn_blocking(move || Pack::load(&dir.join("forge-pack.json")))
        .await
        .map_err(|_| "Prompt Forge data failed to load")??;
    let mut targets: Vec<Value> = pack
        .models
        .iter()
        .map(|(key, m)| {
            json!({
                "key": key,
                "label": m.str("label").unwrap_or(key),
                "modes": m.modes(),
                "defaultMode": m.str("default_mode"),
                "optional": m.optional(),
                "qualityPresets": m.entry.get("quality_presets").and_then(Value::as_object).map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
                "styles": m.entry.get("styles").map(|s| match s { Value::Object(o) => o.keys().cloned().collect::<Vec<_>>(), Value::Array(a) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(), _ => vec![] }).unwrap_or_default(),
                "aspectRatios": m.entry.get("aspect_ratios").cloned().unwrap_or(Value::Null),
                "hasNegative": m.entry.get("has_negative").and_then(Value::as_bool) != Some(false),
                "tools": m.flag("tools"),
                "guidance": m.guidance_docs.keys().collect::<Vec<_>>(),
            })
        })
        .collect();
    targets.sort_by(|a, b| a["key"].as_str().cmp(&b["key"].as_str()));
    Ok(json!({ "source": pack.source, "creativity": pack.creativity_order, "targets": targets }))
}
