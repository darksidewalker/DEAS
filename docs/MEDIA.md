# Media browser, previews and metadata

[Documentation index](README.md) · [Current implementation status](IMPLEMENTATION-STATUS.md)

## Purpose and prerequisites

The Media dock browses configured Input/Output folders and previews local image/video/audio assets. Open a checked DEAS environment; folder access is native and separate from resource downloads. The library is a filesystem browser, not a durable project/collection database.

## Browse and select

A separate left folder navigator expands children on demand; clicking a folder name changes the displayed files. Breadcrumbs/parent navigation, Input/Output shortcuts, depth (1–5, default 3), search and sorting help locate media. The drag/drop guidance is plain inline text immediately after Depth, not an overlay on the file view; it wraps with the header on narrow windows. Depth uses a compact selector, and the sort/type/view dropdowns share the search field's height. Tiles contain files rather than folders. Symlink/hidden-tree descent remains restricted. Search/sort and the **View** picker (Tiles, Large thumbnails, List) in the dock also serve Models/LoRAs without changing their stored selections.

Images use native cached thumbnails where available; animated WebP/GIF tiles show a still frame to avoid persistent decoder/repaint work. Only visible tile rows plus spare rows render. Selecting a file loads its preview and bounded embedded metadata; OS-dropped files can also be inspected. Right-click a file for **Open in folder**: the system file manager opens the folder that contains it (on Windows and macOS with the file selected). Source files are not rewritten by browsing.

## Starred generated media

The star beside a tile, central preview, full-window viewer or queue result physically moves that file into **Output → starred**, using the configured DEAS/ComfyUI output folder (otherwise the checked environment's `ComfyUI/output`). Existing output files also work after restart; a retained job/completion record is not required. Native preparation, running/queued or uncertain jobs block moves. Input and external files are not silently moved.

The relative naming hierarchy and original filename stay intact: `Output/2026-10-21/model/image_123.png` becomes `Output/starred/2026-10-21/model/image_123.png`. A collision adds `-1`, `-2`, and so on to the filename stem; it never overwrites. Already-starred files show a filled star and remain in place; no unstar/move-back action is added. The same recognized image/video/audio extensions as the native Media browser are accepted, not just PNG.

Availability checks inspect filesystem metadata only; they do not decode every image just to draw a star. The actual move checks open-file identity and observes size/mtime stability once before the no-clobber rename. The bytes are not rewritten or validated as playable content; the observation cannot exclude a future external writer. Retained native output aliases are repaired only when their captured backend-launch output-root identity matches the moved file's root. Changing saved folders does not retroactively change a running backend's launch directory.

Native validation determines whether the action is available. Project-managed files and files with detected JSON/TXT/XMP sidecars are explicitly blocked until reference-aware/grouped moves exist; do not move those files manually to work around the restriction. Missing, read-only or unsafe files also show an unavailable reason. Successful moves refresh the browser and update in-session output/preview references without changing submitted generation settings. This is not durable project/job-history support. Directory and media identities are checked again before and after the rename. An interrupted namespace change attempts no-clobber rollback; if restoration cannot be confirmed, inspect the reported source/destination directories before retrying. Failed moves do not repair aliases to an unverified destination. Failures reach shared Logs; do not assume a clicked star succeeded or that a concurrently renamed source path was restored.

## Working with media

Use [Studio](STUDIO.md) for image-to-image, masks, inserts, last-frame marking and output comparison. Image edits consume approved backend-resolvable input/output references; unsupported origins/formats show a blocker. Up to four visible inserts/masks and ephemeral source-owned drafts are not a persistent media project. Metadata **Use these settings** restores supported values explicitly; **Open in Comfy** imports a stored editor workflow without queueing it.

## Playback and limits

Owned job video uses the backend `/view` route; dock video/audio uses fetched bytes in a Blob because WebKitGTK rejects the asset protocol for video. This describes the selected transport, **not accepted playback**: the latest journal records a GStreamer Matroska assertion abort after video starts, with audio unconfirmed. See [video limitations](STUDIO.md#video-generation) and [verification](VERIFICATION.md). Originals must remain intact.

Dedicated synchronized two-source comparison, shared libmpv playback, collections/tags, persistent asset revisions and general montage remain [planned integrations](IMPLEMENTATION-STATUS.md#3-real-reference-projects-and-integration-plans).

## Errors

Retry a failed child listing locally; do not clear unrelated folders or run as root. Check selected folder permissions and Backend status. A file extension/thumbnail does not establish codec support. Use [Logs](LOGS.md) for diagnostics and report OS/GPU/version plus the error without private paths/tokens where possible.
