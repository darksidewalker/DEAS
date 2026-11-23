# DEAS Agent API — the usage guide

One HTTP plane for images, video, reference bundles, and the file shelves around them.
Every example in this document was executed against a live DEAS and rendered — copy them
freely. Words the server answers with are printed exactly as served.

Scoping tags used throughout: **[ALL]** every row · **[IMG]** image rows · **[VID]**
video rows · **[H3]** MiniMax H3 only · **[OP]** operator-only.

---

## 1. START HERE (2 minutes)

Connect: DEAS serves the plane on the port shown in its **Agent API panel** — default
`8790` on a fresh install, but the operator may have changed it there, so check the panel.
Base is `http://127.0.0.1:<port>` (default: `http://127.0.0.1:8790`), and every door after
`/v1` wants the header `x-api-key: <your key>` (the panel shows/configures the key too).
Check the plane:
`GET /v1/health` → `{"ok":true,"version":…}`.

**Your library, not ours:** every `model` handle, LoRA/model name, and placement name
printed in this document is a REAL value from one tested DEAS install — the grammar is
universal, the names are not. Before copying an example, get your own values from
`GET /v1/models` (handles, family part names like `audioVae` — copy those verbatim),
`GET /v1/families`, and `GET /v1/inputs` (placement names). Handles are the 12-hex prefix
of a file's sha256 and survive restarts; they change only if your library does.

The whole API is one loop:

1. `POST /v1/queue` — one row per picture or video (as many rows as you like).
2. `POST /v1/generate {"wait":"cycle"}` — ONE blocking call renders the whole queue,
   releases VRAM, and restores the chat model. It answers when the cycle ends.
3. Read the files (see §4) or the receipts (`GET /v1/jobs`, `GET /v1/cycle`).

Copy-me picture row (tested):

```json
POST /v1/queue
{ "model": "190dec1694ad", "mode": "t2i",
  "positivePrompt": "a shrine maiden feeding koi at a stone basin",
  "outputPrefix": "docG1-01-minimal",
  "dials": { "width": 512, "height": 512 } }
```

Copy-me video row (tested):

```json
POST /v1/queue
{ "model": "d73ac7f98c32", "family": "minimax-h3", "mode": "t2v",
  "positivePrompt": "a paper lantern drifting over a quiet harbor at dusk",
  "outputPrefix": "docG2-01-t2v", "frames": 73, "frameRate": 24,
  "dials": { "width": 512, "height": 512, "steps": 8, "cfg": 1,
             "sampler": "lcm", "scheduler": "beta" },
  "h3": { "mode": "T2VA",
          "audioVae": "Minimax\\minimax_h3_audio_vae_fp32.safetensors",
          "shiftVideo": 10, "shiftAudio": 3 } }
```

⚠ HAZARD: never restart or kill DEAS from the API; a render in flight is precious.
The `bench` doors (§4) sweep WHOLE folder roots — read that section before ever touching them.

JSON paths carry doubled backslashes (`Minimax\\…`); a single backslash is invalid JSON.
If your tooling collapses `\\` to `\`, write bodies with a serializer, not string literals.

---

## 2. ROWS — the universal grammar

### Row fields [ALL]

| field | meaning |
| --- | --- |
| `model` | a model handle from `GET /v1/models` — e.g. `"190dec1694ad"` (handles are the 12-hex prefix of the file's sha256; yours come from YOUR `GET /v1/models`) |
| `family` | optional family stamp (`"minimax-h3"`, `"anima"`, …) |
| `mode` | `t2i`, `i2i`, `inpaint`, `refine`, `upscale` **[IMG]**; `t2v`, `i2v`, `ref2va` **[VID]**; `refmod` (bundle export) **[H3]** |
| `positivePrompt` | what you want to see |
| `outputPrefix` | name stem for produced files |
| `seed` | optional; fixed seed = reproducible pixels |
| `dials` | the knobs — closed set in the next table |
| `inputImage` | placement name of your input picture **[IMG i2i/inpaint/upscale/refine]** |

### The dials — closed set [ALL]

`width`, `height`, `steps`, `cfg`, `sampler`, `scheduler`, `negativePrompt`,
`denoise` (i2i-family rows), `imageFormat` (`png`|`webp`, never jpg), `seedMode`
(`fixed`|`random`), `options`. Nothing else; there is no `batch` dial — queue several
rows instead. `imageCompression` is NOT a dial: it is a top-level control key **[IMG]**,
integer `0..=100` (see §3.3).

### Canvas law [ALL]

RULE: `width`/`height` are 8..8192 aligned to 8 (8 is the latent-grid floor; 1216×836 is
refused naming the law), product under 16,777,216 pixels. On top of that generic wall sits
the **family grid**: the model family's own `multiple` from the family plugin (8 — sd15,
pixart, hunyuan-dit; 16 — anima, moss-image and 21 more; 32 — minimax-h3, ltx-2; 64 — sdxl)
must divide every canvas edge. A 24×24 picture on anima clears the generic wall and would be
padded inside the model, so it is refused naming that grid (`Invalid width 24: anima pictures
sit on a 16-pixel canvas grid…`). The same grid gates `refine`, `inputResize` and `inpaintCrop`
targets. A family declaring no grid (music, SAM) has no picture canvas, so only the generic
wall applies to it. The law guards every path —
uploads are measured (PNG/WebP headers) and refused oversize at the upload door; `i2i`
whose INPUT breaks it is refused at the queue door naming the input dims; `refine`,
`latentUpscale`, `inputResize`, `inpaintCrop` targets are gated the same way. A film adds
the **pixels-frames budget**: `width*height*frames < 4294967296`, refusal names the
arithmetic.

### `i2i` size law [IMG]

RULE: an `i2i` render comes back at the INPUT image's dimensions even if you send
`width`/`height` (the answer echoes them as `"request"` — the echo records what you asked,
not what rendered). Want another size: promote at the size you want, or use an `upscale`
row. This holds through a `refine` second pass too (tested: refine 768² target on a 512²
input renders 512²).

### Reading the answer: dials, sources, seeds

The queue answer is the row: `{id, status:"queued", envelope}`. The envelope's dial echo
marks where every value came from — `valueSource` (and `source` in `envelope.fields[]`)
with words: `request` (you sent it) · `combo` (defaults sheet set it — see §5.4) ·
`stock` (family default) · `floor` (DEAS chose a safe value) · `none` (unset). The echo
also lists bookkeeping fields that are not dials (e.g. `batch:1 floor`) — read them as
information, don't try to set them. Tested
example: after patching the sheet (§5.4), a dial-free row echoes `steps:12 source:"combo"`
while `sampler` stays `stock`.

A fixed `seed` you sent always appears with `"valueSource":"request"`. A terminal row's
`seed` field can read `null` — recover the real seed from the queue answer or
`GET /v1/queue`. `seedMode:"fixed"` without a `seed` reuses one seed across rows of the
same batch; with a seed, two rows with identical payload render pixel-identical (PNG
metadata differs by `filename_prefix` only — pixels match).

### Etiquette & hazards [ALL]

- ⚠ HAZARD: `sigmas` validates LATE. A malformed ladder queues fine and fails at prepare
  with `"expected steps + 1 finite values"`. RULE: ladder length = `steps + 1`
  (tested: 5 sigmas with `steps:4` renders; and delete bad queued rows before cycling —
  `DELETE /v1/queue/{id}` — or the poison guard eats the whole cycle).
- Read the hint once and fix exactly it — 400/422 hints name the valid grammar.
- One `POST /v1/generate {"wait":"cycle"}` per batch; never `wait:"none"` (push mode is
  retired — the door answers `WAIT_UNSUPPORTED` / `WAIT_RETIRED`).
- If your connection drops mid-generate the cycle keeps running: poll nothing, call
  `GET /v1/cycle` (answer `{configured, phase, cycleId, report}`) later.
- A terminal failed row keeps its story at `GET /v1/cycle` → `report.rows[].error`
  (`kind`, `detail`, `hint`). `prepareRefused` naming DEAS-managed files is usually
  owner-class (repair from the DEAS UI) — EXCEPT a LoRA name miss (see §3.3).

### Refusal vocabulary

Live authority: `GET /v1/errors` (serves `{code, reason, status}` per word; who-fixs-it
is judgment: `BODY_INVALID` = you, missing-library words = owner). Common ones:

| word | status | fix |
| --- | --- | --- |
| `BODY_INVALID` | 400 | your body broke the closed grammar — the hint names the key |
| `KEY_MISSING` / `KEY_INVALID` | 401 | send `x-api-key` |
| `LANE_FULL` | 429 | too many in flight; wait for the cycle |
| `CYCLE_IN_FLIGHT` | 409 | a cycle is already running; wait |
| `LIBRARY_SCAN_REQUIRED` | 422 | handle/name/digest unknown — re-discover via `GET /v1/models` (there is no `MODEL_UNKNOWN` word) |
| `MODE_UNSUPPORTED` | 422 | mode not offered by that family — check `GET /v1/families` |
| `PREPARE_REFUSED` | 422 | compiled plan rejected at drain — read `detail` |
| `JOB_UNKNOWN` | 503 | that job id aged out of the recent window |
| `INPUT_MISSING` | 422 | placement name not on the shelf — see §4 uploads |

---

## 3. ROWS — mode & family add-ons

Every option: one line what, one line `RULE:`, one tested block. Top-level = beside the
row, NOT inside `dials`.

### 3.1 `i2i` — edit a picture [IMG]

`inputImage` (top-level): placement name of your input. `denoise` (dial) REQUIRED.
Tested (renders at input dims):

```json
POST /v1/queue
{ "model": "190dec1694ad", "mode": "i2i",
  "positivePrompt": "the same scene repainted as watercolor",
  "outputPrefix": "docG1-10-i2i",
  "inputImage": "deas-inputs/fa95111a-5838-4f3a-9cb3-3a128bbf269b.png",
  "dials": { "width": 512, "height": 512, "denoise": 0.55 } }
```

### 3.2 `inpaint` — repaint a masked region [IMG]

`inputImage` + `inputMask` + `denoise` travel together; mask uploads via
`POST /v1/uploads?kind=mask` (lands under `deas-masks/`), same size as the input,
white = repaint. `maskBlur` (top-level, int 0..31) softens the edge.
`inpaintCrop` (top-level) is a crop OBJECT
`{"x":…,"y":…,"width":…,"height":…,"targetWidth":…,"targetHeight":…}` — a boolean is
refused naming those six keys; canvas-gated. Tested:

```json
POST /v1/queue
{ "model": "190dec1694ad", "mode": "inpaint",
  "positivePrompt": "a red paper umbrella resting on the basin's edge",
  "outputPrefix": "docG1-11-inpaint",
  "inputImage": "deas-inputs/fa95111a-5838-4f3a-9cb3-3a128bbf269b.png",
  "inputMask": "deas-masks/5b1c19b9-aa5e-4722-ac1d-3fdfd657ec5f.png",
  "maskBlur": 6,
  "inpaintCrop": { "x": 0, "y": 0, "width": 512, "height": 512,
                   "targetWidth": 512, "targetHeight": 512 },
  "dials": { "width": 512, "height": 512, "denoise": 0.6 } }
```

TIP: content outside the mask comes back pixel-identical (verified). Pre-blurring the mask
file itself works everywhere.

### 3.3 LoRAs, sigmas, layers, compression [ALL except H3-still]

`loras` (top-level): up to 8 `{name, strength}` pairs — **`strength` is not optional**.
RULE: `name` = the FULL index name exactly as `GET /v1/models` prints it (subfolder and
backslashes included), or the 12-hex handle, or the full 64-hex sha256. A bare filename
queues and dies at prepare with `"Diagnostic loras are not available on this backend:
<name>"` — that is a name miss (agent-fixable: use the full name/handle), not a missing
file. Digest handles bypass family stamps: a file's sha outranks its stamped family.
Tested all three forms (name / handle / sha all rendered):

```json
{ "model": "190dec1694ad", "mode": "t2i",
  "positivePrompt": "a shrine maiden feeding koi at a stone basin",
  "outputPrefix": "docG1-05-sdxl-lora-name",
  "dials": { "width": 512, "height": 512 },
  "loras": [ { "name": "Illust\\Characters\\citlaliV4IL.safetensors", "strength": 1.0 } ] }
```

```json
{ "model": "727b9530ad3f", "mode": "t2i",
  "positivePrompt": "a paper moon over tiled roofs, ukiyo-e woodblock",
  "outputPrefix": "docG1-03-krea-lora",
  "dials": { "width": 512, "height": 512 },
  "loras": [ { "name": "bfb8914750d5", "strength": 0.8 } ] }
```

```json
{ "model": "bd43b7cffe1e", "mode": "t2i",
  "positivePrompt": "a fox spirit bowing at a torii gate at dawn",
  "outputPrefix": "docG1-06-anima-lora-sha",
  "dials": { "width": 512, "height": 512 },
  "loras": [ { "name": "1b55e40bdb1d0e5a78cb498f245fccfdaae97823265db957d2aabdcf4cd3caf1",
               "strength": 1.0 } ] }
```

`sigmas` (top-level): noise ladder. RULE: length = `steps + 1` (validated at PREPARE, see
§2 hazard). Tested: `"sigmas": [1.0, 0.9, 0.75, 0.5, 0.25]` with `"steps": 4`.

`skipLayers` (top-level): family-specific layer skips, e.g. `"2,4"`. RULE: the word must
belong to the family — a moss-family option on an sdxl row is refused. Tested on moss
(`cacd158728a1`): `"skipLayers": "2,4"` renders.

`imageCompression` (top-level control key, NOT a dial): webp quality `0..=100`
(default floor 44). Tested: `imageFormat:"webp"` + `imageCompression: 10` → 9.7 KB file.

```json
{ "model": "bd43b7cffe1e", "mode": "t2i",
  "positivePrompt": "a fox spirit bowing at a torii gate at dawn",
  "outputPrefix": "docG1-13-compress", "imageCompression": 10,
  "dials": { "width": 512, "height": 512, "imageFormat": "webp" } }
```

### 3.4 `upscale` / `refine` / `latentUpscale` / `faceRefine` [IMG]

`upscale` rows: `mode:"upscale"` + `upscaleModel` (name as the models door prints it) +
optional `inputResize` closed to `{"width":…,"height":…,"crop":"center"}` (`mode:"factor"`
and `pad` are refused). Tested (512² input → 768² out):

```json
POST /v1/queue
{ "model": "190dec1694ad", "mode": "upscale",
  "positivePrompt": "crisp watercolor koi pond",
  "outputPrefix": "docG1-08-upscale",
  "inputImage": "deas-inputs/fa95111a-5838-4f3a-9cb3-3a128bbf269b.png",
  "upscaleModel": "RealESRGAN_x4plus.pth",
  "inputResize": { "width": 768, "height": 768, "crop": "center" },
  "dials": { "width": 768, "height": 768 } }
```

`refine` (top-level): `{width, height, denoise}` beside the row + first-pass `denoise` in
`dials` — both REQUIRED together (hard pairing). You get two files: the second pass at
your prefix, the first pass at `<prefix>_original`. For a true sharpen keep
`refine.denoise` small (~0.15); it is a re-render, not a kernel. Tested at 512²→512².

`latentUpscale` (top-level **[H3-still]**): see 3.5. On ordinary families it belongs to
`refine`'s machinery; the video-row set rejects it (§3.6 closed set).
`faceRefine`: needs the SAM3 checkpoint installed (owner-class); answers
`"Diagnostic checkpoints are not available"` when missing — deliberately off on a stock
plane.

### 3.5 H3 still images — `h3Edit` [H3, image row]

RULE: `mode:"i2i"` on the H3 checkpoint + `h3Edit` block + `inputImage` + `denoise` in
`dials` (REQUIRED — the door refuses without it: `"mode 'i2i' cannot run without
'denoise'"`). Never the `h3` block (that's video-only); no `sigmas`, no `refine` here.
Optional on top: `latentUpscale: { "model":
"minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors", "scale": 2.0, "steps": 4,
"denoise": 0.5 }` (tested 512²→1024²). Tested:

```json
POST /v1/queue
{ "model": "d73ac7f98c32", "mode": "i2i",
  "positivePrompt": "the same keeper now carved as a woodblock print",
  "outputPrefix": "docG1-14-h3edit",
  "inputImage": "deas-inputs/fa95111a-5838-4f3a-9cb3-3a128bbf269b.png",
  "h3Edit": { "shiftVideo": 10, "shiftAudio": 3 },
  "dials": { "width": 512, "height": 512, "denoise": 0.6 } }
```

### 3.6 Video rows — `t2v` / `i2v` [VID, H3]

Top-level extras: `frames`, `frameRate` (24 default), reference arrays `images`/`videos`,
and the family block `h3` — closed set, `mode` word: `t2v`→`"T2VA"`, `i2v`→`"I2VA"`
(+ `images:["<placement png>"]`, slot law: I2VA slot 0), `ref2va`→ **no mode word**.
`audioVae` name copied **verbatim** from `GET /v1/models` (backslashes doubled).
RULE (frames): MiniMax H3 counts must sit the latent grid: 22, 39, 56, 73, 90, 107,
124, 141, 158, 175, 192… (each is 17k+5). For `s` seconds at 24 fps take the smallest such
count ≥ `s × 24 + 22` (the +22 covers the seed frames every clip spends).

`enhancedPreview` (top-level, optional): `{ "model": "taeh3.safetensors", "decoder":
"tiny" }` — fast decode preview.
⚠ HAZARD: the video row's top-level key set is CLOSED (`dials, streamDecode, faceRefine,
enhancedPreview, latentUpscale, videoPost, sourceVideo, output, loras, options,
firstFrame, lastFrame, chunks, audioEnhance` + reference arrays + `h3` + `frames`/
`frameRate` + slots/seed). Sending a key from outside it is refused BY NAME — that is why
`h3Edit` on a video row says `"…not an intent key the 'i2v' door accepts"`.

Tested `i2v`:

```json
POST /v1/queue
{ "model": "d73ac7f98c32", "family": "minimax-h3", "mode": "i2v",
  "positivePrompt": "the keeper lights the lamp and the harbor glow stirs",
  "outputPrefix": "docG2-02-i2v", "frames": 73, "frameRate": 24,
  "dials": { "width": 512, "height": 512, "steps": 8, "cfg": 1,
             "sampler": "lcm", "scheduler": "beta" },
  "images": [ "deas-inputs/fa95111a-5838-4f3a-9cb3-3a128bbf269b.png" ],
  "h3": { "mode": "I2VA",
          "audioVae": "Minimax\\minimax_h3_audio_vae_fp32.safetensors",
          "shiftVideo": 10, "shiftAudio": 3 } }
```

### 3.7 `ref2va` — video from references, with the TRIM law [VID, H3]

(The two placements below are from the tested library — put your own image/audio
placements here, each already uploaded per §4.)

The reference arrays: entries are a placement string OR — for `videos`/`audio` ONLY — a
decorated object `{ "file": …, "trimStart": …, "trimEnd": … }`. `images` stay strings.
RULE (trim): seconds, `0..=3600`, `trimStart < trimEnd`; each audio/video clip's TRIMMED
span must land **2–15 s** — measured at prepare (`"REF2VA clips must last 2-15 seconds"`;
the node also says `"audio must be 2–15 s"`), so a long track rides fine when you cut it.
RULE (block): `ref2va` carries NO `h3.mode` word. `inputScaling` is optional
(`"Fill and crop"`).

THE flagship, tested end-to-end (image identity + trimmed voice → AV1+AAC film):

```json
POST /v1/queue
{ "model": "d73ac7f98c32", "family": "minimax-h3", "mode": "ref2va",
  "positivePrompt": "cinematic film scene, the weathered lighthouse keeper climbs the spiral stairs, storm outside",
  "outputPrefix": "docG2-03-ref2va", "seed": 20261124, "frames": 73, "frameRate": 24,
  "dials": { "width": 512, "height": 512, "steps": 8, "cfg": 1,
             "sampler": "lcm", "scheduler": "beta",
             "negativePrompt": "blurry, distorted face, extra limbs, text, watermark" },
  "images": [ "deas-inputs/9d024645-162d-46f2-a027-7563ce089e6d.jpg" ],
  "audio": [ { "file": "deas-inputs/bda84db5-73d3-42bc-824e-5b82abb3c777.mp3",
               "trimStart": 3.43, "trimEnd": 15.14 } ],
  "h3": { "audioVae": "Minimax\\minimax_h3_audio_vae_fp32.safetensors",
          "shiftVideo": 10, "shiftAudio": 3, "inputScaling": "Fill and crop" } }
```

`refmods` (top-level): trained identity bundles — build one first (§5.1), then ride:

```json
"refmods": [ { "slot": 1, "name": "docG2-keeper.safetensors",
               "strength": 1.0, "description": "keeper identity" } ]
```

Slots 1–8, unique per row, `strength` in `(0,1]`. `refmods` ride `ref2va` rows only (and
story `base` blocks).

---

## 4. MATERIAL — inputs, outputs, and the shelves

### Uploads [ALL]

`POST /v1/uploads?kind=image|video|audio|mask` — body is raw bytes
(`Content-Type: application/octet-stream`). The answer:
`{placement, actual, kind, bytes}`. **Use the `placement` name the answer returns — never
guess the folder.** `kind=image/audio` land under `deas-inputs/`, `kind=mask` under
`deas-masks/`, `kind=video` at the input root (`deas-input-<uuid>.mp4`). Uploads ride the
canvas law (oversize images refused at the door).

### Listings & the files doors [ALL]

- `GET /v1/inputs` / `GET /v1/outputs` — the shelves (cap 500; `unlisted` counts folder
  shells, not missing files).
- `GET /v1/files/outputs/<subfolder>/<filename>` and
  `GET /v1/files/inputs/<placement, %2F-encoded>` — the bytes (Range supported; sha256
  verified byte-equal vs disk).
- Filenames follow your `outputPrefix`: `my-picture-00001.png`; re-using a prefix
  increments the counter (`-00002`, `-00003`, never overwrite); video outputs get a
  `-audio` suffix (`my-clip-00001-audio.mp4`). A `/` in `outputPrefix` nests:
  `"keeper/act1"` → `keeper/act1-00001.png`, and the files door serves that same path.

### Promote an output into an input [ALL]

`POST /v1/inputs/promote {"name":"<BARE filename on the OUTPUTS root>"}` — note: the body
key is `name`, the door reads the OUTPUTS root, and bare filename only (a `placement`
form is refused). The answer carries `name`; it then appears in `GET /v1/inputs`.

### ⚠ HAZARD: the `bench` doors

`POST /v1/inputs/bench` / `POST /v1/outputs/bench` (zero-key body) **sweep the WHOLE
root** — every file, other users' included — into `.bench/<YYYYMMDDTHHMMSSZ>/…`. Nothing
is ever deleted; rows still ACTIVE in the queue protect their files (`claimedByQueue`
refuses the sweep); terminal history never blocks it. Undo by moving the folder back.
Agents should not call these unless explicitly told.

---

## 5. COMPOSED WORKFLOWS

### 5.1 RefMods — trained identity bundles [H3]

1. `POST /v1/refmods { "name": "docG2-keeper", "description": "keeper identity",
   "images": [ "<placement>", "<placement>", "<placement>" ] }` → answer carries
   **`refmodId`** + `status:"queued"` (one id keys create, status, cancel).
2. `GET /v1/refmods/<refmodId>` → state at `refmod.state`:
   `queued → running → done` (or `cancelled`). No generate cycle needed — it trains while
   you queue other things.
3. Use it in `ref2va` rows / story `base`: `refmods:[{slot, name:"<name>.safetensors",
   strength, description}]` (tested §3.7 — bundle rode a ref2va film fine).
4. `POST /v1/refmods/<refmodId>/cancel` → `{"cancelled":"running"}` or
   `{"cancelled":"none"}` (normal when the bundle already finished). Terminal state reads
   `cancelled`. There is no list door for bundles — keep your `refmodId`.

### 5.2 Continuity film — base + segments, ONE cycle, auto-joined [H3]

The whole film renders in one generate cycle; the LAST step's file IS the joined film —
no join call.

1. Opening clip: any video mode (tested: a 73-frame `t2v`), its own cheap cycle.
2. `POST /v1/uploads?kind=video` (raw bytes) → lands at the input root;
   `POST /v1/videos/prepare {"file":"deas-input-<uuid>.mp4"}` → answer nests `prepared`
   with a 64-hex `sourceId`.
3. `POST /v1/videos/story` — `base` is the row template every step rides and
   **`base.mode` must be `"ref2va"`** (other base modes refused naming the
   `h3.continuity.durationSeconds` interlock). Each step: `seconds` + `action` (what
   happens) + optional `prompt` (restyles that step). Tested body:

```json
POST /v1/videos/story
{ "session": "docG2-film",
  "sourceId": "13395a87075b485da0fdfbdd14e2cdba6bed94d21d19590afed1172a722266c5",
  "steps": [
    { "seconds": 4, "action": "the keeper raises the lantern toward the rain-streaked window" },
    { "seconds": 4, "action": "the great lamp sweeps its beam across the black sea",
      "prompt": "the great lamp rotates, beam sweeping storm waves, wide shot" },
    { "seconds": 3, "action": "the keeper sits down beside the lamp, at rest" } ],
  "base": { "model": "d73ac7f98c32", "family": "minimax-h3", "mode": "ref2va",
            "positivePrompt": "cinematic film scene, the weathered lighthouse keeper tends the great lamp",
            "outputPrefix": "docG2-film", "frameRate": 24,
            "dials": { "width": 512, "height": 512, "steps": 8, "cfg": 1,
                       "sampler": "lcm", "scheduler": "beta" },
            "h3": { "audioVae": "Minimax\\minimax_h3_audio_vae_fp32.safetensors",
                    "shiftVideo": 10, "shiftAudio": 3 } } }
```

4. ONE `POST /v1/generate {"wait":"cycle"}` → chained renders; on disk:
   `docG2-film-00001-audio.mp4` (7.30 s) → `-00002` (11.55 s) → **`-00003` (14.375 s =
   the full film)**. `GET /v1/sessions/<session>` (case-sensitive id) shows
   `session.clips[]`; full-mode stories keep clip dirs even when `clips:[]` reads empty.
   Step length math: each step's new frames ≈ `seconds × fps`, clips overlap ~22 frames
   at the seams — don't re-derive counts yourself, the story door mints them.

### 5.3 Plain join (only if you have separate clips)

`POST /v1/videos/join {"kind":"files","files":[{"filename":"<output-side name>"}, …]}` —
model-free assemble row (tested: true concat, ~41 s for two clips). Skip it after §5.2 —
the story already joined your film.

### 5.4 Family+mode defaults — save, overwrite, reset [ALL]

- `GET /v1/defaults` — `{configurable:{combos,families,global,version}}`.
- Preview resolution: `GET /v1/defaults?family=krea-2&mode=t2i` — per-field values +
  source words.
- **SAVE/SET:** `POST /v1/defaults {"confirm":true,"key":"krea-2:t2i","dials":
  {"steps":12,"cfg":1.0,"width":768,"height":768}}`. Three-state merge: a value SETS,
  `null` CLEARS (falls back to stock), an **absent field KEEPS**. The answer carries the
  configured sheet after the merge. Writes are range-checked AT THE WRITE (`width:30000`
  → 400 there, never in a render).
- **OVERWRITE:** POST the same `key` again with `{"steps":20}` — `steps` changes,
  `cfg/width/height` survive (proven).
- **USE:** queue a row of that family with NO dials at all — e.g. `{"model":
  "727b9530ad3f", "mode": "t2i", "positivePrompt": "…", "outputPrefix": "…"}` — every
  sheet value rides with `source:"combo"`; tested render: 768×768 from the sheet alone.
- **RESET to baseline:** `null` every field you set —
  `{"confirm":true,"key":"krea-2:t2i","dials":{"steps":null,"cfg":null,"width":null,"height":null}}`
  → the next dial-free row resolves all `stock` again (proven). Caveat: there is no
  key-removal verb — the emptied `"krea-2:t2i":{}` entry stays in the sheet, behaviorally
  identical to absent.

---

## 6. APPENDICES

### A. Door cheat table

Live authority: `GET /v1/routes` (every door + its closed body grammar). The everyday
ones: `GET /v1` (plane info) · `/v1/health` · `/v1/status` (lanes + embedded
`cycle.report`) · `/v1/families` · `/v1/models?q=` · `/v1/models/status` ·
`/v1/resolve/<handle|full-name-%5C-encoded>` (absolute-path form unusable — no door
reveals the models root) · `POST /v1/queue` · `GET /v1/queue` (full spool, unbounded —
clean bad rows before cycling) · `DELETE /v1/queue/{id}` · `POST /v1/generate`
(`wait|key` only) · `GET /v1/cycle` · `GET /v1/jobs` (recent window; older ids answer
`JOB_UNKNOWN` 503 — not a server fault) · `GET /v1/jobs/{id}` · `GET /v1/history` (stock
job records, NOT cycles) · `/v1/inputs`,`/v1/outputs` · `/v1/files/*` ·
`POST /v1/uploads?kind=` · `POST /v1/inputs/promote` · `/v1/refmods*` ·
`POST /v1/videos/prepare|story|join` · `GET /v1/sessions/{id}` · `GET /v1/errors` ·
`/v1/defaults` (GET/POST) · `GET /v1/errors` (serves `{code,reason,status}` per word). Operator/debug doors exist (`/v1/scan`, `/v1/fingerprint`,
`/v1/models/refresh`, `/v1/watchdog/sever`, `/v1/free`, `/v1/stop`) — read before use.

### B. Every dial & control key (superset)

| name | tag | where | range / words |
| --- | --- | --- | --- |
| `width`,`height` | [ALL] | dials | 8..8192 ×8-aligned, product <16,777,216 |
| `steps`,`cfg` | [ALL] | dials | finite; family defaults via `/v1/families` |
| `sampler`,`scheduler` | [ALL] | dials | must exist on the backend; `euler`/`simple` always safe |
| `negativePrompt` | [ALL] | dials | text (moss prefill exists in family defaults) |
| `denoise` | [IMG i2i-family, H3-still] | dials | (0,1]; REQUIRED on i2i/inpaint/h3Edit rows |
| `imageFormat` | [ALL] | dials | `png` \| `webp` |
| `seedMode` | [ALL] | dials | `fixed` \| `random` |
| `options` | — | dials | door-served grammar (`attention|sage|cache|compile|vaeTile`) is backend-patch vocabulary, not stable row API — leave unset |
| `imageCompression` | [IMG webp] | top-level | int 0..=100 (floor 44) |
| `seed` | [ALL] | top-level | integer |
| `loras` | [ALL] | top-level | ≤8 `{name FULL/handle/sha, strength}` — strength REQUIRED |
| `sigmas` | [IMG] | top-level | length = steps+1, validated at prepare |
| `skipLayers` | [FAM] | top-level | family-specific words |
| `inputImage`,`inputMask` | [IMG] | top-level | placement names |
| `maskBlur` | [IMG] | top-level | int 0..31 |
| `inpaintCrop` | [IMG] | top-level | 6-key object |
| `inputResize` | [IMG] | top-level | `{width,height,crop:"center"}` |
| `upscaleModel` | [IMG] | top-level | models-door name |
| `refine` | [IMG] | top-level | `{width,height,denoise}` + dials.denoise pairing |
| `h3Edit` | [H3 image] | top-level | `{shiftVideo,shiftAudio}`; denoise REQUIRED |
| `latentUpscale` | [H3 image] | top-level | `{model,scale,steps,denoise}` |
| `frames`,`frameRate` | [VID] | top-level | frames on 17k+5 (H3); budget w×h×f < 2^32 |
| `images`,`videos`,`audio` | [VID] | top-level | placement strings; videos/audio gain `{file,trimStart?,trimEnd?}` |
| `refmods` | [H3 ref2va/story] | top-level | ≤8 `{slot,name ".safetensors",strength ≤1,description}` |
| `h3` | [H3 VID] | top-level | `{mode?(t2v/i2v only),audioVae verbatim,shiftVideo,shiftAudio,inputScaling?}` |
| `enhancedPreview` | [VID] | top-level | `{model,decoder:"tiny"}` |

### C. Operator notes

Settings/guard files live under the DEAS data folder; `componentOverrides` pins a family's
companions when the stamp is wrong (owner panel). `install_repair` and environment
mutation stay UI-only by design — the API reports, never repairs.

### D. What this build changed

Canvas floor 8 (8..8192 ×8) with every path measured · LoRA classification truth + hex
handle/sha digest resolution (digest outranks family stamp) · zero-key whole-root bench
sweep into `.bench/<stamp>` (never delete) · defaults range-walled at write · video
pixels-frames budget 4,294,967,296 · reference TRIM objects `{file,trimStart?,trimEnd?}`
on the videos/audio lanes (trimmed span 2–15 s) · `imageCompression` top-level control.

*Examples tested live on v0.3.14, 2026-11-22. Handles drift with library scans — when a
handle 422s, re-discover via `GET /v1/models`.*
