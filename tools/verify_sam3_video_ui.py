"""H3 SAM video-analysis browser acceptance; strict simulated IPC, no inference."""
import ast
import json
from pathlib import Path
import sys
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:1421').rstrip('/')
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home()/'.hermes/cache/scratch/deas-hf1-browser'
OUT.mkdir(parents=True, exist_ok=True)
module = ast.parse((ROOT/'tools/verify_inpaint.py').read_text())
INIT = next(ast.literal_eval(n.value) for n in module.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'INIT' for t in n.targets))
FIXTURE = r'''
Object.defineProperty(navigator,'userAgent',{value:'DEAS Windows browser fixture'});
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
window.__TAURI_INTERNALS__.convertFileSrc=path=>'http://asset.fixture/'+encodeURIComponent(path);
localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify('t2v'));
const samName='SAM3/sam3.1_multiplex_fp16.safetensors';
const videoNodes=['CheckpointLoaderSimple','CLIPTextEncode','LoadVideo','DEAS_SAM3VideoWindow','GetVideoComponents','SAM3_VideoTrack','SAM3_TrackToMask','MaskToImage','CreateVideo','SaveVideo','DEAS_SAM3ShotMask'];
const source={id:'source-video',baseUrl:'http://127.0.0.1:7801',promptId:'p',state:'succeeded',outputs:[{filename:'source.mp4',subfolder:'clips',type:'output',format:'video/mp4'}],outputRoot:'/out',error:null,generationReady:false};
window.__faceJobs=[source];window.__faceUploads=[];window.__facePlans=[];window.__faceAdapter=true;
const previous=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
 const note=()=>window.__calls.push({command,args:structuredClone(args)});
 if(command==='native_models_scan'){note();return [{category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/h3.safetensors',family:'minimax-h3',size:1,info:null}];}
 if(command==='native_recipe_prerequisites'){note();return {baseUrl:args.baseUrl,recipeId:'checkpoint-text-to-image-diagnostic',version:1,missingNodes:[],generationReady:false,allowlist:{nodes:videoNodes.filter(n=>window.__faceAdapter||n!=='DEAS_SAM3VideoWindow'),checkpoints:[samName],loras:[],samplers:['euler'],schedulers:['simple']}};}
 if(command==='native_workbench_current'||command==='native_workbench_poll'){note();return {jobs:structuredClone(window.__faceJobs),preparing:0,capacity:20,stopAvailable:true,admissionEpoch:0,stopping:false};}
 if(command==='native_media_list'){note();return {path:args.path,parent:'/',entries:[],truncated:false};}
 if(command==='native_media_star_status'){note();return {starred:false};}
 if(command==='native_media_star_notice'){note();return null;}
 if(command==='native_media_reference_thumbnail'){note();return null;}
 if(command==='native_wildcard_library'){note();return {categories:[]};}
 if(command==='native_audio_enhance_capabilities'){note();return {};}
 if(command==='native_audio_enhance_install_status'){note();return {running:false,mode:'',stage:'',downloaded:0,total:0};}
 if(command==='native_input_upload'){note();window.__faceUploads.push(structuredClone(args));if(window.__holdFaceUpload)await new Promise(resolve=>window.__releaseFaceUpload=resolve);return 'uploaded-face.mp4';}
 if(command==='native_workbench_run'){
  note();if(args.intent?.recipeId!=='sam3-video-mask')throw Error('unexpected generation');
  window.__facePlans.push(structuredClone(args.intent));
  const result={...source,id:'face-mask-result',intent:structuredClone(args.intent),outputs:[{filename:'face-mask.mp4',subfolder:'analysis',type:'output',format:'video/mp4',role:'mask-preview'}]};
  window.__faceJobs.push(result);return result;
 }
 return previous(command,args);
};
'''
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width':1440,'height':960}, reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script(INIT + '\n' + FIXTURE)
    page.goto(URL+'/tools/inpaint-fixture.html', wait_until='networkidle')
    page.locator('[data-dock-tab="post"]').click()
    page.locator('[data-post-card="face-analysis"]').click()
    group = page.locator('[data-post-group="face-analysis"]')
    expect(group).to_be_visible()
    expect(group.locator('[data-sam-video="source"]')).to_contain_text('source.mp4')
    button = group.locator('[data-sam-video="analyze"]')
    expect(button).to_be_enabled()
    cuts = group.locator('[data-sam-video="cuts"]')
    scene = group.locator('[data-sam-video="sceneThreshold"]')
    expect(cuts).not_to_be_checked()
    expect(scene).to_be_disabled()
    expect(scene).to_have_value('0.3')
    cuts.check()
    scene.fill('0')
    expect(button).to_be_disabled()
    scene.fill('0.3')
    cuts.uncheck()
    expect(button).to_be_enabled()
    assert page.evaluate('__faceUploads.length+__facePlans.length') == 0
    group.locator('[data-sam-video="startSeconds"]').fill('0.5')
    group.locator('[data-sam-video="durationSeconds"]').fill('1')
    page.evaluate('__holdFaceUpload=true')
    button.click()
    page.wait_for_function('__faceUploads.length===1')
    group.locator('[data-sam-video="durationSeconds"]').fill('8')
    group.locator('[data-sam-video="maxObjects"]').fill('12')
    page.evaluate('__releaseFaceUpload()')
    page.wait_for_function('__facePlans.length===1')
    intent = page.evaluate('__facePlans[0]')
    assert intent == {'recipeId':'sam3-video-mask','version':1,'checkpoint':'SAM3/sam3.1_multiplex_fp16.safetensors','sourceVideo':'uploaded-face.mp4','outputPrefix':'DEAS/SAM3/face-mask','threshold':0.5,'maxObjects':4,'detectInterval':1,'startSeconds':0.5,'durationSeconds':1}, intent
    assert page.evaluate('__faceUploads[0].path') == '/out/clips/source.mp4'
    expect(page.locator('[data-job-id="face-mask-result"]')).to_be_visible()
    expect(page.locator('.wb-shown video')).to_have_attribute('src', 'http://asset.fixture/%2Fout%2Fanalysis%2Fface-mask.mp4')
    page.locator('[data-more]').click()
    expect(page.locator('[data-more-apply]')).to_be_disabled()
    expect(page.locator('[data-more-reuse]')).to_be_disabled()
    page.locator('[data-more]').click()
    page.locator('[data-job-id="source-video"] .wb-queue-select').click()
    cuts.check()
    scene.fill('0.4')
    assert page.evaluate('__facePlans.length') == 1
    button.click()
    page.wait_for_function('__faceUploads.length===2')
    scene.fill('0.9')
    cuts.uncheck()
    page.evaluate('__releaseFaceUpload()')
    page.wait_for_function('__facePlans.length===2')
    assert page.evaluate('__facePlans[1].sceneThreshold') == 0.4
    assert 'sceneThreshold' not in page.evaluate('__facePlans[0]')
    for width in (1440,768,390):
        page.set_viewport_size({'width':width,'height':960})
        for locale in ('en','de','fr','ja','tr','zh'):
            page.get_by_role('combobox', name='Fixture language', exact=True).select_option(locale)
            group.locator('[data-sam-video="analyze"]').scroll_into_view_if_needed()
            assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'), (width,locale)
            bounds = cuts.bounding_box()
            assert bounds and 8 <= bounds['width'] <= 24 and 8 <= bounds['height'] <= 24, (width,locale,bounds)
        page.get_by_role('combobox', name='Fixture language', exact=True).select_option('en')
        page.screenshot(path=str(OUT/f'hf1-{width}.png'), full_page=True)
    assert page.evaluate('__facePlans.length') == 2
    assert not errors, errors
    assert page.evaluate('__unexpected') == [], page.evaluate('__unexpected')
    browser.close()
print(json.dumps({'status':'PASS','kind':'Chromium + strict simulated IPC; no native inference','checks':['explicit analysis','visible-source identity','immutable upload/settings/cut snapshot','default-OFF and explicit-ON payloads','invalid cut threshold','queue video preview','no metadata reuse','six locales/three widths','no implicit generation'],'screenshots':str(OUT)},indent=2))
