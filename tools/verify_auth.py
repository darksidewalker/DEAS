"""Provider-auth browser IPC fixtures; never touches real tokens or providers."""
import json
import sys
from playwright.sync_api import sync_playwright
from deas_locale import set_locale
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4173'
fixture = r"""window.isTauri=true;window.__CHECK_STATUS__='verified';window.__AUTH_CHECKS__=[];window.__TAURI_INTERNALS__={invoke:async(c,a)=>{
 if(c==='native_media_list')return {path:'/fixture',parent:null,entries:[],truncated:false};
 if(c==='native_install_defaults')return {storagePath:'/fixture/deas-environment',backend:'cpu',hardware:null,warnings:[]};
 if(c==='native_install_plan')return {id:'fixture',request:a.request,steps:[],warnings:[],unsupportedOptions:[],canExecute:true};
 if(c==='native_auth_status')return ['huggingface','civitai','github'].map(providerId=>({providerId,configured:true,persisted:true}));
 if(c==='native_auth_verify'){window.__AUTH_CHECKS__.push(a.providerId);return {providerId:a.providerId,status:window.__CHECK_STATUS__};}
 throw Error('Unexpected fixture IPC: '+c);
}};"""
results = []
with sync_playwright() as p:
 browser = p.chromium.launch(headless=True)
 for width in (1440, 1024, 768, 390, 320):
  page = browser.new_page(viewport={'width': width, 'height': 960}, reduced_motion='reduce')
  errors = []
  page.on('pageerror', lambda e: errors.append(str(e)))
  page.add_init_script(fixture)
  page.goto(url, wait_until='networkidle')
  set_locale(page, 'en')
  page.get_by_role('button', name='Provider authorization', exact=True).click()
  for provider in ('huggingface', 'civitai', 'github'):
   page.locator(f'[data-provider="{provider}"]').click()
   page.locator('.auth-verified').wait_for()
   assert 'Token verified' in page.locator('.auth-verified').inner_text()
   assert page.locator('.auth-verified').inner_text().startswith('✓')
   assert page.get_by_label('Token', exact=True).input_value() == ''
  page.evaluate("window.__CHECK_STATUS__='rejected'")
  page.get_by_role('button', name='Refresh authorization status', exact=True).click()
  page.get_by_text('Token rejected or access denied', exact=True).wait_for()
  assert page.locator('.auth-verified').count() == 0
  page.evaluate("window.__CHECK_STATUS__='unavailable'")
  page.get_by_role('button', name='Refresh authorization status', exact=True).click()
  page.get_by_text('Token check unavailable; try again', exact=True).wait_for()
  assert page.locator('.auth-verified').count() == 0
  assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
  assert not errors, errors
  results.append({'width': width, 'verifiedProviders': page.evaluate('[...new Set(__AUTH_CHECKS__)]'), 'rejectedAndOfflineNoCheckmark': True, 'noOverflow': True})
  page.close()
 browser.close()
print(json.dumps(results, indent=2))
