# Changelog

All notable changes to DEAS — Dark Engine AI Studio. Versions match `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`. Verification evidence lives in [docs/VERIFICATION.md](docs/VERIFICATION.md); the roadmap in [docs/PLAN.md](docs/PLAN.md).

## 0.1.8 — 2026-10-16

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
