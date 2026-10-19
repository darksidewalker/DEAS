# Logs and diagnostic export

[Documentation index](README.md) · [Current implementation status](IMPLEMENTATION-STATUS.md)

## Purpose and access

The **Logs** header action displays recent DEAS, owned ComfyUI and installer CLI output in one view. Native logging comes from the app-owned session; opening Logs does not launch a job, install packages or restart a service. Browser fixtures do not provide real native logs.

## Controls

- **Source:** All, DEAS, ComfyUI or CLI; one choice per group.
- **Level:** All, Error, Warning, Info or Debug, classified from message text rather than a guarantee of backend structured severity.
- **Search:** case-insensitive text filtering in the retained session output.
- **Copy:** copies all retained matching rows, not just the visible subset.
- **Export:** native Save dialog writes matching formatted text; cancel does not report success. Browser-only export downloads the current view data, not native backend logs.

The native store is capped at 10 MiB, evicting oldest entries. The UI keeps a bounded mirror and renders the latest 2,000 matches, with a count/limited indicator; these limits are not durable audit retention. Following new lines stops when you scroll away from the bottom. No persistent cross-restart log archive is promised.

## Reporting errors safely

Select the relevant source/level, search the error and export/copy enough context to explain the failed operation. Remove tokens, personal paths, prompts/media metadata or other private data before posting. NVIDIA preflight errors include bounded process exit/stdout/stderr diagnostics; these are driver-query output, not proof of successful GPU computation.

Clipboard/chooser permissions can fail; their error is shown without fabricating success. See [setup troubleshooting](GETTING-STARTED.md#if-something-goes-wrong), [Backend](BACKEND.md) and [verification](VERIFICATION.md).
