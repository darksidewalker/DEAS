"""Real GTK/WebKit rendering of the in-app spellcheck overlay with mocked IPC; no dictionary download.
Run: GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 /usr/bin/python tools/verify_spellcheck.py URL [OUTPUT_DIRECTORY]
Use an isolated Vite --host 127.0.0.1 --port PORT --strictPort server.

Checks, per locale and width: the Studio prompt textarea carries spellcheck=false (the browser's checker is off),
`native_spellcheck_check` is asked only for letter words, the misspelled one is marked in the mirror, the mirror
copies the textarea's font/padding/size exactly, the mark sits inside the textarea box, Ctrl+. opens the suggestion
list and Enter replaces only that word. The same assertions run for the Prompt Forge brief.
"""
import ast
import json
from pathlib import Path
import sys
if sys.platform != 'linux':
    sys.exit('Linux-only GTK/WebKit diagnostic; the engine itself is covered by Rust tests on every platform.')
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib

ROOT = Path(__file__).resolve().parents[1]
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:1420'
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home()/'.hermes/cache/scratch/deas-spellcheck'


def fixture():
    tree = ast.parse((ROOT/'tools/verify_workbench.py').read_text(encoding='utf-8'))
    base = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == 'fixture' for t in n.targets))
    base = base.replace("id:'fixture-install-plan',request:args.request", "id:'fixture-install-plan',reopenId:'fixture-install-plan',request:args.request")
    extra = r"""
if(command==='native_update_check')return {app:null,comfy:false,nodepack:false};
if(command==='native_models_scan')return [];
if(command==='native_files_present')return [true];
if(command==='native_install_open')return {state:'succeeded',stepId:null,logs:[],error:null};
if(command==='native_settings_read')return {};
if(command==='native_startup_read')return {startup:{preset:'off',flags:[],fast:[]},packages:[],presets:{off:{flags:[],fast:[]}}};
if(command==='native_llm_read')return {provider:'local',baseUrl:'http://127.0.0.1:11434'};
if(command==='native_llm_models')return {models:[{id:'fixture:model',label:'fixture model'}],warnings:[]};
if(command==='native_forge_targets')return {source:{},creativity:[],targets:['illustrious'],layout:{},aspects:[]};
if(command==='native_job_current')return null;
if(command==='native_backend_status')return {state:'stopped',endpoint:null,logs:[],error:null,generationReady:false};
if(command==='native_spellcheck_status')return {available:true,installed:true,license:'fixture',bytes:1};
if(command==='native_spellcheck_check'){window.__checked.push(args.words);return args.words.filter(w=>w.startsWith('wunderschoen'));}
if(command==='native_spellcheck_suggest'){window.__suggested.push(args.word);return ['wunderschön','wunderschon'];}
window.__unexpected.push(command);return null;
"""
    return base.replace("throw Error('Unexpected command '+command);", extra+"throw Error('Unexpected command '+command);")


TEST = r"""window.__RESULT=null;(async()=>{
const wait=async(f)=>{for(let i=0;i<200;i++){const v=f();if(v)return v;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+f);};
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
const tick=(ms=80)=>new Promise(r=>setTimeout(r,ms));
const click=async(s)=>{(await wait(()=>document.querySelector(s))).click();await tick();};
const type=async(el,value,caret)=>{el.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.setSelectionRange(caret,caret);el.dispatchEvent(new Event('select',{bubbles:true}));await tick(450);};
const inside=(a,b)=>a.left>=b.left-1&&a.right<=b.right+1&&a.top>=b.top-1&&a.bottom<=b.bottom+1;
const report={};
const exercise=async(name,el,bad,text,fixed)=>{
 check(el,'missing field '+name);
 check(el.getAttribute('spellcheck')==='false','browser checker still on for '+name);
 const before=window.__checked.length;
 await type(el,text,10);
 const asked=window.__checked.slice(before).flat();
 check(asked.includes(bad)&&!asked.some(w=>/\d|_/.test(w)),name+' asked wrong words: '+JSON.stringify(asked));
 const host=el.closest('.prompt-textarea');
 const mirror=await wait(()=>host.querySelector('.prompt-mirror'));
 const marks=[...mirror.querySelectorAll('mark')];
 check(marks.length===1&&marks[0].textContent===bad,name+' marks: '+marks.map(m=>m.textContent));
 const ts=getComputedStyle(el),ms=getComputedStyle(mirror);
 for(const k of ['fontFamily','fontSize','lineHeight','paddingLeft','paddingTop','letterSpacing'])check(ts[k]===ms[k],name+' mirror '+k+' '+ts[k]+' != '+ms[k]);
 const tr=el.getBoundingClientRect(),mr=mirror.getBoundingClientRect(),kr=marks[0].getBoundingClientRect();
 check(Math.abs(tr.width-mr.width)<1&&Math.abs(tr.height-mr.height)<1&&Math.abs(tr.left-mr.left)<1&&Math.abs(tr.top-mr.top)<1,name+' mirror box differs');
 check(inside(kr,tr)&&kr.width>20,name+' mark outside the textarea '+JSON.stringify({mark:kr,textarea:tr,mirror:mr,scroll:el.scrollTop,rows:el.rows,h:ts.height,mh:ms.height}));
 // the mark starts after "ein " at the same x the textarea draws it: compare with a canvas measurement of the prefix
 const canvas=document.createElement('canvas').getContext('2d');canvas.font=ts.font;
 const expectedX=tr.left+parseFloat(ts.paddingLeft)+parseFloat(ts.borderLeftWidth)+canvas.measureText('ein ').width;
 check(Math.abs(kr.left-expectedX)<2,name+' mark x '+kr.left+' expected '+expectedX);
 el.dispatchEvent(new KeyboardEvent('keydown',{key:'.',ctrlKey:true,bubbles:true}));await tick(200);
 const options=[...host.querySelectorAll('.prompt-fixes [role=option]')];
 check(options.map(o=>o.textContent).join()==='wunderschön,wunderschon',name+' suggestions: '+options.map(o=>o.textContent));
 el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick(450);
 check(el.value===fixed,name+' replaced: '+el.value);
 check(!host.querySelector('.prompt-fixes'),name+' suggestion list stayed open');
 check(!host.querySelector('.prompt-mirror'),name+' mark stayed after the fix');
 report[name]={asked,markX:kr.left,expectedX,font:ts.font};
};
await click('[data-node=studio]');await click('[data-studio-tab=generate]');
await exercise('studio-positive',await wait(()=>document.querySelector('#run-positive')),'wunderschoen','ein wunderschoen Haus, 1girl, long_hair','ein wunderschön Haus, 1girl, long_hair');
await click('[data-studio-tab=forge]');
const visible=s=>[...document.querySelectorAll(s)].find(e=>e.getBoundingClientRect().height>0);
await exercise('forge-brief',await wait(()=>visible('[data-forge-brief]')).catch(()=>{const b=document.querySelector('[data-forge-brief]');const chain=[];for(let e=b;e&&chain.length<20;e=e.parentElement){const r=e.getBoundingClientRect(),c=getComputedStyle(e);chain.push([e.tagName+'.'+e.className,Math.round(r.width),Math.round(r.height),c.display,e.hidden,e.getAttribute('aria-hidden')]);}throw Error('no visible Forge brief; chain: '+JSON.stringify(chain));}),'wunderschoene','die wunderschoene Stadt, 2girls, short_hair','die wunderschön Stadt, 2girls, short_hair');
const unexpected=window.__unexpected.filter(c=>/spellcheck|download|job_|backend_start|install_start/.test(c));
check(!unexpected.length,'Unexpected IPC: '+unexpected);
check(!window.__calls.some(c=>c.command==='native_spellcheck_install'),'Fixture downloaded a dictionary');
check(!window.__errors.length,'Browser errors: '+window.__errors);
window.__RESULT={passed:true,viewport:innerWidth,...report};
})().catch(e=>window.__RESULT={error:String(e),stack:e.stack,calls:window.__calls,text:document.body.innerText.slice(-6000)});'started'"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    for width, locale in [(1440, 'de'), (1440, 'en'), (900, 'de'), (1440, 'tr')]:
        manager = WebKit2.UserContentManager()
        init = fixture()+r"""
localStorage.clear();window.__unexpected=[];window.__errors=[];window.__checked=[];window.__suggested=[];
window.addEventListener('error',e=>window.__errors.push(e.message));
window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
localStorage.setItem('deas.pref.install.root',JSON.stringify('/fixture/env'));
localStorage.setItem('deas.pref.backend.autostart','false');
localStorage.setItem('deas.pref.prompt.tools',JSON.stringify({spellcheck:true,autocomplete:false,language:'de'}));
"""+'\nlocalStorage.setItem("deas.locale.v1",'+json.dumps(locale)+');'
        manager.add_script(WebKit2.UserScript.new(init, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
        view = WebKit2.WebView.new_with_user_content_manager(manager)
        window = Gtk.Window(); window.set_default_size(width, 1100); window.add(view)
        failures = []; started = False

        def fail(error):
            failures.append(str(error)); Gtk.main_quit()

        def snapshot(web, result, *_):
            try: web.get_snapshot_finish(result).write_to_png(str(OUT/f'spellcheck-{locale}-{width}.png'))
            except Exception as error: fail(error)
            Gtk.main_quit()

        def checked(web, result, *_):
            try:
                report = json.loads(web.evaluate_javascript_finish(result).to_string())
                if report is None:
                    GLib.timeout_add(100, poll); return
                assert report.get('passed'), report
                results.append({'locale': locale, 'width': width, **report})
                web.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, snapshot, None)
            except Exception as error: fail(error)

        def poll():
            view.evaluate_javascript('JSON.stringify(window.__RESULT)', -1, None, None, None, checked, None)
            return False

        def loaded(web, event):
            nonlocal started
            if event == WebKit2.LoadEvent.FINISHED and not started:
                started = True
                view.evaluate_javascript(TEST, -1, None, None, None, None, None)
                GLib.timeout_add(100, poll)

        view.connect('load-changed', loaded)
        timeout = GLib.timeout_add_seconds(40, lambda: fail('Spellcheck fixture timeout'))
        window.show_all(); view.load_uri(URL); Gtk.main()
        GLib.source_remove(timeout); window.destroy()
        (OUT/'results.json').write_text(json.dumps(results, indent=2)+'\n', encoding='utf-8')
        assert not failures, (width, locale, failures)
        print(f'PASS GTK/WebKit spellcheck {width} {locale}', flush=True)


if __name__ == '__main__':
    main()
