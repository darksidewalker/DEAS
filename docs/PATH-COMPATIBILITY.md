# Windows and Linux path compatibility

[Documentation index](README.md) · [Development](DEVELOPMENT.md) · [Verification](VERIFICATION.md#windowslinux-path-audit-0149)

## Path contracts

DEAS distinguishes native filesystem locations from backend identifiers and URLs. ComfyUI's `folder_paths.py` belongs to ComfyUI, not this repository; it was inspected read-only at revision `b1a247c9cf9dbfda4b2c0a0c1d50950667eeaa0c`.

- **Model identifiers:** discovery, Library, project checkpoints and recipe compilation preserve the exact identifier returned by the backend, including Windows backslashes. Both separator forms are validated for traversal; allowlist matching remains exact. No normalization silently substitutes one model for another.
- **Input/upload/reference names:** portable slash-separated relative names remain distinct from model identifiers. Local Windows drive/UNC locations are converted only when deriving a relative reference under the selected root. Sibling roots and traversal are rejected. Literal backslashes in Linux filenames are not reinterpreted as directory boundaries; files that cannot be represented safely as a protocol reference are skipped instead of aliased.
- **Output descriptors:** safe Windows subfolders from job history remain unchanged in backend requests. Local display/move matching recognizes native separators. Submitted intent is not rewritten when a result moves to Starred.
- **Filesystem operations:** Rust remains authoritative for canonical identity, containment, symlink/reparse checks and no-clobber writes. Frontend helpers are lexical display/matching helpers, not filesystem authorization. Explorer receives Windows-friendly canonical paths. Local GGUF IDs convert only the host's native separator.
- **Executable discovery:** PATH uses the platform parser; Unix Git candidates must be executable files. Managed Python and uv retain their existing Windows/Linux executable layouts.
- **URLs, archives and templates:** HTTP/Vite module URLs, portable archive entries and output-prefix templates keep their own slash grammar. Forward slashes accepted by native Windows filesystem APIs are not a bug by themselves.

No saved-folder migration, dependency addition or automatic backend restart is required. Existing exact model selections must match the backend that will execute them; moving a draft between differently named model libraries still requires explicit selection.

## Builds and developer tools

`build-linux.sh` and `build-windows.cmd` resolve one absolute `CARGO_TARGET_DIR` shared by Cargo, Tauri and staging; the default remains `src-tauri/target`. Relative overrides are resolved after entering the checkout. The Windows launcher uses `pushd`/`popd` for UNC checkouts and restores the caller's directory.

Portable verification tools read and write repository/fixture text as UTF-8. SQLite validation closes handles before scratch cleanup/replacement, which matters on Windows. Scratch diagnostics do not require the Unix `TMPDIR` variable.

Offline graph validation no longer assumes an author's checkout or model configuration. Use the selected ComfyUI environment's Python and supply all paths explicitly:

```text
python tools/validate_video_graphs.py graphs.json --comfy-root "path to ComfyUI" --extra-model-paths-config "path to deas-models.yaml"
```

Paths are resolved before entering ComfyUI's checkout. This tool imports core/custom nodes and validates graphs on CPU without starting a listener; it needs FFmpeg and an existing input image to create its temporary video fixture. It does not prove model inference or node import side-effect freedom.

Linux GTK/WebKit, X11 drag/framebuffer, vendored GStreamer and pinned Linux resolver probes explicitly reject unsupported hosts rather than claiming Windows coverage. Forge-data export retains Linux/bubblewrap isolation. Wheel-metadata diagnostics deliberately target Linux wheels. Historical verification records and mocked POSIX paths are evidence/fixtures, not runtime defaults to rewrite.

## Acceptance limits

Cross-platform regression fixtures cover native model IDs, traversal/absolute-path rejection, drive/UNC and mixed-separator media references, root boundaries, trailing separators, output moves, Unicode/spaces, SQLite URI escaping and script staging. Linux native tests, frontend suites, Windows MSVC library/test cross-checks and executable cross-linking are recorded in the verification journal.

A Linux-hosted cross-build does not run Windows filesystem APIs, Explorer, WebView2, the batch launcher or the NSIS installer. Real Windows runtime acceptance, Windows long-path/reparse behavior and network-share execution remain open; ignored GPU/live-service tests are not run by this audit. No user services or external ComfyUI files are changed.
