"""One request per managed process, or one Prompt Forge write in `session` mode; exit releases the model and its GPU/CPU memory."""
import json
import math
import os
import sys

MAX_INPUT = 1024 * 1024
MAX_OUTPUT = 1024 * 1024
SESSION_INPUT = 4 * 1024 * 1024
SESSION_CONTEXTS = (32768, 16384, 8192)


def load_llama():
    if os.name == "nt":
        # The CUDA wheel cannot find its runtime DLLs until torch has loaded them.
        try:
            import torch  # noqa: F401
        except ImportError:
            pass
    import llama_cpp
    return llama_cpp


def thinking_off(llama_cpp, model):
    """Prompt rewrites gain nothing from reasoning; templates that ask get told no."""
    template = model.metadata.get("tokenizer.chat_template")
    if not template or "enable_thinking" not in template:
        return
    eos = model.token_eos()
    model.chat_handler = llama_cpp.llama_chat_format.Jinja2ChatFormatter(
        template="{%- set enable_thinking = false -%}" + template,
        eos_token=model.detokenize([eos], special=True).decode("utf-8", "ignore"),
        bos_token=model.detokenize([model.token_bos()], special=True).decode("utf-8", "ignore"),
        stop_token_ids=[eos],
    ).to_chat_handler()


def open_model(llama_cpp, path):
    """The largest context that fits: a smaller card still gets a working, shorter one."""
    layers = -1 if llama_cpp.llama_supports_gpu_offload() else 0
    for n_ctx in SESSION_CONTEXTS:
        try:
            model = llama_cpp.Llama(model_path=path, n_ctx=n_ctx, n_gpu_layers=layers, verbose=False)
            break
        except Exception:
            if n_ctx == SESSION_CONTEXTS[-1]:
                raise
    try:
        thinking_off(llama_cpp, model)
    except Exception:
        pass  # A model that keeps thinking is slower, not broken; the reply parser drops it.
    return model


def session_round(model, request):
    messages, tools = request["messages"], request.get("tools")
    if not isinstance(messages, list) or not messages or (tools is not None and not isinstance(tools, list)):
        raise ValueError("Invalid messages")
    # The wire shape is a JSON string; chat templates walk an object.
    for message in messages:
        for call in message.get("tool_calls") or []:
            call["function"]["arguments"] = json.loads(call["function"]["arguments"] or "{}")
    options = {key: request[key] for key in ("temperature", "top_p", "max_tokens") if request.get(key) is not None}
    if tools:
        options.update(tools=tools, tool_choice="auto")
    result = model.create_chat_completion(messages=messages, stream=False, **options)["choices"][0]
    return {"text": result["message"].get("content") or "", "finish": result.get("finish_reason")}


def serve():
    """One JSON line in, one out, until stdin closes. The first line names the model."""
    protocol = os.fdopen(os.dup(1), "wb")
    # Native libraries may print to fd 1 even with verbose=False; reserve stdout for JSON.
    os.dup2(2, 1)
    model = None
    try:
        while True:
            line = sys.stdin.buffer.readline(SESSION_INPUT + 1)
            if not line:
                return 0
            if len(line) > SESSION_INPUT:
                raise ValueError("Request too large")
            request = json.loads(line)
            try:
                if model is None:
                    path = request["modelPath"]
                    if not isinstance(path, str) or not os.path.isabs(path) or not path.lower().endswith(".gguf") or not os.path.isfile(path):
                        raise ValueError("Invalid model")
                    stage = "runtime"
                    llama_cpp = load_llama()
                    stage = "load"
                    model = open_model(llama_cpp, path)
                    reply = {"ready": True}
                else:
                    stage = "failed"
                    reply = session_round(model, request)
            except Exception as error:
                # Never expose exception text: tokenizer/model errors can contain the user's prompt.
                reply = {"error": "context" if "exceed context" in str(error) else stage}
            protocol.write(json.dumps(reply, ensure_ascii=True).encode("utf-8") + b"\n")
            protocol.flush()
    finally:
        if model is not None:
            model.close()


def generate(payload):
    request = payload["request"]
    path = payload["modelPath"]
    if not isinstance(path, str) or not os.path.isabs(path) or not path.lower().endswith(".gguf") or not os.path.isfile(path):
        raise ValueError("Invalid model")
    n_ctx = 4096
    tokens, temperature = request["maxTokens"], request["temperature"]
    if type(tokens) is not int or not 1 <= tokens < n_ctx:
        raise ValueError("Invalid token budget")
    if type(temperature) not in (int, float) or not math.isfinite(temperature) or not 0 <= temperature <= 2:
        raise ValueError("Invalid temperature")
    system, prompt = request["system"], request["prompt"]
    if not isinstance(system, str) or not isinstance(prompt, str) or not prompt.strip() or "\0" in system + prompt or len((system + prompt).encode("utf-8")) > 128 * 1024:
        raise ValueError("Invalid prompt")
    llama_cpp = load_llama()
    layers = -1 if llama_cpp.llama_supports_gpu_offload() else 0
    model = llama_cpp.Llama(model_path=path, n_ctx=n_ctx, n_gpu_layers=layers, verbose=False)
    try:
        result = model.create_chat_completion(
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            max_tokens=tokens, temperature=temperature, stream=False,
        )
        text = result["choices"][0]["message"]["content"]
        if not isinstance(text, str) or not text.strip() or "\0" in text or len(text.encode("utf-8")) > MAX_OUTPUT:
            raise ValueError("Invalid model response")
        return {"text": text}
    finally:
        model.close()


def main():
    try:
        if sys.argv[1:] == ["session"]:
            return serve()
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ValueError("Request too large")
        payload = json.loads(raw)
        # Native libraries may print to fd 1 even with verbose=False; reserve stdout for JSON.
        output = os.dup(1)
        try:
            os.dup2(2, 1)
            result = generate(payload)
            encoded = json.dumps(result, ensure_ascii=True).encode("utf-8")
            if len(encoded) > MAX_OUTPUT:
                raise ValueError("Response too large")
            with os.fdopen(os.dup(output), "wb") as protocol:
                protocol.write(encoded)
        finally:
            os.close(output)
    except Exception:
        # Never expose exception text: tokenizer/model errors can contain the user's prompt.
        sys.stderr.write("Local LLM worker failed\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
