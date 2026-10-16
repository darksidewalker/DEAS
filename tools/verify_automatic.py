"""Automatic setup rendering and consent checks; native IPC is an explicit fixture."""
from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright
root = Path(__file__).resolve().parents[1]
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:1420'
strings = {locale: json.loads((root / f'src/components/setup/locales/{locale}.json').read_text()) for locale in ('de','en','fr','ja','tr','zh')}
fixture = r"""window.isTauri=true; window.__calls=[]; window.__installState='running';
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
window.__calls.push({command,args});
if(command==='native_media_list') return {path:'/fixture',parent:null,entries:[],truncated:false};
if(command==='native_download_catalog') return {version:1,providers:[],entries:[]};
if(command==='native_pick_directory') return '/real/custom-models';
if(command==='native_install_defaults') return {storagePath:'/executable-folder/deas-environment',backend:'nvidia',hardware:{name:'RTX fixture'},warnings:[]};
if(command==='native_install_plan') return {id:'fixture-plan',request:args.request,steps:[],warnings:[],unsupportedOptions:Object.entries(args.request.options).filter(([,v])=>v).map(([k])=>k),canExecute:!Object.values(args.request.options).some(Boolean)};
if(command==='native_install_start'||command==='native_install_status') return {state:window.__installState,stepId:'fixture-only',logs:[],error:null};
if(command==='native_backend_start') return {state:'starting',endpoint:null,logs:[],error:null,generationReady:false};
if(command==='native_backend_status') return {state:'running',endpoint:'http://127.0.0.1:49173',logs:[],error:null,generationReady:false};
throw Error('Unexpected fixture command '+command);
}};"""
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch()
    for width in (1440,1024,768,390,320):
        for native in (False, True):
            page=browser.new_page(viewport={'width':width,'height':960}, reduced_motion='reduce')
            errors=[]
            page.on('pageerror', lambda e: errors.append(str(e)))
            if native: page.add_init_script(fixture)
            page.goto(url, wait_until='networkidle')
            page.locator('.language-control select').select_option('en')
            page.locator('[data-node="setup:aio"]').click()
            assert page.locator('button[data-setup-mode="guided"]').count()==0
            storage=page.locator('#auto-storage')
            backend=page.locator('#auto-backend')
            if native:
                page.wait_for_function("document.querySelector('#auto-storage')?.value==='/executable-folder/deas-environment'")
                assert backend.input_value()=='nvidia'
                assert page.evaluate("__calls.filter(x=>x.command==='native_install_start').length")==0
            else:
                assert storage.input_value()=='' and backend.input_value()==''
                assert page.get_by_role('button',name=strings['en']['setup.autoStart'],exact=True).count()==0
            page.get_by_text(strings['en']['settings.optional'],exact=True).click()
            if native:
                page.get_by_role('button',name=strings['en']['settings.chooseFor'].replace('{folder}',strings['en']['settings.models']),exact=True).click()
                page.wait_for_function("__calls.filter(x=>x.command==='native_install_plan').at(-1)?.args.request.folders?.models==='/real/custom-models'")
                assert not page.evaluate("__calls.some(x=>x.command==='native_settings_write'||x.command==='native_settings_move')")
            for box in page.locator('.aio-auto-fields input[type="checkbox"]').evaluate_all('els=>els.map(el=>el.getBoundingClientRect().toJSON())'):
                assert box['width']<=24, 'Checkbox inherited full-width input styling'
            storage.fill('/edited/new-environment')
            page.locator('details.aio-advanced > summary').click()
            backend.select_option('cpu')
            page.locator('#auto-ref').fill('master')
            for locale,t in strings.items():
                page.locator('.language-control select').select_option(locale)
                assert storage.input_value()=='/edited/new-environment'
                assert backend.input_value()=='cpu'
                assert page.get_by_role('heading',name=t['setup.autoReview'],exact=True).count()==1
                assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'),(width,locale)
            page.locator('.language-control select').select_option('en')
            if native:
                start=page.get_by_role('button',name=strings['en']['setup.autoStart'],exact=True)
                start.wait_for()
                assert start.is_enabled()
                plans="__calls.filter(x=>x.command==='native_install_plan').length"
                def replan(action):
                    before=page.evaluate(plans); action(); page.wait_for_function(f"{plans}==={before+1}"); start.wait_for()
                before=page.evaluate(plans)
                storage.fill('/edited/newer-environment')
                assert page.get_by_role('button',name=strings['en']['setup.autoStart'],exact=True).count()==0
                assert page.evaluate("__calls.filter(x=>x.command==='native_install_start').length")==0
                page.wait_for_function(f"{plans}==={before+1}"); start.wait_for()
                replan(lambda: page.get_by_label(strings['en']['setup.option.ffmpeg'],exact=True).check())
                assert start.is_disabled(), 'Unsupported selection must block final start'
                replan(lambda: page.get_by_label(strings['en']['setup.option.ffmpeg'],exact=True).uncheck())
                assert start.is_enabled()
                if width in (1440,320):
                    page.screenshot(path=str(root/f'assets/deas-automatic-fixture-{width}.png'),full_page=True)
                start.click()
                page.wait_for_function("__calls.filter(x=>x.command==='native_install_start').length===1")
                assert storage.is_disabled() and backend.is_disabled()
                submitted=page.evaluate("__calls.find(x=>x.command==='native_install_start').args")
                assert submitted=={'planId':'fixture-plan','confirmed':True}, submitted
                assert page.locator('#studio-workspace').count()==0
                page.evaluate("window.__installState='succeeded'")
                page.locator('#studio-workspace').wait_for()
                page.locator('[data-studio-tab="map"]').click()
                assert page.evaluate("__calls.filter(x=>x.command==='native_backend_start').length")==0
                assert page.locator('[data-node="director"]').count()==1
                page.get_by_role('button',name=strings['en']['setup.backendLifecycle.start'],exact=True).click()
                page.wait_for_function("document.querySelector('#endpoint')?.value==='http://127.0.0.1:49173'")
                assert page.evaluate("__calls.filter(x=>x.command==='native_backend_start').length")==1
                assert not page.evaluate("__calls.some(x=>/inspect|prerequisites|negotiate/.test(x.command))")
                for locale in strings:
                    page.locator('.language-control select').select_option(locale)
                    assert page.locator('#endpoint').input_value()=='http://127.0.0.1:49173'
                    assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'),(width,locale,'handoff')
                page.locator('.language-control select').select_option('en')
                if width in (1440,320):
                    page.screenshot(path=str(root/f'assets/deas-studio-handoff-fixture-{width}.png'),full_page=True)
            assert not errors,errors
            results.append({'width':width,'nativeIPCFixture':native,'allSixLocales':True,'noOverflow':True,'noPerStepQuestions':True})
            page.close()
    browser.close()
print(json.dumps(results,indent=2))
