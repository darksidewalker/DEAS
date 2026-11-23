//! LEG M11a — the INTENT TRUTH harness (owner-ordered).
//!
//! What this file proves, and how far it reaches:
//!
//! 1. **The pipeline is the real door.** Every OURS-side intent here is produced by
//!    [`routes::queue_post`] — the same `POST /v1/queue` handler the live plane serves
//!    (E16 fold → reference placement → resolver → turbo → defaults ladder →
//!    [`fill_plane::fill`] → `complete_or_refuse` → [`spool::QueueRow::from_plan`] →
//!    spool append). The intent is then re-read from the durable spool through
//!    [`spool::flat_intent`], the exact reconstruction the M4 drain feeds to
//!    `jobs::native_job_prepare` (cycle.rs:886). No hand-built OURS intent exists in
//!    this file: hand-built values appear ONLY on the stock-fixture side of a
//!    differential.
//! 2. **The stock gate is stock.** [`crate::jobs::compile`] (jobs.rs:436) is a pure
//!    `&Value -> Result<Value, String>` and dispatches the music and video arms itself
//!    (`jobs_music::compile` at jobs_music.rs:169, `jobs_video::compile` at
//!    jobs_video.rs:1643). A compile `Err` fails the harness with the stock string
//!    verbatim. RefMod is the separate door and the separate seam
//!    ([`crate::jobs::refmod::compile`], jobs_refmod.rs:51 — this leg widened that
//!    module from private to `pub(crate)` so the harness can gate the export shape at
//!    the stock compile seam: a visibility widening only, no stock behaviour touched).
//! 3. **The differential is structural.** For each stock fixture (jobs_tests.rs:544
//!    `intent()`, `jobs_video::tests::ltx()/wan()/h3()`, the music fixture files,
//!    `jobs_refmod_tests.rs:83 request()`) the closest agent envelope is queued,
//!    compiled, and compared to the raw stock fixture's graph by class_type multiset
//!    plus per-class input-KEY sets. Fewer or more node classes, or a node missing an
//!    input key the stock graph carries, fails with a printed diff.
//! 4. **No silent ladder holes.** Every compiled graph the harness produces is scanned:
//!    no input value may be `null`, and the set of `(class_type, input key)` pairs
//!    carrying an empty string may not exceed the stock fixture's own set. That is the
//!    trouble mode the owner named: stock compile passing a `null` the ladder left open.
//!
//! Two walls agree: every negative asserts BOTH the door's closed refusal word AND that
//! the same raw intent, bypassing fill, is refused by stock compile too.
//!
//! Where the walls deliberately differ (documented, not papered over):
//!
//! * **`prereq` layer is a window proof (M11b), the compile layer is here.**
//!   `recipe_prerequisites` / `allowlist.triton` needs the owned environment over HTTP,
//!   so `options.compile` is refused at the door by the cause (fill_plane.rs:1191) and
//!   nothing in this file can prove a Triton allowlist. The compile-layer half — every
//!   shape law stock `compile` owns — IS exercised here.
//! * **Refine is not the standalone face-refine recipe.** `jobs_face_refine::compile`
//!   (:153) is reached only for `recipeId "h3-face-refine"` (jobs_video.rs:1647), a
//!   recipe this plane exposes no mode for. The `faceRefine` BLOCK this door passes
//!   through is validated inside the parent compile (jobs.rs:680, jobs_video.rs:1506);
//!   the harness covers that leg, and the mode-`refmod` queue row (E28, LEG
//!   AF2-M24c) has no compile-side leg here — its submission is the stock export.
//! * **Family-fixed samplers are door-side only in ONE direction.** Stock enforces the
//!   same `fixed_sampler`/`step_choices` words (jobs_video.rs:1453-1465), so the walls
//!   agree; the door adds no sampler law stock lacks.
//!
//! Expected VALUE-level diffs against the stock fixtures (shapes still agree):
//!
//! | fixture | field | stock fixture | the ladder's choice | why |
//! |---|---|---|---|---|
//! | image | `seed` | 123 | 123 (fixed) | pinned through `seedMode:fixed` |
//! | image | `imageFormat` | absent | `"png"` | §6.5 floor; `compile` only validates it |
//! | h3 video | `outputPrefix` | `"video/2026-10-18/x"` | `"agent/h3"` | a slot, never a fixture |
//! | music | `generation.cfgScale` | 1.01 | 1.0 | `MUSIC_GENERATION_DEFAULTS` mirrors the Workbench seed |
//! | music | `style` | `"English, indie pop"` | same text via `positivePrompt` | the prompt slot IS the conditioning |

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use serde_json::{json, Value};

use super::config::AgentSettings;
use super::cycle;
use super::defaults;
use super::errors::ErrorKind;
use super::idempotency;
use super::lanes::Lanes;
use super::resolver::IndexSource;
use super::results::FakeRefmodBridge;
use super::results::FakeResultsBridge;
use super::resume;
use super::routes;
use super::scan::FakeScanBridge;
use super::spool::{self, QueueRow, Spool};
use super::uploads::RecordingUploadBridge;
use super::watchdog::{Watchdog, WatchdogSeams};
use super::PlaneState;

/* --------------------------------- the fake library --------------------------------- */

/// The anima index record's SHA-256, and the §9 handle drawn from its prefix.
const ANIMA_SHA: &str = "1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a";
const ANIMA_HANDLE: &str = "1b2c3d4e5f60";

/// One library root holds every family this harness queues against. The index is a
/// pre-built stock-shaped snapshot, exactly the shape `transport::tests` install
/// (transport.rs:1502 `plane_with_library`, `record` at :1537): the file name is the
/// stock reader's own law (`models-<sha256 of the roots array>`), and `detector` must
/// equal the package version or `load_index` refuses the file.
fn write_index(index_dir: &Path, root: &Path) -> IndexSource {
    let roots = vec![root.to_path_buf()];
    let key = {
        use sha2::Digest as _;
        format!(
            "{:x}",
            sha2::Sha256::digest(serde_json::to_vec(&roots).expect("roots"))
        )
    };
    let record = |category: &str,
                  name: &str,
                  sha: Option<&str>,
                  family: Option<&str>,
                  component: Option<&str>| {
        json!({
            "stamp": null,
            "model": {
                "category": category,
                "name": name,
                "path": root.join(category).join(name).to_string_lossy(),
                "size": 1024,
                "info": sha.map(|sha| json!({"sha256": sha, "size": 1024, "fetchedAt": 1})),
                "detectedFamily": family,
                "component": component,
            }
        })
    };
    let index = json!({
        "schema": crate::downloads::models::index::SCHEMA,
        "detector": env!("CARGO_PKG_VERSION"),
        "roots": roots,
        "records": [
            // Image families: the self-contained loader and the split one with its two
            // header-verified components.
            record("diffusion_models", "sd/sdxl_base.safetensors", Some("0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9"), Some("sdxl"), None),
            record("diffusion_models", "anima/anima.safetensors", Some(ANIMA_SHA), Some("anima"), None),
            record("text_encoders", "anima/qwen3-0.6b.safetensors", None, None, Some("qwen3-0.6b")),
            record("vae", "anima/wan_2.1_vae.safetensors", None, None, Some("wan-2.1-vae")),
            // Video families. wan declares a `components` map, so its model reference
            // resolves. minimax-h3 declares NO components map in the stock plugin
            // (src/families/builtin.json) and ltx-2 declares a PARTIAL one
            // (`audioVaes`/`textProjections`, no `textEncoders` slot), so the resolver
            // cannot build their split recipe from the index — it answers the honest
            // component refusal naming the slot (pinned by
            // `families_without_a_components_map_refuse_a_model_reference`). The LTX2
            // record exists in the index precisely so that refusal is the components
            // law, not the "no library entry" law.
            record("diffusion_models", "WAN22/high.safetensors", Some("2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1"), Some("wan"), None),
            record("text_encoders", "WAN22/umt5_xxl_fp8.safetensors", None, None, Some("umt5-xxl")),
            record("vae", "WAN22/wan_2.1_vae.safetensors", None, None, Some("wan-2.1-vae")),
            record("diffusion_models", "LTX2/ltx.safetensors", Some("4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3"), Some("ltx-2"), None),
            // Music: the one family this build's music arm compiles (YuE2).
            record("checkpoints", "yue/yue2.safetensors", Some("3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2"), Some("yue2"), None),
            // Music, LEG M14b opened the ACE-Step leg: the 1.0 row's all-in-one
            // checkpoint, for the model-reference door path (the 1.5 split form
            // rides the explicit family word instead).
            record("checkpoints", "ace/ace-step.safetensors", Some("5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4"), Some("ace-step-1-0"), None),
        ],
    });
    std::fs::write(
        index_dir.join(format!("models-{key}.json")),
        serde_json::to_vec(&index).expect("index bytes"),
    )
    .expect("index file");
    IndexSource {
        index_dir: index_dir.to_path_buf(),
        roots,
    }
}

/* ------------------------------------ the plane ------------------------------------- */

/// The truth kit: tempdir app-data, the model root, the plane, and the concrete
/// RefMod bridge handle (the refmod differential reads what the seam received).
/// The construction is `transport::tests::plane_with_app_data` (transport.rs:145) —
/// every file-backed handle captured inside the tempdir — plus the fake library.
pub(super) struct Kit {
    app: tempfile::TempDir,
    /// Held, never read: the model root the fake index paths point inside.
    _root: tempfile::TempDir,
    /// The input root the truth kit's queue door stats against (LEG MEDIA-1
    /// existence law): `door()` physically places every placement name a body
    /// references, so the harness truth stays the INTENT, never the input plane.
    _inputs: tempfile::TempDir,
    plane: PlaneState,
    refmods: Arc<FakeRefmodBridge>,
}

impl Kit {
    pub(super) fn new() -> Self {
        let app = tempfile::tempdir().expect("app-data tempdir");
        let root = tempfile::tempdir().expect("model root tempdir");
        let inputs = tempfile::tempdir().expect("input root tempdir");
        let source = write_index(app.path(), root.path());
        let refmods = Arc::new(FakeRefmodBridge::healthy());
        let plane = PlaneState {
            settings: AgentSettings {
                enabled: true,
                port: 8790,
                standing_key: None,
                origin_allowlist: vec!["http://localhost:1420".to_owned()],

                component_overrides: Default::default(),
            },
            app_data: app.path().to_path_buf(),
            lanes: Arc::new(Lanes::new()),
            spool: Arc::new(Spool::new(app.path())),
            cycle: Arc::new(cycle::CycleCell::new(app.path())),
            cycle_seams: Arc::new(cycle::CycleSeams::defaults_for_tests()),
            watchdog: Arc::new(Watchdog::new(
                app.path(),
                Arc::new(WatchdogSeams::defaults_for_tests()),
            )),
            ledger: Arc::new(idempotency::Ledger::new(app.path())),
            resume: Arc::new(resume::ResumeWatch::scripted_for_tests(Arc::new(
                resume::ScriptProbe::always(true),
            ))),
            results: Arc::new(FakeResultsBridge::healthy()),
            refmods: Arc::clone(&refmods) as Arc<dyn super::results::RefmodBridge>,
            library: Some(source),
            input_root: Some(inputs.path().to_path_buf()),
            output_root: None,
            batch: Arc::new(super::caps::BatchLedger::new()),
            app: None,
            scan: Arc::new(FakeScanBridge::idle()),
            uploads: Arc::new(RecordingUploadBridge::accepting()),
        };
        Self {
            app,
            _root: root,
            _inputs: inputs,
            plane,
            refmods,
        }
    }

    /// The spool row the door appended for `id`, read back off the durable file.
    pub(super) fn row(&self, id: &str) -> QueueRow {
        let rows = self.plane.spool.snapshot().expect("spool readable");
        rows.into_iter()
            .find(|row| row.id == id)
            .expect("the door appended the row it answered")
    }
}

/* ------------------------------- the pipeline under test ----------------------------- */

/// One door call: the REAL `POST /v1/queue` handler, no router and no auth wall (the
/// wall stack is another leg's truth; this harness is about the intent). Answers the
/// verdict body, or the closed-taxonomy body of a refusal.
pub(super) async fn door(kit: &Kit, body: &Value) -> Result<Value, Value> {
    // LEG MEDIA-1: the queue door now stats every input reference the body NAMES
    // (existence law). The harness is about the INTENT, so this helper first
    // physically places every placement-form name the body references — the
    // honest stand-in for "the stranger already uploaded it" — then the door
    // law passes and whatever the fill walls decide is the truth under test.
    if let Some(fields) = body.as_object() {
        let Some(root) = kit.plane.input_root.as_ref() else {
            unreachable!("the truth kit always injects an input root");
        };
        // Fold first (a harness-side copy; the door re-folds the real request):
        // the existence law reads FOLDED names, so `picture1`/`audio1` shorthand
        // must be placed under the canonical placement names they become.
        let mut folded = fields.clone();
        let _ = super::e16::fold(&mut folded);
        for name in super::inputs::referenced_placement_names(&folded) {
            let target = root.join(name.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).expect("placement folder");
            }
            if !target.exists() {
                std::fs::write(&target, b"fixture-placed").expect("placed fixture input");
            }
        }
    }
    let request = Request::builder()
        .method("POST")
        .uri("http://127.0.0.1:8790/v1/queue")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("valid request");
    match routes::queue_post(State(kit.plane.clone()), request).await {
        Ok(answer) => Ok(answer.0.clone()),
        Err(error) => Err(error.body_json()),
    }
}

/// The full pipeline: envelope in, compile-ready flat intent out, read back through the
/// spool exactly as the drain rebuilds it (cycle.rs:886 `spool::flat_intent(row)`).
/// A door refusal is a harness failure naming the reason and hint verbatim.
pub(super) async fn fill_intent(kit: &Kit, body: &Value) -> Value {
    let answer = door(kit, body)
        .await
        .unwrap_or_else(|refusal| panic!("the door refused {body}: {refusal}"));
    let id = answer["id"].as_str().expect("the verdict carries a row id");
    let row = kit.row(id);
    spool::flat_intent(&row)
        .unwrap_or_else(|problem| panic!("row {id} is not drain-ready: {problem}"))
}

/// The stock gate. `jobs::compile` dispatches the music and video arms itself, so this
/// one call IS the whole compile-side surface for the three recipes.
pub(super) fn stock_compile(intent: &Value) -> Value {
    crate::jobs::compile(intent).unwrap_or_else(|problem| {
        panic!(
            "STOCK COMPILE REFUSED OUR FILLED INTENT: {problem}\nintent: {}",
            serde_json::to_string(intent).expect("intent bytes")
        )
    })
}

/// The same gate, for a raw stock fixture: a failure here is the fixture being wrong,
/// not the plane, and is reported as such.
pub(super) fn stock_fixture_compile(intent: &Value, label: &str) -> Value {
    crate::jobs::compile(intent)
        .unwrap_or_else(|problem| panic!("the STOCK fixture '{label}' does not compile: {problem}"))
}

/// The door's closed word for a refusal, naming the reason and the hint.
pub(super) async fn door_refusal(kit: &Kit, body: &Value, want: ErrorKind, names: &str) -> String {
    let refusal = door(kit, body)
        .await
        .expect_err("this body must be refused at the door");
    assert_eq!(
        refusal["reason"].as_str().unwrap_or_default(),
        want.reason(),
        "expected '{}', the door answered: {refusal}",
        want.reason()
    );
    let hint = refusal["hint"].as_str().unwrap_or_default().to_owned();
    assert!(
        hint.contains(names),
        "the refusal must name '{names}', it said: {hint}"
    );
    hint
}

/* ------------------------------- the structural law -------------------------------- */

/// A graph's structural signature: per `class_type`, how many nodes carry it and the
/// union of their input KEYS. Node ids and values are deliberately out of the
/// signature: the ladder chooses seeds and paths, the compiler owns the wiring.
pub(super) fn shape(graph: &Value) -> BTreeMap<String, (usize, BTreeSet<String>)> {
    let mut out: BTreeMap<String, (usize, BTreeSet<String>)> = BTreeMap::new();
    for node in graph.as_object().expect("a graph object").values() {
        let class = node["class_type"].as_str().unwrap_or_default().to_owned();
        let entry = out.entry(class).or_default();
        entry.0 += 1;
        if let Some(inputs) = node["inputs"].as_object() {
            entry.1.extend(inputs.keys().cloned());
        }
    }
    out
}

/// The `(class_type, input key)` pairs whose value is an empty string, and every
/// `null` input value. A `null` is always a hole; an empty string is only a hole the
/// stock shape does not also carry.
pub(super) fn value_holes(graph: &Value) -> (BTreeSet<String>, Vec<String>) {
    let mut empties = BTreeSet::new();
    let mut nulls = Vec::new();
    for node in graph.as_object().expect("a graph object").values() {
        let class = node["class_type"].as_str().unwrap_or_default().to_owned();
        if let Some(inputs) = node["inputs"].as_object() {
            for (key, value) in inputs {
                match value {
                    Value::Null => nulls.push(format!("{class}.{key}")),
                    Value::String(text) if text.is_empty() => {
                        empties.insert(format!("{class}.{key}"));
                    }
                    _ => {}
                }
            }
        }
    }
    (empties, nulls)
}

fn render_shape(shape: &BTreeMap<String, (usize, BTreeSet<String>)>) -> String {
    shape
        .iter()
        .map(|(class, (count, keys))| {
            format!(
                "  {class} x{count} inputs={}",
                keys.iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The differential's verdict: same node classes in same counts, and every input key
/// the stock graph carries present in ours. Extra keys are reported too (a door that
/// invents an input the Workbench never sends is drift), but only as a warning line in
/// the failure text when something else fails; a missing class, a wrong count or a
/// missing key fails.
pub(super) fn assert_shapes(ours: &Value, stock: &Value, label: &str) {
    let mine = shape(ours);
    let theirs = shape(stock);
    let mut problems: Vec<String> = Vec::new();
    for (class, (count, keys)) in &theirs {
        match mine.get(class) {
            None => problems.push(format!("ours is MISSING node class '{class}'")),
            Some((mine_count, mine_keys)) => {
                if mine_count != count {
                    problems.push(format!(
                        "'{class}': stock has {count} node(s), ours has {mine_count}"
                    ));
                }
                for key in keys {
                    if !mine_keys.contains(key) {
                        problems.push(format!("'{class}': ours lacks input key '{key}'"));
                    }
                }
            }
        }
    }
    for class in mine.keys() {
        if !theirs.contains_key(class) {
            problems.push(format!("ours has an EXTRA node class '{class}'"));
        }
    }
    assert_eq!(
        mine.values().map(|(count, _)| count).sum::<usize>(),
        theirs.values().map(|(count, _)| count).sum::<usize>(),
        "node-count drift for '{label}':\nOURS:\n{}\nSTOCK:\n{}\nDIFF:\n{}",
        render_shape(&mine),
        render_shape(&theirs),
        problems.join("\n")
    );
    assert!(
        problems.is_empty(),
        "structural drift against the stock fixture '{label}':\n{}\nOURS:\n{}\nSTOCK:\n{}",
        problems.join("\n"),
        render_shape(&mine),
        render_shape(&theirs)
    );
}

/// No ladder hole may survive compile: zero `null` inputs, and the empty-string set is
/// bounded by the stock graph's own (the stock image graph legitimately carries empty
/// negative conditioning).
pub(super) fn assert_no_holes(ours: &Value, stock: &Value, label: &str) {
    let (mine, nulls) = value_holes(ours);
    let (theirs, _) = value_holes(stock);
    assert!(
        nulls.is_empty(),
        "'{label}': the compiled graph carries null inputs: {nulls:?}"
    );
    let extra: Vec<&String> = mine.iter().filter(|key| !theirs.contains(*key)).collect();
    assert!(
        extra.is_empty(),
        "'{label}': empty-string inputs the stock shape does not carry: {extra:?}"
    );
}

/// One differential: queue the closest agent envelope, compile it, compile the raw
/// stock fixture, compare shapes and holes.
pub(super) async fn differential(kit: &Kit, body: &Value, stock_intent: &Value, label: &str) {
    let ours = fill_intent(kit, body).await;
    let ours_graph = stock_compile(&ours);
    let stock_graph = stock_fixture_compile(stock_intent, label);
    assert_shapes(&ours_graph, &stock_graph, label);
    assert_no_holes(&ours_graph, &stock_graph, label);
}

/* --------------------------------- stock fixtures ---------------------------------- */

/// Verbatim from `jobs_tests.rs:544 intent()` — the image arm's own fixture.
pub(super) fn stock_image() -> Value {
    json!({"recipeId":"checkpoint-text-to-image-diagnostic","version":1,
        "positivePrompt":"a cat", "negativePrompt":"", "checkpoint":"sd/model.safetensors",
        "seed":123,"width":512,"height":768,"steps":20,"cfg":7,
        "sampler":"euler","scheduler":"normal","outputPrefix":"DEAS_test"})
}

/// The image fixture with one leg applied on BOTH sides of the differential.
pub(super) fn stock_image_with(legs: &[(&str, Value)]) -> Value {
    let mut intent = stock_image();
    let object = intent.as_object_mut().expect("an object");
    for (key, value) in legs {
        object.insert((*key).to_owned(), value.clone());
    }
    intent
}

/// The music arm's stock fixture, straight from the same JSON the stock tests read
/// (`jobs_music_tests.rs:3 fixture("t2m-off.intent")`).
fn stock_music_off() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/music/t2m-off.intent.json"
    ))
    .expect("stock music fixture")
}

/// Verbatim from `jobs_refmod_tests.rs:83 request()` MINUS the Workbench-only row
/// decorations (`mediaMode`/`trimStart`/`trimEnd`): stock's `validate_h3_media` types
/// them optional ("mediaMode? (video)"), and `lane_flags` (jobs_refmod.rs:38) rides a
/// mediaMode-less video on the VIDEO-only lane — exactly what the E16 surface lands
/// (`video1` is one reference string with no lane word). The closest stock envelope
/// for the agent body therefore rides the same lane: one video VAE, no audio VAE.
fn stock_refmod_request() -> Value {
    json!({"name":"hero","description":"main cast","conceptType":"identity",
        "media":[{"type":"image","file":"deas-inputs/a.png","slot":0,"description":"face"},
                 {"type":"video","file":"deas-input-clip.mp4","slot":0}],
        "refmods":["old/set"],"vae":"MiniMaxH3/video_vae.safetensors","audioVae":"MiniMaxH3/audio_vae.safetensors"})
}

/// The H3 family block every H3 body in this harness carries: the fields the door
/// cannot fabricate (fill_plane.rs `build_h3_block`: audioVae, shiftVideo, shiftAudio).
pub(super) fn h3_block(mode: &str) -> Value {
    json!({"mode": mode, "audioVae": "MiniMaxH3/audio_vae.safetensors", "shiftVideo": 10, "shiftAudio": 3})
}

/// The split-loader recipe the H3/LTX bodies carry explicitly: those two families
/// declare no `components` map in `builtin.json`, so the resolver cannot build it from
/// the index (pinned by `families_without_a_components_map_refuse_a_model_reference`).
pub(super) fn h3_diffusion() -> Value {
    json!({"textEncoder":"MiniMaxH3/qwen3vl.safetensors","clipType":"minimax","vae":"MiniMaxH3/video_vae.safetensors"})
}

pub(super) fn ltx_diffusion() -> Value {
    json!({"textEncoder":"LTX2/gemma_3_12B_it_fp8.safetensors","clipType":"ltxv","vae":"LTX2/video_vae.safetensors"})
}

/* ------------------------------ image-mode differentials ---------------------------- */

#[tokio::test]
async fn t2i_minimal_lands_the_stock_image_graph() {
    let kit = Kit::new();
    // The closest envelope for `jobs_tests::intent()`: the model by name, the mode,
    // the prompt slot, and the fixture's numbers through the dials block.
    let body = json!({
        "model": "sd/sdxl_base.safetensors",
        "mode": "t2i",
        "positivePrompt": "a cat",
        "outputPrefix": "DEAS_test",
        "seed": 123,
        "dials": {"width": 512, "height": 768, "steps": 20, "cfg": 7,
                   "sampler": "euler", "scheduler": "normal"}
    });
    differential(&kit, &body, &stock_image(), "image/t2i").await;
}

#[tokio::test]
async fn t2i_over_a_split_loader_model_lands_the_stock_split_graph() {
    let kit = Kit::new();
    // Anima resolves through the library: the resolver supplies the family word, the
    // checkpoint slot and the split `diffusion` recipe (transport.rs:1601 pins the
    // same door behaviour).
    // The anima handle is the 12-hex prefix of that record's SHA-256 (§9 handle law).
    let body = json!({
        "model": ANIMA_HANDLE,
        "mode": "t2i",
        "positivePrompt": "a cat",
        "outputPrefix": "DEAS_test",
        "seed": 123,
        "dials": {"width": 512, "height": 768, "steps": 20, "cfg": 7,
                   "sampler": "euler", "scheduler": "normal"}
    });
    let mut stock = stock_image_with(&[("checkpoint", json!("anima/anima.safetensors"))]);
    stock["diffusion"] = json!({
        "textEncoder": "anima/qwen3-0.6b.safetensors",
        "clipType": "stable_diffusion",
        "vae": "anima/wan_2.1_vae.safetensors"
    });
    differential(&kit, &body, &stock, "image/t2i-split").await;
}

#[tokio::test]
async fn i2i_input_image_and_denoise_pair_lands_the_stock_i2i_graph() {
    let kit = Kit::new();
    let body = json!({
        "model": "sd/sdxl_base.safetensors", "mode": "i2i",
        "positivePrompt": "a cat", "outputPrefix": "DEAS_test", "seed": 123,
        "inputImage": "deas-inputs/in.png",
        "dials": {"width": 512, "height": 768, "steps": 20, "cfg": 7,
                   "sampler": "euler", "scheduler": "normal", "denoise": 0.6}
    });
    let stock = stock_image_with(&[
        ("inputImage", json!("deas-inputs/in.png")),
        ("denoise", json!(0.6)),
    ]);
    differential(&kit, &body, &stock, "image/i2i").await;
}

#[tokio::test]
async fn inpaint_mask_leg_lands_the_stock_inpaint_graph() {
    let kit = Kit::new();
    let body = json!({
        "model": "sd/sdxl_base.safetensors", "mode": "inpaint",
        "positivePrompt": "a cat", "outputPrefix": "DEAS_test", "seed": 123,
        "inputImage": "deas-inputs/in.png", "inputMask": "deas-masks/2f1e9d4c-7b3a-4e5f-9c8d-1a2b3c4d5e6f.png", "maskBlur": 2,
        "dials": {"width": 512, "height": 768, "steps": 20, "cfg": 7,
                   "sampler": "euler", "scheduler": "normal", "denoise": 1.0}
    });
    let stock = stock_image_with(&[
        ("inputImage", json!("deas-inputs/in.png")),
        (
            "inputMask",
            json!("deas-masks/2f1e9d4c-7b3a-4e5f-9c8d-1a2b3c4d5e6f.png"),
        ),
        ("maskBlur", json!(2)),
        ("denoise", json!(1.0)),
    ]);
    differential(&kit, &body, &stock, "image/inpaint").await;
}

#[tokio::test]
async fn upscale_resize_and_model_leg_lands_the_stock_upscale_graph() {
    let kit = Kit::new();
    // `inputResize` plus its padding must equal the output edges (jobs.rs:898), so the
    // door's pairing law and compile agree on the same arithmetic.
    let body = json!({
        "model": "sd/sdxl_base.safetensors", "mode": "upscale",
        "positivePrompt": "a cat", "outputPrefix": "DEAS_test", "seed": 123,
        "inputImage": "deas-inputs/in.png",
        "inputResize": {"width": 1536, "height": 1152, "crop": "disabled"},
        "upscaleModel": "upscale/2x.safetensors",
        "dials": {"width": 1536, "height": 1152, "steps": 20, "cfg": 7,
                   "sampler": "euler", "scheduler": "normal", "denoise": 0.0}
    });
    let stock = stock_image_with(&[
        ("width", json!(1536)),
        ("height", json!(1152)),
        ("inputImage", json!("deas-inputs/in.png")),
        (
            "inputResize",
            json!({"width": 1536, "height": 1152, "crop": "disabled"}),
        ),
        ("upscaleModel", json!("upscale/2x.safetensors")),
        ("denoise", json!(0.0)),
    ]);
    differential(&kit, &body, &stock, "image/upscale").await;
}

#[tokio::test]
async fn refine_pass_leg_lands_the_stock_refine_graph() {
    let kit = Kit::new();
    let body = json!({
        "model": "sd/sdxl_base.safetensors", "mode": "refine",
        "positivePrompt": "a cat", "outputPrefix": "DEAS_test", "seed": 123,
        "refine": {"width": 512, "height": 768, "denoise": 0.35},
        "dials": {"width": 512, "height": 768, "steps": 20, "cfg": 7,
                   "sampler": "euler", "scheduler": "normal"}
    });
    let stock = stock_image_with(&[(
        "refine",
        json!({"width": 512, "height": 768, "denoise": 0.35}),
    )]);
    differential(&kit, &body, &stock, "image/refine").await;
}

#[tokio::test]
async fn lora_shorthand_lands_the_stock_loras_bag_graph() {
    let kit = Kit::new();
    // `--lora "name:strength"` folds into the structured bag (e16.rs `fold_lora`);
    // the stock side carries the bag verbatim, as jobs_tests.rs:568 does.
    let body = json!({
        "model": "sd/sdxl_base.safetensors", "mode": "t2i",
        "positivePrompt": "a cat", "outputPrefix": "DEAS_test", "seed": 123,
        "--lora": "styles/detail.safetensors:0.7",
        "dials": {"width": 512, "height": 768, "steps": 20, "cfg": 7,
                   "sampler": "euler", "scheduler": "normal"}
    });
    let stock = stock_image_with(&[(
        "loras",
        json!([{"name": "styles/detail.safetensors", "strength": 0.7}]),
    )]);
    differential(&kit, &body, &stock, "image/loras").await;
}

/* -------------------------------- video differentials ------------------------------- */

#[tokio::test]
async fn video_h3_i2v_lands_the_stock_h3_graph() {
    let kit = Kit::new();
    // The stock side is the stock tests' own fixture (jobs_video_tests.rs:1401 h3()).
    let stock = crate::jobs_video::tests::h3();
    let body = json!({
        "family": "minimax-h3",
        "mode": "video",
        "checkpoint": "MiniMaxH3/fl2va.safetensors",
        "diffusion": h3_diffusion(),
        "positivePrompt": "a fox",
        "outputPrefix": "agent/h3",
        "images": ["deas-inputs/a.png"],
        "h3": h3_block("I2VA"),
        "seed": 7,
        "dials": {"width": 1024, "height": 768, "steps": 4, "cfg": 1, "negativePrompt": "text and subtitles",
                   "sampler": "euler", "scheduler": "simple"}
    });
    differential(&kit, &body, &stock, "video/h3-i2v").await;
}

#[tokio::test]
async fn video_h3_face_refine_block_lands_the_stock_face_pass() {
    let kit = Kit::new();
    let mut stock = crate::jobs_video::tests::h3();
    let block = crate::jobs_face_refine::tests::block();
    stock
        .as_object_mut()
        .expect("a fixture")
        .insert("faceRefine".to_owned(), block.clone());
    let body = json!({
        "family": "minimax-h3",
        "mode": "video",
        "checkpoint": "MiniMaxH3/fl2va.safetensors",
        "diffusion": h3_diffusion(),
        "positivePrompt": "a fox",
        "outputPrefix": "agent/h3",
        "images": ["deas-inputs/a.png"],
        "h3": h3_block("I2VA"),
        "faceRefine": block,
        "seed": 7,
        "dials": {"width": 1024, "height": 768, "steps": 4, "cfg": 1, "negativePrompt": "text and subtitles",
                   "sampler": "euler", "scheduler": "simple"}
    });
    differential(&kit, &body, &stock, "video/h3-faceRefine").await;
}

#[tokio::test]
async fn video_h3_dial_rack_rides_to_the_stock_rack_graph() {
    // LEG M12 (reviewer (1)): the stock UI attaches top-level `dials` rack rows
    // (`Workbench.tsx:1226` `withDials`; `jobs_video.rs` OPTIONAL:1), and the door
    // now passes the ARRAY through the video arm's passthrough — gated by the
    // stock `validate_dial_row` — so the drain-side graph grows the SAME rack
    // node the stock fixture graph grows. Branch taken by the read: the rack IS
    // an intent-side block stock-side, never a UI-only construct.
    let kit = Kit::new();
    // The rack occupies the `dials` wire word for this body (shape is the
    // discriminator: the ladder block is an object), so the ladder tier rides the
    // sheet's combo block — the §6 ladder's designed home — carrying the stock
    // fixture's exact numbers to keep the differential value-clean.
    let mut sheet = defaults::DefaultsSheet::default();
    sheet.combos.insert(
        "minimax-h3:video".to_owned(),
        serde_json::from_value(json!({
            "width": 1024, "height": 768, "steps": 4, "cfg": 1,
            "sampler": "euler", "scheduler": "simple",
            "negativePrompt": "text and subtitles"
        }))
        .expect("fixture combo dials"),
    );
    defaults::write(kit.app.path(), &sheet).expect("the fixture sheet lands");
    // The rows mirror the stock tests' own rack fixtures (jobs_video_tests.rs:3498
    // `dial_row` + :3506 `timed_dial`): one constant row, one time-curve row.
    let rack = json!([
        {"dial": "dials/h3_motion.safetensors", "strength": 1.5},
        {"dial": "dials/sub/h3_calm.safetensors", "strength": -0.5,
         "time": {"type": "keys", "points": [[0, 0.5], [1.5, 1], [4, -2]], "unit": "seconds"}}
    ]);
    let mut stock = crate::jobs_video::tests::h3();
    stock["dials"] = rack.clone();
    // Pin the STOCK half of the differential first: its graph must carry the rack
    // node, so the shape comparison can never pass on "neither graph has a rack".
    let stock_graph = stock_fixture_compile(&stock, "video/h3-dial-rack");
    assert!(
        stock_graph
            .as_object()
            .expect("graph object")
            .values()
            .any(|node| node["class_type"] == "MAIDialRack"),
        "the stock fixture graph must grow the rack node"
    );
    let body = json!({
        "family": "minimax-h3",
        "mode": "video",
        "checkpoint": "MiniMaxH3/fl2va.safetensors",
        "diffusion": h3_diffusion(),
        "positivePrompt": "a fox",
        "outputPrefix": "agent/h3",
        "images": ["deas-inputs/a.png"],
        "h3": h3_block("I2VA"),
        "seed": 7,
        "dials": rack,
    });
    differential(&kit, &body, &stock, "video/h3-dial-rack").await;
    // The OURS-side graph grows the rack node too: rebuild through the drain's
    // own reconstruction and compile, then name the node — the multiset
    // comparison above already proved the two graphs agree; this names WHICH node.
    let ours = fill_intent(&kit, &body).await;
    let ours_graph = stock_compile(&ours);
    assert!(
        ours_graph
            .as_object()
            .expect("graph object")
            .values()
            .any(|node| node["class_type"] == "MAIDialRack"),
        "our compiled graph grows the MAIDialRack node the rack rows drive"
    );
}

#[tokio::test]
async fn the_dial_rack_on_a_non_h3_video_family_refuses_at_the_door_and_stock_agrees() {
    // WALK 3 harness cell (family-D gap): the rack rides `dials`, and BOTH walls
    // refuse a non-H3 family — the door's fill arm (fill_plane `dials` arm, the
    // family wall mirrored from the stock constant home) and the stock compiler
    // itself (`validate_dials`, jobs_video.rs:679 "dials are experimental and
    // run on MiniMax H3 video only"). Differential honesty: the refusal PAIRS,
    // no graph is compiled — a rack graph has no non-H3 home anywhere.
    let kit = Kit::new();
    let rack = json!([{"dial": "dials/h3_motion.safetensors", "strength": 1.5}]);
    let body = json!({
        "family": "ltx-2",
        "mode": "t2v",
        "checkpoint": "LTX2/ltx.safetensors",
        "diffusion": ltx_diffusion(),
        "positivePrompt": "a fox",
        "outputPrefix": "agent/ltx",
        "ltx": {"textProjection": "LTX2/proj.safetensors", "audioVae": "LTX2/audio_vae.safetensors", "passes": 1},
        "dials": rack,
    });
    let problem = door_refusal(
        &kit,
        &body,
        ErrorKind::ModeUnsupported,
        "MiniMax H3 video only",
    )
    .await;
    assert!(problem.contains("family 'ltx-2' has no rack"), "{problem}");
    // The stock half: the same rack on the stock ltx intent dies at the stock
    // family wall, naming the same law. NOTE the shape: the STOCK intent carries
    // no `mode` word at all (the FIELDS/OPTIONS wall at jobs_video.rs:1364
    // refuses unknown keys; our door's mode word is folded away by fill) — the
    // rack is what trips `validate_dials`.
    let mut raw = crate::jobs_video::tests::ltx();
    raw["dials"] = rack;
    let stock = crate::jobs::compile(&raw).expect_err("stock refuses the rack off H3");
    assert!(
        stock.contains("MiniMax H3 video only"),
        "the stock wall names the same law: {stock}"
    );
}

#[tokio::test]
async fn video_ltx_t2v_lands_the_stock_ltx_graph() {
    let kit = Kit::new();
    let stock = crate::jobs_video::tests::ltx();
    let body = json!({
        "family": "ltx-2",
        "mode": "t2v",
        "checkpoint": "LTX2/ltx.safetensors",
        "diffusion": ltx_diffusion(),
        "positivePrompt": "a fox",
        "outputPrefix": "video/2026-10-18/x",
        "ltx": {"textProjection":"ltx-2.3_text_projection_bf16.safetensors","audioVae":"LTX2/audio_vae.safetensors","passes":1},
        "output": {"codec":"Auto","container":"Auto","bitDepth":"Auto","quality":20,"audioCodec":"Auto","audioBitrate":"192k","saveFirstFrame":false,"saveLastFrame":false},
        "seed": 7,
        "dials": {"width": 1280, "height": 704, "steps": 8, "cfg": 1, "negativePrompt": "text and subtitles",
                   "sampler": "euler_cfg_pp", "scheduler": "linear_quadratic"}
    });
    differential(&kit, &body, &stock, "video/ltx-t2v").await;
}

#[tokio::test]
async fn video_ltx_v2v_source_video_lands_the_stock_v2v_graph() {
    // WALK 3 harness cell (family-D gap): v2v compiled ONLY inside the settings
    // matrix until now — no stock-fixture graph parity for `sourceVideo`. This
    // differential pins the v2v graph shape: the stock ltx intent carrying
    // `sourceVideo` + `sourceStrength` against the door body that folds to it.
    let kit = Kit::new();
    // Stock shape truth (jobs_video.rs:1364 field wall): a stock video intent
    // carries NO `mode` word — v2v IS `sourceVideo` present + `sourceStrength`
    // in the ltx block (validate_ltx: the strength belongs EXACTLY to a
    // sourceVideo), and the graph grows LoadVideo -> GetVideoComponents (the
    // named v2v nodes below).
    let mut stock = crate::jobs_video::tests::ltx();
    // Stock law (jobs_video.rs:1410): sourceVideo is a TOP-LEVEL input file —
    // model_name-shaped and slash-free (the placement form rides the drain's
    // own root-join; the graph shape is what the differential compares).
    stock["sourceVideo"] = json!("x.mp4");
    stock["ltx"]["sourceStrength"] = json!(0.6);
    let body = json!({
        "family": "ltx-2",
        "mode": "v2v",
        "checkpoint": "LTX2/ltx.safetensors",
        "diffusion": ltx_diffusion(),
        "positivePrompt": "a fox",
        "outputPrefix": "video/2026-10-18/x",
        "sourceVideo": "deas-input-clip.mp4",
        "ltx": {"textProjection":"ltx-2.3_text_projection_bf16.safetensors","audioVae":"LTX2/audio_vae.safetensors","passes":1,"sourceStrength":0.6},
        "output": {"codec":"Auto","container":"Auto","bitDepth":"Auto","quality":20,"audioCodec":"Auto","audioBitrate":"192k","saveFirstFrame":false,"saveLastFrame":false},
        "seed": 7,
        "dials": {"width": 1280, "height": 704, "steps": 8, "cfg": 1, "negativePrompt": "text and subtitles",
                   "sampler": "euler_cfg_pp", "scheduler": "linear_quadratic"}
    });
    differential(&kit, &body, &stock, "video/ltx-v2v").await;
    // Name the v2v half explicitly: the drain-side graph loads the source video
    // (a LoadVideo-class node fed by the placement path), not just a t2v graph
    // with an extra dial.
    let ours = fill_intent(&kit, &body).await;
    assert_eq!(
        ours["sourceVideo"], "deas-input-clip.mp4",
        "the drain body carries the source video in placement form (stock joins the input root)"
    );
    assert_eq!(ours["ltx"]["sourceStrength"], 0.6, "the strength rides");
    let ours_graph = stock_compile(&ours);
    assert!(
        ours_graph
            .as_object()
            .expect("graph object")
            .values()
            .any(|node| node["class_type"] == "LoadVideo"),
        "the drain-side graph loads the source video — the v2v nodes, not a t2v graph with a dial"
    );
}

#[tokio::test]
async fn video_wan_i2v_first_frame_only_lands_the_stock_wan_graph() {
    let kit = Kit::new();
    let stock = crate::jobs_video::tests::wan();
    // wan's model reference DOES resolve (it declares a components map), so this body
    // exercises the resolver-fed video path for once.
    let body = json!({
        "model": "WAN22/high.safetensors",
        "mode": "i2v",
        "positivePrompt": "a fox",
        "outputPrefix": "video/2026-10-18/x",
        "wan": {"lowModel":"WAN22/low.safetensors","shiftHigh":5,"shiftLow":5,"refinerStep":2},
        "firstFrame": "first.png",
        "seed": 7,
        "dials": {"width": 528, "height": 768, "steps": 4, "cfg": 1, "negativePrompt": "text and subtitles",
                   "sampler": "euler", "scheduler": "simple"}
    });
    differential(&kit, &body, &stock, "video/wan-i2v").await;
}

#[tokio::test]
async fn video_frames_and_frame_rate_partials_land_the_stock_clocks() {
    let kit = Kit::new();
    // The partial: frames and frameRate in the request body, everything else from the
    // family plugin's `video` block. The stock side pins the same clocks.
    let mut stock = crate::jobs_video::tests::h3();
    stock["frames"] = json!(124);
    stock["frameRate"] = json!(24);
    let body = json!({
        "family": "minimax-h3",
        "mode": "video",
        "checkpoint": "MiniMaxH3/fl2va.safetensors",
        "diffusion": h3_diffusion(),
        "positivePrompt": "a fox",
        "outputPrefix": "agent/h3",
        "images": ["deas-inputs/a.png"],
        "h3": h3_block("I2VA"),
        "seed": 7,
        "frames": 124,
        "frameRate": 24,
        "dials": {"width": 1024, "height": 768, "steps": 4, "cfg": 1, "negativePrompt": "text and subtitles",
                   "sampler": "euler", "scheduler": "simple"}
    });
    let ours = fill_intent(&kit, &body).await;
    let ours_graph = stock_compile(&ours);
    let stock_graph = stock_fixture_compile(&stock, "video/clocks");
    assert_shapes(&ours_graph, &stock_graph, "video/clocks");
    assert_no_holes(&ours_graph, &stock_graph, "video/clocks");
    assert_eq!(ours["frames"], 124, "the request's frames win the ladder");
    // `frameRate` is f64-typed by stock (finite gate, jobs_video.rs:1441 — unlike
    // `frames`, which the `int` closure types u64), so it rides the ladder as a float.
    assert_eq!(
        ours["frameRate"].as_f64(),
        Some(24.0),
        "the request's frameRate wins the ladder"
    );
}

#[tokio::test]
async fn ref2va_picture_shorthand_loras_and_dials_land_the_stock_ref2va_graph() {
    let kit = Kit::new();
    // The owner's shape: numbered pictureN aliases, `--lora`, and a `--dials` subset.
    // The stock side carries the folded equivalents, as jobs_video_tests REF2VA rows do.
    let mut stock = crate::jobs_video::tests::h3();
    stock["h3"]
        .as_object_mut()
        .expect("h3")
        .remove("references");
    stock["h3"]["mode"] = json!("REF2VA");
    stock["h3"]["media"] = json!([
        {"type": "image", "file": "deas-inputs/a.png", "slot": 0},
        {"type": "image", "file": "deas-inputs/b.png", "slot": 1},
        {"type": "audio", "file": "deas-inputs/song.mp3", "slot": 0}
    ]);
    stock["loras"] = json!([{"name": "H3/turbo.safetensors", "strength": 1.0}]);
    stock["steps"] = json!(6);
    stock["cfg"] = json!(2);
    let body = json!({
        "family": "minimax-h3",
        "mode": "ref2va",
        "checkpoint": "MiniMaxH3/fl2va.safetensors",
        "diffusion": h3_diffusion(),
        "positivePrompt": "a fox",
        "outputPrefix": "agent/ref2va",
        "picture1": "deas-inputs/a.png",
        "picture2": "deas-inputs/b.png",
        "audio1": "deas-inputs/song.mp3",
        "--lora": "H3/turbo.safetensors",
        "--dials": "steps=6,cfg=2",
        "h3": {"audioVae":"MiniMaxH3/audio_vae.safetensors","shiftVideo":10,"shiftAudio":3},
        "seed": 7,
        "dials": {"width": 1024, "height": 768, "negativePrompt": "text and subtitles",
                   "sampler": "euler", "scheduler": "simple"}
    });
    differential(&kit, &body, &stock, "video/ref2va-shorthand").await;
}

/* ------------------- LEG M15: the RefMods bag and the audio wrapper ------------------- */

/// The ref2va queue envelope both M15 video tests share: one image lane item and
/// the family block; the tests add only the leg under proof.
fn ref2va_m15_body() -> Value {
    json!({
        "family": "minimax-h3",
        "mode": "ref2va",
        "checkpoint": "MiniMaxH3/fl2va.safetensors",
        "diffusion": h3_diffusion(),
        "positivePrompt": "a fox",
        "outputPrefix": "agent/ref2va",
        "images": ["deas-inputs/a.png"],
        "h3": {"audioVae":"MiniMaxH3/audio_vae.safetensors","shiftVideo":10,"shiftAudio":3},
        "seed": 7
    })
}

/// The stock REF2VA fixture base: `jobs_video::tests::h3()` with the three
/// mutations the stock RefMod test itself applies (mode word, emptied
/// references, media in place of references).
fn ref2va_m15_stock() -> Value {
    let mut stock = crate::jobs_video::tests::h3();
    stock["h3"]
        .as_object_mut()
        .expect("h3")
        .remove("references");
    stock["h3"]["mode"] = json!("REF2VA");
    stock["h3"]["media"] = json!([{"type":"image","file":"deas-inputs/a.png","slot":0}]);
    stock
}

#[tokio::test]
async fn ref2va_refmods_bag_lands_the_stock_director_refmods_leg() {
    let kit = Kit::new();
    // The stock-side ground truth is the stock suite's own RefMod rows:
    // `jobs_video_tests.rs:2429 h3_ref2va_refmods_reach_the_timeline_and_may_
    // stand_alone` proves Director rows reach `timeline_data` with the
    // `enabled:true` / `description:""` defaults the compiler mints
    // (jobs_video.rs:2281-2290). LEG M15: the door validated this bag by
    // CALLING stock `validate_refmods`, so the bag rides to the same wiring.
    let mut stock = ref2va_m15_stock();
    stock["h3"]["refmods"] = json!([
        {"slot":1,"name":"chars/hero","strength":0.8,"description":"the hero"},
        {"slot":3,"name":"place","strength":1}
    ]);
    let mut body = ref2va_m15_body();
    // The bag rides VERBATIM (numbers included: an authored `1.0` stays `1.0`
    // in the timeline, exactly as a stock UI-authored row does), so the
    // fixture pair here carries identical literals and the rows agree byte-for-byte.
    body["refmods"] = json!([
        {"slot": 1, "name": "chars/hero", "strength": 0.8, "description": "the hero"},
        {"slot": 3, "name": "place", "strength": 1}
    ]);
    differential(&kit, &body, &stock, "video/ref2va-refmods").await;
    // The shape proof is not enough for this leg: the claim is the Director's
    // OWN rows. Our compiled timeline must carry the identical refmods array
    // the stock fixture shows — defaults minted stock-side, our bag untouched
    // on the way in.
    let timeline_of = |graph: &Value| -> Value {
        let raw = graph["D"]["inputs"]["timeline_data"]
            .as_str()
            .expect("the Director node carries its timeline");
        serde_json::from_str(raw).expect("timeline bytes")
    };
    let ours = fill_intent(&kit, &body).await;
    let ours_rows = timeline_of(&stock_compile(&ours))["refmods"].clone();
    let stock_rows =
        timeline_of(&stock_fixture_compile(&stock, "video/ref2va-refmods"))["refmods"].clone();
    assert_eq!(
        ours_rows, stock_rows,
        "the Director rows must agree byte-for-byte"
    );
    assert_eq!(ours_rows[0]["enabled"], json!(true));
    assert_eq!(ours_rows[1]["description"], json!(""));
}

#[tokio::test]
async fn negative_refmods_rows_and_the_ref2va_mode_law_refuse_both_walls() {
    // LEG M15: the door arm calls the stock `validate_refmods` (jobs_video.rs:
    // 1035, stock-side called by `validate_h3`:927), so BOTH walls speak one
    // sentence: the stock one. The stock suite keeps its own row loop at
    // `jobs_video_tests.rs:2444-2459`; this probe drives the same rows through
    // the real door and the raw compiler.
    let kit = Kit::new();
    let row_cases: [(&str, Value); 6] = [
        (
            "duplicate slot",
            json!([{"slot":1,"name":"chars/hero","strength":1},{"slot":1,"name":"place","strength":1}]),
        ),
        (
            "strength 0",
            json!([{"slot":1,"name":"chars/hero","strength":0}]),
        ),
        (
            "strength 1.0001",
            json!([{"slot":1,"name":"chars/hero","strength":1.0001}]),
        ),
        (
            "slot 9 off the 1-8 lane",
            json!([{"slot":9,"name":"chars/hero","strength":1}]),
        ),
        ("non-object row", json!([1])),
        ("empty bag", json!([])),
    ];
    for (label, rows) in row_cases {
        let mut body = ref2va_m15_body();
        body["refmods"] = rows.clone();
        door_refusal(&kit, &body, ErrorKind::BodyInvalid, "h3.refmods").await;
        let mut stock = ref2va_m15_stock();
        stock["h3"]["refmods"] = rows;
        let problem = crate::jobs::compile(&stock)
            .expect_err("the same row must die stock-side too: {label}");
        assert!(
            problem.contains("h3.refmods"),
            "{label}: stock said '{problem}'"
        );
    }
    // The mode law on both walls: RefMods ride REF2VA only. Stock refuses the
    // I2VA pair with its own sentence (`jobs_video_tests.rs:2461-2463 keeps
    // that probe); our door refuses by the same cause, hint quoting it.
    let mut body = ref2va_m15_body();
    body["mode"] = json!("video");
    body["h3"] = h3_block("I2VA");
    body["refmods"] = json!([{"slot":1,"name":"chars/hero","strength":1}]);
    door_refusal(
        &kit,
        &body,
        ErrorKind::ModeUnsupported,
        "h3.refmods belong to REF2VA",
    )
    .await;
    let mut stock = crate::jobs_video::tests::h3();
    stock["h3"]["refmods"] = json!([{"slot":1,"name":"chars/hero","strength":1}]);
    let problem = crate::jobs::compile(&stock)
        .expect_err("RefMods on I2VA is refused by the stock law itself");
    assert_eq!(problem, "h3.refmods belong to REF2VA");
}

#[tokio::test]
async fn audio_enhance_wrapper_rides_the_plan_intent_never_the_graph() {
    let kit = Kit::new();
    // The wrapper truth (design question 4, measured): `audioEnhance` is an
    // INTENT key the stock compile honors ONLY to validate it and STRIP it
    // (jobs.rs:448-451 via `audio_post::settings`); the enhancement itself is
    // the native post-render chain off the plan intent (jobs.rs:2131/2218/
    // 2387, jobs_audio_post.rs), and its product enters the row as the
    // `processed` role (jobs_outputs.rs:431) — a word the M9g descriptors
    // already surface, keeping the enhanced artifact discoverable. So the
    // differential pairs a WRAPPED body with an UNWRAPPED stock fixture: the
    // compiled graphs must agree exactly, and our flat intent must keep the
    // key top-level where the stock machinery reads it.
    let stock = ref2va_m15_stock();
    let mut body = ref2va_m15_body();
    body["audioEnhance"] = json!({"mode": "clean", "profile": "mix"});
    let ours = fill_intent(&kit, &body).await;
    assert_eq!(
        ours["audioEnhance"],
        json!({"mode": "clean", "profile": "mix"}),
        "the wrapper rides the drain-reconstructed intent verbatim"
    );
    differential(&kit, &body, &stock, "video/ref2va-audio-wrapper").await;
    // The shape law at both walls (jobs_audio_post.rs:13-32 is the single home
    // — the door arm calls it, so the strings cannot drift).
    for (bad, stock_string) in [
        (
            json!({"mode": "deep", "profile": "mix"}),
            "Deep is speech-only",
        ),
        (json!({"mode": "clean"}), "AUDIO_SETTINGS: Expected"),
    ] {
        let mut probe = body.clone();
        probe["audioEnhance"] = bad.clone();
        door_refusal(&kit, &probe, ErrorKind::BodyInvalid, stock_string).await;
        let mut stock_probe = stock.clone();
        stock_probe["audioEnhance"] = bad;
        let problem = crate::jobs::compile(&stock_probe)
            .expect_err("the wrapper law runs stock-side as well");
        assert!(problem.contains(stock_string), "stock said '{problem}'");
    }
    // The image recipe never carries the wrapper: our image arm refuses the
    // key at its closed set, and the compiler refuses it by the recipe cause
    // (jobs_audio_post.rs:18-23: the allowed recipeIds are video and music).
    let mut image = json!({
        "model": "sd/sdxl_base.safetensors",
        "mode": "t2i",
        "positivePrompt": "a cat",
        "outputPrefix": "DEAS_test",
        "seed": 123
    });
    image["audioEnhance"] = json!({"mode": "clean", "profile": "mix"});
    door_refusal(&kit, &image, ErrorKind::BodyInvalid, "audioEnhance").await;
    let problem = crate::jobs::compile(&stock_image_with(&[(
        "audioEnhance",
        json!({"mode": "clean", "profile": "mix"}),
    )]))
    .expect_err("images get no audio stage");
    assert!(
        problem.contains("AUDIO_INTENT: Audio enhancement requires video or music"),
        "{problem}"
    );
}

/* --------------------- the fourth video family: HyperFlow Flash -------------------- */

/// HyperFlow Flash is the fourth `video-generation` family (`jobs_video::FAMILIES`:7)
/// and the only one the stock plugin pins with BOTH a fixed sampler and a saved
/// schedule: `fixedSampler: euler` plus `stepChoices: [4,6,8]`, read off the same
/// plugin at `model_families.rs:1577`. The compile answers that family with its own
/// loader and `HyperFlowSigmas` instead of `BasicScheduler`+`MiniMaxH3SigmaShift`.
#[tokio::test]
async fn video_hyperflow_i2v_lands_its_own_loader_and_saved_schedule() {
    let kit = Kit::new();
    // The stock side is the stock tests' own H3 fixture with exactly the two mutations
    // `jobs_video_tests.rs:1473 hyperflow_flash_uses_its_own_loader_and_saved_schedule`
    // applies to `h3()`: the family word and the flash GGUF. `h3()` already carries the
    // only values this family samples (steps 4, euler) and its I2VA slot-0 reference.
    let mut stock = crate::jobs_video::tests::h3();
    stock["family"] = json!("minimax-h3-hyperflow");
    stock["model"] = json!("MiniMaxH3/minimax_h3_fl2va_hyperflow_flash_14b-Q4_K_M.gguf");
    let body = json!({
        "family": "minimax-h3-hyperflow",
        "mode": "video",
        "checkpoint": "MiniMaxH3/minimax_h3_fl2va_hyperflow_flash_14b-Q4_K_M.gguf",
        "diffusion": h3_diffusion(),
        "positivePrompt": "a fox",
        "outputPrefix": "agent/hyperflow",
        "images": ["deas-inputs/a.png"],
        "h3": h3_block("I2VA"),
        "seed": 7,
        "dials": {"width": 1024, "height": 768, "steps": 4, "cfg": 1,
                   "negativePrompt": "text and subtitles", "sampler": "euler", "scheduler": "simple"}
    });
    differential(&kit, &body, &stock, "video/hyperflow-i2v").await;
    // The multiset proved the two graphs agree; this names WHICH loader and schedule the
    // family word drives in OURS, exactly as the cited stock test names them in stock.
    let ours = fill_intent(&kit, &body).await;
    let graph = stock_compile(&ours);
    assert_eq!(
        graph["1"]["class_type"], "HyperFlowGGUFLoader",
        "the flash GGUF loads through the family's own GGUF node"
    );
    assert_eq!(
        graph["Z"]["class_type"], "HyperFlowSigmas",
        "the saved schedule replaces the shifted scheduler"
    );
    for absent in ["BasicScheduler", "MiniMaxH3SigmaShift"] {
        assert!(
            !graph
                .as_object()
                .expect("graph object")
                .values()
                .any(|node| node["class_type"] == absent),
            "the H3 schedule node '{absent}' must not survive the hyperflow variant"
        );
    }
    // Both walls read the SAME plugin for the two family-fixed controls (stock
    // `jobs_video.rs:1454` steps, `:1464` sampler; stock evidence
    // `jobs_video_tests.rs:1494` "only samples 4/6/8", `:1500` "runs euler only"), so an
    // off-ladder dial refuses at the door and never reaches the card as a prepare failure.
    for (key, value, names) in [
        ("steps", json!(5), "only samples 4/6/8"),
        ("sampler", json!("dpmpp_2m"), "runs euler only"),
    ] {
        let mut off_body = body.clone();
        off_body["dials"][key] = value.clone();
        door_refusal(&kit, &off_body, ErrorKind::BodyInvalid, names).await;
        let mut off_stock = stock.clone();
        off_stock[key] = value;
        let problem =
            crate::jobs::compile(&off_stock).expect_err("stock refuses the same off-ladder dial");
        assert!(
            problem.contains(names),
            "stock quotes the same family law ({names}): {problem}"
        );
    }
    // The family-fixed posture is not a licence for the latent upscale stock refuses on
    // this variant (`jobs_video_tests.rs:1520`): the door's family gate agrees.
    let mut upscale_body = body.clone();
    upscale_body["latentUpscale"] =
        json!({"model": "ltxup.safetensors", "scale": 2, "steps": 4, "denoise": 0.4});
    door_refusal(
        &kit,
        &upscale_body,
        ErrorKind::ModeUnsupported,
        "runs on ltx-2 and minimax-h3",
    )
    .await;
    let mut upscale_stock = stock.clone();
    upscale_stock["latentUpscale"] = upscale_body["latentUpscale"].clone();
    assert!(
        crate::jobs::compile(&upscale_stock).is_err(),
        "stock fail-closes the same latent upscale on the hyperflow variant"
    );
}

/* ------------------- the TVE post chain and the seamless loop ---------------------- */

/// The `videoPost` block is a pure passthrough (`VIDEO_PASSTHROUGH_KEYS`:6), so the
/// whole TVE chain — model upscale, RTX refine, frame generation, and the
/// `DaSiWa_SeamlessLoop` node a `loop` sub-block drives — must ride to the graph the
/// stock fixture graph grows. Stock evidence: `jobs_video_tests.rs:928
/// tve_post_chain_runs_after_the_decode_with_a_source_rate_baseline` (the
/// `upscaleModel` + rife row at :972) and `jobs_video_tests.rs:1002
/// seamless_loop_runs_first_and_its_audio_passes_the_baseline_gate` (the loop block
/// at :1012).
#[tokio::test]
async fn video_post_chain_and_seamless_loop_ride_the_passthrough_to_the_stock_nodes() {
    let kit = Kit::new();
    let h3_body = |post: &Value| {
        json!({
            "family": "minimax-h3",
            "mode": "video",
            "checkpoint": "MiniMaxH3/fl2va.safetensors",
            "diffusion": h3_diffusion(),
            "positivePrompt": "a fox",
            "outputPrefix": "agent/h3",
            "images": ["deas-inputs/a.png"],
            "h3": h3_block("I2VA"),
            "videoPost": post,
            "seed": 7,
            "dials": {"width": 1024, "height": 768, "steps": 4, "cfg": 1,
                       "negativePrompt": "text and subtitles", "sampler": "euler", "scheduler": "simple"}
        })
    };
    let stock_with = |post: &Value| {
        let mut fixture = crate::jobs_video::tests::h3();
        fixture["videoPost"] = post.clone();
        fixture
    };
    let classes = |graph: &Value| -> BTreeSet<String> {
        graph
            .as_object()
            .expect("graph object")
            .values()
            .filter_map(|node| node["class_type"].as_str().map(str::to_owned))
            .collect()
    };
    // Stage 1: model upscale + core frame generation, no loop.
    let chain = json!({
        "upscaleModel": "2x.safetensors",
        "frameGeneration": {"engine": "rife", "multiplier": 3, "model": "rife_v4.26.safetensors"}
    });
    let body = h3_body(&chain);
    differential(&kit, &body, &stock_with(&chain), "video/h3-videoPost-chain").await;
    let ours = fill_intent(&kit, &body).await;
    let graph = stock_compile(&ours);
    for node in [
        "UpscaleModelLoader",
        "ImageUpscaleWithModel",
        "FrameInterpolationModelLoader",
        "FrameInterpolate",
        "DEAS_VideoPostprocessGate",
    ] {
        assert!(
            classes(&graph).contains(node),
            "the post chain must grow '{node}'; ours grew {:?}",
            classes(&graph)
        );
    }
    assert!(
        !classes(&graph).contains("DaSiWa_SeamlessLoop"),
        "no loop stage was asked for; the graph must not grow the loop node"
    );
    // Stage 2: the loop sub-block rides to its own node, ahead of the rest of the chain.
    let looped = json!({
        "upscaleModel": "2x.safetensors",
        "loop": {"backend": "rife", "model": "rife_v4.26.safetensors", "audio": "beat"},
        "frameGeneration": {"engine": "rife", "multiplier": 3, "model": "rife_v4.26.safetensors"}
    });
    let looped_body = h3_body(&looped);
    differential(
        &kit,
        &looped_body,
        &stock_with(&looped),
        "video/h3-videoPost-loop",
    )
    .await;
    let looped_graph = stock_compile(&fill_intent(&kit, &looped_body).await);
    let loop_node = looped_graph
        .as_object()
        .expect("graph object")
        .values()
        .find(|node| node["class_type"] == "DaSiWa_SeamlessLoop")
        .expect("the loop sub-block grows DaSiWa_SeamlessLoop");
    assert_eq!(
        loop_node["inputs"]["audio_loop"], "Beat-aware",
        "the loop's audio posture lands as the node's own word"
    );
    assert_eq!(
        loop_node["inputs"]["interpolation_backend"], "RIFE / FILM",
        "the loop's backend lands as the node's own word"
    );
    // The door now calls the stock TVE validator, so a block stock rejects cannot ride
    // to a prepare-time refusal on the card (the M11 trouble class).
    for bad in [json!({}), json!({"bogusStage": true})] {
        let refused = h3_body(&bad);
        door_refusal(
            &kit,
            &refused,
            ErrorKind::BodyInvalid,
            "videoPost needs upscaleModel",
        )
        .await;
        assert!(
            crate::jobs::compile(&stock_with(&bad)).is_err(),
            "stock refuses the same malformed videoPost: {bad}"
        );
    }
}

/* ------------------- the MiniMax H3 image-edit legs (stills) ----------------------- */

/// The H3 still-edit body, shaped from the stock fixture `jobs_tests.rs:3045
/// h3_still_intent()` (itself built on `jobs_tests.rs:544 intent()`): minimax encoder,
/// an input image, the `h3Edit` pair, and the native reference bag.
fn h3_still_body(block: (&str, &Value)) -> Value {
    let mut body = json!({
        "family": "minimax-h3",
        "mode": "i2i",
        "checkpoint": "MiniMaxH3/ref2va.safetensors",
        "diffusion": {
            "textEncoder": "qwen3vl_32b_minimax_h3.safetensors",
            "clipType": "minimax",
            "vae": "MiniMaxH3/video_vae.safetensors"
        },
        "positivePrompt": "a cat",
        "outputPrefix": "DEAS_test",
        "seed": 123,
        "inputImage": "deas-inputs/src.png",
        "h3Edit": {"shiftVideo": 10, "shiftAudio": 3},
        "nativeImageReference": {
            "method": "minimax-h3",
            "images": ["deas-inputs/jacket.png", "deas-inputs/pose.png"]
        },
        "dials": {"width": 1024, "height": 768, "steps": 8, "cfg": 7,
                   "sampler": "euler", "scheduler": "simple", "denoise": 1.0, "negativePrompt": ""}
    });
    body[block.0] = block.1.clone();
    body
}

/// `latentUpscale` on the IMAGE arm is legal only on an unmasked MiniMax H3 edit
/// (`jobs.rs:687`), and compiles a completely different second pass from the
/// `upscaleModel` leg the M11a upscale differential pins (`image/upscale`,
/// `jobs_tests.rs` `intent()` + `upscaleModel` at :571 above): the latent upscaler
/// node + its own loader, then a re-encode, against `ImageUpscaleWithModel` there.
/// Stock fixtures carry both shapes: `jobs_tests.rs:3045 h3_still_intent()` with the
/// block at :3071, and the `upscaleModel` pair at `jobs_tests.rs:544 intent()`.
#[tokio::test]
async fn h3_still_latent_upscale_lands_the_latent_pass_not_the_model_upscale_shape() {
    let kit = Kit::new();
    let block = json!({"model": "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors", "scale": 1.5, "steps": 4, "denoise": 0.35});
    let mut stock = crate::jobs::tests::h3_still_intent();
    // The fixture carries the minimax recipe parts but not the family WORD; the stock
    // tests attach it themselves (jobs_tests.rs:3067, :3120) because `jobs.rs:687`
    // demands `family == "minimax-h3"` beside the `h3Edit` pairing.
    stock["family"] = json!("minimax-h3");
    stock["latentUpscale"] = block.clone();
    let body = h3_still_body(("latentUpscale", &block));
    differential(&kit, &body, &stock, "image/h3-still-latentUpscale").await;
    let graph = stock_compile(&fill_intent(&kit, &body).await);
    let mine = shape(&graph);
    assert!(
        mine.contains_key("DaSiWaH3TiledUpscale"),
        "the latent upscale pass must grow its own node:\n{}",
        render_shape(&mine)
    );
    assert!(
        !mine.contains_key("LatentUpscaleModelLoader"),
        "on the H3 leg the upscaler name is an INPUT of the pass node, not a loader node \
         (jobs_video::h3_upscale_node); the separate loader belongs to the ltx-2 leg \
         (jobs_tests.rs:4424)"
    );
    let pass = graph
        .as_object()
        .expect("graph object")
        .values()
        .find(|node| node["class_type"] == "DaSiWaH3TiledUpscale")
        .expect("the latent upscale pass");
    assert_eq!(
        pass["inputs"]["upscale_model"], block["model"],
        "the upscaler name lands on the pass node"
    );
    assert_eq!(
        pass["inputs"]["scale"], block["scale"],
        "the block's scale lands as a number"
    );
    assert!(
        !mine.contains_key("ImageUpscaleWithModel"),
        "the latent leg is NOT the upscaleModel leg; the two shapes must not merge"
    );
    // The legality is family- and mask-scoped exactly as stock scopes it: an SDXL i2i
    // carrying the block refuses at the door, and `jobs.rs:687` refuses the same raw
    // intent ("needs an unmasked MiniMax H3 edit").
    let foreign = json!({
        "model": "sd/sdxl_base.safetensors", "mode": "i2i",
        "positivePrompt": "a cat", "outputPrefix": "DEAS_test", "seed": 123,
        "inputImage": "deas-inputs/in.png",
        "latentUpscale": block,
        "dials": {"width": 512, "height": 768, "steps": 20, "cfg": 7,
                   "sampler": "euler", "scheduler": "normal", "denoise": 0.6}
    });
    door_refusal(
        &kit,
        &foreign,
        ErrorKind::ModeUnsupported,
        "needs an unmasked MiniMax H3 edit",
    )
    .await;
    let stock_side = stock_image_with(&[
        ("inputImage", json!("deas-inputs/in.png")),
        ("denoise", json!(0.6)),
        ("latentUpscale", block.clone()),
    ]);
    let problem =
        crate::jobs::compile(&stock_side).expect_err("stock refuses the block off the H3 edit");
    assert!(
        problem.contains("unmasked MiniMax H3 edit"),
        "stock names the same pairing law: {problem}"
    );
}

/// The IMAGE-arm `faceRefine` block: the prereq/allowlist half is a prepare-side window
/// proof (M11b law), but the COMPILE shape is provable now — the face pass inserts its
/// nodes behind the postprocess gate (`jobs.rs:676` validates the block, requiring the
/// minimax family). Stock fixture: `jobs_tests.rs:3045 h3_still_intent()` + the block
/// from `jobs_face_refine::tests::block()`, exactly the pairing
/// `jobs_tests.rs:3113 h3_image_face_refine_precedes_latent_upscale_without_changing_the_off_graph`
/// compiles.
#[tokio::test]
async fn h3_still_face_refine_block_lands_the_still_face_pass_nodes() {
    let kit = Kit::new();
    let block = crate::jobs_face_refine::tests::block();
    let mut stock = crate::jobs::tests::h3_still_intent();
    stock["family"] = json!("minimax-h3");
    stock["faceRefine"] = block.clone();
    let body = h3_still_body(("faceRefine", &block));
    differential(&kit, &body, &stock, "image/h3-still-faceRefine").await;
    let graph = stock_compile(&fill_intent(&kit, &body).await);
    let mine = shape(&graph);
    assert!(
        mine.contains_key("DEAS_H3FaceRefine"),
        "the face pass must grow DEAS_H3FaceRefine on the still graph:\n{}",
        render_shape(&mine)
    );
    // The still form saves the refined frame and the untouched baseline as a pair
    // (`jobs.rs:1423`: `B7` is the pre-face saver with the `_original` prefix) — the
    // history contract the leg's reporting law depends on.
    let (face_id, _) = graph
        .as_object()
        .expect("graph object")
        .iter()
        .find(|(_, node)| node["class_type"] == "DEAS_H3FaceRefine")
        .expect("the face pass node");
    assert_eq!(
        graph["PG"]["class_type"], "DEAS_ImagePostprocessGate",
        "the still's refined frame sits behind the IMAGE postprocess gate"
    );
    assert_eq!(
        graph["PG"]["inputs"]["image"],
        json!([face_id, 0]),
        "the gate's lazy input is the refined still"
    );
    assert_eq!(
        graph["7"]["inputs"]["images"],
        json!(["PG", 0]),
        "the saver carries the gate, not the raw face pass"
    );
    assert!(
        graph["B7"]["inputs"]["filename_prefix"]
            .as_str()
            .unwrap_or_default()
            .ends_with("_original"),
        "the unrefined baseline rides beside it"
    );
    // The block is H3-only on images: an SDXL still carrying it refuses at BOTH walls
    // (stock `jobs.rs:678` "needs a MiniMax H3 edit").
    let foreign = json!({
        "model": "sd/sdxl_base.safetensors", "mode": "refine",
        "positivePrompt": "a cat", "outputPrefix": "DEAS_test", "seed": 123,
        "refine": {"width": 512, "height": 768, "denoise": 0.35},
        "faceRefine": block,
        "dials": {"width": 512, "height": 768, "steps": 20, "cfg": 7,
                   "sampler": "euler", "scheduler": "normal"}
    });
    door_refusal(&kit, &foreign, ErrorKind::ModeUnsupported, "faceRefine").await;
    let stock_side = stock_image_with(&[
        (
            "refine",
            json!({"width": 512, "height": 768, "denoise": 0.35}),
        ),
        ("faceRefine", crate::jobs_face_refine::tests::block()),
    ]);
    let problem = crate::jobs::compile(&stock_side)
        .expect_err("stock refuses faceRefine off the minimax family");
    assert!(
        problem.contains("MiniMax H3"),
        "stock names the same family law: {problem}"
    );
}

/* -------------------------------- music differentials ------------------------------- */

#[tokio::test]
async fn music_t2m_lands_the_stock_yue2_graph() {
    let kit = Kit::new();
    let stock = stock_music_off();
    let body = json!({
        "model": "yue/yue2.safetensors",
        "mode": "t2m",
        "positivePrompt": "English, indie pop",
        "lyrics": "[Verse]\nHello world",
        "outputPrefix": "raw/YuE2",
        "seed": 42,
        "maxDuration": 120.0,
        "dials": {"steps": 32, "cfg": 1, "sampler": "dpm_2", "scheduler": "sgm_uniform"}
    });
    let ours = fill_intent(&kit, &body).await;
    let ours_graph = stock_compile(&ours);
    let stock_graph = stock_fixture_compile(&stock, "music/t2m-off");
    assert_shapes(&ours_graph, &stock_graph, "music/t2m-off");
    assert_no_holes(&ours_graph, &stock_graph, "music/t2m-off");
    // The documented value-level diff: the Workbench seed carries 1.01, this build's
    // `MUSIC_GENERATION_DEFAULTS` mirror carries 1.0 (fill_plane.rs:157).
    assert_eq!(ours["generation"]["cfgScale"], 1.0);
    assert_eq!(stock["generation"]["cfgScale"], 1.01);
}

#[tokio::test]
async fn music_cover_row_lands_the_stock_cover_graph() {
    let kit = Kit::new();
    let stock: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/music/cover.intent.json"
    ))
    .expect("stock cover fixture");
    let body = json!({
        "model": "yue/yue2.safetensors",
        "mode": "music",
        "positivePrompt": "English, indie pop",
        "lyrics": "[Verse]\nHello world",
        "outputPrefix": "raw/YuE2",
        "seed": 42,
        "maxDuration": 120.0,
        "audio1": "deas-inputs/song.flac",
        "audioEncoder": "ace/a15_encoder.safetensors",
        "dials": {"steps": 32, "cfg": 1, "sampler": "dpm_2", "scheduler": "sgm_uniform"}
    });
    differential(&kit, &body, &stock, "music/cover").await;
}

/// LEG M14b — the ACE-STEP music leg is OPEN. The M14a-era pin
/// (`ace_step_stock_arm_compiles_its_own_graph_and_the_door_still_refuses_the_leg`)
/// is retired by the leg it scoped: the door now runs its own ACE arm
/// (`fill_music_ace`, M14b), so the differential M14a could only state as a TARGET
/// now runs BOTH ways — the door body through `queue_post -> fill -> spool ->
/// stock compile`, and the `jobs_music_ace_tests.rs:4 intent()` fixture verbatim
/// through the same gate. Both loader forms (1.0 monolithic, 1.5 split
/// UNETLoader/DualCLIPLoader) must land structurally identical graphs; the shared-
/// classes proof stands (only the sampler/saver spine is common with the YuE2 arm).
#[tokio::test]
async fn ace_step_stock_arm_and_the_open_door_leg_compile_both_loader_forms() {
    let kit = Kit::new();
    // Verbatim from `jobs_music_ace_tests.rs:4 intent(family, split)`; 1292 frames of
    // 4096/44100 s is the 1.0 native latent grid the arm's duration law demands.
    let ace_fixture = |family: &str, profile: (&str, u64, f64, f64), split: bool| -> Value {
        let (version, steps, cfg, shift) = profile;
        let duration = if version == "1.0" {
            1292.0 * 4096.0 / 44100.0
        } else {
            120.0
        };
        let mut intent = json!({
            "recipeId": "music-generation", "version": 1, "family": family, "mode": "t2m",
            "planning": "off", "checkpoint": "ace.safetensors",
            "style": "English, indie pop", "lyrics": "[Verse]\nHello world", "seed": 42,
            "maxDuration": duration, "steps": steps, "cfg": cfg,
            "sampler": "euler", "scheduler": "simple", "outputPrefix": "raw/ACE",
            "ace": {"shift": shift, "lyricsStrength": 1, "bpm": 120, "timeSignature": "4",
                     "language": "en", "keyScale": "C major", "generateAudioCodes": true,
                     "lmCfg": 2, "temperature": 0.85, "topP": 0.9, "topK": 0, "minP": 0}
        });
        if split {
            intent["diffusion"] = json!({
                "textEncoder": "qwen_0.6b_ace15.safetensors",
                "textEncoder2": "qwen_1.7b_ace15.safetensors",
                "vae": "ace_1.5_vae.safetensors"
            });
        }
        intent
    };
    // Wall one: the stock arm IS live and compiles both loader forms.
    let monolithic = ace_fixture("ace-step-1-0", ("1.0", 50, 5.0, 5.0), false);
    let monolithic_graph = stock_fixture_compile(&monolithic, "music/ace-1.0");
    let split = ace_fixture("ace-step-1-5-turbo", ("1.5", 8, 1.0, 3.0), true);
    let split_graph = stock_fixture_compile(&split, "music/ace-1.5-split");
    let classes = |graph: &Value| -> BTreeSet<String> {
        graph
            .as_object()
            .expect("graph object")
            .values()
            .filter_map(|node| node["class_type"].as_str().map(str::to_owned))
            .collect::<BTreeSet<_>>()
    };
    let ace_classes = classes(&monolithic_graph);
    for node in [
        "TextEncodeAceStepAudio",
        "EmptyAceStepLatentAudio",
        "ModelSamplingSD3",
        "LatentOperationTonemapReinhard",
        "LatentApplyOperationCFG",
        "SaveAudioAdvanced",
    ] {
        assert!(
            ace_classes.contains(node),
            "the 1.0 arm grows '{node}': {ace_classes:?}"
        );
    }
    // The follow-up arm's real constraint: the ACE graph shares almost nothing with the
    // YuE2 graph this plane already lands, so the emission law cannot be forked from it —
    // the `ace{}` block drives its own patch/encode/latent classes and (1.5) the split
    // loader triple replaces the checkpoint loader.
    let yue_classes = classes(&stock_fixture_compile(&stock_music_off(), "music/t2m-off"));
    let shared: Vec<String> = ace_classes.intersection(&yue_classes).cloned().collect();
    assert_eq!(
        shared,
        [
            "CheckpointLoaderSimple",
            "ConditioningZeroOut",
            "KSampler",
            "SaveAudioAdvanced",
            "VAEDecodeAudio"
        ],
        "only the sampler/saver spine is common; the rest of the ACE arm is its own law"
    );
    assert_eq!(
        split_graph["1"]["class_type"], "UNETLoader",
        "the 1.5 split recipe replaces the checkpoint loader (jobs_music_ace.rs:186)"
    );
    assert_eq!(split_graph["E"]["class_type"], "DualCLIPLoader");
    // The YuE2 keys must NOT ride an ACE body: the stock derive is
    // `deny_unknown_fields`, so `generation`/`abc` (this plane's music blocks) are
    // refusals, which is why the arm needs its own key law rather than a flag.
    for foreign in ["generation", "abc", "sourceAudio", "audioEncoder"] {
        let mut probe = monolithic.clone();
        probe[foreign] = json!(1);
        let problem =
            crate::jobs::compile(&probe).expect_err("the ACE struct counts no YuE2 music key");
        assert!(
            problem.contains("Invalid ACE music intent") && problem.contains(foreign),
            "stock names the offending key ({foreign}): {problem}"
        );
    }
    // Wall two, LEG M14b: the door runs its own ACE arm now, so the closest agent
    // envelopes compile to the SAME graphs as the stock fixtures — both loader
    // forms. The 1.0 form rides the model reference (the fake index carries an
    // ace-step-1-0 checkpoint record); the 1.5 split form rides the explicit family
    // word plus the 3-key `{textEncoder,textEncoder2,vae}` triple.
    let one_body = json!({
        "model": "ace/ace-step.safetensors", "mode": "music",
        "positivePrompt": "English, indie pop", "lyrics": "[Verse]\nHello world",
        "outputPrefix": "agent/ace", "seed": 42,
        "maxDuration": 1292.0 * 4096.0 / 44100.0
    });
    differential(&kit, &one_body, &monolithic, "music/ace-1.0-door").await;
    let split_body = json!({
        "family": "ace-step-1-5-turbo", "mode": "t2m",
        "checkpoint": "ace/ace-step-1.5-turbo.safetensors",
        "diffusion": {
            "textEncoder": "qwen_0.6b_ace15.safetensors",
            "textEncoder2": "qwen_1.7b_ace15.safetensors",
            "vae": "ace_1.5_vae.safetensors"
        },
        "positivePrompt": "English, indie pop", "lyrics": "[Verse]\nHello world",
        "outputPrefix": "agent/ace", "seed": 42, "maxDuration": 120.0
    });
    differential(&kit, &split_body, &split, "music/ace-1.5-split-door").await;
    // The floor-only form: every unasked value rides the ladder — the profile tier
    // (steps/cfg/sampler/scheduler), the `defaultAceSettings` + profile-shift mirror,
    // and the grid-snapped duration seed — and the STOCK compiler accepts the result.
    let floor_body = json!({
        "model": "ace/ace-step.safetensors", "mode": "music",
        "positivePrompt": "ambient piano", "outputPrefix": "agent/ace", "seed": 42
    });
    let floored = fill_intent(&kit, &floor_body).await;
    stock_compile(&floored);
    assert_eq!(floored["mode"], "t2m");
    assert_eq!(floored["planning"], "off");
    assert!(
        floored["ace"].is_object(),
        "the stock Workbench mirror rides the floor: {floored}"
    );
    assert_eq!(
        floored["steps"], 50,
        "the 1.0 profile row is the ladder's stock tier"
    );
    // The YuE2 keys refuse the door as well (the stock wall refused them verbatim
    // above): two walls, one cause.
    for foreign in ["generation", "abc", "sourceAudio", "audioEncoder"] {
        let mut body = one_body.clone();
        body[foreign] = json!(1);
        door_refusal(&kit, &body, ErrorKind::BodyInvalid, foreign).await;
    }
}

#[tokio::test]
async fn negative_ace_fractions_off_grid_durations_and_bogus_words_refuse_both_walls() {
    // LEG M14b two-wall probes against the raw stock ACE arm and the door alike.
    let kit = Kit::new();
    let raw_one = || -> Value {
        json!({
            "recipeId": "music-generation", "version": 1, "family": "ace-step-1-0",
            "mode": "t2m", "planning": "off", "checkpoint": "ace.safetensors",
            "style": "English, indie pop", "lyrics": "[Verse]\nHello world", "seed": 42,
            "maxDuration": 1292.0 * 4096.0 / 44100.0, "steps": 50, "cfg": 5,
            "sampler": "euler", "scheduler": "simple", "outputPrefix": "raw/ACE",
            "ace": {"shift": 5, "lyricsStrength": 1, "bpm": 120, "timeSignature": "4",
                    "language": "en", "keyScale": "C major", "generateAudioCodes": true,
                    "lmCfg": 2, "temperature": 0.85, "topP": 0.9, "topK": 30, "minP": 0}
        })
    };
    let door_one = || -> Value {
        json!({
            "family": "ace-step-1-0", "mode": "music",
            "checkpoint": "ace/ace.safetensors", "positivePrompt": "p",
            "outputPrefix": "agent/ace", "seed": 42
        })
    };
    // The integral law (M11 class): a FRACTION in an integer-marked `ace` member —
    // both walls refuse. Unlike the YuE2 sub-blocks the ACE block is a serde `Value`
    // the stock gate validates by hand (`as_f64` + zero-fraction), so 30.0 PASSES
    // both walls and our door integralizes it on emission (below); 30.5 refuses.
    for (key, value) in [("topK", json!(30.5)), ("bpm", json!(120.5))] {
        let mut probe = raw_one();
        probe["ace"][key] = value.clone();
        let stock = crate::jobs::compile(&probe)
            .expect_err("the stock settings gate names the integer law");
        assert!(stock.contains(&format!("Invalid ace.{key}")), "{stock}");
        let mut body = door_one();
        body["ace"] = raw_one()["ace"].clone();
        body["ace"][key] = value;
        door_refusal(&kit, &body, ErrorKind::BodyInvalid, &format!("ace.{key}")).await;
    }
    // An INTEGRAL float is stock-side legal and lands as a JSON integer graph-side
    // (the M11 emission law; the stock arm accepts 30.0 too, but feeds it to the
    // INT node input untyped — our door hands compile the integer).
    let mut body = door_one();
    body["ace"] = raw_one()["ace"].clone();
    body["ace"]["topK"] = json!(30.0);
    body["ace"]["bpm"] = json!(120.0);
    let ours = fill_intent(&kit, &body).await;
    assert!(
        ours["ace"]["topK"].is_i64() && ours["ace"]["bpm"].is_i64(),
        "no float on an INT node input: {ours}"
    );
    stock_compile(&ours);
    // The family latent-grid law: 120.0 is OFF the 1.0 grid (the stock test
    // `ace_original_duration_never_silently_loses_a_frame` walks exactly this),
    // 0.96 and 1000.04 sit outside the 1..1000 range — both walls each time.
    for bad in [120.0, 0.96, 1000.04] {
        let mut probe = raw_one();
        probe["maxDuration"] = json!(bad);
        crate::jobs::compile(&probe).expect_err("stock refuses {bad} on the 1.0 row");
        let mut body = door_one();
        body["maxDuration"] = json!(bad);
        door_refusal(&kit, &body, ErrorKind::BodyInvalid, "maxDuration").await;
    }
    // The stock gate's equality words: planning full / mode cover — stock refuses;
    // the door never lets a planning word but off through, and counts no mode word.
    let mut probe = raw_one();
    probe["planning"] = json!("full");
    assert!(
        crate::jobs::compile(&probe).is_err(),
        "stock: planning off only"
    );
    let mut body = door_one();
    body["planning"] = json!("full");
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "planning off").await;
    let mut probe = raw_one();
    probe["mode"] = json!("cover");
    assert!(
        crate::jobs::compile(&probe).is_err(),
        "stock: mode t2m only"
    );
    // Unknown keys: deny_unknown on both walls.
    let mut probe = raw_one();
    probe["options"] = json!({});
    assert!(
        crate::jobs::compile(&probe).is_err(),
        "stock deny_unknown counts no options bag"
    );
    let mut body = door_one();
    body["options"] = json!({});
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "options").await;
    // A GGUF checkpoint: the stock ACE gate refuses it; so does the door.
    let mut probe = raw_one();
    probe["checkpoint"] = json!("ace/ace.gguf");
    assert!(
        crate::jobs::compile(&probe).is_err(),
        "stock refuses GGUF models"
    );
    let mut body = door_one();
    body["checkpoint"] = json!("ace/ace.gguf");
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "GGUF").await;
}

#[tokio::test]
async fn negative_ace_split_recipe_pairings_refuse_both_walls() {
    let kit = Kit::new();
    let raw_split = || -> Value {
        json!({
            "recipeId": "music-generation", "version": 1, "family": "ace-step-1-5-turbo",
            "mode": "t2m", "planning": "off", "checkpoint": "ace15.safetensors",
            "style": "English, indie pop", "lyrics": "[Verse]\nHello world", "seed": 42,
            "maxDuration": 120.0, "steps": 8, "cfg": 1, "sampler": "euler",
            "scheduler": "simple", "outputPrefix": "raw/ACE",
            "ace": {"shift": 3, "lyricsStrength": 1, "bpm": 120, "timeSignature": "4",
                    "language": "en", "keyScale": "C major", "generateAudioCodes": true,
                    "lmCfg": 2, "temperature": 0.85, "topP": 0.9, "topK": 0, "minP": 0},
            "diffusion": {"textEncoder": "qwen_0.6b_ace15.safetensors",
                          "textEncoder2": "qwen_1.7b_ace15.safetensors",
                          "vae": "ace_1.5_vae.safetensors"}
        })
    };
    let door_turbo = || -> Value {
        json!({
            "family": "ace-step-1-5-turbo", "mode": "t2m",
            "checkpoint": "ace/ace15.safetensors", "positivePrompt": "p",
            "outputPrefix": "agent/ace", "seed": 42
        })
    };
    // 1.0 + the split triple: the stock pairing law names the all-in-one checkpoint;
    // the door refuses the same body by the same cause.
    let mut probe = raw_split();
    probe["family"] = json!("ace-step-1-0");
    // The latent-grid law (jobs_music_ace::validate: duration x rate / samplesPerLatent
    // whole) fires BEFORE the pairing law, so the 1.0 probe must sit on the 1.0 grid:
    // 441 frames x 4096/44100 = 40.96s exactly. The pairing law is what this probe tests.
    probe["maxDuration"] = json!(40.96);
    let stock =
        crate::jobs::compile(&probe).expect_err("ACE-Step 1.0 requires the all-in-one checkpoint");
    assert!(stock.contains("all-in-one checkpoint"), "{stock}");
    let mut body = json!({
        "family": "ace-step-1-0", "mode": "music",
        "checkpoint": "ace/ace.safetensors", "positivePrompt": "p",
        "outputPrefix": "agent/ace", "seed": 42,
        "diffusion": raw_split()["diffusion"].clone()
    });
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "all-in-one checkpoint").await;
    // `clipType` rides the IMAGE recipe only; the ACE struct denies it — both walls.
    let mut probe = raw_split();
    probe["diffusion"]["clipType"] = json!("ace");
    crate::jobs::compile(&probe).expect_err("the ACE Diffusion struct counts no clipType");
    body = door_turbo();
    body["diffusion"] = raw_split()["diffusion"].clone();
    body["diffusion"]["clipType"] = json!("ace");
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "clipType").await;
    // Identical encoders: the stock split law, and the door's mirror of it.
    let mut probe = raw_split();
    probe["diffusion"]["textEncoder2"] = probe["diffusion"]["textEncoder"].clone();
    assert!(
        crate::jobs::compile(&probe).is_err(),
        "stock refuses identical split encoders"
    );
    let mut body = door_turbo();
    body["diffusion"] = raw_split()["diffusion"].clone();
    let first = body["diffusion"]["textEncoder"].clone();
    body["diffusion"]["textEncoder2"] = first;
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "distinct").await;
    // A 1.5 row WITHOUT the triple: the door refuses naming the slot (the sheet's
    // loader law, routes' drain-ready gate). Stock would COMPILE an all-in-one
    // graph around a UNET name the prereq wall then kills — the door is stricter
    // here, stated, one wall (the fill-plane pin names it too).
    let body = door_turbo();
    let hint = door_refusal(&kit, &body, ErrorKind::BodyInvalid, "diffusion").await;
    assert!(hint.contains("drain-ready"), "the slot law: {hint}");
}

/* ------------------------------------ the matrix ------------------------------------ */

/// One matrix cell: the body plus what it must not leave open.
struct Cell {
    mode: &'static str,
    bodies: [Value; 4],
}

#[tokio::test]
async fn matrix_all_thirteen_modes_compile_with_no_ladder_holes() {
    let kit = Kit::new();
    let cells = [
        Cell {
            mode: "t2i",
            bodies: [
                json!({"model":"sd/sdxl_base.safetensors","mode":"t2i","positivePrompt":"p","outputPrefix":"agent/run"}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"t2i","positivePrompt":"p","outputPrefix":"agent/run","dials":{"steps":8}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"t2i","positivePrompt":"p","outputPrefix":"agent/run","dials":{"sampler":"dpmpp_2m"}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"t2i","positivePrompt":"p","outputPrefix":"agent/run","seed":4242}),
            ],
        },
        Cell {
            mode: "i2i",
            bodies: [
                json!({"model":"sd/sdxl_base.safetensors","mode":"i2i","positivePrompt":"p","outputPrefix":"agent/run","inputImage":"deas-inputs/in.png","dials":{"denoise":0.6}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"i2i","positivePrompt":"p","outputPrefix":"agent/run","inputImage":"deas-inputs/in.png","dials":{"denoise":0.6,"negativePrompt":"worst quality"}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"i2i","positivePrompt":"p","outputPrefix":"agent/run","inputImage":"deas-inputs/in.png","imageCompression":80,"dials":{"denoise":0.6}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"i2i","positivePrompt":"p","outputPrefix":"agent/run","inputImage":"deas-inputs/in.png","seed":99,"dials":{"denoise":0.6}}),
            ],
        },
        Cell {
            mode: "inpaint",
            bodies: [
                json!({"model":"sd/sdxl_base.safetensors","mode":"inpaint","positivePrompt":"p","outputPrefix":"agent/run","inputImage":"deas-inputs/in.png","inputMask":"deas-masks/2f1e9d4c-7b3a-4e5f-9c8d-1a2b3c4d5e6f.png","dials":{"denoise":1.0}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"inpaint","positivePrompt":"p","outputPrefix":"agent/run","inputImage":"deas-inputs/in.png","inputMask":"deas-masks/2f1e9d4c-7b3a-4e5f-9c8d-1a2b3c4d5e6f.png","maskBlur":4,"dials":{"denoise":1.0}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"inpaint","positivePrompt":"p","outputPrefix":"agent/run","inputImage":"deas-inputs/in.png","inputMask":"deas-masks/2f1e9d4c-7b3a-4e5f-9c8d-1a2b3c4d5e6f.png","dials":{"denoise":0.4,"negativePrompt":"x"}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"inpaint","positivePrompt":"p","outputPrefix":"agent/run","inputImage":"deas-inputs/in.png","inputMask":"deas-masks/2f1e9d4c-7b3a-4e5f-9c8d-1a2b3c4d5e6f.png","seed":7,"dials":{"denoise":1.0}}),
            ],
        },
        Cell {
            mode: "refine",
            bodies: [
                json!({"model":"sd/sdxl_base.safetensors","mode":"refine","positivePrompt":"p","outputPrefix":"agent/run","refine":{"width":1024,"height":1024,"denoise":0.3}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"refine","positivePrompt":"p","outputPrefix":"agent/run","refine":{"width":1024,"height":1024,"denoise":0.3,"upscaleModel":"upscale/2x.safetensors"}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"refine","positivePrompt":"p","outputPrefix":"agent/run","refine":{"width":1024,"height":1024,"denoise":0.3},"dials":{"steps":12}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"refine","positivePrompt":"p","outputPrefix":"agent/run","refine":{"width":1024,"height":1024,"denoise":0.3},"seed":5150}),
            ],
        },
        Cell {
            mode: "upscale",
            bodies: [
                json!({"model":"sd/sdxl_base.safetensors","mode":"upscale","positivePrompt":"p","outputPrefix":"agent/run","inputImage":"deas-inputs/in.png","inputResize":{"width":1536,"height":1152,"crop":"disabled"},"upscaleModel":"upscale/2x.safetensors","dials":{"width":1536,"height":1152}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"upscale","positivePrompt":"p","outputPrefix":"agent/run","inputImage":"deas-inputs/in.png","inputResize":{"width":1536,"height":1152,"crop":"center"},"upscaleModel":"upscale/2x.safetensors","dials":{"width":1536,"height":1152,"denoise":0.35}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"upscale","positivePrompt":"p","outputPrefix":"agent/run","inputImage":"deas-inputs/in.png","inputResize":{"width":1536,"height":1152,"crop":"disabled"},"upscaleModel":"upscale/2x.safetensors","dials":{"width":1536,"height":1152,"steps":6}}),
                json!({"model":"sd/sdxl_base.safetensors","mode":"upscale","positivePrompt":"p","outputPrefix":"agent/run","inputImage":"deas-inputs/in.png","inputResize":{"width":1536,"height":1152,"crop":"disabled"},"upscaleModel":"upscale/2x.safetensors","seed":31337,"dials":{"width":1536,"height":1152}}),
            ],
        },
        Cell {
            // E28 (LEG AF2-M24c): `refmod` is no longer a deferred word — it is
            // the drainable RefMod EXPORT row, whose submission is the stock
            // export, never a Workbench compile. There is therefore no
            // compile-side truth for it in this matrix; the queue-door grammar
            // is pinned in `the_refmod_queue_door_refuses_render_words_and_foreign_families`,
            // the export request's stock truth in
            // `refmod_creation_door_lands_a_request_the_stock_refmod_compiler_accepts`.
            mode: "refmod",
            bodies: [json!(null), json!(null), json!(null), json!(null)],
        },
        Cell {
            mode: "ref2va",
            bodies: [
                json!({"family":"minimax-h3","mode":"ref2va","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","picture1":"deas-inputs/a.png","h3":{"audioVae":"MiniMaxH3/audio_vae.safetensors","shiftVideo":10,"shiftAudio":3}}),
                json!({"family":"minimax-h3","mode":"ref2va","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","picture1":"deas-inputs/a.png","--lora":"H3/turbo.safetensors:0.8","h3":{"audioVae":"MiniMaxH3/audio_vae.safetensors","shiftVideo":10,"shiftAudio":3}}),
                json!({"family":"minimax-h3","mode":"ref2va","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","picture1":"deas-inputs/a.png","--dials":"steps=6,cfg=2","h3":{"audioVae":"MiniMaxH3/audio_vae.safetensors","shiftVideo":10,"shiftAudio":3}}),
                json!({"family":"minimax-h3","mode":"ref2va","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","picture1":"deas-inputs/a.png","video1":"deas-input-clip.mp4","audio1":"deas-inputs/song.mp3","h3":{"audioVae":"MiniMaxH3/audio_vae.safetensors","shiftVideo":10,"shiftAudio":3}}),
            ],
        },
        Cell {
            mode: "video",
            bodies: [
                json!({"family":"minimax-h3","mode":"video","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","h3":h3_block("T2VA")}),
                json!({"family":"minimax-h3","mode":"video","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","images":["deas-inputs/a.png"],"h3":h3_block("I2VA")}),
                json!({"family":"minimax-h3","mode":"video","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","images":["deas-inputs/a.png"],"h3":h3_block("I2VA"),"frames":90,"frameRate":30}),
                json!({"family":"minimax-h3","mode":"video","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","h3":h3_block("T2VA"),"--lora":"H3/turbo.safetensors"}),
            ],
        },
        Cell {
            mode: "music",
            bodies: [
                json!({"model":"yue/yue2.safetensors","mode":"music","positivePrompt":"p","outputPrefix":"agent/run"}),
                json!({"model":"yue/yue2.safetensors","mode":"music","positivePrompt":"p","lyrics":"[Verse]\nhi","outputPrefix":"agent/run"}),
                json!({"family":"ace-step-1-0","mode":"music","checkpoint":"ace/ace.safetensors","positivePrompt":"p","outputPrefix":"agent/run"}),
                json!({"family":"ace-step-1-5-turbo","mode":"music","checkpoint":"ace/ace15.safetensors","diffusion":{"textEncoder":"ace/e1.safetensors","textEncoder2":"ace/e2.safetensors","vae":"ace/vae.safetensors"},"positivePrompt":"p","outputPrefix":"agent/run","dials":{"steps":6,"sampler":"euler"}}),
            ],
        },
        Cell {
            mode: "t2v",
            bodies: [
                json!({"family":"minimax-h3","mode":"t2v","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","h3":h3_block("T2VA")}),
                json!({"family":"ltx-2","mode":"t2v","checkpoint":"LTX2/ltx.safetensors","diffusion":ltx_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","ltx":{"textProjection":"LTX2/proj.safetensors","audioVae":"LTX2/audio_vae.safetensors","passes":1}}),
                json!({"family":"minimax-h3","mode":"t2v","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","h3":h3_block("T2VA"),"frames":175}),
                json!({"family":"minimax-h3","mode":"t2v","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","h3":h3_block("T2VA"),"--dials":"steps=6"}),
            ],
        },
        Cell {
            mode: "i2v",
            bodies: [
                json!({"model":"WAN22/high.safetensors","mode":"i2v","positivePrompt":"p","outputPrefix":"agent/run","wan":{"lowModel":"WAN22/low.safetensors","shiftHigh":5,"shiftLow":5,"refinerStep":2},"firstFrame":"deas-inputs/a.png","lastFrame":"deas-inputs/b.png"}),
                json!({"model":"WAN22/high.safetensors","mode":"i2v","positivePrompt":"p","outputPrefix":"agent/run","wan":{"lowModel":"WAN22/low.safetensors","shiftHigh":5,"shiftLow":5,"refinerStep":2},"firstFrame":"deas-inputs/a.png"}),
                json!({"family":"minimax-h3","mode":"i2v","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","images":["deas-inputs/a.png"],"h3":h3_block("I2VA")}),
                json!({"family":"ltx-2","mode":"i2v","checkpoint":"LTX2/ltx.safetensors","diffusion":ltx_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","firstFrame":"deas-inputs/a.png","ltx":{"textProjection":"LTX2/proj.safetensors","audioVae":"LTX2/audio_vae.safetensors","passes":1}}),
            ],
        },
        Cell {
            mode: "v2v",
            bodies: [
                json!({"family":"ltx-2","mode":"v2v","checkpoint":"LTX2/ltx.safetensors","diffusion":ltx_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","sourceVideo":"deas-input-clip.mp4","ltx":{"textProjection":"LTX2/proj.safetensors","audioVae":"LTX2/audio_vae.safetensors","passes":1,"sourceStrength":0.6}}),
                json!({"family":"ltx-2","mode":"v2v","checkpoint":"LTX2/ltx.safetensors","diffusion":ltx_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","sourceVideo":"deas-input-clip.mp4","ltx":{"textProjection":"LTX2/proj.safetensors","audioVae":"LTX2/audio_vae.safetensors","passes":1,"sourceStrength":0.6},"chunks":4}),
                json!({"family":"minimax-h3","mode":"v2v","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","h3":h3_block("I2VA"),"images":["deas-inputs/a.png"]}),
                json!({"family":"ltx-2","mode":"v2v","checkpoint":"LTX2/ltx.safetensors","diffusion":ltx_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","sourceVideo":"deas-input-clip.mp4","--dials":"steps=6","ltx":{"textProjection":"LTX2/proj.safetensors","audioVae":"LTX2/audio_vae.safetensors","passes":1,"sourceStrength":0.6}}),
            ],
        },
        Cell {
            mode: "t2m",
            bodies: [
                json!({"model":"yue/yue2.safetensors","mode":"t2m","positivePrompt":"p","outputPrefix":"agent/run"}),
                json!({"model":"yue/yue2.safetensors","mode":"t2m","positivePrompt":"p","lyrics":"[Verse]\nhi","outputPrefix":"agent/run","seed":1234}),
                json!({"model":"yue/yue2.safetensors","mode":"t2m","positivePrompt":"p","outputPrefix":"agent/run","maxDuration":240.0,"dials":{"cfg":2}}),
                json!({"family":"ace-step-1-5-base","mode":"t2m","checkpoint":"ace/ace15b.safetensors","diffusion":{"textEncoder":"ace/e1.safetensors","textEncoder2":"ace/e2.safetensors","vae":"ace/vae.safetensors"},"positivePrompt":"p","outputPrefix":"agent/run","seed":1234}),
            ],
        },
    ];
    assert_eq!(cells.len(), defaults::MODES.len(), "one cell per mode word");
    for cell in cells {
        if cell.mode == "refmod" {
            continue;
        }
        for (index, body) in cell.bodies.iter().enumerate() {
            let ours = fill_intent(&kit, body).await;
            let graph = stock_compile(&ours);
            let (empties, nulls) = value_holes(&graph);
            let _ = empties; // bounded by the differentials; the matrix pins nulls
            assert!(
                nulls.is_empty(),
                "mode '{}' body #{} left null inputs in the graph: {nulls:?}\nintent: {}",
                cell.mode,
                index,
                serde_json::to_string(&ours).expect("intent bytes")
            );
            assert!(
                !graph.as_object().expect("graph").is_empty(),
                "mode '{}' body #{} compiled an empty graph",
                cell.mode,
                index
            );
        }
    }
}

/* ------------------------------------ negatives ------------------------------------ */

#[tokio::test]
async fn negative_unknown_model_handle_refuses_at_the_door() {
    let kit = Kit::new();
    let body = json!({"model":"deadbeefcafe","mode":"t2i","positivePrompt":"p","outputPrefix":"agent/run"});
    door_refusal(
        &kit,
        &body,
        ErrorKind::LibraryScanRequired,
        "no library entry",
    )
    .await;
    // Stock has no model-resolution wall at all: the same handle as a raw checkpoint
    // name compiles (a name is a name to ComfyUI). The honest asymmetry: the door
    // refuses a handle the LIBRARY does not know, which stock can never know.
    let raw = json!({"recipeId":"checkpoint-text-to-image-diagnostic","version":1,
        "positivePrompt":"p","negativePrompt":"","checkpoint":"deadbeefcafe",
        "seed":1,"width":512,"height":512,"steps":20,"cfg":7,
        "sampler":"euler","scheduler":"normal","outputPrefix":"agent/run"});
    assert!(
        crate::jobs::compile(&raw).is_ok(),
        "the stock image arm has no library wall to agree with; recorded as the \
         documented one-way wall (identity lives in the library, not in compile)"
    );
}

#[tokio::test]
async fn negative_inpaint_mask_without_its_pair_refuses_and_stock_refuses_too() {
    let kit = Kit::new();
    // Our wall: the inpaint mode's requirement names the missing key.
    let body = json!({"model":"sd/sdxl_base.safetensors","mode":"inpaint","positivePrompt":"p","outputPrefix":"agent/run","inputMask":"deas-masks/2f1e9d4c-7b3a-4e5f-9c8d-1a2b3c4d5e6f.png","dials":{"denoise":1.0}});
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "inputImage").await;
    // The stock wall, same shape bypassing fill entirely.
    let raw = json!({"recipeId":"checkpoint-text-to-image-diagnostic","version":1,
        "positivePrompt":"p","negativePrompt":"","checkpoint":"sd/model.safetensors",
        "seed":1,"width":512,"height":512,"steps":20,"cfg":7,
        "sampler":"euler","scheduler":"normal","outputPrefix":"agent/run",
        "inputMask":"deas-masks/2f1e9d4c-7b3a-4e5f-9c8d-1a2b3c4d5e6f.png"});
    let stock = crate::jobs::compile(&raw).expect_err("stock must refuse the same shape");
    assert!(
        stock.contains("inputMask"),
        "the stock refusal should name inputMask, it said: {stock}"
    );
}

#[tokio::test]
async fn negative_sampler_outside_the_grammar_refuses_and_stock_refuses_too() {
    let kit = Kit::new();
    let body = json!({"model":"sd/sdxl_base.safetensors","mode":"t2i","positivePrompt":"p","outputPrefix":"agent/run","dials":{"sampler":"beta57;rm"}});
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "sampler").await;
    let mut raw = stock_image();
    raw["sampler"] = json!("beta57;rm");
    let stock = crate::jobs::compile(&raw).expect_err("stock refuses the same word");
    assert!(
        stock.contains("sampler or scheduler"),
        "stock quotes the jobs_tests.rs:556 law verbatim: {stock}"
    );
}

#[tokio::test]
async fn negative_family_fixed_sampler_refuses_both_walls() {
    let kit = Kit::new();
    // `minimax-h3-hyperflow` pins euler and steps 4/6/8 (builtin.json fixedSampler /
    // stepChoices); BOTH walls read the same plugin (jobs_video.rs:1453).
    let body = json!({"family":"minimax-h3-hyperflow","mode":"t2v","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","h3":h3_block("T2VA"),"dials":{"sampler":"res_multistep"}});
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "runs euler only").await;
    let raw = json!({"recipeId":"video-generation","version":1,"family":"minimax-h3-hyperflow",
        "positivePrompt":"p","negativePrompt":"","model":"MiniMaxH3/fl.safetensors",
        "textEncoder":"MiniMaxH3/qwen3vl.safetensors","vae":"MiniMaxH3/video_vae.safetensors",
        "seed":7,"width":1024,"height":768,"frames":124,"frameRate":24,"steps":6,"cfg":1,
        "sampler":"res_multistep","scheduler":"simple","outputPrefix":"agent/run",
        "h3":{"mode":"T2VA","audioVae":"MiniMaxH3/audio_vae.safetensors","shiftVideo":10,"shiftAudio":3}});
    let stock = crate::jobs::compile(&raw).expect_err("stock refuses the same sampler");
    assert!(
        stock.contains("runs euler only"),
        "stock quotes the same fixed-sampler law: {stock}"
    );
}

#[tokio::test]
async fn negative_ref2va_over_the_reference_caps_refuses_and_stock_refuses_too() {
    let kit = Kit::new();
    let many: Vec<String> = (0..13)
        .map(|index| format!("deas-inputs/frame{index}.png"))
        .collect();
    let body = json!({"family":"minimax-h3","mode":"ref2va","checkpoint":"MiniMaxH3/fl2va.safetensors","diffusion":h3_diffusion(),"positivePrompt":"p","outputPrefix":"agent/run","images":many,"h3":{"audioVae":"MiniMaxH3/audio_vae.safetensors","shiftVideo":10,"shiftAudio":3}});
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "caps at 9 images").await;
    let media: Vec<Value> = many
        .iter()
        .enumerate()
        .map(|(slot, file)| json!({"type":"image","file":file,"slot":slot}))
        .collect();
    let raw = json!({"recipeId":"video-generation","version":1,"family":"minimax-h3",
        "positivePrompt":"p","negativePrompt":"","model":"MiniMaxH3/fl2va.safetensors",
        "textEncoder":"MiniMaxH3/qwen3vl.safetensors","vae":"MiniMaxH3/video_vae.safetensors",
        "seed":7,"width":1024,"height":768,"frames":124,"frameRate":24,"steps":4,"cfg":1,
        "sampler":"euler","scheduler":"simple","outputPrefix":"agent/run",
        "h3":{"mode":"REF2VA","audioVae":"MiniMaxH3/audio_vae.safetensors","shiftVideo":10,"shiftAudio":3,"media":media}});
    let stock = crate::jobs::compile(&raw).expect_err("stock refuses the same over-cap row set");
    assert!(
        stock.contains("media") || stock.contains("slot"),
        "the stock lane law must name the media rows: {stock}"
    );
}

#[tokio::test]
async fn negative_upscale_without_resize_refuses_and_stock_refuses_too() {
    let kit = Kit::new();
    let body = json!({"model":"sd/sdxl_base.safetensors","mode":"upscale","positivePrompt":"p","outputPrefix":"agent/run","inputImage":"deas-inputs/in.png","upscaleModel":"upscale/2x.safetensors","dials":{"denoise":0.0}});
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "inputResize").await;
    let raw = json!({"recipeId":"checkpoint-text-to-image-diagnostic","version":1,
        "positivePrompt":"p","negativePrompt":"","checkpoint":"sd/model.safetensors",
        "seed":1,"width":1536,"height":1152,"steps":20,"cfg":7,
        "sampler":"euler","scheduler":"normal","outputPrefix":"agent/run",
        "inputImage":"deas-inputs/in.png","denoise":0.0,"upscaleModel":"upscale/2x.safetensors"});
    let stock = crate::jobs::compile(&raw).expect_err("stock refuses the same pairing");
    assert!(
        stock.contains("upscaleModel"),
        "the stock pairing law names upscaleModel: {stock}"
    );
}

/* -------------------------------- model / mode coupling ---------------------------- */

#[tokio::test]
async fn coupling_a_video_model_onto_an_image_mode_refuses_at_the_door() {
    let kit = Kit::new();
    // wan detects as a video family; the image arm's pipeline gate is the wall.
    let body = json!({
        "model": "WAN22/high.safetensors",
        "mode": "t2i",
        "positivePrompt": "p",
        "outputPrefix": "agent/run",
    });
    // The stock-accurate refusal word: the video-only gate names the FAMILY and its
    // declared pipelines (fill_plane.rs `check_family_supports`), never the mode.
    let hint = door_refusal(
        &kit,
        &body,
        ErrorKind::ModeUnsupported,
        "declares no image pipeline",
    )
    .await;
    assert!(
        hint.contains("video recipe"),
        "the refusal must state the family's video-only existence: {hint}"
    );
    // The mirror image: an image family onto a video mode.
    let body = json!({"model":"sd/sdxl_base.safetensors","mode":"t2v","positivePrompt":"p","outputPrefix":"agent/run"});
    door_refusal(&kit, &body, ErrorKind::ModeUnsupported, "video-generation").await;
    // A music family onto an image mode, and an image family onto the music mode.
    let body = json!({"model":"yue/yue2.safetensors","mode":"t2i","positivePrompt":"p","outputPrefix":"agent/run"});
    door_refusal(
        &kit,
        &body,
        ErrorKind::ModeUnsupported,
        "declares no image pipeline",
    )
    .await;
    let body = json!({"model":"sd/sdxl_base.safetensors","mode":"t2m","positivePrompt":"p","outputPrefix":"agent/run"});
    door_refusal(&kit, &body, ErrorKind::ModeUnsupported, "t2m").await;
    // The window-side half stays out of reach here: `recipe_prerequisites` and the
    // Triton allowlist need the owned backend over HTTP, so the PREREQ layer is a
    // window proof (M11b); the COMPILE layer is what this harness proves.
}

#[tokio::test]
async fn families_without_a_components_map_refuse_a_model_reference() {
    let kit = Kit::new();
    // FINDING (reported, not papered over): the stock family plugin
    // (`src/families/builtin.json`, read by `model_families::component_matches` at
    // model_families.rs:194) gives minimax-h3 NO `components` map and ltx-2 a PARTIAL
    // one (`audioVaes`/`textProjections` — the `textEncoders` slot has no component
    // ids), while wan and anima carry full ones. `component_matches` reads only that
    // map, so the resolver can never build the h3/ltx split recipe from the library
    // index, and the door answers the honest `libraryScanRequired` naming the missing
    // slot (the LTX2 model itself IS in the index, so this refusal is the components
    // law, not a scan gap). The video bodies in this harness therefore carry the
    // recipe explicitly (family + checkpoint + diffusion), which §9 says wins over a
    // resolved value — and the video differentials prove that explicit body compiles
    // the stock graph end to end.
    let body = json!({"model":"LTX2/ltx.safetensors","mode":"t2v","positivePrompt":"p","outputPrefix":"agent/run","ltx":{"textProjection":"LTX2/proj.safetensors","audioVae":"LTX2/audio_vae.safetensors","passes":1}});
    door_refusal(&kit, &body, ErrorKind::LibraryScanRequired, "textEncoders").await;
}

/* ------------------------------------ the refmod door ------------------------------ */

#[tokio::test]
async fn the_refmod_queue_door_refuses_render_words_and_foreign_families() {
    // E28 (LEG AF2-M24c replaced the M-era `refmod_mode_is_deferred_at_the_queue_door`
    // pin — the word is no longer Deferred): the mode-`refmod` ROW door holds the
    // closed request grammar. A render body is refused `bodyInvalid` NAMING the
    // model key (this mode runs no ladder and resolves no model), and a foreign
    // family meets the H3-only wall as `modeUnsupported` naming the reason —
    // neither body ever reaches the spool.
    let kit = Kit::new();
    let render_body = json!({"model":"sd/sdxl_base.safetensors","mode":"refmod","positivePrompt":"p","outputPrefix":"agent/run"});
    door_refusal(
        &kit,
        &render_body,
        ErrorKind::BodyInvalid,
        "'model' is not an intent key the 'refmod' door accepts",
    )
    .await;
    let foreign = json!({"family":"anima","mode":"refmod","refmods":["old.safetensors"]});
    door_refusal(&kit, &foreign, ErrorKind::ModeUnsupported, "cannot run it").await;
}

#[tokio::test]
async fn refmod_creation_door_lands_a_request_the_stock_refmod_compiler_accepts() {
    let kit = Kit::new();
    // The RefMod surface is its own door and its own seam (`POST /v1/refmods` ->
    // `RefmodBridge::submit` -> the stock `native_h3_refmod_submit`); the compile-side
    // truth is `jobs_refmod::compile(request, request_id)` (jobs_refmod.rs:51). The
    // request the fake seam received is handed straight to the stock compiler.
    let request = Request::builder()
        .method("POST")
        .uri("http://127.0.0.1:8790/v1/refmods")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "name": "hero",
                "description": "main cast",
                "conceptType": "identity",
                "picture1": "deas-inputs/a.png",
                "video1": "deas-input-clip.mp4",
                "--refmod": "old/set",
                "vae": "MiniMaxH3/video_vae.safetensors",
                "audioVae": "MiniMaxH3/audio_vae.safetensors"
            })
            .to_string(),
        ))
        .expect("valid request");
    let answer = super::results::refmod_create(State(kit.plane.clone()), request)
        .await
        .expect("the creation door answers");
    assert_eq!(answer.0["status"], "queued", "{:#?}", answer.0);
    let submitted = kit.refmods.submitted.lock().expect("seam log").clone();
    let ours = submitted
        .last()
        .expect("the door submitted one export")
        .clone();

    let ours_graph = crate::jobs::refmod::compile(&ours, "req-ours")
        .unwrap_or_else(|problem| panic!("stock RefMod compile refused {ours}: {problem}"));
    let stock_side = stock_refmod_request();
    let stock_graph = crate::jobs::refmod::compile(&stock_side, "req-stock")
        .unwrap_or_else(|problem| panic!("the stock RefMod fixture refused: {problem}"));
    assert_shapes(&ours_graph, &stock_graph, "refmod/create");
    assert_no_holes(&ours_graph, &stock_graph, "refmod/create");
    // The media rows carry the same contract the stock fixture pins; descriptions are
    // the Workbench's, which the agent surface never invents.
    assert_eq!(ours["media"][0]["file"], "deas-inputs/a.png");
    assert_eq!(ours["media"][1]["file"], "deas-input-clip.mp4");
    assert_eq!(ours["refmods"], json!(["old/set"]));
}

/* --------------------------------- the ladder's own truth -------------------------- */

#[tokio::test]
async fn a_defaults_sheet_combo_overrides_the_stock_tier_and_still_compiles() {
    let kit = Kit::new();
    // The §6 ladder order, proven at the compile gate rather than in a unit test: a
    // `family:mode` combo beats the builtin stock tier, and the graph still lands.
    super::defaults::write(
        kit.app.path(),
        &super::defaults::DefaultsSheet {
            version: super::defaults::SHEET_VERSION,
            global: super::defaults::Dials::default(),
            families: Default::default(),
            combos: {
                let mut map = std::collections::BTreeMap::new();
                map.insert(
                    "sdxl:t2i".to_owned(),
                    super::defaults::Dials {
                        steps: Some(6),
                        ..super::defaults::Dials::default()
                    },
                );
                map
            },
        },
    )
    .expect("a valid sheet writes");
    let body = json!({"model":"sd/sdxl_base.safetensors","mode":"t2i","positivePrompt":"a cat","outputPrefix":"DEAS_test","seed":123});
    let ours = fill_intent(&kit, &body).await;
    assert_eq!(ours["steps"], 6, "the combo tier beat the builtin 28");
    let graph = stock_compile(&ours);
    assert_eq!(graph["5"]["inputs"]["steps"], 6);
    let (empties, nulls) = value_holes(&graph);
    assert!(nulls.is_empty(), "null inputs: {nulls:?}");
    assert!(
        empties.is_subset(&value_holes(&stock_fixture_compile(&stock_image(), "image/t2i")).0),
        "empty-string inputs drifted from the stock shape: {empties:?}"
    );
}

/// The §6 ladder proven at the COMPILE gate: a distinct value at every tier, and the
/// graph carries the WINNER plus the tier word that supplied it. Sheet staging reuses
/// the defaults plane's own write path (`defaults::write` — the same call
/// `defaults::tests::ladder_sheet`/`write_fixture` (defaults.rs:817/:596) and the combo
/// test above exercise); no hand-built intent, and every verdict is read off the
/// compiled graph, not off our own field list.
#[tokio::test]
async fn every_defaults_tier_lands_its_winning_value_in_the_compiled_graph() {
    let kit = Kit::new();
    let body = json!({
        "model": "sd/sdxl_base.safetensors", "mode": "t2i",
        "positivePrompt": "a cat", "outputPrefix": "DEAS_test", "seed": 123
    });
    let sheet = |blocks: Value| {
        let mut table = json!({"version": defaults::SHEET_VERSION});
        for (tier, block) in blocks.as_object().expect("tier blocks") {
            table[tier] = block.clone();
        }
        let sheet: defaults::DefaultsSheet =
            serde_json::from_value(table).expect("a valid sheet shape");
        defaults::write(kit.app.path(), &sheet).expect("the sheet lands");
    };
    // (tier blocks, expected steps, expected tier word). The builtin stock tier for
    // sdxl answers 28, which is what the sheet-absent case must resolve.
    for (blocks, want, source) in [
        (json!({}), 28, "stock"),
        (json!({"global": {"steps": 7}}), 7, "global"),
        (
            json!({"global": {"steps": 7}, "families": {"sdxl": {"steps": 9}}}),
            9,
            "family",
        ),
        (
            json!({
                "global": {"steps": 7},
                "families": {"sdxl": {"steps": 9}},
                "combos": {"sdxl:t2i": {"steps": 11}}
            }),
            11,
            "combo",
        ),
    ] {
        sheet(blocks);
        let ours = fill_intent(&kit, &body).await;
        assert_eq!(
            ours["steps"], want,
            "the '{source}' tier must win the ladder"
        );
        let graph = stock_compile(&ours);
        assert_eq!(
            graph["5"]["inputs"]["steps"], want,
            "the winner must reach the compiled sampler, not just the intent"
        );
        let answer = door(&kit, &body).await.expect("the body queues");
        let row = kit.row(answer["id"].as_str().expect("id"));
        let won = row.envelope["fields"]
            .as_array()
            .expect("the envelope carries the ladder fields")
            .iter()
            .find(|field| field["field"] == "steps")
            .expect("a steps field record");
        assert_eq!(
            won["source"].as_str(),
            Some(source),
            "the row must name the tier that won ({source})"
        );
    }
    // Tier 1 is the request itself: the same three-tier sheet, beaten by the dial block.
    sheet(json!({
        "global": {"steps": 7},
        "families": {"sdxl": {"steps": 9}},
        "combos": {"sdxl:t2i": {"steps": 11}}
    }));
    let mut with_dials = body.clone();
    with_dials["dials"] = json!({"steps": 13});
    let ours = fill_intent(&kit, &with_dials).await;
    assert_eq!(ours["steps"], 13, "the request beats every sheet tier");
    assert_eq!(stock_compile(&ours)["5"]["inputs"]["steps"], 13);
    // No tier may leave a hole: the minimal body still compiles clean against the
    // stock image fixture's own empty-string set.
    let graph = stock_compile(&fill_intent(&kit, &body).await);
    assert_no_holes(
        &graph,
        &stock_fixture_compile(&stock_image(), "image/t2i"),
        "ladder/tiers/no-holes",
    );
}

/// GAP CHECK (LEG M14a): the `options` bag is a LADDER dial (it never rides the
/// passthrough), so a sheet-level bag must reach the STOCK option nodes — and reach them
/// with the value CLASSES those nodes type (`vaeTile` is read through `as_u64()` at
/// `jobs_video.rs:1776`, so a float emission is exactly the M11 defect class). Stock
/// shape evidence: `jobs_tests.rs:2689` attaches this same bag family to the image
/// fixture.
#[tokio::test]
async fn the_options_bag_rides_its_tier_to_the_stock_option_nodes_with_stock_value_classes() {
    let kit = Kit::new();
    // `options.compile` is deliberately absent from the bag: this door refuses it by the
    // Triton prerequisite cause (fill_plane.rs:1261) while stock accepts it — a
    // documented wall difference, pinned at the end of this test.
    let bag = json!({
        "attention": "comfy kitchen attention",
        "cache": {"node": "EasyCache", "threshold": 0.2},
        "vaeTile": 512
    });
    let body = json!({
        "model": "sd/sdxl_base.safetensors", "mode": "t2i",
        "positivePrompt": "a cat", "outputPrefix": "DEAS_test", "seed": 123
    });
    let sheet = |blocks: Value| {
        let mut table = json!({"version": defaults::SHEET_VERSION});
        for (tier, block) in blocks.as_object().expect("tier blocks") {
            table[tier] = block.clone();
        }
        let sheet: defaults::DefaultsSheet =
            serde_json::from_value(table).expect("a valid sheet shape");
        defaults::write(kit.app.path(), &sheet).expect("the sheet lands");
    };
    // The global tier carries the bag: the compiled shape must match the stock fixture
    // that carries the same bag, node for node.
    sheet(json!({"global": {"options": bag.clone()}}));
    differential(
        &kit,
        &body,
        &stock_image_with(&[("options", bag.clone())]),
        "image/options-bag-global-tier",
    )
    .await;
    let graph = stock_compile(&fill_intent(&kit, &body).await);
    assert_eq!(
        graph["A"]["class_type"], "ModelAttentionBackend",
        "the attention patch chains onto the model"
    );
    assert_eq!(graph["A"]["inputs"]["attention"], bag["attention"]);
    assert_eq!(graph["E"]["class_type"], "EasyCache");
    assert_eq!(
        graph["E"]["inputs"]["reuse_threshold"], 0.2,
        "the cache threshold rides as the float the node types"
    );
    assert_eq!(graph["6"]["class_type"], "VAEDecodeTiled");
    assert_eq!(
        graph["6"]["inputs"]["tile_size"].as_u64(),
        Some(512),
        "vaeTile must survive the sheet as an INTEGER: both stock arms read it through \
         as_u64 (jobs_video.rs:1776), so a float silently drops the tiled VAE"
    );
    assert!(graph.get("T").is_none(), "no torch.compile node unasked");
    // The combo bag beats the global bag wholesale: one bag per field, because two
    // attention patches would silently override each other (stock `valid_options`).
    sheet(json!({
        "global": {"options": bag},
        "combos": {"sdxl:t2i": {"options": {"sage": "auto"}}}
    }));
    let ours = fill_intent(&kit, &body).await;
    assert_eq!(
        ours["options"],
        json!({"sage": "auto"}),
        "the combo bag wins"
    );
    let patched = stock_compile(&ours);
    assert_eq!(patched["K"]["class_type"], "PathchSageAttentionKJ");
    assert!(
        patched.get("A").is_none(),
        "the losing bag must not leak a node"
    );
    assert!(
        patched.get("E").is_none() && patched["6"]["class_type"] == "VAEDecode",
        "the winning bag carries no cache pass and no tiled VAE"
    );
    // The value classes the stock validator owns: `vaeTile` an integer 256..=4096 on a
    // 64 grid, `cache.node` a closed word, one attention patch only. Both walls refuse
    // the same shapes — the door names its dial law, stock says the stock words.
    for bad in [
        json!({"vaeTile": 512.0}),
        json!({"vaeTile": 500}),
        json!({"cache": {"node": "NopeCache", "threshold": 0.2}}),
        json!({"attention": "pytorch attention", "sage": "auto"}),
    ] {
        let refused = json!({
            "model": "sd/sdxl_base.safetensors", "mode": "t2i",
            "positivePrompt": "a cat", "outputPrefix": "DEAS_test", "seed": 123,
            "dials": {"options": bad.clone()}
        });
        door_refusal(&kit, &refused, ErrorKind::BodyInvalid, "options:").await;
        let stock_side = stock_image_with(&[("options", bad.clone())]);
        assert_eq!(
            crate::jobs::compile(&stock_side),
            Err("Invalid options".to_owned()),
            "stock refuses the same option shape: {bad}"
        );
    }
    // The documented wall difference: stock accepts `options.compile`; this door refuses
    // it because it cannot prove the Triton prerequisite on the owned backend (M11a law:
    // the prereq layer is a window proof, never a compile proof). LEG M14a found the
    // gate existed on the VIDEO arm only — an image body carrying `options.compile` rode
    // to the prepare-side allowlist wall (`jobs.rs:1820` + `recipe_prerequisites:518`),
    // the invisible-refusal class. Fixed at the plane home: the gate is now
    // `fill_plane::check_triton_gated_compile`, one home every arm calls.
    let compiled = json!({
        "model": "sd/sdxl_base.safetensors", "mode": "t2i",
        "positivePrompt": "a cat", "outputPrefix": "DEAS_test", "seed": 123,
        "dials": {"options": {"compile": "inductor"}}
    });
    door_refusal(&kit, &compiled, ErrorKind::ModeUnsupported, "Triton").await;
    // A sheet tier carrying the compile key answers the same cause (the gate reads the
    // RESOLVED field, not the request).
    sheet(json!({"global": {"options": {"compile": "inductor"}}}));
    door_refusal(&kit, &body, ErrorKind::ModeUnsupported, "Triton").await;
    assert!(
        crate::jobs::compile(&stock_image_with(&[(
            "options",
            json!({"compile": "inductor"})
        )]))
        .is_ok(),
        "stock accepts options.compile — the walls differ HERE by ruling, not by accident"
    );
}

#[tokio::test]
async fn every_matrix_mode_carries_its_seed_from_a_named_tier() {
    let kit = Kit::new();
    // The reproducibility law the spool row owes the operator: a random draw and a
    // fixed value both land as numbers, and the envelope names the tier that supplied
    // them. Read through the door's own verdict record.
    let answer = door(
        &kit,
        &json!({"model":"sd/sdxl_base.safetensors","mode":"t2i","positivePrompt":"p","outputPrefix":"agent/run"}),
    )
    .await
    .expect("the minimal t2i body queues");
    assert!(
        answer["seed"].is_number(),
        "the drawn seed echoes: {answer}"
    );
    let row = kit.row(answer["id"].as_str().expect("id"));
    assert_eq!(
        row.envelope["seed"]["modeSource"]
            .as_str()
            .unwrap_or_default(),
        "floor",
        "an unrequested seedMode rides the floor tier"
    );
    let answer = door(
        &kit,
        &json!({"model":"sd/sdxl_base.safetensors","mode":"t2i","positivePrompt":"p","outputPrefix":"agent/run","seed":98765}),
    )
    .await
    .expect("the fixed-seed body queues");
    assert_eq!(answer["seed"], 98765);
    let row = kit.row(answer["id"].as_str().expect("id"));
    assert_eq!(
        row.envelope["seed"]["valueSource"].as_str(),
        Some("request")
    );
}
