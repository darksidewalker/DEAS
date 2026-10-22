# DEAS project rules and goals

This is the normative development guide. **MUST** is a requirement; **SHOULD** allows a documented technical exception. Existing code is not automatically compliant merely because it predates these rules. Current delivery status belongs in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md); ComfyUI-specific requirements belong in [COMFYUI-RULES.md](COMFYUI-RULES.md).

## Accepted product contract

[PRODUCT-DECISIONS.md](PRODUCT-DECISIONS.md) is the owner-approved target contract: experienced local users, persistent managed-media projects, immutable revisions/jobs, explicit execution, local-first privacy and a bounded Studio surface using ComfyUI. It supersedes conflicting older product priorities, not existing safety rules or evidence. The owner subsequently reduced the next scope to a bounded global recent-job history (last 10 jobs; one local JSON file proposed) and deferred managed generated PNG/revision persistence and the full SDXL project/recovery milestone as excessive for the current workflow. The scope correction at the top of PRODUCT-DECISIONS governs over the older interview target. Preserve existing project features/files and separately recorded video defects; further integrations require explicit priority. Keep normal correctness, source-preservation and platform verification for changed behavior. This is decided scope, not a claim of implementation, execution authorization or a rewrite mandate. The broader AiO goal below remains the long-term direction.

## 1. Product goal

DEAS is an all-in-one AI workstation for generating and prompting, managing checkpoints/models/LoRAs, intelligent editable presets, automated installation and backend handling, composable image/video pipelines, LoRA creation/training, video post-production, video comparison and video assembly. Users should not need to understand ComfyUI's computational graph to use Studio.

New features must be easy to add as small plugins. New ComfyUI releases, models and processing implementations must be accommodated through bounded adapters and capability data, not invasive changes throughout the application. Robustness, auditability, exact model-compatible settings and measured performance take precedence over the number of advertised features.

Automation recommends and prepares; users retain control of settings, resources, execution and outputs. The preset system must explain its model/hardware assumptions, preserve explicit overrides and produce reproducible effective settings. A guessed setting must never be presented as measured or verified.

## 2. Rust first

- Rust MUST be the primary language for new native/domain functionality: provisioning, downloads, authentication boundaries, process ownership, filesystem/media operations, scheduling, validation, recipe compilation, project persistence and backend adapters.
- If an implementation or maintained Rust library works correctly on both Linux and Windows, use Rust rather than adding a Python/Go/Node service for that job. Verify bindings, native dependencies, licensing, hardware support and actual behavior; a crate name alone is not proof of suitability.
- React/TypeScript remains the presentation layer. Keep browser interactions, rendering and editable drafts there; native validation and execution are authoritative. Existing TS compile previews may remain, but must not become a second independently evolving execution engine. Test parity with native compilation.
- Python is an explicit exception for ComfyUI/PyTorch and specialized ML/training/SDK computation with no suitable working Rust path. Keep these adapters narrow, versioned, isolated and replaceable. Do not rewrite a working model stack merely to claim language purity.
- Existing Go applications are behavioral references, not new bundled DEAS orchestration services or embedded legacy UIs. Do not copy their servers or launchers into the product by default.
- Record exceptions with the capability, unavailable Rust alternative, supported platforms, dependency profile, tests and migration boundary. No speculative Rust rewrite of unrelated existing code.

## 3. Atomic, plugin-oriented implementation

- A feature SHOULD be one independently testable module/plugin with one clear responsibility, explicit inputs/outputs and minimal declared dependencies. Split UI, native orchestration, backend computation and data where their lifecycles differ.
- Prefer the current module/manifest conventions. Built-in compiled modules and validated data-only plugins are valid initial forms; this rule does not require a dynamic-library loader or a new plugin framework.
- A plugin contract must identify a stable ID/schema version, capabilities, dependencies/runtime profile, supported platforms/hardware, permissions, settings/presets/locales, entry points, errors/cancellation and tests. Executable plugins are trusted code unless a real isolation boundary proves otherwise.
- Adding a feature must not require scattered feature-specific cases in shared services. Keep unavoidable integration wiring explicit and small. Do not claim today's manifest registry is a complete third-party SDK.
- Discover capabilities and validate dependencies before exposing Run. Distinguish offered, selected, downloaded, installed, discovered, compatible and execution-verified. Installation needs no second enable switch, but does not imply recipe readiness.
- Optional failures must disable only dependent capabilities, with an explanation. An optional dependency must not break unrelated modules at import/startup.
- Use existing shared auth, download, folder, asset, job, output, model-family and locale services. Promote a helper only when another real caller needs it; do not build one-use generic frameworks.
- Shared functions/scripts must take explicit parameters, return structured results and avoid hidden global state, UI assumptions and hard-coded user paths. Preserve cancellation, validation and errors when extracting reusable behavior.

### Cross-project changes and upstream pull requests

- Depending on another project does not authorize changing it. First use its supported public APIs, extension points and configuration; keep DEAS-specific behavior in the DEAS adapter when possible.
- If a feature requires changes in a dependency/reference project, implement those changes in that project's own repository on a separate branch and submit a focused **upstream pull request where applicable**, following its contribution/review process. A private/closed project may require its equivalent reviewed change request; document why an upstream PR is unavailable rather than silently patching installed files. Editing another repository and publishing a PR still require explicit authorization; a DEAS feature request alone does not grant it.
- Preserve the other project's standalone behavior, existing callers, workflows, defaults and Linux/Windows support. Prefer additive APIs and explicit opt-in behavior over DEAS-specific global patches or breaking interface changes. A necessary breaking change requires coordinated approval, versioning and migration—not a unilateral integration shortcut.
- Test the upstream change in that project's own suite, including unchanged standalone/other-consumer behavior, and test the DEAS integration separately. Cross-project work is not done merely because DEAS passes while the dependency regresses.
- Record the upstream repository, PR/change-request link, exact compatible commit/release and acceptance evidence in the integration documentation. Keep the dependent feature blocked or clearly experimental until its required revision is available and verified. A submitted or merged PR is not automatically a released/installed dependency; never silently track an unreviewed branch, force-update a user's checkout or claim upstream acceptance before it occurs.

## 4. Linux and Windows are required targets

- Every implementation MUST have a Linux and Windows path, or explicitly report a capability-specific unsupported state before execution. A platform-specific accelerator is an optional capability, not grounds to make the application itself platform-specific.
- Keep OS-specific filesystem, process, socket and desktop behavior behind narrow native modules. Use platform-aware paths and argv-based process APIs; never assume Bash, fish, a drive letter, `/proc`, POSIX signals or a particular shell.
- Preserve Windows Job Object cleanup and Linux owned-process-group cleanup. Do not manage processes by loose names or port matches.
- Test spaces/Unicode, long paths, canonical identities, symlinks/reparse points, cancellation and no-clobber output on both systems. Use existing Windows-aware path handling such as `dunce` where required.
- Native playback must be exercised in Linux WebKitGTK and Windows WebView2; Chromium fixtures and a cross-build are not target-platform runtime acceptance.
- Performance/correctness equivalence is the goal, not identical vendor acceleration. Publish hardware/driver/codec limitations and verified fallbacks rather than silent substitutions.

## 5. Dependency policy and current stack

Use existing project code → standard library/public backend API → already installed suitable dependency → maintained compatible Rust crate → small justified local implementation → new specialized worker dependency. Check licenses and transitive/native costs before adding a dependency; commit lockfile changes with the change that requires them.

The checked-in manifests, lockfiles and installer profiles—not this table—define exact resolved versions.

| Boundary | Current dependencies / requirement | Rule |
| --- | --- | --- |
| Native shell | Rust 2021, Cargo, Tauri 2; `src-tauri/Cargo.toml` and `Cargo.lock` | Main trusted orchestration layer |
| Native services | serde/serde_json, Tokio, reqwest with rustls, SHA-256, UUID, TOML, PNG, rfd, keyring, WebSocket support | Reuse existing services before adding alternatives |
| Platform APIs | Unix libc; Windows windows-sys; dunce | Keep platform branches localized |
| Frontend/tooling | React 19, TypeScript 5.9, Vite 7, Tauri JS API; Node/npm and `package-lock.json` | Rendering/drafts and development tooling, not a second runtime daemon |
| Linux desktop | Tauri build packages, GTK/WebKitGTK 4.1 and required GStreamer plugins | System/native dependencies remain real requirements |
| Windows desktop | Tauri Windows toolchain and WebView2 runtime | Verify packaging and runtime on Windows |
| Managed execution | Verified uv bootstrap, managed Python 3.12, selected pinned Torch trio, ComfyUI and explicitly selected node packs | Resolve actual profile in `install_torch.rs`; do not duplicate fast-changing pins here |
| Source acquisition | Git prerequisite; explicitly selected refs and recorded revisions | No implicit system-package changes |
| Optional ML/media | Selected models, FFmpeg/probe/codecs, training and enhancement worker stacks | Declare per-plugin; not all are provisioned today |
| Tests | Node test runner, Vitest/Testing Library, Cargo tests; Python/Playwright for targeted verification | Distinguish fixture, native, GPU and target-OS evidence |

Backend/training/enhancement dependency stacks may conflict. Isolate profiles instead of upgrading a shared environment underneath another plugin. Do not install dependencies, initialize GPUs or load large models during plugin discovery.

## 6. ComfyUI compatibility and future models

Follow the complete [ComfyUI rules](COMFYUI-RULES.md). DEAS owns Studio controls and versioned user intent; ComfyUI executes internal computational recipes. The separate original Comfy tab is a deliberate exception, not an alternative architecture for Studio.

Model packs must declare architecture evidence, required checkpoint/encoder/VAE/adapter components, supported operations and exact dimensions/frame/fps/audio constraints. Preserve filenames and API identifiers literally. Unknown compatibility blocks unsupported operations; do not infer architecture from a friendly filename or claim universal future-model support.

Centralize model constraints in family data and shared native validation. Display exactly what is submitted. Test constants as well as formulas against the reference model implementation. Capability probes and version diagnostics must fail clearly without replacing another pack's registrations or silently choosing another model/backend.

## 7. Shared pipeline and media contract

Plugins exchange validated asset handles and metadata, not arbitrary host paths or large copied pixel arrays by default. Preserve originals, audio/timestamps, color information and provenance. A generated/enhanced/trained result becomes a new asset; never overwrite a source silently.

The target planner is import/reference → prompt → generate → inspect/compare → edit → enhance → assemble → export. Stages must support mix-and-match where their typed media/model constraints allow it. Edits create revisions and invalidate downstream dependents only; running submissions stay immutable. Shared scheduling starts conservatively serial; concurrent GPU work requires measured budgets. Persistent projects, restart recovery and the full planner remain implementation work, not assumptions about today's queue.

## 8. Safety and auditability

- Plan read-only, authorize the exact immutable operation explicitly, revalidate at execution and publish outputs atomically without clobbering existing files.
- Only start/stop/update app-owned environments/processes. Never restart a user's service or alter an external ComfyUI installation to make verification pass.
- Treat paths, archives, URLs, metadata, workflows and plugins as untrusted inputs. Bound memory/bytes/time, constrain roots/origins, reject traversal and unsafe redirects, use argv instead of shell interpolation, and keep secrets out of logs/frontend/presets.
- Downloads need integrity evidence, dependency/version identities and applicable license consent. A downloaded workflow does not authorize execution. Preserve third-party notices; check redistribution and model/SDK terms separately.
- Log effective settings, versions, capability decisions, job identity and actionable errors without credentials. Never fabricate progress, readiness, benchmarks or tests.

### Shared logging for every plugin and implementation

- Every plugin, feature and integration MUST route its operational diagnostics, warnings and errors through the **host application's shared logging service**. Private plugin-only logs, browser console output or terminal output alone do not satisfy this requirement.
- In DEAS, React/TypeScript feature errors, Rust operations and managed worker/backend diagnostics MUST reach the central Logs view through the existing bounded native logging path. Frontend error forwarding must use a narrow, validated IPC boundary; it must not grant arbitrary file/log writes or bypass redaction and size limits.
- ComfyUI integrations MUST use the target ComfyUI/Python logging mechanism. When DEAS owns that backend, its diagnostics must also be captured by DEAS. Other host applications use their own logging facilities and adapter boundaries; this rule does not authorize attaching to, changing or adopting a foreign service.
- Entries MUST identify the originating plugin/component, severity and operation, plus job/request identity when available. Preserve useful error causes and bounded stack/process diagnostics without credentials, authorization headers or unnecessary sensitive prompt/media data. Retain the true origin when forwarding worker/backend errors.
- User-facing errors complement logging; a toast, inline message or rejected promise does not replace a diagnostic entry. Do not swallow failures or report success after failure. Expected cancellation is a separate outcome, not an error by default.
- Repeated polling/retry errors MUST be deduplicated or rate-limited while preserving the first cause, recurrence information and recovery/terminal outcome. Avoid logging the same propagated failure independently at every layer. Keep buffers and payloads bounded; logging failures must not cause recursion, block the UI or conceal the original failure.
- Each integration MUST test representative validation, execution, transport and worker failures as applicable, proving they reach the correct host log with origin/severity/correlation intact and secrets excluded. Test cancellation and repeated-error behavior too; a console assertion alone is not shared-log acceptance.

These are mandatory implementation/acceptance requirements, **not a claim of complete existing coverage**. The current source/level-filtered Logs view is a foundation; per-plugin structured context and end-to-end error coverage still require an audit. See [Logs](LOGS.md).

## 9. Documentation ownership and README scope

- Every user-facing feature, plugin and tab MUST have maintained user documentation under the repository-root `docs/` directory (`../docs/` relative to `src/`), with a discoverable page or clearly named section. Do not write documentation outside the repository based on a caller's working directory.
- Feature/tab documentation MUST explain purpose, prerequisites/dependencies, installation or activation, normal usage, controls/defaults, inputs/outputs, supported platforms/backends/models, important limitations and troubleshooting. Include relevant screenshots/assets and related-guide links; distinguish implemented behavior from planned or unverified capabilities.
- New or changed features/tabs are not done until their documentation and navigation links are updated in the same change. Shared guides may cover related tabs, but every tab must have an explicit entry; avoid duplicating the same instructions across pages.
- Maintain dedicated **changelog, news and credits documents under `docs/`**: `docs/CHANGELOG.md` for versioned changes, `docs/NEWS.md` for concise user-facing release/feature announcements, and `docs/CREDITS.md` for contributors, reused projects, attribution and relevant license/source links. Preserve existing history and required third-party notices. When consolidating an existing root changelog, move its history without loss and retain a compatibility pointer; do not maintain competing copies or invent release entries/credits. These documents are now indexed from `docs/README.md`; keep their roles distinct and their content evidence-based.
- The root `README.md` MUST stay brief: project overview, essential installation/start instructions, a small set of representative assets, and links into `docs/` for features/tabs, detailed setup, dependencies, troubleshooting, changelog, news and credits. Detailed feature manuals, exhaustive controls/support tables, planning and release histories belong in `docs/`, not the README. When moving content, preserve the information in the linked destination and fix inbound links/assets.
- Verify relative links, section anchors and asset paths after documentation changes. Document only behavior supported by source/evidence; attribution does not replace checking reuse/redistribution permissions.

## 10. Definition of done

Before implementation, inspect callers, fixtures, config, exports, permissions and migrations. Deliver the smallest complete change, not a stub or speculative framework.

For changed executable behavior: focused regression tests, relevant full suites, Rust formatting/lints, frontend typecheck/build, actual changed-path execution and failure/cancellation checks. Cross-platform code requires corresponding CI/build checks and explicit target-runtime evidence or a stated outstanding gate.

Performance is a release gate: measure a reproducible before/after workload where behavior changes, recording hardware/OS/driver, model/runtime versions, settings, warm/cold conditions, latency/throughput and peak RAM/VRAM as applicable. UI/shared-service changes also check idle CPU/memory and responsiveness. A benchmark not run remains unverified; neither unit-test speed nor upstream marketing establishes inference performance.

Update the consolidated plan with evidence and remaining work. Keep implementation, static validation, fixtures, native interaction, real model quality/performance and Windows/Linux acceptance separate. Documentation-only changes require link/content/diff checks, not costly model runs or a version bump. Commit/push/release only when requested.
