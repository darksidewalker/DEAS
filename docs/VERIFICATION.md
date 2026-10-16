# DEAS verification — native baseline, optional capabilities and languages

## T05-R1 local readiness-test correction (2026-10-15; acceptance BLOCKED)

Checked out `fix/deas-readiness-ci` from local `main` at `f2651a584b0757c2d292fe2f44672f89b16279bb` (0.1.5); the local `origin/main` reference matched. The pre-existing `.gitignore` addition of `plan/` is preserved. All three planning documents are revision 3 dated 2026-10-15; repository plan/verification/handoff notes were read, and no applicable `AGENTS.md` was found.

Source inspection confirmed that synchronous launch validation/spawn precedes the supervisor's deadline, which starts after runtime construction. The test now applies its unchanged <1 second bound to `terminal_observation`, intentionally excluding synchronous launch latency. Supervisor work can overlap launch return, so this caller-observed post-launch liveness guard is not a precise 300 ms supervisor/cleanup measurement. Launch/total diagnostics, the 300 ms timeout, overall-timeout error assertion and every outcome/process check remain unchanged. Production code, dependencies and CI configuration are untouched.

Local Windows checks used Node 22.13.1 and bundled npm 10.9.2 via `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"`:

- `run typecheck` and `run build`: exit 1 each; `tsc` unavailable, with `node_modules` absent.
- `test`: exit 1 before tests; nested npm launcher hit `EPERM` resolving `C:\Users\arasb` in the sandbox.
- `run test:core`: exit 1; 42 passed, 2 dependency-load failures (`@tauri-apps/api`, `typescript`), not product assertion failures.
- `run test:ui`: exit 1; `vitest` unavailable.
- `node --experimental-strip-types --test tests/execution.test.ts tests/setup.test.ts`: exit 0, 29 passed; overlaps the core results above.
- `git diff --check`: exit 0. Static diff review confirms only the intended test expression/comment changed in Rust; this is not a rustfmt/native pass.

`cargo --version` exited 1 (command unavailable); Rust tools were not found. Linux isolated diagnostic, normally parallel native suite, strict fmt/locked all-targets Clippy/build and required frontend/Ubuntu/Windows CI remain **BLOCKED**. No new native timing/count, corrective commit SHA, CI run URL or attempt exists; the correction is uncommitted. No toolchains/dependencies were installed, ignored/live/GPU/dialog/model tests run, or user services controlled. No commit/push/merge. T01 requires a separate assignment after this correction's required CI is green. The earlier acceptance sections below are historical evidence, not results for this correction.

## PNG preview/export and paused handoff (0.1.5)

The current diagnostic succeeded job now supports explicit indexed PNG retrieval through its native-held endpoint/output references. Transport disables proxies/redirects, bounds encoded bytes to 16 MiB and uses a ten-second request deadline. PNG parsing checks envelope/IEND/trailing data, CRC and Adler checksums, rejects animation, bounds decoding to 32 MiB and requires dimensions matching the original diagnostic intent (at most 2048 per side). Text/ICC metadata decompression is skipped. One bounded native cache preserves original encoded bytes and SHA-256; job status does not include media bytes. Stale/replaced jobs cannot publish a fetched result.

The frontend explicitly loads native-validated bytes into a local PNG Blob preview, revokes replaced/unmounted URLs and discards stale async responses. Save As uses the exact cached native original, not frontend bytes or another HTTP fetch. Linux publication is descriptor-anchored, private-mode, synced and no-clobber; existing files, symlinks and untrusted parents are preserved. Cancelling returns null and does not report success. Non-Linux export fails closed. The native dialog cannot create parent directories.

Final independent gates: 48 core tests, 147 UI/IPC tests, 122 Rust tests with nine ignored, typecheck, frontend build, Clippy with warnings denied, formatting and native release build. HTTP/PNG fixtures cover actual original bytes, digest, exact prefixed view query, cache reuse with the server gone, MIME/HTML/SVG/redirect/corruption/truncation/APNG/dimension/size/time bounds and exclusive/stale fetches. Real scratch filesystem tests read back byte-identical exported PNGs and verify cancellation, private mode, no-clobber/symlink/perms guards. One earlier full Rust run had a transient pre-existing backend fixture assertion failure; its isolated rerun and both final full runs passed without changing that test.

The extended `tools/verify_jobs.py` passed at five widths down to 320px across six locales: one explicit media load, actual browser PNG decode (512px test fixture), local Blob URL, cancelled export without success, explicit mocked successful Save As and no extra media fetch. Browser native responses and exported path are IPC fixtures; the filesystem export above is real. Updated `assets/deas-jobs-fixture-{1440,320}.png` show an explicitly encoded copper test PNG, not a model-generated image. Existing UI/confirmation/help/stability suites also passed at five widths.

With Vite stopped, a separate exact-PID 0.1.5 release instance rendered the initial native window (`assets/deas-native-outputs.png`) through the existing XWayland fallback; only that instance was terminated. This does not prove native-webview media decoding or interactive native Save As dispatch. Local artifact/release SHA-256 matches: `896bebf6ad614876fed32f800fa5a9a46afb4895f9b279e68877b08fef481d5a`. No live generation/model download was attempted; user services were untouched.

**Stopped at the owner-requested boundary.** No live delegated workers or owned verification servers remain. Accumulated changes are local/uncommitted; no push/publication. Resume from [NEXT-SESSION.md](NEXT-SESSION.md), then choose safe job cancellation or a separately consented real model-generation acceptance. Full Director recipes, durable restart adoption, other export platforms and complete installer parity remain open.

## Diagnostic native classic job transport (0.1.4)

The native job service accepts only a bounded versioned diagnostic intent and rechecks fresh core prerequisites before storing its endpoint and fixed graph. Separate unchecked consent and Run authorize one classic submission; the native plan is consumed before the first network await. Lost/malformed responses remain unknown and cannot silently retry. Subsequent history/queue reads use the native-held prompt ID, client ID and exact graph; foreign identities and unsafe output names are rejected. Only validated output metadata is returned, never arbitrary backend paths or media URLs.

The DEAS panel keeps a submitted identity across draft endpoint changes, serializes polling, stops polling on terminal/unknown results and allows explicit refresh. Explicit Recover session job restores only the current native session snapshot after panel unmount/navigation or a lost IPC response. It never submits, starts a service or adopts saved drafts. An unknown submission without a returned prompt ID deliberately blocks replacement jobs for that app session; safe abandonment/reconciliation is not implemented. No global interrupt/queue-clear, file transfer, media preview/export or generation-readiness claim is added.

Independent gates passed: 48 core tests, 131 UI/IPC tests and 115 Rust tests (nine explicit tests ignored by default), TypeScript check, production build, Clippy with warnings denied, formatting and native release build. Nine native job tests include real local HTTP fixtures covering prepare-only reads, endpoint prefixes, immutable submission/confirmation/duplicate guards, queued/running/completed/error states, transport ambiguity, correlation failures, unsafe references, streamed response bounds and session recovery. Frontend tests cover stale/unmounted requests, input invalidation, consent, serialization, browser fail-closed behavior and recovery without resubmission.

`tools/verify_jobs.py` passed at 1440/1024/768/390/320px across all six locales, including exact explicit Run payload, draft invalidation, original-endpoint tracking and navigation/recovery. Its server responses are mocked IPC fixtures, not actual model generation. Captures: `assets/deas-jobs-fixture-{1440,320}.png`. The 320px completion UUID/URL overflow found during verification was fixed with bounded wrapping; the final suite passed. Existing UI/confirmation/help/stability suites passed at five widths; automatic and recipe-prerequisite browser suites passed browser/IPC-fixture modes across six locales.

With Vite stopped, a separate exact-PID release instance rendered the native initial window through XWayland fallback; `assets/deas-native-jobs.png` was visually checked. Only that owned instance was terminated. The atomically staged local 0.1.4 artifact and release binary share SHA-256 `7329cfaca07f1537a633c2988cae3e3dd04d4fc0873784c41b8abd11de5d0e39`. This is local Linux rendering/build evidence, not interactive native job or model/GPU acceptance. Previous real installer/Director acceptance remains documented below; this slice did not rerun large installs or submit to a user backend.

## Installed components and automatic studio handoff (0.1.3)

Successful native provisioning of the exact started immutable plan reveals the studio automatically, including Director and its passive companions without another enable step. Drafts, running/failed/cancelled installs, stale requests and newly prepared plans cannot trigger the success handoff. Backend start remains explicit; actual native running status binds its exact endpoint once per lifecycle/endpoint, without automatic inspection, job submission or a generation-ready claim. Repeated polling and callback changes do not repeatedly reopen the Engine panel.

Independent gates passed: 48 core tests, 111 UI/IPC tests, 106 Rust tests (nine ignored by default), typecheck, production build, Cargo Clippy/fmt and native release build. The separately invoked `real_comfy_director_install_and_owned_lifecycle` also passed (164.45 seconds): a new actual NVIDIA/ComfyUI environment, selected Director dependencies and required node registration, synchronized framework computation, owned API readiness and stop. This does not prove model generation or every Director recipe.

The extended `tools/verify_automatic.py URL` passed automatic review plus install-success → studio → explicit backend start → endpoint handoff at 1440/1024/768/390/320px across all six locales. Browser installation/lifecycle responses are explicitly mocked IPC; no model/job is submitted. Existing UI/confirmation/help/stability suites passed at all five widths. New fixture captures: `assets/deas-studio-handoff-fixture-{1440,320}.png`. A separate exact-PID release instance rendered the native initial window (`assets/deas-native-studio-continuation.png`) using automatic X11 fallback with default graphics variables unset and an unavailable Wayland socket. Only that owned instance was terminated. Native screenshot rendering is not interactive installation acceptance.

The local `artifacts/deas-linux-amd64` was atomically replaced with the rebuilt 0.1.3 binary; matching release/artifact SHA-256: `5e2e3e5e52c2a61a8a41a7a8db366557e17d892d344c92cd31bc49f743cc8662`. Existing services and installations were not modified. Remaining work: real job/assets/output handling, verified model recipes, restart adoption, Git bootstrap and full platform/installer parity.

## Diagnostic recipe prerequisites and compile preview (0.1.2)

The native `native_recipe_prerequisites({baseUrl})` command reads only the selected core ComfyUI `object_info` endpoint. It preserves path prefixes, disables redirects/environment proxies and bounds the response to 16 MiB with a ten-second request timeout. It checks the six diagnostic built-in node identities and extracts exact checkpoint/sampler/scheduler choices. Missing nodes are diagnostics; malformed schemas, unsafe identifiers and duplicate choices fail closed. There is no upstream/proxy following, submission, download or service operation.

The Engine panel exposes an explicit prerequisite check and DEAS-owned diagnostic prompt/model/enum controls. Its pure compiler preview uses observed allowlists and fixed readable defaults (512×512, 20 steps, CFG 7, seed 0). Endpoint edits and unmount discard stale results; missing prerequisites prevent compilation. All six locales are supplied. Reported identities do not establish checkpoint architecture, file validity, model loading, GPU execution or generation readiness.

Independent integration gates passed: 48 core tests, 98 UI tests, 106 Rust tests with nine ignored, typecheck, frontend production build, Clippy and native release build. Thirteen native prerequisite regressions include real local HTTP fixtures; frontend/native IPC responses in browser tests are explicit fixtures. `tools/verify_recipe_prerequisites.py` passed browser-fail-closed and IPC-fixture paths at 1440/1024/768/390/320px across all six locales, with no overflow or unexpected submission. A separate exact-owned-PID release instance rendered the initial native window through XWayland without stderr; only that instance was terminated. Interactive prerequisite IPC in the native webview and live model generation were not exercised.

## Automatic-first installer (0.1.1)

Opening AiO now enters one editable review rather than the guided question sequence. Native read-only defaults select a compatible NVIDIA backend or an explained CPU recommendation, a new `deas-environment` beside the actual running executable, ComfyUI master, core-only package and optional extensions off. Directory, backend, Director package, all attention/media flags and source ref remain editable. Prepare native plan shows the exact immutable request; final Start install is the explicit authorization. Edits invalidate old plans; mismatched/unsupported requests and duplicate starts are blocked. Older drafts and the optional manual guided/existing-backend paths remain supported.

Independent gates passed: 48 core tests, 86 UI tests, 92 Rust tests (nine ignored by default), typecheck, frontend build, Clippy, formatting and native release build. The explicit read-only native-defaults test returned the actual RTX 5090 and executable-relative path without creating a directory. `tools/verify_automatic.py` passed browser-fail-closed and native-IPC-fixture modes at 1440/1024/768/390/320px across all six locales, including every editable field, stale-plan rejection, unsupported-option blocking, final explicit confirmation, running edit lock and compact checkbox geometry. All seven existing browser suites passed after selecting the optional guided fallback where applicable. Native fixture starts do not install anything.

With Vite stopped, a separate exact-PID release instance was clicked to open AiO and captured in `assets/deas-native-automatic-review.png`: real NVIDIA discovery, `/data/GitHub/DEAS/artifacts/deas-environment` beside the launched artifact, and the actual native editable review are visible. Only the test instance was terminated; no final installation was started, environment created or unrelated service stopped. Browser fixture screenshots are explicitly named `assets/deas-automatic-fixture-{1440,320}.png`.

The later opt-in target-machine capability/optimization scan (launch parameters, memory/offload policy, kernel/codec support and bounded consented benchmarking) is specified in PLAN and PLUGIN-ROADMAP only; basic read-only recommendations do not implement it.

## Real upstream CPU/NVIDIA installation acceptance

The explicit `real_comfy_cpu_install_and_owned_lifecycle` test passed twice against upstream ComfyUI master in a new temporary environment. It exercised the actual Engine plan/confirmation/start worker, checksum-verified uv, managed Python 3.12, pinned CPU Torch trio, constrained ComfyUI dependencies, framework computation checks, manifest capture, owned backend launch, real API readiness and owned stop. No fixtures replace ComfyUI in this test. The temporary environment is removed afterward; no model weights or user installations/services are touched. API readiness remains distinct from generation acceptance.

The explicit `real_comfy_nvidia_install_and_owned_lifecycle` test also passed against upstream ComfyUI master on the RTX 5090. It used the same real Engine path with the immutable cu130 Torch profile, exact framework versions, hardware identity checks and synchronized CUDA matrix multiplication, followed by actual ComfyUI API readiness and owned stop. No existing GPU service was stopped.

The node dependency path now applies the reference installer’s CPU/CUDA-specific llama-cpp-python wheel index and binary-only guard. NVIDIA VFX is resolved separately from its actual NVIDIA wheel index rather than executing its PyPI downloader stub. Provisioning initializes real ComfyUI core/custom nodes without opening a listener, within a 120-second process alarm, and fails when the selected Director/Continuity node IDs did not register; `--help` is no longer treated as an import check. Focused regression tests cover CPU, cu130, spelling variants and false matches. The explicit `real_comfy_director_install_and_owned_lifecycle` test subsequently passed in a new NVIDIA environment: full selected nodepack dependencies (including real NVIDIA VFX and cu130 llama-cpp-python wheels), actual Director/Continuity node registration, ComfyUI API readiness and owned stop. It does not prove model generation, RTX VFX execution or every included feature recipe.

Current checks passed: 88 Rust tests (eight explicit integration tests ignored by default), the separately executed full CPU, NVIDIA and selected Director-nodepack integration tests, 47 core tests, 94 UI tests, typecheck, frontend build, native debug and release builds, formatting and Clippy with warnings denied.

Repeat the network/download integration explicitly:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked real_comfy_cpu_install_and_owned_lifecycle -- --ignored --nocapture
```

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

Current 0.1.5 SHA-256: `896bebf6ad614876fed32f800fa5a9a46afb4895f9b279e68877b08fef481d5a`

Locally verified, system-linked Linux x86_64 development artifact. Not a signed portable release. Launch directly:

```sh
./artifacts/deas-linux-amd64
```

### Built-in Linux startup fallbacks

Before GTK/WebKit initialization, DEAS supplies `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `GDK_BACKEND=wayland,x11` only when each variable is absent. Explicit overrides, including empty values, remain unchanged. The defaults are process-local; no system settings, external services or graphics drivers are modified.

The previous artifact, with both variables removed, exited with `Error 71 (Protokollfehler) dispatching to Wayland display` on this host. The rebuilt artifact started with both variables removed and rendered the native frontend without stderr output. Exact-owned-PID native screenshots were visually checked for both the default Wayland window and automatic X11 fallback through XWayland. The X11 fallback check supplied a nonexistent Wayland socket while leaving `GDK_BACKEND` unset, proving GTK proceeds to X11 when Wayland is unavailable. Only separately launched test instances were terminated. Other compositors and standalone X11 machines were not physically tested.

Verification: frontend production build and native release build passed; Cargo tests reported 93 passed / 9 ignored, including the new defaults/override regression; clippy, fmt and diff whitespace checks passed. The deployed artifact and release build have identical SHA-256 hashes. Media and other target platforms still need independent acceptance tests.

## 0.1.6 — simplified automatic setup and media start page

Gates: 48 core tests, 158 UI/IPC tests (new `MediaLibrary.test.tsx`), typecheck/build, clippy/fmt and release build passed; Cargo `media` tests cover extension classification, sorted listing, hidden-entry skipping, symlinked and dangling links. `backend::tests::invalid_owned_api_never_marks_running` fails on this host before and after the change. Browser suites `verify_automatic`, `verify_ui`, `verify_jobs`, `verify_api`, `verify_recipe_prerequisites`, `verify_languages`, `verify_downloads`, `verify_help`, `verify_confirmation` and `verify_stability` passed against owned Vite servers; `assets/deas-media-start-{1440,320}.png` show a browser drop rendering an image preview. The native release artifact rendered its initial page; media library click-through, OS drag & drop and asset-protocol preview inside WebKitGTK were not exercised (no input automation on this Wayland host).

## Explicit unverified or unsupported areas

- Complete CPU installation and owned API lifecycle are now verified above; full NVIDIA installation and owned API lifecycle are also verified; actual model generation remains unverified.
- Node dependencies now use explicit NVIDIA VFX wheels from NVIDIA’s package index and backend-matched llama-cpp-python wheels; no wheel-stub/source build or implicit CPU fallback is required for those packages. Full selected-nodepack acceptance is reported separately; package availability alone is not RTX operation or generation readiness.
- AMD/Intel, other platforms, Sage/Radial/Flash/FFmpeg remain blocked selections, not ported capability claims.
- Git remains an external prerequisite. Free-space estimates and multi-GPU selection are unfinished.
- No model/recipe/workflow provisioning, restart adoption, resume, repair, transactional update or rollback. Full new CPU/NVIDIA and selected Director-nodepack installation/lifecycle acceptance is documented above; model generation remains unverified.
- Language plugins are bundled validated JSON data; downloadable pack installation is not implemented. Raw native technical logs/errors/details remain original beneath translated headings.
- Native UI-to-command dispatch is covered with mocked frontend IPC and direct native engine tests; screenshot rendering alone does not prove a full end-to-end native installation.
- Earlier live endpoint 127.0.0.1:7801 returned Kestrel redirect/HTML rather than ComfyUI; no new live backend request or environment mutation in this slice.

## Publication and safety

Existing user installations and services were not changed or restarted. Only owned development processes and scratch fixtures were used. No model downloads or releases were performed. GitHub publication/CI is checked separately from these local acceptance results. Windows CI remains configured but not exercised locally. Remaining acceptance items are in `docs/PLAN.md`; full Go feature parity is explicitly incomplete.

## 0.1.10 — Checked reopening and default-on backend autostart

The owner's `/home/darksidewalker/Downloads/deas-environment/` resolves to `/data/Downloads/deas-environment`. The explicit ignored `inspect_existing_environment_from_env` test parsed its existing plan/install manifests, captured the native path/ownership/launch-file evidence and completed `open_existing` in a fresh Engine with `state=succeeded`, NVIDIA and the recorded Director/Forge/RefMods/Continuity selections. It performed no installation, package update, manifest rewrite or backend start. This is reuse validation, not a fresh framework/GPU computation test.

Native scratch fixtures prove preview-only state cannot launch, opening needs the exact one-time native preview plus confirmation, changed launch files invalidate it, explicit start after reopening runs only the fixture's owned child, and a second Lifecycle cannot start the same environment until the first releases its OS lock. Frontend tests cover folder-root recognition, restored/fresh-install autostart exactly once, StrictMode, status-first handling, manual Stop without restart, persisted Settings opt-out and invalid remembered roots failing closed. The opt-out leaves manual Start available and never stops a running backend.

Gates: 190 UI tests pass; native library 151 passed / 12 ignored plus the binary's one test pass; typecheck, production/Linux release build, clippy, fmt and diff checks pass. `tools/verify_reopen.py` passes all 30 combinations of six locales and five widths down to 320px, including default-on startup, off-switch persistence through reload and manual startup while off. An isolated native release instance rendered at 1440×960 with a fresh webview profile and no real credentials/environment adoption. The complete core suite now passes 48/48: installed-model sizes use a localized GiB/Gio label, and the preference-key false positive in the locale audit is corrected without exempting translation calls.

The updated artifact is staged at `artifacts/deas-linux-amd64`. Real GPU execution after reopening, generation acceptance and Windows runtime behavior remain unverified. Foreign services were not stopped or adopted; the owner's environment was not reinstalled or modified.

## 0.1.9 — Automatic provider-token verification

Native HTTP fixtures verify authenticated identity schemas for Hugging Face, CivitAI and GitHub; 401 rejection versus unavailable 403/429/5xx, redirects, HTML/public/malformed responses, fixed-size and chunked response caps, connection failure and the eight-second stalled-response timeout. UI fixtures cover automatic restored/saved-token checks, a green checkmark only on confirmation, rejected/unavailable/unsupported outcomes and stale replacement results. `tools/verify_auth.py` covers all three providers, rejection and offline states at five widths down to 320px; the existing downloads browser suite also passes. No real user tokens or provider/vault acceptance were exercised.

Typecheck, production frontend/Linux release build and clippy/fmt pass; Cargo reports 147 passed / 9 ignored, Vitest 180 passed. The core suite currently reports 47/48: its unrelated locale-reference audit treats the existing preference key `usePref('studio.tab', …)` in `App.tsx` as a translation key. This work does not change that preference/scanner contract. The rebuilt app is staged at `artifacts/deas-linux-amd64`; a running instance must be relaunched. API authentication is not download entitlement, gated-license acceptance or generation evidence.

## 0.1.7–0.1.8 — Library sorting, Settings folders, relocation and tab-strip setup

Gates re-run at the 0.1.8 docs commit: typecheck, 14 Vitest files / 167 UI-IPC tests, production build, `cargo fmt --check`, clippy clean, Cargo 141 passed / 9 ignored. The pre-existing host-dependent `backend::tests::invalid_owned_api_never_marks_running` failure persists independent of these changes. Browser suites `verify_automatic`, `verify_downloads`, `verify_languages`, `verify_jobs`, `verify_api` and `verify_recipe_prerequisites` were run during the 0.1.6–0.1.8 feature commits; no new browser acceptance was performed in this docs-only pass.

Relocation (`settings_move.rs`) is covered by Rust fixtures: all-tree conflict/overlap rejection, exclusive streamed copy, byte verification, atomic settings save, unchanged-source removal, retained-original warnings, symlinked/overlapping tree rejection. Relocation is Linux-only; other platforms fail closed. Real large-tree relocation on live data and crash/power-loss recovery remain unverified. `native_pick_directory` canonicalizes symlink aliases at the chooser boundary; execution still refuses substitutions.

Windows remains compiled and CI-built only; no Windows runtime acceptance. Artifact re-staging for 0.1.8 is pending the next `./build-linux.sh` release build.
