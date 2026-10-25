"""Wildcard UX with real node-pack library and mocked native IPC; not model-generation acceptance."""
import ast
import json
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright, expect

root=Path(__file__).resolve().parents[1]
url=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:4299'
pack=Path(sys.argv[2]) if len(sys.argv)>2 else root.parent/'ComfyUI/custom_nodes/ComfyUI-DaSiWa-Nodes'
out=Path(sys.argv[3]) if len(sys.argv)>3 else Path.home()/'.hermes/cache/scratch/deas-wildcards-verification'
out.mkdir(parents=True,exist_ok=True)
# Reuse the workbench fixture without executing its standalone browser suite.
module=ast.parse((root/'tools/verify_workbench.py').read_text())
fixture=next(ast.literal_eval(n.value) for n in module.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='fixture' for t in n.targets))
categories=json.loads((pack/'data/wildcards_and_presets_dual.json').read_text())['wildcard_library']['categories']
fixture=fixture.replace("window.__calls.push({command,args});","window.__calls.push({command,args});\nif(command==='native_wildcard_library')return "+json.dumps(json.dumps({'categories':categories}))+";\nif(command==='native_workbench_run'){window.__intent=structuredClone(args.intent);return window.__job={id:'wild-job',baseUrl:'http://127.0.0.1:7801/',promptId:'p',intent:window.__intent,state:'succeeded',outputs:[],error:null,generationReady:false};}")
with sync_playwright() as p:
 browser=p.chromium.launch()
 for width in (1440,1024,768,390,320):
  for locale in ('de','en','fr','ja','tr','zh'):
   t=json.loads((root/f'src/features/wildcards/locales/{locale}.json').read_text())
   page=browser.new_page(viewport={'width':width,'height':960},reduced_motion='reduce')
   errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.add_init_script(fixture)
   page.add_init_script("localStorage.setItem('deas.locale.v1',"+json.dumps(locale)+");")
   page.goto(url,wait_until='networkidle')
   page.locator('[data-node=studio]').click()
   page.locator('[data-studio-tab=generate]').click()
   page.locator('[data-forge-open]').click()
   page.get_by_role('button',name=t['wildcards.title'],exact=True).click()
   panel=page.get_by_role('region',name=t['wildcards.title'],exact=True)
   expect(panel.locator('summary')).to_have_count(len(categories))
   panel.locator('summary').filter(has_text='Character Selection').click()
   panel.get_by_role('checkbox',name='1 Girl · '+t['wildcards.presets'],exact=True).check()
   panel.get_by_role('spinbutton',name=t['wildcards.weight'].replace('{name}','1 Girl · '+t['wildcards.presets']),exact=True).fill('1.2')
   panel.get_by_role('checkbox',name=t['wildcards.enabled'],exact=True).check()
   panel.get_by_role('checkbox',name=t['wildcards.auto'],exact=True).check()
   page.locator('[data-run-positive]').fill('manual base')
   # Force model listing through the existing Generate dock, not an invented model selector.
   page.locator('[data-dock-tab=models]').click()
   page.locator('[data-run-load]').click()
   page.locator('[data-run-checkpoint]').wait_for()
   page.locator('[data-run]').click()
   page.wait_for_function("window.__calls.some(c=>c.command==='native_workbench_run')")
   intent=page.evaluate('window.__intent')
   assert intent['positivePrompt']=='manual base'
   assert intent['wildcard']['auto_reroll'] is True
   assert intent['wildcard']['selection_state']['Character Selection/1 Girl/presets']=={'enabled':True,'weight':1.2}
   # Editing the next job must not change the selected job's native snapshot.
   page.locator('[data-dock-tab=wildcards]').click()
   panel.get_by_role('button',name=t['wildcards.clear'],exact=True).click()
   if page.locator('[data-metadata-toggle][aria-pressed=false]').count():page.locator('[data-metadata-toggle]').click()
   metadata=page.locator('.wb-metadata')
   expect(metadata.get_by_text('Character Selection/1 Girl/presets (1.2)',exact=True)).to_be_visible()
   metadata.locator('[data-metadata-apply]').click()
   page.wait_for_function("JSON.parse(localStorage.getItem('deas.pref.studio.run.wildcard')).selection_state['Character Selection/1 Girl/presets']?.weight===1.2")
   page.get_by_role('button',name=t['wildcards.disable'],exact=True).click()
   assert page.evaluate("JSON.parse(localStorage.getItem('deas.pref.studio.run.wildcardEnabled'))") is False
   assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'),(width,locale,'horizontal overflow')
   assert not errors,(width,locale,errors)
   if locale=='en' and width in (1440,320):
    panel.get_by_role('button',name=t['wildcards.random'],exact=True).click()
    panel.get_by_role('checkbox',name=t['wildcards.enabled'],exact=True).check()
    page.screenshot(path=str(out/f'wildcards-{width}.png'),full_page=True)
   page.close()
 browser.close()
print('wildcard IPC fixture: 6 languages × 5 widths passed; real library categories:',len(categories))
print('screenshots:',out)
