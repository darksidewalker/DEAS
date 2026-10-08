"""Integrated optional-plugin browser rendering. Native IPC uses fixtures, not live provider access."""
from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
url=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:1420'
results=[]
fixture=r"""window.isTauri=true;window.__DEAS_CALLS__=[];window.__TAURI_INTERNALS__={invoke:async(c,a)=>{window.__DEAS_CALLS__.push(c);if(c==='native_detect_hardware')return {backend:null,warnings:[]};if(c==='native_download_catalog'||c==='native_download_import_catalog')return {version:1,providers:[{id:'fixture',kind:'http',label:'Fixture HTTPS provider',origin:'https://example.invalid',scopes:['index'],anonymousNotice:'Fixture only; no live provider contacted.'}],entries:[]};if(c==='native_download_browse')return {resources:[{id:'fixture-file',label:'Fixture data file',kind:'file',url:'https://example.invalid/a.json',downloadable:true,size:23}],nextCursor:null,warnings:[]};if(c==='native_pick_directory')return '/scratch-fixture';if(c==='native_download_plan')return {id:'fixture-plan',target:'/scratch-fixture/new-files',resources:a.request.resources,totalKnownBytes:23,unknownSizeCount:0,warnings:[],canExecute:true};if(c==='native_download_start'||c==='native_download_status')return {state:'succeeded',completed:1,total:1,bytesDownloaded:23,error:null};if(c==='native_auth_status')return [{providerId:'huggingface',configured:false,persisted:false}];throw Error('Unexpected fixture command');}};"""
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 for width in (1440,1024,768,390,320):
  for native in (False,True):
   page=browser.new_page(viewport={'width':width,'height':960},reduced_motion='reduce')
   errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   if native:page.add_init_script(fixture)
   page.goto(url,wait_until='networkidle')
   page.get_by_label('Sprache',exact=True).select_option('en')
   page.get_by_role('button',name='AiO installer',exact=True).click()
   page.get_by_text('Optional downloads and credentials — available any time',exact=True).click()
   page.get_by_role('button',name='Optional downloads',exact=True).click()
   if native:
    page.get_by_role('option',name='Fixture HTTPS provider').wait_for(state='attached')
    assert page.evaluate("__DEAS_CALLS__.filter(x=>x.startsWith('native_download_'))")==['native_download_catalog']
    page.get_by_label('Source locator',exact=True).fill('https://example.invalid/a.json')
    page.get_by_role('button',name='Browse resources',exact=True).click()
    page.get_by_label('Fixture data file',exact=True).check()
    page.get_by_role('button',name='Choose existing parent folder',exact=True).click()
    page.get_by_label('New subfolder',exact=True).fill('new-files')
    page.get_by_role('button',name='Prepare native download plan',exact=True).click()
    consent=page.get_by_label('I authorize only this exact optional download plan.',exact=True)
    consent.wait_for();assert not consent.is_checked()
    assert page.get_by_role('button',name='Start confirmed download',exact=True).is_disabled()
    consent.check();page.get_by_role('button',name='Start confirmed download',exact=True).click()
    page.get_by_text('Succeeded',exact=True).wait_for()
   else:
    assert page.get_by_text('Browser preview',exact=False).count()>0
    assert page.get_by_role('button',name='Start confirmed download',exact=True).is_disabled()
   page.get_by_role('button',name='Provider authorization',exact=True).click()
   page.get_by_label('Token',exact=True).wait_for()
   assert page.get_by_label('Token',exact=True).get_attribute('type')=='password'
   assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
   if native:assert 'native_auth_status' not in page.evaluate('__DEAS_CALLS__')
   assert not errors,errors
   if width in (1440,320) and native:page.screenshot(path=str(root/'assets'/f'deas-downloads-fixture-{width}.png'),full_page=True)
   results.append({'width':width,'mode':'native IPC fixture' if native else 'browser fails closed','setupIntegration':True,'noOverflow':True,'noRuntimeErrors':True})
   page.close()
 browser.close()
print(json.dumps(results,indent=2))
