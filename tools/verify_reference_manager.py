"""Fixed reference-pane geometry and interaction, synthetic media only; no native app capture.

Run against an owned Vite server: python tools/verify_reference_manager.py URL OUTPUT
"""
import json
import sys
import io
import wave
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

URL, OUT = sys.argv[1].rstrip('/'), Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
INIT = Path(__file__).with_name('references-manager-init.js').read_text(encoding='utf-8')

GEOMETRY = """()=>Object.fromEntries([...document.querySelectorAll('[data-reference-lane],[data-refmods]')].map(e=>{const r=e.getBoundingClientRect();return [e.dataset.referenceLane||'refmods',[r.x,r.y,r.width,r.height]]}))"""
SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#345865"/><circle cx="80" cy="60" r="30" fill="#8dbba5"/></svg>'
buffer=io.BytesIO()
with wave.open(buffer,'wb') as wav:
    wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(b'\0\0'*16000*8)
WAV=buffer.getvalue()
reports = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for locale in (['en'] if len(sys.argv)>3 else ['en', 'de', 'fr', 'ja', 'tr', 'zh']):
        for width, height in ([(1920,1080)] if len(sys.argv)>3 else [(1920,1080),(1440,900),(1280,720),(1024,768)]):
            print(f'REFERENCE_CASE {locale} {width}',flush=True)
            context = browser.new_context(viewport={'width':width,'height':height},user_agent='DEAS Windows Chromium fixture')
            page = context.new_page()
            errors=[]
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.route('**/fixture.png*', lambda r:r.fulfill(content_type='image/svg+xml',body=SVG))
            page.route('**/fixture/video-*', lambda r:r.fulfill(status=204))
            page.route('**/fixture/audio-*', lambda r:r.fulfill(content_type='audio/wav',body=WAV))
            page.add_init_script(INIT.replace('LOCALE',json.dumps(locale)))
            page.goto(URL+'/tools/references-manager-fixture.html',wait_until='networkidle')
            dialog=page.locator('.references-overlay')
            expect(dialog).to_be_visible()
            before=page.evaluate(GEOMETRY)
            page.locator('[data-fixture-fill]').click()
            expect(page.locator('[data-ref]')).to_have_count(15)  # retained over-limit fixture is intentional
            full=page.evaluate(GEOMETRY)
            assert before==full, ('adding media moved panes',locale,width,before,full)
            # Real mouse pointer capture, no synthetic HTML drag events: grid snap and Escape rollback.
            image_rows=dialog.locator('[data-reference-lane="image"] [data-ref]')
            order=image_rows.evaluate_all('(es)=>es.map(e=>e.dataset.referenceKey)')
            grip=image_rows.nth(0).locator('.reference-drag-grip').bounding_box()
            target=image_rows.nth(2).bounding_box()
            page.mouse.move(grip['x']+grip['width']/2,grip['y']+grip['height']/2);page.mouse.down()
            page.mouse.move(target['x']+target['width']/2,target['y']+target['height']/2,steps=10)
            page.mouse.up()
            expect(image_rows.nth(2)).to_have_attribute('data-reference-key',order[0])
            moved=image_rows.evaluate_all('(es)=>es.map(e=>e.dataset.referenceKey)')
            grip=image_rows.nth(0).locator('.reference-drag-grip').bounding_box();target=image_rows.nth(2).bounding_box()
            page.mouse.move(grip['x']+grip['width']/2,grip['y']+grip['height']/2);page.mouse.down()
            page.mouse.move(target['x']+target['width']/2,target['y']+target['height']/2,steps=10)
            page.keyboard.press('Escape');page.mouse.up()
            assert image_rows.evaluate_all('(es)=>es.map(e=>e.dataset.referenceKey)')==moved
            expect(dialog).to_be_visible()
            assert page.evaluate(GEOMETRY)==full
            assert all(r[3]>45 for r in full.values()), ('unreachable pane',full)
            folders=dialog.locator('.media-folders')
            files=dialog.locator('.media-scroll')
            folders.hover();page.mouse.wheel(0,600)
            page.wait_for_function('document.querySelector(".media-folders").scrollTop>0')
            assert files.evaluate('e=>e.scrollTop')==0
            folder_scroll=folders.evaluate('e=>e.scrollTop')
            files.hover();page.mouse.wheel(0,600)
            page.wait_for_function('document.querySelector(".media-scroll").scrollTop>0')
            assert folders.evaluate('e=>e.scrollTop')==folder_scroll
            folders.evaluate('e=>e.scrollTop=0');files.evaluate('e=>e.scrollTop=0')
            images=page.locator('[data-reference-lane="image"] > .reference-pane-list')
            assert images.evaluate('e=>e.scrollHeight<=e.clientHeight+1'), ('images should fit without scrolling',locale,width)
            assert page.locator('[data-reference-lane="image"] [data-ref]').evaluate_all('(es)=>es.every(e=>{const r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom+1})')
            # Only each pane scrolls; its neighbors retain their exact bounds.
            for pane in ['[data-reference-lane="image"]','[data-reference-lane="video"]','[data-reference-lane="audio"]','[data-refmods]']:
                scroller=page.locator(pane+' > .reference-pane-list')
                scroller.evaluate('e=>e.scrollTop=e.scrollHeight')
                assert page.evaluate(GEOMETRY)==full
                assert scroller.evaluate('e=>e.scrollHeight<=e.clientHeight||e.scrollTop>0')
                scroller.evaluate('e=>e.scrollTop=0')
            # Every action is visible on the card, reachable and named; remove stays red at rest.
            card=page.locator('[data-reference-lane="image"] [data-ref]').first
            expect(card.locator('.reference-card-actions button')).to_have_count(5)
            assert page.locator('.reference-card-menu,[popover]').count()==0
            assert card.locator('.reference-card-actions button').evaluate_all('(es)=>es.every(e=>{const r=e.getBoundingClientRect(),p=e.closest("[data-ref]").getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.x>=p.x&&r.right<=p.right&&r.top>=p.top&&r.bottom<=p.bottom+1&&e.contains(hit)&&!!e.title&&e.title===e.getAttribute("aria-label")})')
            assert card.locator('.reference-icon-remove').evaluate('(e)=>getComputedStyle(e).color!==getComputedStyle(e.parentElement.querySelector(".reference-icon-edit")).color')
            card.locator('[data-edit-reference]').click()
            editor=page.locator('.reference-editor-dialog')
            expect(editor).to_be_visible()
            expect(editor.locator('[data-ref-instructions]')).to_be_visible()
            page.keyboard.press('Escape')
            expect(editor).to_have_count(0)
            expect(card.locator('[data-edit-reference]')).to_be_focused()
            assert page.evaluate(GEOMETRY)==full
            # RefMod description editing remains nested and restores focus to its edit icon.
            mod=page.locator('[data-refmod]').first
            mod.locator('[data-edit-refmod]').click()
            expect(editor).to_be_visible()
            editor.locator('textarea').fill('Updated synthetic description')
            page.keyboard.press('Escape')
            expect(editor).to_have_count(0)
            expect(mod.locator('[data-edit-refmod]')).to_be_focused()
            # Compact audio preview lazily creates one player, pauses, and stops when its editor opens.
            audio_list=dialog.locator('[data-reference-lane="audio"] > .reference-pane-list')
            audio_rows=audio_list.locator('[data-ref]')
            if audio_list.evaluate('e=>e.scrollHeight>e.clientHeight+2'):
                audio_list.evaluate('e=>e.scrollTop=0')
                first_audio=audio_rows.first.get_attribute('data-reference-key')
                grip=audio_rows.first.locator('.reference-drag-grip').bounding_box();edge=audio_list.bounding_box()
                page.mouse.move(grip['x']+grip['width']/2,grip['y']+grip['height']/2);page.mouse.down()
                page.mouse.move(grip['x']+grip['width']/2,edge['y']+edge['height']-2,steps=8)
                try:
                    page.wait_for_function('(()=>{const e=document.querySelector("[data-reference-lane=audio] > .reference-pane-list");return e.scrollTop>=e.scrollHeight-e.clientHeight-2})()',timeout=3000)
                except Exception:
                    print(audio_list.evaluate('(e)=>({top:e.scrollTop,height:e.clientHeight,total:e.scrollHeight,rows:[...e.children].map(c=>({key:c.dataset.referenceKey,class:c.className,rect:c.getBoundingClientRect().toJSON()})),capture:e.closest("[data-references]").hasPointerCapture(1),focus:document.activeElement?.outerHTML})'),flush=True)
                    page.screenshot(path=str(OUT/'drag-failure.png'))
                    raise
                page.mouse.up();expect(audio_rows.last).to_have_attribute('data-reference-key',first_audio)
                audio_list.evaluate('e=>e.scrollTop=0')
            sound=dialog.locator('[data-reference-lane="audio"] [data-ref]').first
            sound.locator('.reference-audio-preview button').click()
            page.wait_for_function('document.querySelector("[data-ref] audio")?.currentTime>.1')
            page.evaluate('window.__inlineAudio=document.querySelector("[data-ref] audio")')
            sound.locator('.reference-audio-preview button').click()
            assert page.evaluate('__inlineAudio.paused')
            sound.locator('.reference-audio-preview button').click()
            page.wait_for_function('!__inlineAudio.paused')
            sound.locator('.reference-icon-edit').click()
            expect(editor).to_be_visible()
            page.wait_for_function('__inlineAudio.paused&&!document.querySelector("[data-ref] audio")')
            page.wait_for_function('document.querySelector(".reference-editor-dialog audio").duration>0')
            fields=editor.locator('input[type="number"]')
            geometry=lambda:editor.evaluate('e=>[e,e.querySelector(".reference-media-trims"),e.querySelector(".reference-media-actions")].map(el=>{const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})')
            stable=geometry();fields.nth(1).fill('1.15')
            expect(editor.locator('.reference-media-notice [role="alert"]')).to_be_visible()
            assert geometry()==stable,('trim warning moved editor',locale,width,stable,geometry())
            fields.nth(1).fill('5');expect(editor.locator('.reference-media-notice [role="alert"]')).to_have_count(0)
            assert geometry()==stable
            page.keyboard.press('Escape')
            splitter=page.locator('.reference-manager-divider')
            splitter.focus()
            page.keyboard.press('ArrowLeft')
            resized=page.evaluate(GEOMETRY)
            assert resized['image']==full['image']
            assert resized['refmods'][2]>full['refmods'][2]
            page.keyboard.press('ArrowRight')
            assert page.evaluate(GEOMETRY)==full
            # Emptying and refilling never collapses a panel.
            page.locator('[data-fixture-empty]').click()
            expect(page.locator('[data-ref]')).to_have_count(0)
            assert page.evaluate(GEOMETRY)==before
            page.locator('[data-fixture-fill]').click()
            assert page.evaluate(GEOMETRY)==full
            # Identical picture files still occupy independent slots with separate editor values.
            page.locator('[data-fixture-empty]').click()
            dialog.locator('.references-picker').get_by_role('button',name='Picture 0.png',exact=True).click()
            dialog.locator('[data-video-role="reference"]').click()
            dialog.locator('[data-video-role="reference"]').click()
            copies=dialog.locator('[data-reference-lane="image"] [data-ref]')
            expect(copies).to_have_count(2)
            copies.nth(1).locator('.reference-icon-edit').click()
            editor.locator('[data-ref-instructions]').fill('Only the second slot')
            editor.locator('[data-ref-label]').select_option('style')
            page.keyboard.press('Escape')
            copies.nth(0).locator('.reference-icon-edit').click()
            expect(editor.locator('[data-ref-instructions]')).to_have_value('')
            page.keyboard.press('Escape')
            copies.nth(1).locator('.reference-icon-earlier').click()
            copies.nth(0).locator('.reference-icon-edit').click()
            expect(editor.locator('[data-ref-instructions]')).to_have_value('Only the second slot')
            page.keyboard.press('Escape')
            copies.nth(0).locator('.reference-icon-remove').click()
            expect(copies).to_have_count(1)
            assert page.evaluate(GEOMETRY)==before
            page.locator('[data-fixture-fill]').click()
            overflow=dialog.evaluate("""d=>[d,...d.querySelectorAll('.references-overlay-body,.references-picker,.references-editor,.reference-manager,.reference-manager-pane,.reference-manager-card')].filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>({class:e.className,extra:e.scrollWidth-e.clientWidth}))""")
            assert not overflow,(locale,width,overflow)
            assert not errors, errors
            if locale=='en':page.screenshot(path=str(OUT/f'references-{width}.png'))
            assert not page.evaluate('__calls.some(c=>/upload|submit|scan|prepare/.test(c))')
            reports.append({'locale':locale,'width':width,'height':height,'fixedPaneBounds':True,'independentScroll':True,'nestedEditors':True,'divider':True})
            context.close()
    browser.close()
(OUT/'results.json').write_text(json.dumps(reports,indent=2),encoding='utf-8')
print(f'PASS {len(reports)} reference-manager geometry/interaction cases; synthetic media only')
