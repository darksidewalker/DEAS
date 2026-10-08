# DEAS desktop shell

Tauri 2 embeds the React production output from `../dist` in a native binary named `deas`. Rust owns the native provisioning orchestration directly; no Go installer sidecar is launched. Existing ComfyUI connections remain read-only. The native installer is a limited Linux x86_64 CPU/NVIDIA baseline, not full Go-installer parity.

## Verify and build

From the repository root, build the frontend first with `npm run build`. Then:

```sh
export CARGO_TARGET_DIR="$HOME/.hermes/cache/scratch/deas-target"
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
```

The native executable is `$CARGO_TARGET_DIR/debug/deas`. A desktop session and WebKitGTK 4.1 are needed on Linux. If a GPU/Wayland stack reports GBM buffer allocation errors, try launching with `WEBKIT_DISABLE_DMABUF_RENDERER=1`; this is an environment-specific diagnostic, not an app-wide rendering override.

Tauri CLI development uses `http://localhost:1420` and `npm run dev`. Its build hook runs `npm run build` before embedding assets. Direct `cargo build` does not run that hook.

## Read-only IPC

```ts
invoke('inspect_backend', { baseUrl: 'http://127.0.0.1:8188' })
```

Returns `{ baseUrl, nodeCount, devices, missingRequiredNodes, capabilities }` with camelCase keys. Device names and node counts come only from backend responses. Required node IDs are `MiniMaxH3Director` and `MiniMaxH3DirectorGuide`. Capabilities are sorted feature keys, excluding null and explicitly false entries; no health status or inferred feature support is invented.

Only GET requests to `object_info`, `system_stats`, and `features` under the selected base path are sent. `features` 404 means no reported capabilities; other HTTP failures, invalid JSON, and malformed mandatory data return an error. A 3-second connect timeout, 10-second per-request total timeout, and 16 MiB streamed-response cap apply. Redirects and environment proxies are disabled. HTTP/HTTPS URLs only; credentials, queries, and fragments are rejected.

Local `main` window capabilities permit read-only inspection, scoped hardware/folder discovery, the four native installer commands and the three explicit owned-backend commands. Remote-origin IPC, shell/filesystem plugins, and browser-to-backend network access are not granted. CSP restricts scripts and assets to the embedded app and permits only Tauri IPC connections.

## Read-only execution API negotiation

`invoke('native_negotiate_api', {baseUrl})` requires an explicit HTTP/HTTPS endpoint and returns `{baseUrl, protocol: 'classic'|'v2', generationReady:false, capabilities}`. It never starts a service or submits a graph. Only `allow-native-negotiate-api` grants this command to the local main webview.

Probe the documented proxy `api/v2/health`, then protected `api/v2/jobs?limit=1`; only health 404 authorizes Classic `GET prompt` fallback and `exec_info.queue_remaining` validation. Health metadata's upstream URL is never followed. Successful v2 probes establish health/listing contracts, not functioning upstream computation or all execution operations. JSON response bodies are bounded at 64 KiB; five-second request and ten-second total deadlines apply. Redirects and environment proxies are disabled. Schema pinned to official proxy source commit `1569dc17ec0dd293d4b9a0723e142204dacedb85`.

Failures reject with `{code,endpoint,message}`: invalidEndpoint, authentication, redirect, html, malformed, incompatible, http, transport, timeout or responseTooLarge. Auth/HTML/schema failures never silently become Classic success. Nine native HTTP-fixture tests verify probe behavior, paths, errors and bounds; real ComfyUI/proxy execution remains unverified.

## Native directory picker

`native_pick_directory({title})` opens the actual platform directory chooser (XDG portal on Linux) and returns an existing absolute directory or `null` on cancellation. Only the local main webview may call it. It does not create a target or start provisioning. The UI selects an existing parent and specifies a new environment subfolder because the installer refuses existing targets. UTF-8 paths are returned exactly; invalid titles/paths fail explicitly. Browser mode has no fabricated native picker.

The Linux portal dialog was independently opened, visually inspected in folder-only mode, and cancelled using the actual dialog close action; the explicit interactive smoke test passed. Tests also verify cancellation, directory/file distinction and no target creation. Windows/macOS runtime dialog acceptance remains unverified.

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
- `storagePath` is the **new environment directory**, not an existing model/project directory. Its parent must already exist. Roots, relative paths, traversal, symlink components and every existing target (even empty) are rejected. Start revalidates and claims the directory exclusively. Partial failed/cancelled installs remain for inspection; no automatic deletion, wipe, resume, migration or rollback is offered.
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

`allow-native-backend` grants exactly these three commands to the local main webview. There are no executable, target, PID, port, URL, shell-command or arbitrary-argument IPC inputs. Installation planning and its separate explicit confirmation are unchanged. Provisioning does not auto-start anything. Only successful completion in the **current Engine/app session** records an immutable approved plan plus directory/file identities, exact plan/install manifests and launch-file hashes. A prepared plan, forged manifest, failed/cancelled job or preexisting environment cannot authorize start. Consuming another installation clears the prior authorization; an active owned backend must be stopped first. Restarting the app loses authorization deliberately: persistent environment adoption/repair is not implemented.

Before each launch, native code rejects missing/replaced paths, symlink components in the guarded root/launch/manifest paths, changed manifests or launch files, foreign ownership and group/world-writable guarded entries. uv's venv interpreter link is materialized as a regular executable copy from the approved managed runtime during provisioning, before existing framework verification. The explicit uv/Python scratch smoke verifies that this copy preserves the real Python 3.12 venv/base-prefix and package import. These guards are not a sandbox for upstream package/node code and do not recursively attest every Python dependency/source file; concurrent hostile same-user filesystem mutation is outside this slice's threat model.

The child executes managed `venv/bin/python -u main.py --listen 127.0.0.1 --port <one ephemeral port> --disable-auto-launch`, with `--cpu` or the approved NVIDIA `--cuda-device 0` (plus planned GPU UUID environment and bounded driver/device recheck). Its working directory is the owned `ComfyUI`; inherited Python/user configuration is cleared and home/cache/config/temp paths remain inside the owned environment. No SDK/proxy, models, cloud fallback or generation recipe is installed or submitted.

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
