# DEAS — Dark Engine AI Studio

DEAS is a Rust/Tauri desktop studio for ComfyUI and DaSiWa tools. Setup is a tab strip — AiO installer, Provider authorization, Library, Settings — with a persistent install review panel. The studio preview shows a workspace map of connected feature blobs; selecting a blob opens its controls within the page.

## Desktop preview

![Setup tab strip with the install review panel — browser fixture](assets/deas-automatic-fixture-1440.png)

## Setup path

Setup is one automatic path. A top tab strip carries the Installer tab (pulsing green until the install succeeds, then a done check; it stays clickable to re-run), Provider authorization, Library and Settings. The Installer tab shows the hardware findings, and a sticky **Review & edit installation** panel on the right holds the storage folder, the Director package (checked by default; Forge · RefMods · Continuity · Output are included parts, not separate choices), a dense plan summary with the step chain, collapsed native warnings and the single green **Start install** authorization. Backend, optional packages, the ComfyUI Git ref and an existing-backend address live under Advanced options. The native plan re-prepares automatically after every edit; any edit invalidates the prepared plan, and choices lock during execution. Managed setup defaults to a new `deas-environment` directly beside the running executable, selects a compatible NVIDIA profile or an explained conservative CPU recommendation, and leaves optional packages/extensions off. The native Linux x86_64 baseline installs ComfyUI directly. Full new CPU and NVIDIA installations, framework computation, owned backend start, real API readiness and stop are verified on Linux. AMD/Intel and optional Sage/Radial/Flash/FFmpeg currently block execution explicitly; there is no simulated success.

Shared `NeuralBlob`, `NeuralPath`, `NeuralGraph` and reusable `NeuralIncludedFeatures` components serve both setup and studio features. Roads offer light, moving cat paws and off modes, with reduced-motion support. See [primitive ownership and references](docs/NEURAL-PRIMITIVES.md).

![Install-to-studio handoff with the owned backend running — browser fixture](assets/deas-studio-handoff-fixture-1440.png)

## Studio preview

A successful approved installation opens the studio automatically with **Video**, **Image** and **Workspace map** tabs. The media library loads images and videos via drop or native folder browsing, previews them in browser tabs, and lists exported job outputs. The workspace map shows the Engine, Director and plugin blobs with selectable road animation (Light · Paws · Off). Diagnostic jobs, read-only API checks and the media library are live; inference and editing controls arrive in separate steps.

![Media library with a loaded preview — browser fixture](assets/deas-media-start-1440.png)

## All-in-one vision — early alpha

DEAS aims to bring backend setup, resource downloads, model-aware prompting, image/video generation and editing, enhancement, training, comparison and media organization into one Rust/Tauri studio. An editable media planner should connect these operations end to end. Every feature belongs to a plugin family, and optional features must remain installable from the UX after initial setup.

Most of this is not implemented. The [plugin roadmap](docs/PLUGIN-ROADMAP.md) maps TrainFlow, TrueVideoEnhancer, DaSiWa Nodes, PromptForge and simple-video-compare into the new architecture; it is a development/collaboration plan, not a feature-completeness claim.

## Current development stage

Current alpha: **0.1.8** — automatic setup with tab-strip review, installation-to-studio handoff, diagnostic classic jobs with PNG preview/export, the categorised Library with CivitAI browsing, per-environment folder settings and verified no-clobber folder relocation. Windows support is compiled and CI-built, not runtime-verified. Transport, media and filesystem tests use fixtures; actual model generation and native-webview media acceptance remain unverified.

The first milestone builds the desktop shell, interactive studio, trusted built-in feature registry and read-only ComfyUI discovery. This is **not yet the completed AiO installer or a generation-ready Director replacement**. Unavailable execution functions are identified in the interface rather than simulated.

The intended AiO product ports capabilities from the [DaSiWa ComfyUI Installer](https://github.com/darksidewalker/dasiwa-comfyui-installer) into DEAS's native Rust engine. It does not bundle or launch an external Go installer. ComfyUI is the baseline; Director is one explicitly selected package including Prompt Forge, RefMods, Continuity and Output — shown as a muted subline under the Director checkbox, not as separate optional choices. Successful approved installation opens the studio automatically; installed components need no additional enable action. Starting the owned backend remains explicit. Once native status reports it running, the studio automatically uses its exact endpoint without an extra connection step or automatic inspection/generation. Suggested/Detected are translated badges only, without recommendation connection lines. Hardware recommendations remain editable and do not authorize installation; the final Start install action does. UX languages are data-only plugins with decentralized per-module text resources. Python/PyTorch continue to execute workflows; driver compatibility and model licenses remain explicit prerequisites.

## Execution-only backend

DEAS owns every feature selection, input/settings control, media reference, job view and output playback/export. ComfyUI receives dynamically compiled API-format jobs and executes them; internal computational nodes do not define or supply the studio UX. No embedded node editor or custom-node frontend is used. A verified SDK/API adapter is preferred, with explicit endpoint binding and no automatic cloud fallback. See [execution contract and API roadmap](docs/EXECUTION-CONTRACT.md).

### API discovery and diagnostic compilation

The Engine panel offers a separate read-only execution-API check. It probes the documented v2 proxy health and protected job listing; Classic queue inspection is selected only when the optional v2 health route returns 404. Authentication, redirects, malformed responses and incompatible contracts remain visible failures. Browser preview fails closed for this native-owned operation. A pure versioned diagnostic checkpoint text-to-image compiler validates explicit intent and supplied verified node/model/sampler/scheduler lists, then builds a deterministic immutable API graph. The Engine panel offers an explicit native prerequisite check and compile preview using the core `object_info` API. Exact observed checkpoint/sampler/scheduler choices feed DEAS-owned diagnostic controls; missing nodes/models block compilation, and changing the endpoint discards stale evidence. Defaults are 512×512, 20 steps, CFG 7 and seed 0. This is not a Director/video recipe or checkpoint-architecture guarantee. Dynamic Director recipes and real model-generation acceptance remain unfinished.

### Diagnostic jobs and PNG outputs

- **Submission:** native intent validation, immutable plan preparation, separate unchecked consent and one-shot classic submission.
- **Tracking:** prompt/client/graph-correlated history and queue status, plus explicit current-session recovery after navigation.
- **Preview:** explicit native PNG retrieval, bounded CRC-checked decoding and a local Blob preview.
- **Export:** Save As writes the exact cached original with SHA-256; Linux refuses existing files and unsafe/symlink parents. Cancelling is not success.
- **Safety:** no global interruption or silent retry of uncertain submissions.

Safe cancellation, actual model-generation acceptance and native-webview media acceptance remain open.

![Diagnostic job preview — test fixture, not model-generated](assets/deas-jobs-fixture-1440.png)

## Library, downloads and provider authorization

Provider authorization and the Library are setup tabs; optional downloads are also reachable from the studio plugin area, independently of baseline installation. A strict native TOML catalog feeds the UI; add resources/providers in `src-tauri/downloads/default.toml` or explicitly import an additive catalog for the current session. Browse HF users/model/dataset repositories, CivitAI creators/models, GitHub accounts/repository files, configured HTTPS direct/index sources or an explicitly configured loopback Ollama tags endpoint. Repository listings lead to explicit repository browsing; Ollama tags never imply a pull or downloadable file.

Provider tokens are optional and origin-bound. Session memory is default; OS-store persistence/restoration is explicit and never falls back to plaintext. Downloads use their own immutable plan, native parent-folder selection, a new destination subfolder and separate unchecked consent. Staged files are inert data, not installed models or executed workflows. Linux scratch HTTP transfers and UI/IPC fixtures are tested; live authenticated providers, real OS-store operation, large-download resume and Windows writes remain unverified/unsupported. See [catalog examples, contracts and limits](docs/DOWNLOAD-PLUGINS.md).

![Provider authorization tab — browser fixture](assets/deas-downloads-fixture-1440.png)

The Library sorts catalog cards and loaded file rows by version publication date (newest first), or by name (A–Z). Undated entries come last. Bundled dates are a catalog snapshot; live CivitAI user/search requests ask for newest results. Name sorting covers loaded results, not unseen pages. CivitAI browsing defaults to **SFW only**; switching to **+NSFW (18+)** requires an explicit age confirmation, and a base-model filter narrows model lists. The 18+ badge reflects the provider's model classification, not the preview image rating. Opening a CivitAI model lists individual files across its versions (up to 50); quantizations are selected explicitly, never downloaded together automatically. Conflicting destination filenames block the plan instead of overwriting files.

## Folder selection and relocation

Native folder selection resolves symlink aliases to their real existing directories before planning; installation execution still refuses symlink substitutions. The first installation review offers optional existing models, input and output folders. They remain an in-memory draft until Start install authorizes the immutable plan; no folder settings or data are written by selection alone.

Relocation currently supports Linux; other platforms reject movement without changing files. After installation, the Settings tab separates saving paths from the explicitly selected **Move files & save folders** action. Moving checks all changed trees for conflicting filenames before copying; it never overwrites a destination file. Close other applications using these folders, stop the owned backend and finish downloads first. Copies are verified before settings are switched and originals removed. Errors preserve original data; cleanup warnings identify retained duplicates. Symlinks inside relocated trees and overlapping trees are rejected rather than followed.

## Language plugins

German, English, Turkish, French, Simplified Chinese and Japanese menus/texts live in decentralized module-owned `locales/*.json` files. Data-only manifests under `src/languages/<id>/manifest.json` register bundled UX languages. Switching language preserves IDs and choices; key parity and source-reference checks run in tests. Raw technical logs/errors remain original. See [localization contract](docs/LOCALIZATION.md).

## Native installer coverage

Rust directly implements verified uv bootstrap, managed Python, isolated venv, ComfyUI reference checkout, pinned CPU/NVIDIA Torch selection and required runtime checks. Selected DaSiWa capabilities share one nodepack dependency, fetched only when needed; selecting a capability does not yet implement its studio UI or install model weights. Plans fix hardware and framework identities and require separate confirmation. Targets must be absent, with an existing nonsymlink parent. Existing environments are never wiped or changed.

Successful native provisioning in the current app session authorizes a separate explicit owned-backend start. Lifecycle commands verify exact child/listener ownership and real bounded ComfyUI API responses, expose status/logs and stop only the owned process group. They do not adopt arbitrary existing targets or imply generation readiness. Linux local-process/HTTP fixtures and full newly installed CPU/NVIDIA ComfyUI stacks are verified, including an RTX 5090 CUDA computation and owned service launch.

Read [the port ledger](docs/INSTALLER-INTEGRATION.md) and [native IPC details](src-tauri/README.md) for unsupported options and verification limits. Node requirements explicitly resolve NVIDIA VFX wheels and select backend-specific llama-cpp-python binary wheels, following the reference installer; unavailable wheels fail without a source build or silent CPU fallback. Complete selected nodepack installation, required Director/Continuity registration and owned API lifecycle are verified on the RTX 5090; model generation and every included feature recipe remain separate acceptance work. Full Go-installer parity is unfinished.

## Development

Requires Node/npm, Rust/Cargo and Tauri's platform build dependencies. On Linux the desktop runtime uses WebKitGTK, so browser tests alone do not prove native media support.

```sh
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

Desktop development and packaging:

```sh
npm run tauri dev
npm run tauri build
```

The frontend development server uses port 1420. Engine discovery is an explicit read-only action; the initial local endpoint is `http://127.0.0.1:7801`. Connect to a compatible ComfyUI API, not an authenticated HTML login page. Browser mode may require backend CORS configuration; the native shell uses bounded Rust HTTP requests.

## Local Linux executable

The locally built executable is `artifacts/deas-linux-amd64`. Launch it directly:

```sh
./artifacts/deas-linux-amd64
```

Before initializing GTK/WebKit on Linux, DEAS defaults to the compatible non-DMA-BUF renderer and tries Wayland, then X11. No launcher or environment variable is required. Explicit `WEBKIT_DISABLE_DMABUF_RENDERER` and `GDK_BACKEND` overrides are preserved, so users can opt back into DMA-BUF (`0`) or select a specific display backend. These defaults affect only DEAS and its children, not desktop/system settings.

It embeds the frontend and does not require a Vite server. It still requires compatible Linux system/webview libraries; this is not yet a signed portable AiO release. See [verification and limitations](docs/VERIFICATION.md).

Browser acceptance checks can be repeated with a Python environment containing Playwright and Pillow:

```sh
python tools/verify_api.py
python tools/verify_recipe_prerequisites.py http://127.0.0.1:1420
python tools/verify_automatic.py http://127.0.0.1:1420
python tools/verify_jobs.py http://127.0.0.1:1420
python tools/verify_downloads.py http://127.0.0.1:1420
python tools/verify_languages.py http://127.0.0.1:1420
```

## Architecture

- **React/TypeScript:** neural studio, local authoring state and feature manifests.
- **Rust/Tauri:** desktop integration, narrow native commands and native provisioning.
- **Go installer source:** read-only reference for the Rust port; no external installer process.
- **ComfyUI + DaSiWa nodes:** model execution and media processing.

Feature discovery does not guarantee a workflow is ready: model presence, GPU execution and complete recipe validation are separate future checks. Built-in manifests are trusted code, not a sandbox for downloaded plugins.

## Safety

Development does not install models, alter existing ComfyUI environments or stop running user services. Full managed setup and updates will require an explicit plan and preserve projects, models and media. DEAS must only manage backend processes it owns.

## Plan

See [the milestone plan and acceptance checklist](docs/PLAN.md). Verified outcomes and explicit limitations are recorded in `docs/VERIFICATION.md`. Per-version changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Repository

Source and collaboration: https://github.com/darksidewalker/DEAS
