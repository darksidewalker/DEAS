"""Q2c2 actual-App DOM acceptance with strict simulated native IPC, never real services.

  python tools/verify_workbench_run_stop.py --selfcheck
  python tools/verify_workbench_run_stop.py http://127.0.0.1:PORT

Requires an existing loopback Vite server and installed Playwright/Chromium. No installs,
backend calls, repository screenshots, source edits, or native acceptance are performed.
"""
import argparse
import json
from pathlib import Path
import signal
import subprocess
import tempfile
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

LOCALES = ('de', 'en', 'fr', 'ja', 'tr', 'zh')
BROWSER_CASES = 18  # recovery, fixed, random, settled, partial, unreachable + 12 layouts
FIXTURE = r"""
window.isTauri=true;
const clone=x=>structuredClone(x);
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO8+e7HfwAJHgPpUpmX6wAAAABJRU5ErkJggg==';
const f=window.__runstop={calls:[],unexpected:[],mutations:[],jobs:[],epoch:0,stopping:false,
 mode:'settled',holdStop:false,holdRun:false,attempted:[],foreign:{id:'not-owned',state:'running'}};
const intent=seed=>({recipeId:'checkpoint-text-to-image-diagnostic',version:1,
 positivePrompt:'Recovered immutable prompt',negativePrompt:'Recovered negative',
 checkpoint:'sdxl/fresh.safetensors',seed,width:768,height:512,steps:17,cfg:4.5,
 sampler:'euler',scheduler:'normal',outputPrefix:'held'});
const job=(id,state,seed)=>({id,baseUrl:'http://127.0.0.1:7801/',promptId:'prompt-'+id,
 intent:freeze(intent(seed)),appVersion:'0.1.45',metadata:{startedAt:1700000000000,
 generationMs:state==='succeeded'?13310:null},state,outputs:state==='succeeded'?
 [{filename:'preserved.png',subfolder:'original',type:'output'}]:[],error:null,generationReady:false});
f.recover=mode=>{f.mode=mode;f.jobs=[job('queued01-held','queued',1),job('running2-held','running',2),
 job('success4-held','succeeded',4)];if(mode==='partial'){
 const j=job('unknown3-source','unknown',3);j.error='Source partial: ownership not established';f.jobs.push(j);}};
const snapshot=()=>clone({jobs:f.jobs,preparing:0,capacity:20,stopAvailable:true,
 admissionEpoch:f.epoch,stopping:f.stopping});
const fail=message=>{f.unexpected.push(message);throw Error(message);};
const keys=(args,names)=>Object.keys(args).sort().join(',')===names.sort().join(',');
window.__TAURI_INTERNALS__={convertFileSrc:()=>png,invoke:async(command,input)=>{
 const args=input??{};f.calls.push({command,args:clone(args)});
 if(command==='native_workbench_current'||command==='native_workbench_poll'){
  if(!keys(args,[]))return fail('collection read must have no arguments');return snapshot();}
 if(command==='native_workbench_run'){
  if(!keys(args,['baseUrl','intent','confirmed','admissionEpoch'])||args.confirmed!==true||
    args.baseUrl!=='http://127.0.0.1:7801'||!args.intent?.positivePrompt||
    !Number.isSafeInteger(args.intent.seed)||args.intent.seed<0)return fail('invalid Run payload');
  if(f.holdRun)await new Promise(resolve=>f.releaseRun=resolve);
  if(args.admissionEpoch!==f.epoch||f.stopping)throw Error('Stale admission epoch: explicit Run required');
  if(f.jobs.filter(j=>['queued','running','unknown'].includes(j.state)).length>=20)throw Error('Capacity');
  const j=job('run-'+(f.jobs.length+1),'queued',args.intent.seed);j.intent=freeze(clone(args.intent));
  f.jobs.push(j);return clone(j);
 }
 if(command==='native_workbench_stop'){
  if(!keys(args,['confirmed'])||args.confirmed!==true)return fail('invalid Stop payload');
  f.epoch++;f.stopping=true;
  if(f.holdStop)await new Promise(resolve=>f.releaseStop=resolve);
  const issues=[];let active=0;
  for(const j of f.jobs){if(!['queued','running','unknown'].includes(j.state))continue;active++;
   if(!f.attempted.includes(j.id)){f.attempted.push(j.id);f.mutations.push({jobId:j.id,operation:'scoped-stop'});}
   if(f.mode==='unreachable'||j.state==='unknown'){
    issues.push({jobId:j.id,error:f.mode==='unreachable'?'Endpoint unreachable':'Source ownership unresolved'});
   }else j.state='cancelled';
  }
  f.stopping=false;return {...snapshot(),outcome:issues.length?'partial':active?'settled':'empty',discarded:0,issues};
 }
 if(command==='native_job_output'){
  if(!keys(args,['jobId','index']))return fail('invalid output args');
  const j=f.jobs.find(j=>j.id===args.jobId);
  if(!j||j.state!=='succeeded'||!j.outputs[args.index])return fail('invalid output owner/index');
  return {jobId:j.id,index:args.index,mimeType:'image/png',width:1,height:1,sha256:'0'.repeat(64),
   bytes:Array.from(atob(png.split(',')[1]),c=>c.charCodeAt(0))};
 }
 if(command==='native_recipe_prerequisites')return {baseUrl:args.baseUrl.replace(/\/$/,'')+'/',
 recipeId:'checkpoint-text-to-image-diagnostic',version:1,allowlist:{nodes:['CheckpointLoaderSimple',
 'CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage'],checkpoints:['sdxl/fresh.safetensors'],
 loras:[],samplers:['euler'],schedulers:['normal']},missingNodes:[],generationReady:false};
 if(command==='native_media_star_status')return {starred:false,unavailable:null};
 if(command==='native_media_list')return {path:args.path||'/fixture-unused',parent:null,entries:[],truncated:false};
 if(command==='native_install_plan')return {id:'fixture-plan',request:args.request,steps:[],warnings:[],unsupportedOptions:[],canExecute:true};
 if(command==='native_auth_status')return [];
 if(command==='native_update_check')return {app:null,comfy:false,nodepack:false};
 if(command==='native_repo_stars')return {count:0,starred:null};
 if(command==='native_install_defaults')return {storagePath:'/fixture-unused',backend:'cpu',warnings:[]};
 return fail('Unexpected command '+command);
}};
"""


def selfcheck():
    # Exercise the exact browser fixture rather than a Python reimplementation of its race.
    script = 'global.window=global;\n' + FIXTURE + r"""
(async()=>{
 const assert=require('node:assert/strict'),invoke=__TAURI_INTERNALS__.invoke;
 assert.equal((await invoke('native_workbench_current')).admissionEpoch,0);
 f.holdRun=true;
 const delayed=invoke('native_workbench_run',{baseUrl:'http://127.0.0.1:7801',
  intent:intent(42),confirmed:true,admissionEpoch:0});
 assert.equal((await invoke('native_workbench_stop',{confirmed:true})).outcome,'empty');
 f.releaseRun();await assert.rejects(delayed,/Stale admission epoch/);assert.equal(f.jobs.length,0);
 f.holdRun=false;f.recover('settled');const done=clone(f.jobs[2]);
 const stop=await invoke('native_workbench_stop',{confirmed:true});assert.equal(stop.outcome,'settled');
 assert.deepEqual(f.jobs[2],done);assert.deepEqual(f.foreign,{id:'not-owned',state:'running'});
 f.recover('partial');const partial=await invoke('native_workbench_stop',{confirmed:true});
 assert.equal(partial.outcome,'partial');assert.equal(f.jobs[3].state,'unknown');
 const mutations=f.mutations.length;await invoke('native_workbench_stop',{confirmed:true});
 assert.equal(f.mutations.length,mutations);
 f.recover('unreachable');const before=clone(f.jobs);
 assert.equal((await invoke('native_workbench_stop',{confirmed:true})).outcome,'partial');
 assert.deepEqual(f.jobs,before);
 const rejected=f.unexpected.length;await assert.rejects(invoke('native_interrupt',{}),/Unexpected/);
 assert.equal(f.unexpected.length,rejected+1);
 console.log('PASS fixture selfcheck: stale delayed admission, settled/partial/unreachable, retention, strict rejection');
})().catch(error=>{console.error(error);process.exitCode=1;});
"""
    result = subprocess.run(['node', '-e', script], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    print(result.stdout.strip(), flush=True)


def locale(page, value):
    page.locator('[data-node="settings"]').click()
    page.locator('#language-select').select_option(value)
    page.locator('[data-node="studio"]').click()
    expect(page.locator('[data-workbench]')).to_be_visible()


def row(page, identifier):
    return page.locator(f'[data-job-id="{identifier}"] [data-state]').first


def calls(page, command):
    return page.evaluate('(command)=>__runstop.calls.filter(c=>c.command===command)', command)


def clean(page, errors):
    assert not errors, errors
    assert page.evaluate('__runstop.unexpected') == [], page.evaluate('__runstop.unexpected')
    assert page.evaluate('__runstop.foreign') == {'id': 'not-owned', 'state': 'running'}


def open_studio(browser, url, mode=None):
    context = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
    page = context.new_page()
    page.set_default_timeout(5000)
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
    page.add_init_script(FIXTURE + (f'\nf.recover({json.dumps(mode)});' if mode else ''))
    page.goto(url, wait_until='networkidle', timeout=20000)
    locale(page, 'en')
    page.wait_for_function('__runstop.calls.some(c=>c.command==="native_workbench_current")')
    assert not calls(page, 'native_workbench_run'), 'Recovery auto-ran a job'
    return context, page, errors


def load_model(page):
    page.locator('[data-dock-tab="models"]').click()
    page.locator('[data-run-load]').click()
    expect(page.locator('[data-model-picker]')).to_have_value('sdxl/fresh.safetensors')


def completed_output(page):
    row(page, 'success4-held').click()
    expect(page.locator('[data-job-output-preview]')).to_be_visible()
    expect(page.locator('[data-job-id="success4-held"]')).to_contain_text('preserved.png')
    assert calls(page, 'native_job_output'), 'Rootless completed output must use native_job_output'


def control_geometry(page):
    geometry = page.evaluate(r"""()=>{
 const run=document.querySelector('[data-run]'),stop=document.querySelector('[data-run-stop]');
 const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
 return {run:rect(run),stop:rect(stop),parent:rect(run.parentElement),
  siblings:run.parentElement===stop.parentElement,tag:stop.tagName,tab:stop.tabIndex,
  width:innerWidth,scroll:document.documentElement.scrollWidth};
}""")
    assert geometry['siblings'], geometry
    assert geometry['tag'] == 'BUTTON' and geometry['tab'] >= 0, geometry
    assert geometry['scroll'] <= geometry['width'], geometry
    for key in ('run', 'stop'):
        rect, parent = geometry[key], geometry['parent']
        assert rect['w'] > 0 and rect['h'] > 0, geometry
        assert rect['x'] >= -1 and rect['x'] + rect['w'] <= geometry['width'] + 1, geometry
        assert rect['x'] >= parent['x'] - 1 and rect['y'] >= parent['y'] - 1, geometry
        assert rect['x'] + rect['w'] <= parent['x'] + parent['w'] + 1, geometry
        assert rect['y'] + rect['h'] <= parent['y'] + parent['h'] + 1, geometry
    assert geometry['stop']['x'] >= geometry['run']['x'] + geometry['run']['w'] - 1, geometry
    assert geometry['stop']['x'] - geometry['run']['x'] - geometry['run']['w'] <= 24, geometry


def repeated(browser, url, passed):
    context, page, errors = open_studio(browser, url)
    try:
        expect(page.locator('[data-job-id]')).to_have_count(0)
        assert not calls(page, 'native_workbench_run')
        passed.append('empty recovery without auto-Run')
        load_model(page)
        seed = page.locator('.wb-seed input[type="number"]')
        seed.fill('42')  # Existing input explicitly switches to fixed mode.
        for index in range(3):
            page.locator('[data-run-positive]').fill(f'Explicit immutable {index} — 猫')
            page.locator('[data-run-negative]').fill(f'Negative {index}')
            expect(page.locator('[data-run]')).to_be_enabled()
            expect(page.locator('[data-run]')).to_have_text('Run')
            page.locator('[data-run]').click()
            expect(page.locator('[data-job-id]')).to_have_count(index + 1)
            expect(seed).to_have_value('42')
        fixed = calls(page, 'native_workbench_run')
        assert len(fixed) == 3
        for index, call in enumerate(fixed):
            assert call['args']['admissionEpoch'] == 0 and call['args']['confirmed'] is True
            assert call['args']['intent']['seed'] == 42
            assert call['args']['intent']['positivePrompt'] == f'Explicit immutable {index} — 猫'
            assert call['args']['intent']['negativePrompt'] == f'Negative {index}'
        page.locator('[data-run-positive]').fill('Changed draft only')
        assert page.evaluate('__runstop.jobs.map(j=>j.intent)') == [c['args']['intent'] for c in fixed]
        expect(page.locator('[data-run]')).to_be_enabled()
        expect(page.locator('[data-run]')).to_have_text('Run')
        passed.append('three fixed-seed immutable explicit Runs remain enabled')
        # Existing seed-mode button order is random, fixed; do not infer behavior from translations.
        page.locator('.wb-seed-row button[aria-pressed]').first.click()
        for index in range(2):
            captured = int(seed.input_value())
            page.locator('[data-run-positive]').fill(f'Random captured {index}')
            page.locator('[data-run]').click()
            expect(page.locator('[data-job-id]')).to_have_count(4 + index)
            submitted = calls(page, 'native_workbench_run')[-1]['args']['intent']
            assert submitted['seed'] == captured, submitted
            assert submitted['positivePrompt'] == f'Random captured {index}'
        # No assertion that random values differ: valid randomness can collide.
        random_intents = page.evaluate('__runstop.jobs.map(j=>j.intent)')
        seed.fill('99')
        assert page.evaluate('__runstop.jobs.map(j=>j.intent)') == random_intents
        clean(page, errors)
        passed.append('random per-press seed capture without duplicate assumptions')
    finally:
        context.close()


def stop_case(browser, url, mode, screenshots, passed):
    context, page, errors = open_studio(browser, url, mode)
    try:
        completed_output(page)
        before = page.evaluate('__runstop.jobs.find(j=>j.id==="success4-held")')
        load_model(page)
        page.locator('[data-run-positive]').fill('Valid draft')
        expect(page.locator('[data-run]')).to_be_enabled()
        # A real missing-input validation blocks Run, not Stop for already-held jobs.
        page.get_by_role('combobox', name='Pipeline', exact=True).select_option('i2i')
        expect(page.locator('[data-run]')).to_be_disabled()
        stop = page.locator('[data-run-stop]')
        expect(stop).to_be_enabled()
        control_geometry(page)
        if mode == 'settled':
            for width in (1440, 320):
                page.set_viewport_size({'width': width, 'height': 960})
                for value in LOCALES:
                    locale(page, value)
                    page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
                    control_geometry(page)
                    assert not calls(page, 'native_workbench_run')
                    clean(page, errors)
                    if value == 'en':
                        shot = screenshots / f'workbench-run-stop-{width}.png'
                        page.screenshot(path=str(shot), full_page=True)
                        print('SCREENSHOT '+str(shot), flush=True)
                    passed.append(f'layout {width} {value}')
        page.evaluate('__runstop.holdStop=true')
        stop.focus()
        expect(stop).to_be_focused()
        stop.press('Enter')
        page.wait_for_function('__runstop.stopping && typeof __runstop.releaseStop==="function"')
        expect(page.locator('[data-run]')).to_be_disabled()
        expect(stop).to_be_disabled()
        assert not calls(page, 'native_workbench_run')
        page.evaluate('__runstop.releaseStop()')
        if mode == 'settled':
            for identifier in ('queued01-held', 'running2-held'):
                expect(row(page, identifier)).to_have_attribute('data-state', 'cancelled')
        else:
            identifier = 'unknown3-source' if mode == 'partial' else 'running2-held'
            state = 'unknown' if mode == 'partial' else 'running'
            expect(row(page, identifier)).to_have_attribute('data-state', state)
            issue = 'Source ownership unresolved' if mode == 'partial' else 'Endpoint unreachable'
            alert = page.locator('[data-workbench] [role="alert"]').filter(has_text=issue).first
            expect(alert).to_be_visible()
            expect(alert).to_contain_text(issue)
            mutations = page.evaluate('__runstop.mutations')
            # A UI may disable retry or re-read a retained result. Neither may re-mutate ownership.
            page.evaluate('__runstop.holdStop=false')
            if stop.is_enabled():
                stop.click()
                page.wait_for_function('!__runstop.stopping')
            assert page.evaluate('__runstop.mutations') == mutations
            expect(row(page, identifier)).to_have_attribute('data-state', state)
            if mode == 'unreachable':
                expect(row(page, 'queued01-held')).to_have_attribute('data-state', 'queued')
            else:
                expect(row(page, 'running2-held')).to_have_attribute('data-state', 'cancelled')
        assert page.evaluate('__runstop.jobs.find(j=>j.id==="success4-held")') == before
        completed_output(page)
        clean(page, errors)
        passed.append(mode+' Stop: keyboard, invalid draft, pending disable, retention')
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url', nargs='?', help='Already-running HTTP loopback Vite URL')
    parser.add_argument('--selfcheck', action='store_true', help='Fixture race/contract only, no browser/server')
    args = parser.parse_args()
    if not args.selfcheck and not args.url:
        parser.error('provide a loopback URL or --selfcheck')
    if args.url:
        parsed = urlparse(args.url)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.username or parsed.password:
            parser.error('an explicit HTTP loopback URL without credentials is required')
    selfcheck()
    if args.selfcheck:
        print(json.dumps({'implemented_browser_cases': BROWSER_CASES, 'passed_browser_cases': 0,
                          'passed_fixture_selfchecks': 1, 'kind': 'simulated native IPC only'}))
        return
    scratch = Path.home()/'.hermes/cache/scratch'
    scratch.mkdir(parents=True, exist_ok=True)
    screenshots = Path(tempfile.mkdtemp(prefix='deas-run-stop-', dir=scratch))
    passed = []
    # Bound the complete browser invocation as well as individual waits.
    def timeout(_signum, _frame):
        raise TimeoutError('180-second browser verification budget exhausted')
    if hasattr(signal, 'SIGALRM'):
        signal.signal(signal.SIGALRM, timeout)
        signal.alarm(180)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(timeout=15000)
            try:
                repeated(browser, args.url, passed)
                for mode in ('settled', 'partial', 'unreachable'):
                    stop_case(browser, args.url, mode, screenshots, passed)
            finally:
                browser.close()
        assert len(passed) == BROWSER_CASES, passed
    finally:
        if hasattr(signal, 'SIGALRM'):
            signal.alarm(0)
        print(json.dumps({'implemented_browser_cases': BROWSER_CASES, 'passed_browser_cases': len(passed),
                          'passed': passed, 'passed_fixture_selfchecks': 1,
                          'kind': 'simulated native IPC only; not native/backend acceptance',
                          'screenshots': str(screenshots)}), flush=True)


if __name__ == '__main__':
    main()
