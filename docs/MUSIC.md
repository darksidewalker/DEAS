# Music — YuE2 text-to-music and melody covers

[Documentation index](README.md) · [Studio](STUDIO.md) · [Open work](PLAN.md#43-music-yue2)

Studio → Generate offers two music pipelines for YuE2 checkpoints. Both compile to the ComfyUI core YuE2 nodes natively; no custom node pack is needed for generation.

## Selecting a music pipeline

- **Music (Text to Music)** and **Music (Cover Music)** sit in the Pipeline picker next to the image and video modes.
- The checkpoint picker lists only files whose safetensors header carries both YuE2 keys (`model.diffusion_model.llm2vae.weight` and `text_encoders.model.embed_tokens.weight`). Put the checkpoint under `models/checkpoints`. A file that only has the YuE2 name is not listed; a renamed file with the keys is.
- Covers need a SheetSage2 audio encoder under `audio_encoders` in your configured models folder (or the backend's own `models/audio_encoders`). The picker shows the names the running backend reports for `AudioEncoderLoader`; nothing is downloaded automatically.
- Missing YuE2 or SheetSage2 nodes on the backend disable only the dependent pipeline. Run names the missing node or encoder in its tooltip and the Run Plan notices.

## Style and Lyrics

Music replaces the positive/negative prompt pair with two independent editors. **Style** is required (genre, mood, instruments, vocal description, language); **Lyrics** is optional and may use section tags such as `[Verse]` and `[Chorus]`; leave it empty for an instrumental. Each editor has its own expand, copy and clear buttons and its own Prompt Forge hammer: Style writes with the DaSiWa `YuE2 Song Style` dialect, Lyrics with `YuE2 Lyrics`. There is no negative prompt and no image reference.

Music texts are stored separately from image prompts (`studio.run.music.*`). Switching to an image or video pipeline and back restores each pipeline's own draft; the Prompt Forge "Send to Generate" handoff is refused while a music pipeline is active because it carries image prompts. Projects (image drafts) never serialize music settings.

Without a configured LLM the hammers stay disabled and point to LLM setup, like the image hammers.

## ABC planning and generation settings

Text to Music chooses **ABC planning**:

| Planning | Graph | Extra settings |
| --- | --- | --- |
| Off | `YuE2GenerateMusic` only; the planning input is empty | AR settings only (the AR guidance control switches to 1.01 the first time you choose Off while it is still at 1) |
| Full | `YuE2GenerateABC` writes melody and chords, then `YuE2GenerateMusic` follows it | ABC settings: max tokens, temperature, top-p, top-k, repetition penalty, penalty window |
| Melody | same as Full in melody mode | same ABC settings |

Autoregressive (AR) settings apply in every mode: temperature, top-p, top-k, repetition penalty and AR guidance (`cfg_scale`). Seed, steps, CFG, sampler and scheduler are the usual sampling controls (defaults 32 / 1.0 / `dpm_2` / `sgm_uniform`, as in the core template). **Maximum duration** bounds the request in seconds (0.04 s steps, at most 900 s); the generated song may be shorter. All bounds mirror the native validation in `src-tauri/src/jobs_music.rs`; the UI rejects values outside them.

## Covers

```
selected audio or video ──LoadAudio──► SheetSage2AudioToABC ──melody ABC──► YuE2GenerateMusic ──► VAEDecodeAudio ──► FLAC
                                        (AudioEncoderLoader)        + Style + Lyrics
```

- Select the source in the Media dock with **Use for music cover** (context menu). Audio files and videos are accepted; images are not offered. Only one source is active; the Media dock marks it.
- Core `LoadAudio` reads the first audio stream. A video without an audio track fails at the backend with `No audio stream found in the file.` — there is no silent text-only fallback.
- The source is uploaded once when you press Run; the submitted intent carries the uploaded name and is frozen. Edits after Run belong to the next job.
- A cover is a melody reinterpretation: planning is always Melody, Lyrics come from you, and nothing copies the singer's voice, transcribes words, or preserves tempo, timbre or exact duration.

## Results

- Output is one FLAC under the output prefix (`raw/audio/…` with the default naming template). Native result handling decodes the whole file (pure-Rust `claxon`, CRC-checked) before it is cached, previewed or exported; a truncated or corrupt file is rejected as an invalid output rather than shown.
- The Workbench renders a standard audio player with controls and no autoplay; the queue shows ♪ for audio jobs. Generation metadata lists the music fields; the image "use these settings" action is not offered for music.
- Recent generation history restores a music record completely (pipeline, texts, planning, durations, encoder, sampling). The cover source must be re-selected explicitly; until then Run stays blocked and names the missing file.
- Save As follows the existing no-clobber output export; the decoded bytes are what was retained, never a re-fetch.

## What was verified, and what was not

Tested revisions: ComfyUI core `b1a247c9` (2026-10-19) for the YuE2/SheetSage2 node schemas and `SaveAudioAdvanced` history shape; ComfyUI-DaSiWa-Nodes `ab364c5` for the `YuE2 Song Style`/`YuE2 Lyrics` writer presets. The node schemas were captured in-process from a throwaway CPU-only ComfyUI (`--cpu`, port 8199, stopped afterwards): all compiled Full/Melody/Off/cover graphs pass `validate_prompt`; `LoadAudio` decodes a FLAC and an MP4 with audio and rejects a silent MP4 with the error above; `SaveAudioAdvanced` lists its FLAC under the `audio` history key.

Automated: Rust compiler/validation/prerequisite/FLAC-transport tests, header-detection test, Vitest suites for `MusicPrompts`, `MusicSettings`, Run Plan, metadata, history restore and the Workbench music flows, six-locale key parity.

**Not verified:** the layout/screenshot gate does not switch Generate to the music pipelines, so narrow-width geometry of the music controls is unchecked; no song has been generated with real weights (GPU runs were not authorized in this slice), so music quality, ABC-mode behavior, cover melody relationship, scoped cancellation during generation and actual duration/sample-rate/VRAM are unmeasured. FLAC playback was exercised in the Chromium test runtime only — Linux WebKitGTK and Windows WebView2 playback and the Windows runtime are not verified. SheetSage2 list multiplicity on a live backend was not observed.

## License notice

The inspected YuE2 checkpoint header declares CC-BY-NC-4.0. Verify the model card, the SheetSage2 encoder terms and the ComfyUI core license before adding either to a download catalog or redistributing outputs commercially. This page is a usage note, not legal advice.
