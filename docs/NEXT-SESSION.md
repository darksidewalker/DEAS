# Resume DEAS development

## Current boundary

The 0.1.10 source gathers persistent/verified provider authorization, checked environment reopening, default-on backend autostart with a Settings opt-out, installed-model metadata, remembered UI choices and system-language selection. It retains per-environment folders, folder alias resolution and verified no-clobber relocation (`settings_move.rs`). Windows support is merged and CI-built, not runtime-verified. The source of truth is `docs/PLAN.md`; verification evidence is in `docs/VERIFICATION.md`; per-version changes in `CHANGELOG.md`.

## Known host quirks

- The pre-existing Cargo test `backend::tests::invalid_owned_api_never_marks_running` fails on this host independent of changes.
- KDE Wayland host ignores XTest fake input: native click-through cannot be automated; native evidence is limited to initial-render screenshots of a separately launched instance.
- `npx vitest run` through the rtk wrapper writes its JSON report late; use `./node_modules/.bin/vitest run --reporter=dot`.
- Browser suites: owned Vite on an explicit free port, isolated Playwright Python at `~/.hermes/cache/scratch/deas-handoff-verify/bin/python`; suites are `verify_automatic`, `verify_downloads`, `verify_languages`, `verify_jobs`, `verify_api`, `verify_recipe_prerequisites URL`. The guided suites (`verify_ui/confirmation/help/stability`) were deleted with manual mode.
- `lib/setup.ts` still carries the guided state machine for core tests and the `existing` plan route — delete it only together with its tests.

## Next functional work (in order)

1. Safe job-scoped cancellation, then real diagnostic generation acceptance. Before a real model run, establish the exact suitable existing checkpoint or obtain model-download/license consent; a filename in object_info is not architecture compatibility.
2. Director/video recipe vertical slice: versioned intent → native compile → correlated submission → verified outputs (see `docs/EXECUTION-CONTRACT.md`, PLAN M3).
3. Real hardware/GPU restart acceptance for the checked reopen/autostart path; saved drafts alone never authorize environment adoption.
4. Relocation acceptance beyond Linux, resumable downloads, real authenticated provider/vault acceptance.
5. Windows runtime acceptance on actual hardware.

Keep full installer parity (AMD/Intel, FFmpeg, attention extensions), real GPU restart acceptance, resumable setup/repair and actual Director/video recipes unchecked until independently verified. Never stop/restart user services to make a test pass.

## Local artifact

`artifacts/deas-linux-amd64` is a system-linked Linux development binary, not a signed portable release. Re-stage it atomically with `./build-linux.sh` after every release build and print its SHA-256; a running app keeps the old inode, so the owner must quit and relaunch. Browser fixture screenshots are labelled `assets/deas-jobs-fixture-*`; native initial captures have separate names.
