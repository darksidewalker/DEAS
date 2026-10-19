# News

[Documentation index](README.md) · [Current implementation status](IMPLEMENTATION-STATUS.md)

News summarizes user-visible development changes; it is not proof that a tagged release, signed artifact or platform acceptance exists. Check [official releases](https://github.com/darksidewalker/DEAS/releases), the [full changelog](CHANGELOG.md) and [verification evidence](VERIFICATION.md).

## Current development: 0.1.27

- Generate has family-specific LTX 2.3, Wan 2.2 and MiniMax H3 video recipes, output settings and an H3 Continuity dock. A real owner-run H3 I2VA job reached succeeded; broad model/platform acceptance remains open.
- **Known blocker:** native video playback can crash in GStreamer Matroska demuxing after playback starts. Audible audio is unconfirmed. Do not treat the alpha as playback-complete.
- Prompt Forge, presets/wildcards, image masks/layers and opt-in image refine/upscale share the generation workspace; see [Studio](STUDIO.md) and [prompting](PROMPTING.md).

## Unreleased maintenance

- Rust-first, cross-platform, atomic-plugin and ComfyUI coexistence rules are now project-local. A consolidated implementation plan distinguishes code, recorded acceptance and missing work.
- User documentation now lives in focused guides under `docs/`; README is the short installation/start/documentation entry point. Changelog history is preserved here, with a root compatibility pointer.
- NVIDIA preflight retains the host driver environment and returns bounded failure stdout/stderr and raw exit diagnostics; regression tests accompany the change. This is not Windows runtime acceptance.
