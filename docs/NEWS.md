# News

## 0.3.18

### Replace with a mask now swaps the object

The Replace wizard's **Paint a mask** method redraws the masked area completely, so the old object really goes away —
tested with a red car on a street photo. **Look again** next to the model list finds models you add later, and the run
status no longer shows raw placeholders.

## 0.3.17

The Beginner **Wizards** page now uses the whole window; before, an empty area pushed the wizard down.

## 0.3.16

### Wizards in Beginner

Beginner now has a **Wizards** page next to Generation, Models and Media. The Replace wizard works there just like in
Advanced: describe what to swap, press **Prepare and run**, and watch the result arrive. Generation shows what the wizard
set up, and **Clear wizard draft** takes you back to a plain draft.

## 0.3.15

### Replace with a mask, in one click

The Replace wizard's **Prepare and run** now also handles **Paint a mask**: SAM 3.1 finds what you typed in *Replace
what*, and Generate inpaints only that area. If SAM cannot find it, nothing is drawn and the draft waits in Generate for
you to paint the mask yourself. You need a SAM 3.1 checkpoint and an up-to-date backend; the wizard says when one is
missing. The wizard's **Stop** now also works while its job is drawing.

### DEAS speaks Russian

The interface now ships in Russian as its seventh language. Pick **Русский (ru)** under Settings → Language: every panel, help text and error message is translated, and the Beginner model guides read in Russian too. Russian also works as a prompt spellcheck target language.

## 0.3.14

### Play, pause and scrub the running video preview

The Enhanced Preview of a running video job has play/pause, the elapsed and total time, and a scrub bar. Scrubbing jumps
to that moment in the newest preview clip and keeps it paused or playing as it was. Previews that a sampler encodes too
long now play at the job's real length, so the clock and the scrub bar match the video you will get.

## 0.3.13

### Backend-only LoRAs only when you ask for them

0.3.12 mixed LoRAs that ComfyUI reports but the local index has not seen into the normal LoRA list. They now stay out of
it unless you tick **Backend-only LoRAs** in the LoRAs dock, which then shows just those, outlined in amber. Your selected
LoRAs keep working either way.

## 0.3.12

### Downloads: one line per file, and new models show up right away

The **Queue** lists every file on its own line with its own progress bar, percentage, size and speed, instead of one
combined row per folder. If a download stops, the error and **Resume** sit on the file where it stopped, and resuming a
partly finished folder now continues after the files it already saved. When a download finishes, Library re-reads that
folder, so **Installed** and the Studio model lists show the new model without restarting DEAS.

### Library: faster refresh, video covers, Explorer select

**Refresh models** checks only the current folder or category by default (**Entire library** is still there), and
missing-only **Fetch** reuses earlier lookups. Library can show MP4 covers and **Save preview locally** keeps a missing
one as `model.mp4`; on Linux, Model Details plays it with the native player while cards keep the still placeholder. On
Windows the file link opens Explorer with the model selected.

### Studio: backend LoRAs, Notes folders

The LoRA list also shows LoRAs that ComfyUI reports but the local index has not seen yet. Studio Notes gets folder
naming dialogs, drag-to-reorder and nesting, **Move to folder**, and asks before overwriting a note with the same name.
The prompt buttons sit beside the editor so its scrollbar stays clear.

### Dark Wizards can run the job now

The Replace wizard has **Prepare and run**: it sets up the draft in Generate and starts it there, through the same Run
path as pressing Run yourself. The wizard then shows the job live — step counter and preview image — and afterwards the
finished picture with its size, model, seed and duration. **Stop** on the wizard stops just that one job. The masked
method still only prepares, because you paint its mask in Generate.

## 0.3.11 (untagged; shipped in 0.3.12)

### Dark Wizards: Replace

A new **Dark Wizards** tab prepares Generate for common jobs. The first wizard, **Replace**, takes the picture to change,
optionally a second picture with the object that should go in, and two short texts (*the red car* → *the dog*). With a
Qwen Image 2.1 model it sets up a reference edit, or opens the picture in Inpaint on the same model so you can paint
exactly where the object goes; without Qwen it inpaints from the text with another installed model. You always check the
draft and press Run in Generate yourself. When no fitting model is installed, **Find in Library** shows it in the catalog.

## 0.3.10 (untagged; shipped in 0.3.12)

### Image editor: eyedropper and undo

The brush colour has an **eyedropper** icon: click it, then click the picture to take a colour from it. It no longer
depends on the desktop's screen picker, which never answered on some desktops, and zooming keeps working meanwhile.
The colour controls only show while you paint on a picture, not on a mask. **Ctrl+Z** undoes brush strokes, magic-wand
fills and Clear on masks and pictures; **Ctrl+Shift+Z** or **Ctrl+Y** redoes them.

### Media Analysis takes pasted media

Ctrl+V on the Media Analysis tab works again without clicking into it first. A picture copied from a browser loads
directly, and a picture or video file copied in a file manager opens from its own location.

## 0.3.9

### Wan 2.2 GGUF video models work in Image → Video

GGUF versions of Wan 2.2 models made with DaSiWa Quant Station (SnatchKiss and others) were missing from the video
pipeline, and the text-encoder and VAE pickers stayed empty ([#44](https://github.com/darksidewalker/DEAS/issues/44)).
DEAS could not read one part of these files, so it did not know they were Wan models. It reads them now. On current
ComfyUI, GGUF video models then failed at the first step with *cutlass_fp16_linear: K mismatch* when the
**fp16 accumulation** speed option was on. DEAS now steers only the GGUF layers around that new fast path.
Restart the backend once after updating.

## 0.3.8

### Downloads run in the background

**Download all** in the Library hands every file to a background queue that keeps running when you switch tabs
or close the Library. A **Queue** view shows each download with its progress, and interrupted downloads resume
after a restart.

## 0.3.7

### DEAS updates itself on Windows

**Upgrade → Everything** no longer stops on Windows when a newer DEAS exists
([#43](https://github.com/darksidewalker/DEAS/issues/43)). DEAS downloads and checks the new version, swaps it in
while it runs, and asks **Restart now** or **Later**. It waits for antivirus scans and puts the old version back
if anything goes wrong. When Windows ransomware protection blocks the folder, the message says which setting to
change.

### Local GGUF models: no more *Windows Error 0xc000001d*

Some llama-cpp-python builds need AVX-512, a processor feature most desktop CPUs lack, so Prompt Forge and Chat
with a local GGUF model failed with *0xc000001d* (illegal instruction). DEAS now installs a build without it. Run
**Upgrade → ComfyUI and node packs** once in an existing environment. AMD environments, and Windows PCs with a
GTX 10-series card, now get the Vulkan build, which runs local GGUF on the GPU.

## 0.3.6

### Face refine works straight after a generation

Starting **Face refine** right after a large video generation could fail with a SAM3 memory message, because
ComfyUI was still holding the previous run's models and results in memory. It would have let go of them on
demand, but DEAS checked first. DEAS now asks ComfyUI to free that memory before checking, so the post-process
starts without rerunning anything. Restart the backend once after updating.

## 0.3.5

### The memory check no longer stops jobs on its own

0.3.4 refused heavy jobs when the model files they use added up to more than the free system memory. ComfyUI
does not keep all of those models in memory at once — it offloads and unloads them as the job moves on — so jobs
that would have run fine were stopped. The check is now off by default. Set `DEAS_HOST_MEMORY_ADMISSION=warn`
to see the estimate in **Logs**, or `=block` to bring the refusal back.

## 0.3.4

### Studio waits for a slow backend instead of flooding it

On computers where ComfyUI needs more than a few seconds to list its nodes and models, Studio could stay on
*Backend not ready* for good while **Backend → Test** was green, and the Comfy tab never finished loading
([#39](https://github.com/darksidewalker/DEAS/issues/39)). Studio kept asking again before the previous answer arrived,
and the backend queued up the questions until every request timed out. Studio now waits for the answer it already asked
for.

### LoRA details you can make your own

In Library → **Model details** of a LoRA you can now edit or clear its trigger words, replace its card image with one from
your computer, and browse prompt examples from its Civitai page with copy buttons for the prompt and negative prompt.
Your trigger words survive metadata refreshes and are what Library search and Studio show. (Thanks to @AzuliarTHP, PR #42.)

### Enhanced preview keeps moving

While a video job upscales or exports and no new sampling preview arrives, the enhanced preview now replays the latest
clip after a short pause instead of freezing on its last frame.

### Older environments update instead of failing

When DEAS finds an environment that an older version installed with other node-pack revisions, the Backend tab now
says **Environment needs an update** and offers **Update environment**, instead of a technical error with no way
forward. After you confirm, DEAS fetches the required pack revisions and opens the environment. Models, inputs,
outputs and settings are kept.

### Fewer install and log surprises

The first-run uv download retries a dropped connection or a busy server before giving up. Studio's Models and LoRAs
docks tell you when the backend already lists model files that the list does not show yet (for example files you
copied in by hand); **Reload** adds them. On Windows, the KJNodes "triton" traceback at every backend start is now a
single information line in Logs.

### Triton on Windows

Windows NVIDIA environments now get Triton (`triton-windows`) like Linux already did through PyTorch, so
**Torch Compile** and Triton-based nodes can work there. Existing Windows environments get it with
**Backend → Upgrade**. When an environment has no Triton, Studio says so in Options instead of letting a
Torch Compile job fail.

## 0.3.3

### Weights are typeable again

The LoRA weight boxes (and the other numeric Studio fields) no longer erase the keystroke that starts a decimal or a
minus sign, so `0.5` and `-0.25` can be typed key by key. Half-typed text is never treated as a value, an impossible
number is not stored, and clearing a box no longer silently sets a weight to 0.

### Backend options you can find

Global search (`Ctrl+K`) now lists the backend's options one by one: presets, attention backend, the fast features,
VRAM and VAE choices, the collapsed **Advanced** precision and cache fields, the partner-node switch, **Apply**, and
the LLM provider, endpoint, key, model and test controls. A hit opens the right Backend pane and any collapsed group,
and a control that only exists in another mode says so.

### Fewer nodes for the backend to answer

**Backend → Startup optimizations** has a new **Disable partner nodes** switch, checked by default. DEAS never uses
ComfyUI's paid API models (Kling, ByteDance, Gemini, Tripo, …), and they make up almost half of the node list a
backend answers with, so startup, **Test**/**Inspect** and recipe discovery respond sooner. Uncheck it to keep those
nodes for workflows you build yourself in the Comfy tab. Older backends show the switch greyed out with the reason.

## 0.3.2


### Drop media straight into H3 References

Drag a Media tile or a file from your file manager into the **H3 Video** or **H3 Image Edit** References popup.
DEAS asks which role the file should take. Once an image reference is present, more images are added
automatically. First and last frames appear as cards under **Images**. Assignments come back after a restart.
Thanks to @AzuliarTHP ([#41](https://github.com/darksidewalker/DEAS/pull/41)).

### Library: manage model files, open Civitai pages

- Right-click a card, or use **Bulk select**, to move models to another folder in the same category or delete them
  after confirmation.
- The file path opens its folder. **View on Civitai** opens the matched version, and the creator name opens their
  profile. Mature models open on civitai.red, because civitai.com now only shows a "moved" notice for them.
- **Fetch** can save a missing cover next to the model (off by default). Existing covers are kept.

### Enhanced video preview

Each enhanced preview now plays to the end before the newest sampling preview starts, and holds its last frame
while waiting.

## 0.3.1

### Backend startup on slow machines

DEAS now allows up to 45 seconds for each required ComfyUI answer (**`object_info`**, **`system_stats`**)
while the owned backend starts, instead of giving up after two seconds. Startup still stops after 120 seconds
overall. **Logs → DEAS** now names the probe that was running, how long it waited and the startup result, so a
slow start can be told apart from a broken installation. A startup timeout is not a reason to reinstall or
delete your settings. See [Backend](BACKEND.md).

## 0.3.0 — Feature phase

DEAS 0.3.0 completes the basic beta milestone and starts the feature phase.
New and experimental capabilities still have their own compatibility and verification limits.

### Experimental Dials for MiniMax H3 video

Open **Dials** in Advanced Studio settings on supported MiniMax H3 video pipelines.
Adjust steering strength or draw time curves in the rack. Download MatlowAI’s
files from **Library → Catalog → Dials**. For an existing owned backend, use
**Backend → Upgrade → ComfyUI and node packs**, then restart the backend when idle.
See [Dials](DIALS.md) for supported combinations and limitations.

### Tidier image editing

Sampler and Scheduler, CFG and Denoise, H3 shifts, and Context Padding and Mask Blur
now sit in pairs. **Add target mask** lives in **Post-Processing → SAM 3.1 masking**.
See [Studio](STUDIO.md).

### Tidier preview and Library controls

The Original/Processed buttons above a post-processed result follow your colour
scheme like every other button, and the Library search fields are now the same
height as the other searches. See [Studio](STUDIO.md) and [Library](LIBRARY.md).

## 0.2.40 BETA

### empty H3 drafts start in T2VA

An empty H3 Video draft now recovers from an old remembered reference/frame mode
without demanding nonexistent references. History and pinned Continuity keep their
intended mode. See [Studio](STUDIO.md).

### Enhanced video preview keeps your position

The animated denoising preview during a running Video generation no longer jumps
back to the start on every update; it resumes at the position you were watching,
so the growing clip plays through. See [Studio](STUDIO.md).

### Windows deletion fixes

Media deletion now releases DEAS's own inspection handles before confirming that
files are gone. Bulk deletion and filename reuse work without false failure reports.
TVE source cleanup preserves identity checks and protects active source operations.
See [Media](MEDIA.md).

### more local prompt tags

The prompt's tag-plus button opens autocomplete options: turn suggestions on/off,
choose a larger floating list outside the prompt, increase result count and enable
the local merged Danbooru/e621 dictionary. The compact popup keeps controls and
labels together. Separate CSV presets were removed; user CSV files are never bundled.
Every CSV source, including the merged entry, can be removed with its trash icon;
the original CSV stays intact. Built-in Danbooru keeps its checkbox without a trash icon.
Sources are indexed once and queried locally while typing.
See [Studio](STUDIO.md).

### compact H3 Video References

Video References has dedicated Images, Video, Audio and RefMod panes, a compact
assignment bar and aligned pack controls. Pane positions stay stable as references
change. Visible action icons include a red Remove button, and a picture can be
assigned to multiple independent slots. Audio cards have crop play/pause, drag grips
snap with pointer capture, and trim warnings no longer move the editor. H3 image edit
now has a pinned main preview, controls below it and a compact reference grid.
See [Studio](STUDIO.md).

### Library Catalog

Catalog and Installed now share a gallery-style browsing layout. Online cards
have their own Favorites, tags and notes; source, search and Download all sit on
one action line. Installed is the left tab, and missing-cover hexagons stay centered.

## 0.2.39 BETA

Library and Studio now share Favorites and explicit inventory updates. Studio's
compact selection controls match a selected card's displayed family label and can
bulk edit families or favorites. Clean exports support confirmed filename replacement.
See [Library](LIBRARY.md), [Studio](STUDIO.md) and [Media](MEDIA.md).

Windows preview handles are released before deletion; deletion reports success only after the filename has disappeared, allowing a new output at the same path.

## 0.2.38 BETA

- H3 Image can opt into the existing face-refinement stage, retaining Original and Processed images. It reuses the SAM/model settings and runs before optional learned latent upscale; real-model still-image quality acceptance remains open.

- Integration review fixes preserve exact MOSS history/prompt choices, keep Lying Sigma out of independent SAM refinement, show the eight-active-LoRA execution limit before Run, invalidate deleted TVE sources, and retain streaming audio fallback and Windows no-overwrite publication.

- H3 latent upscale/Hi-Res gained an opt-in **Stream decode (lower RAM)** mode: Original and Processed are decoded and encoded chunk-by-chunk instead of holding the full pixel batch. Off by default; unsupported combinations show a concrete reason instead of silently falling back.
- Manual H3 **Refine faces** processes the whole selected source video rather than the short mask-analysis preview window. The original and processed products remain separate.

An optional **Lying Sigma** control is available below Sampler/Scheduler in the
advanced Image pipeline. It starts at **0 = Off**. Nonzero settings use the bundled
sampler wrapper and expose the sampling interval; this is a
detail adjustment with model-dependent results. Strength steps by 0.01; new timing
defaults are 25%–90%. DEAS bundles just this sampler and deploys it through the
owned backend's normal startup; no extra upgrade option or full node pack is
required.
[Guide](LYING-SIGMA.md).

## 0.2.37 BETA — Library and Studio workflow

- Image/video model switches no longer get blocked by retained other-family LoRAs; their draft selections and weights are preserved. Explicit selections remain scoped to the current model draft.
- SAM Auto Refine now uses the shared Mask Blur setting. Image Post-Processing exposes the learned upscaler with a fresh 2× default; existing explicit factors remain unchanged.
- Added 7:9 / 9:7 canvas presets, fixed References sorting/thumbnail refresh, recovered queue stars after generation and cleared stale preview/export feedback on model changes. Generic non-actionable model advice stays quiet.

- Restore the native model browsing index across restarts; explicit Refresh checks
  changes. Library/Studio share collapsible folders, visibility controls, sorting,
  independent scrolling and View all. Library adds scoped metadata/previews Fetch,
  Favorites, personal tags/notes and detail dialogs. Local JPG/JPEG, PNG, WebP,
  GIF, AVIF and BMP previews use a shared fallback path.
- Manage selected LoRA weights and named sets from the model-picker button. Add
  LoRAs from Library cards, details or the right-click menu, without changing tabs
  or opening a popup. A floating notice keeps action buttons aligned. Pending
  additions survive asynchronous Studio loading and Windows folder spelling
  differences; retries preserve weights and storage failures report failure. Native
  index null metadata fields are accepted and normalized. Both success/error
  notices use the browser top layer to escape pane and dialog clipping.
  The larger selection dialog includes thumbnails and nested read-only details
  with cached trigger words. The selection list scrolls independently, uses compact
  thumbnails and supports pointer/keyboard reordering with edge auto-scroll.
  Power icons retain disabled, greyed-out entries and weights; saved sets preserve
  order and switches. Only enabled entries enter Run/Run Plan, in displayed order.
  Trigger-word chips support Copy selected alongside Copy all. Outside clicks/Escape
  close only the active dialog; Escape during a drag cancels that reorder.
- Treat selected LoRA family labels as advisory in Studio, history and native
  admission. Submit every active, present LoRA with its exact weight; retain
  file/source, metadata binding, format, loader and integrity validation. Genuine
  backend loading errors remain visible. Family declarations use a compact badge.
- Add a personal prompt notebook with nested folders, a separate note-list pane,
  positive/negative prompts and manual seeds. Explicit Save, unsaved-draft guards,
  write-failure recovery and confirmed deletion keep it separate from generation.
  Folder action icons sit beside All notes; note actions and fields stay compact.
- Add confirmed single/bulk Media deletion within owned Input/Output roots, with
  whole-batch preflight, job-idle checks, file-identity guards and partial-failure
  feedback. Deletion is permanent and restricted to regular media files.
- Returning to Studio no longer scans models or briefly disables Run. Windows
  output publication uses no-overwrite rename for exFAT, with grouped rollback;
  the POSIX hard-link path is unchanged.
- Extend six locales, shared diagnostics, documentation and disposable/synthetic
  fixtures. Runtime caches, personal notes/sets, models and credentials are not
  included in source changes.

## 0.2.36 BETA

- H3 Hi-Res Regenerate now has its own refiner-LoRA strength. Upscale refine strength and 2D sharpness are shared with Latent upscale: change either card and the other card shows the same value. The new Hi-Res tuning needs DaSiWa node pack 0.5.55; normal authoring starts at the existing shared strength 0.2, while 1 restores the full three-step Hi-Res preset.
- HyperFlow H3 Flash now also accepts the single-file safetensors checkpoints (INT8 convrot and BF16 conversions), not only GGUF — Studio routes them through the backend's HyperFlowLoader. If the backend upgrade did not offer that loader, update the owned backend.
- **Windows: the enhanced video preview plays as a video again** instead of a static pixelated image per step — the preview clip was blocked by the app's content-security policy.

## 0.2.35 BETA

- Model scanning is much faster: hashing big model files got ~20x faster (a large checkpoint now takes seconds instead of minutes), the file listing ~3x, and *Scan Files* now handles four files at a time.
- Huge libraries no longer vanish silently: scans walk up to 100,000 files, and any cut is written to the central Logs — previously everything after file 5,000 was dropped without a trace.
- exFAT drives are scanned now (for example an external T7 Shield); the Library used to read "No model files found" there.
- RefMod VAE slots fill themselves: from the selected model's Matching set, or from disk when the backend is stopped — and Windows VAE pickers now take the selection instead of rejecting it.
- Pickled models (`.pt`, `.pth`, `.bin`) carry a note that they can run code when the backend loads them. Nothing is blocked.

- New in Join clips: **Smooth audio seams** (off by default) softens clicks where clips meet with a short 5 ms fade. Requires the DaSiWa node pack 0.5.53 or newer.

## 0.2.34 BETA (untagged; shipped in 0.2.35)

- Join video files with optional generated H3 transitions: enable the switch in Continuity → Join clips → Video files, check the clips, then Join now. The current H3 model/settings render each bridge before the final join. Cancel stops the sequence without deleting completed bridges. A real 10-second reference film and native Windows playback were verified; full native sequence/cancellation and broader resource/audio-seam acceptance remain open.

## 0.2.33 BETA

- Fixed: moving a Linux video preview before it was ready could crash the window.
- Removed leftover debug logging from the Downloads plugin panel.
- The weekly Prompt Forge data update works again.

## 0.2.32 BETA (untagged; shipped in 0.2.33)

- H3 Continuity capture and Seamless loop can now be used together: the checkpoint keeps the unlooped Original, the looped video is still saved.

## 0.2.31 BETA (untagged; shipped in 0.2.33)

- Pictures made with wildcards now show the prompt that was actually used, both in the Media metadata pane and in Media Analysis **Made with**.

## 0.2.30 BETA (untagged; shipped in 0.2.33)

- **H3 Hi-Res Regenerate → Target resolution → Regenerate only, keep input resolution** refines the generated draft without enlarging it or requiring an upscaler model. Needs node pack 0.5.52; the Regenerate LoRA is still required. The source picture’s resolution is not used to resize the generated draft.
- The Post-Processing overlay no longer grows a horizontal scrollbar for long model names or warnings; scrolling on short windows still keeps every control reachable.

## 0.2.29 BETA (untagged; shipped in 0.2.33)

- Logs now name the internal phases of H3 Hi-Res Regenerate (LoRA preparation, each upscale and refinement window) and the model setup steps, so slow or failing steps are easier to find.

## 0.2.28 BETA

- Models you drop into the model folders while DEAS runs now show up without a restart: Post-Processing cards re-read the model lists when opened, and Studio re-scans the folders when you switch back to the DEAS window (at most every 10 s, no background watcher). Scanning no longer freezes the window.
- **H3 Regenerate 2K** is now called **H3 Hi-Res Regenerate**, because it targets 1080P, 2K and 4K. Update the node pack to 0.5.50 (Backend → Upgrade → ComfyUI and node packs).
- The Post-Processing panel no longer disappears behind a playing video on Linux and opens vertically centred.
- The Open-H3-Regenerate-2K LoRA converter can now leave out the bundled Turbo part (`--drop turbo`), for Turbo checkpoints that already carry it.
- Processing logs now name each stage (sampling, upscale, De-rope, face refinement, audio treatment, saving …) per job, so a slow or failing step is visible in Logs.

## 0.2.27 BETA (untagged; shipped in 0.2.28)

- New **H3 Hi-Res Regenerate** card under Post-Processing for MiniMax H3 videos: regenerates the draft at 1080P, 2K or 4K with the Open-H3-Regenerate-2K LoRA (convert it in Quant Station first). Needs DaSiWa node pack 0.5.50.
- Model choices now explain compatibility and availability consistently, with concrete damaged-file, stale-metadata, missing-loader and missing-companion hints. Library download actions remain explicit; no background hashing, automatic download or silent model substitution was added. See [model checks](STUDIO.md#contextual-model-checks).

## 0.2.26 BETA (untagged; shipped in 0.2.28)

- An ACE-Step all-in-one file placed in `unet/` or `diffusion_models/` now gets a clear "move it to checkpoints" note instead of a text-encoder download offer.

## 0.2.25 BETA

- Beginner **Music** shows only the basics (length, BPM, language, key, Steps/CFG/Sampler); split ACE-Step models without their text encoders get a download card instead of a dependency warning.

- H3 SAM **Auto Refine** now honours its denoise, and reference thumbnails can be dragged to reorder.

- **MiniMax H3 picture edits** can use the H3 **Latent upscale** after sampling (not with Inpaint).

- In **References**, pasting a picture onto a picture card replaces that file and keeps its settings.

- A wrapped preview toolbar no longer covers the picture.

- Beginner now uses **Image / Video / Music** too, with usable music model selection, Style/Lyrics and cover-source controls.

- **Music** combines Text to Music and Cover: explicitly assign a source to cover it, or remove the source to return to text generation. Authored text and model settings stay. ACE-Step retains its existing text-only capability.

- **Video** replaces the four video-mode choices: assign frame/reference/source roles in References and DEAS displays the resulting mode. Existing saved modes remain readable.

- MiniMax H3 Image → Image can use up to 8 reference pictures (`<Picture 2>` onward; the edited picture is `<Picture 1>`), plus a Denoise control (default 1.0). SAM Auto Refine on H3 now honours its denoise. The reference bar shows the edited picture as card 1; the first reference added without one becomes it.
- Text → Image and Image → Image are now one **Image** pipeline: pick a picture to edit (**Use as picture to edit**) to edit it, clear it to generate from text; settings stay.
- Image pipelines with prompt references get a **References** button that opens the reference overlay (Media picker + numbered bar), as video already had.

## 0.2.24 BETA

- The Comfy tab accepts native workflow/image drops, including images dropped onto an existing node.

- H3 face refinement also works with empty main/refinement prompts; no replacement text is inserted.

- Audio enhancement in Post-Processing is blocked for image pipelines; video/music access and saved settings are retained.

- Post-Processing settings are grouped into category cards with status and active counts (contributed by @Arasberk). Settings float in draggable, non-blocking overlays; cards incompatible with the selected pipeline are greyed out and blocked, without losing saved values.
- H3 face refinement can be limited to the main face of each shot (**Main face only**, off by default).

## 0.2.23 BETA

- **De-rope (fast motion) for MiniMax H3:** an optional second pass that re-renders smeared whip-fast motion after the Original is saved, with a turbo-LoRA (6 steps) or generation-model pass; tick **Generation is distilled (turbo)** when your generation already uses a turbo checkpoint or turbo LoRA. Needs DaSiWa nodes 0.5.43+ (0.5.45 for Keep static background). Results vary with content; both switches default OFF.
- **Maximize videos:** the Linux video player gets a **Maximize video** button; the same player fills the window and Escape brings it back.
- **Inpaint only masked has its Context padding right below it** (it used to hide in the SAM group as "Mask Shrink Grow").
- **Export into folders like ~/Videos works:** both exports failed when the save dialog went through a symlinked folder.
- **Face refinement:** follows faces that move across the frame, can skip faces below a minimum size, always runs at least 2 steps; default strength is now 0.3.
- **Keep static background:** an optional H3 De-rope switch retains original detail outside motion/changed regions. It defaults OFF, needs DaSiWa nodes 0.5.45, and falls back to the full second pass for broad scene changes.
- **Original before latent upscale:** H3 and LTX save the original video first, including H3 Continuity new-segment captures, so a later failed or stopped upscale can retain the take. Requires a compatible DEAS baseline gate in the backend.
- **H3 face refinement:** refine tracked faces of an existing H3 video window, or switch on **Refine faces after H3 generation** (default OFF). Faces are re-sampled by H3 in a close crop and stitched back; the original video and soundtrack are kept alongside.
- **Join clips:** assemble Continuity segments or video files into one video from the Continuity overlay, model-free.

- **Cut-safe mask analysis:** optionally restart SAM tracking at detected hard cuts inside the selected video window. A compact threshold control stays with face-mask analysis; the option defaults OFF.

- **H3 face-mask analysis:** Post-Processing gains explicit SAM3.1 face-mask analysis for a selected video window. It outputs a silent mask preview.

- **Less clutter in Inpaint:** SAM settings live in Post-Processing, without an extra navigation button in Inpaint settings. Available SAM checkpoints select automatically; point picking stays on the editor image and only creates a mask.
- **Result controls:** queue stars sit on the left, and preview Media Analysis/metadata-free export actions live in More.

## 0.2.22 BETA

- **New: Media Analysis.** Drop a picture on **Studio → Media Analysis** for its tags, the settings that made it and **Open in ComfyUI** for its workflow; press **Describe** for the picture in words from your vision LLM, with the characters it recognises and what the tagger missed. It uses the taggers you already have (WD14 node, animetimm ONNX, and others) and downloads one only if you have none and ask. Drop a video to get every frame in a strip: save frames, analyse one, or send it to Generate as a first/last frame or H3 picture (several picked frames at once as H3 references). Have animetimm taggers from ComfyUI's animetimm node? Media Analysis can convert them to ONNX for you, once, and use them. Describe has Temperature and Repeat penalty sliders, and you pick its model before it runs. [Media Analysis guide](MEDIA-ANALYSIS.md).

- **Videos can loop seamlessly.** In the video Post-Processing dock (and TVE) **Seamless loop** trims the clip to its best loop span and morphs the end into the start; the audio is cut and faded with exactly the same frame mapping, and **Beat-aware** picks a loop length of whole beats when the music has a clear tempo. The unprocessed Original is kept. Needs a node-pack update in Backend. [Studio](STUDIO.md).
- **Post-processed videos never lose the Original.** The unprocessed video is now encoded before any post-processing node starts, so a failing or cancelled post chain cannot cost you the take. [Studio](STUDIO.md).
- **A time-left estimate next to the step count** while sampling, measured from the job's own pace.
- **Arrow keys in the full-window viewer** step through the finished pictures of the queue, Original and Processed included.
- **Export without metadata…** saves a copy with no prompt, workflow or settings; pixels stay byte-identical, videos and audio are remuxed without re-encoding.
- **Open in ComfyUI and the metadata pane work again with newer ComfyUI frontends** (frontend 1.57 changed its app export).
- **Create RefMods from the References tab**, and RefMods in your own models folder are now found by the owned backend. [Studio](STUDIO.md).
- **Stop asks only when there is more than one thing to stop**, and its first item stops the run that is generating.
- **Switching between pipelines of the same kind keeps your prompt.**
- **Chat can run on your local GGUF models**, and SAM Auto Refine shows its passes in the queue.
- **Small fixes:** videos show a thumbnail instead of ▶, dock tabs count what is switched on, the Denoise slider no longer shows "?" for videos, pictures can be pasted into Media and References, Beginner shows Steps and CFG, and Comfy prompt text is sharp at every zoom level.

## 0.2.21 BETA

- **AMD Radeon (Linux) can run the owned ComfyUI backend** — setup detects RDNA2–RDNA4 cards, installs the pinned ROCm environment and verifies with a real computation; RTX Video refine and RTX frame generation stay NVIDIA-only and are refused at submit with a named reason. First real RDNA hardware is still the acceptance gate. [Backend](BACKEND.md).
- **MiniMax H3 auto-picks the clean video VAE.** Installing the fast `minimax_h3_sol_vae_*` no longer silently makes it the default and repaints every frame with 128/256-pixel seam lines; the proven blending VAE is chosen per family order and the Sol decoder stays selectable by hand.
- **The enhanced video preview plays as a video again.** The companion's fragmented-MP4 animated previews are accepted by the preview guard and fed to the looping player instead of silently falling back to a still image.
- **Consent popups now sit on top of the video preview.** Install confirmations and other asks use a real in-app dialog — no more half-unreadable confirmations blended behind the preview pixels; the preview steps aside while a dialog is open.
- **Comparing models in the same family keeps your settings.** Switching between two H3 (or other same-family) checkpoints no longer resets steps/CFG/sampler/scheduler/size; each model's own remembered draft still wins, and family switches still apply that family's defaults.

## 0.2.20 BETA

- **Local GGUF models can now see your reference pictures (#28).** Put the matching `*.mmproj*.gguf` projector file next to the model in DEAS's LLM folder and Prompt Forge sends pictures through DEAS's built-in runner; a model without one says so honestly instead of guessing.

- **Chat now makes pictures and writes prompts itself.** Ask Chat for a picture: it writes the prompt with the Prompt Forge writer of the checkpoint selected in Studio → Generate and draws it there with your current settings — edits across messages ("make the highlights teal"), asked sizes (`16:9`, `1080p`), and a conversation list with right-click Rename, Pin and Delete. On one GPU, the chat model and ComfyUI step aside for each other. Video models still write through their Prompt Forge mode. [Usage](CHAT.md#making-pictures).

- **Prompt Forge stops runaway writers.** A write with Length on Default now has an 8,192-token ceiling, and a write that runs past it is refused instead of kept half-finished. A Length you set still cuts off exactly as before.

- **Theme editing now stays inside DEAS.** **Quick Settings → Edit themes** opens the editor in its own frame — no browser tab — and its **Edit theme** list offers the themes of your selected environment, saving straight into that theme folder with a backup of the previous manifest. [Theme guide](THEME-PACKS.md).

- **H3 Enhanced preview setup fixed.** The explicit ComfyUI/node-pack update now includes the missing pinned preview node pack. Tiny VAEs in configured `vae_approx` and existing `vae` folders become visible without moving files; Options explains when the backend update is required. Reopen this build, then approve the ComfyUI/node-pack update on an idle owned environment. No preview weights are downloaded automatically.

- **Video metadata repaired end to end.** New saves embed strict-valid metadata; the pane shows the actual prompt and settings (old `NaN` files parse too). Audio-enhanced videos keep that metadata and get a readable `-audio-enhanced` name instead of a UUID file. Civitai still cannot show prompts for H3 node graphs until it supports those node types upstream.

- **Video/audio UX fixes.** Opening Metadata next to a video no longer blanks the preview (side-by-side layout, playback preserved). FLAC references play with real duration and cropping in the editor. "Use these settings" works for finished videos from History, and each More menu behaves independently.

## 0.2.19 BETA

- **Image refinement saves Original first.** Optional image refinement now waits for the encoded Original before starting its post-processing branch, so a later upscale/refine failure does not lose that completed image. Requires the compatible DEAS adapter and saver; start the owned backend explicitly with this build to install the adapter. This does not yet change video ordering.

- **Stop one generation or the whole queue.** Stop now opens a choice instead of immediately stopping everything. Cancel or Escape leaves work running. The selected-item action keeps other jobs and preparations intact; real-backend/native-platform acceptance is still open.

- **H3 opening-frame seams corrected.** Image → Video now defaults to *Fill and crop* reference scaling, so a picture with a different canvas ratio no longer distorts the first frames; the H3 scaling option formerly named *Auto* is now **Native (ShortEdge 2048)** because it only shrinks and never fits.
- **SAM masking and Auto Refine are being integrated.** Select objects with text, points (Alt-click excludes) or a box; refine ordered targets such as `eyes; feet; hands` without changing the generation prompt. Automatic post-generation refinement is opt-in, with manual refinement for existing images and retained originals. SAM weights require separate license acceptance and manual installation. This unreleased integration is not yet real-model or native Linux/Windows accepted. [Guide](STUDIO.md#sam-31-masking-and-auto-refine).

## 0.2.18 BETA

- **Audio enhancement is ready when you open the tab.** Processing options load immediately, **Enhance audio and save…** accepts bookmarked (symlinked) folders, and enhanced video keeps the container and audio codec your TVE/video-combine output picked instead of forcing MKV/FLAC.

- **Use output pictures in Prompt Forge.** Generated reference images and first/last frames are readable by Forge, Cast and Find people without moving them manually into input. Vision controls explain when images are sent.

- **HyperFlow H3 Flash (fast MiniMax H3) works in the Studio.** Put a `minimax_h3_*_hyperflow_flash_14b-*.gguf` from [VideoRebirthAI/hyperflow-h3-flash](https://huggingface.co/VideoRebirthAI/hyperflow-h3-flash) into `diffusion_models/MiniMaxH3/`: DEAS detects it as a HyperFlow variant, defaults to 6 steps with euler at CFG 1 (4/6/8 selectable) and runs the usual H3 pipelines with Continuity. The node pack installs itself with the ComfyUI update. The INT8-convrot files on that hub are not a ComfyUI format — use the GGUF quants (Q4_K_M ≈ 9 GB).

- **Edit themes from Quick Settings.** DEAS creates a starter theme in your environment only when needed, opens the offline editor, and no longer ships duplicate copies of the built-in palettes. Save a unique theme, refresh, and choose it. [Theme guide](THEME-PACKS.md).
- **Smaller Beginner guide bundle.** The four large model-guide illustrations were removed. The guide text, tags, credits and publisher links remain.

## 0.2.17 BETA

- Monitoring, Run Plan, Backend and Logs are grouped on the right; creative tabs remain on the left.
- ACE-Step exports using the `ace-step-1_5` header identifier are recognized correctly, including models found under UNet.
- This release also publishes the Beginner workspace, optional audio enhancement and ACE-Step improvements listed below.

## 0.2.16 BETA (untagged; shipped in 0.2.17)

- Beginner layout refinement: resize directly between preview and prompt, no lower Media dock, rounded Run/Stop ends, and a full-width Beginner/Advanced light switch in Quick Settings.

- ACE-Step now has Text to Music authoring and native recipes for original 1.0 and resolved 1.5/XL Base, SFT and Turbo, with distinct defaults, AIO/split components and separate code-LM controls. Model detection explains uncertain filename evidence in Edit meta; prompts and model-specific overrides are retained. Graph/UI validation is covered; real-model inference remains unverified.

- Beginner now has one creative invitation in the preview, with pipeline instructions kept below it, no Local workspace badge or project controls, and restored pane resizing/collapse arrows. Switch Beginner/Advanced in Quick Settings just above Reset layout.

- Clicking a Linux preview video now pauses it; clicking again resumes playback. The existing playback buttons remain available.

- Beginner mode now looks and works like the advanced Studio: the positive prompt field with tag help sits under the preview without extra buttons; the job queue and all Generate controls appear on the right. Both modes share the same tab styling without a separate DEAS Studio logo; the separate right-hand Engine button is now a matching **Backend** tab, and **Collection** is now **Media**.
- Drag-and-drop of files from your desktop into DEAS now lands correctly on Linux screens with scaling, and dropped images can target the Beginner starting-image row directly; theme editors accept images dragged onto their image rows.

## 0.2.15 BETA (previously local-only; shipped in 0.2.17)

- DEAS now asks **You are… A beginner / An advanced user** on first launch. Beginner mode keeps only Generation (model, LoRAs optional, prompt), Models and Collection; the Engine button reaches setup, and the top-right Beginner/Advanced switch restores your full technical workbench untouched. [Beginner mode](BEGINNER-MODE.md).

- Audio enhancement now offers **Clean**, **Deep** for speech and **Stems** with Smule Labs Windowed RoFormer. Select a mode before video/music generation or TVE enhancement to chain it automatically; audio-only new-copy export also works without video enhancement. Originals remain available. Model/runtime downloads are explicit; Smule's CPU path is currently slow and requires a C++ compiler. [Audio enhancement](AUDIO-ENHANCEMENT.md).

## 0.2.14 BETA

- Install local colour/image themes from `theme-packs/`, customize them with the offline editor and apply changes through Quick Settings → Refresh themes. Existing packs and saved selections are not overwritten. [Theme packs](THEME-PACKS.md).

- Reuse SwarmUI `Stable-Diffusion` and `Lora` folders through the existing model-root settings, including existing directory links. Model-family sidecars are saved beside the actual file without moving weights. The checkpoint dropdown filters candidates for the current pipeline and keeps an unavailable saved selection explicit.

- Hand-edited config files saved with a UTF-8 BOM (PowerShell, VS Code "UTF-8 with BOM") now read correctly: startup settings, model folders, Studio presets, wildcard libraries and opened JSON documents.

- Output-naming failures preserve originals and roll back incomplete publications. Temporal tiled-refine restrictions now also apply to direct native requests. Old guided-setup-only code is removed without changing automatic installation.

- Paste clipboard pictures into the active Forge editor; ordinary text paste still works. Chat can read later guide pages, including Music, App updates and TVE documentation, within its existing tool budget.

- Reuse image/video settings from the media context menu, preview toolbar or a preview drop. Queue prompt reuse is separate and never starts generation. Embedded metadata is explicitly partial; exact queued intents take precedence.
- Restoring compatible Qwen Image 2.1 Turbo LoRAs no longer reports the base model family as incompatible; missing models remain blocked.

- Wildcard categories and your own JSON variables now work as `$name` prompt variables: same seed = same pick, per-occurrence pins win over the seed, the Wildcards live pane shows the exact resolved prompt, chips under the prompts show picks and remove a token with ×. [Prompting guide](PROMPTING.md#wildcards).

- Default sampler is euler everywhere (Illustrious CFG 3.5); family defaults follow the current official recommendations.

## 0.2.13 BETA

- **SD3 and SD3.5 are selectable.** Pick `clip_l`/`clip_g` and `t5xxl` in the two encoder slots plus the SD3 VAE; the recipe uses the dual CLIP loader, the SD3 latent and a shift-3 sampling patch.
- **Chroma and Chroma Radiance are selectable.** Both use the T5-XXL encoder with type `chroma`; Chroma runs the Flux latent, Radiance the pixel latent. The family id keeps the two apart.
- **HiDream is selectable.** `llama_3_8b` plus `t5xxl` in the two encoder slots, the Flux VAE and latent, no sampling patch.
- **PixArt and HunyuanDiT are selectable.** PixArt takes the single T5 encoder, HunyuanDiT the dual `clip_l` + `mt5xl` pair; both use the SD latent and need no sampling patch.
- **Lumina2 is selectable.** Pick the all-in-one NetaYume checkpoint; the family brings the SD3 latent and the AuraFlow shift-4 sampling patch. Z-Image stays separate through the tensor-shape check.
- **SD1.5 and SD2 are selectable.** Plain checkpoint families: SD latent, no sampling patch, grid 8, 512×512 at 20 steps CFG 7. SDXL keeps its own two-encoder signature.
- **Kandinsky 5 Image is selectable.** Qwen2.5-VL-7B encoder, Flux latent, no sampling patch.
- **Ideogram 4 and Boogu Image are selectable.** Ideogram 4 uses the Qwen3-8B encoder and the Flux2 latent; Boogu the full Qwen3-VL-8B encoder and the Flux latent.
- **OmniGen2 is selectable.** Qwen2.5-VL-3B encoder, Flux latent, no sampling patch.
- **Fibo 2.0 and Ernie Image are selectable.** Fibo 2.0 uses Qwen3-VL-4B and Ernie Ministral-3-3B; both take the Flux2 latent.
- **Flux.2 is selectable.** Klein/Dev with the Qwen3-4B or Mistral-3-small encoder, Flux2 latent and VAE; the graph uses Flux2Scheduler with CFGGuider instead of KSampler.
- **Flux.3 is selectable (unverified).** Qwen3-VL-4B encoder with the Flux2 latent and the same scheduler path.
- **Mage-Flow is selectable.** Qwen3-VL-4B encoder and Mage-Flow VAE; prompt, negative and latent come from one encode node, 30 steps at CFG 5.
- **PixelDiT is selectable (unverified).** Gemma-2 encoder, pixel latent, no sampling patch.

## 0.2.12 BETA (untagged; shipped in 0.2.14)

- **Flux.1 is selectable.** Pick the Flux.1 diffusion file, its `clip_l` and `t5xxl` encoders (the second one in the new **Second text encoder** picker) and the Flux VAE, then run Text to Image or Image to Image. The recipe uses the dual CLIP loader, the SD3 latent, a zeroed negative and the blueprint's 20 steps at CFG 1.
- **Two-encoder families no longer need compiler code.** A family declares its dual loader and the second encoder slot; both compilers read the same optional field.

## 0.2.11 BETA (untagged; shipped in 0.2.14)

- **Z-Image is selectable.** Choose the Z-Image Turbo diffusion file, its Qwen3-4B text encoder and the Flux VAE, then run Text to Image or Image to Image. The family brings its own SD3 latent, sampling shift and zeroed negative, so the numbers are the model's, not generic ones.
- **New image families are data, not code.** A family now declares its latent node, negative handling and sampling patch in the bundled family file; unknown models keep the plain recipe.

## 0.2.10 BETA

- **Prompt Forge:** dropping a picture on the Reference images zone works in the native shell, and a drop with no usable picture says so.
- **Ctrl+Enter runs**, through the same Run button, so a disabled Run stays disabled; plain Enter still picks a tag or spelling suggestion.
- **Tiled refine is refused up front on Anima, Krea 2 and H3**, whose latents are 5-D; plain refine still runs.
- **H3 input scaling starts on Auto**, like the Director; a saved choice and jobs saved before this keep restoring as before.
- **Multi-reference → Video Auto aspect** follows the first picture or video by slot, as the Director does; sound-only uses don't count.
- **Undo survives tag and spelling picks**: Ctrl+Z works after picking a suggestion.
- **Videos get the More menu** with **Use these settings** and **Reuse prompt** from the job that made them.
- **Clicking the queue only previews**; right-click a job for **Use these settings**, and Stop stays for active jobs.
- **Changing the checkpoint keeps your prompts** exactly; the model's other settings still come back.
- **GitHub issue forms** for bug, enhancement, question and documentation reports, with version/update fields and a reviewed log export.
- **Checkpoint picker:** the compact native dropdown is restored, without the custom expanding list or extra filter field.
- **MOSS-Image inpaint:** a painted mask (Inpaint mode) works with MOSS now, with the same graph as every other image model.
- **Prompt Forge and Chat use the saved LLM key** for an OpenAI-compatible server, instead of failing with HTTP 401.
- **Library downloads:** files up to 128 GiB, a job up to 256 GiB, no one-hour cutoff, and an interrupted transfer resumes with `Range` and verifies the full SHA-256.

## 0.2.9 BETA

- **Monitoring tab:** the last ten generations with queue wait, generation time, a timeline bar and per-job hardware peaks, plus live CPU, RAM, GPU, VRAM and disk I/O graphs, three per row and sharp at any window size. Works with the backend stopped.
- **Image models can use a local GGUF** for Prompt Forge and the hammer, with no LLM server; Prompt Forge can now be cancelled, and Regenerate on a local GGUF gives a new result.
- **Windows:** RTX VSR / frame generation loads again (`NvVFX_Load … code -12`; takes effect on the next backend start), a local GGUF in a deep folder is no longer "invalid", and the local GGUF runner finds its CUDA DLLs.
- **Checkpoint picker filter:** type to narrow the Studio model list when more than eight models are installed.
- **Logs show progress bars live** instead of only the finished bar.
- **One button look everywhere**, drawn from the active theme.
- **Global search** finds Options cards and Backend controls; Library groups creator sources and names all category tabs.
- Latent upscale no longer complains about a missing upscaler model right after start while the backend is still answering.
- Video prompts say the backend isn't running instead of "Prompt Forge request failed"; a missing spellcheck dictionary is a warning, not an error; cleaner Prompt Forge image prompts.

## 0.2.8 BETA

- **Stop really stops.** The Stop button next to Run interrupts the running generation (long videos, many-step images) again instead of only clearing the queue. Takes effect after the next backend start.
- **MiniMax H3 image edit / inpaint runs again**, with and without a mask (the saver's metadata config pointed at nodes the H3 graph removes).
- **LLM backend:** thinking models (Qwen3.5, gpt-oss) on Ollama answer again instead of "LLM response has no valid text"; OpenAI-compatible servers accept an **API key**, also used by Prompt Forge.
- Click a video preview to play/pause it.
- Presets tab: **New preset…** opens the preset overlay with your changed settings; Post-Processing tab is grouped by stage (Latent upscale, Upscale model, TVE).
- Quick Settings: the spellcheck and tag-autocompletion toggles now show whether they are on.
- **Spellcheck now works the same on Linux and Windows.** DEAS checks prompt fields itself (Studio prompts, Prompt Forge, Chat) with the downloaded Hunspell dictionary — wavy underline, right-click or Ctrl+. for suggestions. Install the dictionary once under Backend → Language; no restart, no admin rights, nothing leaves your PC.

## 0.2.7 BETA

- TVE **Enhance** now shows queued/running/failed itself and prints the backend error instead of staying on "Queued" while the Studio queue is closed.
- TVE RTX stages gained **Disk fallback (use_mmap)** and **Frames per chunk**, so the out-of-RAM advice from the node is reachable from the app.
- Loader errors name the model file, and truncated safetensors are flagged in the Library and never auto-selected.
- **Global search.** A magnifier in the top tab band (Ctrl+K) finds controls across every tab by breadcrumb — Studio settings and prompts, Forge, Chat, TVE, Run Plan stages, Library, Comfy, Backend and Logs — and switches to the hit, opens its group, scrolls to it and flashes it. A control that does not apply right now shows why instead of doing nothing. Search never writes a setting, submits a job or calls the backend.
- **Spellcheck dictionary install (Linux).** When no dictionary exists for the spellcheck language, Backend → Language offers **Install dictionary** for German, English, French and Turkish: the pinned Hunspell pair goes into your user folder, no admin rights. Japanese and Chinese say that no Hunspell dictionary is published instead.
- Windows: installing into a folder with a space (including a user name with a space) no longer fails at Requirements.
- Prompt Forge keeps a written result through a tab switch or the backend finishing its start, and says "No LLM server found" instead of "no models" when that is the actual gap.
- Setup steps past a folder left by a failed or cancelled install (`…-2`) with a note; the old folder is never reused or deleted.
- The footer update arrow clears as soon as a ComfyUI or node-pack update finishes.

## 0.2.6 BETA

- Windows: the backend starts again instead of hanging on "Starting — verifying owned API" / the Backend API check and timing out after 120 s (`object_info … BACKEND_UNAVAILABLE` in Logs).
- After a driver update, Reinstall or Update ComfyUI clears the "hardware/driver changed" start error.

## 0.2.5 BETA

- Quick settings grey out the spellcheck button when no dictionary is available instead of showing a long message.
- Videos in the Comfy tab play again on NVIDIA systems instead of freezing on the first frame.
- In the Prompt Forge tab, **People & order** is shown openly for each frame/reference picture. The button that opens the Forge tab is the hammer again, with inverted colours.
- Studio: an arrow on the Settings edge and on the bottom panel's edge collapses that pane fully and brings it back.
- Everything in a media file's right-click menu (reference, first/last frame, source, cover) is now also a button in the preview toolbar.
- Library: **Catalog source** now also offers the CivitAI creators TrashAI, LolTurdFerguson and DustyDrab; DaSiWa stays the default.

## 0.2.4 BETA

- Backend updates, reinstalls and environment moves now stop a running ComfyUI gracefully and start it again afterwards; a stopped backend stays stopped. Updated Linux DEAS binaries reopen by themselves.
- **Move environment…** in Backend moves your whole DEAS environment to another folder or drive without reinstalling; DEAS fixes the paths inside the venv and checks the moved Python before switching. A running owned backend is stopped gracefully and restarted afterwards; a stopped backend stays stopped.
- H3's **Prompt Forge** button beside Continuity opens the existing tab with the current run's references, people/order and full Director prompt controls. First/last-frame people editing moved out of pipeline settings; drafts and cards stay when switching tabs.
- Right-click an image in the Media menu to use it as **first frame**, **last frame** or both. MiniMax H3 can run Image → Video from a last frame alone.

## 0.2.3 BETA

- MiniMax H3: the new Sol VAE (`minimax_h3_sol_vae_fp16.safetensors`) shows up in the VAE picker. Update ComfyUI first — it needs the upstream Sol-H3-VAE support.
- Backend shows where your DEAS environment is installed, with a button to open the folder.
- The startup splash no longer just flashes on fast starts.

## 0.2.2 BETA

- Changing folders in Backend → Settings now restarts a running backend, so newly pointed model folders (e.g. MOSS) are found right away. A running generation is never interrupted; you get a note to restart afterwards.

## 0.2.1 BETA

- **Startup splash** with the real startup phase; the main window appears once your workspace is restored. The owner's Catgirl artwork slot is ready but still empty.
- **Backend not ready?** Studio says so in one calm line and disables Run, instead of a red list of "incompatible" dependencies.
- **Stop** is quiet and frees the queue; right-click a queue entry to stop just that generation.
- The preview toolbar always sits top right; Linux audio previews (YuE2 FLAC) play through the native player with controls at the bottom.

See the [changelog](CHANGELOG.md#0211-beta-untagged-shipped-in-0214) for details.

## 0.2.0 BETA

DEAS moves from ALPHA to **BETA**. Version `0.2.0` includes the `0.1.67` development work below. BETA is not a production-readiness claim: platform, model and playback acceptance remain as recorded in [the plan](PLAN.md) and [verification](VERIFICATION.md).

## 0.1.67 (untagged; shipped in 0.2.0)

H3 latent upscale has a **☰ More upscaler options** menu in Post-Processing with all remaining node settings (refine CFG/scheduler, precision, tiling/chunking, memory planning, Spike Guard, Continuity soft refine), starting at the node defaults. Cover Music now finds SheetSage2 encoders in your models folder's `audio_encoders`. See [Studio](STUDIO.md#learned-video-latent-upscale-0164-shipped-in-0166) and [Music](MUSIC.md).

## 0.1.66

Generate now offers **Music (Text to Music)** and **Music (Cover Music)** for YuE2 checkpoints: independent Style/Lyrics editors with ABC Off/Full/Melody planning, maximum duration and advanced sampling; covers build a new song from the melody of a selected audio file or video-with-audio. Outputs are FLAC, kept in Recent history with full settings restore. Real-model generation and native playback acceptance are still open. [Usage and limits](MUSIC.md).

## 0.1.64 (untagged; shipped in 0.1.66)

Generate's Post-Processing adds learned H3 and LTX latent upscale, separate from TVS and LTX's existing multipass refinement. Enable it, select the compatible latent model, and review the final canvas before Run. If weights are missing, a Library popup offers the family-specific model in `latent_upscale_models`; opening it never starts a download or generation. [Usage and limits](STUDIO.md#learned-video-latent-upscale-0164-shipped-in-0166). Shipped in 0.1.66.

## 0.1.63 (untagged; shipped in 0.1.66)

Studio adds inline character counts and shared writing aids for normal/enlarged prompts. Configure the independent spellcheck language below Backend’s language selector; toggle spellcheck and optional local Forge-tag completion there or in Quick Settings. Completion starts off. See [usage and dictionary requirements](STUDIO.md#prompt-writing-aids-0163-shipped-in-0166). Shipped in 0.1.66.

## 0.1.66 — Chat prompt routing fix

Chat now keeps the requested generation model: it refers to that model’s Prompt Forge mode first, falls back only to a compatible registered simple writer, and otherwise says no compatible writer exists. H3 requests no longer end by offering four unrelated image models. Referrals name the exact Write for mode without switching tabs or modifying drafts automatically. [Usage and limits](CHAT.md).

## 0.1.66 — model folder fix

Studio now explains known models in the wrong loader folder instead of offering them as runnable. Anima belongs in `diffusion_models` (or `unet`) for its split recipe, not `checkpoints`. Files remain visible; move them yourself and refresh the list. Native preparation also distinguishes an opposite-loader listing from a missing model. No model moves or automatic loader changes. See [Studio model controls](STUDIO.md).

## 0.1.62

H3 References separates selection from editing: compact thumbnails show the current crop and stream choice, and the copper-glowing Edit button opens one larger media dialog. Close/Escape retains changes and returns to the card; the underlying reference picker stays open. Existing crop/playback, people and Forge controls are retained. Linux keeps native libmpv playback and uses cached FFmpeg thumbnails. [Usage](STUDIO.md#multi-reference-overlay). The preview **More** menu closes on its own click and outside clicks; **Use these settings** moved there from the metadata dock, next to the new **Reuse prompt** which refills prompt and sampler settings from a file's embedded metadata.

## 0.1.59 — References overlay

Multi-reference authoring now has a Continuity-style References popup with its own media picker and inline previews. Choose picture, sound or both from a video, set crop endpoints with fields/sliders or the playhead, and audition only that segment. Existing Director labels, people controls, packs and RefMods stay available; edits do not rewrite source files. See [Studio](STUDIO.md#multi-reference-overlay) for supported paths and remaining parity limits.


## 0.1.58 (untagged; shipped in 0.1.59)

H3 Continuity is now available for Video → Video and Multi-reference → Video as well as text/image inputs. Continue a pinned checkpoint or prepared input video with the existing serial planner, and opt in to current reference conditioning when needed. Generation and Next action Forge use the same reference policy. The Director’s mode-family and canvas checks remain authoritative; this does not add LTX/Wan continuity or establish real-model seam quality. [Usage](STUDIO.md#ref2va-continuation-references). Shipped in 0.1.59.

## 0.1.54 (untagged; shipped in 0.1.55)

TVE adds native file-authority preparation and an optional Linux rendering engine. Explicitly bind trusted runtime/model files, validate and render a short SDR clip, or Stop its owned Rust worker. A real four-frame CUDA video passed the managed parent/worker/publication path with audio and source preservation; this is not full-resolution/general-model or Windows-render acceptance. See [workflow and limits](STUDIO.md#tve-workspace). Shipped in 0.1.55; since 0.1.56 every build includes the engine (still an explicit runtime opt-in).

## 0.1.53

TVE now has its own main tab. Inspect a video source, choose a scale/export-profile draft and explicitly check its exact output metadata in Rust; source/draft state survives navigation without computation. Image refinement stays in Studio. The draft is not a runnable enhancement job and does not verify an encoder, GPU or source cadence. See [TVE workspace](STUDIO.md#tve-workspace) and [remaining execution work](PLAN.md#42-video-post-processing-tve-and-paired-products).

## 0.1.52

Post-Processing can inspect a local video source without uploading or processing it. The native Rust check shows dimensions, exact frame-rate fractions and source limitations; cancel retains the last inspected result. This is a preparation feature, not video upscaling/interpolation/HDR rendering. The standalone video pipeline is required to use Rust without Go/Python workers. See [usage and dependencies](STUDIO.md#tve-workspace) and [video plan](PLAN.md#42-video-post-processing-tve-and-paired-products).

## 0.1.51 (untagged; shipped in 0.1.52)

Optional image refinement now produces labelled Original and Processed products for individual selection and comparison. Already-reported completed products remain available when later work fails or is cancelled. This is the first bounded post-processing slice, not a full video-enhancement port or a guarantee that a baseline saver runs before every failure. See [usage and limits](STUDIO.md#original-and-processed-image-products-0151-shipped-in-0152) and [remaining work](PLAN.md#42-video-post-processing-tve-and-paired-products). Shipped in 0.1.52.

## 0.1.50

Prerequisite diagnostics now accept Windows subfolder model paths (`Folder\model.safetensors`) against the backend's slash-separated model lists, fixing "diffusionModels are not available on this backend" for models inside subfolders (the `+` in model names was never the problem). Krea2 keeps full torch.compile support. See [verification](VERIFICATION.md).

## 0.1.49

Windows/Linux path fixes preserve exact backend model identifiers and output subfolders, repair media-reference/Starred matching and remove developer-specific script assumptions. MOSS reference readiness now checks its active encoder. Ordinary native Prompt Forge modes offer all fixed aspect presets from the main Settings while keeping legacy saved choices; Auto/Custom and MOSS layout/Generate geometry remain deferred. See [path compatibility](PATH-COMPATIBILITY.md), [Prompt Forge](PROMPTING.md) and [verification](VERIFICATION.md). Local unsigned binaries; native Windows runtime acceptance remains open.

## 0.1.48

This release includes the model-aware SDXL/Qwen/Krea/MOSS prompt-reference wiring developed under 0.1.47 below.
Prompt references use compact numbered picture thumbnails rather than full-width filenames. Remove a picture with its red X, drag pictures into a new order. The numbering follows the order used by the next generation; each picture keeps its own ReVision strength. See [image references](STUDIO.md#image-references).

## 0.1.47 (untagged; shipped in 0.1.48)

Studio’s prompt picture drop is now wired to the selected image family: SDXL ReVision, Qwen Image 2.1/Turbo native text/vision plus reference latents, and Swarm-style Krea 2/MOSS visual conditioning. Attached filenames and Run Plan show the inputs; model-specific prerequisites still apply. The small Krea/MOSS adapter is bundled for approved DEAS-owned backend starts, not silently installed into foreign backends. See [Studio usage/support](STUDIO.md#image-references) and [verification](VERIFICATION.md#unified-image-reference-wiring-0147). Shipped in 0.1.48; not a universal quality/identity guarantee.

## 0.1.46

The native-only cancellation foundation can remove one correlated queued prompt or request a scoped interruption of one running prompt on the current owned backend, with explicit confirmation and readback. Running interruption uses an authenticated DEAS queue-locked route and is confined to inspected backend sources; no Studio cancellation button or whole-queue Stop is enabled. Confirmed cancellation has a six-language terminal label. Repeated Run/Stop still awaits whole-queue lifecycle integration. See [running-interrupt verification](VERIFICATION.md#scoped-running-interruption-and-status-abort-recovery-0146) and [pending-cancel verification](VERIFICATION.md#native-pending-cancellation-foundation-0146).

Image Run now reports a missing Wildcards plugin before preparation instead of failing after the click; enabled settings remain until explicitly disabled. The native all-job polling foundation is tested but is not connected to Studio yet, so repeated Run/Stop remains planned. See [verification](VERIFICATION.md#workbench-all-job-polling-foundation-and-wildcards-readiness-0146).

## 0.1.45

MOSS-Image gains a bounded t2i/i2i generation adapter through the existing image pipeline. Queue thumbnails now place stars on their corresponding outputs and show measured generation duration. This is not MOSS inference acceptance. Repeated Run/Stop, generation-reference prompting and Prompt Forge aspect-ratio parity remain open. See [Studio](STUDIO.md) and [verification](VERIFICATION.md#moss-image-adapter-and-queue-presentation-0145).

## 0.1.44

Native image Prompt Forge, Studio Chat and colour schemes are integrated. The required prompts, Randomizer and optional tag/character tables ship in the executable; native LLM model selection works without starting ComfyUI. DEAS is now licensed under GPL-3.0-or-later. See [Prompting](PROMPTING.md), [Chat](CHAT.md) and [data provenance](../src-tauri/forge-data/README.md).

## 0.1.42

Save custom Studio configurations in **Presets**, load them later and edit/update them for quick reuse. **Wildcards** remains a separate tab with the existing prompt-library controls. See [Presets](PROMPTING.md#presets).

[Documentation index](README.md) · [Plan](PLAN.md)

News summarizes user-visible development changes; it is not proof that a tagged release, signed artifact or platform acceptance exists. Check [official releases](https://github.com/darksidewalker/DEAS/releases), the [full changelog](CHANGELOG.md) and [verification evidence](VERIFICATION.md).

## 0.1.41 (untagged; shipped in 0.1.42)

- Studio keeps companion file choices under the compact **Model files** disclosure beneath its other settings. Its Checkpoint dropdown and Models tiles update each other; all Settings dropdowns share the compact selector style.

## 0.1.40 (untagged; shipped in 0.1.42)

- Studio can recognize supported companion architectures without relying on their download names. Each text-encoder/VAE selector also has its own **All files** switch for manual selection, including audio VAEs and text projections where required. Switches default off; selecting unverified components is not a compatibility guarantee. See [Studio component selection](STUDIO.md#text-encoders-vaes-and-companion-files).

## 0.1.39

- Opening raw/starred now creates the missing fixed directory under the selected native-approved Output folder; arbitrary missing browse paths still show errors.

- New renders use Output/raw; the star moves them to Output/starred under the same named subpath, and Unstar reverses that switch. Older stars need no new records. Input tiles have no star. Output, Starred and Input buttons navigate directly; the Output-relative tree starts at root instead of showing the full filesystem trail.

## 0.1.38 — 2026-10-21

- Resize the Settings and Queue columns against the central preview. Quick Settings beside GitHub separates layout reset from confirmed generation-default reset. Missing LLM setup takes you directly to the LLM Backend pane.
- Project actions move beside Run. Export/import a portable **draft ZIP** containing baseline image settings and its managed input PNG; generated results and full Studio-state persistence are still not included.
- Star eligible generated media to physically move it into Output/starred. Native safety checks keep unmanaged/project-linked/sidecar-associated files unavailable rather than risking broken references.

## 0.1.37 (untagged; shipped in 0.1.38)

- Backend configuration now uses a left-hand menu for Startup optimizations, LLM backend and Provider authorization, shown in one matching right-hand pane. Switching panels retains unsaved drafts; explicit Save/Apply behavior is unchanged.

## 0.1.36 (untagged; shipped in 0.1.38)

- Image previews now fit to the available window edge over a semi-transparent, non-checkered background. Click outside the image to close; zoom and pan remain available. The transparent DEAS v… footer shows backend startup progress, then a brief green check that vanishes after 3 seconds.

## 0.1.35 (untagged; shipped in 0.1.38)

- Use nearly the whole window: 3px exterior edges and a floating version hint. Backend and Logs join the top tabs; GitHub/star move to the header right. Backend now shows its settings and provider authorization directly, with a compact status overview. Click a read-only image preview for zoomable full-window viewing; edit canvases keep their existing behavior.

## 0.1.34 (untagged; shipped in 0.1.38)

- More vertical space for media: one top tab band, footer utilities and Backend-owned installer/authorization. Browse media without replacing your edit draft, and return shifted images to a clearly marked original frame.

## 0.1.33 (untagged; shipped in 0.1.38)

- Closing the main window waits for pending project changes: save first, or explicitly discard a failed draft. A missing close guard is reported instead of silently implying protection.

- Keep baseline image settings and an explicitly imported PNG in a native project folder, then reopen them without starting a job. Global Studio defaults remain separate. Jobs, generated results, optional processing and editor layers are not restored by this first slice; see [Projects](PROJECTS.md).

## 0.1.32 (untagged; shipped in 0.1.38)

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

## Included maintenance (0.1.31)

- H3 character references gain manual people boxes for directing Cast reads. **Find people** now offers explicitly applied candidates through the selected vision model; stopping is best effort. Real vision quality and native-platform interaction are not newly verified.
- H3 character references gain **People & order** for selecting people and their spatial arrangement. Manual/detected boxes are available separately; frame-mode Cast controls remain planned.
- MiniMax H3 reference pictures support ordered character-group labels and separate Cast cards per member, with Director-compatible pack storage. Vision/model and native-platform acceptance are still open.
- Rust-first, cross-platform, atomic-plugin and ComfyUI coexistence rules are now project-local. A consolidated implementation plan distinguishes code, recorded acceptance and missing work.
- User documentation now lives in focused guides under `docs/`; README is the short installation/start/documentation entry point. Changelog history is preserved here, with a root compatibility pointer.
- NVIDIA preflight retains the host driver environment and returns bounded failure stdout/stderr and raw exit diagnostics; regression tests accompany the change. This is not Windows runtime acceptance.

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
