# DEAS consolidated implementation status and plan

## Current authoring preview (0.1.29)

Studio **Run Plan / Ablaufplan** replaces Workspace map with a live read-only preview from the exact Workbench image/video intent builders used by the main Run action. Optional input/mask/layer preparation, model/LoRAs/options, prompts/wildcards, generation, image refine/upscale, video-family/audio and output choices are exposed; upload/default/Auto values remain explicitly unresolved. Saved `map` tabs and mounted editor drafts survive. The former Engine/local Director workspace remains expandable diagnostics, not an execution graph. See [usage and boundaries](STUDIO.md#run-plan-and-engine-diagnostics) and [verification](VERIFICATION.md#run-plan-authoring-preview-0129). This does not complete the roadmap's editable planner, runtime tracking, persistent projects, or native/model/platform acceptance.

MiniMax H3 upload-preparation fix: native preparation no longer treats `LoadImage`'s top-level combo as a complete inventory of `deas-inputs/` references. Exact-error HTTP regression and native/frontend gates are recorded in [verification](VERIFICATION.md#minimax-h3-uploaded-reference-preparation-fix). No new GPU or platform acceptance is claimed.

## Pre-install folder-choice regression fix

The setup consent guard now compares Models/Input/Output path values rather than JSON property order. A reordered native request no longer falsely disables **Start install**; genuinely changed paths remain blocked. Regression fixtures reproduce the former failure with Output → Models → Input, cover Models alone, and reject a mismatched path for each folder. Verified: `npm test` (80 core and 332 UI tests), `npm run typecheck`, `npm run build`, and `git diff --check`. No fresh native installation or Windows runtime test was performed; native folder validation is unchanged. See [first setup](GETTING-STARTED.md#first-setup-inside-deas).

## Windows installer Verify timeout fix

Removed the Unix-only Python `signal.alarm` from the ComfyUI import probe; the native runner now enforces its 120-second deadline through existing Linux process-group / Windows Job cleanup. Other commands retain their one-hour deadline. A regression fixture first reproduced the reported AttributeError by removing `signal.alarm`, then passed for CPU/NVIDIA argument paths after the fix. Actual timeout, cancellation, missing-node rejection and partial-file preservation are tested. Verified: 249 native tests passed (20 ignored), strict native Clippy, changed-file rustfmt, and offline `cargo xwin check --lib --target x86_64-pc-windows-msvc --locked`. No actual Windows install/GPU run or new distributable was produced. See [troubleshooting](GETTING-STARTED.md#if-something-goes-wrong).

## Editable base image and layer drag ordering

Base image and inserted images share paint, move/resize and visibility controls; image rows (including the base) and mask rows support drag ordering within their own stacks. A changed base is baked with visible inserts once into the source-sized input PNG; the mask stays separate. Originals are preserved. Regression tests cover brush/geometry/order/failure paths and submitted intents. Verified: 80 core and 351 UI tests, frontend typecheck/build, plus real Chromium interaction and PNG pixel assertions for base paint/move/resize/hide/order and immutable upload snapshots. The broader responsive fixture sweep remains blocked by Media header/dock pointer interception after the desktop capture; no all-width acceptance is claimed. No native WebKitGTK/WebView2 or GPU render was run. See [image editing](STUDIO.md#image-editing).

## Authority and evidence

This is the **single current planning/status index** for DEAS. Video pipelines, media references and MiniMax H3 Director parity have their own working plan, [VIDEO-PLAN.md](VIDEO-PLAN.md). It consolidates [PLAN.md](PLAN.md), [PLUGIN-ROADMAP.md](PLUGIN-ROADMAP.md), [NEXT-SESSION.md](NEXT-SESSION.md), [EXECUTION-CONTRACT.md](EXECUTION-CONTRACT.md), [INSTALLER-INTEGRATION.md](INSTALLER-INTEGRATION.md), download/auth/localization contracts and [VERIFICATION.md](VERIFICATION.md). Older files retain detailed contracts and historical records; their stale checkboxes are not a competing current backlog. [PROJECT-RULES.md](PROJECT-RULES.md) and [COMFYUI-RULES.md](COMFYUI-RULES.md) govern implementation.

Baseline: source version **0.1.27**, inspected on **2026-10-19**, Git HEAD `0af7d339e67ea091d2a83f279ed262ec2bba2d16`. The working tree already contained an unrelated `src-tauri/src/install_torch.rs` change and untracked `.hermes/` state; these were not changed by this documentation work. Exact installer pins must be checked against the current working source, not inferred from this baseline.

The initial consolidation was a source/document audit, not fresh runtime acceptance. The subsequent documentation-migration/publication follow-up ran frontend typecheck/tests/build, native tests/fmt/strict Clippy and the Linux release build; see the newest entry in [VERIFICATION.md](VERIFICATION.md). No new GPU render, training, Windows runtime or playback acceptance was performed. Earlier model/platform acceptance below remains historical evidence, not reproduced by those gates.

| State | Meaning |
| --- | --- |
| Implemented, bounded | The named bounded capability exists in source; does not mean the entire product goal is done |
| Partial | Usable building blocks exist, but significant contract/acceptance work remains |
| Missing | No dedicated DEAS implementation found for the stated capability |
| Recorded acceptance | Earlier journal reports execution; scope and unresolved failures still apply |
| Unverified / blocked | Required evidence is absent or a known defect prevents acceptance |

## 1. Goal and architectural decisions

Build an easy-to-extend AiO AI workstation for generation, prompting, checkpoints/models/LoRAs, intelligent editable presets, installation/backend management, mixed image/video pipelines, training, video post-production, comparison and assembly.

- Rust is the main implementation language wherever a working Linux/Windows implementation or library is available. React/TypeScript presents the product; Python remains only where ComfyUI/ML/training/SDK APIs justify it.
- Features are small independently testable plugins/modules with explicit contracts. Reuse shared native services and general parameterized helpers; do not create a new framework or one-use service for each feature.
- The current built-in metadata registry is a foundation, **not a finished plugin SDK**. Add runtime/version/permission/dependency/lifecycle contracts incrementally when a real plugin needs them.
- ComfyUI executes recipes; DEAS owns Studio controls, immutable submissions, validation and result handling. The separate original Comfy tab remains an explicit exception, without native IPC authority.
- Model packs declare exact architecture/runtime/resource/shape constraints. New backend/model support requires capability checks and tests, not universal compatibility promises.
- Linux and Windows are required targets; platform-specific accelerators are optional capabilities. Build, native interaction, media playback, real computation and performance are separate acceptance gates.
- Installed features are included automatically with no second enable action. Available, installed, compatible and execution-verified are distinct states.
- Preserve source media and external services. Conflicting inference/enhancement/training stacks use isolated managed profiles and shared owned-job scheduling.

## 2. Consolidated status matrix

Source paths below are relative to the DEAS repository. “Remaining” includes implementation and acceptance; an existing form or graph is not a completed feature.

| Area / prior milestone | State and implementation evidence | Remaining work / acceptance boundary |
| --- | --- | --- |
| Repository and neural shell — M0/M1/M1b | **Implemented, bounded.** `src/App.tsx`, `src/components/neural/`, `src/lib/plugins.ts::validatePlugins`; React/Tauri shell, hierarchy, reusable neural controls and inspection | Preserve current automatic setup; old guided confirmation/animation milestones are historical, not requirements to restore |
| Native provisioning — M2 | **Partial.** `install.rs::Engine::{plan,start,existing_plan,open_existing,update}`, `install_defaults.rs`, `install_torch.rs`; immutable consented plans, owned runtime, selected nodepack, checked reopening and updates | AMD/Intel profiles, Git bootstrap, full FFmpeg/attention provisioning, space planning, interrupted-install repair/resume, staged upgrades/rollback; broader hardware/Windows runtime acceptance |
| Owned lifecycle and restart | **Implemented, bounded.** `backend.rs`, `startup.rs`, `win.rs`; approved ownership, default-on configurable autostart, explicit Stop, checked reopening | Real restart/hardware matrices and crash/power-loss recovery; approval is not recursive attestation or arbitrary environment adoption |
| Optional resource downloads — M2b | **Partial.** `downloads.rs::Manager::{import,browse,plan,start,cancel}`, `downloads_models.rs`, `downloads_providers.rs`, `downloads/fs.rs`; catalogs, providers, managed placement, integrity and cancellation | Resume, complete resource registry/free-space UX, broad authenticated-provider acceptance and explicitly authorized backend pulls |
| Authentication | **Partial.** `auth.rs`; native exact-origin credentials, set/restore/verify and metadata-only readback | Real OS-store and authenticated-provider acceptance beyond injected-vault/HTTP fixtures; authentication does not imply license access |
| Localization | **Implemented, bounded.** `src/lib/i18n.ts`, module-owned locale files and language manifests; six bundled languages | Native-speaker review and future external-language/plugin lifecycle; translated IDs remain stable |
| API negotiation — M3a/M3 | **Partial.** `api.rs`, `recipe_prerequisites.rs`; bounded classic/v2 discovery and exact node/model/sampler choices | Complete v2/SDK execution adapter; no implicit cloud fallback or fallback after authentication/schema errors |
| Image generation and model families | **Partial.** `jobs.rs::{compile,Jobs::prepare,Jobs::submit}`, `model_families.rs`, `src/families/builtin.json`, Workbench; image recipes, LoRA stacks, family constraints, correlated classic jobs | Per-family real computation/quality/performance matrix, complete versioned/licensed resource packs, image/video prompt references ([§3.5](#35-smart-masking-and-imagevideo-prompt-references)), regional image prompting ([§3.6](#36-regional-prompting-for-image-generation)) and more verified modes; family entries with empty pipelines are not implemented operations |
| Video generation | **Partial.** `jobs_video.rs::{validate,compile,ltx,wan,h3}`; native LTX 2.3, Wan 2.2 and MiniMax H3 graphs, uploads and output recognition; LTX video-to-video (`sourceVideo` → core `LoadVideo` → multi-frame `LTXVAddGuide`) and keyframe multi-reference (`ltx.keyframes`); H3 REF2VA timeline media (`h3.media`); H3 image edit (`h3Edit`, Director Image Inpaint style). Open work packages: [VIDEO-PLAN.md](VIDEO-PLAN.md) | Real LTX/Wan/REF2VA runs, LTX source-audio keep, IC-LoRA control, per-segment prompts, full media export/playback, multi-model paths and platform acceptance |
| Director and continuity | **Partial.** `ContinuityPlanner.tsx`, `src/lib/continuity.ts`, `Workbench.tsx::{runVideo,pinClip}`, `jobs.rs::native_h3_session`; ordered H3 segments and previous-clip pinning | Full Director authoring, verified capture/continuation, RefMods asset domain, REF2VA/inpaint generation modes, joined clips/transitions and durable handoffs; the map's local Director draft is not this full product |
| Prompt Forge / shared LLM | **Partial.** `llm.rs`, `src/lib/forge.ts`, `src/features/forge/`; local/remote discovery, model dialects, text/vision route forwarding, review/apply/undo and Send to Generate | Streaming/cancellation, cast/people boxes, richer video/audio references and continuity drafts; broad native/platform interaction; remote API-key support where absent |
| Presets, wildcards and seeds | **Partial overall; existing controls implemented.** `wildcard.rs`, `src/lib/wildcard.ts`, Workbench, `outputNaming.ts`; reproducible seed controls and installed-node library with weights/budgets | Custom-library editing/import, versioned cross-feature smart presets, compatibility explanations and measured hardware-aware recommendations |
| Image editing | **Partial.** `StudioImageEditor.tsx`, `imageEditor.ts`, `jobs.rs::compile`; layers/masks, zoom/pan, sizing, crop-inpaint-composite, blur and a colour-tolerance magic wand (`floodRegion`) | Persisted projects, undo, transparent inserts, broader outpaint/instruction edit paths (source frame and full-size drop: [§3.7](#37-image-editor-source-frame-for-outpainting-and-full-size-image-drop)), model-based masking ([§3.5](#35-smart-masking-and-imagevideo-prompt-references)) and native/GPU quality acceptance |
| Editable end-to-end planner — M4c | **Missing general system.** H3 sequential Run-all is a narrow building block | Persistent operation graph, asset revisions, downstream invalidation, intermediate replacement, review/pause/resume, batch/restart recovery and general mix-and-match pipelines |
| Media browser/player/domain — M4b | **Partial.** `media.rs`, `media_metadata.rs`, `MediaLibrary.tsx`; folders, thumbnails, metadata and output presentation | Durable asset registry, project provenance/revisions, collections/tags/search and shared compatibility proxies; native video playback currently has a recorded crash |
| Output and export | **Partial.** `jobs_outputs.rs::Jobs::{output,export_to}`, metadata/naming savers, `jobs_video.rs::combine`; bounded PNG retrieval/cache/no-clobber export and video graph saving | General verified video/audio transfer/Save As/export; Workbench video `/view` playback is not app-owned immutable asset ingestion; native A/V acceptance remains open |
| Video comparison | **Missing dedicated integration.** Workbench original/result image comparison exists | Port the actual Rust/libmpv comparison behavior described below, not only a generic browser two-video mockup |
| Video enhancement/post-production — M4d | **Missing dedicated TrueVideoEnhancer port.** Existing image upscale/refine graphs are not a video worker pipeline | Composable enhancement profiles, bounded streaming, real AI/NVIDIA inference/interpolation, previews, cancellation and color/audio/export correctness |
| Video assembly/editor | **Missing dedicated assembly port.** Video saving and sequential H3 generation are not montage/export composition | Ordered clips/layouts, stream preflight, trims/splits/timeline/audio decisions, safe export and optional later model transitions |
| Training/datasets — M4d | **Missing.** No DEAS training/dataset command/worker family found | TrainFlow profile contracts, preparation/captioning, managed workers, short real runs, samples/state resume and library publication |
| Analysis and automation | **Partial assistance only.** Forge vision, shared LLM, wildcard/seed services and H3 sequencing | General analysis/tagging plugins and approved cross-feature operation automation |
| Telemetry and optimization | **Partial primitives.** `hardware.rs` discovery and selected model options | CPU/RAM/storage/resource-pressure profiles, shared GPU scheduling, opt-in bounded benchmarks and verified optimization recommendations |
| Plugin SDK/feature manager — M4/M4b | **Missing general platform; metadata/data plugins exist.** `PluginManifest`/`validatePlugins`, catalogs and locales | Versioned execution contracts, dependencies, permissions, platform constraints, migrations, install/remove/update lifecycle and untrusted extension isolation |
| Safe updates/migrations — M4 | **Partial in-place operations.** `Engine::update`, repository release checks and settings relocation | Staged environment update, rollback, compatibility channels, project migrations and safe feature-level removal; reinstall can replace the owned venv, so it is not rollback |
| Distribution — M5 | **Partial infrastructure.** Linux/Windows build/test matrix, NSIS and release workflow definitions | Current CI readback, actual Windows/WebView2 runtime acceptance, fresh-machine/Git-free setup, signed/updater-verified/portable distribution and beginner release acceptance |
| Licenses and collaboration | **Process requirements, not completed clearance.** Existing roadmap/contracts and reference repositories | Inventory code/model/SDK/runtime terms before reuse/distribution; separate authorization for publication, visibility changes or invitations |

### Important acceptance corrections

1. `VERIFICATION.md` records a real owner-run **MiniMax H3 I2VA job reaching succeeded**. Blanket “no real video generation” is stale. That does not establish LTX/Wan, real continuity capture, a fresh-install model run or broad quality/performance support.
2. The same latest record reports a **WebKit/GStreamer Matroska assertion abort after playback starts**; audible audio is unconfirmed. Native playback is **blocked**, regardless of earlier successful HTTP/blob probes. This must be addressed before accepting video presentation.
3. Earlier CPU/NVIDIA install and selected-nodepack lifecycle runs are recorded, but were not rerun here. Installer parity, every hardware/backend and Windows runtime remain separate gates.
4. Input/mask uploads, image/video compilation, classic job submission/correlation and managed download placement exist. Older unchecked entries describing them as wholly missing are stale; durable asset ownership, cancellation and general adapters still are missing.
5. Prompt Forge review/apply and the native recipe compiler exist. Older “future module” wording must not be interpreted as absence of those source files.
6. `src-tauri/README.md`, the execution ledger and older verification sections contain baseline-only/Linux-only or diagnostic-only descriptions. Retain their safety constraints, but use this index and current source for implementation scope. Historical test totals and artifact hashes are not a current green certificate.
7. `src-tauri/src/output_naming.py::prepare` conditionally wraps existing core/DaSiWa saver methods. This is an existing global-patch compatibility exception to audit under the new coexistence rules, not proof that DEAS currently avoids all monkey patches. No code change is made by this plan.

## 3. Real reference projects and integration plans

The following paths identify the **local source repositories inspected**. They are provenance references, not portable runtime paths or dependencies to hard-code into DEAS. Source-project functionality does not count as implemented in DEAS. Link/source paths are relative to each named reference repository.

### 3.1 Video post-production: DaSiWa-TrueVideoEnhancer

**Reference:** `/data/GitHub/DaSiWa-TrueVideoEnhancer`.

Use actual composable processing rather than the older blanket roadmap claim that restoration/HDR are absent. `backend/custom_pipeline.py` implements selection validation and a bounded processor: **restore → spatial upscale → temporal interpolation → SDR-to-HDR → encode**, with AI/NVIDIA spatial and RIFE/NVIDIA temporal choices. `backend/render_contract.py` holds codec/container/precision/output safeguards; `backend/streaming_pipeline.py` holds streaming and memory/queue behavior. `internal/worker/manager.go` supplies behavioral references for preview/batch/cancel/progress, not a Go service to embed.

**DEAS boundary:** Rust owns validation, models/profiles, FFmpeg/process lifecycle, scheduling, status, cancellation, output verification and registration; reuse appropriate Python inference workers only for PyTorch/Spandrel/RIFE/ONNX/TensorRT/NVIDIA VFX computation without a suitable Rust path. Keep this runtime isolated from ComfyUI and training where stacks conflict.

**Constraints:** the reference requirements are CUDA/NVIDIA-oriented, including Torch/Torch-TensorRT/CuPy/VFX; do not copy that stack as a universal CPU/AMD/Intel environment. VFX API discovery is not GPU execution evidence. AI/RIFE process normalized SDR, even with 16-bit transport; this is not native HDR model inference. Custom selection rejects FPS reduction and incompatible legacy custom-encoder/HDR/slomo options. Advertise restoration/HDR only for explicitly supported and tested combinations.

Acceptance, all still open in DEAS:
- [ ] Versioned composable stage/profile contract with explicit available/unsupported capabilities and source-preserving outputs.
- [ ] Real short AI-upscale/RIFE and NVIDIA spatial/temporal/restoration/HDR runs separately; verify effective scale/FPS, stage order and color precision.
- [ ] Bounded-memory long-clip decode/process/encode run; record RAM/VRAM, throughput, latency and cancellation behavior.
- [ ] Separate preview assets/budgets, batch state, owned-child cleanup and no accidental overwrite.
- [ ] Decode/read back outputs for dimensions, frame count/timing, audio/subtitles where supported and codec/container validity; target Linux/Windows acceptance tracked separately.

### 3.2 Video comparison: DaSiWa-simple-video-compare

**Actual reference found:** `/data/GitHub/DaSiWa-simple-video-compare`. This is distinct from the supplied assembler. Its current desktop is already **Rust/Tauri/libmpv**, not the old Go application still present in its tree.

Read `src-tauri/src/native.rs` for side/slider/blend/difference filters, normalization, seeking/frame-step and audio/source controls; `embedded.rs` and `embedded_windows.rs` for native rendering; `runtime.rs` for runtime discovery and checked Windows provisioning; `desktop/src/model.ts` for the UI contract. Reuse/adapt these native boundaries in small DEAS media/compare modules rather than reimplementing the old server UI.

**Dependencies/limits:** libmpv and FFprobe plus GTK/OpenGL/WebKitGTK on Linux; libmpv DLL, FFprobe and WebView2 on Windows. The source has Linux-specific GPU wipe and Windows filter paths; do not promise identical acceleration. Comparison filters normalize to `yuv420p`, so these modes are not bit-exact HDR/high-bit-depth analysis. Managed runtime download is Windows x86_64-specific. Do not blindly copy its Wayland software-render workaround into DEAS's startup policy. Source reports do not establish fresh real-Windows acceptance.

Acceptance, all still open for the DEAS port:
- [ ] Shared player/probe/runtime boundary reused by comparison and editing, with permission/ownership validation and clear runtime errors.
- [ ] Real one/two-source playback with side-by-side, wipe, blend and difference; seek, frame-step, source audio and metadata controls.
- [ ] Mismatched dimensions/FPS/duration, shorter-source EOF, missing audio, invalid input and repeated close/reopen tests; preserve originals.
- [ ] Document comparison color/precision limits; separate decoded-file correctness from visual native rendering.
- [ ] Linux and actual Windows native interaction/playback/performance evidence; assess GPL/libmpv/FFmpeg redistribution before copying/bundling.

### 3.3 Video assembly: DaSiWa-simple-rtx-video-assambler

**Reference, spelling retained:** `/data/GitHub/DaSiWa-simple-rtx-video-assambler`.

`vid_tool.py` provides ordered sources/labels, row/column/two-column grid, contain/cover/stretch, even dimensions, text overlays, selected/mixed/no audio and NVENC AV1 or SVT-AV1 export. Use its filter/command behavior as a reference for a **Rust FFmpeg assembly plugin**; PySide6 is legacy UI, not a required ML worker. Spatial grid composition is distinct from temporal montage; both must be named explicitly in DEAS.

Do not port its defects: “preview” only computes resolution, audio mixing assumes every input has an audio stream, emitted NVENC `p8`/`p9` are not universally supported presets, and `-y` plus timestamp output names can overwrite. NVENC encoding does not mean scale/stack/text filters run on the GPU. Use DEAS output ownership, actual stream/encoder probes and typed argv.

Acceptance:
- [ ] Ordered source list and non-destructive labels/trims/layout choices using the shared media domain.
- [ ] Probe stream geometry/audio and encoder options; valid fit/layout/preset combinations, odd-count grids and special-character labels.
- [ ] Mix only existing audio streams with explicit timing policy; test silent-only and mixed silent/audio sources.
- [ ] Verified hardware encode with explicit software fallback where supported; measure full pipeline, not encoder-only speed.
- [ ] Atomic collision-safe export, cancellation/owned cleanup and decoded A/V readback on both target platforms.
- [ ] Distinct temporal concatenation/assembly contract and tests; later transitions use a separate optional model capability, not hidden interpolation.

### 3.4 LoRA creation/training: DaSiWa-TrainFlow

**Reference:** `/data/GitHub/DaSiWa-TrainFlow`.

Use `internal/trainer/profiles.go`, `config.go`, `defaults.go`, `musubi.go`, `manager.go` and `normalizer.go`, plus runtime/model/process modules, for exact profile behavior. The exposed profiles are **Anima, SDXL/Pony/Illustrious, LTX 2.3, Wan 2.2 and Krea 2**. Vendored training scripts do not make every architecture a supported TrainFlow profile.

Preserve required model components, training-specific divisors/buckets, optimizer-aware defaults, dataset TOML, cache-text → cache-latents → train prerequisites, samples/state outputs and compatible resume behavior. Training dimensions are profile-specific; do not substitute generation-grid assumptions. Dataset normalization is manual-only in the reference. Textual inversion is restricted to sd-scripts profiles; applicable LoKr/other modes need individual capability checks.

**DEAS boundary:** Rust owns datasets, typed settings/config/argv, preprocessing orchestration, model/runtime validation, process groups, progress, cancel/resume and result indexing. Python remains the sd-scripts/Musubi/PyTorch training engine. Keep trainer environments isolated where required; do not embed the Go UI/server or couple training upgrades to ComfyUI.

**Limits to retain/correct:** actual managed runtime code uses cu130 despite older README CUDA 12.4 wording; check current source rather than copy a prose pin. ROCm is experimental, existing PyTorch is not compatibility evidence, and current Musubi launch is single-process/single-machine. Replace whitespace-split extra arguments with typed validated argv rather than claiming robust quoting or distributed training support. Wrapper MIT licensing does not clear vendored trainer/models.

Acceptance:
- [ ] Native profile/settings/model prerequisites, reproducible dataset/config generation and explicit manual normalization.
- [ ] Dataset caption/tag/resize plugin contracts with independent resource requirements and no source overwrite.
- [ ] Cache failures block training; each advertised profile/mode/backend passes config/CLI tests and a real short run producing a usable artifact.
- [ ] Samples, logs, measured RAM/VRAM/step throughput, owned cancellation and verified supported state resume.
- [ ] Publish trained artifacts and previews to the shared model/media registry with provenance; no silent replacement or automatic generation activation.
- [ ] Separate Linux/Windows acceptance and license inventory for wrapper, vendored code, dependencies and model assets.

### 3.5 Smart masking and image/video prompt references

**References:** core ComfyUI (local checkout `8f04fd6e`, `comfy_extras/nodes_sam3.py`, `comfy/text_encoders/sam3_clip.py`), [ComfyUI SAM 3.1 guide](https://docs.comfy.org/tutorials/utility/video-segment-sam3), [SAM License](https://github.com/facebookresearch/sam3/blob/main/LICENSE), [SwarmUI Image Prompting](https://github.com/mcmonkeyprojects/SwarmUI/blob/master/docs/Features/ImagePrompting.md). Owner request; nothing below is implemented beyond the magic wand.

**Masking ideas (Inpaint):** the shipped magic wand selects a connected area by colour tolerance. Planned, in this order:

1. **Text → mask** ("the face", "the sky") and **click/box → object mask** with **SAM 3.1** instead of the older SAM2 + GroundingDINO pairing. Assessment: SAM 3 is the better fit. It is one model for both open-vocabulary text prompts and point/box prompts, it is **native in core ComfyUI** (`CheckpointLoaderSimple` → `CLIPTextEncode` → `SAM3_Detect` with optional `bboxes`, `positive_coords`/`negative_coords`, `threshold`, `individual_masks` → `MASK`; `SAM3_VideoTrack` for frames), so no extra node pack is needed (COMFYUI-RULES prefer core), and DEAS already detects SAM 3 checkpoints by header (`sam3` family in `builtin.json`, no pipeline yet). SAM2 (Apache-2.0) + GroundingDINO needs two custom node packs and two models for the same result. Limits to keep: text prompts max 32 tokens (comma-separated subjects, `:N` caps detections); weights (`sam3.1_multiplex_fp16.safetensors`, Comfy-Org/sam3.1) are under the custom **SAM License**, not Apache-2.0 (redistribution must ship the agreement; trade-control/prohibited-use terms) → license inventory and explicit download consent before any catalog entry or bundling; VRAM/latency on the target GPUs is unmeasured.
2. **Select all similar colour** (non-contiguous variant of the wand), frontend only.
3. **Edge stop** (Sobel/gradient barrier) for soft gradients where colour tolerance leaks, frontend only.

Acceptance for SAM masking:
- [ ] Recipe `sam3-mask`: source image (input/`[output]` naming as today) + text and/or points/box → mask PNG returned through the existing job/output path and inserted as a new editor mask layer (never overwriting existing masks); both compilers and `recipe_prerequisites` list `SAM3_Detect` and the SAM 3 checkpoint.
- [ ] Editor UI: prompt field plus click/box tool on the picture; points mapped through the same source-pixel transform as the brush; threshold/individual-mask controls only where the node reads them.
- [ ] Missing model/node shows the download/install path, not a silent no-op; real run on the owned backend with measured time/VRAM; video tracking (`SAM3_VideoTrack`) is a separate later row.

**Image/video prompt references (SwarmUI-style):** share the reference model planned in [VIDEO-PLAN.md](VIDEO-PLAN.md) W1/W2 (one pick/mark/edit flow for video and image references). drag or paste images (and, where the model supports it, video/audio) into the prompt box; they appear as reference chips and open an image-prompting group in the settings. Route per model family from family data, as SwarmUI does:
- Edit/reference models (e.g. Flux Kontext, Flux.2, Qwen Image Edit): pass the images directly through the family's own reference nodes; no extra switches.
- SDXL: ReVision (core CLIP-vision conditioning, strength slider) and optionally IP-Adapter, which needs the external `ComfyUI_IPAdapter_plus` pack and its models (explicit install/download consent, license and maintenance check first).
- Style models such as Flux Redux through core style-model nodes.
- MiniMax H3 already takes Director image/video references; reuse that contract for video/audio chips instead of a second path.

Acceptance:
- [ ] Prompt-box drop/paste of dock tiles and OS files; references stored in the immutable intent and shown in metadata; unsupported families explain why instead of ignoring references.
- [ ] Per-family compiler paths in both compilers with prerequisite checks; one real run per advertised family/technique.
- [ ] Distinct from Prompt Forge vision input (that writes text; this conditions generation).

### 3.6 Regional prompting for image generation

**Status: planned, not implemented.** Generate images with different prompts assigned to user-defined regions, rather than applying every subject/style description to the entire image. This is generation conditioning, not Prompt Forge vision input, painting pixels, or merely restricting where inpainting repaints.

**Smallest first slice:** opt-in regions for image generation, with SDXL as the first verification target. Keep the global positive/negative prompts for scene-wide context. Each enabled region has a name, its own positive prompt, an optional negative prompt, a strength (proposed default 1.0), and an explicit rectangular area or painted mask. Draw, select, move, resize and show/hide region guides on the generation canvas; distinguish guide visibility from whether a region participates in Run. Disabled regions are omitted. Preserve overlapping regions as weighted conditioning, not image-layer order or a promise of perfectly isolated subjects. With no enabled regions, preserve the existing graph and output behavior.

**Implementation sequence / acceptance:**
- [ ] First prove a minimal two-region SDXL recipe on the owned backend. Inspect the running backend's node schemas; core candidates present in the inspected local `ComfyUI/nodes.py` are `CLIPTextEncode`, `ConditioningSetArea` / `ConditioningSetAreaPercentage`, `ConditioningSetMask` and `ConditioningCombine`. Node presence is not model/quality acceptance. Compare a fixed-seed global-only baseline with left/right regional descriptions and record actual placement, leakage, latency and peak VRAM before advertising support.
- [ ] Add optional typed region data to `src/lib/execution.ts` and native validation/compilation in `src-tauri/src/jobs.rs`; declare actual required nodes in `src-tauri/src/recipe_prerequisites.rs` and supported families in `src/families/builtin.json`. Validate finite strengths, bounded prompt/region/mask payloads, nonempty in-bounds geometry and uploaded-mask identities. Gate unverified families or unavailable nodes with an explanation; never silently ignore selected regions or claim universal DiT/video support.
- [ ] Add a small regional-prompt editor through `src/features/studio/Workbench.tsx` and the existing canvas/geometry helpers in `StudioImageEditor.tsx` / `imageEditor.ts` (or one focused region component). Text-to-image must have an output-sized canvas without requiring a base image. Keep region conditioning masks distinct from inpaint masks and coloured image-layer strokes; explicit copying of an existing mask creates an independent region mask, not a live alias.
- [ ] Define coordinates against the intended generation canvas and map them consistently through zoom/pan, resizing, crop-inpaint and refine/upscale. Test transforms rather than reusing source pixels as latent coordinates. Only expose combinations whose conditioning remapping is implemented; explain unsupported combinations before Run.
- [ ] Snapshot region prompts, enabled state, geometry/masks and strengths before asynchronous uploads. Preserve the draft across tab/edit-mode switches; expose effective regions and deferred mask uploads in `src/features/studio/RunPlan.tsx`, job metadata and supported preset/project serialization. Region edits during upload must affect only the next job.
- [ ] Add compiler parity/regressions in `tests/execution.test.ts` and `src-tauri/src/jobs_tests.rs`; UI tests for add/edit/remove, guide visibility versus enablement, empty/disabled regions, overlaps and geometry. Add real browser mask/coordinate/snapshot checks, missing-node and image-load failures, and unchanged no-region graphs. Verify user-visible failures reach the shared Logs path.
- [ ] Accept each advertised image family separately with a real generated artifact and placement/quality/resource evidence; Linux/WebKitGTK and Windows/WebView2 interaction remain separate gates. Update all six locales, `docs/STUDIO.md`, `docs/PROMPTING.md` and verification evidence when implemented. Video regional prompting, automatic segmentation and new attention/custom-node dependencies are outside this first slice; SAM-assisted masks can reuse §3.5 only once that path is implemented and accepted.

### 3.7 Image editor: source frame for outpainting and full-size image drop

**Status: planned, not implemented.** Owner request.

**Source frame.** In Inpaint, draw the original image resolution as a thin, low-contrast border on the canvas. The frame stays fixed while the image can be moved partly outside it. The frame is the processing area: the job only uses what lies inside it. Uncovered parts of the frame become the area to outpaint, and image pixels moved outside the frame are not sent. With the image still covering the whole frame, the existing inpaint graph and output stay unchanged.

**Drop import at original size.** Dragging an image into the editor view currently inserts a tiny layer. `Workbench.tsx::insertLayer` scales every insert to at most a third of the source width (`source.width/3`). A dropped image should be inserted at its original pixel size, centered on the drop point, and scaled down only when it exceeds the 8192 px limit.

Acceptance:
- [ ] The frame is drawn at the source resolution and follows zoom/pan. It can be told apart from layer and mask outlines, and it is not burned into the output.
- [ ] Moving the image changes only what the frame covers. The job input is cropped/padded to the frame, and frame areas the image does not cover get an outpaint mask through the existing crop-inpaint-composite path in both compilers. Coordinates are mapped through the same source-pixel transform as the brush.
- [ ] Dropped images keep `naturalWidth`/`naturalHeight` (capped only at 8192 px). Inserts from the dock and from OS files behave the same way, and the existing four-layer limit and error messages still apply.
- [ ] Regressions in `tests/execution.test.ts` and `src-tauri/src/jobs_tests.rs` for frame crop/pad and outpaint mask, and UI tests for frame drawing and full-size insert. A real inpaint/outpaint run on the owned backend. Update `docs/STUDIO.md` and the six locales where new text is added.

## 4. Remaining plugin-platform work

Today `PluginManifest` contains identity/parent/text/node/include/suggest metadata. `validatePlugins` checks duplicate IDs, missing parents and cycles. Operational panels and native commands are wired explicitly; adding a manifest alone cannot install or run a new implementation. Data catalogs, families and locales are more extensible, but are not an executable-plugin trust boundary.

- [ ] Extend the smallest existing contract needed by the first real new plugin: stable schema/version, dependencies, capabilities/platforms, permissions, lifecycle, settings/locales and tests.
- [ ] Keep shared services minimal: native filesystem/auth/download/jobs/assets/runtime primitives; feature-owned domain behavior stays outside the kernel.
- [ ] Introduce durable project/asset/recipe/job identities and immutable revisions before claiming restartable multi-pipeline editing.
- [ ] Add shared job scheduling and scoped cancel/recovery. Current session-held jobs/H3 sequencing are not persistent multi-plugin scheduling.
- [ ] Implement post-setup feature add/remove/update without resetting projects; installed means included, readiness remains separate.
- [ ] Stage backend/plugin updates and validate before switching; implement rollback/migrations instead of calling in-place venv replacement rollback.
- [ ] Define trusted built-in versus untrusted extension boundaries before loading downloaded executable/UI plugins.

## 5. Delivery order and exit criteria

Each item is a bounded workstream, not authorization to perform downloads, service changes, training or a broad rewrite now.

1. **Stabilize current video slice.** Resolve the recorded native playback crash/audio uncertainty, verify safe video transfer/export, and add regression fixtures plus native Linux evidence; repeat on Windows. Audit existing saver wrapping and private H3 continuity keys for coexistence/version drift.
2. **Finish job/asset contracts.** Scoped cancellation, durable asset/job identity, recovery and a first project revision contract; keep external jobs/services untouched. Accept one complete model-specific image/video path, with real output/quality/resource evidence. H3 generation evidence is already present but not the whole path.
3. **Extract/reuse native compare/player behavior.** Start from the real Rust/libmpv reference; establish shared runtime/probe/media contracts and target-platform playback before expanding the editor.
4. **Add assembly as a small Rust plugin.** Source ordering/layout/stream validation, safe encoding/audio and output publication first; then temporal montage/trims through the shared project domain.
5. **Add TrueVideoEnhancer profiles.** Rust orchestration plus narrowly justified isolated inference workers; accept one real composable path before broad AI/vendor combinations.
6. **Add TrainFlow profiles.** Dataset/config/cache/train/artifact vertical slice for one profile first; then other profiles, normalization/tagging and verified resume. Preserve per-profile capability differences.
7. **Generalize the editable planner and intelligent presets from real consumers.** Dependency invalidation, review points and mix-and-match validated stages; transparent recommendations, immutable effective settings and opt-in measured resource scheduling. Do not add speculative abstraction ahead of functioning slices.
8. **Broaden verified packs and distribution.** Complete installer gaps, feature lifecycle, rollback/security/license review, performance baselines, fresh-machine Linux/Windows tests and signed/update-verifiable releases. More model/accelerator modes are separate acceptance rows, not inherited support.

## Documentation migration follow-up

The brief root README now links to [the documentation index](README.md). User guides cover setup, Backend/settings, Studio/docks, prompting, media, Library/auth, Comfy and Logs. [Changelog](CHANGELOG.md), [News](NEWS.md) and [Credits](CREDITS.md) live under `docs/`; the complete old version history is preserved and the root changelog is a compatibility pointer. New features/tabs must update their guide in the same change. The user authorized including the existing NVIDIA probe fix in this publication; local `.hermes/` planning state remains ignored rather than published. No version bump or tagged release is introduced.

## 6. How to maintain and verify this plan

For every completed item record source/test paths, exact tested revisions, platform/hardware/model/runtime, commands/outcome and unresolved limits in `VERIFICATION.md`; summarize the state here. Preserve old journal entries as history. Never promote source inspection, a form field, offline graph validation or a successful HTTP request to real inference/playback/training acceptance.

Executable changes use the project gates: frontend typecheck/tests/build; Rust tests/fmt/Clippy/build; relevant browser fixtures; actual native path; model/GPU and performance checks where needed. Check the Linux/Windows CI matrix, but do not claim a configured workflow passed without reading the relevant run. This docs-only update requires link/content/diff verification, not a release build or version bump.

Open release blockers include native video playback/audio, missing job-scoped cancellation/durable media domain, incomplete plugin lifecycle, unverified target-platform coverage and unresolved reuse/redistribution obligations. A source project's benchmark or existing binary is not DEAS acceptance.
