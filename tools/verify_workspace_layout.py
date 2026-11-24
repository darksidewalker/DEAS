"""Viewport contract regression: real browser geometry, read-only IPC fixtures only.

Run: uv run --no-project --with playwright python tools/verify_workspace_layout.py
Owns its Vite/browser children; never accesses real models, media or backend services.
"""
import json
import re
from pathlib import Path
from playwright.sync_api import expect
import verify_postprocessing as runner
import verify_workbench_collection as collection
import verify_video_post as video

GEOMETRY = r'''()=>{
 const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
 const active=[...document.querySelectorAll('.studio-generate-host:not([hidden])')].find(e=>e.getClientRects().length);
 return {height:innerHeight,width:innerWidth,scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth,
  shell:rect(document.querySelector('.studio-shell')),frame:rect(document.querySelector('.aio-decision-area')),left:rect(document.querySelector('.aio-left')),panes:[...document.querySelectorAll('.aio-left,.aio-right')].filter(e=>e.getClientRects().length).map(rect),
  active:active?rect(active):null,activeOnly:active&&![...active.parentElement.children].some(e=>e!==active&&e.getClientRects().length),
  hidden:[...document.querySelectorAll('[hidden]:not([hidden="until-found"])')].filter(e=>e.getClientRects().length).map(e=>e.className||e.tagName),
  footer:{...rect(document.querySelector('.footer')),position:getComputedStyle(document.querySelector('.footer')).position}};
}'''


def assert_viewport(page, label):
    g = page.evaluate(GEOMETRY)
    assert abs(max(p['bottom'] for p in g['panes']) - g['frame']['bottom']) <= 2, (label, 'viewport chain shrinks and leaves footer-only space', g)
    assert abs(g['shell']['height'] - g['height']) <= 2, (label, 'shell must own one viewport', g)
    assert g['scrollHeight'] <= g['height'] + 2, (label, 'document scroll; content must scroll inside its pane', g)
    assert g['scrollWidth'] <= g['width'] + 1, (label, 'horizontal page overflow', g)
    assert not g['hidden'], (label, 'retained hidden panes occupy layout', g)
    assert g['footer']['position'] == 'fixed' and g['footer']['height'] < 24, (label, 'version reserves workspace space', g)
    if g['active'] and g['activeOnly']:
        assert abs(g['active']['bottom'] - g['frame']['bottom']) <= 2, (label, 'Studio tab does not inherit viewport', g)
    if page.locator('.aio-utility-tabs').count():
        utility = page.locator('.aio-utility-tabs')
        assert utility.locator('[role="tab"]').evaluate_all('(es)=>es.map(e=>e.dataset.studioTab||e.dataset.node)') == ['monitor','map','settings','logs'], label
        creative = page.locator('.aio-topbar > .aio-tabs').first
        assert creative.locator('[role="tab"]').evaluate_all('(es)=>es.map(e=>e.dataset.studioTab||e.dataset.node)')[:8] == ['generate','optional-downloads','forge','chat','analysis','wizards','tve','comfy'], label
        if g['width'] >= 1440:
            left, right = creative.bounding_box(), utility.bounding_box()
            assert left['x']+left['width'] <= right['x']+1, (label,'utility group is not right of creative tabs')
    return g


def assert_prompt_scrollbar(prompt):
    prompt.fill('A long synthetic prompt line.\n' * 60)
    prompt.scroll_into_view_if_needed()
    layout = prompt.evaluate("""textarea => {
      const bounds = textarea.getBoundingClientRect();
      const buttons = [...textarea.parentElement.nextElementSibling.querySelectorAll('button')]
        .filter(button => button.getClientRects().length);
      return {
        overflows: textarea.scrollHeight > textarea.clientHeight,
        buttonCount: buttons.length,
        clear: buttons.every(button => button.getBoundingClientRect().left >= bounds.right),
      };
    }""")
    assert layout['overflows'] and layout['buttonCount'] and layout['clear'], layout


FIXTURE = video.IPC + r'''
window.__TAURI_INTERNALS__.metadata={currentWindow:{label:'main'},currentWebview:{label:'main'}};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
localStorage.setItem('deas.pref.install.root', JSON.stringify('/fixture/env'));
localStorage.setItem('deas.pref.backend.autostart', 'false');
const layoutInvoke=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(c,a)=>{
 const read={
  native_files_present:[true],native_install_open:{state:'succeeded',logs:[],error:null},
  native_download_status:{state:'idle',completed:0,total:0,bytesDownloaded:0,error:null,jobs:[]},
  native_settings_read:{},
  native_model_scan_status:{state:'idle',id:'',total:0,completed:0,failed:0},
  native_models_scan:[{name:'video-cover.safetensors',category:'loras',path:'/fixture/models/loras/video-cover.safetensors',
    size:100,info:{civitai:{name:'Video cover fixture',version:'1',modelId:1,versionId:1,nsfw:false,trainedWords:[],
      preview:'https://image.civitai.com/library-preview-fixture.mp4',previewKind:'video'}}}],
  native_theme_packs:{directory:'/fixture/env/themes',packs:[],warnings:[]},
  native_llm_read:{provider:'openai',baseUrl:'http://127.0.0.1:49312'},native_llm_models:{models:[{id:'openai:layout-fixture',provider:'openai',name:'Layout fixture'}],warnings:[]},
  native_forge_randomizer_list:[],native_forge_targets:{source:{commit:'layout-fixture'},creativity:['balanced'],targets:[{key:'illustrious',label:'Layout fixture',modes:[],defaultMode:null,optional:[],qualityPresets:[],styles:[],aspectRatios:null,hasNegative:true,tools:false,guidance:[]}]},
  native_startup_read:{startup:{preset:'off',flags:[],fast:[]},packages:[],presets:{speed:{flags:[],fast:[]},compatibility:{flags:[],fast:[]},off:{flags:[],fast:[]}}},
  native_backend_status:{state:'stopped',endpoint:null,logs:[],error:null,generationReady:false},
  native_analysis_overview:{runtimeReady:false,install:{running:false,stage:'',downloaded:0,total:0,error:null},taggers:[],unusable:[],defaultSize:0,runtimeSize:0,toolsSize:0},
  native_chat_list:[],native_chat_settings:{search:'off',searxngUrl:''},native_logs:[],
  native_spellcheck_status:{available:true,installed:true},native_spellcheck_check:[],
  native_jobs_history:{schemaVersion:1,records:[],readOnly:false,error:null},
  native_wildcard_library:JSON.stringify({categories:[]}),
  native_audio_enhance_install_status:{running:false,mode:"",stage:"",downloaded:0,total:0},
  native_audio_enhance_capabilities:{clean:true,deep:false,stems:false},
  native_monitoring_sample:{at:0,source:'layout-fixture',cpu:null,ram:null,swap:null,disks:[],diskIo:null,gpus:[]},
  // Start-window preference (0.3.22) and multi-GPU enumeration (0.3.21): single-GPU fixture, default start mode.
  native_window_read:'maximized',native_backend_gpus:null
 };
 if(c==='native_install_plan'){f.calls.push({command:c,args:clone(a??{})});return {id:'layout-reopen',reopenId:'checked',request:a.request,steps:[],warnings:[],unsupportedOptions:[],canExecute:true};}
 if(c==='native_recipe_prerequisites'){
  const result=await layoutInvoke(c,a);
  return {...result,allowlist:{...result.allowlist,loras:['video-cover.safetensors','backend-only.safetensors']}};
 }
 if(Object.hasOwn(read,c)){f.calls.push({command:c,args:clone(a??{})});return clone(read[c]);}
 return layoutInvoke(c,a);
};
'''


def open_fixture(browser, url, user_agent=None):
    original = collection.FIXTURE
    collection.FIXTURE += FIXTURE
    try:
        return collection.open_studio(browser, url, False, user_agent=user_agent)
    finally:
        collection.FIXTURE = original


def verify_web_video_cover(browser, url):
    # WebView2 (Windows) path: the web <video> cover. The Linux desktop never renders it.
    context, page, errors = open_fixture(browser, url, 'DEAS Windows Chromium fixture')
    try:
        clip = Path(__file__).resolve().parents[1] / 'src-tauri/test-data/preview/preview.mp4'
        page.route('https://image.civitai.com/library-preview-fixture.mp4',
                   lambda request: request.fulfill(path=clip, content_type='video/mp4'))
        page.locator('[data-node="optional-downloads"]').click()
        page.locator('[data-library-tab="installed"]').click()
        card = page.get_by_role('button', name='video-cover.safetensors', exact=True)
        expect(card.locator('video')).to_be_visible()
        card.click()
        player = page.locator('.library-video-cover video')
        expect(player).to_have_js_property('controls', True)
        player.evaluate("video => video.play()")
        page.wait_for_function("document.querySelector('.library-video-cover video')?.currentTime > 0")
        assert not errors, errors
    finally:
        context.close()


def verify(browser, url, shots):
    verify_web_video_cover(browser, url)
    context, page, errors = open_fixture(browser, url)
    try:
        checks = ['Windows-UA installed model preview decodes and plays an MP4']
        picker = page.locator('[data-model-picker]')
        expect(picker).to_be_visible()
        assert picker.evaluate("e=>e.tagName==='SELECT'&&!e.multiple&&e.size===0")
        assert page.locator('[data-model-filter], [data-model-list]').count() == 0
        page.locator('[data-node="optional-downloads"]').click()
        page.locator('[data-library-tab="installed"]').click()
        card = page.get_by_role('button', name='video-cover.safetensors', exact=True)
        expect(card).to_be_visible()
        linux = page.evaluate("/Linux/.test(navigator.userAgent)")
        if linux:
            # Linux desktop UA (simulated Tauri): no WebKit <video> card, the still placeholder instead.
            assert card.locator('video').count() == 0
            checks.append('Linux-UA library card renders no WebKit video')
        page.locator('[data-studio-tab="generate"]').click()
        page.screenshot(path=str(shots/'checkpoint-native-desktop.png'))
        page.locator('[data-dock-tab="loras"]').click()
        backend_lora = page.get_by_role('button', name='backend-only.safetensors', exact=True)
        indexed_lora = page.get_by_role('button', name='video-cover.safetensors', exact=True)
        filter_backend = page.get_by_role('checkbox', name='Backend-only LoRAs')
        expect(filter_backend).not_to_be_checked()
        expect(indexed_lora).to_be_visible()
        expect(backend_lora).to_have_count(0)
        filter_backend.check()
        expect(indexed_lora).to_have_count(0)
        expect(backend_lora).to_have_accessible_description('Listed by ComfyUI. Local metadata is unavailable.')
        expect(backend_lora).to_have_attribute('title', re.compile('Local metadata is unavailable'))
        assert 'inset' in backend_lora.evaluate('el=>getComputedStyle(el).boxShadow')
        expect(page.locator('#studio-index-gap')).to_have_count(0)
        backend_lora.click()
        expect(backend_lora).to_have_attribute('aria-pressed', 'true')
        assert 'inset' in backend_lora.evaluate('el=>getComputedStyle(el).boxShadow')
        filter_backend.uncheck()
        expect(indexed_lora).to_be_visible()
        expect(backend_lora).to_have_count(0)
        filter_backend.check()
        expect(backend_lora).to_have_attribute('aria-pressed', 'true')
        backend_lora.click()
        filter_backend.uncheck()
        page.locator('[data-dock-tab="media"]').click()
        checks.append('exclusive backend-only LoRA filter defaults off and preserves selection')
        for width in (1440, 390):
            page.set_viewport_size({'width':width,'height':900})
            assert_prompt_scrollbar(page.locator('[data-run-positive]'))
            assert_prompt_scrollbar(page.locator('[data-run-negative]'))
            checks.append(f'{width}: prompt actions leave both scrollbars clear')
        page.set_viewport_size({'width':1440,'height':960})
        page.locator('[data-prompt-expand="positive"]').click()
        overlay = page.locator('.wb-prompt-overlay')
        assert_prompt_scrollbar(overlay.locator('.wb-prompt-overlay-body > .prompt-textarea > textarea'))
        overlay.locator('.wb-prompt-overlay-bar button').click()
        checks.append('expanded prompt leaves its scrollbar clear')
        page.locator('[data-dock-tab="notes"]').click()
        notes = page.locator('.prompt-note-editor')
        expect(notes.locator('.prompt-note-location')).to_be_visible()
        assert notes.locator('select').count() == 1 and notes.locator('[data-note-move]').count() == 1
        checks.append('note folder is shown in the editor toolbar as text, with one Move to folder select')
        folders = page.locator('.prompt-note-folders')
        all_notes = folders.get_by_role('button', name='All notes')
        for name in ('Alpha', 'Nested', 'Zulu'):
            if name == 'Zulu':
                all_notes.click()
            folders.get_by_role('button', name='New folder').click()
            naming = page.get_by_role('dialog', name='New folder')
            naming.get_by_role('textbox', name='Folder name').fill(name)
            naming.get_by_role('button', name='Confirm').click()
        roots = folders.locator('.prompt-note-tree > li > .prompt-note-folder > button:last-child')
        expect(roots).to_have_text(['Alpha', 'Zulu'])
        folders.get_by_role('button', name='Zulu', exact=True).drag_to(
            folders.get_by_role('button', name='Alpha', exact=True), target_position={'x':20,'y':3})
        expect(roots).to_have_text(['Zulu', 'Alpha'])
        folders.get_by_role('button', name='Nested', exact=True).drag_to(all_notes)
        expect(roots).to_have_text(['Zulu', 'Alpha', 'Nested'])
        expect(folders.get_by_role('button', name='Expand Zulu')).to_have_count(0)
        folders.get_by_role('button', name='Nested', exact=True).drag_to(
            folders.get_by_role('button', name='Zulu', exact=True))
        expect(roots).to_have_text(['Zulu', 'Alpha'])
        expect(folders.get_by_role('button', name='Collapse Zulu')).to_have_attribute('aria-expanded', 'true')
        expect(folders.get_by_role('button', name='Nested', exact=True)).to_be_visible()
        checks.append('note folders can be reordered, nested, and dragged to root')
        page.locator('[data-dock-tab="media"]').click()
        page.locator('[data-run-negative]').fill('')
        page.locator('[data-run-positive]').fill('Viewport draft retained')
        tabs = page.locator('.aio-tabs [role="tab"]').evaluate_all("els=>els.map(e=>({studio:e.dataset.studioTab,node:e.dataset.node}))")
        assert tabs
        for locale in collection.LOCALES:
            collection.set_locale(page, locale, '[data-node="studio"]')
            for width, height in [(1920,1080),(1440,960),(1024,768),(768,900),(390,844),(320,640),(1440,420)]:
                page.set_viewport_size({'width':width,'height':height})
                for target in tabs:
                    selector = '[data-studio-tab="'+target['studio']+'"]' if target.get('studio') else '[data-node="'+target['node']+'"]'
                    button = page.locator('.aio-tabs '+selector)
                    button.click()
                    try:
                        expect(button).to_have_attribute('aria-selected', 'true')
                    except AssertionError:
                        print('NAVIGATION_DIAGNOSTICS', errors, page.evaluate('({calls:__collection.calls,unexpected:__collection.unexpected,text:document.body.innerText.slice(0,6000)})'), flush=True)
                        raise
                    page.wait_for_timeout(35)
                    label = f'{locale}:{width}x{height}:{target}'
                    assert_viewport(page, label)
                    checks.append(label)
                page.locator('[data-studio-tab="generate"]').click()
                assert_viewport(page, 'return to retained Generate')
                expect(page.locator('[data-run-positive]')).to_have_value('Viewport draft retained')
            if locale in ('de','en'):
                page.locator('[data-studio-tab="tve"]').click()
                audio = page.locator('[data-audio-enhance="tve"]')
                expect(audio).to_be_visible()
                audio.locator('[data-audio-enhance-run]').scroll_into_view_if_needed()
                assert audio.locator('[data-audio-enhance-mode]').input_value() == 'off'
                assert audio.locator('[data-audio-enhance-run]').is_disabled()
                checks.append(f'{locale}:TVE audio enhancement reachable and opt-in OFF')
                page.set_viewport_size({'width':1440,'height':960})
                page.screenshot(path=str(shots/f'workspace-{locale}-desktop.png'))
                page.set_viewport_size({'width':390,'height':844})
                page.screenshot(path=str(shots/f'workspace-{locale}-narrow.png'))
        page.locator('[data-studio-tab="tve"]').click()
        page.evaluate("""()=>{
          document.querySelector('.studio-generate-host:not([hidden])').hidden=true;
          const host=document.createElement('div');host.className='studio-generate-host';host.dataset.futureHost='';
          host.innerHTML='<section class="future-pane"><input aria-label="future first"></section>';
          document.querySelector('.studio-main').append(host);
        }""")
        assert_viewport(page, 'unknown future tab inherits shared viewport')
        checks.append('future tab without feature-specific height rules')
        page.evaluate("""()=>{const e=document.querySelector('[data-future-host]');e.style.flex='none';e.style.height='40px';}""")
        try:
            assert_viewport(page, 'deliberately broken tab')
        except AssertionError:
            checks.append('negative control: footer-only gap is rejected')
        else:
            raise AssertionError('layout guard accepted a deliberately shrunken pane')
        page.evaluate("""()=>{
          const host=document.querySelector('[data-future-host]');host.removeAttribute('style');
          host.firstElementChild.innerHTML='<div style="height:2000px">Long future content</div><input aria-label="future last">';
          const style=document.createElement('style');style.textContent='.studio-generate-host[hidden]{display:grid}';document.head.append(style);
        }""")
        page.get_by_role('textbox',name='future last').scroll_into_view_if_needed()
        box = page.get_by_role('textbox',name='future last').bounding_box()
        assert box and box['y'] >= 0 and box['y'] + box['height'] <= page.viewport_size['height']
        assert_viewport(page, 'long future tab scrolls inside viewport; retained hidden CSS cannot override hiding')
        checks.append('long future content reachable without page scroll or hidden-pane leakage')
        collection.assert_clean(page, errors)
        forbidden=page.evaluate("__collection.calls.filter(c=>/(_start|_stop|_write|_send|_generate|_run|_submit|_cancel)$/.test(c.command))")
        assert not forbidden, forbidden
        result={'status':'PASS','checksPassed':len(checks),'tabCount':len(tabs),'checks':checks,'kind':'Chromium geometry; strict simulated IPC; no native services','screenshots':str(shots)}
        (shots/'result.json').write_text(json.dumps(result,indent=2)+'\n', encoding='utf-8')
        print(json.dumps(result,indent=2))
    finally:
        context.close()


if __name__ == '__main__':
    runner.verify = verify
    runner.main(artifact_root=Path(__file__).resolve().parents[1]/'output/playwright')
