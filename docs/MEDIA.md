# Media browser, previews and metadata

[Documentation index](README.md) · [Current implementation status](IMPLEMENTATION-STATUS.md)

## Purpose and prerequisites

The Media dock browses configured Input/Output folders and previews local image/video/audio assets. Open a checked DEAS environment; folder access is native and separate from resource downloads. The library is a filesystem browser, not a durable project/collection database.

## Browse and select

**Output · Starred · Input** are direct navigation buttons: Output opens `raw/`, Starred opens `starred/`, Input opens the configured input folder and has no per-tile stars. There is no light switch. The active button follows the successfully opened folder. This changes browsing only, preserving search/type/sort/depth and editor state; it does not move media or start work. If the fixed `raw/` or `starred/` directory is missing, opening it initializes that direct child beneath the native-approved selected Output root. The root itself and arbitrary missing browse paths are not created; unsafe roots, occupied file names and permission failures remain visible errors. Existing media stays untouched.

The left folder navigator starts at the configured Output folder, displayed as **root**, with `raw/`, `starred/` and their relative subfolders beneath it. It does not show filesystem ancestors such as `/data/…`; parent navigation stops at the anchor. Input outside Output has its own Input anchor, and explicitly picked external folders start at that selected folder. Clicking/expanding folder names, Output/Starred/Input shortcuts, depth (1–5, default 3), search and sorting help locate media. Native operations still use validated full paths internally. The drag/drop guidance is plain inline text immediately after Depth, not an overlay on the file view; it wraps with the header on narrow windows. Depth uses a compact selector, and the sort/type/view dropdowns share the search field's height. Tiles contain files rather than folders. Symlink/hidden-tree descent remains restricted. Search/sort and the **View** picker (Tiles, Large thumbnails, List) in the dock also serve Models/LoRAs without changing their stored selections.

Images use native cached thumbnails where available; animated WebP/GIF tiles show a still frame to avoid persistent decoder/repaint work. Only visible tile rows plus spare rows render. Selecting a file loads its preview and bounded embedded metadata; OS-dropped files can also be inspected. Right-click a file for **Open in folder**: the system file manager opens the folder that contains it (on Windows and macOS with the file selected). Source files are not rewritten by browsing.

## Starred generated media

The star beside a tile, central preview, full-window viewer or queue result physically moves that file into **Output → starred**, using the configured DEAS/ComfyUI output folder (otherwise the checked environment's `ComfyUI/output`). Existing output files also work after restart; a retained job/completion record is not required. Native preparation, running/queued or uncertain jobs block moves. Input and external files are not silently moved.

Normal DEAS generations go to **Output/raw/<Output naming>**. Starring switches the base to **Output/starred/<Output naming>**; Unstar switches it back to **Output/raw/<Output naming>**, keeping every named subfolder and the current filename. Example: `Output/raw/image/2026-10-19/result.png` ↔ `Output/starred/image/2026-10-19/result.png`. The filled star performs Unstar; no database, receipt or retained job history is required, so existing starred files work too. Moves safely create missing target subdirectories. Browsing may initialize only the two fixed direct Output children `raw/` and `starred/`; it does not create arbitrary naming subfolders. Star collisions add a numeric suffix without overwriting; Unstar refuses an occupied target and preserves the starred file. A collision suffix stays part of the filename. Existing older outputs outside `raw/` may still be starred, then unstar into `raw/` under the same relative named path. No existing files are migrated automatically.

Availability checks inspect filesystem metadata only; they do not decode every image just to draw a star. The actual move checks open-file identity and observes size/mtime stability once before the no-clobber rename. The bytes are not rewritten or validated as playable content; the observation cannot exclude a future external writer. Retained native output aliases are repaired only when their captured backend-launch output-root identity matches the moved file's root. Changing saved folders does not retroactively change a running backend's launch directory.

The fixed `raw/` and `starred/` bases always belong to the currently selected Output root. Switching Output does not authorize moves from the previous root. The earlier receipt-only proposal has been removed: no `.deas-stars/` metadata is read or created, and no media is copied to a second archive.

Native validation determines whether the action is available. Project-managed files and files with detected JSON/TXT/XMP sidecars are explicitly blocked until reference-aware/grouped moves exist; do not move those files manually to work around the restriction. Missing, read-only or unsafe files also show an unavailable reason. Successful moves refresh the browser and update in-session output/preview references without changing submitted generation settings. This is not durable project/job-history support. Directory and media identities are checked again before and after the rename. An interrupted namespace change attempts no-clobber rollback; if restoration cannot be confirmed, inspect the reported source/destination directories before retrying. Failed moves do not repair aliases to an unverified destination. Failures reach shared Logs; do not assume a clicked star succeeded or that a concurrently renamed source path was restored.

## Working with media

Use [Studio](STUDIO.md) for image-to-image, masks, inserts, last-frame marking and output comparison. Image edits consume approved backend-resolvable input/output references; unsupported origins/formats show a blocker. Up to four visible inserts/masks and ephemeral source-owned drafts are not a persistent media project. Metadata **Use these settings** restores supported values explicitly; **Open in Comfy** imports a stored editor workflow without queueing it.

## Playback and limits

Owned job video uses the backend `/view` route; dock video/audio uses fetched bytes in a Blob because WebKitGTK rejects the asset protocol for video. This describes the selected transport, **not accepted playback**: the latest journal records a GStreamer Matroska assertion abort after video starts, with audio unconfirmed. See [video limitations](STUDIO.md#video-generation) and [verification](VERIFICATION.md). Originals must remain intact.

Dedicated synchronized two-source comparison, shared libmpv playback, collections/tags, persistent asset revisions and general montage remain [planned integrations](IMPLEMENTATION-STATUS.md#3-real-reference-projects-and-integration-plans).

## Errors

Retry a failed child listing locally; do not clear unrelated folders or run as root. Check selected folder permissions and Backend status. A file extension/thumbnail does not establish codec support. Use [Logs](LOGS.md) for diagnostics and report OS/GPU/version plus the error without private paths/tokens where possible.
