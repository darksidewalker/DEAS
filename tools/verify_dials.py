"""Experimental Dials dock strip, rack dialog and rack presets dialog: real Chromium geometry, mouse and keyboard; synthetic IPC (the
preset store is an in-page stand-in for the pack's routes), no models/backend.

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
SHA = 'a' * 64
# Stand-in for the pack's preset files: one preset with every kind of note, one plain.
PRESETS = {
    'dance_mixed': {'rows': [
        {'dial': 'dials/h3_motion.safetensors', 'sha256': SHA, 'strength': 1.2, 'on': True, 'solo': False, 'time': {'type': 'keys', 'points': [[0, 0], [0.4, 0], [0.65, 1], [1, 1]]}},
        {'dial': 'dials/h3_day_night_hook.safetensors', 'sha256': SHA, 'strength': 1.5, 'on': True, 'solo': False},
        {'dial': 'dials/h3_calm.safetensors', 'sha256': SHA, 'strength': 0, 'on': True, 'solo': False, 'hold': True},
        {'dial': LONG, 'sha256': SHA, 'strength': -2.25, 'on': False, 'solo': False, 'blocks': [1, 0.5, 0]},
        {'dial': 'dials/gone.safetensors', 'sha256': SHA, 'strength': 1, 'on': True, 'solo': False},
    ], 'warnings': [{'row': 0, 'reason': 'changed'}, {'row': 4, 'reason': 'missing'}]},
    'plain_motion': {'rows': [{'dial': 'dials/h3_motion.safetensors', 'sha256': SHA, 'strength': 1.5, 'on': True, 'solo': False}], 'warnings': []},
}
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
 if(command.startsWith('native_dial_preset')){
  __calls.push({command,args});
  if(window.__noPresetRoute)throw new Error('DIAL_PRESETS_UNAVAILABLE: This backend has no rack preset route. It comes with the Dial Rack nodes (ComfyUI-Dials or ComfyUI-MAINodes), which DEAS does not install yet');
  window.__presets??=RACKPRESETS;
  if(command==='native_dial_presets')return Object.keys(__presets).sort();
  if(command==='native_dial_preset_load'){if(!__presets[args.name])throw new Error('DIAL_PRESET_NOT_FOUND: Preset not found.');return __presets[args.name];}
  if(__presets[args.name])throw new Error('DIAL_PRESET_EXISTS: Preset already exists. Choose a new name.');
  return __presets[args.name]={rows:args.rows.map(r=>({...r,sha256:'b'.repeat(64),solo:false})),warnings:[]};
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


RACK = r"""()=>{
 const dialog=document.querySelector('dialog[data-dial-rack]'),body=dialog.querySelector('.dial-rack-body');
 const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
 const shown=e=>e.getClientRects().length>0;
 const lanes=[...dialog.querySelectorAll('[data-dial-lane]')].map(lane=>({dial:lane.dataset.dialLane,selected:lane.dataset.selected,name:box(lane.querySelector('.dial-lane-name')),
  track:box(lane.querySelector('.dial-lane-track')),plot:box(lane.querySelector('.dial-lane-plot')),points:[...lane.querySelectorAll('[data-dial-point]')].map(box)}));
 const tools=[...dialog.querySelectorAll('.dial-rack-tools')].map(group=>({group:box(group),parts:[...group.querySelectorAll('button,label,small,output,strong')].filter(shown).filter(e=>!e.parentElement.closest('label')).map(box)}));
 return {viewport:{width:innerWidth,height:innerHeight},page:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},open:dialog.open,modal:dialog.matches(':modal'),dialog:box(dialog),
  body:{client:body.clientWidth,scroll:body.scrollWidth,overflow:getComputedStyle(body).overflowY},axis:box(dialog.querySelector('.dial-axis-track .dial-lane-plot')),
  ticks:dialog.querySelectorAll('[data-dial-tick]').length,seconds:[...dialog.querySelectorAll('[data-dial-second]')].map(box),lanes,tools,
  help:[...dialog.querySelectorAll('[data-dial-help]')].map(e=>({id:e.dataset.dialHelp,text:e.textContent,...box(e)}))};
}"""
# What the dialog must not change: the shell's own boxes behind it.
SHELL = r"""()=>['#studio-dock','.wb-dock-tabs','[data-dials]','[data-run-positive]'].map(q=>{const e=document.querySelector(q);if(!e)return [q,null];const r=e.getBoundingClientRect();return [q,[r.left,r.top,r.width,r.height].map(v=>Math.round(v*10)/10)];})
 .concat([['page',[document.documentElement.scrollWidth,document.documentElement.scrollHeight,document.body.scrollWidth,document.body.scrollHeight]]])"""


def check_rack(g, label):
    d, view = g['dialog'], g['viewport']
    assert g['open'] and g['modal'], (label, 'the rack is not an open modal dialog')
    assert g['page']['width'] <= view['width'] + 1, (label, 'page overflows horizontally', g['page'])
    assert d['left'] >= -1 and d['right'] <= view['width'] + 1 and d['top'] >= -1 and d['bottom'] <= view['height'] + 1, (label, 'dialog leaves the viewport', d, view)
    assert g['body']['scroll'] <= g['body']['client'] + 1, (label, 'dialog body overflows horizontally', g['body'])
    assert g['body']['overflow'] == 'auto', (label, 'dialog body must scroll long content itself')
    assert len(g['lanes']) == 4 and [lane['selected'] for lane in g['lanes']].count('true') == 1, (label, 'lanes', [lane['selected'] for lane in g['lanes']])
    first = g['lanes'][0]['plot']
    for lane in g['lanes']:
        # One shared seconds axis: every lane's plot, and the axis, start and end at the same pixels.
        assert abs(lane['plot']['left'] - first['left']) <= 1 and abs(lane['plot']['right'] - first['right']) <= 1, (label, 'lanes do not share the time axis', lane['dial'], lane['plot'], first)
        assert lane['plot']['width'] > 120, (label, 'lane collapsed', lane['plot'])
        assert lane['track']['left'] >= d['left'] - 1 and lane['track']['right'] <= d['right'] + 1, (label, 'lane leaves the dialog', lane['track'])
        apart = lane['name']['right'] <= lane['track']['left'] + 1 or lane['name']['bottom'] <= lane['track']['top'] + 1
        assert apart, (label, 'lane name overlaps its track', lane['dial'])
        for point in lane['points']:
            assert point['width'] >= 14 and point['left'] >= lane['track']['left'] - 1 and point['right'] <= lane['track']['right'] + 1 and point['top'] >= lane['track']['top'] - 1 and point['bottom'] <= lane['track']['bottom'] + 1, (label, 'point leaves its lane', lane['dial'], point, lane['track'])
    selected = next(lane for lane in g['lanes'] if lane['selected'] == 'true')
    assert all(selected['track']['height'] > 2 * lane['track']['height'] for lane in g['lanes'] if lane is not selected), (label, 'the selected lane is not the tall one')
    assert abs(g['axis']['left'] - first['left']) <= 1 and abs(g['axis']['right'] - first['right']) <= 1, (label, 'axis is not under the lanes', g['axis'], first)
    assert g['ticks'] == 38 and len(g['seconds']) == 6, (label, 'latent-frame ticks / second labels', g['ticks'], len(g['seconds']))
    for a, b in zip(g['seconds'], g['seconds'][1:]):
        assert a['right'] <= b['left'] + 1, (label, 'second labels overlap', a, b)
    for group in g['tools']:
        parts = group['parts']
        for part in parts:
            assert part['left'] >= group['group']['left'] - 1 and part['right'] <= group['group']['right'] + 1, (label, 'tool leaves its row', part, group['group'])
        for i, a in enumerate(parts):
            for b in parts[i + 1:]:
                apart = a['right'] <= b['left'] + 1 or b['right'] <= a['left'] + 1 or a['bottom'] <= b['top'] + 1 or b['bottom'] <= a['top'] + 1
                assert apart, (label, 'tools overlap', a, b)
    assert [h['id'] for h in g['help']] == ['resolution', 'scene', 'range'] and all(h['text'].strip() and h['width'] > 100 for h in g['help']), (label, 'help lines', g['help'])


def saved(page):
    return page.evaluate("JSON.parse(localStorage.getItem('deas.pref.studio.run.dials'))")


def verify_rack(browser, url, shots, checks):
    """The rack dialog: opens over the unchanged shell, shares one axis, and is edited with a real mouse and keyboard."""
    curved = 'dials/h3_day_night_hook.safetensors'
    for locale in ('en', 'de', 'fr', 'ja', 'tr', 'zh'):
        context = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(FIXTURE.replace('LOCALE', json.dumps(locale)).replace('RACKPRESETS', json.dumps(PRESETS)).replace('ROWS', json.dumps(ROWS)).replace('LISTED', json.dumps(LISTED)).replace('NODES', json.dumps(['UNETLoader', 'MAIDialRack', 'MAIDialHoldMap'])))
        try:
            page.goto(url + '/tools/inpaint-fixture.html', wait_until='networkidle')
            opener = page.locator('#studio-dock [data-dial-rack-open]')
            expect(opener).to_be_visible()
            for width, height in ((1440, 960), (1440, 1300), (1024, 700), (390, 844), (320, 480)):
                page.set_viewport_size({'width': width, 'height': height})
                page.wait_for_timeout(80)
                label = f'rack:{locale}:{width}x{height}'
                opener.scroll_into_view_if_needed()
                before = page.evaluate(SHELL)
                opener.focus()
                page.keyboard.press('Enter')
                dialog = page.locator('dialog[data-dial-rack]')
                expect(dialog).to_be_visible()
                expect(dialog.locator('[data-dial-rack-close]')).to_be_focused()
                # The shared window-layout contract: a modal dialog must not move or resize anything in the shell.
                assert page.evaluate(SHELL) == before, (label, 'opening the rack changed the shell layout', before, page.evaluate(SHELL))
                dialog.locator(f'[data-dial-lane="{curved}"] .dial-lane-name').click()
                expect(dialog.locator('[data-dial-point]')).to_have_count(4)
                check_rack(page.evaluate(RACK), label)
                # Long content stays reachable by scrolling the dialog's own body.
                for target in dialog.locator('[data-dial-lane] .dial-lane-track, [data-dial-help], [data-dial-rack] [data-dial="remove"]').all():
                    target.scroll_into_view_if_needed()
                    expect(target).to_be_in_viewport()
                if (locale, width) in (('en', 1440), ('en', 390), ('en', 320), ('de', 1024), ('ja', 390), ('zh', 1440), ('fr', 1024), ('tr', 320)) and height != 960:
                    dialog.locator(f'[data-dial-lane="{curved}"] .dial-lane-track').scroll_into_view_if_needed()
                    page.screenshot(path=str(shots / f'modal-{locale}-{width}x{height}.png'))
                    dialog.locator('.dial-rack-body').evaluate('e=>e.scrollTo(0,e.scrollHeight)')
                    page.screenshot(path=str(shots / f'modal-{locale}-{width}x{height}-end.png'))
                page.keyboard.press('Escape')
                expect(dialog).to_have_count(0)
                expect(opener).to_be_focused()
                assert page.evaluate(SHELL) == before, (label, 'closing the rack changed the shell layout')
                assert saved(page) == ROWS, (label, 'looking at the rack changed the rows', saved(page))
                checks.append(label)
            # Mouse and keyboard editing in a desktop window.
            page.set_viewport_size({'width': 1440, 'height': 960})
            opener.scroll_into_view_if_needed()
            opener.click()
            dialog = page.locator('dialog[data-dial-rack]')
            dialog.locator(f'[data-dial-lane="{curved}"] .dial-lane-name').click()
            track = dialog.locator(f'[data-dial-lane="{curved}"] .dial-lane-track')
            track.scroll_into_view_if_needed()
            plot = dialog.locator(f'[data-dial-lane="{curved}"] .dial-lane-plot').bounding_box()
            span = 124 / 24  # the fixture's 5 s clip is 124 frames
            at = lambda t, level: (plot['x'] + plot['width'] * t / span, plot['y'] + plot['height'] * (1 - level))
            curve = lambda: saved(page)[1]['time']['points']
            # Click the empty lane: a point on the 0.1 s / 0.05 grid, selected and focused.
            page.mouse.click(*at(2.52, 0.33))
            assert curve() == [[0, 0], [1.5, 0.2], [2.5, 0.35], [3.5, 1], [5, 1]], curve()
            expect(dialog.locator('[data-dial-point="2"]')).to_be_focused()
            expect(dialog.locator('[data-dial-point="2"]')).to_have_attribute('aria-pressed', 'true')
            # Drag it: it follows the pointer, and stops one latent frame (1/6 s) before the next point even when the pointer leaves the lane.
            page.mouse.move(*at(2.5, 0.35))
            page.mouse.down()
            page.mouse.move(*at(2.9, 0.6), steps=4)
            assert curve()[2] == [2.9, 0.6], curve()
            page.mouse.move(plot['x'] + plot['width'] + 80, plot['y'] - 60, steps=4)
            assert curve()[2] == [3.3333, 1], curve()
            page.mouse.up()
            page.mouse.move(*at(1, 0.5))
            assert curve()[2] == [3.3333, 1], 'a released point must not follow the pointer'
            expect(dialog.locator('[data-dial-readout]')).to_contain_text('1 ')
            # Keys on the focused point: arrows nudge, Delete removes, Ctrl+Z walks back, Ctrl+Shift+Z forward.
            dialog.locator('[data-dial-point="2"]').focus()
            page.keyboard.press('ArrowLeft')
            page.keyboard.press('ArrowDown')
            assert curve()[2] == [3.2333, 0.95], curve()
            page.keyboard.press('Delete')
            assert curve() == ROWS[1]['time']['points'], curve()
            expect(dialog.locator('[data-dial-point="2"]')).to_be_focused()
            page.keyboard.press('Control+z')
            assert len(curve()) == 5, curve()
            page.keyboard.press('Control+Shift+z')
            assert curve() == ROWS[1]['time']['points'], curve()
            # Tab reaches the tools, the lane names and the points; a preset from the keyboard writes levels inside 0..1.
            dialog.locator('[data-dial-tool="preset.pulse"]').focus()
            page.keyboard.press('Enter')
            pulse = curve()
            assert [p[1] for p in pulse] == [0, 1, 1, 0] and pulse[1][0] == 1.5 and abs(pulse[3][0] - span) < 1e-3, pulse
            steps = dialog.locator('[data-dial-steps]')
            expect(steps).to_have_attribute('placeholder', '7')
            steps.fill('9')
            assert saved(page)[1]['time']['steps'] == 9
            if locale == 'en':
                track.scroll_into_view_if_needed()
                page.screenshot(path=str(shots / 'modal-en-edited-1440x960.png'))
            # Copy on the curved lane, paste on a constant one: the in-page copy stands in when the headless clipboard is refused.
            dialog.locator('[data-dial-tool="copy"]').click()
            expect(dialog.locator('[data-dial-rack-note]')).not_to_be_empty()
            dialog.locator('[data-dial-lane="dials/h3_motion.safetensors"] .dial-lane-name').click()
            dialog.locator('[data-dial-tool="paste"]').click()
            page.wait_for_function("JSON.parse(localStorage.getItem('deas.pref.studio.run.dials'))[0].time")
            assert saved(page)[0]['time'] == saved(page)[1]['time'], saved(page)[0]
            dialog.locator('[data-dial-tool="removeCurve"]').click()
            assert 'time' not in saved(page)[0]
            page.keyboard.press('Escape')
            expect(dialog).to_have_count(0)
            expect(opener).to_be_focused()
            # The strip behind shows the edited curve; nothing was submitted.
            expect(page.locator('#studio-dock [data-dial-curve]')).to_have_count(2)
            checks.append(f'rack:{locale}:mouse-keyboard')
            assert not errors, errors
            assert page.evaluate('__unexpected') == [], page.evaluate('__unexpected')
            assert not page.evaluate('__calls.some(c=>/(_run|_submit|_upload|_prepare)$/.test(c.command))')
        finally:
            context.close()


PRESETS_GEOMETRY = r"""()=>{
 const dialog=document.querySelector('dialog[data-dial-presets]'),body=dialog.querySelector('.lora-sets-body');
 const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
 const shown=e=>e.getClientRects().length>0;
 const panels=[...body.querySelectorAll(':scope>section')].map(p=>({box:box(p),client:p.clientWidth,scroll:p.scrollWidth,
  parts:[...p.querySelectorAll('button,select,input,li,p,small,h3,.dial-preset-entry>span')].filter(shown).map(e=>({tag:e.tagName,text:e.textContent.slice(0,40),...box(e)}))}));
 const controls=[...dialog.querySelectorAll('button,select,input')].filter(shown).map(e=>({tag:e.tagName,text:(e.textContent||e.value||'').slice(0,40),...box(e)}));
 return {viewport:{width:innerWidth,height:innerHeight},page:{width:document.documentElement.scrollWidth},open:dialog.open,modal:dialog.matches(':modal'),dialog:box(dialog),
  body:{client:body.clientWidth,scroll:body.scrollWidth},panels,controls,rows:[...dialog.querySelectorAll('[data-dial-preset-row]')].map(e=>e.dataset.dialPresetState)};
}"""


def check_presets(g, label):
    d, view = g['dialog'], g['viewport']
    assert g['open'] and g['modal'], (label, 'the presets dialog is not an open modal dialog')
    assert g['page']['width'] <= view['width'] + 1, (label, 'page overflows horizontally', g['page'])
    assert d['left'] >= -1 and d['right'] <= view['width'] + 1 and d['top'] >= -1 and d['bottom'] <= view['height'] + 1, (label, 'dialog leaves the viewport', d, view)
    assert g['body']['scroll'] <= g['body']['client'] + 1, (label, 'dialog body overflows horizontally', g['body'])
    assert len(g['panels']) == 2, (label, 'panels', len(g['panels']))
    for panel in g['panels']:
        assert panel['box']['width'] > 200, (label, 'panel collapsed', panel['box'])
        assert panel['scroll'] <= panel['client'] + 1, (label, 'panel overflows horizontally', panel['scroll'], panel['client'])
        for part in panel['parts']:
            assert part['width'] > 0 and part['left'] >= panel['box']['left'] - 1 and part['right'] <= panel['box']['right'] + 1, (label, 'content leaves its panel', part, panel['box'])
    for i, a in enumerate(g['controls']):
        for b in g['controls'][i + 1:]:
            apart = a['right'] <= b['left'] + 1 or b['right'] <= a['left'] + 1 or a['bottom'] <= b['top'] + 1 or b['bottom'] <= a['top'] + 1
            assert apart, (label, 'controls overlap', a, b)
    assert g['rows'] == ['warning', 'ok', 'left-out', 'left-out', 'warning'], (label, 'preset rows', g['rows'])


def verify_presets(browser, url, shots, checks):
    """The rack presets dialog: a modal over the unchanged shell at every size and locale; list, load, save, refusals and the rack's undo."""
    for locale in ('en', 'de', 'fr', 'ja', 'tr', 'zh'):
        context = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(FIXTURE.replace('LOCALE', json.dumps(locale)).replace('RACKPRESETS', json.dumps(PRESETS)).replace('ROWS', json.dumps(ROWS)).replace('LISTED', json.dumps(LISTED)).replace('NODES', json.dumps(['UNETLoader', 'MAIDialRack', 'MAIDialHoldMap'])))
        try:
            page.goto(url + '/tools/inpaint-fixture.html', wait_until='networkidle')
            opener = page.locator('#studio-dock [data-dial-presets-open]')
            expect(opener).to_be_visible()
            dialog = page.locator('dialog[data-dial-presets]')
            for width, height in ((1440, 960), (1440, 1300), (1024, 700), (700, 600), (390, 844), (320, 480)):
                page.set_viewport_size({'width': width, 'height': height})
                page.wait_for_timeout(80)
                label = f'presets:{locale}:{width}x{height}'
                opener.scroll_into_view_if_needed()
                before = page.evaluate(SHELL)
                opener.focus()
                page.keyboard.press('Enter')
                expect(dialog).to_be_visible()
                assert page.evaluate(SHELL) == before, (label, 'opening the presets dialog changed the shell layout')
                expect(dialog.locator('[data-dial-preset-select] option')).to_have_count(3)
                dialog.locator('[data-dial-preset-select]').select_option('dance_mixed')
                expect(dialog.locator('[data-dial-preset-row]')).to_have_count(5)
                check_presets(page.evaluate(PRESETS_GEOMETRY), label)
                # Long content stays reachable by scrolling inside the dialog.
                for target in dialog.locator('[data-dial-preset-row], [data-dial-preset-current], [data-dial-preset-save], [data-dial-preset-load], .media-help').all():
                    target.scroll_into_view_if_needed()
                    expect(target).to_be_in_viewport()
                if (locale, width, height) in (('en', 1440, 960), ('en', 1024, 700), ('en', 390, 844), ('en', 320, 480), ('de', 1440, 960), ('de', 390, 844), ('ja', 1024, 700), ('zh', 700, 600), ('fr', 320, 480), ('tr', 1440, 1300)):
                    dialog.locator('[data-dial-preset-select]').scroll_into_view_if_needed()
                    page.screenshot(path=str(shots / f'presets-{locale}-{width}x{height}.png'))
                    if width < 700:
                        dialog.locator('[data-dial-preset-row]').last.scroll_into_view_if_needed()
                        page.screenshot(path=str(shots / f'presets-{locale}-{width}x{height}-rows.png'))
                page.keyboard.press('Escape')
                expect(dialog).to_have_count(0)
                expect(opener).to_be_focused()
                assert page.evaluate(SHELL) == before, (label, 'closing the presets dialog changed the shell layout')
                assert saved(page) == ROWS, (label, 'looking at the presets changed the rows', saved(page))
                checks.append(label)
            page.set_viewport_size({'width': 1440, 'height': 960})
            opener.scroll_into_view_if_needed()
            # Save: the name pattern, a new file, then the pack's refusal of the same name; the rack is not touched.
            opener.click()
            name, save = dialog.locator('[data-dial-preset-name]'), dialog.locator('[data-dial-preset-save]')
            name.fill('two words')
            expect(save).to_be_disabled()
            name.fill('from_deas-1')
            save.click()
            expect(dialog.locator('[data-dial-preset-select]')).to_have_value('from_deas-1')
            expect(dialog.locator('[data-dial-preset-row]')).to_have_count(4)
            sent = page.evaluate("__calls.filter(c=>c.command==='native_dial_preset_save').at(-1).args")
            assert sent['name'] == 'from_deas-1' and sent['rows'] == [{k: v for k, v in {**row, 'on': row.get('on', True)}.items()} for row in ROWS], sent
            assert all(set(row) <= {'dial', 'strength', 'on', 'time'} for row in sent['rows']), sent
            save.click()
            expect(dialog.locator('[data-dial-preset-error="DIAL_PRESET_EXISTS"]')).to_be_visible()
            if locale == 'en':
                page.screenshot(path=str(shots / 'presets-en-exists-1440x960.png'))
            assert saved(page) == ROWS
            # Load: only the rows DEAS sends, fractions converted with the 124-frame lane (5.1667 s).
            dialog.locator('[data-dial-preset-select]').select_option('dance_mixed')
            dialog.locator('[data-dial-preset-load]').click()
            loaded = saved(page)
            assert [r['dial'] for r in loaded] == ['dials/h3_motion.safetensors', 'dials/h3_day_night_hook.safetensors', 'dials/gone.safetensors'], loaded
            assert loaded[0]['time'] == {'type': 'keys', 'points': [[0, 0], [2.0667, 0], [3.3583, 1], [5.1667, 1]], 'unit': 'seconds'}, loaded[0]
            page.keyboard.press('Escape')
            expect(page.locator('[data-dial-row]')).to_have_count(3)
            # From the rack dialog: a load is one undo step.
            page.locator('#studio-dock [data-dial-rack-open]').click()
            rack = page.locator('dialog[data-dial-rack]')
            rack.locator('[data-dial-presets-open]').click()
            expect(dialog).to_be_visible()
            assert page.evaluate("document.querySelector('dialog[data-dial-presets]').matches(':modal')")
            dialog.locator('[data-dial-preset-select]').select_option('plain_motion')
            dialog.locator('[data-dial-preset-load]').click()
            assert saved(page) == [{'dial': 'dials/h3_motion.safetensors', 'strength': 1.5, 'on': True}], saved(page)
            if locale == 'en':
                page.screenshot(path=str(shots / 'presets-en-over-rack-1440x960.png'))
            page.keyboard.press('Escape')
            expect(dialog).to_have_count(0)
            expect(rack).to_be_visible()
            rack.locator('[data-dial-tool="undo"]').click()
            assert saved(page) == loaded, saved(page)
            page.keyboard.press('Escape')
            # Without the pack's route: the reason, and nothing to load or save.
            page.evaluate('window.__noPresetRoute=true')
            opener.click()
            expect(dialog.locator('[data-dial-preset-error="DIAL_PRESETS_UNAVAILABLE"]')).to_be_visible()
            name.fill('anything')
            expect(save).to_be_disabled()
            expect(dialog.locator('[data-dial-preset-load]')).to_be_disabled()
            expect(dialog.locator('[data-dial-preset-select]')).to_be_disabled()
            if locale in ('en', 'ja'):
                page.screenshot(path=str(shots / f'presets-{locale}-unavailable-1440x960.png'))
            page.keyboard.press('Escape')
            checks.append(f'presets:{locale}:list-load-save-refusals')
            assert not errors, errors
            assert page.evaluate('__unexpected') == [], page.evaluate('__unexpected')
        finally:
            context.close()


def verify(browser, url, shots):
    checks = []
    for locale in ('en', 'de', 'fr', 'ja', 'tr', 'zh'):
        for nodes in (['UNETLoader', 'MAIDialRack', 'MAIDialHoldMap'], ['UNETLoader']):
            gate = 'ready' if 'MAIDialRack' in nodes else 'nodeMissing'
            context = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(FIXTURE.replace('LOCALE', json.dumps(locale)).replace('RACKPRESETS', json.dumps(PRESETS)).replace('ROWS', json.dumps(ROWS)).replace('LISTED', json.dumps(LISTED)).replace('NODES', json.dumps(nodes)))
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
    verify_rack(browser, url, shots, checks)
    verify_presets(browser, url, shots, checks)
    result = {'status': 'PASS', 'checksPassed': len(checks), 'kind': 'Chromium geometry, mouse and keyboard; synthetic IPC only', 'screenshots': str(shots), 'checks': checks}
    (shots / 'result.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'checks'}))


if __name__ == '__main__':
    from pathlib import Path
    runner.verify = verify
    runner.main(artifact_root=Path(__file__).resolve().parents[1] / 'output/playwright')
