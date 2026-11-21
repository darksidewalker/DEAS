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
   - **Paint a mask (inpaint)**: Generate opens B in **Inpaint**. With a Qwen model and an object picture, B and A are also its prompt references (`image 1`, `image 2`) and the prompt asks to replace the masked area of image 1 with the object from image 2 — one model does both, no second model is involved. Paint over the area that should change, then press Run; Run stays disabled until a mask is painted. Preparing sets Generate's Inpaint strength to 1 so the masked area is redrawn completely (at a lower strength the old object's shape and colour stay). **Prepare and run** makes the mask for you with SAM 3.1 (see step 6). Inpaint keeps B's size, so B must already lie on the model's grid (32 px for Qwen with references); the wizard says when it does not, and Generate then blocks Run until the picture is resampled.
   - When no Qwen model is installed, **Paint a mask** falls back to a Flux.2, Z-Image, Flux.1 or SDXL model with *With what* as the prompt. These models cannot read the object picture; the wizard says so and uses only the text.
5. **Model** — the installed models that fit the method, in the wizard's preference order. Models whose family DEAS does not know are never offered. **Look again** beside the list checks the model folders again, for example after copying or downloading a model.
5. **Prepare in Generate** — switches to Generate with the prepared draft. If Generate cannot use the chosen model (for example the file was moved), the wizard shows why and nothing changes in Generate.
6. **Prepare and run** — prepares the same draft and asks Generate to start it, through Generate's own Run path: the same input capture and uploads, the same prerequisite and grid checks, the same queue, history and Stop. The wizard does not submit anything itself. While the job runs it shows the step counter and the sampler preview with a **Stop** for that one job; afterwards it shows the finished picture with its size, model, seed and duration, and **Show in Generate** opens the tab with the job and its output. The result also appears in Generate's queue and in Media, like any other job. This button needs the desktop app.
   - **With Paint a mask**, Generate first finds the mask with SAM 3.1, using *Replace what* as the target (the same text-to-mask path as Generate's own SAM **Mask** button, with Generate's selected SAM checkpoint and threshold — Generate's own SAM targets field is left as it is). Commas or semicolons in *Replace what* make one mask layer per part (*the hat, the scarf*). The wizard shows *Finding the mask with SAM 3.1…*; when a mask was found, the inpaint run starts as above. If SAM finds nothing, nothing is drawn: the wizard says so, the draft stays prepared in Generate, and you can paint the mask there and press Run. The button needs *Replace what* and stays disabled with Generate's SAM reason when no SAM 3.1 checkpoint or no `SAM3_Detect` node is available (see SAM 3.1 masking in the [Studio guide](STUDIO.md)). The mask is only found after jobs already running in Generate finish, and Stop appears once the drawing job is queued. A picture to change from outside ComfyUI's Input/Output folders is uploaded to the backend when Run starts, as references are.

Preparing selects the model like a click in the Models dock (its remembered settings return), clears that draft's LoRAs, replaces the picture to edit / prompt references and the positive prompt, and leaves the negative prompt, seed, sampler and post-processing as they are. Check the Run Plan before Run. Components the model needs (text encoder, VAE) are checked by Generate as usual.

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

Replace for videos and the planned Mood, Movie Maker and Grid Generator wizards are tracked in the [plan](PLAN.md#ux-22--dark-wizards-tab--replace-priority-1-movie-maker-mood-grid-generator).
