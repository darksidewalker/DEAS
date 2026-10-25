"""System GTK/WebKit star/unstar UI roundtrip; IPC fixtures, not native file moves."""
import ast
import base64
import json
from pathlib import Path
import struct
import sys
import zlib
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib

ROOT = Path(__file__).resolve().parents[1]
URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4207').rstrip('/')
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home()/'.hermes/cache/scratch/deas-webkit-stars'


def constant(filename, name):
    module = ast.parse((ROOT/'tools'/filename).read_text())
    return next(ast.literal_eval(n.value) for n in module.body if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == name for t in n.targets))


def png():
    def chunk(kind, data):
        return struct.pack('>I', len(data))+kind+data+struct.pack('>I', zlib.crc32(kind+data))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0))+chunk(b'IDAT', zlib.compress((b'\0'+b'\x58\x88\xa0'*64)*64))+chunk(b'IEND', b'')


TEST = r"""window.__STAR_RESULT=null;(async()=>{
 const wait=async(f)=>{for(let i=0;i<200;i++){const v=f();if(v)return v;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+f);};
 const check=(ok,message)=>{if(!ok)throw Error(message);};
 (await wait(()=>document.querySelector('.media-list [data-kind=file]'))).click();
 (await wait(()=>document.querySelector('[data-browsed-preview] [data-use-input]'))).click();
 const editor=await wait(()=>document.querySelector('[data-editor-viewport]'));
 await wait(()=>document.querySelector('[data-layer=base] img')?.naturalWidth);
 document.querySelector('.sie-tools .sie-seg button').click();
 const base=document.querySelector('[data-layer=base]');base.focus();base.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
 await wait(()=>base.style.left==='-8px');
 const button=()=>[...document.querySelectorAll('[role=toolbar]')].find(e=>e.getAttribute('aria-label')==='Edit image')?.querySelector('.media-star');
 (await wait(()=>{const b=button();return b&&!b.disabled&&b;})).click();
 await wait(()=>document.querySelector('[data-layer=base] img')?.src.endsWith('/starred/image/2026-10-19/fixture.png'));
 check(document.querySelector('[data-editor-viewport]')===editor&&base.style.left==='-8px','Star discarded editor/geometry');
 await wait(()=>button()?.getAttribute('aria-pressed')==='true'&&!button().disabled);
 check(button().getAttribute('aria-label')==='Unstar fixture.png','Missing Unstar action');button().click();
 await wait(()=>document.querySelector('[data-layer=base] img')?.src.endsWith('/output/raw/image/2026-10-19/fixture.png'));
 await wait(()=>button()?.getAttribute('aria-pressed')==='false'&&!button().disabled);
 check(document.querySelector('[data-editor-viewport]')===editor&&base.style.left==='-8px','Unstar discarded editor/geometry');
 const moves=window.__calls.filter(c=>c.command==='native_media_star'||c.command==='native_media_unstar');
 check(moves.length===2&&moves[1].args.path==='/env/ComfyUI/output/starred/image/2026-10-19/fixture.png','Unexpected move calls');
 check(!window.__calls.some(c=>/native_job_prepare|native_job_submit|native_workbench_run|native_input_upload|native_mask_upload/.test(c.command)),'Unexpected computation/upload');
 const roots=document.querySelector('.media-roots');
 check(roots?.nextElementSibling.classList.contains('media-depth'),'Root buttons not before Depth');
 check([...roots.querySelectorAll('[data-media-root]')].map(e=>e.dataset.mediaRoot).join(',')==='output,starred,input','Wrong root button order');
 check(!document.querySelector('.media-starred-switch, .media-header [role=switch]'),'Obsolete light switch');
 const tree=document.querySelector('.media-folders');
 check(!tree.textContent.includes('/env')&&!tree.textContent.includes('ComfyUI'),'Filesystem ancestor trail remains');
 check(tree.querySelector('.media-folder-name').textContent==='root','Output is not the tree root');
 document.querySelector('[data-media-root=input]').click();
 await wait(()=>document.querySelector('.media-folder-name[aria-current=location]')?.title==='/env/ComfyUI/input');
 check(!document.querySelector('.media-list .media-star'),'Input tiles still draw stars');
 const listCalls=()=>window.__calls.filter(c=>c.command==='native_media_list');
 const starred=document.querySelector('[data-media-root=starred]');
 const output=document.querySelector('[data-media-root=output]');
 starred.click();
 await wait(()=>starred.getAttribute('aria-pressed')==='true');
 check(output.getAttribute('aria-pressed')==='false','Output remains selected in Starred');
 check(listCalls().some(c=>c.args.path==='/env/ComfyUI/output/starred'),'Starred did not open starred');
 output.click();
 await wait(()=>output.getAttribute('aria-pressed')==='true');
 check(starred.getAttribute('aria-pressed')==='false','Starred remains selected in Output');
 check(listCalls().some(c=>c.args.path==='/env/ComfyUI/output/raw'),'Output did not return to raw');
 check(window.__calls.filter(c=>c.command==='native_media_star'||c.command==='native_media_unstar').length===2,'Navigation moved files');
 check(document.querySelector('[data-editor-viewport]')===editor&&base.style.left==='-8px','Navigation discarded editor');
 check(!window.__unexpected.length,'Unexpected IPC: '+window.__unexpected);
 window.__STAR_RESULT={passed:true,editorPreserved:true,geometryPreserved:true,unstarPreservesNamedRawPath:true,inputStarsHidden:true,rootNavigation:true,relativeTree:true};
})().catch(e=>window.__STAR_RESULT={error:String(e)});'started'"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    script = constant('verify_projects.py', 'INIT').replace('LOCALE', json.dumps('en'))+constant('verify_media_stars.py', 'EXTRA')
    script += '\nwindow.__TAURI_INTERNALS__.convertFileSrc=path=>'+json.dumps('data:image/png;base64,'+base64.b64encode(png()).decode())+"+'#'+path;"
    manager = WebKit2.UserContentManager()
    manager.add_script(WebKit2.UserScript.new(script, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
    view = WebKit2.WebView.new_with_user_content_manager(manager)
    window = Gtk.Window(); window.set_default_size(1440, 1000); window.add(view)
    failures = []; started = False

    def fail(error):
        failures.append(str(error)); Gtk.main_quit()

    def snapshot(web, result, *_):
        try: web.get_snapshot_finish(result).write_to_png(str(OUT/'unstarred-editor.png'))
        except Exception as error: fail(error)
        Gtk.main_quit()

    def checked(web, result, *_):
        try:
            report = json.loads(web.evaluate_javascript_finish(result).to_string())
            if report is None: GLib.timeout_add(100, poll); return
            assert report.get('passed'), report
            (OUT/'results.json').write_text(json.dumps(report, indent=2)+'\n')
            web.get_snapshot(WebKit2.SnapshotRegion.FULL_DOCUMENT, WebKit2.SnapshotOptions.NONE, None, snapshot, None)
        except Exception as error: fail(error)

    def poll():
        view.evaluate_javascript('JSON.stringify(window.__STAR_RESULT)', -1, None, None, None, checked, None)
        return False

    def loaded(web, event):
        nonlocal started
        if event == WebKit2.LoadEvent.FINISHED and not started:
            started = True
            view.evaluate_javascript(TEST, -1, None, None, None, None, None)
            GLib.timeout_add(100, poll)

    view.connect('load-changed', loaded)
    timeout = GLib.timeout_add_seconds(40, lambda: fail('WebKit star test timeout'))
    window.show_all(); view.load_uri(URL+'/tools/inpaint-fixture.html'); Gtk.main()
    GLib.source_remove(timeout); window.destroy()
    assert not failures, failures
    print(f'PASS: actual GTK/WebKit star/unstar roundtrip, retained editor/geometry, no generation/upload (IPC fixture). {OUT}')


if __name__ == '__main__':
    main()
