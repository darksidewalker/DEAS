"""Experimental Dials dock strip: real Chromium geometry and keyboard; synthetic read-only IPC, no models/backend.

Run: uv run --no-project --with playwright==1.64.1 python tools/verify_dials.py
"""
import json
from playwright.sync_api import expect
import verify_continuity as continuity
import verify_postprocessing as runner

LONG = 'dials/h3_' + 'very_long_dial_name_' * 6 + 'hook.safetensors'
ROWS = [
    {'dial': 'dials/h3_motion.safetensors', 'strength': 1.5, 'on': True},
    {'dial': 'dials/h3_day_night_hook.safetensors', 'strength': -0.5, 'on': True,
     'time': {'type': 'keys', 'points': [[0, 0], [1.5, 0.2], [3.5, 1], [5, 1]], 'unit': 'seconds'}},
    {'dial': LONG, 'strength': 12, 'on': False,
     'time': {'type': 'keys', 'points': [[0, -1], [2, 1], [4, -0.5]], 'unit': 'seconds', 'interp': 'step'}},
    {'dial': 'dials/gone.safetensors', 'strength': 1, 'on': True},
]
LISTED = ['style.safetensors', 'dials/h3_motion.safetensors', 'dials/h3_day_night_hook.safetensors', LONG, 'dials/h3_calm.safetensors', 'dials/_probes/x.safetensors']

FIXTURE = continuity.INIT + r"""
localStorage.setItem('deas.pref.studio.dock.tab',JSON.stringify('dials'));
localStorage.setItem('deas.pref.studio.dock.height',JSON.stringify(360));
localStorage.removeItem('deas.pref.studio.run.continuity');
localStorage.setItem('deas.pref.studio.run.dials',JSON.stringify(ROWS));
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
const previousInvoke=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
 if(command==='native_audio_enhance_install_status')return {running:false,mode:'',stage:'',downloaded:0,total:0};
 if(command==='native_recipe_prerequisites'){
  __calls.push({command,args});
  return {baseUrl:args.baseUrl,recipeId:'checkpoint-text-to-image-diagnostic',version:1,missingNodes:[],generationReady:false,allowlist:{nodes:NODES,diffusionModels:['MiniMaxH3/h3.safetensors'],checkpoints:[],loras:LISTED,samplers:['euler'],schedulers:['simple']}};
 }
 if(command==='native_models_scan'){
  __calls.push({command,args});
  return [...await previousInvoke(command,args),...LISTED.map(name=>({category:'loras',name,path:'/m/loras/'+name,size:1,info:null}))];
 }
 return previousInvoke(command,args);
};
"""

GEOMETRY = r"""()=>{
 const panel=document.querySelector('#studio-dock .wb-dock-panel'),strip=panel.querySelector('[data-dials]');
 const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
 const rows=[...strip.querySelectorAll('[data-dial-row]')].map(row=>({dial:row.dataset.dialRow,state:row.dataset.dialState,box:box(row),
  parts:[...row.children].filter(e=>e.getClientRects().length).map(e=>({tag:e.tagName+(e.dataset.dial?':'+e.dataset.dial:''),...box(e)}))}));
 return {viewport:innerWidth,page:document.documentElement.scrollWidth,client:panel.clientWidth,scroll:panel.scrollWidth,vertical:panel.scrollHeight>panel.clientHeight,
  overflow:getComputedStyle(panel).overflowY,state:strip.dataset.dials,add:box(strip.querySelector('[data-dial-add]')),rows};
}"""


def check_geometry(g, label):
    assert g['page'] <= g['viewport'] + 1, (label, 'page overflows horizontally', g['page'])
    assert g['scroll'] <= g['client'] + 1, (label, 'dock panel overflows horizontally', g['scroll'], g['client'])
    assert g['overflow'] == 'auto', (label, 'dock panel must keep its own scrolling')
    assert g['add']['width'] > 40, (label, 'add control collapsed', g['add'])
    for row in g['rows']:
        parts = row['parts']
        for part in parts:
            assert part['width'] > 0 and part['left'] >= row['box']['left'] - 1 and part['right'] <= row['box']['right'] + 1, (label, 'control leaves its row', row['dial'], part)
        for i, a in enumerate(parts):
            for b in parts[i + 1:]:
                apart = a['right'] <= b['left'] + 1 or b['right'] <= a['left'] + 1 or a['bottom'] <= b['top'] + 1 or b['bottom'] <= a['top'] + 1
                assert apart, (label, 'controls overlap', row['dial'], a, b)


def verify(browser, url, shots):
    checks = []
    for locale in ('en', 'de', 'fr', 'ja', 'tr', 'zh'):
        for nodes in (['UNETLoader', 'MAIDialRack', 'MAIDialHoldMap'], ['UNETLoader']):
            gate = 'ready' if 'MAIDialRack' in nodes else 'nodeMissing'
            context = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(FIXTURE.replace('LOCALE', json.dumps(locale)).replace('ROWS', json.dumps(ROWS)).replace('LISTED', json.dumps(LISTED)).replace('NODES', json.dumps(nodes)))
            try:
                page.goto(url + '/tools/inpaint-fixture.html', wait_until='networkidle')
                strip = page.locator('#studio-dock [data-dials]')
                expect(strip).to_be_visible()
                expect(strip).to_have_attribute('data-dials', gate)
                expect(page.locator('[data-dock-tab="dials"]')).to_have_attribute('aria-selected', 'true')
                expect(page.locator('[data-dial-row]')).to_have_count(4)
                expect(page.locator('[data-dial-curve]')).to_have_count(2)
                expect(page.locator('[data-dial-row="dials/gone.safetensors"]')).to_have_attribute('data-dial-state', 'missing')
                for width, height in ((1440, 1300), (1440, 960), (1024, 700), (390, 844), (320, 480)):
                    page.set_viewport_size({'width': width, 'height': height})
                    page.wait_for_timeout(80)
                    label = f'{locale}:{gate}:{width}x{height}'
                    g = page.evaluate(GEOMETRY)
                    check_geometry(g, label)
                    # Every row stays reachable by scrolling its pane, also in a short or narrow window.
                    for row in page.locator('[data-dial-row]').all():
                        row.scroll_into_view_if_needed()
                        expect(row.locator('[data-dial="remove"]')).to_be_in_viewport()
                    if locale in ('en', 'de', 'ja'):
                        page.locator('[data-dial-row]').first.scroll_into_view_if_needed()
                        page.screenshot(path=str(shots / f'dials-{locale}-{gate}-{width}x{height}.png'))
                    checks.append(label)
                page.set_viewport_size({'width': 1440, 'height': 960})
                motion = page.locator('[data-dial-row="dials/h3_motion.safetensors"]')
                slider, number, switch = motion.locator('[data-dial="slider"]'), motion.locator('[data-dial="strength"]'), motion.locator('[data-dial="on"]')
                add = page.locator('[data-dial-add]')
                if gate == 'ready':
                    # Keyboard only: arrow keys move the slider by one step, Space flips the switch, the list adds a row, Enter removes it.
                    slider.focus()
                    page.keyboard.press('ArrowRight')
                    expect(number).to_have_value('1.55')
                    page.keyboard.press('ArrowLeft')
                    page.keyboard.press('ArrowLeft')
                    expect(number).to_have_value('1.45')
                    number.fill('-7.25')
                    expect(slider).to_have_value('-3')
                    switch.focus()
                    page.keyboard.press('Space')
                    expect(motion).to_have_attribute('data-dial-state', 'off')
                    assert add.locator('option').evaluate_all('(es)=>es.map(e=>e.value)') == ['', 'dials/h3_calm.safetensors'], 'offers unused dial files outside "_" folders'
                    add.select_option('dials/h3_calm.safetensors')
                    calm = page.locator('[data-dial-row="dials/h3_calm.safetensors"]')
                    expect(calm.locator('[data-dial="strength"]')).to_have_value('1')
                    calm.locator('[data-dial="remove"]').focus()
                    page.keyboard.press('Enter')
                    expect(calm).to_have_count(0)
                    saved = page.evaluate("JSON.parse(localStorage.getItem('deas.pref.studio.run.dials'))")
                    assert saved[0] == {'dial': 'dials/h3_motion.safetensors', 'strength': -7.25, 'on': False}, saved[0]
                    assert saved[1:] == ROWS[1:], saved
                else:
                    expect(strip.locator('[data-dials-reason="nodeMissing"]')).to_be_visible()
                    expect(add).to_be_disabled()
                    expect(slider).to_be_disabled()
                    expect(number).to_be_disabled()
                    switch.focus()
                    page.keyboard.press('Space')
                    expect(motion).to_have_attribute('data-dial-state', 'off')
                checks.append(f'{locale}:{gate}:keyboard')
                assert not errors, errors
                assert page.evaluate('__unexpected') == [], page.evaluate('__unexpected')
                assert not page.evaluate('__calls.some(c=>/(_run|_submit|_upload|_prepare)$/.test(c.command))')
            finally:
                context.close()
    result = {'status': 'PASS', 'checksPassed': len(checks), 'kind': 'Chromium geometry and keyboard; synthetic IPC only', 'screenshots': str(shots), 'checks': checks}
    (shots / 'result.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'checks'}))


if __name__ == '__main__':
    from pathlib import Path
    runner.verify = verify
    runner.main(artifact_root=Path(__file__).resolve().parents[1] / 'output/playwright')
