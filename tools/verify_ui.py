"""Compact DEAS acceptance. No provisioning or backend requests.
Requires Playwright; use against the explicit Vite test server.
"""
from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright

url=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:1420'
root=Path(__file__).resolve().parents[1]
strings={}
for path in (root/'src').rglob('locales/en.json'):
    strings.update(json.loads(path.read_text()))

def button(page,key):
    return page.get_by_role('button',name=strings[key],exact=True)

def label(page,key):
    return page.get_by_label(strings[key],exact=True)

def target(page,node):
    option=page.locator(f'[data-choice="{node}"] button')
    return option if option.count() else page.locator(f'[data-node="{node}"] > button')

def click(page,node):
    target(page,node).click()

def tidy(page):
    page.mouse.move(1,1)
    page.evaluate('document.activeElement?.blur()')

def layout(page):
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), 'Horizontal overflow'
    for selector in ['.neural-graph [data-node]', '.neural-graph [data-choice]']:
        boxes=page.locator(selector).evaluate_all('els=>els.map(e=>e.getBoundingClientRect().toJSON())')
        for i,a in enumerate(boxes):
            for b in boxes[i+1:]:
                assert not (a['left']<b['right'] and a['right']>b['left'] and a['top']<b['bottom'] and a['bottom']>b['top']), 'Overlapping active hit targets'

results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    for width in (1440,1024,768,390,320):
        page=browser.new_page(viewport={'width':width,'height':960},reduced_motion='reduce')
        errors,requests=[],[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.on('request',lambda request:requests.append(request.url))
        page.goto(url,wait_until='networkidle')
        assert page.locator('html').get_attribute('lang')=='de'
        assert page.locator('[data-node]').count()==1
        assert page.locator('.language-control select').bounding_box()['width']<=112
        page.locator('.language-control select').select_option('en')
        tidy(page)
        assert page.locator('.neural-help:not(.neural-help-reserved)').count()==0
        base=page.locator('[data-node="setup:aio"]').bounding_box()
        assert base['width']<=145 and base['height']>=82
        assert base['x']<65
        target(page,'setup:aio').hover()
        page.wait_for_selector('.neural-help:not(.neural-help-reserved)')
        help_box=page.locator('.neural-help:not(.neural-help-reserved)').bounding_box()
        expanded=page.locator('[data-node="setup:aio"]').bounding_box()
        assert expanded==base, 'Hover changed bubble geometry'
        assert page.locator('[data-node]').count()==1 and page.locator('body > .neural-help').count()==0, 'Extra hover bubble'
        assert help_box['x']>=expanded['x'] and help_box['x']+help_box['width']<=expanded['x']+expanded['width']
        assert help_box['y']+help_box['height']<=expanded['y']+expanded['height'], 'Help outside existing bubble'
        if width==1440:
            page.screenshot(path=str(root/'assets/deas-compact-hover.png'))
        click(page,'setup:aio')
        page.locator('button[data-setup-mode="guided"]').click()
        assert page.locator('.neural-choice-group').count()==1
        managed=page.locator('[data-choice="setup:route:managed"]').bounding_box()
        existing=page.locator('[data-choice="setup:route:existing"]').bounding_box()
        assert existing['y']>managed['y'] and existing['x']>managed['x'], 'Choices are not staircase arranged'
        layout(page)
        click(page,'setup:route:managed')
        assert label(page,'setup.storageDirectory').count()==0
        button(page,'setup.confirmStep').click()
        assert button(page,'setup.pickParent').is_disabled(), 'Browser cannot pretend to open native picker'
        label(page,'setup.storageDirectory').fill('relative')
        button(page,'setup.confirmStep').click()
        assert page.get_by_role('alert').is_visible()
        label(page,'setup.storageDirectory').fill('/data/DEAS acceptance')
        button(page,'setup.confirmStep').click()
        assert page.locator('.neural-choice-group[data-selection-mode="multi"]').count()==1
        for feature in ('director',):
            assert target(page,'setup:pack:'+feature).get_attribute('aria-pressed')=='false'
        click(page,'setup:pack:director')
        assert page.locator('[data-kind="suggested"]').count()==0
        assert page.locator('[data-choice="setup:pack:director"] [data-included-feature]').count()==4
        layout(page)
        tidy(page)
        if width in (1440,320):
            page.screenshot(path=str(root/f'assets/deas-compact-options-{width}.png'),full_page=True)
        page.locator('.language-control select').select_option('de')
        assert target(page,'setup:pack:director').get_attribute('aria-pressed')=='true'
        page.locator('.language-control select').select_option('en')
        button(page,'setup.confirmStep').click()
        click(page,'setup:acceleration:cpu')
        assert label(page,'setup.exactPlan').count()==0
        button(page,'setup.confirmStep').click()
        assert page.locator('.neural-history [data-node]').count()>=4
        assert not page.locator('.aio-detail details').first.get_attribute('open')
        plan=json.loads(label(page,'setup.exactPlan').text_content())
        assert plan['features']==['director','forge','refmods','continuity'] and plan['backend']=='cpu' and plan['status']=='NOT INSTALLED'
        assert button(page,'setup.prepare').is_disabled()
        with page.expect_download() as download:
            button(page,'setup.export').click()
        assert json.loads(Path(download.value.path()).read_text())==plan
        click(page,'setup:storage')
        assert label(page,'setup.storageDirectory').input_value()=='/data/DEAS acceptance'
        button(page,'setup.confirmStep').click()
        button(page,'setup.confirmStep').click()
        button(page,'setup.confirmStep').click()
        assert json.loads(label(page,'setup.exactPlan').text_content())==plan, 'Reopening loses selections'
        click(page,'setup:route')
        click(page,'setup:route:existing')
        button(page,'setup.confirmStep').click()
        assert page.locator('[data-choice="setup:pack:director"]').count()==0
        label(page,'setup.backendUrl').fill('http://127.0.0.1:7801')
        button(page,'setup.confirmStep').click()
        button(page,'setup.inspect').click()
        assert page.locator('#endpoint').input_value()=='http://127.0.0.1:7801'
        assert page.locator('#endpoint').evaluate('el=>el===document.activeElement')
        assert page.locator('.studio-workspace [data-node]').count()==3
        assert page.locator('[data-node="director"] [data-included-feature]').count()==4
        click(page,'director')
        page.locator('#direction').fill('Compact draft acceptance')
        page.locator('#panel-director').get_by_role('button',name=strings['studio.save'],exact=True).click()
        page.reload(wait_until='networkidle')
        button(page,'studio.explore').click()
        tidy(page)
        layout(page)
        if width==1440:
            page.screenshot(path=str(root/'assets/deas-compact-studio.png'),full_page=True)
            assert page.evaluate('document.documentElement.scrollHeight')<=960, 'Studio map requires excessive scrolling'
        click(page,'director')
        assert page.locator('#direction').input_value()=='Compact draft acceptance'
        page.get_by_role('button',name='Close Director',exact=True).click()
        assert target(page,'director').evaluate('el=>el===document.activeElement')
        assert not errors,errors
        assert all(request.startswith(url) for request in requests)
        assert not any('/system_stats' in request or '/object_info' in request for request in requests)
        results.append({'width':width,'compactBubble':True,'stableInlineHelp':True,'groupedStairs':True,'returnableHistory':True,'planRoundtrip':True,'noBackendRequests':True})
        page.close()
    page=browser.new_page(viewport={'width':1440,'height':960},reduced_motion='no-preference')
    page.goto(url,wait_until='networkidle')
    page.locator('.language-control select').select_option('en')
    click(page,'setup:aio')
    page.locator('button[data-setup-mode="guided"]').click()
    light=page.locator('.neural-road-light').first
    before=light.evaluate('el=>getComputedStyle(el).strokeDashoffset')
    page.wait_for_timeout(250)
    assert light.evaluate('el=>getComputedStyle(el).strokeDashoffset')!=before
    page.get_by_role('radio',name=strings['setup.motion.paws'],exact=True).check()
    paw=page.locator('.neural-paw').first
    before=paw.evaluate('el=>{const m=el.getCTM();return [m.e,m.f]}')
    page.wait_for_timeout(350)
    assert paw.evaluate('el=>{const m=el.getCTM();return [m.e,m.f]}')!=before
    page.emulate_media(reduced_motion='reduce')
    page.wait_for_function("!document.querySelector('animateMotion')")
    assert page.locator('.neural-road-light').count()==0
    browser.close()
print(json.dumps(results,indent=2))
