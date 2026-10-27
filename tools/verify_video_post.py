"""Video source-inspection browser acceptance; strict simulated IPC, no native probe.

Run: uv run --no-project --with playwright python tools/verify_video_post.py
Reuse the owned Vite/browser runner and collection fixture. No media or backend access.
"""
import json
from playwright.sync_api import expect
import verify_postprocessing as runner
import verify_workbench_collection as collection

IPC = r"""
const oldInvoke=window.__TAURI_INTERNALS__.invoke;
window.__videoSource={name:'clip 猫.mp4',width:1280,height:720,
 fpsNumerator:30000,fpsDenominator:1001,durationSeconds:1.001,
 pixelFormat:'yuv420p',fieldOrder:'progressive',colorTransfer:'bt709',
 audioStreams:1,subtitleStreams:0,blockers:[],timingVerified:false,processingReady:false};
window.__videoMode='success';
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(command!=='native_video_post_inspect')return oldInvoke(command,args);
 f.calls.push({command,args:clone(args??{})});
 if(Object.keys(args??{}).join(',')!=='title'||typeof args.title!=='string'||!args.title.trim())return fail('unsafe video inspect arguments');
 if(window.__videoMode==='cancel')return null;
 if(window.__videoMode==='error')throw Error('VIDEO_PROBE: fixture unavailable');
 if(window.__videoMode==='pending')return new Promise(resolve=>{window.__videoResolve=()=>resolve(clone(window.__videoSource));});
 return clone(window.__videoSource);
};
"""


def verify(browser, url, screenshots):
    original = collection.FIXTURE
    collection.FIXTURE = original + IPC
    try:
        context, page, errors = collection.open_studio(browser, url, False)
    finally:
        collection.FIXTURE = original
    checks = []
    try:
        page.locator('[data-dock-tab="post"]').click()
        panel = page.locator('[data-video-post]')
        button = page.locator('[data-video-post-inspect]')
        expect(panel).to_be_visible()
        assert page.evaluate('__collection.calls.filter(c=>c.command==="native_video_post_inspect").length') == 0
        button.click()
        expect(page.locator('[data-video-post-source]')).to_contain_text('clip 猫.mp4')
        expect(panel).to_contain_text('30000')
        expect(panel).to_contain_text('1001')
        expect(panel).to_contain_text('1280')
        expect(panel).to_contain_text('720')
        expect(page.locator('[data-video-post-blocker]')).to_have_count(0)
        checks.append('explicit chooser invocation; exact rational rate and source metadata; no mount probe')

        page.evaluate('__videoMode="cancel"')
        button.click()
        expect(button).to_be_enabled()
        expect(page.locator('[data-video-post-source]')).to_contain_text('clip 猫.mp4')
        expect(panel.get_by_role('alert')).to_have_count(0)
        checks.append('chooser cancellation preserves inspected source without error')

        page.evaluate('__videoMode="error"')
        button.click()
        expect(panel.get_by_role('alert')).to_contain_text('VIDEO_PROBE')
        expect(button).to_be_enabled()
        page.evaluate('__videoMode="pending"')
        button.click()
        expect(button).to_be_disabled()
        calls = page.evaluate('__collection.calls.filter(c=>c.command==="native_video_post_inspect").length')
        button.dispatch_event('click')
        assert page.evaluate('__collection.calls.filter(c=>c.command==="native_video_post_inspect").length') == calls
        page.evaluate('__videoResolve()')
        expect(button).to_be_enabled()
        expect(panel.get_by_role('alert')).to_have_count(0)
        checks.append('failure/retry, duplicate-click exclusion and settled busy state')

        for width in (1440, 960, 320):
            page.set_viewport_size({'width': width, 'height': 960})
            for locale in collection.LOCALES:
                collection.set_locale(page, locale, '[data-node="studio"]')
                page.locator('[data-dock-tab="post"]').click()
                page.evaluate('__videoMode="success";__videoSource.blockers=["hdr","rotation","cadenceMismatch","nonSquarePixels","pixelAspectUnknown"]')
                button.click()
                expect(page.locator('[data-video-post-blocker]')).to_have_count(5)
                expect(page.locator('[data-video-post-source]')).to_contain_text('clip 猫.mp4')
                assert 'studio.' not in panel.inner_text(), (locale, panel.inner_text())
                button.scroll_into_view_if_needed()
                button.click()
                expect(button).to_be_enabled()
                geometry = panel.evaluate('el=>({width:el.clientWidth,scroll:el.scrollWidth,document:document.documentElement.scrollWidth})')
                assert geometry['document'] <= width, (width, locale, geometry)
                assert geometry['scroll'] <= geometry['width'] + 1, (width, locale, geometry)
                page.screenshot(path=str(screenshots/f'video-source-{width}-{locale}.png'), full_page=True)
                collection.assert_clean(page, errors)
                checks.append(f'localized source/blockers and pointer/layout {width}px {locale}')
        collection.assert_clean(page, errors)
        forbidden = page.evaluate('__collection.calls.filter(c=>/run|stop|upload|submit|interrupt|cancel/.test(c.command))')
        assert not forbidden, forbidden
        result = {'status': 'PASS', 'checksPassed': len(checks), 'checks': checks,
                  'kind': 'Chromium DOM and simulated native chooser/probe; not filesystem or native-webview acceptance',
                  'screenshots': str(screenshots)}
        (screenshots/'video-source-result.json').write_text(json.dumps(result, indent=2)+'\n')
        print(json.dumps(result, indent=2), flush=True)
    finally:
        context.close()


if __name__ == '__main__':
    runner.verify = verify
    runner.main()
