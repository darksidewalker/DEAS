"""Comfy tab browser acceptance: mocked DEAS IPC, optional read-only real ComfyUI frontend."""
import argparse
import json
import re
from itertools import product
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('url', nargs='?', default='http://127.0.0.1:4287')
parser.add_argument('--comfy-url', help='Already running loopback ComfyUI; never starts or submits jobs')
parser.add_argument('--screenshot', type=Path)
parser.add_argument('--workflow', action='store_true', help='Test metadata import with the native bridge injected by Playwright (no generation)')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
endpoint = args.comfy_url or 'http://127.0.0.1:49312'
csp = json.loads((root / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['app']['security']['csp']
fixture = r"""
(() => {
if(window.top!==window.self)return;
localStorage.setItem('deas.locale.v1',LOCALE);
localStorage.setItem('deas.pref.install.root',JSON.stringify('/fixture/env'));
window.isTauri=true;window.__CALLS__=[];window.__BACKENDSTATE__='starting';
window.__TAURI_INTERNALS__={convertFileSrc:p=>'asset://localhost/'+encodeURIComponent(p),invoke:async(c,a)=>{
 window.__CALLS__.push(c);
 if(c==='native_files_present')return [true];
 if(c==='native_install_plan')return {id:'reopen',reopenId:'checked',request:{storagePath:'/fixture/env',backend:'cpu',features:[],options:{sage:false,radial:false,flash:false,ffmpeg:false},comfyRef:'master'},steps:[],warnings:[],unsupportedOptions:[],canExecute:true};
 if(c==='native_install_open')return {state:'succeeded',logs:[],error:null};
 if(c==='native_settings_read')return {};
 if(c==='native_install_defaults')return {storagePath:'/fixture/env',backend:'cpu',warnings:[]};
 if(c==='native_llm_read')return {provider:'local',baseUrl:'http://127.0.0.1:11434'};
 if(c==='native_llm_models')return {models:[],warnings:[]};
 if(c==='native_startup_read')return {startup:{preset:'off',flags:[],fast:[]},packages:[],presets:{speed:{flags:[],fast:[]},compatibility:{flags:[],fast:[]},off:{flags:[],fast:[]}}};
 if(c==='native_backend_status')return {state:window.__BACKENDSTATE__,endpoint:window.__BACKENDSTATE__==='running'?ENDPOINT:null,logs:[],error:null,generationReady:false};
 if(c==='native_media_list')return {path:'/fixture',parent:null,entries:[],truncated:false};
 if(c==='native_auth_status')return [];
 if(c==='native_models_scan')return [];
 if(c==='native_job_current')return null;
 if(c==='native_download_catalog')return {version:1,providers:[],entries:[]};
 throw Error('Unexpected fixture IPC '+c);
}};
})();
"""
workflow = {'last_node_id': 1, 'last_link_id': 0, 'nodes': [{'id': 1, 'type': 'CLIPTextEncode', 'pos': [100, 100], 'size': [400, 200], 'flags': {}, 'order': 0, 'mode': 0, 'inputs': [{'name': 'clip', 'type': 'CLIP', 'link': None}], 'outputs': [{'name': 'CONDITIONING', 'type': 'CONDITIONING', 'links': None}], 'properties': {}, 'widgets_values': ['DEAS workflow handoff verified']}], 'links': [], 'groups': [], 'config': {}, 'extra': {}, 'version': 0.4}
if args.workflow:
    fixture = fixture.replace("if(c==='native_media_list')return {path:'/fixture',parent:null,entries:[],truncated:false};", "if(c==='native_media_list')return {path:'/fixture',parent:null,entries:[{path:'/fixture/workflow.png',name:'workflow.png',kind:'file',media:'image',size:1,modified:1,symlink:false}],truncated:false};if(c==='native_media_metadata')return [['workflow'," + json.dumps(json.dumps(workflow)) + "]];if(c==='native_media_thumbnail')return '/fixture/workflow.png';")
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    cases = [(1440, 'en')] if args.comfy_url else product((1440, 1024, 768, 390, 320), ('de', 'en', 'fr', 'ja', 'tr', 'zh'))
    for width, locale in cases:
        page = browser.new_page(viewport={'width': width, 'height': 960}, reduced_motion='reduce')
        page.context.grant_permissions(['local-network-access'], origin=args.url)
        requests = []
        page.on('response', lambda r: requests.append((r.status, r.url)) if r.url.startswith(endpoint) else None)
        page.on('requestfailed', lambda r: requests.append((r.failure, r.url)))
        errors = []
        console_errors = []
        page.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        if args.workflow:
            page.add_init_script('const DEAS_DEV_ORIGIN = '+json.dumps(args.url)+';\n'+(root/'src-tauri/src/comfy_bridge.js').read_text(encoding='utf-8'))
        page.add_init_script(fixture.replace('LOCALE', json.dumps(locale)).replace('ENDPOINT', json.dumps(endpoint)))
        def serve_app(route):
            response = route.fetch()
            route.fulfill(response=response, headers={**response.headers, 'content-security-policy': csp})
        page.route(args.url.rstrip('/') + '/', serve_app)
        if not args.comfy_url:
            page.route(endpoint + '/**', lambda route: route.fulfill(content_type='text/html', body='<title>Comfy fixture</title><input id="workflow" aria-label="Workflow" value="draft"><canvas></canvas>'))
        else:
            # Real frontend load only: block HTTP writes including any attempt to queue a job.
            page.route(endpoint + '/**', lambda route: route.continue_() if route.request.method in ('GET', 'HEAD', 'OPTIONS') else route.abort())
        page.goto(args.url, wait_until='domcontentloaded')
        page.wait_for_function("()=>__CALLS__.includes('native_backend_status')")
        labels = json.loads((root / 'src/components/setup/locales' / f'{locale}.json').read_text(encoding='utf-8'))
        page.locator('[data-node="settings"]').click()
        page.locator('[data-backend-state]').filter(has_text=labels['setup.backendStarting']).wait_for()
        page.locator('[data-node="comfy"]').click()
        assert page.locator('.comfy-loading .aio-spinner').is_visible()
        assert page.locator('.comfy-loading').inner_text() == labels['setup.comfy.waiting']
        page.evaluate("()=>{window.__BACKENDSTATE__='running'}")
        editor = page.frame_locator('.comfy-view iframe')
        try:
            editor.locator('canvas').first.wait_for(timeout=45000)
            if args.comfy_url:
                editor.get_by_text('Run', exact=True).first.wait_for(timeout=45000)
        except Exception:
            if args.screenshot:
                args.screenshot.parent.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(args.screenshot))
            print({'errors': errors, 'console': console_errors, 'requests': requests[-30:], 'frames': [f.url for f in page.frames], 'frameText': editor.locator('body').inner_text()[:4000]})
            raise
        page.locator('.comfy-loading').wait_for(state='hidden')
        if args.workflow:
            assert args.comfy_url, '--workflow requires a real ComfyUI frontend'
            frame_obj = page.locator('.comfy-view iframe').element_handle().content_frame()
            frame_obj.evaluate("async()=>{const {app}=await import('/scripts/app.js');await app.loadGraphData({nodes:[],links:[],version:0.4},true,true,'DEAS previous draft')}")
            page.locator('[data-node="studio"]').click()
            page.locator('[data-dock-tab="media"]').click()
            page.locator('.media-list button[title="workflow.png"]').click()
            meta = json.loads((root/'src/features/studio/locales'/f'{locale}.json').read_text(encoding='utf-8'))
            page.get_by_role('button',name=meta['studio.run.metadata.workflow'],exact=True).click()
            page.wait_for_function("()=>document.querySelector('[data-node=comfy]').getAttribute('aria-selected')==='true'")
            frame_obj.wait_for_function("async()=>{const {app}=await import('/scripts/app.js');return app.graph._nodes.some(n=>n.widgets?.some(w=>w.value==='DEAS workflow handoff verified'))}",timeout=30000)
            # Reimport the same file after editing: the first imported draft must survive too.
            first_name = editor.get_by_text(re.compile(r'^DEAS workflow\.png \(')).first.inner_text()
            frame_obj.evaluate("async()=>{const {app}=await import('/scripts/app.js');app.graph._nodes[0].widgets[0].value='DEAS edited import retained';app.graph.change()}")
            page.locator('[data-node="studio"]').click()
            page.get_by_role('button',name=meta['studio.run.metadata.workflow'],exact=True).click()
            frame_obj.wait_for_function("async()=>{const {app}=await import('/scripts/app.js');return app.graph._nodes.some(n=>n.widgets?.some(w=>w.value==='DEAS workflow handoff verified'))}",timeout=30000)
            editor.get_by_text(first_name,exact=True).first.click()
            assert frame_obj.evaluate("async()=>{const {app}=await import('/scripts/app.js');return app.graph._nodes[0].widgets[0].value}") == 'DEAS edited import retained'
            # A distinct tab preserves the previous unsaved graph, rather than replacing it.
            assert 'DEAS previous draft' in editor.locator('body').inner_text()
            editor.get_by_text('DEAS previous draft',exact=True).first.click()
            assert frame_obj.evaluate("async()=>{const {app}=await import('/scripts/app.js');return app.graph._nodes.length}") == 0
            page.locator('[data-node="studio"]').click()
            page.get_by_role('button',name=meta['studio.run.metadata.workflow'],exact=True).wait_for(state='visible')
            assert not page.get_by_role('alert').count()
            page.locator('[data-node="comfy"]').click()
        assert not page.locator('.aio-setup-header').is_visible()
        assert not page.locator('.studio-workspace').is_visible()
        assert page.locator('.footer').is_visible()
        assert page.locator('.aio-tabs').is_visible()
        frame_box = page.locator('.comfy-view iframe').bounding_box()
        footer_box = page.locator('.footer').bounding_box()
        assert frame_box['height'] > 700, frame_box
        assert frame_box['y'] + frame_box['height'] <= 958
        assert footer_box['y'] + footer_box['height'] <= 961, footer_box
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight')
        frame = page.locator('.comfy-view iframe').element_handle()
        if not args.comfy_url:
            editor.get_by_label('Workflow').fill('unsaved workflow')
        page.locator('[data-node="optional-downloads"]').click()
        page.locator('[data-node="settings"]').click()
        assert labels['setup.backendStarted'] in page.locator('[data-backend-state]').inner_text()
        assert not page.locator('.comfy-view').is_visible()
        page.locator('[data-node="comfy"]').click()
        assert page.evaluate('(old)=>old===document.querySelector(".comfy-view iframe")', frame)
        if not args.comfy_url:
            assert editor.get_by_label('Workflow').input_value() == 'unsaved workflow'
        assert not page.evaluate("__CALLS__.some(c=>c==='native_backend_start'||c==='native_backend_stop'||c==='native_install_start')")
        assert not errors, errors
        if args.comfy_url:
            editor.get_by_text('Run', exact=True).first.wait_for(timeout=45000)
            assert any(status == 200 and '/extensions/ComfyUI-DaSiWa-Nodes/' in url for status, url in requests), requests
        if args.screenshot and width == 1440 and locale == 'en':
            args.screenshot.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(args.screenshot))
        results.append({'width': width, 'locale': locale, 'editor': 'live read-only' if args.comfy_url else 'HTTP fixture', 'footerVisible': True, 'workflowRetained': True})
        page.close()
    browser.close()
print(json.dumps(results, indent=2))
