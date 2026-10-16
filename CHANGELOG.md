# Changelog

All notable changes to DEAS — Dark Engine AI Studio. Versions match `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`. Verification evidence lives in [docs/VERIFICATION.md](docs/VERIFICATION.md); the roadmap in [docs/PLAN.md](docs/PLAN.md).

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
