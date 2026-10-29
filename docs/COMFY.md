# Original ComfyUI editor tab

[Documentation index](README.md) · [Plan](PLAN.md)

## Comfy

The **Comfy** tab (between Run Plan and Backend) opens the original web editor of the running DEAS-owned backend inside the app. It uses the same installed nodes, models and configured input/output folders, not a second installation. The app header and other panels hide; the top tab band and the version overlay remain. Returning to Studio or Library keeps the editor mounted, retaining its unsaved workflow while the endpoint stays unchanged. A backend restart can change the port and reload the editor; save workflows before restarting. While the owned backend is unavailable, Comfy shows a waiting spinner; while its frame loads, a loading spinner. The version overlay shows Backend starting… and then a brief ✓ from native lifecycle status. Start a stopped backend under Backend; merely opening Comfy never starts it. Stop, failure or unavailable native status removes the old frame instead of reconnecting to a revoked port.

Comfy runs as an isolated, cross-origin frame without DEAS native-command permissions. Its workflow, queue, interrupt and extension actions are the original ComfyUI actions, not DEAS job-scoped controls; both views share the same backend queue. Browser-engine support still applies to clipboard and downloads. DEAS turns off ComfyUI's backdrop blur inside the frame, because the Linux engine renders it in software and the Templates dialog would freeze the app; dialogs therefore show a plain dimmed backdrop. Windows HTML5 file drops into Comfy are not supported with the existing Tauri native media-drop handler; use the original ComfyUI file picker. Native Windows acceptance remains unverified.


## Embedded workflow import

Select local media containing an editor `workflow`, then **Open in Comfy**. This loads a named workflow without execution and retains the old draft; a checked running owned backend is required. API-only `prompt` data cannot reconstruct layout. Missing models/nodes need explicit resolution; import is not generation acceptance. See [metadata](STUDIO.md#generation-metadata) and [execution ownership](EXECUTION-CONTRACT.md).
