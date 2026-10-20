# DEAS contributor instructions

Read [project rules](docs/PROJECT-RULES.md) before changing this repository. They define the Rust-first, Linux/Windows, atomic-plugin and reuse requirements.

Read [the accepted product/architecture decisions](docs/PRODUCT-DECISIONS.md) for the binding target contract and first image-project milestone, and [the consolidated implementation plan](docs/IMPLEMENTATION-STATUS.md) for current priorities and done/partial/missing states. Decisions are not implementation evidence; do not resume an older video-first priority or expand integrations ahead of the accepted milestone. Older checklists are historical inputs, not competing current task lists. Read the relevant implementation and tests before accepting a historical completion claim.

For any ComfyUI integration, also follow [the project-local ComfyUI rules](docs/COMFYUI-RULES.md) and [execution ownership](docs/EXECUTION-CONTRACT.md).

Every feature/plugin/tab requires maintained user documentation in repository-root `docs/`, updated with its implementation. Keep changelog, news and credits in dedicated documents there. The README is only a brief overview, essential installation/start instructions, representative assets and links to the detailed docs; follow the documentation section of the project rules.

Every plugin/integration must send diagnostics and errors to its host application's shared logging service: DEAS's central Logs for frontend/native/managed-worker paths, ComfyUI's logging for ComfyUI integrations. Include origin, severity, operation and job identity where available; redact secrets, distinguish cancellation, rate-limit repeated failures and test delivery. See [the logging contract](docs/PROJECT-RULES.md#shared-logging-for-every-plugin-and-implementation); complete existing coverage is not assumed.

If an integration needs changes in another project, use a separate upstream PR or that project's equivalent review process where applicable, with explicit authorization. Preserve its standalone behavior and other consumers; test both projects and document the exact required revision and PR status. Do not silently patch installed dependencies or treat a merged PR as an installed release. See [cross-project rules](docs/PROJECT-RULES.md#cross-project-changes-and-upstream-pull-requests).

Keep changes scoped. Preserve unrelated working-tree edits, user media and external services. Do not commit, push, download model weights, run costly training or restart a user's service without authorization. Documentation-only work does not authorize implementation changes or a version bump.
