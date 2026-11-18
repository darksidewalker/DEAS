"""Desktop prompt options and inline/floating completion; synthetic native IPC only."""
import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
url=sys.argv[1].rstrip('/');out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
init="""
localStorage.setItem('deas.locale.v1',LOCALE);
localStorage.setItem('deas.pref.prompt.tagCompletion',JSON.stringify({sources:['builtin','classified','danbooru','e621'],limit:8,aliases:true,contains:true,minimumCount:0,floating:false}));
localStorage.setItem('deas.pref.prompt.tools',JSON.stringify({spellcheck:false,autocomplete:false,language:''}));
window.isTauri=true;window.__calls=[];
window.__TAURI_INTERNALS__={invoke:async(c,a)=>{__calls.push({c,a});if(c==='native_prompt_tag_sources')return [{id:'builtin',label:'builtin',available:true,ready:true,rows:0,skipped:0},{id:'merged',label:'merged.csv',available:true,ready:false,rows:0,skipped:0}];if(c==='native_prompt_tag_remove')return null;if(c==='native_prompt_tag_import'&&!a.source)return {id:'custom-0123456789abcdef',label:'my-tags.csv',available:true,ready:true,rows:150,skipped:0};if(c==='native_prompt_tag_import')return {id:'merged',label:'merged.csv',available:true,ready:true,rows:10000,skipped:0};if(c==='native_prompt_tag_search')return Array.from({length:a.options.limit},(_,i)=>({tag:'blue_tag_'+i,category:'general',count:10000-i,source:'merged',description:'Local description '+i}));if(c==='native_forge_tag_search')return [{tag:'blue_eyes',category:'general',count:100}];throw Error('Unexpected fixture IPC: '+c);}};
"""
reports=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 for locale in ['en','de','fr','ja','tr','zh']:
  for width,height in [(1920,1080),(1440,900),(1280,720),(1024,600)]:
   print(f'TAG_CASE {locale} {width}',flush=True)
   context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.add_init_script(init.replace('LOCALE',json.dumps(locale)))
   page.goto(url+'/tools/tag-completion-fixture.html',wait_until='networkidle')
   button=page.locator('[data-prompt-tag-options]')
   assert button.evaluate('e=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest("[data-prompt-tag-options]")===e}')
   assert page.locator('.wb-prompt').first.evaluate('e=>{const rs=[...e.querySelectorAll("button")].map(b=>b.getBoundingClientRect());return rs.every((r,i)=>rs.every((q,j)=>i===j||r.right<=q.left||q.right<=r.left||r.bottom<=q.top||q.bottom<=r.top))}')
   button.click();dialog=page.locator('.tag-options-dialog');expect(dialog).to_be_visible()
   assert dialog.evaluate('e=>{const r=e.getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&e.scrollWidth<=e.clientWidth+1}')
   expect(dialog.locator('.tag-source-row')).to_have_count(2)
   expect(dialog.locator('.tag-source-entry').first.locator('.tag-source-remove')).to_have_count(0)
   assert page.evaluate('JSON.parse(localStorage.getItem("deas.pref.prompt.tagCompletion")).sources.join()')=='builtin'
   assert dialog.locator('input').evaluate_all('(es)=>es.every(e=>{const r=e.getBoundingClientRect();return r.width>=13&&r.width<=16})')
   assert dialog.locator('.tag-source-row').evaluate_all('(es)=>es.every(e=>{const r=e.querySelector("input").getBoundingClientRect(),s=e.querySelector("span").getBoundingClientRect();return s.left-r.right>=6&&s.left-r.right<=12})')
   if locale=='en':assert dialog.bounding_box()['height']<560
   if locale=='en' and width==1920:page.screenshot(path=str(out/'compact-options.png'))
   dialog.locator('input[type=checkbox]').first.check()
   dialog.locator('input[type=radio]').nth(1).check()
   dialog.locator('select').first.select_option('32')
   dialog.locator('.tag-source-row').nth(1).locator('input').check()
   expect(dialog.locator('.tag-source-row').nth(1).locator('input')).to_be_checked()
   dialog.locator('fieldset > button').click()
   expect(dialog.locator('.tag-source-row')).to_have_count(3)
   dialog.locator('.tag-source-remove').last.click()
   expect(dialog.locator('.tag-source-row')).to_have_count(2)
   assert page.evaluate('__calls.filter(x=>x.c==="native_prompt_tag_remove").length')==1
   page.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(button).to_be_focused()
   positive=page.get_by_role('textbox',name='Positive');positive.fill('blue')
   floating=page.locator('body > .prompt-suggestions-floating');expect(floating.locator('[role=option]')).to_have_count(32)
   assert floating.evaluate('e=>{const r=e.getBoundingClientRect(),p=document.querySelector("textarea").getBoundingClientRect();return (r.top>=p.bottom||r.bottom<=p.top)&&r.left>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&r.top>=0&&r.width>=400}')
   page.keyboard.press('ArrowDown');page.keyboard.press('Tab');expect(positive).to_have_value('blue_tag_1');expect(floating).to_have_count(0)
   negative=page.get_by_role('textbox',name='Negative');negative.fill('blue');expect(floating.locator('[role=option]')).to_have_count(32)
   page.set_viewport_size({'width':width-100,'height':height})
   page.wait_for_function('document.querySelector(".prompt-suggestions-floating").getBoundingClientRect().right<=innerWidth+1')
   button.click();dialog=page.locator('.tag-options-dialog');dialog.locator('input[type=radio]').first.check();page.keyboard.press('Escape')
   positive.fill('blue');expect(page.locator('.prompt-textarea > .prompt-suggestions')).to_be_visible();expect(floating).to_have_count(0)
   button.click();dialog.locator('.tag-source-remove').click();expect(dialog.locator('.tag-source-row')).to_have_count(1);dialog.locator('input[type=checkbox]').first.uncheck();page.keyboard.press('Escape');positive.fill('blue again')
   page.wait_for_timeout(180);expect(page.get_by_role('listbox')).to_have_count(0)
   assert page.evaluate('__calls.filter(x=>x.c==="native_prompt_tag_import").length')==2
   assert not errors,errors
   reports.append({'locale':locale,'viewport':[width,height],'passed':True});context.close()
 browser.close()
(out/'report.json').write_text(json.dumps(reports,indent=2),encoding='utf-8');print(f'{len(reports)} desktop cases passed')
