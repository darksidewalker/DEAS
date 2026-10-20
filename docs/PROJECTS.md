# Image draft projects

[Documentation index](README.md) · [Studio](STUDIO.md) · [Accepted target contract](PRODUCT-DECISIONS.md)

## Scope

This is the first bounded project implementation: baseline image settings and one explicitly imported PNG input can live in a user-selected project folder. It is **not yet** the full persistent generation project described in the target contract. Jobs, generated outputs, job recovery, executed dependency fingerprints and immutable generation/edit history are not saved/restored by this slice. Keep using explicit output exports; do not assume a project contains generated results.

After approved installation or checked reopening of a DEAS environment, use the project bar in Studio. The controls require native DEAS. A browser preview alone cannot create/open a real project or invoke an OS file chooser. Linux and Windows have native code paths; build/test evidence and target-runtime acceptance are recorded separately in [Verification](VERIFICATION.md).

## Create, open and close

Use the project bar above Generate/Run Plan. **New project** asks for an existing parent folder and creates a uniquely named child without replacing existing folders. It starts from the current baseline image settings. **Open project** selects an existing DEAS project folder and restores its saved baseline settings; it does not install models, contact a model service, upload input media or start generation.

Only one project is active in the app. Another DEAS instance cannot write the same open project. Close the project in the first instance before opening it for writing elsewhere. Copy/backup the whole folder while it is closed; project-internal media references are relative, but model weights and credentials are not included.

Baseline settings autosave after edits. **Saved** means the native write succeeded, not merely that an edit is visible. Wait for saving to finish before switching/closing projects. A save failure remains visible; fix the filesystem/space/permission issue and retry rather than assuming the draft reached disk. If retry cannot succeed (for example after an outside manifest edit or uncertain commit durability), **Close without saving** explicitly discards the unsaved local draft and releases the project; reopen to inspect the actual disk state. It does not delete project files. Project actions are locked during active preparation/generation and project writes. Cancelling a chooser leaves the active project unchanged.

**Close project** releases its writer lock and restores the normal global Studio defaults. Working inside a project does not replace those defaults. Closing the project is not deleting it. Normal main-window close requests are blocked while a project draft is unsaved, saving, hydrating or a project operation is in flight. Wait for Saved, then request window close again; a failed save can be explicitly discarded with Close without saving. If the close listener cannot be installed, a visible warning and fixed shared diagnostic tell you to wait for Saved and close the project before quitting. This does not protect against a process kill, crash or power loss, and does not yet implement confirmation for stopping running computation. The OS releases the writer lock on process exit; do not delete the lock file as a workaround.

## Saved controls

The draft stores positive/negative prompt, exact selected checkpoint name, effective image width/height, steps, CFG, sampler, scheduler, seed, image-to-image denoise and text-to-image/image-to-image pipeline. Reopening uses fixed canvas dimensions and a fixed saved seed. Missing or incompatible saved checkpoints block Run until you explicitly select a compatible model; another checkpoint is not silently substituted. A stored checkpoint name is not yet a verified model digest or a successful model-run claim.

This initial schema does **not** save LoRAs, wildcard state, post-processing/options, editor paint/masks/layers or video/Continuity settings. Opening a draft starts baseline image authoring with optional LoRAs/wildcards/post-processing disabled, default Options and ordinary image-to-image resampling. Those features remain available, but changes to them are not part of this project's saved contract. Save/export their existing dedicated formats where applicable. Do not expect an unsaved editor canvas or arbitrary file selected in Media to become a persistent project input automatically.

## Managed PNG input

**Import PNG** opens the native file chooser and copies one validated, bounded PNG into the active project under a new identity. The original file stays unchanged. The managed input is restored on reopen and remains usable if the original is moved/deleted. Import is local only: it does not upload to ComfyUI or compute anything. Choose Image → Image explicitly when desired; only an explicit **Run** uploads a required managed input through the existing transport. Keep the selected model's image-dimension constraints in mind.

Importing another PNG changes the active input reference without deleting previously committed media. Import accepts static PNGs up to 64 MiB, at most 8192 pixels per edge and 16,777,216 pixels total, with bounded decoding and checksum verification; animated, truncated or corrupt files are refused. PNG is the only project-import format in this slice; this does not restrict the existing Media library's other formats. Generated results are not automatically adopted as project assets yet.

## Failures and privacy

Unsupported/corrupt manifest versions, missing/tampered media, unsafe paths and stale saves fail instead of silently migrating, replacing files or inventing recovery. Native project failures reach shared Logs with a fixed operation diagnostic; prompt/media contents and full filesystem paths are not copied into those diagnostic messages.

A project folder contains private prompts and input media. It is a local backup/move unit, not a sanitized sharing package. Do not hand-edit a live manifest or remove managed files while it is open. No automatic project cleanup/deletion or cloud fallback is provided.

## Remaining milestone

The next project work must connect exact executed jobs and verified generated assets to durable revisions, recover uncertain outcomes without resubmission, and exercise the complete SDXL text → image → image-to-image → compare/export → reopen path with actual model/native/resource evidence. This draft feature alone does not satisfy that milestone. See [current implementation status](IMPLEMENTATION-STATUS.md).
