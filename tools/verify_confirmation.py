"""DEAS selection/confirmation acceptance; browser only, no provisioning."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
STRINGS={}
for file in (ROOT/'src').rglob('locales/en.json'):
    STRINGS.update(json.loads(file.read_text()))

def target(page,identifier):
    choice=page.locator(f'[data-choice="{identifier}"] button')
    return choice if choice.count() else page.locator(f'[data-node="{identifier}"] > button')

def confirm(page):
    page.get_by_role('button',name=STRINGS['setup.confirmStep'],exact=True).click()

def no_overflow(page):
    assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'), 'Horizontal overflow'
    assert page.locator('[data-kind="suggested"]').count()==0, 'Suggestion connection line remains'
    assert page.locator('.neural-road-label').count()==0, 'Suggestion road label remains'
    for selector in ['.neural-graph [data-node]','.neural-graph [data-choice]']:
        boxes=page.locator(selector).evaluate_all('els=>els.map(el=>el.getBoundingClientRect().toJSON())')
        for index,a in enumerate(boxes):
            for b in boxes[index+1:]:
                assert not(a['left']<b['right'] and a['right']>b['left'] and a['top']<b['bottom'] and a['bottom']>b['top']), 'Overlapping active choices'

with sync_playwright() as p:
    browser=p.chromium.launch()
    results=[]
    for width in (1440,1024,768,390,320):
        page=browser.new_page(viewport={'width':width,'height':960},reduced_motion='reduce')
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto('http://127.0.0.1:1420',wait_until='networkidle')
        page.locator('.language-control select').select_option('en')
        target(page,'setup:aio').click()
        page.locator('button[data-setup-mode="guided"]').click()
        target(page,'setup:route:managed').click()
        assert page.get_by_label(STRINGS['setup.storageDirectory'],exact=True).count()==0, 'Route click auto-advanced'
        target(page,'setup:route').click()
        assert page.get_by_label(STRINGS['setup.storageDirectory'],exact=True).count()==0, 'Heading bypassed confirmation'
        confirm(page)
        page.get_by_label(STRINGS['setup.storageDirectory'],exact=True).fill('/data/deas-confirmation-not-installed')
        confirm(page)
        director=target(page,'setup:pack:director')
        director.click()
        assert director.get_attribute('aria-pressed')=='true'
        for identifier in ('forge','refmods','continuity','output'):
            micro=page.locator(f'[data-choice="setup:pack:director"] [data-included-feature="{identifier}"]')
            assert micro.count()==1, identifier
            assert micro.locator('button,input,[role="button"]').count()==0, 'Included feature is an extra control'
            assert page.locator(f'[data-choice="setup:pack:{identifier}"]').count()==0, 'Included feature remains optional'
        assert page.locator('[data-choice="setup:acceleration:cpu"]').count()==0, 'Capability click auto-advanced'
        no_overflow(page)
        if width in (1440,320):
            page.mouse.move(1,1)
            page.evaluate('document.activeElement?.blur()')
            page.screenshot(path=str(ROOT/f'assets/deas-director-included-{width}.png'),full_page=True)
        confirm(page)
        target(page,'setup:acceleration:cpu').click()
        assert page.get_by_label(STRINGS['setup.exactPlan'],exact=True).count()==0, 'Backend click skipped extra options'
        target(page,'setup:acceleration').click()
        assert page.get_by_label(STRINGS['setup.exactPlan'],exact=True).count()==0, 'Backend heading skipped extra options'
        page.get_by_label(STRINGS['setup.option.ffmpeg'],exact=True).check()
        page.get_by_label(STRINGS['setup.comfyRef'],exact=True).fill('master')
        no_overflow(page)
        if width==1440:
            page.screenshot(path=str(ROOT/'assets/deas-backend-confirmation.png'),full_page=True)
        confirm(page)
        plan=json.loads(page.get_by_label(STRINGS['setup.exactPlan'],exact=True).text_content())
        assert plan['features']==['director','forge','refmods','continuity'],plan
        assert plan['options']['ffmpeg'] is True and plan['backend']=='cpu'
        assert page.get_by_role('button',name=STRINGS['setup.prepare'],exact=True).is_disabled()
        page.get_by_role('button',name=STRINGS['setup.save'],exact=True).click()
        page.reload(wait_until='networkidle')
        page.get_by_role('button',name=STRINGS['setup.restore'],exact=True).click()
        restored=json.loads(page.get_by_label(STRINGS['setup.exactPlan'],exact=True).text_content())
        assert restored==plan, 'Draft roundtrip changed confirmed options'
        target(page,'setup:acceleration').click()
        assert page.get_by_label(STRINGS['setup.option.ffmpeg'],exact=True).is_checked()
        target(page,'setup:acceleration:amd').click()
        assert page.get_by_label(STRINGS['setup.option.ffmpeg'],exact=True).is_checked(), 'Choice discarded extra option'
        assert page.get_by_label(STRINGS['setup.exactPlan'],exact=True).count()==0, 'Edit bypassed confirmation'
        confirm(page)
        updated=json.loads(page.get_by_label(STRINGS['setup.exactPlan'],exact=True).text_content())
        assert updated['backend']=='amd' and updated['options']['ffmpeg'] is True
        no_overflow(page)
        assert not errors,errors
        results.append({'width':width,'explicitConfirmation':True,'extrasPreserved':True,'includedMicrofeatures':True,'noSuggestedLines':True,'draftRoundtrip':True})
        page.close()
    browser.close()
print(json.dumps(results,indent=2))
