"""U-01 Chromium authoring fixture with simulated native IPC, not native acceptance.

Run against an existing local Vite server. Uses actual Workbench/PromptForge and
the shared typed handoff. No HTTP backend, LLM, model, upload or generation runs.
"""
import json
from pathlib import Path
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from verify_projects import INIT

URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4197').rstrip('/')
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parents[1] / 'artifacts/verification/u01-forge-canvas'
EXTRA = r"""
const pref=(key,value)=>localStorage.setItem('deas.pref.'+key,JSON.stringify(value));
pref('studio.run.checkpoint','sdxl.safetensors');pref('studio.run.resolution','model');pref('studio.run.aspect','1:1');
pref('studio.run.seed',42);pref('studio.run.negative','negative preserved');
pref('forge.target','MOSS');pref('forge.model','ollama:qwen');pref('forge.brief','A camp with a sign');
pref('forge.native.moss.mode','Layout JSON');pref('forge.native.moss.aspect','N/A');
pref('forge.native.moss.customWidth',3);pref('forge.native.moss.customHeight',2);
window.__INITIAL_LAYOUT__={w:1024,h:768,caption:'A quiet camp',meta:'illustration, anime',items:[
 {id:'camp-person',name:'Camper',label:'object',caption:'a camper sitting',text:'',color:'#52e0c4',x:64,y:96,w:384,h:480},
 {id:'camp-sign',name:'Sign',label:'text',caption:'a wooden sign',text:'CAMP',color:'#bb9aff',x:640,y:48,w:256,h:96}
]};
pref('forge.layout.project',window.__INITIAL_LAYOUT__);
window.__forgePending=[];
window.__completeForge=(index,stale=false)=>{
 const pending=window.__forgePending[index];if(!pending||pending.done)throw Error('Missing pending fixture completion '+index);
 pending.done=true;
 const request=pending.args.request,p=JSON.parse(localStorage.getItem('deas.pref.forge.layout.project'));
 const body=stale?{summary:{caption:'REJECTED OLD REPLY'},items:[]}:{summary:{meta:p.meta.split(',').map(s=>s.trim()),caption:p.caption},items:request.controls.layout?.items??[]};
 const prompt=request.mode==='Layout JSON'?'':'N/A prompt only fixture.';
 pending.resolve({segments:[{label:request.mode==='Layout JSON'?'Layout JSON':'Enhanced prompt',body:request.mode==='Layout JSON'?JSON.stringify(body):prompt}],
  refused:false,prompt,negative:null,characters:[],tools:[],rounds:0,warnings:[],fixes:[]});
};
const originalInvoke=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
 const record=value=>{window.__calls.push({command,args:structuredClone(args)});return value;};
 if(command==='native_workbench_current'||command==='native_workbench_poll')return record({jobs:[],preparing:0,capacity:20,stopAvailable:false,admissionEpoch:0,stopping:false});
 if(command==='native_llm_read')return record({provider:'ollama',baseUrl:'http://fixture.invalid:11434'});
 if(command==='native_llm_models')return record({models:[{provider:'ollama',id:'qwen',name:'Fixture qwen'}],warnings:[]});
 if(command==='native_forge_targets')return record({source:{commit:'simulated-u01'},creativity:['balanced'],targets:[
  {key:'moss',label:'MOSS',modes:['Natural language','Layout JSON'],defaultMode:'Natural language',optional:['Negative prompt'],qualityPresets:[],styles:[],
   aspectRatios:['N/A','16:9 Wide'],hasNegative:true,tools:false,guidance:[],layoutCanvas:{'N/A':[1024,1024],'16:9 Wide':[1536,864]},layoutRewrite:true}
 ]});
 if(command==='native_forge_write'){
  record(null);return new Promise(resolve=>window.__forgePending.push({args:structuredClone(args),resolve,done:false}));
 }
 return originalInvoke(command,args);
};
"""


def stored_project(page):
    return page.evaluate("JSON.parse(localStorage.getItem('deas.pref.forge.layout.project'))")


def studio_context(page):
    return json.loads(page.locator('[data-fixture-context]').text_content())


def authoring_state(page):
    return page.evaluate("""()=>Object.fromEntries(['positive','negative','checkpoint','seed','pipeline','inputScaling','width','height','resolution'].map(k=>[k,localStorage.getItem('deas.pref.studio.run.'+k)]))""")


def unchanged_objects(before, after):
    assert [before['caption'], before['meta']] == [after['caption'], after['meta']]
    identity = ('id', 'name', 'label', 'caption', 'text', 'color')
    assert [{k: item[k] for k in identity} for item in before['items']] == [{k: item[k] for k in identity} for item in after['items']]
    for old, new in zip(before['items'], after['items']):
        for field, edge in [('x', 'w'), ('w', 'w'), ('y', 'h'), ('h', 'h')]:
            # Existing resizeProject rounds each box edge to whole pixels.
            assert abs(old[field] / before[edge] - new[field] / after[edge]) <= 1 / after[edge] + 1e-9, (field, old, new)


def snapshot(page, phase, width):
    """Record actual DOM and SVG rectangles, without changing product layout."""
    metrics = page.locator('[data-fixture-forge]').evaluate("""host=>{
      const rect=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom}};
      const visible=e=>e.getClientRects().length>0;
      const controls=[...host.querySelectorAll('button,input,select,textarea')].filter(visible).map(e=>({selector:e.getAttribute('data-forge-tile')||e.getAttribute('data-layout-item')||e.tagName,rect:rect(e)}));
      const canvas=host.querySelector('[data-layout-canvas]');
      return {viewport:innerWidth,host:rect(host),cards:[...host.querySelectorAll('.forge-card')].filter(visible).map(rect),controls,
        canvas:canvas&&visible(canvas)?{viewBox:canvas.getAttribute('viewBox'),rect:rect(canvas),boxes:[...canvas.querySelectorAll('[data-layout-id]')].map(e=>({id:e.getAttribute('data-layout-id'),rect:rect(e)}))}:null};
    }""")
    for bounds in [*metrics['cards'], *(item['rect'] for item in metrics['controls'])]:
        assert bounds['width'] > 0 and bounds['x'] >= -1 and bounds['right'] <= width + 1, (phase, width, bounds)
    page.screenshot(path=str(OUT / f'{phase}-{width}.png'), full_page=True)
    return {'phase': phase, 'width': width, 'project': stored_project(page), **metrics}


def start_write(page, selector, count):
    button = page.locator(selector)
    expect(button).to_be_enabled()
    button.click()
    page.wait_for_function('(n)=>window.__forgePending.length===n', arg=count)


def run_case(browser, width):
    context = browser.new_context(viewport={'width': width, 'height': 1000}, reduced_motion='reduce')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(INIT.replace('LOCALE', json.dumps('en')) + EXTRA)
    origin = urlparse(URL).netloc

    def route(request):
        if urlparse(request.request.url).netloc != origin:
            errors.append('Unexpected network request ' + request.request.url)
            request.abort()
        else:
            request.continue_()

    page.route('**/*', route)
    page.on('websocket', lambda socket: errors.append('Unexpected websocket ' + socket.url) if urlparse(socket.url).netloc != origin else None)
    page.goto(URL + '/tools/forge-canvas-fixture.html', wait_until='networkidle')
    page.wait_for_function("()=>JSON.parse(document.querySelector('[data-fixture-context]').textContent||'null')?.effective?.width===1024")
    expect(page.locator('[data-layout-canvas]')).to_have_attribute('viewBox', '0 0 1024 768')
    before = authoring_state(page)
    initial = page.evaluate('window.__INITIAL_LAYOUT__')
    assert stored_project(page) == initial
    results = [snapshot(page, 'na-preserved', width)]

    page.locator('[data-forge-tile="aspect:16:9"]').click()
    expect(page.locator('[data-layout-canvas]')).to_have_attribute('viewBox', '0 0 1344 768')
    wide = stored_project(page)
    unchanged_objects(initial, wide)
    assert authoring_state(page) == before
    results.append(snapshot(page, 'preset-wide', width))
    page.locator('[data-layout-undo]').click()
    assert stored_project(page) == initial
    page.locator('[data-forge-tile="aspect:N/A"]').click()
    page.locator('[data-layout-redo]').click()
    assert stored_project(page) == wide

    page.locator('[data-forge-tile="aspect:custom"]').click()
    expect(page.locator('[data-forge-custom-width]')).to_have_value('3')
    expect(page.locator('[data-forge-custom-height]')).to_have_value('2')
    page.locator('[data-forge-custom-width]').fill('6')
    page.locator('[data-forge-custom-height]').fill('4')
    expect(page.locator('[data-layout-canvas]')).to_have_attribute('viewBox', '0 0 1280 832')
    custom = stored_project(page)
    unchanged_objects(wide, custom)
    assert authoring_state(page) == before
    results.append(snapshot(page, 'custom', width))

    start_write(page, '[data-forge-generate-json]', 1)
    request = page.evaluate('window.__forgePending[0].args.request')
    assert request['controls']['canvas'] == {'width': 1280, 'height': 832}
    assert [request['controls']['layout'][edge] for edge in ('width', 'height')] == [1280, 832]
    page.locator('[data-forge-tile="aspect:9:16"]').click()
    expect(page.locator('[data-layout-canvas]')).to_have_attribute('viewBox', '0 0 768 1344')
    changed = stored_project(page)
    page.evaluate('window.__completeForge(0,true)')
    expect(page.locator('[data-forge-native] [role="alert"]')).to_contain_text('old reply was discarded')
    assert stored_project(page) == changed
    expect(page.locator('[data-forge-send-layout]')).to_have_count(0)
    results.append(snapshot(page, 'stale-aspect-reply', width))

    page.locator('[data-forge-tile="aspect:custom"]').click()
    expect(page.locator('[data-layout-canvas]')).to_have_attribute('viewBox', '0 0 1280 832')
    start_write(page, '[data-forge-generate-json]', 2)
    old_context = studio_context(page)['key']
    page.locator('[data-fixture-context-change]').click()
    page.wait_for_function('(old)=>JSON.parse(document.querySelector("[data-fixture-context]").textContent).key!==old', arg=old_context)
    expect(page.locator('[data-forge-generate-json]')).to_be_visible()
    changed = stored_project(page)
    page.evaluate('window.__completeForge(1,true)')
    expect(page.locator('[data-forge-native] [role="alert"]')).to_contain_text('old reply was discarded')
    assert stored_project(page) == changed
    assert authoring_state(page) == before
    results.append(snapshot(page, 'stale-context-reply', width))

    start_write(page, '[data-forge-generate-json]', 3)
    consumed = page.evaluate('window.__forgePending[2].args.request.controls.canvas')
    page.evaluate('window.__completeForge(2)')
    expect(page.locator('[data-forge-send-layout]')).to_be_enabled()
    expect(page.locator('[data-forge-result-canvas]')).to_contain_text('1280')
    assert stored_project(page) == changed
    assert studio_context(page)['effective'] == {'width': 1024, 'height': 1024}
    assert authoring_state(page) == before
    results.append(snapshot(page, 'consumed-result', width))
    page.locator('[data-forge-send-layout]').click()
    expect(page.locator('[data-fixture-studio]')).to_be_visible()
    expect(page.get_by_label('Width', exact=True)).to_have_value(str(consumed['width']))
    expect(page.get_by_label('Height', exact=True)).to_have_value(str(consumed['height']))
    page.wait_for_function('(size)=>{const c=JSON.parse(document.querySelector("[data-fixture-context]").textContent);return c.resolution==="fixed"&&c.effective.width===size.width&&c.effective.height===size.height}', arg=consumed)
    incoming = json.loads(page.locator('[data-fixture-incoming]').text_content())
    assert incoming['canvas']['canvas'] == consumed
    sent_layout = json.loads(page.locator('[data-run-positive]').input_value())
    assert [item['caption'] for item in sent_layout['items']] == [item['caption'] for item in changed['items']]
    after_send = authoring_state(page)
    for key in ('negative', 'checkpoint', 'seed', 'pipeline', 'inputScaling'):
        assert after_send[key] == before[key], key
    page.screenshot(path=str(OUT / f'explicit-send-{width}.png'), full_page=True)
    results.append({'phase': 'explicit-send', 'width': width, 'consumed': consumed, 'authoring': after_send})

    page.locator('[data-fixture-tab="forge"]').click()
    page.locator('[data-forge-tile="aspect:N/A"]').click()
    assert stored_project(page) == changed
    page.locator('[data-forge-mode="Natural language"]').click()
    start_write(page, '[data-forge-write]', 4)
    na_request = page.evaluate('window.__forgePending[3].args.request')
    assert na_request['controls']['aspectRatio'] == 'N/A' and 'canvas' not in na_request['controls']
    page.evaluate('window.__completeForge(3)')
    expect(page.locator('[data-forge-send]')).to_be_enabled()
    results.append(snapshot(page, 'na-prompt-only-result', width))
    page.locator('[data-forge-send]').click()
    expect(page.locator('[data-run-positive]')).to_have_value('N/A prompt only fixture.')
    assert 'canvas' not in json.loads(page.locator('[data-fixture-incoming]').text_content())
    assert studio_context(page)['effective'] == consumed
    after_na = authoring_state(page)
    for key in ('negative', 'checkpoint', 'seed', 'pipeline', 'inputScaling', 'width', 'height', 'resolution'):
        assert after_na[key] == after_send[key], key
    page.screenshot(path=str(OUT / f'na-prompt-only-send-{width}.png'), full_page=True)
    results.append({'phase': 'na-prompt-only-send', 'width': width, 'effective': consumed, 'authoring': after_na})

    calls = page.evaluate('window.__calls')
    assert len([call for call in calls if call['command'] == 'native_forge_write']) == 4
    assert not any(call['command'] in ('native_job_prepare', 'native_job_submit', 'native_workbench_run', 'native_input_upload', 'native_mask_upload', 'native_llm_generate') for call in calls), calls
    assert not page.evaluate('window.__unexpected'), page.evaluate('window.__unexpected')
    assert not errors, errors
    context.close()
    return results


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (1440, 390):
            results.extend(run_case(browser, width))
        browser.close()
    (OUT / 'results.json').write_text(json.dumps({'cases': results, 'fixtureOnly': True, 'noGenerationOrUpload': True, 'simulatedCompletionsPerViewport': 4}, indent=2) + '\n')
    print(f'PASS: {len(results)} U-01 states at 1440/390 px; preset/Custom, MOSS identity and normalized resize/undo, stale aspect/context replies, consumed exact Send and N/A prompt-only preservation (simulated IPC).')


if __name__ == '__main__':
    main()
