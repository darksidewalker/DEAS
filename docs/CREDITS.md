# Credits and upstream references

[Documentation index](README.md) · [Current implementation status](IMPLEMENTATION-STATUS.md)

## Project

DEAS — Dark Engine AI Studio is maintained under the [darksidewalker GitHub project](https://github.com/darksidewalker/DEAS). The [contributor history](https://github.com/darksidewalker/DEAS/graphs/contributors) and Git history identify individual contributions; this document does not invent contributor names or confer rights to upstream works.

## Current runtime and development foundations

| Project | Role | Source / notices |
| --- | --- | --- |
| Tauri and Rust ecosystem | Native shell, IPC and native services | [Tauri](https://tauri.app/), [Rust](https://www.rust-lang.org/), exact crates in `src-tauri/Cargo.lock` |
| React, TypeScript and Vite | Web presentation and build tooling | [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Vite](https://vite.dev/), exact packages in `package-lock.json` |
| ComfyUI | Managed model/graph execution and the original Comfy editor | [ComfyUI](https://github.com/Comfy-Org/ComfyUI); preserve upstream licensing/notices |
| ComfyUI-DaSiWa-Nodes | Selected prompt, Director/continuity, metadata/output and wildcard computation | [DaSiWa nodes](https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes) |
| ComfyUI-KJNodes | Optional model/attention/chunking capabilities where recipes require them | [KJNodes](https://github.com/kijai/ComfyUI-KJNodes); presence is not provisioning/compatibility proof |
| uv, Python and PyTorch | Managed runtime/bootstrap and tensor/model computation | [uv](https://github.com/astral-sh/uv), [Python](https://www.python.org/), [PyTorch](https://pytorch.org/) |
| GStreamer | Linux webview media support and bundled fallback plugins | [Bundled plugin provenance, LGPL-2.1-or-later and corresponding source](../src-tauri/gstreamer/README.md) |
| DM Sans and Manrope via Fontsource | Bundled UI fonts | [DM Sans](https://fontsource.org/fonts/dm-sans), [Manrope](https://fontsource.org/fonts/manrope); preserve packaged font licenses |
| SwarmUI | Behavioral references for controls, model-aware sizing and image editing | [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI); attribution is not a claim of identical implementation or output |

Tests/builds also rely on Node/npm, Vitest/Testing Library, Playwright and their dependencies. Manifests/lockfiles identify packages and versions; this credits list is not an exhaustive legal notice inventory. Model weights, vendor SDKs and gated assets carry separate terms.

## Behavioral and planned integration references

These are sources inspected for architecture/behavior, **not claims that their full implementations are bundled or ported into DEAS**:

- DaSiWa ComfyUI Installer: behavioral/compatibility reference for native Rust provisioning, not a bundled Go installer.
- DaSiWa-TrueVideoEnhancer: composable video enhancement, streaming and render contracts.
- DaSiWa-simple-video-compare: current Rust/Tauri/libmpv comparison/native playback reference; old Go code is not the target architecture.
- DaSiWa-simple-rtx-video-assambler: ordered layouts, audio and FFmpeg export behavior.
- DaSiWa-TrainFlow: trainer profiles, datasets, runtime and sd-scripts/Musubi orchestration behavior.
- PromptForge and the DaSiWa node pack: prompting/reference-authoring behavior; standalone deployment is not DEAS architecture.

Exact local source identities, capabilities and planned acceptance are recorded in [the consolidated plan](IMPLEMENTATION-STATUS.md). Check each source’s current license and vendored dependencies before copying/distributing it; TrainFlow wrapper licensing does not clear its trainers, and GPL/libmpv/FFmpeg/SDK obligations need their own review. No new DEAS license or legal clearance is declared by this document.

## Documentation assets and rules

Screenshots under `assets/` document the project; fixture screenshots are labelled as fixtures, not real model outputs or target-native acceptance. The [ComfyUI rules](COMFYUI-RULES.md) are a project-local adaptation of the author's `comfyui-dev` workflow. Preserve required source/author/license attribution when adding future code, models, screenshots or other assets.
