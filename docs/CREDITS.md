# Credits and upstream references

[Documentation index](README.md) · [Current implementation status](IMPLEMENTATION-STATUS.md)

## Project

DEAS — Dark Engine AI Studio is maintained under the [darksidewalker GitHub project](https://github.com/darksidewalker/DEAS). The [contributor history](https://github.com/darksidewalker/DEAS/graphs/contributors) and Git history identify individual contributions; this document does not invent contributor names or confer rights to upstream works.

## Current runtime and development foundations

| Project | Role | Source / notices |
| --- | --- | --- |
| Tauri and Rust ecosystem | Native shell, IPC and native services | [Tauri](https://tauri.app/), [Rust](https://www.rust-lang.org/), exact crates in `src-tauri/Cargo.lock` |
| zip-rs (`zip`) | Bounded native draft ZIP import/export; Stored/Deflate only | [zip-rs](https://github.com/zip-rs/zip2), MIT; exact dependency in `src-tauri/Cargo.lock` |
| rusqlite (bundled SQLite) | Read-only access to Prompt Forge's tag and character databases | [rusqlite](https://github.com/rusqlite/rusqlite), MIT; [SQLite](https://sqlite.org/) is public domain |
| PromptForge | The native image-model Prompt Forge: prompt files, tool definitions and guidance documents (exported verbatim into `forge-data/forge-pack.json`, which records the source commit) the ported canon, tool-loop, revision, randomizer and clean-up logic in `src-tauri/src/forge/`, and the builder's layout and camera/light tile drawings in `src/features/forge/`; the Randomizer vocabulary (`forge-data/randomizer.json`) comes from the owner's Total Chaos Randomizer workflow via PromptForge | [PromptForge-Public](https://github.com/yoimtrashgaming-prog/PromptForge-Public) |
| PromptForge Chat | Studio → Chat ports PromptForge's chat: its system prompt (exported into `forge-data/forge-pack.json`), the `write_prompt` tool design, picture handling and the DuckDuckGo/SearXNG web search (`src-tauri/src/forge/assistant.rs`, `search.rs`) | [PromptForge-Public](https://github.com/yoimtrashgaming-prog/PromptForge-Public) |
| MOSS Layout Studio | The MOSS layout editor in the Prompt Forge tab (`src/features/forge/LayoutStudio.tsx`) is a fresh implementation of Azmagane's MOSS Layout Studio as PromptForge embeds it: boxes on a canvas written out as MOSS's centred `yxyx` Layout JSON, the two-step generate and the Rewrite instruction | Azmagane, via PromptForge |
| Darksidewalker's OCs | The colour schemes (Liiti Pink, Voud, Slimy Teal, Clawy Grey, Android White, Dragon's Hoard) take their palettes from Darksidewalker's original characters | Darksidewalker |
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
- PromptForge and the DaSiWa node pack: prompting/reference-authoring behavior; standalone deployment is not DEAS architecture. The image-model writer is now ported (see the table above); PromptForge's server, accounts and online lookups are not.
- Prompt Forge data: `tags.sqlite` is built from Danbooru's public tag listing (danbooru.donmai.us) and `character_traits.sqlite` from the noob-wiki and deepghs community character lists. **Redistribution terms for shipping these files have not been reviewed**: they are placed in `forge-data` by hand and are not bundled with DEAS.

Exact local source identities, capabilities and planned acceptance are recorded in [the consolidated plan](IMPLEMENTATION-STATUS.md). Check each source’s current license and vendored dependencies before copying/distributing it; TrainFlow wrapper licensing does not clear its trainers, and GPL/libmpv/FFmpeg/SDK obligations need their own review. No new DEAS license or legal clearance is declared by this document.

## Documentation assets and rules

Screenshots under `assets/` document the project; fixture screenshots are labelled as fixtures, not real model outputs or target-native acceptance. The [ComfyUI rules](COMFYUI-RULES.md) are a project-local adaptation of the author's `comfyui-dev` workflow. Preserve required source/author/license attribution when adding future code, models, screenshots or other assets.
