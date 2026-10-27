"""Recent-history desktop/narrow interaction with strict simulated IPC; no backend.

Run against an existing Vite server: python tools/verify_jobs_history.py URL
Uses the installed Playwright/browser only. It never installs, submits or writes media.
"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

FIXTURE = r"""
window.isTauri=true;
window.__historyFixture={calls:[],unexpected:[]};
const f=window.__historyFixture,clone=x=>structuredClone(x);
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO8+e7HfwAJHgPpUpmX6wAAAABJRU5ErkJggg==';
const intent={recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:'Historical forest 猫',negativePrompt:'historic blur',checkpoint:'a.safetensors',seed:987654321,width:1216,height:832,steps:17,cfg:4.25,sampler:'euler',scheduler:'normal',outputPrefix:'raw/history/exact',loras:[{name:'style.safetensors',strength:.75}],imageReference:{visionModel:'vision.safetensors',images:[{image:'second.png',strength:.2},{image:'first.png',strength:.9}]}};
const row=(id,n)=>({id,clientId:'c-'+id,promptId:'p-'+id,origin:n===9?'diagnostic':'studio',appVersion:'0.1.48',admittedAt:1700000000000+n,observedAt:1700000001000+n,revision:2,state:n===9?'unknown':'failed',intent:clone(intent),outputs:[{filename:'found.png',subfolder:'raw',type:'output'},{filename:'missing.png',subfolder:'raw',type:'output'}],outputRoot:'/env/ComfyUI/output',outputRootIdentity:'fixture',backendOrigin:'http://127.0.0.1:7801',error:null});
f.records=Array.from({length:10},(_,n)=>row(n===0?'current-job':'attempt-'+n,n));
f.records[9].intent={...clone(intent),inputImage:'missing-input.png',inputMask:'deas-masks/missing.png'};
f.job={id:'current-job',baseUrl:'http://127.0.0.1:7801/',promptId:'p-current',state:'failed',outputs:[],intent:{...clone(intent),positivePrompt:'Immutable queue prompt'},error:null,generationReady:false};
const fail=message=>{f.unexpected.push(message);throw Error(message);};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},convertFileSrc:()=>png,invoke:async(command,args)=>{
 f.calls.push({command,args:clone(args??{})});
 if(command==='native_workbench_current')return clone({jobs:[f.job],preparing:0,capacity:20,stopAvailable:true,admissionEpoch:0,stopping:false});
 if(command==='native_jobs_history'){
  if(Object.keys(args??{}).length)return fail('history takes no path or endpoint');
  return clone({schemaVersion:1,records:f.records,readOnly:false,error:null});
 }
 if(command==='native_jobs_history_outputs'){
  if(Object.keys(args??{}).join(',')!=='jobId'||!f.records.some(r=>r.id===args.jobId))return fail('availability identity only');
  return ['available','missing'];
 }
 if(command==='native_models_scan')return [{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null},{category:'loras',name:'style.safetensors',family:'sdxl',path:'/m/lora',size:1,info:null}];
 if(command==='native_recipe_prerequisites')return {baseUrl:'http://127.0.0.1:7801/',recipeId:'checkpoint-text-to-image-diagnostic',version:1,missingNodes:[],generationReady:false,allowlist:{nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage','CLIPVisionLoader','LoadImage','CLIPVisionEncode','unCLIPConditioning'],checkpoints:['a.safetensors'],loras:['style.safetensors'],samplers:['euler'],schedulers:['normal'],visionModels:['vision.safetensors'],images:['first.png','second.png']}};
 if(command==='native_media_list')return {path:args.path,parent:null,entries:[],truncated:false};
 if(command==='plugin:event|listen'||command==='plugin:event|unlisten'||command==='native_project_close_notice')return 1;
 return fail('Unexpected command '+command);
}};
localStorage.setItem('deas.locale.v1','en');
"""


def interaction(browser, url, width, screenshots=None):
    context = browser.new_context(viewport={'width': width, 'height': 960}, reduced_motion='reduce')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    origin = urlparse(url).netloc
    def route(request):
        target = urlparse(request.request.url)
        if target.scheme in ('http', 'https') and target.netloc != origin:
            errors.append('Unexpected network '+request.request.url)
            request.abort()
        else:
            request.continue_()
    page.route('**/*', route)
    page.add_init_script(FIXTURE)
    try:
        page.goto(url.rstrip('/')+'/tools/inpaint-fixture.html', wait_until='networkidle')
        expect(page.locator('[data-workbench]')).to_be_visible()
        expect(page.locator('[data-job-id="current-job"]')).to_be_visible()
        probes = page.evaluate('__historyFixture.calls.filter(c=>c.command==="native_recipe_prerequisites").length')
        page.locator('[data-history-toggle]').click()
        expect(page.locator('[data-history-id]')).to_have_count(10)
        expect(page.locator('[data-job-id="current-job"]')).to_be_hidden()
        page.locator('[data-history-id="current-job"]').click()
        expect(page.get_by_text('Also in current queue', exact=True)).to_be_visible()
        page.get_by_role('button', name='Check files in selected environment').click()
        expect(page.get_by_text('Available in selected environment', exact=True)).to_be_visible()
        expect(page.get_by_text('Missing from selected environment', exact=True)).to_be_visible()
        page.locator('[data-history-restore]').click()
        expect(page.locator('[data-history-confirm]')).to_contain_text('replaces current authoring')
        expect(page.locator('[data-history-confirm]')).to_contain_text('Historical filenames do not prove original media')
        expect(page.locator('[data-history-confirm]')).to_contain_text('input: second.png')
        expect(page.locator('[data-history-confirm]')).to_contain_text('input: first.png')
        if screenshots:
            page.screenshot(path=str(screenshots / ('history-'+str(width)+'.png')), full_page=True)
        page.locator('[data-history-apply]').click()
        page.locator('[data-history-close]').click()
        expect(page.locator('[data-run-positive]')).to_have_value('Historical forest 猫')
        expect(page.get_by_role('spinbutton', name='Seed', exact=True)).to_have_value('987654321')
        expect(page.get_by_role('button', name='Fixed', exact=True)).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('[data-reference-controls]')).to_have_count(2)
        expect(page.locator('[data-reference-controls] img')).to_have_count(0)
        expect(page.locator('[data-run]')).to_be_disabled()
        if screenshots:
            page.screenshot(path=str(screenshots / ('history-inputs-'+str(width)+'.png')), full_page=True)
        # Deliberate Media drops replace individual unresolved cards, retaining
        # their original slots and ReVision strengths. No file is auto-resolved.
        page.evaluate("""() => ['second.png','first.png'].forEach((name,index)=>{
            const transfer=new DataTransfer();
            transfer.setData('application/x-deas-media',JSON.stringify({name,path:'/env/ComfyUI/input/'+name,media:'image',src:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO8+e7HfwAJHgPpUpmX6wAAAABJRU5ErkJggg=='}));
            document.querySelectorAll('[data-reference-controls]')[index].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
        })""")
        expect(page.locator('[data-reference-controls] img')).to_have_count(2)
        expect(page.locator('[data-reference-controls]').nth(0).locator('img')).to_have_attribute('alt','second.png')
        expect(page.locator('[data-reference-controls]').nth(1).locator('img')).to_have_attribute('alt','first.png')
        expect(page.locator('[data-reference-controls]').nth(0).locator('input[type="number"]')).to_have_value('0.2')
        expect(page.locator('[data-reference-controls]').nth(1).locator('input[type="number"]')).to_have_value('0.9')
        expect(page.locator('[data-run]')).to_be_enabled()
        expect(page.locator('[data-job-id="current-job"]')).to_be_visible()
        assert page.evaluate('__historyFixture.job.intent.positivePrompt') == 'Immutable queue prompt'
        assert page.evaluate('__historyFixture.calls.filter(c=>c.command==="native_recipe_prerequisites").length') == probes
        page.locator('[data-history-toggle]').click()
        page.locator('[data-history-id="attempt-9"]').click()
        expect(page.locator('[data-history-details]')).to_contain_text('not a recovered live job')
        page.locator('[data-history-restore]').click()
        expect(page.locator('[data-history-confirm]')).to_contain_text('inputMask')
        page.locator('[data-history-apply]').click()
        page.keyboard.press('Escape')
        expect(page.locator('[data-history-panel]')).to_have_count(0)
        expect(page.locator('[data-run]')).to_be_disabled()
        expect(page.locator('[data-history-draft]')).to_contain_text('missing-input.png')
        assert page.evaluate('__historyFixture.unexpected') == [], page.evaluate('__historyFixture.unexpected')
        forbidden = ['native_workbench_run','native_workbench_stop','native_job_prepare','native_job_submit','native_input_upload','native_mask_upload','native_backend_start','native_backend_stop']
        assert page.evaluate('(names)=>__historyFixture.calls.filter(c=>names.includes(c.command))', forbidden) == []
        assert not errors, errors
        return {'width': width, 'rows': 10, 'settings_restore': True, 'partial_gate': True, 'network_and_execution': 'none'}
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('url')
    parser.add_argument('--screenshots', type=Path, help='Optional screenshot directory; no files are written by default')
    args = parser.parse_args()
    parsed = urlparse(args.url)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('an existing HTTP loopback Vite URL is required')
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            results = [interaction(browser, args.url, width, args.screenshots) for width in (1440, 390)]
        finally:
            browser.close()
    print(json.dumps({'passed': len(results), 'kind': 'Chromium simulated native IPC only', 'cases': results}))


if __name__ == '__main__':
    main()
