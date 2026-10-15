# Resume DEAS development

## Stopping boundary

The diagnostic PNG preview/new-file export slice (0.1.5) is finished and independently verified. Work is stopped at this boundary. Do not begin cancellation, model downloads, restart adoption or further installer/backend features in this session. The owner explicitly requested a clean stopping point for later continuation.

The accumulated work is local and uncommitted. Do not reset existing changes, publish or push without a new explicit request. The current source of truth is `docs/PLAN.md`; verification evidence belongs in `docs/VERIFICATION.md`.

## Implemented preceding slices

- Successful approved native installation reveals the studio automatically; Director companions require no second enable step.
- Explicit owned backend start binds its actual endpoint to the studio automatically. No automatic inspection, foreign-service adoption or generation-ready claim.
- Native diagnostic intent preparation, immutable consented one-shot classic submission, prompt/client/graph-correlated status, and explicit read-only current-session job recovery after panel navigation.
- Previous real new CPU/NVIDIA and selected Director installation/lifecycle acceptance is documented separately from HTTP/IPC fixtures.

## Current PNG slice acceptance

Native output retrieval must use only a succeeded current native job's indexed metadata, not arbitrary frontend paths/URLs. Fully validate bounded PNG data, keep original encoded bytes and digest, and export exactly the cached original through an explicit native Save As dialog. Cancellation is not success; existing files/symlinks/untrusted parents must remain untouched. The frontend uses revocable local Blob URLs, never remote media URLs. Non-Linux export must fail closed until equivalent filesystem safeguards are implemented.

Final gates: 48 core tests, 147 UI/IPC tests, 122 Rust tests (nine ignored); typecheck/build, Clippy/fmt and native release/rendering passed. The extended job browser suite passed six locales at five widths including actual fixture-PNG browser decode, export cancellation and explicit mocked export success. Native filesystem fixtures verified byte-identical no-clobber export. No background workers or owned verification servers remain. Check the final status in `docs/VERIFICATION.md` before continuing. Browser job/media responses are explicit IPC fixtures, not proof of real model generation. A native screenshot proves initial rendering only, not native-webview media decode or interactive Save As dispatch.

## Resume after the stop

1. Read `git status --short`, `docs/PLAN.md` and the newest `docs/VERIFICATION.md` section. Preserve all accumulated edits.
2. Re-run `npm run typecheck`, `npm test`, `npm run build`; then Cargo test, Clippy, formatting and release build using `--manifest-path src-tauri/Cargo.toml --locked` (formatting uses `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`).
3. For browser acceptance, start an owned Vite server on an explicit free port and run `tools/verify_jobs.py URL`, `tools/verify_automatic.py URL` and `tools/verify_recipe_prerequisites.py URL` using an isolated Playwright Python. Legacy UI/confirmation/help/stability scripts also exercise the original guided path; several retain port 1420 internally.
4. Next functional work is safe job-scoped cancellation or real diagnostic generation acceptance, not another enable toggle. Before a real model run, establish the exact suitable existing checkpoint or obtain model-download/license consent. Do not assume an offered checkpoint architecture is compatible merely because its filename appears in object_info.
5. Keep full installer parity, durable restart adoption, AMD/Intel/Windows acceptance, resumable setup/repair and actual Director/video recipes unchecked until independently verified. Do not stop/restart user services to make a test pass.

## Local artifact

`artifacts/deas-linux-amd64` is a system-linked Linux development binary, not a signed portable release. Confirm its current version/hash against the newest verification entry. Replace it atomically when rebuilding; do not overwrite a running executable or stop the owner's app. Browser fixture screenshots are labelled `assets/deas-jobs-fixture-*`; native initial captures have separate names.
