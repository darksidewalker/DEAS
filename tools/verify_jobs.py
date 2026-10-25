"""Diagnostic jobs: browser IPC fixtures only, not model/GPU generation acceptance."""
from pathlib import Path
import json
import sys
import hashlib
import struct
import zlib
from playwright.sync_api import sync_playwright
from deas_locale import set_locale

root = Path(__file__).resolve().parents[1]
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:1420'
# A genuine encoded test PNG, never a model-generated result.
def png_chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
png = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', 512, 512, 8, 2, 0, 0, 0)) + png_chunk(b'IDAT', zlib.compress((b'\x00' + bytes((206, 152, 117)) * 512) * 512)) + png_chunk(b'IEND', b'')
output_fixture = {'mimeType': 'image/png', 'width': 512, 'height': 512, 'sha256': hashlib.sha256(png).hexdigest(), 'bytes': list(png)}
fixture = r"""window.isTauri=true; window.__calls=[]; window.__jobState='queued';
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
if(command==='native_workbench_current')return {jobs:[],preparing:0,capacity:20,stopAvailable:false};
if(command==='native_media_list') return {path:'/fixture',parent:null,entries:[],truncated:false};
window.__calls.push({command,args});
if(command==='native_job_output') return {...window.__outputFixture,jobId:args.jobId,index:args.index};
if(command==='native_job_export') return window.__exportCancel?null:{path:'/fixture/exported-image.png',sha256:window.__outputFixture.sha256,size:window.__outputFixture.bytes.length};
if(command==='native_recipe_prerequisites') return {
baseUrl:args.baseUrl.replace(/\/$/,'')+'/',recipeId:'checkpoint-text-to-image-diagnostic',version:1,
allowlist:{nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage'],checkpoints:['fixture.safetensors'],samplers:['euler'],schedulers:['normal']},missingNodes:[],generationReady:false};
if(command==='native_job_prepare') return {id:'fixture-plan',baseUrl:args.baseUrl.replace(/\/$/,'')+'/',intent:args.intent,graph:JSON.parse(document.querySelector('[data-recipe-graph]').textContent).graph,generationReady:false};
if(command==='native_job_submit'||command==='native_job_status'||command==='native_job_current') return {id:'fixture-job',baseUrl:'http://127.0.0.1:7801/',promptId:'00000000-0000-4000-8000-000000000001',state:window.__jobState,outputs:window.__jobState==='succeeded'?[{filename:'fixture_00001_.png',subfolder:'',type:'output'}]:[],error:null,generationReady:false};
throw Error('Unexpected command '+command);
}};"""
results = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for width in (1440, 1024, 768, 390, 320):
        page = browser.new_page(viewport={'width': width, 'height': 960}, reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script('window.__outputFixture=' + json.dumps(output_fixture) + ';window.__exportCancel=true;')
        page.add_init_script(fixture)
        page.goto(url, wait_until='networkidle')
        set_locale(page, 'en')
        page.locator('[data-node="studio"]').click()
        page.locator('[data-studio-tab="map"]').click()
        page.locator('.run-plan-diagnostics > summary').click()
        page.locator('[data-node="engine"] > button').click()
        before_check = page.evaluate('__calls.length')
        assert not page.evaluate("__calls.some(c=>/^native_job_/.test(c.command))")
        page.locator('[data-recipe-check]').click()
        page.locator('[data-recipe-compile]').click()
        jobs = page.locator('[data-diagnostic-jobs]')
        jobs.wait_for()
        assert page.evaluate('__calls.length') == before_check + 1, 'Only the explicit prerequisite check may perform IPC; compile must not prepare or submit'
        jobs.locator('[data-job-prepare]').click()
        consent = jobs.locator('[data-job-consent]')
        consent.wait_for()
        assert not consent.is_checked()
        assert jobs.locator('[data-job-submit]').is_disabled()
        page.locator('#recipe-positive').fill('Changed before Run')
        assert jobs.locator('[data-job-submit]:enabled').count() == 0, 'Edit must invalidate native plan'
        page.locator('[data-recipe-compile]').click()
        jobs.locator('[data-job-prepare]').click()
        consent.wait_for()
        for locale in ('de', 'en', 'fr', 'ja', 'tr', 'zh'):
            set_locale(page, locale, '[data-node="studio"]')
            assert not consent.is_checked(), 'Locale changes cannot authorize a job'
            assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'), (width, locale)
        set_locale(page, 'en', '[data-node="studio"]')
        assert page.evaluate("__calls.filter(x=>x.command==='native_job_submit').length") == 0
        consent.check()
        jobs.locator('[data-job-submit]').click()
        page.wait_for_function("window.__calls.some(x=>x.command==='native_job_submit')")
        submitted = page.evaluate("__calls.filter(x=>x.command==='native_job_submit')")
        assert len(submitted) == 1 and submitted[0]['args'] == {'planId': 'fixture-plan', 'confirmed': True}
        page.evaluate("window.__jobState='running'")
        try:
            jobs.locator('[data-job-state][data-state="running"]').wait_for()
        except Exception:
            print(json.dumps({'width': width, 'calls': page.evaluate('__calls'), 'errors': errors, 'jobUI': jobs.text_content()}, ensure_ascii=False))
            raise
        page.locator('#endpoint').fill('http://127.0.0.1:9999')
        assert 'http://127.0.0.1:7801/' in jobs.text_content(), 'Active job must retain its original endpoint'
        page.evaluate("window.__jobState='succeeded'")
        jobs.locator('[data-job-state][data-state="succeeded"]').wait_for()
        assert 'fixture_00001_.png' in jobs.text_content()
        assert page.evaluate("__calls.filter(x=>x.command==='native_job_submit').length") == 1
        assert page.evaluate("__calls.filter(x=>x.command==='native_job_status').every(x=>JSON.stringify(x.args)===JSON.stringify({jobId:'fixture-job'}))")
        page.locator('[data-node="director"] > button').click()
        page.locator('[data-node="engine"] > button').click()
        jobs.locator('[data-job-recover]').click()
        jobs.locator('[data-job-state][data-state="succeeded"]').wait_for()
        assert page.evaluate("__calls.filter(x=>x.command==='native_job_current').length") == 1
        assert page.evaluate("__calls.filter(x=>x.command==='native_job_submit').length") == 1
        assert 'http://127.0.0.1:7801/' in jobs.text_content()
        assert page.evaluate("__calls.filter(x=>x.command==='native_job_output').length") == 0, 'Output fetch must be explicit'
        jobs.locator('[data-job-output-load="0"]').click()
        preview = jobs.locator('[data-job-output-preview]')
        preview.wait_for()
        page.wait_for_function("document.querySelector('[data-job-output-preview]')?.naturalWidth===512")
        assert preview.get_attribute('src').startswith('blob:'), 'Only local validated bytes supply preview'
        export = jobs.locator('[data-job-output-export]')
        export.click()
        page.wait_for_function("__calls.filter(x=>x.command==='native_job_export').length===1")
        assert jobs.locator('[data-job-output-exported]').count() == 0, 'Cancelled dialog is not success'
        page.evaluate('window.__exportCancel=false')
        export.click()
        jobs.locator('[data-job-output-exported]').wait_for()
        assert '/fixture/exported-image.png' in jobs.text_content()
        assert page.evaluate("__calls.filter(x=>x.command==='native_job_output').length") == 1
        assert page.evaluate("__calls.filter(x=>x.command==='native_job_export').every(x=>x.args.jobId==='fixture-job'&&x.args.index===0&&typeof x.args.title==='string'&&!('path' in x.args)&&!('bytes' in x.args))")
        for locale in ('de', 'en', 'fr', 'ja', 'tr', 'zh'):
            set_locale(page, locale, '[data-node="studio"]')
            assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'), (width, locale, 'completed')
        set_locale(page, 'en', '[data-node="studio"]')
        if width in (1440, 320):
            page.screenshot(path=str(root / f'assets/deas-jobs-fixture-{width}.png'), full_page=True)
        assert not errors, errors
        results.append({'width': width, 'sixLocales': True, 'explicitSubmission': True, 'immutableJob': True, 'IPCFixtureOnly': True})
        page.close()
    browser.close()
print(json.dumps(results, indent=2))
