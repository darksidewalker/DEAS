"""Output naming: real browser UI with native IPC fixtures, not model generation."""
import ast
import json
from pathlib import Path
import re
import sys
from playwright.sync_api import sync_playwright, expect

root=Path(__file__).resolve().parents[1]
url=sys.argv[1]
out=Path(sys.argv[2]) if len(sys.argv)>2 else Path.home()/'.hermes/cache/scratch/deas-output-naming'
out.mkdir(parents=True,exist_ok=True)
module=ast.parse((root/'tools/verify_workbench.py').read_text())
fixture=next(ast.literal_eval(n.value) for n in module.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='fixture' for t in n.targets))
fixture=fixture.replace("window.__calls.push({command,args});","window.__calls.push({command,args});if(command==='native_workbench_run'){window.__intent=structuredClone(args.intent);return window.__job={id:'name-job',baseUrl:'http://127.0.0.1:7801/',promptId:'p',intent:window.__intent,state:'succeeded',outputs:[],error:null,generationReady:false};}")
with sync_playwright() as p:
 browser=p.chromium.launch()
 for width in (1440,1024,768,390,320):
  for locale in ('de','en','fr','ja','tr','zh'):
   t=json.loads((root/f'src/features/studio/locales/{locale}.json').read_text())
   page=browser.new_page(viewport={'width':width,'height':960},reduced_motion='reduce')
   errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.add_init_script(fixture)
   page.add_init_script("localStorage.setItem('deas.locale.v1',"+json.dumps(locale)+");")
   page.goto(url,wait_until='networkidle')
   page.locator('[data-node=studio]').click()
   page.locator('[data-dock-tab=models]').click()
   page.locator('[data-run-load]').click()
   page.locator('[data-run-checkpoint]').wait_for()
   page.locator('[data-dock-tab=options]').click()
   field=page.get_by_role('textbox',name=t['studio.run.opt.outputNaming'],exact=True)
   expect(field).to_have_value('%type%/%date_yyyy-mm-dd%/%time%-%seed%-%model%')
   page.get_by_role('spinbutton',name=t['studio.run.seed'],exact=True).fill('42')
   page.locator('[data-run]').click()
   page.wait_for_function("window.__calls.some(c=>c.command==='native_workbench_run')")
   intent=page.evaluate('window.__intent')
   assert re.fullmatch(r'image/\d{4}-\d{2}-\d{2}/\d{2}-\d{2}-\d{2}-42-anima-preview',intent['outputPrefix']),intent
   field.fill('custom/%type%/%seed%-%model%')
   page.reload(wait_until='networkidle')
   page.locator('[data-node=studio]').click()
   page.locator('[data-dock-tab=options]').click()
   expect(field).to_have_value('custom/%type%/%seed%-%model%')
   field.fill('../%seed%')
   expect(field).to_have_attribute('aria-invalid','true')
   page.locator('[data-run]').click()
   assert not page.evaluate("window.__calls.some(c=>c.command==='native_workbench_run')")
   field.fill('%type%/%date_yyyy-mm-dd%/%time%-%seed%-%model%')
   expect(field).to_have_attribute('aria-invalid','false')
   field.scroll_into_view_if_needed()
   assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'),(width,locale)
   assert not errors,(width,locale,errors)
   if locale=='en' and width in (1440,320):page.screenshot(path=str(out/f'naming-{width}.png'),full_page=True)
   page.close()
 browser.close()
print('Output naming IPC fixture: 6 locales × 5 widths passed (default, resolved intent, persistence, invalid path).')
