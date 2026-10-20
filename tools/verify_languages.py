"""Six-language browser acceptance; real rendering without backend/provider requests."""
from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright
from deas_locale import set_locale
root=Path(__file__).resolve().parents[1]
url=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:1420'
names={'de':'Deutsch','en':'English','fr':'Français','ja':'日本語','tr':'Türkçe','zh':'中文'}
strings={}
for locale in names:
 strings[locale]={}
 for f in (root/'src').rglob(f'locales/{locale}.json'):strings[locale].update(json.loads(f.read_text()))
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 for width in (1440,1024,768,390,320):
  page=browser.new_page(viewport={'width':width,'height':960},reduced_motion='reduce',locale='de-DE')
  errors=[];foreign=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('request',lambda r:foreign.append(r.url) if not r.url.startswith(url) else None)
  page.goto(url,wait_until='networkidle')
  # No stored choice: the system language (de-DE) is detected and nothing is persisted.
  assert page.locator('html').get_attribute('lang')=='de' and page.evaluate("localStorage.getItem('deas.locale.v1')") is None
  page.locator('[data-node="settings"]').click()
  select=page.locator('#language-select')
  assert select.locator('option').count()==7 and select.input_value()==''
  for locale,name in names.items():assert select.locator(f'option[value="{locale}"]').inner_text()==f'{name} ({locale})'
  set_locale(page,'en','[data-node="settings"]')
  page.get_by_label('Director',exact=True).check()
  for locale in names:
   set_locale(page,locale,'[data-node="settings"]');t=strings[locale]
   assert page.locator('html').get_attribute('lang')==locale
   assert page.evaluate("localStorage.getItem('deas.locale.v1')")==locale
   assert page.get_by_label(t['setup.storageDirectory'],exact=True).count()==1
   assert page.get_by_label(t['setup.feature.director.label'],exact=True).is_checked()
   page.get_by_role('tab',name=t['downloads.title'],exact=True).click()
   assert page.get_by_role('region',name=t['downloads.title'],exact=True).get_by_text(t['downloads.browser'],exact=True).count()==1
   assert page.get_by_role('button',name=t['downloads.startAll'].replace('{count}','0'),exact=True).is_disabled()
   assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
   page.mouse.move(0,0);page.evaluate('document.activeElement?.blur()')
   if width==320 and locale in ('tr','fr','zh','ja'):page.screenshot(path=str(root/'assets'/f'deas-language-{locale}-320.png'),full_page=True)
   page.locator('[data-node="settings"]').click()
   results.append({'width':width,'locale':locale,'nativeNameAndIso':True,'choicePreserved':True,'localizedDownloadPanel':True,'noOverflow':True})
  page.reload(wait_until='networkidle');assert page.locator('html').get_attribute('lang')=='zh'
  page.locator('[data-node="settings"]').click();assert select.input_value()=='zh'
  set_locale(page,'');assert page.locator('html').get_attribute('lang')=='de' and page.evaluate("localStorage.getItem('deas.locale.v1')") is None
  assert not errors and not foreign,(errors,foreign)
  page.close()
 browser.close()
print(json.dumps(results,indent=2))
