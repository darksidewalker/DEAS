# Development, architecture and verification

[Documentation index](README.md) · [Plan](PLAN.md)

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

Before initializing GTK/WebKit on Linux, DEAS keeps WebKit's GPU renderer usable on NVIDIA Wayland (`__NV_DISABLE_EXPLICIT_SYNC=1`) and tries Wayland, then X11. No launcher or environment variable is required. Explicit `__NV_DISABLE_EXPLICIT_SYNC`, `WEBKIT_DISABLE_DMABUF_RENDERER` and `GDK_BACKEND` overrides are preserved, so users can fall back to CPU rendering (`WEBKIT_DISABLE_DMABUF_RENDERER=1`) or select a specific display backend. These defaults affect only DEAS and its children, not desktop/system settings. Linux video plays through embedded libmpv, loaded at runtime (`libmpv.so.2`, override with `DEAS_LIBMPV`), so libmpv is a Linux runtime requirement. Audio still plays in WebKit, which aborts the page on media when the host lacks the GStreamer `good` plugins; DEAS compiles in the ones it needs and enables only those the host does not provide ([details](../src-tauri/gstreamer/README.md)).

It embeds the frontend and does not require a Vite server. It still requires compatible Linux system/webview libraries; this is not yet a signed portable AiO release. See [verification and limitations](VERIFICATION.md).

For a publishable release folder, commit the reviewed sources first, then run `./build-linux.sh --release` from a clean checkout. The version destination must not already exist; existing release assets are preserved instead of being mixed into a new build. The manifest lists only targets built in that invocation. This command bundles deb/AppImage (when `patchelf` is installed), cross-builds the Windows `deas.exe` with `cargo xwin` when installed, and stages everything under `artifacts/releases/v<version>/` with a generated `BUILD-MANIFEST.json` (including the binary's glibc floor) and `SHA256SUMS`. NSIS and portable Windows bundles need Windows tooling and come from `build-windows.cmd --release`. `build-windows.cmd --release` stages a fresh Windows-only version folder and refuses an existing destination; complete provenance and publish notes separately before publishing.

Browser acceptance checks can be repeated with a Python environment containing Playwright and Pillow:

```sh
python tools/verify_api.py
python tools/verify_recipe_prerequisites.py http://127.0.0.1:1420
python tools/verify_automatic.py http://127.0.0.1:1420
python tools/verify_jobs.py http://127.0.0.1:1420
python tools/verify_downloads.py http://127.0.0.1:1420
python tools/verify_languages.py http://127.0.0.1:1420
```


## Cross-platform paths

See [Windows/Linux path compatibility](PATH-COMPATIBILITY.md) for native paths versus exact ComfyUI identifiers, `CARGO_TARGET_DIR`, portable script arguments and Linux-only diagnostic exceptions.

## Architecture

- **React/TypeScript:** neural studio, local authoring state and feature manifests.
- **Rust/Tauri:** desktop integration, narrow native commands and native provisioning.
- **Go installer source:** read-only reference for the Rust port; no external installer process.
- **ComfyUI + DaSiWa nodes:** model execution and media processing.

Feature discovery does not guarantee a workflow is ready: recipe prerequisite discovery (nodes, models, loaders) is implemented, but GPU execution and model compatibility are separate acceptance checks. Built-in manifests are trusted code, not a sandbox for downloaded plugins.


## Execution-only backend

DEAS owns every feature selection, input/settings control, media reference, job view and output playback/export. ComfyUI receives dynamically compiled API-format jobs and executes them; internal computational nodes do not define or supply the studio UX. This remains the Studio contract. The separate **Comfy** tab is an explicit exception: it embeds the original ComfyUI frontend, including installed custom-node extensions, without translating its controls into DEAS features. A verified SDK/API adapter is preferred, with explicit endpoint binding and no automatic cloud fallback. See [execution contract and API roadmap](EXECUTION-CONTRACT.md).

### API discovery and diagnostic compilation

The Engine panel offers a separate read-only execution-API check. It probes the documented v2 proxy health and protected job listing; Classic queue inspection is selected only when the optional v2 health route returns 404. Authentication, redirects, malformed responses and incompatible contracts remain visible failures. Browser preview fails closed for this native-owned operation. A pure versioned diagnostic checkpoint text-to-image compiler validates explicit intent and supplied verified node/model/sampler/scheduler lists, then builds a deterministic immutable API graph. The Engine panel offers an explicit native prerequisite check and compile preview using the core `object_info` API. Exact observed checkpoint/sampler/scheduler choices feed DEAS-owned diagnostic controls; missing nodes/models block compilation, and changing the endpoint discards stale evidence. Defaults are 512×512, 20 steps, CFG 7 and seed 0. This is not a Director/video recipe or checkpoint-architecture guarantee. This diagnostic panel is narrower than Generate’s implemented image/video recipes; broad adapter/model acceptance remains unfinished.

### Diagnostic jobs and PNG outputs

- **Submission:** native intent validation, immutable plan preparation, separate unchecked consent and one-shot classic submission.
- **Tracking:** prompt/client/graph-correlated history and queue status, plus explicit current-session recovery after navigation.
- **Preview:** explicit native PNG retrieval, bounded CRC-checked decoding and a local Blob preview.
- **Export:** Save As writes the exact cached original with SHA-256; Linux refuses existing files and unsafe/symlink parents. Cancelling is not success.
- **Safety:** no global interruption or silent retry of uncertain submissions.

Studio jobs have scoped cancellation (see [native IPC](../src-tauri/README.md)); this diagnostic panel keeps its own one-shot flow. Broad model/native-webview acceptance remains open; individual real runs are recorded in the verification journal.

![Diagnostic job preview — test fixture, not model-generated](../assets/deas-jobs-fixture-1440.png)


## Safety

Development does not install models, alter existing ComfyUI environments or stop running user services. Managed setup/updates require explicit plan authorization and must preserve projects, models and media. DEAS must only manage backend processes it owns.


## Local development notes

- Running the Vitest suites through the rtk wrapper writes its JSON report late; call `./node_modules/.bin/vitest run --reporter=dot` directly.
- On KDE Wayland, XTest fake input is ignored, so native click-through cannot be automated there; native evidence on that host is limited to screenshots of a separately launched instance.
- Browser suites need an owned Vite server on an explicit free port and a Python environment with Playwright (`tools/verify_*.py`).
- `artifacts/deas-linux-amd64` is replaced atomically by `./build-linux.sh`; a running app keeps the old inode, so quit and relaunch to test a rebuild.
- `backend_tests.rs::invalid_owned_api_never_marks_running` was recorded (0.1.10) as failing on the owner's host independently of changes; recheck before treating it as a regression.

## Contributor contracts

Read [project rules](PROJECT-RULES.md), [ComfyUI rules](COMFYUI-RULES.md), [the plan](PLAN.md), [changelog](CHANGELOG.md) and [credits](CREDITS.md). Native changes need Cargo tests/fmt/strict Clippy/build alongside frontend gates. Browser fixtures are not native acceptance; costly model runs require explicit scope and must never restart user services.
