"""Render the production NativeVideo controls with mocked IPC; no media/backend access.
Run against an owned Vite: uv run --no-project --with playwright python tools/verify_video_controls.py URL OUT
"""
import json
import sys
import re
from urllib.request import urlopen
from pathlib import Path
from playwright.sync_api import sync_playwright

HTML = '''<html><head><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;
window.__vite_plugin_react_preamble_installed__=true;
</script></head><body><div id="root"></div><script type="module">
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {NativeVideo} from '/src/features/studio/NativeVideo.tsx';
import {I18nProvider} from '/src/i18n/I18nProvider';
import '/src/styles.css';import '/src/themes.css';
window.state={position:65,duration:125,width:640,height:360,paused:true,muted:false,volume:25};
window.calls=[];
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
window.calls.push({command,...args});
if(args?.action?.kind==='status')return {...window.state};
if(args?.action?.kind==='seek')window.state.position=args.action.seconds;
if(args?.action?.kind==='volume')window.state.volume=args.action.volume;
if(args?.action?.kind==='mute')window.state.muted=args.action.muted;
if(args?.action?.kind==='pause')window.state.paused=args.action.paused;
}};
localStorage.setItem('deas.locale.v1','en');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,null,React.createElement(NativeVideo,{source:{path:'/fixture.mp4'},label:'Controls fixture'})));
</script></body></html>'''


def main():
    url, out = sys.argv[1:]
    # Reuse Vite's canonical module URLs, including its current HMR/cache query.
    with urlopen(url.rstrip('/')+'/src/features/studio/NativeVideo.tsx') as response:
        module = response.read().decode()
    match = re.search(r'from "([^"]*I18nProvider[^"]*)"', module)
    assert match, 'Vite did not expose the production I18nProvider import'
    provider = match.group(1)
    html = HTML.replace('/src/i18n/I18nProvider', provider)
    output = Path(out)
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('**/__video_controls', lambda route: route.fulfill(body=html, content_type='text/html'))
        page.goto(url.rstrip('/')+'/__video_controls')
        page.get_by_text('1:05 / 2:05', exact=True).wait_for()
        results = []
        for width in (900, 320):
            page.set_viewport_size({'width': width, 'height': 700})
            for percent in (0, 25, 50, 100):
                page.evaluate('(p)=>{state.position=state.duration*p/100;state.volume=p;window.dispatchEvent(new Event("resize"));}', percent)
                page.wait_for_function('(p)=>document.querySelector(".native-video-volume").style.getPropertyValue("--progress")===p+"%"', arg=percent)
                sliders = page.locator('.native-video-controls input')
                for slider in sliders.all():
                    box = slider.bounding_box()
                    assert slider.evaluate('e=>getComputedStyle(e).padding') == '0px'
                    assert slider.evaluate('e=>getComputedStyle(e).borderWidth') == '0px'
                    assert slider.evaluate('e=>e.style.getPropertyValue("--progress")') == f'{percent}%'
                    # The visible track and thumb center share the same 6px endpoint inset.
                    page.mouse.click(box['x']+6+(box['width']-12)*percent/100, box['y']+box['height']/2)
                    value = slider.evaluate('e=>Number(e.value)/Number(e.max)*100')
                    assert abs(value-percent) < 2, (width, percent, value)
                boxes = page.locator('.native-video-controls > *').evaluate_all('es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}})')
                assert all(b['x'] >= 0 and b['right'] <= width for b in boxes), boxes
                for i, a in enumerate(boxes):
                    for b in boxes[i+1:]:
                        assert min(a['right'],b['right']) <= max(a['x'],b['x'])+1 or min(a['bottom'],b['bottom']) <= max(a['y'],b['y'])+1, boxes
                results.append({'width': width, 'percent': percent})
            page.screenshot(path=str(output/f'controls-{width}.png'))
        volume = page.get_by_role('slider', name='Video volume')
        volume.focus()
        page.keyboard.press('Home')
        page.wait_for_function('document.querySelector(".native-video-volume").value === "0"')
        page.keyboard.press('End')
        page.wait_for_function('document.querySelector(".native-video-volume").value === "100"')
        page.get_by_role('button', name='Play', exact=True).click()
        page.get_by_role('button', name='Pause', exact=True).wait_for()
        page.get_by_role('button', name='Mute', exact=True).click()
        page.get_by_role('button', name='Unmute', exact=True).wait_for()
        assert not errors, errors
        print(json.dumps({'checks': results, 'keyboard_and_transport': 'passed', 'page_errors': errors}))
        browser.close()


if __name__ == '__main__':
    main()
