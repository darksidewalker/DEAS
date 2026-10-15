# Native installer port — M2 architecture

## Decision and scope
The Go DaSiWa installer is a read-only source of behavioral and compatibility rules. DEAS ports these capabilities into its Rust engine. There is no bundled Go executable, external installer app, sidecar protocol or Go server. Python/PyTorch and scoped tooling such as uv remain required runtime tools; this does not make the installer an external application.

ComfyUI is the baseline. Director is one explicitly selected package including Prompt Forge, RefMods, Continuity and Output. Included features are passive microbubble labels, not separate optional selections. Recommendations use labels only, without connection lines or automatic activation. The optional guided flow requires confirmation before progression; automatic-first setup uses one editable summary and final Start install authorization. Native plans expand Director into its included provisioning feature IDs before the separate installation consent. Package inclusion does not prove runtime readiness. Successful approved installation reveals the studio automatically, with no separate component enable step. Backend start remains explicit; native running status hands its exact endpoint to the studio automatically, without inspection/submission or a generation-ready claim.

## Execution-only runtime

DEAS owns all feature selections, input controls, media references and result presentation/export. ComfyUI receives dynamically compiled jobs through a verified SDK/API adapter and executes them. No embedded node editor, node widget forms or custom-node preview panels supply the DEAS UX. Computational nodes may remain internal recipe implementation details. See [EXECUTION-CONTRACT.md](EXECUTION-CONTRACT.md) for endpoint binding, SDK beta/proxy constraints, classic fallback, assets/jobs, isolation and the next installer/lifecycle gates.

## Native boundary
Tauri exposes narrow native commands for immutable plan creation, explicit confirmed start, bounded status and cancellation. The frontend cannot submit arbitrary shell commands or executable paths. Native code validates every request independently of TypeScript.

An approved plan fixes the target, backend/runtime selection, ComfyUI reference, selected capabilities and installer options. Starting references a native stored plan ID. One active installation is allowed; cancellation applies only to processes owned by this job. No boot-time installation, package upgrade, deletion or service shutdown.

## Safety and execution
- App-owned runtime and environments only; no global pip, system Python replacement or unapproved sudo.
- Execute argument arrays directly, never interpolated shell scripts.
- Git must be noninteractive (`GIT_TERMINAL_PROMPT=0`).
- Validate absolute targets and refuse unsafe roots, traversal, symlinks and unknown nonempty directories.
- Do not port the Go installer's destructive wipe mode as a default. Repair/update require a separate ownership-aware contract.
- Verify downloaded executables before execution. Keep tool source/version and digest observable.
- Required failures abort completion. An unsupported selected option prevents execution, never silently disappears.
- Mark installed runtime separately from API readiness, GPU computation, required node/model availability and actual generation acceptance.

## Go capability port ledger
The native baseline implementation is under development; check source/tests and `docs/VERIFICATION.md` for verified coverage. Nothing in this ledger is a claim of completed parity.

| Go capability | Native acceptance target |
| --- | --- |
| uv bootstrap and managed Python | Scoped tool/runtime paths; verified downloads; no global mutation |
| ComfyUI clone/reference selection | Noninteractive Git, validated reference, recorded revision |
| Venv and requirements | uv-based environment and explicit interpreter; fail required dependencies |
| Torch vendor selection | Port proven CPU/NVIDIA/AMD/Intel rules; no guessed fallback vendor |
| CUDA/ROCm ABI constraints | Preserve supported interpreter/Torch/audio/vision/kernel constraints |
| Sage/Radial/Flash attention | Explicit opt-in and hardware gates; compiled ABI/import verification |
| FFmpeg | Scoped media tool provisioning and functional executable test |
| Custom nodes | Required nodes resolved from selected capabilities, not all nodes unconditionally |
| Optional workflows/models | Explicit choice, license consent, integrity and resumable downloads |
| Final runtime checks | Exact framework metadata and synchronized device computation |
| Launchers/backend lifecycle | Track only app-owned processes; leave unrelated services untouched |
| Cleanup/repair/update | Ownership-aware maintenance with rollback, never implicit wipe |

Unsupported areas stay visible as blockers or pending capabilities until their real implementation is verified.

## Languages and suggested relationships
Translation resources live with their module, using stable string keys. Validated language manifests describe data-only UX plugins. Switching language changes text without changing stable feature IDs, edge IDs, saved choices or native plans. Fallback must be deterministic and missing keys testable.

Suggested metadata renders translated badges only, never connection lines. NeuralPath and its motion/reduced-motion behavior remain for hierarchy connections. A recommendation is not an install dependency or consent.

## Verification contract
Exercise the native runner with real safe scratch processes and local Git fixtures. Do not substitute mocked installer success for a working execution path. Full Torch/model installation is a separate explicitly scoped integration run due to download size and hardware requirements. Browser and native rendering checks cannot alone prove installation or GPU readiness. Test all shipped target platforms before claiming parity.
