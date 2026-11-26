# DEAS plan

[Documentation index](README.md) · [Project rules](PROJECT-RULES.md) · [Product decisions](PRODUCT-DECISIONS.md) · [Verification journal](VERIFICATION.md) · [Changelog](CHANGELOG.md)

The **single list of open work** for DEAS. Everything here is either not built yet or built but not yet accepted. Delivered work lives in the [changelog](CHANGELOG.md) and the user guides, evidence in the [verification journal](VERIFICATION.md), binding scope in [PRODUCT-DECISIONS.md](PRODUCT-DECISIONS.md), working rules in [PROJECT-RULES.md](PROJECT-RULES.md), [COMFYUI-RULES.md](COMFYUI-RULES.md) and [EXECUTION-CONTRACT.md](EXECUTION-CONTRACT.md). Earlier planning files (`IMPLEMENTATION-STATUS.md`, `VIDEO-PLAN.md`, `YUE2-MUSIC-PLAN.md`, `PLUGIN-ROADMAP.md`, `NEXT-SESSION.md`, …) remain in Git history only.

Working tree **0.3.28** (latest tag `v0.3.23`); 0.3.x is the feature phase after the 0.2.40 beta. Restructured 2026-11-19: every open item now has an ID, a type and its blockers; delivered narratives moved to [VERIFICATION.md](VERIFICATION.md#closed-plan-items-moved-from-planmd-2026-11-19) and the H3 Director reference facts to [COMFYUI-RULES.md](COMFYUI-RULES.md#9-h3-director-and-video-reference-facts).

## 0. How to work on this plan (read first)

### 0.1 Item format

Every open item is a `####` heading `ID · title`, followed by one metadata line and the original specification:

- **Type**
  - `FEATURE` — not implemented. Needs an explicit owner priority before any code is written.
  - `SLICE` — part of a shipped feature still needs code; the item says which part.
  - `ACCEPT` — code is shipped; only verification remains. No code is expected unless a gate fails (then the failure becomes a `DEFECT` row or a narrowed `SLICE`).
  - `DEFECT` — a reported or reproduced fault; reproduce before changing code.
  - `RESEARCH` — measurements/decisions must come before any implementation.
  - `DEFERRED` — out of current scope by owner decision; do not start.
- **Needs** — what must be available to close the item:
  - `CPU` — closable on the Linux dev host with code, unit/component tests, fixtures, offline graph validation.
  - `GPU` — a real model run on an **isolated** throwaway backend on a free port. Needs explicit owner GPU approval each time; never use or restart the owner's running services.
  - `NATIVE` — click-through in the shipped Linux app (`artifacts/deas-linux-amd64`, WebKitGTK/libmpv). KDE Wayland ignores XTest, so this often needs the owner at the desktop.
  - `WIN` — the real Windows WebView2 app on the Windows test host (see skill `windows-remote-testing`); a cross-build is not this.
  - `OWNER` — owner judgement, listening/viewing, media samples, artwork or consent.
  - `AMD` — real RDNA hardware. `UPSTREAM` — needs a separately authorized node-pack/Core change.
  - `PRIORITY` — owner must prioritize the item before work starts.
- Checkboxes `- [ ]` are the acceptance criteria. An item is done when all its boxes are ticked **and** moved out (0.3).

### 0.2 Picking work

1. An open row is **not** authorization. Work only on items the owner prioritized (section 2) or explicitly names. `ACCEPT` items with `CPU` need no extra priority when they only verify existing behaviour.
2. Read the item, then grep the named symbols before coding — rows can be stale (code may already exist). Report a stale row instead of re-implementing it.
3. Large items: split them in this file **before** coding (`UX-22a`, `UX-22b` …), each sub-row stating what is deferred.
4. Batch all `GPU` gates into one approved isolated-backend session (list in section 3) instead of scattering runs; batch `NATIVE`/`WIN` click-throughs the same way.
5. Follow the repository `AGENTS.md` and the `deas-development` skill for gates, version bumps and commits. Scope = request: plan edits are docs-only.

### 0.3 Finishing an item

When a slice lands or a gate passes, in the same change:

1. Evidence → [VERIFICATION.md](VERIFICATION.md) (commands, hardware, file pointers, measurements).
2. User-facing change → [CHANGELOG.md](CHANGELOG.md)/[NEWS.md](NEWS.md) and the guide (`STUDIO.md`, `MUSIC.md`, `LIBRARY.md`, …); implementation changes also get the version bump.
3. Here: tick nothing in place — **remove** the item (or the closed checkboxes) and narrow the remainder; update the index row in section 1. No delivered narratives stay in this file. A closed checkbox that still carries a caveat becomes a new, smaller `- [ ]`.
4. Never promote source inspection, a form field, offline graph validation or an HTTP success to real inference, playback or platform acceptance.

### 0.4 Evidence levels

An item is only as accepted as its strongest evidence. Keep the levels separate.

| Level | Meaning |
| --- | --- |
| Implemented, bounded | Code exists for the named slice; it does not mean the whole area is done |
| Fixture-verified | Unit/component/HTTP/Chromium fixtures or offline graph validation passed |
| Native Linux | Exercised in the real GTK/WebKitGTK (or libmpv) app on Linux |
| Real model | Actual model computation produced a checked artifact on named hardware |
| Windows runtime | Exercised in the real WebView2 app on Windows; a cross-build is not this |

### 0.5 Gates

- frontend: `npm run typecheck`, `npm run test:core`, `npm run test:ui`, `npm run build`, `npm run test:layout` (Vitest via `NODE_OPTIONS=--no-experimental-webstorage node node_modules/vitest/vitest.mjs run …` from `~/dev/DEAS`);
- native: `cd src-tauri && CARGO_TARGET_DIR=../.target cargo test --lib -- --test-threads=1`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` (your files only), `git diff --check`;
- video graphs: `cargo test --lib dump_video_graphs -- --ignored --nocapture`, then `tools/validate_video_graphs.py <json> --comfy-root <checkout> --extra-model-paths-config <yaml>` (node names, inputs and link types only);
- documentation-only changes need link/anchor/diff checks, not a version bump.

## 1. Open-work index

| ID | Item | Type | Needs | Area |
| --- | --- | --- | --- | --- |
| [V-01](#v-01--prompt-forge-selected-media-vision) | Prompt Forge selected-media vision | SLICE | CPU, GPU, NATIVE, WIN | §4.1 |
| [V-02](#v-02--multi-reference-auto-aspect-real-run-check) | Multi-reference Auto aspect real-run check | ACCEPT | GPU | §4.1 |
| [V-03](#v-03--animated-live-video-previews-enhanced-preview) | Animated live video previews (Enhanced preview) | ACCEPT | GPU, NATIVE, WIN, OWNER | §4.1 |
| [V-04](#v-04--continuity-enabledisable) | Continuity enable/disable | ACCEPT | NATIVE, WIN | §4.1 |
| [V-05](#v-05--replace-on-paste-for-references-w2b) | Replace-on-paste for references (W2b′) | ACCEPT | NATIVE, WIN | §4.1 |
| [V-06](#v-06--trim-editor-remainder) | Trim editor remainder | SLICE | CPU, PRIORITY | §4.1 |
| [V-07](#v-07--create-refmod-remaining-acceptance-w2e3) | Create RefMod remaining acceptance (W2e3) | ACCEPT | GPU, NATIVE, WIN | §4.1 |
| [V-08](#v-08--refmod-content-preview-and-media-recovery) | RefMod content preview and media recovery | FEATURE | PRIORITY, GPU, NATIVE, WIN | §4.1 |
| [V-09](#v-09--join-clips-and-h3-transitions-in-continuity) | Join clips and H3 transitions in Continuity | ACCEPT | GPU, NATIVE, WIN, OWNER | §4.1 |
| [V-10](#v-10--later-recipe-features-w6) | Later recipe features (W6) | FEATURE | PRIORITY | §4.1 |
| [V-11](#v-11--seamless-loop) | Seamless loop | ACCEPT | GPU, NATIVE | §4.1 |
| [V-12](#v-12--real-gpu-acceptance-of-video-recipes-w5) | Real GPU acceptance of video recipes (W5) | ACCEPT | GPU | §4.1 |
| [V-13](#v-13--experimental-dials-dial-rack--moss-imagekrea-2-dials) | Experimental Dials (Dial Rack) + MOSS-Image/Krea 2 Dials | ACCEPT + FEATURE | NATIVE, WIN, GPU, PRIORITY | §4.1 |
| [V-14](#v-14--learned-latent-upscale) | Learned latent upscale | ACCEPT | GPU | §4.1 |
| [V-15](#v-15--h3-native-sampling-and-conditioning-optimization-h3o) | H3 native sampling and conditioning optimization (H3O) | RESEARCH | PRIORITY, GPU, UPSTREAM | §4.1 |
| [V-16](#v-16--h3-hi-res-regenerate-open-h3-regenerate-2k) | H3 Hi-Res Regenerate (Open-H3-Regenerate-2K) | ACCEPT | GPU, NATIVE, WIN | §4.1 |
| [V-17](#v-17--h3-input-scaling-auto-vs-fill-and-crop-real-run-check) | H3 input scaling: Auto vs Fill and crop real-run check | ACCEPT | GPU | §4.1 |
| [V-18](#v-18--videoaudio-playback-acceptance) | Video/audio playback acceptance | ACCEPT | NATIVE, WIN | §4.1 |
| [P-01](#p-01--tve-stages-on-the-owned-backend) | TVE stages on the owned backend | ACCEPT + SLICE | GPU, CPU | §4.2 |
| [P-02](#p-02--memory-bounded-video-decodingexport-and-optional-ssd-staging) | Memory-bounded video decoding/export and optional SSD staging | SLICE | GPU, CPU | §4.2 |
| [P-03](#p-03--h3-automatic-whole-video-face-refinement) | H3 automatic whole-video face refinement | SLICE + ACCEPT | GPU, NATIVE, WIN, OWNER | §4.2 |
| [P-04](#p-04--h3-de-rope) | H3 de-rope | SLICE + DEFECT | GPU, OWNER | §4.2 |
| [P-05](#p-05--pp1--image-runtime-acceptance-and-video-ordering) | PP1 — image runtime acceptance and video ordering | ACCEPT | GPU, NATIVE, WIN | §4.2 |
| [P-06](#p-06--paired-video-acceptance) | Paired-video acceptance | ACCEPT | GPU, NATIVE, WIN | §4.2 |
| [M-01](#m-01--yue2-and-ace-step-remaining-work) | YuE2 and ACE-Step remaining work | SLICE + ACCEPT | CPU, GPU, NATIVE, WIN | §4.3 |
| [I-01](#i-01--inpaint-colour-pipette--screen-eyedropper) | Inpaint colour pipette / screen eyedropper | ACCEPT | NATIVE, WIN | §4.4 |
| [I-02](#i-02--sam-31-masking-and-native-auto-refine) | SAM 3.1 masking and native Auto Refine | ACCEPT | GPU, NATIVE, WIN, OWNER | §4.4 |
| [I-03](#i-03--minimax-h3-image-edit-with-multiple-references) | MiniMax H3 image edit with multiple references | ACCEPT | GPU, NATIVE, WIN | §4.4 |
| [I-04](#i-04--more-reference-techniques) | More reference techniques | FEATURE | PRIORITY | §4.4 |
| [I-05](#i-05--regional-prompting) | Regional prompting | FEATURE | PRIORITY, GPU | §4.4 |
| [MD-01](#md-01--image-lying-sigma-contribution--remaining-acceptance) | Image Lying Sigma contribution — remaining acceptance | ACCEPT | GPU, NATIVE, WIN | §4.5 |
| [MD-02](#md-02--central-model-checks-and-contextual-model-helper) | Central model checks and contextual model helper | ACCEPT | NATIVE, WIN, GPU | §4.5 |
| [MD-03](#md-03--multi-pass-sampling-for-all-imagevideo-models) | Multi-pass sampling for all image/video models | FEATURE | PRIORITY, GPU | §4.5 |
| [MD-04](#md-04--steps-and-cfg-editable-in-beginner) | Steps and CFG editable in Beginner | ACCEPT | NATIVE, WIN, GPU | §4.5 |
| [MD-05](#md-05--sampler-coverage-and-moss-image-defaults) | Sampler coverage and MOSS-Image defaults | SLICE + ACCEPT | CPU, GPU, OWNER | §4.5 |
| [MD-06](#md-06--user-defined-recipe-profiles-m-02) | User-defined recipe profiles (M-02) | FEATURE | PRIORITY | §4.5 |
| [MD-07](#md-07--split-diffusion-models-for-checkpoint-only-families-yue2-first) | Split diffusion models for checkpoint-only families (YuE2 first) | FEATURE | PRIORITY, GPU | §4.5 |
| [MD-08](#md-08--gguf-real-inference-and-windows-runtime) | GGUF real inference and Windows runtime | ACCEPT | GPU, WIN | §4.5 |
| [MD-09](#md-09--all-comfyui-core-architectures-f0f4-incl-ace-step-f3af3c) | All ComfyUI core architectures (F0–F4, incl. ACE-Step F3a–F3c) | FEATURE + ACCEPT | PRIORITY, GPU, NATIVE, WIN | §4.5 |
| [UX-01](#ux-01--beginner-optimized-pipelines) | Beginner optimized pipelines | ACCEPT | NATIVE, WIN, GPU | §4.6 |
| [UX-02](#ux-02--role-based-pipelines-one-image--video--music-pipeline) | Role-based pipelines (one Image / Video / Music pipeline) | SLICE + ACCEPT | CPU, NATIVE, WIN, GPU | §4.6 |
| [UX-03](#ux-03--comfy-file-drops) | Comfy file drops | ACCEPT | NATIVE, WIN, OWNER | §4.6 |
| [UX-04](#ux-04--post-processing-category-cards-with-settings-overlays) | Post-Processing category cards with settings overlays | ACCEPT | NATIVE, WIN | §4.6 |
| [UX-05](#ux-05--inpaint-samresult-controls) | Inpaint SAM/result controls | ACCEPT | NATIVE, WIN | §4.6 |
| [UX-06](#ux-06--chat-with-local-gguf-models) | Chat with local GGUF models | ACCEPT | GPU, NATIVE | §4.6 |
| [UX-07](#ux-07--slider-compare-for-videos) | Slider compare for videos | ACCEPT | NATIVE, WIN | §4.6 |
| [UX-08](#ux-08--dock-tabs-changedactive-count) | Dock tabs changed/active count | ACCEPT + SLICE | NATIVE, CPU | §4.6 |
| [UX-09](#ux-09--sam-auto-refine-progress-in-the-queue) | SAM Auto Refine progress in the queue | ACCEPT | GPU | §4.6 |
| [UX-10](#ux-10--video-thumbnails) | Video thumbnails | ACCEPT + SLICE | NATIVE, WIN, CPU | §4.6 |
| [UX-11](#ux-11--full-window-viewer-previousnext) | Full-window viewer previous/next | ACCEPT + SLICE | NATIVE, WIN, CPU | §4.6 |
| [UX-12](#ux-12--pipeline-filtered-model-picker) | Pipeline-filtered model picker | ACCEPT | NATIVE, WIN | §4.6 |
| [UX-13](#ux-13--media-panel-clipboard-droppaste-intake) | Media panel clipboard drop/paste intake | ACCEPT | NATIVE, WIN | §4.6 |
| [UX-14](#ux-14--ctrlf-find-in-the-current-view) | Ctrl+F find in the current view | FEATURE | PRIORITY | §4.6 |
| [UX-15](#ux-15--ctrlenter-runs) | Ctrl+Enter runs | ACCEPT | NATIVE | §4.6 |
| [UX-16](#ux-16--prompt-undoredo-on-webkitgtk) | Prompt Undo/Redo on WebKitGTK | ACCEPT | NATIVE | §4.6 |
| [UX-17](#ux-17--stop-selectedall-runtime-acceptance) | Stop selected/all runtime acceptance | ACCEPT | GPU, NATIVE, WIN | §4.6 |
| [UX-18](#ux-18--startup-splash-artwork-and-acceptance) | Startup splash artwork and acceptance | ACCEPT | OWNER, NATIVE, WIN | §4.6 |
| [UX-19](#ux-19--global-search-ctrlk) | Global search (Ctrl+K) | ACCEPT | NATIVE, WIN | §4.6 |
| [UX-20](#ux-20--in-app-spellcheck) | In-app spellcheck | ACCEPT + FEATURE | NATIVE, WIN | §4.6 |
| [UX-21](#ux-21--monitoring-tab-supersedes-queue-statistics-expansion) | Monitoring tab (supersedes queue statistics expansion) | ACCEPT + FEATURE | NATIVE, WIN | §4.6 |
| [UX-22](#ux-22--dark-wizards-tab--replace-priority-1-movie-maker-mood-grid-generator) | Dark Wizards tab — Replace (priority 1), Movie Maker, Mood, Grid Generator | SLICE + FEATURE | CPU, GPU, NATIVE, WIN, PRIORITY (Movie Maker/Mood/Grid) | §4.6 |
| [UX-23](#ux-23--project-persistence) | Project persistence | DEFERRED | PRIORITY | §4.6 |
| [UX-24](#ux-24--native-acceptance-for-older-shipped-ux-slices) | Native acceptance for older shipped UX slices | ACCEPT | NATIVE, WIN | §4.6 |
| [UX-25](#ux-25--export-without-metadata) | Export without metadata | ACCEPT + SLICE | NATIVE, WIN, CPU | §4.6 |
| [UX-26](#ux-26--estimated-time-next-to-the-step-count) | Estimated time next to the step count | ACCEPT | NATIVE | §4.6 |
| [UX-27](#ux-27--local-notes-and-media-deletion) | Local Notes and Media deletion | ACCEPT | NATIVE, WIN | §4.6 |
| [UX-28](#ux-28--selected-lora-popup-and-sets) | Selected-LoRA popup and sets | ACCEPT | NATIVE | §4.6 |
| [UX-29](#ux-29--studio-lora-inventory-fix) | Studio LoRA inventory fix | ACCEPT | NATIVE, OWNER | §4.6 |
| [UX-30](#ux-30--studio-refocus-fix) | Studio refocus fix | ACCEPT | NATIVE, OWNER | §4.6 |
| [UX-31](#ux-31--split-workbenchtsx) | Split `Workbench.tsx` | SLICE | CPU | §4.6 |
| [L-01](#l-01--library-catalog--pr-38--h3-reference-generation-gate) | Library Catalog / PR #38 — H3 reference generation gate | ACCEPT | GPU | §4.7 |
| [L-02](#l-02--librarystudio-quality-of-life-pr-37) | Library/Studio quality-of-life (PR #37) | ACCEPT | NATIVE, WIN | §4.7 |
| [L-03](#l-03--native-model-browser-proposal) | Native model browser proposal | ACCEPT | NATIVE, OWNER | §4.7 |
| [L-04](#l-04--library-and-downloads-backlog) | Library and downloads backlog | FEATURE | PRIORITY | §4.7 |
| [L-05](#l-05--lora-details-edits-and-prompt-examples-pr-42) | LoRA details edits and prompt examples (PR #42) | ACCEPT | NATIVE, WIN | §4.7 |
| [B-01](#b-01--host-owned-remote-browser-interface-and-deas-api) | Host-owned remote browser interface and DEAS API | FEATURE | PRIORITY | §4.8 |
| [B-02](#b-02--amd-linux-path-and-hardware-follow-ups) | AMD (Linux) path and hardware follow-ups | ACCEPT + FEATURE | AMD, PRIORITY | §4.8 |
| [B-03](#b-03--installer-backlog-git-ffmpegattention-repairrollback-node-pack-pin-windows-settings-move) | Installer backlog (Git, FFmpeg/attention, repair/rollback, node-pack pin, Windows settings move) | FEATURE | PRIORITY | §4.8 |
| [B-04](#b-04--selective-backend-updates) | Selective backend updates | ACCEPT | NATIVE, WIN | §4.8 |
| [B-05](#b-05--packed-release-assets) | Packed release assets | FEATURE | PRIORITY | §4.8 |
| [B-06](#b-06--signed-distribution-and-portability) | Signed distribution and portability | FEATURE | PRIORITY | §4.8 |
| [B-07](#b-07--windows-033-session-fixes--native-acceptance) | Windows 0.3.3 session fixes — native acceptance | ACCEPT | WIN, NATIVE | §4.8 |
| [B-08](#b-08--issue-39--backend-not-ready-on-slow-object_info-windows) | Issue #39 — backend "not ready" on slow `object_info` (Windows) | ACCEPT + RESEARCH | WIN, OWNER | §4.8 |
| [B-09](#b-09--issue-43--windows-self-update--native-acceptance) | Issue #43 — Windows self-update: native acceptance | ACCEPT | WIN | §4.8 |
| [B-10](#b-10--amd-on-windows) | AMD on Windows | FEATURE + ACCEPT | AMD, WIN | §4.8 |
| [B-11](#b-11--agent-api-v1-plane-verification-and-open-rulings) | Agent API (`/v1` plane): verification and open rulings | ACCEPT | GPU, WIN, NATIVE, OWNER | §4.8 |
| [R-01](#r-01--video-comparison-port) | Video comparison port | FEATURE | PRIORITY | §4.9 |
| [R-02](#r-02--video-assembly-port) | Video assembly port | FEATURE | PRIORITY | §4.9 |
| [R-03](#r-03--lora-training-port) | LoRA training port | FEATURE | PRIORITY | §4.9 |
| [R-04](#r-04--full-tve-parity) | Full TVE parity | FEATURE | PRIORITY | §4.9 |
| [R-05](#r-05--node-pack-feature-destinations-and-promptforge-port) | Node-pack feature destinations and PromptForge port | FEATURE | PRIORITY | §4.9 |
| [PL-01](#pl-01--theme-authoring) | Theme authoring | ACCEPT | NATIVE, WIN | §4.10 |
| [PL-02](#pl-02--beginner-mode) | Beginner mode | ACCEPT | NATIVE, WIN, GPU | §4.10 |
| [PL-03](#pl-03--plugin-platform-and-planner) | Plugin platform and planner | FEATURE | PRIORITY | §4.10 |
| [D-01](#d-01--video-metadata-readable-presentation-valid-json-and-civitai-prompts) | Video metadata: readable presentation, valid JSON and Civitai prompts | ACCEPT | OWNER, NATIVE, WIN, UPSTREAM | §4.11 |
| [D-02](#d-02--video-use-these-settings-and-more-actions) | Video Use these settings and More actions | ACCEPT | NATIVE, WIN | §4.11 |
| [D-03](#d-03--metadata-overlay-blacked-out-the-video-preview) | Metadata overlay blacked out the video preview | ACCEPT | NATIVE, WIN | §4.11 |
| [D-04](#d-04--prompt-forge-reference-editor-yue2-flac) | Prompt Forge reference editor YuE2 FLAC | ACCEPT | NATIVE, WIN | §4.11 |
| [D-05](#d-05--swarmui-model-foldersjunctions) | SwarmUI model folders/junctions | ACCEPT | OWNER, WIN, UPSTREAM | §4.11 |
| [D-06](#d-06--forge-clipboarddrop) | Forge clipboard/drop | ACCEPT | NATIVE, WIN | §4.11 |
| [D-07](#d-07--remembered-settings--linux-selector) | Remembered settings — Linux selector | ACCEPT | NATIVE | §4.11 |
| [D-08](#d-08--queuemedia-settings-reuse--native-and-provenance) | Queue/media settings reuse — native and provenance | ACCEPT | NATIVE, WIN | §4.11 |
| [D-09](#d-09--file-settings-coverage) | File settings coverage | SLICE | CPU, UPSTREAM | §4.11 |
| [D-10](#d-10--owner-reported-incompatible-settings-warning) | Owner-reported incompatible-settings warning | DEFECT | OWNER (samples) | §4.11 |
| [D-11](#d-11--comfy-view-sharpness) | Comfy view sharpness | ACCEPT | NATIVE | §4.11 |
| [D-12](#d-12--temporal-latent-tiled-refine) | Temporal-latent tiled refine | ACCEPT | GPU | §4.11 |
| [D-13](#d-13--saver-compatibility-exception--platformlifecycle-limits) | Saver compatibility exception — platform/lifecycle limits | ACCEPT | WIN | §4.11 |
| [D-14](#d-14--windows-output-publication-fix) | Windows output publication fix | ACCEPT | WIN, OWNER | §4.11 |
| [D-15](#d-15--canvas-law-the-family-grid-is-not-a-wall-yet) | Canvas law: the family grid is not a wall yet | SLICE | CPU, GPU | §4.11 |
| [A-01](#a-01--automatic-audio-enhanced-output-naming) | Automatic audio-enhanced output naming | ACCEPT | NATIVE, WIN | §4.12 |
| [A-02](#a-02--audio-modelengine-install-freeze) | Audio model/engine Install freeze | DEFECT | NATIVE, WIN, OWNER | §4.12 |
| [A-03](#a-03--audio-enhancement-for-studio-post-processing-and-tve) | Audio enhancement for Studio post-processing and TVE | ACCEPT | GPU, OWNER, WIN | §4.12 |

Totals: ACCEPT 78, DEFECT 3, DEFERRED 1, FEATURE 25, RESEARCH 2, SLICE 15 (items with mixed types counted per type; 107 items).

## 2. Owner priorities

Recorded owner priorities, newest first. Anything not listed needs an explicit priority before work starts. Standing scope (see [product decisions](PRODUCT-DECISIONS.md)): the lightweight global recent-job history is delivered; managed generated-PNG adoption, immutable i2i revisions and full persistent-project recovery are **deferred** ([UX-23](#ux-23--project-persistence)). Integrations delivered since then (MOSS, image references, TVE, learned latent upscale, GGUF, YuE2, ACE-Step) were each explicitly prioritized by the owner.

1. **Dark Wizards: Replace wizard first, then Movie Maker** ([UX-22](#ux-22--dark-wizards-tab--replace-priority-1-movie-maker-mood-grid-generator)). Mood and the Grid Generator remain planned behind them. Replace for images: the prepare-in-Generate slice (UX-22a) shipped in 0.3.11, one-click Run (UX-22b1) in 0.3.12 and the SAM 3.1 mask for the masked one-click run (UX-22b2) in 0.3.15; UX-22b3 (wizards in Beginner) in 0.3.16; the off-grid crop, the multi-target hint and the native Linux/real-model session in 0.3.25; UX-22c2 (both video methods) in 0.3.27; next are the remaining UX-22b/UX-22c3 checks and the native click-through, then videos only after the recorded H3-vs-LTX comparison.
2. **Memory-bounded video export** ([P-02](#p-02--memory-bounded-video-decodingexport-and-optional-ssd-staging)) is owner-approved scope: the stock-H3 path is shipped opt-in; open are the real 362-frame GPU case and the LTX/Wan paths, which stay opt-in too (owner decision 2026-11-24).
3. **Face refine on existing videos — RF3** ([P-03](#p-03--h3-automatic-whole-video-face-refinement)): CPU fix shipped in 0.2.38, the real GPU retest is next once a GPU session is approved.
4. **ACE-Step** was the prioritized music integration; its implementation shipped (0.2.16) and only acceptance remains ([M-01](#m-01--yue2-and-ace-step-remaining-work), [MD-09](#md-09--all-comfyui-core-architectures-f0f4-incl-ace-step-f3af3c) F3a/F3b).
5. Planning-only entries that explicitly do **not** authorize implementation: [MD-03](#md-03--multi-pass-sampling-for-all-imagevideo-models) Multi-pass, [V-15](#v-15--h3-native-sampling-and-conditioning-optimization-h3o) H3O.

## 3. Cross-cutting gates and batches

Unless an item says otherwise, these stay open product-wide: Windows/WebView2 runtime acceptance, real-model quality/performance per family, measured RAM/VRAM/idle resources, and native click-through where input automation is blocked.

- **Closable on this host without GPU/Windows/owner** (`CPU`): [V-01](#v-01--prompt-forge-selected-media-vision), [V-06](#v-06--trim-editor-remainder), [P-01](#p-01--tve-stages-on-the-owned-backend), [P-02](#p-02--memory-bounded-video-decodingexport-and-optional-ssd-staging), [M-01](#m-01--yue2-and-ace-step-remaining-work), [MD-05](#md-05--sampler-coverage-and-moss-image-defaults), [UX-02](#ux-02--role-based-pipelines-one-image--video--music-pipeline), [UX-22](#ux-22--dark-wizards-tab--replace-priority-1-movie-maker-mood-grid-generator), [UX-08](#ux-08--dock-tabs-changedactive-count), [UX-10](#ux-10--video-thumbnails), [UX-11](#ux-11--full-window-viewer-previousnext), [UX-25](#ux-25--export-without-metadata), [D-09](#d-09--file-settings-coverage). Check each row for `PRIORITY` first.
- **One isolated GPU session** (`GPU`, needs owner approval): [V-01](#v-01--prompt-forge-selected-media-vision), [V-02](#v-02--multi-reference-auto-aspect-real-run-check), [V-03](#v-03--animated-live-video-previews-enhanced-preview), [V-07](#v-07--create-refmod-remaining-acceptance-w2e3), [V-08](#v-08--refmod-content-preview-and-media-recovery), [V-09](#v-09--join-clips-and-h3-transitions-in-continuity), [V-11](#v-11--seamless-loop), [V-12](#v-12--real-gpu-acceptance-of-video-recipes-w5), [V-13](#v-13--experimental-dials-dial-rack--moss-imagekrea-2-dials), [V-14](#v-14--learned-latent-upscale), [V-15](#v-15--h3-native-sampling-and-conditioning-optimization-h3o), [V-16](#v-16--h3-hi-res-regenerate-open-h3-regenerate-2k), [V-17](#v-17--h3-input-scaling-auto-vs-fill-and-crop-real-run-check), [P-01](#p-01--tve-stages-on-the-owned-backend), [P-02](#p-02--memory-bounded-video-decodingexport-and-optional-ssd-staging), [P-03](#p-03--h3-automatic-whole-video-face-refinement), [P-04](#p-04--h3-de-rope), [P-05](#p-05--pp1--image-runtime-acceptance-and-video-ordering), [P-06](#p-06--paired-video-acceptance), [M-01](#m-01--yue2-and-ace-step-remaining-work), [I-02](#i-02--sam-31-masking-and-native-auto-refine), [I-03](#i-03--minimax-h3-image-edit-with-multiple-references), [I-05](#i-05--regional-prompting), [MD-01](#md-01--image-lying-sigma-contribution--remaining-acceptance), [MD-02](#md-02--central-model-checks-and-contextual-model-helper), [MD-03](#md-03--multi-pass-sampling-for-all-imagevideo-models), [MD-04](#md-04--steps-and-cfg-editable-in-beginner), [MD-05](#md-05--sampler-coverage-and-moss-image-defaults), [MD-07](#md-07--split-diffusion-models-for-checkpoint-only-families-yue2-first), [MD-08](#md-08--gguf-real-inference-and-windows-runtime), [MD-09](#md-09--all-comfyui-core-architectures-f0f4-incl-ace-step-f3af3c), [UX-01](#ux-01--beginner-optimized-pipelines), [UX-02](#ux-02--role-based-pipelines-one-image--video--music-pipeline), [UX-06](#ux-06--chat-with-local-gguf-models), [UX-09](#ux-09--sam-auto-refine-progress-in-the-queue), [UX-17](#ux-17--stop-selectedall-runtime-acceptance), [UX-22](#ux-22--dark-wizards-tab--replace-priority-1-movie-maker-mood-grid-generator), [L-01](#l-01--library-catalog--pr-38--h3-reference-generation-gate), [PL-02](#pl-02--beginner-mode), [D-12](#d-12--temporal-latent-tiled-refine), [A-03](#a-03--audio-enhancement-for-studio-post-processing-and-tve).
- **GPU batch status measured 2026-11-19 — three isolated batches (16 gates, then the three reruns); third batch ran the repo adapters on purpose** (throwaway backend on the 5090, `tools/gpu_acceptance_session.py`; evidence [Verification](VERIFICATION.md#isolated-gpu-acceptance-batch--16-gates-2026-11-19), [second batch](VERIFICATION.md#second-isolated-gpu-batch--16-gates-2026-11-19-1205--1241), [third batch](VERIFICATION.md#third-gpu-batch--the-three-reruns-2026-11-19-1339--1423)). Measured real-run evidence: [V-02](#v-02--multi-reference-auto-aspect-real-run-check), **closed** [V-03](#v-03--animated-live-video-previews-enhanced-preview) on delivery (9 `kj_preview_override` previews during an 85 s run, ≈388 KB each, arriving mid-sampling — only the visual-quality half stays open), [V-11](#v-11--seamless-loop) (seam 34.2 vs 17.7 dB), [V-13](#v-13--experimental-dials-dial-rack--moss-imagekrea-2-dials) (H3 run, PSNR 17.9 dial-vs-control), [V-14](#v-14--learned-latent-upscale) (83.2 vs 24.4), [V-16](#v-16--h3-hi-res-regenerate-open-h3-regenerate-2k) as a real untiled-vs-tiled A/B (untiled 203.2 sharpness/442 s vs tiled 159.2/260 s, PSNR 27.7), [V-17](#v-17--h3-input-scaling-auto-vs-fill-and-crop-real-run-check), [P-04](#p-04--h3-de-rope), [P-05](#p-05--pp1--image-runtime-acceptance-and-video-ordering)/[P-06](#p-06--paired-video-acceptance) (ordering/pairing halves), the H3 part of [V-12](#v-12--real-gpu-acceptance-of-video-recipes-w5) and a closed [MD-01](#md-01--image-lying-sigma-contribution--remaining-acceptance) A/B (PSNR 21.0 factor 0.5 vs 0.0). [P-02](#p-02--memory-bounded-video-decodingexport-and-optional-ssd-staging): the export defect is **fixed and proven on GPU** (two 362-frame 1440×1824 products published; the 15:03 rerun after the NaN fix took **980 s instead of 2371 s** and swap came in inside its bound at 7.8 GiB) after two independent causes — ffmpeg's Matroska/WebM muxer dropping non-uppercase metadata tags (fixed with an uppercase `DEAS` envelope tag) and `NaN != NaN` rejecting byte-identical `is_changed:[NaN]` graph provenance (fixed with canonical-serialization equality); the **memory half still fails its own gate** (55.5 GiB RAM peak and 8.7 GiB swap against the 48.1 GiB incident threshold, 2371 s), and the harness now attributes it: backend RSS **44.1 GiB of the 53.6 GiB peak** (the process, not page cache), +42.9 GiB over the run baseline, RSS 6→30 GiB while weights load and **+16 GiB of RAM in six seconds at T+474…480 s** at the latent-upscale / 2K-regenerate boundary, with zswap off and `pswout=0`. `--cache-lru 1` was measured as a **wash** (RSS −1.7 GiB mean, −4.1…+4.8 GiB spread; swap slightly worse), and the `/proc/<pid>/smaps` residency breakdown answered the question: backend RSS is **~99 % `[anonymous/private]`** (model-file mappings peaked at 1.06 GiB), and the six model files this job names total **42.54 GiB** — the demand is the weights as private allocations plus ~1 GiB, and the bounded streaming path never produced a full-RGB-batch spike. That reconstructs the incident arithmetically (42.5 weights + 2.763 + 10.626 GiB RGB ≈ 56 GiB with streaming **off**, the shipped default) and kills the load-policy/Settings-field branch: `--cache-lru`-style flags address file-backed residency this stack does not have. What shipped instead is the item's admission bullet: an over-budget estimate check (0.3.4, `host_memory.rs`), made opt-in in 0.3.5 (`DEAS_HOST_MEMORY_ADMISSION=warn|block`, default off) because summing all model files ignores ComfyUI's own offload/unload, and the streaming-path activation policy is the remaining owner call (43 vs 56 GiB for the reported case). [P-03](#p-03--h3-automatic-whole-video-face-refinement) measured twice (close-up and medium shot): the refined region is 3–10 % *softer*, never sharper — parameter/quality decision is the owner's. [MD-08](#md-08--gguf-real-inference-and-windows-runtime) GPU half retired by owner decision; only its Windows runtime half stays. None of this closes Windows or native halves, and no subjective quality call is implied.
- **Native Linux click-through batch** (`NATIVE`): [B-07](#b-07--windows-033-session-fixes--native-acceptance), [V-01](#v-01--prompt-forge-selected-media-vision), [V-03](#v-03--animated-live-video-previews-enhanced-preview), [V-04](#v-04--continuity-enabledisable), [V-05](#v-05--replace-on-paste-for-references-w2b), [V-07](#v-07--create-refmod-remaining-acceptance-w2e3), [V-08](#v-08--refmod-content-preview-and-media-recovery), [V-09](#v-09--join-clips-and-h3-transitions-in-continuity), [V-11](#v-11--seamless-loop), [V-13](#v-13--experimental-dials-dial-rack--moss-imagekrea-2-dials), [V-16](#v-16--h3-hi-res-regenerate-open-h3-regenerate-2k), [V-18](#v-18--videoaudio-playback-acceptance), [P-03](#p-03--h3-automatic-whole-video-face-refinement), [P-05](#p-05--pp1--image-runtime-acceptance-and-video-ordering), [P-06](#p-06--paired-video-acceptance), [M-01](#m-01--yue2-and-ace-step-remaining-work), [I-01](#i-01--inpaint-colour-pipette--screen-eyedropper), [I-02](#i-02--sam-31-masking-and-native-auto-refine), [I-03](#i-03--minimax-h3-image-edit-with-multiple-references), [MD-01](#md-01--image-lying-sigma-contribution--remaining-acceptance), [MD-02](#md-02--central-model-checks-and-contextual-model-helper), [MD-04](#md-04--steps-and-cfg-editable-in-beginner), [MD-09](#md-09--all-comfyui-core-architectures-f0f4-incl-ace-step-f3af3c), [UX-01](#ux-01--beginner-optimized-pipelines), [UX-02](#ux-02--role-based-pipelines-one-image--video--music-pipeline), [UX-03](#ux-03--comfy-file-drops), [UX-04](#ux-04--post-processing-category-cards-with-settings-overlays), [UX-05](#ux-05--inpaint-samresult-controls), [UX-06](#ux-06--chat-with-local-gguf-models), [UX-07](#ux-07--slider-compare-for-videos), [UX-08](#ux-08--dock-tabs-changedactive-count), [UX-10](#ux-10--video-thumbnails), [UX-11](#ux-11--full-window-viewer-previousnext), [UX-12](#ux-12--pipeline-filtered-model-picker), [UX-13](#ux-13--media-panel-clipboard-droppaste-intake), [UX-15](#ux-15--ctrlenter-runs), [UX-16](#ux-16--prompt-undoredo-on-webkitgtk), [UX-17](#ux-17--stop-selectedall-runtime-acceptance), [UX-18](#ux-18--startup-splash-artwork-and-acceptance), [UX-19](#ux-19--global-search-ctrlk), [UX-20](#ux-20--in-app-spellcheck), [UX-21](#ux-21--monitoring-tab-supersedes-queue-statistics-expansion), [UX-24](#ux-24--native-acceptance-for-older-shipped-ux-slices), [UX-25](#ux-25--export-without-metadata), [UX-26](#ux-26--estimated-time-next-to-the-step-count), [UX-27](#ux-27--local-notes-and-media-deletion), [UX-28](#ux-28--selected-lora-popup-and-sets), [UX-29](#ux-29--studio-lora-inventory-fix), [UX-30](#ux-30--studio-refocus-fix), [L-02](#l-02--librarystudio-quality-of-life-pr-37), [L-05](#l-05--lora-details-edits-and-prompt-examples-pr-42), [L-03](#l-03--native-model-browser-proposal), [B-04](#b-04--selective-backend-updates), [PL-01](#pl-01--theme-authoring), [PL-02](#pl-02--beginner-mode), [D-01](#d-01--video-metadata-readable-presentation-valid-json-and-civitai-prompts), [D-02](#d-02--video-use-these-settings-and-more-actions), [D-03](#d-03--metadata-overlay-blacked-out-the-video-preview), [D-04](#d-04--prompt-forge-reference-editor-yue2-flac), [D-06](#d-06--forge-clipboarddrop), [D-07](#d-07--remembered-settings--linux-selector), [D-08](#d-08--queuemedia-settings-reuse--native-and-provenance), [D-11](#d-11--comfy-view-sharpness), [A-01](#a-01--automatic-audio-enhanced-output-naming), [A-02](#a-02--audio-modelengine-install-freeze).
- **Windows WebView2 batch** (`WIN`): [B-07](#b-07--windows-033-session-fixes--native-acceptance), [B-08](#b-08--issue-39--backend-not-ready-on-slow-object_info-windows), [B-09](#b-09--issue-43--windows-self-update--native-acceptance), [V-01](#v-01--prompt-forge-selected-media-vision), [V-03](#v-03--animated-live-video-previews-enhanced-preview), [V-04](#v-04--continuity-enabledisable), [V-05](#v-05--replace-on-paste-for-references-w2b), [V-07](#v-07--create-refmod-remaining-acceptance-w2e3), [V-08](#v-08--refmod-content-preview-and-media-recovery), [V-09](#v-09--join-clips-and-h3-transitions-in-continuity), [V-13](#v-13--experimental-dials-dial-rack--moss-imagekrea-2-dials), [V-16](#v-16--h3-hi-res-regenerate-open-h3-regenerate-2k), [V-18](#v-18--videoaudio-playback-acceptance), [P-03](#p-03--h3-automatic-whole-video-face-refinement), [P-05](#p-05--pp1--image-runtime-acceptance-and-video-ordering), [P-06](#p-06--paired-video-acceptance), [M-01](#m-01--yue2-and-ace-step-remaining-work), [I-01](#i-01--inpaint-colour-pipette--screen-eyedropper), [I-02](#i-02--sam-31-masking-and-native-auto-refine), [I-03](#i-03--minimax-h3-image-edit-with-multiple-references), [MD-01](#md-01--image-lying-sigma-contribution--remaining-acceptance), [MD-02](#md-02--central-model-checks-and-contextual-model-helper), [MD-04](#md-04--steps-and-cfg-editable-in-beginner), [MD-08](#md-08--gguf-real-inference-and-windows-runtime), [MD-09](#md-09--all-comfyui-core-architectures-f0f4-incl-ace-step-f3af3c), [UX-01](#ux-01--beginner-optimized-pipelines), [UX-02](#ux-02--role-based-pipelines-one-image--video--music-pipeline), [UX-03](#ux-03--comfy-file-drops), [UX-04](#ux-04--post-processing-category-cards-with-settings-overlays), [UX-05](#ux-05--inpaint-samresult-controls), [UX-07](#ux-07--slider-compare-for-videos), [UX-10](#ux-10--video-thumbnails), [UX-11](#ux-11--full-window-viewer-previousnext), [UX-12](#ux-12--pipeline-filtered-model-picker), [UX-13](#ux-13--media-panel-clipboard-droppaste-intake), [UX-17](#ux-17--stop-selectedall-runtime-acceptance), [UX-18](#ux-18--startup-splash-artwork-and-acceptance), [UX-19](#ux-19--global-search-ctrlk), [UX-20](#ux-20--in-app-spellcheck), [UX-21](#ux-21--monitoring-tab-supersedes-queue-statistics-expansion), [UX-24](#ux-24--native-acceptance-for-older-shipped-ux-slices), [UX-25](#ux-25--export-without-metadata), [UX-27](#ux-27--local-notes-and-media-deletion), [L-02](#l-02--librarystudio-quality-of-life-pr-37), [L-05](#l-05--lora-details-edits-and-prompt-examples-pr-42), [B-04](#b-04--selective-backend-updates), [PL-01](#pl-01--theme-authoring), [PL-02](#pl-02--beginner-mode), [D-01](#d-01--video-metadata-readable-presentation-valid-json-and-civitai-prompts), [D-02](#d-02--video-use-these-settings-and-more-actions), [D-03](#d-03--metadata-overlay-blacked-out-the-video-preview), [D-04](#d-04--prompt-forge-reference-editor-yue2-flac), [D-05](#d-05--swarmui-model-foldersjunctions), [D-06](#d-06--forge-clipboarddrop), [D-08](#d-08--queuemedia-settings-reuse--native-and-provenance), [D-13](#d-13--saver-compatibility-exception--platformlifecycle-limits), [D-14](#d-14--windows-output-publication-fix), [A-01](#a-01--automatic-audio-enhanced-output-naming), [A-02](#a-02--audio-modelengine-install-freeze), [A-03](#a-03--audio-enhancement-for-studio-post-processing-and-tve).
- **Owner input needed** (`OWNER`): [V-03](#v-03--animated-live-video-previews-enhanced-preview), [V-09](#v-09--join-clips-and-h3-transitions-in-continuity), [P-03](#p-03--h3-automatic-whole-video-face-refinement), [P-04](#p-04--h3-de-rope), [I-02](#i-02--sam-31-masking-and-native-auto-refine), [MD-05](#md-05--sampler-coverage-and-moss-image-defaults), [UX-03](#ux-03--comfy-file-drops), [UX-18](#ux-18--startup-splash-artwork-and-acceptance), [UX-29](#ux-29--studio-lora-inventory-fix), [UX-30](#ux-30--studio-refocus-fix), [L-03](#l-03--native-model-browser-proposal), [D-01](#d-01--video-metadata-readable-presentation-valid-json-and-civitai-prompts), [D-05](#d-05--swarmui-model-foldersjunctions), [D-10](#d-10--owner-reported-incompatible-settings-warning), [D-14](#d-14--windows-output-publication-fix), [A-02](#a-02--audio-modelengine-install-freeze), [A-03](#a-03--audio-enhancement-for-studio-post-processing-and-tve), [B-08](#b-08--issue-39--backend-not-ready-on-slow-object_info-windows).

## 4. Open work by area

### 4.1 Video, H3 Director and playback

#### V-01 · Prompt Forge selected-media vision

**Type:** SLICE · **Needs:** CPU, GPU, NATIVE, WIN

**Prompt Forge selected-media vision. Status: partial.** Input/output picture identity now reaches standalone and run-bound H3 Forge, Cast and Find people, including first/last frames. Explicit native operations adapt output images through the existing bounded input-upload path, preserving originals; navigation/selection does not upload. People detection and writer vision remain separate. Source-backed UI explains labelled-picture opt-in versus automatic normal-reference/frame vision; neither filenames nor manual character labels establish successful model vision.
- Remaining scope: external/library files outside the active backend input/output roots, actual vision-backed draft/detection quality, supported video-frame sampling/trims, and native-platform acceptance. Do not infer arbitrary video/audio understanding from picture transport tests. The node pack's normal-reference writer sends readable pictures automatically to vision-capable models; `see_pictures` controls its labelled-picture path only.
- [ ] Trace both standalone and run-bound Forge contexts from current inputs/references through native validation and node-pack requests. Make the applicable vision choice visible with an accurate enabled/unavailable reason; match the Director's labelled-picture versus normal-reference semantics without blindly forcing `see_pictures` on every mode. Keep people detection and prompt-writing vision separately understandable and actionable.
- [ ] On explicit analysis/draft action, resolve the exact selected media through existing safe job-bound reads/import/upload paths as needed; do not require the user to move files manually into input. Preserve reference order, labels, boxes, trims and source identity. Pictures must reach the selected vision model as image content, not just names. For video, verify the supported frame-sampling path and intended trims; do not claim audio understanding or arbitrary media support where the chosen model/route lacks it. Explain genuine missing model/capability errors rather than source-folder gating otherwise valid media.
- [ ] No analysis/upload merely on navigation, selection or opening Forge; keep explicit consent for sending local content to an external model endpoint. Preserve originals, manual boxes, drafts and cancellation; stale analysis must not overwrite changed references. Reuse existing APIs, with separately authorized upstream work if a required node-pack route is genuinely missing.
- [ ] Add Forge/PeopleDetector/native transport tests for input, generated output, library/external images, frame inputs, selected references and supported video sources; labelled and mixed-media modes, unsupported vision, refusal/cancellation and selection races. Inspect captured requests for real media payloads and exact source correlation. Prove an actual vision-backed draft and people detection on non-input-folder media, plus supported video-frame understanding, separately from fixtures; native Linux/Windows acceptance, seven locales, global search and `docs/STUDIO.md` updates remain required.

#### V-02 · Multi-reference Auto aspect real-run check

**Type:** ACCEPT · **Needs:** GPU

**Multi-reference Auto aspect: real-run check.** Source rule ported from the Director's `sourceDimensions` (`firstVisualRef`). Open: one real H3 run with a portrait first picture, and the canvas differs by design from the Director's `auto` resolution preset.

#### V-03 · Animated live video previews (Enhanced preview)

**Type:** ACCEPT · **Needs:** GPU, NATIVE, WIN, OWNER

**Animated live video previews during generation. Status: implemented (0.2.19–0.2.21: Options → Enhanced preview, bounded job-correlated transport/parser, playback incl. the KJ fragmented-MP4 layout); real-run and native acceptance open.** Owner explicitly prioritizes H3 and LTX, with Wan 2.2 where compatible. Delivered slices and source discovery: [VERIFICATION.md](VERIFICATION.md#closed-plan-items-moved-from-planmd-2026-11-14); user text in [Studio](STUDIO.md#enhanced-preview-prerequisites).
- **H3 availability — explicit-update/runtime acceptance remaining (0.2.20).** The confirmed missing-companion/model-folder provisioning gap is fixed in source; [verification](VERIFICATION.md#enhanced-preview-prerequisite-repair-0220) records actual package import/schema replay and fixture gates. Still exercise an explicitly approved real owned-environment update (including dependency installation), then check the H3 switch and actual animated sampling preview in WebKitGTK/WebView2 with retained saved OFF. The existing running environment remains unchanged until that approval; no model downloads, copied/moved weights or foreign service changes are authorized implicitly.
- [ ] Real H3 and LTX runs showing visible motion during sampling, measured memory/performance and unchanged generated outputs; confirm the 120-frame/8-fps reference per family instead of imposing it.
- [ ] Wan 2.2: no compatible local tiny decoder was found (14B uses 16-channel Wan2.1-compatible latents); the switch stays unavailable with its reason until one is identified. No automatic download.
- [ ] Native Linux WebKitGTK/libmpv and Windows WebView2 playback acceptance.
- [ ] **Replay during preview gaps (PR #42, 0.3.4; fixture-verified only).** `TemporalPreview.tsx` holds the last frame for 1 s and replays the current clip while no newer revision arrives; a newer revision takes over only at a clip boundary. Check on a real H3/LTX run with latent upscale or Hi-Res regenerate that the clip keeps replaying through the post-processing/export stages and that the finished result replaces it. Linux: the libmpv path remounts `NativeVideo` per replay (`key={replay}`) — check for flicker, surface leaks and CPU over a long post stage; if it is visible, switch to `controlRef` seek(0)+play. Windows WebView2: the `<video>` element is reused (`currentTime=0`, `play()`).

#### V-04 · Continuity enable/disable

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Continuity enable/disable: native acceptance.** The **Continuity active** switch landed in 0.1.67 (frontend-only; intents unchanged, see [Studio](STUDIO.md)). Open: native Linux WebKitGTK and Windows WebView2 click-through.

#### V-05 · Replace-on-paste for references (W2b′)

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Replace-on-paste for references (W2b′) — native acceptance only.** Paste-to-add (0.2.22) and paste-to-replace on a focused picture card (0.2.25, `ReferencesPanel.tsx` paste handler, component test) are implemented. Still open: native WebKitGTK/WebView2 clipboard paste onto a card.

#### V-06 · Trim editor remainder

**Type:** SLICE · **Needs:** CPU, PRIORITY

**Trim editor remainder.** Whole-crop move: needs two finite endpoints, preserves the 2–15 s span, clamps to `[-start, 3600-end]` and updates both ends atomically (3600 is a safety bound, not source duration). The Director's keys move the playhead (Left/Right ±1 s, Shift ±0.1 s); do not call trim nudges Director parity. Waveforms and thumbnail strips.

#### V-07 · Create RefMod remaining acceptance (W2e3)

**Type:** ACCEPT · **Needs:** GPU, NATIVE, WIN

**Create RefMod: remaining acceptance (W2e3, 0.2.22).** Landed (see [VERIFICATION.md](VERIFICATION.md#director-create-refmod-w2e3-0222)); a picture export ran for real on a CPU throwaway backend. Open: video (+sound) and audio members on GPU with timing, **Cancel export** against the owned backend (pending delete and running interrupt), and native WebKitGTK/WebView2 click-through. Editing an existing RefMod (the Director's *Save Changes* copy) is not offered.

#### V-08 · RefMod content preview and media recovery

**Type:** FEATURE · **Needs:** PRIORITY, GPU, NATIVE, WIN

**RefMod content preview and media recovery. Status: planned, not implemented.** Owner request: decode a saved RefMod so its contained media becomes visible/playable and can be recovered as reusable media files, rather than showing only the bundle name and description. This is separate from creating/editing a RefMod or running a new H3 generation.
- **Source baseline.** DEAS `src/lib/jobs.ts::RefModEntry`/`readRefMods` exposes name, kinds and description; Pack `nodes/refmod_library.py::library_entries`/`refmod_details` and `/dasiwa/refmods`/`detail` are metadata-only. Pack `nodes/helper_refmod_format.py::load_refmods` reads image/video/audio latent members; `nodes/nodes_minimax_h3_director_guide.py::_apply_native` already decodes visual RefMod latents for Qwen, but that internal decode is not a user-facing preview/recovery feature. Reuse supported format readers, compatible native VAE decode and DEAS media presentation/export; any missing pack primitive requires separate authorized upstream work, not a patched installed dependency.
- [ ] Show the actual member list with kind, order and descriptions in the existing RefMod/References surface. An explicit decode/preview action makes image thumbnails/full previews, video playback and audio listening available for the relevant members, including mixed bundles. Browsing/listing must remain metadata-only: no implicit model loading, GPU allocation, decoding or downloads just to open the library. Explain missing/incompatible video/audio VAEs and unsupported members without hiding the bundle or affecting ordinary RefMod use.
- [ ] Offer explicit recovery/export of selected members as normal image/video/audio files, with optional explicit reuse as references through existing media actions. Decode stored latents without diffusion generation; preserve stored dimensions, frame/sample timing and member association where the format supplies them. Distinguish VAE-decoded reconstruction from the original source: latent-only RefMods do not guarantee lossless recovery of original pixels, waveform or file bytes, and absent metadata must not be invented. Preview quality/limits must not silently limit a requested full-member export.
- [ ] Keep the source RefMod, member tensors/descriptions, reference slots/strengths and running submissions unchanged. Validate bundle identity/member indices and tensor bounds before decode, bound memory/output, report progress and support scoped cancellation; publish only completed verified products without clobbering files. Reuse job-bound native retrieval, viewers/playback and no-clobber export; retain compatible standalone and legacy/bundle behavior, with no automatic execution or external-service changes.
- [ ] Tests: reader/contract and UI fixtures for single image/video/audio and mixed/legacy bundles, missing/wrong VAE, malformed/oversized members, changed source/selection, cancellation and export collisions; unchanged metadata-only browsing and ordinary REF2VA consumption. Then real compatible-VAE decode/readback of image detail, full video frame count/playback and audio timing/listening, including paired video/audio where represented; measure resource/cancel behavior and verify native Linux WebKitGTK/libmpv and Windows WebView2 preview/export. Add seven locales, global search and `docs/STUDIO.md` guidance with the reconstruction-versus-original limitation; fixtures alone do not close real decode/media acceptance.

#### V-09 · Join clips and H3 transitions in Continuity

**Type:** ACCEPT · **Needs:** GPU, NATIVE, WIN, OWNER

**Join clips and H3 transitions in Continuity — real-model/native acceptance remaining.** Model-free joins shipped in 0.2.23; the native transition job (T1) and opt-in sequential Join UI (T2) are implemented in 0.2.34 (shipped in 0.2.35). Source, regression/review evidence and limits: [VERIFICATION.md](VERIFICATION.md); controls/prerequisites: [Studio](STUDIO.md#h3-transitions-between-joined-video-files). Bridges are validated intermediates in backend `input/h3_transitions/`, not Media outputs; the final model-free join is the product. The modal locks Close/Escape while Join owns a sequence and offers scoped Cancel; ordinary Continuity Run all ownership remains unchanged. No model/service changes or implicit GPU approval.
- [ ] **Slice T3 — real run executed with owner GPU approval (2026-11-15); quality acceptance remains open.** Isolated 32 GB test GPU backend rendered a 29-frame bridge and 114-frame H.264/AAC join at 544×704/24 fps. Cold bridge 85.541 s, warm repeat 37.078 s; full warm-run sampling peaked at 29.70 GiB backend VRAM / 31.33 GiB device total and 44.45 GiB process RSS. Actual later-cut Guide failure and authenticated job-scoped interruption during sampler progress retained the original and finished bridge hash-identically; no partial files remained. Details, graphs, histories and measurement limits: [T3 evidence](VERIFICATION.md#h3-transitions-slice-t3--real-gpu-execution-2026-11-15).
  - [ ] **Sequential memory admission — fix implemented, real GPU retest open.** Cause: Core's RAM-pressure cache targets ~10% headroom (≈6 GiB on this host) while the pack's guard needs 8 GiB plus the edge estimate. Pack 0.5.53 (published as 0.5.57) releases the executor's cached RAM (inactive cache, pins, active cache; never models) before refusing and rechecks, without lowering the reserve or resubmitting. Open: rerun two real H3 generations followed by a bridge on an isolated backend with the patched pack and confirm the bridge is admitted without `/free`; the retest was deferred because an unrelated user GPU process held 28 GiB.
  - [ ] Native-owned lifecycle/UI cancellation and automatic no-follow-up behavior are still separate from the directly exercised backend interrupt/error contracts; retained T2 fixtures cover sequence suppression, not a real native click-through.
- [ ] **Native acceptance remaining.** Done: Windows WebView2 UI/IPC and real 10-second playback ([bounded](VERIFICATION.md#h3-join-and-dungeon-playback-bounded-native-windows-acceptance--2026-11-15)); Linux native-owned backend start/stop, input upload, real join, unconfirmed-cancel refusal, pending→running reconciliation, running interrupt with backend `execution_interrupted`, libmpv playback ([continuation](VERIFICATION.md#h3-join-continuation-native-linux-owned-backend-audio-seams-and-ram-reclaim--2026-11-15)). Open: a real H3 bridge sequence started from the dialog (progress, busy Close/Escape lock, follow-up suppression and bridge retention on real jobs — GPU), native export through the OS chooser (manual), Windows owned-backend execution (test environment lacks the node pack and FFmpeg), real-path Windows history (OS448 junction), audible A/V sync.

- [ ] Owner listening judgement for the dungeon case: exact German dialogue wording, lip sync and perceived audio continuity (visual review was accepted; see the moved case evidence in VERIFICATION.md).

#### V-10 · Later recipe features (W6)

**Type:** FEATURE · **Needs:** PRIORITY

**Later recipe features (W6).** LTX keep source audio (audio VAE encode + 3-D noise mask), LTX IC-LoRA control (`iclora_parameters` on core `LTXVAddGuide`), LTX per-segment prompts (GPL Prompt Relay patch, explicit opt-in only), LTX retake, source-fps resampling, H3 Image Inpaint as its own pipeline label, Wan T2V/S2V, per-model Wan LoRA lists. Unplanned ideas: colour transfer, watermark/soundmark, NAG, TritonVAE.

#### V-11 · Seamless loop

**Type:** ACCEPT · **Needs:** GPU, NATIVE

**Seamless loop — landed in 0.2.22 (fixture + CPU executor with the real 0.5.41 node).** Open: tempo detection on real H3/LTX music (confidence threshold 0.2 is tuned on synthetic clicks/noise), a real RIFE/FILM and RTX loop run on GPU and native acceptance (the node pack has long since published past 0.5.41).

#### V-12 · Real GPU acceptance of video recipes (W5)

**Type:** ACCEPT · **Needs:** GPU

**Real GPU acceptance (W5).** On a throwaway ComfyUI on another port (never the owner's backend): one LTX v2v, one LTX keyframe run, one H3 REF2VA with a 2–15 s clip, one H3 image edit with and without mask. Record outputs, time, VRAM and visible quality. Questions: does H3 frame 0 carry the edit; is unresampled LTX source fps acceptable; does `VAEDecode` after `LTXVSeparateAVLatent` decode H3 correctly.

#### V-13 · Experimental Dials (Dial Rack) + MOSS-Image/Krea 2 Dials

**Type:** ACCEPT + FEATURE · **Needs:** NATIVE, WIN, GPU, PRIORITY

**Experimental Dials (Dial Rack): H3 video, plus planned MOSS-Image and Krea 2 support.** H3 video ships experimentally in 0.3.0, pending full native/GPU acceptance. The work started in [PR #40](https://github.com/darksidewalker/DEAS/pull/40) and now includes an Advanced Studio settings button, a rack timeline, shared presets, author downloads in the Library Catalog, and native compiler support for MiniMax H3 and HyperFlow Flash, including supported GGUF loaders. Owned setup/upgrade pins [ComfyUI-Dials at `9a6b474`](https://github.com/matlowai/ComfyUI-Dials/tree/9a6b474b3ecd53190ae6cd84c01e3a5605ab36f3). See [Dials](DIALS.md) and [Verification](VERIFICATION.md#deas-0242-dials-integration).
- [ ] Repeat native acceptance on Linux WebKitGTK and Windows WebView2: keyboard, screen-reader names, narrow windows, pointer capture and clipboard. Verify catalog and preset list/save/load against the pinned pack, round trips with ComfyUI and an external backend, and failure handling.
- [ ] Repeat Studio GPU runs on an isolated backend: plain H3 and HyperFlow Flash (safetensors and GGUF), De-rope with the baseline gate, and Continuity in full/segment output modes, including REF2VA and stale source-frame refusal. Listen to curve audio in both Follow and Protect modes.
- [ ] **MOSS-Image and Krea 2 Dials — planned, not implemented.** Extend the existing Advanced Studio Dials surface to the two image families (`moss-image`, `krea-2`). The pinned ComfyUI-Dials README lists both for the Dial Rack nodes, but `Workbench.tsx::dialsHere` and `jobs_video.rs::validate_dials` currently gate Dials to H3 video; `Workbench.tsx::buildImageIntent` and `jobs.rs::compile` need image-side wiring. Reuse the rack, catalog, strength controls and compatible shared presets. Start with constant steering; hide or explain video-only curves, audio modes and HoldMap controls unless independently verified for still images. Validate family and loader support, installed node schema and dial-file compatibility on each image recipe; refuse incompatible rows or missing nodes without silently dropping active settings. Verify no-active-dial image graphs and all existing H3 behavior are unchanged. Require frontend intent/native graph and restore tests, seven locales and Studio documentation, and fixed-seed off/on GPU comparisons for each family on the pinned pack, covering each advertised image mode and loader independently.
- [ ] Measure blend-step tradeoffs across schedules, seeds, dials and picture-reference modes. A short schedule can gain visible steering at the cost of an extra model call per blended step; longer-schedule look curves remain unverified beyond the limitations in the guide.
- [ ] Unimplemented: row reordering, media-metadata restoration of a continued segment's time curves, single-frame curve semantics, and time curves with face refinement, tiled latent upscale, H3 transitions, continued De-rope or imported-video continuations. Holds, step envelopes, block strengths, audio-driven curves and preset update/rename/delete are out of scope for this release.
- [ ] First-version refusals to revisit: time curves with face refinement, tiled latent upscale, H3 transitions, De-rope on a continued segment and imported-video continuations (each needs that pass's clip start in piece seconds; the second De-rope pass cannot take a different time offset through `MAIDialHoldMap`); hold rows, step envelopes, block strengths, audio-driven curves, wired dials; HyperFlow Flash and GGUF bases.

#### V-14 · Learned latent upscale

**Type:** ACCEPT · **Needs:** GPU

**Learned latent upscale.** Real model quality/performance; strict baseline-first preservation for the paired Original/Processed outputs.

#### V-15 · H3 native sampling and conditioning optimization (H3O)

**Type:** RESEARCH · **Needs:** PRIORITY, GPU, UPSTREAM

**H3 native sampling and conditioning optimization (H3O). Status: planned, not implemented.** Owner request: retain the source-backed findings and test requirements for a possible optimization; this entry does not authorize implementation, upstream changes, GPU execution or a rewrite of DEAS/the Director. Prefer bounded adoption of native primitives over replacing authoring, job ownership, Continuity or export. Suggested evaluation order: H3O1/H3O2 conditioning and boundary correctness, H3O3 optional primary-sampler windows, then independent H3O4 temporal-refinement/3D-upscaler comparisons. Start a slice only on explicit owner priority.
- **Audit baseline (2026-11-15).** DEAS `c74ec25`; owned Core `eee59185ff4f43ae2d9ad122b245619d27d9daad`, personal Core `157db2ea2f835917c16191147c11e5896eca01a9` (both 0.45.0; relevant context-window/conditioning/model files identical). Owned pack `3c3fd6580e82e15143d56d6fba9ef39c86d65904` / 0.5.51; personal pack `e1bc5b49ace405bf90c3e666b9a02bbacb4c1b0a` / 0.5.52; development pack `6bc3c19`. These are inspected checkout identities, not proof of the running process's imports. Below, Core paths are relative to the selected owned `ComfyUI/`; Pack paths are relative to `ComfyUI-DaSiWa-Nodes/`. Recheck both before implementation; never use the personal installation's version as owned-runtime acceptance.
- **Existing architecture to retain.** Pack `nodes/nodes_minimax_h3_director_guide.py::_apply_native` already calls native `MiniMaxH3ImageToVideo` / `MiniMaxH3ReferenceToVideo` (lines 169–285); DEAS `src-tauri/src/jobs_video.rs:1928–1950` compiles Director → Guide → scheduled model/BasicGuider → SamplerCustomAdvanced → SegmentPrepare/Decode. Core windows change denoiser prediction evaluation, not media authoring, RefMods, stored continuation ancestry/capture, bounded segment decode, clip assembly, scoped jobs or atomic publication. Preserve spatial tiling, original audio, protected source prefixes and baseline-first Original/Processed products.
- **H3O1 — conditioning detail and geometry.** Director Auto is preprocessing only (`nodes/helper_minimax_h3_director.py::scale_input_media`): it leaves inputs at or below a 2048-pixel short edge unchanged, but native `MiniMaxH3ImageToVideo.execute` still stretches first frames and center cover-crops last frames to the generation canvas before Qwen and VAE encoding. Native `MiniMaxH3ReferenceToVideo.execute` separately implements `ref_image_size=match` (down-only, generation pixel area) versus `max` (down-only short-edge limit); see Core `comfy_extras/nodes_minimax_h3.py:155–178,306–328`. A 2048×1536 reference survives Director Auto but becomes 1024×768 under native match for a 1024×768 draft; max retains 2048×1536. DEAS hardcodes match at `jobs_video.rs:1930`; inspect the actual UI preference as well as the compiler's absent-field Fill-and-crop fallback (`Workbench.tsx:344`, `jobs_video.rs:1898–1903`, and the input-scaling row below). The earlier universal video-reference [1024,2048] clamp / 1-MP vision-limit claims confused separate image-conditioning paths and must not be reused.
  - [ ] Decide whether to expose reference-detail sizing and target-pass conditioning reconstruction, preserving current/default graphs and saved explicit choices. Trace first/last guides, REF2VA image/video/audio and preencoded RefMods separately; high-resolution refs add tokens to every sampling window. Existing `nodes/nodes_minimax_h3_tiled_upscale.py::encode_endpoints` can re-encode original endpoint pixels at the target, but reuses Qwen embeddings and does not rebuild all reference latents. Evaluate those channels separately; do not globally force max or re-encode every pass.
  - [ ] Preserve native first-frame stretch versus last-frame cover-crop when re-encoding endpoints: current `encode_endpoints:83–100` bicubically stretches both, so an aspect-mismatched closing image can change geometry between draft and refinement. Cover aspect mismatch, absent endpoints, original-pixel versus latent-only input and multi-frame continuation tails without replacing them with still anchors.
- **H3O2 — temporal guide-boundary parity.** Pack `nodes/h3_tiled_sampling.py::_cut_keyframes` (223–246) uses complete-token containment for video and independent ceil/floor of pixel time × FRAME_RESCALE for audio. The actual sampler's `nodes/nodes_minimax_h3_tiled_upscale.py::audio_window` (61–70, called at the temporal sampling loop) instead uses rounded cumulative pixel boundaries proportional to the complete audio length. Core `comfy/model_base.py::MiniMaxH3._window_payload` (2327–2367) retains intersecting five-token visual groups, permits a negative local guide origin and crops audio from the actual window indices.
  - [ ] Pin and fix or explicitly justify the audio-boundary difference using one authoritative window mapping. Reproduction: 124 real frames / 37 video tokens / 207 audio tokens; window [5,15) samples audio [28,85), but its frame-zero guide uses [29,85) with a +0.4-frame local anchor; final [25,37) samples [142,207), but the guide stops at 206. This is a conditioning-alignment finding, not proof of audible export drift; the current upscaler returns the original audio object.
  - [ ] Pin partially intersecting visual guides and preserve native temporal phase before replacing the custom slicing. Reproduction: a seven-token/22-frame guide anchored at real frame 2, in video-token window [5,15) / real frames [17,51), retains only two tokens in the custom path, whereas Core retains both intersecting five-token groups (all seven source tokens). Test first/last/off-phase guides, negative local origins, multiple guides, unchanged reference blocks and no mutation of cached upstream conditioning.
- **H3O3 — optional native context windows at the primary sampler.** Core `comfy_extras/nodes_context_windows.py::MiniMaxH3ContextWindowsNode` is experimental (upstream [#17425](https://github.com/Comfy-Org/ComfyUI/pull/17425), included in v0.44.0). It installs static per-step prediction windows, H3 17n+5 controls, default length/overlap 124/39, pyramid fusion, optional FreeNoise and no generic causal anchor fix. `comfy/context_windows.py::IndexListContextHandler.execute` fuses window predictions before the outer sampler advances; this differs from Pack `nodes_minimax_h3_tiled_upscale.py` completing an entire sampler trajectory per chunk then anchoring/crossfading the next. Both paths are latent-based; eliminating a supposedly mandatory custom VAE roundtrip is not the justification.
  - [ ] Add only a capability-gated, default-OFF intent/graph option if the evaluation warrants it. Proposed seam: derive a windowed model from the existing scheduled `sampling` model for `B.model` / sampler `5`; keep an explicit unwindowed branch for De-rope, face refine and upscale. The native node already clones its input (`ContextWindowsManualNode.execute`); cloning an already-patched model retains the handler/wrappers and is not an unpatch operation. Avoid applying the node twice; inspect shared mutable handler/cache state. Do not impose a universal ban on custom chunking/Continuity composition or enable both temporal strategies without composition tests. Decide separately whether transition/bridge recipes, which reuse the H3 compiler, opt in.
  - [ ] Complete the actual integration surface: H3 intent builder/types and strict Rust validation, `jobs_video.rs::VIDEO_NODES`, prerequisite/schema checks in `recipe_prerequisites.rs`/`jobs.rs`, Workbench preference/draft/reset/history restoration, Run Plan, global search, seven locales and Studio guide. Missing capability blocks only an enabled dependent feature; absent/disabled settings retain existing graphs, model/sigma/LoRA choices and standalone Director behavior. Do not add a new backend/service/dependency or duplicate native guide remapping.
- **H3O4 — evaluate internal replacements independently.** Consider native per-step fusion as an alternative to the custom temporal refinement loop, not a rewrite of the whole upscale node. Separately compare Core `MiniMaxH3LatentUpscaleWithModel` (`comfy_extras/nodes_minimax_h3.py:658–669`, loader in `nodes_hunyuan.py`) and `comfy/ldm/minimax/latent_upscaler.py::clip_stats`/slab forwards against the matching custom 3D checkpoint path. Native slabs share clip-wide normalization statistics; Pack `nodes/h3_latent_upscale.py::H3LatentUpscaler.temporal_halo` explicitly does not promise chunk/full equivalence for 3D. Keep custom 2D/tier support, required model variants, target dimensions, original audio and existing Continuity/refinement contracts unless a replacement proves them. Any required pack changes need their own authorized upstream review and exact installed-revision checks.
- **Limits to retain in every decision.** 124 is a configurable window default, not a clip maximum or automatic adoption threshold; the native schema describes roughly 124–362 frames as trained range and longer as untested. Core `comfy/model_base.py::map_context_window_to_modalities` maps cumulative video boundaries to actual audio indices, but full latent/noise/solver state and fusion accumulators remain; `comfy/context_windows.py::_prepare_sampling_wrapper` explicitly skips the window-size estimate clamp for packed AV latents. Reference payloads remain in every window; cropped guide groups can exceed target-window length. Core `comfy/ldm/minimax/model.py::_cond_video_rows`/`_cond_audio_rows` restart condition-augmentation RNG on the already-cropped rows, not a slice of one full-guide noise field; do not assume full-clip numerical equivalence.
- **Prior evidence is arithmetic only.** Source-extracted stdlib/NumPy probes checked static schedule coverage/phase and AV mapping in both Core checkouts, first/last/video/audio guide rebasing, reference sizing and the H3O2 cases; no pretrained inference, native executor composition, visual/audio quality, runtime or peak-memory comparison was established. Default 124/39 controls map to 37/12 video positions with stride 25; a 243-frame clip has 72 positions and three 37-position windows (111 visits, 54.2% repeated temporal coverage; long-clip limit 48%). These are coverage counts, not measured overhead/FLOPs/speedups. Retracted claims of strictly better seams, a fixed 30% runtime cost, universally bounded memory and Auto guaranteeing final reference detail must not become acceptance assumptions. Keep reproducible fixtures in the repositories when this work is authorized; scratch probes are not a durable test suite.
- **Acceptance before enabling/replacing anything:**
  - [ ] CPU/contract: turn the boundary/sizing examples into permanent regressions; test clips below/at/above configured context length, final backward-shifted windows, 17n+5 phase, AV coverage/end samples, reference identity and first/last/negative local guide positions. Run actual native tiny-model/executor composition separately from AST/shape fixtures. Reuse/extend Pack `tests/test_h3_tiled_sampling.py`, `tests/test_h3_tiled_native_sampling.py` and DEAS `src-tauri/src/jobs_video_tests.rs`; offline `tools/validate_video_graphs.py` must retain every expected output root, not just report overall valid.
  - [ ] Graph/state: unchanged OFF/legacy graphs; validate ON/OFF/missing capability and malformed settings; unwindowed non-opted branches, generation versus pass-specific models/sigmas/LoRAs, EasyCache/LazyCache and enhanced previews; preserved metadata/history round-trips and strict baseline-first Original/Processed dependencies on success, failure and cancellation. Cover transition/bridge scope deliberately.
  - [ ] Real-model A/B on an explicitly authorized isolated backend: same exact checkpoint/LoRAs/VAE, prompt/media, dimensions, seed, sampler/sigmas/steps and precision; compare unwindowed/native windows/custom temporal refinement with FreeNoise and overlap as separate variables. Include short/long T2VA, I2VA/FL2VA/L2VA, mixed REF2VA and RefMods, off-phase AV guides, fresh/continued jobs from checkpoints and imported video, full-timeline/new-segment output, and spatial tiling/latent upscale/Regenerate/De-rope/face-refine combinations. Do not generalize one family/variant or fixture result to the entire matrix.
  - [ ] Quality/media: inspect full playback and native-resolution boundary crops for seams, identity, motion, flicker, background detail and endpoint crop consistency; listen for dialogue/music continuity and lip sync. Decode outputs to verify geometry, frame/time/sample counts and A/V alignment; assert protected-prefix and original-audio preservation at their specified tensor/media boundaries. Keep baseline products available after actual later-stage failure/Stop; do not claim lossy encoded equality from latent equality.
  - [ ] Performance/native: record cold/warm wall time per stage, model calls/window plans and process/device peak RAM/VRAM on named hardware/runtime; include fixed reference/guide payload and full sampler/VAE/output storage, cancellation latency and cleanup. No foreign-service restarts or implicit GPU/model downloads. Verify actual owned schema/imports and Linux WebKitGTK/libmpv plus Windows WebView2 controls/results/export separately. Publish a measured keep/adopt/reject decision per candidate, including any unresolved quality regression, before removing a fallback or changing defaults.

#### V-16 · H3 Hi-Res Regenerate (Open-H3-Regenerate-2K)

**Type:** ACCEPT · **Needs:** GPU, NATIVE, WIN

**H3 Hi-Res Regenerate (Open-H3-Regenerate-2K refine preset). Status: implemented and released in 0.2.28 (converter, DEAS card; node pack 0.5.49–0.5.51 published, phase logs in 0.2.29), FL2VA GPU acceptance done; remaining items below.** Delivered design, slices and FL2VA GPU evidence: [VERIFICATION.md](VERIFICATION.md#closed-plan-items-moved-from-planmd-2026-11-14). Owner request (2026-11-13). [Efficient-Large-Model/Open-H3-Regenerate-2K](https://huggingface.co/Efficient-Large-Model/Open-H3-Regenerate-2K): 768P draft (1344×768, 121 frames) → author 3D latent upscaler straight to the target grid (latent 48×84 → 90×160; not a uniform factor, the 1.75 draft aspect is mapped onto 16:9) → three Euler steps on `sigmas = [0.909375, 0.857143, 0.666667, 0]`, CFG 1, start `(1-σ₀)·upscaled + σ₀·noise` → 2560×1440.
- Source facts (inspected 2026-11-13; ComfyUI owned env `c5751c8`): the bundle's `latent_upsampler/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` is the same LBH-123-AI model DEAS already accepts (`jobs_video.rs::h3_latent_model`). The refine pass already exists as `DaSiWaH3TiledUpscale` (node `U`, `jobs_video.rs:1815`; model `["SS",0]`, steps/denoise/scheduler, cfg 1, draft audio retained). A pass-only LoRA pattern exists (`DRL` `LoraLoaderModelOnly`, `jobs_video.rs:1590`).
- Header facts: `lora/open_h3_regenerate_2k_lora.safetensors` = 624 tensors, FP32, 11.6 GiB, rank 576 on 312 linears, **Diffusers keys** (`transformer.transformer_blocks.N.attn.to_q|to_k|to_v|to_out.0`, `ff.net.0.proj`, `ff.net.2`, `transformer.token_refiner.refiner_blocks.N.…`). Core `comfy/lora.py:421` maps only native H3 names (`blocks.N.attn.qkv_proj` fused, `out_proj`, `mlp.fc1/fc2`); unmatched LoRA keys are skipped without error, so loading the file unchanged silently runs without the refiner. `lora/sharp_curve_branches.safetensors` = 50 × `adaln_proj.linear.curve_A [64,8]`/`curve_B [96768,64]` (FP32, 1.15 GiB): an ordinary LoRA on curve-form checkpoints (`adaln_t_table`, `comfy/ldm/minimax/model.py:535`, `model_detection.py:420`); the original LMS Sharp ships exactly so in native keys (`diffusion_model.blocks.N.adaln_proj.linear.lora_A [64,8]`). Non-curve checkpoints have no matching target.
- Reference code facts (NVlabs/Sana `sol-engine` `models/Open-H3-Regenerate-2K/open_h3/pipeline.py`, inspected 2026-11-14): `RESOLUTIONS` = 1080p 1920×1088 / 2k 2560×1440 / 4k 3840×2176, 1080/2160 rows centre-cropped after decode; above 2K the upscaler runs to 2K first, then to the target; a latent already at the target is refined without upscaling. Refine is text-only T2VA (no references/keyframes), audio stream = fixed encoded silence at audio sigma 0. The merged LoRA = Open-H3 refiner + **LightX2V FL2VA Turbo v1.2** + LMS Sharp, so it must sit on a model without Turbo/Sharp. ComfyUI's H3 sampling is CONST flow with `t = 1 - σ` (`comfy/ldm/minimax/model.py`), so the published sigmas apply unchanged.
- Out of scope: the fast H3 VAE decoder (`vae_fast/`, different 24-layer architecture, needs FlashAttention-4 + quack, ~30 dB PSNR vs the released VAE), SoL-Engine (sparse attention/MXFP8/CUDA graphs, ~150 GB VRAM), `base_model/` (unmodified MiniMax-H3) and the HyperFlow draft stage. The IC variant (`Open-H3-Regenerate-2K-IC`, draft kept in Ref2VA context for faces/lip sync/lettering) is a separate later evaluation.
- Tunable strengths (DEAS 0.2.36 + node pack 0.5.55, 2026-11-15): the card's **Refiner LoRA strength** (0–2, default 1) is independent; **refinement denoise** (0–1) and **2D sharpness tier** (1–6) are one shared value pair with the Latent upscale card (editing either card updates both; Hi-Res defaults from the published preset stay 1 on the card but the shared authoring default 0.2 is sent only when changed from the node default). Lower denoise selects the tail of the published sigma preset through native `SplitSigmasDenoise` (rounds `3 × denoise`: 1→3 steps, 0.2→1, 0→none; zero steps skips diffusion but keeps upscaling). Absent fields keep the exact legacy graph; changed values require the pack's optional inputs, blocked otherwise with upgrade guidance. Unverified: render quality at other strengths/denoise tiers on real bases (GPU), native WebKit/WebView2 card behaviour.
- Acceptance:
  - [ ] Full int8 Singularity load of the converted LoRA (header match only so far).
  - [ ] GPU: REF2VA references on a Ref2VA base, graviton/Singularity fine-tunes, 1080P/4K targets, GPUs under 32 GB.
  - [ ] Native WebKitGTK/WebView2 check of the DEAS card.
- Risks: the LoRA was trained on the **FL2VA** base, so behaviour on the graviton/Singularity finetunes is unknown — default the card's model to FL2VA (reuse of the generated pass's base as opt-in) and decide by the slice-3 renders; the reference recipe's conditioning (text only vs endpoints vs references) is not stated upstream, so Continuity/Director co-existence is a **quality** question the GPU runs must answer even though the wiring is compatible; rank-1728 fused runtime patching under offload may be slow (consider an opt-in baked checkpoint); spatial tiling can weaken global coherence relative to the dense reference; 2K ≈ 133k tokens.
- Licence gate before publishing any bake/quant/LoRA derived from it (MiniMax H3 Community License territory, `NOTICE` file, modified-file notices; LMS Sharp may add terms); see the `dasiwa-quant-station-development` skill.

#### V-17 · H3 input scaling: Auto vs Fill and crop real-run check

**Type:** ACCEPT · **Needs:** GPU

**H3 input scaling default: real-run check (H3O1).** Resolved 2026-11-16 by owner decision: **Fill and crop** stays the fresh-state default. Source agrees: the `studio.run.video.h3Scaling` preference defaults to Fill and crop and is always sent; the Rust absent-field fallback is the same; saved explicit choices and legacy intent semantics are unchanged. Open: compare Auto against Fill and crop on an aspect-mismatched reference in an authorized throwaway run. Trace native `ref_image_size=match` separately; changing preprocessing alone does not preserve final high-resolution reference conditioning.

#### V-18 · Video/audio playback acceptance

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Playback acceptance.** On Linux, embedded libmpv has replaced the old WebKit/GStreamer path (and its Matroska crash) for all Workbench video. Still open: libmpv runtime acceptance (audible audio, A/V sync, seek/EOF/reopen, resources), WebView2 video on Windows, and WebKit `<audio>` (music/FLAC, audio references) with the bundled GStreamer plugins. Keep `src-tauri/gstreamer/`: the plugins are compiled in via `include_bytes!` and serve `<audio>`.

### 4.2 Video post-processing (TVE) and paired products

Rules: ComfyUI keeps model-dependent work; Rust owns inspection, source retention, recipe compilation and validation. When optional post-processing is enabled the user gets **two real encoded products** (unprocessed baseline and processed result), both selectable/exportable and kept after failure/cancellation; the imported original is preserved. No extra lossy round trip just to save the baseline.

Owner decisions 2026-10-30: (1) the TVE tab compiles the same ComfyUI post recipe the pipelines use (`video-enhance`: LoadVideo → upscale model / `DaSiWa_RTX_UpscalerRefiner` / `DaSiWa_RTX_FrameGeneration` or core RIFE → `DaSiWa_EnhancedVideoCombine`) on the owned backend; (2) the standalone Rust ONNX engine (`video-upscale` feature, `ort`, worker process, output draft/preparation/binding) is retired — it duplicated a strict subset of the backend chain under ≤512 px/≤10 s limits. Shipped in 0.1.67 (see STUDIO.md "TVE post-processing on the backend"): pipeline `videoPost` with B7/7 paired products, all combine codecs/containers/bit depths, model selectors from `upscale_models`/`frame_interpolation`, queue/preview/export through the shared session. 0.2.7 adds the TVE panel's own job polling (a submitted job no longer stays "Queued" while the Studio queue is closed), the RTX `use_mmap`/frames-per-chunk controls and a truncated-safetensors check in the model scan. Open: real GPU acceptance of each stage on the owned backend (RTX nodes need the installed `nvidia_vfx` SDK), HDR, restoration beyond SDK denoise/deblur, baseline-before-processed ordering (PP1 applies to the video savers too), and exact processed geometry in the first/last-frame PNG check (accepted at decoded size).

Reference: TrueVideoEnhancer `67ddb2508fdb6da7f1897bbd964f316592f762d0` (`backend/custom_pipeline.py`, `streaming_pipeline.py`, `render_contract.py`, `nvidia_vfx_pipeline.py`) is a behavioural reference only. Its rawvideo path loses source PTS, its host budgets exclude GPU tensors and its final publication lacks a cancellation check. GPL code reuse does not clear model, NVIDIA SDK or FFmpeg terms.

#### P-01 · TVE stages on the owned backend

**Type:** ACCEPT + SLICE · **Needs:** GPU, CPU

Open items from the owner decisions above (TVE tab compiles the shared `video-enhance` recipe):

- [ ] Real GPU acceptance of each TVE stage on the owned backend (RTX nodes need the installed `nvidia_vfx` SDK).
- [ ] HDR and restoration beyond SDK denoise/deblur (see R-04 for full TVE parity).
- [ ] Exact processed geometry in the first/last-frame PNG check (currently accepted at decoded size).
- Baseline-before-processed ordering for the video savers is tracked in P-05/P-06.

#### P-02 · Memory-bounded video decoding/export and optional SSD staging

**Type:** SLICE · **Needs:** GPU, CPU

**Memory-bounded video decoding/export and optional SSD staging. Status: stock-H3 fused streaming path implemented and CPU-gated in 0.2.38 (opt-in, default OFF); real-VAE/GPU 362-frame case and LTX/Wan paths open.** Owner-approved scope: shared bounded output infrastructure for H3, LTX and Wan, starting with the reported 15-second H3 Hi-Res 2K memory failure, then validating LTX and Wan separately. Prefer temporal-window decoding directly into incremental video encoding when no subsequent frame effect requires intermediate storage; evaluate an explicit default-OFF SSD-backed intermediate for downstream effects that cannot consume the stream directly. Share bounded buffers, storage lifecycle, RAM/disk admission, progress, scoped Stop and safe publication; keep temporal decoding rules specific to the model/VAE, not a universal chunk size. SSD staging is application-owned temporary storage, not operating-system swap; do not assume mapping a file makes downstream tensor operations bounded. This scope bounds decode/post-processing/export memory, not the sampling or model-loading footprint.
- **Owner decision (2026-11-24): LTX and Wan follow the same policy — opt-in, default OFF**; automatic activation under memory pressure is reconsidered only after measured real runs prove the bounded paths. **Owner decision: opt-in, default OFF.** First implementation is a DEAS-owned fused stock-H3 latent decoder/saver for full-timeline latent upscale/Hi-Res regenerate. Existing jobs remain unchanged while off. One explicit control; no automatic activation, service changes or foreign Core/pack edits. Requested combinations needing full IMAGE consumers must give concrete reasons rather than being advertised as bounded. Sol/noncausal, segment-only capture, LTX and Wan require separate supported paths/proofs.
- **Source-backed mechanism, not a fatal-allocation diagnosis:** owned Core preallocates the complete float32 RGB result even when H3 internal decode workspace is chunked. Baseline RGB at the reported dimensions is 2.763 GiB and processed RGB 10.626 GiB; caches and upscale staging can retain additional state. Reuse stock H3 finalized output-buffer writes and `VAE.prepare_decode`, not independently decoded/blended windows. Stream both Original and Processed; processed latent/audio dependencies remain lazy until Original publication. This bounds pixel decode/export only, not sampling, model residency or upscaler latent staging.
- **Implementation/acceptance:** pin the private stock-decoder sink contract and fail clearly on unsupported Core/model layouts. Reuse installed codec/audio/frame helpers with synchronous bounded encoding, no-clobber attempts, exact frame/timing readback, cancellation and retained Original. CPU oracle compares the actual Core temporal algorithm with deterministic fake decode output against tensor/sink destinations; real codec/audio/fault tests establish publication behavior, not learned-VAE quality. Small actual-VAE comparison and the isolated measured 362-frame case remain mandatory before claiming the reported OOM fixed; GPU is occupied and no live service may be stopped implicitly.

**Measured demand (2026-11-19, isolated 362-frame case with the bounded path ON).** Distinct model files named by the compiled graph total **42.54 GiB** (H3 int8 UNet 20 + 32B nvfp4 AWQ text encoder 15 + video VAE 4.9 + regenerate LoRA 2.4 + upscaler/audio VAE 1.2). Measured growth for the run: **+43.6 GiB** system RAM, backend RSS 43.04 GiB peak, of which ~99 % is `[anonymous/private]` — weights are private allocations, not reclaimable file mappings (≤ 1.06 GiB mapped at any sample). No full-RGB-batch spike appeared while the bounded path was on; the post-sampling rise was ~+6 GiB. With the bounded path OFF, the same job should need ≈ 42.5 + 2.76 + 10.6 ≈ 56 GiB of process demand — on a 61.7 GiB host with `earlyoom -m 5 -s 10 --prefer python|python3|torch|ComfyUI|comfy|…` that is the reported kill. Full breakdown: [Verification](VERIFICATION.md#p-02-residency-verdict--the-failed-stage-is-now-identified-2026-11-19-1700--1719).

**Verified evidence and source boundary.** The reported job contains 362 frames at 736×928, a 3D latent upscaler and Hi-Res target 2K (portrait target 1440×1824). The user journal records `systemd-oomd` terminating the DEAS process group on 2026-11-15 at 19:53:13, with 48.1 GB memory peak and 18.4 GB swap peak; the precise failing allocation/stage is unconfirmed. A complete target-size RGB float32 frame batch alone is approximately 10.6 GiB. Concurrent verification also used up to 3.9 GB and must not be conflated with the generation's own demand. `src-tauri/src/jobs_video.rs::decode` currently emits `VAEDecode`/`VAEDecodeTiled`, followed by full-IMAGE consumers and savers. Node-pack `nodes_minimax_h3_regenerate.py::DaSiWaH3HiResRegenerate.regenerate` already delegates to `DaSiWaH3TiledUpscale.upscale` with automatic temporal chunking and spatial tiling; its full CPU latent staging and RAM check do not bound the complete decode/post-processing/export chain. Merely exposing another chunking switch or enabling tiled decode is not the solution.

Acceptance:
- [ ] Trace actual peak allocations and retained executor outputs through baseline decode/save, learned upscale, refinement, processed decode, optional effects and final encoding. Separate RAM, swap and VRAM; identify the failed stage before claiming the reported OOM fixed. Start with existing Core decoder, encoder and node-pack primitives, not a separate inference service.
- [ ] Implement a bounded H3 decode-to-encoder path for Hi-Res/latent-upscale output without further pixel effects, then extend the same bounded output infrastructure to LTX and Wan. The existing `jobs_video.rs::decode` helper is already called by `ltx`, `wan` and H3 paths; reuse that compiler seam without treating shared graph emission as decoder equivalence. Declare per-model/VAE temporal compression, valid window boundaries, required context/overlap, tail handling and duplicate-frame cropping using installed Core implementations. Preserve exact frame order/count, source timing and H3/LTX audio alignment (including video-only Wan paths); compare window edges and full decoded output against a small full-timeline oracle for each family. No universal chunk size or assumed cross-VAE equivalence. A cached list of all decoded chunks does not count as streaming.
- [ ] Preserve independently encoded Original and Processed products and baseline-first ordering, including partial failure and scoped Stop. Never mutate cached source frames, discard the baseline or introduce an extra lossy intermediate encode solely to reduce RAM. Keep existing recipes/intent behavior unchanged when the new path is not selected or supported; capability gaps must be explicit.
- [ ] Audit each downstream effect for bounded-window support. For effects needing retained frames, evaluate optional SSD staging with explicit consent, configured temporary location and a proportional free-space budget, bounded reads/copies, source ownership, cancellation cleanup and crash-orphan recovery. No silent swap dependence, fixed GiB caps or forced SSD writes when disabled. Define the initial streaming-path activation policy before implementation; only SSD staging is explicitly default OFF here.
- [ ] Add end-to-end RAM admission covering decoder workspace, live model/offload residency, cached baseline/processed products, intermediate effects, encoder buffers and concurrent host/cgroup pressure. Recheck at allocation boundaries and fail with actionable diagnostics/progress in central Logs instead of losing the app; estimates are not allocator guarantees.
- [ ] Verify CPU contracts and injected allocation/disk-full/cancel failures, then repeat the owner's 362-frame portrait 2K case on an isolated authorized backend with measured RAM/swap/VRAM and wall time, playable paired outputs, no temporal seams, preserved audio and Stop behavior. Require equivalent measured LTX and Wan runs with family-valid short/tail/window-boundary cases before marking those families supported; H3 acceptance alone is not cross-model proof. Avoid simultaneous heavy test/build workloads. Keep Linux native and Windows runtime acceptance separate. Any new controls require seven locales, global search and STUDIO documentation; node-pack changes require their own reviewed compatibility tests and version/changelog when implemented.

#### P-03 · H3 automatic whole-video face refinement

**Type:** SLICE + ACCEPT · **Needs:** GPU, NATIVE, WIN, OWNER

**H3 automatic whole-video face refinement. Status: implemented and released in 0.2.23; remaining items are quality refinements and native-app acceptance.** Owner request: a DEAS-native Post-Processing stage for H3, automatically chained after generation and usable on an existing whole video, with scene/face detection and a few important controls. Default OFF. No user-installed FaceRefine/Impact Pack/VHS/NativeAudioLock dependency chain; refinement runs through core SAM3/MiniMax H3 nodes plus the bundled DEAS adapter (`sam3_video_window.py` → `DEAS_H3FaceRefine`). Behaviour and limits: [STUDIO.md](STUDIO.md#h3-face-refinement); evidence: [VERIFICATION.md](VERIFICATION.md#h3-face-refinement-0223).

- [ ] Per-frame strength by face size (plan; reference `H3PerFrameDenoise`): close-ups should change less than distant faces (measured: 0.4 of 8 steps rewrote close-up identity, helped distant faces). The owned core already blends fractional H3 noise masks per token (`model_base.py::scale_latent_inpaint`, `x_blend_weight`), so first test whether a per-latent-frame mask value scaled from the face height (e.g. full strength below 10 % of frame height, falling to ~60 % of it at ≥40 %) gives a per-frame effective strength without a model patch. If the blend is not equivalent to a lower start sigma, fall back to splitting a shot at face-size changes. Acceptance: identity kept on close-ups at the default strength, distant faces still sharpened, no flicker where the scale changes.
- [ ] Real GPU run of face refinement combined with H3 latent upscale (graph validated offline only).
- [ ] **Regression: face refine on an already-made video truncates output and appears silent. Fixed CPU-side in 0.2.38 (RF1/RF2: whole-source manual refinement, see [CHANGELOG](CHANGELOG.md#0238-beta)); RF3 real GPU run open.** Owner approved prioritizing this fix before memory-bounded export. Reproduced through the actual Workbench payload: `refineFaces` copied the face-mask analysis window (`samVideoStart`, `samVideoDuration`, default 2 seconds) into standalone refinement. The matching real input has 124 frames / 24 fps (5.166667 s), while both saved Original/Processed products have 48 frames (2 s); their embedded graph requests exactly 2 seconds. Both outputs contain the same nonzero AAC audio packets (not a missing stream), while substantially higher source audio energy occurs after the clipped interval. This supports a shared truncation cause; audible playback of the original complaint remains unverified. Native compiler audio wiring is already present and must not be replaced speculatively.
  - [ ] RF3: repeat the full refinement on an isolated authorized GPU backend with the original/representative clip; require full-length playable output with preserved audio and real cancellation/retention. The current GPU is occupied by Strata; no service shutdown, model loading or GPU run is implicitly authorized. Native Linux/Windows interaction remains separate.
- [ ] Tracker coverage and cut calibration (plan): build a small labelled owner set (dance/fast motion, flashes, slow fades, hard cuts, anime/stylised, tiny and multiple faces, occlusion/re-entry; 10–15 clips). Measure face presence per frame against hand labels at threshold 0.3/0.4/0.5 and detect interval 1/2, and cut precision/recall of the frame-statistics detector against labelled cuts across its threshold range. Set defaults from the curves, document the measured ranges in STUDIO, keep the controls. Known point: on a dancing 15 s shot SAM3.1 at 0.5 tracked the face in 94 + 20 of 362 frames.
- [ ] Hard-cut threshold calibration against motion/flashes/gradual transitions; native Linux WebKitGTK/Windows WebView2 interaction of the controls in the running app.

**Source/reuse baseline.** Behavioural reference: [Carasibana/ComfyUI-H3-FaceRefine](https://github.com/Carasibana/ComfyUI-H3-FaceRefine/tree/d7ae3ee1ec445ea29fff7fc7366fa6fe85bdc2f5), inspected at `d7ae3ee1ec445ea29fff7fc7366fa6fe85bdc2f5`. MIT code, copyright Carasibana; retain notices for any adopted portions. `nodes.py::_make_cut_detector` uses PySceneDetect AdaptiveDetector; `H3FaceTrackCrop` tracks/stabilizes crops, `H3InjectVideoLatent` VAE-encodes source crops into H3's video latent, `H3PerFrameDenoise` patches model/mask behaviour and `H3FaceStitch` composites results. `H3FaceMaskSAM` uses an existing `SAM_MODEL` on source crops per frame with temporal smoothing, not SAM3.1 video tracking. Its injection code can trim/pad a temporal mismatch; do not inherit silent geometry/timing changes. `pyproject.toml` declares ultralytics/scipy/insightface/scenedetect; MIT wrapper licensing does not establish detector/identity/SAM/H3 checkpoint rights. README and package versions differ, so bind review to the commit, not just a version label.

**DEAS seam and recommended design.** `src-tauri/src/jobs_video_post.rs::chain` currently handles upscale/RTX/frame generation, not tracked H3 face refinement. `jobs_video.rs` emits Director/Guide H3 recipes; existing still-image `jobs_sam3.rs::compile` and `jobs_auto_refine.rs` do not establish temporal masks, scene-aware identity tracking or video refinement. The installed owned core already exposes `comfy_extras/nodes_sam3.py::SAM3_VideoTrack`: initial masks or text conditioning, new-object detection threshold, maximum object count and detection interval feed `forward_video`. Prioritize this existing API before considering any new tracker dependency; its batched IMAGE input does not establish bounded whole-video streaming or exact upstream Object Multiplex parity. Keep Rust in charge of source inspection, frame-indexed shot/track plans, scheduling, validation, progress/Stop and no-clobber publication; keep H3/SAM tensor inference on the existing owned ComfyUI execution boundary. Investigate available core/owned-adapter APIs first. If a small missing computation primitive needs a DEAS-managed adapter, identify and validate that seam explicitly rather than promising a Rust-only H3 inference rewrite or silently installing the reference node pack. Any required upstream change needs separate authorization/review under the cross-project rules. “No extra installs” means no manual third-party node/package setup; ML weights/runtime requirements still need honest discovery and consented DEAS provisioning when absent.

**Source-backed implementation notes (owned core `fca60fe70e5b84c5c6b058263653d15cb3401e44`).** `SAM3_VideoTrack` does not expose carry-state between calls; independent windows restart associations, and its text-conditioning conversion discards the still-image top-k suffix. Use `max_objects` for its documented 1–64 object limit, not `face:200` as an object-count control. The union-mask path uses `SAM3_TrackToMask` → `MaskToImage` → encoded output because ordinary indexed output parsing limits a job to 64 files. This is a silent diagnostic mask video, not refined footage or per-person track metadata. Core already offers `VAEEncode` plus `LTXVSeparateAVLatent`/`LTXVConcatAVLatent` for H3-compatible source-video latent injection; inspect/reuse those before porting the reference's injection node. Director references are conditioning, not an img2img starting latent. Tracker progress reaches core's interruption hook; preserve the existing scoped cancel path.

**Automation proposal.** One decode/analysis pass where practicable: detect hard cuts and candidate faces, form stable per-person tracks within each shot, refine temporally coherent crop clips and stitch them back through source-derived masks. Evaluate a **SAM3.1-first detection/segmentation/tracking path** using a face concept prompt and the existing core video tracker; do not require a separate face detector merely to find/track faces. Meta explicitly supports text-prompted video detection and tracking ([SAM3.1 release notes](https://github.com/facebookresearch/sam3/blob/main/RELEASE_SAM3p1.md), [official announcement](https://ai.meta.com/blog/segment-anything-model-3/)). Keep a specialized detector as a conditional fallback only if measured tiny-face/anime recall, mask quality or resource cost warrants it. Temporal track association is supported; biometric identity and reliable cross-cut/re-entry identity are separate requirements, as is cut detection. Meta reports 32 fps for a medium-object workload on H100, not measured face-tracking throughput on this host and not real-time H3 refinement. Reuse installed compatible models where possible; never silently download weights. Compare a native FFmpeg/frame-statistics cut path against the reference adaptive detector on fast motion/flashes; do not claim equivalent accuracy without evidence. Reset crop/mask smoothing at cuts. Missing/occluded/ambiguous faces keep original pixels with a report, never jump to the nearest other person or refine the full frame. Multiple faces need stable IDs and deterministic separate passes. Automatically process the entire admitted video, with shot-aware, bounded temporal windows and overlap only within a shot; no per-frame independent image detailer that causes boiling.

Original acceptance, reconciled with the landed HF1–HF4 code (review 2026-11-11 of `jobs_face_refine.rs`, `sam3_video_window.py::H3FaceRefine`; adapter suite 27/27 re-run green against the owned core):
- [ ] Controls still missing from the proposal: selected tracks, per-track/shot exclusion, optional identity reference; read-only track preview with manual corrections (today only the silent union-mask analysis video). Selected tracks/exclusion need that preview first (track indices are meaningless without it).
- [ ] Memory: the adapter takes the whole decoded video as one IMAGE batch and keeps a full float copy (`images.clone()`). The copy is required while the input is a cached upstream output (the baseline `SD`/`DRR` tensor; in-place stitching would corrupt it for cached re-runs), so the real fix is per-shot windowed decode/encode inside the adapter, not dropping the clone. No analysis cache by source + settings.
- [ ] Crop geometry: context scales with the tallest per-frame face height only (`crop_box`), and every crop is resampled to the 768 canvas, so a 100 px face is upscaled ~7.7× for a full 768 H3 pass per face and shot; the size cutoff above should gate tiny faces.
- [ ] Real-H3 measurements on owner clips: temporal flicker, seams, lip sync, identity drift, time, RAM and peak VRAM; cuts, occlusion/re-entry, crossing people, tiny faces, anime, short shots/tails.
- [ ] Native Linux WebKitGTK/Windows WebView2 use of the new controls in the running app (HF1–HF4 shipped in the v0.2.23 release; native interaction not yet checked).

#### P-04 · H3 de-rope

**Type:** SLICE + DEFECT · **Needs:** GPU, OWNER

**H3 de-rope. Status: implemented for MiniMax H3 (released in 0.2.23, DaSiWa nodes 0.5.43+); real-model acceptance and other families open.** Source: MATLOWAI ComfyUI-MAINodes Motion Lab at `db1f62d` (GPL-3.0-or-later). Hold planning, smear, audio stretch and recovery are bit-identical to Motion Lab (120 random profiles + audio, compared in a scratch run; pinned in the node pack's `tests/test_h3_derope.py`); both graphs validate against the owned core (`valid=True outputs=['7','P','B7']`); Prepare/Recover ran on CPU with the real H3 video/audio VAEs (39 → 107 → 39 frames).
- [ ] Background softening (Laplacian variance −40 %): not an inject artefact (0.70 is not sharper and re-invents the clip; 0.48 stays default). **Keep static background — source implemented, quality/native acceptance remains open.** Node-pack Recover 0.5.45 has additive optional inputs, bounded mask/compositing and same-clip CPU A/B checks; DEAS has the default-OFF switch, verified-ABI capability gate, native intent/graph wiring, restore/search/locales. Measured clip A restores only part of the background detail (fixed-crop gradient +1.95% overall, +7.48% tail versus OFF); clip B changes the scene broadly and falls back to ON exactly equal to OFF. Temporal MAE rises slightly on A, so no flicker-free claim or baseline-level sharpness acceptance is closed. Node pack 0.5.45 is published on both remotes; the owned environment's checkout is at 0.5.58 (checked 2026-11-17), so the switch is available there after a backend restart. *De-rope Recover* gets the baseline frames and an opt-in `keep_background` (default OFF); the result is `baseline·(1−m) + derope·m` with m built per frame from (a) baseline motion (frame difference to the neighbours) and (b) where de-rope moved content (|derope − baseline| above a threshold), dilated, feathered and smoothed over a few frames so edges do not boil. Camera motion makes m cover the whole frame, which degrades gracefully to today's full de-rope. Pixel compositing, not a latent noise mask, because the init latent is already a VAE re-encode and would stay soft. DEAS: one switch "Keep static background" in the De-rope group. Acceptance: background sharpness back to the baseline on the measured clips, no ghost limbs at mask edges (the |derope − baseline| term covers limbs de-rope moved), no flicker increase; node pack version bump + changelog.
- [ ] **Owner-reported grey field around the moving body in clip B.** Keep this as a failed visual-quality case for background preservation, not a successful fallback example. Frame 40 of the current B Original/OFF/ON comparison shows a pale/grey motion halo around the kicking leg in both processed columns; B ON equals OFF at the pre-encode tensor boundary. This localizes the sampled halo upstream of the new background composite, but does not establish its sampler/VAE cause or identify every frame the owner saw. The full-frame fallback preserves that defect rather than fixing it. Acceptance: inspect the owner's affected timestamp/region and the entire matched playback; remove the grey field without old-limb ghosts, cloud seams or additional flicker. Do not mark B accepted merely because ON equals OFF or tune thresholds blindly.
- [ ] **Reference execution parity — audited, controlled GPU comparison still open.** Read-only audit (MAINodes `db1f62d`, owned core `74eb0c4`): DEAS implements the classic pixel-smear method; Prepare/Recover, hold maps and the `BasicScheduler` → `SplitSigmasDenoise` tail selection are equivalent to `H3InjectSchedule` for the allowed 0.48/0.7 cases. There is no single reference default: classic = base model, simple, 25 steps, inject 0.7; fast-iterate/upscale = non-turbo pruned int8 base + dedicated turbo LoRA (strength 1), beta, 6 steps, `gradient_estimation`, separate seed, effective inject 0.5 (preset overrides the stored 0.7), and both rescale before encoding (fast 0.2 → 0.4 MP, upscale 0.4 → 1.5 MP), so neither is a same-resolution control. Reference spatial freeze exists but is off in every shipped example; the old grey-masking core regression is already fixed in the installed core. Measured B differs in model (turbo checkpoint, no pass LoRA), sampler (Euler), shift 10/3 (native default 12/3), inject 0.7 and shared seed — confounded quality variables, none proven to cause the grey field.
  - [ ] LoRA de-duplication between the generation chain and the pass LoRA is name-only and keeps the generation strength.
  - [ ] Controlled real comparison on the same baseline (background preservation OFF): current path vs the reference fast recipe on the nearest available weights (non-turbo int8 base + dedicated turbo LoRA, never stacked on a turbo checkpoint), one variable at a time (sampler, seed, inject, shift). A first GPU attempt was aborted by a provider rate limit before any inference; no result exists yet.
  - [ ] Real-data contracts: oracle/holds/smear/recover and H3V2VInit tensors against the pinned reference on real VAE latents; actual scheduler tensors for shift 10/3 and 12/3; endpoint keyframe positions on real Director conditioning.
- [ ] Superseded note — source comparison against MAINodes `db1f62d` `examples/motion_pipeline_upscale_derope_api.json` shows its second pass uses `gradient_estimation`, a separate seed and a dedicated turbo LoRA. Critically `H3InjectSchedule.inputs.inject` is 0.7 but preset `faithful detail 0.50 (metric best)` overrides it in `motion.py::H3InjectSchedule.sigmas`: the effective 6-step pass runs 3 steps. Measured DEAS clip B instead uses Euler, reuses the generation seed/model chain without the dedicated pass LoRA, and actually runs inject 0.7 (4 steps). Helper arithmetic parity is not full graph/model parity. Reproduce the reference's effective settings on the same baseline and compare before attributing B's grey field to De-rope itself; exact causal contribution and the complete reference model/VAE/scaling/conditioning path remain unproven.
- [ ] Still to measure: a dedicated turbo LoRA vs the distilled generation model.
- [ ] De-rope for a new segment continued from an imported video (window built inside `SegmentPrepare`, no compile-time crop) — refused with a reason.
- [ ] Option to measure: Motion Lab's upscale-in-pass-2 (one sampling pass instead of de-rope + upscale, but without the tiled upscaler's memory planning).
- [ ] De-rope on existing videos (Media/TVE): VAE re-encode of the source as the oracle latent, prompt from metadata.
- [ ] Turbo pass uses Motion Lab's 6 steps on `beta` with the user's sampler and the generation noise seed; Motion Lab used `gradient_estimation` and a second seed. Measure whether the sampler choice matters on owner LoRAs (DMAD/PDMD/LightX2V/Pika are on disk).
- [ ] Continuity join after de-rope (plan): the stored checkpoint is the raw sampled latent, so the next segment continues from an un-de-roped tail. Measured once: first processed frame vs the un-de-roped take's last frame 12.4 vs 6.6 mean abs /255; pass 2 without keyframes in continuations is unmeasured. Options in order: (1) measure the join on 3+ two-segment clips (frame difference across the cut, visual); (2) if visible, publish the de-roped window as the checkpoint (VAE re-encode of the recovered frames beside the original audio latent, same seam as the latent-upscale path) so continuation and output agree; (3) otherwise adopt Motion Lab's `MiniMaxH3ChainDeropeContinuity`/`Guard` approach. Keep the raw latent as the default until (1) shows a problem.
- [ ] Other families. Motion Lab's any-model layer (`DEROPE_ANY_MODEL.md`) runs LTX-2.5 only on a flat clock (hold 16 per window, 8k+1 grid, 960-frame cap per pass, several spliced windows) and measured that the oracle-shaped clock does not fix LTX's weak denoise response; its Wan 2.2 profile is an unmeasured placeholder (hold_scale unknown, x4 exceeds the 81-frame training length). Adopt only after a measured ladder per family; the DaSiWa nodes would take a per-family grid/latent clock instead of H3's 17k+5.

#### P-05 · PP1 — image runtime acceptance and video ordering

**Type:** ACCEPT · **Needs:** GPU, NATIVE, WIN

**PP1 — remaining image runtime acceptance and video ordering.** Image sequencing (PP1a/b, 0.2.19) is implemented and verified with the installed CPU executor; evidence and limits are in [VERIFICATION.md](VERIFICATION.md#image-baseline-first-pp1ab-0219-shipped-in-0219). Keep these acceptance gates separate:
- [ ] Real-model image refine/upscale on an isolated authorized backend: baseline retention during real loader/sampler failure or physical Stop, quality and resource measurements, actual installed-adapter coexistence and native Linux/Windows result selection/export. Do not restart foreign GPU services. Actual metadata PNG encoding is CPU-verified; selected WebP-format runtime acceptance remains separate from the unchanged PNG-only indexed transfer boundary.
- [ ] **PP1c: video ordering — encoded-video chain landed in 0.2.22 (CPU-executor verified).** `jobs_video.rs::post` routes the whole TVE chain through `DEAS_VideoPostprocessGate` (same lazy ABI as the image gate, eager input = `DaSiWa_EnhancedVideoCombine` filename socket of `B7`), so `B7` is encoded before any post node or post-model loader; admission fails closed without the gate ([evidence](VERIFICATION.md#video-baseline-first-pp1c-0222)). Open: **PP1c2 learned latent upscale — real-model/native acceptance.** The shared lazy gate now covers latent-upscale-only H3/LTX jobs, full-timeline H3 audio and H3 segment capture (its single SegmentDecode remains before upscale, with exact shared segment audio; Processed uses core decode/crop). Native and frontend admission require the verified gate. CPU executor retention/failure/interruption checks and transitive graph-closure tests are recorded in [VERIFICATION.md](VERIFICATION.md#latent-upscale-baseline-first-ordering-0223). Still prove real H3/LTX learned-upscale loader/sampler failure and physical Stop with retained, playable/exportable Original, measured resources, real GPU RTX/RIFE runs, and native Linux/Windows cancel/history with `PG`.

#### P-06 · Paired-video acceptance

**Type:** ACCEPT · **Needs:** GPU, NATIVE, WIN

- [ ] **Paired-video acceptance.** Baseline boundary per chain; both products in results/library/compare/export with seven-language role labels; decoded readback (dimensions, frame count/timing, audio, colour/bit depth); measured RAM/VRAM/throughput per platform.

### 4.3 Music (YuE2 and ACE-Step)

#### M-01 · YuE2 and ACE-Step remaining work

**Type:** SLICE + ACCEPT · **Needs:** CPU, GPU, NATIVE, WIN

YuE2 delivered in 0.1.66; ACE-Step Text to Music delivered in 0.2.16 (see [MUSIC.md](MUSIC.md)); cover source preflight and the external-backend FLAC export check closed in 0.3.25 ([verification](VERIFICATION.md#music-cover-source-preflight-and-external-flac-export-m-01-0325)). Open:

- [ ] Live-backend SheetSage2 list multiplicity with real weights.
- [ ] Real Text to Music (Full/Melody/Off), audio and video covers, scoped cancellation.
- [ ] Native FLAC playback on WebKitGTK and WebView2; Windows runtime.
- [ ] ACE-Step: real-model inference for authorized local original 1.0 and representative 1.5 AIO/split Base/SFT/Turbo/XL weights, plus native Linux/Windows picker, FLAC playback/export and audio post-processing acceptance (§4.5 F3b).

Constraints kept from the implementation plan: signatures from one checkpoint do not cover every YuE2 variant (unknown variants stay unavailable; no filename fallback); missing optional nodes disable only the affected modes; no transcription, voice cloning, extra codecs, cloud fallback or automatic installer changes.

### 4.4 Image: masking, references, regional prompting

#### I-01 · Inpaint colour pipette / screen eyedropper

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Inpaint eyedropper. Status: 0.3.10 replaced the screen eyedropper (portal PickColor hung on the owner's KDE desktop and `EyeDropper` is absent from WebKitGTK) with an in-picture eyedropper tool; native runtime acceptance pending.** The icon button sits in the colour group, which is rendered only while a picture is the active layer; clicking the picture samples the visible picture stack (pictures + strokes, never masks) through blob-decoded bitmaps and returns to the previous tool. Picking a colour must not paint, alter a mask or start generation. jsdom covers sample/apply/return and mask-hidden colour group.
- [ ] Native acceptance only: pick a known picture colour in the Linux WebKitGTK app and in Windows WebView2, with wheel zoom between pick and paint, and Ctrl+Z/Ctrl+Shift+Z over mask and picture strokes.

#### I-02 · SAM 3.1 masking and native Auto Refine

**Type:** ACCEPT · **Needs:** GPU, NATIVE, WIN, OWNER

**SAM 3.1 masking and native Auto Refine. Status: implemented (0.2.19); real-model Linux GPU evidence recorded in VERIFICATION.md; WebKitGTK/WebView2 runtime acceptance open.** Owner decisions: core `SAM3_Detect` supplies text, positive/negative point and box masks; a picked result creates a separate editor mask layer, never replaces an existing mask. Alt-click adds a negative point; source-pixel mapping must remain correct through zoom/pan. SAM video tracking is out of scope.
- **Independent targets, unchanged generation baseline.** The SAM targets field is separate from positive/negative generation prompts. Commas, semicolons and newlines separate ordered target groups: `eyes; feet; hands` means eyes → feet → hands. Union every match within one target (both eyes together); run distinct targets as sequential masked-only passes, not one merged mask. Picked mask layers remain separate. Keep the base checkpoint/model, prompt, steps, CFG, sampler and scheduler; configurable denoise defaults to **0.25**, cropped context margin to **32 px**. Composite only masked pixels back; retain original and processed products, including on failure/cancellation.
- **Explicit optional execution.** Post-generation Auto Refine defaults OFF; provide manual **Auto Refine** for an existing image as well. Automatically select an available SAM checkpoint when no usable choice exists, preserving a valid saved selection; do not download weights or add a fictitious installer. After accepting the custom SAM License, manually install `models/checkpoints/sam3.1_multiplex_fp16.safetensors` in the selected ComfyUI model root. Missing `SAM3_Detect` directs users to update the owned ComfyUI through Backend. Each target must fit SAM's text encoder (≤32 tokens); Measured on an isolated owned 32 GB test GPU backend: first text pass 27.6 s (SAM load included, 17.8 GiB peak), warm point/box passes 2.6 s at ~12.3 GiB in the backend process.
- [ ] Physical Stop-press during a serial run, human quality judgement, and native Linux WebKitGTK / Windows WebView2 runtime acceptance (a fixture or cross-build does not close these).
- Frontend-only follow-ups: select-all-similar colour (non-contiguous wand), edge stop (gradient barrier).

#### I-03 · MiniMax H3 image edit with multiple references

**Type:** ACCEPT · **Needs:** GPU, NATIVE, WIN

**MiniMax H3 image edit with multiple references. Status: still path and References overlay image mode implemented (0.2.25); image latent upscale implemented and GPU-accepted (0.2.25/0.2.26, see VERIFICATION); image face refine implemented (0.2.38, GPU quality acceptance open).** Owner question: can DEAS do the community workflow "MMH3. Image edit v02" without external nodes? Yes — pass 1 is a reference-driven regeneration from an empty 1-frame still AV latent with core `MiniMaxH3ReferenceToVideo` conditioning; its external nodes (`FizgigH3Still*`, `AILab_YoloV8`, rgthree, `MinimaxH3LatentUpscaler3D`) are conveniences. Landed: `nativeImageReference` method `minimax-h3` (1..8 user pictures; the edited picture is always `<Picture 1>`), `jobs.rs::h3_edit` still path (`HR` → `AS`/`AC` `LatentCut` audio t=2 → `CA` `LTXVConcatAVLatent` with the kept `9`/`X` encode + noise mask, intent denoise), separate H3 Denoise pref (default 1.0), the 4.11 Auto Refine denoise fix. Evidence: [verification](VERIFICATION.md#h3-image-edit-with-references-still-path-0225).
- [ ] A real SAM Auto Refine H3 run through the Workbench (SAM detection + chained passes) in the running app; the pass graph itself is GPU-verified at 2 MP. Watch reference attribute leakage (pink streaks carried over in the outfit-swap test).
- [ ] Native Linux WebKitGTK / Windows WebView2 click-through of the image References overlay (picker, reorder, Insert label, Escape focus) and its narrow-layout visuals; fixtures only so far.
- **H3 face refine for images. Status: implemented (0.2.38); CPU/offline gates recorded in VERIFICATION.md; GPU portrait/group quality acceptance open.** `DEAS_H3FaceRefine` accepts a single frame only through the explicit `still_image` opt-in (`temporal_shape` padding; short shots inside videos keep the skip; adapter test: a 1-frame input changes inside the mask only). `h3_edit` calls `jobs_face_refine::insert` with `images` from the composed frame, `audio:None`, `fps:24`, `model:["SS",0]` and explicit clip/VAE links, behind `DEAS_ImagePostprocessGate` (baseline `B7` + refined `7`); with latent upscale the refined image is re-encoded beside the untouched audio latent before upscale. Intent: `faceRefine` (existing validation) only with `h3Edit`; UI offers the shared face-refine fields for `h3Image` with a separate default-OFF enable pref (`studio.run.imageFaceRefine`) so older video-refine users are not opted in, `postCategoryFunctions` counts stay consistent, search, seven locales. Gates: dump variants (+ refs, + latent upscale) valid; Rust wiring/gate/rejection tests; Vitest; `tools/verify_image_postprocess.py` order probe; GPU on a portrait and a group picture at 0.25 vs 0.4 remains open.
- Risks kept from the handoff: still audio t=2 follows the core p-h3-image convention (the reference's Fizgig latent source was not inspected); `ref_image_size` stays `match` (`max` keeps identity better but is several times slower — no toggle unless asked); core `MiniMaxH3FunControlNetApply` (real pose/depth control) and an automatic SAM3 face crop as reference are later options.

#### I-04 · More reference techniques

**Type:** FEATURE · **Needs:** PRIORITY

**More reference techniques.** SDXL IP-Adapter (external `ComfyUI_IPAdapter_plus`; consent/license check first), Flux Redux via core style-model nodes, edit models (Flux Kontext/Flux.2/Qwen Image Edit) through their own reference nodes, OS-file drops onto the prompt, and video/audio chips reusing the H3 reference contract. Unsupported families must explain why instead of ignoring references.

#### I-05 · Regional prompting

**Type:** FEATURE · **Needs:** PRIORITY, GPU

**Regional prompting (planned).** Opt-in regions (name, positive and optional negative prompt, strength, rectangle or painted mask), SDXL first; the global prompts stay. No enabled region means an unchanged graph.
- [ ] Prove a two-region SDXL recipe on the owned backend first (`ConditioningSetArea`/`ConditioningSetAreaPercentage`/`ConditioningSetMask`/`ConditioningCombine`) against a fixed-seed baseline; record placement, leakage, latency and VRAM.
- [ ] Typed region data in `execution.ts` and native validation in `jobs.rs`; required nodes in `recipe_prerequisites.rs`; families in `builtin.json`; bounded payloads and in-bounds geometry.
- [ ] Region editor via Workbench and `StudioImageEditor`; text-to-image needs an output-sized canvas; region masks stay distinct from inpaint masks.
- [ ] Coordinates against the generation canvas through zoom/pan/resize/crop-inpaint/refine; snapshot before uploads; Run Plan/metadata/preset serialization.
- [ ] Compiler parity tests, UI tests and a real artifact per advertised family; seven locales and guides.

### 4.5 Models

#### MD-01 · Image Lying Sigma contribution — remaining acceptance

**Type:** ACCEPT · **Needs:** GPU, NATIVE, WIN

- [ ] Bundled sampler deployment through real owned-backend startup on Linux
  and Windows. Adapter filesystem/numerical fixtures and the real ComfyUI core
  with CPU tensor/model doubles pass; native startup/real-model acceptance stays
  separate. No extra installer option or full Detail Daemon package is required.
- [ ] Native WebView2 narrow-pane/history interaction and Linux/WebKitGTK
  interaction with the new default-zero control, missing-node recovery and
  real-backend node coexistence. Browser/component fixtures do not close these gates.
- [ ] Explicit real-model comparisons with identical seeds/settings (including
  Anima), plus quality, cancellation and RAM/VRAM/runtime measurements. No model
  execution is started by this contribution's automated checks.
- [ ] Linux/Windows native desktop build/runtime evidence for the contribution.
  Windows cross-target checks, Rust/TypeScript graph parity and synthetic browser
  evidence are recorded in [verification](VERIFICATION.md).

#### MD-02 · Central model checks and contextual model helper

**Type:** ACCEPT · **Needs:** NATIVE, WIN, GPU

**Central model checks and contextual model helper. Status: implemented in 0.2.27, released in 0.2.28; native/model acceptance open (t_b3dca97c, t_63bded22).** Closed checklist: [VERIFICATION.md](VERIFICATION.md#closed-plan-items-moved-from-planmd-2026-11-14). One coordinator reuses native `downloads_models::describe`/`validate_selected_family`, bounded `model_families` inspection, `modelComponents` and specialized LLM/tagger/audio probes. Identity, structural compatibility and backend availability remain separate evidence; no new registry/parser, implicit hash/network, automatic download or intent/graph substitution. Existing unknown self-contained checkpoint and explicit override paths remain supported. Native admission and post-await checks remain authoritative.
Source seams: `src/lib/models.ts::LocalModel`, `modelComponents.ts::componentFiles`, `execution.ts::compileRecipe`, `Workbench.tsx` family/component/readiness gates, `TveBackendEnhance.tsx`, `downloads_models.rs::describe`/`validate_selected_family`, `jobs.rs` repeated local preflight, `recipe_prerequisites.rs`; specialized `llm.rs`, `analysis_taggers.rs`/`analysis.rs`, `audio_runtime.rs` retain their final source/pinned-integrity checks.
Open:
- [ ] Native artifact rendering without probe-only overrides, model-helper interaction and performance: the isolated X11 smoke could not capture a rendered window and logged GBM buffer failures; no service/default was changed. Final review build was not relaunched, so this remains unresolved.
- [ ] Real Linux WebKitGTK and Windows WebView2 model-helper interaction and operator-authorized real-model/GPU quality/performance acceptance (separate from fixture/header evidence; no foreign-service changes).

#### MD-03 · Multi-pass sampling for all image/video models

**Type:** FEATURE · **Needs:** PRIORITY, GPU

**Multi-pass sampling for all image/video models. Status: planned, not implemented.** Owner request: add an optional **Multi-pass** group in the Studio **Options** tab, default OFF, with a variable pass count. A first generation is followed automatically by a second and, when requested, further sampling passes over the previous pass's result, using fewer steps and lower denoise (follow-up denoise default **0.2**). Target coverage is every supported image/video model and pipeline, not only H3 or an upscale recipe; unsupported combinations must have a concrete reason, never a silently skipped pass or substitute model. Pass count means total passes including the first (2 = generation + one follow-up), confirmed by the owner. All follow-up passes share one editable step count and the follow-up denoise setting (default 0.2); no per-pass override UI. The model-compatible starting step count/rule remains to be established before implementation.
Source baseline: `src/features/studio/Workbench.tsx::buildImageIntent` already emits an optional image `refine` block; `buildVideoIntent` carries LTX's model-specific `ltx.passes`, optional `latentUpscale` and H3 `faceRefine`. Those are separate existing operations, not universal multi-pass support. Inspect/reuse their sampler/latent/conditioning seams in `src-tauri/src/jobs.rs` and `jobs_video.rs`; do not wrap Run in a loop, duplicate the execution service, or conflate this option with latent upscale, face refinement or LTX's native multi-stage schedule.
Acceptance:
- [ ] Options controls: enable, variable pass count, follow-up steps and denoise (default 0.2); missing legacy preferences mean OFF, explicit saved ON/OFF and edited values survive draft/preset/history restoration. No extra pass or intent/graph changes when OFF. Establish the model-compatible starting step count above; validate finite values and family-compatible schedules, including distilled/fixed-step models and very short low-denoise tails that would otherwise execute zero steps.
- [ ] Trace every supported image/video family and pipeline through authoritative native validation, sampler graph emission and prerequisites, recording exact supported/blocked combinations. Reuse compatible latent outputs where possible; preserve dimensions, masks/compositing, reference/keyframe conditioning, frame counts/cadence, source audio and A/V bridges. Keep model/LoRA/prompt identity and existing native multi-stage schedules intact; document order relative to image refine, latent upscale, De-rope, face refine and TVE. Universal target coverage is not accepted from a single H3/image fixture.
- [ ] Capture immutable pass settings in the submitted intent and Run Plan; use existing job ownership, progress/step estimates, central Logs and scoped Stop for the whole chain. Save the first complete generation as Original before follow-up sampling, expose final Processed, and preserve Original on follow-up failure/cancellation; no automatic rerun or source overwrite.
- [ ] Native/compiler and frontend tests: OFF/legacy unchanged graphs, 2 and multiple passes, invalid count/steps/denoise, fixed schedules, exact previous-pass links, capability failures, retained audio/conditioning/geometry, partial results and Stop. Real image/video runs across the supported family matrix must establish quality, timing and RAM/VRAM separately from fixtures. Six locales, Ctrl+K/global search, Options badge, `docs/STUDIO.md`, and native WebKitGTK/WebView2 controls remain required. Planning only: implementation is not authorized by this entry.

#### MD-04 · Steps and CFG editable in Beginner

**Type:** ACCEPT · **Needs:** NATIVE, WIN, GPU

**Steps and CFG editable in Beginner — landed in 0.2.22 (fixture-verified).** Shared `samplingFields` in both modes; entering Beginner keeps current values, Beginner edits carry back into Advanced, automatic family values never overwrite Advanced ones. Open: native WebKitGTK/WebView2 keyboard/narrow-layout acceptance and one real Beginner run with edited values.

#### MD-05 · Sampler coverage and MOSS-Image defaults

**Type:** SLICE + ACCEPT · **Needs:** CPU, GPU, OWNER

**Sampler coverage and MOSS-Image defaults. Status: partially implemented.** Owner request.
- **Turbo/speed variants — still open.** Support the 8-step DMD LoRA (CFG 1, 8 steps) and the 4-step `rapid-moss` adapter (no negative prompt, no SLG) as labelled MOSS variants with matching defaults. Blocked honestly: no MOSS turbo/rapid-moss LoRA file exists in the owned environment to header-verify key layout against, and the MOSS LoRA guard stays closed until that verification plus a labelled-variant defaults design exist — a silently no-op LoRA is the known trap to avoid.
- [ ] One real MOSS run per default set (base 50/3.0/euler/sgm_uniform with SLG 22, turbo 8-step) recorded in `docs/VERIFICATION.md`. GPU backlog: the SLG-22 base run becomes runnable when the GPU is free; the turbo run additionally needs the open variant implementation above.
- [ ] **Verify every family default against real suggested defaults.** `docs/MODEL_DEFAULTS.md` keeps a researched matrix (current `builtin.json` defaults vs official model-card / Comfy-Org-template recommendations, per row with source + confidence). 0.2.14 realigned fourteen families; residual: video/audio families outside the audited set in `MODEL_DEFAULTS.md` still need re-checking and any contradicted default fixed.

#### MD-06 · User-defined recipe profiles (M-02)

**Type:** FEATURE · **Needs:** PRIORITY

**User-defined recipe profiles (M-02, planned).** M-01 (the Edit meta… family override) shipped in 0.1.66. M-02 would add:
- a versioned, data-only local profile binding an unknown model to an existing recipe adapter, with exact VAE/encoder references;
- adapter-supported defaults/constraints and explicit supported modes;
- a stable profile ID, with revalidation when components are replaced;
- distinct states *Configured* / *Backend requirements checked* / *Successfully executed*;
- optional bounded import/export (no credentials or weights).

A genuinely new architecture still needs a reviewed adapter. A later *Import example workflow…* may only assist the mapping; it must never execute arbitrary graphs.

#### MD-07 · Split diffusion models for checkpoint-only families (YuE2 first)

**Type:** FEATURE · **Needs:** PRIORITY, GPU

**Split diffusion models for checkpoint-only families (planned).** The Studio checkpoint selector and the Models tab list YuE2 only as an all-in-one checkpoint in `checkpoints/`: the family has `"loader": "checkpoint"` and its header rule needs both `model.diffusion_model.llm2vae.weight` and `text_encoders.model.embed_tokens.weight` (`builtin.json`, `model_families.rs`). A diffusion-only YuE2 file in `diffusion_models`/`unet` is therefore never listed. ComfyUI core already supports the split form (inspected at `b1a247c9`): `UNETLoader` detects it from `vae2llm.weight`, `llm2vae.weight`, `latent_pos_embed.pe`, `model.layers.0.self_attn.qkv_proj.weight` and `time_embedder.mlp.0.weight` (`model_detection.py`), `CLIPLoader` has type `yue2`, and `VAELoader` recognizes the YuE2 audio VAE (`sd.py`). (A file in a misnamed `checkpoint/` folder is not scanned by ComfyUI or DEAS; that is a placement problem, not this gap.)
- Correct pipeline use comes first: list a loading form only where it really runs through Text to Music **and** Cover Music. Verify each supported form end-to-end — detection, Run Plan, compiled graph, SheetSage2 cover path, decoded FLAC result — before advertising it; a listed but non-working form is a defect, not partial support.
- Detect diffusion-only YuE2 files by those header keys and list them in the selector and Models tab for Text to Music and Cover Music, alongside the existing checkpoint form.
- Compile a split music recipe (`UNETLoader` + `CLIPLoader type=yue2` + `VAELoader`) with header-backed companion matching for the text encoder and VAE slots, missing-companion Run gates and unchanged graphs for the all-in-one checkpoint.
- Apply the same audit to other families that are checkpoint-only today but whose core loaders accept split files; GGUF split variants follow the existing GGUF rules.
- Native/TS compiler regressions, offline graph validation, seven locales, then a real run per loading form in both music pipelines: the all-in-one checkpoint (including a quantized one such as `convrot_int8`, whose loading/quality is unverified) and the split files; MUSIC.md and the family table updated.

#### MD-08 · GGUF real inference and Windows runtime

**Type:** ACCEPT · **Needs:** GPU, WIN

**GGUF.** Real bounded image/video/audio-in-video GGUF inference and the Windows runtime. ComfyUI-GGUF has no full-checkpoint or GGUF VAE loader, so a manual family assignment can still fail on unsupported labels.

#### MD-09 · All ComfyUI core architectures (F0–F4, incl. ACE-Step F3a–F3c)

**Type:** FEATURE + ACCEPT · **Needs:** PRIORITY, GPU, NATIVE, WIN

**All ComfyUI core architectures (planned, owner request).** DEAS registers 41 family IDs (including ACE-Step variants) and detects the families in `builtin.json`. ComfyUI core at `b5a43215` (2026-10-29) ships ~55 distinct architectures (108 `ModelSupport` classes counting variants) and `blueprints/*.json` is the authoritative per-architecture graph. SwarmUI adds no architecture of its own: it is a ComfyUI frontend, and `T2IModelClassSorter.cs` narrows detection to 25 compat classes, so it is only a header-signature source. Scope: every architecture ComfyUI can load from the folders DEAS already scans (`settings.rs::MODEL_FOLDERS`, 16 folders incl. `text_encoders`, `clip`, `clip_vision`, `style_models`). Owner example: Z-Image.

**Gap by cause, not by model.** The image recipe is one fixed graph (`execution.ts::compileRecipe`: `UNETLoader`/`CLIPLoader`/`VAELoader`/`CLIPTextEncode`/`EmptyLatentImage`/`KSampler`) with two hardcoded family branches (MOSS `EmptyFlux2LatentImage`, GGUF) and one text encoder. Nearly every missing architecture differs from it in only four declarative points — text-encoder loader form (single vs `DualCLIPLoader`), latent node, model-sampling patch, negative handling — plus defaults. Make those family data: then most new image architectures are a `builtin.json` entry + header rule, not a compiler branch.

**F0 — declarative adapter (one slice, no new model).**
- `src/families/builtin.json` gains `clip: {loader: "single"|"dual", encoders: [patterns]}` (dual needs two slots), `latent: {node, …}`, `patch: {node, shift}`, `negative: "text"|"zero"`; `defaults` and `multiple` already exist. **Landed in 0.2.12: `clip` dual loader (`diffusion.textEncoder2` + `dualTextEncoders`/`dualClipTypes` prerequisites + second encoder picker), Flux.1.** **Landed in 0.2.13: `modelShapes` (Z-Image 3840 vs Lumina2 2304) and the top-level `family` id for checkpoint families (Lumina2 latent + AuraFlow 4).** Mirror the fields in the Rust `Family` struct (`model_families.rs`) and the TS `Family` type (`Workbench.tsx`); use only existing ComfyUI core nodes, no new loader kinds.
- Family detection gains `modelShapes: [{key, shape}]`, because several architectures share the same key set: Z-Image vs Lumina2 vs Ming-Image (`cap_embedder` + `noise_refiner` + `dim` 3840 vs 2304), Flux 2 vs Flux 3, Chroma vs Chroma-Radiance, HiDream vs HiDream-O1, LTX 2.3 vs 2.5, Wan 2.1 vs 2.2. `detect_component` already has the shape helper — reuse it. A key-only rule that misclassifies is a defect: wrong family means wrong latent, grid and defaults.
- Dual encoders: the intent gains a second encoder slot; `jobs.rs` preflight and `recipe_prerequisites.rs` gain non-GGUF `dualTextEncoders`/`dualClipTypes` (the GGUF pairs already exist); `execution.ts` uses the existing unused `clipLoaderName(name, dual)` parameter; Workbench picker, capability allowlist, seven locales.
- Acceptance: one unit test per new field asserting the exact graph JSON, one real Z-Image run, `cargo test --lib model_families`, `src/lib/modelComponents.test.tsx`.

**F0b — pipeline classes instead of per-family compilers.** Graph knowledge lives twice today: `execution.ts::compileRecipe` (image) and `jobs.rs` preflight + `recipe_prerequisites.rs` re-derive the same model/encoder/VAE/node facts; video is one Rust compiler with 25 `family ==` sites plus the TS discriminated union (`videoIntent.ts`); music is a YuE2-only graph. Adding one family therefore means editing a compiler in two languages, the union, and the UI — that is what must stop.
- Pipeline **classes** become data, one entry per class with one graph template: `t2i`, `i2i`, `inpaint`, `edit` (reference conditioning), `refine`, `t2v`, `i2v`, `v2v`, `flf2v`, `t2m`, `cover`, `t2a`, `mask`, `depth`, `pose`, `3d`.
- A family declares the classes it supports plus slot values (encoder(s), clip type, VAE, latent, patch, negative, frame grid/fps/audio rate, sampler defaults, option groups). The compiler becomes one template interpreter addressing nodes by role (`model`, `clip`, `vae`, `positive`, `negative`, `latent`, `sampler`, `decode`, `save`, …) instead of fixed IDs.
- Structural differences are **templates**, never branches: Mage-Flow `TextEncodeMageFlowEdit`, Cascade B+C two-stage, H3 audio/video latent + continuity, LTX two-pass audio/video samplers, Wan high/low-noise pair. A family selects class + template + slots; no `if family == …` in the compiler.
- **Base graph per class, complex parts as declared fragments (injections).** A class owns one base graph whose nodes are addressed by role slots (`model`, `clip`, `vae`, `positive`, `negative`, `latent`, `sampler`, `decode`, `save`). Every complex case is a named fragment declaring `insert` (new nodes with namespaced ids), `rewire` (claim an exclusive role, e.g. `sampler ← SamplerCustomAdvanced`, `decode ← VAEDecodeTiled`), `chain` (append to an additive role, e.g. LoRA → attention/sage/cache/compile/chunk patches), `requires` (nodes/models, so prerequisites derive instead of being restated) and `when` (family/intent/option predicate). A family lists class + fragment ids + slots; ControlNet, refiner, second pass, continuity and reference conditioning are fragments reused across families, not per-family code.
- **Composition rules:** fixed order model-chain → conditioning → latent → sampler → decode → save → post; two fragments claiming an exclusive role is an error (no last-wins); additive chains compose in declared order; fragments never renumber nodes or hardcode ids; every rewire must resolve or the compile fails naming the slot; a fragment whose nodes are missing from `object_info` fails the Run gate by name.
- The codebase already composes this way in miniature — the image `patches` array, the `sigmas` swap of node `5`, the `imageReference` CV/RI/CE/UC chain, the tiled-decode swap, and video `model_chain`/`decode`/`input_image`. F0b extracts those into the fragment registry rather than inventing a second mechanism.
- Tests: fragment test (base + one fragment → exact graph), composition snapshot per family × class, TS↔Rust golden parity; adding a capability fragment must not touch any family compiler.
- One writer: family data feeds the TS graph, the Rust preflight and the `recipe_prerequisites` node list; a parity test compiles the same family in both languages and asserts identical graph and prerequisites. A new family is a data entry + header rule + fixture — touching `compileRecipe`/`jobs_video.rs` means the slice failed.
- Migration order: t2i (covers F1) → i2i/inpaint/edit (the existing MOSS/Krea/Qwen reference methods become templates) → video (LTX/Wan/H3 as the first three templates; their `family ==` sites disappear) → music. Existing families must emit byte-identical graphs: golden-graph tests prove the migration, not a new model run.
- Capabilities stay negotiated: templates name only nodes/loaders the backend lists, and a missing node fails with the named Run gate instead of a silent fallback. Unknown architectures keep running the generic t2i template on grid 16.
- Ties to M-02 above: a recipe profile binds an unknown model to class + template + slots; it adds no compiler code.

**F1 — image families (t2i/i2i), data-only once F0/F0b land.** Values come from the blueprint, never guessed; a family with no blueprint (`Flux 3`) is verified from `supported_models.py`/`latent_formats.py` and labelled unverified until a real run.

| family | loader/clip | vae | latent | patch | defaults |
| --- | --- | --- | --- | --- | --- |
| Z-Image Turbo / Base | `lumina2` + `qwen_3_4b` | `ae` | `EmptySD3LatentImage` | `ModelSamplingAuraFlow` 3 | turbo 8/1 `res_multistep` `simple` (landed); base 25/4 with encoded negative (open) |
| Flux.1 dev/schnell/krea/fill | `DualCLIPLoader` clip_l + t5xxl `flux` | `ae` | `EmptySD3LatentImage` | — | 20/1 `euler` `simple`; dev/schnell/krea landed, Fill = inpaint path (open) |
| Flux.2 dev / Klein | mistral-3-small / `qwen_3_4b` `flux2` | `flux2-vae` | `EmptyFlux2LatentImage` | `Flux2Scheduler` (sigmaNode) | landed: 20/5 euler; edit refs open |
| Flux.3 | `qwen3vl_4b` `flux3` | flux2 | `EmptyFlux2LatentImage` | `Flux2Scheduler` (sigmaNode) | landed, unverified (no blueprint) |
| SD3 / 3.5 large+medium | dual t5xxl + clip_l/clip_g `sd3` | `ae` | `EmptySD3LatentImage` | `ModelSamplingSD3` 3 | landed: 28/4.5 `dpmpp_2m` `karras` as starting values |
| Lumina2 / NewBie / NetaYume | all-in-one checkpoint, encoder embedded | — | `EmptySD3LatentImage` | `ModelSamplingAuraFlow` 4 | landed (modelShapes 2304 vs Z-Image 3840) |
| Chroma / Chroma-Radiance | chroma | pixel-space | `EmptyChromaRadianceLatentImage` | — | landed: Chroma = Flux latent, Radiance = pixel latent, family id disambiguates |
| HiDream / HiDream-O1 | hidream dual llama3 + t5 | `ae` | `EmptySD3LatentImage` / `EmptyHiDreamO1LatentImage` | — | landed: I1 Full/Dev/Fast (no patch); O1 open |
| Mage-Flow (+edit) | `mage` + `qwen3vl_4b` | `mage_flow_vae` | `TextEncodeMageFlowEdit` carries w/h (not data-only) | — | landed: t2i via `encodeNode` 30/5 euler; edit refs open |
| Qwen-Image 2512 / Layered / edit refs | `qwen_image` + qwen2.5-vl | `qwen_image_vae` / layered vae | `EmptySD3LatentImage` / `EmptyQwenImageLayeredLatentImage` | `ModelSamplingAuraFlow` | per blueprint |
| Ideogram v4 (landed), Boogu (+edit) (landed), OmniGen2 (landed), Fibo 2.0 (landed), Ernie (+turbo) (landed), LongCat (+edit), Joy Image edit, SenseNova U1.5, Ming-Image, Lens, AuraFlow | per blueprint | per blueprint | per blueprint | per blueprint | per blueprint |
| PixelDiT/PiD T2I | `pixeldit` + gemma-2 | pixel-space | `EmptyChromaRadianceLatentImage` | — | landed, unverified (VAE name) |
| Kandinsky5-Image Lite/Pro | `kandinsky5_image` + qwen2.5-vl-7b | `ae` | `EmptySD3LatentImage` | — | landed (shift internal) |
| PixArt Alpha/Sigma, HunyuanDiT 1.0/1.5 | `pixart` single t5 / `hunyuan_dit` dual clip_l+mt5xl | SD15/SDXL | `EmptyLatentImage` | — | landed (grid 8, no patch) |
| SD1.5 / SD2 (landed) / SDXL Refiner / SSD-1B / KOALA / instruct-pix2pix / SVD / SV3D / Zero123 / LotusD | checkpoint families | built-in | `EmptyLatentImage` | — | SD1.5/SD2 landed (grid 8); rest per blueprint |
| Stable Cascade B + C | two-stage checkpoint pair | built-in | cascade latents | — | not data-only |

Order: Z-Image → Flux.1/2 → SD3.5 → Lumina2 → Chroma/HiDream → Mage/Boogu/Ideogram/Ernie/LongCat → the remainder. Z-Image first because it is the owner's example and the newest split form; Flux/SD3.5 because they are the most-installed.

**F2 — video families.** Extend the existing `wan` family first (`jobs_video.rs`, `videoIntent.ts` discriminated union): t2v high/low-noise pair, VACE FLF2V + inpaint, Animate 2 motion transfer, SCAIL-2 character replacement, Wan Dancer, S2V, HuMo, Camera, Fun-Control, Bernini-R. Then new families: HunyuanVideo (+I2V/SkyReels, 1.5, Image 2.1 + refiner, SR distilled), LTX 2.5 (Gemma4 encoder, int8), CogVideoX (+VOID inpaint), Mochi, Cosmos, Kandinsky5 video. Each new family is data (class + template + slots + frame grid/fps in the family entry); a template is added only where the graph shape is genuinely new. SeedVR2 video upscale is a post-processing node, not a generation family.

**F3 — audio.** Stable Audio 3 (medium/base), MiniMax Music 3. The YuE2 split-form item above is folded in, not duplicated. ACE-Step is the owner's explicitly prioritized next music integration, split below rather than enabled by a picker-only change.

**F3a — ACE-Step identity: native acceptance remaining.** Header/shape architecture classification, conservative filename-based variants, unresolved/conflicting evidence, seven-locale Edit meta evidence and source-bound family declaration/reset are implemented and covered by native/unit/Chromium fixtures; evidence belongs in `VERIFICATION.md`. Remaining acceptance before executable integration is called supported:

- [ ] Exercise model listing, declaration/reset and filename/header evidence in the real Linux WebKitGTK and Windows WebView2 app with an operator-selected local model. The inspected upstream headers do not encode Base/SFT/Turbo; a filename result must remain visibly weaker than header identity. No implicit model downloads or generation.

**F3b — ACE-Step Text to Music: real-model/native acceptance remaining.** The implementation and source-linked defaults now live in the existing Text to Music path; implementation details and source/gate evidence belong in `MUSIC.md`, `MODEL_DEFAULTS.md` and `VERIFICATION.md`. No new required variant selector or separate execution transport. Outstanding acceptance, not missing UI/compiler wiring:

- [ ] With explicitly authorized operator-selected local weights, run original 1.0 and representative 1.5 AIO/split Base/SFT/Turbo/XL combinations. Record model identity/provenance, exact submitted controls, initialization/peak RAM/VRAM/time, generated FLAC sample rate/sample count/duration and output quality. Schema validation with scratch filename fixtures does not prove model loading or inference.
- [ ] Exercise the real Linux WebKitGTK and Windows WebView2 model/component pickers, native FLAC playback/export, history/settings restoration and enabled automatic audio post-processing; verify retained baseline/processed products without restarting foreign services. Windows crosschecks are not runtime acceptance.
- [ ] Additional shift/continuous distillations remain excluded until their exact official recipe and defaults are verified. Keep unresolved/conflicting identity blocked, never silently select Turbo; preserve user overrides and authored Style/Lyrics during any future profile migration.

**F3c — ACE-Step audio-to-audio/Cover/Repaint. Status: deferred, not implemented.** Not part of the initial Text to Music implementation. Original audio editing and newer 1.5 reference-timbre paths need separate graph/intent acceptance; Comfy 1.5 documentation and newer core expose different maturity levels. Do not advertise full Cover/Repaint or manufacturer-only tasks from node presence alone.

**F4 — perception/3D (lowest priority).** SAM 3.1 masking (§4.4), RT-DETR v4 pose, Depth Anything 3, MoGe, Marigold, Lotus depth, Hunyuan3D 2/2.1, Trellis2, TripoSplat, BiRefNet. These need their own pipelines, not t2i, and only after F0–F2.

**Model folders.** `MODEL_FOLDERS` already covers every folder these families load from, so no scan change is needed. Close while F1 lands: `style_models`/`model_patches`/`diffusers` are scanned but no recipe uses them (Flux Redux stays in §4.4), and the loader gate must keep checkpoint families out of `diffusion_models` and vice versa (`model_families.rs::validate_override` already enforces this). Library download catalog gets entries per family only where an official Comfy-Org/HF repo exists — not one bulk import.

**Acceptance, uniform per family.** (1) header fixture from the real file names the family, not a neighbour (`model_families` test with the exact key set/shape); (2) compiler test asserting the exact graph: loader form, latent node, patch, negative handling, defaults; (3) golden-graph parity test (TS ↔ Rust) and offline validation against the blueprint; (4) one real GPU run in VERIFICATION.md with VRAM/time; (5) family and Forge label in seven locales plus the `docs/STUDIO.md` family table; (6) version bump + CHANGELOG bullet. A family counts as supported only after (4); before that it is *detected*, not supported.

**Explicit exclusions.** No ControlNet/LoRA variants per architecture (Z-Image ControlNet, Anima LLLite), no SwarmUI-only classes, no wizard, no 3D/audio UI surface until asked. Unknown checkpoints keep the strict grid-16 t2i/i2i path.

### 4.6 Studio UX

#### UX-01 · Beginner optimized pipelines

**Type:** ACCEPT · **Needs:** NATIVE, WIN, GPU

**Beginner optimized pipelines — native/model acceptance remaining.** Image / Video / Music, music model filtering, shared settings/prompts and explicit Media source actions are implemented and fixture/browser-verified (0.2.25; see VERIFICATION). Still exercise native Linux WebKitGTK/Windows WebView2 picker/model/media/search paths, experience-switch draft retention and real-model image/video/YuE2/ACE runs. Existing dependency and unsupported-cover gates remain; no download or execution is authorized by navigation.

#### UX-02 · Role-based pipelines (one Image / Video / Music pipeline)

**Type:** SLICE + ACCEPT · **Needs:** CPU, NATIVE, WIN, GPU

**Role-based pipelines: one Image, one Video, one Music pipeline; each medium's role decides the mode. Status: Image slice implemented (0.2.25; see [Studio](STUDIO.md)); Video UI slice implemented with native/real-model acceptance open; Music UI slice implemented with native/real-model acceptance open.** Image slice as built (owner decisions 2026-11-13): one **Image** dropdown entry; internal `t2i`/`i2i` ids stay (intents, `projects.rs`, history, Run Plan, Monitoring unchanged, no preference migration); the picture to edit is set only explicitly (*Use as picture to edit* in the preview toolbar/right-click and on reference cards, Resample/Inpaint buttons, drop on H3 card 1); clicking a tile only previews; t2i/i2i share one draft per model (`draftPipe` in `Workbench.tsx`); edit-only models (H3) stay in `i2i`. Not done in this slice: Source/Reference chips for non-H3 families beyond the per-card *Use as picture to edit* button, H3 text-to-image from references alone (needs a start latent from `HR[1]` cut to t=1 plus a graph proof), and native WebKitGTK/WebView2 click-through. `tools/verify_component_pickers.py`/`verify_workbench_run_stop.py` were aligned to the single entry; `verify_workbench_run_stop.py` is green again (18/18 browser cases, 0.2.25: Advanced preselected, newer read-only probes answered, Stop menu's Stop all). Owner idea (2026-11-12): *Reference to …*, *Image to …* and *Video to …* are largely the same pipeline with different inputs. The References overlay should set what each medium is (first frame, last frame, both, reference, source). Order of the four slices: (0) the image mode of the References overlay (landed in 0.2.25; Source/Reference role chips come with slice 1); (1) Image; (2) Video; (3) Music, optional.
- **Source facts (HEAD `4e8b08d`):**
  - Intents carry **no pipeline ID**. `history.ts` derives it when restoring (`inputImage` → i2i, `sourceVideo`/`firstFrame` → v2v/i2v, `h3.mode==='REF2VA'` → ref2v, music `mode`), so the job/intent contract stays unchanged. The video H3 mode is already derived from the frame roles (`h3ForgeContext`: T2VA/I2VA/L2VA/FL2VA); L2VA already runs inside t2v.
  - t2i and i2i are already one recipe (`checkpoint-text-to-image-diagnostic`; `inputImage` + `denoise` switch the start latent, `jobs.rs` around line 353). Image references are already pipeline-independent (`referenceMethod` for `t2i||i2i`).
  - Places that branch on pipeline IDs:
    - `Workbench.tsx`: `pipelines`/`videoPipelines`/`outputKind`, the pref `studio.run.pipeline` (default `t2i`), `switchDraft`/`pickPipeline` (drafts per pipeline+model, `keepPrompts` per output kind), `why()` greying out unavailable pipelines from `family.pipelines`, Beginner shared keys (around lines 1440 and 1457);
    - `history.ts` (`HistoryRestore.pipeline`), `Monitoring.tsx`, `beginner/modelCatalog.ts` (kind by pipeline);
    - `lib/projects.ts` + `src-tauri/src/projects.rs` (stored `pipeline: 't2i'|'i2i'`, validated natively);
    - `model_families.rs:168` (image capability via `t2i|i2i|inpaint|edit`), `builtin.json` `pipelines` arrays;
    - the `studio.run.pipe.*` locale keys, Run Plan, search, `tools/verify_*.py`;
    - about 90 test references (`Workbench.*.test.tsx` 49, `ReferencesPanel.test.tsx` 19, `history.test.tsx` 11, …).
- **Real mode boundaries (must not be removed):**
  - H3 **reference ≠ frame**. References (`minimax_refs`) give identity/content with no time position; frames (`minimax_keyframes`) pin pixels at an exact frame. The Director uses a different checkpoint socket (`ref2va_model` vs `fl2va_model`, `jobs_video.rs` around line 1715), and Continuity cannot cross between the families.
  - Do **not** mix frames and references in one H3 run until a GPU run proves the quality. Core `MiniMaxH3AddGuide` on REF conditioning is technically possible but untested, and the Director does not do it. Show the rule as an explained disabled role, not a silent drop.
  - Per-family role capabilities stay data in `builtin.json`: Wan first frame only; LTX frames + source video + guides; H3 all roles; HyperFlow GGUF images only for REF2VA. No `if family ==` branches.
- **Image slice:**
  - Merge t2i and i2i into one **Image** pipeline. Each image in the overlay is either **Source** (max 1: start latent, editor, mask, inpaint crop, denoise, input resize) or **Reference** (per-family limit). No source = text to image; a source = edit/inpaint. Editor/mask/denoise appear only with a source.
  - Side effect for H3: `minimax-h3` today only lists `i2i`. With references and no source it becomes H3 text-to-image, which is pass 1 of the reference workflow. That needs one more `h3_edit` branch whose start latent is the video part of `HR[1]` cut to t=1, plus its own graph proof.
- **Video slice — remaining acceptance.** UI consolidation, explicit roles, mode badge, shared per-model video drafts, legacy IDs/history and capability/mixing guards are implemented (0.2.25); see STUDIO and VERIFICATION. Still exercise native Linux WebKitGTK/Windows WebView2 role selection, drop/replace/remove/search, per-model return and actual generation per supported derived mode. Existing partial history restoration remains fail-closed for unsupported historical fields. No service restart or model download is authorized.
- **Video slice:** merge t2v/i2v/v2v/ref2v into one **Video** pipeline. Roles per medium: *First frame*, *Last frame*, *Reference* (image/video/audio, with the existing lanes/trims/V-A-V+A), *Source video* (LTX). Show the derived mode as a badge (e.g. "H3 · FL2VA", "H3 · REF2VA", "LTX · v2v"). A checkpoint that does not fit the roles gets the existing hint (REF2VA recommended), not a block. The first/last-frame Media menu and the frame badges (`frameMarks`, `lastOnlySrc`) become role setters for the same state. The open W7 item (stage slots) is folded in here.
- **Music slice — remaining acceptance.** The single Music entry and explicit source role, shared per-model drafts, legacy/history guards, ACE text-only boundary, seven locales and source-removal search are implemented (0.2.25). See MUSIC and VERIFICATION for source and fixture evidence. Still exercise source use/removal, per-model returns, relocation, source preview/playback and search on native Linux WebKitGTK/Windows WebView2, plus actual YuE2 text/cover and ACE model execution. Beginner shares these music authoring controls; native/model acceptance, model downloads and live-service restarts remain separate.
- [ ] **Compatibility without persisted-ID migration (Image/Video/Music UI slices):**
  - Keep saved `studio.run.pipeline` values (`t2i`/`i2i`, `t2v`/`i2v`/`v2v`/`ref2v`, `t2m`/`cover`) readable and writable as internal modes; Image/Video/Music are presentation choices, not new persisted IDs. Share drafts per output kind + model without losing role media. Do not introduce a format migration merely to collapse the dropdown.
  - Projects: preserve the current `t2i|i2i` read/write contract in `projects.rs`/`projects.ts`; this UI-only slice does not change the project schema.
  - History restore retains its captured mode and unresolved-input warnings while the UI displays the corresponding Image/Video entry and roles. Existing history records stay readable; empty unresolved roles must not silently downgrade a restored edit/reference intent to text generation.
  - Presets and Beginner modes keep working.
  - Compatibility tests: absent preference, every legacy mode, model/draft return, and unresolved history inputs. Native cross-platform restoration remains a separate acceptance gate.
- [ ] **References overlay as the single role editor** (image and video mode; keep the right-click as a shortcut).
  - Role chips per medium, with the role-limit or mixing rule as the disabled reason.
  - Numbered `<Picture N>`/`<Video N>`/`<Audio N>` tags with the existing tag insert. Tags stay English in all locales.
  - Keyboard/focus/Escape like today.
  - Six locales, global search (`search.ts`) per role control, `npm run test:core`.
- [ ] **Unchanged-intent proof:** for every old pipeline × family combination the new UI builds a byte-identical intent for the same media/roles (one Vitest table; the Rust suite needs no change because intents stay the same). The Run Plan shows roles and the derived mode.
- [ ] Update every consumer of the pipeline IDs above (including `modelCatalog.ts`, `Monitoring.tsx`, `model_families.rs` image capability, `tools/verify_*.py`), then `docs/STUDIO.md`, CHANGELOG and version bump per slice.
- [ ] Native acceptance: Linux WebKitGTK/Windows WebView2 click-through for the role chips and overlay, plus one real run per derived mode (H3 T2VA/I2VA/FL2VA/REF2VA, LTX v2v, Wan i2v; Image text-to-image/edit/references).

#### UX-03 · Comfy file drops

**Type:** ACCEPT · **Needs:** NATIVE, WIN, OWNER

**Comfy file drops — remaining native acceptance (0.2.24).** Native paths are forwarded only to the visible editor as original `File`s at the refreshed drop position, through ComfyUI’s own dragover/drop handlers; tab/backend navigation and iframe reload abort pending intake. Real WebKitGTK verified workflow JSON, metadata PNG, image-on-node and image-on-canvas; an isolated Tauri process verified native events, bounded asset HEAD/ranges and a multi-range workflow import. A real cross-process GTK drag in an isolated nested KWin session now passes after the native-video-layer fix. Still exercise the owner's file-manager drag on the normal Wayland desktop and Windows WebView2, including scaled displays and return navigation. Existing unit/browser evidence and limits: [verification](VERIFICATION.md#comfy-native-file-drop-forwarding-0224). No generation, services or model changes are authorized by dropping a file.

#### UX-04 · Post-Processing category cards with settings overlays

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Post-Processing category cards with settings overlays. Status: implemented with floating non-modal settings and blocked pipeline-incompatible cards; frontend fixture/browser evidence is recorded in [VERIFICATION.md](VERIFICATION.md#floating-post-processing-settings-0224). Native WebKitGTK/WebView2 acceptance remains open.** Owner request: replace the long Studio Post-Processing dock's inline category controls with compact selectable cards, visually similar to choosing a preset card. Clicking a major category (for example **Audio enhancement**) opens that category's settings in an overlay/submenu. Confirmed scope: **Studio Post-Processing only; the TVE tab remains unchanged.** Each card shows a clear enabled/inactive indicator **and the number of enabled functions in that category**. A click opens settings only; it must not enable an effect, apply a preset, run a job, install a runtime or download a model.
Source baseline: `src/features/studio/Workbench.tsx` renders the Post dock's `AudioEnhance`, latent upscale, `Sam3VideoControls`, image refine/upscale, `DeropeControls` and `TvePostControls` inside category cards and an accessible category overlay (`[data-post-card]`, `[data-post-overlay]`, `[data-post-category]`), backed by `src/features/studio/dockBadges.ts::postCategoryFunctions` and `src/lib/search.ts::revealTarget`.
Acceptance:
- [ ] Open the category's existing controls in an accessible overlay with keyboard activation, appropriate dialog/submenu semantics, Escape/close, focus handling/return and reachable scrolling on narrow windows. Opening/closing is mutation-free; intentional edits use existing settings and persist when closing/reopening. Do not clear drafts, stop running jobs, unmount job ownership or hide essential install/progress/cancel/error feedback. Audio's optional engine install actions remain visible inside its open category, following existing consent/installed-state rules. (Implemented and covered in `Workbench.*.test.tsx`, which run in every release's full UI gate since 0.2.24; narrow/wide visual verification and native WebKitGTK/WebView2 runtime verification remain open.)
- [ ] Ctrl+K/global search must open the Post dock **and the owning category overlay** before revealing/focusing a nested control; preserve existing SAM **Add target mask** and other reveal shortcuts. Card/overlay labels, status/count text and accessible names are localized in all seven languages. Update `docs/STUDIO.md`; TVE retains its current controls/layout. (Implemented, localized in all seven locale files and covered in `GlobalSearch.test.tsx` / `Workbench.*.test.tsx` within the release UI gates; seven-language narrow/wide visual verification remains open.)
- [ ] Six-language narrow/wide visual checks and native Linux WebKitGTK / Windows WebView2 runtime acceptance (keyboard/focus/Escape, nested search reveal, audio install progress/cancellation, running-job continuity). Component, layout and full UI/core suites run in the release gates.

#### UX-05 · Inpaint SAM/result controls

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Inpaint SAM/result controls — native acceptance remaining (0.2.23).** UI cleanup, checkpoint auto-selection including explicit model Reload, queue-star placement, preview More actions and mask-only source preservation are implemented and fixture-verified; [evidence](VERIFICATION.md#inpaint-sam-and-result-controls-0223). Open: native Linux WebKitGTK / Windows WebView2 click-through for point/box masks with existing queue results, saved/new SAM checkpoint selection, preview More actions and narrow-layout placement. Check that Add target mask opens Post-Processing, highlights/focuses empty SAM targets without execution, and segments the current editor source when keywords are present. Preserve source images, separate mask layers and default-OFF automatic refinement; no model download or generation on navigation/selection.

#### UX-06 · Chat with local GGUF models

**Type:** ACCEPT · **Needs:** GPU, NATIVE

**Chat with local GGUF models — landed in 0.2.22 (fixture-verified).** Chat lists local GGUFs (`useForgeModels(…, localGguf=true)`), `forge/assistant.rs` accepts `local:` models, `native_chat_send` scopes the turn in `chat::with_local_runner` (worker dropped when the turn ends, before the frontend renders a picture), and `chat::stream_round` routes local models to the existing tool-parsing `local_round` (no token streaming, Stop drops the round). Open: one real local-GGUF chat turn with a tool call and one with `render_picture` (measured VRAM release), and native picker acceptance.

#### UX-07 · Slider compare for videos

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Slider compare for videos. Status: implemented in 0.2.40** — `CompareView.tsx` `video` mode renders the Original/Processed pair as two muted HTML `<video>` elements under one divider/zoom; the original drives playback and the processed copy re-seeks when it drifts more than 60 ms; one play/pause button. Audio-only outputs keep the disabled Slider with its reason.
- [ ] Linux: the compare pair uses WebKit `<video>`, not the libmpv `NativeVideo` path the rest of Workbench video uses (WebKit `<video>` previously froze on NVDEC caps). Verify real TVE/latent-upscale pairs in the shipped WebKitGTK app; if playback freezes, switch to a native two-surface/clip layout or a still-frame compare.
- [ ] Mismatched geometry/fps/duration (TVE upscale, frame generation) is unverified on real pairs; frame-accurate start, loop and audio choice are not implemented. Windows WebView2 playback acceptance separately.

#### UX-08 · Dock tabs changed/active count

**Type:** ACCEPT + SLICE · **Needs:** NATIVE, CPU

**Dock tabs: changed/active count — landed in 0.2.22 (fixture-verified).** `dockBadges.ts` counts Options fields differing from `defaultOptions`, the Wildcards switch plus authored rules, and the Post-Processing stages that run for the pipeline; badge with a seven-locale count label. Not done: per-item names in the tooltip, a per-panel summary line/reset. Open: native visual check.

#### UX-09 · SAM Auto Refine progress in the queue

**Type:** ACCEPT · **Needs:** GPU

**SAM Auto Refine progress in the queue — fixed in 0.2.22 (fixture-verified, RED/GREEN).** Cause was frontend-only: each pass is already a native held Workbench job (`workbench_auto_refine_run`), but the queue poller stopped once no job was current; `samBusy` now keeps it polling, so SAM and refine passes appear with live state. Open: real serial face→hands run on the owned backend to confirm the rows update; optional per-target stage labels.

#### UX-10 · Video thumbnails

**Type:** ACCEPT + SLICE · **Needs:** NATIVE, WIN, CPU

**Video thumbnails — landed in 0.2.22 (fixture-verified).** Media tiles and finished queue rows use the existing cached FFmpeg still (`native_media_reference_thumbnail`, 2 concurrent, Tiles virtualized so only visible tiles ask). Open: References/Forge pickers and Beginner Media reuse the same MediaLibrary tiles (covered); recent-history rows and a black-first-frame offset are not done; native Linux/Windows check on a large video folder, extraction failures currently log the generic reference-media line.

#### UX-11 · Full-window viewer previous/next

**Type:** ACCEPT + SLICE · **Needs:** NATIVE, WIN, CPU

**Full-window viewer previous/next — landed in 0.2.22 for pictures (fixture-verified).** `ImageViewer` takes `onPrev/onNext/position`; Workbench feeds the finished local picture results in queue order (paired products included). Open: video-view navigation, native Linux WebKitGTK/Windows WebView2 keyboard acceptance.

#### UX-12 · Pipeline-filtered model picker

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Pipeline-filtered model picker — native acceptance.** The compact selector now reuses the existing compatibility gate to list only candidates for the active pipeline; an unavailable remembered selection stays visibly disabled with its translated reason, without replacement. Component tests cover mixed/empty inventories, image/video changes, drafts, prompt preservation and selection events. Open: native Linux WebKitGTK and Windows WebView2 popup/keyboard behavior; filtering does not replace native Run validation.

#### UX-13 · Media panel clipboard drop/paste intake

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Media panel: clipboard drop/paste intake field — landed in 0.2.22 (fixture-verified).** `native_media_paste` (sniffed PNG/JPEG/WebP ≤64 MiB, local-time stamp validated, no-clobber publish via `Anchor`) and `native_media_copy_in` (picture/video ≤512 MiB, clean source stem) write into the owned Input root; MediaLibrary field + panel-scoped Ctrl+V, References tab Ctrl+V. Open: native Linux WebKitGTK and Windows WebView2 paste (`clipboardData.files` and `navigator.clipboard.read()` support differ per webview), OS drop onto the field, large-video copy time.

#### UX-14 · Ctrl+F find in the current view

**Type:** FEATURE · **Needs:** PRIORITY

**Ctrl+F: find in the current view. Status: planned, not implemented.** Owner request. Open a browser-like find bar over the current view with Ctrl+F; entering a search term highlights matching text in that view. Keep this separate from Ctrl+K global control/navigation search.
- [ ] Reuse existing search/highlight mechanisms where suitable after inspecting current view containers and keyboard handlers. Search only the active visible view, excluding retained hidden tabs and closed overlays; do not search the whole application or change prompt contents. Highlight matches, show current/total count and offer previous/next navigation (Enter/Shift+Enter); Escape closes the bar, clears highlights and restores focus. Reopening retains the current query for the session. Empty queries and no matches have clear states.
- [ ] Preserve editable-field text/selection, IME input, existing shortcuts and mounted-view/job lifecycles; highlighting must not rewrite controlled textarea values or disrupt native media. Check the embedded Comfy view separately: cross-origin iframe content needs its own supported find path, not a claim that parent-DOM search covers it. Report any unsupported surface explicitly.
- [ ] Add focused UI tests for Ctrl+F opening, matching/highlighting, next/previous wrapping, empty/no matches, Escape/focus return, active-view changes and hidden-view exclusion. Verify editable prompt fields and embedded Comfy behavior on Linux WebKitGTK and Windows WebView2. Add accessible labels, seven-language text, a global-search entry and `docs/STUDIO.md` shortcut documentation; run the shared layout gate if the bar changes layout.

#### UX-15 · Ctrl+Enter runs

**Type:** ACCEPT · **Needs:** NATIVE

**Ctrl+Enter runs: native acceptance.** Landed with component tests. Open: Linux WebKitGTK keyboard check; held keys and IME composition on a real keyboard.

#### UX-16 · Prompt Undo/Redo on WebKitGTK

**Type:** ACCEPT · **Needs:** NATIVE

**Prompt Undo/Redo: WebKitGTK check.** Tag and spelling picks now go through `execCommand('insertText')`. Open: Ctrl+Z and Ctrl+Y on Linux WebKitGTK, and the enlarged editor.

#### UX-17 · Stop selected/all runtime acceptance

**Type:** ACCEPT · **Needs:** GPU, NATIVE, WIN

**Stop selected/all — remaining runtime acceptance (phase 1, 0.2.19).** The dialog and scoped-versus-whole-queue frontend wiring are implemented and fixture-verified; evidence is in [VERIFICATION.md](VERIFICATION.md#stop-selectedall--phase-1-0219-shipped-in-0219), usage in [STUDIO.md](STUDIO.md#queue-lifecycle-limits).
- [ ] On an isolated authorized backend, stop a pending item and a running item with another queued item; prove only the selected owned prompt is cancelled and the next item progresses without another Run press. Physically stop a serial SAM/Auto Refine chain separately; never use or restart foreign GPU services for acceptance.
- [ ] Real Linux WebKitGTK and Windows WebView2: Stop dropdown (0.2.22 replaced the dialog) keyboard focus, selection capture, terminal/unknown/no selection reasons, Escape/outside-click close and whole-queue choice. Fixture tests do not close these runtime gates.

#### UX-18 · Startup splash artwork and acceptance

**Type:** ACCEPT · **Needs:** OWNER, NATIVE, WIN

**Startup splash (artwork and acceptance open).** The splash (`public/splash.html`, `src-tauri/src/splash.rs`) shows the wordmark and real phases, keeps main hidden until the restore settles, has a 30 s hand-off deadline and a reduced-motion bar. Open:
- Owner-provided Catgirl idle animation into `public/splash/` (`catgirl.apng` preferred, `catgirl.webp`, static `catgirl.png` also used for reduced motion); do not substitute artwork.
- Acceptance beyond the Linux XWayland probe (fresh environment): warm start with a remembered environment, slow/failed restore, disabled autostart, Wayland-native and Windows.

#### UX-19 · Global search (Ctrl+K)

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Global search (landed in 0.2.7, open).** The magnifier entry in the top tab band, Ctrl+K, the breadcrumb result list and reveal/flash of controls are implemented over the curated index in `src/lib/search.ts` (`GlobalSearch.tsx`); a disabled control reports its own tooltip first, then the entry's reason key, then the generic greyed note. Open:
- Native acceptance on WebKitGTK and Windows: overlay placement at narrow widths, focus return after Escape, flash under reduced motion (Chromium at 1440/900/480 px and reduced motion are verified in `docs/VERIFICATION.md`).
- The index is a curated set (Studio settings/prompts/dock incl. Presets and Wildcards, Forge prompts and ladders, Chat, TVE post incl. frame-rate multiplier, Run Plan stages, Library catalog+installed incl. scan scope, Comfy iframe, Backend panes/folders/language, Logs filters/actions); extend it only where a control has a stable anchor.

#### UX-20 · In-app spellcheck

**Type:** ACCEPT + FEATURE · **Needs:** NATIVE, WIN

**In-app spellcheck (landed in 0.2.8, acceptance open).** `spellbook` checks prompt fields on every platform against the pair installed under Backend → Language (`spellcheck.rs`, `src/lib/spellcheck.ts`, `PromptTextarea`); the WebView/Enchant path is gone. Open:
- Native acceptance of the underline overlay (font/line metrics mirror) on WebKitGTK and WebView2, including resized Studio panes and the enlarged editor; the engine itself is verified with fixtures and the pinned pairs.
- A personal "add to dictionary" list for recurring prompt vocabulary (`photorealistic`, model names) is not implemented; such words are flagged.
- Fields outside `PromptTextarea` (Comfy iframe, Forge card/layout captions, Chat history) are not checked.

#### UX-21 · Monitoring tab (supersedes queue statistics expansion)

**Type:** ACCEPT + FEATURE · **Needs:** NATIVE, WIN

**Monitoring tab (landed in 0.2.9, open).** Generations (last ten finished attempts with queue wait, generation time, timeline bar and per-job peaks from the native job sampler) and System (one graph per component from a native `/proc`/`/proc/diskstats`/Win32 + `nvidia-smi` sample per second). Open: native acceptance on WebKitGTK and WebView2 (six canvases repainting at 1 Hz, narrow widths); AMD/Intel GPUs and the node pack's `/dasiwa/system-monitor` route (would add non-NVIDIA GPUs when the backend runs) are not read; peaks are per first GPU only; the Queue panel keeps its rows (this tab supersedes the "Queue statistics expansion" row above).

- Former row "Queue statistics expansion", superseded by this tab and kept only as an optional follow-up:
- **Queue statistics expansion.** Client-measured elapsed queued/running time for live rows (marked as client-side) and steps/seed/checkpoint in the detail view; no new tracking.

#### UX-22 · Dark Wizards tab — Replace (priority 1), Movie Maker, Mood, Grid Generator

**Type:** SLICE + FEATURE · **Needs:** CPU, GPU, NATIVE, WIN, PRIORITY (Movie Maker/Mood/Grid)

**Dark Wizards tab (planned; expands the earlier Wizards proposal).** A top-band tab named **Dark Wizards**, following the existing theme, skins, typography and shared viewport/navigation conventions, with multiple preset-driven "EZ wizards" that pick model, pipeline and settings themselves; the user supplies only media, a mask (optional) and a short instruction. A wizard checks the installed models against its preference list and, when nothing fits, offers the Library download (consent + license as today) instead of failing silently. Internally a wizard builds an ordinary image/video intent (`buildImageIntent`/`buildVideoIntent`) and runs through the shared Run/queue/preview — no new execution path; the Run Plan shows the chosen model and values. Additional wizard proposals (**Replace is first implementation priority**, followed by Movie Maker below; Mood remains planned): (1) **Replace** a character/object/characteristic in an image or video: images via Qwen Image Edit 2.1 (`nativeImageReference` method `qwen-image-2.1`, already compiled) or inpaint with mask; optional SAM 3.1 text→mask (§4.4) for the masked area; videos via H3 image edit per first frame + I2VA or LTX v2v with keyframe guides — research which gives the better replacement (owner's guess: H3) and record the fixed-seed comparison before choosing the default. (2) **Mood / colour / emphasis overhaul** of an image: prompt built from Prompt Forge presets and wildcard preset mixtures (`wildcard_preset_prompt_builder.md`, DEAS presets `studio-presets.md`) plus a small curated list of cinematic/colour-grade preset mixtures, run as low-denoise i2i with the family's refine defaults. **Status: planned, not implemented.** Owner request.
**Grid Generator — planned, not implemented.** Owner request: a Dark Wizards tool modeled on [SwarmUI → Tools → Grid Generator](https://github.com/mcmonkeyprojects/SwarmUI/tree/b5d28088/src/BuiltinExtensions/GridGenerator) for creating, saving and comparing multiple named image grids. Unlike the EZ wizards, this tool varies user-chosen parameters from a fixed Studio snapshot; it does not choose substitute models or change the original draft. Use `Workbench.tsx::buildImageIntent` and the existing native compile, Run Plan, queue and asset services as reuse points, not a second generation engine. The existing Replace → Movie Maker priority is unchanged.

- [ ] **Configure and compare.** Save, load and duplicate named grid configurations; keep previous runs and compare grids side by side on matching axes. Support configurable X/Y and additional axes (selectable slices/facets), ordered values and fixed controls for prompts, seeds, checkpoints, sampler/scheduler, steps, CFG, sizes, LoRAs and presets, where valid for the selected recipes. Include Swarm-style numeric ranges (`..`), comma-safe prompt lists (`||`), `SKIP:` placeholders, prompt find/replace and preset combinations. Pin the effective seed per cell before submission and show the resolved settings; never imply deterministic equality across different models.
- [ ] **Preview and run.** Dry-run preview shows the Cartesian cell count, queued versus skipped or invalid cells, expected outputs and resource limits before explicit approval; cap combinatorial expansion. Use the existing queue with scoped cancel, progress, stop/continue-on-error choice, optional live output display and model-aware execution ordering that does not change cell coordinates. Resume a saved grid by reusing only compatible completed cells, retry missing/failed or explicitly selected cells, and retain earlier results instead of overwriting them silently. Record cell intents, job IDs, output identities and errors through the shared job and logging paths.
- [ ] **Review and export.** Offer individual images, a labeled static grid image, and an interactive local HTML export with switchable axes/slices and selectable cells. Show effective settings in the viewer and make generation metadata an explicit export option; nothing is published automatically. Verify a reproducible fixed-seed comparison across two saved grids, axis switching, skipped/missing cells, partial failure and retry, no-clobber export, Linux/Windows native layout and access, seven locales, search and user documentation.

**Movie Maker — follows Replace. Status: planned, not implemented.** Owner request: drop multiple images, supply a story and desired total length, and let the wizard prepare a coherent movie with minimal additional input. Every generated stage must also be inspectable, editable and individually regenerable. This expands the same tab proposal, not a second competing wizard surface; Replace and Mood remain additional wizards.

**Source/reuse baseline.** `src/App.tsx` owns the current Studio panes and retained Forge host; it does not establish a Movie Maker tab. `src/lib/continuity.ts::nextStep` already plans captured first takes and subsequent H3 continuation from the preceding clip; this is a reuse seam, not proof of automatic story planning, independent shot editing or seamless final-film quality. `src-tauri/src/jobs_video.rs` owns video validation/compilation. Reuse native Prompt Forge and the existing H3 Director Forge boundary (`src-tauri/src/forge/mod.rs`), image reference intents and music intents (`src/lib/musicIntent.ts`, `src-tauri/src/jobs_music.rs`); do not introduce a parallel inference engine.

Owner-approved guided flow: **Brief → Cast / references → Lore and storyboard → Voices / soundtrack → Segment timeline → Review / assemble / export**. **Owner-revised implementation priority: Replace first, then Movie Maker.** Simple mode prepares the entire dependency plan from the brief; expanded mode exposes stage and segment overrides. **Default: run the displayed multi-stage plan after approval**, with pause and editing available at stage boundaries, plus optional approval stops. Pause prevents admission of the next stage; do not promise arbitrary mid-sampler checkpoint/resume. Preserve completed outputs and immutable in-flight submissions; edits requiring a changed downstream plan need approval before resumed computation. Authoring, entering the tab and editing never start computation. **Storytelling defaults to automatic scene/cut versus continuous-shot planning, with explicit user choice/overrides.** **Image/video/audio generation stays local; LLM planning supports both local and remote endpoints**, reusing Prompt Forge's configured providers, models and credentials rather than introducing a separate LLM setup. Remote LLM use is explicit, with the destination and supplied story/prompt/reference data visible before transfer; never silently fall back from a local LLM to a remote provider or change existing Forge configuration. Send reference media only when explicitly authorized and supported by the selected endpoint.

- [ ] Inputs: multi-image drop with explicit grouping/assignment to actors, locations, props or style; story, target total duration and output format/aspect. Optional existing character sheets, music, ambience and per-actor voice/reference clips can replace generation. Preserve originals and make reference purpose clear rather than treating every image as the same character.
- [ ] Cast preparation: prefer the verified Qwen Image Edit 2.1 reference recipe for character sheets/multiview candidates; allow actor naming, selecting/replacing views and approving/locking identity, wardrobe and appearance. Verify the exact requested model/recipe before advertising this capability; generated multiview consistency is a real-model quality gate, not an assumed property.
- [ ] Story planning: Forge-compatible structured output for a shared story/lore bible, cast/voice IDs, locations, chronology, scene/shot list, dialogue and emotional/delivery cues, camera/action prompts and entry/exit state per segment. Validate schema, actor/reference IDs and timing, show editable text, and preserve locked/manual content on regeneration. Keep narrative continuity distinct from visual/latent continuation.
- [ ] H3 segment generation: preferred MiniMax H3 with family-valid frame/fps/resolution/audio constraints and reference conditioning. Aim for approximately 5–15-second segments where supported and admitted by measured memory limits; this is not a universal supported range or a guaranteed VRAM-to-duration formula. Show actual submitted segment durations and total duration, account for continuation overlap and final-tail handling, and explain an unattainable exact requested duration before running. Never silently reduce quality, switch models or exceed a declared budget.
- [ ] Continuity-aware assembly: reuse H3 continuation for adjacent continuous action, plus explicit scene cuts where the story calls for them; establish identity, scene-state, reference and audio carry-over rules. Validate whether the existing full-output continuation already contains prior footage before assembling, avoiding duplicated prefixes/overlaps. Export one playable film with correct timing, no duplicated/missing boundary frames and coherent sound; a file concatenation or crossfade alone is not proof of seamless continuation.
- [ ] Audio roles are separate capabilities: soundtrack/music (YuE2 or another verified fitting model), ambience/SFX, actor speech and any native generated video audio. Do not infer general ambience, controllable dialogue, cloning, reference-audio support or lip sync from music/video support. Discover compatible local recipes and reference modes per role; surface missing capabilities and consented installation options. No silent model substitution or cloud fallback.
**Owner-selected primary audio candidates: Qwen3-TTS and YuE2, with MiniMax H3 as the joint video/audio generator.** These companion models can prepare reference audio rather than necessarily rendering the final movie soundtrack separately. Proposed dialogue-film path: Qwen3-TTS creates approved actor voice/line references; YuE2 creates optional music references; H3 consumes the supported audio references alongside cast/scene images and segment prompts to generate audiovisual segments. Proposed song/music-video path: YuE2 creates the song, then H3 uses the relevant song portions as reference inputs alongside visual references; Qwen3-TTS is not required for a song-only workflow. User-provided audio can replace either generation stage. Preserve reference assets, actor/cue identities and sample-accurate source ranges per segment in the movie manifest.

- [ ] Validate the exact H3 audio-reference modes, duration/sample limits, required visual companions, multiple-reference/speaker assignment and continuation behavior through the existing compiler/backend boundary. `src-tauri/src/jobs_video.rs` already validates REF2VA audio references and requires an image/video reference when RefMods is absent; this is a reuse seam, not proof that every voice/music combination is supported. Distinguish reference-guided synthesis (which may change words, identity, melody or timing) from exact preservation of a supplied song/dialogue waveform. Expose that choice in the plan; if exact song playback is requested, retain the original audio as the final master track and verify video alignment rather than claiming H3 reproduces it sample-for-sample. Test reference transfer, intelligibility, actor identity, musical fidelity, lip sync and cross-segment continuity before enabling each path. Dedicated external ambience/Foley/final-mix stages remain optional, not prerequisites when H3's generated audio meets acceptance.

**Additional audio model research shortlist (upstream documentation reviewed; not an integration, quality ranking or watermark-free certification).** Qwen3-TTS and YuE2 are the primary candidates for the owner-selected reference-first path; the other models below are optional comparison/fallback research, not selected defaults. Prefer current high-quality local models per role rather than a single purported universal SOTA model. Existing family declarations in `src/families/builtin.json` cover exact ACE-Step 1.5 variants and YuE2; they do not establish wizard orchestration or support for the new candidates below.

- **Primary voice-reference candidate — Qwen3-TTS 12Hz 1.7B:** evaluate VoiceDesign to create and approve a fictional actor reference, then Base with its reusable clone prompt for repeated lines; CustomVoice provides preset speakers with instruction-based style control. These are distinct checkpoints/capabilities, not interchangeable modes. Upstream documents ten languages including German and English; the [Base model card](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base) declares Apache-2.0. The [official implementation](https://github.com/QwenLM/Qwen3-TTS) documents design-then-clone. Do not assume Base cloning exposes the same instruction controls as CustomVoice or that generated speech has exact requested duration/lip sync. Watermark behavior remains unverified beyond no watermark requirement found in the reviewed README/card.
- **Expressive dialogue comparison — IndexTTS:** the [current upstream](https://github.com/index-tts/index-tts) documents emotion reference/vector/text controls and IndexTTS2.5 speed control. Pin the exact version before comparison; do not attribute 2.5 controls to 2.0. Evaluate identity versus emotion disentanglement on the same actor lines. Its bilibili Model Use License Agreement needs separate model/commercial review; watermark behavior remains unverified. Not an approved default merely because it has acting controls.
- **Optional score / instrumental comparison — ACE-Step 1.5:** integration-reuse alternative to the primary YuE2 candidate, comparing the exact supported Base/SFT/Turbo variants for instrumental cinematic score, reference-guided music and local revision. [Upstream](https://github.com/ace-step/ACE-Step-1.5) describes cover, repaint and vocal-to-BGM capabilities and labels its code MIT; verify selected weight/companion terms separately. Prefer a coherent scene/film-level score with cue edits, not independent music generation per video segment. Wizard exposure of upstream editing features needs its own intent/compiler support. Watermark behavior remains unverified; no watermark requirement was found in the reviewed README.
- **Primary music/song-reference candidate — YuE2-3B:** evaluate for composed score, full songs and reference covers supplied to H3, not as a speech or general SFX model. The [current weight card](https://huggingface.co/m-a-p/YuE2-3B) declares **CC-BY-NC-4.0**; permissive repository code does not override weight restrictions. Do not make it an unrestricted commercial default. Watermark behavior remains unverified; verify exact weight license and any separately granted commercial rights.
- **Ambience / text-directed effects / score repair — Stable Audio 3:** evaluate Small-SFX for focused sound design, Small-Music for lightweight score drafts, and Medium for higher-quality music/sound generation and inpainting/extension. The [official repository](https://github.com/Stability-AI/stable-audio-3) and [Medium card](https://huggingface.co/stabilityai/stable-audio-3-medium) distinguish MIT code from Stability audio/community weight terms. Large is API-only in the reviewed public implementation and excluded from the local generation shortlist. Verify hardware/platform support, exact checkpoint terms and watermark behavior; the README/card review alone is not a watermark-free guarantee. Text-to-audio is not demonstrated frame-accurate video-to-audio.
- **Video-aligned Foley — MMAudio large_44k_v2:** [upstream](https://github.com/hkchengrex/MMAudio) explicitly conditions on video/text with synchronization; worth a quality comparison for footsteps, impacts and action sounds, not scripted dialogue. Default training/output duration is 8 seconds; arbitrary H3 segment lengths need measured window/overlap handling. **Weights are CC-BY-NC-4.0**, despite MIT code, so not an unrestricted commercial default. Upstream warns about unintelligible speech-like sounds; require clean effects-only acceptance and preserve dialogue stems. Watermark behavior remains unverified.
- **Exclude from the non-watermarked default shortlist — Chatterbox:** [official upstream](https://github.com/resemble-ai/chatterbox) explicitly states generated audio includes an imperceptible PerTh watermark. MIT licensing does not make output unwatermarked. Select another model rather than proposing watermark removal. Likewise exclude any other model/checkpoint/runtime that mandates embedded audio/visual watermarking.
- [ ] **Non-watermarked output is an explicit model-selection requirement**, covering inaudible/imperceptible marks as well as visible/audible branding. For every selected image/video/audio model, record exact weight and runtime revisions, code/weight/companion licenses, output restrictions, watermark documentation and source-path audit (including adapters, vocoders and savers). Distinguish documented absence, audited no-insertion path, embedded-in-weights uncertainty and unknown status; absence of a README mention is not proof. Unknown candidates stay research-only for this requirement; never badge them verified watermark-free, silently strip provenance, or remove an existing watermark from supplied references. Keep ordinary provenance metadata distinct from signal watermarking.
- [ ] Compare admitted candidates on the approved two-actor film: English/German intelligibility as relevant, stable identity across lines, emotional control, leakage/hallucinated speech, reference fidelity, cue/impact timing, background loops/joins, music continuity and mix quality. Measure actual RAM/VRAM/time and native-platform readiness; serialize model residency against H3. Require a supported owned-backend recipe before presenting a model as runnable; a third-party node pack listing alone is not integration evidence. Research findings do not authorize downloads, dependency changes or GPU runs.

- [ ] Voice direction: stable voice assignment per actor with per-line/scene emotion, delivery and timing overrides; reference clips only through a verified supported path and with permission to use the voice. Define dialogue/lip-sync strategy and audio precedence before implementation: avoid doubling H3 speech with external dialogue; preserve separate music, ambience and dialogue stems where available, with editable levels, fades and ducking. Speech edits must expose whether video must be regenerated/resynchronized rather than promise audio-only edits retain lip sync.
- [ ] Editable timeline: inspect prompts, cast/reference assignments, duration, seeds, model/settings, music and each actor's lines per segment. Regenerate a selected sheet, prompt, audio item or video segment without replacing approved unrelated outputs. Revisions preserve old results; changed continuity/lore/audio dependencies mark affected downstream items stale and show the bounded rerun plan for approval. A changed segment may invalidate later continuous segments; do not imply that every replacement is isolated.
- [ ] Native orchestration: typed, versioned stage plans with immutable ordinary intents through existing jobs/queue, capability admission, conservative serial GPU scheduling, model-release/resource checks, progress, scoped cancellation, partial-output retention and correlated central Logs. Data-defined wizard descriptors may reference reviewed stage implementations; do not encode orchestration in free-form prompts or build a speculative generic workflow framework.
- [ ] **Save/reopen and restart recovery are mandatory (owner-approved Movie Maker scope).** A long movie cannot rely on the last-ten-job history for recovery. Use a bounded, versioned movie manifest referencing inputs, completed assets, authored stage revisions, approved plan, cast/voice identities and continuity checkpoints, atomically saved with missing-dependency reporting. Reconcile in-flight jobs without automatic resubmission or duplicate work; reopen paused and require explicit resume approval. Verify that required assets/checkpoints survive ordinary temporary cleanup; explain missing external files. This authorizes movie-specific recovery, not an unrelated application-wide persistence rewrite; full managed-media adoption/portable archives remain deferred unless separately approved.
- [ ] Acceptance: stage-to-intent/native validation tests, invalid planner output, missing dependencies, reference assignment, edit/invalidation/locking, exact timeline/overlap/audio arithmetic, failure/cancel/retry and restart reconciliation as authorized. Real-model multi-actor/multi-segment runs must demonstrate identity, narrative continuity, visual joins, voice consistency, audio sync and final playback, with measured RAM/VRAM/time; distinguish CPU fixtures, GPU quality and native Linux/Windows evidence. Six locales, global search, Beginner/Advanced views, `npm run test:layout`, and maintained STUDIO/tab documentation are required when implemented. Existing Studio jobs/intents/graphs remain unchanged when the wizard is not used.

**Movie Maker split (2026-11-24; each row says what is deferred).** Nothing here changes Studio jobs, intents or graphs.
- UX-22d0 — **landed (fixture-verified, no caller yet, so no version bump/changelog; [verification](VERIFICATION.md#movie-maker-manifest-and-arithmetic-core-ux-22d0-2026-11-24))**: **manifest and arithmetic core** (pure TypeScript, `src/lib/movieManifest.ts`, no UI, no native, no jobs): the versioned movie manifest schema with validation and size bounds, dependency/staleness propagation with a bounded rerun plan (locked items need approval), revisions that keep old results, and exact segment-duration arithmetic with continuation overlap and an explanation when the requested total is unattainable. Deferred: persistence (UX-22d1), planner/LLM, any tab, any generation.
- UX-22d1a — **landed (fixture-verified, no frontend caller yet, so no version bump/changelog; [verification](VERIFICATION.md#movie-maker-manifest-store-ux-22d1a-2026-11-24))**: native `native_movie_list/open/save` (`src-tauri/src/movie_store.rs`) with bounded validation, atomic save, fixed error codes and Central Logs.
- UX-22d1b — **landed in 0.3.33 (fixture-verified; [verification](VERIFICATION.md#movie-maker-missing-files-on-reopen-ux-22d1b-0333-2026-11-24))**: `native_movie_check` plus the reopen report and *Mark the missing clips as not made*. Open: a movie saved while a job was in flight is reopened with that shot not made (there is no resubmission by design) — a dedicated *in-flight at save* marker is not recorded; native Linux/Windows check; network-share paths are not given a timeout.
- UX-22d2 — **landed in 0.3.29 (fixture-verified; [verification](VERIFICATION.md#movie-maker-brief-and-cast-stages-ux-22d2-0329-2026-11-24))**: Brief and Cast / references in the Dark Wizards tab (`src/features/wizards/MovieMaker.tsx`), save/open through UX-22d1a. Deferred inside d2: OS drag-and-drop of several pictures at once and reference-purpose analysis (a picture is added one at a time with Choose…), native Linux/Windows click-through.\n- UX-22d3a — **landed (fixture-verified, no caller yet, so no version bump/changelog; [verification](VERIFICATION.md#movie-maker-story-plan-core-ux-22d3a-2026-11-24))**: planner request text with disclosure, strict plan parser/validator, approval diff and application to the manifest (`src/lib/movieStory.ts`). Deferred: the endpoint call and Story stage UI landed as **UX-22d3b in 0.3.30** (below).
- UX-22d3b — **landed in 0.3.30 (fixture-verified; [verification](VERIFICATION.md#movie-maker-story-planning-in-the-tab-ux-22d3b-0330-2026-11-24))**: model pick, explicit remote confirmation, validated proposal with diff approval and the editable Story stage using `native_llm_generate`; limits from `video.segment` family data. Open: a real-LLM run (answer quality, whether small local models produce valid JSON), cancellation of a running plan (the completion call has no cancel), per-model context size beyond the 4096-token bound, Beginner mode check, native click-through.
- UX-22d4a — **landed in 0.3.31 (fixture-verified; [verification](VERIFICATION.md#movie-maker-make-the-shots-ux-22d4a-0331-2026-11-24))**: cut/first shots as H3 t2v / REF2VA drafts through Generate's own Run (`source: 'movie'` hand-over), result recorded on the manifest (`outputId` = the clip's file path, plus job id). Open: **UX-22d4b** continued shots via H3 Continuity (session/source clip per shot, overlap, full-vs-segment output and duplicate-prefix checks); a real GPU run of a shot; per-shot seeds/dials; the missing-file check on reopen (UX-22d1b — `outputId` now identifies a file path, so it is unblocked); Beginner check.
- UX-22d6 — **landed in 0.3.32 (fixture-verified; [verification](VERIFICATION.md#movie-maker-join-the-shots-ux-22d6-0332-2026-11-24))**: ordered join of the recorded shot clips through the existing `h3-join` files recipe (inspect → upload → pack preflight → job), result recorded on the final item. Open: a real backend/GPU run of shots followed by the join (native Linux/Windows), cross-segment audio/lore consistency review, continued shots (UX-22d4b) which will need the duplicate-prefix checks, subtitles/music/voices (UX-22d5).
- UX-22d4b0 — **landed (fixture-verified, model only, no caller yet, so no version bump/changelog; [verification](VERIFICATION.md#movie-maker-continued-shots-chain-model-ux-22d4b0-2026-11-24))**: `src/lib/movieChains.ts` groups shots into chains and builds each chain's `ContinuityPlan` (segment output mode, overlap, `useReferences`) with the H3 frame arithmetic and the refusals the family rules imply.
- [ ] **UX-22d4b1 — run continued shots.** Source findings: (1) Workbench's continuity plan is the persistent pref `studio.run.continuity` (`Workbench.tsx` `usePref`), so a hand-over that sets it would overwrite the user's own plan — **decision needed:** a separate in-memory movie plan, or save-and-restore; (2) the plan runs through Workbench's own `runPlan`/`planRun`, while a wizard hand-over follows exactly one job (`wizardJob`) — chain progress needs multi-step reporting through `onWizardApplied`; (3) in `segment` output mode each step's file holds only its newly visible footage and the step's *checkpoint clip id* (`ContinuityStep.clipId`) is what the pack joins, so a continued shot's recorded result must carry that clip id and the film join must use `h3-join` kind `segments` (session + chain) for chains, not the file concatenation of UX-22d6; (4) a continued step needs its predecessor's clip captured in the same session, so a chain is rerun from the first changed shot onward (the staleness rule already marks later continuous shots stale). Real-model quality of continued shots (identity, visual joins, audio) stays a GPU acceptance gate.
- [ ] UX-22d5 — audio roles (music, voices, ambience; see the audio candidates above). Real-model acceptance of the whole movie stays open (GPU).

**Owner-approved first acceptance film:** approximately 30 seconds, two characters and several segments, using a verified H3 preset and supported resolution suitable for the available authorized GPU. This is an end-to-end test case, not a product limit; exact resolution/aspect and GPU/VRAM are determined before testing. No GPU run is authorized by these planning answers. Replace is the first wizard implementation priority; Mood remains planned, not automatically part of the first Movie Maker release. Exact audio model/voice/lip-sync choices require capability research rather than an unverified fixed default.

- **UX-22a landed in 0.3.11 (fixture-verified):** Dark Wizards tab, wizard descriptors as validated data (`src/wizards/builtin.json`, `src/lib/wizards.ts`), Replace for images with an optional object picture A placed into B — Qwen Image 2.1 reference edit, masked edit on the same Qwen model (B and A as `image 1`/`image 2`), text-only inpaint fallback — prepared into Generate through the `wizard` hand-over, and **Find in Library** for a missing model (catalog search only, no download). Evidence: [verification](VERIFICATION.md#dark-wizards-replace-for-images-ux-22a-0311).
- **UX-22b1 landed in 0.3.12 (fixture-verified):** **Prepare and run** in the wizard hands the same draft to Generate and starts it there through Workbench's own `run()` (the Chat-render seam, not a second execution path); the wizard shows that one job's progress/preview with a **Stop** for only that job, then the finished picture (native-held `outputRoot` + output identity), its size/model/seed/duration and **Show in Generate**. Evidence: [verification](VERIFICATION.md#dark-wizards-prepare-and-run-ux-22b1-0312).
- **UX-22b2 landed in 0.3.15 (fixture-verified):** masked **Prepare and run** — Generate masks the picture with its own `maskWithSam` text path from *Replace what*, then starts the run; disabled with Generate's SAM reason. Evidence: [verification](VERIFICATION.md#dark-wizards-sam-31-mask-for-prepare-and-run-ux-22b2-0315). Open: SAM mask quality on real pictures and the masked one-click run end to end are part of the UX-22b GPU gate below.
- **UX-22b3 landed in 0.3.16 (fixture-verified):** Beginner band page **Wizards** with the same component; Beginner accepts hand-overs for Beginner-usable models and shows wizard pictures, masked edit and wizard size in its composer. Evidence: [verification](VERIFICATION.md#dark-wizards-in-beginner-ux-22b3-0316). Open: native/Windows click-through (row below).
- [ ] **UX-22b GPU — measured on the Windows test PC in 0.3.18, quality decisions open** ([verification](VERIFICATION.md#windows-real-model-runs-replace-wizard-on-qwen-image-21-turbo-and-sam-31-0318-2026-11-21)). Owner decisions applied in 0.3.19 (object pictures → reference edit; SAM mask grow 32 px + blur 4 px), measured in the [0.3.19 entry](VERIFICATION.md#windows-replace-wizard-object-routing-and-grown-sam-mask-0319-2026-11-21). Ran: Qwen Image 2.1 Turbo reference edit with and without object picture (both replace convincingly: car → blue bicycle / → the dog from image 2, scene kept), masked edit with and without object, SDXL text inpaint, one-click path (wizard picture = the job's own file), Stop of just that job, SAM 3.1 no-match on a real photo and a two-part target. Open:
  - Multi-part targets: owner decision (b), a hint instead of per-part replacements — shipped in 0.3.25.
  - [ ] Residual dark smudge under the grown mask area on the street picture (0.3.18 run).
  - Qwen Image 2.1 full model (`qwen_image_2.1_int8_convrot`) masked one-click run on native Linux in 0.3.25 ([verification](VERIFICATION.md#linux-native-and-real-model-session-replace-wizard-crop-and-replace-for-videos-0325-2026-11-24)): book → sleeping cat replaced convincingly, changes confined to the book region.
  - Masked edit on Qwen 2.1 full that erased the object without drawing the replacement: owner decision (a) "bigger mask, stronger redraw"; measured that the mask size is not the cause and CFG is ([verification](VERIFICATION.md#replace-wizard-masked-edit-cfg-vs-mask-size-0326-2026-11-24)). Shipped in 0.3.26: the masked method sets CFG 4 on `qwen-image-2.1` (wizard data, Turbo and other families unchanged); mask grow stays 32 px. Verified in the real Linux app (apple drawn, intent `cfg: 4`).
  - [ ] Masked replacement quality on the other masked families (Flux.2, Z-Image, Flux.1, SDXL) at their own CFG is unmeasured; extend the seed sweep when those models are installed.
  - [ ] Flux.2 masked run: no Flux.2 diffusion model is installed on the test host (only `flux2-vae`), so it could not run.
- [ ] Off-grid **Crop to W×H** (0.3.25; native Linux verified with a pixel-exact crop into the configured Input folder and a masked one-click run on the copy, [verification](VERIFICATION.md#linux-native-and-real-model-session-replace-wizard-crop-and-replace-for-videos-0325-2026-11-24)): Windows WebView2 click-through.
- [ ] **UX-22c — Replace for videos**, split so nothing is built ahead of the comparison (both families already declare `v2v`/`ref2v` in `src/families/builtin.json`; the replacement first frame comes from the existing image Replace path):
  - UX-22c0 (comparison harness) landed in 0.3.25, fixture-verified ([verification](VERIFICATION.md#replace-for-videos-comparison-harness-ux-22c0-0325)): candidates A/B/C as `UX-22c-*` gates in `tools/gpu_acceptance_session.py`, all three graphs valid offline.
  - UX-22c1 measured on 2026-11-24 ([verification](VERIFICATION.md#linux-native-and-real-model-session-replace-wizard-crop-and-replace-for-videos-0325-2026-11-24)): A, B and C on a static-camera clip and a strongly moving clip at 480×832, plus C at guide 0.3. Only H3 I2VA (A) keeps the replacement on both clips, but it re-animates the shot (motion correlation 0.44 / 0.24, scene drift to 12.7 dB on the moving clip). LTX v2v at guide 0.3 is the best edit on the static clip (motion 0.99, scene 31.3 dB, replacement held), but on the moving clip it and H3 REF2VA (B) lose the replacement after about a second as the source object returns; LTX at guide 0.6 never shows it. LTX does not carry the source sound; its own track was near-silent on three of four runs.
  - UX-22c1 owner decision (a): offer both measured methods — **Edit video** (LTX 2.3 v2v, source guide 0.3, replaced frame as first frame; best for still or slow shots) and **Re-animate from the edited frame** (H3 I2VA; keeps the replacement, does not follow the source motion). The wizard states plainly that strongly moving shots are not reliable yet.
  - UX-22c2 landed in 0.3.27 ([verification](VERIFICATION.md#dark-wizards-replace-for-videos-in-the-wizard-ux-22c2-0327-2026-11-24)): video as the picture to change, exact first frame into Input, image methods on it, then **Edit video** (LTX v2v, guide 0.2 — measured at the wizard's canvas; 0.3 lost the replacement) or **Re-animate** (H3 I2VA) as ordinary Generate jobs, chained by *Run both steps*. Native Linux end to end with real models for both methods.
  - [ ] **UX-22c3:** Windows WebView2 click-through and one real run; Linux OS drag-and-drop/Choose… of a clip (paste was used). (The H3/LTX video model default now prefers the Turbo/distilled/int8/fp8 file of the family, 0.3.28; remembering the choice across sessions is not done.)
  - [ ] A clip shorter than 1 s is handed over as 1 s; decide whether to refuse sub-second clips instead.
- [ ] Native Linux WebKitGTK click-through of the tab: verified in 0.3.25 ([verification](VERIFICATION.md#linux-native-and-real-model-session-replace-wizard-crop-and-replace-for-videos-0325-2026-11-24)) — tab and Beginner Wizards page in the real app, paste of a file path through the tab's paste handler (synthetic `ClipboardEvent`; OS keyboard/clipboard injection is not possible on this host), native describe, Crop to W×H, multi-target hint, Prepare and run with SAM 3.1 on the owned backend. Still open on Linux: OS drag-and-drop, Choose… (native dialog) and a real Ctrl+V, Find in Library (needs a missing-model state). Windows WebView2 covered over CDP in 0.3.16 — tab and Beginner page rendering, native describe of a pasted path, SAM reason, hand-over and real SDXL inpaint runs from both experiences ([verification](VERIFICATION.md#windows-webview2-acceptance-dark-wizards-ux-22b1b3-0316-2026-11-21)); still open on Windows: OS clipboard/drop/Choose… at the desktop, Find in Library, the masked one-click run with a SAM 3.1 checkpoint.
- [ ] Mood wizard with preset picker and a before/after Slider result (existing paired-products presentation).
- [ ] Unchanged: Studio tabs, intents and graphs; a wizard run is an ordinary job in the queue.

**Promo/Trailer wizard — planned (owner request 2026-11-24; answers recorded here; Movie Maker's slimmed predecessor).** An in-product Dark Wizards wizard (not an agent-side video pipeline) that turns a project brief plus optional existing Media into a promo cut. A wizard run stays an ordinary intent through the shared Run/queue/preview path. v1 scenes are **discrete cuts**: H3 Continuity carry-over, cast/lore bibles and identity locking stay Movie Maker scope and are not promised here. Owner-approved shape: **Brief / scene list → per-scene generation → audio roles → scene timeline → assemble (Join) → subtitles → export**.

- [ ] Brief and scene list: a short project description, target duration/aspect and optional existing Media; LLM planning reuses the configured Forge endpoint (local or remote under the Movie Maker rules, never a silent fallback) to draft N scenes with copy, seconds and camera/action prompts — all editable, nothing computes before an explicit Run of the displayed plan.
- [ ] Optional product analysis feeding that brief (owner decision 2026-11-24, sources: provided media + project folder; **no URL/site crawling** in scope): an explicit **Analyze what I provided** step runs the existing Prompt Forge vision/tagger/Describe path (`docs/MEDIA-ANALYSIS.md`, V-01) over dropped media and a separately chosen **Read project folder** intake (text files and pictures only, explicitly picked; nothing scanned implicitly), and feeds the resulting descriptions into the scene-list draft. Analysis output is visible, editable text with its source per line, follows the same local-preferred/explicit-remote Forge rules, and — like authoring itself — starts no generation by itself. Folder intake respects the configured media/asset boundaries and excludes credentials, model weights and secrets from the analysed set.
- [ ] Per-scene generation: ordinary `buildVideoIntent` runs; the family picker offers verified presets only (H3 / LTX 2 / 2.3 / Wan per `src/families/builtin.json` and the recipe gates), each scene keeps job ID, seed, model and output identity in the promo manifest.
- [ ] Speech role is a user choice: **MiniMax H3 native audio**, **LTX 2/2.3 native audio**, or **Qwen3-TTS external voice** (global in v1, per-scene overrides later). The Qwen3-TTS option is not presented before the audio-shortlist research in this entry declares a Qwen3-TTS family/recipe; until then the picker shows the two native-audio choices with the concrete reason. Never double native video speech with external dialogue; the manifest records which role owns each scene's master audio.
- [ ] Music bed: **YuE2** or **ACE-Step 1.5** as a selectable option plus user-supplied tracks (both families already declared; reuse `musicIntent`/`jobs_music`). Record exact weight terms — YuE2-3B weights are CC-BY-NC-4.0, so it is not an unrestricted commercial promo default.
- [ ] Editable scene timeline: reorder, trim, edit copy/duration and **regenerate a single scene without replacing approved unrelated outputs**; changed scenes mark only downstream assembly/subtitle/mix items stale and show a bounded rerun plan before approval. Reuse the Movie Maker manifest/staleness machinery — one versioned manifest schema, not a second one.
- [ ] Assembly reuses the existing model-free **Join clips** path (preflight → join, trims, ordering, optional H3 transitions, Smooth audio seams) through ordinary jobs; no parallel assembler and no new join semantics.
- [ ] Subtitles from scene copy plus actual joined timing: the primary deliverable is a **muxed soft subtitle track** (SRT/ASS) in the exported file, with **burn-in** as an explicit second option (never both silently). Timing arithmetic is frame-accurate against the joined result and verified by ffprobe/stream inspection, not assumed from requested seconds. Current video export drafts refuse subtitle streams on purpose (`src-tauri/src/video_post.rs` source probe + draft blockers); lifting that blocker for wizard-owned exports is its own explicit slice and does not silently change existing export-draft behavior.
- [ ] Audio mix: a music bed under speech needs a mix/duck stage; until one exists, v1 keeps exactly one master audio per scene and documents that limit instead of promising ducking.
- [ ] Acceptance: manifest fixtures (staleness, bounded rerun, subtitle timing math), offline graph validation of every candidate scene intent (`tools/validate_video_graphs.py`), one owner-approved real GPU promo proving single-scene rerender + re-join + muxed subtitle playback on native Linux and Windows, six locales, `searchIndex` entries, Beginner/Advanced views, `npm run test:layout`, and DARK-WIZARDS.md documentation.

Planning-only entry: this does not set an implementation priority ahead of Replace for videos (UX-22c) or Movie Maker, and it authorizes no model downloads, TTS integration, GPU runs or code changes.

#### UX-23 · Project persistence

**Type:** DEFERRED · **Needs:** PRIORITY

**Project persistence (deferred).** The full target, if resumed:
- complete Studio authoring state;
- managed inputs, adopted results and job records;
- an extension of the versioned `project.json` (no parallel schema);
- one portable ZIP with credentials and weights excluded, and safe extraction;
- reopening without computation.

Existing draft projects stay as they are.

#### UX-24 · Native acceptance for older shipped UX slices

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Native acceptance still open for shipped UX slices:**
- star/unstar round-trips (Unicode, collisions, permissions, restart);
- column resizing and the remembered session;
- Quick Settings resets and project/global isolation;
- LLM-setup routing from every entry point;
- Settings dropdown rendering and dependency-warning clearing in WebKitGTK/WebView2;
- contained bottom media controls (U-02).

#### UX-25 · Export without metadata

**Type:** ACCEPT + SLICE · **Needs:** NATIVE, WIN, CPU

**Export without metadata — landed in 0.2.22 (fixture + real-FFmpeg verified).** `media_export.rs::native_media_export_clean` (Output-root authority, chunk-level PNG/JPEG/WebP strip, FFmpeg `-map_metadata -1 -map_chapters -1 -c copy`, no-clobber publish), wired into `mediaActions` and the queue `jobMenu`. Open: native save-dialog click-through on Linux/Windows, Matroska attachments, metadata after the first JPEG scan, an FFmpeg timeout.

#### UX-26 · Estimated time next to the step count

**Type:** ACCEPT · **Needs:** NATIVE

**Estimated time next to the step count — landed in 0.2.22 (fixture-verified).** `stepEta.ts` per job, recomputed on each status poll (no ticking between polls). Open: native visual check.

#### UX-27 · Local Notes and Media deletion

**Type:** ACCEPT · **Needs:** NATIVE, WIN

Manual prompt notes and nested folders are implemented as personal profile data,
with explicit Save and write-failure recovery. Media has confirmed single/bulk
native deletion of owned Input/Output files. Fixture validation covers both;
native WebView user acceptance remains open. Native deletion/cache/RefMod code
compiled and passed the full serial Rust suite, including disposable Linux
capture/rollback fixtures; Windows cross-check and strict Clippy passed. Real Windows
handle/reparse deletion ran on the Windows host (module 11/11, see the 2026-11-17
VERIFICATION entry); interactive Linux/Windows acceptance remains a separate gate. 0.3.12 (PR #45) adds folder naming dialogs, saved drag order/nesting and overwrite confirmation; pointer drag is covered in Chromium only, so native WebKitGTK/WebView2 drag acceptance is open, as is a real Windows run of the Explorer select-the-file reveal (compiles under strict Windows Clippy). 0.3.12 (PR #46) MP4 Library covers: native acceptance open for Linux Model Details playback through NativeVideo and for WebView2 card/details playback on Windows. 0.3.14 (PR #47) Enhanced Preview transport (play/pause, scrub, stretched-preview rate via mpv `speed`): native acceptance open on Linux libmpv during a real running video job and on Windows WebView2. These changes do not authorize a real library scan or generation
during verification.

#### UX-28 · Selected-LoRA popup and sets

**Type:** ACCEPT · **Needs:** NATIVE

Selected weights, root-scoped personal set CRUD, Library add notifications,
preview thumbnails, stacked read-only details and backdrop dismissal have fixture coverage. Native WebView interaction and user
acceptance remain separate; no real model scan or generation is run during checks.

#### UX-29 · Studio LoRA inventory fix

**Type:** ACCEPT · **Needs:** NATIVE, OWNER

Studio lists all indexed LoRAs and allows other-family authoring selections,
and submission. Family-only labels are advisory in Studio and native admission;
missing-file, loader, integrity and source checks remain. Retained other-family
selections stay inactive on model switches unless explicitly enabled in that
model draft; disabled entries do not block readiness. Mocked coverage checks
exact weights, no family popup and compact declaration markers without generation.
Native acceptance with the user's collection remains separate.

#### UX-30 · Studio refocus fix

**Type:** ACCEPT · **Needs:** NATIVE, OWNER

The model refresh on window focus has been removed. A mocked regression checks
that Run stays available and model/backend requests do not increase on refocus,
while explicit Reload still discovers new files. Native-window acceptance remains
with the user; no live generation is started.

#### UX-31 · Split `Workbench.tsx`

**Type:** SLICE · **Needs:** CPU

`src/features/studio/Workbench.tsx` is 353 KB: one `WorkbenchContent` component of about 2,600 lines with 33 `useState`, 29 `useRef` and 60 `useEffect` calls, about 120 lines over 400 characters. Duplication is low (three repeated snippets); the problem is that every concern shares the same state. Done in 0.3.34: the wizard hand-over's decisions as the pure `wizardDraft.ts`, shared guards in `studioGuards.ts`, orphan imports/exports removed. A hook that takes the remaining wizard effects would need a ~60-member parameter bag (all the setters and refs), which only moves the tangle; do these first, in this order, each with the full Workbench suites green and no behaviour change:

- [ ] Pure intent builders (video, image, music `buildXIntent` bodies) out of `run()` into plain functions fed by one settings snapshot object.
- [ ] The continuity plan runner (`planRun`, `runPlan`, clip resolution) as one hook with its own state, which UX-22d4b1 needs anyway.
- [ ] Group related state into a few reducers/contexts (references, SAM/masking, run queue) before extracting further hooks, so hooks take a handful of values instead of dozens of setters.
- [ ] Remaining top-of-file constants and validators into modules (`studioGuards.ts` is the pattern).

### 4.7 Library and downloads backlog

#### L-01 · Library Catalog / PR #38 — H3 reference generation gate

**Type:** ACCEPT · **Needs:** GPU

Remaining gate of the Library Catalog and [PR #38](https://github.com/darksidewalker/DEAS/pull/38) integration (released in 0.2.40); the closed gates are in [VERIFICATION.md](VERIFICATION.md#closed-plan-items-moved-from-planmd-2026-11-19).

- [ ] Real H3 image/video and audio-reference generation/quality acceptance;
  role intent, duplicate-slot uploads and existing limits are regression tested,
  but no new model run or backend restart is authorized by these UI checks.

#### L-02 · Library/Studio quality-of-life (PR #37)

**Type:** ACCEPT · **Needs:** NATIVE, WIN

Shared Favorites, explicit inventory/cover updates, compact bulk family/favorite
actions and separately confirmed clean-export replacement are integrated from
[PR #37](https://github.com/darksidewalker/DEAS/pull/37). Native Linux/WebKitGTK
and Windows/WebView2 save-dialog, replacement/recovery and large-library
interaction/performance acceptance remain open. Automated checks use disposable
fixtures, not the owner's media, preferences or model collection.

H3 Video and H3 Image Edit use pointer gestures for in-app Media tile drops.
Packaged desktop acceptance remains open for dragging tiles and files from a
file manager. See [verification](VERIFICATION.md#library-enhanced-preview-and-h3-references).

#### L-03 · Native model browser proposal

**Type:** ACCEPT · **Needs:** NATIVE, OWNER

The indexed Library/Studio browser is proposed for review. Windows compilation,
unit tests and mocked Chromium verification are recorded in VERIFICATION.md.
Real-library performance, native WebView interaction, Linux/WebKit acceptance and
large-library memory behavior still need maintainer/user acceptance. No model
weights are downloaded or generation started by the browser.

#### L-04 · Library and downloads backlog

**Type:** FEATURE · **Needs:** PRIORITY

- One flow per card (selection, destination, Prepare, consent and Start inside the picker); one-click single-variant download.
- Exact sizes (HEAD/Content-Length) and a free-space check in the plan.
- Per-version browsing beyond the 50-file listing cap; mark cards whose files are already local.
- Variant labels (quant suffix, size) for Hugging Face/HTTP sources; grouping exists only for CivitAI.
- [x] Resumable downloads shipped in 0.3.8: native persisted background queue (per-job percent/MB-GB statistics, Logs entries, resume of kept partials across cancel/restart, Queue view opened instead of the byte footer; `native_download_start_queue`/`native_download_resume`/`native_download_clear_queue`). Fixture-verified; live-provider large-download and Windows acceptance remain open alongside the existing L-04 acceptance needs.

#### L-05 · LoRA details edits and prompt examples (PR #42)

**Type:** ACCEPT · **Needs:** NATIVE, WIN

Shipped in 0.3.4 from PR #42 (contributor evidence: Windows build, 67 native Library tests, Chromium fixtures with mocked IPC; integration evidence in [VERIFICATION.md](VERIFICATION.md#lora-details-edits-and-prompt-examples)). `native_model_edit_lora` (trigger words in the `.deas.json` sidecar, `<file>.deas-preview.png` cover, bounded PNG validation), `LibraryLoraDetails.tsx`, Civitai `examples` (≤6 stills) in the cached metadata.

- [ ] Native Linux WebKitGTK and Windows WebView2: edit, save and clear trigger words on a LoRA without metadata and on a fetched one; **Refresh metadata** keeps the local list; Library search and Studio → LoRA details use it.
- [ ] Both platforms: **Replace preview…** through the real file chooser with PNG, JPEG, WebP and AVIF (WebKitGTK image decoding differs from Chromium); the card, the Studio LoRA picker and the Library cover show the new image without a restart; the sibling `*.preview.*` file is unchanged; moving and deleting the LoRA in Library carries the cover along.
- [ ] Both platforms: a real Civitai fetch of a LoRA whose version has prompt metadata stores the examples; thumbnails load under the app CSP (`https://*.civitai.com`), mature examples stay blurred with blurring on, and both copy buttons put the exact text on the clipboard.

### 4.8 Installer, backend and distribution

#### B-01 · Host-owned remote browser interface and DEAS API

**Type:** FEATURE · **Needs:** PRIORITY

**Host-owned remote browser interface and DEAS API. Status: planned, not implemented.** Owner request: variant 2, a browser frontend controlling the existing DEAS app running on a host, not pixel/window streaming, a separate mobile execution engine or a replacement cloud service. Android/iPhone and desktop browsers display the existing UI and send actions; generation, model access, file operations, settings, credentials and backend lifecycle remain on the host. Desktop and browser must use the same host services and job authority, not independent queues or duplicate workflow implementations. The browser necessarily renders UI and receives requested media; it does not receive arbitrary host filesystem access or provider secrets.
- Verified source entry points: `src/lib/jobs.ts::native` rejects non-Tauri job execution; `src/lib/api.ts::negotiateApi` requires desktop IPC; `src/lib/media.ts::listMedia`/`itemFromEntry` use native file operations and Tauri asset URLs; `src/lib/chat.ts` uses Tauri `Channel`/`invoke`. `src-tauri/src/jobs.rs::Jobs` holds the native job session. `src-tauri/src/api.rs` negotiates an outgoing ComfyUI connection; it is not an incoming DEAS server. Reuse these service boundaries after auditing Tauri state, window/dialog and native-player dependencies.
- Proposed transport: versioned HTTP/JSON REST under `/api/v1`, with SSE for progress/status and streamed chat, an OpenAPI contract and an Axum server in the existing Rust/Tokio process. Serve the browser UI and API from the same origin. Keep framework/endpoint details as implementation proposals until the service-boundary audit; no generic remote `/invoke`, arbitrary ComfyUI-graph execution, GraphQL, gRPC or additional Python/Node backend is required. The API also supports authorized scripts/integrations, not just the UI.
- Initial scope: optional, default-OFF remote access while the host desktop app runs; reuse the React frontend with desktop IPC or remote HTTP transport. Include capabilities/models, host media browsing, explicit job submission, current/history/results, scoped cancellation and live progress; carry Chat/Forge streaming through the same host services when exposed. Publish an explicit remote capability matrix for desktop-only actions rather than presenting dead controls. A standalone headless host, native mobile apps, PWA installation, Internet publication and full multi-user administration are deferred, not prerequisites. Host-root selection, permitted remote mutations and shared-versus-client-specific draft editing need explicit decisions before implementation; do not silently synchronize or overwrite desktop drafts.
- Acceptance:
  - [ ] Audit callers, native services, state ownership, IPC permissions, media/player paths and tests; extract only necessary shared service logic. Desktop and remote calls must preserve the existing intent validation, recipe compilation, job identity, GPU/resource scheduling, output ownership and scoped interruption. With remote mode OFF, desktop behavior, graphs, local settings and startup stay unchanged; no listener, firewall changes, unrelated service shutdown or automatic Internet exposure.
  - [ ] Define and document a versioned, bounded API and structured errors/capabilities. Job creation returns an asynchronous job handle (`202 Accepted`); support idempotent submission and truthful reconciliation after lost replies, never automatic duplicate generation. Snapshot/reconnect and bounded event delivery restore authoritative job state without resubmission; a browser disconnect must not cancel an accepted job. Enforce per-client/token job permissions so a scoped cancellation cannot become global Stop or interrupt peer work.
  - [ ] Keep host file selection on the host through an approved-root browser picker; never substitute a phone file chooser or trust a client-supplied absolute path. Serve authorized media by opaque identity, with bounded reads and video seek/range support; preserve provenance, no-clobber export and canonical containment against traversal/symlink escapes. Any explicit device upload/download is a distinct, validated transfer, not an implicit move of host processing. Use browser media playback instead of attempting to expose the host's libmpv surface. Native dialogs, reveal-in-file-manager, updates and lifecycle actions need explicit remote support or a clear unavailable reason.
  - [ ] Require authenticated, explicitly enabled access: protected browser sessions (HttpOnly cookies, appropriate SameSite policy and CSRF/Origin checks), revocable API tokens for integrations, least-privilege routes, bounded requests/uploads/connections and no secrets in URLs, responses or logs. No blanket CORS or arbitrary endpoint/path forwarding. Define HTTPS or a documented protected VPN/tunnel deployment for off-host access, credential storage/revocation and authorized roots before LAN acceptance; do not imply that LAN alone is trusted.
  - [ ] Verify real desktop + browser coexistence: shared queue/progress/results, explicit draft ownership, no lost edits, duplicate runs or peer cancellation, reload/reconnect, expired authorization and slow/disconnected clients. Add Rust service/HTTP/security tests, frontend transport/UI tests and an OpenAPI contract check; retain existing desktop regressions. Exercise Android Chrome and iPhone Safari plus desktop browsers, narrow/touch layouts, host-file selection, image/audio/video output and seeking; fixture success alone does not close physical-device or real host-job acceptance. Verify native Linux and Windows host behavior separately, and record real-model runs only with explicit GPU authorization.
  - [ ] Localize remote controls/errors in all seven locales and update global search, `docs/STUDIO.md` and API/deployment/security documentation. Record supported functions and unsupported desktop-only actions honestly; tests and documentation must distinguish current-session recovery from crash/restart persistence, which is not promised by this feature.

#### B-02 · AMD (Linux) path and hardware follow-ups

**Type:** ACCEPT + FEATURE · **Needs:** AMD, PRIORITY

**AMD (Linux) installed path landed.** RDNA2–RDNA4 (`gfx1030`, `gfx1100`–`1102`, `gfx1151`, `gfx1200`–`1201`) is detected through read-only `lspci`/amdgpu discovery (`amd.rs`, port of the reference installer's map), recommended by defaults, planned, provisioned from AMD's wheel index with the installer's proven pins (`torch[device-<gfx>]==2.13.0+rocm10.0.0`, `torchvision[device-<gfx>]==0.28.0+rocm10.0.0`, `torchaudio==2.11.0.2+rocm10.0.0` at `stable.repo.amd.com/rocm/whl-next/`), verified by gcnArchName identity plus matmul, launched with `HIP_VISIBLE_DEVICES=0`, and updated/reinstalled through the same plan machinery. Intel stays closed (no reference-installer path; torch-XPU unproven on this node stack). Caveats, to be fixed later, in order of impact:
- **No AMD hardware here: the ROCm pins are reference-installer-proven and dry-run-resolved only.** First acceptance = plan → install → verify → GGUF smoke → TVE model-upscale smoke on a real RDNA card; until then AMD is declared support, not verified support.
- Windows AMD is plan-closed with a named unsupported reason (wheel metadata resolves for Windows, runtime acceptance is missing); see [B-10](#b-10--amd-on-windows).
- A future AMD Torch update needs fresh installer-proven pins; `torch_target()` deliberately returns `None` for AMD plans so no pytorch.org profile can silently replace the ROCm one.
- llama-cpp-python installs the **Vulkan** wheel family on AMD plans (0.3.7; abetlen publishes no ROCm/HIP family, and DEAS never builds from source). Local GGUF ran fully offloaded on Radeon iGPUs through Vulkan, with 37/37 layers on RDNA2 RADV under Linux and 25/25 under the Windows AMD driver ([VERIFICATION](VERIFICATION.md#llama-cpp-python-avx-512-wheels--windows-error-0xc000001d-037)). Open: a discrete RDNA card through a real DEAS install and Prompt Forge run.
- `videoPost` RTX refine/frame-generation fail closed at admission on non-NVIDIA plans (the node pack registers `DaSiWa_RTX_*` even where nvvfx is missing, so the installed plan backend is the vendor truth). The TVE panel still offers the RTX toggles on AMD plans; wiring the installed plan's backend into `TvePostControls` (instead of node-presence evidence alone) is open.
- AMD is single-GPU only (ROCm launch pins device 0; `parse_amd_lspci` takes one display device). NVIDIA multi-GPU selection landed in 0.3.21 (#52); its open gate is acceptance on a multi-GPU host here (contributor-verified on Windows only). Unmapped gfx families fail the plan instead of borrowing RDNA3 kernels.
- AMD multi-GPU selection and free-space estimates remain open.
- Remaining §4.8 hardware follow-ups: Intel profile and preflight; AMD multi-GPU selection; free-space estimates.
  - ROCm startup rules, from research (2026-11-01, no AMD hardware here): never offer `--fast fp16_accumulation` on ROCm — PyTorch applies `CUBLAS_COMPUTE_16F` only under `#ifndef USE_ROCM`, so it is a GEMM no-op, but ComfyUI still sets `PRIORITIZE_FP16` and picks fp16 over bf16 for UNet/text encoder (black/overflowing output on Flux/Qwen-class models; ComfyUI PR #9258 enabled it for AMD untested). Keep Speed+ NVIDIA-only (`startup.rs` already does). Offer `--force-fp32`/`--bf16-unet` as the first diagnostic for GGUF noise on RDNA3 (city96/ComfyUI-GGUF #300: noise on GPU, correct on CPU, 7900 XT/XTX, root cause open) and `--disable-smart-memory` for the ROCm 7.15 / torch 2.13 weight corruption (ComfyUI #15314, black frames). ComfyUI-GGUF has no dequant-dtype switch; there is no documented "fp16 accumulation bug with GGUF on AMD" beyond these two separate facts.

#### B-03 · Installer backlog (Git, FFmpeg/attention, repair/rollback, node-pack pin, Windows settings move)

**Type:** FEATURE · **Needs:** PRIORITY

- Git bootstrap, or removal of the external Git prerequisite; full FFmpeg/attention-extension provisioning.
- Interrupted-install repair/resume; staged environment upgrade with rollback (reinstall replaces the venv, which is not rollback).
- Pin the DaSiWa node-pack ref. It is cloned from `main` with the revision recorded but not user-selected, which falls short of the explicit-updates decision.
- Settings relocation on Windows (`settings_move.rs` rejects non-Linux).

#### B-04 · Selective backend updates

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Selective backend updates: native acceptance.** Implemented in 0.1.67: Update asks Everything / DEAS app only / ComfyUI and node packs / PyTorch only (see [Studio](STUDIO.md)). Open: a real Linux run of each action (a PyTorch update needs an environment with an older profile) and Windows separately. The compatibility blockers named below need no extra gate today: owned environments cannot carry attention extensions (sage/flash/radial plans are refused), ComfyUI-GGUF is pure Python and is reinstalled under the new constraints, and TVE's ONNX runtime is a user-chosen native library outside the venv. Node packs DEAS did not install block the update. Original spec:
- **Update ComfyUI**: ComfyUI checkout, installed node packs and their Python dependencies, under the existing Torch constraints so a node-pack requirement cannot silently replace Torch. No DEAS binary download.
- **Update PyTorch**: only to a newer profile this DEAS build knows (`install_torch.rs`), never an arbitrary latest wheel. Offer it only when the new profile's hardware/driver gate passes, and block it when ComfyUI, the installed node packs or DEAS features are not known to work with it (e.g. attention/CUDA-extension pins, GGUF, the CUDA ONNX runtime used by TVE). Show the exact from → to versions before confirmation.
- Both: stop the owned backend first, block while a job runs, reuse the existing plan/consent/cancellation/log paths, persist the updated plan only after the verify step passes, and report the previous state on failure (no rollback is claimed until staged updates exist). The full **Update** stays available.
- Acceptance: fixtures for each action alone, failed verify (plan unchanged), a node-pack requirement that would change Torch, unsupported hardware for a new Torch profile, cancellation; a real Linux run of each action; Windows separately.

#### B-05 · Packed release assets

**Type:** FEATURE · **Needs:** PRIORITY

**Packed release assets (planned).** Linux `deas-linux-amd64.tar.gz`, Windows `deas-windows-amd64.7z`.
- Detect packing by magic bytes (`1f 8b` for gzip, `37 7A BC AF 27 1C` for 7z).
- Verify the archive digest and size first.
- Extract exactly one entry with the expected executable name: reject paths, dirs, symlinks and extra entries, and bound the decompressed size. Then apply the existing header and atomic-replacement checks.
- Raw assets stay accepted in both directions (old updaters with new releases and the reverse).
- Fixtures for raw, tar.gz, 7z, extra/symlink/traversal entries, decompression bomb, digest mismatch and mixed releases.

#### B-06 · Signed distribution and portability

**Type:** FEATURE · **Needs:** PRIORITY

- Signed/update-verifiable distribution, fresh-machine/Git-free setup, glibc portability and current CI readback.

#### B-07 · Windows 0.3.3 session fixes — native acceptance

**Type:** ACCEPT · **Needs:** WIN, NATIVE

Fixes shipped in 0.3.4 for findings 1–4 of the 0.3.3 Windows session, plus Triton provisioning for Windows NVIDIA, (evidence: [VERIFICATION.md](VERIFICATION.md#034--fixes-for-the-033-windows-session-findings-2026-11-19)); all four are CPU/fixture-verified only.

- [ ] Windows host: launch 0.3.4 against the untouched 0.2.34 environment `C:\Users\testacct\DEAS`; confirm **Update required** / **Update environment** instead of the technical-error toast, run the confirmed update, and check that the environment opens, the backend starts and models/inputs/outputs are unchanged.
- [ ] Windows host, before upgrading the 0.3.3 environment `C:\Users\testacct\DEAS-033\deas-environment-2`: backend start shows the single condensed KJNodes `INFO` line instead of the triton traceback; the `/object_info` node count is unchanged.
- [ ] Windows host: **Upgrade** of that environment installs `triton-windows==3.8.0.post29`, records `tritonVersion` in `deas-install.json`, the KJNodes line disappears and `PatchTritonVAE` appears in `/object_info`; then one SDXL Studio run with **torch.compile = inductor** (needs owner GPU approval; record whether MSVC build tools were needed). Before the upgrade, `inductor` must be disabled with the no-Triton reason.
- [ ] Linux NVIDIA: a fresh or upgraded environment records `tritonVersion` 3.8.0 and the verify step passes (CPU-only here so far).
- [ ] Native Linux WebKitGTK and Windows WebView2: copy a checkpoint into the models folder while DEAS runs; the Models dock shows the index-gap note next to **Reload**, and Reload clears it.
- [ ] Opportunistic: a real transient GitHub failure during first-run uv download is retried (look for `WARN: download attempt` in Logs).

#### B-08 · Issue #39 — backend "not ready" on slow `object_info` (Windows)

**Type:** ACCEPT + RESEARCH · **Needs:** WIN, OWNER

Root cause found in the reporters' 0.3.3 logs and fixed in 0.3.4: readiness succeeded, then Studio's 3 s capability poll superseded every slower `object_info` answer, so ComfyUI queued requests faster than it served them until every request timed out (evidence and RED/GREEN fixture: [VERIFICATION.md](VERIFICATION.md#issue-39--studio-capability-poll-livelock-on-slow-object_info-034)). The earlier 0.3.1 (45 s probe) and 0.3.3 (partner nodes off) changes stay; they reduced the payload but could not stop the livelock.

- [x] Reporter confirmed on 0.3.4 ("The fix did work for me"); issue #39 closed with the 0.3.9 release. Open only if a second reporter's fresh log contradicts it.
- [ ] Research: `object_info` takes 3.8–7 s for a 1.5 MB answer on the reporters' Windows machines (RTX 5070 Ti; fresh install, no linked folders) versus well under 2 s on this Linux host. Measure on the Windows test host which part dominates (model-folder listing per loader input, custom-node `INPUT_TYPES`, JSON serialization, antivirus scanning of the model folders) before changing anything; every Studio capability read, Backend → Test and recipe check pays it.

#### B-09 · Issue #43 — Windows self-update: native acceptance

**Type:** ACCEPT · **Needs:** WIN

0.3.7 replaces a running `deas.exe` by rename swap, with scan-lock retry, quarantine and tamper detection with rollback, a Controlled Folder Access diagnosis and a Restart now / Later question ([Application updates](APP-UPDATES.md)). The swap is proven on the Windows host by the library's own tests, including the live scan-lock swap ([VERIFICATION](VERIFICATION.md#issue-43--windows-self-update-037-not-native-accepted)); the GUI path is not.
- [ ] Windows host: real click-through from a 0.3.7 scratch copy to the next release (Everything with an installed environment, then App only); check the restart question, both **Restart now** and **Later**, that `deas.exe.old` disappears after the next start, and that the backend resume state survives.

#### B-10 · AMD on Windows

**Type:** FEATURE + ACCEPT · **Needs:** AMD, WIN

The owner expected Windows AMD to be supported; it is not. The plan step refuses Windows AMD with a named reason; only Linux RDNA2–RDNA4 installs (B-02).

- [ ] Plan/install: decide the Windows Torch source. Options are AMD's ROCm-on-Windows wheels from the same `whl-next` index (metadata resolves for Windows; a runtime has never been tried) or DirectML. Then map Windows Radeon detection (no `lspci`: use the display-adapter/registry or DXGI vendor `0x1002`) to the RDNA gfx targets. Keep "single GPU, no CPU fallback".
- [ ] Node requirements: llama-cpp-python already resolves to the Vulkan family for every AMD plan (0.3.7). The Windows Vulkan wheel 0.3.36 is proven on a Radeon iGPU under the AMD driver: 25/25 layers offloaded, 34 tokens/s with Qwen2.5-0.5B Q4_K_M ([VERIFICATION](VERIFICATION.md#llama-cpp-python-avx-512-wheels--windows-error-0xc000001d-037)).
- [ ] Feature gates that already fail closed on non-NVIDIA plans (RTX video refine/frame generation, TVE RTX toggles, Triton/torch.compile) must carry the same reasons on Windows AMD; attention extensions stay refused.
- [ ] Acceptance on a real Windows machine with a discrete Radeon (RDNA2+): plan → install → verify → one image and one video generation → GGUF Prompt Forge → TVE model upscale. The Windows test host only has a Radeon iGPU next to the NVIDIA card, so it cannot stand in for a single-GPU Radeon install.

#### B-11 · Agent API (/v1 plane): verification and open rulings

**Type:** ACCEPT · **Needs:** GPU, WIN, NATIVE, OWNER

Landed in 0.3.23 through [#53](https://github.com/darksidewalker/DEAS/pull/53): the opt-in loopback `/v1` plane (`src-tauri/src/agent_api/`), the **Backend → Agent API** panel, the operator files (`deas-agent-settings.json`, `deas-agent-guard.json`, `deas-agent-defaults.json`) and the guide [AGENT-API.md](AGENT-API.md). It ships OFF: no settings file means no bind, no cycle, no fence. Re-run here at the merge tree: Rust lib suite, Clippy `-D`, type check, core and interface suites, plane smoke test. What still has no evidence from this host:

- [ ] GPU: repeat the guide's battery on an approved throwaway backend — the four image families, H3 `t2v`/`i2v`/`ref2va`, one RefMod export, one one-cycle continuity film, and the VRAM handoff (`GET /v1/cycle` free/restore legs, watchdog posture). The author reports ~90 live probes; none were reproduced here.
- [ ] WIN: the operator unload/restore bats through `cmd /C` with `raw_arg` (quoted paths must survive), and the hung-leg tree kill `taskkill /T /F /PID` with its direct-`kill` fallback.
- [ ] NATIVE: the panel in the shipped Linux app — search hits reveal each control, the diff-then-confirm wall, key reveal/mask, and the refusal shown while a cycle is live.
- [ ] OWNER rulings, left open by the merge:
  - [ ] Canvas floor 8 at the native walls (was 64; the PR records an owner ruling of 2026-11-22 and a live-proven 56×56 render). Studio's own controls still floor at 64, so only direct intents and the API see 8.
  - [ ] The **Agent API** tab stays clickable without an installed environment but shows the authorization panel (`BackendPanels` coalesces every non-LLM choice to `auth` while `root` is empty), although the plane's files live in app-data. Root-independent entry, or keep as is.
  - [ ] The `bench` doors sweep whole input/output roots into `.bench/<stamp>` (rename, never delete, un-benching is an owner action). Confirm they ship in the public plane as they are.

### 4.9 Reference-project ports

These are the local reference repositories; their functionality does not count as implemented in DEAS. Each port needs an explicit owner priority, a Rust-first native boundary and its own Linux/Windows acceptance.

#### R-01 · Video comparison port

**Type:** FEATURE · **Needs:** PRIORITY

**Video comparison:** `<workspace>/DaSiWa-simple-video-compare` (Rust/Tauri/libmpv: `src-tauri/src/native.rs`, `embedded.rs`, `embedded_windows.rs`, `runtime.rs`, `desktop/src/model.ts`).
- Share the player/probe/runtime boundary with DEAS's libmpv player.
- One/two-source side-by-side, wipe, blend and difference; seek, frame-step and source audio.
- Test mismatched dimensions/fps/duration, short-source EOF and missing audio.
- Filters normalize to `yuv420p`, so this is not bit-exact HDR analysis.
- Assess GPL/libmpv/FFmpeg redistribution first.

#### R-02 · Video assembly port

**Type:** FEATURE · **Needs:** PRIORITY

**Video assembly:** `<workspace>/DaSiWa-simple-rtx-video-assambler` (`vid_tool.py`; spelling retained).
- A Rust FFmpeg plugin: ordered sources, labels, grid layouts (contain/cover/stretch), audio selection/mixing, NVENC AV1/SVT-AV1.
- Do not port its defects: the preview only computes resolution, the audio mix assumes every input has audio, the `p8`/`p9` presets are not universal, and `-y` plus timestamp names can overwrite files.
- Spatial grid and temporal montage are separate contracts.

#### R-03 · LoRA training port

**Type:** FEATURE · **Needs:** PRIORITY

**LoRA training:** `<workspace>/DaSiWa-TrainFlow` (`internal/trainer/profiles.go`, `config.go`, `defaults.go`, `musubi.go`, `manager.go`, `normalizer.go`).
- Profiles: Anima, SDXL/Pony/Illustrious, LTX 2.3, Wan 2.2, Krea 2.
- Rust owns datasets, typed config/argv, process groups, progress, cancel/resume and result indexing. Python stays the sd-scripts/Musubi engine, in an isolated environment.
- The runtime uses cu130 (not the README's CUDA 12.4); ROCm is experimental; Musubi is single-process. Replace whitespace-split extra args with typed argv.

#### R-04 · Full TVE parity

**Type:** FEATURE · **Needs:** PRIORITY

**Full TVE parity**, beyond §4.2: AI/NVIDIA restoration, RIFE/NVIDIA interpolation and SDR→HDR, each only for tested combinations. The reference stack is CUDA-specific and must not become a universal environment.

#### R-05 · Node-pack feature destinations and PromptForge port

**Type:** FEATURE · **Needs:** PRIORITY

Node-pack features and their intended DEAS destination (not yet planned in detail):

| Node-pack feature | DEAS destination |
| --- | --- |
| H3 Cache / Kitchen Attention | Opt-in inference optimization profiles |
| RTX Upscaler & Refiner | Enhancement plugin with an explicit NVIDIA SDK requirement |
| Watermark Overlay | Editor overlay |
| System Monitor | Native telemetry |
| Random String Picker | Prompt/seed services |
| Node Status Switch | Planner stage enable/bypass |
| LLM/VLM Analyze | Analysis/captioning plugin — **Media Analysis landed in 0.2.22** (taggers, Describe, frame picker; [MEDIA-ANALYSIS.md](MEDIA-ANALYSIS.md)); LoRA captioning still open |

A PromptForge port keeps per-model dialects, structured video sections, reference labels, tagger integration and review/apply. It uses DEAS's execution layer rather than its own ComfyUI queue, and licensing is verified first.

### 4.10 Plugin platform and planner

#### PL-01 · Theme authoring

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Theme authoring — remaining native acceptance.** DEAS bundles one canonical `EDIT-THEMES.html` and one `new-theme` starter; it does not duplicate the nine built-in schemes as external packs. **Quick Settings → Edit themes** now opens that editor in its own frame inside DEAS (no system browser), lists the selected environment's theme folders and reads/writes one folder through `native_theme_folders`/`native_theme_read`/`native_theme_write` (`theme.json`, `assets/…`, `backups/…` only, re-validated and atomically replaced). Open gates: confirm the framed editor actually renders and saves in the shipped Linux WebKitGTK window and Windows WebView2 build (Chromium fixture evidence does not close this), real Chrome/Edge standalone folder permission, no-clobber starter creation, theme save/refresh, duplicate ID rejection and reduced-motion/full-scheme selection. [Guide](THEME-PACKS.md).

#### PL-02 · Beginner mode

**Type:** ACCEPT · **Needs:** NATIVE, WIN, GPU

**Beginner mode (landed in 0.2.15, acceptance open).** Manual port of the `DEAS-0.2.13-Beginner-SHARE.zip` overlay (archive SHA-256 `b4adae309300e95224bf3ad5ecdf5c4d34162014b28a0d28117a23bf09c3f900`): one `interface.experience` preference, page band Generate/Models/Media, Engine button to the unchanged setup, per-mode settings isolation and model-bound Beginner LoRA draft. Deliberately not adopted: the fork's window-title rebranding, Sage as fresh-install theme fallback (the built-in Sage scheme already provides Sage), and the fork's hide-GlobalSearch choice (every control must stay reachable from Ctrl+K). Open gates:
- [ ] Native acceptance on WebKitGTK and WebView2: welcome dialog first run, mode switch during a running job keeps the job, Engine flow with no installed environment, seven locales at narrow widths.
- [ ] One real Beginner run per supported pipeline (t2i/t2v/i2v still open; i2i/inpaint ran on the Windows test PC in 0.3.16, see [verification](VERIFICATION.md#windows-webview2-acceptance-dark-wizards-ux-22b1b3-0316-2026-11-21)) on real hardware; native download of one featured guide model through the existing plan/confirm dialog.

#### PL-03 · Plugin platform and planner

**Type:** FEATURE · **Needs:** PRIORITY

`PluginManifest` holds identity/parent/text/node/include/suggest metadata; `validatePlugins` checks duplicates, missing parents and cycles. A manifest alone cannot install or run an implementation.

- [ ] Extend the smallest contract the first real new plugin needs: schema version, dependencies, capabilities/platforms, permissions, lifecycle, settings/locales, tests.
- [ ] Durable project/asset/recipe/job identities and immutable revisions before claiming restartable multi-pipeline editing.
- [ ] Shared job scheduling and scoped recovery across plugins (today: session-held jobs and serial H3 sequencing).
- [ ] Post-setup feature add/remove/update without resetting projects.
- [ ] A trusted built-in versus untrusted extension boundary before loading downloaded executable/UI plugins.
- [ ] A general editable planner (operation graph, revisions, downstream invalidation, review/pause/resume), only once real consumers need it.

### 4.11 Known defects and audits

Implementation and audit evidence for the completed portions is in [verification](VERIFICATION.md#known-defects-and-audits-0214-shipped-in-0214). Only remaining work is listed here.

#### D-01 · Video metadata: readable presentation, valid JSON and Civitai prompts

**Type:** ACCEPT · **Needs:** OWNER, NATIVE, WIN, UPSTREAM

**Video metadata: readable presentation, valid JSON and Civitai prompts. Status: DEAS side implemented in 0.2.20** (producer sanitization of `is_changed`/non-finite values, legacy `NaN` parsing, readable metadata rows, audio-stage tag mapping; checked against Civitai's published parser — see [CHANGELOG](CHANGELOG.md#0220-beta)). Remaining:
- [ ] Civitai recognizing H3 Director/Guide/BasicScheduler graphs is an upstream parser gap outside DEAS; do not fabricate executable CLIP/KSampler nodes or resource hashes to satisfy it. Re-check the hosted parser before any interoperability envelope change.
- [ ] Real upload of an exact final Original and Processed file to Civitai only with explicit publication consent; native Linux/Windows Metadata-pane rendering of the exact owner H3 REF2VA video.

#### D-02 · Video Use these settings and More actions

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Video Use these settings and More actions. Status: implemented in 0.2.20** — Use settings falls back to saved job History via exact output-path match plus native availability; More menus are owned per toolbar with Escape/focus handling (native fixture). Remaining:
- [ ] Native Linux GTK/libmpv/WebKit and Windows WebView2 click-through on the exact owner H3 video (held job, reopened history entry, browsed file; Original and Processed; raw/starred), confirming pointer/keyboard reach over native video and partial-restore messaging. No generation, upload or media mutation on open/cancel.

#### D-03 · Metadata overlay blacked out the video preview

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Metadata overlay blacked out the video preview. Status: fixed in 0.2.20** — reserved side-by-side layout keeps the native surface visible and the player mounted (fixture-verified against real libmpv frames). Remaining: [ ] paused/playing, Original/Processed, resize and repeated open/close in the shipped Linux app and on Windows WebView2.

#### D-04 · Prompt Forge reference editor YuE2 FLAC

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Prompt Forge reference editor could not load a YuE2 FLAC. Status: fixed in 0.2.20** — local Linux audio references use `NativeVideo` audio-only with real duration/crop (verified against the owner file). Remaining: [ ] native Linux WebKitGTK and Windows WebView2 check of starred/raw/input roots, spaces/Unicode names, a WAV/MP3 control and modal close/reopen.

#### D-05 · SwarmUI model folders/junctions

**Type:** ACCEPT · **Needs:** OWNER, WIN, UPSTREAM

**SwarmUI model folders/junctions — bounded implementation, remaining acceptance.** Category aliases, native metadata save/reset/readback and resolved category-target registration are implemented; Windows filesystem, actual ComfyUI Python configuration and real WebView2 persistence evidence are in [verification](VERIFICATION.md#swarmui-model-folders-and-pipeline-picker-0214-shipped-in-0214). Roots still contain category folders; a directly selected `Krea2`/category subfolder is not a mapping. No model bytes, SwarmUI settings or OS trust policies are changed.
- [ ] **Nested untrusted Windows junctions remain a backend limitation.** Native headers/sidecars are readable, but ComfyUI’s recursive traversal/mtime lookup can raise OS448 and fail the entire category list. Resolving a category root does not preserve/bypass a nested alias prefix. Keep exact backend catalog and Run gates; do not flatten model names, claim these files runnable or patch ComfyUI/security policy without separately authorized work.
- [ ] **Original reported files and interactive acceptance.** The reporter’s exact Krea2/MOSS/Z-image headers/loading forms and Windows paths are still needed for a matched reproduction and real generation check. Preserve the distinction between discovery, declared family and actual checkpoint/split loader support. Native Linux/Windows metadata-editor click-through and checkpoint-popup keyboard behavior remain separate from the completed native IPC save/restart/read/reset tests.

#### D-06 · Forge clipboard/drop

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Forge clipboard/drop — native acceptance.** Exercise real OS picture clipboard paste and native file drops in the open Forge editor on Linux WebKitGTK and Windows WebView2, including nested dialogs, ordinary text paste, image caps and errors. Component fixtures do not close this gate.

#### D-07 · Remembered settings — Linux selector

**Type:** ACCEPT · **Needs:** NATIVE

**Remembered settings — Linux selector acceptance.** Exercise checkpoint-only switches through the actual native selector: preserve positive/negative prompts exactly, including empty fields, while restoring the target's other draft settings. No key-collision defect is established. The GTK fixture rendered readable selectors but its separate warning-layout assertion failed; investigate that renderer-specific observation rather than weakening the gate.

#### D-08 · Queue/media settings reuse — native and provenance

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Queue/media settings reuse — native and provenance acceptance.** Verify queue/context/toolbar keyboard actions and OS preview drops in native Linux/Windows, including retained editor masks/layers, cancellation of replacement, exact clicked-file ownership and no generation. Matching is currently a unique held-job output path in its captured root, not a media-content digest; files replaced externally or no longer correlated with a held job cannot be claimed to carry that job's exact provenance. Persisted recent history remains an explicit separate restore path.

#### D-09 · File settings coverage

**Type:** SLICE · **Needs:** CPU, UPSTREAM

**File settings coverage.** Embedded PNG/JPEG/WebP and MP4/Matroska/WebM metadata can recover supported literal prompts/model/sampling/dimensions and partial video timing, not the complete DEAS component/options/post-processing/input intent. No full validated intent is embedded by the current saver contract. Keep partial restores explicit and missing/ambiguous models blocked. Recovered since 0.3.24 from correlated wiring: split-loader text encoder(s)/VAE, H3 Dial Rack rows, and an Upscale-alone/model-upscale post output's source generation (read from its `deas-inputs` upload). Remaining: recover additional supported component/operation fields from correlated graph wiring where unambiguous; coordinate any complete intent-embedding requirement with the actual saver API (node-pack changes require separate authorization). Do not invent an intent from node presence, a filename or a shared basename.

#### D-10 · Owner-reported incompatible-settings warning

**Type:** DEFECT · **Needs:** OWNER (samples)

**Owner-reported incompatible-settings warning — concrete samples still needed.** Reproduced fixes cover declared LoRA-family aliases, LoRAs resolved against the restored rather than previous family, lossy display metadata, stale explicit sigma schedules, explicit empty adapter lists and ambiguous exact model names. The original affected generated image and video plus their successful intents/backend capabilities have not been supplied. Capture those exact cases, compare file versus history restore under unchanged capabilities, and retain real missing-dependency/model-exact validation. Native playback/overlay and Linux/Windows round-trip acceptance remain open.

#### D-11 · Comfy view sharpness

**Type:** ACCEPT · **Needs:** NATIVE

**Comfy view sharpness — fixed in 0.2.22 for DOM widgets.** Cause reproduced in WebKitGTK: ComfyUI scales DOM widgets (prompt textareas) with `transform: scale()`, which WebKitGTK rasterizes at 1× and stretches; `comfy_bridge.js` now maps it to CSS `zoom` (identical geometry measured at 0.7–2.2×). Open: native click/typing and overlap-clipping acceptance in the shipped app.

#### D-12 · Temporal-latent tiled refine

**Type:** ACCEPT · **Needs:** GPU

**Temporal-latent tiled refine — real-model acceptance.** Direct native intents and the TS preview now reject tiled refine through the existing family flag; frontend/history gates remain. Still run one real Anima case with the gate and one unchanged tiled SDXL case. No checkpoint/diffusion weights are present in the inspected owned environment's standard model folders. Optional spatial-at-T=1 support is separate node-pack work and needs explicit authorization plus a declared compatible prerequisite before removing the gate.

#### D-13 · Saver compatibility exception — platform/lifecycle limits

**Type:** ACCEPT · **Needs:** WIN

**Saver compatibility exception — platform/lifecycle limits.** The owned-backend adapter still installs process-wide method wrappers after a marked submission; unmarked saves retain standalone behavior, and no safe public per-job teardown hook has been established. Failure rollback, saver capability checks, idempotence and actual Linux CPU savers are tested. Remaining: Windows native publication/failure acceptance (configured test host is currently unreachable: SSH `No route to host`) and broader coexistence with third-party wrappers; retain the narrow DEAS opt-in and do not extend this exception to unrelated backends.

#### D-14 · Windows output publication fix

**Type:** ACCEPT · **Needs:** WIN, OWNER

The DEAS naming adapter has tested Windows no-overwrite rename publication and
multi-file rollback. Real exFAT generation after an owned-backend restart remains
user acceptance; no live generation is started during implementation.

#### D-15 · Canvas law: the family grid as the wall

**Type:** SLICE · **Needs:** GPU

0.3.23 ([#53](https://github.com/darksidewalker/DEAS/pull/53)) lowered the generic native canvas floor from 64 to 8 (`jobs::CANVAS_MIN`). That part is right: 8 is one latent-grid cell (`VAEEncode`/`EmptyLatentImage` divide by 8), while 64 was SDXL's number wearing a generic costume — an 8-grid family like sd15 renders 56×56 fine. The wall is still half-open on the other side, though: for pictures it checks only `%8`, `8..=8192` and the 16.7 M product, while `src/families/builtin.json` already carries each family's real canvas grid in `multiple` — 8 (sd15, pixart, hunyuan-dit), 16 (anima, moss-image and 21 more), 32 (minimax-h3, ltx-2), 64 (sdxl). Natively that grid is enforced only for MOSS-Image (`model_families::image_multiple`), and the agent door enforces it for video families only (`fill_plane::video_grid`). So an anima picture at 24×24 now passes the wall although anima's grid is 16 — precisely the "ComfyUI silently pads/rounds it" class the project rules close. The old 64 wall caught that case by accident while refusing valid smaller grids.
- [x] Picture canvas floor and alignment became `max(8, family.multiple)` / `% family.multiple` at both walls from family data — no per-family numbers in code. `model_families::canvas_grid` reads `multiple` from the bundled plugin (explicit family id only: families share CLIP types whose grids differ, so an unknown or grid-less family answers `jobs::LATENT_GRID` = 8 and the generic law stays the whole law). `jobs::canvas_fields` names the eight values that become a canvas (the latent pair, `refine.width/height`, `inputResize.width/height`, `inpaintCrop.targetWidth/targetHeight`) and `jobs::family_grid_refusal` is the single refusal home; `compile` walks it after the generic numeric table, and the door mirrors it in `agent_api/fill_plane.rs` (`check_image_canvas` for the dial pair, `check_family_grid` last inside `check_pairing_laws`, so the generic stock laws keep their own reason words and the family grid answers only what they cannot see). Proven on both walls per grid class in `agent_api::intent_truth_settings::p2_the_image_family_grid_law_refuses_both_walls_per_family` (anima /16, sdxl /64, sd15 /8 admitted) and `jobs::tests::the_family_grid_refuses_an_off_grid_canvas_and_names_the_family_grid` (canvas, refine, inputResize, inpaintCrop; an unnamed family stays at the 8-cell floor).
- [x] Studio enforces the chosen family's grid (`Workbench::requiredCanvasGrid` = `family.multiple`, Director multi-reference stays 32, unknown family stays 8) and `src/lib/resolution.ts::validCanvas` now carries the latent floor 8 instead of 64, so the UI wall and the native wall agree; a refused direct intent names the family grid (`"Invalid width 24: anima pictures sit on a 16-pixel canvas grid…"`). Visible consequence, deliberately taken: a historical or hand-typed SDXL canvas that is not a 64-multiple (a 1000² square) is now refused instead of being padded inside the model — two Studio tests that asserted the padded acceptance were re-pointed to on-grid canvases (1088²) while keeping their actual subject (exact value survives history apply and the Forge handoff).
- [x] Auto Refine's `crop_target` no longer floors at a hardcoded 64: the floor is one cell of the family grid (`grid` is the family's `multiple`, never below the latent floor), which is also what the `lib/resolution.ts::canvasSize` mirror it names has always done — the 64 was SDXL's number wearing a generic number again, and it moved a legal 8-grid/16-grid target (a 256:1 crop wanting 32) to 64. The 8192 edge and 16.7 M ceilings stay, and the target is re-measured by `jobs::compile` (canvas + family grid) when the pass queues, so a degenerate crop cannot reach the backend. `lib/resolution.ts::scaleInput` lost the same hardcoded 64 floor (it now floors at the model grid), and `lib/execution.ts` — the browser-side intent wall — carries the same law as the native one: floor 8 for the canvas, `refine`, `inputResize` and `inpaintCrop` targets, each measured against the family grid from the family plugin (`tests/execution.test.ts`: anima 24×24 and 1000×1024 refused, 512×768 admitted; sd15 56×56 admitted; sdxl 1000² refused; refine and inpaintCrop targets refused; a family-less intent keeps the 8-cell law).
- [ ] GPU (one approved session, one canvas per grid class — an 8-grid, a 16-grid, sdxl): the smallest admitted canvas renders with no internal padding or rounding.

### 4.12 Audio enhance across audio pipelines

#### A-01 · Automatic audio-enhanced output naming

**Type:** ACCEPT · **Needs:** NATIVE, WIN

**Automatic audio-enhanced output naming. Status: implemented in 0.2.20** — `jobs_audio_post.rs` publishes `<source-stem>-audio-enhanced.<ext>` with readable collision counters (UUIDs only for hidden staging); History carries the final name. Existing UUID-named outputs are not renamed. Remaining:
- [ ] Real FFmpeg post-stage on Linux and Windows verifying the readable name through history/preview/Star, including custom templates, Unicode/long names and an occupied target.

#### A-02 · Audio model/engine Install freeze

**Type:** DEFECT · **Needs:** NATIVE, WIN, OWNER

**Audio model/engine Install: progress feedback implemented in 0.2.20; native freeze reproduction remains open.** Owner reports that clicking **Install** for audio models freezes the UX or shows no visible progress. Code reading established: the native installer runs on the async runtime with `spawn_blocking` around CLI work, status reads are lightweight, and `window.confirm` is used in several other shipped flows without reports — no code-level cause for a whole-UI freeze was found, so the unresponsiveness symptom stays unreproduced and owner-side native reproduction remains the gate. The missing-feedback symptom is fixed: a `packages` stage now precedes the hash-locked package install, the panel names each stage in the seven locales, and stages without byte totals render "may take several minutes" instead of a stalled `0 / — bytes`; the DeepFilterNet version check moved off the async workers.
- [ ] Reproduce the exact button/engine on Linux WebKitGTK and Windows WebView2; distinguish the modal consent step, blocked webview/native event loop, slow preparation/download/package installation, and stalled status observation using correlated central Logs. No guessed cause or fabricated percentage.
- [ ] Real-install acceptance of progress, cancellation and failure on both platforms (ignored `audio_real_install_deep_stems_cpu`); prove actual native responsiveness/progress separately from mocked timers. Windows test host currently unreachable.

#### A-03 · Audio enhancement for Studio post-processing and TVE

**Type:** ACCEPT · **Needs:** GPU, OWNER, WIN

**Audio enhancement for Studio post-processing and TVE (0.2.15, shipped in 0.2.17).** Clean processing, paired baseline/processed publication and native automatic post-generation chaining exist; the user selected Smule Labs Windowed RoFormer instead of Demucs for Stems. Deep uses native DeepFilterNet. All modes are opt-in OFF initially, content-aware alternatives rather than a quality ladder. See [Audio enhancement](AUDIO-ENHANCEMENT.md).
- Native automatic chaining retains immutable `audioEnhance: {mode, profile}` in music/video/TVE intents and watches backend completion independently of mounted frontend panes. Jobs remain running until post-processing settles. Local cancellation does not interrupt the backend after generation; silent video is a true no-op. Baselines and valid partial products remain accessible after failure/cancellation. Real-FFmpeg lifecycle checks are explicit ignored acceptance tests, separate from default dependency-free unit gates.
- TVE supports audio-only processing from its retained inspected source without backend/video stages and automatically chained audio after selected video enhancements. Explicit new-copy export remains available on terminal selected products. Native source identity, stream mapping, sample-rate/channel/duration checks, no-clobber publication and central Logs apply to both paths.
- **Stems selection:** [Smule Labs Windowed RoFormer](https://github.com/smulelabs/windowed-roformer), original HF revision `d9642ed592120dca935ebb783c77f2faa1e6c32b`, MIT code and checkpoint grant. This is vocal/instrumental separation, not four-stem drums/bass/other extraction. Demucs is not the selected shipping backend. No automatic music-to-speech-model routing or silent weaker-mode substitution.
- Smule optional installation and actual CPU inference are exercised with pinned upstream sources/checkpoint, hash-locked isolated dependencies, explicit consent and an inference readiness check. Rust performs overlapping 8-second windows at 4-second stride, exact-length complementary assembly and instrumental subtraction. The upstream CLI is unmodified. The initial CPU path reloads the model per window and needs a compatible C++ compiler.
- Stems device selection `auto | cpu | cuda` landed with read-only reuse of the owned environment's CUDA Torch, an ABI-checked binding published only after a real CUDA inference window, and RAM/VRAM admission that releases only owned queue-idle backend caches (re-measured, never trusted from the ack). A shared compute gate serializes admissions with backend submissions.
- [ ] Real end-to-end CUDA inference acceptance (`gpu_provision_repair_real`, `smule_real_short_cuda` ignored tests) on an idle GPU: on the current host the GPU is held by an unrelated live LLM engine and the owned backend was not running, so the binding remains unpublished and the UI truthfully CPU-only until this runs.
- [ ] Perceptual Deep/Smule quality and A/V-sync acceptance on representative generated speech/music and real TVE clips. Current real model/codec tests establish execution, exact sample lengths, unchanged video packets and source/no-clobber/cancel behavior, not subjective enhancement quality. Smule CPU tests measured roughly 73 s for 1 s input and 115 s for 9 s input on a 7800X3D; GPU speed remains unmeasured until the acceptance above runs.
- [ ] Actual Windows runtime/installer/playback acceptance; configured test host is currently unreachable (SSH timeout). Cross-target compilation is not execution evidence.
- [ ] A separate ComfyUI graph node, only if separately authorized in its owning project; preserve standalone consumers.
