# The DEAS Agent API — a guide for agents and scripts

DEAS can expose a small, closed HTTP API on your own machine. Through it an agent can queue
pictures and videos, run them, get the finished files, and never worry about the GPU, the
backend, or VRAM: DEAS handles all of that around each run.

Everything lives on `http://127.0.0.1:<port>` (the port is set in DEAS Settings → Agent API;
ask your operator). Every request carries the key your operator gave you:

```
x-api-key: <your key>
```

If you forget it you get `401`. Nothing else on this API talks to the outside world.

## The one workflow that matters

1. **Queue** the work: `POST /v1/queue` (one call per picture or video; queue as many rows as you like).
2. **Run** it and wait: `POST /v1/generate` with body `{"wait":"cycle"}`.

```json
POST /v1/generate
{ "wait": "cycle" }
```

That call **does not return until every queued row has finished** — including any automatic
model swapping DEAS does around the run. There is nothing to poll, nothing to time out, and no
reason to sleep and retry: your request simply comes back when the work is on disk. The answer
is flat — `ok`, `freed` and `rows` at the top level:

```json
{ "ok": true, "freed": true,
  "rows": [
    { "id": "…", "jobId": "…", "status": "done",
      "outputs": [ { "filename": "my-picture-00001.png", "subfolder": "", "type": "output" } ] } ] }
```

`GET /v1/cycle` repeats the same information at any time, wrapped in an envelope: it adds
`phase` (`"idle"` when nothing runs) and `cycleId`, and nests the identical payload under
`report`. Row receipts echo dials with provenance words — inside `envelope.fields[]` the key
is `source`, on the row's dial echo it is `valueSource`; the words are request / stock (the
family's default sheet) / floor / none, as described under Queuing.

3. **Collect** the files (see Outputs below).

Rows that fail are marked `status:"failed"` in the report with an `error` word — the run still
completes and your blocking call still returns. A row is never silently dropped.

You may also send `{"wait":"poll"}` if you'd rather watch progress yourself, but blocking is
the recommended path: one call in, finished files out.

`GET /v1/health` answers with the plane's state (`cycle:"idle"` when nothing runs) and is a good
first call to confirm the port and key.

## Inputs — getting your material in

- **Upload a file:** `POST /v1/uploads?kind=image` (or `video`, `audio`) with the raw bytes as
  the body (`Content-Type: application/octet-stream`). The answer gives you a placement name:

  ```json
  { "ok": true, "placement": "deas-inputs/3f2a…9c.png" }
  ```

  Use that exact name to refer to the file in rows. **Videos land at the input root**
  (`deas-input-<uuid>.mp4`) — that root form is what the video doors expect.
- **Reuse a finished output as an input:** `POST /v1/inputs/promote {"subfolder":"","name":"my-picture-00001.png"}`
  — a server-side copy, no upload needed, no size limits. The answer gives the new placement name.
- **See what you have:** `GET /v1/inputs`.

## Outputs — getting your results out

Everything DEAS generates appears in the outputs area (your operator's chosen output folder).

- `GET /v1/outputs` lists finished files (`filename`, `subfolder`).
- `GET /v1/files/outputs/<subfolder>/<filename>` serves the bytes — or just read the folder
  directly if you are on the same machine.
- Filenames follow your `outputPrefix`: `my-picture-00001.png`, video outputs get a `-audio`
  suffix (`my-clip-00001-audio.mp4`).

## Queuing rows (`POST /v1/queue`)

A row is one picture or one video. The fields an agent needs:

| field | meaning |
| --- | --- |
| `model` | a model handle from `GET /v1/models` (e.g. `"727b9530ad3f"`) |
| `family` | optional family stamp (`"minimax-h3"`, `"anima"`, …); the row's model usually carries it |
| `mode` | `t2i` (picture), `i2i` (edit a picture), `inpaint` (repaint a masked region), `refine` (two-pass sharpen), `upscale` (learned upscaler), `t2v` (video), `ref2va` (video from references), `i2v` (animate one picture) |
| `positivePrompt` | what you want to see |
| `outputPrefix` | name stem for the produced files |
| `seed` | optional; fixed seed = reproducible result |
| `dials` | the knobs — the complete closed set: `width`, `height`, `steps`, `cfg`, `sampler`, `scheduler`, `negativePrompt`, `denoise` (for `i2i`), `imageFormat`, `seedMode`, `options`. Nothing else; there is no `batch` dial — queue several rows instead |
| `inputImage` | for `i2i`: the placement name of your input picture |

```json
POST /v1/queue
{ "model": "727b9530ad3f", "mode": "t2i",
  "positivePrompt": "a lighthouse keeper climbing his tower at dusk, lantern in hand",
  "outputPrefix": "keeper",
  "seed": 777401,
  "dials": { "width": 1024, "height": 768, "steps": 8, "cfg": 1,
             "sampler": "euler", "scheduler": "simple",
             "negativePrompt": "blurry, text, watermark" } }
```

The answer is the row (`id`, `status:"queued"`). Queue as many rows as you want, then run them
all with a single blocking generate — one cycle does the whole queue.

**Canvas law.** `width`/`height` must be 8..8192 and aligned to 8 (1216×840 is legal, 1216×836
is refused naming the law; 8 is the latent-grid floor — 1×1 cannot render), and the product
stays under 16,777,216 pixels. The law guards every path, not just the dials: uploaded images
are measured (PNG/WebP header dims) and refused oversize at the upload door; an `i2i`/inpaint
whose INPUT image breaks the law is refused at the queue door naming the input dimensions;
`refine{width,height}`, `latentUpscale` result dims, `inputResize` targets and `inpaintCrop`
are gated the same way; a film is bounded by the **pixels-frames budget**: `width*height*frames` stays under
`4294967296`, and the refusal names the arithmetic — "the film exceeds the
4294967296 pixels-frames budget (4096x4096 x 260 frames = 4362076160); lower frames or
the canvas (the decode would cross host memory — see the host-memory budget law)".
`imageFormat` is `png` or `webp` — never jpg.

**`i2i` size law.** An `i2i` render comes back at the INPUT image's dimensions even if you send
`width`/`height` (the answer still echoes them as `"request"` — the echo records what you asked,
not what rendered). Want a different size: promote the input at the size you want, or use an
`upscale` row.

**Inpaint rows.** `inputImage` + `inputMask` + `denoise` travel together. Upload the mask with
`POST /v1/uploads?kind=mask` (it lands under `deas-masks/`); the mask must be the same size as
the input picture, white = repaint region. Optional (top level, beside `inputMask` — NOT dials):
`maskBlur` (integer 0..31, softer edge), `inpaintCrop` (work on the masked region only).
Pre-blurring the mask file itself works everywhere. Verified: content outside the mask comes
back pixel-identical.

**Upscale rows.** These are `mode:"upscale"` rows — an `i2i` row carrying `upscaleModel` is
refused at the door naming the key. Send the top-level pair: `upscaleModel` (a library upscaler,
e.g. `RealESRGAN_x4plus.pth` — `GET /v1/models?q=esrgan`) and `inputResize`, whose closed shape
is exactly `{ "width": W, "height": H, "crop": "center" }`. Three keys, nothing else: there is no
`"mode":"factor"` spelling (refused, with the hint naming the arithmetic — "inputResize
width/height plus padding must equal intent"), and prepare demands `crop`
(`Invalid inputResize: requires image, aligned dimensions and crop`). W/H are the **result**
dimensions: they equal the row's `width`/`height` dials. Verified: 512² input → 1024² output.

**Extra row keys (top level, not dials).** `sigmas`: a custom sigma ladder (array of floats).
`loras`: an array of `{ "name": …, "strength": … }` entries (`strength` optional). `name` takes
the index name, the 12-hex handle, or the full 64-hex sha256 — the hex forms resolve **by
digest**, and the index's family stamp is not consulted, so a lora the index classifies under
another family still loads (verified: `c3d19c1a0def` and
`c3d19c1a0defce6b…af9eca13` on an anima row produced byte-identical renders at one seed — the
handle IS the first 12 hex of the digest). A `name` that is not `.safetensors` is refused at the
door: `MODEL_FORMAT_UNSUPPORTED: LoRA files must be safetensors; GGUF LoRA is unsupported`. An
unknown name is a resolution failure, never a silent skip — the row does not quietly render
without the lora. The queue answer marks such rows with `extras:["loras"]`.
`skipLayers`: MOSS-Image only, a comma-separated STRING of layer indices (e.g. `"2,4"`) or `""`.
`nativeImageReference`: `{ "method": "krea-2" | "moss-image" | "qwen-image-2.1" | "minimax-h3",
"images": [placement names] }` — must pair with the model's own family. `imageReference`:
SDXL-checkpoint route only, `{ "visionModel": handle, "images": [ { "image": placement,
"strength": 0.8 } ] × 1..4 }` — needs a CLIP-Vision model in the library; a missing one fails
the row with an owner-class repair message.

**MiniMax H3 still images.** H3 edits pictures with `h3Edit: { "shiftVideo": 10, "shiftAudio": 3 }`
+ `inputImage` (never the `h3` block — that's video-only; no `sigmas`, no `refine` on these rows).
On top of an unmasked `h3Edit` row you may add:
`latentUpscale: { "model": "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors",
"scale": 2.0, "steps": 4, "denoise": 0.5 }` (verified: 2× output) and
`faceRefine: { … }` (needs the SAM3 checkpoint installed — owner-class dependency; the door
answers `Diagnostic checkpoints are not available` when it is missing).

**Where a failed row's story lives.** A row that queued then failed keeps its `kind`, `detail`
and `hint` in the cycle report (`GET /v1/cycle` → `report.rows[].error`) and in the durable spool;
`GET /v1/history` only keeps the last handful. Read the hint: missing-file failures are
owner-class (install/repair in DEAS UI), never something an agent should fight.

A `refine` row runs a first pass then a second pass: send `refine: {width, height, denoise}`
beside the row, keep the first-pass `denoise` in `dials` (with `inputImage` it pairs as usual,
and both denoises are REQUIRED together — the pairing is a hard law), and you get two files —
the second-pass image at your prefix and the first pass at `<prefix>_original`. The second pass
is a re-render, not a sharpening kernel: for a true sharpen keep `refine.denoise` small (~0.15).

The row answer also echoes every dial back with a provenance word: a value you sent shows
`"request"` / `"valueSource":"request"`; a family default shows `"stock"`; a value DEAS chose
for you shows `"floor"` or `"none"`. A fixed
`seed` you sent always appears with `"valueSource":"request"` — that is your seed, kept.
A terminal row's `seed` field can read `null` — recover the real seed from the queue answer
or from `GET /v1/queue`.

Sampler and scheduler words must exist on the backend: an unknown one queues fine but fails
the row (`Diagnostic samplers are not available on this backend: <word>`). `euler`/`simple`
and the family defaults from `GET /v1/families` are always safe.

### Which models, which dials

`GET /v1/models` lists everything installed: `handle` (use this), `family`, `category`, `name`.
`GET /v1/families` answers per family: which `modes` it supports and its sensible default
dials — a good way to choose sizes and settings you won't have to fight. Any dial you leave
out is filled by that family's default (the row answer marks such values `"source":"floor"`).
If a family is missing a required companion
file the queue answer says so directly:

```json
{ "error": "LIBRARY_SCAN_REQUIRED",
  "hint": "family 'qwen-image-2.1' needs a textEncoders component (qwen3-vl-8b) present in the library index…" }
```

That is a report for your operator, not something an agent can fix — skip that family (the
operator section has the pin for when they choose to enable it).

### Video rows

Videos add a few fields (the exact set is confirmed by the door's own hint if you get it wrong):

- `frameRate` — 24 is a good default.
- `frames` — length in frames. For MiniMax H3 the count must fit the latent grid: 22, 39, 56,
  73, 90, 107, 124, 141, 158, 175, 192… (each is 17k+5). For a target of `s` seconds at 24 fps,
  take the smallest such count that is ≥ `s × 24`.
- `h3` — for MiniMax H3 videos this block is required. Its `mode` depends on the row mode:
  `t2v` → `"T2VA"`, `i2v` → `"I2VA"` (and `ref2va` rows need no `h3.mode`). `i2v` takes its
  starting picture in the same `images: [...]` array as `ref2va` — the door builds the internal
  reference itself, so never send `h3.references` or `firstFrame` yourself. The block must also
  carry `audioVae` — the family's audio encoder, copied **verbatim from the `name`
  field of `GET /v1/models`** (that is how all component references work: exact `name`, with
  its subfolder and backslashes). A minimal working pair:

  ```json
  "h3": { "mode": "T2VA", "audioVae": "Minimax\\minimax_h3_audio_vae_fp32.safetensors",
          "shiftVideo": 10, "shiftAudio": 3, "inputScaling": "Fill and crop" }
  ```

  `t2v` and `i2v` **do** carry `h3.mode` — the minimal `t2v` block is
  `{ "mode": "T2VA", "audioVae": "…", "shiftVideo": 10, "shiftAudio": 3 }` — and only `ref2va`
  carries none.

- Multiple identity bundles in one row are fine: give each a unique `slot` (1–8). Two characters
  in one scene = two `refmods` entries.

- `enhancedPreview` — optional; speeds up previews: `{"model":"taeh3.safetensors","decoder":"tiny"}`.

### Video from references (`mode:"ref2va"`)

`ref2va` builds a video that *stays in character* using references. It needs at least one
reference source — any mix of:

- `images: ["deas-inputs/3f2a…9c.png"]` — still reference pictures (placement names).
- `videos: ["deas-input-667f…c3.mp4"]` — a reference video clip.
- `audio: [...]` — reference audio.
- `refmods: [{ "slot": 1, "name": "my-bundle-v1.safetensors", "strength": 1.0,
   "description": "what the bundle is" }]` — trained identity bundles (next section). Slots are
  1–8, unique per row, `strength` in `(0,1]`. **`refmods` ride `ref2va` rows only** — a `t2v`
  row carrying them is refused with the rule named.

```json
POST /v1/queue
{ "model": "d73ac7f98c32", "family": "minimax-h3", "mode": "ref2va",
  "positivePrompt": "cinematic film scene, the weathered lighthouse keeper climbs the spiral stairs, storm outside",
  "outputPrefix": "keeper-scene", "seed": 777401, "frames": 124, "frameRate": 24,
  "dials": { "width": 1088, "height": 608, "steps": 8, "cfg": 1, "sampler": "lcm",
             "scheduler": "beta", "negativePrompt": "blurry, distorted face, extra limbs, text, watermark" },
  "refmods": [{ "slot": 1, "name": "doc-keeper-v1.safetensors", "strength": 1.0 }],
  "images": ["deas-inputs/3f2a…9c.png"],
  "h3": { "audioVae": "Minimax\\minimax_h3_audio_vae_fp32.safetensors",
          "shiftVideo": 10, "shiftAudio": 3, "inputScaling": "Fill and crop" } }
```

## Identity bundles (refmods)

A refmod is a small trained file that makes a character reproducible across shots — the same
face, the same creature, in every video.

1. **Build one:** `POST /v1/refmods` with a name, what it is, and 2–8 reference pictures
   (placement names from uploads or promotes):

   ```json
   { "name": "my-character-v1", "conceptType": "identity",
     "description": "short description of who this is",
     "images": ["deas-inputs/a.png", "deas-inputs/b.png", "deas-inputs/c.png"] }
   ```

2. **Wait for it:** `GET /v1/refmods/<refmodId>` (the `refmodId` came back from step 1). The
   state is at `refmod.state`: `queued → running → done`. Small bundles finish in seconds. This
   build does **not** need a generate cycle — it runs while you queue other things. Never call
   `/v1/generate` for a refmod; if a queue says `503 jobUnknown` while an export is live, just
   read the export's state instead.
3. **Use it** in `ref2va` rows (and story `base` blocks) via `refmods: [...]` (previous
   section). Names in rows use the `.safetensors` form: `"my-character-v1.safetensors"`.
   There is no list door for bundles — if a queue refuses the name as unknown, the bundle
   was never built (or was named differently).

Bundles are files. If you build a new version, give it a new name (`-v2`); the same name is not
replaced while it exists.

## Continuity videos (one scene, many shots, seamless)

To make a multi-shot video where the last frame of each shot flows into the next:

1. **Make the opening clip** (any video mode) and get its file.
2. **Upload it** (`POST /v1/uploads?kind=video`) — it lands at the input root — then
   **prepare it**: `POST /v1/videos/prepare {"file":"deas-input-<uuid>.mp4"}`. The answer carries
   a 64-character `sourceId` (the answer nests it under `prepared`).
3. **Tell the story:** `POST /v1/videos/story`:

   ```json
   { "session": "keeper-storm", "sourceId": "<the 64-hex id>",
     "steps": [
       { "seconds": 4, "action": "the keeper raises the lantern toward the window" },
       { "seconds": 4, "action": "the lamp sweeps its beam across the sea", "prompt": "the great lamp rotates, beam sweeping storm waves" },
       { "seconds": 3, "action": "the keeper sits down beside the lamp, at rest" } ],
     "base": { …one full row body, exactly as you would queue it… } }
   ```

   Each step continues from the previous clip automatically. `action` is what happens;
   optional `prompt` restyles that step. `base` carries the model, dials, `refmods` etc. for
   every step. The answer gives the `rows` it queued.
4. **Run the whole story in one blocking cycle** (`POST /v1/generate {"wait":"cycle"}`). By
   default each step runs in `outputMode:"full"`: every step's file contains the story so far,
   and **the last step's file IS the finished joined film** — no extra steps, and no separate
   segment clips are written in this mode. Continuity state (latent + clip records) lives under
   `output/df_h3_continuity/<session>/`; you never need to touch it.
   Step length: a `seconds` step mints the smallest 17k+5 frame count that covers
   `seconds × frameRate + 22` — each seam overlaps the previous clip by ~22 frames (≈1 s at
   24 fps), so a step adds `frames − 22` new frames. Final duration ≈ base + Σ(step frames − 22)
   over the frame rate.
5. **Optional — stitching tools.** Join exists for assembling clips that were made separately
   (segments from `outputMode:"segment"` stories, or plain files). Skip it after a default
   story run — your final cut already came out of step 4 (the door's `nextMove` text mentions
   join, and `prepare`'s `nextMove` advertises a low-level per-row continuity route — both are
   optional lower levels; the story door above is the recommended path). Story steps inherit
   the `base` block's `outputPrefix` with step numbers (`myfilm-00001-audio.mp4`, `-00002-`…);
   don't reuse a prefix from earlier runs or the listings look collided. To collect
   segment ids for a manual re-cut, read the session:

   ```
   GET /v1/sessions/keeper-storm        → clips[] with clipId/parent
   POST /v1/videos/join
   { "kind": "segments", "session": "keeper-storm",
     "chain": ["import_…", "<clip1>", "<clip2>", "<clip3>"],
     "filenamePrefix": "KEEPER-STORM" }
   ```

   Then one more blocking generate — the answer is a single `KEEPER-STORM_<id>.mp4` in outputs.

   A 3-step story typically runs in one cycle of a few minutes and ends with the complete film.
Story steps may also set `"outputMode":"segment"` per step to keep pure clips (no stitched
prefix); a story run that way needs a join afterwards, exactly as above.

To join **ordinary finished videos** instead, first place each clip where
the join door can read it — **upload it** (`POST /v1/uploads?kind=video`; videos land at the
input root) — then pass those placement names as descriptor objects:

```json
POST /v1/videos/join
{ "kind": "files",
  "files": [ { "filename": "deas-input-667f…c3.mp4" },
             { "filename": "deas-input-a562…188.mp4" } ],
  "filenamePrefix": "MY-CUT" }
```

…then one blocking generate, and the joined `MY-CUT_<id>.mp4` appears in outputs.

## Reading the answers like a professional

- **Every refusal is a map.** The closed grammar answers with `reason` and a `hint` that names
  the exact fields or values that are valid ("the closed grammar is …", "frames must be 17k+5",
  "unknown story field 'refmods'; the closed grammar is session, sourceId, steps, base"). When
  you get a 400, read the hint and correct that field — do not guess twice.
- **If a request ever dies with a bare dropped connection** (no JSON answer at all), the plane
  itself stays alive — `GET /v1/health` still answers. Re-send the request once; it will answer
  normally. If drops repeat, report it to your operator — never restart DEAS yourself.
- **`GET /v1/routes`** lists every door (method + path) and **`GET /v1/openapi.json`** describes
  them mechanically. They are always in sync with the running build.
- Useful reads: `GET /v1/queue` (current rows), `GET /v1/history` (recent cycles),
  `GET /v1/errors` (the full vocabulary of error codes the plane can answer with — 25 kinds,
  each with its status and reason word), `GET /v1/health` (plane state),
  `GET /v1/resume` (whether a paused cycle can be picked up; `{"ready":true}` when it can).
- Image `upscale`/`refine` modes exist on some families but ask for a workbench-style geometry
  contract (`inputResize` aligned to the intent size plus an `upscaleModel`). Prefer a plain
  `i2i` row at the larger size — same result, far fewer moving parts.
- Lifecycle doors exist but an agent normally needs none of them: `POST /v1/stop` (abandon the
  running cycle), `DELETE /v1/queue/{id}` (drop a QUEUED row — terminal rows keep their record
  for the record-keeping, no delete verb ships for them), `POST /v1/jobs/{id}/cancel`,
  `POST /v1/free` (release GPU memory — DEAS already does this around cycles).

### Other doors (operator/debug)

Agent work needs none of these; they are named once so a read can be cited rather than guessed.
`GET /v1/routes` (46 doors on this build) is the authority.

- `GET /v1` — plane help: `plane`, `version`, `port`, `enabled` plus the route index it serves.
- `GET /v1/status` — plane fields: lane ceilings (control 2, render 4), `keyRequired`,
  `originAllowlist`, `guard.configured`, and honest `backend.state` — it never claims a backend
  it has not seen.
- `GET /v1/models/status` — `libraryReady` (can the resolver read a non-empty index right now)
  plus the stock scan slot; `scan.state:"idle"` means no scan is running now, never "cold".
- `GET /v1/scan` — that scan posture alone (`state`, `root`, `file`, counters; idle at boot).
- `POST /v1/scan` — start the stock scan over the engine's saved model folders: the
  `LIBRARY_SCAN_REQUIRED` remedy. Zero keys, no root parameter, one scan at a time.
- `POST /v1/fingerprint {"action":"start"}` — alias over that same scan seam (the UI's own Scan
  Files call); a second scan while one runs answers the stock reserve refusal.
- `POST /v1/models/refresh` — rebuilds the index snapshot, and is the only door that recomputes
  component stamps: an agent told a component is missing can fix the ground truth itself. Body
  closed to zero keys, zero VRAM, touches no backend process — safe beside a live cycle; the walk
  takes minutes on a big library. Answer `{ok, refreshed, roots, nextMove}`.
- `GET /v1/resolve/{q}` — one reference through the resolver's own lookup: the 12-hex handle, the
  exact index `name`, or a percent-encoded absolute path. Match → identity, never a path; none →
  `count:0` with the scan remedy in `nextMove`; several → `familyAmbiguous` naming every
  candidate.
- `GET /v1/jobs`, `GET /v1/jobs/{id}` — stock workbench row snapshots (`state`, `intent`,
  `outputs`, `promptId`), deduped by id; unknown ids answer `JOB_UNKNOWN`. These are the engine's
  rows — `GET /v1/queue` is yours.
- `POST /v1/refmods/{id}/cancel` — cancel one export by the id its own answer carried (the
  backend prompt id). Answer is the stock placement word `{cancelled: queued|running|none}`, never
  a completion claim; an unknown id answers `jobUnknown` naming it. `POST /v1/stop` cannot reach
  an export; this keyed door can.
- `GET /v1/outputs/{id}/{index}` — one stock output preview as JSON (`jobId`, `index`, `mimeType`,
  `width`, `height`, `sha256`, `bytesBase64`) under the stock validation bounds and the stock
  single-fetch gate. Prefer the files doors.
- `POST /v1/watchdog/sever` — operator/debug only: runs the sever arm against the row the judge
  latched, or over a closed window with the closed body `{"jobId": "<stock job id>"}`. Refused
  while a cycle holds the card unloading/restoring; `jobUnknown` when nothing has tripped.



- See the planes: `GET /v1/inputs` and `GET /v1/outputs` list everything (no query
  parameters — any `?q=`/`?limit=` is refused). Both report `cap:500`, `truncated` and
  `unlisted`; past the cap there is no page-two door. `unlisted` counts files the media
  table doesn't label (e.g. continuity state under `df_h3_continuity/`) — they exist on
  disk but no door lists them.
- Read bytes: `GET /v1/files/inputs/<placement, %2F-encoded>` and
  `GET /v1/files/outputs/<subfolder>/<filename>` (up to 8 segments; Range works).
- **No door deletes files — inputs or outputs.** The cleanup verb is the bench,
  and a bench call is a **whole-root sweep**: it takes **no body**.
  `POST /v1/inputs/bench` and `POST /v1/outputs/bench` — empty body (or `{}`);
  any key is refused, and the hint names the law: "the bench sweep takes no body:
  one call benches EVERY file under the root except the ones a live queue row
  holds; drop the field '<key>'". One call moves **every file under that root**
  (the whole tree — your placements, operator drops, UI-placed files, and on the
  output plane the `df_h3_continuity/` state too) into **one date-time-stamped
  folder inside the `.bench` parent** of the same root:
  `<root>/.bench/<YYYYMMDDTHHMMSSZ>/<original relative path>` (UTC). One call,
  one dated group: everything benched together is one folder to find later. The
  list is **unbounded** — there is no entry cap. The stamp folder is minted
  lazily (a call that moves nothing leaves no folder on disk) and calls landing
  in the same second share one folder.
- What stays put: a file a **live** (queued / draining / wedged) row still
  references is refused per-row `claimedByQueue` naming that row, and it remains
  at its original path for the drain to read. **Terminal rows never hold
  anything** — the sweep does not track items that were already generated, so a
  `done`/`failed`/`cancelled` row never blocks its files.
- Rows answer `{old,new}` or `{old,error}` (`notFound` / `targetExists` /
  `moveFailed` / `claimedByQueue`); partials are honest, and a successful row
  means the source path is gone and the same bytes live at the new path — a
  move, never a copy, never a delete. `moved`/`refused` count ALL swept rows;
  `rows` carries every refused row plus the first 50 moved rows and
  `rowsTruncated: true` says the moved details were capped — the files all moved
  either way. If the root cannot be walked, or the spool cannot be read, the
  whole call is refused `maintenanceActive` and nothing moves.
- Dot folders are **never re-swept**: `.bench` and anything inside it, plus any
  legacy `.bench-<stamp>` folder from the older grammar, stay exactly where they
  are (the walk skips every dot-prefixed entry at every level). Benched names
  leave the listings but stay readable at their `".bench/<stamp>/<name>"` path —
  for inputs percent-encode the whole name, `.bench%2F<stamp>%2F<name>`;
  outputs take the catch-all spelling `/v1/files/outputs/.bench/<stamp>/<name>`.
  **Un-benching is an owner action**, not an agent door. Use bench to declutter
  your working set or to sweep material aside before another user of this box
  takes over.
- Rows: `DELETE /v1/queue/{id}` drops a still-QUEUED row (terminal rows keep their
  record); `POST /v1/queue/clear` cancels all queued rows at once.
- Listings carry no ownership tag — remember your own placement names; a bench
  call sweeps the whole plane, every file in it, not just yours.

## Family defaults (the user-configurable layer)

Every family+mode has a defaults sheet the queue merges under your row — send a minimal
row (just `model`, `mode`, `positivePrompt`, `outputPrefix`) and the sheet supplies the
rest. It is operator/user-configurable live, no restart:

- `GET /v1/defaults` — the stock table plus the configured sheet; add
  `?family=sdxl&mode=t2i` for the resolved per-field preview with source words
  (`request`, `combo`, `family`, `global`, `stock`, `floor`, `none`).
- `POST /v1/defaults {"confirm":true,"key":"sdxl:t2i","dials":{"width":576,"height":1024}}`
  — three-state merge: a value SETS it, `null` CLEARS it (falls through to family/stock),
  an absent field KEEPS it. The answer is the full post-merge sheet. The write is
  confirm-gated.
- Proven: patch the sheet, queue a dial-free row, the render comes back at the patched
  size; `null` the fields and the next row falls back to stock. Merged values ride the
  queue answer with their source word.
- Careful: the sheet range-walls `width`/`height` at the write (8..=8192, aligned to 8,
  product under 16.7M) — a bogus `width:30000` is refused with a canvas hint, so a
  family+mode can no longer be poisoned from the sheet. The latent grid needs
  dimensions aligned to 8; 8 is the true floor (1x1 cannot render).

## Etiquette for agents

- Queue everything you want, then generate **once**. One cycle runs the whole queue — cheaper
  and faster than one cycle per row.
- Never kill, restart, or reconfigure DEAS. If something looks stuck, read `GET /v1/cycle` and
  report it; the operator handles the machine.
- Don't fight the hints: a `422` usually names the missing piece (a companion file, a size
  rule); a `400` names the field. The API is closed by design so that every answer is
  deterministic.
- Fixed seeds make your work reproducible; set one and keep it in your notes.
- **The queue door has no idempotency:** the same body POSTed twice queues twice. Dedupe
  yourself if that matters.
- **A few values pass the door and die at render:** `steps:0`, negative `cfg`, and malformed
  `sigmas` (see the sigma bullets below) all fail with `prepareRefused` at submit. Avoid them;
  if a whole batch of started rows fails at submit, the cycle's poison-row guard aborts the
  drain and the generate call answers `MAINTENANCE_ACTIVE` — your remaining rows stay queued
  and re-POSTing the same blocking wait safely resumes the drain.
- `steps+1` sigma ladders must be finite floats, strictly descending, ending at 0 — the render
  error states this verbatim; check it before you queue.
- **`sigmas` is validated at prepare, not at the queue door:** a malformed ladder (e.g.
  `[1.0,"x"]`) queues with `200` and sits in `GET /v1/queue` until the drain reaches it, where it
  fails `prepareRefused` and the poison-row guard aborts the whole cycle. Read your own queued
  rows before you generate and `DELETE /v1/queue/{id}` any malformed ladder — the door will not
  do it for you.
- An unknown model handle answers `LIBRARY_SCAN_REQUIRED` even when the library is fine —
  it really means "that handle/name matched nothing": re-check `GET /v1/models`.

## Quick recipe (copy-me block)

```text
1. GET  /v1/health                          (port + key alive?)
2. GET  /v1/models                          (pick a handle for the family you want)
3. POST /v1/queue   {model, mode:"t2i", positivePrompt, outputPrefix,
                     dials:{width,height,steps,cfg,sampler,scheduler}}
4. POST /v1/generate {"wait":"cycle"}       (blocks; returns when files exist)
5. GET  /v1/outputs   → read files, or read the output folder on disk
```

For videos, swap `mode` to `t2v` (add `frames`, `frameRate`, and the `h3` block with
`mode:"T2VA"` + `audioVae`) or `ref2va` (add `images`/`videos`/`refmods` and `audioVae` in
`h3`; no `h3.mode`). For a MiniMax H3 row, a known-good full copy-me block:

```json
{ "model": "d73ac7f98c32", "family": "minimax-h3", "mode": "t2v",
  "positivePrompt": "a small round creature wakes up in a sunlit meadow, stretches, yawns",
  "outputPrefix": "my-clip", "seed": 3383938679, "frameRate": 24, "frames": 107,
  "dials": { "width": 1088, "height": 608, "steps": 8, "cfg": 1,
             "sampler": "lcm", "scheduler": "beta",
             "negativePrompt": "blurry, distorted face, extra limbs, text, watermark" },
  "h3": { "mode": "T2VA", "audioVae": "Minimax\\minimax_h3_audio_vae_fp32.safetensors",
          "shiftVideo": 10, "shiftAudio": 3, "inputScaling": "Fill and crop" },
  "enhancedPreview": { "model": "taeh3.safetensors", "decoder": "tiny" } }
```

For multi-shot scenes, see Continuity above.

## What this build changed

- **The canvas floor is 8, not 1.** `width`/`height` below 8 or unaligned to 8 are refused — the
  latent grid cannot mint a smaller tile, so a 1×1 render is impossible by construction. The same
  wall gates uploads, `refine`/`latentUpscale` targets, `inputResize` targets and `inpaintCrop`.
- **LoRA names resolve by digest.** `loras[].name` accepts the 12-hex handle or the full 64-hex
  sha256 and ignores the index's family stamp — that is the bypass for a misclassified lora. A
  non-safetensors lora is refused naming the format.
- **The bench is a whole-root, zero-key sweep.** One call moves every file under the root into
  `<root>/.bench/<UTC stamp>/…`; there is no per-file delete door, and only files a **live** row
  still holds are refused (`claimedByQueue`). Terminal rows never hold anything.
- **The defaults sheet is range-walled at the write.** A `width` outside 8..=8192 or unaligned is
  refused with the canvas hint, so a family+mode can no longer be poisoned from the sheet.
- **Films are bounded by the pixels-frames budget** (`width*height*frames` < 4294967296); the
  refusal names the product and tells you which dial to lower.

---

### Operator section — Agent API panel settings

The API ships **disabled**: nothing listens, nothing is written, until an operator turns it on.
Settings → Agent API in DEAS:

| setting | effect |
| --- | --- |
| **Enabled** | turns the plane on. Takes effect at the next DEAS start. |
| **Port** | the loopback port the plane listens on (default suggestion 8790; any free port). Changing it also applies at the next DEAS start. |
| **Standing key** | the `x-api-key` value every request must carry. Generate something long; store it where your agents can read it. |
| **Origins** | optional browser-origin allowlist for web clients. Leave blank for agents/scripts — loopback tools need no CORS entry. |

Guard block (only relevant when DEAS shares the GPU with another model host):

| setting | effect |
| --- | --- |
| **Auto-cycle VRAM** | when on, every generate cycle unloads the other model first and restores it after — agents never think about the GPU. Requires the two commands below. |
| **Unload / restore commands** | the two system commands DEAS runs at cycle start/end. They are operator-configured and operator-owned. |
| **Ready URL** | a health URL DEAS waits for after restore before it accepts the next cycle. |
| **Upload caps** | size limits (MiB) per upload / per job. Blank = unlimited within the plane's built-in limits. |

Everything the plane stores lives in the app-data folder (`deas-agent-settings.json`,
`deas-agent-guard.json`, queue/cycle spools). Deleting those files and restarting returns DEAS
to the shipped off/blank state.

**Component overrides (operator-only, edit the settings file directly).** When a family refuses
`LIBRARY_SCAN_REQUIRED` because its component gate wants a header signature your file doesn't
carry — but you know the pairing is right — pin the file yourself in
`deas-agent-settings.json` (takes effect at the next DEAS start):

```json
"componentOverrides": {
  "qwen-image-2.1": {
    "textEncoders": "qwen21/qwenImage21TextEncoderOriginal_v10_3241874.safetensors",
    "vaes": "qwen21/qwenImage21VAEOriginalBf16_v10.safetensors"
  }
}
```

Family id → slot word (`textEncoders`, `vaes`, `audioVaes`, `textProjections`) → the library
file name (either separator; the file must be in the library index — re-scan after placing).
The override skips only the index's architecture stamp; the render backend stays the final
arbiter, so a wrong pairing fails its row with the backend's own honest error rather than
silently misrendering.
