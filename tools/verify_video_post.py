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
window.__draftMode='success';
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(command==='native_download_catalog'){
  f.calls.push({command,args:clone(args??{})});
  if(Object.keys(args??{}).length)return fail('catalog must have empty args');
  return {version:1,providers:[],entries:[]};
 }
 if(command==='native_video_post_draft'){
  f.calls.push({command,args:clone(args??{})});
  if(Object.keys(args??{}).sort().join(',')!=='settings,source')return fail('unsafe draft argument keys');
  const s=args.source,o=args.settings;
  if(Object.keys(s??{}).sort().join(',')!=='audioStreams,blockers,fpsDenominator,fpsNumerator,height,name,subtitleStreams,width'||Object.keys(o??{}).sort().join(',')!=='profile,scale')return fail('unsafe draft fields');
  if(![1,2,4].includes(o.scale)||!['mp4-h264','mkv-h264','webm-vp9'].includes(o.profile))return fail('invalid draft selection');
  if(window.__draftMode==='error')throw Error('VIDEO_DRAFT: fixture unavailable');
  const webm=o.profile==='webm-vp9',container=webm?'webm':o.profile==='mkv-h264'?'mkv':'mp4';
  const width=s.width*o.scale,height=s.height*o.scale;
  const blockers=[...s.blockers];
  if(width>8192||height>8192||width%2||height%2||width*height>33177600)blockers.push('outputDimensions');
  if(s.subtitleStreams)blockers.push('subtitlesUnsupported');
  const result={kind:'deas-video-post-draft',version:1,source:clone(s),settings:clone(o),
   output:{filename:'processed.'+container,width,height,fpsNumerator:s.fpsNumerator,fpsDenominator:s.fpsDenominator,container,videoEncoder:webm?'libvpx-vp9':'libx264',pixelFormat:'yuv420p',
    ...(s.audioStreams?{audioEncoder:webm?'libopus':'aac',audioBitrate:192000}:{})},
   blockers,processingReady:false,timingVerified:false,encoderVerified:false};
  if(window.__draftMode==='pending')return new Promise(resolve=>{window.__draftResolve=()=>resolve(result);});
  return result;
 }
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
        page.locator('[data-studio-tab="tve"]').click()
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

        workspace = page.locator('[data-tve]')
        scale = page.locator('[data-tve-scale]')
        profile = page.locator('[data-tve-profile]')
        check = page.locator('[data-tve-check]')
        draft = page.locator('[data-tve-draft]')
        assert page.evaluate('__collection.calls.filter(c=>c.command==="native_video_post_draft").length') == 0
        check.click()
        expect(draft).to_contain_text('2560')
        expect(draft).to_contain_text('1440')
        expect(draft).to_contain_text('libx264')
        expect(draft).to_contain_text('30000/1001')
        profile.select_option('webm-vp9')
        expect(draft).to_have_count(0)
        scale.select_option('4')
        check.click()
        expect(draft).to_contain_text('5120')
        expect(draft).to_contain_text('libvpx-vp9')
        expect(draft).to_contain_text('libopus')
        checks.append('explicit native output draft, profile mapping, exact geometry/cadence and edit invalidation')

        before = page.evaluate('__collection.calls.filter(c=>["native_video_post_draft","native_video_post_inspect"].includes(c.command)).length')
        page.locator('[data-node="optional-downloads"]').click()
        page.locator('[data-studio-tab="tve"]').click()
        expect(scale).to_have_value('4')
        expect(profile).to_have_value('webm-vp9')
        expect(draft).to_contain_text('5120')
        expect(page.locator('[data-video-post-source]')).to_contain_text('clip 猫.mp4')
        assert page.evaluate('__collection.calls.filter(c=>["native_video_post_draft","native_video_post_inspect"].includes(c.command)).length') == before
        expect(workspace.get_by_role('button', name='Run', exact=True)).to_have_count(0)
        checks.append('TVE source/draft survives Library navigation without probing or execution')

        page.evaluate('__draftMode="error"')
        check.click()
        expect(workspace.get_by_role('alert')).to_contain_text('VIDEO_DRAFT')
        page.evaluate('__draftMode="success"')
        check.click()
        expect(draft).to_contain_text('5120')
        checks.append('draft failure and explicit retry remain truthful')

        for width in (1440, 960, 320):
            page.set_viewport_size({'width': width, 'height': 960})
            for locale in collection.LOCALES:
                collection.set_locale(page, locale, '[data-node="studio"]')
                page.locator('[data-studio-tab="tve"]').click()
                page.evaluate('__videoMode="success";__videoSource.blockers=["hdr","rotation","cadenceMismatch","nonSquarePixels","pixelAspectUnknown"];__videoSource.subtitleStreams=1')
                button.click()
                expect(page.locator('[data-video-post-blocker]')).to_have_count(5)
                expect(page.locator('[data-video-post-source]')).to_contain_text('clip 猫.mp4')
                check.click()
                expect(page.locator('[data-tve-blocker]')).to_have_count(1)
                assert 'studio.' not in workspace.inner_text(), (locale, panel.inner_text())
                button.scroll_into_view_if_needed()
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
                  'kind': 'Chromium DOM and strict simulated native chooser/draft; not native Rust, filesystem, encoder or GPU acceptance',
                  'screenshots': str(screenshots)}
        (screenshots/'video-source-result.json').write_text(json.dumps(result, indent=2)+'\n')
        print(json.dumps(result, indent=2), flush=True)
    finally:
        context.close()


if __name__ == '__main__':
    runner.verify = verify
    runner.main()
