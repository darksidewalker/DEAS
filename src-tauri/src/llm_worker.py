"""One request per managed process; exit releases the model and its GPU/CPU memory."""
import json
import math
import os
import sys

MAX_INPUT = 1024 * 1024
MAX_OUTPUT = 1024 * 1024


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
    from llama_cpp import Llama, llama_supports_gpu_offload
    layers = -1 if llama_supports_gpu_offload() else 0
    model = Llama(model_path=path, n_ctx=n_ctx, n_gpu_layers=layers, verbose=False)
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
