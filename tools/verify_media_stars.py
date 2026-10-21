"""Chromium star/relocation/editor fixture; actual filesystem moves are native-test evidence."""
import json
from pathlib import Path
import struct
import sys
import zlib
from playwright.sync_api import sync_playwright, expect
from verify_projects import INIT

URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4197').rstrip('/')
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home()/'.hermes/cache/scratch/deas-media-stars'
EXTRA = r"""
const originalInvoke=window.__TAURI_INTERNALS__.invoke;
window.__STARRED__=false;
window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
 const root='/env/ComfyUI/output',path=root+(window.__STARRED__?'/starred':'')+'/fixture.png';
 const record=value=>{window.__calls.push({command,args});return value;};
 if(command==='native_media_list')return record({path:args.path,parent:'/env/ComfyUI',entries:[{name:'fixture.png',path,kind:'file',media:'image',symlink:false,size:100,modified:1}],truncated:false});
 if(command==='native_media_thumbnail')return record(args.path);
 if(command==='native_media_metadata')return record([]);
 if(command==='native_media_star_status')return record({starred:args.path.includes('/starred/'),unavailable:null});
 if(command==='native_media_star'){window.__STARRED__=true;return record({oldPath:args.path,path:root+'/starred/fixture.png'});}
 return originalInvoke(command,args);
};
"""


def png():
    def chunk(kind, data):
        return struct.pack('>I', len(data))+kind+data+struct.pack('>I', zlib.crc32(kind+data))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0))+chunk(b'IDAT', zlib.compress((b'\0'+b'\x58\x88\xa0'*64)*64))+chunk(b'IEND', b'')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(INIT.replace('LOCALE', json.dumps('en'))+EXTRA)
        page.route('**/env/ComfyUI/output/**/*.png', lambda route: route.fulfill(content_type='image/png', body=png()))
        page.goto(URL+'/tools/inpaint-fixture.html', wait_until='networkidle')
        page.locator('.media-list [data-kind="file"]').click()
        preview = page.locator('[data-browsed-preview]')
        expect(preview.get_by_role('button', name='Star fixture.png', exact=True)).to_be_enabled()
        image = preview.locator('img')
        expect(image).to_be_visible()
        page.wait_for_function('()=>document.querySelector("[data-browsed-preview] img").naturalWidth>0')
        box = image.bounding_box()
        assert abs(box['width']-box['height'])>4, box
        image.click(position={'x':1 if box['width']>box['height'] else box['width']/2,'y':box['height']/2 if box['width']>box['height'] else 1})
        expect(page.locator('.wb-viewer')).to_have_count(0)
        image.click()
        expect(page.get_by_role('dialog',name='fixture.png',exact=True)).to_be_visible()
        page.keyboard.press('Escape')
        preview.locator('[data-use-input]').click()
        editor = page.locator('[data-editor-viewport]')
        expect(editor).to_be_visible()
        page.get_by_role('button', name='Select', exact=True).click()
        base = page.locator('[data-layer="base"]')
        base.focus()
        base.press('ArrowLeft')
        assert base.evaluate('e=>e.style.left') == '-8px'
        page.evaluate('window.__EDITOR__=document.querySelector("[data-editor-viewport]")')
        toolbar = page.get_by_role('toolbar', name='Edit image')
        toolbar.get_by_role('button', name='Star fixture.png', exact=True).click()
        page.wait_for_function('()=>document.querySelector("[data-layer=base] img").src.includes("/starred/fixture.png")')
        assert page.evaluate('window.__EDITOR__===document.querySelector("[data-editor-viewport]")')
        expect(editor).to_be_visible()
        expect(page.locator('[data-browsed-preview]')).to_have_count(0)
        assert base.evaluate('e=>e.style.left') == '-8px'
        expect(toolbar.get_by_role('button', name='Starred fixture.png', exact=True)).to_be_disabled()
        toolbar.locator('[data-view-full]').click()
        viewer = page.get_by_role('dialog', name='fixture.png', exact=True)
        expect(viewer.get_by_role('button', name='Starred fixture.png', exact=True)).to_be_disabled()
        assert viewer.locator('img').get_attribute('src').endswith('/starred/fixture.png')
        page.screenshot(path=str(OUT/'starred-editor-viewer.png'))
        page.keyboard.press('Escape')
        assert not page.evaluate('window.__calls.some(c=>/native_job_prepare|native_job_submit|native_input_upload|native_mask_upload/.test(c.command))')
        assert not page.evaluate('window.__unexpected'), page.evaluate('window.__unexpected')
        assert not errors, errors
        (OUT/'results.json').write_text(json.dumps({'editorPreserved': True, 'geometryPreserved': True, 'viewerPathUpdated': True, 'fixtureOnly': True}, indent=2)+'\n')
        browser.close()
    print('PASS: real Chromium preview/editor/viewer star actions, relocated source, retained editor geometry and no execution/upload (IPC fixture).')


if __name__ == '__main__':
    main()
