"""Offline adapter/auth/mutex race checks; optional read-only pinned PromptQueue source."""
import ast
import asyncio
import copy
import heapq
import json
import os
from pathlib import Path
import sys
import threading
import types
from typing import List, Literal, NamedTuple, Optional


class Queue:
    def __init__(self, server):
        self.mutex = threading.RLock()
        self.currently_running = {}
        self.queue = []

    def put(self, item):
        with self.mutex:
            self.queue.append(item)

    def get(self):
        with self.mutex:
            item = self.queue.pop(0)
            self.currently_running[0] = item
            return item, 0

    def task_done(self, key, result, status):
        with self.mutex:
            del self.currently_running[key]

    def get_current_queue(self):
        with self.mutex:
            return list(self.currently_running.values()), self.queue[:]


root = os.environ.get("DEAS_TEST_COMFY_SOURCE")
reset = None
if root:
    tree = ast.parse((Path(root) / "execution.py").read_text())
    queue_class = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "PromptQueue")
    namespace = dict(globals(), MAXIMUM_HISTORY_SIZE=10000)
    exec(compile(ast.Module(body=[queue_class], type_ignores=[]), "pinned-PromptQueue", "exec"), namespace)
    Queue = namespace["PromptQueue"]
    executor = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "PromptExecutor")
    execute = next(n for n in executor.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "execute_async")
    # Exercise the actual reset statement, not an invented successor contract.
    statement = execute.body[1]
    assert ast.unparse(statement) == "nodes.interrupt_processing(False)"
    reset = compile(ast.Module(body=[statement], type_ignores=[]), "pinned-reset", "exec")

server = types.SimpleNamespace(queue_updated=lambda: None)
queue = Queue(server)
server.prompt_queue = queue
server.routes = types.SimpleNamespace(post=lambda path: lambda fn: fn)
sys.modules["server"] = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=server))
sys.modules["aiohttp"] = types.SimpleNamespace(web=types.SimpleNamespace(Response=lambda status: types.SimpleNamespace(status=status)))
signals = []
started = threading.Event()
transitioned = threading.Event()
threads = []


def signal(value=True):
    if not value:
        signals.append((False, queue.get_current_queue()[0][0][1]))
        return

    def successor():
        started.set()
        queue.task_done(0, {}, None)
        queue.put([1, "foreign", {}, {"client_id": "foreign"}, []])
        queue.get()
        if reset:
            exec(reset, {"nodes": sys.modules["nodes"]})
        else:
            signal(False)
        transitioned.set()

    thread = threading.Thread(target=successor)
    threads.append(thread)
    thread.start()
    assert started.wait(2)
    # If the route releases the mutex before setting the flag, this worker can advance.
    assert not transitioned.wait(0.05), "foreign successor advanced before flag set"
    signals.append((True, queue.get_current_queue()[0][0][1]))


sys.modules["nodes"] = types.SimpleNamespace(interrupt_processing=signal)
os.environ["DEAS_RUNNING_INTERRUPT_TOKEN"] = "native-launch-secret"
namespace = {}
exec(compile(sys.argv[1], "running_interrupt.py", "exec"), namespace)
assert "DEAS_RUNNING_INTERRUPT_TOKEN" not in os.environ
handler = namespace["interrupt_running"]
graph = {"7": {"class_type": "SaveImage", "inputs": {"value": 1}}}
queue.put([0, "owned", graph, {"client_id": "client"}, ["7"]])
queue.get()


class Content:
    def __init__(self, body):
        self.body = body

    async def iter_chunked(self, size):
        for offset in range(0, len(self.body), size):
            yield self.body[offset:offset + size]


def request(body=None, token="native-launch-secret", origin=None):
    headers = {"X-DEAS-Interrupt-Token": token}
    if origin:
        headers["Origin"] = origin
    return types.SimpleNamespace(headers=headers, content_type="application/json", content=Content(body if body is not None else json.dumps({"prompt_id": "owned", "client_id": "client", "prompt": graph}).encode()))


async def check():
    for req, status in [(request(token=""), 403), (request(token="foreign"), 403),
                        (request(origin="http://localhost"), 403), (request(b"not-json"), 400),
                        (request(b"x" * (1024 * 1024 + 1)), 413), (request(b"{}"), 400)]:
        assert (await handler(req)).status == status
    for field, value in [("prompt_id", "foreign"), ("client_id", "foreign"), ("prompt", {"7": {}})]:
        data = {"prompt_id": "owned", "client_id": "client", "prompt": graph}
        data[field] = value
        assert (await handler(request(json.dumps(data).encode()))).status == 409
    for queued, requested in [(1, True), (0, False), (True, 1), (False, 0), (9007199254740992, 9007199254740993)]:
        graph["7"]["inputs"]["value"] = queued
        with queue.mutex:
            queue.get_current_queue()[0][0][2]["7"]["inputs"]["value"] = queued
        changed = copy.deepcopy(graph)
        changed["7"]["inputs"]["value"] = requested
        data = {"prompt_id": "owned", "client_id": "client", "prompt": changed}
        assert (await handler(request(json.dumps(data).encode()))).status == 409, (queued, requested)
    graph["7"]["inputs"]["value"] = 1
    with queue.mutex:
        queue.get_current_queue()[0][0][2]["7"]["inputs"]["value"] = 1
    assert not signals
    normalized = copy.deepcopy(graph)
    normalized["7"]["inputs"]["value"] = 1.0
    data = {"prompt_id": "owned", "client_id": "client", "prompt": normalized}
    assert (await handler(request(json.dumps(data).encode()))).status == 200
    for thread in threads:
        thread.join(2)
        assert not thread.is_alive()
    assert transitioned.is_set()
    assert signals == [(True, "owned"), (False, "foreign")], signals
    assert (await handler(request())).status == 409
    assert len(signals) == 2


asyncio.run(check())
print("scoped adapter: auth, bounds, exact correlation, locked transition and successor reset passed")
