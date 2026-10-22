"""LLM settings/discovery/layout: Chromium IPC fixtures, not live inference."""
import ast
import json
import sys
from itertools import product
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4287'
module = ast.parse((root / 'tools/verify_reopen.py').read_text())
fixture = next(ast.literal_eval(node.value) for node in module.body
               if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'fixture' for t in node.targets))
fixture += r"""
localStorage.setItem('deas.pref.backend.autostart','false');
window.__LLM__={provider:'local',baseUrl:'http://127.0.0.1:11434'};
window.__REMOTE_DOWN__=false;
const invokeBase=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(c,a)=>{
 if(c.startsWith('native_llm_')){
  window.__CALLS__.push({command:c,args:a});
  if(c==='native_llm_write')window.__LLM__=a.config;
  if(c==='native_llm_models')return {
   models:[{id:'prompt.gguf',name:'Local fixture GGUF',provider:'local'},
    ...(__LLM__.provider!=='local'&&!__REMOTE_DOWN__?[{id:'remote-chat',name:'Remote fixture chat',provider:__LLM__.provider}]:[])],
   warnings:__REMOTE_DOWN__?['Remote discovery fixture unavailable']:[]};
  if(c==='native_llm_generate')return {text:'Explicit IPC fixture completion',backend:a.request.model.provider};
  return window.__LLM__;
 }
 return invokeBase(c,a);
};
"""
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for width, locale in product((1440, 1024, 768, 390, 320), ('de', 'en', 'fr', 'ja', 'tr', 'zh')):
        labels = json.loads((root / 'src/features/llm/locales' / f'{locale}.json').read_text())
        page = browser.new_page(viewport={'width': width, 'height': 1100}, reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.add_init_script(fixture.replace("localStorage.setItem('deas.locale.v1','en')", "localStorage.setItem('deas.locale.v1'," + json.dumps(locale) + ")"))
        page.goto(url, wait_until='networkidle')
        page.wait_for_function("__CALLS__.some(c=>c.command==='native_install_open')")
        page.locator('[data-node="settings"]').click()
        page.locator('[data-backend-panel="llm"]').click()
        panel = page.get_by_role('region', name=labels['llm.title'], exact=True)
        provider = panel.get_by_role('combobox', name=labels['llm.provider'], exact=True)
        choices = panel.get_by_role('combobox', name=labels['llm.test.model'], exact=True)
        choices.locator('option').filter(has_text='Local fixture GGUF').wait_for(state='attached')
        assert not page.evaluate("__CALLS__.some(c=>c.command==='native_llm_generate')")
        assert panel.locator('input[type=number]').count() == 0
        for kind in ('ollama', 'openai'):
            provider.select_option(kind)
            panel.get_by_role('textbox', name=labels['llm.baseUrl'], exact=True).fill('http://127.0.0.1:8080/v1' if kind == 'openai' else 'http://127.0.0.1:11434')
            assert panel.get_by_role('button', name=labels['llm.test'], exact=True).is_disabled()
            panel.get_by_role('button', name=labels['llm.save'], exact=True).click()
            choices.locator('option').filter(has_text='Remote fixture chat').wait_for(state='attached')
            assert choices.locator('option').filter(has_text='Local fixture GGUF').count() == 1
            assert panel.get_by_role('button', name=labels['llm.test'], exact=True).is_disabled()
            for name, expected in [('Local fixture GGUF', 'local'), ('Remote fixture chat', kind)]:
                value = choices.locator('option').filter(has_text=name).get_attribute('value')
                choices.select_option(value=value)
                panel.get_by_role('button', name=labels['llm.test'], exact=True).click()
                panel.get_by_text('Explicit IPC fixture completion', exact=True).wait_for()
                assert page.evaluate("__CALLS__.filter(c=>c.command==='native_llm_generate').at(-1).args.request.model.provider") == expected
            assert set(page.evaluate('__LLM__')) == {'provider', 'baseUrl'}
            assert panel.get_by_role('textbox').count() == 2, 'Only endpoint and test prompt, no model/path input'
        page.evaluate('window.__REMOTE_DOWN__=true')
        panel.get_by_role('button', name=labels['llm.refresh'], exact=True).click()
        panel.get_by_text('Remote discovery fixture unavailable', exact=True).wait_for()
        assert choices.locator('option').filter(has_text='Local fixture GGUF').count() == 1
        assert choices.locator('option').filter(has_text='Remote fixture chat').count() == 0
        menu = page.locator('.backend-panel-menu').bounding_box()
        pane = page.get_by_role('tabpanel').bounding_box()
        if width <= 480:
            assert menu['y'] + menu['height'] <= pane['y'], (width, locale, menu, pane)
        else:
            assert menu['x'] + menu['width'] <= pane['x'], (width, locale, menu, pane)
        assert page.get_by_role('tabpanel').count() == 1
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), (width, locale)
        assert not errors, errors
        if width in (1440, 320) and locale == 'en':
            page.screenshot(path=str(root / 'assets' / f'deas-llm-fixture-{width}.png'), full_page=True)
        results.append({'width': width, 'locale': locale, 'localAndRemoteDiscovered': True, 'perRequestModel': True, 'localSurvivesRemoteFailure': True, 'layout': True})
        page.close()
    browser.close()
print(json.dumps(results, indent=2))
