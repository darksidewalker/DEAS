# Dials for MiniMax H3 video (experimental)

[Studio](STUDIO.md) · [Plan](PLAN.md) · [Verification](VERIFICATION.md)

**Status: experimental.** DEAS can compile dial rows into a MiniMax H3 video job, and
Studio has a **Dials** dock tab to add rows and set their strength, a **rack dialog**
with a timeline to draw each row's time curve, and a **rack presets** dialog that reads
and writes the node pack's own preset files through the pack's routes. The node pack is
**not installed or pinned by DEAS**, and **no job started from these controls has been
run on a backend**, nor has the presets dialog talked to a real backend: the evidence is
compiler, prerequisite, fixture-server and component tests and a headless Chromium
check. Treat every statement about the picture as untested unless it names the render it
comes from; the renders named here are one seed each.

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
  does not show that information yet, so the label is the file name. As a first guide,
  **about 1.5 is usually clearly visible; above about 2 the picture can leave the prompt
  or freeze** (provisional, see [What renders have shown so far](#what-renders-have-shown-so-far-provisional)).
- **Presets…** opens the [rack presets](#rack-presets) dialog.
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

When a row has a time curve that the next job cannot run, the tab lists the reason
under the heading and Run is blocked with the same reason; see
[When a time curve cannot run](#when-a-time-curve-cannot-run).

Not built yet: reordering rows, the dial's own description and side labels, and useful
and overcook marks on the slider.

## The rack dialog and its timeline

**Open rack** in the Dials tab opens a dialog over Studio (Esc or **Close** returns to
the button). It holds the same rows with the same controls as the tab, and below them
one **timeline**: a lane per row over a shared seconds axis.

- **Lane length.** The lanes cover the clip the next job renders, in its real length:
  MiniMax H3 clips are 17k + 5 frames at 24 fps, so 4 s typed is 107 frames (4.458 s)
  and 5 s is 124 frames (5.167 s). With a Continuity plan that starts the piece, the
  lanes cover the **whole piece** (the first step's clip plus every later step's
  seconds, snapped to 17-frame steps as the compiler snaps them), segment ends are
  drawn as dashed lines and points snap to them. A plan that continues an existing clip
  or an imported video starts at a frame count Studio does not hold, so the dialog says
  so and shows only the next clip; curve seconds still count from the start of the whole
  piece. The laid-out piece length mirrors the compiler's rule and was not compared with
  a real session.
- **Lanes.** Click a lane or its name to select it. The selected lane is tall and
  editable; the others are drawn dimmed so overlaps can be seen. A row without a curve
  is a dashed flat line at level 1. **Add curve** starts a flat curve at level 1 (the
  same strength as before); **Remove curve** returns the row to a constant strength.
- **Editing.** Click the selected lane to add a point and keep dragging it; drag a
  point to move it (the pointer may leave the lane; Alt places without snapping);
  double-click a point or press Delete to remove it. Times snap to 0.1 s and to segment
  ends, levels to 0.05. Points keep one latent frame (1/6 s) apart and cannot pass each
  other, and a curve keeps at least two points. A click within 1/6 s of a point selects
  that point instead of adding one.
- **Keyboard.** Every point is a button: Tab reaches it, the arrow keys nudge it by
  0.1 s or 0.05 (Shift: ten times), Delete removes it. **Add point** puts a point in the
  middle of the widest gap, on the curve. The selected point's **Time (s)** and
  **Level** are number fields.
- **Undo / Redo** (buttons, Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y outside a number field)
  cover everything changed while the dialog is open, the row controls included. One
  drag or one slider movement is one step. The history ends when the dialog closes.
- **Between points:** **Ramp** (straight lines) or **Hold until the next** (steps).
  **Smoothing** (0 to 1, ramps only) rounds the corners; the curve still passes through
  every point and never beyond it.
- **Levels.** A level multiplies the row's strength: at levels 0 to 1 the model gets
  level × strength, which the readout shows as `time s · level · strength` for the
  pointer or the selected point. The lane covers levels 0 to 1 by default. **Lowest
  level** and **Highest level** widen it on purpose, down to -20 and up to 20 (the
  compiler's limit); outside 0 to 1 the node's blend extrapolates and the readout says
  so. A curve that already has levels outside 0 to 1 widens the lane to fit.
- **Blend steps.** Empty means the default, shown beside the field (for example
  "default: 7 of 20 steps (provisional)"). A number sets it for that curve. Each blended
  step costs one extra model call. See [Blend steps](#blend-steps).
- **Presets** write the points of the selected lane (and give a constant row a curve):
  **Ramp in** (0 to 1 over the first 1.5 s), **Ramp out** (1 to 0 over the last 1.5 s),
  **Pulse** (0, up to 1, hold, back to 0) and **Dip** (1, down to 0, hold, back to 1).
  All stay inside levels 0 to 1 and use 1.5 s ramps, shorter only on a lane too short
  for them.
- **Copy curve / Paste curve** move a curve between lanes as JSON, the row's `time`
  object. When the WebView refuses the clipboard, the copy is kept inside the window and
  the dialog says so. Paste also accepts a curve copied in the pack's own editor (clip
  fractions are converted with the lane's length; its audio mode is dropped) and a bare
  `[[seconds, level], …]` list.

What the picture shows, and what to expect:

- The thick line is the curve as the node computes it (the same interpolation and
  smoothing, tested against the pack's own function). The thin stepped line on the
  selected lane and the short ticks under the axis are the **latent frames**: the model
  takes one value per latent frame, about 1/6 s, the curve's average over that frame.
  Sharper changes are averaged away, and the pack's notes say a change shows in the
  render over about 1.5 s. With a Continuity piece the ticks are exact for the first
  segment only and the stepped line is not drawn.
- **A strong dial on a curve can change the whole scene where the curve changes.** The
  curve blends between the render with the dial and the one without, and at a high
  strength these are different scenes. In renders on 2026-11-16 (one seed each, the
  motion dial on a dance prompt) the picture cut to a different scene at the change at
  row strength 1.5, for a level change of 0 to 1 as well as -1 to +1 and for ramps from
  0.2 s to 1.5 s. On the 0 to 1 curve with a 1.0 s ramp, strength 1.0 showed no visible
  effect, **1.2 raised the motion in the same scene**, and 1.5 cut: a narrow window. A
  look dial (`h3_evil_cold`) on the same curve at 1.2, 1.5 and 2.0 showed no visible
  change over time and no cut, although the same dial clearly acts as a constant row.
  All of this is provisional. The dialog shows this warning; lower the row strength if
  the picture cuts. The curve presets (Ramp in and so on) do not prevent it.
- Director timeline items and prompt blocks are **not** drawn behind the lanes: Studio
  holds MiniMax H3 references as slots with trims, without a place in seconds, and
  timed prompt blocks are free text. Only the Continuity plan's segment ends exist as
  seconds, and those are drawn.

## Rack presets

**Presets…**, in the Dials tab and in the rack dialog, opens a dialog with the look of
the LoRA sets dialog: the current rack on the left, the presets of the backend on the
right.

A preset is one of the **node pack's own preset files**:
`models/loras/dials/presets/<name>.json` on the backend, the same files the Dial Rack
node's own preset menu in ComfyUI reads and writes. So a rack saved in ComfyUI shows in
DEAS and the reverse. DEAS keeps no copy and reaches the files only through the pack's
routes on the backend (`/mainodes/dials/presets`), which also works for an external
backend. It needs the pack that has these routes (ComfyUI-Dials or ComfyUI-MAINodes).
Without it the dialog says so and offers nothing; the rack itself is not affected.

- **Presets on the backend** lists the names. Choosing one reads it and shows **every
  row it holds**, with a note under each row that is not loaded or is loaded changed,
  and the pack's own warnings: the dial file is not on the backend, or the dial file's
  contents changed since the preset was saved (the pack compares a hash of the file's
  tensors).
- **Load into rack** replaces the rack's rows with the rows that can be loaded and
  starts nothing. In the rack dialog this is one **Undo** step. From the Dials tab there
  is no undo; save the rack first if you want it back.
- **Save as new preset** writes the current rack (all rows, off ones included) under a
  new name: letters, digits, `_` and `-`, at most 80. **Saving never overwrites.** For a
  name that exists the dialog shows the pack's answer and nothing is written. Presets
  cannot be renamed or deleted from DEAS; remove the file on the backend.
- **Refresh list** reads the names again.

What is converted, and what is said about it:

| In the preset | In DEAS |
| --- | --- |
| Curve times as clip fractions (`unit` absent or `normalized`, the pack's default) | Converted to seconds with the lane length shown in the rack (the clip, or the whole Continuity piece), rounded to 0.1 ms; noted on the row. The same preset gives other seconds on another clip length |
| Curve in seconds | Kept as authored |
| `solo` on an active row | DEAS has no solo switch. The pack runs only the solo rows, so the other rows are loaded **switched off**; noted on both |
| Hold row, step envelope, block strengths, audio-driven curve, wired dial input | **The row is not loaded**, with the reason. It is never loaded without that part |
| Curve audio mode `protect` | The row is loaded; the note says the audio mode is not kept (audio follows the curve) |
| Strength outside ±20, a curve outside the compiler's limits, a file that is not `dials/….safetensors` | The row is not loaded, with the reason |
| More than 8 loadable rows | The ninth and later are not loaded, with the reason |
| A curve without blend steps | Loaded without; DEAS then writes its own default for the job's step count, while the node alone would use 2 (see [Blend steps](#blend-steps)). Not noted per row |

Saving writes only what DEAS sends: `dial`, `strength`, `on` and, for a curve, the keys
curve with `unit: "seconds"` (and `interp`, `smooth`, `steps` when set). DEAS sends **no
hash**: the pack computes each row's `sha256` from the dial file when it saves, and
stores `null` for a file it cannot find. A preset saved from DEAS therefore never holds
solo, hold, envelope or block settings; loading it in ComfyUI gives a rack without them.

Not verified: the dialog against a real backend with the pack (the tests use a fixture
server and an in-page stand-in), and a preset written by DEAS opened in the ComfyUI
rack.

## What renders have shown so far (provisional)

One seed each on 2026-11-16, 832×480, 4 s, the 6-step turbo recipe unless stated; the
graphs were minted by hand to the shape DEAS compiles, not started from Studio. None of
this is a measured rule.

- **Constant rows, ten shipped dials** (eight `h3_evil_*` on a talking prompt,
  `h3_motion` and `h3_motion_lora` on a dance prompt) at -3, -2.25, -1.5, +1.5, +2.25
  and +3: about ±1.5 was clearly visible on both sides; by about +2.25 the picture left
  the prompt or nearly froze; -3 changed the scene. This is why the slider reaches ±3
  and the hint names 1.5 and 2.
- **Motion dial on a 0 to 1 curve** (1.0 s ramp, dance prompt): row strength 1.0 no
  visible effect, 1.2 more motion in the same scene, 1.5 a cut to another scene.
- **Look dial on the same curve** (`h3_evil_cold`, 1.2, 1.5 and 2.0): no visible change
  over time and no cut; as a constant row at +1.5 it darkens the room and the mood.
- **Two rows in one rack** (both constant; one on a curve; crossing curves) ran without
  error. What the combinations look like was not judged.
- **Blend steps:** the default was confirmed only at 6 and 25 sampler steps.

## When a time curve cannot run

The compiler refuses a time curve in the cases below. Studio finds them before Run from
the same settings: the reason is listed in the Dials tab and in the rack dialog, Run is
blocked with it, and in the dialog the curve tools (add curve, presets, points, paste,
ramp and smoothing) are disabled. **Remove curve**, the row's switch and × stay usable,
and rows without a curve are never held. With Continuity on, the cases are judged for
the plan's next step, and they block the plain Run button too.

| Case | What to do |
| --- | --- |
| More blend steps than the job has sampler steps | Lower the curve's blend steps or clear the field (not locked: the field stays editable) |
| Face refinement is on | Switch it off, or remove the curve |
| The tiled latent upscale is on | Use Hi-Res Regenerate or no upscale, or remove the curve |
| De-rope on a continued segment | Switch De-rope off for that step, or remove the curve |
| The next step continues an imported video | Remove the curve |
| De-rope with a curve, and `MAIDialHoldMap` is not on the backend | Install the pack that has it (shown once the backend's node list is read) |
| Join with generated transitions | While a row with a curve is on, the Continuity dialog does not offer transitions and says why |

Two refusals cannot be known before the job is prepared, because the pinned clip's
frame count is read from the session list only then: a pinned clip that is not in the
list, and points too close together to move onto the continued window. Their native
errors appear when the job is prepared (see Troubleshooting). The curve's own limits (1
to 64 points, increasing seconds, levels within ±20, smoothing 0 to 1, blend steps 1 to
150) cannot be broken from the dialog; a stored row list that breaks them is not loaded
(the rack then starts empty).

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

**This default is provisional and was confirmed only at 6 and 25 sampler steps.** It
comes from one seed at two settings on 2026-11-16:
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
  curve). A [rack preset](#rack-presets) that holds one of these is loaded without that
  row, or with the change named on the row;
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
| A dial does nothing or the picture breaks | Strength too low or too high for that dial. The file's own useful and overcook strengths are not shown yet; about 1.5 was usually clearly visible in one-seed tests and above about 2 the picture could leave the prompt. |
| The presets dialog says the backend has no rack presets | The backend has no `/mainodes/dials/presets` route: the pack is not installed, is older than the routes, or the backend was not restarted. Logs has a `Dial presets` entry. |
| "A preset with this name already exists" | The pack never overwrites. Choose a new name, or remove the file in `models/loras/dials/presets/` on the backend. |
| A preset row says "Not loaded" | The row uses a part of the rack this version does not send. See [Rack presets](#rack-presets). |
| "The dial file changed since the preset was saved" | The file's tensors differ from the hash stored in the preset. The row is still loaded; the result may differ from when the preset was made. |
| `Diagnostic nodes are not available on this backend: MAIDialRack` (or `MAIDialHoldMap`) | Same cause as the first row, reported by the native check when the job is prepared. |
| `Diagnostic loras are not available on this backend: dials/…` | The dial file is not in `models/loras/dials/`, or the backend's model list is stale. |
| `Invalid dials: time curves on a continued segment need … sourceFrames …` | The pinned checkpoint clip was not found in the session list, so the window's start is unknown. Pin an existing clip. |
| `Invalid dials: time points are too close together to shift onto the continued segment's window` | Two points of a curve fall on the same moment once moved onto the continued window. Spread them out. |
| A curve does nothing | Raise its blend steps in the rack dialog; the default is provisional. See [Blend steps](#blend-steps). |
| The picture cuts to another scene where a curve changes | The row is too strong for a curve. Lower its strength. See [the rack dialog](#the-rack-dialog-and-its-timeline). |
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
  contract DEAS may rely on. The rack presets do call the pack's preset routes, because
  the preset files are the pack's and nothing in DEAS can stand in for them; they fail
  closed without the route (see
  [Rack presets: the store](#rack-presets-the-store-and-how-deas-reaches-it)).

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
  `dial`, `strength`, optional `on` and `time`), so the strip, the rack dialog and
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
dock. `onOpenRack` opens the rack dialog (the button is not shown without it) and
`rackRef` is that button, so focus can return to it.

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

### Time-curve refusals

`dialCurveConflicts` in `src/lib/dials.ts` is the one function for the compiler's
time-curve refusals, in the order native `validate_dials` checks them. It takes plain
facts about the next job (`DialCurveFacts`) and returns every refusal that applies;
native reports only the first and stays authoritative. The Workbench builds the facts
from the same state the intent is built from; `dialIntentFacts` reads them from a built
intent. The strip and the dialog both show the returned list, and Run is blocked with
it. A test per refusal compares the trigger and the native wording with the Rust source.

| Id | Fact | Native check |
| --- | --- | --- |
| `blendSteps` | an active curve's `steps` above the job's `steps` | `validate_dials` |
| `transition` | `h3.transition` | `validate_dials` |
| `faceRefine` | `faceRefine` block | `validate_dials` |
| `tiledUpscale` | `latentUpscale` without `regenerate` | `validate_dials` |
| `deropeContinued` | `videoPost.derope` with a pinned source | `validate_dials` |
| `importedVideo` | pinned source of kind `video` | `validate_dials` |
| `sourceFrames` | pinned clip's frame count known to be missing | `validate_dials`; **Studio cannot know this before Run** |
| `shift` | points collapse when shifted by the window start | `validate_dials`; **needs the window start, which Studio does not hold** |
| `holdMapMissing` | De-rope with a curve and no `MAIDialHoldMap` in the node list | prerequisite check |
| `curveLimits` | a curve `isDialCurve` rejects | `validate_dial_row`; cannot occur in stored rows |

`transition` is not a Workbench state: the join builds its transition jobs from the
captured generation intent, dial rows included. While `dialCurveConflicts` reports it
for the current rows, the Workbench does not hand the join a capture function (the
transitions option is then not offered) and passes the reason to the Continuity dialog.

### The rack dialog

- `DialRackDialog.tsx` follows `ContinuityOverlay` (native `<dialog>`, `showModal`,
  focus on Close, `cancel` handled, focus back to the opening button) and reuses
  `DialStrip` for the rows, so there is one set of row controls. Its styles are in
  `dial-rack.css`; it adds nothing to the shell's layout.
- All curve logic is pure, in `src/lib/dialCurve.ts`: `sampleDialCurve` and
  `dialFrameLevels` (mirrors of the pack's `keyframes`, `curve_fn` and
  `frame_weights`), `movePoint`/`addPoint`/`removePoint` with the limits, the presets,
  clipboard text, the lane length (`dialTimeline`) and `rackReduce`, the reducer every
  edit of the dialog goes through, strip edits included, which is what gives one undo
  history. The dialog holds only view state: level range, pointer and drafts.
- The sampler is tested against `src/lib/dialCurve.fixture.json`: 48 curves (8 point
  sets × ramp at four smoothing values and step) sampled at 3,354 times plus the
  per-latent-frame means for clips of 5, 9 and 29 latent frames, computed by the pack's
  own functions from ComfyUI-MAINodes `382f640` (working tree clean for those files) and
  matched to 1e-12. The functions were lifted from the source files with `ast` and run
  with NumPy on CPU, because the modules import ComfyUI; the generator is a scratch
  script and is not in the repository.
- Points are HTML buttons placed over an SVG that is stretched to the lane, so they are
  focusable and keep their size at every width.

### Rack presets: the store and how DEAS reaches it

Decision (owner, 2026-11-16): the pack's preset files are the store, so a rack saved in
ComfyUI shows in DEAS and the reverse, and the picker has the look of the LoRA sets
dialog. Two ways to reach the files were looked at.

1. **DEAS's own models-folder access.** The Library scan walks the models folder
   natively and only for model files (`downloads_models.rs`, `is_model`, `walk`,
   `scan`). DEAS does write small JSON files there, the `<file>.deas.json` metadata
   sidecars (`downloads_models.rs`, `SIDECAR`), so writing is not against a rule. It does
   not fit here for three reasons. The models folder is an optional local setting
   (`roots.models` in `Workbench.tsx`): with an external backend there is none, or it is
   not the backend's folder, and Studio then falls back to the backend's own lists. A
   preset row carries `sha256`, the pack's hash of the dial file's tensors
   (`presets.py::dial_sha256`, `core.tensors_sha256`); DEAS would have to re-implement
   that hash or write `null`, and must not invent one. And the pack's validation and
   exclusive create (`open("x")`) would be bypassed by a second writer.
2. **Native commands over the pack's routes**, following `native_h3_refmods`
   (`jobs.rs`, `GET /dasiwa/refmods`): `GET /mainodes/dials/presets`,
   `GET` and `POST /mainodes/dials/presets/{name}` (`dials/routes.py`).

**Chosen: the routes.** They work for owned and external backends alike, the pack
computes the hashes and the load warnings itself, and saving cannot overwrite. The cost
is that the route is a contract of a pack DEAS has not pinned yet; so every call **fails
closed**: a 404 or 405 without the pack's `{"error": …}` body is reported as "this
backend has no rack preset route", and the dialog then offers neither load nor save.

- **Native** (`src-tauri/src/jobs_dial_presets.rs`, a child module of `jobs` like
  `jobs_refmod.rs`): `native_dial_presets`, `native_dial_preset_load`,
  `native_dial_preset_save`. Names are checked against the pack's pattern before any
  request. A save is refused natively unless every row passes the compiler's
  `validate_dial_row` (1 to 8 rows), so DEAS cannot write a row it cannot run, and the
  request body is the rows as given, with no `sha256`. Answers are bounded (1 MiB, at
  most 64 rows, 500 names); a loaded preset's rows are handed to Studio as the pack sent
  them, with the pack's warnings reduced to `{row, reason: missing | changed}`.
- **Failures** come back as `CODE: detail` (`DIAL_PRESETS_UNAVAILABLE`,
  `DIAL_PRESET_EXISTS`, `DIAL_PRESET_NOT_FOUND`, `DIAL_PRESET_REFUSED`, …); the dialog
  shows the localized sentence for the code and, where the detail is the pack's or the
  validator's own sentence, that sentence beside it.
- **Logging:** every failure writes one entry to the central Logs
  (`WARN|ERROR: Dial presets <list|load|save>: <cause>; preset=<name>; repeated=N`),
  without the URL or the backend's text; per cause, the first failure and its first
  repeat are immediate and further repeats are limited to once per minute. A successful
  save writes an `INFO` entry with the name and row count. Listing and loading are not
  logged on success.
- **Conversion** is pure, in `src/lib/dialPresets.ts`: `fromPresetRows` (pack rows to
  rack rows plus a report per preset row) and `toPresetRows`. The rule is that nothing
  is changed or left out without a note on its row.
- **Dialog** (`DialPresetsDialog.tsx`): the LoRA sets dialog's frame and classes
  (`loraSets.css`), a native `<dialog>` in a portal. It takes the store as a prop (the
  native commands by default), which is how the tests and `tools/verify_dials.py` drive
  it. Inside the rack dialog a load is the reducer action `load`, always its own undo
  step; from the strip it is the strip's `onChange`. Because React hands a portal's
  events to its React parents, the dialog stops its own `keydown` and `cancel` there, so
  Esc and Ctrl+Z do not also close or undo the rack behind it.
- Left out on purpose: update, rename and delete (the pack has no routes for them), a
  preview of the preset's curves, and offering a preset's suggested strength.

### What the next parts need

- **Default shapes:** no ramp length avoided the scene change at row strength 1.5, and
  1.2 worked for the motion dial on one prompt and seed (see above). A preset could
  carry a suggested strength; nothing supports a general value yet.
- **Rows are keyed by position.** The validator allows the same dial twice (the compiler
  does); the strip only never offers it. Reordering was left out; the rack adds the
  rows' shifts, so order is not expected to change the result (not tested).
- **Off rows are not sent**, so history cannot restore them. If the rack should come
  back whole, send them with `on: false` (the compiler accepts and ignores them) and
  drop the filter in `withDials`.
- **Logging:** the strip and the rack dialog only edit local state. The one operation
  there that can be refused is the clipboard; it falls back to a copy inside the window
  and tells the user, and writes no log entry. The presets dialog's backend calls are
  logged natively (see above). Job errors already reach Logs through the job path.

## Platforms and evidence

Compilation is plain Rust and the Studio controls are plain React; both are meant to
behave the same on Linux and Windows. Nothing here was run on Windows or in the real
desktop WebViews, and nothing was run on a GPU or against a real backend. See the
verification entries for the
[compiler](VERIFICATION.md#experimental-h3-dials-compiler-slice-unreleased--2026-11-16) and the
[Dials tab](VERIFICATION.md#experimental-h3-dials-studio-dock-strip-unreleased--2026-11-16)
and the [rack dialog](VERIFICATION.md#experimental-h3-dials-rack-dialog-and-blend-steps-unreleased--2026-11-16)
and the [rack presets](VERIFICATION.md#experimental-h3-dials-rack-presets-unreleased--2026-11-16)
for what was tested and the [plan](PLAN.md) for what is open. `tools/verify_dials.py`
checks the strip's, the rack dialog's and the presets dialog's geometry, mouse and
keyboard use in Chromium with synthetic IPC. Node behaviour was read
from the installed ComfyUI-MAINodes checkout (`dials/nodes.py`, `timecurve.py`,
`presets.py`, `routes.py`), not from a pinned release.
