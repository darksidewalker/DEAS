"""U-02 Chromium media controls with simulated native IPC, not native acceptance.

Run against an existing local Vite server. Desktop/narrow rendered bounds,
retained drafts and Star identity are browser evidence; no files are moved,
media decoded, backend started, generation submitted or inputs uploaded.
"""
import json
from pathlib import Path
import struct
import sys
from urllib.parse import urlparse
import zlib
from playwright.sync_api import sync_playwright, expect
from verify_projects import INIT

URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4197').rstrip('/')
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parents[1]/'artifacts/verification/u02-media-controls'
EXTRA = r"""
const originalInvoke=window.__TAURI_INTERNALS__.invoke;
window.__STARRED__=false;
window.__RESULT__={id:'u02-results',baseUrl:'http://127.0.0.1:7801/',promptId:'u02-prompt',outputRoot:'/captured/old/output',state:'succeeded',error:null,generationReady:false,
 intent:{recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:'Immutable fixture result',negativePrompt:'',checkpoint:'sdxl.safetensors',seed:42,width:64,height:64,steps:20,cfg:5,sampler:'euler',scheduler:'normal',outputPrefix:'raw'},
 outputs:[{filename:'result-A.png',subfolder:'raw/original',type:'output'},{filename:'result-B.png',subfolder:'raw/original',type:'output'}]};
window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
 const root='/env/ComfyUI/output',path=root+(window.__STARRED__?'/starred':'/raw')+'/image/2026-10-19/fixture.png';
 const record=value=>{window.__calls.push({command,args});return value;};
 if(command==='native_media_list'){
  const filePath=args.path.startsWith('/env/ComfyUI/input')?'/env/ComfyUI/input/fixture.png':path;
  const entries=args.path===root?['raw','starred'].map(name=>({name,path:root+'/'+name,kind:'directory',media:null,symlink:false,size:0,modified:1})):filePath.startsWith(args.path.replace(/\/$/,'')+'/')?[{name:'fixture.png',path:filePath,kind:'file',media:'image',symlink:false,size:100,modified:2},{name:'clip.webm',path:root+'/raw/video/clip.webm',kind:'file',media:'video',symlink:false,size:100,modified:1}]:[];
  return record({path:args.path,parent:'/env/ComfyUI',entries,truncated:false});
 }
 if(command==='native_media_thumbnail')return record(args.path);
 if(command==='native_media_metadata')return record([]);
 if(command==='native_media_star_status')return record({starred:args.path.includes('/starred/'),unavailable:null});
 if(command==='native_media_star'||command==='native_media_unstar'){
  const unstar=command==='native_media_unstar',path=args.path.replace(unstar?'/starred/':'/raw/',unstar?'/raw/':'/starred/');
  if(args.path.endsWith('/fixture.png'))window.__STARRED__=!unstar;
  window.__RESULT__.outputs=window.__RESULT__.outputs.map(o=>[window.__RESULT__.outputRoot,o.subfolder,o.filename].join('/')===args.path?{...o,subfolder:path.slice(window.__RESULT__.outputRoot.length+1).split('/').slice(0,-1).join('/')}:o);
  return record({oldPath:args.path,path});
 }
 if(command==='native_workbench_current')return record({jobs:[structuredClone(window.__RESULT__)],preparing:0,capacity:20,stopAvailable:false});
 if(command==='native_models_scan')return record([{category:'checkpoints',name:'sdxl.safetensors',family:'sdxl',path:'/m/sdxl.safetensors',size:1,info:null},{category:'diffusion_models',name:'z-ltx2.safetensors',family:'ltx-2',path:'/m/ltx2.safetensors',size:1,info:null}]);
 // Actual NativeVideo HTML controls; mocked surfaces/status, no media decoder.
 if(command==='native_video_open')return record(null);
 if(command==='native_video_update')return record(args.action.kind==='status'?{position:0,duration:8,width:640,height:360,paused:true,muted:false,volume:100}:null);
 return originalInvoke(command,args);
};
"""


def png():
    def chunk(kind, data):
        return struct.pack('>I', len(data))+kind+data+struct.pack('>I', zlib.crc32(kind+data))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0))+chunk(b'IDAT', zlib.compress((b'\0'+b'\x58\x88\xa0'*64)*64))+chunk(b'IEND', b'')


def bottom_bounds(page, phase, width, minimum_actions=2):
    """Measure rectangles/hit targets, not declarations or mirrored CSS classes."""
    tools = page.locator('.wb-stage [data-media-tools]:visible')
    expect(tools).to_have_count(1)  # These phases show one media view at a time.
    tools.scroll_into_view_if_needed()
    metrics = tools.evaluate('''e=>{
      const box=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      const host=e.parentElement,children=Array.from(host.children),before=children.slice(0,children.indexOf(e));
      return {toolbar:box(e),host:box(host),stage:box(e.closest('.wb-stage')),
        pill:e.closest('.wb-stage').querySelector('.wb-stage-meta')?box(e.closest('.wb-stage').querySelector('.wb-stage-meta')):null,
        close:e.closest('.wb-stage').querySelector('.wb-stage-close')?box(e.closest('.wb-stage').querySelector('.wb-stage-close')):null,
        position:getComputedStyle(e).position,
        content:before.filter(n=>n.getBoundingClientRect().height>0).map(box),
        media:host.matches('figure')?Array.from(host.querySelectorAll('img,video,[data-native-video],.native-video-controls')).map(box):[],
        buttons:Array.from(e.querySelectorAll('button')).map(n=>({...box(n),label:n.textContent,clipped:n.scrollWidth>n.clientWidth+1,visible:getComputedStyle(n).visibility!=='hidden'&&n.offsetWidth>0})),
        rows:(()=>{const rows=[];for(const button of e.querySelectorAll('button')){
          if(getComputedStyle(button).visibility==='hidden'||!button.offsetWidth)continue;
          const r=button.getBoundingClientRect(),row=rows.find(v=>r.top<v.bottom-1&&r.bottom>v.top+1);
          if(row){row.top=Math.min(row.top,r.top);row.bottom=Math.max(row.bottom,r.bottom);}
          else rows.push({top:r.top,bottom:r.bottom});
        }return rows.map(r=>Math.round(r.top));})()};
    }''')
    toolbar = metrics['toolbar']
    stage = metrics['stage']
    # The row lives inside the stage; in overlay mode it rides the header line with the Metadata pill.
    assert toolbar['x'] >= stage['x']-1 and toolbar['right'] <= stage['right']+1, (phase, width, 'stage', metrics)
    assert toolbar['y'] >= stage['y']-1 and toolbar['bottom'] <= stage['bottom']+1, (phase, width, 'stage', metrics)
    if metrics['position'] == 'absolute':
        for peer in (metrics['pill'], metrics['close']):
            if peer:
                assert abs(toolbar['y'] - peer['y']) <= 1, (phase, width, 'toolbar not on the pill line', metrics)
                assert toolbar['right'] <= peer['x']+1, (phase, width, 'toolbar overlaps pill/close', metrics)
    else:
        assert all(r['bottom'] <= toolbar['y']+1 for r in metrics['content']), (phase, width, 'toolbar covers content/player/editor', metrics)
        assert all(r['bottom'] <= toolbar['y']+1 for r in metrics['media']), (phase, width, 'media/player overflows reserved row', metrics)
    assert metrics['content'], (phase, width, 'missing media/editor content', metrics)
    assert all(r['width'] > 0 and r['height'] > 0 for r in metrics['content']), (phase, width, 'collapsed content', metrics)
    assert all(r['x'] >= metrics['host']['x']-1 and r['right'] <= metrics['host']['right']+1 for r in metrics['media']), (phase, width, 'media/player overflows host', metrics)
    for button in metrics['buttons']:
        if not button['visible']:
            continue  # Closed dropdown rows: laid out invisibly, not interactive.
        assert button['width'] > 0 and button['height'] > 0 and not button['clipped'], (phase, width, 'clipped label', button)
        assert button['x'] >= toolbar['x']-1 and button['right'] <= toolbar['right']+1, (phase, width, button, metrics)
        assert button['y'] >= toolbar['y']-1 and button['bottom'] <= toolbar['bottom']+1, (phase, width, button, metrics)
    star = tools.locator('button.media-star')
    if star.count():
        expect(star).to_be_enabled()
    enabled = tools.locator('button:enabled:visible')
    assert enabled.count() >= minimum_actions, (phase, width, 'expected keyboard actions')
    enabled.nth(0).focus()
    page.keyboard.press('Tab')
    if enabled.count() > 1:
        expect(enabled.nth(1)).to_be_focused()
    else:
        expect(enabled.nth(0)).not_to_be_focused()
        page.keyboard.press('Shift+Tab')
        expect(enabled.nth(0)).to_be_focused()
    for button in enabled.all():
        button.scroll_into_view_if_needed()
        assert button.evaluate('''e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}'''), (phase, width, 'obstructed action', button.text_content())
    assert not page.evaluate('document.documentElement.scrollWidth>innerWidth+1'), (phase, width, 'horizontal page overflow')
    page.screenshot(path=str(OUT/f'{phase}-{width}.png'))
    return {'phase': phase, 'width': width, **metrics}


def authoring_state(page):
    return page.evaluate('''()=>({prompt:document.querySelector('[data-run-positive]').value,
      pipeline:document.querySelector('.wb-pipeline select').value,
      seed:document.querySelector('input[aria-label="Seed"]')?.value??localStorage.getItem('deas.pref.studio.run.seed')})''')


def retained_geometry(page, editor, base):
    expect(editor).to_be_visible()
    assert page.evaluate('window.__EDITOR__===document.querySelector("[data-editor-viewport]")')
    assert base.evaluate('e=>e.style.left') == '-8px'


def run_case(browser, width):
    # Linux UA selects NativeVideo; its owned surface/status IPC is simulated.
    context = browser.new_context(viewport={'width': width, 'height': 1000}, reduced_motion='reduce', user_agent='DEAS U02 Chromium Linux fixture')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(INIT.replace('LOCALE', json.dumps('en'))+EXTRA)
    origin = urlparse(URL).netloc
    def route(request):
        target = urlparse(request.request.url)
        if target.netloc != origin:
            errors.append('Unexpected network request '+request.request.url)
            request.abort()
        elif target.path.startswith(('/env/ComfyUI/output/', '/captured/old/output/')):
            request.fulfill(content_type='image/png', body=png())
        else:
            request.continue_()
    page.route('**/*', route)
    page.goto(URL+'/tools/inpaint-fixture.html', wait_until='networkidle')
    # Real desktop host containment; existing narrow rules scroll vertically.
    page.locator('[data-workbench]').evaluate('e=>e.style.height="calc(100vh - 32px)"')
    before = authoring_state(page)
    page.locator('.media-list').get_by_role('button', name='fixture.png', exact=True).click()
    assert authoring_state(page) == before, 'browsing changed generation authoring'
    preview = page.locator('[data-browsed-preview]')
    # The control toolbar rides the stage header as a direct stage child (user contract).
    preview_tools = page.locator('.wb-stage > [data-media-tools]')
    expect(preview_tools.get_by_role('button', name='Star fixture.png', exact=True)).to_be_enabled()
    image = preview.locator('img')
    expect(image).to_be_visible()
    page.wait_for_function('()=>document.querySelector("[data-browsed-preview] img").naturalWidth>0')
    results = [bottom_bounds(page, 'browsed-image', width)]
    page.get_by_label('Fixture language', exact=True).select_option('de')
    expect(preview_tools.locator('[data-use-input]')).to_have_text('Als Eingabe verwenden')
    translated = bottom_bounds(page, 'browsed-image-German', width)
    if width == 390:
        assert len(translated['rows']) > 1, ('longer German controls must wrap', translated)
    results.append(translated)
    page.get_by_label('Fixture language', exact=True).select_option('en')
    box = image.bounding_box()
    # The square fixture has letterbox margins only in a nonsquare slot.
    # The narrow slot can itself be square, so exercise its image click below.
    if abs(box['width']-box['height']) > 4:
        image.click(position={'x':1 if box['width']>box['height'] else box['width']/2,'y':box['height']/2 if box['width']>box['height'] else 1})
        expect(page.locator('.wb-viewer')).to_have_count(0)
    image.click()
    expect(page.get_by_role('dialog', name='fixture.png', exact=True)).to_be_visible()
    page.keyboard.press('Escape')
    preview_tools.locator('[data-use-input]').press('Enter')
    editor = page.locator('[data-editor-viewport]')
    expect(editor).to_be_visible()
    results.append(bottom_bounds(page, 'adopted-image', width))
    page.get_by_role('button', name='Select', exact=True).click()
    base = page.locator('[data-layer="base"]')
    base.focus()
    base.press('ArrowLeft')
    assert base.evaluate('e=>e.style.left') == '-8px'
    page.evaluate('window.__EDITOR__=document.querySelector("[data-editor-viewport]")')
    toolbar = page.get_by_role('toolbar', name='Edit image')
    toolbar.get_by_role('button', name='Star fixture.png', exact=True).click()
    page.wait_for_function('()=>document.querySelector("[data-layer=base] img").src.includes("/starred/image/2026-10-19/fixture.png")')
    retained_geometry(page, editor, base)
    expect(page.locator('[data-browsed-preview]')).to_have_count(0)
    expect(toolbar.get_by_role('button', name='Unstar fixture.png', exact=True)).to_be_enabled()
    # No Full view button anymore: the media label in the view opens the viewer (user contract).
    page.locator('[data-editor-caption]').click()
    viewer = page.get_by_role('dialog', name='fixture.png', exact=True)
    expect(viewer.get_by_role('button', name='Unstar fixture.png', exact=True)).to_be_enabled()
    assert viewer.locator('img').get_attribute('src').endswith('/starred/image/2026-10-19/fixture.png')
    page.screenshot(path=str(OUT/f'starred-editor-viewer-{width}.png'))
    page.keyboard.press('Escape')
    toolbar.get_by_role('button', name='Unstar fixture.png', exact=True).click()
    page.wait_for_function('()=>document.querySelector("[data-layer=base] img").src.endsWith("/output/raw/image/2026-10-19/fixture.png")')
    retained_geometry(page, editor, base)
    expect(toolbar.get_by_role('button', name='Star fixture.png', exact=True)).to_be_enabled()
    page.locator('[data-editor-caption]').click()
    viewer = page.get_by_role('dialog', name='fixture.png', exact=True)
    expect(viewer.get_by_role('button', name='Star fixture.png', exact=True)).to_be_enabled()
    assert viewer.locator('img').get_attribute('src').endswith('/output/raw/image/2026-10-19/fixture.png')
    assert page.evaluate('window.__calls.filter(c=>c.command==="native_media_unstar").length') == 1
    assert page.evaluate('window.__calls.find(c=>c.command==="native_media_unstar").args.path') == '/env/ComfyUI/output/starred/image/2026-10-19/fixture.png'
    page.screenshot(path=str(OUT/f'unstarred-editor-viewer-{width}.png'))
    page.keyboard.press('Escape')
    # Preview another media kind without changing the retained editor/draft.
    before = authoring_state(page)
    page.locator('.media-list').get_by_role('button', name='clip.webm', exact=True).click()
    assert authoring_state(page) == before, 'video browsing changed generation authoring'
    expect(editor).not_to_be_visible()
    expect(preview.locator('[data-edit], [data-view-full], [data-edit-last]')).to_have_count(0)
    expect(preview.locator('[data-use-input]')).to_have_count(1)
    player = preview.locator('[data-native-video]')
    expect(player).to_be_visible()
    results.append(bottom_bounds(page, 'browsed-video', width))
    play = player.locator('.native-video-controls button').first
    expect(play).to_be_enabled()
    play.press('Enter')
    page.wait_for_function('__calls.some(c=>c.command==="native_video_update"&&c.args.action.kind==="pause"&&c.args.action.paused===false)')
    page.locator('[data-preview-close]').click()
    retained_geometry(page, editor, base)
    results.append(bottom_bounds(page, 'retained-after-video-browse', width))
    # A pre-existing multi-output job keeps its captured root and Star mapping.
    page.locator('[data-job-id="u02-results"] .wb-queue-select').first.click()
    expect(editor).not_to_be_visible()
    result = page.locator('.wb-shown .media-preview')
    expect(result.locator('[data-media-content] img')).to_have_count(2)
    results.append(bottom_bounds(page, 'multi-output-result', width))
    stars = result.locator('.wb-output-stars')
    expect(stars.locator('button')).to_have_count(2)
    for name in ('result-A.png', 'result-B.png'):
        expect(stars.get_by_role('button', name='Star '+name, exact=True)).to_be_enabled()
        stars.get_by_role('button', name='Star '+name, exact=True).click()
        expect(stars.get_by_role('button', name='Unstar '+name, exact=True)).to_be_enabled()
        assert page.evaluate('(path)=>__calls.some(c=>c.command==="native_media_star"&&c.args.path===path)', '/captured/old/output/raw/original/'+name)
    assert not page.evaluate('__calls.some(c=>c.command==="native_media_star"&&c.args.path.startsWith("/env/ComfyUI/output/")&&c.args.path.includes("result-"))'), 'output Star rebased onto current environment'
    page.locator('[data-editor-return]').click()
    retained_geometry(page, editor, base)
    results.append(bottom_bounds(page, 'retained-after-result', width))
    # Last frame is image-only and needs the existing supported video family.
    page.locator('.wb-pipeline select').select_option('i2v')
    last = page.locator('.wb-stage [data-media-tools]:visible [data-edit-last]')
    expect(last).to_be_enabled()
    last.click()
    expect(last).to_have_attribute('aria-pressed', 'true')
    results.append(bottom_bounds(page, 'image-last-frame-eligible', width))
    page.locator('.media-list').get_by_role('button', name='clip.webm', exact=True).click()
    expect(preview.locator('[data-edit], [data-view-full], [data-edit-last]')).to_have_count(0)
    preview.locator('[data-use-input]').click()
    expect(page.locator('.wb-stage [data-native-video]:visible')).to_have_count(1)
    expect(page.locator('.wb-stage [data-media-tools]:visible [data-edit], .wb-stage [data-media-tools]:visible [data-view-full], .wb-stage [data-media-tools]:visible [data-edit-last]')).to_have_count(0)
    results.append(bottom_bounds(page, 'adopted-video', width, minimum_actions=1))
    assert not page.evaluate('window.__calls.some(c=>/native_job_prepare|native_job_submit|native_workbench_run|native_input_upload|native_mask_upload/.test(c.command))')
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
    (OUT/'results.json').write_text(json.dumps({'cases': results, 'editorPreserved': True, 'geometryPreserved': True, 'viewerPathUpdated': True, 'unstarPreservesNamedRawPath': True, 'multiOutputIdentityPreserved': True, 'fixtureOnly': True}, indent=2)+'\n')
    print(f'PASS: {len(results)} rendered-bound states at 1440/390 px; bottom controls, German wrapping, keyboard focus, image/video eligibility, multi-output Star provenance and retained editor geometry; no generation/upload (simulated IPC).')


if __name__ == '__main__':
    main()
