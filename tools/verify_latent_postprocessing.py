"""Chromium-only H3/LTX latent post-processing gate; strict synthetic IPC, no inference.

  uv run --offline --no-project --with playwright python tools/verify_latent_postprocessing.py
  ... tools/verify_latent_postprocessing.py --url http://127.0.0.1:1420
  ... tools/verify_latent_postprocessing.py --self-check

Requires installed node_modules/Vite, Python Playwright and its Chromium binary.
Owns only its standalone loopback Vite child unless --url is supplied. All artifacts
are under ~/.hermes/cache/scratch. No model/backend/download service is contacted.
Schema snapshots: lib/models.ts (LocalModel), lib/execution.ts (RecipeAllowlist),
lib/recipePrerequisites.ts, lib/downloads.ts; values mirror Workbench.test.tsx.
The browser-only fixture-module patch exposes Workbench's existing planVisible prop;
no application component, DownloadPanel, or file on disk is replaced.
"""
import argparse
from contextlib import contextmanager
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from urllib.parse import urlparse
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
LOCALES = ('de', 'en', 'fr', 'ja', 'tr', 'zh')
MODELS = {
    'minimax-h3': 'minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors',
    'ltx-2': 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors',
}
INIT = r"""
const config=__CONFIG__;
if(!sessionStorage.getItem('latent-fixture-initialized')){
 localStorage.clear();localStorage.setItem('deas.locale.v1','en');
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify('t2v'));
 localStorage.setItem('deas.pref.studio.dock.tab',JSON.stringify('post'));
 localStorage.setItem('deas.pref.studio.run.positive',JSON.stringify('Synthetic latent intent — 猫'));
 localStorage.setItem('deas.pref.studio.run.seedMode',JSON.stringify('fixed'));
 localStorage.setItem('deas.pref.studio.run.seed','42');
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({attention:'',vae:'full',tile:512,cache:'',threshold:0.05,compile:'',outputNaming:'latent-fixture/%seed%',chunkHeadroom:0}));
 sessionStorage.setItem('latent-fixture-initialized','yes');
}
window.isTauri=true;
const f=window.__latent={calls:[],unexpected:[],jobs:[],config};
const clone=x=>structuredClone(x);
const fail=message=>{f.unexpected.push(message);throw Error(message);};
const keys=(args,names)=>{if(Object.keys(args).sort().join(',')!==names.split(',').filter(Boolean).sort().join(','))fail('argument keys: '+JSON.stringify(args)+' expected '+names);};
const model=(category,name,family)=>({category,name,path:'/env/ComfyUI/models/'+category+'/'+name,size:1,info:null,...(family?{family}:{})});
const h3=config.family==='minimax-h3';
const files=h3?[
 model('diffusion_models','h3.safetensors','minimax-h3'),
 model('text_encoders','qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'),
 model('vae','minimax_h3_video_vae_fp16.safetensors'),
 model('vae','minimax_h3_audio_vae_fp32.safetensors')
]:[
 model('unet','LTX2/ltx.safetensors','ltx-2'),
 model('text_encoders','gemma_3_12B_it_fp8.safetensors'),
 model('text_encoders','ltx-2.3_text_projection_bf16.safetensors'),
 model('vae','LTX2/LTX23_video_vae_bf16.safetensors'),
 model('vae','LTX2/LTX23_audio_vae_bf16.safetensors')
];
const candidates=Object.values(config.models);
if(config.installed)files.push(...candidates.map(n=>model('latent_upscale_models',n)));
const entry=(family,name)=>({id:family==='minimax-h3'?'h3-latent-upscaler':'ltx-latent-upscaler',label:name,providerId:'fixture',scope:'repo',locator:'fixture/'+family,kind:'repo',target:'latent_upscale_models',media:'video',base:family==='minimax-h3'?'MiniMax H3':'LTX 2.3'});
const catalog={version:1,providers:[{id:'fixture',kind:'huggingface',label:'Synthetic offline catalog',origin:'https://example.invalid',scopes:['repo'],anonymousNotice:'No network: strict fixture'}],entries:Object.entries(config.models).map(([family,name])=>entry(family,name))};
const snapshot=()=>clone({jobs:f.jobs,preparing:0,capacity:20,stopAvailable:false,admissionEpoch:0,stopping:false});
let callback=0;
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>++callback,
 convertFileSrc:path=>fail('unexpected file access '+path),
 invoke:async(command,args={})=>{
 f.calls.push({command,args:clone(args)});
 switch(command){
 case 'plugin:event|listen':
  if(!['tauri://drag-enter','tauri://drag-over','tauri://drag-drop','tauri://drag-leave','tauri://close-requested'].includes(args.event))return fail('unexpected event '+args.event);
  return ++callback;
 case 'plugin:event|unlisten': return null;
 case 'native_workbench_current':case 'native_workbench_poll':keys(args,'');return snapshot();
 case 'native_models_scan':keys(args,'root');if(args.root!=='/env/ComfyUI/models')return fail('wrong model root');return clone(files);
 case 'native_recipe_prerequisites':
  keys(args,'baseUrl');if(args.baseUrl.replace(/\/$/,'')!=='http://127.0.0.1:7801')return fail('wrong endpoint');
  return {baseUrl:'http://127.0.0.1:7801/',recipeId:'checkpoint-text-to-image-diagnostic',version:1,missingNodes:[],generationReady:false,
   allowlist:{nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage','DaSiWaH3TiledUpscale','LatentUpscaleModelLoader','LTXVLatentUpsampler'],checkpoints:[],loras:[],samplers:['euler','er_sde'],schedulers:['normal','simple','linear_quadratic'],
    diffusionModels:files.filter(m=>['unet','diffusion_models'].includes(m.category)).map(m=>m.name),textEncoders:files.filter(m=>m.category==='text_encoders').map(m=>m.name),vaes:files.filter(m=>m.category==='vae').map(m=>m.name),
    latentUpscaleModels:config.installed?candidates:[],h3LatentUpscaleModels:config.installed?[...candidates,'interpolation']:[]}};
 case 'native_media_list':
  keys(args,'path');if(!['/env/ComfyUI/input','/env/ComfyUI/output'].includes(args.path))return fail('unexpected media root');
  return {path:args.path,parent:'/env/ComfyUI',entries:[],truncated:false};
 case 'native_prompt_spellcheck':return null;
 case 'native_download_catalog':keys(args,'');return clone(catalog);
 case 'native_download_status':keys(args,'');return {state:'idle',completed:0,total:0,bytesDownloaded:0,error:null};
 case 'native_auth_status':keys(args,'');return [];
 case 'native_download_browse':{
  keys(args,'request');const r=args.request;keys(r,'providerId,scope,locator,authenticated,nsfw');
  const e=catalog.entries.find(e=>e.locator===r.locator);
  if(!e||r.providerId!=='fixture'||r.scope!=='repo'||r.authenticated!==false||r.nsfw!==true)return fail('invalid catalog browse');
  return {resources:[{id:e.id,label:e.label,kind:'model',url:'https://example.invalid/'+e.label,locator:e.label,downloadable:true,category:e.target,size:1}],nextCursor:null,warnings:[]};}
 case 'native_files_present':
  keys(args,'paths');if(!args.paths.every(p=>p.startsWith('/env/ComfyUI/models/latent_upscale_models/')))return fail('wrong download destination');return args.paths.map(()=>false);
 case 'native_workbench_run':{
  keys(args,'baseUrl,intent,confirmed,admissionEpoch');
  if(!f.allowRun||args.confirmed!==true||args.admissionEpoch!==0||args.baseUrl.replace(/\/$/,'')!=='http://127.0.0.1:7801'||args.intent.family!==config.family)return fail('unauthorized run');
  f.allowRun=false;
  const job={id:'synthetic-latent-'+f.jobs.length,baseUrl:args.baseUrl,promptId:'none',state:'failed',outputs:[],error:'Synthetic capture only: no generation',generationReady:false,intent:clone(args.intent)};
  f.jobs.push(job);return clone(job);}
 default:return fail('Unexpected IPC '+command);
 }
}};
"""


def fixture_script(family, installed):
    return INIT.replace('__CONFIG__', json.dumps({'family': family, 'installed': installed, 'models': MODELS}))


def self_check():
    assert set(MODELS) == {'minimax-h3', 'ltx-2'} and len(LOCALES) == 6
    for family in MODELS:
        for installed in (False, True):
            source = fixture_script(family, installed)
            assert '__CONFIG__' not in source
            # Node parses every fixture variant and proves unknown/download IPC fails closed.
            harness = "global.window=global;global.localStorage={clear(){},setItem(){}};global.sessionStorage={getItem(){return true}};" + source
            harness += "\n(async()=>{for(const c of ['unknown','native_download_start','native_download_plan']){let rejected=false;try{await __TAURI_INTERNALS__.invoke(c)}catch{rejected=true}if(!rejected)process.exit(1)}if(__latent.unexpected.length!==3)process.exit(2)})()"
            subprocess.run(['node', '-e', harness], check=True, cwd=ROOT)
    print('PASS Python/JS fixture self-check; unknown commands and all download writes reject')


@contextmanager
def vite(existing, artifacts):
    if existing:
        parsed = urlparse(existing)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
            raise ValueError('--url must be an HTTP loopback origin')
        yield existing.rstrip('/')
        return
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        port = reserve.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    with (artifacts/'vite.log').open('w') as log:
        server = subprocess.Popen(['node', str(ROOT/'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError(f'Vite exited; see {artifacts}/vite.log')
                try:
                    with urlopen(url+'/tools/inpaint-fixture.html', timeout=.3) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError('Vite startup timed out')
            yield url
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)


def clean(page, errors):
    assert not errors, errors
    assert page.evaluate('__latent.unexpected') == [], page.evaluate('__latent.unexpected')
    assert not page.evaluate("__latent.calls.some(c=>/^native_download_(plan|start|cancel)$/.test(c.command))"), 'implicit download operation'


def bounds(locator, width):
    locator.scroll_into_view_if_needed()
    geometry = locator.evaluate('el=>{const r=el.getBoundingClientRect();return {x:r.x,right:r.right,w:r.width,h:r.height,scroll:el.scrollWidth,client:el.clientWidth}}')
    assert geometry['x'] >= -1 and geometry['right'] <= width+1 and geometry['w'] > 8 and geometry['h'] > 8, geometry
    assert geometry['scroll'] <= geometry['client']+1, geometry


def plan(page, url):
    page.goto(url+'/tools/inpaint-fixture.html?plan=1', wait_until='networkidle')
    page.locator('[data-plan-intent]').wait_for(state='attached')
    return json.loads(page.locator('[data-plan-intent]').text_content())


def verify_case(browser, url, artifacts, family, installed):
    from playwright.sync_api import expect
    context = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
    page = context.new_page()
    page.set_default_timeout(8000)
    page.set_default_navigation_timeout(30000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    origin = urlparse(url).netloc

    def route(request):
        target = urlparse(request.request.url)
        if target.scheme in ('http', 'https') and target.netloc != origin:
            errors.append('Blocked external request '+request.request.url)
            request.abort()
        elif target.path == '/tools/inpaint-fixture.tsx':
            response = request.fetch()
            source = response.text()
            # Expose one existing React prop in the served fixture only, not in product code.
            needle = 'endpoint: params.get("endpoint")'
            assert source.count(needle) == 1, 'Vite fixture transform changed; update this exact seam'
            request.fulfill(response=response, body=source.replace(needle, 'planVisible: params.has("plan"), '+needle))
        else:
            request.continue_()

    page.route('**/*', route)
    page.add_init_script(fixture_script(family, installed))
    checks = []
    try:
        initial = plan(page, url)
        assert initial['family'] == family and 'latentUpscale' not in initial, initial
        clean(page, errors)
        page.goto(url+'/tools/inpaint-fixture.html', wait_until='networkidle')
        page.locator('[data-dock-tab="post"]').click()
        toggle = page.locator('[data-latent-upscale-enabled]')
        expect(toggle).not_to_be_checked()
        toggle.check()
        if installed:
            picker = page.locator('[data-latent-upscale-model]')
            options = picker.locator('option').evaluate_all('els=>els.map(e=>e.value)')
            assert MODELS[family] in options and MODELS[next(f for f in MODELS if f != family)] not in options, options
            assert 'interpolation' not in options, options
            picker.select_option(MODELS[family])
            expected = {'model': MODELS[family], 'scale': 2}
            if family == 'minimax-h3':
                expected.update(steps=1, denoise=.2)
            draft = plan(page, url)
            assert draft['latentUpscale'] == expected, draft
            assert draft['width'] == initial['width'] and draft['height'] == initial['height'] and draft['frames'] == initial['frames'], (initial, draft)
            assert not page.evaluate("__latent.calls.some(c=>c.command==='native_workbench_run')")
            page.goto(url+'/tools/inpaint-fixture.html', wait_until='networkidle')
            expect(page.locator('[data-run]')).to_be_enabled()
            page.evaluate('__latent.allowRun=true')
            page.locator('[data-run]').click()
            page.wait_for_function("__latent.calls.some(c=>c.command==='native_workbench_run')")
            runs = page.evaluate("__latent.calls.filter(c=>c.command==='native_workbench_run')")
            assert len(runs) == 1 and runs[0]['args']['intent'] == draft, (runs, draft)
            checks.append('compatible models only; default off; Run Plan equals explicit captured Run; dimensions/frames retained')
        else:
            # Enabling a missing model deliberately opens the real Library immediately.
            dialog = page.locator('dialog[data-latent-upscale-download]')
            expect(dialog).to_be_visible()
            clean(page, errors)
            dialog.locator('header button').click()
            expect(dialog).not_to_be_visible()
            expect(toggle).to_be_checked()
            expect(page.locator('[data-latent-upscale-offer]')).to_be_visible()
            expect(page.locator('[data-run]')).to_be_disabled()
            assert not page.evaluate("__latent.calls.some(c=>c.command==='native_workbench_run')")
            checks.append('missing opt-in opens Library immediately; cancel retains choice; Run blocked; no automatic run')
        for width in (1440, 320):
            page.set_viewport_size({'width': width, 'height': 960})
            for locale in LOCALES:
                page.get_by_role('combobox', name='Fixture language').select_option(locale)
                page.locator('[data-dock-tab="post"]').click()
                translations = json.loads((ROOT/'src/features/studio/locales'/f'{locale}.json').read_text())
                expect(toggle.locator('..')).to_contain_text(translations['studio.run.latent.enabled'])
                expect(page.locator('[data-latent-upscale-model]').locator('..')).to_contain_text(translations['studio.run.latent.model'])
                expect(page.locator('[data-latent-upscale-offer]')).to_have_text(translations['studio.run.latent.download'])
                expect(toggle).to_be_checked()
                bounds(toggle, width)
                if installed:
                    expect(page.locator('[data-latent-upscale-model]')).to_have_value(MODELS[family])
                    expect(page.locator('[data-latent-upscale-scale]')).to_have_value('2')
                    bounds(page.locator('[data-latent-upscale-model]'), width)
                    bounds(page.locator('[data-latent-upscale-scale]'), width)
                else:
                    offer = page.locator('[data-latent-upscale-offer]')
                    bounds(offer, width)
                    offer.click()
                    dialog = page.locator('dialog[data-latent-upscale-download]')
                    expect(dialog).to_be_visible()
                    assert dialog.evaluate('el=>el.matches(":modal")')
                    bounds(dialog, width)
                    # Real shared DownloadPanel DOM, not a mock or a lookalike dialog.
                    expect(dialog.locator('.download-module [data-library-tab="catalog"]')).to_be_visible()
                    start = dialog.locator('.download-start-all')
                    expect(start).to_be_disabled()
                    # Matching real catalog IDs must open the targeted listing without a card click.
                    item = dialog.locator('.download-resource input[type="checkbox"]')
                    expect(item).to_have_count(1)
                    expect(item).to_have_accessible_name(MODELS[family])
                    expect(item).not_to_be_checked()
                    item.check()
                    expect(start).to_be_enabled()
                    expect(dialog.locator('.download-identity').get_by_text('/env/ComfyUI/models/latent_upscale_models', exact=True)).to_be_visible()
                    clean(page, errors)  # Selection is NOT authorization to start/plan.
                    bounds(start, width)
                    page.screenshot(path=str(artifacts/f'{family}-missing-{width}-{locale}.png'), full_page=True)
                    page.keyboard.press('Escape')
                    expect(dialog).not_to_be_visible()
                    clean(page, errors)
                assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'), (family, installed, width, locale)
                text = page.locator('[data-dock-tab="post"]').inner_text()
                assert text.strip() and 'studio.' not in text, (locale, text)
                clean(page, errors)
                checks.append(f'{width}px {locale}: controls bounded; '+('selection retained' if installed else 'real Library open/select/cancel; no implicit downloads'))
        if installed:
            page.screenshot(path=str(artifacts/f'{family}-installed.png'), full_page=True)
            toggle.uncheck()
            assert 'latentUpscale' not in plan(page, url)
            checks.append('turning opt-in off removes submitted postprocessing intent')
        return {'family': family, 'installed': installed, 'checks': checks}
    finally:
        (artifacts/f'{family}-{installed}-ipc.json').write_text(json.dumps(page.evaluate('window.__latent'), indent=2)+'\n')
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', help='existing HTTP loopback Vite origin (not owned/stopped)')
    parser.add_argument('--self-check', action='store_true', help='parse fixture and verify fail-closed IPC without browser')
    args = parser.parse_args()
    self_check()
    if args.self_check:
        return
    from playwright.sync_api import sync_playwright
    scratch = Path.home()/'.hermes/cache/scratch'
    scratch.mkdir(parents=True, exist_ok=True)
    artifacts = Path(tempfile.mkdtemp(prefix='deas-latent-postprocessing-', dir=scratch))
    print('ARTIFACTS '+str(artifacts), flush=True)
    result = {'status': 'FAIL', 'kind': 'actual Chromium, real Workbench/DownloadPanel; strict simulated IPC only', 'cases': [], 'artifacts': str(artifacts)}
    try:
        with vite(args.url, artifacts) as url, sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            result['chromium'] = browser.version
            try:
                for family in MODELS:
                    for installed in (False, True):
                        result['cases'].append(verify_case(browser, url, artifacts, family, installed))
            finally:
                browser.close()
        result['status'] = 'PASS'
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        (artifacts/'result.json').write_text(json.dumps(result, indent=2)+'\n')
        print(json.dumps(result, indent=2), flush=True)


if __name__ == '__main__':
    main()
