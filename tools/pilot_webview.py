#!/usr/bin/env python3
"""Drive a running DEAS desktop app from a script or an agent: read the page, click, type, take screenshots.

Linux / WebKitGTK only. The app must have been started with WebKitGTK's loopback inspector server:

    WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9333 ./src-tauri/target/debug/deas

Nothing in DEAS is changed or instrumented: this talks to the web view's own inspector protocol. A debug
build has the inspector on; a release build needs Tauri's devtools enabled. See docs/AGENT-PILOTING.md.

    uv run --no-project --with websockets python tools/pilot_webview.py targets
    ... pilot_webview.py text                      # the page's visible text
    ... pilot_webview.py eval '<js expression>'    # synchronous expression; the JSON value is printed
    ... pilot_webview.py click 'Run Plan' [index]  # a button, tab, summary, link, label or option by its exact text
    ... pilot_webview.py set 'Seed' 3302086038     # an input, select or textarea by the start of its label
    ... pilot_webview.py fill '#endpoint' http://127.0.0.1:8188   # the same by CSS selector
    ... pilot_webview.py shot out.png              # a PNG of the viewport

Options (before the command): --host 127.0.0.1:9333   --target /socket/1/2/WebPage (default: the first WebPage)
"""
import asyncio
import base64
import json
import re
import sys
import urllib.request

import websockets

CLICKABLE = "button,[role=tab],summary,a,label,option"
# React keeps its own copy of a field's value: set it through the element's native setter and fire the events.
SET_VALUE = """(e,v)=>{const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
Object.getOwnPropertyDescriptor(p,'value').set.call(e,v);
e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new Event('blur',{bubbles:true}));return e.value}"""


def targets(host):
    html = urllib.request.urlopen(f"http://{host}/", timeout=5).read().decode()
    return re.findall(r'targetname">(.*?)</div><div class="targeturl">(.*?)</div>.*?(/socket/\d+/\d+/\w+)', html, re.S)


class Page:
    async def open(self, host, path):
        self.ws = await websockets.connect(f"ws://{host}{path}", max_size=None)
        self.n, self.target = 0, None
        # A WebPage target wraps the page's protocol in Target.*; wait for the page target to be announced.
        try:
            while True:
                m = json.loads(await asyncio.wait_for(self.ws.recv(), 2))
                if m.get("method") == "Target.targetCreated" and m["params"]["targetInfo"]["type"] == "page":
                    self.target = m["params"]["targetInfo"]["targetId"]
                    break
        except asyncio.TimeoutError:
            pass
        return self

    async def call(self, method, params=None, timeout=60):
        self.n += 1
        inner = {"id": self.n, "method": method, "params": params or {}}
        if self.target:
            self.n += 1
            await self.ws.send(json.dumps({"id": self.n, "method": "Target.sendMessageToTarget",
                                           "params": {"targetId": self.target, "message": json.dumps(inner)}}))
        else:
            await self.ws.send(json.dumps(inner))
        while True:
            m = json.loads(await asyncio.wait_for(self.ws.recv(), timeout))
            if m.get("method") == "Target.dispatchMessageFromTarget":
                m = json.loads(m["params"]["message"])
            if m.get("id") == inner["id"]:
                return m

    async def eval(self, js):
        r = await self.call("Runtime.evaluate", {"expression": js, "returnByValue": True})
        res = r.get("result", {})
        if "error" in r or res.get("wasThrown"):
            return {"ERROR": r.get("error") or res.get("result")}
        return res.get("result", {}).get("value")

    async def shot(self, out):
        size = await self.eval("[innerWidth, innerHeight]")
        r = await self.call("Page.snapshotRect", {"x": 0, "y": 0, "width": size[0], "height": size[1],
                                                  "coordinateSystem": "Viewport"})
        with open(out, "wb") as f:
            f.write(base64.b64decode(r["result"]["dataURL"].split(",", 1)[1]))
        return {"saved": out, "size": size}


def script(command, args):
    q = json.dumps
    if command == "text":
        return "document.body.innerText"
    if command == "eval":
        return args[0]
    if command == "click":
        index = int(args[1]) if len(args) > 1 else 0
        return (f"(()=>{{const t={q(args[0])};const e=[...document.querySelectorAll({q(CLICKABLE)})]"
                ".filter(e=>e.textContent.trim()===t||e.getAttribute('aria-label')===t);"
                f"if(e.length<={index})return 'NOT FOUND: '+t+' ('+e.length+' matches)';e[{index}].click();"
                "return 'clicked 1 of '+e.length})()")
    if command == "set":
        return (f"(()=>{{const t={q(args[0])}.toLowerCase();const l=[...document.querySelectorAll('label')]"
                ".find(l=>l.textContent.trim().toLowerCase().startsWith(t));if(!l)return 'NO LABEL: '+t;"
                "const e=l.querySelector('input,select,textarea')||document.getElementById(l.htmlFor);"
                f"if(!e)return 'NO FIELD: '+t;return ({SET_VALUE})(e,{q(args[1])})}})()")
    if command == "fill":
        return (f"(()=>{{const e=document.querySelector({q(args[0])});if(!e)return 'NOT FOUND: '+{q(args[0])};"
                f"return ({SET_VALUE})(e,{q(args[1])})}})()")
    raise SystemExit(__doc__)


async def main(argv):
    host, target = "127.0.0.1:9333", None
    while argv and argv[0] in ("--host", "--target"):
        if argv[0] == "--host":
            host = argv[1]
        else:
            target = argv[1]
        argv = argv[2:]
    if not argv:
        raise SystemExit(__doc__)
    command, args = argv[0], argv[1:]
    found = targets(host)
    if command == "targets":
        print(json.dumps(found, indent=1))
        return
    target = target or next((path for _, _, path in found if path.endswith("WebPage")), None)
    if not target:
        raise SystemExit(f"no WebPage target on {host}: is the app running with WEBKIT_INSPECTOR_HTTP_SERVER={host}?")
    page = await Page().open(host, target)
    result = await (page.shot(args[0]) if command == "shot" else page.eval(script(command, args)))
    print(result if isinstance(result, str) else json.dumps(result, indent=1))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
