# DEAS ComfyUI integration rules

Project-local adaptation of the `comfyui-dev` skill, reviewed for this documentation change. These rules are deliberately stored in the repository: contributors do not need access to the author's Hermes skills. This is the applicable project ruleset, not a claim that all existing adapters already comply. Read with [PROJECT-RULES.md](PROJECT-RULES.md) and [EXECUTION-CONTRACT.md](EXECUTION-CONTRACT.md).

## 1. Inspect the real target

Record the exact ComfyUI/nodepack/frontend revision, Python/PyTorch versions, launch flags, minimum supported versions and platforms before implementation. Identify V1, V3 SDK, routes, frontend hooks and graph expansion separately. Inspect analogous installed core code first, then matching upstream source and official documentation. Never invent a moving API or infer model capability from an old assumption.

Check actual source symbols and model/header evidence when determining channels, resolutions, audio or architecture support. Discovery and `/object_info` establish schema/identity, not successful loading or inference. Optional imports must remain lazy and capability probes must not allocate models or initialize a GPU.

## 2. Collision-free identity and coexistence

- New DEAS-owned node registration IDs MUST use a reserved `DEAS_` prefix (for example `DEAS_AssetPublish`). New frontend extension IDs must use `deas.<feature>`; new server routes must live under `/deas/<feature>/...`. Namespace custom socket types, shared browser events, storage keys and temporary module names where globally visible.
- Preserve existing DaSiWa/core/third-party IDs when consuming those nodes; reference them rather than re-registering, aliasing over, or replacing them. Preserve already serialized DEAS IDs unless an explicit migration handles older workflows.
- Use package-relative Python imports and module-local helpers; never inject generic `nodes`, `utils` or other pack names into `sys.modules`/`sys.path` to shadow imported nodes. Give exported cross-module functions descriptive domain names. Class-local methods such as `execute` do not collide across classes and need no ceremonial prefix.
- Before adding a registration/route/extension, inspect the target for duplicate identity. Duplicate ownership must fail clearly rather than last-import-wins replacement. Friendly display names may omit a prefix; internal IDs must remain unique.
- Do not monkey-patch global core classes, executors, savers or another pack as a normal integration mechanism. Prefer public hooks and explicit inputs. Any unavoidable existing patch needs narrow opt-in scope, feature detection, idempotence, teardown where possible, unchanged standalone behavior and coexistence tests. This is a requirement to audit existing adapters, not proof they are patch-free.
- Verify own and other packs' `/object_info` entries and `python_module` values together in one isolated instance, plus served extension names/assets. A successful isolated import alone cannot detect a registration collision.

## 3. Preserve workflow ABI

Treat node registration IDs, input names/types, widget order, socket positions and output order as public serialized API. Append rather than reorder; keep legacy serialized slots when hiding controls. Preserve false toggles and distinguish an absent value from an explicit value. Version and validate JSON state, including nested fields, and test old/new workflow reload and API export.

Keep existing V1 interfaces unless a justified migration is approved. For new V3 work, verify the actual `comfy_api` generation, `ComfyExtension`, node schema and entrypoint from the target installation. Do not combine V1 and incompatible V3 examples or assume `latest` is stable across versions.

## 4. Native execution and graph semantics

Reuse public core nodes/functions for existing operations rather than recoding decode, normalization, resize or save behavior. Test forwarded arguments against concrete signatures. Keep native functions' validation, interrupt checks, cache behavior and stateful writer semantics.

Understand linked/lazy/list inputs, batch mapping, hidden inputs, bypass and compiled prompt semantics. Optional stages must route the last active media explicitly; bypass through IMAGE→LATENT→IMAGE is not a safe media router. Muted/bypassed branches must not cause downstream savers to error or emit unintended artifacts. Validate effective execution, not just canvas links or a saved output preference.

Do not defeat caching with random change keys. External mutable data needs supported change detection; linked inputs may be unavailable during V1 cache-key calculation. Do not mutate cached upstream contexts. List outputs are not bounded streaming: long videos require bounded acquisition and processing as well as encoding. Check interruption inside expensive frame/tile/stage loops and before final publication.

## 5. API-mode first; UI optional

Core computation must work without browser JavaScript where practical. Carry execution state in serialized inputs/outputs rather than custom DOM-only values. Avoid extra routes if graph data flow solves the requirement.

For frontend extensions, use current public lifecycle/hooks/widgets, feature-detect Nodes 2.0 versus classic behavior and clean up listeners/resources. Keep presentation in JS and computation in the backend. Native-style model selectors remain clean socketless combos where appropriate. Fixed-column custom panels must not reflow when a node resizes. Every user-facing control needs useful tooltip/accessibility help covering units, active modes and ignored controls.

Studio must not mirror ComfyUI widgets. Its controls express user tasks and versioned intent; the explicitly separate Comfy tab may expose the original editor with no DEAS native IPC authority.

## 6. Routes, imports and trust boundaries

Add routes only when normal graph execution is insufficient. Validate payload shape, constrain paths to allowed roots, reject traversal, use real HTTP errors, bound responses and move blocking work off event loops. Never accept arbitrary shell commands, unsafe deserialization, `eval`/`exec` or unrestricted dynamic imports from workflows. Never log tokens or embed credentials in workflow/catalog data.

Keep import-time code lightweight and compatible with the declared minimum Python of the distributed nodepack. A pack intended for Python 3.10 environments cannot unconditionally import 3.11-only stdlib modules such as `tomllib`, even if DEAS's own managed environment uses 3.12. One transitive import failure can hide every node. Optional SDKs must not break unrelated nodes; unsupported explicit requests fail clearly instead of silently degrading.

Declare minimal runtime dependencies and check current Registry/Manager packaging guidance before distribution. Do not bundle models, caches, credentials, local paths or runtime-generated files. Retain attribution/licenses and independently review proprietary/gated SDK redistribution.

## 7. Model/media correctness

Keep per-family dimension/frame/fps/audio rules centralized and exact. Preserve conditioning, reference ordering, audio/video bridges and model-specific defaults. Never silently choose another model or drop references to make a run succeed.

For video, retain validated media descriptors (`filename`, `subfolder`, `type`), timestamps, audio alignment, color and alpha requirements. Bound decode/process/encode memory. Verify the written file by decoding it; setting a codec/pixel-format flag does not prove alpha, timing or quality. Distinguish safe spatial post-processing from unsupported temporal changes. Publish new outputs atomically only after verification and a final cancellation check.

## 8. Acceptance gates

1. Syntax and focused unit/contract tests, including old serialized state, explicit false values, missing optional dependencies and malformed input.
2. Real import/schema checks with the actual target interpreter; `main.py --help` exits too early to prove custom-node imports.
3. Isolated API-mode graph validation and relevant CPU operations; coexistence with other installed packs and correct module/asset ownership.
4. Real frontend loader/queueing/interaction checks when JS changes, including supported classic/Nodes 2.0 behavior. Chromium is not WebKitGTK/WebView2 acceptance.
5. Real model/GPU execution, numerical/media quality, cancellation, resource measurements and Linux/Windows target checks where the feature requires them.

Use an isolated loopback instance with unique pack names and correct model paths. Never restart the live user service. Stop only the recorded owned process/group; no `pkill -f` patterns. Confirm the checkout actually served by the runtime before diagnosing stale assets. Label each evidence level honestly and retain unresolved gates in the consolidated plan.

## Public references

- [ComfyUI developer documentation](https://docs.comfy.org/development/overview)
- [Custom node development](https://docs.comfy.org/custom-nodes/overview)
- [Server communication routes](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [SDK/API documentation](https://docs.comfy.org/development/api-development/sdks)

Public links are discovery entry points, not pinned compatibility evidence. Match APIs to the actual target source before implementation.
