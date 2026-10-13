"""Real geometry checks: stable choices and a content-anchored green footer."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
STRINGS = {}
for path in (ROOT/'src').rglob('locales/en.json'):
    STRINGS.update(json.loads(path.read_text()))


def button(page, identifier):
    choice = page.locator(f'[data-choice="{identifier}"] button')
    return choice if choice.count() else page.locator(f'[data-node="{identifier}"] > button')


def geometry(page):
    return page.locator('.neural-graph [data-node], .neural-graph [data-choice]').evaluate_all('''els => els.map(el => {
      const r=el.getBoundingClientRect(); return [el.dataset.node||el.dataset.choice,r.x+scrollX,r.y+scrollY,r.width,r.height];
    })''')


def unchanged(before, after):
    assert len(before) == len(after), (before, after)
    for a, b in zip(before, after):
        assert a[0] == b[0] and all(abs(x-y) < 1 for x, y in zip(a[1:], b[1:])), ('Geometry changed', a, b)


def content_anchor(page, confirm):
    metrics = confirm.evaluate('''el => {
      const area=el.closest('.aio-decision-area'), rail=el.parentElement;
      const r=el.getBoundingClientRect(), a=area.getBoundingClientRect();
      const detail=area.querySelector('.aio-detail'), graph=area.querySelector('.neural-graph');
      const bottom=(detail||graph).getBoundingClientRect().bottom;
      const controls=[...area.querySelectorAll('.aio-detail input, .aio-detail button, [data-choice], [data-node]')];
      return {same:el===window.stabilityConfirm, outsideForm:!el.closest('form'),
        position:getComputedStyle(rail).position, right:r.right-a.right, bottom:r.bottom-a.bottom,
        gap:r.top-bottom, width:a.width, overflow:document.documentElement.scrollWidth>innerWidth,
        overlap:controls.some(c=>{const b=c.getBoundingClientRect();return b.width&&b.height&&r.left<b.right&&r.right>b.left&&r.top<b.bottom&&r.bottom>b.top;}),
        box:[r.x+scrollX,r.y+scrollY,r.width,r.height]};
    }''')
    assert metrics['same'] and metrics['outsideForm'], metrics
    assert metrics['position'] == 'static', metrics
    assert abs(metrics['right']) < 1 and abs(metrics['bottom']) < 1, metrics
    assert 0 <= metrics['gap'] <= 20, ('Footer must immediately follow current controls', metrics)
    assert metrics['width'] <= 769 and not metrics['overflow'] and not metrics['overlap'], metrics
    return metrics['box']


with sync_playwright() as p:
    browser = p.chromium.launch()
    results = []
    for width in (1440, 1024, 768, 390, 320):
        page = browser.new_page(viewport={'width':width, 'height':960}, reduced_motion='no-preference')
        page.goto('http://127.0.0.1:1420', wait_until='networkidle')
        page.locator('.language-control select').select_option('en')
        button(page, 'setup:aio').click()
        page.locator('button[data-setup-mode="guided"]').click()
        confirm = page.get_by_role('button', name=STRINGS['setup.confirmStep'], exact=True)
        confirm.evaluate('el=>window.stabilityConfirm=el')
        color = confirm.evaluate('el=>getComputedStyle(el).backgroundColor')
        channels = [int(x) for x in color.strip('rgba() ').replace(',', ' ').split()[:3]]
        assert channels[1] > channels[0] and channels[1] > channels[2], ('Not green', color)
        content_anchor(page, confirm)

        def hover_stable(identifier):
            before = geometry(page)
            anchor = content_anchor(page, confirm)
            target = button(page, identifier)
            target.hover()
            page.wait_for_timeout(250)
            unchanged(before, geometry(page))
            unchanged([['confirm', *anchor]], [['confirm', *content_anchor(page, confirm)]])
            target.focus()
            unchanged(before, geometry(page))
            unchanged([['confirm', *anchor]], [['confirm', *content_anchor(page, confirm)]])
            page.mouse.move(1, 1)
            page.evaluate('document.activeElement?.blur()')
            unchanged(before, geometry(page))

        def select_stable(identifier):
            before = geometry(page)
            anchor = content_anchor(page, confirm)
            button(page, identifier).click()
            unchanged(before, geometry(page))
            unchanged([['confirm', *anchor]], [['confirm', *content_anchor(page, confirm)]])

        hover_stable('setup:route')
        hover_stable('setup:route:managed')
        select_stable('setup:route:managed')
        confirm.click()
        content_anchor(page, confirm)
        assert confirm.get_attribute('form') == 'aio-step-input-form'
        page.get_by_label(STRINGS['setup.storageDirectory'], exact=True).fill('/data/deas-stability-not-installed')
        # Native browser Enter submission must use the persistent external submit button.
        page.get_by_label(STRINGS['setup.storageDirectory'], exact=True).press('Enter')
        content_anchor(page, confirm)
        assert confirm.get_attribute('form') is None
        hover_stable('setup:pack:director')
        select_stable('setup:pack:director')
        confirm.click()
        content_anchor(page, confirm)
        for identifier in ('cpu', 'nvidia', 'amd', 'intel'):
            hover_stable('setup:acceleration:'+identifier)
        select_stable('setup:acceleration:cpu')
        before = geometry(page)
        anchor = content_anchor(page, confirm)
        page.get_by_label(STRINGS['setup.option.ffmpeg'], exact=True).check()
        unchanged(before, geometry(page))
        unchanged([['confirm', *anchor]], [['confirm', *content_anchor(page, confirm)]])
        page.get_by_label(STRINGS['setup.comfyRef'], exact=True).fill('v0.3.50')
        content_anchor(page, confirm)
        # Force a scrollable viewport without inserting fake content or changing controls.
        page.set_viewport_size({'width':width, 'height':320})
        page.evaluate('scrollTo(0,0)')
        top_box = confirm.bounding_box()
        doc_box = content_anchor(page, confirm)
        page.evaluate('scrollTo(0,document.documentElement.scrollHeight)')
        scroll = page.evaluate('scrollY')
        assert scroll > 0, 'Selection area should remain normally scrollable'
        bottom_box = confirm.bounding_box()
        assert abs((top_box['y']-bottom_box['y'])-scroll) < 1, ('CTA stuck to viewport', top_box, bottom_box, scroll)
        unchanged([['confirm', *doc_box]], [['confirm', *content_anchor(page, confirm)]])
        page.set_viewport_size({'width':width, 'height':960})
        confirm.scroll_into_view_if_needed()
        if width in (1440, 320):
            page.screenshot(path=str(ROOT/f'assets/deas-stable-controls-{width}.png'))
        confirm.click()
        exact = page.get_by_label(STRINGS['setup.exactPlan'], exact=True)
        assert exact.count() == 1
        plan = json.loads(exact.text_content())
        assert plan['options']['ffmpeg'] and plan['comfyRef'] == 'v0.3.50', plan
        assert confirm.count() == 0
        results.append({'width':width, 'greenConfirm':True, 'contentAnchoredFooter':True,
                        'stableHoverFocusSelection':True, 'normalScrolling':True, 'noOverlap':True})
        page.close()
    browser.close()
print(json.dumps(results, indent=2))
