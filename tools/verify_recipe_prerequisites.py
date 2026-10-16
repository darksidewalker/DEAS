"""Recipe compile-preview acceptance. Native IPC responses are explicit fixtures."""
from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:1420'
fixture = r"""window.__calls=[]; window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
window.__calls.push({command,args});
if(command!=='native_recipe_prerequisites') throw Error('Unexpected command '+command);
return {baseUrl:args.baseUrl.replace(/\/$/,'')+'/',recipeId:'checkpoint-text-to-image-diagnostic',version:1,
allowlist:{nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage'],
checkpoints:['fixture.safetensors'],samplers:['euler'],schedulers:['normal']},missingNodes:[],generationReady:false};
}};"""
results = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for width in (1440, 1024, 768, 390, 320):
        for native in (False, True):
            page = browser.new_page(viewport={'width': width, 'height': 960}, reduced_motion='reduce')
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            if native:
                page.add_init_script(fixture)
            page.goto(url, wait_until='networkidle')
            page.locator('.language-control select').select_option('en')
            page.locator('.studio-explore').click()
            page.locator('[data-studio-tab="map"]').click()
            page.locator('[data-node="engine"] > button').click()
            panel = page.locator('[data-recipe-prerequisites]')
            panel.wait_for()
            if native:
                assert page.evaluate('__calls.length') == 0, 'Probe must be explicit'
            panel.locator('[data-recipe-check]').click()
            if native:
                page.wait_for_function('__calls.length===1')
                panel.locator('[data-recipe-checkpoint]').select_option('fixture.safetensors')
                panel.locator('[data-recipe-compile]').click()
                graph = panel.locator('[data-recipe-graph]')
                graph.wait_for(state='attached')
                assert 'CheckpointLoaderSimple' in graph.text_content()
                assert 'fixture.safetensors' in graph.text_content()
                assert page.evaluate('__calls.length') == 1, 'Compilation must not submit a job'
            else:
                assert panel.locator('[role="alert"]').count() > 0, 'Browser must fail closed'
            for locale in ('de', 'en', 'fr', 'ja', 'tr', 'zh'):
                page.locator('.language-control select').select_option(locale)
                assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'), (width, locale)
            if native:
                page.locator('#endpoint').fill('http://127.0.0.1:9999')
                assert panel.locator('[data-recipe-graph]').count() == 0, 'Endpoint edit must discard evidence'
                assert page.evaluate('__calls.length') == 1, 'Endpoint edits must not auto-probe'
            assert not errors, errors
            results.append({'width': width, 'nativeIPCFixture': native, 'sixLocales': True, 'noOverflow': True})
            page.close()
    browser.close()
print(json.dumps(results, indent=2))
