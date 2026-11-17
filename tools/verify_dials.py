"""Experimental Dials dock strip, rack dialog, rack presets dialog and dial info: real Chromium geometry, mouse and keyboard; synthetic
IPC (the preset store and the dial catalog are in-page stand-ins for the pack's routes), no models/backend.

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
# Stand-in for `native_dial_catalog`: four entries of the development machine's catalog (public dial metadata, 2026-11-16) and one
# built from the pack's schema, because no dial file there carries per-pipeline measurements yet.
NONE = {'useful': None, 'overcook': None}
# Mode and family: a pre-refiner H3 dial (a LoRA-style dial file) and a dial of another model family (example name).
PRE, KREA = 'dials/h3_motion_lora.safetensors', 'dials/krea2_example_hook.safetensors'
BARE = {'version': 2, 'description': '', 'negative': '', 'positive': '', 'pipeline': '', 'notes': '', 'neg': {'useful': None, 'overcook': None}, 'pos': {'useful': None, 'overcook': None}, 'evidence': None}
DAY, INK, IMPACT, MOTION, EXAMPLE = ('dials/h3_day_night_hook.safetensors', 'dials/h3_ink_wash.safetensors', 'dials/h3_impact_frame.safetensors', 'dials/h3_motion.safetensors', 'dials/example_measured_look.safetensors')
CATALOG = {'dropped': 0, 'truncated': False, 'dials': [
    {'dial': DAY, 'family': 'MiniMax H3', 'mode': 'post', 'info': {'version': 2, 'description': 'Time of day: +1 dusk, +2 night with a blue cast. Measured on Pika H3 Flex, 1 seed.', 'negative': 'bright midday', 'positive': 'night',
     'pipeline': 'Pika H3 Flex 6-step', 'notes': '', 'neg': {'useful': 1.5, 'overcook': 3.0}, 'pos': {'useful': 1.5, 'overcook': 3.0}, 'evidence': 'one-seed'}},
    {'dial': INK, 'family': 'MiniMax H3', 'mode': 'post', 'info': {'version': 2, 'description': 'Ink wash: the scene becomes a flowing black ink-wash painting on paper; negative goes to clean cel-shaded anime colour. Text to video only: 1.5 is already a full ink-wash landscape, 2.0 on a seep-in/out curve paints the scene in and out (r 0.94) at k = 6 (k = 2 smeared it over the whole clip, r 0.52). The painting restages the landscape and the figure as it comes and goes. With a reference picture (Ref2V) it draws nothing up to 6, curve or constant: the picture holds the style.',
     'negative': 'cel-shaded colour', 'positive': 'ink wash', 'pipeline': 'Pika H3 Flex 6-step, time rows k = 6, audio: protect',
     'notes': 'Best as a constant look on text to video: 1.5 to 2. On a seep in/out curve, 2 at k = 6 follows but re-composes the landscape (k = 2 smears the look over the clip). With a reference picture it draws nothing up to 6. One scene, seed 4242. https://matlowai.github.io/ComfyUI-Dials/curves.html',
     'neg': NONE, 'pos': {'useful': 2.0, 'overcook': None}, 'evidence': 'one-seed'}},
    {'dial': IMPACT, 'family': 'MiniMax H3', 'mode': 'post', 'info': {'version': 2, 'description': 'Impact frame: the anime hit flash, the frame turned into a stark inverted black-and-white drawing with heavy ink lines. Best on a short pulse at the moment of contact. Held constant, 3.0 turns a whole T2V clip into ink and 4.5 replaces the shot with an ink drawing. k = 2 drew no flash at 3.0.',
     'negative': 'normal shading', 'positive': 'impact frame', 'pipeline': 'Pika H3 Flex 6-step, time rows k = 6, audio: protect',
     'notes': 'Text to video: pulse 4.5 (a 0.5 s step at the hit) gives ~6 inverted ink frames and the shot comes back clean; constant 3 inks the whole clip. With a reference picture: pulse 6, a burst over the contact, not full-frame; 8 drew less than 6. One scene, seed 4242. https://matlowai.github.io/ComfyUI-Dials/curves.html',
     'neg': NONE, 'pos': {'useful': 4.5, 'overcook': 8.0}, 'evidence': 'one-seed'}},
    {'dial': MOTION, 'family': 'MiniMax H3', 'mode': 'post', 'info': {'version': 2, 'description': '', 'negative': '', 'positive': '', 'pipeline': '', 'notes': '', 'neg': NONE, 'pos': NONE, 'evidence': None}},
    {'dial': EXAMPLE, 'family': 'MiniMax H3', 'mode': 'post', 'info': {'version': 2, 'description': 'Schema example, not a real dial file: a look measured per pipeline.', 'negative': 'plain', 'positive': 'styled', 'pipeline': '6-step', 'notes': '',
     'neg': {'useful': 1.0, 'overcook': None}, 'pos': {'useful': 2.0, 'overcook': 4.0}, 'evidence': 'multi-seed', 'kind': 'look',
     'pipelines': {'t2v': {'useful': 2.0, 'overcook': 4.0, 'steps': 6, 'evidence': 'multi-seed', 'notes': 'follows at 6, smears at 2'}}}},
    {'dial': PRE, 'family': 'MiniMax H3', 'mode': 'pre', 'info': BARE},
    {'dial': KREA, 'family': 'Krea 2', 'mode': 'post', 'info': BARE},
]}
INFO_ROWS = [
    {'dial': DAY, 'strength': 1.5, 'on': True},
    {'dial': IMPACT, 'strength': 9, 'on': True, 'time': {'type': 'keys', 'points': [[0, 0], [2, 0], [2.5, 1], [3, 0]], 'unit': 'seconds', 'interp': 'step', 'steps': 6, 'audio': 'protect'}},
    {'dial': INK, 'strength': 2, 'on': True, 'time': {'type': 'keys', 'points': [[0, 0], [1.5, 1], [3.5, 1], [5, 0]], 'unit': 'seconds'}},
    {'dial': EXAMPLE, 'strength': 2, 'on': True},
    {'dial': MOTION, 'strength': 1.2, 'on': True},
]
INFO_LISTED = ['style.safetensors', DAY, INK, IMPACT, MOTION, EXAMPLE]
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
 if(command==='native_dial_catalog'){
  __calls.push({command,args});
  if(window.__noCatalog)throw new Error('DIAL_INFO_UNAVAILABLE: This backend has no dial catalog route. It comes with the Dial Rack nodes (ComfyUI-Dials or ComfyUI-MAINodes), which DEAS does not install yet');
  return DIALCATALOG;
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

FIXTURE = FIXTURE.replace('DIALCATALOG', json.dumps(CATALOG))

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


def check_rack(g, label, lanes=4):
    d, view = g['dialog'], g['viewport']
    assert g['open'] and g['modal'], (label, 'the rack is not an open modal dialog')
    assert g['page']['width'] <= view['width'] + 1, (label, 'page overflows horizontally', g['page'])
    assert d['left'] >= -1 and d['right'] <= view['width'] + 1 and d['top'] >= -1 and d['bottom'] <= view['height'] + 1, (label, 'dialog leaves the viewport', d, view)
    assert g['body']['scroll'] <= g['body']['client'] + 1, (label, 'dialog body overflows horizontally', g['body'])
    assert g['body']['overflow'] == 'auto', (label, 'dialog body must scroll long content itself')
    assert len(g['lanes']) == lanes and [lane['selected'] for lane in g['lanes']].count('true') == 1, (label, 'lanes', [lane['selected'] for lane in g['lanes']])
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
    assert [h['id'] for h in g['help']] == ['resolution', 'scene', 'findings', 'range'] and all(h['text'].strip() and h['width'] > 100 for h in g['help']), (label, 'help lines', g['help'])


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


CONTINUED = r"""()=>{
 const dialog=document.querySelector('dialog[data-dial-rack]'),body=dialog.querySelector('.dial-rack-body');
 const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
 const timeline=dialog.querySelector('[data-dial-timeline]'),locked=dialog.querySelector('[data-dial-rack-locked]'),basis=dialog.querySelector('[data-dial-basis]');
 return {viewport:{width:innerWidth,height:innerHeight},page:document.documentElement.scrollWidth,dialog:box(dialog),body:{client:body.clientWidth,scroll:body.scrollWidth},
  basisId:timeline.dataset.dialTimeline,basis:basis?{text:basis.textContent,...box(basis)}:null,locked:locked?{text:locked.textContent,...box(locked)}:null,
  ticks:dialog.querySelectorAll('[data-dial-tick]').length,frames:dialog.querySelectorAll('[data-dial-frames]').length,curves:dialog.querySelectorAll('[data-dial-lane-curve]').length,
  help:[...dialog.querySelectorAll('[data-dial-help]')].map(e=>e.dataset.dialHelp),conflicts:[...dialog.querySelectorAll('[data-dial-conflict]')].map(e=>e.dataset.dialConflict),
  points:[...dialog.querySelectorAll('[data-dial-point]')].map(e=>e.disabled),tools:Object.fromEntries([...dialog.querySelectorAll('[data-dial-tool]')].map(e=>[e.dataset.dialTool,e.disabled]))};
}"""


def verify_continued(browser, url, shots, checks):
    """A Continuity plan that continues an existing clip: the rack draws no frame ticks or per-frame line, holds the curves with the reason, and Run is blocked."""
    curved = 'dials/h3_day_night_hook.safetensors'
    plan = {'enabled': True, 'session': 'fixture-session', 'outputMode': 'full', 'source': {'clipId': 'pinned-clip', 'endpoint': 'http://127.0.0.1:8188'}, 'steps': [{'id': 'one', 'seconds': 5, 'action': ''}]}
    for locale in ('en', 'de', 'ja'):
        context = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(FIXTURE.replace('LOCALE', json.dumps(locale)).replace('RACKPRESETS', json.dumps(PRESETS)).replace('ROWS', json.dumps(ROWS[:2])).replace('LISTED', json.dumps(LISTED)).replace('NODES', json.dumps(['UNETLoader', 'MAIDialRack', 'MAIDialHoldMap']))
                             + f"\nlocalStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({json.dumps(plan)}));")
        try:
            page.goto(url + '/tools/inpaint-fixture.html', wait_until='networkidle')
            opener = page.locator('#studio-dock [data-dial-rack-open]')
            expect(opener).to_be_visible()
            # The strip names the refusal and Run carries it.
            expect(page.locator('#studio-dock [data-dial-conflict="pieceStart"]')).to_be_visible()
            reason = page.locator('#studio-dock [data-dial-conflict="pieceStart"]').text_content()
            assert len(reason) > 60, reason
            assert reason in (page.locator('[data-run]').get_attribute('title') or ''), ('Run does not carry the refusal', page.locator('[data-run]').get_attribute('title'))
            expect(page.locator('[data-run]')).to_be_disabled()
            for width, height in ((1440, 960), (390, 844)):
                page.set_viewport_size({'width': width, 'height': height})
                page.wait_for_timeout(80)
                label = f'continued:{locale}:{width}x{height}'
                opener.scroll_into_view_if_needed()
                opener.click()
                dialog = page.locator('dialog[data-dial-rack]')
                expect(dialog).to_be_visible()
                dialog.locator(f'[data-dial-lane="{curved}"] .dial-lane-name').click()
                g = page.evaluate(CONTINUED)
                assert g['basisId'] == 'planSource' and g['basis'] and g['basis']['width'] > 100, (label, 'basis', g['basisId'], g['basis'])
                assert g['ticks'] == 0 and g['frames'] == 0, (label, 'frame ticks or the per-frame line are drawn for a window Studio cannot place', g['ticks'], g['frames'])
                assert g['curves'] == 2, (label, 'the authored curves are still shown', g['curves'])
                assert g['conflicts'] == ['pieceStart'] and g['locked'] and reason in g['locked']['text'], (label, 'refusal', g['conflicts'], g['locked'])
                assert g['help'] == ['scene', 'findings', 'range'], (label, 'help lines', g['help'])
                assert g['points'] == [True] * 4, (label, 'points stay editable', g['points'])
                assert g['tools']['removeCurve'] is False and g['tools']['preset.rampIn'] and g['tools']['addPoint'] and g['tools']['paste'], (label, 'tools', g['tools'])
                assert g['page'] <= g['viewport']['width'] + 1 and g['body']['scroll'] <= g['body']['client'] + 1, (label, 'overflow', g['page'], g['body'])
                for part in (g['basis'], g['locked']):
                    assert part['left'] >= g['dialog']['left'] - 1 and part['right'] <= g['dialog']['right'] + 1, (label, 'text leaves the dialog', part)
                dialog.locator('[data-dial-basis]').scroll_into_view_if_needed()
                page.screenshot(path=str(shots / f'continued-{locale}-{width}x{height}.png'))
                dialog.locator(f'[data-dial-lane="{curved}"] .dial-lane-track').scroll_into_view_if_needed()
                page.screenshot(path=str(shots / f'continued-{locale}-{width}x{height}-lanes.png'))
                page.keyboard.press('Escape')
                expect(dialog).to_have_count(0)
                checks.append(label)
            # Removing the curve is the way out: the constant row runs and Run no longer carries the refusal.
            opener.scroll_into_view_if_needed()
            opener.click()
            dialog = page.locator('dialog[data-dial-rack]')
            dialog.locator(f'[data-dial-lane="{curved}"] .dial-lane-name').click()
            dialog.locator('[data-dial-tool="removeCurve"]').click()
            expect(dialog.locator('[data-dial-conflict]')).to_have_count(0)
            page.keyboard.press('Escape')
            expect(page.locator('#studio-dock [data-dial-conflict]')).to_have_count(0)
            assert reason not in (page.locator('[data-run]').get_attribute('title') or '')
            checks.append(f'continued:{locale}:remove-curve')
            assert not errors, errors
            assert page.evaluate('__unexpected') == [], page.evaluate('__unexpected')
            assert not page.evaluate('__calls.some(c=>/(_run|_submit|_upload|_prepare)$/.test(c.command))')
        finally:
            context.close()


def verify_families(browser, url, shots, checks):
    """The catalog's family and mode: a dial of another model family is not offered; a pre-refiner dial is, and its lane takes no curve and says why."""
    listed = ['style.safetensors', DAY, MOTION, PRE, KREA]
    rows = [{'dial': PRE, 'strength': 1.5, 'on': True}, ROWS[1]]
    for locale in ('en', 'de', 'zh'):
        for catalog in (True, False):
            context = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(FIXTURE.replace('LOCALE', json.dumps(locale)).replace('RACKPRESETS', json.dumps(PRESETS)).replace('ROWS', json.dumps(rows)).replace('LISTED', json.dumps(listed)).replace('NODES', json.dumps(['UNETLoader', 'MAIDialRack', 'MAIDialHoldMap']))
                                 + ('' if catalog else '\nwindow.__noCatalog=true;'))
            try:
                page.goto(url + '/tools/inpaint-fixture.html', wait_until='networkidle')
                label = f'families:{locale}:{"catalog" if catalog else "no-catalog"}'
                strip = page.locator('#studio-dock [data-dials]')
                if catalog:
                    expect(strip.locator('[data-dial-row][data-dial-info="known"]')).to_have_count(2)
                else:
                    expect(strip.locator('[data-dial-info-state="unavailable"]')).to_be_visible()
                offered = strip.locator('[data-dial-add] option').evaluate_all('(es)=>es.map(e=>e.value)')
                assert offered == (['', MOTION] if catalog else ['', MOTION, KREA]), (label, 'offered dial files', offered)
                expect(page.locator('#studio-dock [data-dial-conflict]')).to_have_count(0)
                opener = page.locator('#studio-dock [data-dial-rack-open]')
                opener.scroll_into_view_if_needed()
                opener.click()
                dialog = page.locator('dialog[data-dial-rack]')
                expect(dialog.locator(f'[data-dial-lane="{PRE}"]')).to_have_attribute('data-selected', 'true')
                locked = dialog.locator('[data-dial-rack-locked]')
                for tool in ('addCurve', 'preset.rampIn', 'preset.pulse', 'paste'):
                    button = dialog.locator(f'[data-dial-tool="{tool}"]')
                    if catalog:
                        expect(button).to_be_disabled()
                    else:
                        expect(button).to_be_enabled()
                if catalog:
                    expect(locked).to_be_visible()
                    expect(locked).to_contain_text('h3_motion_lora')
                    box, body = locked.bounding_box(), dialog.locator('.dial-rack-body').bounding_box()
                    assert box['x'] >= body['x'] - 1 and box['x'] + box['width'] <= body['x'] + body['width'] + 1, (label, 'the reason leaves the dialog', box, body)
                    if locale == 'en':
                        locked.scroll_into_view_if_needed()
                        page.screenshot(path=str(shots / 'families-en-pre-1440x960.png'))
                else:
                    expect(locked).to_have_count(0)
                # The post-refiner lane beside it is edited as always, and the pre-refiner row keeps its strength controls.
                dialog.locator(f'[data-dial-lane="{DAY}"] .dial-lane-name').click()
                expect(dialog.locator('[data-dial-rack-locked]')).to_have_count(0)
                expect(dialog.locator('[data-dial-tool="preset.rampIn"]')).to_be_enabled()
                expect(dialog.locator(f'[data-dial-row="{PRE}"] [data-dial="slider"]')).to_be_enabled()
                page.keyboard.press('Escape')
                expect(dialog).to_have_count(0)
                assert saved(page) == rows, (label, 'looking changed the rows', saved(page))
                checks.append(label)
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


INFO = r"""()=>{
 const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
 return [...document.querySelectorAll('#studio-dock [data-dial-row]')].map(row=>{
  const q=s=>row.querySelector(s),all=s=>[...row.querySelectorAll(s)],slider=q('[data-dial="slider"]');
  return {dial:row.dataset.dialRow,known:row.dataset.dialInfo??'',row:box(row),slider:{...box(slider),min:slider.min,max:slider.max,value:slider.value,disabled:slider.disabled},
   marks:all('[data-dial-mark]').map(m=>({kind:m.dataset.dialMark,strength:Number(m.dataset.dialMarkAt),at:Number(m.style.getPropertyValue('--at')),...box(m)})),
   sides:all('[data-dial-side]').map(e=>({side:e.dataset.dialSide,text:e.textContent,...box(e)})),facts:q('[data-dial-facts]')?{text:q('[data-dial-facts]').textContent,...box(q('[data-dial-facts]'))}:null,
   over:!!q('[data-dial-over]'),about:!!q('[data-dial="about"]')};
 });
}"""
# Chromium's range thumb: a tick is where the thumb's centre is at that strength.
THUMB = 16


def check_info(rows, label):
    by = {row['dial']: row for row in rows}
    expected = {DAY: ('-3', '3', ['neg-useful', 'neg-overcook', 'pos-useful', 'pos-overcook'], ['bright midday', 'night']), IMPACT: ('-3', '8', ['pos-useful', 'pos-overcook'], ['normal shading', 'impact frame']),
                INK: ('-3', '3', ['pos-useful'], ['cel-shaded colour', 'ink wash']), EXAMPLE: ('-3', '4', ['neg-useful', 'pos-useful', 'pos-overcook'], ['plain', 'styled']), MOTION: ('-3', '3', [], [])}
    for dial, (low, high, marks, sides) in expected.items():
        row = by[dial]
        assert row['known'] == 'known' and (row['slider']['min'], row['slider']['max']) == (low, high), (label, 'slider reach', dial, row['slider'])
        assert [m['kind'] for m in row['marks']] == marks and [s['text'] for s in row['sides']] == sides, (label, 'marks / side labels', dial, row['marks'], row['sides'])
        assert row['facts'] and row['facts']['text'].strip() and row['facts']['left'] >= row['row']['left'] - 1 and row['facts']['right'] <= row['row']['right'] + 1, (label, 'facts line', dial, row['facts'])
        slider = row['slider']
        for mark in row['marks']:
            centre = (mark['left'] + mark['right']) / 2
            want = slider['left'] + THUMB / 2 + mark['at'] * (slider['width'] - THUMB)
            assert abs(centre - want) <= 1.5, (label, 'a mark is not under the thumb position of its strength', dial, mark, want)
            assert mark['top'] >= slider['top'] - 1 and mark['bottom'] <= slider['bottom'] + 3, (label, 'a mark leaves the slider', dial, mark, slider)
        if sides:
            neg, pos = row['sides']
            assert abs(neg['left'] - slider['left']) <= 2 and abs(pos['right'] - slider['right']) <= 2, (label, 'side labels are not at the slider ends', dial, neg, pos, slider)
            assert neg['right'] <= pos['left'] + 1 and neg['top'] >= slider['bottom'] - 2, (label, 'side labels overlap or cover the slider', dial, neg, pos)
    assert [row['over'] for row in rows] == [False, True, False, False, False], (label, 'only the row above its overcook strength is warned', [row['over'] for row in rows])
    assert [row['about'] for row in rows] == [True, True, True, True, False], (label, 'rows with texts have a note button')


def verify_info(browser, url, shots, checks):
    """The dial files' own info: side labels, marks, reach, facts and notes in the strip and the rack at every size and locale; the unavailable state."""
    script = lambda locale: FIXTURE.replace('LOCALE', json.dumps(locale)).replace('RACKPRESETS', json.dumps(PRESETS)).replace('ROWS', json.dumps(INFO_ROWS)).replace('LISTED', json.dumps(INFO_LISTED)).replace('NODES', json.dumps(['UNETLoader', 'MAIDialRack', 'MAIDialHoldMap']))
    strip_shots = {('en', 1440, 1300), ('en', 1440, 960), ('en', 1024, 700), ('en', 390, 844), ('en', 320, 480), ('de', 1440, 1300), ('de', 1024, 700), ('ja', 390, 844), ('zh', 1024, 700)}
    rack_shots = {('en', 1440, 1300), ('en', 1440, 960), ('en', 1024, 700), ('en', 390, 844), ('de', 1440, 1300), ('de', 390, 844), ('ja', 1024, 700), ('fr', 1440, 960), ('tr', 1024, 700), ('zh', 390, 844)}
    for locale in ('en', 'de', 'fr', 'ja', 'tr', 'zh'):
        context = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        # A taller dock than the other sections use, so a screenshot holds the five rows.
        page.add_init_script(script(locale) + "\nlocalStorage.setItem('deas.pref.studio.dock.height',JSON.stringify(560));")
        try:
            page.goto(url + '/tools/inpaint-fixture.html', wait_until='networkidle')
            strip = page.locator('#studio-dock [data-dials]')
            expect(strip.locator('[data-dial-row][data-dial-info="known"]')).to_have_count(5)
            expect(strip.locator('[data-dial-info-state]')).to_have_count(0)
            assert page.evaluate("__calls.filter(c=>c.command==='native_dial_catalog').length") == 1, 'the catalog is read once when the tab opens'
            opener = page.locator('#studio-dock [data-dial-rack-open]')
            for width, height in ((1440, 1300), (1440, 960), (1024, 700), (390, 844), (320, 480)):
                page.set_viewport_size({'width': width, 'height': height})
                page.wait_for_timeout(80)
                label = f'info:{locale}:{width}x{height}'
                check_geometry(page.evaluate(GEOMETRY), label)
                check_info(page.evaluate(INFO), label)
                for row in page.locator('#studio-dock [data-dial-row]').all():
                    row.scroll_into_view_if_needed()
                    expect(row.locator('[data-dial-facts]')).to_be_in_viewport()
                # The note opens from the keyboard and stays inside the row.
                about = strip.locator(f'[data-dial-row="{INK}"] [data-dial="about"]')
                about.focus()
                page.keyboard.press('Enter')
                note = strip.locator(f'[data-dial-row="{INK}"] [data-dial-note]')
                expect(note).to_contain_text('k = 6')
                expect(about).to_have_attribute('aria-expanded', 'true')
                check_geometry(page.evaluate(GEOMETRY), label + ':note')
                note.scroll_into_view_if_needed()
                expect(note).to_be_in_viewport()
                if (locale, width, height) in strip_shots:
                    page.locator('#studio-dock [data-dial-row]').first.scroll_into_view_if_needed()
                    page.screenshot(path=str(shots / f'info-strip-{locale}-{width}x{height}.png'))
                about.focus()
                page.keyboard.press('Enter')
                expect(note).to_have_count(0)
                # The rack: the selected lane's pipeline text and notes sit with the blend steps and the audio mode.
                opener.scroll_into_view_if_needed()
                opener.click()
                dialog = page.locator('dialog[data-dial-rack]')
                dialog.locator(f'[data-dial-lane="{INK}"] .dial-lane-name').click()
                info = dialog.locator('[data-dial-rack-info]')
                expect(info).to_have_attribute('data-dial-rack-info', INK)
                expect(info.locator('[data-dial-rack-info-part="pipeline"]')).to_contain_text('time rows k = 6, audio: protect')
                expect(info.locator('[data-dial-rack-info-part="notes"]')).to_contain_text('k = 2 smears the look over the clip')
                expect(dialog.locator('[data-dial-audio]')).to_have_value('follow')
                expect(dialog.locator('[data-dial-steps-file]')).to_have_count(0)
                check_rack(page.evaluate(RACK), label + ':rack', lanes=5)
                box, body = info.bounding_box(), dialog.locator('.dial-rack-body').bounding_box()
                assert box['x'] >= body['x'] - 1 and box['x'] + box['width'] <= body['x'] + body['width'] + 1, (label, 'the info block leaves the dialog', box, body)
                for target in dialog.locator('[data-dial-rack-info], [data-dial-audio], [data-dial-steps], [data-dial-help]').all():
                    target.scroll_into_view_if_needed()
                    expect(target).to_be_in_viewport()
                if (locale, width, height) in rack_shots:
                    dialog.locator('.dial-rack-timeline h3').scroll_into_view_if_needed()
                    page.screenshot(path=str(shots / f'info-rack-{locale}-{width}x{height}.png'))
                    dialog.locator(f'[data-dial-lane="{INK}"] .dial-lane-track').scroll_into_view_if_needed()
                    page.screenshot(path=str(shots / f'info-rack-{locale}-{width}x{height}-lanes.png'))
                page.keyboard.press('Escape')
                expect(dialog).to_have_count(0)
                assert saved(page) == INFO_ROWS, (label, 'looking at the info changed the rows', saved(page))
                assert page.evaluate("__calls.filter(c=>c.command==='native_dial_catalog').length") == 1, (label, 'the rack must not read the catalog again while the tab is open')
                checks.append(label)
            # Behaviour in a desktop window: starting strength, the overcook warning, blend steps from the file, the audio mode.
            page.set_viewport_size({'width': 1440, 'height': 960})
            impact = strip.locator(f'[data-dial-row="{IMPACT}"]')
            expect(impact.locator('[data-dial-over]')).to_be_visible()
            expect(impact.locator('[data-dial="slider"]')).to_have_value('8')
            impact.locator('[data-dial="strength"]').fill('8')
            expect(impact.locator('[data-dial-over]')).to_have_count(0)
            impact.locator('[data-dial="remove"]').click()
            page.locator('[data-dial-add]').select_option(IMPACT)
            expect(strip.locator(f'[data-dial-row="{IMPACT}"] [data-dial="strength"]')).to_have_value('4.5')
            assert saved(page)[-1] == {'dial': IMPACT, 'strength': 4.5, 'on': True}, saved(page)[-1]
            opener.scroll_into_view_if_needed()
            opener.click()
            dialog = page.locator('dialog[data-dial-rack]')
            dialog.locator(f'[data-dial-lane="{EXAMPLE}"] .dial-lane-name').click()
            expect(dialog.locator('[data-dial-rack-info-part="measured"]')).to_be_visible()
            dialog.locator('[data-dial-tool="addCurve"]').click()
            # The fixture job is text to video with 20 sampler steps; DEAS's own default would be 7.
            expect(dialog.locator('[data-dial-steps]')).to_have_value('6')
            expect(dialog.locator('[data-dial-steps-file]')).to_have_attribute('data-dial-steps-file', '6')
            expect(dialog.locator('[data-dial-steps-use]')).to_have_count(0)
            dialog.locator('[data-dial-steps]').fill('')
            expect(dialog.locator('[data-dial-steps]')).to_have_attribute('placeholder', '7')
            dialog.locator('[data-dial-steps-use]').click()
            dialog.locator('[data-dial-audio]').select_option('protect')
            example = next(r for r in saved(page) if r['dial'] == EXAMPLE)
            assert example['time']['steps'] == 6 and example['time']['audio'] == 'protect', example
            check_rack(page.evaluate(RACK), f'info:{locale}:rack-steps', lanes=5)
            if locale in ('en', 'de'):
                dialog.locator('.dial-rack-timeline h3').scroll_into_view_if_needed()
                page.screenshot(path=str(shots / f'info-rack-{locale}-file-steps-1440x960.png'))
            dialog.locator('[data-dial-audio]').select_option('follow')
            assert 'audio' not in next(r for r in saved(page) if r['dial'] == EXAMPLE)['time']
            page.keyboard.press('Escape')
            # Reload reads the catalog again.
            strip.locator('[data-dial-info-refresh]').click()
            page.wait_for_function("__calls.filter(c=>c.command==='native_dial_catalog').length===2")
            checks.append(f'info:{locale}:start-strength-warning-steps-audio')
            assert not errors, errors
            assert page.evaluate('__unexpected') == [], page.evaluate('__unexpected')
            assert not page.evaluate('__calls.some(c=>/(_run|_submit|_upload|_prepare)$/.test(c.command))')
        finally:
            context.close()
        # No catalog route: the strip keeps its fallbacks, says so, and nothing is disabled.
        context = browser.new_context(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script('window.__noCatalog=true;\n' + script(locale) + "\nlocalStorage.setItem('deas.pref.studio.dock.height',JSON.stringify(560));")
        try:
            page.goto(url + '/tools/inpaint-fixture.html', wait_until='networkidle')
            strip = page.locator('#studio-dock [data-dials]')
            note = strip.locator('[data-dial-info-state="unavailable"]')
            expect(note).to_be_visible()
            expect(strip).to_have_attribute('data-dials', 'ready')
            for width, height in ((1440, 960), (390, 844), (320, 480)):
                page.set_viewport_size({'width': width, 'height': height})
                page.wait_for_timeout(80)
                label = f'info-unavailable:{locale}:{width}x{height}'
                check_geometry(page.evaluate(GEOMETRY), label)
                rows = page.evaluate(INFO)
                assert all(r['known'] == '' and (r['slider']['min'], r['slider']['max']) == ('-3', '3') and not r['slider']['disabled'] and not r['marks'] and not r['sides'] and not r['facts'] and not r['over'] for r in rows), (label, rows)
                note.scroll_into_view_if_needed()
                expect(note).to_be_in_viewport()
                if (locale, width) in (('en', 1440), ('en', 390), ('de', 1440), ('ja', 390)):
                    page.screenshot(path=str(shots / f'info-strip-{locale}-unavailable-{width}x{height}.png'))
                checks.append(label)
            page.set_viewport_size({'width': 1440, 'height': 960})
            strip.locator(f'[data-dial-row="{MOTION}"] [data-dial="remove"]').click()
            expect(page.locator('[data-dial-add]')).to_be_enabled()
            page.locator('[data-dial-add]').select_option(MOTION)
            expect(strip.locator(f'[data-dial-row="{MOTION}"] [data-dial="strength"]')).to_have_value('1')
            # A later read that works brings the info in without a reload of the page.
            page.evaluate('window.__noCatalog=false')
            strip.locator('[data-dial-info-refresh]').click()
            expect(strip.locator('[data-dial-row][data-dial-info="known"]')).to_have_count(5)
            expect(note).to_have_count(0)
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
    verify_continued(browser, url, shots, checks)
    verify_families(browser, url, shots, checks)
    verify_presets(browser, url, shots, checks)
    verify_info(browser, url, shots, checks)
    result = {'status': 'PASS', 'checksPassed': len(checks), 'kind': 'Chromium geometry, mouse and keyboard; synthetic IPC only', 'screenshots': str(shots), 'checks': checks}
    (shots / 'result.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'checks'}))


if __name__ == '__main__':
    from pathlib import Path
    runner.verify = verify
    runner.main(artifact_root=Path(__file__).resolve().parents[1] / 'output/playwright')
