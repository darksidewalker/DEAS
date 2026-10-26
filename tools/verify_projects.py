"""Real Chromium project-draft interaction with mocked IPC; no native/model acceptance."""
from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4177').rstrip('/')
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'artifacts/verification/projects'
INIT = r"""
localStorage.clear();localStorage.setItem('deas.locale.v1',LOCALE);
localStorage.setItem('deas.pref.studio.run.positive',JSON.stringify('global draft'));
window.isTauri=true;window.__calls=[];window.__unexpected=[];window.__callbacks={};window.__closeHandler=null;
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
let callback=0;
const draft={positivePrompt:'saved project',negativePrompt:'',checkpoint:'sdxl.safetensors',width:1024,height:1024,steps:20,cfg:5,sampler:'euler',scheduler:'normal',seed:42,denoise:0.6,pipeline:'t2i'};
let saved={id:'fixture-project',root:'/projects/fixture',revision:1,draft,input:null};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:handler=>{window.__callbacks[++callback]=handler;return callback;},unregisterCallback:id=>delete window.__callbacks[id],convertFileSrc:path=>path,
 invoke:async(command,args={})=>{
 window.__calls.push({command,args});
 if(command==='plugin:event|listen'){if(args.event==='tauri://close-requested')window.__closeHandler=args.handler;return ++callback;}
 if(command==='plugin:window|destroy'||command==='native_project_close_notice')return null;
 if(command==='plugin:event|unlisten')return null;
 if(command==='native_workbench_current')return {jobs:[],preparing:0,capacity:20,stopAvailable:false};
 if(command==='native_media_list')return {path:args.path,parent:null,entries:[],truncated:false};
 if(command==='native_models_scan')return [{category:'checkpoints',name:'sdxl.safetensors',family:'sdxl',path:'/m/sdxl.safetensors',size:1,info:null}];
 if(command==='native_recipe_prerequisites')return {baseUrl:args.baseUrl,recipeId:'checkpoint-text-to-image-diagnostic',version:1,missingNodes:[],generationReady:false,allowlist:{nodes:[],checkpoints:['sdxl.safetensors'],loras:[],samplers:['euler'],schedulers:['normal']}};
 if(command==='native_project_open'||command==='native_project_import_package')return structuredClone(saved);
 if(command==='native_project_export_package')return true;
 if(command==='native_project_close')return null;
 if(command==='native_project_save'){
  if(args.projectId!==saved.id||args.expectedRevision!==saved.revision)throw Error('Stale project revision');
  saved={...saved,revision:saved.revision+1,draft:structuredClone(args.draft)};return structuredClone(saved);
 }
 window.__unexpected.push(command);throw Error('Unexpected IPC '+command);
 }};
"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for locale in ['en', 'de', 'fr', 'ja', 'tr', 'zh']:
            for width in [1440, 960, 320]:
                context = browser.new_context(viewport={'width': width, 'height': 1000})
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.add_init_script(INIT.replace('LOCALE', json.dumps(locale)))
                page.goto(URL + '/tools/inpaint-fixture.html', wait_until='networkidle')
                menu = page.locator('.project-menu')
                summary = menu.locator('summary')
                expect(menu).not_to_have_attribute('open', '')
                summary.click()
                opener = page.locator('[data-project-open]')
                expect(opener).to_be_enabled()
                opener.click()
                prompt = page.locator('#run-positive')
                expect(prompt).to_have_value('saved project')
                assert not page.evaluate('window.__calls.some(c=>/native_job_submit|native_workbench_run|native_input_upload|native_mask_upload/.test(c.command))')
                prompt.fill('edited project')
                page.wait_for_function('window.__closeHandler!==null')
                page.evaluate("window.__callbacks[window.__closeHandler]({event:'tauri://close-requested',id:1,payload:null})")
                page.wait_for_function("window.__calls.some(c=>c.command==='native_project_close_notice'&&c.args.reason==='blocked')")
                assert not page.evaluate("window.__calls.some(c=>c.command==='plugin:window|destroy')")
                page.wait_for_function("window.__calls.some(c=>c.command==='native_project_save'&&c.args.draft.positivePrompt==='edited project')")
                if not menu.evaluate('(e)=>e.open'):
                    summary.click()
                close = page.locator('[data-project-close]')
                expect(close).to_be_enabled()
                page.evaluate("window.__callbacks[window.__closeHandler]({event:'tauri://close-requested',id:1,payload:null})")
                page.wait_for_function("window.__calls.some(c=>c.command==='plugin:window|destroy')")
                close.click()
                expect(prompt).to_have_value('global draft')
                assert page.evaluate("JSON.parse(localStorage.getItem('deas.pref.studio.run.positive'))") == 'global draft'
                opener.click()
                expect(prompt).to_have_value('edited project')
                page.locator('[data-project-package-export]').click()
                page.wait_for_function("window.__calls.some(c=>c.command==='native_project_export_package')")
                page.locator('[data-project-package-import]').click()
                page.wait_for_function("window.__calls.some(c=>c.command==='native_project_import_package')")
                expect(prompt).to_have_value('edited project')
                bar = page.locator('.project-bar')
                # Test the project controls, not the pre-existing full Workbench's narrow-layout backlog.
                assert bar.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1'), f'Project bar overflow: {locale}/{width}'
                menu.press('Escape')
                expect(page.locator('[data-project-open]')).not_to_be_visible()
                page.screenshot(path=str(OUT / f'{locale}-{width}.png'))
                assert not errors, errors
                assert not page.evaluate('window.__unexpected'), page.evaluate('window.__unexpected')
                calls = page.evaluate('window.__calls')
                assert not any(c['command'] in ['native_job_submit', 'native_workbench_run', 'native_input_upload', 'native_mask_upload'] for c in calls)
                results.append({'locale': locale, 'width': width, 'autosaves': sum(c['command'] == 'native_project_save' for c in calls)})
                context.close()
        browser.close()
    (OUT / 'results.json').write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')
    print(f'PASS: {len(results)} Chromium locale/viewport cases; close blocked before save, allowed after save, draft reopen, global preservation and no execution/upload.')


if __name__ == '__main__':
    main()
