# News

[Documentation index](README.md) · [Current implementation status](IMPLEMENTATION-STATUS.md)

News summarizes user-visible development changes; it is not proof that a tagged release, signed artifact or platform acceptance exists. Check [official releases](https://github.com/darksidewalker/DEAS/releases), the [full changelog](CHANGELOG.md) and [verification evidence](VERIFICATION.md).

## Unreleased — 0.1.41

- Studio keeps companion file choices under the compact **Model files** disclosure beneath its other settings. Its Checkpoint dropdown and Models tiles update each other; all Settings dropdowns share the compact selector style.

## Unreleased — 0.1.40

- Studio can recognize supported companion architectures without relying on their download names. Each text-encoder/VAE selector also has its own **All files** switch for manual selection, including audio VAEs and text projections where required. Switches default off; selecting unverified components is not a compatibility guarantee. See [Studio component selection](STUDIO.md#text-encoders-vaes-and-companion-files).

## Unreleased — 0.1.39

- Opening raw/starred now creates the missing fixed directory under the selected native-approved Output folder; arbitrary missing browse paths still show errors.

- New renders use Output/raw; the star moves them to Output/starred under the same named subpath, and Unstar reverses that switch. Older stars need no new records. Input tiles have no star. Output, Starred and Input buttons navigate directly; the Output-relative tree starts at root instead of showing the full filesystem trail.

## 0.1.38 — 2026-10-21

- Resize the Settings and Queue columns against the central preview. Quick Settings beside GitHub separates layout reset from confirmed generation-default reset. Missing LLM setup takes you directly to the LLM Backend pane.
- Project actions move beside Run. Export/import a portable **draft ZIP** containing baseline image settings and its managed input PNG; generated results and full Studio-state persistence are still not included.
- Star eligible generated media to physically move it into Output/starred. Native safety checks keep unmanaged/project-linked/sidecar-associated files unavailable rather than risking broken references.

## Unreleased — 0.1.37

- Backend configuration now uses a left-hand menu for Startup optimizations, LLM backend and Provider authorization, shown in one matching right-hand pane. Switching panels retains unsaved drafts; explicit Save/Apply behavior is unchanged.

## Unreleased — 0.1.36

- Image previews now fit to the available window edge over a semi-transparent, non-checkered background. Click outside the image to close; zoom and pan remain available. The transparent DEAS v… footer shows backend startup progress, then a brief green check that vanishes after 3 seconds.

## Unreleased — 0.1.35

- Use nearly the whole window: 3px exterior edges and a floating version hint. Backend and Logs join the top tabs; GitHub/star move to the header right. Backend now shows its settings and provider authorization directly, with a compact status overview. Click a read-only image preview for zoomable full-window viewing; edit canvases keep their existing behavior.

## Unreleased — 0.1.34

- More vertical space for media: one top tab band, footer utilities and Backend-owned installer/authorization. Browse media without replacing your edit draft, and return shifted images to a clearly marked original frame.

## Unreleased — 0.1.33

- Closing the main window waits for pending project changes: save first, or explicitly discard a failed draft. A missing close guard is reported instead of silently implying protection.

- Keep baseline image settings and an explicitly imported PNG in a native project folder, then reopen them without starting a job. Global Studio defaults remain separate. Jobs, generated results, optional processing and editor layers are not restored by this first slice; see [Projects](PROJECTS.md).

## Unreleased — 0.1.32

- Upload a local video directly from Continuity, then prepare and select it explicitly. Originals are preserved; no playback or generation starts automatically.

- Continue from a prepared video already in ComfyUI input: prepare, inspect metadata, select, then Run or draft Next action with Forge. Local upload and native playback remain separate work.

- Ask Prompt Forge to draft a checkpoint continuation’s Next action, review it and apply only to that step. No automatic generation or replacement of the main prompt.

- Continue from an explicitly selected checkpoint in the active H3 session. Loading/selecting is read-only; imported-video sources and Forge-written Next action remain planned.

- Name Continuity sessions explicitly without deleting backend clips. Applying a name retains the plan settings and starts fresh local clip tracking; backend-wide session browsing remains planned.

- H3 Continuity adds an overlap selector for later segments, retaining the 22-frame default and explaining backend shortening for limited context.

- H3 Continuity now opens as its own overlay instead of occupying the dock, preserving the existing plan and sequential run controls. New Director continuity parameters and Forge Next action remain planned.

- H3 first/last-frame modes gain explicit character/order/box assignments and editable character Cast cards in the Generate hammer. No automatic card inference or video graph change.

- Generate's H3 REF2VA hammer supports editable Pose cards with explicit vision Read. Cards stay with their picture when references are reordered. Automatic reads are still planned; no new model/platform acceptance or distributable is implied.

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
