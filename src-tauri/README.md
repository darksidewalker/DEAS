# DEAS desktop shell

Tauri 2 embeds the React production output from `../dist` in a native binary named `deas`. Rust owns the native provisioning orchestration directly; no Go installer sidecar is launched. Existing ComfyUI connections remain read-only. The native installer is a limited Linux x86_64 CPU/NVIDIA baseline, not full Go-installer parity.

## Verify and build

From the repository root, build the frontend first with `npm run build`. Then:

```sh
export CARGO_TARGET_DIR="$HOME/.hermes/cache/scratch/deas-target"
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
```

The native executable is `$CARGO_TARGET_DIR/debug/deas`. A desktop session, WebKitGTK 4.1 and GStreamer `good` plugins (`gst-plugins-good`; WebKit aborts on media without `autoaudiosink`) are needed on Linux. Before GTK/WebKit initialization, the binary supplies process-local defaults `__NV_DISABLE_EXPLICIT_SYNC=1` (NVIDIA Wayland: keeps WebKit's GPU renderer from a protocol error) and `GDK_BACKEND=wayland,x11` (try Wayland, then X11). Launch the binary directly; no wrapper or exported variable is needed. Existing explicit overrides are preserved, including `WEBKIT_DISABLE_DMABUF_RENDERER=1` to fall back to CPU rendering or `GDK_BACKEND=x11`/`wayland` to force one backend. This does not force software OpenGL, change system settings or replace missing system libraries.

Tauri CLI development uses `http://localhost:1420` and `npm run dev`. Its build hook runs `npm run build` before embedding assets. Direct `cargo build` does not run that hook.

## Read-only IPC

```ts
invoke('inspect_backend', { baseUrl: 'http://127.0.0.1:8188' })
```

Returns `{ baseUrl, nodeCount, devices, missingRequiredNodes, capabilities }` with camelCase keys. Device names and node counts come only from backend responses. Required node IDs are `MiniMaxH3Director` and `MiniMaxH3DirectorGuide`. Capabilities are sorted feature keys, excluding null and explicitly false entries; no health status or inferred feature support is invented.

Only GET requests to `object_info`, `system_stats`, and `features` under the selected base path are sent. `features` 404 means no reported capabilities; other HTTP failures, invalid JSON, and malformed mandatory data return an error. A 3-second connect timeout, 10-second per-request total timeout, and 16 MiB streamed-response cap apply. Redirects and environment proxies are disabled. HTTP/HTTPS URLs only; credentials, queries, and fragments are rejected.

Local `main` window capabilities permit read-only inspection, scoped hardware/folder discovery, the read-only native installer-defaults command, the four native installer commands and the three explicit owned-backend commands. Remote-origin IPC, shell/filesystem plugins, and browser-to-backend network access are not granted. CSP restricts scripts and assets to the embedded app and permits only Tauri IPC connections.

## Read-only execution API negotiation

`invoke('native_negotiate_api', {baseUrl})` requires an explicit HTTP/HTTPS endpoint and returns `{baseUrl, protocol: 'classic'|'v2', generationReady:false, capabilities}`. It never starts a service or submits a graph. Only `allow-native-negotiate-api` grants this command to the local main webview.

Probe the documented proxy `api/v2/health`, then protected `api/v2/jobs?limit=1`; only health 404 authorizes Classic `GET prompt` fallback and `exec_info.queue_remaining` validation. Health metadata's upstream URL is never followed. Successful v2 probes establish health/listing contracts, not functioning upstream computation or all execution operations. JSON response bodies are bounded at 64 KiB; five-second request and ten-second total deadlines apply. Redirects and environment proxies are disabled. Schema pinned to official proxy source commit `1569dc17ec0dd293d4b9a0723e142204dacedb85`.

Failures reject with `{code,endpoint,message}`: invalidEndpoint, authentication, redirect, html, malformed, incompatible, http, transport, timeout or responseTooLarge. Auth/HTML/schema failures never silently become Classic success. Nine native HTTP-fixture tests verify probe behavior, paths, errors and bounds; real ComfyUI/proxy execution remains unverified.

## Native Workbench polling

`invoke('native_workbench_current')` is an argument-free, network-free session snapshot. `invoke('native_workbench_poll')` refreshes the held Workbench jobs and returns the same `{jobs, preparing, capacity:20, stopAvailable:false}` envelope. Both use the existing local-main-only `allow-native-diagnostic-jobs` permission; neither polls the exclusive diagnostic slot or accepts frontend endpoints/job lists.

Polling reuses prompt/client/immutable-graph correlation and output handling, with up to 20 concurrent status operations, each bounded by the existing 15-second status deadline (3-second connect / 10-second request limits, 1 MiB responses). Terminal/submitting jobs are skipped; missing prompt IDs remain unknown without requests. Per-job transport failures become unknown without blocking peers or evicting uncertain jobs. Overlapping aggregate polls return the current snapshot immediately, never queue another pass. An admitted pass finishes even if its IPC waiter disappears, so per-job polling flags are cleared. Polling only reads history/queue: no POST, submission retry, cancellation or automatic Run. Status/error changes use the existing sanitized shared Logs path. The frontend is not wired to these commands yet; its Run guard is unchanged and Stop remains unavailable. Loopback fixtures are not real-model or Linux/Windows webview acceptance.

## Native Workbench pending cancellation

`invoke('native_workbench_cancel_pending', {jobId, confirmed:true})` uses the local-main `allow-native-diagnostic-jobs` permission and returns the normal native job snapshot. Only a held Workbench job ID is accepted; there are no endpoint, prompt-ID, graph, token or diagnostic-slot inputs. Confirmation, busy and ownership refusals reject with a sanitized string. Missing prompt IDs stay unknown without requests. Unknown/running jobs can reconcile read-only; this call does not delete them.

For a queued job, native code requires the exact currently owned running HTTP IPv4 loopback listener, correlates its stored prompt/client/immutable graph against history/queue, and rechecks the owned lifecycle before sending exactly `POST /queue {delete:[heldPromptId]}`. Core ComfyUI's empty HTTP 200 reply is required, with a streamed 1 MiB cap; non-empty 200 acknowledgements (including HTML/JSON) are rejected rather than treated as deletion success. The existing client disables redirects, retries, environment proxies and credentials (3-second connect / 10-second request bounds); the complete operation has a 40-second deadline. Remote/proxy/authenticated endpoints are unsupported, including 401/403; no provider token is forwarded.

Same-lifecycle readback preserves running/completed transitions and successful outputs; absence receives a second history/queue read to close a completion-between-reads window. Only accepted deletion plus absent readback becomes terminal `cancelled`. Lost/rejected/oversized replies, failed correlation/readback or a lifecycle change remain `unknown`, not presumed cancelled. Once a delete is attempted, snapshots include `pendingCancellationAttempted:true`; that session-held marker survives read-only reconciliation and blocks every further delete for the job. Polling/submission and cancellation share the per-job busy guard, and admitted cancellation finishes even if its IPC waiter disappears. Sanitized shared Logs distinguish pending cancellation; refusals/uncertainty are rate-limited. This is a bounded Classic core adapter, not an atomic backend cancellation protocol or hostile same-user socket-replacement defense.

No queue clear, resubmission or whole-queue Stop is implemented. `stopAvailable` remains false and the frontend is not wired to cancellation. Real loopback HTTP fixtures cover these contracts; real ComfyUI/model execution and Windows runtime cancellation remain unverified.

## Native Workbench running interruption

`invoke('native_workbench_interrupt_running', {jobId, confirmed:true})` uses the same local-main permission and normal job snapshot as pending cancellation. The only inputs are a held Workbench job ID and explicit confirmation. Diagnostic jobs, foreign endpoints and caller-supplied graphs/prompt IDs/tokens cannot authorize it. Missing prompt IDs stay unchanged; submitting/polling or previously attempted jobs refuse. Unknown jobs reconcile read-only, pending jobs are not deleted, and completed jobs retain their products. The standalone status waiter now has a lock-disarmed RAII polling guard, so aborting it cannot strand cancellation or clear a later operation's flag.

**Core `/interrupt` is never used.** The inspected handler checks running IDs and sets its global processing flag in separate critical sections: even its targeted body can interrupt a foreign successor. Instead the existing owned-launch custom-node installation hook installs `deas_running_interrupt.py`. Its separate `POST /deas/jobs/interrupt` route holds `PromptQueue.mutex` across exact prompt/client/graph comparison and the flag set, requires a single current matching running tuple, and returns empty HTTP 200 only when signalled (409 otherwise). The inspected executor resets the flag before executing the successor. It does not monkeypatch core or modify a foreign checkout.

Support is fail-closed and limited to inspected ComfyUI revision `b1a247c9cf9dbfda4b2c0a0c1d50950667eeaa0c`: native launch captures bounded validated `server.py`, `execution.py`, `main.py` and `nodes.py` against the SHA-256 pins in `backend.rs`, plus the installed adapter hash. `server.py`'s pin is `6e3614c753c95b037e57e25dfc2de979de70136baad2a3abb5d2d32aaf05281e`. LF and CRLF checkouts are accepted through the known normalized hashes; retained raw hashes must still match before each interruption. Unknown/missing/changed sources disable this optional capability without failing backend startup. A post-launch disk check cannot acquire capability absent at launch. Arbitrary custom nodes remain trusted backend code, not a sandboxed threat model.

A fresh native-held random token is passed only to that owned child through `DEAS_RUNNING_INTERRUPT_TOKEN`, removed from its environment by the adapter at import, and sent only in the sensitive `X-DEAS-Interrupt-Token` header. It is never an IPC result, preference or log entry; provider credentials are not used. The adapter rejects browser Origin calls and missing/wrong authority. Native code additionally reuses exact owned running loopback listener/lifecycle checks before and after requests. No adoption, legacy fallback, proxy, redirect, retry or process Stop is allowed. Transport bounds remain 3-second connect / 10-second request / 40-second operation and 1 MiB streamed replies; only empty HTTP 200 acknowledges the mutation.

Before the one possible POST, native snapshots record `interruptCancellationAttempted:true` independently of `pendingCancellationAttempted`; it survives reconciliation and prevents a second ambiguous interruption. Same-lifecycle history/queue readback, including a second absent read, determines the result. An acknowledgement alone is not cancellation: only correlated terminal `execution_interrupted` history yields `cancelled`; observed running stays `running`, successful completion retains products, and disappearance without terminal proof is `unknown`. Invalid/lost replies remain diagnostic uncertainty, never permission to retry. Shared bounded/redacted Logs distinguish running interruption. Admitted operations finish if their IPC waiter disappears.

Offline verification includes real loopback protocol fixtures, standalone waiter-abort regression, and a compact Python auth/mutex race fixture. The optional source-backed CPU fixture copies only explicitly selected read-only source into scratch, launches a fixture interpreter (never imports/executes the pinned model main), exercises the actual pinned `PromptQueue` class and executor reset statement, and validates launch/source/adapter/foreign/stopped checks for LF and CRLF:

```sh
DEAS_TEST_COMFY_SOURCE=/path/to/inspected/ComfyUI cargo test --locked --lib running_interrupt_source_backed_launch_proof_and_queue_race -- --ignored --nocapture
```

No real model/GPU, live user service or Windows runtime acceptance is implied. Whole-queue coordination and UI Stop remain separate work; `stopAvailable:false` is unchanged.

## Imported H3 video preparation

`invoke('native_h3_video_upload', {baseUrl})` (local-main `allow-native-diagnostic-jobs`) opens the platform video chooser (MP4/MOV/WebM/MKV) and returns a fresh backend-relative input filename or `null` on cancellation. It reuses the reference upload transport, requires video magic bytes and a regular file ≤ 512 MiB, preserves the local original, and never prepares/selects/runs a source. The UI only fills its filename draft; Prepare and Use remain explicit. Native upload failures reach shared Logs as fixed, path/URL/body-free, rate-limited diagnostics, including the existing `native_input_upload` callers. Native chooser and Windows runtime interaction remain separate acceptance gates.


`invoke('native_h3_video_prepare', {baseUrl, filename})` uses the existing local-main `allow-native-diagnostic-jobs` permission (already granted by `capabilities/main.json`). It sends exactly `POST <base-path>/df_h3_continuity/video` with `{filename}`. The name must already exist relative to the backend input directory: nonempty, at most 4096 UTF-8 bytes, forward-slash segments only; spaces/Unicode are preserved. Absolute/drive/backslash paths, empty/dot/traversal segments, controls/NUL and `[output]`/`[temp]` suffixes are rejected before network access. This command neither reads host media nor uploads it.

Success returns only `{sourceId, filename, sha256, width, height, fps, seconds, hasAudio}`. The echoed filename must match exactly, kind must be `video`, source/digest IDs must be 64 lowercase hexadecimal characters, dimensions must be integer 1–65536, duration/rate finite and positive, and audio a boolean. No frame count is invented. IDs are opaque: DEAS does not recreate source or VAE-cache hashes. HTTP/HTTPS base-URL validation, no redirects/proxies/retries, a 3-second connect timeout, 180-second total request timeout and 1 MiB streamed response cap apply; the bounded filename also bounds the JSON request. Failures reach shared Logs through a fifth fixed cause slot (first cause and first recurrence immediately, later repeats rate-limited to a minute), without filenames, URLs, response bodies or credentials.

`native_h3_session` retains its old clip shapes unless valid root-level `provenance.kind == "imported_video"` metadata is present. Such entries additionally expose `importedVideo: {sourceId, width, height, modeFamily}` from `provenance.source_video_id`, root dimensions and `mode_family` (`fl2va`/`ref2va`). This maps the opaque prepared source to the **backend-returned** VAE-cached checkpoint `clipId`; an extension's `parent` identifies that checkpoint, not the source manifest ID. Malformed or absent imported metadata is omitted, not guessed. No provenance filename, raw metadata or host path is added.

Contract inspected read-only at DaSiWa nodepack revision `1da4fefa` (`video_source.prepare_video`, `pyav_media.probe`, `ClipStore.metadata/list_clips`). The local checkout was already newer (`fcd0ec54623c`); no dependency was modified. HTTP-fixture tests cover sanitized exact POSTs, invalid-input no-network rejection, tampering/nonfinite fields, status/redirect/response bounds, safe rate-limited Logs and old/new session shapes. Real backend hash/probe, VAE import/inference and Linux/Windows webview acceptance are not established by these fixtures.

## Image draft project IPC

The local-main `allow-native-projects` permission grants only `native_project_create({title})`, `native_project_open({title})`, `native_project_save({projectId,expectedRevision,draft})`, `native_project_import_image({title,projectId,expectedRevision})` and `native_project_close({projectId})`, plus fixed `native_project_close_notice({reason})` diagnostics (`blocked` or `unavailable`, no arbitrary log text). Create/open/import paths come from native choosers, not arbitrary frontend filesystem arguments. Cancellation returns null. `Projects` retains the active directory identity and exclusive OS writer lock; save/import require its exact identity and revision.

`ProjectSnapshot` returns `{id,root,revision,draft,input}`; disk `project.json` schema 1 omits the absolute root and stores the managed PNG reference relatively. Draft fields are strictly bounded baseline image controls; unknown manifest/draft fields and unsupported schema versions fail closed. New projects use unique `deas-project-<uuid>` children. Atomic manifest publication, bounded PNG verification/hash/copy, no-clobber media identities, root/lock identity checks and sanitized shared Logs preserve existing data. See [project usage and limitations](../docs/PROJECTS.md). The active project bar uses Tauri `onCloseRequested` to prevent normal window close during pending draft/project operations. Its allowed-close path requires the explicitly granted local-main `core:window:allow-destroy`; no remote origin or generic window permission set is enabled. Fixed close diagnostics distinguish INFO blocked-close from ERROR unavailable protection and are rate-limited per cause. This is not persistent native Jobs state, forced-exit recovery, running-computation exit consent or executed model/version provenance.

## Native directory picker

`native_pick_directory({title})` opens the actual platform directory chooser (XDG portal on Linux) and returns an existing absolute directory or `null` on cancellation. Only the local main webview may call it. It does not create a target or start provisioning. The UI selects an existing parent and specifies a new environment subfolder because the installer refuses existing targets. UTF-8 paths are returned exactly; invalid titles/paths fail explicitly. Browser mode has no fabricated native picker.

`native_forge({baseUrl,root,route:"people",body:{model,path,request_id}})` reuses the existing local-main Forge permission. The input-relative path, model and UUID are validated before forwarding; saved native LLM settings replace frontend settings. Success returns only up to 32 ordered, normalized boxes, with raw model descriptions/output removed. Failures use fixed sanitized messages and safe request-UUID correlation in shared Logs; expected cancellation is INFO. The existing cancel route is a scoped best-effort request, not proof that backend inference stopped. No global interrupt, automatic upload or model download.

`native_logs_people_image_error()` (no arguments; existing local-main `allow-native-logs` permission) forwards only a fixed, path-free `ERROR: Studio PeopleBoxes image-load` diagnostic into shared Logs, at most once per minute. It accepts no frontend log text, path, prompt or credentials. The image editor separately shows the localized failure and disables box editing; repeated image errors are deduplicated locally too.

`native_json_save({title,name,text})` / `native_json_open({title})` (permission `allow-native-json-file`) save or open one user-chosen JSON document through the OS file dialogs, e.g. DaSiWa Director reference packs. Both directions cap the document at 1 MiB and require it to parse as JSON; the suggested save name must end in `.json` without path separators. Cancellation returns `false` / `null`; nothing else is read or written.

The Linux portal dialog was independently opened, visually inspected in folder-only mode, and cancelled using the actual dialog close action; the explicit interactive smoke test passed. Tests also verify cancellation, directory/file distinction and no target creation. Windows/macOS runtime dialog acceptance remains unverified.

## Automatic recommendations (read-only)

`invoke('native_install_defaults', {})` returns `{storagePath, backend, hardware, warnings}`. The default target is a new `deas-environment` in the running executable’s parent directory, independent of the shell working directory. Existing targets are reported, not adopted, renamed or changed. Supported NVIDIA hardware/driver profiles recommend `nvidia`; failed or incompatible discovery recommends `cpu` with an explanation, not a claim of detected CPU/AMD/Intel hardware. No files, plans, downloads or services are changed by this command.

Defaults are editable recommendations, not authorization. The final Start install action must use the exact current immutable plan and explicit native confirmation. Basic defaults do not implement the roadmap’s later capability/benchmark/launch-optimization mode.

## Native provisioning IPC

```ts
const plan = await invoke('native_install_plan', { request: {
  storagePath: '/absolute/existing-parent/new-deas-environment',
  backend: 'cpu',
  features: ['installer'],
  options: { sage: false, radial: false, flash: false, ffmpeg: false },
  comfyRef: 'master',
} });
await invoke('native_install_start', { planId: plan.id, confirmed: true });
const status = await invoke('native_install_status');
await invoke('native_install_cancel');
```

- Plan returns `{id, request, steps: [{id,labelKey,detail}], warnings, unsupportedOptions, canExecute, hardware, torch}`. Planning performs local reads and, for NVIDIA, a read-only argv-based `nvidia-smi` query (5-second timeout, 16 KiB output limit); it never creates target directories or downloads. Plans are immutable in app memory, capped at 64, and consumed once. IDs do not survive app restart.
- Start accepts only a stored plan ID and explicit boolean confirmation; the caller cannot replace the planned request. It returns status immediately and starts an owned asynchronous worker. Only one native installation runs at a time.
- Status returns `{state, stepId, logs, error}`, with state `idle|running|succeeded|failed|cancelled`. The last 300 log chunks are retained (4096 characters each). Cancel requests cancellation; poll until terminal state. It affects only this worker's downloads and newly created subprocess groups, never an existing ComfyUI server.
- For a fresh installation, `storagePath` is the **new environment directory**, not an existing model/project directory. Its parent must already exist. Roots, relative paths, traversal, symlink components and existing non-DEAS targets (even empty) are rejected. Start revalidates and claims a new directory exclusively. A completed DEAS target instead produces a checked reopen preview with `reopenId`; consume it through `native_install_open({planId: plan.id, confirmed: true})`, never `native_install_start`. The exact one-time native snapshot is revalidated before approval; opening does not reinstall, update, wipe or start a backend. Persisted and selected paths are compared by canonical identity without rewriting the saved plan. Partial failed/cancelled installs remain for inspection; no automatic deletion, wipe, resume, migration or rollback is offered.
- Supported backends are `cpu` and `nvidia` on Linux x86_64. AMD/Intel and other OS/architectures are explicit blocked plans. NVIDIA requires one visible GPU; missing/failed probes, unsupported GPU families and insufficient drivers block execution with `NVIDIA_GPU`/`NVIDIA_DRIVER` messages. No fallback silently selects CPU. `sage`, `radial`, `flash` and `ffmpeg` selections block execution rather than being silently skipped. Git must be installed beforehand; no system package installer is run.
- Accepted features are `installer`, `director`, `forge`, `refmods`, `continuity`. Director selects its included Forge/RefMods/Continuity package: planning expands missing companion IDs in the immutable returned request before separate install consent. Already complete requests retain their exact order; unknown IDs are still blocked. Output is an included studio capability, not a separate native feature ID. Empty features also select only the baseline. Any of the four selected DaSiWa feature IDs fetch the DaSiWa nodepack once, from its `main` branch, and install its requirements; unknown features block execution. This does **not** install model weights, recipes or workflows or prove those features ready.
- `comfyRef` accepts a branch, tag or commit (for example `master`); URLs/options are rejected. Branch/tag revisions are resolved at execution and exact Git commits are recorded. No fallback silently replaces a requested reference.

The worker downloads official uv **0.8.22** for Linux x86_64, verifies an embedded release SHA-256, and extracts only the uv executable to `runtime/uv`. uv installs managed Python **3.12** under `runtime/python`, with local caches/config/home/temp directories and no user/system Python or PATH modifications. The venv is created at its final `venv` path. CPU retains the deliberate **Torch 2.8.0 / torchvision 0.23.0 / torchaudio 2.8.0** official CPU-index baseline (Go CPU is unpinned). NVIDIA ports Go config global/minimum 13.2 → effective **CUDA 13.0**, **Torch 2.14.1 / torchvision 0.29.1 / torchaudio 2.11.0**, official `cu130` index; Linux driver >=580 and capability >=7.5 are required. GTX 10/Pascal capability 6.0/6.1 instead selects **2.4.1 / 0.19.1 / 2.4.1**, `cu121`, driver >=525.60.13. Volta/older unsupported hardware blocks rather than receiving CUDA 13. No standalone developer toolkit or attention-extension build is provisioned; Torch wheel runtime dependencies are installed. Exact pins/index/hardware are stored in the immutable plan and reused by execution, not reselected; driver/UUID/capability changes fail before target creation. ComfyUI and node requirements receive wheel-family-qualified constraints and the selected extra index, with a percent-encoded `UV_CONSTRAINT` URI propagated to children. Commands use argv, not a shell; inherited Python/uv/pip/Git configuration is removed. Upstream dependency build code is trusted, not sandboxed.

Final checks import the exact Torch trio and verify either CPU tensor arithmetic or exact CUDA metadata, planned GPU architecture/identity and synchronized CUDA matrix multiplication. NVIDIA probes address the planned UUID. ComfyUI help uses `main.py --cuda-device 0 --help` for NVIDIA, `main.py --cpu --help` for CPU. `deas-plan.json` records the approved plan and `deas-install.json` records revisions and verification identities with `generationReady: false`. Success means these provisioning checks passed; no backend launch, API/node discovery or generation acceptance has occurred. GPU runtime acceptance is a required execution-time check, not something established by planning or the packaging tests below.

## Explicit owned-backend IPC

```ts
// All three commands have no caller-supplied arguments.
const started = await invoke('native_backend_start');
const status = await invoke('native_backend_status');
const stopped = await invoke('native_backend_stop');
```

Start resolves to the same status schema as status/stop, or rejects with a string for authorization/validation/duplicate-start/spawn failures:

```ts
type NativeBackendStatus = {
  state: 'starting' | 'running' | 'failed' | 'stopped';
  endpoint: string | null;
  logs: string[];
  error: string | null;
  generationReady: false;
};
```

`allow-native-backend` grants exactly these three commands to the local main webview. There are no executable, target, PID, port, URL, shell-command or arbitrary-argument IPC inputs. Installation planning and its separate explicit confirmation are unchanged. Provisioning itself does not launch a backend. Successful provisioning or checked `native_install_open` records current Engine approval with directory/file identities, exact plan/install manifests and launch-file hashes. A prepared plan, saved draft, failed/cancelled job or unvalidated existing folder cannot authorize start. An active owned backend must be stopped explicitly before changing environments. The frontend revalidates the last selected completed environment after restart and auto-starts its owned backend by default; Settings persists the opt-out. Check native status before one automatic start attempt, do not restart after manual Stop, and hold the OS environment lock until owned-process cleanup. Repair and recursive package attestation remain unimplemented.

Before each launch, native code rejects missing/replaced paths, symlink components in the guarded root/launch/manifest paths, changed manifests or launch files, foreign ownership and group/world-writable guarded entries. uv's venv interpreter link is materialized as a regular executable copy from the approved managed runtime during provisioning, before existing framework verification. The explicit uv/Python scratch smoke verifies that this copy preserves the real Python 3.12 venv/base-prefix and package import. These guards are not a sandbox for upstream package/node code and do not recursively attest every Python dependency/source file; concurrent hostile same-user filesystem mutation is outside this slice's threat model.

The child executes managed `venv/bin/python -u main.py --listen 127.0.0.1 --port <one ephemeral port> --disable-auto-launch --enable-cors-header tauri://localhost` (CORS mode replaces ComfyUI's origin middleware, which otherwise answers the Comfy tab's cross-site iframe with 403), with `--cpu` or the approved NVIDIA `--cuda-device 0` (plus planned GPU UUID environment and bounded driver/device recheck). Its working directory is the owned `ComfyUI`; inherited Python/user configuration is cleared and home/cache/config/temp paths remain inside the owned environment. No SDK/proxy, models, cloud fallback or generation recipe is installed or submitted.

Startup reserves one loopback ephemeral port, releases it immediately before the one spawn and never retries another port or adopts a listener. **Ownership proof** correlates the exact unreaped child PID's `/proc/<pid>/fd` socket inode with the unique IPv4 `127.0.0.1:<chosen-port>` LISTEN record in `/proc/net/tcp`; `/proc/<pid>/net` alone is not used as proof. Ownership is required before and after bounded GET-only `object_info` and `system_stats` probes, and continued child/listener ownership is monitored while running. A foreign listener collision fails and only the newly owned child is terminated. Valid JSON and the existing inspector's mandatory node/device structure are required. API response status is not inferred from process liveness or log text.

The startup deadline is **120 seconds**, with a 500 ms connect timeout, 2-second request timeout, overall remaining-deadline enforcement and 16 MiB streamed cap per response. Status starts as `starting`, and exposes an endpoint only after owned API verification (`running`). Exit, ownership loss, invalid/stalled responses or deadline failure yield `failed` with retained bounded logs/error. Logs retain the latest 300 chunks, each at most 4096 characters. All states retain `generationReady:false`; API acceptance says nothing about models, required pack nodes, GPU generation or readiness to submit a recipe.

Stop is idempotent and accepts no PID. It kills only the freshly created private child process group and reaps its leader; it never looks up or terminates a service by port/name. Linux `waitid(WNOWAIT)` keeps an exited leader unreaped until private-group cleanup, avoiding PID/group-number reuse between observation and cleanup. Request serials prevent a stale startup probe from publishing running after stop/restart. Tauri exit events and lifecycle drop both clean up the owned child. This is Linux-only lifecycle coverage, matching the installer; it does not establish Windows/macOS support or survival cleanup after SIGKILL/power loss.

Default lifecycle tests use real scratch venv/Python children and local HTTP fixtures: successful API start/status/stop, duplicate start, timeout, stalled/invalid API, startup failure/logs, manifest/symlink/file tampering, ownership collision, listener loss, stop during probe, lifecycle drop and owned-descendant cleanup with an unrelated child left alive. The ignored uv smoke additionally exercises real checksum-verified uv and managed Python 3.12 through the Engine's **test-only fixture authorization**, real local HTTP readiness and shutdown. It is not a successful full ComfyUI/Torch provision or GPU execution test.

### Isolated execution tests

```sh
# TMPDIR must point to an existing scratch directory, not a user install target.
cargo test --manifest-path src-tauri/Cargo.toml
# Explicit network smoke: verified uv + managed Python + packaging==25.0 only.
# No Torch/model download; temporary environment is removed by the fixture.
cargo test --manifest-path src-tauri/Cargo.toml real_uv_isolated_minimal_package -- --ignored --nocapture
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

### NVIDIA packaging checks (explicit network only)

```sh
cargo test --manifest-path src-tauri/Cargo.toml live_nvidia -- --ignored --nocapture
python src-tauri/verify_wheel_metadata.py
python src-tauri/verify_resolution.py
# Optional node dependency resolver check (currently fails the binary-only gate):
python src-tauri/verify_resolution.py --include-nodes
```

Verified on this host: RTX 5090, driver 615.71.09, compute capability 12.0; immutable plan chooses the exact cu130 trio and a single shared nodepack step. All nine CPU/cu121/cu130 Python 3.12 Linux x86_64 wheel URLs answered HEAD 200. CPU/cu130 PEP 658 metadata versions were checked; legacy cu121 metadata endpoints returned 403 (wheel HEAD availability only). The metadata checker records official CDN alias use when advertised `download-r2` HEAD requests are denied; uv resolution against the original index succeeded. uv **0.8.22**, isolated managed Python **3.12.11**, current ComfyUI requirements and exact cu130 constraints resolved **106 packages** in dry-run, without GPU wheel installation. The full node requirements fail the safe binary-only resolver because `nvidia-vfx` has no usable stable wheel; node source builds (also `llama-cpp-python`) remain unverified and execution must abort any required failure. No full CPU/GPU environment, CUDA computation, model, nodepack import or generation run was performed in this acceptance session. No installed environment or user service was changed.

Default tests also exercise real Git fixture checkout through the production runner, real subprocess cancellation, bounded logs, checksum rejection, immutable confirmation and unsupported-selection/path safety. The explicit uv smoke is ignored in the offline default suite.
