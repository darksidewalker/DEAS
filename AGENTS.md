# DEAS contributor instructions

Read [project rules](docs/PROJECT-RULES.md) before changing this repository. They define the Rust-first, Linux/Windows, atomic-plugin and reuse requirements.

Read [the consolidated implementation plan](docs/IMPLEMENTATION-STATUS.md) for current priorities and done/partial/missing states. Older checklists are historical inputs, not competing current task lists. Read the relevant implementation and tests before accepting a historical completion claim.

For any ComfyUI integration, also follow [the project-local ComfyUI rules](docs/COMFYUI-RULES.md) and [execution ownership](docs/EXECUTION-CONTRACT.md).

Every feature/plugin/tab requires maintained user documentation in repository-root `docs/`, updated with its implementation. Keep changelog, news and credits in dedicated documents there. The README is only a brief overview, essential installation/start instructions, representative assets and links to the detailed docs; follow the documentation section of the project rules.

Keep changes scoped. Preserve unrelated working-tree edits, user media and external services. Do not commit, push, download model weights, run costly training or restart a user's service without authorization. Documentation-only work does not authorize implementation changes or a version bump.
