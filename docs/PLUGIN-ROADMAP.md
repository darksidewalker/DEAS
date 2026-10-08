# DEAS — All-in-one plugin studio roadmap

## Vision and alpha status

DEAS should consolidate the owner's separate installer, generation, prompting, training, enhancement, comparison and media tools into one lightweight Rust/Tauri application with a cohesive DEAS-owned web frontend. It is an **early alpha**: most of this product is missing. Existing component tests and a working shell are not evidence of a complete installer, editor or generation pipeline.

The eventual experience is: set up the required backends, select optional features/resources, author a media project, execute it end to end, inspect results, edit at any intermediate stage and continue from the appropriate point. The app should automate repetitive technical work while keeping consent, costs, licenses, destructive actions and errors visible.

Every product feature is a plugin or plugin family. Shared runtime services remain a small trusted kernel rather than duplicate implementations inside every plugin. Setup is not a one-time gate: **installing, enabling, disabling and updating optional features must remain available after setup**, without reinstalling the app or discarding projects.

## Architecture and integration rules

- **Rust/Tauri kernel:** scoped IPC, project/asset storage, credential access, file dialogs, installation plans, download transport, resource scheduling and app-owned process lifecycle.
- **DEAS frontend:** one neural workspace with reusable feature blobs, ownership roads and inline controls. Plugins integrate with this surface, not separate dashboards, embedded legacy apps or ComfyUI widget panels.
- **Execution adapters:** ComfyUI for inference recipes; managed Python workers for training/enhancement/tagging; scoped FFmpeg/FFprobe for media; explicit Ollama/OpenAI-compatible services for language/vision tasks. Rust orchestrates; it does not replace Python/PyTorch model computation.
- **Data-first extensions:** validated TOML/JSON manifests, resource catalogs, model-family recipes, prompts and locale dictionaries. Adding ordinary resources or recipe metadata should not require frontend-specific code. New transport or computational behavior requires a reviewed adapter, not arbitrary executable manifest fields.
- **Plugin lifecycle:** available → selected → planned → installed → verified → enabled, with explicit blocked/failed/update states. Installed, enabled and generation-ready are different facts. A bundled dependency is installed once, even when several plugins use it.
- **Plugin contract:** stable ID/version, ownership, DE/EN labels, dependencies, backend capabilities, resource/catalog references, input/output domain schemas, project migrations, permission requests, hardware/platform limits and verification checks. Arbitrary third-party executable/UI plugins require a separate isolation and trust model.
- **Shared identities:** project, asset, recipe revision, model digest, job and output IDs connect all features. Plugins exchange validated assets and intentions rather than raw host paths or private widget state.
- **Runtime isolation:** conflicting Torch/TensorRT/training stacks may use separate managed environments. Never force every backend into the ComfyUI venv. Existing external services are connected only explicitly and are never implicitly stopped or updated.

## Plugin inventory and placement

Everything below is a target design unless an implementation is explicitly recorded in `PLAN.md` and `VERIFICATION.md`.

| Plugin family | Source/reference | Role in the DEAS workspace | Execution and shared dependencies |
| --- | --- | --- | --- |
| AiO setup and backend manager | DaSiWa ComfyUI Installer | Initial setup blob; later reopenable feature/backend installation controls | Native Rust provisioning, isolated Python, hardware preflight and owned lifecycle |
| Resource browser/downloads | HF, CivitAI, Git providers and configured HTTPS sites | Optional models, LoRAs, encoders, VAEs, files, presets and Comfy workflows; browse a user/repository and select resources | Validated TOML catalog, native provider adapters, resumable/integrity-checked transfer and resource registry |
| Authentication/accounts | Provider token plugins | Separate optional access controls; anonymous mode with visible limits; reusable after setup | Native exact-origin credentials; session storage and explicitly requested OS store; no tokens in project files |
| Generation/model families | ComfyUI and model-specific recipes | Image/video/audio generation controls, model/VAE/LoRA choice and local capability checks | Versioned recipes, Comfy execution adapter and verified model packs |
| Director | ComfyUI-DaSiWa-Nodes | Shot planning, reference media lanes, FL2VA/REF2VA authoring and model-aware constraints | DEAS media domain plus internal native Comfy computational nodes; no imported node frontend |
| Prompt Forge | PromptForge and nodepack prompt assistance | Brief-to-prompt, per-model dialects, reference-aware writing, streaming, review/edit/apply; reusable inside Director and independently | Explicit local LLM/VLM adapters, prompt/template libraries and optional taggers |
| RefMods and continuity | Director/nodepack and DEAS project domain | Reference labels, pinned source assets, continuity state, versioned successful handoffs between shots | Shared media/project registry and compatible recipe adapters |
| Image editor | Nodepack crop/inpaint/composite and PromptForge edit reference | Non-destructive crop/resize/masks, layers, inpainting/outpainting and instruction-based edits | Asset revisions, GPU recipe packs and deterministic local compositing where appropriate |
| Video editor | New DEAS authoring surface; Director and media tools as references | Timeline/shot assembly, image/video/audio lanes, trims, splits, transitions, overlays and editable intermediate results | Shared edit decisions, proxies, FFmpeg and model-specific generation/enhancement plugins |
| Video enhancement | TrueVideoEnhancer | Upscale and interpolation as standalone actions or planner stages, previews and cancellation | Managed Python workers, Spandrel/ONNX/TensorRT/RIFE as declared by each profile; bounded memory and encoding |
| Media comparison | simple-video-compare | A/B image/video results, synchronized playback/scrubbing and before/after evaluation | Shared player/proxy service, frame/time alignment, FFprobe metadata; originals remain untouched |
| Training and datasets | DaSiWa-TrainFlow | Dataset preparation, tagging/captions, training profiles, previews, checkpoints and resume; publish trained assets to the library | Managed sd-scripts/Musubi workers, profile-specific isolated dependencies and GPU scheduling |
| Media player and organizer | DEAS shared domain, compare/output references | Library, folders/collections, metadata/search, playback, thumbnails, tags, provenance and project linkage | Native asset access and compatible proxy playback; originals and exports remain separate |
| Output/export | Nodepack Metadata Image Saver and Enhanced Video Combine | Image/video/audio exports, codec/container controls, generation metadata, first/last frame assets and privacy controls | Scoped FFmpeg/encoders, output ownership and actual native-webview playback verification |
| Analysis and automation | Nodepack LLM/VLM Analyze and PromptForge analysis/tagging | Caption/tag/reference analysis, model-aware prompt assistance and suggested planner operations | Local HF/Transformers/GGUF or explicit language/vision servers; human review before applying changes |
| Telemetry and optimization | Nodepack System Monitor, H3 Cache and Kitchen Attention | Compact real resource health, budget estimates and opt-in compatible inference optimizations | Native read-only telemetry and model-scoped backend patches; no fabricated status |
| Localization and future extensions | Existing DEAS data-only language plugins | Consistent multilingual controls and discoverable optional plugin additions | Validated decentralized resources and versioned compatibility/trust contract |

The Director setup package may include Prompt Forge, RefMods, Continuity and Output while their shared services remain reusable by other plugin families. This does not make each included element a second mandatory setup choice or duplicate its backend installation.

## Reusing the requested projects

### DaSiWa-TrainFlow → training and dataset plugins

Use the existing profile/settings behavior as a reference for LoRA, applicable LoKr and textual-inversion training, auto-calculation, optimizer-aware defaults, previews, state resume, model metadata and dataset caption/tag/resize preparation. Initial families to investigate are Anima, SDXL/Pony/Illustrious, LTX, Wan and Krea. Preserve their differing supported options instead of applying one generic training form to every architecture.

Rebuild orchestration and controls in Rust/Tauri/DEAS. Reuse the appropriate Python training stacks rather than bundle the old Go trainer UI. Connect trained outputs and sampled previews to the same media/model registry used by generation. Do not inherit upstream performance or hardware support as DEAS verification.

### TrueVideoEnhancer → enhancement plugin

Plan native orchestration for real AI upscaling, model-scale-aware multi-pass processing, interpolation to supported target frame rates, tiled fallbacks, cache identities, bounded decode/process/encode streaming, audio/subtitle handling and actual previews/cancellation.

Its documented inference path is NVIDIA-first. AMD/Intel/CPU/HDR/restoration/scene-detection capabilities need independent adapters and tests; controls or accepted flags are not implementation proof. Resolve source documentation inconsistencies, including queue behavior, against code before porting. Separate TensorRT/training/Comfy dependency profiles where required.

### ComfyUI-DaSiWa-Nodes → domain features and internal recipe capabilities

Port most useful behavior, grouped by user task instead of copying the node canvas:

| Nodepack feature | DEAS plugin destination |
| --- | --- |
| MiniMax H3 Director/Guide | Director/media planner; model-specific recipes and reference constraints |
| H3 Cache and Kitchen Attention patch | Opt-in inference optimization profiles |
| RTX Upscaler & Refiner | Enhancement plugin with explicit NVIDIA SDK requirements |
| Resolution Scale Calculator and Torch Resize | Shared canvas sizing/crop/fit and media-preprocessing service |
| Advanced LoRA Loader | Shared model/LoRA stack controls with applicable visual/audio branches |
| Metadata Image Saver | Output plugin with provenance and privacy controls |
| Enhanced Video Combine | Media/export plugin, real encoder fallback and audio muxing |
| Watermark Overlay | Image/video editor overlay operation |
| Inpaint Crop Prep & Composite | Masked image editor and local-to-original compositing recipe stages |
| System Monitor | Shared compact native telemetry plugin |
| Random String Picker, Seed Control, Wildcard & Preset Prompt Builder | Reproducible prompt/seed/preset services used by authoring and batch recipes |
| LLM/VLM Analyze | Analysis/captioning/reference understanding plugin |
| Node Status Switch | Planner stage enable/bypass semantics, not control of a mirrored node canvas |

Node identifiers and workflow migration must be checked against current source. Downloading a workflow is not permission to execute it; importing one requires validation and a supported domain mapping or a clearly separate reviewed API-recipe import. Unsupported modes remain visible blockers.

### PromptForge → model-aware assistance plugin

Preserve per-model prompt dialects/templates, structured video sections, reference labels, tagger integration, backend/model switching and review/apply semantics. Generation/editing requests should use DEAS's shared execution/asset layer rather than a second PromptForge-owned ComfyUI queue. Training requests should use the shared training plugin.

The supplied GitHub URL was unavailable during planning; the local `/data/GitHub/PromptForge/README.md` supplied the feature reference. Its standalone user/accounts, deployment and monitoring design does not automatically become the desktop product architecture. Verify licensing and usable code/assets before porting; preserve authored prompt-library semantics rather than silently rewriting them.

### simple-video-compare → compare/player plugin

Reimplement native file selection/drop handling, two-source playback and metadata inspection within DEAS. Share pinned FFmpeg/probe provisioning and compatibility proxies with the player/editor instead of starting the old standalone Go server. Synchronized timeline/frame controls, split/wipe modes and image comparison are DEAS targets, not assumed verified features of the referenced repository. Test actual WebKitGTK playback and codec fallback, not just Chromium.

## End-to-end editable media planner

The planner owns versioned intentions and a non-destructive operation graph: import/reference → prompt/plan → generate → inspect/compare → edit → enhance → assemble → export. This is a project/shot graph, not a ComfyUI node editor.

- Every completed stage produces an immutable asset revision with provenance; edits create a new revision or branch.
- Users may change prompts, references, masks, trims, LoRAs, settings and operation order between stages. Recompute only invalidated dependent results; preserve unrelated completed assets.
- A running job keeps its immutable submitted recipe. Editing its draft creates the next revision, with explicit job-scoped cancel/re-run options rather than silently changing in-flight computation.
- Pause at review points, choose a result, replace an intermediate asset manually, resume downstream or run supported independent stages in batches.
- Track dependencies, resource budgets, GPU conflicts, model/runtime availability, progress, actionable errors, restart recovery and exports through one job contract.
- Generating, enhancement and training share scheduling but not necessarily a Python environment. Serial execution is the safe initial policy; concurrency requires measured resource budgets.

## Model support strategy

The ambition is coverage of common image and video model families, not a claim that arbitrary models work. Add tested adapters/packs incrementally: checkpoint-based SD/SDXL/Pony/Illustrious; Anima, Krea and Qwen Image/edit; FLUX where verified; MiniMax H3, LTX and Wan video; further families through the same plugin contract.

Each pack declares compatible backend/node/runtime versions, exact architecture, checkpoints/encoders/VAEs/adapters, resolutions/frame limits, supported generation/editing modes, licenses/gated resources and required acceptance tests. Keep offered, downloaded, installed, discovered, recipe-compatible and actually executed states separate. Add audio/speech/music packs where demand and verified backends justify them, without implying generic audio support from a video adapter.

## Delivery sequence and collaboration

1. **Alpha foundations:** finish current download/auth slice, stabilize installation ownership, local project/asset domain and reopenable feature management.
2. **First complete vertical slice:** one verified model pack, explicit resources, native upload/job/output transport and playback/export. Then a real Director shot from authoring through output.
3. **Editing and comparison:** library/player, basic non-destructive image/video edits, A/B evaluation and editable planner handoffs.
4. **Enhancement and training:** isolated workers/profile packs, dataset preparation, real cancellation/resume and resource scheduling.
5. **Broader coverage:** more tested model families, batch/automation, plugin SDK/security, updates/migration and target-platform distribution.

A private Git repository can support collaboration; creating it, changing visibility or inviting contributors requires explicit separate authorization. Contributors can own bounded plugin workstreams with shared domain/API contracts, test fixtures and small reviewed changes. Useful workstreams include Rust installation/downloads/auth, frontend neural UX/editors, model recipes/Comfy adapters, media/FFmpeg/WebKit playback, training/enhancement workers and cross-platform QA/docs.

Before reuse/distribution, inventory upstream code/model/media licenses and preserve required notices. TrainFlow is described as MIT; TrueVideoEnhancer and simple-video-compare as GPL-family projects. Confirm exact current licenses and compatibility before copying implementations; this roadmap chooses no new DEAS license and makes no legal clearance claim. Keep proprietary/gated models optional and do not redistribute credentials or licensed assets.

## References and evidence boundaries

- [DaSiWa-TrainFlow](https://github.com/darksidewalker/DaSiWa-TrainFlow): supplied repository README context.
- [TrueVideoEnhancer](https://github.com/darksidewalker/TrueVideoEnhancer): supplied repository README context; limitations retained.
- [ComfyUI-DaSiWa-Nodes](https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes): supplied README plus retrieved raw README; versions differ, so source verification precedes porting.
- [PromptForge](https://github.com/darksidewalker/PromptForge): supplied link unavailable; local README read as reference, not proof of public availability.
- [simple-video-compare](https://github.com/darksidewalker/simple-video-compare): supplied repository README context.
- [Implementation checklist](PLAN.md), [execution ownership](EXECUTION-CONTRACT.md), [download/auth contract](DOWNLOAD-PLUGINS.md), [verified state](VERIFICATION.md).
