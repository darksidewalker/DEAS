# Media browser, previews and metadata

[Documentation index](README.md) · [Current implementation status](IMPLEMENTATION-STATUS.md)

## Purpose and prerequisites

The Media dock browses configured Input/Output folders and previews local image/video/audio assets. Open a checked DEAS environment; folder access is native and separate from resource downloads. The library is a filesystem browser, not a durable project/collection database.

## Browse and select

A separate left folder navigator expands children on demand; clicking a folder name changes the displayed files. Breadcrumbs/parent navigation, Input/Output shortcuts, depth (1–5, default 3), search and sorting help locate media. Tiles contain files rather than folders. Symlink/hidden-tree descent remains restricted. Search/sort in the dock also serves Models/LoRAs without changing their stored selections.

Images use native cached thumbnails where available; animated WebP/GIF tiles show a still frame to avoid persistent decoder/repaint work. Only visible tile rows plus spare rows render. Selecting a file loads its preview and bounded embedded metadata; OS-dropped files can also be inspected. Source files are not rewritten by browsing.

## Working with media

Use [Studio](STUDIO.md) for image-to-image, masks, inserts, last-frame marking and output comparison. Image edits consume approved backend-resolvable input/output references; unsupported origins/formats show a blocker. Up to four visible inserts/masks and ephemeral source-owned drafts are not a persistent media project. Metadata **Use these settings** restores supported values explicitly; **Open in Comfy** imports a stored editor workflow without queueing it.

## Playback and limits

Owned job video uses the backend `/view` route; dock video/audio uses fetched bytes in a Blob because WebKitGTK rejects the asset protocol for video. This describes the selected transport, **not accepted playback**: the latest journal records a GStreamer Matroska assertion abort after video starts, with audio unconfirmed. See [video limitations](STUDIO.md#video-generation) and [verification](VERIFICATION.md). Originals must remain intact.

Dedicated synchronized two-source comparison, shared libmpv playback, collections/tags, persistent asset revisions and general montage remain [planned integrations](IMPLEMENTATION-STATUS.md#3-real-reference-projects-and-integration-plans).

## Errors

Retry a failed child listing locally; do not clear unrelated folders or run as root. Check selected folder permissions and Backend status. A file extension/thumbnail does not establish codec support. Use [Logs](LOGS.md) for diagnostics and report OS/GPU/version plus the error without private paths/tokens where possible.
