# MiniMax H3 image edit with multiple references: handoff plan

Status: **planned, not implemented.** Implementation needs its own owner request.
Owner question: can DEAS do the multi-reference image editing from the community workflow "MMH3. Image edit v02" without new external nodes? **Yes.** Every required node is a core node in the owned backend (checked against owned ComfyUI `c5751c8`, DEAS HEAD `4e8b08d`).

## 1. What the reference workflow actually does

Checked node by node against the workflow JSON (not in this repository):

- **Pass 1 is a reference-driven regeneration, not latent inpainting.** `SamplerCustomAdvanced` (full sigmas, `er_sde`/`beta`, 10 steps) starts from an **empty 1-frame still AV latent** (`FizgigH3StillLatent`, sized to the target). The only conditioning comes from core `MiniMaxH3ReferenceToVideo` (`ref_image_size: "match"`).
- **The source picture is a reference only.** `LoadImage` → `<Picture 1>` (the whole image) and a YOLO face crop → `<Picture 2>`. Slots 3–5 are optional. The prompt names them (`… girl from <Picture 1> and <Picture 2>, sitting in the cafe …`). Edits, restyles and pose copies all happen through the prompt plus references.
- Later passes are optional quality stages: 3D latent upscale to 8.3 MP, a quarter-tile partial denoise, and a face fix. The face fix is the only latent-inpaint part: `VAEEncode` → `SetLatentNoiseMask` → `LTXVConcatAVLatent` with the face crop as its reference.
- External nodes in the workflow (`FizgigH3Still*`, `AILab_YoloV8`, rgthree, Set/Get, `MinimaxH3LatentUpscaler3D`) are conveniences. Pass 1 needs none of them.

## 2. Core facts the design relies on (verified in source)

| Fact | Source |
|---|---|
| `MiniMaxH3ReferenceToVideo` takes up to 9 picture slots and returns `[0]` conditioning (`minimax_refs`, `<Picture i>` tokens, no frame index) and `[1]` an empty AV latent | `comfy_extras/nodes_minimax_h3.py:259-380` |
| In the API prompt, Autogrow slot keys are `"ref_images.ref_image_0"` … `"ref_image_8"` | `comfy_api/latest/_io.py` `finalize_prefix` (joined with `.`) |
| DEAS `prepare()` already accepts dotted dynamic-input keys | Qwen `"images.image_1"` in `jobs.rs` (`nativeImageReference` block) and `SaveVideo` `"format.codec"` in `jobs_sam3_video.rs` |
| The H3 video VAE encodes one picture to one latent frame and decodes a 1-frame latent to one picture | `comfy/sd.py` H3 `downscale_ratio` (a=1 → 1); `comfy/ldm/minimax/vae.py` `decode_output_shape` (t==1 → 1 frame) |
| A still is video t=1 with **audio t=2** | `PH3ImageConditioning`: `_av_latent(w, h, 1, 2)`, "a still image, with the two audio latents it spans" |
| The DiT builds its layout from the latent shapes alone, with no fixed video/audio ratio | `comfy/ldm/minimax/model.py` `_forward` → `PackedLayout(text_len, latent_t, …, audio_t)` |
| `LatentCut dim "x"` cuts the last axis, which is the time axis of the audio latent `[1,32,2,T]` | `comfy_extras/nodes_latent.py:176` |
| `LTXVConcatAVLatent` pairs a plain video latent with the audio latent and keeps a video `noise_mask`. The reference workflow uses this exact pattern in its face fix | `comfy_extras/nodes_lt.py:896` |
| `MiniMaxH3ImageConditioning` / `PH3ImageConditioning` are for **other checkpoints** (MiniMax-H3-Image, p-h3-image). Do not use them with the H3 video model | node descriptions |

## 3. Design

### 3.1 Intent: reuse `nativeImageReference` and add no new field

Add a fourth method, `"minimax-h3"`. It brings the upload, `RI{n}` LoadImage nodes, the `prepare()` image list, the Media menu, numbered thumbnails, reordering, Run Plan and history restore with it.

- `src/families/builtin.json`: add `"imagePrompting": "minimax-h3"` to `minimax-h3` (only that family; HyperFlow stays without it). `referenceMethod` in `Workbench.tsx` then switches the existing reference UI on for H3 Image → Image.
- `src/lib/execution.ts`: add `nativeImageReferenceEncoders['minimax-h3'] = 'MiniMaxH3ReferenceToVideo'`, then widen the method union and the validation pair `(method 'minimax-h3', clipType 'minimax')`. The limit for this method is **1..8** user pictures (9 core slots minus the source, see 3.2). Other methods keep 1..4.
- `src-tauri/src/jobs.rs` validation (the `native_reference` match): add the pair `(Some("minimax-h3"), Some("minimax"))` and the same per-method limit. Also require `h3Edit` and `inputImage` for this method, because the source becomes `<Picture 1>`.

### 3.2 Picture numbering (follows the reference workflow and the core edit convention)

- `<Picture 1>` is **always the picture being edited**: the pixels node `9` would encode (the inpaint crop when *Inpaint only masked* is on, otherwise the source scaled to the canvas). This matches the reference workflow and the core convention "image_1 is the picture to edit".
- User references follow as `<Picture 2>` … `<Picture 9>`, in thumbnail order.
- The thumbnails therefore show `Picture n+1` for H3. Tokens stay English in every locale because they are model input.

### 3.3 Graph that `h3_edit()` emits when `nativeImageReference.method == "minimax-h3"`

Without references, the current 5-frame `MiniMaxH3ImageToVideo` path stays **byte-identical**.

```text
RI{n}  LoadImage                    (already emitted by the nativeImageReference block; do NOT emit QI/DEAS_ImagePromptEncode for this method)
HR     MiniMaxH3ReferenceToVideo    {clip, vae, prompt:<positive>, width:W, height:H, length:5, ref_image_size:"match",
                                     "ref_images.ref_image_0": <node 9 pixels>,
                                     "ref_images.ref_image_{n+1}": ["RI{n}",0]}
9      VAEEncode                    KEPT (today h3_edit removes it); H3 video VAE → [1,24,1,H/16,W/16]
X      SetLatentNoiseMask           KEPT when a mask exists (DEAS inpaint keeps working)
AS     LTXVSeparateAVLatent         {av_latent:["HR",1]}
AC     LatentCut                    {samples:["AS",1], dim:"x", index:0, amount:2}     → still audio t=2
CA     LTXVConcatAVLatent           {video_latent:<X or 9>, audio_latent:["AC",0]}
SS/N/Q MiniMaxH3SigmaShift / RandomNoise / KSamplerSelect   (unchanged)
Z      BasicScheduler               {model:["SS",0], scheduler, steps, denoise:<intent denoise, default 1.0>}
B      BasicGuider                  {model:["SS",0], conditioning:["HR",0]}
5      SamplerCustomAdvanced        {…, latent_image:["CA",0]}
SEP    LTXVSeparateAVLatent         {av_latent:["5",0]}  → 6 VAEDecode(SEP,0) = one picture
F      ImageFromBatch(0,1)          kept, so every former ["6",0] consumer (saver, crop rescale, composite) stays unchanged
```

Remove only `2`, `3` and `HE`. Keep the existing `civitai_saver` rewiring (`node_positive` → `["HR",0]`, `text_positive` from `HR.inputs.prompt`) and cover it with a test. Fixed-ID rule: grep `["2", 0]`, `["3", 0]` and `["6", 0]` in `jobs.rs` and `execution.ts`.

**Denoise is new for H3:** today `h3_edit` always uses 1.0. On this path the encoded source sits in the init latent, so the intent `denoise` applies:
- **1.0**: the reference workflow's mode (full regeneration; pose, composition and style may change).
- **< 1.0**: keeps the composition.
- **Mask**: only the masked area changes, which is the reference workflow's face-fix pattern.

Default stays 1.0.

Add to `H3_EDIT_NODES`: `MiniMaxH3ReferenceToVideo`, `LTXVConcatAVLatent`, `LatentCut`, and `VAEEncode`/`SetLatentNoiseMask` only if they are not already in `REQUIRED_NODES`.

## 4. How it should work for the user

1. **Image → Image**, MiniMax H3 checkpoint, load the picture to edit as usual. It is `<Picture 1>`.
2. Right-click media tiles → **Use as reference** (the same menu as Qwen/Krea/MOSS). They appear as numbered thumbnails `Picture 2`, `Picture 3` …, drag to reorder, red X to remove. At most 8.
3. Prompt with the tags, e.g. `Edit <Picture 1>: she wears the jacket from <Picture 2>, sitting in the pose of <Picture 3>. Expressive digital illustration, soft cel shading.` The reference author recommends naming the source's style (monochrome sketch, anime screencap …) so the style is preserved.
4. Choose the mode:

   | Goal | Setting |
   |---|---|
   | New pose / scene / outfit (reference-workflow behaviour) | Denoise 1.0, no mask |
   | Keep composition, change details | Denoise about 0.5–0.8 |
   | Change only one region (face, object) | Paint a mask, optionally enable *Inpaint only masked* |

5. Canvas of **at least 2 MP**, per the author's tip. Below that, a non-blocking plan notice.
6. **Pose copy** = a reference picture with the pose plus "in the pose of `<Picture N>`". No ControlNet is needed. Core `MiniMaxH3FunControlNetApply` (real pose/depth control) is a later, separate option.

Not in this slice: the reference workflow's automatic YOLO face crop (pass 4). The face can be added by hand as a reference crop. A later option is a SAM3 face mask followed by a masked pass, without external nodes. The 8 MP upscale with tile refine is covered by its own follow-up slice (§6).

### 4.1 References button and overlay (image mode), part of this slice

Owner decision (2026-11-12): image references get a **References button plus overlay**, as in multi-reference to video, not just the right-click selection. The right-click stays as a shortcut.

- Reuse `ReferencesOverlay` (`src/features/studio/ReferencesOverlay.tsx`) with an image mode; do not copy it. Today it is typed to video families (`family: 'ltx-2'|'minimax-h3'|'minimax-h3-hyperflow'`) and the `VideoRef` state (`refs`). Image references live in `imageRefs` (`Workbench.tsx` around line 243). The image mode binds `imageRefs`/`setImageRefs` and shows only images: no trims, audio lanes, RefMods or Create RefMod.
- Content:
  - The shared `MediaPanel` picker (same `marks`/`mediaActions`).
  - Numbered thumbnails: drag reorder, red X, file name in alt/title.
  - The existing tag insert (`onInsert`): for H3, `<Picture n+1>` because `<Picture 1>` is the source. Other families keep their own numbering or no tags if the family has none.
  - The per-family limit as a disabled reason (H3 8, Qwen/Krea/MOSS 4, SDXL Revision 4).
- The button sits where the video References button is (`referencesButton`); it is visible for `t2i`/`i2i` when the family has `imagePrompting`. Its badge shows the count (`aria-hidden`, count in the title). Focus returns to the button on close.
- All image families benefit (Qwen/Krea/MOSS/SDXL Revision), not only H3. This is also slice 0 of the planned **role-based pipelines** (`docs/PLAN.md` 4.6): the overlay later gets the Source/Reference role chips.
- Tests:
  - `ReferencesOverlay.test.tsx`: image mode, limit, reorder, tag insert, Escape/focus.
  - `Workbench.test.tsx`: the button only for families with `imagePrompting`; the intent is unchanged versus right-click selection.
  - Global search entry, six locales, `npm run test:core`. Extend `tools/verify_*.py` if they cover references.

## 5. Implementation steps

1. **Pin the contract first:** a Rust test pins `MiniMaxH3ReferenceToVideo` input names, the `ref_images.ref_image_N` key form, `length` min 5, and `LatentCut` `dim` options from the owned core source. It also asserts that the node is not yet in `H3_EDIT_NODES`. Sort JSON keys before exact-set asserts.
2. **Offline graph proof (gate):** extend `dump_h3_edit_graph` (ignored, `jobs_tests.rs:4410`) with three variants: references, references plus mask, no references. Run `tools/validate_video_graphs.py <json> --comfy-root /data/GitHub/deas-environment/ComfyUI --extra-model-paths-config /data/GitHub/deas-environment/deas-models.yaml`. Expect `valid=True outputs=['7']` for all three. If this fails, stop and record the finding.
3. **CPU shape probe (cheap, before GPU):** on a throwaway owned backend on `--port 8199 --cpu` with scratch input/output, use a small canvas. It must prove that `AS → AC → CA` yields video `[1,24,1,h,w]` plus audio `[1,32,2,2]` and that `SEP → VAEDecode` returns exactly 1 picture. Delete the scratch files and kill the backend afterwards.
4. **Frontend:** `builtin.json`, `execution.ts` (method, encoder, limit, validation), the References overlay in image mode (§4.1), `Workbench.tsx`:
   - `Picture n+1` labels for H3.
   - A ≥ 2 MP notice in `planNotices`.
   - The prompt token hint.
   - Grep every consumer of `referenceMethod`/`imagePrompting`/`promptEncoder` (`historyReferenceCompatible`, `mossIssues`, readiness lists).
   - Six locales, a `search.ts` entry, then `npm run test:core`.
5. **Backend `jobs.rs`:** validation pair and limit; in the `nativeImageReference` block emit only the `RI{n}` nodes for `minimax-h3` (no `QI`, keep `2`/`3` for `h3_edit`); the `h3_edit` branch from 3.3; extend `H3_EDIT_NODES`.
6. **Tests:**
   - Rust: exact graph shapes for the 3 variants, a byte-identical old graph without references, rejections (9 user refs, missing `inputImage`, wrong `clipType`, unsafe names), civitai saver wiring.
   - Vitest: H3 Image → Image with references builds `nativeImageReference{method:'minimax-h3'}`, labels start at Picture 2, Run Plan.
7. **Docs and version:** `docs/STUDIO.md` (H3 edit section), CHANGELOG plus a version bump across all version files, narrow the PLAN item, add VERIFICATION evidence.
8. **Gates:** `cargo test --lib` (serial on cluster failures), `cargo clippy --all-targets -- -D warnings`, `npm run typecheck && npm run test:core && npm run test:ui`, then `./build-linux.sh` for the owner.
9. **GPU acceptance (free 5090 only; never touch running services):** the owner's canonical H3 setup at ≥ 2 MP:
   - (a) a 2-reference outfit swap at denoise 1.0;
   - (b) a pose copy;
   - (c) a masked face fix.

   Check the result frames with `vision_analyze` and record timing and VRAM in VERIFICATION.md.

## 6. Follow-up slice: H3 image latent upscale ("8 MP tiled upscale")

Status: **planned, not implemented.** Independent of the reference slice: it works for the current 5-frame H3 edit as well as for the still path in §3.3. Both may ship in either order, but the graph proof must cover both start latents.

**Reference workflow (passes 2+3):** first pass at 4 MP → `MinimaxH3LatentUpscaler3D` (external pack, `3d_conv_v1`) to 8.3 MP → a 2-step partial denoise (`beta` 12, `SplitSigmas` 10) → a manual 2×2 quarter-tile denoise with `LatentCut`/`LatentConcat`, conditioning from the reference node.

**Already available (no new node):**
- Node-pack `DaSiWaH3TiledUpscale` (`nodes/nodes_minimax_h3_tiled_upscale.py`, pack 0.5.47) combines learned latent upscale and per-step Tiled Diffusion in one node: `scale` 1–8, `upscale_model` `interpolation`/2D/3D, `steps`, `denoise`, `sampler`/`noise`, `conditioning`, automatic tile and memory planning. Audio is frozen and returned unchanged.
- The node's own comment covers the Director "Image Inpaint" 5-frame pass ("keep its complete AV latent through upscale/refine"). Its check accepts video `T ≥ 1`, so the still latent from §3.3 is accepted.
- Weights present: `AI-Ressources/models/latent_upscale_models/minimax_h3_latent_upscaler_2d_conv_v1_fp16.safetensors` (the pack's preferred default, sharpness tiers 1–6) and `…_3d_conv_v1_bf16.safetensors`.
- DEAS already wires it for H3 video:
  - intent `latentUpscale {model, scale, steps, denoise, advanced?}` (`src/lib/videoIntent.ts` `H3LatentUpscale`/`H3LatentAdvanced`, defaults `h3LatentDefaults`);
  - graph `jobs_video.rs` around line 1815;
  - allowlist `h3LatentUpscaleModels`; Post-Processing **Latent** card;
  - `DaSiWaH3TiledUpscale` in `VIDEO_NODES`.
- Only the UI condition `latent = isVideo && (minimax-h3 || ltx-2)` (`Workbench.tsx:512`) shuts it out for H3 Image → Image.

**Changes:**
- **Graph (`h3_edit`):** after sampler `5`, insert
  `U DaSiWaH3TiledUpscale {model:["SS",0], conditioning:<["HE",0] or ["HR",0]>, latent:["5",0], sampler:["Q",0], noise:["N",0], sampler_name, scale, upscale_model, steps, denoise, seed, …advanced}`.
  Then `SEP.av_latent = ["U",0]`. Map the optional inputs through the same `H3_LATENT_ADVANCED_INPUTS` table as the video path, with no second mapping. Omit `director_guide`, `vae`/`start_image` and `continuity_context`. Without `latentUpscale` the graph stays byte-identical.
- **Intent/validation:** the image recipe accepts `latentUpscale` (same shape as `H3LatentUpscale`) only together with `h3Edit`. In `execution.ts`, add the field to the allowed set and validate like the video block. `jobs.rs` reuses the video validation of the block. A new image `inputImage`/`denoise` field is not needed.
- **Masks are refused by the node itself.** `DaSiWaH3TiledUpscale` rejects a latent with `noise_mask`, and `SamplerCustomAdvanced` passes the mask through (`out = latent.copy()`). So with a mask or *Inpaint only masked* the Latent card is disabled with a reason, natively rejected as well, with a test. This is correct by design too: inpaint results are composited back into the source size.
- **Output size:** the saver/composite size becomes the upscale size (`latentUpscaleSize('minimax-h3', canvas, scale)`, Python-round /32). Show it in Run Plan and the resolution readout ("model-exact": show what is submitted). Without a mask nothing is composited back, so check that the crop-rescale/composite consumers of `F` do not scale back to the source size.
- **Frontend:** `latent` also for `h3Image`; same Latent card, model picker and Advanced options. No new defaults: the existing H3 defaults apply. Plan notice: base canvas ≥ 2 MP (from §4); the reference workflow's choice of ~4 MP × scale 1.5 ≈ 9 MP is a documented example, not a forced value. Card reason text when a mask is set.
- **Prerequisites:** add `DaSiWaH3TiledUpscale` to `H3_EDIT_NODES` (the node-pack gate stays as for video: an older pack keeps the card disabled until Backend → Upgrade).

**Steps:**
1. Extend `dump_h3_edit_graph` with: 5-frame edit + upscale, still path + references + upscale, upscale + mask (must be rejected). Run `tools/validate_video_graphs.py` → `valid=True outputs=['7']` for the valid variants.
2. Rust tests:
   - exact `U` wiring, advanced mapping;
   - rejections: mask, `latentUpscale` without `h3Edit`, invalid scale/model;
   - old graph unchanged.
3. Vitest: the card is available for H3 Image → Image, disabled with a mask, intent contains `latentUpscale`, Run Plan shows the target size. Six locales for new reason texts, `npm run test:core`, search entry if a new control appears.
4. Docs/version as in §5.7, PLAN item narrowed.
5. **GPU acceptance** (free 5090 only):
   - one unmasked H3 edit at ~4 MP × 1.5 with 2D and 3D upscaler;
   - measure peak VRAM/time and check that tile planning holds on a t=1 still at ~9 MP;
   - compare visually against the base (sharpness, tile seams, colour shift, spike-guard need).
   Record in VERIFICATION.md.

**Risks:** tile planning and quality of the node on H3 **stills** are only established from source, not measured (developed and tested on video). The 2D upscaler is "better on 32/36 scales" per the pack, but unverified for H3 stills. The reference workflow's 2×2 tiles and the node's per-step tiling are different methods; a visual equivalence claim needs step 5.

## 7. Follow-up slice: H3 face refine for images

Status: **planned, not implemented.** Owner request (2026-11-12): the existing H3 video face refine should also work for H3 Image → Image (with or without references). It works on any decoded H3 image, so it is independent of §3 and §6.

**Source facts (checked):**
- `DEAS_H3FaceRefine` (`src-tauri/src/sam3_video_window.py:455`) works for any frame count except for one rule: SAM tracking per shot, square crop (`crop_box`), 768 canvas, `vae.encode`, partial denoise with the graph's own `noise/guider/sampler/sigmas` (`SplitSigmasDenoise`), feathered stitch-back. Padding to the H3 grid is built in (`temporal_shape(count)`, last frame repeated, padded frames dropped after decode), so a single image becomes the same 5-frame clip that `h3_edit` already uses.
- **Blocker:** line 517 `if end - first < 5: … skipped: shorter than H3's 5-frame minimum`. A single image is skipped silently and returned unchanged; as it stands the feature would look like it ran and change nothing.
- `jobs_face_refine::insert(g, images, audio, fps, model, f)` expects the house H3 ids `C`/`V`/`AV`/`N`/`Q`/`Z`; the H3 image graph has `SS`/`N`/`Q`/`Z`, with clip and VAE taken from the former nodes `2`/`6`. Its conditioning is text-only by design.
- The UI gate today is `face-analysis` = `isVideo && isH3Video(videoFamily)` (`Workbench.tsx` around line 1722).

**Changes:**
- **Adapter:** accept a single-frame input (a still) and pad it to 5 frames through the existing padding. The skip rule for short shots inside videos stays. The 24-fps check stays; the image graph passes 24 as a constant. Add one test in `test_sam3_video_window.py`: a 1-frame input is refined (output differs inside the mask, identical outside) and not skipped.
- **Image graph (`h3_edit`):** after `F`, call `jobs_face_refine::insert` with `images: ["F",0]`, `audio: None`, `fps: 24` and `model: ["SS",0]`, and map the house ids to the existing nodes (refactor `insert` minimally, e.g. pass clip/VAE in instead of hard-coded `C`/`V`). Put the baseline-first gate `DEAS_ImagePostprocessGate` at the end of the chain (baseline saver `B7` + refined saver `7`), as the image post-processing rule requires. Combined with §6 the order is generate → latent upscale → decode → face refine, on the final image, like video (fixes run at base resolution there; for stills refining after the upscale is cheaper per face — decide with the GPU measurement and record it).
- **Intent:** the image recipe accepts the existing `faceRefine` block (same validation `jobs_face_refine::validate`) only together with `h3Edit`. Add it to the allowed fields in `execution.ts`.
- **UI:** offer the face refine settings for `h3Image` too: same fields (SAM checkpoint, prompt, threshold, denoise, crop factor, feather, minimum face, *Main face only*), same defaults; `postCategoryFunctions`/card counts stay consistent; global search, six locales.
- **Prerequisites:** the bundled adapter and `ALLOW_NODES` stay; `DEAS_ImagePostprocessGate` is already part of the image post path.

**Steps:**
1. Adapter test (1 frame), then the dump variants: H3 edit + face refine, H3 edit + references + face refine, + latent upscale (§6), then `tools/validate_video_graphs.py` → `valid=True`, outputs `7` and the baseline.
2. Rust tests: wiring, baseline gate, rejections (`faceRefine` without `h3Edit`), old graph unchanged.
3. Vitest: card available for H3 Image → Image, intent contains `faceRefine`, Run Plan shows the stage.
4. CPU executor probe with `tools/verify_image_postprocess.py` for the gate order; GPU acceptance (free 5090 only) on a portrait and a group picture: denoise 0.25 vs 0.4 (the video finding: 0.4 rewrites close-up identity, 0.25 keeps it), timing/VRAM in VERIFICATION.md.
5. Docs/version as in §5.7.

**Related defect (record separately in `docs/PLAN.md` 4.11, not part of this slice):** SAM **Auto Refine** already accepts H3 images (`jobs_auto_refine.rs:408`), but per the code each pass goes through `h3_edit`, which always uses denoise 1.0 and removes the mask chain (`9`/`X`). The Auto Refine denoise (default 0.25) therefore has no effect for H3: the crop is fully regenerated, only anchored at the first frame, and composited back through the mask. This is from reading the code; confirm with one run before fixing. Fix direction: the still path from §3.3 (keep `VAEEncode` + `SetLatentNoiseMask`, intent denoise) also for H3 passes without references.

## 8. Remaining risks

- **Still audio t=2** comes from the core p-h3-image convention. The reference workflow's Fizgig latent source was not available locally, so its exact audio length is unknown. The DiT accepts any length; quality is confirmed only by step 9.
- **Partial denoise and mask on a still H3 latent:** the reference workflow shows mask plus concat. Partial denoise without a mask is new and needs a step 9 check.
- **Reference size `"match"`** scales references to the canvas area. Per the core tooltip, `"max"` keeps identity better but is several times slower; do not add a toggle unless the owner asks.
- Another session may commit at the same time: check `git log` before continuing and stage explicit paths.
