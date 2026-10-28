"""References overlay + real browser media playback; mocked backend IPC, no inference.
Run with the owned Vite URL and an existing directory containing clip.mp4 and voice.wav.
"""
from pathlib import Path
import importlib.util
import json
import sys
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = sys.argv[1].rstrip('/')
MEDIA = Path(sys.argv[2])
OUT = Path(sys.argv[3]) if len(sys.argv) > 3 else ROOT / 'artifacts/verification/references'
spec = importlib.util.spec_from_file_location('continuity_fixture', ROOT / 'tools/verify_continuity.py')
assert spec is not None and spec.loader is not None
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
INIT = fixture.INIT.replace("JSON.stringify('t2v')", "JSON.stringify('ref2v')").replace("convertFileSrc:path=>path", "convertFileSrc:path=>'/fixture-media/'+path.split('/').pop()")
INIT = INIT.replace("if(command==='native_media_list')return {path:args.path,parent:null,entries:[],truncated:false};", """
  if(command==='native_media_list')return {path:args.path,parent:null,entries:['clip.mp4','voice.wav'].map(name=>({name,path:'/env/input/'+name,kind:'file',symlink:false,media:name.endsWith('.wav')?'audio':'video',size:100,modified:1})),truncated:false};
  if(command==='native_logs_reference_media_error')return null;
""")
INIT += "\nwindow.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};\nObject.defineProperty(navigator,'userAgent',{value:'DEAS Windows browser fixture'});"

with sync_playwright() as p:
    OUT.mkdir(parents=True, exist_ok=True)
    browser = p.chromium.launch(headless=True)
    reports = []
    for locale in ['en', 'de', 'fr', 'tr', 'ja', 'zh']:
        for width in [1440, 700, 320]:
            context = browser.new_context(viewport={'width': width, 'height': 1000})
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            def serve_media(route):
                path = MEDIA / route.request.url.split('/')[-1]
                data = path.read_bytes()
                mime = 'audio/wav' if path.suffix == '.wav' else 'video/mp4'
                import re
                match = re.fullmatch(r'bytes=(\d+)-(\d*)', route.request.headers.get('range', ''))
                if match:
                    start = int(match[1]); end = min(int(match[2]) if match[2] else len(data)-1, len(data)-1)
                    route.fulfill(status=206, content_type=mime, body=data[start:end+1], headers={'Accept-Ranges':'bytes','Content-Range':f'bytes {start}-{end}/{len(data)}'})
                else:
                    route.fulfill(content_type=mime, body=data, headers={'Accept-Ranges':'bytes'})
            page.route('**/fixture-media/*', serve_media)
            page.add_init_script(INIT.replace('LOCALE', json.dumps(locale)))
            page.goto(URL + '/tools/inpaint-fixture.html', wait_until='networkidle')
            opener = page.locator('[data-open-references]')
            expect(opener).to_be_visible()
            expect(page.locator('[data-dock-tab="references"]')).to_have_count(0)
            opener.click()
            dialog = page.locator('.references-overlay')
            expect(dialog).to_be_visible()
            assert dialog.evaluate('(d)=>d.matches(":modal")')
            picker = dialog.locator('.references-picker')
            picker.get_by_role('button', name='clip.mp4', exact=True).click()
            card = dialog.locator('[data-ref="clip.mp4"]')
            expect(card).to_be_visible()
            video = card.locator('video')
            expect(video).to_have_count(1)
            page.wait_for_function('document.querySelector("[data-ref] video").duration > 0')
            assert video.evaluate('(v)=>v.muted')
            inputs = card.locator('input[type="number"]')
            inputs.nth(0).fill('1')
            inputs.nth(1).fill('3')
            play = card.locator('.reference-media-actions button').nth(0)
            expect(play).to_be_enabled()
            play.click()
            try:
                page.wait_for_function('(()=>{const v=document.querySelector("[data-ref] video");return v&&!v.paused&&v.currentTime>1.1})()', timeout=5000)
            except Exception:
                print(card.inner_text())
                print(video.evaluate('(v)=>({time:v.currentTime,paused:v.paused,ready:v.readyState,error:v.error?.message,network:v.networkState,duration:v.duration})'))
                page.screenshot(path=str(OUT / 'failure.png'))
                raise
            page.wait_for_function('(()=>{const v=document.querySelector("[data-ref] video");return v&&v.paused&&v.currentTime>=2.95&&v.currentTime<=3.1})()')
            # Both streams keep sound; sound-only moves to Audio without losing crop.
            card.locator('select[aria-label]').last.select_option('video_audio')
            assert not card.locator('video').evaluate('(v)=>v.muted')
            card.locator('select[aria-label]').last.select_option('audio')
            expect(card.locator('video')).to_have_count(0)
            expect(card.locator('audio')).to_have_count(1)
            expect(inputs.nth(0)).to_have_value('1')
            expect(inputs.nth(1)).to_have_value('3')
            assert card.locator('xpath=ancestor::section[1]').get_attribute('aria-label') == dialog.locator('.wb-lane').nth(2).get_attribute('aria-label')
            picker.get_by_role('button', name='voice.wav', exact=True).click()
            audio = dialog.locator('[data-ref="voice.wav"] audio')
            expect(audio).to_have_count(1)
            page.wait_for_function('s=>document.querySelector(s).duration > 0', arg='[data-ref="voice.wav"] audio')
            sound_card = dialog.locator('[data-ref="voice.wav"]')
            sound_card.locator('input[type="number"]').nth(0).fill('2')
            sound_card.locator('input[type="number"]').nth(1).fill('4')
            sound_card.locator('.reference-media-actions button').nth(0).click()
            page.wait_for_function('s=>{const a=document.querySelector(s);return a&&a.paused&&a.currentTime>=3.95&&a.currentTime<=4.1}', arg='[data-ref="voice.wav"] audio')
            # Real modal focus containment and nested width, not only outer dimensions.
            for _ in range(6):
                page.keyboard.press('Tab')
                assert page.evaluate('document.activeElement===document.body||!!document.activeElement.closest(".references-overlay")')
            overflow = dialog.evaluate('d=>[d,...d.querySelectorAll(".references-overlay-body,.references-picker,.references-editor,.reference-media")].map(e=>({class:e.className,overflow:e.scrollWidth-e.clientWidth})).filter(x=>x.overflow>2)')
            assert not overflow, overflow
            if locale == 'en':
                dialog.locator('.references-editor').evaluate('e=>e.scrollTop=0')
                page.screenshot(path=str(OUT / f'references-{width}.png'))
            page.keyboard.press('Escape')
            expect(dialog).to_have_count(0)
            expect(opener).to_be_focused()
            assert not errors, errors
            assert not page.evaluate('window.__unexpected'), page.evaluate('window.__unexpected')
            assert not page.evaluate('window.__calls.some(x=>/submit|upload|prepare/.test(x.command)&&x.command!=="native_recipe_prerequisites")')
            reports.append({'locale': locale, 'width': width, 'modal': True, 'videoCrop': [1, 3], 'audioCrop': [2, 4]})
            context.close()
    browser.close()
    (OUT / 'results.json').write_text(json.dumps(reports, indent=2))
    print(f'PASS {len(reports)} locale/width cases; real MP4/WAV crop playback, mocked backend IPC, no inference')
