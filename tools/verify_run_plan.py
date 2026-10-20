"""Read-only Run Plan, browser IPC fixtures; no backend, models or GPU used."""
from pathlib import Path
import json
import sys
import tempfile
from playwright.sync_api import sync_playwright
from deas_locale import set_locale

root = Path(__file__).resolve().parents[1]
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:1420'
fixture = r"""window.isTauri=true;window.__calls=[];
localStorage.setItem('deas.pref.studio.tab',JSON.stringify('map'));
localStorage.setItem('deas.pref.studio.run.seed','42');
localStorage.setItem('deas.pref.studio.run.seedMode',JSON.stringify('fixed'));
localStorage.setItem('deas.pref.studio.run.positive',JSON.stringify('Run Plan fixture — 猫'));
localStorage.setItem('deas.pref.studio.run.post','true');
localStorage.setItem('deas.pref.studio.run.upscale','2');
localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({attention:'',vae:'full',tile:512,cache:'',threshold:0.05,compile:'',outputNaming:'plan/%seed%',chunkHeadroom:0}));
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
window.__calls.push({command,args});
if(command==='native_auth_status')return [];
if(command==='native_repo_stars')return {count:0,starred:null};
if(command==='native_update_check')return {app:null,comfy:false,nodepack:false};
if(command==='native_install_defaults')return {storagePath:'/fixture',backend:'cpu',warnings:[]};
if(command==='native_media_list')return {path:'/fixture',parent:null,entries:[],truncated:false};
if(command==='native_recipe_prerequisites')return {baseUrl:args.baseUrl,recipeId:'checkpoint-text-to-image-diagnostic',version:1,allowlist:{nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage'],checkpoints:['plan.safetensors'],samplers:['euler'],schedulers:['normal']},missingNodes:[],generationReady:false};
if(command==='native_install_plan')return {id:'fixture-plan',request:args.request,steps:[],warnings:[],unsupportedOptions:[],canExecute:true};
throw Error('Unexpected fixture command '+command);
}};"""
results = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for width in (1440, 1024, 768, 390, 320):
        page = browser.new_page(viewport={'width': width, 'height': 960}, reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.add_init_script(fixture)
        page.goto(url, wait_until='networkidle')
        set_locale(page, 'en')
        page.locator('[data-studio-tab="map"]').click()
        assert page.locator('[data-studio-tab="map"]').get_attribute('aria-selected') == 'true'
        assert page.get_by_role('region', name='Run Plan', exact=True).is_visible()
        assert not page.locator('.run-plan-diagnostics').get_attribute('open')
        page.locator('[data-studio-tab="generate"]').click()
        page.locator('[data-dock-tab="models"]').click()
        page.locator('[data-run-load]').click()
        page.locator('[data-run-checkpoint]').wait_for()
        page.locator('[data-run-positive]').fill('Live edit — 猫')
        # Keep an identity marker: the actual workbench/editor is never replaced.
        page.locator('[data-workbench]').evaluate('el=>el.dataset.identity="preserved"')
        before = page.evaluate('__calls.length')
        page.locator('[data-studio-tab="map"]').click()
        page.locator('[data-plan-intent]').wait_for(state='attached')
        draft = json.loads(page.locator('[data-plan-intent]').text_content())
        assert draft['checkpoint'] == 'plan.safetensors'
        assert draft['positivePrompt'] == 'Live edit — 猫'
        assert draft['refine']['width'] == draft['width'] * 2
        assert draft['outputPrefix'] == 'plan/42'
        assert page.evaluate('__calls.length') == before, 'opening plan must not perform IPC'
        assert page.locator('[data-plan-stage]').evaluate_all('els=>els.map(el=>el.dataset.planStage)') == ['model','prompt','generate','refine','output']
        assert page.locator('.run-plan input,.run-plan button,.run-plan select,.run-plan textarea').count() == 0
        for locale in ('de', 'en', 'fr', 'ja', 'tr', 'zh'):
            set_locale(page, locale, '[data-studio-tab="map"]')
            assert json.loads(page.locator('[data-plan-intent]').text_content()) == draft
            assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'), (width, locale)
            assert 'studio.plan.' not in page.locator('.run-plan').inner_text()
        # Expand all technical details and check wrapping at the narrowest widths too.
        page.locator('.run-plan details').evaluate_all('els=>els.forEach(el=>el.open=true)')
        assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
        if width in (1440, 320):
            page.screenshot(path=str(Path(tempfile.gettempdir()) / f'deas-run-plan-{width}.png'), full_page=True)
        page.locator('[data-studio-tab="generate"]').click()
        assert page.locator('[data-workbench]').get_attribute('data-identity') == 'preserved'
        assert page.locator('[data-run-positive]').input_value() == 'Live edit — 猫'
        page.locator('[data-studio-tab="map"]').click()
        set_locale(page, 'en', '[data-studio-tab="map"]')
        page.locator('.run-plan-diagnostics > summary').click()
        page.locator('[data-node="engine"] > button').click()
        assert page.locator('#endpoint').is_visible()
        assert page.locator('[data-recipe-check]').is_visible()
        assert not page.evaluate("__calls.some(c=>/job_(prepare|submit)|upload/.test(c.command))")
        assert not errors, errors
        results.append({'width': width, 'sixLocales': True, 'readOnly': True, 'legacyMapPreference': True, 'draftPreserved': True, 'noOverflow': True})
        page.close()
    browser.close()
print(json.dumps(results, indent=2))
