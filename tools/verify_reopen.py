"""Reopen/autostart browser IPC fixtures; no real backend, files or GPU are started."""
import json
import sys
from itertools import product
from pathlib import Path
from playwright.sync_api import sync_playwright
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4279'
fixture = r"""localStorage.setItem('deas.locale.v1','en');
if(!localStorage.getItem('deas.pref.install.root'))localStorage.setItem('deas.pref.install.root',JSON.stringify('/fixture/env'));
window.isTauri=true;window.__CALLS__=[];window.__RUNNING__=false;
window.__TAURI_INTERNALS__={invoke:async(c,a)=>{
 window.__CALLS__.push({command:c,args:a});
 const request={storagePath:'/fixture/env',backend:'cpu',features:['director','forge','refmods','continuity'],options:{sage:false,radial:false,flash:false,ffmpeg:false},comfyRef:'master'};
 if(c==='native_files_present')return [true];
 if(c==='native_install_plan')return {id:'reopen-fixture',reopenId:'reopen-fixture',request,steps:[],warnings:[],unsupportedOptions:[],canExecute:true};
 if(c==='native_install_open')return {state:'succeeded',stepId:null,logs:['Opened fixture; no reinstall'],error:null};
 if(c==='native_install_defaults')return {storagePath:'/new/environment',backend:'cpu',hardware:null,warnings:[]};
 if(c==='native_settings_read')return {};
 if(c==='native_startup_read')return {startup:{preset:'speed',flags:[],fast:[]},packages:[],presets:{speed:{flags:[],fast:[]},compatibility:{flags:[],fast:[]},off:{flags:[],fast:[]}}};
 if(c==='native_startup_write')return a.startup;
 if(c==='native_llm_read')return {provider:'local',baseUrl:'http://127.0.0.1:11434'};
 if(c==='native_llm_models')return {models:[],warnings:[]};
 if(c==='native_job_current')return null;
 if(c==='native_media_list')return {path:'/fixture',parent:null,entries:[],truncated:false};
 if(c==='native_backend_start')window.__RUNNING__=true;
 if(c==='native_backend_stop')window.__RUNNING__=false;
 if(c.startsWith('native_backend_'))return {state:window.__RUNNING__?'running':'stopped',endpoint:window.__RUNNING__?'http://127.0.0.1:49312':null,logs:[],error:null,generationReady:false};
 throw Error('Unexpected IPC '+c);
}};"""
results = []
with sync_playwright() as p:
 browser = p.chromium.launch(headless=True)
 for width, locale in product((1440, 1024, 768, 390, 320), ('de', 'en', 'fr', 'ja', 'tr', 'zh')):
  labels = json.loads((Path(__file__).resolve().parents[1] / 'src/components/setup/locales' / f'{locale}.json').read_text())
  page = browser.new_page(viewport={'width': width, 'height': 960}, reduced_motion='reduce')
  errors = []
  page.on('pageerror', lambda e: errors.append(str(e)))
  page.add_init_script(fixture.replace("localStorage.setItem('deas.locale.v1','en')", "localStorage.setItem('deas.locale.v1'," + json.dumps(locale) + ")"))
  page.goto(url, wait_until='networkidle')
  page.wait_for_function("__CALLS__.some(c=>c.command==='native_backend_start')")
  assert page.evaluate("__CALLS__.filter(c=>c.command==='native_install_open').length") == 1
  assert page.evaluate("__CALLS__.filter(c=>c.command==='native_backend_start').length") == 1
  assert not page.evaluate("__CALLS__.some(c=>c.command==='native_install_start')")
  page.locator('[data-node="settings"]').click()
  toggle = page.locator('.backend-autostart')
  assert toggle.get_attribute('aria-checked') == 'true'
  toggle.click()
  assert toggle.get_attribute('aria-checked') == 'false'
  assert not page.evaluate("__CALLS__.some(c=>c.command==='native_backend_stop')")
  assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
  page.reload(wait_until='networkidle')
  page.wait_for_function("__CALLS__.some(c=>c.command==='native_install_open')")
  page.locator('[data-node="settings"]').click()
  assert page.locator('.backend-autostart').get_attribute('aria-checked') == 'false'
  assert not page.evaluate("__CALLS__.some(c=>c.command==='native_backend_start')")
  page.locator('[data-node="settings"]').click()
  page.get_by_role('button', name=labels['setup.backendLifecycle.start'], exact=True).click()
  page.wait_for_function("__CALLS__.filter(c=>c.command==='native_backend_start').length===1")
  assert not errors, errors
  results.append({'width': width, 'locale': locale, 'checkedReopen': True, 'defaultAutostartOnce': True, 'persistedOffAfterReload': True, 'manualStartWithAutostartOff': True, 'noReinstallOrImplicitStop': True})
  page.close()
 browser.close()
print(json.dumps(results, indent=2))
