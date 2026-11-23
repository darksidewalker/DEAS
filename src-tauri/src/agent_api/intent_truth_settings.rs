//! LEG M13 — the SETTINGS-TRUTH harness (owner-ordered).
//!
//! What this file proves, in the owner's words: every resolution dial (width, height,
//! the per-mode grid laws) and every output setting (file type, compression, codec,
//! quality) that an intent carries must LAND WHERE STOCK LANDS IT — asserted at the
//! graph seam (node class + input VALUE), never against our own intent shape alone.
//!
//! The pipeline is the M11a home, reused verbatim (no fork): the real `POST /v1/queue`
//! door, the durable spool, the drain's `spool::flat_intent` reconstruction, and
//! `jobs::compile` as the stock wall. Refusals assert BOTH walls: the door's closed
//! word AND the same raw intent refused by stock compile (or `validate`, which compile
//! calls — the video grid and output laws are validate-side INSIDE compile, so the
//! compile call carries them; documented per probe, honestly).
//!
//! Seam map of the settings, from the stock read (PART A grounding):
//!
//! * Image canvas — `jobs::compile` numeric table (jobs.rs:857-868): integer
//!   8..=8192, aligned to 8, pixels ≤ 16,777,216 (the floor is the true latent-grid
//!   floor, raised from the historical 64 — one latent cell is 8, so no smaller
//!   canvas can exist). Graph carrier: every node with
//!   `width`/`height` inputs (EmptyLatentImage "4", the recipe encode node, ImageScale).
//!   The door now mirrors the law (`fill_plane::check_image_canvas`) — the half-override
//!   (width-only body) stays legal because the flat intent is per-field stock-side too:
//!   both walls measure the MERGED pair.
//! * Video canvas — `jobs_video::grid` (jobs_video.rs:185-190, enforced at :1436 inside
//!   `validate`, which `compile` calls): ltx-2 /32 & 8k+1, wan /16 & 4k+1, H3 /32 &
//!   17k+5; the door has mirrored it since M9c (`check_video_ranges`).
//! * Image output — `imageFormat`/`imageCompression` are validated inside `compile`
//!   (jobs.rs:719-724) and count in its key law. The COMPILE-seam graph keeps the plain
//!   `SaveImage` saver; the swap to `DaSiWa_MetadataImageSaver` with `file_format`/
//!   `compression` inputs is PREPARE-side (`civitai_saver`, jobs.rs:1560, called only
//!   when the backend's object_info allows the DaSiWa saver pair — jobs.rs:1867). The
//!   0..=100 number rides RAW; the PNG-level/WebP-quality mapping is runtime Python
//!   (jobs.rs:1594 comment). Stock's graph-level evidence for the swap lives in the
//!   stock tests (jobs_tests.rs:2923-2929, :3067-3084 — `file_format` "webp").
//! * Video output — the `output` block is lawed by `jobs_video::valid_output` (:209)
//!   at :1477 inside `validate`; `effective_output` (:1785) fills codec/container/
//!   bitDepth Auto, quality 20, audioCodec Auto, audioBitrate 192k, saves false; the
//!   values ride node "7" `DaSiWa_EnhancedVideoCombine` as `codec`/`container`/
//!   `bit_depth`/`quality`/`audio_codec`/`audio_bitrate`/`save_first_frame`/
//!   `save_last_frame` (:1819-1824). The block is ALL-KEYS-OR-ABSENT stock-side — the
//!   door now refuses partials too (the `check_video_passthrough_shape` arm calls the
//!   stock predicate directly, the dial-rack pattern).
//! * Music output — fixed: `SaveAudioAdvanced` with `format: "flac"` (jobs_music.rs:187,
//!   jobs_music_ace.rs:171). Not an intent key; nothing to expose. Resolution: N/A —
//!   the music key law counts no width/height at all.
//! * RefMod — the `refmod` MODE is the drainable RefMod EXPORT row (E28, LEG
//!   AF2-M24c), not a render recipe — it has no settings ladder and no compile
//!   cell, so it is skipped from the matrix (pinned by
//!   `fill_plane::the_refmod_row_fills_the_closed_export_map_not_a_plan`; RefMod
//!   creation is a different door with no generation settings).

use serde_json::{json, Value};

use super::defaults;
use super::errors::ErrorKind;
use super::fill_plane;
use super::intent_truth::{
    assert_shapes, door_refusal, fill_intent, h3_block, h3_diffusion, ltx_diffusion, stock_compile,
    stock_fixture_compile, stock_image_with, value_holes, Kit,
};

/* --------------------------------- the combo table ---------------------------------- */

/// One builtin family row, read from the embedded sheet (the same single home the
/// defaults ladder and `GET /v1/families` read).
fn family_row(family: &str) -> &'static Value {
    defaults::builtin_view()
        .as_array()
        .expect("the builtin sheet is an array")
        .iter()
        .find(|row| row["id"] == family)
        .unwrap_or_else(|| panic!("'{family}' is not a builtin family"))
}

/// The per-family stock defaults for the canvas, as (width, height).
fn default_edges(family: &str) -> (u64, u64) {
    let row = family_row(family);
    (
        row["defaults"]["width"].as_u64().expect("default width"),
        row["defaults"]["height"].as_u64().expect("default height"),
    )
}

/// Form-level exclusions from the pipeline-gated family set, each with the reason the
/// harness states (and a pinning probe where the refusal is reachable):
///
/// * `ref2va` over hyperflow/ltx-2: both DECLARE `ref2v` in the sheet, but the REF2VA
///   media matrix is the H3 Director leg (`validate_h3` owns the media law); a non-H3
///   `ref2va` body is a later-leg surface, not a settings surface.
/// * (LEG M14b) the fourteen `music`/`t2m` ace-step exclusions are RETIRED: the
///   door opened the ACE-Step arm, so the seven `t2m`-declaring rows ride the
///   matrix beside YuE2. Every exclusion below carries a still-live stock reason.
/// * `refine`/`upscale` over moss-image: the moss law refuses `refine` and
///   `upscaleModel` outright (jobs.rs:602-615, mirrored at the door by
///   `FAMILY_KEY_REFUSALS`), and both modes cannot run without one of them — pinned by
///   `negative_moss_image_refuses_the_modes_whose_required_keys_it_refuses`.
const COMBO_EXCLUSIONS: [(&str, &str, &str); 7] = [
    ("ref2va", "minimax-h3-hyperflow", "REF2VA media is the H3 Director leg"),
    ("ref2va", "ltx-2", "REF2VA media is the H3 Director leg"),
    ("refine", "moss-image", "moss refuses refine and upscaleModel (jobs.rs:602)"),
    ("upscale", "moss-image", "moss refuses refine and upscaleModel (jobs.rs:602)"),
    ("refine", "minimax-h3", "the H3 image-edit path forbids the refine leg (jobs.rs:658-663)"),
    ("refine", "flux2", "stock-side null: refine over a sigmaNode recipe emits SamplerCustomAdvanced.model=null — pinned by the evidence test below"),
    ("refine", "flux3", "stock-side null: refine over a sigmaNode recipe emits SamplerCustomAdvanced.model=null — pinned by the evidence test below"),
];

/// The matrix, DERIVED not listed: every [`defaults::MODES`] word crossed with every
/// builtin family passing that mode's pipeline gate — the gate words come from
/// [`fill_plane::mode_pipeline_gate`], the MODE_SPECS row itself, so the table cannot
/// drift from the mode table. `refmod` is skipped (E28/LEG AF2-M24c: it is the
/// RefMod export ROW, not a render recipe — its gate is empty-by-design, meaning
/// ungated, which would wrongly cross all 42; its grammar is pinned in
/// `fill_plane::the_refmod_row_fills_the_closed_export_map_not_a_plan`).
fn combo_table() -> Vec<(&'static str, Vec<&'static str>)> {
    let rows = defaults::builtin_view()
        .as_array()
        .expect("the builtin sheet is an array");
    defaults::MODES
        .iter()
        .filter(|mode| **mode != "refmod")
        .map(|mode| {
            let gate =
                fill_plane::mode_pipeline_gate(mode).expect("every MODES word has a spec row");
            let families = rows
                .iter()
                .filter_map(|row| row["id"].as_str())
                .filter(|family| {
                    !COMBO_EXCLUSIONS
                        .iter()
                        .any(|(m, f, _)| m == mode && f == family)
                })
                .filter(|family| {
                    defaults::builtin_pipelines(family)
                        .iter()
                        .any(|word| gate.contains(&word.as_str()))
                })
                .collect();
            (*mode, families)
        })
        .collect()
}

/* ------------------------------------ the bodies ------------------------------------ */

/// The split-loader recipe the diffusion families need, built from the sheet's own
/// `clipType` word with grammar-legal component names (compile checks the grammar;
/// the backend's object_info wall is the prereq layer, a window proof by M11a law).
fn split_diffusion(family: &str) -> Value {
    json!({
        "textEncoder": format!("{family}/encoder.safetensors"),
        "clipType": family_row(family)["clipType"],
        "vae": format!("{family}/vae.safetensors"),
    })
}

/// One image-arm body: explicit family + checkpoint (+ split recipe when the loader
/// law demands it), the mode's leg keys, no resolution dials unless `dials` carries
/// them — so the minimal form rides the ladder's stock-tier defaults by construction.
fn image_body(mode: &str, family: &str, dials: Value) -> Value {
    let (width, height) = default_edges(family);
    let mut body = json!({
        "family": family, "mode": mode,
        "checkpoint": format!("{family}/model.safetensors"),
        "positivePrompt": "a cat", "outputPrefix": "agent/m13", "seed": 123,
        "dials": dials,
    });
    if defaults::builtin_loader(family) == Some("diffusion") {
        body["diffusion"] = split_diffusion(family);
    }
    match mode {
        "i2i" | "inpaint" | "upscale" => {
            body["inputImage"] = json!("deas-inputs/in.png");
            body["dials"]["denoise"] = json!(0.6);
            if family == "minimax-h3" {
                // Stock pairs the minimax encoder with h3Edit exactly (jobs.rs:644:
                // `h3_family != h3.is_some()` refuses either half of the pairing).
                body["h3Edit"] = json!({"shiftVideo": 10, "shiftAudio": 3});
            }
        }
        _ => {}
    }
    if mode == "inpaint" {
        body["inputMask"] = json!("deas-masks/2f1e9d4c-7b3a-4e5f-9c8d-1a2b3c4d5e6f.png");
        body["dials"]["denoise"] = json!(1.0);
    }
    if mode == "upscale" {
        // inputResize + padding must equal the output edges (jobs.rs:900), so the
        // canvas dial pair and the resize block move together.
        body["inputResize"] = json!({"width": 1536, "height": 1152, "crop": "disabled"});
        body["upscaleModel"] = json!("upscale/2x.safetensors");
        body["dials"]["width"] = json!(1536);
        body["dials"]["height"] = json!(1152);
    }
    if mode == "refine" {
        body["refine"] = json!({"width": width, "height": height, "denoise": 0.35});
    }
    body
}

/// The H3 mode word a video-mode body carries (mirrors `fill_plane`'s arm: `v2v` on
/// H3 rides the I2VA reference form, exactly as the M11a matrix cell proved).
fn h3_mode_word(mode: &str) -> &'static str {
    match mode {
        "t2v" | "ref2va" => "T2VA",
        _ => "I2VA",
    }
}

/// One video-arm body for any of the four recipe families.
fn video_body(mode: &str, family: &str) -> Value {
    let mut body = json!({
        "family": family, "mode": mode,
        "checkpoint": format!("{family}/model.safetensors"),
        "positivePrompt": "a fox", "outputPrefix": "agent/m13", "seed": 7,
    });
    match family {
        "minimax-h3" | "minimax-h3-hyperflow" => {
            body["diffusion"] = h3_diffusion();
            if mode == "ref2va" {
                body["picture1"] = json!("deas-inputs/a.png");
                body["h3"] = json!({"audioVae": "MiniMaxH3/audio_vae.safetensors", "shiftVideo": 10, "shiftAudio": 3});
            } else {
                body["h3"] = h3_block(h3_mode_word(mode));
                if mode != "t2v" {
                    body["images"] = json!(["deas-inputs/a.png"]);
                }
            }
        }
        "ltx-2" => {
            body["diffusion"] = ltx_diffusion();
            body["ltx"] = json!({"textProjection": "LTX2/proj.safetensors", "audioVae": "LTX2/audio_vae.safetensors", "passes": 1});
            if mode == "i2v" {
                body["firstFrame"] = json!("deas-inputs/a.png");
            }
            if mode == "v2v" {
                body["sourceVideo"] = json!("deas-input-clip.mp4");
                body["ltx"]["sourceStrength"] = json!(0.6);
            }
        }
        "wan" => {
            // wan declares a full components map, but the explicit-family body must
            // still carry the split recipe (the model-reference resolution is the
            // other door path, exercised in the M11a wan differential).
            body["diffusion"] = json!({"textEncoder": "wan/encoder.safetensors", "clipType": "wan", "vae": "wan/vae.safetensors"});
            body["wan"] = json!({"lowModel": "WAN22/low.safetensors", "shiftHigh": 5, "shiftLow": 5, "refinerStep": 2});
            body["firstFrame"] = json!("deas-inputs/a.png");
        }
        other => unreachable!("combo_table gates video modes to the four recipe families: {other}"),
    }
    body
}

/// One music-arm body. YuE2 rides the library reference (the fake index carries
/// `yue/yue2.safetensors`, exactly as the M11a music differentials). An ACE-Step
/// family (LEG M14b) rides the explicit family word plus checkpoint, and a
/// `loader: "diffusion"` row additionally the exact 3-key split triple — NO
/// `clipType` (the DualCLIPLoader's `"ace"` type is compiler-side). Unasked
/// values — the `ace{}` block, the profile-tier dials and the grid-snapped
/// duration seed — ride the door's stock-mirror floors: proving THOSE land is
/// what the settings truth is for.
fn music_body(mode: &str, family: &str) -> Value {
    if family == "yue2" {
        return json!({
            "model": "yue/yue2.safetensors", "mode": mode,
            "positivePrompt": "English, indie pop", "outputPrefix": "agent/m13",
            "seed": 42, "maxDuration": 120.0,
        });
    }
    let mut body = json!({
        "family": family, "mode": mode,
        "checkpoint": format!("{family}/model.safetensors"),
        "positivePrompt": "English, indie pop", "outputPrefix": "agent/m13",
        "seed": 42,
    });
    if defaults::builtin_loader(family) == Some("diffusion") {
        body["diffusion"] = json!({
            "textEncoder": format!("{family}/enc1.safetensors"),
            "textEncoder2": format!("{family}/enc2.safetensors"),
            "vae": format!("{family}/vae.safetensors"),
        });
    }
    body
}

/// The all-keys `output` block the stock law demands when the block is present at all
/// (`valid_output` requires every key; the absent case rides `effective_output`).
fn output_block(codec: &str, quality: u64) -> Value {
    json!({
        "codec": codec, "container": "Auto", "bitDepth": "Auto", "quality": quality,
        "audioCodec": "Auto", "audioBitrate": "192k",
        "saveFirstFrame": false, "saveLastFrame": false,
    })
}

/// A raw stock video intent (bypasses fill entirely — the second wall's input). The
/// grid and output gates live inside `validate`, which `compile` calls, so the grid
/// refusal fires before any family-block compile.
fn raw_video(family: &str, mutate: &[(&str, Value)]) -> Value {
    let (frames, block) = match family {
        "wan" => (
            81,
            json!({"lowModel": "WAN22/low.safetensors", "shiftHigh": 5, "shiftLow": 5, "refinerStep": 2}),
        ),
        "ltx-2" => (
            121,
            json!({"textProjection": "LTX2/proj.safetensors", "audioVae": "LTX2/audio_vae.safetensors", "passes": 1}),
        ),
        _ => (
            124,
            json!({"mode": "T2VA", "audioVae": "MiniMaxH3/audio_vae.safetensors", "shiftVideo": 10, "shiftAudio": 3}),
        ),
    };
    let (width, height) = default_edges(family);
    let mut intent = json!({
        "recipeId": "video-generation", "version": 1, "family": family,
        "positivePrompt": "a fox", "negativePrompt": "",
        "model": format!("{family}/model.safetensors"),
        "textEncoder": format!("{family}/encoder.safetensors"),
        "vae": format!("{family}/vae.safetensors"),
        "seed": 7, "width": width, "height": height, "frames": frames, "frameRate": 24,
        "steps": 4, "cfg": 1, "sampler": "euler", "scheduler": "simple",
        "outputPrefix": "agent/m13",
    });
    match family {
        "wan" => intent["wan"] = block,
        "ltx-2" => intent["ltx"] = block,
        _ => intent["h3"] = block,
    }
    for (key, value) in mutate {
        intent[key] = value.clone();
    }
    intent
}

/* ------------------------------- the graph-side probes ------------------------------ */

/// Every node carrying numeric `width`/`height` INPUTS — the graph-side carriers of
/// resolution. The assertion reads the compiled graph, never the intent.
fn canvas_nodes(graph: &Value) -> Vec<(String, u64, u64)> {
    graph
        .as_object()
        .expect("a graph object")
        .values()
        .filter_map(|node| {
            let class = node["class_type"].as_str()?.to_owned();
            let width = node["inputs"]["width"].as_u64()?;
            let height = node["inputs"]["height"].as_u64()?;
            Some((class, width, height))
        })
        .collect()
}

fn first_node_of_class<'a>(graph: &'a Value, class: &str) -> Option<&'a Value> {
    graph
        .as_object()
        .expect("a graph object")
        .values()
        .find(|node| node["class_type"] == class)
}
fn class_count(graph: &Value, class: &str) -> usize {
    graph
        .as_object()
        .expect("a graph object")
        .values()
        .filter(|node| node["class_type"] == class)
        .count()
}

/// True when the number rides as an input VALUE anywhere in the graph (video graphs
/// build their latent inside recipe nodes, so the value check is the honest seam).
fn graph_carries_value(graph: &Value, value: u64) -> bool {
    graph
        .as_object()
        .expect("a graph object")
        .values()
        .any(|node| {
            node["inputs"]
                .as_object()
                .expect("node inputs")
                .values()
                .any(|input| input.as_u64() == Some(value))
        })
}

/// The image-arm settings truth of one compiled graph. Canvas carriers: t2i/refine/
/// upscale graphs hold numeric `width`/`height` inputs (EmptyLatentImage, the refine
/// pass node, the ImageScale leg); pure i2i/inpaint graphs swap the latent for
/// LoadImage → VAEEncode (jobs.rs:487, :1127) and carry NO numeric canvas node —
/// that absence is the stock shape, so `requires_canvas` names which law applies.
/// The compile-seam saver is the plain `SaveImage`; no video/music output node exists
/// where it is not applicable.
fn assert_image_graph_settings(
    graph: &Value,
    width: u64,
    height: u64,
    requires_canvas: bool,
    savers: usize,
    label: &str,
) {
    let canvas = canvas_nodes(graph);
    if requires_canvas {
        assert!(
            !canvas.is_empty() && canvas.iter().all(|(_, w, h)| *w == width && *h == height),
            "'{label}': canvas nodes drifted from {width}x{height}: {canvas:?}"
        );
    } else {
        assert!(
            canvas.is_empty() || canvas.iter().all(|(_, w, h)| *w == width && *h == height),
            "'{label}': an i2i-family graph may carry no canvas node (VAEEncode latent) or the exact edges: {canvas:?}"
        );
    }
    assert_eq!(
        class_count(graph, "SaveImage"),
        savers,
        "'{label}': the compile-seam graph keeps the plain SaveImage saver per output leg (refine runs two): {}",
        super::intent_truth::shape(graph)
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ")
    );
    assert_eq!(
        class_count(graph, "DaSiWa_EnhancedVideoCombine"),
        0,
        "'{label}': an image graph must not grow the video combine node"
    );
    assert_eq!(
        class_count(graph, "SaveAudioAdvanced"),
        0,
        "'{label}': an image graph must not grow the audio saver"
    );
}

/* -------------------------------------- P1: defaults --------------------------------- */

#[tokio::test]
async fn p1_minimal_image_bodies_land_the_ladder_default_edges_in_the_graph() {
    let kit = Kit::new();
    // Checkpoint loader, split loader, 512-default and 2048-default families: the
    // minimal body carries NO resolution dial, so the graph must carry the sheet's
    // stock-tier edges as node INPUT VALUES.
    for family in ["sdxl", "anima", "sd15", "qwen-image-2.1"] {
        let (width, height) = default_edges(family);
        let ours = fill_intent(&kit, &image_body("t2i", family, json!({}))).await;
        assert_eq!(
            ours["imageFormat"], "png",
            "'{family}': the format floor rides the intent"
        );
        assert_eq!(ours["imageCompression"], 44, "'{family}': the compression floor rides the intent RAW (the saver maps 0..=100 at runtime — jobs.rs:1594)");
        let graph = stock_compile(&ours);
        assert_image_graph_settings(&graph, width, height, true, 1, &format!("p1/{family}"));
    }
}

#[tokio::test]
async fn p1_minimal_video_bodies_land_the_default_canvas_and_the_combine_defaults() {
    let kit = Kit::new();
    for family in ["minimax-h3", "minimax-h3-hyperflow", "ltx-2", "wan"] {
        let (width, height) = default_edges(family);
        let mode = if family == "wan" { "i2v" } else { "t2v" };
        let ours = fill_intent(&kit, &video_body(mode, family)).await;
        assert!(
            ours.get("output").is_none(),
            "'{family}': the minimal body sends no output block; stock fills it at compile"
        );
        let graph = stock_compile(&ours);
        assert!(
            graph_carries_value(&graph, width) && graph_carries_value(&graph, height),
            "'{family}': the default canvas {width}x{height} did not ride into the graph"
        );
        // The `effective_output` defaults (jobs_video.rs:1785) land as node 7's inputs:
        // codec/container/bitDepth/audioCodec "Auto", quality 20, 192k, saves false.
        let combine = first_node_of_class(&graph, "DaSiWa_EnhancedVideoCombine")
            .expect("the video graph carries the combine node");
        assert_eq!(
            combine["inputs"]["codec"], "Auto",
            "'{family}': the codec default rides the graph input"
        );
        assert_eq!(
            combine["inputs"]["quality"], 20,
            "'{family}': the quality default rides the graph input"
        );
        assert_eq!(combine["inputs"]["container"], "Auto");
        assert_eq!(combine["inputs"]["bit_depth"], "Auto");
        assert_eq!(combine["inputs"]["audio_codec"], "Auto");
        assert_eq!(combine["inputs"]["audio_bitrate"], "192k");
        assert_eq!(combine["inputs"]["save_first_frame"], json!(false));
        assert_eq!(combine["inputs"]["save_last_frame"], json!(false));
    }
}

#[tokio::test]
async fn p1_music_has_no_canvas_and_lands_the_fixed_flac_saver() {
    let kit = Kit::new();
    // A width dial on a music body is ladder-supplied but NEVER emitted: the music key
    // law counts no canvas key (deny_unknown_fields, jobs_music).
    let body = json!({"model":"yue/yue2.safetensors","mode":"t2m","positivePrompt":"p","outputPrefix":"agent/m13","seed":42,"maxDuration":120.0,"dials":{"width":999,"height":999}});
    let ours = fill_intent(&kit, &body).await;
    assert!(
        ours.get("width").is_none() && ours.get("height").is_none(),
        "the music intent counts no canvas key: {ours}"
    );
    let graph = stock_compile(&ours);
    assert!(
        canvas_nodes(&graph).is_empty(),
        "the music graph carries no canvas node"
    );
    let saver = first_node_of_class(&graph, "SaveAudioAdvanced")
        .expect("the music graph carries the audio saver");
    assert_eq!(
        saver["inputs"]["format"], "flac",
        "the music output format is FIXED flac (jobs_music.rs:187), not an intent key"
    );
    assert_eq!(
        class_count(&graph, "DaSiWa_EnhancedVideoCombine"),
        0,
        "no video codec node on a music graph"
    );
    // LEG M14b: the ACE arm's settings carriers. The profile row IS the stock tier
    // (the ACE sheet rows carry no `defaults` block), the profile shift rides the
    // floor `ace{}` block into the patch node, and flac stays fixed — the same
    // SaveAudioAdvanced law on both music arms.
    for (family, steps, cfg, shift) in [
        ("ace-step-1-0", 50, 5.0, 5.0),
        ("ace-step-1-5-turbo", 8, 1.0, 3.0),
    ] {
        let ours = fill_intent(&kit, &music_body("t2m", family)).await;
        assert!(
            ours.get("generation").is_none(),
            "the ACE key law counts no YuE2 generation block: {ours}"
        );
        let graph = stock_compile(&ours);
        assert_eq!(
            graph["S"]["inputs"]["steps"], steps,
            "the profile tier feeds the sampler for '{family}'"
        );
        assert_eq!(
            graph["S"]["inputs"]["cfg"], cfg,
            "the profile cfg rides the ladder for '{family}'"
        );
        let patch = first_node_of_class(
            &graph,
            if family == "ace-step-1-0" {
                "ModelSamplingSD3"
            } else {
                "ModelSamplingAuraFlow"
            },
        )
        .expect("the profile's patch class grows");
        assert_eq!(
            patch["inputs"]["shift"], shift,
            "the profile shift rides the floor ace block into the patch node for '{family}'"
        );
        assert!(
            canvas_nodes(&graph).is_empty(),
            "the ACE music graph counts no canvas either"
        );
        let saver = first_node_of_class(&graph, "SaveAudioAdvanced")
            .expect("the ACE music graph carries the audio saver");
        assert_eq!(
            saver["inputs"]["format"], "flac",
            "flac is fixed for the ACE arm too (jobs_music_ace.rs SaveAudioAdvanced)"
        );
    }
}

/* ----------------------------------- P2: resolution ---------------------------------- */

#[tokio::test]
async fn p2_resolution_partials_land_exact_values_image() {
    let kit = Kit::new();
    // Full pair from the request: the graph inputs carry the EXACT values.
    let body = image_body("t2i", "sdxl", json!({"width": 1536, "height": 640}));
    let graph = stock_compile(&fill_intent(&kit, &body).await);
    assert_image_graph_settings(&graph, 1536, 640, true, 1, "p2/image/pair");
    // The half-override: width-only is LEGAL stock-side (the flat intent is per-field;
    // jobs.rs measures the merged pair, not provenance) — the merged 1536x1024 must
    // land exactly.
    let body = image_body("t2i", "sdxl", json!({"width": 1536}));
    let graph = stock_compile(&fill_intent(&kit, &body).await);
    assert_image_graph_settings(&graph, 1536, 1024, true, 1, "p2/image/half");
}

#[tokio::test]
async fn p2_off_grid_and_oversized_image_canvases_refuse_both_walls() {
    let kit = Kit::new();
    // Off-grid width 511 (not /8): the door refuses naming the field and the law
    // (the LEG M13 `check_image_canvas` home); stock compile refuses the same raw
    // intent (jobs.rs:857 "Invalid diagnostic width"). Both walls are compile-side.
    let body = image_body("t2i", "sdxl", json!({"width": 511, "height": 512}));
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "aligned to 8").await;
    let raw = stock_image_with(&[("width", json!(511))]);
    let stock = crate::jobs::compile(&raw).expect_err("stock refuses the same off-grid width");
    assert!(
        stock.contains("width"),
        "the stock refusal names the field: {stock}"
    );
    // Half-override into off-grid: width 511 merged with the ladder's 1024 is refused
    // too — the merged pair is what the door measures.
    let body = image_body("t2i", "sdxl", json!({"width": 511}));
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "width 511").await;
    // The 16.7M pixel ceiling: 8192x4096 passes the edge law and fails the product.
    let body = image_body("t2i", "sdxl", json!({"width": 8192, "height": 4096}));
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "pixel ceiling").await;
    let raw = stock_image_with(&[("width", json!(8192)), ("height", json!(4096))]);
    let stock = crate::jobs::compile(&raw).expect_err("stock refuses the same pixel product");
    assert!(
        stock.contains("pixel limit"),
        "the stock refusal names the ceiling: {stock}"
    );
}

/// The raised floor (64 -> 8, the latent-grid truth): 8x8 is legal on BOTH walls —
/// the door admits it and stock compile compiles it into an 8x8 latent — while 7
/// (off-grid, under the floor) is refused by both, naming the field and the law.
#[tokio::test]
async fn p2_the_latent_grid_floor_eight_lands_on_both_walls() {
    let kit = Kit::new();
    let body = image_body("t2i", "sdxl", json!({"width": 8, "height": 8}));
    let graph = stock_compile(&fill_intent(&kit, &body).await);
    assert_image_graph_settings(&graph, 8, 8, true, 1, "p2/image/floor");
    let body = image_body("t2i", "sdxl", json!({"width": 7, "height": 8}));
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "width 7").await;
    let raw = stock_image_with(&[("width", json!(7))]);
    let stock = crate::jobs::compile(&raw).expect_err("stock refuses the same under-floor width");
    assert!(
        stock.contains("width"),
        "the stock refusal names the field: {stock}"
    );
    // The compile-side floor moved with the door's: 8 compiles stock-side alone.
    let raw = stock_image_with(&[("width", json!(8)), ("height", json!(8))]);
    crate::jobs::compile(&raw).expect("8x8 compiles through the stock numeric table");
}

#[tokio::test]
async fn p2_video_grid_law_refuses_both_walls_per_family() {
    let kit = Kit::new();
    // ltx-2 /32, wan /16, H3 /32 (jobs_video.rs:185-190; the gate at :1436 is
    // validate-side INSIDE compile — the two-wall probe calls compile with the raw
    // intent; the door mirror is `check_video_ranges`, M9c).
    let mut body = video_body("t2v", "ltx-2");
    body["dials"] = json!({"width": 1000, "height": 704});
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "multiple of 32").await;
    let stock = crate::jobs::compile(&raw_video("ltx-2", &[("width", json!(1000))]))
        .expect_err("stock refuses the same off-grid ltx canvas");
    assert!(stock.contains("multiple of 32"), "{stock}");
    let mut body = video_body("i2v", "wan");
    body["dials"] = json!({"width": 511, "height": 1280});
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "multiple of 16").await;
    let stock = crate::jobs::compile(&raw_video("wan", &[("width", json!(511))]))
        .expect_err("stock refuses the same off-grid wan canvas");
    assert!(stock.contains("multiple of 16"), "{stock}");
    let mut body = video_body("t2v", "minimax-h3");
    body["dials"] = json!({"width": 511, "height": 768});
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "multiple of 32").await;
    let stock = crate::jobs::compile(&raw_video("minimax-h3", &[("width", json!(511))]))
        .expect_err("stock refuses the same off-grid H3 canvas");
    assert!(stock.contains("multiple of 32"), "{stock}");
}

#[tokio::test]
async fn p2_video_resolution_partial_lands_exact_values_half_override_legal() {
    let kit = Kit::new();
    // Width-only over H3 (1344 is /32): merged with the ladder's 768, the pair passes
    // both walls and the requested edge rides the graph as an input VALUE.
    let mut body = video_body("t2v", "minimax-h3");
    body["dials"] = json!({"width": 1344});
    let ours = fill_intent(&kit, &body).await;
    assert_eq!(ours["width"], 1344, "the request edge wins the ladder");
    assert_eq!(
        ours["height"], 768,
        "the ladder edge completes the pair (legal half-override)"
    );
    let graph = stock_compile(&ours);
    assert!(
        graph_carries_value(&graph, 1344) && graph_carries_value(&graph, 768),
        "the merged 1344x768 did not ride the graph"
    );
}

/* ------------------------------------- P3: output ------------------------------------ */

#[tokio::test]
async fn p3_image_webp_and_compression_ride_the_stock_key_law() {
    let kit = Kit::new();
    // The differential: the closest agent envelope vs a raw stock intent carrying the
    // same output keys. At the COMPILE seam the saver node stays `SaveImage` on BOTH
    // sides — the swap to DaSiWa_MetadataImageSaver (file_format/compression inputs)
    // is prepare-side, gated on the backend's object_info (jobs.rs:1867; stock's own
    // graph-level evidence: jobs_tests.rs:2923-2929, :3067-3084). The graph-level
    // truth this seam can assert: the shape is IDENTICAL to stock's webp graph, and
    // the filled intent carries the values raw.
    let mut body = image_body("t2i", "sdxl", json!({"imageFormat": "webp"}));
    body["imageCompression"] = json!(87);
    let ours = fill_intent(&kit, &body).await;
    assert_eq!(ours["imageFormat"], "webp");
    assert_eq!(
        ours["imageCompression"], 87,
        "the raw 0..=100 number rides; the WebP/PNG mapping is runtime Python (jobs.rs:1594)"
    );
    let stock_side = stock_image_with(&[
        ("imageFormat", json!("webp")),
        ("imageCompression", json!(87)),
    ]);
    let ours_graph = stock_compile(&ours);
    let stock_graph = stock_fixture_compile(&stock_side, "p3/image/webp");
    assert_shapes(&ours_graph, &stock_graph, "p3/image/webp");
    assert_eq!(
        class_count(&ours_graph, "SaveImage"),
        1,
        "compile keeps the plain saver; the DaSiWa swap is prepare-side"
    );
    // The edges: 0 and 100 are legal and land; png + 44 is the floor pair.
    for compression in [0, 100] {
        let mut body = image_body("t2i", "sdxl", json!({"imageFormat": "webp"}));
        body["imageCompression"] = json!(compression);
        let ours = fill_intent(&kit, &body).await;
        assert_eq!(ours["imageCompression"], compression);
        stock_compile(&ours);
    }
    let png = image_body("t2i", "sdxl", json!({"imageFormat": "png"}));
    let ours = fill_intent(&kit, &png).await;
    assert_eq!(ours["imageFormat"], "png");
    assert_eq!(ours["imageCompression"], 44, "png+44 lands as the RAW pair — stock compile writes it verbatim into the saver input (jobs.rs:1596); the 44 -> PNG level 4 mapping is the runtime saver's");
    stock_compile(&ours);
}

#[tokio::test]
async fn p3_every_video_codec_word_and_the_quality_bounds_land_in_the_combine_node() {
    let kit = Kit::new();
    for codec in crate::jobs_video::CODECS {
        let mut body = video_body("t2v", "minimax-h3");
        body["output"] = output_block(codec, 20);
        let graph = stock_compile(&fill_intent(&kit, &body).await);
        let combine =
            first_node_of_class(&graph, "DaSiWa_EnhancedVideoCombine").expect("the combine node");
        assert_eq!(
            combine["inputs"]["codec"], codec,
            "codec '{codec}' must ride the graph input verbatim"
        );
    }
    for quality in [0, 51] {
        let mut body = video_body("t2v", "minimax-h3");
        body["output"] = output_block("AV1", quality);
        let graph = stock_compile(&fill_intent(&kit, &body).await);
        let combine =
            first_node_of_class(&graph, "DaSiWa_EnhancedVideoCombine").expect("the combine node");
        assert_eq!(combine["inputs"]["codec"], "AV1");
        assert_eq!(
            combine["inputs"]["quality"], quality,
            "quality {quality} must ride the graph input"
        );
    }
}

/* ------------------------------------- the negatives --------------------------------- */

#[tokio::test]
async fn negative_image_format_outside_png_webp_refuses_both_walls() {
    let kit = Kit::new();
    let body = image_body("t2i", "sdxl", json!({"imageFormat": "jpg"}));
    let hint = door_refusal(&kit, &body, ErrorKind::BodyInvalid, "png or webp").await;
    assert!(
        hint.contains("imageFormat"),
        "the refusal names the key: {hint}"
    );
    let raw = stock_image_with(&[("imageFormat", json!("jpg"))]);
    let stock = crate::jobs::compile(&raw).expect_err("stock refuses the same format word");
    assert!(stock.contains("imageFormat"), "{stock}");
}

#[tokio::test]
async fn negative_image_compression_outside_the_domain_refuses_both_walls() {
    let kit = Kit::new();
    let mut body = image_body("t2i", "sdxl", json!({}));
    body["imageCompression"] = json!(101);
    door_refusal(&kit, &body, ErrorKind::BodyInvalid, "imageCompression").await;
    let raw = stock_image_with(&[("imageCompression", json!(101))]);
    let stock = crate::jobs::compile(&raw).expect_err("stock refuses the same compression");
    assert!(stock.contains("imageCompression"), "{stock}");
}

#[tokio::test]
async fn negative_video_codec_outside_the_closed_list_refuses_both_walls() {
    let kit = Kit::new();
    let mut body = video_body("t2v", "minimax-h3");
    body["output"] = output_block("H.999", 20);
    let hint = door_refusal(&kit, &body, ErrorKind::BodyInvalid, "codec").await;
    assert!(
        hint.contains("H.264"),
        "the refusal names the closed list: {hint}"
    );
    let raw = raw_video("minimax-h3", &[("output", output_block("H.999", 20))]);
    let stock = crate::jobs::compile(&raw).expect_err("stock refuses the same codec word");
    assert!(
        stock.contains("output"),
        "the stock refusal is the output law (jobs_video.rs:1477): {stock}"
    );
}

#[tokio::test]
async fn negative_video_quality_outside_the_domain_refuses_both_walls() {
    let kit = Kit::new();
    for quality in [52, 100] {
        let mut body = video_body("t2v", "minimax-h3");
        body["output"] = output_block("AV1", quality);
        door_refusal(&kit, &body, ErrorKind::BodyInvalid, "quality 0..=51").await;
        let raw = raw_video("minimax-h3", &[("output", output_block("AV1", quality))]);
        let stock = crate::jobs::compile(&raw).expect_err("stock refuses the same quality");
        assert!(stock.contains("output"), "{stock}");
    }
}

#[tokio::test]
async fn negative_partial_video_output_block_refuses_both_walls_the_block_is_all_keys_or_absent() {
    let kit = Kit::new();
    // Stock's law: `valid_output` requires every key (jobs_video.rs:209-234 via :1477),
    // so a lone {codec} is refused; the absent block rides effective_output's defaults.
    let mut body = video_body("t2v", "minimax-h3");
    body["output"] = json!({"codec": "AV1"});
    door_refusal(
        &kit,
        &body,
        ErrorKind::BodyInvalid,
        "every required key present",
    )
    .await;
    let raw = raw_video("minimax-h3", &[("output", json!({"codec": "AV1"}))]);
    let stock = crate::jobs::compile(&raw).expect_err("stock refuses the partial block");
    assert!(stock.contains("output"), "{stock}");
}

#[tokio::test]
async fn negative_moss_image_refuses_the_modes_whose_required_keys_it_refuses() {
    let kit = Kit::new();
    // The two matrix exclusions with a reachable refusal: moss-image refuses `refine`
    // and `upscaleModel` (the family law, jobs.rs:602-615, mirrored at the door), and
    // those modes cannot run without one of them.
    let body = image_body("refine", "moss-image", json!({}));
    door_refusal(&kit, &body, ErrorKind::ModeUnsupported, "refine").await;
    let body = image_body("upscale", "moss-image", json!({}));
    door_refusal(&kit, &body, ErrorKind::ModeUnsupported, "upscaleModel").await;
}

/* ----------------------------------- P4: the matrix ---------------------------------- */

#[tokio::test]
async fn p4_combo_matrix_every_supported_mode_family_cell_lands_its_settings_carriers() {
    let kit = Kit::new();
    let table = combo_table();
    let cells: usize = table.iter().map(|(_, families)| families.len()).sum();
    // Derived at the 2026-11-21 sheet AFTER LEG M14b opened the ACE-Step music
    // leg: t2i 26, i2i 26, inpaint 26, refine 23 (union gate 27 minus moss, h3,
    // flux2, flux3), upscale 25 (minus moss), ref2va 1, video 4, music 8 (YuE2 +
    // the seven ace-step rows), t2v 3, i2v 4, v2v 2, t2m 8 (same), refmod 0
    // (the export row, not a render cell — see `combo_table`) = 156 cells — the M13-era 142 plus the 14 ace-step cells M14a
    // scoped — 12 mode words, every exclusion carrying a stated stock reason, and
    // the two stock-side ones pinned by the evidence test below.
    assert_eq!(
        cells, 156,
        "the derived matrix size drifted from the sheet: {table:?}"
    );
    for (mode, families) in table {
        for family in families {
            let label = format!("{mode}/{family}");
            let body = match mode {
                "ref2va" | "video" | "t2v" | "i2v" | "v2v" => video_body(mode, family),
                "music" | "t2m" => music_body(mode, family),
                _ => image_body(mode, family, json!({})),
            };
            let ours = fill_intent(&kit, &body).await;
            let graph = stock_compile(&ours);
            let (empties, nulls) = value_holes(&graph);
            let _ = empties; // bounded by the M11a differentials; this matrix pins nulls
            assert!(
                nulls.is_empty(),
                "cell '{label}' left null inputs: {nulls:?}"
            );
            match mode {
                "ref2va" | "video" | "t2v" | "i2v" | "v2v" => {
                    let combine = first_node_of_class(&graph, "DaSiWa_EnhancedVideoCombine")
                        .unwrap_or_else(|| {
                            panic!("cell '{label}': no codec-carrier node in the video graph")
                        });
                    assert_eq!(
                        combine["inputs"]["codec"], "Auto",
                        "cell '{label}': the codec default must ride"
                    );
                    assert_eq!(
                        combine["inputs"]["quality"], 20,
                        "cell '{label}': the quality default must ride"
                    );
                    let (width, height) = default_edges(family);
                    assert!(graph_carries_value(&graph, width) && graph_carries_value(&graph, height), "cell '{label}': the default canvas {width}x{height} did not ride the graph");
                }
                "music" | "t2m" => {
                    let saver =
                        first_node_of_class(&graph, "SaveAudioAdvanced").unwrap_or_else(|| {
                            panic!("cell '{label}': no audio saver in the music graph")
                        });
                    assert_eq!(
                        saver["inputs"]["format"], "flac",
                        "cell '{label}': the fixed flac format must ride"
                    );
                    assert!(
                        canvas_nodes(&graph).is_empty(),
                        "cell '{label}': the music graph counts no canvas"
                    );
                }
                _ => {
                    let expected = if mode == "upscale" {
                        (1536, 1152)
                    } else {
                        default_edges(family)
                    };
                    let requires_canvas = !matches!(mode, "i2i" | "inpaint");
                    // The refine pass legs two output savers ("7" original + "B7"
                    // final, jobs.rs:1598); every other image mode legs one.
                    let savers = usize::from(mode == "refine") + 1;
                    assert_image_graph_settings(
                        &graph,
                        expected.0,
                        expected.1,
                        requires_canvas,
                        savers,
                        &label,
                    );
                }
            }
        }
    }
}

#[tokio::test]
async fn stock_side_evidence_refine_over_a_sigma_node_recipe_carries_the_null_model_stock_owns() {
    // Raw STOCK intent (bypasses fill entirely): flux2 family + refine leg. STOCK
    // itself emits `SamplerCustomAdvanced.model = null` for the sigmaNode recipes
    // (flux2/flux3 declare Flux2Scheduler in builtin.json) — the hole is stock-side,
    // reproducible with the Workbench's own shape, and the two refine matrix
    // exclusions above stand on this pin, not on a dodge.
    let raw = json!({"recipeId":"checkpoint-text-to-image-diagnostic","version":1,
        "positivePrompt":"p","negativePrompt":"","checkpoint":"flux2/model.safetensors",
        "diffusion":{"textEncoder":"flux2/encoder.safetensors","clipType":"flux2","vae":"flux2/vae.safetensors"},
        "family":"flux2","seed":123,"width":1024,"height":1024,"steps":20,"cfg":3.5,
        "sampler":"euler","scheduler":"normal","outputPrefix":"agent/m13",
        "refine":{"width":1024,"height":1024,"denoise":0.35}});
    let graph = crate::jobs::compile(&raw).expect("stock compiles it");
    let (empties, nulls) = value_holes(&graph);
    assert_eq!(
        nulls,
        vec!["SamplerCustomAdvanced.model".to_owned()],
        "the stock-side refine/sigmaNode hole must stay exactly as pinned (if stock fixes it, the matrix exclusion must be revisited): empties {empties:?}"
    );
}
