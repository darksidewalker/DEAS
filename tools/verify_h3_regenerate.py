"""Regenerate overlay: real Chromium geometry; synthetic read-only IPC, no models/backend.

Run: uv run --no-project --with playwright==1.64.1 python tools/verify_h3_regenerate.py
"""
import json
from playwright.sync_api import expect
import verify_continuity as continuity
import verify_postprocessing as runner

FIXTURE = continuity.INIT + r"""
localStorage.setItem('deas.pref.studio.dock.tab',JSON.stringify('post'));
localStorage.setItem('deas.pref.studio.run.regenerate.h3',JSON.stringify({enabled:true,lora:'regenerate_'+ 'long_name_'.repeat(30)+'.safetensors',target:'2K',model:'minimax_h3_latent_upscaler_3d_conv_'+ 'long_name_'.repeat(30)+'.safetensors',spatialTiling:true}));
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
const previousInvoke=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
 if(command==='native_audio_enhance_install_status')return {running:false,mode:'',stage:'',downloaded:0,total:0};
 if(command==='native_recipe_prerequisites'){
  __calls.push({command,args});
  const p=JSON.parse(localStorage.getItem('deas.pref.studio.run.regenerate.h3'));
  return {baseUrl:args.baseUrl,recipeId:'checkpoint-text-to-image-diagnostic',version:1,missingNodes:[],generationReady:false,allowlist:{nodes:['UNETLoader','DEAS_VideoPostprocessGate','DaSiWaH3HiResRegenerate'],diffusionModels:['MiniMaxH3/h3.safetensors'],checkpoints:[],loras:[p.lora],h3LatentUpscaleModels:['minimax_h3_latent_upscaler_3d_conv_installed.safetensors'],h3RegenerateOriginal:true,samplers:['euler'],schedulers:['simple']}};
 }
 return previousInvoke(command,args);
};
"""

GEOMETRY = r"""()=>{
 const overlay=document.querySelector('.wb-post-overlay'),body=overlay.querySelector('.wb-post-overlay-body');
 const box=overlay.getBoundingClientRect();
 const controls=[...overlay.querySelectorAll('select,input,button')].filter(e=>e.getClientRects().length).map(e=>{
  const r=e.getBoundingClientRect();return {tag:e.tagName,left:r.left,right:r.right,width:r.width};
 });
 return {viewport:innerWidth,left:box.left,right:box.right,top:box.top,bottom:box.bottom,height:innerHeight,client:body.clientWidth,scroll:body.scrollWidth,vertical:body.scrollHeight>body.clientHeight,overflow:getComputedStyle(body).overflowY,controls};
}"""


def verify(browser, url, shots):
    checks = []
    for locale in ('en', 'de', 'fr', 'ja', 'tr', 'zh'):
        context = browser.new_context(viewport={'width':1440,'height':960}, reduced_motion='reduce')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(FIXTURE.replace('LOCALE', json.dumps(locale)))
        try:
            page.goto(url+'/tools/inpaint-fixture.html', wait_until='networkidle')
            page.locator('[data-dock-tab="post"]').click()
            page.locator('[data-post-card="regenerate"]').click()
            overlay = page.locator('[data-post-overlay="regenerate"]')
            expect(overlay).to_be_visible()
            for width, height in ((1440,960),(390,844),(320,480)):
                page.set_viewport_size({'width':width,'height':height})
                for target in ('2K','Original'):
                    page.locator('[data-regenerate-target]').select_option(target)
                    g = page.evaluate(GEOMETRY)
                    print(json.dumps({'locale':locale,'target':target,'geometry':g}), flush=True)
                    assert g['scroll'] <= g['client']+1, ('overlay horizontal overflow',locale,target,g)
                    assert g['left'] >= 0 and g['right'] <= width+1, g
                    assert g['top'] >= 0 and g['bottom'] <= height+1, g
                    assert g['overflow'] == 'auto', 'keep accessible viewport scrolling'
                    for control in g['controls']:
                        assert control['width'] > 0 and control['left'] >= g['left'] and control['right'] <= g['right'], control
                    if target == 'Original':
                        expect(page.locator('[data-regenerate-model]')).to_have_count(0)
                    else:
                        expect(page.locator('[data-regenerate-model]')).to_be_visible()
                    if locale in ('en','de'):
                        page.screenshot(path=str(shots/f'regenerate-{locale}-{width}-{target}.png'))
                    if g['vertical']:
                        body = overlay.locator('.wb-post-overlay-body')
                        body.hover()
                        page.mouse.wheel(0,1000)
                        page.wait_for_timeout(80)
                        assert body.evaluate('e=>e.scrollTop') > 0, 'wheel must retain access'
                        tiling = page.locator('[data-regenerate-tiling]')
                        tiling.focus()
                        assert tiling.evaluate('e=>e===document.activeElement')
                        before = tiling.is_checked()
                        page.keyboard.press('Space')
                        assert tiling.is_checked() != before, 'keyboard controls remain reachable'
                    checks.append({'locale':locale,'width':width,'target':target,'geometry':g})
            assert not errors, errors
            assert page.evaluate('__unexpected') == [], page.evaluate('__unexpected')
            assert not page.evaluate('__calls.some(c=>/(_run|_submit|_upload|_prepare)$/.test(c.command))')
        finally:
            context.close()
    result={'status':'PASS','checksPassed':len(checks),'kind':'Chromium geometry; synthetic IPC only','screenshots':str(shots),'checks':checks}
    (shots/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='checks'}))


if __name__ == '__main__':
    runner.verify = verify
    runner.main()
