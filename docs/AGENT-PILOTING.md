# Piloting the running app from a script or an agent

Status: contributor tooling, Linux / WebKitGTK only, first used on 2026-11-17 to exercise the
experimental [dials](DIALS.md) in a real debug build. It is not a test gate and it changes nothing in
DEAS: `tools/pilot_webview.py` talks to the web view's own inspector, the same door a human opens
with the developer tools.

Use it when a change has to be seen working in the real application (native commands, a real
backend, real model lists) and not only in the fixture pages the `tools/verify_*.py` scripts drive
in headless Chromium. Those scripts stay the regression gates.

## What it can do

| Command | What it does |
| --- | --- |
| `targets` | Lists the inspector's targets. One `WebPage` target is the app window. |
| `text` | Prints the page's visible text. |
| `eval '<js>'` | Evaluates one synchronous expression in the page and prints its JSON value. |
| `click '<text>' [index]` | Clicks a button, tab, summary, link, label or option by its exact text or `aria-label`. |
| `set '<label start>' <value>` | Sets an input, select or textarea found by the start of its label. |
| `fill '<css selector>' <value>` | The same, found by a selector. |
| `shot out.png` | Saves a PNG of the viewport. |

It cannot move the mouse, drag, or press keys as the operating system would. Pointer gestures (the
rack's lane editing, splitters) need events dispatched from `eval`, or a human.

## Start the app so it can be piloted

1. Build the frontend and the debug binary. The binary embeds `dist/`, so no Vite server is needed:

   ```sh
   npm run build
   cargo build --manifest-path src-tauri/Cargo.toml --locked
   ```

2. Start it with the inspector server on loopback, detached, with a log:

   ```sh
   (umask 022; WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9333 \
     setsid nohup ./src-tauri/target/debug/deas > /tmp/deas_app.log 2>&1 & disown)
   ```

   `umask 022` matters on hosts whose default is `0002`: DEAS refuses an owned environment or a
   settings folder that is group-writable, including one its own installer has just created.

3. Wait until the page answers (about half a minute on first start), then drive it:

   ```sh
   P="uv run -q --no-project --with websockets python tools/pilot_webview.py"
   $P targets
   $P click 'Studio'
   $P shot /tmp/studio.png
   ```

Keep the inspector on `127.0.0.1`. Anyone who can reach that port can run script in the app,
including its native commands.

## How it works

WebKitGTK serves an inspector over HTTP and WebSocket when `WEBKIT_INSPECTOR_HTTP_SERVER` is set. The
index page lists targets; the app window is `/socket/<n>/<m>/WebPage`. That socket speaks WebKit's
inspector protocol, with the page's own messages wrapped in `Target.sendMessageToTarget` and answered
by `Target.dispatchMessageFromTarget`. The tool uses `Runtime.evaluate` for everything except
screenshots, which are `Page.snapshotRect`.

A debug build has the inspector enabled. A release build has it only when Tauri's devtools are on.

## Things that cost time the first time

- **`eval` is synchronous.** An `async` function or a promise comes back as `{}`. Start the work,
  store the result on `window`, and read it with a second call:

  ```sh
  $P eval "window.__TAURI_INTERNALS__.invoke('native_models_scan',{root:R,refresh:true}).then(r=>window.__r=r.length,e=>window.__r='ERR '+e),'started'"
  $P eval "window.__r"
  ```

- **React fields ignore a plain `value =`.** `set` and `fill` go through the element's native value
  setter and dispatch `input`, `change` and `blur`. Do the same in your own `eval` code.
- **Never `location.reload()`.** The page comes back without its environment and the model lists
  are empty. Stop and start the app.
- **State that lives only in memory resets on every start**: the backend address is one. The owned
  backend's port changes on each start.
- **Model lists come only from a DEAS-owned environment.** Without one, Studio shows no checkpoints
  whatever backend it is connected to. After adding files, ask for a rescan with `refresh: true`.
- **Pointing Studio at another backend.** Before an environment exists: Backend, Advanced options,
  "Existing backend address", "Connect existing backend", then "Inspect connection" on the page that
  opens. Once an environment is open that field is gone from the Backend tab; use Run Plan, "Engine
  diagnostics & legacy workspace", Engine, the `#endpoint` field, then "Inspect connection".
- **Stable hooks.** Prefer the `data-*` attributes the components already carry (for example
  `[data-dock-tab=dials]`, `[data-forge-open]`, `[data-insert-shot]`) over visible text, which is
  translated.
- **Clicking by text can match more than one element.** `click` reports how many matched; pass an
  index for the one you mean.
- **Entry points that need a language model redirect.** With no LLM configured, the Prompt Forge
  hammer and tab open Backend, LLM backend. That is the app's behaviour, not a failed click.
- **Video does not play in the web view without `libmpv.so.2`.** Read the output file instead.

## Screenshots

A screenshot shows whatever is on screen: the Media tab lists folder and file names, the LoRAs tab
lists every model folder. Look at each image before it leaves the machine, and take shareable ones
from a tab that shows only what is meant to be shown.

## Stopping

Stop the app by its exact process id (`pgrep -x deas`). The owned backend is a separate Python
process inside the environment's `venv`; find it with `pgrep -a python` and stop that id too if the
app left it behind. Do not use `pgrep -f` with a pattern that also appears in your own command line:
it matches your own shell, and any other waiting shell that mentions the same words.

## Limits

- Linux / WebKitGTK only. On Windows, WebView2 has its own DevTools port and protocol; contributors
  have driven it that way (see [verification](VERIFICATION.md)), but this tool does not speak it.
- One window. Dialogs opened by the operating system (file pickers) are outside the page.
- Evidence from a piloted run is one machine and one session. Record what was looked at, as for any
  other entry in [verification](VERIFICATION.md).
