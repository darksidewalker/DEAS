# Changelog

All notable changes to DEAS — Dark Engine AI Studio. Versions match `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`. Verification evidence lives in [docs/VERIFICATION.md](docs/VERIFICATION.md); the roadmap in [docs/PLAN.md](docs/PLAN.md).

## 0.1.13 — 2026-10-17

- Generate now offers Director-style aspect and resolution selectors: automatic reference aspect, landscape/portrait/square and ultrawide ratios, custom aspect, one model-derived native/default resolution, pixel-budget presets through 4K, custom megapixels and exact width/height. Explicit dimensions override the aspect selector until a preset or aspect is chosen again. Auto-Aspect is offered only in media-input pipelines, never text-to-image/video. The proportional aspect swatch is inside the picker; no separate size-summary row. Old 768px-native preferences migrate to model defaults.
- Image-to-image keeps resolution controls beside Denoise. Input scaling supports Off, Auto (2048px short-edge downscale cap), Target/stretch, Fit, Fill and crop, and Fit and pad. Scaling is compiled before VAE encoding on both native and preview paths; Fit or original-size pass-through can differ from the selected canvas. Original files are never rewritten. Settings persist and reference dimensions are read from loaded image/video previews.
- Fix: every job ended as "Unknown — Backend prompt/client/graph correlation failed". ComfyUI rewrites FLOAT inputs (`1` → `1.0`) in the stored graph, and DEAS compared graphs byte-exactly; numbers now compare by value, everything else stays exact.
- Live progress: running jobs show the sampler step (`3/8`) and the latest ComfyUI preview image in the stage and on the queue tile, read over the job's own `/ws?clientId=` socket (`preview_method: auto` per job, plain `http` endpoints only). The preview is display-only, never a saved output.
- Diagnostic jobs accept aligned dimensions through 8192px per side with a 16,777,216-pixel area cap; required scale/pad nodes are checked before submission. This is a validation bound, not a model/VRAM guarantee. Video and multi-reference generation recipes and automatic multi-model chaining remain unavailable.

## 0.1.12 — 2026-10-17

- **Pipeline** chips above the settings: Text → Image, Image → Image, Text → Video, Image → Video, Video → Video, Multi-reference → Video. Only what can actually run is enabled: Text → Image needs a checkpoint; Image → Image additionally needs an image picked from the environment's **Input** folder (ComfyUI's `LoadImage` reads only there) and shows a **Denoise** control instead of width/height — the job then goes through `LoadImage → VAEEncode` and is validated against the backend's input-file list. The video pipelines are listed but disabled with the reason until a verified recipe exists.
- Studio has one **Generate** tab (no separate image/video areas; the recipe will follow the loaded model later) beside the workspace map. Checkpoints and LoRAs are read straight from the environment's models folder (the one set in Settings) as soon as an environment is open, with Reload; picked LoRAs are chained into the job (`LoraLoader`, strength for model and CLIP). Basic settings (width/height/steps/CFG, sampler/scheduler, seed with new/lock) and one green **Run**. Prompts and settings are remembered. Without an open environment **Load models** asks the running backend instead.
- Run is the authorization: it prepares and submits one immutable native plan (validated against the running backend) and polls until done; finished files are shown straight from the output folder (native PNG transfer when no environment is open). Director/video recipes are still not implemented.
- The workbench fits the window: settings on the left, the preview takes the remaining height with the prompts under it, the session queue sits on the right with the green **Run** under it, and a bottom dock with **Media · Models · LoRAs** tabs can be dragged taller at its top edge (height remembered). Resizing the window never adds scrollbars.
- **Media** dock: thumbnail tiles (real miniatures for images, glyphs for video/audio/folders) in a wrapping grid, clicking loads the file into the preview. The path is clickable segments, the listing looks into subfolders (**Depth** 1–5, default 3; symlinked and hidden folders are not descended), starts in the environment's **Output** folder (newest first) with **Output / Input** chips honouring the folders set in Settings, and re-lists after a finished generation. **Models** and **LoRAs** docks show tiles (CivitAI preview when cached beside the file); a click picks the checkpoint or toggles a LoRA with its strength field.
- Media performance: PNG tiles use native 192 px thumbnails cached in the app cache directory (decoded once per file, keyed by path + size + mtime; other formats fall back to the original), only the visible tile rows plus two spare are rendered, folder listings and thumbnails are cached for the session (revisits show instantly, then refresh), and listing/thumbnailing run off the UI thread. The dock tab row has a **search** box and a **sort** select (Newest · Name · Size; Newest for media only) that apply to Media, Models and LoRAs; folders stay first.
- The owned backend's automatic endpoint handoff no longer jumps to the workspace map; only the explicit **Inspect existing backend** opens the Engine node.
- **Model families** (SwarmUI-style detection, data-only plugin `src/families/builtin.json`): the models scan reads each safetensors header — `modelspec.architecture` first, then tensor-key signatures — and falls back to the cached CivitAI base model. Built in: SDXL/Illustrious/Pony, Anima, Krea 2, Qwen Image 2.1, MiniMax H3, LTX 2/2.3, Wan 2.1/2.2, ACE-Step, SAM 3. The **Models** dock now lists every model from `checkpoints`, `diffusion_models` and `unet` with its family; only models with a recipe for the active pipeline are selectable (others are greyed with the reason). Picking a model applies the family's starting settings (size, steps, CFG, sampler, scheduler). Diffusion models (Anima, Krea 2, Qwen Image 2.1) run through `UNETLoader` + `CLIPLoader` (family CLIP type) + `VAELoader`; matching text encoders and VAEs are found by file name and offered as **Text encoder** / **VAE** pickers. The **LoRAs** dock hides LoRAs of other families (unknown ones stay).
- Sampler and scheduler offer every choice the backend lists (read on first use of the picker), both here and in the diagnostic panel; native validation checks them against `object_info` instead of a fixed three-entry list. Model and input-image names with spaces and non-ASCII letters (`MM-H3 - Ahegao Face.safetensors`, `Größe/…`) now work in jobs; only traversal, absolute/host paths, URLs, `\ : %`, control characters and padded segments are refused — such files are skipped instead of failing the whole prerequisite check.

## 0.1.11 — 2026-10-16

- Header buttons are smaller with their ✓ inline before the name. **Provider authorization** shows a ✓ plus the providers whose saved token passed the identity check (re-checked on start and when leaving the panel). The AiO installer pulses red until a backend is installed.
- **Settings & Backend** (renamed): after an install it holds the autostart switch next to the owned backend controls, now with **Restart** (stop, then start) besides Start/Stop.
- Library always lists every model; in SFW mode 18+ previews are blurred instead of hidden, and the 18+ switch only un-blurs (no reload).
- Technical logs are read line by line and cleaned: ANSI colour codes and control characters are removed, progress-bar carriage returns keep the last state, UTF-8 is no longer split between chunks and empty lines are dropped.

## 0.1.10 — 2026-10-16

- Installed model sizes use localized GiB/Gio labels; Python cache files are excluded from Git.
- Choosing a completed DEAS environment previews a checked reuse operation instead of attempting to reinstall into it. **Use existing environment** verifies the captured native manifests, ownership and launch-file fingerprints; the new-install overwrite guard remains intact. The folder chooser recognizes an environment root rather than adding a second `deas-environment` subfolder.
- The last successful/explicitly opened environment is validated and reopened after app restart. Its owned backend auto-starts by default; **Settings → Auto-start backend** persists the opt-out. Turning it off never stops a running backend, and explicit Stop does not trigger an automatic restart.
- Backend startup first checks current native status, remains session-scoped and uses an OS-held environment lock to prevent duplicate DEAS instances from starting the same environment. No foreign service is adopted or stopped; API readiness is not generation readiness.

## 0.1.9 — 2026-10-16

- Language follows the system language automatically (first bundled match of the OS/webview languages, English otherwise) and is only stored when the user picks one. The selector moved from the header into **Settings**; a pick is marked **Custom** with the detected system language named, and the first entry returns to automatic.
- Library **Show: Catalog · Installed** switch: *Installed* scans the environment's ComfyUI models folder (standard category subfolders, recursive) and lists the files as cards per folder. Opening a card shows path, size, SHA-256 and a **Fetch CivitAI metadata** button: the file is hashed once, looked up via `api/v1/model-versions/by-hash`, and model/version name, base model, trigger words, preview and the showcase image's sampler/steps/CFG/size are cached beside the file as `<file>.deas.json` (also when CivitAI does not know the hash).
- Provider authorization: the provider dropdown is replaced by an overview of buttons (Hugging Face · CivitAI · GitHub) showing ✓ / "Token saved" or "No token" each; clicking one opens its framed settings below.
- Fix: CivitAI checkpoints listed no files — real download URLs carry `?fileId=<n>`, which the native URL guard rejected for the whole listing. Files now load, show their variant (precision · size · format · ≈GB), and loading/errors appear under the clicked card.
- Library sort is an inline `Sort by  Newest ↓  Name ↑` button pair: the active one is highlighted, clicking it again flips the arrow and direction (undated items stay last).
- Clicking a Library card opens its file picker directly under the card. CivitAI files are grouped by model version (native `Resource.version`): pick a version chip, then tick the quant/format files of that version.
- Installation status, logs and Cancel moved to the left column under the tabs with a spinner while running; it stays visible on every tab during the run.
- Setup layout: AiO installer, Provider authorization and Settings are buttons right of the headline; the tab band holds **Studio** then **Library** (the "Explore studio" toggle is gone). The installation review shows only on the installer view and hides after a successful install (a second installer click reopens it for a re-run); success switches to Studio.
- Remembered choices: `src/lib/preferences.ts` (`usePref`/`readPref`/`writePref`, validated JSON under `deas.pref.*` in webview storage). It restores the install folder (only while its `deas-install.json` exists, otherwise the first run returns and the entry is forgotten), the Library category, base family, media filter and sort, and the Studio sub-tab.
- Provider authorization automatically checks saved/restored tokens on opening or changing provider, and new tokens after saving. A green checkmark requires a successful authenticated identity response from Hugging Face, CivitAI or GitHub. Rejected tokens, unavailable checks and unsupported providers remain distinct; Refresh retries without re-entering the token.
- Checks use fixed HTTPS identity endpoints, bounded native-only requests and no redirects or plaintext/token readback. Token replacement/removal and panel navigation discard stale verification results. Authentication does not imply download entitlement or license acceptance.

## 0.1.8 — 2026-10-16

- Authorization remembers tokens in the OS credential store by default (session-only opt-out), restores saved official-provider tokens on app start and displays their status automatically. Library browsing reuses the matching configured token unless anonymous access was explicitly selected; no plaintext fallback.
- Selected folder aliases resolve to their real existing directories at the chooser boundary; installation execution still refuses symlink substitutions.
- Safe environment data relocation: Settings separates path-only saves from an explicit **Move files & save folders** action with all-tree conflict/overlap checks, exclusive streamed copy, byte verification, atomic settings save and unchanged-source removal. Collisions abort, never overwrite. Linux only; other platforms fail closed.

## 0.1.7 — 2026-10-16

- Library sorts catalog cards and loaded file rows by publication date (newest first) or name (A–Z).
- No-clobber folder relocation groundwork with atomic tmp+rename settings saves (`deas-settings.json` beside the environment root).

## 0.1.6 — 2026-10-16

- Simplified automatic setup: one page asks only for the storage folder and the optional Director package (checked by default); backend, optional packages and the ComfyUI Git ref live under Advanced options. The native plan re-prepares automatically after each edit; **Start install** is the single explicit authorization.
- Removed the manual step-by-step installer, draft save/restore and the guided confirmation suites.
- Setup UI is a top tab strip (Installer with pending-glow/done-check, Provider authorization, Library, Settings) with a sticky Review & edit panel; the review never scrolls out of sight.
- Studio start page: Video / Image / Map tabs with a `MediaLibrary` side panel — native read-only folder listing, OS and browser drag & drop, asset-protocol previews. Registered as the `media` plugin.
- Library (renamed from Optional downloads): preview cards grouped by ComfyUI model folder, Models tab with image/video filter, base-model chip filter (Anima, Illustrious, Krea 2, LTX 2.3, MiniMax H3, Wan 2.1/2.2), `18+` badges, in-app NSFW confirmation dialog and light-switch toggle, local-present rows, in-place managed staging into `ComfyUI/models/<category>`, CivitAI search browsing, full owner catalog (`darksidewalker.toml`).
- Settings tab: per-environment models/input/output folders honoured by the owned backend at start (`--input-directory`, `--output-directory`, generated `deas-models.yaml`); a vanished saved folder fails the start.
- Provider token page opens in the system browser (`native_open_token_page`, allowlisted URLs only).
- Windows support compiled: managed uv/Python provisioning, Job-Object backend lifecycle, TCP-table listener ownership, anchored no-clobber downloads/PNG export, NSIS bundling, CI workflow. No Windows runtime acceptance.
- Root build scripts `build-linux.sh` / `build-windows.cmd`; uniform breathing bubbles; one panel open at a time.

## 0.1.5 — 2026-10-15

- Diagnostic PNG output transfer: bounded non-redirecting retrieval of indexed outputs of the current succeeded native job, full CRC/dimension-checked decode, original bytes + SHA-256 session cache, local Blob preview and native Save As of the cached original (no-clobber, unsafe parents/symlinks refused).

## 0.1.4 — 2026-10-15

- Diagnostic classic job transport: native intent revalidation against fresh prerequisites, immutable plan, separate unchecked consent, one-shot classic `POST prompt`, prompt/client/correlated status tracking, explicit current-session job recovery after navigation. No global interrupt, no silent retry.

## 0.1.3 — 2026-10-15

- Installation-to-studio continuation: successful native provisioning reveals the studio automatically (no second enable step); the studio binds the exact running owned backend endpoint once per lifecycle; backend Start/Stop stay explicit, `generationReady` stays false.

## 0.1.2 — 2026-10-15

- Recipe prerequisites: explicit read-only core `object_info` probe, exact checkpoint/sampler/scheduler identities, missing-node reporting, DEAS-owned diagnostic compile preview; endpoint edits discard stale evidence.

## 0.1.1 — 2026-10-14

- Automatic-first setup: read-only native defaults (new `deas-environment` beside the executable, NVIDIA profile gates, explained CPU fallback), editable findings/plan summary, immutable-plan invalidation on edits.
- Linux startup fallbacks: process-local `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `GDK_BACKEND=wayland,x11` defaults before GTK/WebKit init.

## 0.1.0 — 2026-10-13

- Alpha studio: React/Tauri single-page neural interface (`NeuralBlob`/`NeuralPath`/`NeuralGraph`), trusted built-in plugin manifests, read-only ComfyUI discovery.
- Native Rust AiO provisioning (uv, managed Python, ComfyUI checkout, pinned CPU/NVIDIA Torch, Director package with Forge/RefMods/Continuity/Output), immutable plans, explicit consent, owned backend lifecycle with FD/socket-inode ownership proofs.
- Real CPU/NVIDIA installation and owned lifecycle acceptance on Linux (RTX 5090 CUDA computation).
- Data-only language plugins (de/en/fr/ja/tr/zh) with decentralized module locales, key-parity and source-reference audits.
- Declarative TOML download catalogs, HF/CivitAI/GitHub/Ollama browsing, origin-bound optional tokens with session storage and explicit OS-keyring persistence, immutable download plans with streamed byte verification.
