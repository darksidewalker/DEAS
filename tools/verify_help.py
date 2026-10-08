"""Regression: hover expands existing buttons, never creates another bubble."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]

def contained(page):
    errors=page.evaluate('''() => {
      const errors=[];
      for(const help of document.querySelectorAll('.neural-help:not(.neural-help-reserved)')) {
        const owner=help.closest('button');
        if(!owner) { errors.push('detached description');continue; }
        const a=help.getBoundingClientRect(),b=owner.getBoundingClientRect();
        if(a.left<b.left || a.right>b.right || a.top<b.top || a.bottom>b.bottom) errors.push('description outside button');
      }
      const choices=[...document.querySelectorAll('.neural-graph [data-choice]')].map(e=>e.getBoundingClientRect());
      for(let i=0;i<choices.length;i++) for(let j=i+1;j<choices.length;j++) {
        const a=choices[i],b=choices[j];
        if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top) errors.push('overlapping choices');
      }
      return errors;
    }''')
    assert not errors,errors

with sync_playwright() as p:
    browser=p.chromium.launch()
    results=[]
    for width,height in [(1440,960),(1024,720),(768,720),(390,720),(320,720)]:
        page=browser.new_page(viewport={'width':width,'height':height},reduced_motion='reduce')
        page.goto('http://127.0.0.1:1420',wait_until='networkidle')
        page.locator('.language-control select').select_option('en')
        page.get_by_role('button',name='AiO installer',exact=True).click()
        page.mouse.move(1,1)
        assert page.locator('.neural-help:not(.neural-help-reserved)').count()==0
        count=page.locator('.neural-blob').count()
        for node in ['setup:route','setup:route:managed','setup:route:existing']:
            button=page.locator(f'[data-choice="{node}"] button, [data-node="{node}"] > button')
            button.hover()
            page.wait_for_selector('.neural-help:not(.neural-help-reserved)')
            assert page.locator('.neural-blob').count()==count
            assert page.locator('body > .neural-help').count()==0
            contained(page)
            button.focus()
            contained(page)
            page.evaluate('document.activeElement?.blur()')
            page.mouse.move(1,1)
        page.locator('[data-choice="setup:route:managed"] button').click()
        page.get_by_role('button',name='Confirm & continue',exact=True).click()
        page.get_by_label('Storage directory',exact=True).fill('/data/hover-regression-not-installed')
        page.get_by_role('button',name='Confirm & continue',exact=True).click()
        for feature in ['director']:
            button=page.locator(f'[data-choice="setup:pack:{feature}"] button')
            count=page.locator('.neural-blob').count()
            button.hover()
            page.wait_for_selector('.neural-help:not(.neural-help-reserved)')
            assert page.locator('.neural-blob').count()==count
            contained(page)
            if width==1440:
                assert page.locator('[data-choice="setup:pack:director"] [data-included-feature]').count()==4
                assert page.locator('[data-kind="suggested"]').count()==0
                assert button.get_attribute('aria-pressed')=='false'
                page.screenshot(path=str(root/'assets/deas-inline-help-flags.png'))
            button.click()
            assert page.locator('.neural-help:not(.neural-help-reserved)').count()==0
        assert page.locator('[data-choice]').count()==1
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        results.append({'width':width,'height':height,'noAdditionalBubbles':True,'containedDescription':True,'clickDismissesHelp':True})
        page.close()
    browser.close()
print(json.dumps(results,indent=2))
