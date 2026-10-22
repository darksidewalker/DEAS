# Image draft projects

[Documentation index](README.md) · [Studio](STUDIO.md) · [Accepted target contract](PRODUCT-DECISIONS.md)

## Scope

This is the first bounded project implementation: baseline image settings and one explicitly imported PNG input can live in a user-selected project folder. It is **not yet** the full persistent generation project described in the target contract. Jobs, generated outputs, job recovery, executed dependency fingerprints and immutable generation/edit history are not saved/restored by this slice. Keep using explicit output exports; do not assume a project contains generated results.

After approved installation or checked reopening of a DEAS environment, use the **Project actions** dropdown beside Run in Studio. The controls require native DEAS. A browser preview alone cannot create/open a real project or invoke an OS file chooser. Linux and Windows have native code paths; build/test evidence and target-runtime acceptance are recorded separately in [Verification](VERIFICATION.md).

## Create, open and close

Open the small arrow attached to Run on its right. Project path/save status appear below the button, not in the Run label. **Save as project…** asks for an existing parent folder and creates a uniquely named child without replacing existing folders. It starts from the current baseline image settings; this is still an image draft, not a complete Studio snapshot. **Open project** selects an existing DEAS project folder and restores its saved baseline settings; it does not install models, contact a model service, upload input media or start generation. Escape or a click outside closes the menu. The active project path and save/error state remain visible without a permanent action panel.

Only one project is active in the app. Another DEAS instance cannot write the same open project. Close the project in the first instance before opening it for writing elsewhere. Copy/backup the whole folder while it is closed; project-internal media references are relative, but model weights and credentials are not included.

Baseline settings autosave after edits. **Saved** means the native write succeeded, not merely that an edit is visible. Wait for saving to finish before switching/closing projects. A save failure remains visible; fix the filesystem/space/permission issue and retry rather than assuming the draft reached disk. If retry cannot succeed (for example after an outside manifest edit or uncertain commit durability), **Close without saving** explicitly discards the unsaved local draft and releases the project; reopen to inspect the actual disk state. It does not delete project files. Project actions are locked during active preparation/generation and project writes. Cancelling a chooser leaves the active project unchanged.

**Close project** releases its writer lock and restores the normal global Studio defaults. Working inside a project does not replace those defaults. Closing the project is not deleting it. Normal main-window close requests are blocked while a project draft is unsaved, saving, hydrating or a project operation is in flight. Wait for Saved, then request window close again; a failed save can be explicitly discarded with Close without saving. If the close listener cannot be installed, a visible warning and fixed shared diagnostic tell you to wait for Saved and close the project before quitting. This does not protect against a process kill, crash or power loss, and does not yet implement confirmation for stopping running computation. The OS releases the writer lock on process exit; do not delete the lock file as a workaround.

## Saved controls

The draft stores positive/negative prompt, exact selected checkpoint name, effective image width/height, steps, CFG, sampler, scheduler, seed, image-to-image denoise and text-to-image/image-to-image pipeline. Reopening uses fixed canvas dimensions and a fixed saved seed. Missing or incompatible saved checkpoints block Run until you explicitly select a compatible model; another checkpoint is not silently substituted. A stored checkpoint name is not yet a verified model digest or a successful model-run claim.

This initial schema does **not** save LoRAs, wildcard state, post-processing/options, editor paint/masks/layers or video/Continuity settings. Opening a draft starts baseline image authoring with optional LoRAs/wildcards/post-processing disabled, default Options and ordinary image-to-image resampling. Those features remain available, but changes to them are not part of this project's saved contract. Save/export their existing dedicated formats where applicable. Do not expect an unsaved editor canvas or arbitrary file selected in Media to become a persistent project input automatically.

## Portable draft ZIP

**Export draft ZIP…** saves the committed `project.json` and its currently referenced managed PNG as a single ZIP. Choose a new destination filename: existing files are never replaced. Ordinary autosaves still update the working project folder without rebuilding an archive. Extra files in that folder, older unreferenced inputs, credentials, model weights, jobs and generated results are not included. The menu's draft limitation applies equally to the archive; this is not a complete Studio-state export.

**Import project ZIP…** asks for the archive and then an existing writable parent folder. It validates the complete package before creating a unique child project and activating it. Cancelling either chooser or rejecting a package leaves the previous active project unchanged and the source archive intact. The import accepts only the bounded draft format: a manifest plus its optional managed PNG, with matching digest and valid image data. Traversal, links, duplicate/unexpected entries, unsupported schemas, oversized data and corrupt contents fail rather than being generally extracted. Classic Stored/Deflate ZIP is supported; ZIP64, multidisk archives and archive comments are outside this small format.

If a filesystem write fails after creating the new child, that incomplete child may remain but is not activated; the previous project stays active. Check disk space/permissions and shared Logs. Do not assume a failed import created a usable project, or remove an open project's lock file.

## Managed PNG input

**Import PNG** opens the native file chooser and copies one validated, bounded PNG into the active project under a new identity. The original file stays unchanged. The managed input is restored on reopen and remains usable if the original is moved/deleted. Import is local only: it does not upload to ComfyUI or compute anything. Choose Image → Image explicitly when desired; only an explicit **Run** uploads a required managed input through the existing transport. Keep the selected model's image-dimension constraints in mind.

Importing another PNG changes the active input reference without deleting previously committed media. Import accepts static PNGs up to 64 MiB, at most 8192 pixels per edge and 16,777,216 pixels total, with bounded decoding and checksum verification; animated, truncated or corrupt files are refused. PNG is the only project-import format in this slice; this does not restrict the existing Media library's other formats. Generated results are not automatically adopted as project assets yet.

## Failures and privacy

Unsupported/corrupt manifest versions, missing/tampered media, unsafe paths and stale saves fail instead of silently migrating, replacing files or inventing recovery. Native project failures reach shared Logs with a fixed operation diagnostic; prompt/media contents and full filesystem paths are not copied into those diagnostic messages.

A project folder contains private prompts and input media. It is a local backup/move unit, not a sanitized sharing package. Do not hand-edit a live manifest or remove managed files while it is open. No automatic project cleanup/deletion or cloud fallback is provided.

## Remaining milestone

The owner has deferred full managed-result/revision persistence and project recovery as excessive for the current workflow. The next proposal after unstar is instead one global last-10 job history with settings/status and references to existing output files, not project-owned media copies. Existing draft projects keep their current saved scope; the history is not implemented by this planning correction. The previous complete persistent SDXL milestone is retained as historical detail, not a prerequisite for this smaller history. See [current implementation status](IMPLEMENTATION-STATUS.md).
