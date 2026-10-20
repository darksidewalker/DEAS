"""Continuity overlay: real Chromium interaction, mocked IPC, no generation."""
from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:1422').rstrip('/')
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'artifacts/verification/continuity'
INIT = r"""
localStorage.clear(); localStorage.setItem('deas.locale.v1', LOCALE);
localStorage.setItem('deas.pref.studio.run.pipeline', JSON.stringify('t2v'));
localStorage.setItem('deas.pref.studio.dock.tab', JSON.stringify('continuity'));
localStorage.setItem('deas.pref.studio.run.continuity', JSON.stringify({session:'fixture-session',outputMode:'segment',steps:[{id:'one',seconds:5,action:'',clipId:'old-root',jobId:'old-job'},{id:'two',seconds:6,action:'turn around'}]}));
window.isTauri=true; window.__calls=[]; window.__unexpected=[]; window.__forge=[];
let callback=0;
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>++callback,
 convertFileSrc:path=>path,
 invoke:async(command,args={})=>{
  window.__calls.push({command,args});
  if(command==='plugin:event|listen')return ++callback;
  if(command==='plugin:event|unlisten')return null;
  if(command==='native_media_list')return {path:args.path,parent:null,entries:[],truncated:false};
  if(command==='native_recipe_prerequisites')return {baseUrl:args.baseUrl,recipeId:'checkpoint-text-to-image-diagnostic',version:1,missingNodes:[],generationReady:false,allowlist:{nodes:[],checkpoints:[],loras:[],samplers:['euler'],schedulers:['simple']}};
  if(command==='native_forge'){
   if(args.route==='models')return {models:[{id:'fixture-vision',label:'Fixture vision'}],errors:{},creativity:Array(10).fill('Grounded'),shot_counts:['Auto'],default_shots:'Auto'};
   if(args.route==='h3'&&args.body.continuity){window.__forge.push(structuredClone(args.body));return {simple_prompt:'Fixture next action.',continuity:true,source_kind:args.body.continuity.source_kind,warnings:[]};}
   if(args.route==='cancel')return {cancelled:true};
  }
  if(command==='native_h3_video_upload')return 'deas-input-fixture.mp4';
  if(command==='native_h3_video_prepare')return {sourceId:'a'.repeat(64),filename:args.filename,sha256:'b'.repeat(64),width:1920,height:1080,fps:24,seconds:8,hasAudio:true};
  if(command==='native_h3_session')return {latestId:'newest-root',clips:[{clipId:'older-root',parent:null,frames:124,completed:1,export:null},{clipId:'newest-root',parent:null,frames:124,completed:2,export:null}]};
  if(command==='native_models_scan')return [
   {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/h3.safetensors',size:1,info:null,family:'minimax-h3'},
   {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
   {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
   {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}];
  window.__unexpected.push(command);throw Error('Unexpected IPC '+command);
 }};
"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for locale in ['en', 'de', 'fr', 'tr', 'ja', 'zh']:
            for width, source_kind in [(w,k) for w in [1440,1100,320] for k in ['checkpoint','video','local-video']]:
                context = browser.new_context(viewport={'width': width, 'height': 1000})
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.add_init_script(INIT.replace('LOCALE', json.dumps(locale)))
                page.goto(URL + '/tools/inpaint-fixture.html', wait_until='networkidle')
                opener = page.locator('[data-continuity-open]')
                expect(opener).to_be_visible()
                expect(page.locator('[data-dock-tab="continuity"]')).to_have_count(0)
                expect(page.locator('[data-dock-tab="media"]')).to_have_attribute('aria-selected', 'true')
                opener.click()
                dialog = page.get_by_role('dialog')
                expect(dialog).to_be_visible()
                assert dialog.evaluate('(d)=>d.matches(":modal")'), 'Not a native modal'
                overlap = dialog.locator('[data-cont-overlap]')
                expect(overlap).to_have_value('22')
                assert overlap.locator('option').evaluate_all('(options)=>options.map(o=>o.value)') == ['73', '56', '39', '22', '5']
                overlap.select_option('56')
                assert page.evaluate('JSON.parse(localStorage.getItem("deas.pref.studio.run.continuity")).overlapFrames') == 56
                session = dialog.locator('[data-cont-session]')
                session.fill('Named_session-1')
                assert page.evaluate('JSON.parse(localStorage.getItem("deas.pref.studio.run.continuity")).session') == 'fixture-session'
                dialog.locator('[data-cont-session-apply]').click()
                saved = page.evaluate('JSON.parse(localStorage.getItem("deas.pref.studio.run.continuity"))')
                assert saved['session'] == 'Named_session-1' and saved['overlapFrames'] == 56
                assert len(saved['steps']) == 2 and all('clipId' not in x and 'jobId' not in x for x in saved['steps'])
                assert not page.evaluate('window.__calls.some(x=>x.command==="native_h3_session")'), 'Session was read implicitly'
                if source_kind=='checkpoint':
                    selected_id='older-root'
                    dialog.locator('[data-cont-load-sources]').click()
                    source = dialog.locator('[data-cont-source]')
                    expect(source.locator('option[value="older-root"]')).to_have_count(1)
                    expect(source).to_have_value('')
                    source.select_option(selected_id)
                else:
                    selected_id='a'*64
                    if source_kind=='local-video':
                        dialog.locator('[data-cont-video-upload]').click()
                        expect(dialog.locator('[data-cont-video-filename]')).to_have_value('deas-input-fixture.mp4')
                        assert not page.evaluate('window.__calls.some(x=>x.command==="native_h3_video_prepare")'), 'Upload prepared implicitly'
                        assert not page.evaluate('JSON.parse(localStorage.getItem("deas.pref.studio.run.continuity")).source'), 'Upload selected implicitly'
                    else:
                        dialog.locator('[data-cont-video-filename]').fill('clips/source.mp4')
                    dialog.locator('[data-cont-video-prepare]').click()
                    expect(dialog.locator('[data-cont-video-use]')).to_be_enabled()
                    assert not page.evaluate('JSON.parse(localStorage.getItem("deas.pref.studio.run.continuity")).source'), 'Preparation selected a source implicitly'
                    dialog.locator('[data-cont-video-use]').click()
                    assert page.evaluate('window.__calls.filter(x=>x.command==="native_h3_video_prepare").length') == 1
                saved = page.evaluate('JSON.parse(localStorage.getItem("deas.pref.studio.run.continuity"))')
                expected_source={'clipId':selected_id,'endpoint':'http://127.0.0.1:7801'}
                if source_kind!='checkpoint':
                    expected_source['kind']='video'
                assert saved['source'] == expected_source
                action = dialog.locator('.wb-cont-action textarea').nth(1)
                action.fill('fixture edited action')
                forge_open = dialog.locator('.wb-cont-action [data-forge-open]')
                expect(forge_open).to_have_count(1)
                assert forge_open.evaluate('(el)=>{const r=el.getBoundingClientRect(),p=el.closest(".wb-cont-action").getBoundingClientRect();return r.x>=p.x&&r.right<=p.right+1&&r.y>=p.y&&r.bottom<=p.bottom+1;}'), 'Forge hammer escaped its owning step'
                forge_open.click()
                forge = dialog.locator('.forge-pop')
                forge.locator('[data-forge-brief]').fill('turn left')
                forge.locator('[data-forge-write]').click()
                expect(forge.locator('[data-forge-result]')).to_have_value('Fixture next action.')
                assert page.evaluate('JSON.parse(localStorage.getItem("deas.pref.studio.run.continuity")).steps[0].action') == ''
                request = page.evaluate('window.__forge.at(-1)')
                assert request['continuity'] == {'source_kind':'checkpoint' if source_kind=='checkpoint' else 'video','session':'Named_session-1','clip_id':selected_id,'overlap_frames':56,'current_prompt':'','use_references':False}
                assert request['duration'] == 5 and request['references'] == []
                rect = forge.evaluate('(el)=>{const r=el.getBoundingClientRect();return {x:r.x,right:r.right,top:r.top,bottom:r.bottom,overflow:el.scrollWidth-el.clientWidth};}')
                assert rect['x'] >= 0 and rect['right'] <= width + 1 and rect['top'] >= 0 and rect['bottom'] <= 1001 and rect['overflow'] <= 1, rect
                if locale in ['en','de']:
                    page.screenshot(path=str(OUT / f'next-action-{source_kind}-{locale}-{width}.png'))
                forge.locator('[data-forge-brief]').focus()
                page.keyboard.press('Escape')
                expect(forge).to_have_count(0)
                expect(dialog).to_be_visible()
                forge_open.click()
                forge.locator('[data-forge-draft="1"]').click()
                forge.locator('[data-forge-apply]').click()
                expect(forge).to_have_count(0)
                applied = page.evaluate('JSON.parse(localStorage.getItem("deas.pref.studio.run.continuity"))')
                assert applied['steps'][0]['action'] == 'Fixture next action.' and applied['steps'][1]['action'] == 'fixture edited action'
                # Chromium may focus browser chrome (body active); background app controls stay inert.
                opener.evaluate('(el)=>el.focus()')
                assert dialog.evaluate('(d)=>d.contains(document.activeElement)'), 'Background accepted focus'
                for _ in range(24):
                    page.keyboard.press('Tab')
                    assert dialog.evaluate('(d)=>d.contains(document.activeElement)||document.activeElement===document.body'), 'Focus reached background UI'
                geometry = dialog.evaluate('(d)=>{const r=d.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:d.scrollWidth-d.clientWidth};}')
                assert geometry['left'] >= 0 and geometry['right'] <= width + 1, geometry
                assert geometry['top'] >= 0 and geometry['bottom'] <= 1001, geometry
                assert geometry['overflow'] <= 1, geometry
                assert dialog.locator('.continuity-overlay-body').evaluate('(el)=>el.scrollWidth-el.clientWidth<=1'), 'Modal body overflows horizontally'
                if locale in ['en', 'de']:
                    page.screenshot(path=str(OUT / f'continuity-{source_kind}-{locale}-{width}.png'))
                page.keyboard.press('Escape')
                expect(dialog).to_have_count(0)
                expect(opener).to_be_focused()
                opener.click()
                expect(page.get_by_role('dialog').locator('.wb-cont-action textarea').nth(1)).to_have_value('fixture edited action')
                expect(page.get_by_role('dialog').locator('[data-cont-overlap]')).to_have_value('56')
                expect(page.get_by_role('dialog').locator('[data-cont-session]')).to_have_value('Named_session-1')
                expect(page.get_by_role('dialog').locator('[data-cont-source]')).to_have_value('older-root' if source_kind=='checkpoint' else '')
                if source_kind!='checkpoint':
                    expect(page.get_by_role('dialog').locator('[data-cont-selected-video]')).to_contain_text(selected_id)
                page.get_by_role('dialog').locator('header button').click()
                expect(page.get_by_role('dialog')).to_have_count(0)
                expect(opener).to_be_focused()
                uploads=page.evaluate('window.__calls.filter(x=>x.command==="native_h3_video_upload")')
                assert len(uploads) == (1 if source_kind=='local-video' else 0), uploads
                if uploads:
                    assert uploads[0]['args']['baseUrl'] == 'http://127.0.0.1:7801'
                assert not page.evaluate('window.__unexpected'), page.evaluate('window.__unexpected')
                assert not page.evaluate('window.__calls.some(x=>/native_job_/.test(x.command))'), 'Opening/closing executed a job'
                assert page.evaluate('window.__calls.filter(x=>x.command==="native_h3_session").length') == (1 if source_kind=='checkpoint' else 0), 'Unexpected automatic session read'
                assert not errors, errors
                results.append({'locale': locale, 'width': width, 'sourceKind':source_kind, 'modal': True, 'focus': True, 'draftRetained': True, 'nextActionApplied': True, 'nestedEscape': True})
                context.close()
        browser.close()
    (OUT / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(f'PASS: {len(results)} Chromium locale/viewport cases; explicit checkpoint/backend-video/local-upload flows, no generation IPC. Evidence: {OUT}')


if __name__ == '__main__':
    main()
