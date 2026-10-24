"""DEAS-owned scoped interrupt adapter; core /interrupt is deliberately unused."""
import json
import logging
import os
import secrets

from aiohttp import web
import nodes
from server import PromptServer

_TOKEN = os.environ.pop("DEAS_RUNNING_INTERRUPT_TOKEN", "")


def same_json(left, right):
    """Allow ComfyUI's int-to-float normalization, never bool-to-number coercion."""
    if type(left) is not type(right):
        return type(left) in (int, float) and type(right) in (int, float) and left == right
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(same_json(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(same_json(a, b) for a, b in zip(left, right))
    return left == right


@PromptServer.instance.routes.post("/deas/jobs/interrupt")
async def interrupt_running(request):
    # Browser/editor calls are not native authority, even on this owned listener.
    if (not _TOKEN or not secrets.compare_digest(request.headers.get("X-DEAS-Interrupt-Token", "").encode("utf-8"), _TOKEN.encode("utf-8"))
            or request.headers.get("Origin") or request.content_type != "application/json"):
        return web.Response(status=403)
    body = bytearray()
    async for chunk in request.content.iter_chunked(65536):
        if len(body) + len(chunk) > 1024 * 1024:
            return web.Response(status=413)
        body.extend(chunk)
    try:
        data = json.loads(body)
    except (ValueError, UnicodeError):
        return web.Response(status=400)
    if (not isinstance(data, dict) or set(data) != {"prompt_id", "client_id", "prompt"}
            or not isinstance(data["prompt_id"], str) or not data["prompt_id"]
            or not isinstance(data["client_id"], str) or not data["client_id"]
            or not isinstance(data["prompt"], dict) or not data["prompt"]):
        return web.Response(status=400)
    queue = PromptServer.instance.prompt_queue
    # task_done/get share this lock; the next executor resets the flag before execution.
    with queue.mutex:
        running, _ = queue.get_current_queue()
        if (len(running) == 1 and running[0][1] == data["prompt_id"]
                and running[0][3].get("client_id") == data["client_id"]
                and same_json(running[0][2], data["prompt"])):
            nodes.interrupt_processing()
            logging.info("DEAS scoped running interruption signalled")
            return web.Response(status=200)
    return web.Response(status=409)


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
