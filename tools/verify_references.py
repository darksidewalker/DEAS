"""References overlay + real browser media playback; mocked backend IPC, no inference.
Run with the owned Vite URL and an existing directory containing clip.mp4 and voice.wav.
"""
from pathlib import Path
import importlib.util
import json
import sys
import subprocess
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
  if(command==='native_media_reference_thumbnail')return '/env/input/clip.png';
""")
INIT += "\nwindow.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};\nObject.defineProperty(navigator,'userAgent',{value:'DEAS Windows browser fixture'});"

with sync_playwright() as p:
    OUT.mkdir(parents=True, exist_ok=True)
    # Mock the native thumbnail transport with an actual decoded fixture frame.
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(MEDIA / 'clip.mp4'), '-frames:v', '1', str(OUT / 'clip.png')], check=True)
    browser = p.chromium.launch(headless=True)
    reports = []
    for locale in ['en', 'de', 'fr', 'tr', 'ja', 'zh']:
        for width in [1440, 700, 320]:
            context = browser.new_context(viewport={'width': width, 'height': 1000})
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            def serve_media(route):
                name = route.request.url.split('/')[-1]
                path = (OUT if name == 'clip.png' else MEDIA) / name
                data = path.read_bytes()
                mime = {'.wav': 'audio/wav', '.mp4': 'video/mp4', '.png': 'image/png'}[path.suffix]
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
            # Overview thumbnails may be inert videos, but never live players.
            expect(dialog.locator('[data-ref] video[controls], [data-ref] audio, [data-ref] [data-native-video]')).to_have_count(0)
            assert card.locator('.reference-thumb').count() == 1
            assert dialog.locator('[data-ref] video').evaluate_all('(vs)=>vs.every(v=>v.paused&&!v.autoplay)')
            edit = card.locator('[data-edit-reference]')
            edit.click()
            editor = page.locator('.reference-editor-dialog')
            expect(editor).to_be_visible()
            assert editor.evaluate('(d)=>d.matches(":modal")')
            # Chromium can report body while focus traverses browser chrome; no background control may receive focus.
            for key in ['Tab', 'Shift+Tab']:
                focused = 0
                for _ in range(24):
                    page.keyboard.press(key)
                    state = page.evaluate('({inside:!!document.activeElement.closest(".reference-editor-dialog"),chrome:document.activeElement===document.body})')
                    assert state['inside'] or state['chrome'], state
                    focused += state['inside']
                assert focused > 0
            editor.locator('header button').focus()
            opener.evaluate('(e)=>e.focus()')
            assert page.evaluate('!!document.activeElement.closest(".reference-editor-dialog")')
            expect(editor.locator('[data-ref-instructions]')).to_be_visible()
            video = editor.locator('video[controls]')
            expect(video).to_have_count(1)
            page.wait_for_function('document.querySelector(".reference-editor-dialog video[controls]").duration > 0')
            assert video.evaluate('(v)=>v.muted')
            inputs = editor.locator('input[type="number"]')
            inputs.nth(0).fill('1')
            inputs.nth(1).fill('3')
            play = editor.locator('.reference-media-actions button').nth(0)
            expect(play).to_be_enabled()
            play.click()
            try:
                page.wait_for_function('(()=>{const v=document.querySelector(".reference-editor-dialog video[controls]");return v&&!v.paused&&v.currentTime>1.1})()', timeout=5000)
            except Exception:
                print(editor.inner_text())
                print(video.evaluate('(v)=>({time:v.currentTime,paused:v.paused,ready:v.readyState,error:v.error?.message,network:v.networkState,duration:v.duration})'))
                page.screenshot(path=str(OUT / 'failure.png'))
                raise
            page.wait_for_function('(()=>{const v=document.querySelector(".reference-editor-dialog video[controls]");return v&&v.paused&&v.currentTime>=2.95&&v.currentTime<=3.1})()')
            # Reopen from the same card; trims survive unmounting the player.
            page.keyboard.press('Escape')
            expect(editor).to_have_count(0)
            expect(dialog).to_be_visible()
            expect(edit).to_be_focused()
            edit.click()
            expect(inputs.nth(0)).to_have_value('1')
            expect(inputs.nth(1)).to_have_value('3')
            editor.evaluate('(e)=>window.__referenceEditor=e')
            # Both streams keep sound; changing lane must not remount the dialog.
            editor.locator('.reference-media select').select_option('video_audio')
            assert not editor.locator('video[controls]').evaluate('(v)=>v.muted')
            editor.locator('.reference-media select').select_option('audio')
            assert editor.evaluate('(e)=>e===window.__referenceEditor&&e.matches(":modal")')
            expect(editor.locator('video[controls]')).to_have_count(0)
            expect(editor.locator('audio')).to_have_count(1)
            expect(inputs.nth(0)).to_have_value('1')
            expect(inputs.nth(1)).to_have_value('3')
            assert card.locator('xpath=ancestor::section[1]').get_attribute('aria-label') == dialog.locator('.wb-lane').nth(2).get_attribute('aria-label')
            if locale == 'en':
                page.screenshot(path=str(OUT / f'reference-editor-{width}.png'))
            overflow = editor.evaluate('d=>[d,...d.querySelectorAll(".reference-editor-body,.reference-media")].map(e=>({class:e.className,overflow:e.scrollWidth-e.clientWidth})).filter(x=>x.overflow>2)')
            assert not overflow, overflow
            page.keyboard.press('Escape')
            expect(editor).to_have_count(0)
            expect(dialog).to_be_visible()
            expect(edit).to_be_focused()
            picker.get_by_role('button', name='voice.wav', exact=True).click()
            sound_card = dialog.locator('[data-ref="voice.wav"]')
            sound_edit = sound_card.locator('[data-edit-reference]')
            sound_edit.click()
            audio = editor.locator('audio')
            expect(audio).to_have_count(1)
            page.wait_for_function('document.querySelector(".reference-editor-dialog audio").duration > 0')
            editor.locator('input[type="number"]').nth(0).fill('2')
            editor.locator('input[type="number"]').nth(1).fill('4')
            editor.locator('.reference-media-actions button').nth(0).click()
            page.wait_for_function('()=>{const a=document.querySelector(".reference-editor-dialog audio");return a&&!a.paused&&a.currentTime>2.1}', timeout=5000)
            page.wait_for_function('()=>{const a=document.querySelector(".reference-editor-dialog audio");return a&&a.paused&&a.currentTime>=3.95&&a.currentTime<=4.1}')
            page.keyboard.press('Escape')
            expect(editor).to_have_count(0)
            expect(dialog).to_be_visible()
            expect(sound_edit).to_be_focused()
            expect(dialog.locator('[data-ref] video[controls], [data-ref] audio, [data-ref] [data-native-video]')).to_have_count(0)
            assert dialog.locator('[data-ref] video').evaluate_all('(vs)=>vs.every(v=>v.paused&&!v.autoplay)')
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
            reports.append({'locale': locale, 'width': width, 'modal': True, 'nestedModal': True, 'focusTrap': True, 'editorSurvivesLaneChange': True, 'overviewPlayers': 0, 'videoCrop': [1, 3], 'audioCrop': [2, 4]})
            context.close()
    browser.close()
    (OUT / 'results.json').write_text(json.dumps(reports, indent=2))
    print(f'PASS {len(reports)} locale/width cases; real MP4/WAV crop playback, mocked backend IPC, no inference')
