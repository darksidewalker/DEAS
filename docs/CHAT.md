# Chat

**Studio → Chat** is a conversation with the LLM set under **Backend → LLM backend**, ported from PromptForge's chat. It knows this project: it can write prompts with the image models' own prompt writers, read how any model (or DEAS itself) wants to be used, look tags up, and search the web when you switch that on.

## Requirements

- An Ollama or OpenAI-compatible LLM server under **Backend → LLM backend** (llama.cpp, llama-swap, vLLM, Ollama). The local GGUF runner cannot call tools yet, so Chat says so instead of answering.
- Prompt Forge data is included in the executable, including the chat prompt, model guides and tag database. Existing files in `<environment>/forge-data` (or `DEAS_FORGE_DATA`) override the bundled defaults. No separate download or running ComfyUI backend is required for Chat. See [Prompting](PROMPTING.md#prompt-forge).
- The model is picked at the top of the tab, from the same list as Prompt Forge.

## Using it

- Type and press **Enter** to send (**Shift+Enter** for a new line). Answers appear as they are written; **Stop** ends one early and keeps what arrived.
- **Pictures:** **Picture** or paste an image (up to four per message, PNG/JPEG/WebP, large ones scaled down). They go to the model with that message only and are never saved; the history notes that pictures were sent. The model has to be able to see pictures.
- **Include what I'm working on:** sends Studio's current prompt, negative prompt, model, size and sampler settings, and your Prompt Forge draft with each message, so you can ask about them directly ("why does this prompt keep giving two people?").
- **New chat**, and the list of conversations on the left: open, rename (✎) or delete (×, then **Delete?** to confirm).

## What it can do on its own

The model decides when to use these; what it used is listed under its answer.

| Tool | What it does |
| --- | --- |
| `write_prompt` | Writes a prompt for **Illustrious, Anima, Krea2 or MOSS** with that model's real prompt writer (the same engine as the Prompt Forge tab, with PromptForge's default settings, including tag lookups and character canon). The prompt is shown as a card exactly as written, with **Copy** and **Send to Generate**; the chat model never retouches it. For the full set of controls use the Prompt Forge tab. |
| `read_guide` | Reads a guide before answering how something works: each image model's own prompt-writing instructions and guidance documents, the **MiniMax H3, Wan 2.2 and LTX 2.3** prompt guides, and DEAS's user guides (Getting started, Studio, Prompting, Library, Media, Backend, Logs, Projects, Comfy). "How does LTX prompting work?" reads the LTX guide first. |
| `search_tags` | Looks tags up in the local Danbooru tag database: whether a tag exists, its spelling and how common it is. |

## Web search

Off by default: Chat does not go online unless you switch it on. **Web search** at the top of the tab chooses how:

- **DuckDuckGo** needs nothing installed. Your message is sent to DuckDuckGo and its plain results page is read, which means the query leaves this PC and the page format can change.
- **SearXNG** sends the search to your own SearXNG server (its address, e.g. `http://127.0.0.1:8080`), which proxies it. SearXNG must be running and allow JSON results (`search.formats` including `json` in its `settings.yml`).

With a search mode chosen, the **Search** button appears beside the message box. While it is on, your message is searched before the answer and the answer cites the results as [1], [2] with the sources listed under it. The setting is stored in `<environment>/deas-chat.json`.

## Where things are kept

- Conversations: `<environment>/chats/<id>.json`, one file each, newest first (at most 500 listed). Pictures are never written.
- The chat system prompt and guides come from PromptForge's own files, exported into the data pack by `tools/export-forge-pack.mjs`.

## Limits

- No rendering or picture editing from chat; make pictures in Studio's Generate (send a prompt there with **Send to Generate**).
- `write_prompt` covers the four image models; for H3, Wan and LTX, Chat explains their prompting from the guides but does not write those prompts.
- Small models may skip a tool and answer from memory; ask again ("read the LTX guide first") if an answer looks invented.

## Troubleshooting

- *"Chat needs an LLM server…"*: set an Ollama or OpenAI-compatible server under **Backend → LLM backend**.
- *"The LLM took too long to answer"*: the server may be loading the model or busy with another job; try again.
- Search says *"refused the JSON request (403)"*: enable JSON in SearXNG's `settings.yml`.
- Errors are also written to **Logs**.
