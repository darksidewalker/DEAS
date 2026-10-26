"""Actual system GTK/WebKit settings render; reused IPC fixtures, no real backend/files."""
import ast
import json
from pathlib import Path
import sys
if sys.platform != 'linux':
    sys.exit('Linux-only GTK/WebKit diagnostic; use portable Chromium fixtures on Windows.')
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib

ROOT = Path(__file__).resolve().parents[1]
URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4207').rstrip('/')
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home()/'.hermes/cache/scratch/deas-settings-selectors'


def fixture(name, variable):
    tree = ast.parse((ROOT/'tools'/name).read_text(encoding='utf-8'))
    return next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == variable for t in n.targets))


CHECK = r"""JSON.stringify((()=>{
 const els=[...document.querySelectorAll('.language-setting select,.backend-panels select,.aio-auto-review select')].filter(e=>e.getClientRects().length);
 const menu=document.querySelector('.backend-panel-menu'),pane=document.querySelector('.backend-panel-content'),m=menu.getBoundingClientRect(),p=pane.getBoundingClientRect();
 const menuValid=menu.getAttribute('aria-orientation')==='vertical'&&getComputedStyle(menu).flexDirection==='column'&&(innerWidth<=480?m.bottom<=p.top:m.right<=p.left);
 const controls=els.map(e=>{
  const s=getComputedStyle(e),r=e.getBoundingClientRect(),c=document.createElement('canvas').getContext('2d');c.font=`${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
  return {id:e.id||e.closest('section').className,height:r.height,font:parseFloat(s.fontSize),appearance:s.appearance,top:s.paddingTop,bottom:s.paddingBottom,chevron:s.backgroundImage,available:r.width-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)-2,selected:c.measureText(e.selectedOptions[0]?.text||'').width,line:c.measureText('Mg').actualBoundingBoxAscent+c.measureText('Mg').actualBoundingBoxDescent};
 });
 return {controls,menuValid,viewport:[innerWidth,document.documentElement.scrollWidth],overflow:document.documentElement.scrollWidth>innerWidth,wide:[...document.querySelectorAll('body *')].filter(e=>e.getClientRects().length&&(e.getBoundingClientRect().right>innerWidth+1||e.scrollWidth>e.clientWidth+1)).map(e=>[e.tagName,e.className,e.getBoundingClientRect().width,e.scrollWidth,e.clientWidth]).slice(-20),calls:window.__CALLS__||window.__calls};
})())"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    for installed in [False, True]:
        for width in [1440, 768, 320]:
            for locale in ['en', 'de', 'fr', 'ja', 'tr', 'zh']:
                init = fixture('verify_reopen.py' if installed else 'verify_workbench.py', 'fixture')
                init += '\nlocalStorage.setItem("deas.locale.v1",'+json.dumps(locale)+');localStorage.setItem("deas.pref.backend.autostart","false");'
                manager = WebKit2.UserContentManager()
                manager.add_script(WebKit2.UserScript.new(init, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
                view = WebKit2.WebView.new_with_user_content_manager(manager)
                window = Gtk.Window(); window.set_default_size(width, 1000); window.add(view)
                failures = []; started = False

                def fail(error):
                    failures.append(str(error)); Gtk.main_quit()

                def evaluate(script, callback):
                    def done(web, result, *_):
                        try: callback(web.evaluate_javascript_finish(result).to_string())
                        except Exception as error: fail(error)
                    view.evaluate_javascript(script, -1, None, None, None, done, None)

                def report(value, panel):
                    data = json.loads(value)
                    assert data['menuValid'], (width, locale, panel, 'vertical menu layout/semantics')
                    assert not data['overflow'], (width, locale, panel, 'overflow', data['viewport'], data['wide'], data['controls'])
                    assert len(data['controls']) >= {'startup': 5, 'llm': 3, 'review': 2}[panel], (panel, data)
                    for item in data['controls']:
                        assert abs(item['height']-28.8) <= 1 and item['font'] >= 12, item
                        assert item['appearance'] == 'none' and item['top'] == item['bottom'] == '0px', item
                        assert 'svg' in item['chevron'] and item['line'] < item['height']-2, item
                        assert item['selected'] <= item['available']+1, (width, locale, panel, item)
                    assert not any(c['command'].endswith(('_write', '_start', '_submit', '_upload')) for c in data['calls']), data['calls']
                    results.append({'installed': installed, 'width': width, 'locale': locale, 'panel': panel, **data})
                    if panel == 'startup':
                        evaluate("document.querySelector('[data-backend-panel=llm]').click();'ok'", lambda _: GLib.timeout_add(200, check_llm))
                    else:
                        if width in [1440, 320] and locale == 'en':
                            view.get_snapshot(WebKit2.SnapshotRegion.FULL_DOCUMENT, WebKit2.SnapshotOptions.NONE, None, snapshot, None)
                        else: Gtk.main_quit()

                def snapshot(web, result, *_):
                    try: web.get_snapshot_finish(result).write_to_png(str(OUT/f'{installed}-{width}.png'))
                    except Exception as error: fail(error)
                    Gtk.main_quit()

                def check_llm():
                    evaluate(CHECK, lambda value: report(value, 'llm')); return False

                def check():
                    evaluate("document.querySelectorAll('.startup-advanced,.aio-advanced').forEach(e=>e.open=true);'ok'", lambda _: evaluate(CHECK, lambda value: report(value, 'startup' if installed else 'review')))
                    return False

                def navigate():
                    evaluate("document.querySelector('[data-node=settings]').click();'ok'", lambda _: GLib.timeout_add(300, startup))
                    return False

                def startup():
                    if installed: evaluate("document.querySelector('[data-backend-panel=startup]').click();'ok'", lambda _: GLib.timeout_add(300, check))
                    else: check()
                    return False

                def loaded(web, event):
                    nonlocal started
                    if event == WebKit2.LoadEvent.FINISHED and not started:
                        started = True; GLib.timeout_add(1000, navigate)

                view.connect('load-changed', loaded)
                timeout = GLib.timeout_add_seconds(20, lambda: fail('timeout'))
                window.show_all(); view.load_uri(URL); Gtk.main()
                GLib.source_remove(timeout); window.destroy()
                assert not failures, (installed, width, locale, failures)
    (OUT/'results.json').write_text(json.dumps(results, indent=2)+'\n', encoding='utf-8')
    print(f'PASS: {len(results)} settings panel renders in actual GTK/WebKit; six locales, three widths, no writes/start/submit/upload. {OUT}')


if __name__ == '__main__':
    main()
