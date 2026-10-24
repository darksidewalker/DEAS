//! Chat: PromptForge's chat (server.mjs handleChat) run natively. A conversation
//! with the configured LLM, streamed as it is written, that knows this project:
//!
//! - `write_prompt` runs the real prompt writer for one of the four image models
//!   (the same engine as the Prompt Forge tab, with PromptForge's defaults) and
//!   puts its prompt into the reply word for word — the chat model never gets a
//!   second turn to "tidy" it (PromptForge's server/chat-prompt-tool.mjs).
//! - `read_guide` reads how a model wants to be prompted (the image models' own
//!   prompt files and guidance documents, the H3/Wan/LTX prompts) and DEAS's own
//!   user guides.
//! - `search_tags` looks a tag up in the local database.
//! - Web search, when switched on, runs on the person's message before the answer
//!   (server/search.mjs) and the answer cites it.
//!
//! Conversations live in `<environment>/chats/<id>.json`. Pictures are held for
//! the turn they arrive in only and never written to disk.

use super::engine::{self, data_dir, Data, WriteRequest, ROUND_TIMEOUT};
use super::{chat, search, tools};
use crate::llm::{LlmConfig, Provider};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

const DIR: &str = "chats";
const MAX_CHATS: usize = 500;
const MAX_MESSAGE: usize = 32_000;
const MAX_PICTURES: usize = 4;
/// Tool rounds before the model has to answer.
const MAX_ROUNDS: usize = 4;
/// A guide is cut here: the 8B models on the Z440 run 32k contexts.
const GUIDE_LIMIT: usize = 16_000;
const IMAGE_MODELS: &[&str] = &["illustrious", "anima", "krea2", "moss"];

/// DEAS's own user guides, readable by `read_guide`.
const DOCS: &[(&str, &str, &str)] = &[
    (
        "deas-getting-started",
        "Getting started with DEAS",
        include_str!("../../../docs/GETTING-STARTED.md"),
    ),
    (
        "deas-studio",
        "Studio: Generate, settings, Quick Settings, colour schemes",
        include_str!("../../../docs/STUDIO.md"),
    ),
    (
        "deas-prompting",
        "Prompt Forge, the hammer, presets and wildcards",
        include_str!("../../../docs/PROMPTING.md"),
    ),
    (
        "deas-library",
        "Library: models, LoRAs, downloads",
        include_str!("../../../docs/LIBRARY.md"),
    ),
    (
        "deas-media",
        "Media browser",
        include_str!("../../../docs/MEDIA.md"),
    ),
    (
        "deas-backend",
        "Backend: install, ComfyUI, LLM backend",
        include_str!("../../../docs/BACKEND.md"),
    ),
    ("deas-logs", "Logs", include_str!("../../../docs/LOGS.md")),
    (
        "deas-projects",
        "Projects",
        include_str!("../../../docs/PROJECTS.md"),
    ),
    (
        "deas-comfy",
        "The Comfy tab",
        include_str!("../../../docs/COMFY.md"),
    ),
    (
        "deas-chat",
        "Chat: tools, pictures, web search",
        include_str!("../../../docs/CHAT.md"),
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WrittenPrompt {
    pub target: String,
    pub label: String,
    pub prompt: String,
    #[serde(default)]
    pub negative: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// "user" or "assistant".
    pub role: String,
    pub content: String,
    /// Pictures sent with this message; only the count is kept.
    #[serde(default)]
    pub pictures: usize,
    #[serde(default)]
    pub prompts: Vec<WrittenPrompt>,
    #[serde(default)]
    pub citations: Vec<search::Hit>,
    /// What the answer looked at, for the person: "read_guide: ltx".
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub model: String,
    pub created: u64,
    pub updated: u64,
    pub messages: Vec<Message>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub updated: u64,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChatEvent {
    Chat {
        id: String,
        title: String,
    },
    Searched {
        query: String,
        results: Vec<search::Hit>,
        detail: Option<String>,
    },
    Status {
        state: String,
        detail: Option<String>,
    },
    Text {
        text: String,
    },
    Prompt {
        prompt: WrittenPrompt,
    },
    Done {
        message: Message,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub message: String,
    pub model: String,
    #[serde(default)]
    pub pictures: Vec<String>,
    /// What the person is working on, gathered by the page at send time.
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub search: bool,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Today as YYYY-MM-DD (UTC), without a date crate.
fn today() -> String {
    let days = (now() / 86_400_000) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

// ── storage ─────────────────────────────────────────────────────────────────

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn file(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Unknown conversation.".into());
    }
    Ok(root.join(DIR).join(format!("{id}.json")))
}

pub fn load(root: &Path, id: &str) -> Result<Chat, String> {
    let bytes =
        std::fs::read(file(root, id)?).map_err(|_| "That conversation no longer exists.")?;
    serde_json::from_slice(&bytes).map_err(|_| "That conversation could not be read.".into())
}

pub fn save(root: &Path, chat: &Chat) -> Result<(), String> {
    let dir = root.join(DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    let path = file(root, &chat.id)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(chat).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn list(root: &Path) -> Vec<Summary> {
    let Ok(entries) = std::fs::read_dir(root.join(DIR)) else {
        return vec![];
    };
    let mut out: Vec<Summary> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .take(MAX_CHATS * 2)
        .filter_map(|e| std::fs::read(e.path()).ok())
        .filter_map(|b| serde_json::from_slice::<Chat>(&b).ok())
        .map(|c| Summary {
            id: c.id,
            title: c.title,
            updated: c.updated,
            count: c.messages.len(),
        })
        .collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.updated));
    out.truncate(MAX_CHATS);
    out
}

fn title_from(text: &str, pictures: usize) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if line.is_empty() {
        return if pictures > 0 {
            "A picture".into()
        } else {
            "New chat".into()
        };
    }
    let mut t: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        t = format!("{}…", t.trim_end());
    }
    t
}

// ── tools ───────────────────────────────────────────────────────────────────

fn label_of(data: &Data, key: &str) -> String {
    data.pack
        .models
        .get(key)
        .and_then(|m| m.str("label"))
        .unwrap_or(key)
        .to_string()
}

/// Every guide by name, with what it is.
fn guides(data: &Data) -> Vec<(String, String)> {
    let mut out = vec![];
    for key in IMAGE_MODELS {
        if let Some(m) = data.pack.models.get(*key) {
            out.push((
                key.to_string(),
                format!(
                    "how {} prompts are written (its prompt writer's own instructions)",
                    label_of(data, key)
                ),
            ));
            let mut docs: Vec<&String> = m.guidance_docs.keys().collect();
            docs.sort();
            for d in docs {
                out.push((
                    d.clone(),
                    format!("{} guidance document", label_of(data, key)),
                ));
            }
        }
    }
    let mut video: Vec<(&String, &super::pack::Guide)> =
        data.pack.shared.video_guides.iter().collect();
    video.sort_by_key(|(k, _)| k.as_str());
    for (k, g) in video {
        out.push((
            k.clone(),
            format!("how {} video prompts are written", g.label),
        ));
    }
    for (k, what, _) in DOCS {
        out.push((k.to_string(), format!("DEAS guide: {what}")));
    }
    out
}

fn read_guide(data: &Data, name: &str) -> Option<String> {
    let name = name.trim().to_lowercase();
    let text = if let Some(m) = data.pack.models.get(&name) {
        m.system.clone()
    } else if let Some(doc) = data
        .pack
        .models
        .values()
        .find_map(|m| m.guidance_docs.get(&name))
    {
        doc.clone()
    } else if let Some(g) = data.pack.shared.video_guides.get(&name) {
        g.system.clone()
    } else {
        DOCS.iter()
            .find(|(k, _, _)| *k == name)
            .map(|(_, _, t)| t.to_string())?
    };
    let cut: String = text.chars().take(GUIDE_LIMIT).collect();
    Some(if cut.len() < text.len() {
        format!("{cut}\n\n[The guide continues; this is the first part.]")
    } else {
        cut
    })
}

fn tool_definitions(data: &Data) -> Vec<Value> {
    let models: Vec<&str> = IMAGE_MODELS
        .iter()
        .copied()
        .filter(|k| data.pack.models.contains_key(*k))
        .collect();
    let list = models
        .iter()
        .map(|k| format!("{k} = {}", label_of(data, k)))
        .collect::<Vec<_>>()
        .join("; ");
    let names: Vec<String> = guides(data).into_iter().map(|(k, _)| k).collect();
    let mut out = vec![];
    if !models.is_empty() {
        out.push(json!({ "type": "function", "function": {
            "name": "write_prompt",
            "description": format!("Write a finished prompt for one of DEAS's image models, using that model's own prompt writer, which knows its exact format. Call it whenever the person asks for a prompt for one of these models, or asks to change one it wrote, instead of writing or editing the prompt yourself. If they have not said which model, ask them first rather than choosing. Models: {list}."),
            "parameters": { "type": "object", "properties": {
                "model": { "type": "string", "enum": models, "description": "Which model the prompt is for." },
                "brief": { "type": "string", "description": "What the picture should show, in the person's own words, with everything they asked for (subject, style, mood, characters, setting). Do not write the prompt here." }
            }, "required": ["model", "brief"] }
        }}));
    }
    out.push(json!({ "type": "function", "function": {
        "name": "read_guide",
        "description": "Read a guide before explaining how a model wants to be prompted or how a part of DEAS works, instead of answering from memory. The image and video model guides are those models' own prompt-writing instructions.",
        "parameters": { "type": "object", "properties": {
            "name": { "type": "string", "enum": names, "description": "Which guide." }
        }, "required": ["name"] }
    }}));
    if data.tags.is_some() {
        out.push(json!({ "type": "function", "function": {
            "name": "search_tags",
            "description": "Look tags up in the local Danbooru tag database: whether a tag exists, how it is spelled, how common it is. Use it before recommending a tag for Illustrious or Anima.",
            "parameters": { "type": "object", "properties": {
                "queries": { "type": "array", "items": { "type": "string" }, "description": "One or more words or tags to look up." }
            }, "required": ["queries"] }
        }}));
    }
    out
}

fn arguments(raw: &Value) -> Value {
    match raw {
        Value::String(s) => serde_json::from_str(s).unwrap_or(json!({})),
        other => other.clone(),
    }
}

// ── the conversation ────────────────────────────────────────────────────────

fn system_prompt(data: &Data, req: &SendRequest, searched: bool, search_on: bool) -> String {
    let base = data.pack.shared.chat.clone().unwrap_or_else(|| "You are the assistant inside DEAS, a local desktop studio for AI images and video. Answer directly and accurately.".into());
    let mut lines = vec![
        format!("Today is {} (UTC).", today()),
        "You are running inside DEAS (Dark Engine AI Studio), a local desktop app that installs and runs ComfyUI, with Studio for generating, Prompt Forge for writing prompts, a Library of models and LoRAs, and this Chat. Where your base instructions mention PromptForge's own tabs, the same tools exist here: Prompt Forge is the tab for prompts, Studio's Generate is where pictures are made.".to_string(),
        format!(
            "Guides you can read with read_guide: {}.",
            guides(data).iter().map(|(k, what)| format!("{k} ({what})")).collect::<Vec<_>>().join("; ")
        ),
        "When the person asks how a model is prompted or how part of DEAS works, read the guide first and answer from it.".into(),
    ];
    lines.push(if !search_on {
        "Web search is not switched on in this DEAS. You cannot look anything up; when an answer needs current information, say so.".into()
    } else if searched {
        "Web search ran for this message; its results are in front of the question.".into()
    } else {
        "Web search did not run for this message: the Search button was off, and you cannot search on your own. Never say you are searching. When an answer needs current information, say so and suggest asking again with Search on.".into()
    });
    let mut parts = vec![base, lines.join("\n")];
    if let Some(ctx) = req
        .context
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        parts.push(format!(
            "What the person is working on in DEAS right now (shared because they switched \"Include what I'm working on\" on; refer to it when it helps):\n{}",
            ctx.chars().take(8000).collect::<String>()
        ));
    }
    parts.join(super::pack::SEPARATOR)
}

/// The stored conversation as the model sees it. Only this turn's pictures go up.
fn history(chat: &Chat, pictures: &[String], lead: Option<&str>, ollama: bool) -> Vec<Value> {
    let last = chat.messages.len().saturating_sub(1);
    chat.messages
        .iter()
        .enumerate()
        .map(|(i, m)| {
            if i == last && m.role == "user" {
                let text = match lead {
                    Some(l) => format!("{l}\n\nThe question:\n{}", m.content),
                    None if m.content.trim().is_empty() => "Here is a picture.".into(),
                    None => m.content.clone(),
                };
                return chat::user_with_images(&text, pictures, ollama);
            }
            let mut content = m.content.clone();
            if m.pictures > 0 {
                content = format!("{content}\n\n[{} picture(s) were attached here; they are no longer held.]", m.pictures).trim().to_string();
            }
            json!({ "role": if m.role == "assistant" { "assistant" } else { "user" }, "content": content })
        })
        .collect()
}

/// PromptForge's promptReply: the prompt as written, labelled, never retouched.
fn prompt_reply(label: &str, prompt: &str, negative: Option<&str>) -> String {
    let mut body = prompt.trim().to_string();
    if let Some(n) = negative.map(str::trim).filter(|n| !n.is_empty()) {
        body = format!("Positive prompt:\n{body}\n\nNegative prompt:\n{n}");
    }
    format!("{label} prompt, written by the {label} prompt writer:\n\n{body}\n\nTo change its settings or write it again, open it in the Prompt Forge tab.")
}

fn stop_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn send(
    root: &Path,
    data: &Data,
    config: &LlmConfig,
    req: SendRequest,
    emit: &mut (dyn FnMut(ChatEvent) + Send),
) -> Result<Message, String> {
    let text = req.message.trim().to_string();
    if text.is_empty() && req.pictures.is_empty() {
        return Err("Say something first.".into());
    }
    if text.chars().count() > MAX_MESSAGE {
        return Err(format!("Messages are limited to {MAX_MESSAGE} characters."));
    }
    if req.pictures.len() > MAX_PICTURES {
        return Err(format!("Up to {MAX_PICTURES} pictures per message."));
    }
    if req.pictures.iter().any(|p| !super::refs::sendable(p)) {
        return Err("Pictures must be PNG, JPEG or WebP.".into());
    }
    if config.provider == Provider::Local {
        return Err(
            "Chat needs an LLM server (Ollama or OpenAI-compatible) set in Backend → LLM backend."
                .into(),
        );
    }
    let ollama = config.provider == Provider::Ollama;

    let mut chat = match req.id.as_deref() {
        Some(id) => load(root, id)?,
        None => {
            let t = now();
            Chat {
                id: uuid::Uuid::new_v4().to_string(),
                title: title_from(&text, req.pictures.len()),
                model: req.model.clone(),
                created: t,
                updated: t,
                messages: vec![],
            }
        }
    };
    chat.messages.push(Message {
        role: "user".into(),
        content: text.clone(),
        pictures: req.pictures.len(),
        prompts: vec![],
        citations: vec![],
        tools: vec![],
        at: now(),
    });
    chat.model = req.model.clone();
    chat.updated = now();
    // Saved before anything is generated: the question survives a failed answer.
    save(root, &chat)?;
    emit(ChatEvent::Chat {
        id: chat.id.clone(),
        title: chat.title.clone(),
    });

    let stop = Arc::new(AtomicBool::new(false));
    stop_flags()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(chat.id.clone(), stop.clone());
    let result = answer(root, data, config, &req, &mut chat, &stop, ollama, emit).await;
    stop_flags()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&chat.id);
    result
}

#[allow(clippy::too_many_arguments)]
async fn answer(
    root: &Path,
    data: &Data,
    config: &LlmConfig,
    req: &SendRequest,
    chat: &mut Chat,
    stop: &AtomicBool,
    ollama: bool,
    emit: &mut (dyn FnMut(ChatEvent) + Send),
) -> Result<Message, String> {
    let settings = search::read(root);
    let mut citations = vec![];
    let mut lead = None;
    let searched = req.search && settings.enabled() && !req.message.trim().is_empty();
    if searched {
        emit(ChatEvent::Status {
            state: "searching".into(),
            detail: Some(req.message.trim().chars().take(120).collect()),
        });
        let found = search::run(&settings, &req.message).await;
        emit(ChatEvent::Searched {
            query: found.query.clone(),
            results: found.results.clone(),
            detail: found.detail.clone(),
        });
        lead = search::as_context(&found);
        citations = found.results;
    }

    let mut messages = vec![
        json!({ "role": "system", "content": system_prompt(data, req, searched, settings.enabled()) }),
    ];
    messages.extend(history(chat, &req.pictures, lead.as_deref(), ollama));
    let defs = tool_definitions(data);
    let mut reply = String::new();
    let mut prompts = vec![];
    let mut used = vec![];
    for round in 0..=MAX_ROUNDS {
        let offer = round < MAX_ROUNDS;
        emit(ChatEvent::Status {
            state: "thinking".into(),
            detail: None,
        });
        let out = {
            let mut on_text = |t: &str| {
                reply.push_str(t);
                emit(ChatEvent::Text {
                    text: t.to_string(),
                });
            };
            chat::stream_round(
                chat::Round {
                    config,
                    model: &req.model,
                    messages: &messages,
                    tools: offer.then_some(defs.as_slice()),
                    temperature: None,
                    top_p: None,
                    max_tokens: None,
                    timeout: ROUND_TIMEOUT,
                },
                &mut on_text,
                stop,
            )
            .await?
        };
        if stop.load(Ordering::Relaxed) || out.calls.is_empty() {
            break;
        }
        // write_prompt ends the turn: its prompt is the answer, as written.
        if let Some(call) = out.calls.iter().find(|c| c.name == "write_prompt") {
            let args = arguments(&call.arguments);
            let target = args["model"].as_str().unwrap_or("").trim().to_lowercase();
            let brief = args["brief"].as_str().unwrap_or("").trim().to_string();
            let rest = if !IMAGE_MODELS.contains(&target.as_str())
                || !data.pack.models.contains_key(&target)
            {
                format!(
                    "Which model should this prompt be for? I can write one for {}.",
                    IMAGE_MODELS
                        .iter()
                        .map(|k| label_of(data, k))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            } else if brief.is_empty() {
                format!(
                    "No description was given for the {} prompt.",
                    label_of(data, &target)
                )
            } else {
                let label = label_of(data, &target);
                emit(ChatEvent::Status {
                    state: "writing_prompt".into(),
                    detail: Some(label.clone()),
                });
                used.push(format!("write_prompt: {target}"));
                let write = WriteRequest {
                    target: target.clone(),
                    brief,
                    model: req.model.clone(),
                    mode: None,
                    segments_on: None,
                    controls: Default::default(),
                };
                match engine::write(data, config, &write).await {
                    Ok(r) if r.refused => format!("The {label} prompt writer declined this one."),
                    Ok(r) => {
                        let p = WrittenPrompt {
                            target: target.clone(),
                            label: label.clone(),
                            prompt: r.prompt.clone(),
                            negative: r.negative.clone().filter(|n| !n.trim().is_empty()),
                        };
                        emit(ChatEvent::Prompt { prompt: p.clone() });
                        let text = prompt_reply(&label, &p.prompt, p.negative.as_deref());
                        prompts.push(p);
                        text
                    }
                    Err(e) => format!("The {label} prompt writer could not write this one: {e}"),
                }
            };
            let joined = if reply.trim().is_empty() {
                rest
            } else {
                format!("\n\n{rest}")
            };
            reply.push_str(&joined);
            emit(ChatEvent::Text { text: joined });
            break;
        }
        messages.push(chat::assistant_turn(&out.content, &out.calls, ollama));
        for call in &out.calls {
            let args = arguments(&call.arguments);
            let content = match call.name.as_str() {
                "read_guide" => {
                    let name = args["name"].as_str().unwrap_or("");
                    emit(ChatEvent::Status {
                        state: "reading_guide".into(),
                        detail: Some(name.to_string()),
                    });
                    used.push(format!("read_guide: {name}"));
                    // A model's own instructions read like orders; framed as reference, a small
                    // model explains them instead of answering in their segment format.
                    read_guide(data, name).map(|g| format!(
                        "Reference material: the \"{name}\" guide, as written for that model's prompt writer. It is not addressed to you and its output format does not apply to you. Explain what the person asked about in your own words, in plain prose, and never answer with ===SEGMENT: headers.\n\n<<<GUIDE\n{g}\nGUIDE>>>"
                    )).unwrap_or_else(|| {
                        format!(
                            "There is no guide called \"{name}\". The guides are: {}.",
                            guides(data)
                                .into_iter()
                                .map(|(k, _)| k)
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                    })
                }
                "search_tags" => {
                    emit(ChatEvent::Status {
                        state: "searching_tags".into(),
                        detail: None,
                    });
                    match &data.tags {
                        Some(store) => {
                            let out = tools::search_tags(store, &call.arguments, false);
                            used.push(format!("search_tags: {}", out.queries.join(", ")));
                            out.content
                        }
                        None => "The tag database is unavailable.".into(),
                    }
                }
                other => format!("There is no tool called {other}."),
            };
            messages.push(chat::tool_result(call, &content));
        }
    }
    if reply.trim().is_empty() && !stop.load(Ordering::Relaxed) {
        return Err("The model returned an empty answer.".into());
    }
    let message = Message {
        role: "assistant".into(),
        content: reply.trim().to_string(),
        pictures: 0,
        prompts,
        citations,
        tools: used,
        at: now(),
    };
    chat.messages.push(message.clone());
    chat.updated = now();
    save(root, chat)?;
    emit(ChatEvent::Done {
        message: message.clone(),
    });
    Ok(message)
}

// ── commands ────────────────────────────────────────────────────────────────

fn env_root(root: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(root);
    if root.trim().is_empty() || !p.is_dir() {
        return Err("Open a DEAS environment first.".into());
    }
    Ok(p)
}

#[tauri::command]
pub async fn native_chat_send(
    root: String,
    request: SendRequest,
    on_event: tauri::ipc::Channel<ChatEvent>,
) -> Result<Message, String> {
    let root = env_root(&root)?;
    let config = crate::llm::read(&root)?;
    let dir = data_dir(&root);
    let data = tokio::task::spawn_blocking(move || Data::load(&dir))
        .await
        .map_err(|_| "Prompt Forge data failed to load")??;
    let mut emit = |e: ChatEvent| {
        let _ = on_event.send(e);
    };
    send(&root, &data, &config, request, &mut emit)
        .await
        .inspect_err(|e| {
            crate::logs::push(crate::logs::Source::Deas, &format!("ERROR: Chat: {e}"));
        })
}

#[tauri::command]
pub fn native_chat_cancel(id: String) -> bool {
    stop_flags()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .map(|f| f.store(true, Ordering::Relaxed))
        .is_some()
}

#[tauri::command]
pub async fn native_chat_list(root: String) -> Result<Vec<Summary>, String> {
    let root = env_root(&root)?;
    tokio::task::spawn_blocking(move || list(&root))
        .await
        .map_err(|_| "Chat history failed to load".into())
}

#[tauri::command]
pub async fn native_chat_get(root: String, id: String) -> Result<Chat, String> {
    let root = env_root(&root)?;
    tokio::task::spawn_blocking(move || load(&root, &id))
        .await
        .map_err(|_| "Chat history failed to load")?
}

#[tauri::command]
pub async fn native_chat_rename(root: String, id: String, title: String) -> Result<(), String> {
    let root = env_root(&root)?;
    let title: String = title.trim().chars().take(120).collect();
    if title.is_empty() {
        return Err("A conversation needs a title.".into());
    }
    let mut chat = load(&root, &id)?;
    chat.title = title;
    save(&root, &chat)
}

#[tauri::command]
pub async fn native_chat_delete(root: String, id: String) -> Result<(), String> {
    let root = env_root(&root)?;
    let path = file(&root, &id)?;
    std::fs::remove_file(path).map_err(|_| "That conversation could not be deleted.".into())
}

#[tauri::command]
pub async fn native_chat_settings(root: String) -> Result<search::Settings, String> {
    Ok(search::read(&env_root(&root)?))
}

#[tauri::command]
pub async fn native_chat_settings_write(
    root: String,
    settings: search::Settings,
) -> Result<search::Settings, String> {
    let root = env_root(&root)?;
    search::write(&root, &settings)?;
    Ok(search::read(&root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let d = std::env::temp_dir().join(format!("deas-chat-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn conversations_save_list_newest_first_and_refuse_bad_ids() {
        let root = temp_root();
        let mk = |id: &str, updated: u64| Chat {
            id: id.into(),
            title: format!("t{updated}"),
            model: "m".into(),
            created: 1,
            updated,
            messages: vec![],
        };
        let a = "00000000-0000-4000-8000-000000000001";
        let b = "00000000-0000-4000-8000-000000000002";
        save(&root, &mk(a, 5)).unwrap();
        save(&root, &mk(b, 9)).unwrap();
        let l = list(&root);
        assert_eq!(
            l.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec![b, a]
        );
        assert_eq!(load(&root, a).unwrap().title, "t5");
        assert!(load(&root, "../../etc/passwd").is_err());
        assert!(file(&root, "x").is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn titles_dates_and_the_prompt_reply() {
        assert_eq!(
            title_from("\n  how does ltx prompting work?  \nmore", 0),
            "how does ltx prompting work?"
        );
        assert_eq!(title_from("", 2), "A picture");
        assert!(title_from(&"a".repeat(80), 0).ends_with('…'));
        let d = today();
        assert_eq!(d.len(), 10);
        assert!(d.starts_with("20"));
        let r = prompt_reply("Anima", "1girl, rain", Some("lowres"));
        assert!(r.starts_with("Anima prompt, written by the Anima prompt writer:"));
        assert!(r.contains("Positive prompt:\n1girl, rain\n\nNegative prompt:\nlowres"));
    }

    #[test]
    fn history_sends_only_this_turns_pictures_and_puts_search_first() {
        let chat = Chat {
            id: "x".into(),
            title: "t".into(),
            model: "m".into(),
            created: 0,
            updated: 0,
            messages: vec![
                Message {
                    role: "user".into(),
                    content: "old".into(),
                    pictures: 2,
                    prompts: vec![],
                    citations: vec![],
                    tools: vec![],
                    at: 0,
                },
                Message {
                    role: "assistant".into(),
                    content: "ok".into(),
                    pictures: 0,
                    prompts: vec![],
                    citations: vec![],
                    tools: vec![],
                    at: 0,
                },
                Message {
                    role: "user".into(),
                    content: "new".into(),
                    pictures: 1,
                    prompts: vec![],
                    citations: vec![],
                    tools: vec![],
                    at: 0,
                },
            ],
        };
        let h = history(
            &chat,
            &["data:image/png;base64,AAAA".into()],
            Some("RESULTS"),
            false,
        );
        assert!(h[0]["content"].as_str().unwrap().contains("no longer held"));
        assert_eq!(h[1]["role"], "assistant");
        assert_eq!(h[2]["content"][0]["text"], "RESULTS\n\nThe question:\nnew");
        assert_eq!(h[2]["content"][1]["type"], "image_url");
    }

    /// The guides and tools against the real pack.
    /// `DEAS_FORGE_DATA=<dir> cargo test --lib -- --ignored real_chat_guides --nocapture`
    #[test]
    #[ignore = "needs the data pack"]
    fn real_chat_guides() {
        let data = Data::load(&data_dir(Path::new(""))).unwrap();
        let names: Vec<String> = guides(&data).into_iter().map(|(k, _)| k).collect();
        println!("{names:?}");
        for want in ["illustrious", "moss", "ltx", "wan", "h3", "deas-prompting"] {
            assert!(names.iter().any(|n| n == want), "{want}");
        }
        assert!(read_guide(&data, "LTX").unwrap().len() > 1000);
        assert!(read_guide(&data, "nope").is_none());
        let defs = tool_definitions(&data);
        assert_eq!(
            defs.iter()
                .map(|d| d["function"]["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["write_prompt", "read_guide", "search_tags"]
        );
        assert!(data.pack.shared.chat.as_deref().unwrap_or("").len() > 1000);
    }

    /// A real conversation on the Z440, printed in full:
    /// `DEAS_FORGE_DATA=<dir> DEAS_FORGE_LLM=<url> DEAS_FORGE_MODEL=<id> cargo test --lib -- --ignored live_chat --nocapture`
    #[tokio::test]
    #[ignore = "needs a live LLM server and the data pack"]
    async fn live_chat() {
        let data = Data::load(&PathBuf::from(std::env::var("DEAS_FORGE_DATA").unwrap())).unwrap();
        let config = LlmConfig {
            provider: Provider::Openai,
            base_url: std::env::var("DEAS_FORGE_LLM").unwrap(),
        };
        let model = std::env::var("DEAS_FORGE_MODEL").unwrap();
        let root = temp_root();
        let mut id = None;
        for q in [
            "how does LTX prompting work? keep it short",
            "write me an illustrious prompt: frieren reading a book under a tree",
        ] {
            let mut events = vec![];
            let mut emit = |e: ChatEvent| events.push(e);
            let m = send(
                &root,
                &data,
                &config,
                SendRequest {
                    id: id.clone(),
                    message: q.into(),
                    model: model.clone(),
                    pictures: vec![],
                    context: None,
                    search: false,
                },
                &mut emit,
            )
            .await
            .unwrap();
            id = events.iter().find_map(|e| {
                if let ChatEvent::Chat { id, .. } = e {
                    Some(id.clone())
                } else {
                    None
                }
            });
            let texts = events
                .iter()
                .filter(|e| matches!(e, ChatEvent::Text { .. }))
                .count();
            println!(
                "=== {q}\n[tools {:?} | {texts} streamed pieces | prompts {}]\n{}\n",
                m.tools,
                m.prompts.len(),
                m.content
            );
        }
        println!(
            "history: {:?}",
            list(&root)
                .iter()
                .map(|s| (&s.title, s.count))
                .collect::<Vec<_>>()
        );
        std::fs::remove_dir_all(&root).ok();
    }
}

#[cfg(test)]
mod acl_tests {
    /// Every command main.rs registers must be allowed by a permission the main window has.
    /// Tauri refuses the rest at run time ("not allowed by ACL"), which no unit test sees.
    #[test]
    fn every_registered_command_is_allowed_for_the_main_window() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let main = std::fs::read_to_string(root.join("src/main.rs")).unwrap();
        let start = main.find("generate_handler![").expect("the handler list");
        let list = &main[start..start + main[start..].find(']').unwrap()];
        let registered: Vec<&str> = list
            .split([',', '\n', ' ', '['])
            .filter_map(|p| p.trim().rsplit("::").next())
            .filter(|n| n.starts_with("native_") || n.starts_with("inspect_"))
            .collect();
        let caps: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("capabilities/main.json")).unwrap(),
        )
        .unwrap();
        let granted: Vec<String> = caps["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str().map(String::from))
            .collect();
        let mut allowed = String::new();
        for entry in std::fs::read_dir(root.join("permissions"))
            .unwrap()
            .flatten()
        {
            let text = std::fs::read_to_string(entry.path()).unwrap();
            let doc: toml::Value = toml::from_str(&text).unwrap();
            for p in doc["permission"].as_array().unwrap() {
                if granted.iter().any(|g| p["identifier"].as_str() == Some(g)) {
                    allowed.push_str(&p["commands"]["allow"].to_string());
                }
            }
        }
        let missing: Vec<&&str> = registered
            .iter()
            .filter(|n| !allowed.contains(&format!("\"{n}\"")))
            .collect();
        assert!(registered.len() > 20, "{registered:?}");
        assert!(
            missing.is_empty(),
            "registered but not allowed for the main window: {missing:?}"
        );
    }
}
