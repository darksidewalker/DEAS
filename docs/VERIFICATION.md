# DEAS verification — native baseline, optional capabilities and languages

## Final six-language acceptance

All six bundled languages have 344 translated keys each, spread across five module-owned dictionaries. Four new manifests retain native names: Türkçe, Français, 中文 and 日本語. Selector options derive suffixes from ISO 639-1 IDs; Deutsch/English also show `(de)`/`(en)`. Chinese uses Simplified Chinese under `zh`. Core tests independently validate exact key and interpolation-placeholder parity, nonempty strings and manifest identities.

Final gates passed: **47 core tests, 94 UI/IPC tests, 85 Rust tests (five ignored)**, typecheck, production build, Clippy with warnings denied, formatting and native release build. `tools/verify_languages.py` passed all six languages at 1440/1024/768/390/320px: selected setup values survive switching, locale persists after reload, optional-plugin browser-only controls are translated, no horizontal overflow/runtime errors or external requests. `tools/verify_downloads.py` passed both browser and native-IPC-fixture modes again at all five widths. Native render capture with Vite stopped shows the rebuilt app and `English (en)`, without blank/error UI. CJK 320px captures were visually inspected: readable native glyphs, no tofu boxes or clipping. These are generated translations; native-speaker review remains desirable.

The local executable was atomically replaced without stopping the user's already running older binary. Only the separate exact-PID capture instance was terminated. Native initial rendering is not full interactive native download/auth acceptance; no provider credentials or model installs were used.

## Download/auth plugin acceptance

Native module/state/command registration and local-main-window permissions are integrated. The independently rerun native suite passed **85 tests with five explicit-live/network/dialog tests ignored**; Clippy `--all-targets -D warnings` and formatting passed. The native additions include origin-scoped session/vault behavior with an injected test store, strict additive catalogs, official-adapter response-shape fixtures, actual tiny HTTP transfers and output bytes/manifests, checksum/size failure, stalled-stream cancellation and redirect credential stripping. No real user keyring or authenticated live provider was accessed.

Descriptor-based writes reject symlink components and clobbering. Before staging creation, the final parent must belong to the effective user and must not be group/world writable; sticky directories are deliberately rejected too. Opened staging children must be effective-user-owned directories without group/world access. Deterministic substitution/permission tests fail before file writes. This is not a same-user adversary sandbox. Platform-independent tests remain enabled outside Linux; Linux execution/Unix helpers are gated. Windows cross-compilation was blocked by missing `x86_64-w64-mingw32-gcc` while building `ring`, so no Windows compilation success is claimed.

The UI is available from setup and the studio plugin area. Explicit catalog import, repository drill-in, browse pagination, new-parent/child selection, immutable plan disclosure, separate unchecked consent, actual status/cancellation and metadata-only auth refresh/restore are implemented. Frontend gates passed **47 core and 94 UI/IPC tests** before the additional-language work. `tools/verify_downloads.py` passed browser fail-closed and native-IPC-fixture paths at 1440/1024/768/390/320px; fixture success does not mean a real native transfer happened in that browser. The five earlier browser suites also passed at all five widths. Screenshots `assets/deas-downloads-fixture-{1440,320}.png` are explicitly fixtures.

Downloads are inert staged files, not installed models or executable workflows. Custom auth exists natively but is not exposed in current UI. Live providers/auth, real OS-store operation, full install placement, large-download resume, revision pinning/LFS expansion and non-Linux filesystem execution remain open. Already published completed files remain if a later file fails/cancels; there is no transactional batch rollback.

## API negotiation and recipe compiler continuation

The continuation gates passed: 47 core tests, 80 UI/IPC tests and 55 Rust tests (five explicit-live/network/dialog tests ignored), TypeScript check, production frontend build, Cargo clippy/fmt and release build. The four existing browser suites and `tools/verify_api.py` passed at 1440/1024/768/390/320px. New panel checks cover explicit action, no browser backend requests, honest desktop-only failure, endpoint evidence invalidation and DE/EN labels. Frontend success/error tests use mocked IPC; native negotiation uses real local HTTP fixtures, not a live ComfyUI/proxy deployment.

`native_negotiate_api` probes `api/v2/health`, then protected `api/v2/jobs?limit=1`, against the explicitly supplied base URL. The contract is pinned to official comfy-api-proxy source commit `1569dc17ec0dd293d4b9a0723e142204dacedb85`. Health alone does not check its upstream or authentication; even successful listing is not a model/computation proof. Only health 404 allows the separate Classic `GET prompt` queue-shape probe. Redirects and environment proxies are disabled; each response is capped at 64 KiB, requests at five seconds and total negotiation at ten seconds. Returned capabilities name only observed probes, with `generationReady:false`. Authentication, HTML, malformed/incompatible data and transport/bounds errors do not silently fall back.

`compileRecipe` implements only `checkpoint-text-to-image-diagnostic` version 1, with seven built-in computational nodes. Every intent field and four verified capability/model allowlists are required. Pure compilation validates identifiers, bounds, alignment, seeds, prompts and enum choices; it neither discovers real prerequisites nor submits anything. The compiler is not wired to Director draft controls; checkpoint architecture suitability, live model discovery and execution acceptance remain open. This foundation is not marked as a complete M3 Director slice.

The release artifact was refreshed and launched with Vite stopped. Exact-PID X11 window capture `assets/deas-native-api-start.png` visually confirms rendered DEAS, NVIDIA discovery and the initial setup screen; no blank/error page. It does not prove interactive native API negotiation. Host-specific X11/DMABUF settings stayed local to this test. Only the owned test app was terminated. Browser API-panel captures: `assets/deas-api-{1440,320}.png`.

## Earlier independently verified baseline

- `npm run typecheck`: passed.
- `npm test`: 38 core/model/localization tests and 73 React/provider/atom tests passed.
- Localization tests enforce DE/EN key parity and audit production TypeScript/JSX references, visible static prose and literal accessibility labels.
- `npm run build`: passed. One nonfatal Vite warning notes that Tauri core is both statically and dynamically imported; it does not prevent bundling.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 46 tests passed, five explicit-live/network/dialog tests ignored by default.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings`: clean.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`: clean.
- `cargo build --manifest-path src-tauri/Cargo.toml --release --locked`: passed after final frontend changes.
- Both ignored `live_nvidia` tests separately passed, exercising actual read-only GPU discovery and native immutable-plan selection.
- The ignored `real_uv_isolated_minimal_package` smoke separately passed: verified uv archive, locally managed Python and actual installation/import of packaging in a scratch fixture. No Torch/model installation.
- `src-tauri/verify_wheel_metadata.py`: all nine CPU/cu121/cu130 Linux/Python3.12 wheel HEAD checks returned 200. CPU/cu130 metadata verified; cu121 metadata 403 remains a limitation. Availability is not runtime acceptance.
- `src-tauri/verify_resolution.py`: current ComfyUI requirements resolved 106 packages against exact cu130 constraints with uv 0.8.22 in dry-run. No GPU stack installed. Managed Python 3.12.11 was provisioned only in temporary scratch.
- `tools/verify_ui.py`: passed at widths 1440, 1024, 768, 390 and 320. Verified explicit selection/confirmation, included Director microfeatures, no Suggested connection lines, DE/EN switching without changed choices, local plan export, branch reset, existing-backend handoff, Director draft persistence, no blob overlap/page overflow/runtime errors, and no backend requests.
- Actual light dash-offset and paw transforms change over time; reduced motion removes both animations.
- Final release executable launched with the Vite server stopped. `assets/deas-native-stable-start.png` confirms compact language control, left-starting AiO bubble, real hardware IPC discovery and no blank/error page. The host synthetic-input harness did not advance the new native window; interactive confirmation/microfeature acceptance is established by frontend tests and the four browser scripts, not claimed from a native initial-screen capture. The native profile retained English from earlier testing.

## Confirmation and package acceptance

`tools/verify_confirmation.py` passed at 1440/1024/768/390/320px. Route, package and backend selection/heading clicks do not progress; the architecture extras remain editable until Confirm & continue. Four passive included microfeatures appear on Director, with no companion selection controls or recommendation roads. Native request features expand to the full bundle, options persist across backend edits, drafts roundtrip, and no active target overlap/horizontal overflow occurs. DE/EN labels, detected-prefill confirmation and late-response/consent safeguards have regression tests. `assets/deas-director-included-{1440,320}.png` and `assets/deas-backend-confirmation.png` are current browser captures. No installation was performed.

## Stable controls acceptance

`tools/verify_stability.py` passes at 1440/1024/768/390/320px with normal motion enabled. Actual document-coordinate rectangles stay unchanged on hover/focus/selection for group headings, route choices, Director and all four backend alternatives. The shared green confirmation control sits immediately below current controls at the lower-right edge of the common selection workspace, not the viewport. Document-coordinate geometry stays unchanged on hover/focus/selection and option edits; the footer scrolls normally. External input-form Enter submission is verified. Hidden help and badge slots reserve natural wrapping footprints, and history transform/recede animation is removed. Input forms share the external confirmation button without changing native installation authorization. `assets/deas-stable-controls-{1440,320}.png` capture the tested state.

## Compact UI acceptance

The browser acceptance was repeated after the compact redesign: 144px standard bubbles, heading plus mini status, help text in reserved space inside the original button, without resizing or extra bubbles, single staircase choice shell, semitransparent returnable history, exact plan preservation after revisiting storage, locale preservation and studio snake rows. At 1440×960 the closed-panel studio map fits without vertical document scrolling; narrower layouts still allow necessary scrolling. No horizontal overflow or overlapping active hit targets at the five tested widths. Technical disclosures remain closed initially; explicit consent and blockers are not hidden.

The actual OS directory chooser was separately opened in folder-only mode and cancelled via its real close action: the ignored native picker smoke passed. Frontend mocked IPC covers selected parent/new child, cancellation, errors and duplicate-call prevention. A further native-app-to-portal screenshot attempt could not be concluded because the KWin capture helper timed out; do not treat that attempt as successful full native picker UI acceptance. Windows/macOS dialog/runtime checks remain unverified.

## Hover-overlap regression

The earlier clean screenshots deliberately blurred focus and moved the pointer away, so they did not validate help overlap. The running user executable matched that earlier artifact; this was not a stale-build issue. Help placement previously covered source/staircase rows, and focus or layout-induced hover could leave future decision descriptions visible after selection.

`tools/verify_help.py` now tests real hover and focus on group headings and every option at 1440/1024/768/390/320 widths, including 720px-high viewports. The final design supersedes popup exclusion placement: help is plain description text INSIDE the existing bubble/choice button. No help portal, separate bubble or fallback help panel remains. Neighboring choices retain their geometry without overlap. Selection dismisses help until genuine pointer movement or deliberate keyboard focus, preventing stationary-pointer layout changes from revealing a new heading. All four browser suites, 38 core/73 UI tests, typecheck and the rebuilt release passed. `assets/deas-inline-help-flags.png` now shows inline Director help and passive included microfeatures. Earlier native hover captures belong to the superseded popup implementation. No installation was started.

## Detection and recommendation acceptance

Independent native tests: 29 passed, 5 ignored by default; clippy/fmt/release build passed. The explicit `live_read_only_hardware_detection` test passed and returned NVIDIA GeForce RTX 5090, driver 615.71.09 and compute capability 12.0 in 21ms. This is discovery only, not GPU computation or stack compatibility.

The real native webview invoked `native_detect_hardware` on mount: `assets/deas-native-detected-start.png` shows its NVIDIA detected notice, with Vite stopped. Native UI full-path preselection could not be concluded through the host synthetic-input harness; model/frontend integration instead has actual IPC mocked with user override, late/stale responses, restore, StrictMode and prepared-consent regressions. The discovered NVIDIA choice is marked Detected AND Suggested and preselected only if untouched; other Suggested choices remain manual. Detection metadata persists in returnable history. The metadata model supports detected features, but existing feature-package scanning is not implemented; no feature installation is inferred. AMD/Intel discovery remains unsupported.

## Implemented native execution boundary

Rust owns the installer directly, without a Go executable/sidecar. Plans contain exact target, choices, selected Torch profile and discovered NVIDIA identity. Start requires the immutable native ID and separate confirmation; edits invalidate UI consent. Native status/cancellation operates only on app-owned worker processes. Default tests exercise real local Git checkout, real subprocess cancellation, integrity/path checks and immutable-plan safeguards.

Linux x86_64 CPU/NVIDIA baseline orchestration is implemented: verified uv bootstrap, managed Python, ComfyUI checkout, isolated venv, pinned framework packages, constrained requirements, selected shared nodepack and required runtime verification. NVIDIA selection uses bounded read-only preflight and rejects unsupported devices/drivers instead of falling back silently. Final GPU computation is implemented as an execution-time requirement but has not been exercised in a full newly installed environment here.

Director is one selected package including Forge, RefMods, Continuity and Output. Its effective native feature IDs are director/forge/refmods/continuity; native plans expand missing companion IDs before separate installation consent and fetch the shared nodepack once. Output is an included studio capability, not a new provisioning ID. Inclusion does not implement generation or provide model weights/workflows. Suggested labels never imply consent.

## Owned backend lifecycle acceptance

Independent Cargo test rerun: 46 passed, 5 ignored; clippy/fmt clean. The explicit `real_uv_isolated_minimal_package` smoke passed again, including managed Python interpreter-copy execution, a local HTTP fixture and Engine shutdown. Lifecycle tests use real child processes and local HTTP servers to cover successful API readiness, failed startup, timeout, duplicate start, ownership/path/manifest tampering, foreign listeners, listener loss, descendant cleanup and shutdown. They are protocol/lifecycle fixtures, not full ComfyUI or GPU generation acceptance.

Launch authorization is held only after successful approved provisioning in the current Engine. Commands accept no target/PID/URL arguments. The Linux launcher uses a checked managed interpreter, loopback ephemeral port and `--disable-auto-launch`; exact child FD/socket-inode ownership is required before/after bounded classic API probes. The startup deadline is 120 seconds; successful API readiness still reports `generationReady:false`. Stop/app-exit cleanup targets only the owned process group with the leader unreaped until termination, avoiding PID reuse. No arbitrary existing environment adoption or unrelated service control is implemented. Guards are not a sandbox against hostile same-user concurrent filesystem mutation.

`OwnedBackendPanel` adds localized explicit Start, Refresh status, Stop and Inspect running backend controls. Start is offered only after native install success; mount/refresh never starts a service. One-second non-overlapping polling, double-click/error/unmount/stale-response guards and the exact returned endpoint are covered by 10 new mock-IPC lifecycle/integration tests. These tests do not claim real GPU or ComfyUI generation acceptance. Browser preview cannot invoke lifecycle commands.

## Artifact

`artifacts/deas-linux-amd64`

SHA-256: `d5c323746007049d6e4c843df24cffe5d1e63a78f31dad32cf6663a5c8307d78`

Locally verified, system-linked Linux x86_64 development artifact. Not a signed portable release. Native capture used:

```sh
env GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 ./artifacts/deas-linux-amd64
```

These are host-specific test settings, not global graphics changes. Wayland, media and other target platforms need independent acceptance tests.

## Explicit unverified or unsupported areas

- No complete CPU/GPU ComfyUI installation or generation acceptance run was performed.
- Source-only node dependencies such as nvidia-vfx/llama-cpp-python remain unverified. The binary-only node resolver fails; native execution must abort required dependency failures.
- AMD/Intel, other platforms, Sage/Radial/Flash/FFmpeg remain blocked selections, not ported capability claims.
- Git remains an external prerequisite. Free-space estimates and multi-GPU selection are unfinished.
- No model/recipe/workflow provisioning, restart adoption, resume, repair, transactional update or rollback. Explicit owned backend lifecycle is implemented and fixture-tested; launch against a full new ComfyUI install remains unverified.
- Language plugins are bundled validated JSON data; downloadable pack installation is not implemented. Raw native technical logs/errors/details remain original beneath translated headings.
- Native UI-to-command dispatch is covered with mocked frontend IPC and direct native engine tests; screenshot rendering alone does not prove a full end-to-end native installation.
- Earlier live endpoint 127.0.0.1:7801 returned Kestrel redirect/HTML rather than ComfyUI; no new live backend request or environment mutation in this slice.

## Publication and safety

Existing user installations and services were not changed or restarted. Only owned development processes and scratch fixtures were used. No model downloads or releases were performed. The user authorized committing this verified alpha snapshot and pushing to both configured Git remotes; remote publication/CI is checked separately from these local acceptance results. Windows CI remains configured but not exercised locally. Remaining acceptance items are in `docs/PLAN.md`; full Go feature parity is explicitly incomplete.
