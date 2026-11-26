# Dark Wizards

**Studio → Dark Wizards** holds guided helpers for common jobs. You give a wizard a picture and a few words; it picks a fitting installed model, the pipeline, the prompt and the output size, and **prepares Generate**. Nothing starts on its own: Generate shows the prepared draft, the Run Plan shows exactly what would be submitted, and you press **Run** there — or press **Prepare and run** in the wizard, which asks Generate to start that same draft (see below). A wizard run is an ordinary Generate job in the ordinary queue.

The tab is in Advanced's top band; Beginner reaches the same wizards as the **Wizards** page of its band (see [In Beginner](#in-beginner)).

## Replace

Swaps a person, object or detail in a picture for something else — described in words, or taken from a second picture.

1. **Picture to change** (B) — drop a PNG, JPEG or WebP file on its area, paste one (Ctrl+V anywhere on the tab), or press its **Choose…**. A file copied in a file manager is used from its own location. A picture pasted as image data (for example copied from a browser) is first saved to the backend's Input folder, the same way the Media dock's paste does.
2. **Object to put in** (A, optional) — a picture of what should go into B: a person, a product, a piece of clothing. Paste and drop go to the highlighted area; after B is set, the object area is highlighted. Click an area to choose where the next paste goes; **Remove** clears it.
3. **Replace what** and **With what** — for example *the red car* and *a blue bicycle*. With an object picture, *With what* is optional and may name the object in it (*the dog*); without it the prompt says *the main object*.
4. **Method** — the wizard selects the first method with an installed model; you can switch when both are available. Both methods prefer the same Qwen Image 2.1 / 2.1 Turbo model, so switching keeps the selected model:
   - **Reference edit (Qwen Image 2.1)**: B becomes the first prompt reference (`image 1`) of a text-to-image edit in Generate's **References**, A the second (`image 2`). The prompt reads *Replace the red car with a blue bicycle. Keep everything else in the picture unchanged.*, or with A *Replace the red car in image 1 with the dog from image 2. Keep everything else in image 1 unchanged and match its lighting and perspective.* The output size keeps B's aspect ratio at the model's default pixel count, on the 32-pixel grid Qwen reference encoding needs (the first reference fixes the output geometry).
   - **Paint a mask (inpaint)**: Generate opens B in **Inpaint**. With an object picture and a Qwen model, the wizard hands over the **reference edit** on the same model instead and says so: a masked edit with both pictures as references kept the old object in tests, while the reference edit replaces it. Paint over the area that should change, then press Run; Run stays disabled until a mask is painted. Preparing sets Generate's Inpaint strength to 1 so the masked area is redrawn completely (at a lower strength the old object's shape and colour stay), and Mask blur to 4 px. **Prepare and run** makes the mask for you with SAM 3.1 (see step 6). Inpaint keeps B's size, so B must already lie on the model's grid (32 px for Qwen with references); the wizard says when it does not and offers **Crop to W×H**: it saves a centred crop on the grid as a new picture in the Input folder (named after the original plus `-grid-W×H`, never overwriting a file) and uses that copy as B. Only the few edge pixels past the grid are cut — at most one grid step less per side in total, split between both edges — and nothing is resampled, so the kept pixels stay exact; the original file is not touched. A picture too small to crop onto the grid is named as such. Without the crop, Generate blocks Run until the picture is resampled.
   - When no Qwen model is installed, **Paint a mask** falls back to a Flux.2, Z-Image, Flux.1 or SDXL model with *With what* as the prompt. These models cannot read the object picture; the wizard says so and uses only the text.
5. **Model** — the installed models that fit the method, in the wizard's preference order. Models whose family DEAS does not know are never offered. **Look again** beside the list checks the model folders again, for example after copying or downloading a model.
5. **Prepare in Generate** — switches to Generate with the prepared draft. If Generate cannot use the chosen model (for example the file was moved), the wizard shows why and nothing changes in Generate.
6. **Prepare and run** — prepares the same draft and asks Generate to start it, through Generate's own Run path: the same input capture and uploads, the same prerequisite and grid checks, the same queue, history and Stop. The wizard does not submit anything itself. While the job runs it shows the step counter and the sampler preview with a **Stop** for that one job; afterwards it shows the finished picture with its size, model, seed and duration, and **Show in Generate** opens the tab with the job and its output. The result also appears in Generate's queue and in Media, like any other job. This button needs the desktop app.
   - **With Paint a mask**, Generate first finds the mask with SAM 3.1, using *Replace what* as the target; the found mask grows outward by 32 px and gets the 4 px soft edge, so the replacement is not squeezed into the old object's outline (the same text-to-mask path as Generate's own SAM **Mask** button, with Generate's selected SAM checkpoint and threshold — Generate's own SAM targets field is left as it is). Commas or semicolons in *Replace what* make one mask layer per part (*the hat, the scarf*). All parts get the same *With what*: the wizard says so (*All 2 targets (the hat, the scarf) become …*), and to give each part its own replacement you run the wizard once per part. On Qwen Image 2.1 (full model) the masked edit runs at CFG 4 instead of the model's usual 1: at CFG 1 it often only erased the old object (*the phone* → *a red apple* left an empty hand), at CFG 4 it drew the replacement in every measured run. Qwen Image 2.1 Turbo and the other models keep their own CFG; Generate shows the value, and you can change it there before pressing Run. The wizard shows *Finding the mask with SAM 3.1…*; when a mask was found, the inpaint run starts as above. If SAM finds nothing, nothing is drawn: the wizard says so, the draft stays prepared in Generate, and you can paint the mask there and press Run. The button needs *Replace what* and stays disabled with Generate's SAM reason when no SAM 3.1 checkpoint or no `SAM3_Detect` node is available (see SAM 3.1 masking in the [Studio guide](STUDIO.md)). The mask is only found after jobs already running in Generate finish, and Stop appears once the drawing job is queued. A picture to change from outside ComfyUI's Input/Output folders is uploaded to the backend when Run starts, as references are.

Preparing selects the model like a click in the Models dock (its remembered settings return), clears that draft's LoRAs, replaces the picture to edit / prompt references and the positive prompt, and leaves the negative prompt, seed, sampler and post-processing as they are. Check the Run Plan before Run. Components the model needs (text encoder, VAE) are checked by Generate as usual.

### Replace in a video

The picture to change can also be an MP4, MOV, WebM or MKV video (drop, paste or Choose…, as for a picture; the object picture must stay a picture). The wizard reads the clip, takes its exact first frame with the same FFmpeg frame path as Media Analysis, saves it as a new file in the Input folder and shows it as the picture to change, with the clip's name, size and length below it. Then it works in two steps:

1. **Edit the first frame** — every image method above works on that frame (Reference edit, Paint a mask, the object picture, Crop to W×H).
2. **Video method** — two methods, chosen from what was measured (see [verification](VERIFICATION.md#dark-wizards-replace-for-videos-in-the-wizard-ux-22c2-0327-2026-11-24)):
   - **Edit video (LTX 2.3)**: LTX video-to-video with the clip as guide (source strength 0.2) and the edited frame as first frame. It keeps the clip's camera and motion and works best for still or slow shots. In strongly moving shots the old object comes back after about a second, and the clip's sound is not kept.
   - **Re-animate from the edited frame (MiniMax H3)**: H3 image-to-video from the edited frame. The replacement stays, but the motion is new and does not follow the clip; H3 makes its own sound.

   The wizard says plainly that strongly moving shots are not reliable yet with either method. It uses the first 5 seconds of the clip at most (the clip's own length when it is shorter), at the video model's usual pixel count in the clip's aspect, on that model's 32-pixel grid.

**Run both steps** edits the frame through Generate and, when that picture is done, hands the edited frame to the chosen video method and runs it there — both are ordinary Generate jobs in the queue with their Run Plan, Stop and history. **Edit the first frame** runs only step 1; after any finished frame edit, **Run the video step** reuses that edited frame (for example to try the other method) without editing the frame again. The video result plays in the wizard and is in Generate's queue and Media. A video method without an installed model is greyed out with *No installed model for this video method*. The video model list is sorted by the method's family order, then Turbo/distilled/int8/fp8 files first, then by name (so the default is the faster variant of the family); pick the model you want before running (an H3 base model runs at its family's starting settings, a Turbo model at its own).

### In Beginner

**Wizards** in Beginner's band opens the same wizard. **Prepare in Generate** switches to Beginner's **Generation** page; **Prepare and run** stays on the wizard as in Advanced. Only models Beginner can use itself are accepted (the same ones its Models page offers); any other choice is refused with a note and nothing changes. What Beginner shows of the prepared draft:

- **Reference edit**: the wizard's prompt pictures are listed in the composer (*Wizard pictures: …*), and **Quality** reads *Wizard size 1216×672* — the output size the wizard computed; picking another Quality returns to Beginner's own sizes. The wizard size is not remembered as Beginner's Quality across restarts.
- **Paint a mask**: the composer says *Masked edit (inpaint)* and the picture opens in the Inpaint editor, where the mask can also be painted by hand.
- **Clear wizard draft** removes the prompt pictures and the masked edit, back to a plain picture-to-picture draft.

The wizard clears Beginner's LoRAs for that model, like Advanced's draft. Leaving Beginner returns Advanced's own references and edit mode, as for every Beginner draft.

### When no model fits

The wizard says which model it prefers and offers **Find in Library**, which opens the Library catalog filtered to that name. Downloads stay in the Library with its license and consent steps; the wizard never downloads anything. After installing, press **Look again**.

## What a wizard is

A wizard is a data entry in `src/wizards/builtin.json`: its input fields, whether it takes an object picture and, per method, the accepted model families in preference order, the families that can read the object picture, the Generate pipeline, whether the picture is a reference or the picture to edit, the edit mode and the prompt templates (`{field}` required, `{field|fallback}` optional). DEAS validates these entries (known families only, matching pipeline/source/mask) and ignores invalid ones. The wizard only reads the model index, describes the chosen file and asks Generate to prepare a draft — and, only when you press **Prepare and run**, to start it; it never uploads, compiles or submits jobs itself, and it follows just the job its own hand-over started.

## Not yet included

The planned Mood, Movie Maker and Grid Generator wizards are tracked in the [plan](PLAN.md#ux-22--dark-wizards-tab--replace-priority-1-movie-maker-mood-grid-generator).

## Movie Maker

**Movie Maker** (below *Replace* in the wizard list) is the planning front of a multi-step film wizard. In this version it covers two stages and nothing else:

1. **Brief** — title, story, total length (1–600 s) and aspect ratio.
2. **Cast and references** — one entry per actor, location, prop or style with a name, a description and any number of reference pictures (up to 16 per entry, chosen with **Add a reference picture**; the files stay where they are). A **Locked** entry cannot be edited, re-pictured or removed until you unlock it.

**Save movie** writes the plan to the `movies` folder under DEAS' app data (atomic write, one file per movie); **Saved movies** lists and reopens them. Reopening never starts, resumes or resubmits anything, and a damaged, oversized or newer file is reported ("N damaged movie file(s) were skipped") and left exactly as it is. Nothing here generates a picture, analyses a reference or contacts a model: authoring only edits the plan. Every edit keeps the earlier text as a revision, and editing an entry marks everything built from it later (story, voices, segments, the final film) as stale with a bounded rerun plan — those stages arrive in later versions (see the plan, UX-22d3 onward). Pasting a path is not used for Movie Maker; use **Add a reference picture**. Beginner's **Wizards** page shows the same Movie Maker entry.

### Story plan

Below the cast, **Story plan** asks a language model to turn the brief and cast into a **story bible** and a list of **shots**.

- **Model:** pick any model DEAS knows (local GGUF, Ollama, OpenAI-compatible; the list is Prompt Forge's and nothing you pick here becomes a default). Without a model the button says why.
- **What is sent:** the title, aspect, target length, story text and the cast (id, kind, name, description). **Reference pictures are never sent.** A brief plus cast above 6000 characters is refused instead of truncated (the planner's window is 4096 tokens).
- **External servers:** if the endpoint is not on this computer, a confirmation names the host, the characters and the cast entries before anything is sent; *Cancel* sends nothing. A loopback endpoint (`localhost`, `127.x`, `::1`) and local GGUF models need no confirmation. There is no fallback from a local to a remote model.
- **The proposal:** the answer is validated strictly (known cast ids, segment limits, 0.5 s steps, no continued first shot, only actors speak). If it is not usable you see the reasons and nothing changes. A usable one shows what *Apply plan* would do: new / changed / unchanged / locked-and-kept / removed shots, the story text state, finished items that would become stale, and a length note when the plan does not add up to the target.
- **After applying:** edit the story bible, each shot's title, camera/action text, seconds and *Continues the previous shot*, and lock any of them. Each shot shows the seconds MiniMax H3 will actually produce (24 fps; a new take is 17k+5 frames, a continued shot's visible part whole 17-frame steps), and the footer compares planned, produced and target totals. Segment limits come from the family data (2–15 s in 0.5 s steps, unverified).
- Nothing is rendered by this step: shots, dialogue and entry/exit states are plan data for the segment stage that follows.

### Making the shots

Every shot in the **Story stage** has **Prepare in Generate** (fills Generate with the shot's draft and switches there; nothing runs) and **Make this shot** (runs the draft through Generate's normal Run, queue and Stop, and stays in Movie Maker to show progress and the finished clip).

- **What is made:** a shot that starts a new take — the first shot, or any shot not marked *Continues the previous shot* — as a MiniMax H3 draft. Without pictures in its cast entries it is text-to-video; with pictures it is REF2VA and the pictures (up to 12, in cast order; videos and other files are skipped and the count is shown) are the references, with the cast description as each picture's note and the picture label *place* (locations) or *style* (styles). The prompt is the camera/action text plus *At the start* / *At the end* states and the spoken lines (*Anna says: "…" (delivery)*); a shot without pictures also gets the cast descriptions. Seconds and canvas come from the shot and the movie's aspect ratio; the Run Plan shows the real frame count.
- **Result:** a finished clip is stored as the shot's result (file path and job) and plays under the shot; a failed or cancelled run marks the shot failed with the reason. Editing a shot afterwards marks it *outdated*; earlier results stay in its revision history.
- **Model:** the installed MiniMax H3 file, Turbo/int8 first; choose another when several exist.
- **Continued shots:** a shot marked *Continues the previous shot* is made together with the first shot of its chain — see [Chains](#chains-continued-shots). **Not yet:** voices and music. Save the movie to keep the recorded results.

### Joining the film

The **Film** step sits under the shots. It is enabled when every shot is made, up to date and a video file; otherwise it lists each shot that is not (*not made yet*, *outdated*, *failed*, *its result is not a video file*, *continues the previous shot*).

**Join the shots into one film** copies each shot's clip into the backend's Input folder (in plan order), asks the node pack's own join check, and then runs the same **Join clips** recipe as Continuity with smooth audio seams. Shots are cuts, so the clips are concatenated, not blended. **Stop** cancels the copy or the join job. The finished film plays under the step and is recorded on the movie (save the movie to keep it). If the joined length differs from the shots' total by more than 0.25 s you get a note. Editing a shot, the story or the cast afterwards marks the film *outdated*; a refused or failed join records nothing and shows the reason. Needs the desktop app and a running backend.

### When files are missing on reopen

After **Saved movies → open**, Movie Maker checks which recorded clips (shots and the film) and cast reference pictures are no longer on disk and lists them with the shot or cast name. It only checks that each file still exists; nothing is opened or changed. **Mark the missing clips as not made** resets those shots to *not made yet* and marks the film and anything built from them outdated (earlier results stay in the history); missing reference pictures stay as they are until you replace or remove them. A movie opens whether or not files are missing.

### Chains (continued shots)

A chain is the first shot after a cut plus every following shot marked *Continues the previous shot*. On the chain's first shot the buttons read **Prepare the chain in Generate** and **Make the chain (n shots)**; continued shots say they are made together with it.

- **How it runs:** Generate uses H3 Continuity: shot 1 is a new first take (its camera/action text is the prompt), each following shot continues the clip before it with its own text as the action, with the default 22-frame overlap and *segment* output (each shot's file holds only its new footage). The cast pictures of **all** shots in the chain are the references of every step, so an actor who only appears later is available; without pictures the chain is text-to-video. Continued shots last in whole 17-frame steps (the *Will be made as …* line shows it).
- **Your own plan is safe:** the chain runs on its own temporary plan. Continuity shows *This chain's plan (n shots) belongs to Movie Maker*; **Back to my plan** (disabled while a step runs) returns to yours, and starting any other hand-over does the same. Your saved Continuity plan is never changed.
- **Progress and results:** each shot shows *making …* while its step runs and is recorded with its clip when it finishes; the chain stays busy until its last shot ends. A failing step marks that shot *failed*, the rest stay *not made*, and Stop in Generate stops the chain.
- **Refused chains:** a first take over 362 frames, a continued step that leaves no room for the overlap in the 362-frame window, or a shot over 15 s is not sent; the message names the shot.
- **Rerunning:** *Make the chain again* always remakes the whole chain from its first shot (a new session take); there is no restart from a middle shot yet.
- **Film:** the join takes the chain's clips like any other (in plan order). Whether the seams of continued clips are invisible in the joined film has not been checked on real footage.

### Music bed

The **Music** step sits below the Film step and needs a music file you choose; the mix itself needs the joined film (made and up to date).

- **Choose a music file** — WAV, MP3, FLAC, OGG, Opus, M4A, AAC or WMA. The file stays where it is. Without a film joined yet the step says so.
- **Or generate the track:** describe the music (*Describe the music*), then **Generate the track (n s)** — an instrumental text-to-music draft of the film's length (the joined film's length when it is made, else the planned shots') on the installed ACE-Step 1.5 model (Turbo first; other ACE-Step variants next) or YuE2. **Prepare in Generate** only fills the draft. YuE2's weights are licensed CC-BY-NC (non-commercial) and the step says so; ACE-Step 1.5 has no such restriction in the sources checked. The finished track becomes the music file (the scored film goes outdated); a failed generation shows the reason. Both buttons are disabled while a shot, the track or the mix is being made.
- **Settings:** *Music level* (−40…6 dB, default −14), *Duck under the film's sound* (0–30 dB, default 12; 0 turns ducking off) and *Fade-out at the end* (0–10 s, default 2, at most half the film).
- **What the mix does:** FFmpeg repeats or cuts the track to the film's length, applies the level and fade, and — when the film has its own sound, such as the speech MiniMax H3 generated — compresses the music with the film's audio as the trigger, so the music drops whenever the film itself is loud. Both are then summed without normalising, so the film's sound keeps its level. The video stream is copied unchanged; the audio is encoded as AAC (Opus for WebM). Because the music is mixed in afterwards it is exactly your track, never a re-synthesis.
- **Result:** the scored film is written beside the joined film as `<name>-scored.<ext>` (then `-scored-2`, …) — a fresh name every time, never an overwrite — plays under the step, and is recorded on the movie (save to keep it). Changing the music file, any setting, or the film marks it *outdated*; the joined film itself is never touched.
- **Speech:** external dialogue is never layered over H3's own speech; speech in the film comes from H3 for now. If you later pass the music to H3 as an audio reference instead (planned, optional), that mode and this mix are exclusive per movie, so the music is never doubled.
- **Missing file:** reopening a movie reports a music file that is no longer there.
- **Needs:** the desktop app and FFmpeg (with ffprobe) on PATH.
