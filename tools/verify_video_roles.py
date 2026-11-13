"""Role-based Video: Chromium IPC fixtures, six locales, no generation or uploads."""
from pathlib import Path
import importlib.util
import json
import sys
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = sys.argv[1].rstrip('/')
OUT = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location('continuity_fixture', ROOT / 'tools/verify_continuity.py')
assert spec is not None and spec.loader is not None
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
INIT = fixture.INIT + r"""
localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({session:'roles',outputMode:'full',steps:[]}));
const originalInvoke=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
 if(command==='native_media_list')return {path:args.path,parent:null,entries:['frame.png','other.png','clip.mp4'].map(name=>({name,path:'/input/'+name,media:name.endsWith('.png')?'image':'video',kind:'file',symlink:false,size:100,modified:1})),truncated:false};
 if(command==='native_media_reference_thumbnail')return '/input/frame.png';
 if(command==='native_models_scan')return [
  {category:'diffusion_models',name:'h3.safetensors',path:'/m/h3',family:'minimax-h3',size:1,info:null},
  {category:'diffusion_models',name:'ltx.safetensors',path:'/m/ltx',family:'ltx-2',size:1,info:null},
  {category:'diffusion_models',name:'wan-high.safetensors',path:'/m/wan-high',family:'wan',size:1,info:null},
  {category:'diffusion_models',name:'wan-low.safetensors',path:'/m/wan-low',family:'wan',size:1,info:null}];
 return originalInvoke(command,args);
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
"""
SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#234c63"/><circle cx="160" cy="90" r="40" fill="#81b49a"/></svg>'
OUT.mkdir(parents=True, exist_ok=True)
reports = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for locale in ['en', 'de', 'fr', 'tr', 'ja', 'zh']:
        for width in [1440, 700, 320]:
            context = browser.new_context(viewport={'width': width, 'height': 1000})
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.route('**/input/*.png', lambda route: route.fulfill(content_type='image/svg+xml', body=SVG))
            page.add_init_script(INIT.replace('LOCALE', json.dumps(locale)))
            page.goto(URL + '/tools/inpaint-fixture.html', wait_until='networkidle')
            picker = page.locator('[data-pipeline]')
            expect(picker).to_have_value('video')
            assert picker.locator('option').evaluate_all('(os)=>os.map(o=>o.value)') == ['image', 'video', 'music']
            page.locator('[data-open-references]').click()
            dialog = page.locator('.references-overlay')
            expect(dialog).to_be_visible()
            files = dialog.locator('.references-picker')
            files.get_by_role('button', name='frame.png', exact=True).click()
            expect(dialog.locator('[data-video-role-card]')).to_have_count(0)
            expect(dialog.locator('[data-video-role="source"]')).to_be_disabled()
            dialog.locator('[data-video-role="both"]').click()
            expect(dialog.locator('[data-video-role-card="first"]')).to_contain_text('frame.png')
            expect(dialog.locator('[data-video-role-card="last"]')).to_contain_text('frame.png')
            expect(dialog.locator('[data-video-role="reference"]')).to_be_disabled()
            assert dialog.locator('[data-video-role="reference"]').get_attribute('title')
            dialog.locator('header > button').first.click()
            page.locator('[data-model-picker]').select_option('ltx.safetensors')
            page.locator('[data-open-references]').click()
            files.get_by_role('button', name='clip.mp4', exact=True).click()
            expect(dialog.locator('[data-video-role="source"]')).to_be_enabled()
            dialog.locator('[data-video-role="source"]').click()
            files.get_by_role('button', name='other.png', exact=True).click()
            dialog.locator('[data-video-role="reference"]').click()
            expect(dialog.locator('[data-video-role-card="source"]')).to_contain_text('clip.mp4')
            expect(dialog.locator('[data-ref="other.png"]')).to_be_visible()
            overflow = dialog.evaluate('d=>[d,...d.querySelectorAll(".references-overlay-body,.references-picker,.references-editor,[data-video-roles],.wb-ref-toolbar")].map(e=>({class:e.className,overflow:e.scrollWidth-e.clientWidth})).filter(x=>x.overflow>2)')
            assert not overflow, overflow
            if locale == 'en':
                page.screenshot(path=str(OUT / f'video-roles-{width}.png'))
            dialog.locator('header > button').first.click()
            page.locator('[data-model-picker]').select_option('wan-high.safetensors')
            page.locator('[data-open-references]').click()
            expect(dialog.locator('[data-video-role="reference"]')).to_be_disabled()
            expect(dialog.locator('[data-video-role="source"]')).to_be_disabled()
            assert not errors, errors
            assert not page.evaluate('window.__unexpected'), page.evaluate('window.__unexpected')
            assert not page.evaluate('window.__calls.some(c=>/submit|upload|prepare/.test(c.command)&&c.command!=="native_recipe_prerequisites")')
            reports.append({'locale': locale, 'width': width, 'roles': True, 'previewOnly': True, 'mixingDisabled': True, 'sourceAndFrames': True, 'overflow': overflow})
            context.close()
    browser.close()
(OUT / 'results.json').write_text(json.dumps(reports, indent=2), encoding='utf-8')
print(f'{len(reports)} role/locale/width cases passed; no upload or submission')
