# DEAS — Dark Engine AI Studio

## Alpha vision and plugin roadmap

DEAS is an early-alpha all-in-one replacement for the owner's separate installer, generation frontend, prompting, training, enhancement, comparison and media tools. Most of the final product is not implemented. The intended Rust/Tauri application owns a complete image/video authoring experience, an editable end-to-end media planner, a player/organizer and optional backend/model/resource setup. Every feature belongs to a versioned plugin family; small trusted shared kernel services avoid duplicate runtimes, credentials and queues.

See [the all-in-one plugin roadmap](PLUGIN-ROADMAP.md) for the mapping of DaSiWa-TrainFlow, TrueVideoEnhancer, ComfyUI-DaSiWa-Nodes, PromptForge and simple-video-compare, plus the additional editor, library, automation and model-pack plugins. Existing implementations are foundations, not completed ports of those projects. Checked entries below require verified acceptance; roadmap targets remain unchecked.

**Post-setup rule:** optional features, backends and resource packs can be installed later from the same UX. Successfully installed components are included automatically; there is no second enable step. Backend process start and per-recipe readiness remain separate. The first-run wizard must never be the only route to installation. Preserve projects, existing outputs and unrelated external environments when extending the studio.

## Product contract
A lightweight Rust/Tauri desktop application with a React/TypeScript single-page studio. Neural feature blobs are clickable and connected by meaningful parent-child edges. Selected features expand their controls in the page; no modal maze or conventional dashboard replaces this visual model.

The final product provisions ComfyUI through a native Rust installer ported from the Go DaSiWa installer. No external Go installer application or sidecar is bundled. ComfyUI is the baseline; Director is one explicit package selection including Prompt Forge, RefMods, Continuity and Output. The default setup is automatic-first: read-only findings produce conservative editable recommendations and one brief plan summary, with explicit final Start install consent instead of repeated per-step questions. The earlier guided confirmation flow is an optional fallback, not the default. Recommendations use translated badges only, without connection lines or automatic activation. All UX text uses decentralized language resources and data-only language plugins. Python/PyTorch remain the execution engine; existing installations and services are never implicitly modified or stopped.

## Execution-only backend ownership

DEAS owns feature selection, inputs/settings, media, validation, queue/progress and output playback/export. ComfyUI only receives and executes dynamically compiled API-format jobs; its internal computational nodes are not the source of DEAS UI controls. No embedded ComfyUI editor, node widget forms or node-side previews. Prefer a verified SDK/API adapter with explicit local endpoint binding; retain a separate classic API adapter when v2 is absent. SDK availability, beta proxy requirements, job/output ownership and safety gates are specified in [EXECUTION-CONTRACT.md](EXECUTION-CONTRACT.md).

Implemented bounded slice: native-owned diagnostic recipe prerequisites and a DEAS-owned compile preview. Check required built-in nodes and exact checkpoint/sampler/scheduler choices through an explicit read-only core API probe; compilation is not model-load, architecture or generation acceptance. Next: correlated submission/assets and a real Director recipe. Explicit owned lifecycle, read-only API negotiation and a pure diagnostic recipe compiler are implemented. No automatic service start, cloud fallback or assumption of generation readiness.

## Milestones and acceptance checklist

### M0 — Repository and architecture
- [x] Create project directory and local main branch.
- [x] Publish the alpha source repository on GitHub.
- [x] Define frontend, desktop, installer and ComfyUI ownership boundaries.
- [x] Delegate UI, native shell and adapter/registry work independently.
- [x] Integrate and independently verify the first implementation.

### M1 — Executable neural studio foundation (current scope)
- [x] React/TypeScript/Vite application builds and typechecks.
- [x] Neural blobs show feature hierarchy and expand controls inline.
- [x] Keyboard navigation, responsive layout and reduced motion work.
- [x] Trusted built-in plugin manifests describe features and drive hierarchy.
- [x] Manifest validation rejects duplicates, missing parents and cycles.
- [x] Explicit user action inspects ComfyUI node/device/capability data (HTTP fixtures verified; live endpoint unavailable).
- [x] Connection failures are actionable; no fabricated readiness or generation.
- [x] Rust/Tauri desktop shell compiles with bounded read-only backend access.
- [x] Frontend and Rust tests pass.
- [x] Browser interaction checks and screenshot complete.
- [x] Native binary launches independently of development browser.

### M1b — Reusable neural paths and setup decisions (implemented)
- [x] AiO installer is the initial and first visible feature blob.
- [x] Opening a decision spawns all available alternatives, arranged vertically.
- [x] Historical M1b behavior: choosing an alternative revealed the next decision; the confirmation revision below supersedes this.
- [x] Changing an earlier decision invalidates incompatible later choices.
- [x] Shared NeuralBlob, NeuralPath and NeuralGraph atoms replace duplicated shapes and connector math.
- [x] Stable node/edge IDs support reuse, references and tests.
- [x] Roads indicate direction with gentle sequential illumination or moving cat pawprints.
- [x] Animation preferences and prefers-reduced-motion provide static alternatives.
- [x] Setup produces a validated local plan; no fabricated installation or readiness.
- [x] Existing-backend route hands off explicitly to read-only inspection.
- [x] Unit, browser and native rendering checks pass after refactoring.

### UX confirmation and included Director package (current work)
- [x] Every setup selection remains on the current step until explicit Confirm & continue.
- [x] Detected backend preselection must still expose optional attention/media controls and require confirmation.
- [x] History/step heading clicks cannot bypass a pending decision or its extra options.
- [x] Recommendations render localized labels only; no Suggested roads or legends.
- [x] Director is one selectable package including Prompt Forge, RefMods, Continuity and Output.
- [x] Included features are passive reusable microbubble atoms, not independent choices or readiness claims.
- [x] Native plans expand Director into its included native feature IDs before separate installation consent, without writing targets.
- [x] Verify locale/draft roundtrip, five browser widths, history/selection/confirmation, native rebuilt rendering.

### Stable controls refinement
- [x] Historical shared green viewport-anchored button; latest revision below moves it to the selection area.
- [x] Hover/focus/selection change visibility and colour only, with stable natural help/badge slots.
- [x] Remove history transform/recede movement, retaining opacity and optional road motion.
- [x] Verify geometry and CTA placement at five widths, all frontend gates, native release build and launch.

### Selection-area CTA and backend continuation (current work)
- [x] Green confirmation footer at the lower-right of the current selection/control area, not the viewport corner.
- [x] Preserve stable hover/focus/selection geometry, shared button identity and input form submission.
- [x] Review execution-only backend plan against official SDK/API docs; all feature inputs/outputs remain DEAS-owned.
- [x] Explicit owned backend start/status/stop after successful approved native provisioning.
- [x] Verify actual local-fixture API responses, process identity, timeout/failure/shutdown and foreign-service isolation; full ComfyUI stack acceptance remains open.
- [x] Integrate localized frontend lifecycle actions; retain generationReady:false until recipe acceptance.
- [x] Rebuild and independently test native/UI/browser gates: 38 core/73 UI/46 Rust, four browser suites down to 320px, release/native rendering.

### Automatic-first setup and later machine optimization
- [x] Native read-only defaults recommend a compatible backend and a new environment beside the running executable; no writes or downloads. Tests cover failed/incompatible detection and existing-target preservation.
- [x] Show brief findings and an editable plan; directory, backend, package, attention/media flags and source ref remain editable before final Start install.
- [x] Any edit invalidates the prepared immutable plan; late discovery cannot overwrite manual/restored values, and final Start install cannot submit a stale request.
- [x] Preserve old drafts and existing-backend inspection; keep unknown/unsupported hardware and selected-option blockers visible.
- [x] Verify automatic defaults, no writes before final consent, collisions, native IPC, locales and responsive UI; rebuild the native artifact. Browser native-start checks use IPC fixtures; real native defaults/rendering are separately verified.

### Installation-to-studio continuation (0.1.3)
- [x] Reveal the studio after successful native installation of the exact approved plan; no extra Explore/enable action for Director or its included components.
- [x] Bind the studio automatically to the actual running owned backend endpoint, once per endpoint/lifecycle; preserve explicit Start/Stop and do not auto-inspect, submit or claim generation readiness.
- [ ] Complete the diagnostic classic execution slice: explicit job submission, correlated progress/cancellation, validated output retrieval and DEAS playback/export.
- [ ] Verify a consented real model job separately before marking any generation recipe ready.
- [ ] Support ownership-verified reopening after app restart; saved setup drafts alone cannot authorize environment adoption.

### Diagnostic classic job transport (0.1.4, implemented bounded slice)
- [x] Revalidate the explicit versioned diagnostic intent natively against fresh core prerequisites; store an immutable native endpoint/graph plan.
- [x] Require separate unchecked consent and explicit Run; submit once through classic POST prompt, retaining uncertain transport outcomes instead of retrying silently.
- [x] Track only the returned prompt/client/graph identity through bounded history/queue reads; expose real queued/running/failed/completed/unknown states and validated output metadata.
- [x] Keep active job identity independent of draft edits and recover the native-held job explicitly after panel navigation; no global interrupt/queue clear, media transfer or generation-ready claim.
- [x] Verify real local HTTP transport fixtures, explicit frontend IPC controls, six locales/responsive browser rendering and the native release artifact.

### Diagnostic PNG output transfer (0.1.5, verified stopping point)
- [x] Retrieve only indexed validated outputs of the current succeeded native job, with bounded nonredirecting PNG transport.
- [x] Fully decode with CRC/dimension/allocation checks; preserve original bytes and SHA-256 in one bounded session cache.
- [x] Add explicit local-Blob preview and native Save As export of the cached original, with cancellation and stale/unmounted-result safeguards.
- [x] Export only new files through an explicit native chooser; reject clobbering, unsafe parents and symlinks, preserving original bytes.
- [x] Verify HTTP/PNG/filesystem fixtures, explicit IPC/browser paths, six locales at five widths and native release rendering.

**Paused by owner after this verified slice.** Resume instructions: [NEXT-SESSION.md](NEXT-SESSION.md). No further features, model downloads or real generation attempts were started.

### Simplified automatic setup and media start page (0.1.6)
- [x] Automatic setup asks only for the storage folder and the optional Director package; backend, optional packages and Git ref live under Advanced options. The native plan is prepared automatically after each edit; Start install stays the single explicit authorization and shows a one-line summary with full details collapsed.
- [x] Studio start page with top tabs (Video, Image, Workspace map) and a media library side panel: native read-only folder listing with symlinked folders, OS drag & drop (paths) and browser drag & drop (files), image/video/audio preview through the asset protocol. The library is registered as the `media` plugin; `plugin`-kind entries mount as panels, not as graph nodes.
- [ ] Native click-through of the media library (asset preview, OS drop) is unverified; only listing, scope semantics and browser rendering are tested. Video/Image tabs hold no inference yet.

### Single-path setup, credential bubble and categorised downloads (0.1.6)
- [x] Removed the manual step-by-step installer, draft save/restore and the collapsed downloads disclosure. Setup is one automatic path; an existing backend address lives under Advanced options.
- [x] Provider authorization and Optional downloads are always-visible bubbles below the setup. Downloads are grouped by ComfyUI model folder (checkpoints, diffusion_models, loras, …, workflows) as preview cards generated from catalog data; the bundled `src-tauri/downloads/darksidewalker.toml` lists all 22 current CivitAI checkpoints, LoRAs and workflows of the owner with preview media. CivitAI search (`scope = "search"`) returns previewed models; opening one lists its files with previews and ComfyUI category.
- [x] Managed installs receive files in place: a plan with an empty folder name stages into the existing `ComfyUI/models/<category>` (or `user/default/workflows`) folder, still creating files exclusively and never overwriting; no manifest is written there. Choosing a parent folder (optional new subfolder) overrides the destination.
- [ ] CivitAI downloads of the owner's models require a configured CivitAI token (creator setting); anonymous browse works. Live token download and `.mp4` preview rendering in WebKitGTK are unverified.

### Planned later — machine capability scan and optimization mode
- [ ] Add a separate opt-in capability/optimization scan for the actual target machine, not the development host.
- [ ] Record CPU/ISA/core count, RAM, GPU identity/VRAM/driver/compute capability, available storage, supported runtime/attention/codec capabilities and competing resource use. Distinguish measured data, compatibility rules and recommendations.
- [ ] Propose supported ComfyUI launch parameters, memory/offload policy and optional attention/media choices from a versioned capability profile; keep every proposed value editable.
- [ ] Offer explicit bounded smoke/benchmark probes only with consent; no automatic model downloads, external-service shutdown, system tuning or unverified hardware support claims.
- [ ] Persist the accepted profile and exact launch arguments with the immutable plan; invalidate/recheck changed hardware/runtime and provide a conservative fallback.
- [ ] Verify opt-in scan failures, stale evidence, manual overrides, rollback to conservative defaults and performance benefit on real target hardware. This mode is planned, not implemented by basic read-only default recommendations.

### M2 — Managed AiO setup
- [x] Implement native Rust uv/Python/ComfyUI baseline for Linux x86_64 CPU/NVIDIA; Go remains a read-only reference.
- [ ] Reach full Go parity: AMD/Intel, attention extensions, FFmpeg, models/workflows and target-platform setup.
- [x] Expose immutable native plans, explicit confirmed execution, status and owned-process cancellation.
- [x] Select capabilities explicitly; baseline planning/execution needs no extra feature.
- [x] Verify complete new CPU/NVIDIA ComfyUI installation through the real Engine, framework computation, owned API readiness and stop; no model generation claim.
- [x] Verify selected Director-nodepack dependencies, actual required node registration and owned API lifecycle on NVIDIA. Missing selected nodes block install completion.
- [x] Show Suggested metadata without silently enabling features; the label-only revision below supersedes the original paths.
- [x] Decentralize static UX/menu resources and provide validated German, English, Turkish, French, Simplified Chinese and Japanese language plugins, with native names and ISO selector suffixes; raw technical output is preserved.
- [x] Migrate old local drafts without implicit feature activation.
- [ ] Bootstrap Git or remove the external Git prerequisite safely.
- [x] Validate new targets, platform, NVIDIA identity/driver/capability and unsupported choices before execution.
- [ ] Add free-space estimates, multi-GPU selection and AMD/Intel preflight.
- [ ] Define tested functional packs and exact required nodes/model files.
- [ ] Track licenses and gated-download consent without accepting secrets in chat.
- [ ] Required-component failures prevent Ready; optional failures explain fallback.
- [ ] Verify GPU computation, backend startup, node availability and pack requirements.
- [ ] Make downloads resumable and integrity checked.
- [ ] Handle interrupted setup, repair and storage relocation.
- [ ] Keep launch read-only except starting the app-owned backend; never stop unrelated processes.

### M2b — Declarative optional downloads and authentication plugins
- [x] Data-only TOML catalogs describe optional models/files/presets/workflows and provider metadata; native validation feeds UX automatically, including explicit additive session imports.
- [x] Explicit dynamic user/repository browsing for HF, Civitai and GitHub, plus read-only Ollama discovery and generic configured HTTPS downloads; adapter fixtures, not live provider acceptance.
- [x] Independent optional token plugin: exact-origin native session storage, anonymous default, metadata-only reads, clear/remove and no credentials in drafts/catalogs/logs.
- [x] Immutable native download plans, separate consent, safe new destination, real streamed status, digest checks and owned cancellation; Linux scratch byte/file fixtures verified.
- [x] Add inline AiO/studio plugin access, decentralized locale resources and token/privacy/selection/consent regression tests.
- [x] Implement explicit optional OS-keyring persistence/restore without plaintext fallback; injected-vault tests only, real OS-store operation unverified.
- [x] Exercise final frontend/native build gates and six-language browser rendering down to 320px; rebuilt native initial rendering verified, interactive plugin IPC remains fixture coverage.
- [ ] Managed-environment placement, resumable transfer, real authenticated provider/vault acceptance and explicitly approved Ollama pulls remain separate work.

### M3a — Diagnostic recipe prerequisites and compile preview (implemented)
- [x] Explicit native read-only core `object_info` probe on the selected endpoint; bounded transport, no redirects/proxy/cloud fallback and no writes.
- [x] Extract exact checkpoint, sampler and scheduler identities; report missing built-in nodes and reject malformed or unsafe choice lists without normalizing identifiers.
- [x] DEAS-owned diagnostic controls compile only against observed prerequisites; missing nodes/models block compilation and endpoint edits discard stale evidence.
- [x] Verify real HTTP fixture transport, frontend IPC fixtures, six locales and responsive rendering; distinguish compile preview from model architecture/load and generation acceptance.

### M3 — Director vertical slice
- [ ] Complete negotiated SDK/v2 and classic execution adapters; explicit endpoint/no cloud defaults, no ComfyUI editor dependency.
- [x] Native read-only v2/classic negotiation with explicit endpoint, bounded real HTTP fixtures, distinct failures and localized desktop action.
- [x] Versioned pure diagnostic text-to-image compiler with explicit capability/model allowlists and deterministic built-in graphs; not a Director recipe.
- [ ] Compile versioned DEAS feature intent dynamically to internal API graphs, not mirrored node-widget forms.
- [ ] Own input asset upload, correlated job status/cancellation and verified output download in DEAS.
- [ ] Media import, reference labels, trim and serialization.
- [ ] Model/VAE selection and validated execution recipes.
- [ ] Prompt Forge streaming/cancel/review/apply.
- [ ] RefMods and continuity including source pinning and publishing successful exports.
- [ ] Queue, progress, cancellation and actionable node errors.
- [ ] Playback and original-file export tested in the actual native webview.
- [ ] Existing workflow/reference-pack roundtrip migration tests.

### M4 — Plugins and safe updates
- [ ] Versioned studio SDK with declared nodes, permissions and compatibility.
- [ ] Declarative recipes first; untrusted UI extensions isolated explicitly.
- [ ] Separate app, installer, backend, nodepack and plugin versions.
- [ ] Stable and experimental channels with compatibility checks.
- [ ] Stage backend updates in a new environment and support rollback.
- [ ] Preserve projects/models/media across updates and uninstall.

### M4b — Feature manager and shared project/media domain
- [ ] Define versioned plugin manifests: dependencies, permissions, resource packs, backend/model capabilities, locale references and project migrations.
- [ ] Reopen installation after setup; add/remove/update optional plugins without resetting the studio or projects. Installed components need no separate enable action.
- [ ] Distinguish available, installed, verified and job-ready plugin states; installed components are included automatically.
- [ ] Shared project/asset library with immutable revisions, metadata/provenance, collections, tags and search.
- [ ] Native media player, thumbnails and reusable compatibility proxies; preserve originals.
- [ ] Shared GPU/job scheduler and isolated runtime profiles where dependency stacks conflict.

### M4c — Editable end-to-end planner and image/video editors
- [ ] Versioned project/shot operation graph: import → prompt → generate → review → edit → enhance → assemble → export.
- [ ] Allow editing/replacing intermediate assets at any time; invalidate only dependent results and retain completed branches.
- [ ] Keep running submissions immutable; draft changes produce a new revision and explicit cancel/re-run decisions.
- [ ] Non-destructive image crop/resize/masks/layers, crop-inpaint-composite and model-specific instruction editing.
- [ ] Video/audio timeline, trims/splits, shot assembly, transitions, overlays and export.
- [ ] Review/pause/resume points, batch execution where supported and recovery after interruption.
- [ ] A/B image/video comparison and synchronized playback/scrubbing using shared media/proxy services.
- [ ] Validate editing, comparison, codecs, audio and original export in the actual native webview.

### M4d — Enhancement, training and nodepack capability ports
- [ ] TrueVideoEnhancer plugin: verified upscaling/multi-pass/interpolation workers, tiled/memory safeguards, previews and cancellation.
- [ ] TrainFlow plugin: profile-specific LoRA/applicable LoKr/textual inversion, dataset prep/tagging/captions, previews and state resume.
- [ ] Publish trained models and enhancement outputs to the shared library with provenance, never automatic overwrite.
- [ ] Port most nodepack behavior into task plugins: sizing/resize, LoRA stacks, image/video saving, watermark and inpaint compositing.
- [ ] Prompt/preset/seed services, LLM/VLM analysis, resource telemetry and opt-in model-scoped optimizations.
- [ ] Rebuild Rust/Tauri orchestration and DEAS controls; retain appropriate Python computational workers, not legacy Go app UIs.
- [ ] Audit upstream licenses, code reuse and model/SDK redistribution obligations before integration/distribution.

### M4e — Model packs, backend adapters and automation
- [ ] Tested image-family adapters: checkpoint SD/SDXL/Pony/Illustrious, Anima, Krea, Qwen Image/edit and additional verified families such as FLUX.
- [ ] Tested video-family adapters: MiniMax H3, LTX and Wan; more families through the same recipe/pack contract.
- [ ] Per-pack architecture/runtime/node/model/encoder/VAE/LoRA declarations, hardware bounds and license gates.
- [ ] Prompt Forge reusable standalone/Director assistance with distinct model dialects, reference analysis and review/apply.
- [ ] Explicit local LLM/VLM backend adapters for Ollama/OpenAI-compatible services; no implicit cloud fallback.
- [ ] Automated planning suggestions and repeatable presets, with explicit approval for execution, cost or destructive changes.
- [ ] Add optional audio/speech/music packs only with separately verified execution backends.
- [ ] Private collaboration workflow with bounded plugin workstreams, shared contracts and reviewed tests; repository visibility/invitations require separate authorization.

### M5 — Distribution
- [ ] Native Windows and Linux builds exercised on their target OS.
- [ ] Signed artifacts and updater verification.
- [ ] Fresh-machine setup acceptance tests with no Python/Git installed.
- [ ] Offline restart after successful setup.
- [ ] Release binaries and beginner documentation.

## Explicit non-goals for M1
No automatic backend installation, model download, generation, arbitrary third-party executable loading, full graph-editor rewrite, public release, or remote push. M1 proves the shell, interaction model and discovery seam; it is not the completed AiO product.

## Design tokens and layout direction
Graphite #121719, panel slate #1c2427, mist #e4e9e5, muted stone #8d9b99, copper #ce9875, glacial blue #83b8c8. Organic feature shapes are the signature; connection lines encode ownership, not decorative wiring. App chrome remains quiet. Display typography uses a characterful local serif fallback; controls use readable sans-serif and technical details monospace. Actual implementation may refine these tokens but must preserve legibility and the single-page neural model.

## Integration boundaries
- Rust: desktop lifecycle, narrow native IPC, scoped native provisioning and owned-job cancellation.
- TypeScript: complete DEAS UX, versioned feature intent/recipes, draft state and SDK/API adapter contract; no ComfyUI frontend imports.
- Go installer repository: read-only behavioral/compatibility reference for native Rust porting.
- ComfyUI/Python: execution-only model loading, conditioning, sampling, processing and encoding; internal computational nodes are hidden implementation details.

All unfinished controls identify their status. Browser fixture data belongs only in tests. An HTTP response is not proof of generation readiness; an installed package is not proof of working GPU computation.
