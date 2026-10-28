# YuE2 music pipelines — implementation plan

**Status: planned, not implemented.** Owner request. This repository document is the durable implementation handoff linked from [the consolidated plan](IMPLEMENTATION-STATUS.md#planned-yue2-music-generation-and-covers).

> **For Hermes:** Implement task-by-task with the `deas-development`, `test-driven-development` and Ponytail skills; use isolated subagents for independent review, not concurrent writers of Workbench.tsx. Load the subagent-development workflow if available. This document authorizes no implementation, commit, download, service operation or publication.

**Goal:** Add DEAS-owned YuE2 Text to Music and Cover Music workflows, with independent Style/Lyrics editors and writers, template-correct ABC planning, audio/video cover input, and playable retained audio results.

**Architecture:** Add a small native `jobs_music.rs` recipe beside `jobs_video.rs`, then route it through the existing immutable Workbench job lifecycle. Reuse the installed core YuE2, SheetSage2, LoadAudio, audio decode/save nodes and existing Prompt Writer UI; keep music authoring separate from image/video drafts. Extend existing media/output/history seams rather than introducing another scheduler, service, plugin system or frontend graph compiler.

**Tech stack:** Rust 2021/Tauri 2, serde_json, React 19/TypeScript, existing Node tests/Vitest/Cargo tests, installed ComfyUI core and optional DaSiWa Prompt Writer routes.

---

## 1. Context, evidence and assumptions

### Workspace and safety

- Target repository: DEAS. Paths in tasks are repository-relative unless explicitly marked as installed reference sources. This plan was added to repository documentation at the owner's request; it does not authorize implementation.
- Planning inspection was read-only. No tests, model generation or GPU probes ran. No dependency or model was downloaded.
- The target working tree is **already dirty**, including `Workbench.tsx`, `Workbench.test.tsx`, `PromptOverlay.tsx`, `QuickSettings.tsx`, `model_families.rs`, `jobs.rs`, locales, documentation and version files. New untracked `PromptTextarea.tsx` and its tests are present. These are other work, not a clean baseline to replace.
- Read `AGENTS.md`, `docs/PROJECT-RULES.md`, `docs/COMFYUI-RULES.md`, `docs/EXECUTION-CONTRACT.md`, `docs/PRODUCT-DECISIONS.md` and `docs/IMPLEMENTATION-STATUS.md` before execution. Re-read files immediately before editing; line numbers below describe the inspected snapshot, not permanent patch coordinates.
- Future implementation must preserve unrelated changes. Do not stash, reset, format entire unrelated modules, stage `-A`, push, restart the live backend or download model weights. Commit checkpoints below are **conditional on explicit commit authorization**; absent that authorization, report the same checkpoints as tested changes without creating commits.
- Commands below run from `/data/GitHub/DEAS` in fish unless explicitly Python. Expected outputs are **future acceptance conditions**, not observed test results. Compile/test commands write build artifacts and are for the implementation turn only.

### Verified reference sources

Installed ComfyUI revision: `b1a247c9cf9dbfda4b2c0a0c1d50950667eeaa0c`.
Installed `comfyui-workflow-templates` version: `0.11.89`.

Read these exact files; do not infer node APIs from template titles:

```
/data/GitHub/ComfyUI/venv/lib/python3.12/site-packages/comfyui_workflow_templates_json/templates/audio_yue2_text2music.json
/data/GitHub/ComfyUI/venv/lib/python3.12/site-packages/comfyui_workflow_templates_json/templates/audio_yue2_music_cover.json
/data/GitHub/ComfyUI/comfy_extras/nodes_yue2.py
/data/GitHub/ComfyUI/comfy_extras/nodes_audio_encoder.py
/data/GitHub/ComfyUI/comfy_extras/nodes_audio.py
/data/GitHub/ComfyUI/comfy_api/latest/_io.py
/data/GitHub/ComfyUI-DaSiWa-Nodes/nodes/nodes_llm_simple.py
/data/GitHub/ComfyUI-DaSiWa-Nodes/data/llm_skills/yue2_style.md
/data/GitHub/ComfyUI-DaSiWa-Nodes/data/llm_skills/yue2_lyrics.md
```

Findings that determine implementation:

1. YuE2 is a **checkpoint** loaded by `CheckpointLoaderSimple`; it supplies MODEL, CLIP and VAE. Do not expose separate text encoder/VAE pickers for this recipe.
2. `YuE2GenerateABC(clip, style, lyrics, seed, mode, ...)` supports `full` and `melody`.
3. `YuE2GenerateMusic` accepts **style and lyrics**, not positive/negative text. Its `seconds` output must drive `EmptyYuE2LatentAudio.seconds`; requested maximum duration is not an exact generated length.
4. ABC Off is compiled as `abc: ""`, **not** `mode: "off"`. The node internally selects off mode for empty ABC. Its public mode combo still accepts only `full|melody`.
5. Cover uses `AudioEncoderLoader` with `sheetsage2_bf16.safetensors`, then `SheetSage2AudioToABC(mode="melody")`, then `YuE2GenerateMusic(mode="melody")`. SheetSage2's ABC output is a **list**; retain ComfyUI's normal list mapping. Do not invent `[0]` extraction or concatenate distinct songs.
6. `LoadAudio` explicitly lists audio **and video** files. `nodes_audio.load()` opens the first audio stream with PyAV and errors for no stream/no decoded frames. Thus video cover input can use the **same LoadAudio node**, without native FFmpeg extraction or LoadVideo/image decode.
7. The template sampler is 32 steps, CFG 1, `dpm_2`, `sgm_uniform`, denoise 1. The negative conditioning socket is connected to `ConditioningZeroOut(positive)`; it is **not** a negative prompt field. Preserve this internal socket even though music has no negative text.
8. `SaveAudioAdvanced` uses a V3 DynamicCombo. API graph input is `format: "flac"`; runtime packs this into the execute method's dict. Do not put `{"format":"flac"}` directly into the API graph. Confirm through real prompt validation before relying on it.
9. Existing writer dialect names are exactly `YuE2 Song Style` and `YuE2 Lyrics` in both reference checkout and installed node-pack source. They are not `YuE2 Style`, `yue2`, or generic image writers.
10. An existing checkpoint was inspected **header-only** at `/data/GitHub/AI-Ressources/models/checkpoint/yue2_3b_int8_convrot.safetensors`. Metadata includes `source=m-a-p/YuE2-3B`, `yue2_format=1`, `license=CC-BY-NC-4.0`. Keys include `model.diffusion_model.llm2vae.weight` shape `[64,2048]` and `text_encoders.model.embed_tokens.weight` shape `[184704,2048]`. Do not load tensor payloads during discovery or hardcode this host path in production.

### Existing DEAS seams

| Concern | Exact source | Current limitation / required reach |
|---|---|---|
| Family registry | `src/families/builtin.json` | No YuE2 entry; shared by frontend and native header detection |
| Header detection | `src-tauri/src/model_families.rs` | Uses normalized header signatures; test actual normalized prefix rules |
| Recipe compilation | `src-tauri/src/jobs.rs:218`, `src-tauri/src/jobs_video.rs` | Image unless `is_video`; music must dispatch **before** image assumptions |
| Preparation | `src-tauri/src/jobs.rs:1213-1335` | Image saver substitution unless video; image-model unwrap otherwise |
| Prerequisites | `src-tauri/src/recipe_prerequisites.rs:150-178`, `src/lib/recipePrerequisites.ts` | Missing music nodes/audio encoder choices; V3 choices need `options()` |
| Upload | `src/lib/jobs.ts:86`, `src-tauri/src/jobs.rs:1972-2007` | Already accepts audio/video, bounds at 512 MiB and uploads via classic multipart route |
| Job intent | `src/lib/jobs.ts:6` | Image/video union only |
| Authoring | `src/features/studio/Workbench.tsx` | Six pipeline IDs, image/video branch, positive/negative prefs; source selection and async snapshot ownership already exist |
| Editors | `src/features/studio/PromptTextarea.tsx`, `PromptOverlay.tsx` | Reuse current editing/spelling/translation behavior; do not revert concurrent prompt tools |
| Writers | `src/features/forge/ForgeButton.tsx`, `src/lib/forge.ts`, `src-tauri/src/llm.rs` | Existing non-native writer route accepts explicit dialect; verify backend allowlist/error handling |
| History outputs | `src-tauri/src/jobs.rs:1614-1663` | Reads only `images` and `gifs`, hardcoded saver ID `7` |
| Retained output transport | `src-tauri/src/jobs_outputs.rs` | PNG-only cache/decode/export; must not send FLAC through PNG decoder |
| Main preview | `src/features/studio/Workbench.tsx:1032-1033` | Existing output classification recognizes audio, renderer still falls through to `<img>` |
| Fallback preview | `src/features/studio/JobOutputPreview.tsx` | Always `<img>`, PNG-only native transport |
| Run Plan | `src/features/studio/RunPlan.tsx` | Anything not video is assumed image |
| Metadata | `src/features/studio/GenerationMetadata.tsx` | Anything not video is assumed image |
| History restore | `src/features/studio/history.ts`, `Workbench.tsx:878` | Image/video projection only; original input identities intentionally unresolved |
| Persistent history | `src-tauri/src/jobs_history.rs` | Re-validates through compiler; do not force music through image effective defaults |
| Project drafts | `src/lib/projects.ts`, `Workbench.tsx:911-915` | Image-only; never serialize music as an image project |
| User docs/locales | `docs/STUDIO.md`, six `src/features/studio/locales/*.json` | New controls and limitations need documentation/localization |

### Product decisions for this bounded implementation

- Add stable pipeline IDs **`t2m`** and **`cover`**, displayed in English as **Music (Text to Music)** and **Music (Cover Music)**. German: **Musik (Text zu Musik)** and **Musik (Cover)**.
- Exactly **two primary prompt boxes**: **Style** and **Lyrics**. Both retain copy, clear, expand and the existing PromptTextarea tools; both have a Forge hammer using their corresponding writer. No negative editor, wildcard/image reference controls or inferred image canvas in music mode.
- Separate persisted music fields: `studio.run.music.style`, `.lyrics`, `.planning`, `.maxDuration`, `.audioEncoder`, `.abc`, `.generation`. Do not relabel image `negative` as lyrics or share music/image text state. Preserve values through pipeline switching and Run Plan navigation.
- Text-to-music defaults: ABC Planning enabled, Full, maximum duration **120 seconds** (outer template value), seed from existing safe-integer seed control. Planning Off and Melody are explicit choices. Music AR and ABC advanced settings are separate collapsible groups with values below.
- Cover defaults: melody-only, maximum duration **360 seconds**, one explicitly selected audio or video source; SheetSage encoder picker shown only for cover. Source remains separate from image editing/continuity. No automatic lyric transcription, no automatic source-language detection and no voice-cloning promise.
- Output: **FLAC only** in this slice, as in both templates. No codec/container matrix or WAV/MP3 options. Music output is a new result, never replaces source audio/video or remuxes the video.
- Allow empty Lyrics for instrumental intent; do not require vocal lyrics or generate invented words. Require nonblank Style. Preserve user-entered text verbatim rather than stripping section tags.
- Unsupported image/video features are hidden for music and **omitted from music intent**, not silently applied: LoRAs, image post, continuity, image resolution/aspect, sigma edits, image attention/cache/compile toggles, wildcard rules and image output settings. Retain their stored values for returning to image/video.
- No auto-generation, model loads, upload, downloads or LLM call on selecting a music pipeline or opening Run Plan. Run authorizes upload/submission; explicit writer click authorizes only that LLM request.

## 2. Contracts to implement

### Music intent and settings

Create `src/lib/musicIntent.ts` with this complete contract. `options?:never` and `loras?:never` permit common inspection without falsely advertising support. Do not fill missing image properties with dummy dimensions/prompts.

```ts
export interface AbcSettings {
  maxTokens:number; temperature:number; topP:number; topK:number;
  repetitionPenalty:number; penaltyWindow:number;
}
export interface MusicGenerationSettings {
  temperature:number; topP:number; topK:number;
  repetitionPenalty:number; cfgScale:number;
}
export const defaultAbc:AbcSettings={maxTokens:8192,temperature:0.7,topP:0.9,topK:30,repetitionPenalty:1.005,penaltyWindow:100};
export const defaultMusicGeneration:MusicGenerationSettings={temperature:1,topP:0.95,topK:100,repetitionPenalty:1.2,cfgScale:1};
export interface MusicBase {
  readonly recipeId:'music-generation'; readonly version:1; readonly family:'yue2';
  readonly checkpoint:string; readonly style:string; readonly lyrics:string;
  readonly seed:number; readonly maxDuration:number;
  readonly steps:number; readonly cfg:number; readonly sampler:string; readonly scheduler:string;
  readonly generation:MusicGenerationSettings; readonly outputPrefix:string;
  readonly options?:never; readonly loras?:never;
}
export type MusicIntentV1=MusicBase&(
  |{readonly mode:'t2m';readonly planning:'off';readonly abc?:never}
  |{readonly mode:'t2m';readonly planning:'full'|'melody';readonly abc:AbcSettings}
  |{readonly mode:'cover';readonly planning:'melody';readonly sourceAudio:string;readonly audioEncoder:string}
);
export const isMusicIntent=(i:{recipeId:string}):i is MusicIntentV1=>i.recipeId==='music-generation';
```

There is intentionally **no supported music options field** beyond `never`. Do not add arbitrary RunOptions. Use `isImageIntent` at image-only consumers:

```ts
import type { DiagnosticImageIntentV1 } from './execution';
import { isMusicIntent } from './musicIntent';
import { isVideoIntent } from './videoIntent';
// Place after JobIntent in src/lib/jobs.ts.
export const isImageIntent=(i:JobIntent):i is DiagnosticImageIntentV1=>!isVideoIntent(i)&&!isMusicIntent(i);
```

### Native schema/validation policy

`jobs_music.rs` takes a JSON Value (same seam as video), rejects unknown fields at every nesting level, validates first and returns a deterministic API graph. Use `serde(deny_unknown_fields)` structs for the settings and common record if convenient; reject incompatible field combinations after parsing. No HTTP/filesystem/model loading in this module.

Exact bounds from inspected node schemas:

| Field | Allowed | Default |
|---|---|---|
| seed | integer 0..9007199254740991 (JS-safe subset of node u64) | existing seed |
| maxDuration | finite 0.04..900, exact 0.04-second grid (tolerance `1e-7` on scaled integer) | t2m 120 / cover 360 |
| steps | integer 1..10000, also checked against backend schema during readiness | 32 |
| diffusion cfg | finite 0..100 | 1 |
| sampler/scheduler | existing `safe_choice`, then backend allowlist | dpm_2 / sgm_uniform |
| generation temperature | finite 0..5 | 1 |
| generation topP | finite 0.01..1 | 0.95 |
| generation topK | integer 1..32768 | 100 |
| generation repetitionPenalty | finite 0.01..10 | 1.2 |
| generation cfgScale | finite 0..100 | planned/cover 1, off 1.01 on first choosing Off |
| abc maxTokens | integer 1..20000 | 8192 |
| abc temperature | finite 0..5 | 0.7 |
| abc topP | finite 0.01..1 | 0.9 |
| abc topK | integer 1..32768 | 30 |
| abc repetitionPenalty | finite 0.01..10 | 1.005 |
| abc penaltyWindow | integer 1..20000 | 100 |
| style/lyrics | strings, each <=16384 Unicode scalars AND <=65536 bytes; no NUL | Style nonblank, Lyrics may be empty |
| checkpoint/audioEncoder | existing `comfy_model_name` | selected, no filename guessing |
| sourceAudio | existing portable `model_name`; no URLs/absolute path/`[output]` | fresh upload name |
| outputPrefix | existing `safe_output_prefix` | `raw/YuE2` / `raw/YuE2_cover` |

A malformed value is an error, never clamped, rounded or silently replaced. The UI should prevent invalid values, but native validation is authoritative. `cfgScale` is autoregressive guidance, distinct from KSampler CFG; label them separately.

### Canonical graph

Keep saver ID **`7`** for current history parsing. Other IDs are internal deterministic strings. Build exactly these nodes (the JSON below is the t2m Full fixture):

```json
{
  "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"yue2.safetensors"}},
  "A":{"class_type":"YuE2GenerateABC","inputs":{"clip":["1",1],"style":"English, indie pop","lyrics":"[Verse]\nHello world","seed":42,"mode":"full","max_abc_tokens":8192,"temperature":0.7,"top_p":0.9,"top_k":30,"repetition_penalty":1.005,"penalty_window":100}},
  "M":{"class_type":"YuE2GenerateMusic","inputs":{"clip":["1",1],"style":"English, indie pop","lyrics":"[Verse]\nHello world","abc":["A",0],"seed":42,"mode":"full","max_duration":120.0,"temperature":1.0,"top_p":0.95,"top_k":100,"repetition_penalty":1.2,"cfg_scale":1.0}},
  "Z":{"class_type":"ConditioningZeroOut","inputs":{"conditioning":["M",0]}},
  "L":{"class_type":"EmptyYuE2LatentAudio","inputs":{"seconds":["M",1],"batch_size":1}},
  "S":{"class_type":"KSampler","inputs":{"model":["1",0],"positive":["M",0],"negative":["Z",0],"latent_image":["L",0],"seed":42,"steps":32,"cfg":1.0,"sampler_name":"dpm_2","scheduler":"sgm_uniform","denoise":1.0}},
  "D":{"class_type":"VAEDecodeAudio","inputs":{"samples":["S",0],"vae":["1",2]}},
  "7":{"class_type":"SaveAudioAdvanced","inputs":{"audio":["D",0],"filename_prefix":"raw/YuE2","format":"flac"}}
}
```

- t2m Melody: change both mode values to `melody`.
- t2m Off: omit `A`; set `M.inputs.abc=""`, `M.inputs.mode="full"`, and use submitted generation.cfgScale (default 1.01). Do **not** leave a disconnected ABC node or emit a switch/preview node.
- Cover: replace `A` with these three nodes and set `M.inputs.abc=["C",0]`, `M.inputs.mode="melody"`. Use submitted maxDuration and outputPrefix. Do not add `YuE2GenerateABC` on cover.

```json
{
  "I":{"class_type":"LoadAudio","inputs":{"audio":"deas-inputs/source.mp4"}},
  "E":{"class_type":"AudioEncoderLoader","inputs":{"audio_encoder_name":"sheetsage2_bf16.safetensors"}},
  "C":{"class_type":"SheetSage2AudioToABC","inputs":{"audio_encoder":["E",0],"audio":["I",0],"mode":"melody"}}
}
```

No `PreviewAny`, `Primitive*`, `ComfySwitchNode`, UI subgraph IDs or template widget machinery is needed. Source video bytes may be uploaded under the current top-level `deas-input-<uuid>.mp4` form; do not assume all upload names use the subfolder shown in the fixture.

## 3. Ordered implementation tasks

Each numbered **action** below is intended to be 2–5 minutes; each group is several actions, not one five-minute feature. Run each RED/GREEN cycle independently. Build/test runs and hardware acceptance can take longer. A failing import or syntax error in a test is not a valid RED; introduce a compiling empty entry point first if required, then assert the missing behavior.

### Group A — capability and graph foundation

#### A1. Capture baseline and reference fixtures (read-only first)

1. Run:

```fish
cd /data/GitHub/DEAS
git status --short
git diff --stat
node --version
cargo --version
```

Expected: identify and record pre-existing edits and actual runtime versions. Do not claim tests pass from this output.
2. Read the rule files and the exact reference files in section 1. Record core and node-pack revisions in `docs/MUSIC.md` during the later docs task, not in compiled constants.
3. Prepare scoped new fixtures under `tests/fixtures/music/`: `t2m-full.intent.json`, `t2m-full.graph.json`, `t2m-off.intent.json`, `cover.intent.json`, `cover.graph.json`. Derive graph data from section 2, not from UI node positions. These files contain no user media or private paths. Use synthetic filename `yue2.safetensors` only for fixtures, never as a selectable fallback.

#### A2. Add a real compiler RED, then the minimal t2m Full path

Files: create `src-tauri/src/jobs_music.rs`, `src-tauri/src/jobs_music_tests.rs`; modify `src-tauri/src/lib.rs` (module declaration only).

1. Add `mod jobs_music;` beside the existing `mod jobs_video;`. Start with a compiling `pub(crate) fn compile(_: &Value)->Result<Value,String>{Err("Music recipe not implemented".into())}` entry point and include the test module using the same sibling `#[path]` convention as video tests.
2. Test code for `src-tauri/src/jobs_music_tests.rs`:

```rust
use super::*;
use serde_json::json;
fn full() -> Value {
    json!({"recipeId":"music-generation","version":1,"family":"yue2",
      "mode":"t2m","planning":"full","checkpoint":"yue2.safetensors",
      "style":"English, indie pop","lyrics":"[Verse]\nHello world","seed":42,
      "maxDuration":120.0,"steps":32,"cfg":1.0,"sampler":"dpm_2",
      "scheduler":"sgm_uniform","outputPrefix":"raw/YuE2",
      "abc":{"maxTokens":8192,"temperature":0.7,"topP":0.9,"topK":30,
        "repetitionPenalty":1.005,"penaltyWindow":100},
      "generation":{"temperature":1.0,"topP":0.95,"topK":100,
        "repetitionPenalty":1.2,"cfgScale":1.0}})
}
#[test]
fn music_full_matches_the_template_contract() {
    let g=compile(&full()).unwrap();
    assert_eq!(g["M"]["inputs"]["style"],"English, indie pop");
    assert_eq!(g["M"]["inputs"]["lyrics"],"[Verse]\nHello world");
    assert_eq!(g["M"]["inputs"]["abc"],json!(["A",0]));
    assert_eq!(g["L"]["inputs"]["seconds"],json!(["M",1]));
    assert_eq!(g["S"]["inputs"]["negative"],json!(["Z",0]));
    assert_eq!(g["7"]["inputs"]["format"],"flac");
    assert!(!g.to_string().contains("CLIPTextEncode"));
    assert_eq!(g,compile(&full()).unwrap());
}
```

3. RED command:

```fish
cargo test --manifest-path src-tauri/Cargo.toml --lib music_full_matches_the_template_contract -- --nocapture
```

Expected RED: compiler's explicit unimplemented error. If 0 tests run, fix module wiring before proceeding.
4. Implement only the Full graph from section 2, parameterized by submitted values. No runtime transport in compiler. GREEN: same command, one selected test passes.
5. Compare the entire graph to `t2m-full.graph.json` in this test with `serde_json::from_str(include_str!("../../tests/fixtures/music/t2m-full.graph.json"))`. GREEN again. Do not regenerate the expected graph from the compiler under test.
6. Conditional checkpoint: `git add src-tauri/src/jobs_music.rs src-tauri/src/jobs_music_tests.rs tests/fixtures/music`; stage only the module-declaration hunk in `lib.rs` with `git add -p src-tauri/src/lib.rs`; `git commit -m "feat(music): compile YuE2 text-to-music recipe"`.

#### A3. Drive Off and Melody with independent RED/GREEN cycles

Append these tests one at a time to `src-tauri/src/jobs_music_tests.rs`:

```rust
#[test]
fn music_off_omits_planner_but_keeps_a_valid_public_mode() {
    let mut i=full(); i["planning"]=json!("off");
    i.as_object_mut().unwrap().remove("abc");
    i["generation"]["cfgScale"]=json!(1.01);
    let g=compile(&i).unwrap();
    assert!(g.get("A").is_none());
    assert_eq!(g["M"]["inputs"]["abc"],"");
    assert_eq!(g["M"]["inputs"]["mode"],"full");
    assert_eq!(g["M"]["inputs"]["cfg_scale"],1.01);
}
#[test]
fn music_melody_uses_the_same_mode_in_both_generators() {
    let mut i=full(); i["planning"]=json!("melody");
    let g=compile(&i).unwrap();
    assert_eq!(g["A"]["inputs"]["mode"],"melody");
    assert_eq!(g["M"]["inputs"]["mode"],"melody");
}
```

Run filter `music_off_` then `music_melody_` with the A2 Cargo command. Expected RED is wrong graph shape/mode, not a test panic caused by an invalid fixture. Implement exactly the two transformations in section 2; rerun each filter to PASS. Conditional commit: explicit two music module paths, message `feat(music): support ABC off and melody planning`.

#### A4. Add cover compilation without an extraction service

Files: same native module/tests and cover fixture.

```rust
#[test]
fn music_cover_transcribes_source_audio_instead_of_generating_abc() {
    for source in ["deas-inputs/song.flac","deas-input-video.mp4"] {
        let mut i=full();
        i["mode"]=json!("cover");i["planning"]=json!("melody");
        i["sourceAudio"]=json!(source);
        i["audioEncoder"]=json!("sheetsage2_bf16.safetensors");
        i.as_object_mut().unwrap().remove("abc");
        let g=compile(&i).unwrap();
        assert!(g.get("A").is_none());
        assert_eq!(g["I"]["class_type"],"LoadAudio");
        assert_eq!(g["I"]["inputs"]["audio"],source);
        assert_eq!(g["C"]["class_type"],"SheetSage2AudioToABC");
        assert_eq!(g["C"]["inputs"]["audio"],json!(["I",0]));
        assert_eq!(g["C"]["inputs"]["mode"],"melody");
        assert_eq!(g["M"]["inputs"]["abc"],json!(["C",0]));
        assert_eq!(g["M"]["inputs"]["mode"],"melody");
    }
}
```

RED/GREEN command filter `music_cover_`. Minimal implementation: section 2's I/E/C graph, no new dependency. Conditional commit `feat(music): compile SheetSage2 melody covers`.

#### A5. Add validation at the boundary, one invalid category at a time

Files: native music module/tests.

Add this test; first drive unknown/text fields, then numeric fields, then conditional mode fields as separate short cycles rather than writing a pile of tests against a missing parser:

```rust
#[test]
fn music_rejects_malformed_and_cross_recipe_fields() {
    let cases=[
      ("negativePrompt",json!("must never leak")),("width",json!(1024)),
      ("loras",json!([])),("options",json!({})),
      ("seed",json!(9007199254740992_u64)),("seed",json!(-1)),
      ("maxDuration",json!(0)),("maxDuration",json!(900.04)),
      ("maxDuration",json!(0.05)),("style",json!("   ")),
      ("checkpoint",json!("../escape.safetensors")),
      ("outputPrefix",json!("../escape")),("steps",json!(0)),
      ("planning",json!("automatic")),("version",json!(2))
    ];
    for (key,value) in cases {
      let mut bad=full();bad[key]=value;
      assert!(compile(&bad).is_err(),"accepted {key}: {bad}");
    }
    let mut i=full();i["lyrics"]=json!("");assert!(compile(&i).is_ok());
    i["generation"]["topP"]=json!(0);assert!(compile(&i).is_err());
    i=full();i["abc"]["maxTokens"]=json!(20001);assert!(compile(&i).is_err());
    i=full();i["abc"]["unknown"]=json!(true);assert!(compile(&i).is_err());
    i=full();i["mode"]=json!("cover");assert!(compile(&i).is_err());
    i=full();i["style"]=json!("x".repeat(16385));assert!(compile(&i).is_err());
    i=full();i["lyrics"]=json!("a\u{0}b");assert!(compile(&i).is_err());
}
```

Implement the complete bounds table, including all settings fields, not only values sampled in this test. For compact table-driven tests cover both endpoints and one out-of-range value for each entry. Additional mandatory cases: unknown nested generation key, fractional topK, source missing/URL/absolute/Windows drive/traversal, t2m carrying cover fields, cover carrying abc, Off carrying abc, Full missing abc, Unicode texts within bounds. Use serde_json numbers; JSON cannot encode NaN, so test nonnumeric/null/overflow JSON as parse errors instead of inventing a JSON NaN fixture.

Run `cargo test --manifest-path src-tauri/Cargo.toml --lib music_`; expected all music tests pass. Conditional commit `feat(music): validate YuE2 intent before compilation`.

#### A6. Prove node compatibility before dependent integration (research gate)

This is an empirical gate, not a production patch and not a five-minute GPU generation.

1. Reuse an isolated **owned** ComfyUI validation harness; do not start/stop the live service. Validate the compiled Full, Off and cover graphs through ComfyUI `validate_prompt` with matching registered nodes/model names. If a missing model choice prevents validation, report that precise prerequisite rather than replacing the graph with an invented response.
2. Specifically verify the DynamicCombo API `format:"flac"`, generated duration link, and SheetSage2 list mapping. A source-code review is not validation evidence.
3. CPU media probe in the actual installed interpreter: call `nodes_audio.load()` on a tiny authorized audio fixture, a video-with-audio fixture and a silent video. Expected: first two yield nonempty waveform/sample rate; silent video yields `No audio stream found in the file.` No model weights needed.
4. Capture actual `SaveAudioAdvanced` UI/history output key and descriptor fields with a tiny synthetic tensor **during implementation**, in scratch/output isolation. Expected key should be `audio` (verify, do not assume `audios`). This result determines B3's parsing fixture.
5. If any assumption fails, revise this plan's canonical graph/fixture before continuing. Do not patch ComfyUI or DaSiWa installed source. Dependent production tasks remain provisional until this gate passes.

### Group B — native job and output integration

#### B1. Dispatch music without invoking image fallbacks

Files: `src-tauri/src/jobs.rs`, `src-tauri/src/jobs_music.rs`, `src-tauri/src/jobs_tests.rs`.

1. Add a test **inside the existing jobs test module**, which can access the shared `compile`:

```rust
#[test]
fn music_dispatch_is_not_the_diagnostic_image_recipe() {
    let i:Value=serde_json::from_str(include_str!("../../tests/fixtures/music/t2m-full.intent.json")).unwrap();
    let g=compile(&i).unwrap();
    assert_eq!(g["7"]["class_type"],"SaveAudioAdvanced");
    assert!(g.as_object().unwrap().values().all(|n|n["class_type"]!="SaveImage"));
}
```

2. RED command: Cargo filter `music_dispatch_`; expected current image recipe rejection.
3. Add this predicate to `jobs_music.rs` and dispatch **before** video/image parsing in `jobs.rs::compile`:

```rust
pub(crate) fn is_music(i:&Value)->bool { i["recipeId"]=="music-generation" }
// first lines of jobs.rs::compile:
if crate::jobs_music::is_music(i) { return crate::jobs_music::compile(i); }
```

4. In `Jobs::prepare`, introduce `let music=crate::jobs_music::is_music(&intent);`; change saver substitution to `if !video && !music`. Use music `requirements()` before the video/image branches. Define `requirements(i:&Value)->Vec<(&str,Vec<&str>)>` in the music module before wiring its call:

```rust
pub(crate) fn requirements(i:&Value)->Vec<(&str,Vec<&str>)> {
    let mut r=vec![("checkpoints",vec![i["checkpoint"].as_str().unwrap()])];
    if i["mode"]=="cover" {
        r.push(("audioEncoders",vec![i["audioEncoder"].as_str().unwrap()]));
    }
    r
}
```

The function is called only after successful validation; never call it on unchecked frontend JSON. Fresh upload names do not need to appear in stale top-level LoadAudio combo results. The loader validates their actual existence. Retain the exact upload name in the immutable submitted intent.
5. Extend existing preparation HTTP fixture to include the music nodes and choices. Assert no image metadata saver replacement, no image dimensions or `positivePrompt` unwrap, explicit confirmation/admission epoch preserved, missing music node fails before `/prompt`, and unrelated image jobs still prepare when optional music nodes are absent.
6. GREEN filters: `music_dispatch_`, targeted preparation test, then `cargo test --manifest-path src-tauri/Cargo.toml --lib jobs::`.
7. Conditional commit `feat(music): route YuE2 through native Workbench jobs` (stage only own hunks in dirty jobs files).

#### B2. Read music prerequisites without making music globally required

Files: `src-tauri/src/recipe_prerequisites.rs`, `src/lib/recipePrerequisites.ts`, `src/lib/recipePrerequisites.test.tsx`, `src-tauri/src/jobs_music.rs`.

1. Add tests to existing prerequisite parser fixture for: core music nodes present/absent, `AudioEncoderLoader` V3 combo, unsafe/traversal names omitted, old backend missing audio encoder remains image-ready, malformed music schema gives a scoped music error. Do not add music nodes to global `REQUIRED_NODES`/`missingNodes`.
2. Complete node declaration in `jobs_music.rs`:

```rust
pub(crate) const MUSIC_NODES:&[&str]=&[
  "CheckpointLoaderSimple","YuE2GenerateABC","YuE2GenerateMusic",
  "ConditioningZeroOut","EmptyYuE2LatentAudio","KSampler","VAEDecodeAudio",
  "SaveAudioAdvanced","LoadAudio","AudioEncoderLoader","SheetSage2AudioToABC"
];
```

3. Chain `MUSIC_NODES.iter()` into available `nodes` enumeration. Add this field using the existing V3-aware helper (not V1-only `combo`):

```rust
"audioEncoders": options(nodes,"AudioEncoderLoader","audio_encoder_name",crate::jobs::comfy_model_name),
```

4. Add `audioEncoders?:string[]` to TS allowlist (optional preserves old fixture/backend compatibility). Derive required node list from the selected graph/mode: Off does not require `YuE2GenerateABC`; t2m does not require SheetSage2/LoadAudio. Do not disable all music merely because covers are unavailable.
5. RED/GREEN commands: `cargo test --manifest-path src-tauri/Cargo.toml --lib recipe_prerequisites`; `npm run test:ui -- src/lib/recipePrerequisites.test.tsx`. Expected GREEN: no test failures; existing image prerequisite tests unchanged.
6. Conditional commit `feat(music): discover scoped YuE2 and cover prerequisites`.

#### B3. Retain FLAC outputs from correlated history

Files: `src-tauri/src/jobs.rs`, `src-tauri/src/jobs_tests.rs`, `src-tauri/src/jobs_outputs_tests.rs`.

1. Add test to jobs test module before changing `outputs`:

```rust
#[test]
fn music_history_retains_safe_audio_from_the_main_saver() {
    let e=json!({"outputs":{"7":{"audio":[{"filename":"song.flac","subfolder":"raw","type":"output"}]},
      "foreign":{"audio":[{"filename":"foreign.flac","subfolder":"raw","type":"output"}]}}});
    let o=outputs(&e).unwrap();
    assert_eq!(o.len(),1);assert_eq!(o[0]["filename"],"song.flac");
    let bad=json!({"outputs":{"7":{"audio":[{"filename":"../escape.flac","subfolder":"raw","type":"output"}]}}});
    assert!(outputs(&bad).is_err());
}
```

2. RED: `cargo test --manifest-path src-tauri/Cargo.toml --lib music_history_` should fail empty output assertion.
3. After A6 confirms key `audio`, replace the key list `['images','gifs']` with `['images','gifs','audio']` (Rust uses double-quoted strings). Keep the same saver-ID restriction, descriptor validation, <=64 outputs, output-only type and job correlation. Infer `format:"audio/flac"` only for a validated FLAC descriptor from the music saver when no safe MIME is reported; do not trust backend-supplied MIME as media validation.
4. Test malformed audio list, >64 outputs, unsafe subfolder, foreign prompt history, zero outputs not counted as successful generation, multiple valid SheetSage-mapped outputs retained. Existing paired-image saver behavior must remain intact.
5. GREEN same filter then jobs output tests. Conditional commit `feat(music): retain YuE2 audio history outputs`.

#### B4. Extend indexed output transport and no-clobber export for FLAC

Files: `src-tauri/src/jobs_outputs.rs`, `src-tauri/src/jobs_outputs_tests.rs`, `src/lib/jobs.ts`, `src/features/studio/JobOutputPreview.tsx`, `src/features/studio/JobOutputPreview.test.tsx`.

This is a required slice, not an optional nice-to-have: an external backend has no owned local outputRoot and currently falls back to PNG-only IPC. Do not claim support after adding only an `<audio>` tag.

1. RED fixtures using the existing real HTTP server/output test harness: retained terminal music job with a valid tiny FLAC, load by job ID/output index, assert `mimeType=="audio/flac"`, digest and bytes identical on export, native chooser cancel is not success. Reuse the existing PNG no-clobber tests parametrically instead of writing a second export implementation.
2. Keep PNG path unchanged. Add `mime_type` and export extension to `CachedOutput` and preserve the existing public preview width/height fields (`0` for audio, documented as not applicable). Cache owns bytes/digest/job/index; export reuses that cache and never re-fetches mutable backend content. Native chooser filter/default suffix depends on cached media type, not frontend MIME.
3. Accept FLAC only when the immutable graph's output node is `SaveAudioAdvanced` with selected `flac`; do not broadly allow arbitrary audio files from unrelated graphs. Fetch using the existing bounded same-origin client, reject redirects/traversal/oversize and validate FLAC signature plus **actual decodability** before caching. Bound encoded bytes to 144 MiB (reuse existing output byte ceiling), duration <=900 seconds, channels <=2, sample rate <=192000 and total decoded PCM <=768 MiB. Refuse larger results with an actionable error rather than allocating unbounded memory.
4. Reuse an installed native decoder/probe if present. If decoding requires a new Rust FLAC crate, stop for a narrowly documented dependency decision; do not add Python workers, auto-install codecs, or invoke a shell. The exact decoder patch is intentionally gated on A6 media evidence and the inspected dependency inventory; signature-only validation is **not** sufficient. This is one bounded empirical/dependency gate, not a license to redesign output transport.
5. Drive failure tests for corrupt/truncated FLAC, false Content-Type, redirect, active/foreign job, exceeded bytes/decode bounds and existing target file. Shared Logs must receive origin `music/output`, severity and job identity without full prompt/source path/URL credentials. Cancellation retains already verified earlier outputs.
6. In fallback preview preserve request epoch/object URL revocation. Add media MIME to preview state from native `result.mimeType`; render `<audio controls src={selected.url} data-job-output-preview />` for `audio/flac`, existing image otherwise. Do not autoplay multiple mapped results. Change `outputItem(...).media` to `audio` for FLAC so starring does not treat songs as images.
7. Commands: `cargo test --manifest-path src-tauri/Cargo.toml --lib jobs::job_outputs`; `npm run test:ui -- src/features/studio/JobOutputPreview.test.tsx`. Expected: both PNG and FLAC scenarios pass, no skipped decoder assertion counted as acceptance.
8. Conditional commit `feat(music): preview and safely export retained FLAC results`.

### Group C — authoring and model discovery

#### C1. Add family detection with a discriminating header fixture

Files: `src/families/builtin.json`, `src-tauri/src/model_families.rs` (tests), existing family tests under `tests/`.

1. Add a renamed checkpoint header fixture using the two inspected keys and shapes, without loading weights. Test family `yue2` for renamed file; negative control removes each identifying prefix in turn and must not detect YuE2.
2. Add registry entry (signature prefixes use the detector's normalized dotted naming convention; verify normalization in its existing test helper before copying):

```json
{
  "id":"yue2","name":"YuE2","loader":"checkpoint","pipelines":["t2m","cover"],
  "architectures":[],"bases":[],
  "model":[["model.diffusion.model.llm2vae.weight","text.encoders.model.embed.tokens.weight"]],
  "lora":[],
  "defaults":{"width":1024,"height":1024,"steps":32,"cfg":1,"sampler":"dpm_2","scheduler":"sgm_uniform"}
}
```

The width/height fields satisfy the **existing registry shape only**; keep them as compatibility data, not music constraints. They must not appear in music controls, intent or Run Plan. Do not redesign the registry in this slice. No guessed `forge:"YuE2"`: music has two dialects and `dialectOf` cannot represent both.
3. Run `cargo test --manifest-path src-tauri/Cargo.toml --lib model_families` and `npm run test:core`; expected family positive/negative tests pass without classifying YuE2 as unknown-image checkpoint. Conditional commit `feat(music): recognize YuE2 checkpoints by header`.

#### C2. Introduce music draft/type guards before wiring callers

Files: create `src/lib/musicIntent.ts`, `tests/musicIntent.test.ts`; modify `src/lib/jobs.ts`.

1. Copy section 2's TS contract (without the unused import). Add music to `JobIntent`; add `isImageIntent`. No new music-specific IPC command: reuse existing `runWorkbenchJob(baseUrl,intent,admissionEpoch)` JobIntent overload.
2. Test file:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {defaultAbc,defaultMusicGeneration,isMusicIntent} from '../src/lib/musicIntent.ts';
test('YuE2 settings are separate and template exact',()=>{
  assert.equal(defaultAbc.temperature,0.7);
  assert.equal(defaultAbc.maxTokens,8192);
  assert.equal(defaultMusicGeneration.temperature,1);
  assert.equal(defaultMusicGeneration.repetitionPenalty,1.2);
  assert.equal(isMusicIntent({recipeId:'music-generation'}),true);
  assert.equal(isMusicIntent({recipeId:'video-generation'}),false);
});
```

3. For a genuine initial RED use existing public import after a compiling empty/default placeholder and assert exact values; do not count unresolved TypeScript imports as behavior RED. Run `node --experimental-strip-types --test tests/musicIntent.test.ts`.
4. `npm run typecheck` will expose image assumptions after the union change. Fix **only narrowing** in `RunPlan.tsx`, `GenerationMetadata.tsx`, `history.ts`, `Workbench.tsx` and tests: `!isVideoIntent(x)` at image accesses becomes `isImageIntent(x)`. Add early music branches in C5/C6; until those exist use explicit unavailable music presentation, never cast music to image to silence the compiler. Do not commit a type-broken intermediate tree.
5. Conditional commit `feat(music): add versioned music intent and safe recipe narrowing` after C5/C6 minimum branches are present; C2 may be a local checkpoint without commit until then.

#### C3. Add the two prompt boxes without touching image prompt state

Files: create `src/features/studio/MusicPrompts.tsx`, `MusicPrompts.test.tsx`; modify `Workbench.tsx` and all six studio locale JSON files.

1. Write component tests before implementation. Use `I18nProvider`, render two editable values, assert labels Style/Lyrics, no Negative prompt, changing Lyrics calls only onLyrics, expand either opens that field, both hammers exist, writing Style does not modify Lyrics. Mock only Forge/native transport, not the editor under test.
2. Complete minimal component shape (reuse existing class layout and tools; copy/clear handlers should use the existing Workbench helper after generalizing its field-name argument, not duplicate clipboard error logic):

```tsx
import {useState} from 'react';
import {useI18n} from '../../i18n/I18nProvider';
import {ForgeButton} from '../forge/ForgeButton';
import {PromptTextarea} from './PromptTextarea';
import {PromptOverlay} from './PromptOverlay';
import type {ReactNode} from 'react';
export function MusicPrompts({endpoint,root,style,lyrics,onStyle,onLyrics,actions}:{
 endpoint:string;root?:string;style:string;lyrics:string;
 onStyle:(v:string)=>void;onLyrics:(v:string)=>void;
 actions:(field:'style'|'lyrics',value:string,set:(v:string)=>void)=>ReactNode;
}){
 const {t}=useI18n();const [expanded,setExpanded]=useState<'style'|'lyrics'|null>(null);
 const fields=[{id:'style' as const,value:style,set:onStyle,dialect:'YuE2 Song Style'},
   {id:'lyrics' as const,value:lyrics,set:onLyrics,dialect:'YuE2 Lyrics'}];
 const writer=(f:typeof fields[number])=><ForgeButton key={f.id} endpoint={endpoint}
   root={root} dialect={f.dialect} value={f.value} onApply={f.set}/>;
 const selected=fields.find(f=>f.id===expanded);
 return <>
  {fields.map(f=>{const title=t(`studio.music.${f.id}`);return <div className="wb-prompt" key={f.id}>
   <div className="wb-prompt-label"><label htmlFor={`run-music-${f.id}`}>{title}</label>
    <small>{f.value.length} / 16384</small></div>
   <PromptTextarea root={root} target="generic" id={`run-music-${f.id}`}
    data-music-prompt={f.id} value={f.value} maxLength={16384}
    onChange={e=>f.set(e.target.value)}/>
   <button type="button" className="wb-prompt-expand" aria-label={t('studio.run.prompt.expand',{name:title})}
    aria-pressed={expanded===f.id} onClick={()=>setExpanded(expanded===f.id?null:f.id)}>⤢</button>
   {actions(f.id,f.value,f.set)}{writer(f)}
  </div>;})}
  {selected&&<PromptOverlay root={root} target="generic" key={selected.id}
   title={t(`studio.music.${selected.id}`)} value={selected.value} onChange={selected.set}
   onClose={()=>setExpanded(null)} maxLength={16384} closeLabel={t('studio.run.prompt.close')}>
   {writer(selected)}
  </PromptOverlay>}
 </>;
}
```

`target="generic"` preserves existing prompt-tools validation without claiming a native image Forge dialect. If prompt tools accept model-specific YuE2 targets after their concurrent work, use the verified targets; do not invent them in the spelling/translation boundary.
3. In Workbench, add **independent** `usePref` strings for music style/lyrics (top-level hooks, not conditional). Add `t2m`,`cover` to pipeline tuple; `const isMusic=pipeline==='t2m'||pipeline==='cover'`. Render `MusicPrompts` **inside existing `.wb-prompts`** for isMusic, existing positive/negative JSX otherwise. Guard existing detached image overlay with `!isMusic`. Do not mount a second `.wb-prompts` nesting layer or duplicate the entire Workbench.
4. Generalize `promptActions` kind from `positive|negative` to `positive|negative|style|lyrics`; resolve label via `studio.music.<kind>` for music, existing key otherwise. Share the existing clipboard error/copy-state behavior; no new global clipboard service.
5. Tests: `npm run test:ui -- src/features/studio/MusicPrompts.test.tsx src/features/studio/PromptTextarea.test.tsx`; expected both editor tool sets and field independence pass.
6. Conditional checkpoint `feat(music): add independent style and lyrics editors`.

#### C4. Route both writers exactly and isolate asynchronous drafts

Files: `src/features/forge/ForgeButton.tsx`, its existing tests (create `src/features/forge/ForgeButton.music.test.tsx` if no suitable file), `src/lib/forge.ts`, `src-tauri/src/llm.rs`, `src-tauri/src/llm_tests.rs`.

1. Add tests for the actual mocked `native_forge` payload, not button existence: Style sends `{write_for:'YuE2 Song Style',idea:<style brief>,images:[]}`, Lyrics sends `YuE2 Lyrics`; Apply updates only initiating field. Test expansion, undo, cancel and missing LLM configuration route to setup.
2. Existing ForgeButton already falls back to `writePrompt` for dialects absent from nativeTarget. Reuse it; **do not port a third music writer** into native image Forge. If native proxy validates dialect values, append the exact two names to its bounded allowlist. Installed source contains both names, but route availability still needs a real compatibility probe; an unsupported backend returns actionable writer-unavailable, never generic image fallback.
3. Prevent stale async results from being applied after pipeline/root/endpoint/dialect changes. Key music writer instances by field and endpoint/root identity or add the existing request-identity reset pattern to ForgeButton; ensure cancellation on unmount and no surprise draft overwrite. Test pending Lyrics write → switch to t2i → resolve request → image and music fields remain unchanged. Do not globally reset image writer drafts on unrelated renders.
4. Commands: `npm run test:ui -- src/features/forge/ForgeButton.music.test.tsx`; `cargo test --manifest-path src-tauri/Cargo.toml --lib llm`; expected exact writer dialects, failure logging and stale-response tests pass.
5. Conditional commit `feat(music): wire field-specific YuE2 prompt writers`.

#### C5. Add music settings, model filtering and immutable Run

Files: `src/features/studio/Workbench.tsx`, `Workbench.test.tsx`; create `src/features/studio/MusicSettings.tsx`, `MusicSettings.test.tsx`; modify locales.

Separate cycles/actions:

1. RED: select `t2m`, assert checkpoint list includes only detected family yue2 (not unknown checkpoint fallback), two music labels, no canvas/negative/image editor/LoRA controls. GREEN: extend `blocked(model,pipeline)` before its unknown-checkpoint image fallback; known yue2 only for t2m/cover, never image pipelines. Music mode may be selected with no model, with clear missing checkpoint prerequisite.
2. RED: select cover without source/encoder, Run disabled with precise prerequisite; selecting text-to-music does not require cover encoder. GREEN: keep `musicSource:MediaItem|null` separate from `media`/inputImage and add media dock action for audio OR video with a native path. Validate unsupported image/browser-only sources; allow file drop through existing native media descriptor boundary. No upload yet. Mark selected source with existing marks/action pattern. Source can be removed/replaced without changing prompts.
3. RED: ABC Planning Off/Full/Melody changes controls/payload correctly; changing planning does not lose abc settings, switching back restores them. GREEN: use one `planning` select labelled ABC Planning with Off/Full/Melody, not contradictory checkbox+mode values. Cover hides this and displays fixed Melody. Add max-duration step 0.04 with upper bound 900, seed/sampler/steps/CFG using existing components. For Off, first default AR CFG is 1.01; user override is not reset by every render. Keep separate saved defaults for t2m duration and cover duration.
4. RED: Advanced ABC fields only when t2m planned; AR fields always available. GREEN: build `MusicSettings` as controlled presentation of the bounds table with ordinary house numeric controls, existing theme/select skin, no dependency. Add two `<details>` groups, localized ABC settings and Music generation settings. No image size/fps inputs. All numeric values typed/validated before native call; do not convert `''` to zero while editing.
5. RED: pending upload captures source/checkpoint/text/settings once; editing source/pipeline during upload cannot alter submitted job. GREEN: define `buildMusicIntent(sourceAudio?:string):MusicIntentV1` beside existing intent builders. Use structuredClone of independent music state + resolved naming + **capturedSeed**, no spread of image `common`. Return the discriminated type from section 2. Cover requires uploaded name and encoder, throws a localized pre-submit error otherwise. Snapshot every source field before the first await; upload only the captured source with `uploadInput(endpoint,captured.path)`, then put returned name into that captured intent. Reuse Workbench admission epoch/in-flight handling and native errors. No frontend graph compilation.
6. RED: Run Plan in music mode causes zero upload/Run/LLM calls; Run causes one upload for cover then one Workbench submission, t2m no upload. GREEN: select music branch before image/video submit branches and preview builder. For Run Plan source, use a visibly unresolved source marker plus inputNotes, not an executable absolute host path; upload handle becomes authoritative only on Run.
7. RED: t2i → t2m → cover → t2i preserves image prompts/settings and separate music texts; project draft save never gets music fields. GREEN: guard image-project snapshot/application and incoming image Forge canvas handling while isMusic. Do not change image project schema in this feature. Reject ambiguous external image prompt handoff while authoring music with actionable UI; never apply incoming negative as lyrics.
8. Run each new named test immediately with `npm run test:ui -- src/features/studio/Workbench.test.tsx -t '<exact test name>'`, inspect RED reason, implement only its branch, rerun GREEN. Then `npm run test:ui -- src/features/studio/MusicSettings.test.tsx src/features/studio/Workbench.test.tsx` and `npm run typecheck`.
9. Conditional commits at each independently green behavior slice, stage explicit paths/hunks. Never leave union type errors hidden behind `as any` or `as DiagnosticImageIntentV1`.

#### C6. Run Plan, metadata and history must understand music explicitly

Files: `src/features/studio/RunPlan.tsx`, `RunPlan.test.tsx`, `GenerationMetadata.tsx`, `GenerationMetadata.test.tsx`, `history.ts`, `history.test.tsx`, `Workbench.tsx`, `src-tauri/src/jobs_history.rs`, `src-tauri/src/jobs_history_tests.rs`.

1. RED RunPlan test with `MusicIntentV1`: Style/Lyrics rendered verbatim, planning mode and maximum duration shown, no Negative prompt/canvas/fps, cover source and encoder shown. GREEN: early music-specific stage rendering using **existing** `stage`, `row`, stage CSS connectors and localized labels. Keep input→model→prompt→ABC (if active)→generate→audio output ordering. Use the same captured authoring intent builder as Run; opening plan must not compile/prepare/upload. No generic JSON-only plan as substitute for visible stages.
2. RED metadata test: retained job's music style/lyrics/settings displayed after current authoring has changed. GREEN: add explicit `isMusicIntent` branch before image. Do not use image `GenerationSettings` apply button for music; history provides full restore. Display requested max duration as maximum; actual playback/decoded file duration separately if available. Do not claim exact song length from maxDuration.
3. RED history restore test: music record restored to t2m or cover, all settings and two prompts exact, original cover source remains unresolved, changed environment/missing checkpoint/encoder blocks Run. GREEN: extend `HistoryRestore.pipeline` union, early music projection, and Workbench restore branch before positive/negative accesses. Keep existing unresolved-source identity policy—matching old filenames or endpoint origin does not authorize a new upload. Re-selection by user is required; do not auto-open arbitrary historical file paths.
4. RED native history test: roundtrip valid music intent, corrupted/unknown fields refused, effective intent does not insert image format/negative prompt/dimensions. GREEN: return validated music intent unchanged in `effective_intent` before video/image defaults. Compiler remains deserialization authority. Preserve history limit 10; no music database/new schema store.
5. Commands:

```fish
npm run test:ui -- src/features/studio/RunPlan.test.tsx src/features/studio/GenerationMetadata.test.tsx src/features/studio/history.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml --lib jobs::job_history
npm run typecheck
```

Use actual Rust module test filter from `cargo test -- --list` if existing name differs; a 0-test result is failure to verify, never a pass. Conditional commit `feat(music): preserve music intent in plan metadata and history`.

### Group D — playable products, localization, docs and acceptance

#### D1. Render music outputs in main Workbench without image fallthrough

Files: `src/features/studio/Workbench.tsx`, `Workbench.test.tsx`, `JobOutputPreview.tsx` (B4 already handles fallback), `src/features/media/MediaLibrary.tsx` only if audio tiles regress.

1. RED test in existing Workbench harness: native-held terminal music job with owned outputRoot and `song.flac` renders an audio element with controls, **no** image element targeting that output, and output item `media:'audio'`. Same test without outputRoot must use native validated FLAC preview (B4), not a remote URL or PNG decoder.
2. GREEN: before isVideoOut branch at current output renderer line 1033 add audio branch using already-existing `outputItem(shown,o).media==='audio'`. Use existing local media Blob/native asset access contract. Reuse existing output-selection and error handlers; no raw `/view` URL playback bypassing native retention rules. Do not enable Compare/edit/upscale/image metadata actions for audio; reveal/star/export remain available under existing authorization.
3. RED multiple mapped audio results: preserve every safe output, selecting index 1 previews/exports index 1 (current outputIndex defaults non-paired jobs to zero). GREEN: derive outputIndex for **any** retained indexed output, not only paired image roles; do not change original/processed role semantics. Render only the selected audio player or never autoplay any of the multiple players. Queue shows audio icon/name, not broken image thumbnail.
4. RED retained result from failed/cancelled job remains playable/exportable if verified, tab switch doesn't revoke currently used audio unexpectedly, switching selection revokes obsolete object URL and doesn't publish stale async bytes. GREEN: reuse existing output lifecycle patterns; no independent audio polling loop.
5. Commands: `npm run test:ui -- src/features/studio/Workbench.test.tsx src/features/studio/JobOutputPreview.test.tsx`; expected all existing paired output, history and new audio tests pass. Conditional commit `feat(music): play and select generated audio results`.

#### D2. Localize the exact product surface

Files: `src/features/studio/locales/en.json`, `de.json`, `fr.json`, `ja.json`, `tr.json`, `zh.json` and existing locale parity tests.

Minimum keys (plain flat keys, same project convention):

```json
{
  "studio.run.pipe.t2m":"Music (Text to Music)",
  "studio.run.pipe.cover":"Music (Cover Music)",
  "studio.music.style":"Style",
  "studio.music.lyrics":"Lyrics",
  "studio.music.planning":"ABC Planning",
  "studio.music.off":"Off",
  "studio.music.full":"Full — melody and chords",
  "studio.music.melody":"Melody",
  "studio.music.maxDuration":"Maximum duration (seconds)",
  "studio.music.abcSettings":"ABC planning settings",
  "studio.music.generationSettings":"Music generation settings",
  "studio.music.audioEncoder":"SheetSage2 audio encoder",
  "studio.music.source":"Cover source (audio or video)",
  "studio.music.useSource":"Use for music cover",
  "studio.music.needsSource":"Select an audio file or a video with an audio track.",
  "studio.music.needsEncoder":"Select an installed SheetSage2 audio encoder.",
  "studio.music.temperature":"Temperature",
  "studio.music.topP":"Top P",
  "studio.music.topK":"Top K",
  "studio.music.repetitionPenalty":"Repetition penalty",
  "studio.music.penaltyWindow":"Penalty window (tokens)",
  "studio.music.maxTokens":"Maximum ABC tokens",
  "studio.music.arCfg":"Autoregressive guidance",
  "studio.music.output":"Music output (FLAC)",
  "studio.music.durationHint":"Maximum only; the song may finish earlier.",
  "studio.music.coverHint":"Uses the source melody; does not copy the singer's voice or automatically transcribe lyrics."
}
```

Translate each value in the six locales, preserving identifiers and interpolation. Add validation/error labels for actual native errors used by UI; do not expose English raw JSON field names as unlocalized controls. Add only necessary short help; no wall of instructions in the Workbench.

RED: locale parity test requires these keys and no missing translation fallback. GREEN: localized entries. Run `npm run test:core` and localized browser gate in D4. Conditional commit `feat(music): localize YuE2 controls in all Studio languages`.

#### D3. Document the implemented behavior, not just nodes

Files: create `docs/MUSIC.md`; update `docs/STUDIO.md`, `docs/IMPLEMENTATION-STATUS.md`, `docs/CHANGELOG.md`, `docs/NEWS.md`, `docs/VERIFICATION.md`; add attribution under existing `docs/CREDITS.md` if that is the repository's actual credits file (verify first).

Required `docs/MUSIC.md` sections:
- Where to select the two Music pipelines; checkpoint and cover encoder folder/categories.
- Style vs Lyrics and independent writer actions; missing writer/LLM setup behavior.
- ABC Off/Full/Melody, independent planning and AR settings; maximum vs actual duration.
- Cover melody transcription diagram, accepted audio/video input, first audio stream, silent video failure, lyrics entered by user, no voice clone/transcription promise.
- FLAC playback, retained output selection, Save As/no-clobber, history restore source re-selection, source preservation.
- Core/template/node-pack revisions actually tested, exact Linux/Windows/native/GPU evidence and missing gates.
- License notice: inspected checkpoint metadata says CC-BY-NC-4.0; verify source model/card and SheetSage2 terms before any catalog redistribution/download feature. Do not turn this plan into legal assurance.

Update existing guides with links rather than copying all instructions. Version is already dirty at 0.1.63 during inspection; do not guess the next version or overwrite another session's bump. Reconcile at final integration under the established release policy; no release/push in this task without authorization.

Verification: `git diff --check` has no whitespace errors; every feature claim in docs points to real implementation/test evidence, unrun gates remain unchecked. Conditional commit `docs(music): explain YuE2 generation and melody covers`.

#### D4. Integrated gates (do not substitute mocks for model acceptance)

1. Unit/build gates after integrating all code, recording baseline vs newly introduced failures:

```fish
cd /data/GitHub/DEAS
npm run typecheck
npm run test:core
npm run test:ui
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run test:layout
git diff --check
```

Expected: exit 0 for each, all intended tests discovered; no unexplained skips. Do not format/rewrite unrelated dirty files merely to make fmt pass. Capture precise baseline failures if they predate this change.

2. Extend `tools/verify_run_plan.py` and the existing Workbench browser harness (do not add another browser dependency) to cover t2m/cover with discovered new selectors. Six locales, wide and narrow widths including 320px: labels/readability, two prompt boxes, advanced controls keyboard reachable, expand/copy/clear/writer buttons no overlap, plan stages connected, scrolling internal, tab roundtrip retains drafts, hidden views no geometry. Screenshots require human/vision inspection; DOM bounds alone do not establish usable controls.
3. Native rendering/playback: actual Linux WebKitGTK and Windows WebView2. Play FLAC, pause/seek, switch jobs/tabs, source preview audio/video, save to paths with spaces/Unicode, cancel save, existing destination unchanged. Chromium fixture evidence must be reported separately. If Windows unavailable, state Windows runtime **not verified**, not supported by inference.
4. Authorized real-model GPU acceptance on a separately owned backend, without restarting live services or downloading weights implicitly:
   - t2m ABC Full with short section-tagged lyrics and style; verify nonempty decodable FLAC and exact effective intent/graph.
   - t2m Melody; verify corresponding modes/plan used.
   - t2m Off; graph has no ABC generation and AR CFG is the displayed value.
   - cover audio and equivalent video-with-audio; graph contains source→SheetSage2→YuE2 and output is a new file. Listen for melody relationship; a changed waveform or a successful node execution alone is not proof of a useful cover.
   - silent video fails actionably, no success output or text-only fallback.
   - cancel during ABC and during music generation using existing scoped cancellation. Do not global-interrupt another job. Verify already completed output retention and no foreign queue effects.
   - record actual generated duration/sample rate/channels, wall time, memory/VRAM and model/core revisions. Requested maxDuration need not equal actual duration.
5. If checkpoint/SheetSage2 weights, GPU capacity, decoder dependency or target OS are unavailable, finish fixture-verified code only with explicitly incomplete hardware/OS acceptance. Never advertise complete verified Cover support while A6/B4/real cover run is blocked.

## 4. Acceptance map

| User requirement | Automated proof | Empirical/manual proof |
|---|---|---|
| Text to music pipeline | A2/A3, C5 Workbench intent tests | D4 Full/Melody/Off generation |
| Cover uses selected audio | A4 graph, C5 upload snapshot, B1 fixture | D4 audio cover and melody listening |
| Video cover uses its audio | A4 same LoadAudio graph, A6 video decode | D4 equivalent video source + silent failure |
| Two boxes, no negative text | C3, C5, C6 tests | localized native screenshots |
| Corresponding prompt writers | C4 exact native payload + isolated Apply/stale response | actual compatible writer route |
| ABC settings and modes | A3/A5 + C5 settings/intent tests | graph validation + three real modes |
| Playable retained/exportable music | B3/B4/D1 HTTP/media/output tests | FLAC native playback/Save As |
| No regression to image/video | full tests, project/history/type guards | D4 layout and paired-output checks |
| Safe execution/source preservation | existing admission/correlation + B/C added failures | before/after source digest, scoped cancellation |

## 5. Risks, tradeoffs and explicit open gates

1. **List mapping:** SheetSage2 emits a list. Normal graph mapping may create several music outputs and large work. A6 must establish behavior; keep all <=64 safe products and do not silently select the first ABC. If source-driven multiplicity is excessive, add a documented bounded rejection rather than secretly discarding melodies.
2. **Cover is melody reinterpretation:** source audio is transcribed symbolically. It does not preserve timbre, singer identity, accompaniment, exact tempo or exact duration as a guarantee. These limitations belong in UI help/docs.
3. **Memory:** core LoadAudio decodes the full first audio stream into memory. Existing upload ceiling is not a decoded-memory guarantee. Before supporting long source files, establish a native preflight duration/channel/sample-rate bound; proposed initial source policy is <=900 seconds, <=2 channels, <=192kHz, <=768 MiB decoded PCM. Probe with existing native media tooling and fail before expensive inference. Do not silently trim/downmix/resample. If no safe probe exists, this is an implementation blocker requiring a small bounded native probe, not permission to rely on file extension alone.
4. **FLAC transport is real scope:** local owned outputRoot playback alone leaves external-backend fallback broken. B4 decoder/dependency selection remains a bounded research gate; its exact decoder-specific code cannot responsibly be invented before that decision. Implementer must resolve and update the canonical plan before claiming the output/export portion executable.
5. **Model identity:** signatures from one inspected checkpoint do not establish every future YuE2 variant. Keep unknown variants unavailable with a clear reason; never use a filename-only fallback that also enables image recipes.
6. **Upstream revision:** presence in installed source does not mean a newly provisioned DEAS backend has YuE2/SheetSage2 or both writer dialects. Missing optional nodes disable only affected modes; no automatic update of external services or broad installer feature creep.
7. **Concurrent edits:** do not paste whole Workbench or locale files over current code. All snippets describe new bounded behavior; adapt insertion context to the latest tree without reverting PromptTextarea/spellcheck work. Commit only owned hunks, and only with authorization.
8. **Plan completeness boundary:** compiler graph, payload, defaults, bounds, UI behavior and exact integration reach are specified. A6 runtime mapping and B4 decoder choice are explicitly unproven gates; downstream code snippets must not be represented as already validated. Resolving these gates is mandatory before claiming a zero-guess, fully executable media handoff. No test execution or model-quality evidence was collected in planning mode.
9. **Deliberate omissions:** no new custom nodes, FFmpeg extraction service, external API/cloud fallback, automatic lyrics transcription, voice cloning, video remux, ABC score editor, instrumental third prompt box, extra audio codecs, new persistence system, batch/concurrency controls, catalog/download implementation or unrelated refactor.

## 6. Handoff checklist

- [ ] Reinspect baseline dirty edits before implementation; preserve other-session changes.
- [ ] A6 schema/LoadAudio/history/list gate passed and evidence recorded.
- [ ] Native compiler tests and strict validation green.
- [ ] Music optional prerequisites scoped, no image fallback.
- [ ] Source preflight bounds and no-stream error verified.
- [ ] Independent prompt state and both exact writers verified.
- [ ] Full/Melody/Off and advanced settings reflected exactly in intent.
- [ ] Run snapshot is immutable across awaited uploads and UI edits.
- [ ] Audio history/output transfer/cache/export including external backend verified.
- [ ] Plan, metadata, recent-history restore and image-project guards verified.
- [ ] All six locales, docs and layout gates updated.
- [ ] Linux/Windows native playback evidence separated from browser fixtures.
- [ ] Real model/cover quality and scoped cancellation tested, or explicitly blocked.
- [ ] Final review confirms no unrelated changes, no secret/private host data in docs, no unauthorized publication.
