# Dials for MiniMax H3 video (experimental)

[Studio](STUDIO.md) · [Plan](PLAN.md) · [Verification](VERIFICATION.md)

**Status: experimental.** DEAS can compile dial rows into a MiniMax H3 video job, and
Studio has a first **Dials** dock tab to add rows and set their strength. The node pack
is **not installed or pinned by DEAS**, and **no DEAS-compiled dials job has been run on
a backend**: the evidence is compiler, prerequisite and component tests on fixtures.
Time curves can be sent through the intent and are shown as a small picture, but there
is **no curve editor, full rack dialog or rack preset yet**. Treat every statement about
the picture as untested.

## What it is

A dial is a small steering file made with the Dial Rack nodes: a direction such as
"more motion" or "day to night" that is added to the model's text path at a strength
you choose, without training. DEAS sends the rows you list to one **Dial Rack** node
(`MAIDialRack`). A row can also carry a **time curve**, so its strength changes over
the seconds of the piece.

## What you need

- A MiniMax H3 **video** recipe (`family: minimax-h3`) on a safetensors base model.
- The Dial Rack nodes on the backend: `MAIDialRack`, and `MAIDialHoldMap` when De-rope
  runs with a time curve. Both come with **ComfyUI-Dials** or with **ComfyUI-MAINodes**
  (the node ids are the same in both).
  **Install one of these packs yourself for now.** DEAS does not offer, install, update
  or pin it. The plan is to pin ComfyUI-Dials as an optional pack once its next version
  is published; until then no revision is recorded as compatible.
- Dial files in the backend's `models/loras/dials/` folder. The backend lists them
  with the LoRAs, which is how DEAS checks that a file exists.

On an external backend, its owner installs the pack and restarts it. DEAS does not
change or restart external services.

## The Dials tab in Studio

Open **Dials** in the bottom dock of Generate, next to **LoRAs** (Advanced mode; Beginner
has no dock tabs and sends no dials). It works with a MiniMax H3 **video** pipeline.

- **Add a dial…** lists the dial files the backend reports in `models/loras/dials/`
  (the library scan stands in while the backend list is unread). Files in folders whose
  name starts with `_` are not offered, as in the pack's own picker. Each dial can be
  added once; a rack holds at most 8.
- Each row is one line: an **on/off** switch, the file name, a **slider** from -3 to 3,
  a **number field** that accepts the full -20 to 20 (the slider stays at its end when
  the number is beyond it), a small **picture of the time curve** when the row has one,
  and **×** to remove the row. A new row starts on, at strength 1.
- A positive strength pushes toward one side of the dial and a negative one toward the
  other. Which side is which, and how much is useful, is written in the dial file; DEAS
  does not show that information yet, so the label is the file name. Start near 1 and
  raise it gently.
- The tab's badge counts the rows that will be sent: on, with a strength other than 0.
  **Plan** lists them under the model, and the intent JSON shows the exact rows.
- Rows are remembered across restarts, are part of saved Studio presets and settings
  transfer, and come back with **Use settings** from a recent generation (the rows that
  were sent, switched on). They are not read from media file metadata.
- The global search finds the tab under "dial".

When dials cannot run, the tab says why and **Add**, the sliders and the number fields
are disabled. The switch and **×** stay usable so a blocking row can always be turned
off:

| Shown reason | What happens to saved rows |
| --- | --- |
| Not a MiniMax H3 video pipeline (also HyperFlow Flash) | Kept, not sent, Run is not blocked |
| The Dial Rack nodes are not on the backend | Rows that are on block Run; `MAIDialRack` is named beside Run |
| The base model is a GGUF file | Rows that are on block Run with the reason |
| A row's file is not in the backend's list ("Not on the backend") | A row that is on blocks Run; the file is named beside Run |

LoRA browser: files inside `loras/dials/` are no longer offered in the **LoRAs** tab,
because loading a dial through the LoRA loader is not what a rack row does. A dial file
that is already selected as a LoRA stays visible there so it can be removed. The Library
and the LoRA sets dialog still list these files.

Not built yet: editing time curves, the full rack dialog with a shared timeline, rack
presets, reordering rows, the dial's own description and side labels, and useful and
overcook marks on the slider.

## The intent field

Studio writes the optional top-level `dials` field of a `video-generation` intent; it can
also be sent directly. It is a list of rows:

```json
"dials": [
  {"dial": "dials/h3_motion.safetensors", "strength": 1.5},
  {"dial": "dials/h3_calm.safetensors", "strength": 1, "on": true,
   "time": {"type": "keys", "points": [[0, 0.5], [1.5, 1], [4, -2]],
            "unit": "seconds", "interp": "linear", "smooth": 0, "steps": 8}}
]
```

| Field | Meaning | Limits |
| --- | --- | --- |
| `dial` | File inside `dials/`, with forward slashes | `.safetensors`; no `..`, backslash, `:`, `%`, absolute path or control character; at most 255 characters |
| `strength` | Row strength; 0 switches the row off | -20 to 20 |
| `on` | Optional switch, default on | boolean |
| `time` | Optional keyframe curve of the row's level over time | see below |

`time` is `{type: "keys", points, unit: "seconds", interp?, smooth?, steps?}`:

- `points`: 1 to 64 `[seconds, level]` pairs with strictly increasing seconds
  (within ±86400 s) and levels from -20 to 20. The strength the model gets is
  level × row strength. Before the first and after the last point the curve holds
  that point's level.
- `unit` must be `seconds`. The seconds count from the start of the **whole piece**,
  not of the current segment.
- `interp`: `linear` (default) or `step`. `smooth`: 0 (default, straight lines) to 1,
  rounds the corners of a linear curve.
- `steps`: optional whole number of **blend steps**, 1 to 150 and, on a row that is on,
  not more than the job's own `steps`. See [Blend steps](#blend-steps).

A list holds at most 8 rows. Without the field, with an empty list, or when every row
is off or has strength 0, the compiled graph is exactly the graph without dials and
the nodes are not required.

## What DEAS builds

- One `MAIDialRack` node directly after the last LoRA and before the Options patches
  (attention, cache, chunking, compile). Its `rack` input is the list of active rows;
  rows that are off or have strength 0 are left out.
- **Hi-Res Regenerate** keeps its own model chain without dials, as it does without
  the generation LoRAs.
- **De-rope with a time curve:** the second pass samples a slowed copy of the clip.
  DEAS adds `MAIDialHoldMap` between the pass's model (after its turbo LoRA, when one
  is added) and the pass's schedule and guider, wired to De-rope Prepare's hold map,
  so the curves follow real clip time. Rows without a time curve need no extra node.
- **Continuity with a time curve:** a continued segment samples a window that starts
  before the new part (the hidden context frames). DEAS shifts the points by that
  window's start so each moment of the piece gets the level you authored. The start
  is the pinned checkpoint clip's frame count minus the context frames the node pack
  resolves; DEAS reads the frame count from the session list when it prepares the job.
- Logs record both nodes under the stage `dial-patch`.

### Blend steps

A time curve does not act on every sampler step. For the first `time.steps` steps the
node runs the model twice, without and with the dial, and blends the two results per
latent frame; after that the row is off. **Each blended step costs one extra model
call** (a curve that is 0 everywhere costs none).

The node's own default is 2 steps whatever the job's step count. DEAS always writes
`steps` into every curve it sends: the value in the intent, otherwise
`max(2, round(job steps / 3))`, never more than the job's steps (6 steps give 2, 25
give 8, 4 give 2, 1 gives 1).

**This default is provisional.** It comes from one seed at two settings on 2026-11-16:
with the 6-step turbo recipe a blend of 2 steps acted; at 25 steps without the turbo
LoRA a blend of 2 steps did nothing visible and 8 steps made the curve act. No other
step count, strength or dial was tried.

The emitted row, for the example above at 25 job steps and no authored value:

```json
{"dial":"dials/h3_calm.safetensors","strength":1,"time":{"interp":"linear","points":[[0,0.5],[1.5,1],[4,-2]],"smooth":0,"steps":8,"type":"keys","unit":"seconds"}}
```

**The De-rope pass uses the same count.** There is one rack; `MAIDialHoldMap` puts the
same rows with the same settings on the second pass, and has no step input of its own.
That pass samples only the tail of its own schedule: `round(pass steps × inject)` steps
of 6 (turbo LoRA or a distilled chain) or 25 (generation model), so 3 or 4 steps for a
turbo pass and 12 or 18 for a full one. The node blends on the first
`min(time.steps, steps of that pass)` of them. So with a 25-step generation (8 blend
steps) a turbo De-rope pass is blended on all of its 3 or 4 steps, and a full pass on
its first 8; with a 6-step generation (2 blend steps) the pass is blended on its first
2. This is read from the node source (`timecurve.py`, `TimeCurveForward`) and the
compiled graph, **not rendered with these values**. A control render on 2026-11-16
(one seed, blend 2, inject 0.48) showed the same motion with and without
`MAIDialHoldMap`, so what the blend does to the second pass is open. No other pass
reuses the rack with a curve: face refinement, the tiled upscale and transitions refuse
curves, and Hi-Res Regenerate has its own chain without dials.

## Not in this version

DEAS refuses these with an `Invalid dials: …` error instead of sending them:

- hold rows, step envelopes, block strengths, audio-driven curves, wired dial inputs,
  solo, and the per-curve audio mode (the node's default applies: audio follows the
  curve);
- dials on LTX, Wan or HyperFlow Flash, and active dials on a GGUF base model;
- a **time curve** together with any of: face refinement, the tiled latent upscale,
  an H3 transition window, De-rope on a continued segment, or a continuation of an
  imported video. Each of these samples a clip whose clock this version does not map
  to the piece. Rows without a time curve are allowed in all of them and patch the
  model like a LoRA.

Dial rows are not read back from saved media metadata. Rows that are off or have
strength 0 are not sent by Studio, so a restored recent generation brings back only the
rows that ran.

## Troubleshooting

| Message | Cause |
| --- | --- |
| The Dials tab says the Dial Rack nodes are needed, or Run names `MAIDialRack` | The pack is not installed on the backend, or the backend was not restarted after installing it. Reopen the Dials tab afterwards; it reads the backend's node list when opened. |
| The add list is empty, or a row says "Not on the backend" | No file (or not that file) in the backend's `models/loras/dials/`. Reload the models after copying files; on an external backend its own model list must show the file. |
| A dial does nothing or the picture breaks | Strength too low or too high for that dial. The file's own useful and overcook strengths are not shown yet; try 1 to 2 first. |
| `Diagnostic nodes are not available on this backend: MAIDialRack` (or `MAIDialHoldMap`) | Same cause as the first row, reported by the native check when the job is prepared. |
| `Diagnostic loras are not available on this backend: dials/…` | The dial file is not in `models/loras/dials/`, or the backend's model list is stale. |
| `Invalid dials: time curves on a continued segment need … sourceFrames …` | The pinned checkpoint clip was not found in the session list, so the window's start is unknown. Pin an existing clip. |
| `MODEL_FORMAT_UNSUPPORTED: dials on a GGUF base are not proven` | Use a safetensors base model. |

An error raised by the node itself (for example a dial made for another model family)
appears as a failed `dial-patch` stage in [Logs](LOGS.md).

## UI design

This section records how the Studio controls are built and what the next parts need. It
describes the code; behaviour claims above are what the tests cover.

### Where the dial list comes from

- Studio already has two LoRA lists. With a models folder, `native_models_scan` walks
  `loras/` recursively and returns `LocalModel` entries whose `name` is the path relative
  to the category folder (`downloads_models.rs`, `walk`/`scan`; `src/lib/models.ts`).
  Without one, `Workbench.load` falls back to the backend allowlist
  (`checkRecipePrerequisites(...).allowlist.loras`). The allowlist is also what the
  Post-Processing and Options tabs read (`choices`), and what the native prerequisite
  check compares a job's files against, separators normalized (`jobs.rs`, `listed`).
- Dial files are ordinary entries of both lists, named `dials/<name>.safetensors` (or
  with `\` on a Windows backend). The strip therefore needs **no new route and no Rust
  change**: `dialCatalog` in `src/lib/dials.ts` filters the backend list when it is read
  and the library scan otherwise, normalizes separators and applies the pack's own
  catalog rule (inside `dials/`, no folder starting with `_`). The Dials tab refreshes
  the allowlist when it opens, like Post-Processing and Options.
- DEAS does have a precedent for a read-only route of a custom pack behind a native
  command: `native_h3_refmods` reads `GET /dasiwa/refmods`, and `native_h3_session` the
  continuity session list. The Dial Rack pack exposes `GET /mainodes/dials/catalog` in
  the same spirit. It is **not used yet**: the pack is not pinned, so the route is not a
  contract DEAS may rely on.

### Dial files in the LoRA picker

Before this change a dial file was a normal tile in the LoRAs tab: the scan gives it the
category `loras` and no family, and tiles without a family are shown for every model.
Selecting one sent it through the LoRA loader. That is not a rack row: a dial made for
the hook after the token refiner (key `…dials_shift`) has no key a LoRA loader knows,
and one made as a LoRA file (key `…diff_b`) is applied as a constant shift without the
rack's per-step blend, time curve or family check. What the loader does with either was
read from the pack's source, not run. The LoRAs tab now leaves out names inside `dials/`
unless that file is already selected (`pickerLora` in `Workbench.tsx`, one filter that
is easy to remove). Not changed: the Library, the LoRA sets dialog and the De-rope and
Regenerate LoRA lists.

### A dial's own information

A dial file carries a `dial_info` JSON string in its safetensors metadata (version 2:
`description`, `negative` and `positive` side labels, `neg`/`pos` with `useful` and
`overcook` strengths that may be unknown, `evidence`, optional `kind` and per-pipeline
measurements), next to `model_family`. Many files have none.

DEAS has no path for this today. The native scan reads safetensors headers only to
detect families and takes just `modelspec.architecture` from the metadata
(`model_families.rs`, `read_header`/`header`); `LocalModel` has no general metadata
field; the LoRA details dialog shows the cached CivitAI record only. So this first part
ships with fallbacks: the file name as the label, a fixed ±3 slider and a number field
for the full range, and a hint to start near 1.

Planned path, in order of preference:

1. A read-only native command over `GET /mainodes/dials/catalog`, following
   `native_h3_refmods`, once a pack revision is pinned. It returns family, mode and
   checked info for every dial in one call and works for external backends.
2. Otherwise an optional `dial` object on `LocalModel`, filled by the scan for
   `loras/dials/*` from the header it can already read. This covers only backends whose
   models folder DEAS can read, and needs the scan index to carry the new field.

Either way the strip takes the result as one optional map `dial name → info`; the row
then shows the side labels, sets the slider range from the overcook strengths and marks
the useful strength.

### State, persistence and the intent

- State is `DialRow[]` under the preference key `studio.run.dials` (`usePref`, as
  De-rope uses `studio.run.derope`). A `DialRow` **is** the intent row (`H3DialRow`:
  `dial`, `strength`, optional `on` and `time`), so the strip, the future rack dialog and
  the compiler share one shape and nothing is converted. `isDialRows` mirrors the native
  `validate_dial_row` limits, so a stale or foreign value falls back to no rows.
- Because the key starts with `studio.run.`, the existing settings transfer picks it up
  without further code: Studio presets, capture/apply and reset to defaults. Entering
  Beginner mode clears the rows with the other advanced settings, as it does for
  De-rope (that path has no test of its own).
- `withDials` adds the rows to a `minimax-h3` intent after every other block. Only rows
  that are on with a non-zero strength are sent, without the `on` key; with none the
  intent object is returned unchanged, so jobs without dials stay byte-identical. This
  follows the LoRAs, where only active entries enter the intent.
- `restoreHistory` brings the rows back through `fromDials` beside the LoRAs. Restoring
  an intent without dials clears them, as it clears LoRAs.
- Outside a plain MiniMax H3 video pipeline the saved rows stay in the preference and
  are not sent (`dials` in `Workbench.tsx`), the pattern De-rope uses.

### Placement

Its own dock tab, **Dials**, after **LoRAs**. The LoRAs tab is the shared model browser
(folder tree, tiles, bulk family editing, favourites) and has no place for a list of
rows; a dock tab is one entry in `dockTabs`, one label and one panel line. To move the
strip, render `<DialStrip>` elsewhere with the same props; it does not depend on the
dock. `onOpenRack` is the slot for the button that opens the full rack dialog and shows
nothing until it is passed.

### Gating

`dialGate` gives the first reason that applies; the strip shows it and disables adding
and strength edits while the switch and Remove stay usable.

| Case | Source | In the strip | Run |
| --- | --- | --- | --- |
| Not MiniMax H3 video (LTX, Wan, HyperFlow Flash, images, music) | family | reason, rows inert | not blocked, rows not sent |
| `MAIDialRack` not registered | allowlist `nodes`, as De-rope checks its nodes | reason | active rows block, node named |
| GGUF base model (`MODEL_FORMAT_UNSUPPORTED`) | model file name | reason | active rows block |
| Dial file not listed | backend LoRA list, else library scan | "Not on the backend" on the row | an active row blocks, file named |
| More than 8 rows | `DIAL_ROWS` | adding disabled with the reason | cannot occur |

While the backend's node list is unread the node is not reported missing; Run is
disabled anyway until the backend answers.

Refusals that involve a **time curve** are not mirrored in the UI yet. A restored row
can carry a curve, and the compiler's own error then appears when the job is prepared.
The next part must show these before Run:

- a time curve with face refinement, with the tiled latent upscale (not Regenerate), on
  an H3 transition window, with De-rope on a continued segment, or on a continuation of
  an imported video;
- a continued segment whose pinned clip is not in the session list (no `sourceFrames`),
  and points too close together to shift onto the continued window;
- De-rope with a time curve when `MAIDialHoldMap` is not registered;
- the curve's own limits: 1 to 64 points, strictly increasing seconds within ±86400,
  levels within ±20, `interp` `linear` or `step`, `smooth` 0 to 1, `unit` `seconds`.

### What the next parts need

- **Rack dialog and lane timeline:** edit the same `DialRow[]` through the same
  `value`/`onChange` pair; pass `onOpenRack`. Curves are in whole-piece seconds; the
  lane's length is the clip, or the whole Continuity plan when it is on.
- **Keyframe maths:** `dialCurveOutline` only draws the authored corners and ignores
  `smooth`. The editor needs its own sampler that matches the pack's `timecurve.py`,
  tested against sampled curves.
- **Default shapes:** a proof render on 2026-11-16 (one seed) had the model cut to a
  different scene when a curve jumped from level -1 to +1 within 0.2 s. Default ramps
  should be gentle; this is one observation, not a measured threshold.
- **Rows are keyed by position.** The validator allows the same dial twice (the compiler
  does); the strip only never offers it. Reordering was left out; the rack adds the
  rows' shifts, so order is not expected to change the result (not tested).
- **Presets:** Studio presets already carry the rows. Rack preset files of the pack are
  a second store; decide which one the preset picker reads before building it.
- **Off rows are not sent**, so history cannot restore them. If the rack should come
  back whole, send them with `on: false` (the compiler accepts and ignores them) and
  drop the filter in `withDials`.
- **Logging:** the strip only edits local state and adds no operation that can fail, so
  it writes no log entries; job errors already reach Logs through the job path.

## Platforms and evidence

Compilation is plain Rust and the Studio controls are plain React; both are meant to
behave the same on Linux and Windows. Nothing here was run on Windows or in the real
desktop WebViews, and nothing was run on a GPU or against a real backend. See the
verification entries for the
[compiler](VERIFICATION.md#experimental-h3-dials-compiler-slice-unreleased--2026-11-16) and the
[Dials tab](VERIFICATION.md#experimental-h3-dials-studio-dock-strip-unreleased--2026-11-16)
for what was tested and the [plan](PLAN.md) for what is open. `tools/verify_dials.py`
checks the strip's geometry and keyboard use in Chromium with synthetic IPC. Node behaviour was read
from the installed ComfyUI-MAINodes checkout (`dials/nodes.py`, `timecurve.py`,
`presets.py`), not from a pinned release.
