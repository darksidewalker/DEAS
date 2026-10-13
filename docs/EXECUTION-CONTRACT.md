# DEAS execution-only backend contract

## Product decision

DEAS owns the entire product interface: feature/package selection, model and VAE pickers, prompts, reference media, RefMods, continuity controls, timelines, settings, validation, queue presentation, progress, previews, playback and exported results. ComfyUI is an execution service, not the studio interface. Do not embed its web editor, node widgets, custom-node HTML/JavaScript panels or node-side upload/preview UI.

ComfyUI may still execute built-in/custom computational nodes internally. A computational node is an implementation detail of a recipe, not a DEAS feature or its visual control. The DEAS graph describes feature ownership, not a mirrored ComfyUI execution graph. Required-node introspection diagnoses backend compatibility; it must not generate the product UI from node input/widget definitions.

## Boundaries

| Layer | Owns | Does not own |
| --- | --- | --- |
| React DEAS UX | Authoring, selected settings, media references, validation presentation, job controls, output viewer | Backend filesystem paths, arbitrary shell commands, node editor controls |
| Domain recipes | Versioned feature intent, typed inputs, semantic defaults, required models/capabilities, deterministic compilation | HTTP clients, widget/canvas state, backend-dependent UI labels |
| Native assets/jobs | Explicit file access, upload/export, validated paths, transport, scoped process ownership | Inferring consent or editing unrelated environments |
| Comfy SDK/API adapter | Capability negotiation, input handles, graph submission, job identity, progress/status, typed failures, output handles | Studio selections, implicit cloud endpoints or default credentials |
| ComfyUI/Python | Model computation, graph execution, backend-side temporary input/output storage | DEAS authoring state, user-facing feature controls or result presentation |

Internal node savers/loaders may be needed to compute and transfer files. Their widgets and previews are not exposed as DEAS UX. DEAS owns input selection and final output destinations; returned backend asset references are validated and transferred into app-owned project/output storage before exporting or playback.

## API and SDK decision

Prefer a first-party SDK/API contract behind a narrow adapter, not imports from the ComfyUI frontend. The official SDKs are external clients: Python `comfy-sdk` and TypeScript `@comfyorg/sdk`, currently documented as beta `0.1.x`. They cover assets, API-format graph submission, execution, outputs, errors and cancellation; model-library management and node introspection are outside this first SDK surface.[1]

Self-hosted API v2 currently requires the documented `comfy-api-proxy` alongside ComfyUI during beta. Do not assume installing core ComfyUI automatically provides v2. Do not silently add this process or a cloud dependency to provisioning. Evaluate/pin its versions, ownership, authentication, resources and stop behavior before offering it as an explicitly planned managed runtime component.[1][2]

The official SDK chooses its base URL through `COMFY_BASE_URL`; leaving it blank defaults to Comfy Cloud. DEAS must bind an explicitly validated local/selected endpoint before constructing a client, and fail closed when none is set. No automatic cloud fallback, account creation, credential request or paid-service use.[1]

Capability negotiation selects the v2 SDK/API adapter only after a real compatible endpoint probe. For directly installed core ComfyUI without v2, retain a separate documented classic HTTP/WebSocket adapter; its existing `/prompt`, `/history`, `/ws`, upload and view routes remain available.[2][3] The domain job contract and UI must not change when adapters change. Negotiation must distinguish an absent optional API from authentication errors, HTML redirects, malformed responses and incompatible versions rather than silently hiding failures.

For v2, polling is the authoritative status/output view; live SSE events enhance progress but cannot serve as the durable result store.[2] The classic adapter must correlate progress/history with its own prompt/client ID and recover results after reconnect. Never display fabricated progress or treat a successful HTTP submission as successful computation.

## Dynamic execution path (compiler foundation implemented; execution pending)

1. UX creates a versioned feature intent from DEAS-owned inputs/settings.
2. Recipe validation checks required parameters, models, capability/node versions, media constraints and licenses. Missing prerequisites block Run without claiming readiness.
3. A deterministic recipe compiler creates an API-format execution graph dynamically. Node IDs, links and class types are internal to the adapter/compiler; no node widgets or editor canvas are mounted.
4. Native asset handling uploads only explicitly selected files and resolves returned asset handles into recipe inputs. Never forward arbitrary host paths or auto-download arbitrary URLs.
5. A user Run action submits the compiled graph through the negotiated SDK/API adapter. Persist client/job/prompt identity and the exact recipe/version/input choices for traceability.
6. Correlated status/progress/errors update the DEAS queue. Cancellation is job-scoped; classic global `/interrupt` or queue-clear operations must never affect unrelated/shared-backend jobs. If isolation cannot be proven, expose the limitation rather than silently interrupting everything.
7. Validate completion and collect only that job's outputs. Safely resolve returned names/handles, verify media type/size and download without traversal, foreign host redirects or server-side path assumptions.
8. DEAS displays/plays results, preserves generation metadata, and exports through its own output controls. ComfyUI node previews and savers are not the UX.

## Installer continuation and readiness

Provisioning, backend service lifecycle, API compatibility, recipe readiness and generation acceptance are distinct states. `generationReady:false` remains until a real recipe successfully executes with its required models and computational nodes.

The implemented native lifecycle permits explicit app-owned backend start/status/stop only after successful approved provisioning. No auto-start on mount, no adoption of an existing listener, no arbitrary target paths, no stop/restart of external services. Bind loopback, use the approved managed interpreter/backend selection, disable ComfyUI browser auto-launch, and require real bounded API responses before reporting the service running. On app exit stop only this app's owned child/process group.

A local process/HTTP fixture proves lifecycle and protocol checks, not a full newly installed ComfyUI/PyTorch stack. Full installation and model execution remain separate explicitly authorized acceptance runs.

## Implementation ledger

- [x] React/Tauri feature UX and read-only ComfyUI inspection exist (`src/lib/comfy.ts`, `src-tauri/src/lib.rs`).
- [x] Native immutable provisioning plans and separate install consent exist (`src-tauri/src/install.rs`).
- [x] Document execution-only ownership and SDK/API selection constraints.
- [x] Explicit owned backend lifecycle, localized frontend actions and process/API failure regressions (real local-process/HTTP fixtures plus mocked UI IPC; no full ComfyUI stack acceptance).
- [x] Read-only native API negotiation with explicit endpoint, real HTTP fixtures and localized desktop action; no cloud default.
- [x] Pure versioned diagnostic checkpoint text-to-image compiler; supplied capability/model allowlists, strict validation and deterministic immutable graph.
- [x] Native read-only diagnostic recipe-prerequisite discovery and DEAS-owned compile preview; HTTP/IPC fixtures verified, not architecture/model-load or generation acceptance.
- [ ] Complete capability-negotiated SDK/classic execution adapters.
- [ ] Versioned recipes and dynamic API graph compilation from UX intent.
- [ ] DEAS-owned input/output assets, job correlation/cancellation and result playback/export.
- [ ] A real Director recipe accepted on a newly provisioned compatible backend.

## Verification targets and likely files

- `src-tauri/src/backend.rs`, `install.rs`, `main.rs`, `permissions/backend.toml`, `capabilities/main.json`: owned lifecycle, successful-install authorization, canonical paths, loopback identity, real child exit/timeout/stop and app shutdown tests.
- `src/components/setup/AiOSetup.tsx`, setup locales/tests, `src/lib/setup.ts`: explicit backend controls only following actual successful provisioning; start/status/error handling, no generation claim or automatic foreign-service action.
- Future `src/lib/execution.ts` and `tests/execution.test.ts`: typed job/domain contract and deterministic recipe compiler; validate inputs and unknown capability/model failures before submission.
- Future native API/asset adapter modules: exact endpoint binding, bounded JSON/media access, correlated jobs and isolated cancellation with HTTP fixtures.
- UI/browser tests: all controls and outputs are DEAS-owned, no embedded editor/network navigation to ComfyUI `/`, no submission without explicit Run; preserve stable selection geometry and content-anchored confirmation.
- Gates: `npm run typecheck`, `npm test`, `npm run build`, Cargo test/clippy/fmt/release; targeted browser checks and real native rendering. Fixture passes must be labelled as fixture evidence.

## Sources

[1] https://docs.comfy.org/development/api-development/sdks
[2] https://docs.comfy.org/development/api-development/sdks-design
[3] https://docs.comfy.org/development/comfyui-server/comms_routes
