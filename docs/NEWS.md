# News

[Documentation index](README.md) · [Current implementation status](IMPLEMENTATION-STATUS.md)

News summarizes user-visible development changes; it is not proof that a tagged release, signed artifact or platform acceptance exists. Check [official releases](https://github.com/darksidewalker/DEAS/releases), the [full changelog](CHANGELOG.md) and [verification evidence](VERIFICATION.md).

## 0.1.31 — 2026-10-19

- Director-compatible group labels and Characters 1–32, people/order selection, manual person boxes, and explicit **Find people** candidates with separate application. Cancellation is request-scoped and best effort; real vision quality remains unverified.
- Outpaint areas within the source frame, original-size inserted pictures, taller prompt fields with Copy/Clear, and corrected release staging/provenance.
- Source and local unsigned release builds do not imply Windows runtime, GPU quality/performance or oldest-Linux portability acceptance. See the release manifest and verification journal for exact evidence.

## 0.1.30 — 2026-10-19

- References dock for image/video/audio inputs, Director-compatible reference packs, MiniMax H3 RefMods, input scaling, prompt helpers and run-aware Prompt Forge controls.
- The base image is now paintable and movable/resizable like inserted images; drag layer rows to reorder. Changed base compositions are uploaded separately from inpaint masks. Mask display opacity defaults to 75%.
- Fix Windows installation Verify failing on Unix-only `signal.alarm`, and installation consent blocked by reordered folder fields.
- Regional image prompting is planned, not shipped. Native playback/audio, real-model quality/performance, native drag/dialog and Windows-runtime limitations remain; see [verification](VERIFICATION.md).

## 0.1.29 — 2026-10-19

- **Run Plan** (German **Ablaufplan**) replaces Workspace map: inspect the current generation stages and effective settings before Run, including image refinement and video/audio/output choices. Edit in Generate; opening the plan never starts generation or uploads media.
- Backend-resolved values are explicitly unresolved. Engine diagnostics and old local drafts remain available below the plan. This is not the roadmap's editable workflow planner or runtime tracking.

## 0.1.28 — 2026-10-19

- Generate adds **Video → Video** and **Multi-reference → Video** for LTX 2.3 and MiniMax H3 (H3 through the Director's REF2VA), and MiniMax H3 **Image → Image / Inpaint** in the Director's Image Inpaint style. Graphs validate offline against a real ComfyUI checkout; no GPU run of these paths yet.
- Editor and workspace: magic-wand masks, Ctrl+wheel brush size, zoomable slider compare and full view, metadata overlay, dock views (tiles/large/list), pipeline dropdown, run hints on the preview, “Open in folder” for media.

## 0.1.27

- Generate has family-specific LTX 2.3, Wan 2.2 and MiniMax H3 video recipes, output settings and an H3 Continuity dock. A real owner-run H3 I2VA job reached succeeded; broad model/platform acceptance remains open.
- **Known blocker:** native video playback can crash in GStreamer Matroska demuxing after playback starts. Audible audio is unconfirmed. Do not treat the alpha as playback-complete.
- Prompt Forge, presets/wildcards, image masks/layers and opt-in image refine/upscale share the generation workspace; see [Studio](STUDIO.md) and [prompting](PROMPTING.md).

## Included maintenance (0.1.31)

- H3 character references gain manual people boxes for directing Cast reads. **Find people** now offers explicitly applied candidates through the selected vision model; stopping is best effort. Real vision quality and native-platform interaction are not newly verified.
- H3 character references gain **People & order** for selecting people and their spatial arrangement. Manual/detected boxes are available separately; frame-mode Cast controls remain planned.
- MiniMax H3 reference pictures support ordered character-group labels and separate Cast cards per member, with Director-compatible pack storage. Vision/model and native-platform acceptance are still open.
- Rust-first, cross-platform, atomic-plugin and ComfyUI coexistence rules are now project-local. A consolidated implementation plan distinguishes code, recorded acceptance and missing work.
- User documentation now lives in focused guides under `docs/`; README is the short installation/start/documentation entry point. Changelog history is preserved here, with a root compatibility pointer.
- NVIDIA preflight retains the host driver environment and returns bounded failure stdout/stderr and raw exit diagnostics; regression tests accompany the change. This is not Windows runtime acceptance.
