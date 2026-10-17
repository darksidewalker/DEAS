"""Studio workbench: browser IPC fixtures only (models, LoRAs, one fake job), not generation acceptance."""
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright
from deas_locale import set_locale

root = Path(__file__).resolve().parents[1]
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:1420'
# A 1x1 PNG served for the fake output file so the preview and queue thumbnail render.
fixture = r"""window.isTauri=true; window.__calls=[]; window.__polls=0;
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO8+e7HfwAJHgPpUpmX6wAAAABJRU5ErkJggg==';
window.__TAURI_INTERNALS__={convertFileSrc:(p)=>png,invoke:async(command,args)=>{
window.__calls.push({command,args});
if(command==='native_media_list') return {path:args.path||'/home/u',parent:null,entries:[{name:'DEAS_0001.png',path:'/env/out/DEAS_0001.png',kind:'file',symlink:false,media:'image',size:1,modified:5}],truncated:false};
if(command==='native_recipe_prerequisites') return {baseUrl:args.baseUrl.replace(/\/$/,'')+'/',recipeId:'checkpoint-text-to-image-diagnostic',version:1,
 allowlist:{nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage'],checkpoints:['sdxl/juggernaut.safetensors','anima/anima-preview.safetensors'],loras:['style/film-grain.safetensors','detail/add-detail-xl.safetensors'],samplers:['euler','dpmpp_2m'],schedulers:['normal','karras']},missingNodes:[],generationReady:false};
if(command==='native_job_prepare') return {id:'fixture-plan',baseUrl:args.baseUrl,intent:args.intent,graph:{},generationReady:false};
if(command==='native_job_submit') return {id:'fixture-job-1',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false};
if(command==='native_job_status') return {id:'fixture-job-1',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:++window.__polls<2?'running':'succeeded',outputs:window.__polls<2?[]:[{filename:'DEAS_00001_.png',subfolder:'',type:'output'}],error:null,generationReady:false};
if(command==='native_job_output') return {jobId:args.jobId,index:args.index,mimeType:'image/png',width:1,height:1,sha256:'0'.repeat(64),bytes:Array.from(atob(png.split(',')[1]),c=>c.charCodeAt(0))};
if(command==='native_auth_status'||command==='native_install_defaults'||command==='native_repo_stars') return command==='native_auth_status'?[]:command==='native_repo_stars'?{count:0,starred:null}:{storagePath:'/env',backend:'cpu',warnings:[]};
throw Error('Unexpected command '+command);
}};"""
with sync_playwright() as p:
    browser = p.chromium.launch()
    for width in (1440, 1024, 768, 390, 320):
        page = browser.new_page(viewport={'width': width, 'height': 960}, reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(fixture)
        page.goto(url, wait_until='networkidle')
        set_locale(page, 'en')
        page.locator('[data-node="studio"]').click()
        page.locator('[data-studio-tab="generate"]').click()
        wb = page.locator('[data-workbench]')
        wb.wait_for()
        assert page.evaluate("__calls.filter(x=>x.command==='native_recipe_prerequisites').length") == 0, 'no auto-inspection'
        page.locator('[data-dock-tab="models"]').click()
        wb.locator('[data-run-load]').click()  # no environment in this fixture: backend fallback list
        page.locator('[data-run-checkpoint]').wait_for()
        page.locator('[data-dock-tab="loras"]').click()
        page.get_by_role('button', name='style/film-grain.safetensors').click()
        page.locator('[data-dock-tab="media"]').click()
        assert wb.get_by_role('combobox', name='Aspect ratio', exact=True).locator('option[value=auto]').count() == 0
        assert wb.get_by_role('combobox', name='Resolution', exact=True).locator('option[value=auto]').count() == 0
        assert wb.locator('.wb-resolution-summary').count() == 0
        assert wb.locator('.wb-aspect-picker .wb-aspect-swatch').count() == 1
        wb.get_by_role('combobox', name='Aspect ratio', exact=True).select_option('16:9')
        wb.get_by_role('combobox', name='Resolution', exact=True).select_option('4K')
        assert int(wb.get_by_label('Width', exact=True).input_value()) > 2048
        wb.get_by_role('combobox', name='Aspect ratio', exact=True).select_option('custom')
        wb.get_by_label('Aspect width', exact=True).fill('2')
        wb.get_by_label('Aspect height', exact=True).fill('3')
        wb.get_by_role('combobox', name='Resolution', exact=True).select_option('custom')
        wb.get_by_label('Megapixels', exact=True).fill('1.2')
        assert int(wb.get_by_label('Height', exact=True).input_value()) > int(wb.get_by_label('Width', exact=True).input_value())
        assert wb.get_by_role('combobox', name='Aspect ratio', exact=True).locator('option[value=auto]').count() == 0
        assert wb.get_by_role('combobox', name='Resolution', exact=True).locator('option[value=auto]').count() == 0
        assert wb.locator('.wb-resolution-summary').count() == 0
        assert wb.locator('.wb-aspect-picker .wb-aspect-swatch').count() == 1
        wb.get_by_role('combobox', name='Aspect ratio', exact=True).select_option('16:9')
        wb.get_by_role('combobox', name='Resolution', exact=True).select_option('720p')
        page.locator('[data-run-positive]').fill('A copper-lit forest at dusk, 35mm film')
        page.locator('[data-run-negative]').fill('blurry, text')
        for locale in ('de', 'en', 'fr', 'ja', 'tr', 'zh'):
            set_locale(page, locale, '[data-node="studio"]')
            page.locator('[data-studio-tab="generate"]').click()
            assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'), (width, locale)
            if width >= 1024:
                assert not page.evaluate('document.documentElement.scrollHeight>innerHeight+1'), ('vertical scrollbar', width, locale)
        set_locale(page, 'en', '[data-node="studio"]')
        page.locator('[data-studio-tab="generate"]').click()
        page.locator('[data-run]').click()
        page.wait_for_function("window.__calls.some(x=>x.command==='native_job_submit')")
        intent = page.evaluate("__calls.find(x=>x.command==='native_job_prepare').args.intent")
        assert intent['loras'] == [{'name': 'style/film-grain.safetensors', 'strength': 1}], intent
        page.wait_for_function("window.__polls>=2")
        page.locator('.wb-stage img').wait_for()  # native PNG transfer fallback: no environment is installed in this fixture
        if width == 1440:
            page.screenshot(path=str(root / 'assets' / 'deas-workbench-fixture-1440.png'), full_page=True)
        if width == 320:
            page.screenshot(path=str(root / 'assets' / 'deas-workbench-fixture-320.png'), full_page=True)
        assert not errors, errors
        page.close()
    browser.close()
print('workbench fixture ok')
