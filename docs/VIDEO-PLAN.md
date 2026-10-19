# Video, references and Director parity — working plan

[Documentation index](README.md) · [Implementation status](IMPLEMENTATION-STATUS.md) · [Studio guide](STUDIO.md)

This is the shared, resumable plan for Generate's video pipelines, media references and the MiniMax H3 Director features. It replaces the earlier local session plans. Pick the first open work package, read its **Facts** and **Decisions**, and append evidence to [VERIFICATION.md](VERIFICATION.md) when you finish. Project rules: [PROJECT-RULES.md](PROJECT-RULES.md), [COMFYUI-RULES.md](COMFYUI-RULES.md).

## Status

| Package | State | Evidence / where |
| --- | --- | --- |
| V1 Text/Image → Video for LTX 2.3, Wan 2.2 (i2v), MiniMax H3 (T2VA/I2VA/L2VA/FL2VA), Options → Output, H3 Continuity dock | Done 0.1.27 | `src-tauri/src/jobs_video.rs`, `src/lib/videoIntent.ts`, `ContinuityPlanner.tsx`; one owner-run H3 I2VA job succeeded |
| V2 Video → Video and Multi-reference → Video (LTX keyframes/source video, H3 REF2VA) | Done 0.1.28, offline-validated | `jobs_video_tests.rs`, `Workbench.test.tsx`, `tools/validate_video_graphs.py` |
| V3 MiniMax H3 Image → Image / Inpaint (Director *Image Inpaint* style) | Done 0.1.28, offline-validated | `jobs.rs::h3_edit`, `jobs_tests.rs` |
| W1 Reference picking rework (context menu, marks, media type filter) | Open | below |
| W2 References dock tab with the Director media view | Open | below |
| W3 Prompt Forge with full Director H3 features | Open | below |
| W4 H3 Continuity planner as its own overlay | Open | below |
| W5 Real GPU acceptance of V2/V3 | Open — needs owner consent and GPU time | below |
| W6 Later recipe features | Backlog | below |

Suggested order: W1 → W2 → W3 → W4, with W5 whenever GPU time is available. W2 reuses W1's selection model; W3 and W4 reuse W2's reference model.

## Facts (source-checked; re-check after node-pack updates)

### Owner workflows are the recipe reference
The owner's DaSiWa ComfyUI workflows (LTX *OmniForge*, Wan 2.2 *FastFidelity*, MiniMax H3 *MythicAlchemy*; not in this repository) define the wiring. ComfyUI templates and `comfy_extras/nodes_*.py` are only for node signatures. Read subgraph-promoted widget values, not the inner widgets (e.g. H3 steps 4, shift 10/3, `euler`).

### MiniMax H3 Director (DaSiWa node pack, `nodes/nodes_minimax_h3_director*.py`, `js/minimax_h3_director.js`, `docs/minimax_h3_director.md`, `docs/h3_continuity.md`)
- Modes `T2VA, I2VA, FL2VA, L2VA, REF2VA, Image Inpaint`. Model sockets: `ref2va_model` for REF2VA, `fl2va_model` for every other mode (lazy; only the selected one is pulled). **No video-to-video mode.**
- `timeline_data` items: `{id, type: image|video|audio, value: <input-relative path>, slot, order, enabled, trim_start?, trim_end?, media_mode?: video|audio|video_audio}`. Lanes: image slots 0–8, video 0–2, audio 0–2 (a video used as sound sits in the audio lane). Limits: ≤ 9 images, ≤ 3 videos, ≤ 3 audio, ≤ 12 files; audio needs an image or video; each clip 2–15 s, video and audio totals ≤ 15 s. The node decodes media itself (PyAV) and resamples to `frame_rate`.
- Image Inpaint: exactly one image in slot 0, no mask input, native 5-frame pass (`MiniMaxH3ImageToVideo`), the owner saves frame 0.
- Director UI features (target for W2–W4): lanes with + / drag-drop / paste, tile descriptions, reorder, replace-on-paste, video first-frame thumbnails, audio waveforms, crop track with draggable endpoints, playhead grip, **Play crop**, keyboard nudges (1 s / 0.1 s), V/A/V+A per video tile, numbered labels `<Picture N>`, `<Video N>`, `<Audio N>`, Load/Save reference packs (append/overwrite), Clear, Resolution panel and input-scaling modes (Off, Auto, Target, Fit, Fill and crop, Fit and pad, Long side with divisible crop), RefMods (up to 8, strength 0–1, Create RefMod export), Insert Prompt Structure, Insert [Shot N], Prefill Labels & Summary.
- Director Prompt Forge features (target for W3): Idea or Next action, model, Creativity and Detail 1–10, Shots Auto or 1–5 with per-shot boxes, Generate / Regenerate / Cancel, explicit Apply, last three drafts as history with re-apply, draft invalidation on mode/duration/canvas/reference/model changes, canvas passed as exact width/height, picture labels (Character, Place, Style, frame roles; Pose and Custom exclusive), character numbers and left/right/top/bottom/front/back order, **Find people** boxes and **Add character**, Cast & scene cards with automatic reading (opt-out), Scan people/picture, card priority rules, “Let the model see the pictures”, Reference instructions, Keep/ignore, adult-only policy, local/Ollama/OpenAI-compatible sources, context-size rule (+1,820 tokens per picture), continuity source-tail context.
- HTTP routes the Director UI uses: `POST /upload/image` (`type=input`), `GET /view?type=input`, `/dasiwa/refmods*`, `/df_h3_continuity/*`, `/dasiwa/h3/forge*`, `/dasiwa/llm/write`, `/dasiwa/input-images`.

### WhatDreamsCost LTX Director (`WhatDreamsCost-ComfyUI`, GPL-3.0)
- Its guide step equals core `LTXVAddGuide` per segment (images pre-compressed like `LTXVPreprocess(18)`; video segments taken at the source rate). Other features: IC-LoRA motion track, retake mode, per-segment prompts (*Prompt Relay*, a model patch), audio track with 3-D noise mask.
- Do **not** emit its nodes: GPL-3.0, its timeline strings come from a 469 KB JS UI, and `/video_ui_custom_view` (arbitrary file read) and `/video_ui_upload_chunk` (path traversal) are unsafe on any server that has the pack.

### DEAS today
- Native video compiler `jobs_video.rs` (`validate`, `ltx`, `wan`, `h3`, `requirements`, `VIDEO_NODES`); image compiler `jobs.rs::compile` (+ `h3_edit`, `H3_EDIT_NODES`). The TS compiler `src/lib/execution.ts` only serves the prerequisites preview.
- Intent fields: LTX `sourceVideo` (top-level input file) + `ltx.sourceStrength`, `ltx.keyframes[{image, frame, strength}]`; H3 `h3.mode REF2VA` + `h3.media[{type, file, slot, mediaMode?, trimStart?, trimEnd?}]`; H3 image edit `h3Edit{shiftVideo, shiftAudio}` with `diffusion.clipType: minimax`.
- `native_input_upload`: images/audio → `deas-inputs/<uuid>.<ext>`, videos → input root `deas-input-<uuid>.<ext>` (core `LoadVideo` lists only top-level files); magic-byte sniffing, 64 MiB images / 512 MiB media.
- Workbench references today: session state `refs: {item, second, strength, mediaMode}[]`, added with the **Add as reference** toolbar button over the preview, listed in the settings column (`.wb-refs`). Slots are assigned per lane at run time. Trims exist in the intent but have no UI.
- Media dock: `MediaLibrary.tsx` with views (tiles/large/list), sort, search, right-click menu (`.media-menu`, currently only **Open in folder**).
- Prompt Forge: `native_forge` forwards to `/dasiwa/h3/forge`, `/dasiwa/h3/forge/models`, `/dasiwa/llm/write` (allowlist in `src-tauri/src/llm.rs`); `ForgeButton.tsx` (hammer, review, Apply/Undo) and the `PromptForge.tsx` tab. REF2VA references go as `{kind:'image', role:'subject', path, easy_role}`.

## Decisions (keep unless the owner changes them)
1. H3 Video → Video and Multi-reference → Video both run **REF2VA**; label it honestly. A REF2VA checkpoint is recommended (hint, not a block).
2. LTX uses **core** nodes only (`LoadVideo`, `GetVideoComponents`, `ImageFromBatch`, `LTXVAddGuide`); Wan gets no v2v/ref2v.
3. H3 image edit uses the native node the Director calls, so DEAS masks, crops and layers keep working; frame 0 is the result.
4. First/last frame and the Continuity planner stay with Text/Image → Video.
5. DEAS drives node-pack features over their existing HTTP routes; new node-pack routes follow the node-pack procedure (route + test + version bump there first), never by patching the pack from DEAS.

## W1 Reference picking rework
Problem: references are added only from the preview toolbar, are not visible in the dock, and the dock mixes all media types.
- **Context menu:** while Multi-reference → Video (or Video → Video for the source) is active, right-clicking a media tile offers **Add as reference** / **Remove reference** (and **Use as source video** in v2v) next to **Open in folder**. LTX offers it for images only; H3 for images, videos and audio. The menu respects the Director limits and says why an item cannot be added.
- **Visible marks:** referenced tiles carry a badge with their label (`Picture 2`, `Video 1`, `Audio 1`, LTX: `@ 2.5 s`) and an accent border, in every dock view. The stage preview shows the same badge.
- **Type filter:** the Media dock gets an **All / Images / Videos / Audio** filter (remembered pref, chip group like the sort control), applied before search/sort; folders stay visible.
- Data: lift `refs` into one reference model shared by dock, stage, settings column and W2 (`{id, item, lane, slot, mediaMode, trimStart?, trimEnd?, second, strength, description}`), slots assigned on add, stable across re-renders.
- Acceptance: Vitest for menu entries per pipeline/family, limit refusal, badge rendering in all three views, filter persistence; browser screenshots 1440/1100; existing intent tests unchanged or updated to the new model.

## W2 References dock tab (Director media view)
A new dock tab **References** (visible for video pipelines; H3 and LTX), editing the W1 reference model like the Director timeline:
- Lanes Image / Video / Audio (LTX: Images with seconds/strength on a time ruler), tiles with thumbnails / first frame / waveform, drag reorder, drop from the Media dock and from the OS, paste, replace-on-paste, remove, per-tile description.
- Trim editor for video/audio: crop track, draggable endpoints, move the whole crop, playhead grip, **Play crop**, arrow-key nudges, source-time readout; V/A/V+A per video tile. Trims map to `h3.media.trimStart/trimEnd` (already validated natively; durations 2–15 s checked in the UI before Run).
- Label column with `<Picture N>`, `<Video N>`, `<Audio N>` and **Insert label** into the prompt; limit meter (images/videos/audio/total).
- Input scaling select with the Director's modes (sent as `timeline_data.resolution.input_scaling`; needs an intent field and both validation and a compiler test).
- Load / Save reference packs (file format compatible with the Director's packs where the format is documented; else a DEAS JSON with the same fields), Clear.
- RefMods (list `/dasiwa/refmods`, enable, strength, description; `timeline_data.refmods`) as a second step inside W2.
- Native video playback is still blocked by the recorded WebKit/GStreamer Matroska crash; the trim view must work with MP4 and fall back to a first-frame still when playback fails.
- Acceptance: component tests for lane limits, reorder → slot/order, trim → intent, labels, pack round-trip; Rust test that trims/scaling reach `timeline_data`; offline graph validation; browser screenshots.

## W3 Prompt Forge with the full Director H3 feature set
Goal: everything listed under *Director Prompt Forge features* above, inside DEAS's Forge (hammer popover and Forge tab), driven by the W2 references.
- First step (research gate): map each Director Forge control to the request fields of `/dasiwa/h3/forge` and any sub-routes (cast cards, find people, scan) in the node pack. Missing routes are node-pack work first (add the route beside the node's existing routes with a route test and a node-pack version bump, released there), then a `native_forge` allowlist entry in DEAS.
- UI: Idea / Next action, Creativity, Detail, Shots Auto/1–5 with shot boxes, draft review with Generate / Regenerate / Cancel / explicit Apply, three-draft history with re-apply and invalidation, picture labels and roles, character numbers and order, people boxes on the picture (find/add/drag/resize/swap/remove), Cast & scene cards with auto read and edited/out-of-date states, “Let the model see the pictures”, Reference instructions, Keep/ignore, Insert Prompt Structure / Insert [Shot N] / Prefill Labels & Summary in the prompt field.
- Canvas: send the Workbench output width/height exactly; duration and mode from the video controls.
- Acceptance: Vitest per control → request body; history/invalidation tests; route tests in the node pack; one live Forge run with a local vision model on a throwaway backend.

## W4 H3 Continuity planner overlay
Replace the dock-tab additions with one **Continuity…** button that opens a full overlay modelled on the Director's continuity UX, mapped onto DEAS:
- Segment cards left → right (seconds, next action, state planned/running/pinned), session picker, overlap choice {73, 56, 39, 22, 5}, output mode full/segment, `use_references`, source kinds checkpoint and imported video (`/df_h3_continuity/video`), Run next / Run all; cancel stays with the queue.
- Uses `native_h3_session`, `nextStep` / `resolveClip`, the existing run path, W2 references and W3 Forge (Next action with source tail).
- Fixed overlay like the full image view, keyboard close; the dock tab is removed or kept as a read-only summary (decide at start).
- Acceptance: component tests for open/close, plan edit, run order and pinning (reuse the existing continuity test), screenshots 1440/1100, Director JSON contract test unchanged.

## W5 Real GPU acceptance
On a throwaway ComfyUI on another port (never the owner's running backend, never restart his services): one LTX Video → Video, one LTX keyframe run, one H3 REF2VA with a 2–15 s clip, one H3 image edit with and without mask. Record outputs, time, VRAM and visible quality in VERIFICATION.md. Open questions to answer: does H3 frame 0 carry the edit; is unresampled LTX source fps acceptable; does `VAEDecode` after `LTXVSeparateAVLatent` decode H3 correctly.

## W6 Later recipe features
LTX keep source audio (audio VAE encode + 3-D noise mask), LTX IC-LoRA control (depth/pose/canny via `iclora_parameters` on core `LTXVAddGuide`), LTX per-segment prompts (needs the GPL Prompt Relay patch, explicit opt-in only), LTX retake, source-fps resampling, H3 Image Inpaint as a separate pipeline label, H3 continuity from an imported video, join clips / transitions, Wan T2V/S2V, per-model Wan LoRA lists, job cancel.

## How to verify
- Frontend: `npx tsc --noEmit -p .`, `npx vitest run`, `node --experimental-strip-types --test tests/*.test.ts`.
- Native: `cd src-tauri && cargo test --locked`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`.
- Graphs: `cargo test --lib dump_video_graphs -- --ignored --nocapture` (and `dump_h3_edit_graph`), save the JSON line, then run `tools/validate_video_graphs.py <json>` with a ComfyUI checkout's venv; it uses a scratch input folder with an ffmpeg test clip. This proves node names, inputs and link types only.
- Browser fixtures: `tools/inpaint-fixture.html` via Vite (`tools/verify_inpaint.py` shows the harness).
