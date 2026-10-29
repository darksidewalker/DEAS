# Logs and diagnostic export

[Documentation index](README.md) · [Plan](PLAN.md)

## Purpose and access

The **Logs** tab displays recent DEAS, owned ComfyUI and installer CLI output in one view. Native logging comes from the app-owned session; opening Logs does not launch a job, install packages or restart a service. Browser fixtures do not provide real native logs.

## Controls

- **Source:** All, DEAS, ComfyUI or CLI; one choice per group.
- **Level:** All, Error, Warning, Info or Debug. An explicit leading Python tag (`[WARNING]`) or native prefix (`WARN:`) takes precedence over words inside the message. Without a prefix, DEAS falls back to text heuristics; this is not a guarantee of backend structured severity.
- **Search:** case-insensitive text filtering in the retained session output.
- **Copy:** copies all retained matching rows, not just the visible subset.
- **Export:** native Save dialog writes matching formatted text; cancel does not report success. Browser-only export downloads the current view data, not native backend logs.

The native store is capped at 10 MiB, evicting oldest entries. The UI keeps a bounded mirror and renders the latest 2,000 matches, with a count/limited indicator; these limits are not durable audit retention. Following new lines stops when you scroll away from the bottom. No persistent cross-restart log archive is promised.

## Integration logging contract and coverage

Every plugin/feature must route diagnostics and errors to its host application's shared log, not only a private file, browser console or UI message. For DEAS this includes React/TypeScript, Rust and managed worker/backend paths; ComfyUI integrations use ComfyUI/Python logging and are captured centrally when DEAS owns that backend. Entries must retain component origin, severity, operation and job/request identity when available, with bounded context and secrets removed. Cancellation remains distinct from failure; repeated errors are deduplicated/rate-limited without hiding their first cause or terminal outcome.

The existing source/level filters above do **not** establish complete per-plugin structured logging or frontend-to-native error delivery. Those paths require an audit and integration tests; adding this rule does not implement or verify them. See the mandatory [shared logging contract](PROJECT-RULES.md#shared-logging-for-every-plugin-and-implementation) for IPC, redaction, failure handling and test requirements.

## Reporting errors safely

Discovery connection failures now show a translated **Backend not reachable** hint instead of the low-level `object_info` request URL. Start the owned backend under Backend; if already started, wait until ready, verify its current address and inspect Logs. A timeout says the backend may still be starting or busy, rather than claiming it stopped. An HTTP response keeps its status code and points to address/access checks. Malformed data, model/validation errors and uncertain execution outcomes remain separate; a transport failure after submission is not permission to blindly resubmit. Discovery transport diagnostics retain their endpoint/category in shared Logs, omit the request URL, and repeat at most once per endpoint/category per minute.

`[WARNING] send error: Cannot write to closing transport` is a ComfyUI notification/WebSocket send warning: a client connection was already closing. It is kept as **Warning**, not promoted to Error merely because its text says “send error”. If preceded by `Prompt executed`, that excerpt alone does not show a model/sampling failure. Inspect the job outcome and outputs separately. DEAS now closes its own per-job preview WebSocket with a Close handshake (one-second deadline) instead of an abrupt TCP drop, and ignores another prompt’s completion events. Ping/pong and preview/progress handling remain active; job status still comes from the separate native status/history path. Other frontend disconnects can still produce this warning; it is not suppressed or treated as proof of a broken GPU/model. The fix removes a demonstrated abrupt-close defect, but live elimination of the reported warnings has not been established.

Select the relevant source/level, search the error and export/copy enough context to explain the failed operation. Remove tokens, personal paths, prompts/media metadata or other private data before posting. NVIDIA preflight errors include bounded process exit/stdout/stderr diagnostics; these are driver-query output, not proof of successful GPU computation.

Clipboard/chooser permissions can fail; their error is shown without fabricating success. See [setup troubleshooting](GETTING-STARTED.md#if-something-goes-wrong), [Backend](BACKEND.md) and [verification](VERIFICATION.md).
