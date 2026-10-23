//! Reference pictures on the image models, ported from PromptForge's
//! server/imagerefs.mjs and server/refblueprint.mjs.
//!
//! Each picture says what it is FOR (its role) and how closely to follow it
//! (its fidelity), plus an optional note that outranks both. Look first, write
//! second: one call reads the pictures under their roles and writes a factual
//! reading; the pictures then come off the wire and the prompt is written from
//! that text. If the reading is unusable, the pictures ride with the write
//! instead, which is how PromptForge worked before the reading pass existed.

use super::pack::Pack;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Default, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImageRef {
    pub role: String,
    pub fidelity: String,
    /// What to take from it, in the person's words; outranks the role.
    pub note: String,
    /// Who this is, for a Character reference.
    pub character: String,
    pub applies_to: String,
    /// The picture as a data URI (png, jpeg or webp), already sized by the tab.
    pub image: String,
}

/// Roles whose `character` field names the person in the picture.
const CARRIES_CHARACTER: &[&str] = &["character"];
const MAX_DATA_URI: usize = 12 * 1024 * 1024;
pub const BLUEPRINT_TEMPERATURE: f64 = 0.2;

pub fn blueprint_budget(images: usize) -> u32 {
    (650 + images as u32 * 180).min(1600)
}

fn roles(pack: &Pack) -> Option<&serde_json::Map<String, Value>> {
    pack.defaults
        .get("image_reference_roles")
        .and_then(Value::as_object)
}

fn role_def<'a>(pack: &'a Pack, role: &str) -> Option<&'a Value> {
    roles(pack)?.get(role)
}

fn text<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a str> {
    v?.get(key)?.as_str().filter(|s| !s.is_empty())
}

/// Grouped by role in the registry's order, so the numbers in the notes match
/// the order the pictures go up in.
pub fn order(refs: &[ImageRef], pack: &Pack) -> Vec<ImageRef> {
    let order = &pack.role_order;
    let fallback = pack
        .defaults
        .get("default_image_reference_role")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| order.first().cloned())
        .unwrap_or_default();
    let known = |r: &str| roles(pack).is_some_and(|m| m.contains_key(r));
    let normal: Vec<ImageRef> = refs
        .iter()
        .map(|r| ImageRef {
            role: if known(&r.role) {
                r.role.clone()
            } else {
                fallback.clone()
            },
            ..r.clone()
        })
        .collect();
    let mut out = vec![];
    for role in order {
        out.extend(normal.iter().filter(|r| &r.role == role).cloned());
    }
    out.extend(normal.into_iter().filter(|r| !order.contains(&r.role)));
    out
}

pub(crate) fn sendable(uri: &str) -> bool {
    let Some(rest) = [
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/webp;base64,",
    ]
    .iter()
    .find_map(|p| uri.strip_prefix(p)) else {
        return false;
    };
    uri.len() <= MAX_DATA_URI
        && !rest.is_empty()
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

/// The references whose pictures can go up, in order, and how many could not.
pub fn sendable_refs(refs: &[ImageRef], pack: &Pack) -> (Vec<ImageRef>, usize) {
    let max = pack
        .defaults
        .get("max_image_references")
        .and_then(Value::as_u64)
        .unwrap_or(6) as usize;
    let mut sent = vec![];
    let mut dropped = 0;
    for r in order(refs, pack) {
        if r.image.is_empty() {
            continue;
        }
        if sent.len() >= max || !sendable(&r.image) {
            dropped += 1;
            continue;
        }
        sent.push(r);
    }
    (sent, dropped)
}

const LEAVE_TOPICS: &[&[&str]] = &[
    &[
        "background",
        "setting",
        "scene",
        "location",
        "environment",
        "room",
        "place",
        "backdrop",
        "surround",
        "everything around",
    ],
    &[
        "cloth",
        "outfit",
        "footwear",
        "shoe",
        "what they wear",
        "dress",
        "costume",
        "garment",
        "uniform",
    ],
    &["accessor", "jewel", "outfit"],
    &["hair"],
    &["eye"],
    &[
        "who",
        "character",
        "identity",
        "face",
        "same person",
        "same girl",
        "same guy",
        "same woman",
        "same man",
    ],
    &["body"],
    &["pose", "posture", "doing"],
    &["light"],
    &["palette", "colour", "color"],
    &["style", "drawing", "rendering", "art"],
    &["composition", "framing", "camera", "angle"],
];
const NEGATIONS: &[&str] = &[
    "no", "not", "dont", "don't", "do not", "without", "ignore", "leave", "except", "skip", "drop",
    "minus", "never",
];

/// `\bword` in lowercase text: the word starts at a word boundary.
fn starts_word(text: &str, w: &str) -> bool {
    text.match_indices(w).any(|(i, _)| {
        let before = text[..i].chars().next_back();
        let boundary = before.is_none_or(|c| !c.is_alphanumeric() && c != '_');
        // PromptForge's `character(?!istic)`.
        boundary && !(w == "character" && text[i + w.len()..].starts_with("istic"))
    })
}

fn whole_word(text: &str, w: &str) -> bool {
    text.match_indices(w).any(|(i, _)| {
        let ok = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric() && c != '_' && c != '\'');
        ok(text[..i].chars().next_back()) && ok(text[i + w.len()..].chars().next())
    })
}

fn topics_in(text: &str) -> Vec<usize> {
    let t = format!(" {} ", text.to_lowercase());
    LEAVE_TOPICS
        .iter()
        .enumerate()
        .filter(|(_, words)| words.iter().any(|w| starts_word(&t, w)))
        .map(|(i, _)| i)
        .collect()
}

fn asked_topics(note: &str) -> Vec<usize> {
    let mut asked = vec![];
    let lowered = note.to_lowercase().replace(" but ", ",");
    for clause in lowered.split([',', '.', ';']) {
        if clause.trim().is_empty() || NEGATIONS.iter().any(|n| whole_word(clause, n)) {
            continue;
        }
        for i in topics_in(clause) {
            if !asked.contains(&i) {
                asked.push(i);
            }
        }
    }
    asked
}

/// The role's LEAVE list minus whatever the person's note asked to take.
pub fn leave_for(ignore: &str, note: &str) -> String {
    let text = ignore.trim();
    if text.is_empty() {
        return String::new();
    }
    let asked = asked_topics(note);
    if asked.is_empty() {
        return text.to_string();
    }
    let hit = |s: &str| topics_in(s).iter().any(|i| asked.contains(i));
    let mut sentences = text.split_inclusive(". ").map(str::trim);
    let list = sentences.next().unwrap_or("");
    let rest: Vec<&str> = sentences.collect();
    let items: Vec<&str> = list
        .trim_end_matches('.')
        .split([';', ','])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let kept: Vec<&str> = items.iter().copied().filter(|i| !hit(i)).collect();
    let tail: Vec<&str> = rest.iter().copied().filter(|s| !hit(s)).collect();
    if kept.len() == items.len() && tail.len() == rest.len() {
        return text.to_string();
    }
    let head = if kept.is_empty() {
        String::new()
    } else {
        format!("{}.", kept.join("; "))
    };
    std::iter::once(head)
        .chain(tail.into_iter().map(String::from))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The reading pass's question: the brief as context (or as the instruction,
/// for a brief-driven role), then each picture under its own TAKE / LEAVE.
pub fn blueprint_message(sent: &[ImageRef], brief: &str, pack: &Pack) -> String {
    let mut lines: Vec<String> = vec![];
    let brief_driven = sent.iter().any(|r| {
        role_def(pack, &r.role)
            .and_then(|d| d.get("driven_by_brief"))
            .and_then(Value::as_bool)
            == Some(true)
    });
    let trimmed = brief.trim();
    if !trimmed.is_empty() {
        if brief_driven {
            lines.push(format!("What the person asked for: \"{trimmed}\""));
            lines.push(String::new());
            lines.push("That is your instruction for what to take from the picture and what to leave. Read the picture against it. Whatever they did not ask to change, they are keeping — describe it so it can be redrawn. Do not write the prompt itself; that is the next step.".into());
        } else {
            lines.push(format!("The prompt this will be used for: \"{trimmed}\""));
            lines.push(String::new());
            lines.push("That is context only. Do not answer it, and do not write a prompt.".into());
        }
        lines.push(String::new());
    }
    lines.push(if sent.len() == 1 {
        "One picture is attached. Read it under the role below.".into()
    } else {
        format!(
            "{} pictures are attached, in the order listed below. Read each under its own role.",
            sent.len()
        )
    });
    lines.push(String::new());
    for (i, r) in sent.iter().enumerate() {
        let def = role_def(pack, &r.role);
        lines.push(format!(
            "Reference {} — {}",
            i + 1,
            text(def, "label").unwrap_or(&r.role)
        ));
        if let Some(take) = text(def, "extract").or(text(def, "rule")) {
            lines.push(format!("  TAKE: {take}"));
        }
        let leave = leave_for(text(def, "ignore").unwrap_or(""), &r.note);
        if !leave.is_empty() {
            lines.push(format!("  LEAVE: {leave}"));
        }
        if !r.character.trim().is_empty() && CARRIES_CHARACTER.contains(&r.role.as_str()) {
            lines.push(format!("  This is {}.", r.character.trim()));
        }
        if !r.applies_to.trim().is_empty() {
            lines.push(format!("  Applies to: {}", r.applies_to.trim()));
        }
        if !r.note.trim().is_empty() {
            lines.push(format!(
                "  THE PERSON ASKED FOR, and this outranks the two above: {}",
                r.note.trim()
            ));
        }
        lines.push(String::new());
    }
    lines.join("\n")
}

pub fn strip_fence(text: &str) -> String {
    text.lines()
        .filter(|l| {
            let t = l.trim();
            !(t.starts_with("```") && t[3..].chars().all(|c| c.is_ascii_alphabetic()))
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

pub fn usable(text: &str) -> bool {
    let t = strip_fence(text);
    !t.is_empty() && !t.to_uppercase().starts_with("UNAVAILABLE") && t.chars().count() >= 120
}

pub const BLUEPRINT_RULE: &str = "Reference reading — this is the completed visual analysis of the pictures the user attached.
You are not being shown those pictures, and you do not need them: everything below was read off
them for you. Write the prompt from it directly. Do not ask to see the images, and do not mention
them.

The role boundaries in that reading are absolute. A Pose reading gives you geometry and nothing
else — never carry across the identity, face, hair, eyes, outfit, accessories, setting, lighting or
drawing style of whoever was in that picture. The character named in the brief is the one who goes
in the prompt.

A Whole picture reading is the opposite: everything in it carries across EXCEPT the identities.
It describes every person in the frame, and every one of them belongs in your prompt — their
clothes, what they are doing, where they stand, and their number. The brief names which of them is
being replaced and by whom. That one becomes the character the brief names; everybody else stays
exactly as the reading describes them, and the subject count does not change. Replacing one person
in a picture of two must not produce a prompt with one person in it.

Where the brief contradicts the reading, the brief wins. It is the person telling you what they
want; the reading only says what was in the picture.

Your prompt must never contain the words \"reference\", \"picture 1\", \"the source image\", \"same pose\",
\"as shown\" or any other pointer back at an image. Whoever reads your prompt has no image. Write out
the geometry, the garment, the light — the things the reading gave you.";

/// The notes block for the user turn, with the reading under it when there is one.
pub fn block(
    refs: &[ImageRef],
    pack: &Pack,
    underscore: bool,
    carries: bool,
    analysis: Option<&str>,
) -> String {
    let ordered = order(refs, pack);
    if ordered.is_empty() {
        return String::new();
    }
    let fidelities = pack
        .defaults
        .get("reference_fidelity")
        .and_then(Value::as_object);
    let default_fidelity = pack
        .defaults
        .get("default_reference_fidelity")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| fidelities.and_then(|f| f.keys().next().cloned()))
        .unwrap_or_default();
    let spell = |t: &str| {
        if underscore {
            t.to_string()
        } else {
            t.replace('_', " ")
        }
    };
    let analysed = analysis.is_some_and(|a| !a.trim().is_empty());
    let mut lines = vec![if analysed {
        "Reference pictures the user attached. You are not being shown them — they have already been read for you, and that reading is below. These notes say what each picture is FOR and how closely to follow it:"
    } else if carries {
        "Reference images the user attached, in the order they are numbered below. Look at them. These notes say what each picture is FOR and how closely to follow it, which is the part you cannot see by looking — a photograph does not say it was attached for the lighting:"
    } else {
        "Reference images the user attached. You cannot see the pictures — only these notes reached you, so do not describe them beyond what is written here:"
    }
    .to_string()];
    for (i, r) in ordered.iter().enumerate() {
        let def = role_def(pack, &r.role);
        let fkey = if fidelities.is_some_and(|f| f.contains_key(&r.fidelity)) {
            r.fidelity.clone()
        } else {
            default_fidelity.clone()
        };
        let frule = def
            .and_then(|d| d.get("fidelity_rules"))
            .and_then(|f| f.get(&fkey))
            .and_then(|f| f.get("rule"))
            .and_then(Value::as_str)
            .or_else(|| {
                fidelities
                    .and_then(|f| f.get(&fkey))
                    .and_then(|f| f.get("rule"))
                    .and_then(Value::as_str)
            });
        let mut head = format!(
            "- Reference {} — {}",
            i + 1,
            text(def, "label").unwrap_or(&r.role)
        );
        if let Some(rule) = text(def, "compile_rule").or(text(def, "rule")) {
            head.push_str(&format!(": {rule}"));
        }
        lines.push(head);
        if !r.character.trim().is_empty() && CARRIES_CHARACTER.contains(&r.role.as_str()) {
            lines.push(format!("  character: {}", spell(r.character.trim())));
        }
        if !r.applies_to.trim().is_empty() {
            lines.push(format!("  applies to: {}", spell(r.applies_to.trim())));
        }
        if !r.note.trim().is_empty() {
            lines.push(format!("  take from it: {}", r.note.trim()));
        }
        if let Some(rule) = frule {
            lines.push(format!("  how closely: {rule}"));
        }
    }
    if let Some(a) = analysis.filter(|a| !a.trim().is_empty()) {
        lines.push(String::new());
        lines.push(BLUEPRINT_RULE.to_string());
        lines.push(String::new());
        lines.push(a.trim().to_string());
    }
    lines.join("\n")
}

/// Analyze's question: the role, the fidelity and the note, then "read it back".
pub fn readback_question(r: &ImageRef, pack: &Pack) -> String {
    let ordered = order(std::slice::from_ref(r), pack);
    let r = &ordered[0];
    let def = role_def(pack, &r.role);
    let fidelities = pack
        .defaults
        .get("reference_fidelity")
        .and_then(Value::as_object);
    let fkey = if fidelities.is_some_and(|f| f.contains_key(&r.fidelity)) {
        r.fidelity.clone()
    } else {
        pack.defaults
            .get("default_reference_fidelity")
            .and_then(Value::as_str)
            .unwrap_or("close")
            .to_string()
    };
    let fdef = fidelities.and_then(|f| f.get(&fkey));
    let mut lines = vec![format!(
        "This picture is a {} reference.",
        text(def, "label").unwrap_or(&r.role).to_uppercase()
    )];
    if let Some(rule) = text(def, "rule") {
        lines.push(format!("What that role covers: {rule}"));
    }
    lines.push(format!(
        "How closely the user wants it followed: {}{}",
        text(fdef, "label").unwrap_or(&fkey),
        text(fdef, "rule")
            .map(|r| format!(" — {r}"))
            .unwrap_or_default()
    ));
    if !r.note.trim().is_empty() {
        lines.push(format!(
            "\nWhat they said to take from it, in their own words:\n\"{}\"",
            r.note.trim().chars().take(2000).collect::<String>()
        ));
    }
    lines.push("\nRead it back to them.".into());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_takes_back_what_the_role_would_leave() {
        let ignore = "The pose, the outfit, the setting, the lighting, the composition.";
        assert_eq!(leave_for(ignore, ""), ignore);
        assert_eq!(
            leave_for(ignore, "take the outfit too"),
            "The pose; the setting; the lighting; the composition."
        );
        // A negated clause asks for nothing.
        assert_eq!(leave_for(ignore, "not the outfit"), ignore);
        assert_eq!(
            leave_for(ignore, "the lighting, but not the outfit"),
            "The pose; the outfit; the setting; the composition."
        );
        assert!(
            starts_word(" a character ", "character")
                && !starts_word(" characteristic ", "character")
        );
    }

    #[test]
    fn only_real_data_uris_go_up() {
        assert!(sendable("data:image/png;base64,iVBORw0KGgo="));
        assert!(!sendable("http://example.com/a.png"));
        assert!(!sendable("data:image/png;base64,<script>"));
        assert!(!sendable("data:image/gif;base64,R0lG"));
    }

    #[test]
    fn readings_need_substance_and_lose_their_fences() {
        assert!(!usable("UNAVAILABLE"));
        assert!(!usable("short"));
        let long = format!(
            "```text\nREFERENCE 1 — POSE\n\nUSE:\n{}\n```",
            "standing, weight on the left leg, ".repeat(5)
        );
        assert!(usable(&long));
        assert!(!strip_fence(&long).contains("```"));
    }
}
