"""Real Chromium media toolbar layout; mocked IPC, no native/model acceptance."""
import json
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright, expect
from verify_projects import INIT

URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4197').rstrip('/')
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home()/'.hermes/cache/scratch/deas-media-toolbar'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for locale in ['en', 'de', 'fr', 'ja', 'tr', 'zh']:
            for width in [1440, 960, 320]:
                page = browser.new_page(viewport={'width': width, 'height': 1000})
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.add_init_script(INIT.replace('LOCALE', json.dumps(locale)))
                page.goto(URL+'/tools/inpaint-fixture.html', wait_until='networkidle')
                hint = page.locator('.media-header .media-drop-hint')
                expect(hint).to_be_visible()
                assert hint.evaluate('e=>e.previousElementSibling.classList.contains("media-depth")')
                assert not page.locator('.media-files .media-drop-hint').count()
                assert hint.evaluate('e=>getComputedStyle(e).backgroundColor') == 'rgba(0, 0, 0, 0)'
                assert hint.evaluate('e=>getComputedStyle(e).position') == 'static'
                depth = page.locator('.media-depth select')
                roots = page.locator('.media-roots')
                expect(roots).to_be_visible()
                assert roots.locator('[data-media-root]').evaluate_all('es=>es.map(e=>e.dataset.mediaRoot)') == ['output', 'starred', 'input']
                assert not page.locator('.media-starred-switch, .media-header [role="switch"]').count()
                assert roots.evaluate('e=>e.nextElementSibling.classList.contains("media-depth")')
                folder = page.locator('.media-header > button')
                assert depth.bounding_box()['height'] <= folder.bounding_box()['height']+1
                search = page.locator('[data-dock-search]').bounding_box()
                heights = [page.locator(f'[data-dock-{key}]').bounding_box()['height'] for key in ['sort', 'type', 'view']]
                assert all(abs(h-search['height']) <= 1 for h in heights), (locale, width, search['height'], heights)
                for key in ['sort', 'type', 'view']:
                    metrics = page.locator(f'[data-dock-{key}]').evaluate('''e=>{
                        const s=getComputedStyle(e),c=document.createElement('canvas').getContext('2d');c.font=s.font;
                        const r=e.getBoundingClientRect(),available=r.width-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)-parseFloat(s.borderLeftWidth)-parseFloat(s.borderRightWidth);
                        return {font:parseFloat(s.fontSize),available,widest:Math.max(...Array.from(e.options,o=>c.measureText(o.text).width)),appearance:s.appearance,paddingTop:s.paddingTop,paddingBottom:s.paddingBottom};
                    }''')
                    assert metrics['font'] >= 12 and metrics['widest'] <= metrics['available']+1, (locale,width,key,metrics)
                    assert metrics['appearance'] == 'none' and metrics['paddingTop'] == '0px' and metrics['paddingBottom'] == '0px', metrics
                run = page.locator('[data-run]').bounding_box()
                arrow = page.locator('.project-menu > summary').bounding_box()
                group = page.locator('.wb-run-actions').bounding_box()
                assert run['width'] >= group['width']-33 and run['height'] >= 40, (locale,width,run,group)
                assert abs(run['x']+run['width']-arrow['x']) <= 1 and abs(run['height']-arrow['height']) <= 1, (run,arrow)
                header = hint.locator('..').bounding_box()
                hint_box = hint.bounding_box()
                assert hint_box['y'] >= header['y'] and hint_box['y']+hint_box['height'] <= header['y']+header['height']+1
                roots_box = roots.bounding_box()
                assert roots_box['x'] >= header['x'] and roots_box['x']+roots_box['width'] <= header['x']+header['width']+1
                assert not errors, errors
                assert not page.evaluate('window.__unexpected'), page.evaluate('window.__unexpected')
                page.screenshot(path=str(OUT/f'{locale}-{width}.png'), full_page=True)
                results.append({'locale': locale, 'width': width, 'searchHeight': search['height'], 'dropdownHeights': heights, 'depthHeight': depth.bounding_box()['height']})
                page.close()
        browser.close()
    (OUT/'results.json').write_text(json.dumps(results, indent=2)+'\n')
    print(f'PASS: {len(results)} Chromium toolbar cases; inline transparent help, compact Depth and search-aligned sort/filter/view controls.')


if __name__ == '__main__':
    main()
