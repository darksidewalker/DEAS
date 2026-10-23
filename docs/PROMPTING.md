# Prompt Forge, LLM settings, presets and wildcards

[Documentation index](README.md) · [Current implementation status](IMPLEMENTATION-STATUS.md)

## Shared LLM backend

After installing or reopening a DEAS environment, select **Backend → LLM backend** in the left-hand configuration menu. Configure only an optional Ollama server (such as `http://127.0.0.1:11434`) or OpenAI-compatible API (such as `http://127.0.0.1:8080`; `/v1` is appended when missing, like the DaSiWa node pack does). There is no global model or GGUF-path setting.

Local language GGUFs are discovered recursively in the existing **Models folder → llm** directory (by default `<environment>/ComfyUI/models/llm`), independently of any external server. Projector files such as `mmproj` are excluded. `llama-cpp-python` runs the selected local model automatically in the managed venv, with automatic CPU/GPU offload selection, and the worker exits after each request. Optional remote model discovery adds to the local list; an unavailable remote server does not hide local models.

**Test model** lists discovered local and remote models together and chooses a model only for that test request, without saving a default. A failed request never silently switches to another model. Opening settings reads model lists but never generates text. No server, package or model is installed or downloaded by this panel. API-key authentication remains separate work.

![Shared LLM backend settings — browser IPC fixture, not a live server reply](../assets/deas-llm-fixture-1440.png)


If an LLM entry point (including Prompt Forge, inline writers and Director/Continuity helpers) is clicked without a configured endpoint or discoverable local language model, DEAS opens **Backend → LLM backend** with setup guidance instead of an empty writer. The source draft stays mounted. This navigation does not download, start a model or submit text/media. A configured service's connection failure remains an error, not evidence that configuration is missing. Before an environment has been installed/opened, Backend explains that prerequisite; runtime LLM settings cannot be used without one.

## Prompt Forge

Prompt Forge writes or enhances prompts in the dialect of the selected model. It runs in the DaSiWa node pack on the owned backend (the same code as the **LLM Prompt Writer** node and the H3 Director's Forge); DEAS sends it the endpoint saved under **Backend → LLM backend**. Models come from `ComfyUI/models/llm` plus that server.

- **Hammer in the prompt field (Generate):** choose LLM Prompt Forge or Wildcards. The LLM mode writes or enhances the current prompt for the selected model's family (Illustrious/SDXL, Anima, Krea 2), in Image to Image and Inpaint also lets a vision model read the source picture (input or output folder; a model without vision writes from the text and says so), shows the result for review, applies it on **Apply**, and keeps one **Undo**. With Wildcards active, the idea starts as the current prompt plus the resolved picks (node pack 0.5.31 or newer), so the LLM writes around them. Families without a prompt dialect disable only the LLM mode; wildcards need no LLM.
- **Prompt Forge tab:** the same writers for every family plus Wan 2.2, LTX 2.3 and MiniMax H3, with Detail and Creativity, reference pictures from the input folder (read by a vision model), and **Send to Generate** for the prompt and an optional negative prompt. H3 offers T2VA, I2VA, FL2VA, L2VA and REF2VA with Duration, Shots and labelled pictures (Character 1–4, Place, Style, First/Last frame); H3 Generate has a separate bounded recipe; Forge offers more modes than generation currently supports. See [video generation](STUDIO.md#video-generation).

Baseline writers need DaSiWa node pack 0.5.30 or newer on the backend (**Backend → Upgrade**); Director features additionally need their corresponding Forge/Cast/people routes. The **Generate hammer** supports bounded H3 Cast/scene/pose cards, people boxes, explicit Cancel and run-context references; see [Studio controls and limitations](STUDIO.md#prompt-controls). These additions do not extend the separate Prompt Forge tab. The Generate hammer also accepts manually assigned first/last-frame character cards for I2VA/FL2VA/L2VA; generation graphs remain unchanged. Streaming, automatic card reading and continuity drafts remain planned.


## Continuity Next action (checkpoint sources)

In the H3 Continuity overlay, the next runnable step with a known checkpoint source offers the existing Prompt Forge hammer. Its brief is Next action; applying the result changes only that step. Source/session, overlap, current action, step seconds and canvas travel with the request, and context/model/backend changes invalidate a draft. Review, history, undo and cancellation remain explicit. Plan/run controls lock during writing, and closing Continuity cancels its owned request. The backend supplies source-tail evidence when the model/runtime permits it; missing-image warnings mean text-only context, not verified vision. No additional timeline references are supplied in this bounded checkpoint path. A prepared backend-input video now uses the same review flow with `source_kind:video` for the first extension; later steps use their generated checkpoint predecessors. Local uploads and use-references remain separate work. Actual local-model/source-tail quality remains unverified until a consented real run.

## Presets

Generate has independent **Presets** and **Wildcards** dock tabs. Presets need the desktop app, but no running backend, LLM or node-pack installation. Enter a name and choose **Save as new preset** to retain the current live Studio controls, including unsaved changes. Select a saved preset and choose **Load preset**; edit the normal Studio controls, then **Update selected preset** to replace that preset after confirmation, or enter a different name to save another copy. Existing names cannot be silently overwritten by Save as new.

Presets include prompts, selected model/component filenames, LoRAs, pipeline, resolution/scaling, sampler/steps/CFG, seed and random/fixed mode, image/inpaint settings, video controls, post-processing, Options and wildcard rules/activation. They exclude media/input files, references/people assignments, masks/layers, continuity sessions, seed history, layout, backend/folder/auth configuration and project/job identity. Random seed mode remains random; a preset is not a promise to reproduce a random generation. Loading never starts execution, replaces media or saves a project automatically. Normal model availability and generation validation still apply; unavailable files must be supplied or selected before running.

Up to 100 presets are stored in an app-local JSON file through the native service (2 MiB total limit, names up to 100 characters). They survive restarts independently of Studio reset and project/global draft scope. They are not bundled media/project archives or exported packages. Prompt text is stored locally in plaintext: do not put secrets in prompts. Invalid/incompatible settings are rejected as a whole; read/write failures remain visible and are recorded in shared Logs without preset contents. A corrupt file is not overwritten by an empty fallback. Linux/Windows use the same native persistence path; Windows runtime acceptance remains unverified.

## Wildcards

Generate's **Wildcards** dock tab sits beside LoRAs and also opens from the hammer. It reads the installed DaSiWa node's library, with searchable categories, independent preset/wildcard selections and weights, Booru/natural-language style, its own seed and an estimated token budget per positive/negative side. Positive/negative placement follows the original library categories.

Activation is opt-in and remembered with the rules. Manual or Forge-written prompts remain the base text; the original `DaSiWa_WildcardPresetPromptBuilder` runs before both text encoders and appends the selected fragments. **New picks** rerolls alternatives; **Random select** explicitly replaces the selection with 1–10 available entries. **New picks on every generation** rerolls alternatives only, never the selected subjects. The original node handles weighting, category order and budget pruning; DEAS has no second prompt-expansion engine.

An active badge beside the prompts opens the rules; **Disable wildcards** stops applying them without clearing the selection or base text. Job metadata records the submitted rules independently of later edits; **Use these settings** restores a job's rules, while applying ordinary image metadata disables augmentation to avoid adding it twice to an already resolved prompt. With the DaSiWa metadata saver installed, output PNG metadata receives the exact evaluated positive/negative strings. The text fields and job intent show base text, not a prediction of a future random pick. Missing library/node support reports an error instead of silently dropping active rules. Custom libraries remain managed by the node pack; after changing its file, restart that backend as documented by the node.


## Troubleshooting and boundaries

Review Backend → Upgrade for missing node-pack routes; this changes only the approved owned environment. Check discovery, selected model/provider and vision support when requests fail. Active wildcards require their library/node and fail closed. Writer output is a suggestion for review, not quality/adherence proof. Keep secrets out of prompts/reports. See [Logs](LOGS.md) and [verification](VERIFICATION.md).
