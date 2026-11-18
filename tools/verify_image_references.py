"""H3 image-edit popup: synthetic browser geometry and pointer checks; no native execution."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

URL,OUT=sys.argv[1].rstrip('/'),Path(sys.argv[2]);OUT.mkdir(parents=True,exist_ok=True)
INIT=Path(__file__).with_name('references-manager-init.js').read_text(encoding='utf-8')
SVG='<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#365064"/><circle cx="80" cy="60" r="30" fill="#92b9ac"/></svg>'
reports=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    for locale in ['en','de','fr','ja','tr','zh']:
        for width,height in [(1920,1080),(1440,900),(1280,720),(1024,768)]:
            context=browser.new_context(viewport={'width':width,'height':height},user_agent='DEAS Windows Chromium fixture')
            page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.add_init_script(INIT.replace('LOCALE',json.dumps(locale)))
            page.route('**/fixture.png*',lambda r:r.fulfill(content_type='image/svg+xml',body=SVG))
            page.goto(URL+'/tools/references-manager-fixture.html?imageEdit',wait_until='networkidle')
            dialog=page.locator('.references-overlay[data-image-edit]');expect(dialog).to_be_visible()
            source=dialog.locator('[data-reference-source]');grid=dialog.locator('.image-edit-grid')
            geometry=lambda:dialog.evaluate('d=>[d.querySelector("[data-reference-source]"),d.querySelector(".image-edit-grid")].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})')
            before=geometry();page.locator('[data-fixture-fill]').click();assert geometry()==before
            rows=dialog.locator('[data-reference-controls]');expect(rows).to_have_count(8)
            assert grid.locator('.reference-pane-list').evaluate('e=>e.scrollHeight<=e.clientHeight+1')
            expect(source.locator('.wb-reference-position')).to_have_text('1')
            original_source=source.locator('img').get_attribute('alt');original=rows.evaluate_all('(es)=>es.map(e=>e.dataset.imageRefKey)')
            grip=rows.nth(0).locator('.reference-drag-grip').bounding_box();target=rows.nth(2).bounding_box()
            page.mouse.move(grip['x']+grip['width']/2,grip['y']+grip['height']/2);page.mouse.down();page.mouse.move(target['x']+target['width']/2,target['y']+target['height']/2,steps=10);page.mouse.up()
            expect(rows.nth(2)).to_have_attribute('data-image-ref-key',original[0]);expect(source.locator('img')).to_have_attribute('alt',original_source)
            rows.nth(0).locator('[data-preview-reference]').click();preview=page.locator('.reference-editor-dialog');expect(preview).to_be_visible();page.keyboard.press('Escape');expect(preview).to_have_count(0);expect(dialog).to_be_visible()
            rows.nth(0).locator('.reference-icon-insert').click();assert '<Picture 2>' in page.locator('[data-inserted]').text_content()
            next_source=rows.nth(0).locator('img').get_attribute('alt');rows.nth(0).locator('[data-reference-make-source]').click();expect(source.locator('img')).to_have_attribute('alt',next_source);expect(rows).to_have_count(8)
            source.locator('[data-reference-source-remove]').click();expect(rows).to_have_count(7);assert geometry()==before
            assert rows.locator('.reference-card-actions button').evaluate_all('(es)=>es.every(e=>{const r=e.getBoundingClientRect(),p=e.closest("[data-reference-controls]").getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.x>=p.x&&r.right<=p.right&&r.bottom<=p.bottom+1&&e.contains(hit)})')
            overflow=dialog.evaluate('d=>[d,...d.querySelectorAll(".references-overlay-body,.references-editor,.image-reference-manager,.image-edit-grid")].filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>e.className)');assert not overflow,(locale,width,overflow)
            if locale=='en':page.screenshot(path=str(OUT/f'image-references-{width}.png'))
            page.locator('[data-fixture-empty]').click();expect(rows).to_have_count(0);assert geometry()==before
            dialog.locator('.references-picker').get_by_role('button',name='Picture 0.png',exact=True).click();expect(rows).to_have_count(0)
            dialog.locator('[data-image-role="reference"]').click();expect(source.locator('img')).to_have_attribute('alt','Picture 0.png');expect(rows).to_have_count(0)
            assert not errors,errors;assert not page.evaluate('__calls.some(c=>/upload|submit|scan|prepare/.test(c))')
            reports.append({'locale':locale,'width':width,'pinnedSource':True,'eightReferences':True,'pointerReorder':True,'sourceSwapPromotion':True,'preview':True,'fixedBounds':True});context.close()
    browser.close()
(OUT/'results.json').write_text(json.dumps(reports,indent=2),encoding='utf-8');print(f'PASS {len(reports)} H3 image-edit reference cases; synthetic media only')
