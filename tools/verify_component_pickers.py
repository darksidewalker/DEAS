"""Real GTK/WebKit companion-picker rendering with mocked IPC; no inference/files/backend.
Run: GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 /usr/bin/python tools/verify_component_pickers.py URL [OUTPUT_DIRECTORY]
Use an isolated Vite --host 127.0.0.1 --port PORT --strictPort server.
"""
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
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:1420'
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home()/'.hermes/cache/scratch/deas-component-pickers'


def fixture():
    tree = ast.parse((ROOT/'tools/verify_workbench.py').read_text(encoding='utf-8'))
    base = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == 'fixture' for t in n.targets))
    base = base.replace("id:'fixture-install-plan',request:args.request", "id:'fixture-install-plan',reopenId:'fixture-install-plan',request:args.request")
    base = base.replace("samplers:['euler','dpmpp_2m']", "samplers:['euler','dpmpp_2m','er_sde']").replace("schedulers:['normal','karras']", "schedulers:['normal','karras','simple']")
    base = base.replace("if(command==='native_media_list')", "if(command==='native_media_list')return {path:'/fixture/out',parent:null,entries:[],truncated:false};if(false)")
    extra = r"""
if(command==='native_update_check')return {app:null,comfy:false,nodepack:false};
if(command==='native_models_scan')return window.__models;
if(command==='native_files_present')return [true];
if(command==='native_install_open')return {state:'succeeded',stepId:null,logs:[],error:null};
if(command==='native_settings_read')return {};
if(command==='native_startup_read')return {startup:{preset:'off',flags:[],fast:[]},packages:[],presets:{off:{flags:[],fast:[]}}};
if(command==='native_llm_read')return {provider:'local',baseUrl:'http://127.0.0.1:11434'};
if(command==='native_llm_models')return {models:[],warnings:[]};
if(command==='native_job_current')return null;
if(command==='native_backend_status')return {state:'stopped',endpoint:null,logs:[],error:null,generationReady:false};
window.__unexpected.push(command);
"""
    return base.replace("throw Error('Unexpected command '+command);", extra+"throw Error('Unexpected command '+command);")


MODELS: list[dict] = [
    {'category': 'diffusion_models', 'name': 'anima/anima-preview.safetensors', 'family': 'anima'},
    {'category': 'diffusion_models', 'name': 'anima/second.safetensors', 'family': 'anima'},
    {'category': 'diffusion_models', 'name': 'unknown.safetensors'},
    {'category': 'text_encoders', 'name': 'renamed-encoder.safetensors', 'component': 'qwen3-0.6b'},
    {'category': 'text_encoders', 'name': 'qwen_3_600m.safetensors'},
    {'category': 'text_encoders', 'name': 'custom-encoder.safetensors'},
    {'category': 'vae', 'name': 'wan_2.1_vae.safetensors'},
    {'category': 'vae', 'name': 'custom-vae.safetensors'},
    {'category': 'loras', 'name': 'not-a-companion.safetensors'},
]
for model in MODELS:
    model.update(path='/fixture/models/'+model['name'], size=1, info=None)

TEST = r"""window.__RESULT=null;(async()=>{
const wait=async(f)=>{for(let i=0;i<200;i++){const v=f();if(v)return v;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+f);};
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
const tick=()=>new Promise(r=>setTimeout(r,80));
const click=async(s)=>{(await wait(()=>document.querySelector(s))).click();await tick();};
await click('[data-node=studio]');await click('[data-studio-tab=generate]');
await wait(()=>document.querySelectorAll('.wb-component').length===2);
const groups=[...document.querySelectorAll('.wb-component')];
const [encoder,vae]=groups.map(e=>e.querySelector('select'));
const switches=groups.map(e=>e.querySelector('[role=switch]'));
const options=e=>[...e.options].map(o=>o.value);
const select=async(e,v)=>{e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));await tick();check(e.value===v,'Selection rejected: '+v);};
const menu=document.querySelector('.wb-model-files');
check(menu&&!menu.open&&menu.previousElementSibling.classList.contains('wb-controls'),'Companions must start collapsed below ordinary settings');
const closedHeight=menu.getBoundingClientRect().height;
check(closedHeight<=menu.querySelector('summary').getBoundingClientRect().height+3,'Closed menu still consumes companion height');
const checkpoint=document.querySelector('[data-model-picker]');
check(checkpoint&&checkpoint.value==='anima/anima-preview.safetensors','Missing current checkpoint picker');
check([...checkpoint.options].find(e=>e.value==='unknown.safetensors')?.disabled,'Unknown diffusion recipe must stay disabled');
await select(checkpoint,'anima/second.safetensors');
await click('[data-dock-tab=models]');
check(document.querySelector('[data-run-checkpoint] button[aria-pressed=true]')?.getAttribute('aria-label')==='anima/second.safetensors','Dropdown did not update Models tile');
await click('[data-run-checkpoint] button[aria-label="anima/anima-preview.safetensors"]');
check(checkpoint.value==='anima/anima-preview.safetensors','Models tile did not update dropdown');
const styleReport=()=>[...document.querySelectorAll('.wb-settings select')].filter(e=>!e.closest('.wb-model-files')&&e.getBoundingClientRect().height>0).map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {label:e.getAttribute('aria-label')||e.closest('label')?.textContent?.slice(0,40),height:r.height,appearance:s.appearance,chevron:s.backgroundImage,top:s.paddingTop,bottom:s.paddingBottom};});
const mainControls=styleReport();
check(mainControls.length>=6,'Missing ordinary Studio selectors');
for(const c of mainControls)check(Math.abs(c.height-28.8)<1&&c.appearance==='none'&&c.chevron.includes('svg')&&c.top==='0px'&&c.bottom==='0px','Ordinary selector style mismatch '+JSON.stringify(c));
await select(document.querySelector('[data-pipeline]'),'i2i');
const scalingControls=styleReport();check(scalingControls.length>mainControls.length,'Image scaling selector not rendered');
for(const c of scalingControls)check(Math.abs(c.height-28.8)<1&&c.appearance==='none'&&c.chevron.includes('svg')&&c.top==='0px'&&c.bottom==='0px','Scaling selector style mismatch '+JSON.stringify(c));
await select(document.querySelector('[data-pipeline]'),'t2i');
await click('.wb-model-files > summary');check(menu.open&&menu.getBoundingClientRect().height>closedHeight+100,'Model files menu did not expand');
check(switches.every(e=>e.getAttribute('aria-checked')==='false'),'Switches must default off');
check(switches.every(e=>e.getAttribute('aria-label')?.length),'Missing accessible switch labels');
check(encoder.value===''&&vae.value==='','Automatic must use raw empty preference');
check(encoder.options[0].text.includes('qwen_3_600m.safetensors')||encoder.options[0].text.includes('renamed-encoder.safetensors'),'Automatic encoder missing');
check(vae.options[0].text.includes('wan_2.1_vae.safetensors'),'Automatic VAE missing');
check(!options(encoder).includes('custom-encoder.safetensors')&&!options(vae).includes('custom-vae.safetensors'),'Unknown files visible by default');
const renamedByHeader=options(encoder).includes('renamed-encoder.safetensors');
check(!window.__headerMappingExpected||renamedByHeader,'Configured Qwen header identity not matched');
await click('[data-studio-tab=map]');
const automatic=JSON.parse((await wait(()=>document.querySelector('[data-plan-intent]'))).textContent);
check(automatic.diffusion?.textEncoder===window.__automaticEncoder&&automatic.diffusion?.vae==='wan_2.1_vae.safetensors','Automatic Run Plan did not resolve companions');
await click('[data-studio-tab=generate]');
switches[0].click();await tick();
check(switches[0].getAttribute('aria-checked')==='true'&&switches[1].getAttribute('aria-checked')==='false','Encoder switch not independent');
check(options(encoder).includes('custom-encoder.safetensors')&&!options(vae).includes('custom-vae.safetensors'),'Encoder widening leaked');
check(options(encoder).includes('renamed-encoder.safetensors'),'Renamed encoder unavailable with override');
check(!options(encoder).includes('custom-vae.safetensors')&&!options(encoder).includes('not-a-companion.safetensors'),'Category boundary violated');
await select(encoder,'custom-encoder.safetensors');
switches[1].click();await tick();
check(switches.every(e=>e.getAttribute('aria-checked')==='true'),'VAE switch changed encoder override');
check(options(vae).includes('custom-vae.safetensors')&&!options(vae).includes('custom-encoder.safetensors'),'VAE category boundary');
await select(vae,'custom-vae.safetensors');
switches[0].click();await tick();
check(switches[1].getAttribute('aria-checked')==='true','Encoder reset changed VAE override');
check(encoder.value==='custom-encoder.safetensors','Explicit manual pick silently replaced');
switches[0].click();await tick();
const controls=groups.map(e=>{const s=e.querySelector('select'),r=s.getBoundingClientRect(),p=e.getBoundingClientRect(),css=getComputedStyle(s);return {label:e.querySelector('label').textContent,height:r.height,width:r.width,parentWidth:p.width,appearance:css.appearance,chevron:css.backgroundImage,top:css.paddingTop,bottom:css.paddingBottom};});
const dock=document.querySelector('.wb-dock-sort:not(.wb-component select)');
for(const c of controls){check(Math.abs(c.height-28.8)<1,'Unexpected select height '+JSON.stringify(c));check(Math.abs(c.width-c.parentWidth)<1,'Select not full width');check(c.appearance==='none'&&c.chevron.includes('svg')&&c.top==='0px'&&c.bottom==='0px','Native select style mismatch');if(dock)check(c.chevron===getComputedStyle(dock).backgroundImage,'Different dock chevron');}
check(document.documentElement.scrollWidth<=innerWidth,'Generate horizontal overflow');
await click('.wb-model-files > summary');check(!menu.open,'Model files menu did not close');
await click('.wb-model-files > summary');check(encoder.value==='custom-encoder.safetensors'&&vae.value==='custom-vae.safetensors','Closing menu reset selected companions');
const before=window.__calls.length;
await click('[data-studio-tab=map]');
const draft=JSON.parse((await wait(()=>document.querySelector('[data-plan-intent]'))).textContent);
check(draft.diffusion?.textEncoder==='custom-encoder.safetensors'&&draft.diffusion?.vae==='custom-vae.safetensors','Run Plan lost exact manual names: '+JSON.stringify(draft));
check(window.__calls.length===before,'Run Plan caused IPC');
check(document.documentElement.scrollWidth<=innerWidth,'Run Plan horizontal overflow');
await click('[data-studio-tab=generate]');
check(!window.__calls.some(c=>/job_(prepare|submit)|upload|download|backend_start/.test(c.command)),'Unexpected computation/start/download');
check(!window.__unexpected.length,'Unexpected IPC: '+window.__unexpected);
check(!window.__errors.length,'Browser errors: '+window.__errors);
await click('.wb-model-files > summary');check(!menu.open,'Final compact state is not collapsed');
window.__RESULT={passed:true,viewport:innerWidth,controls,mainControls,checkpointSync:true,collapsedMenu:true,scalingStyle:true,renamedByHeader,independentSwitches:true,categoryBoundaries:true,manualPlanNames:true,noImplicitExecution:true,noOverflow:true};
})().catch(e=>window.__RESULT={error:String(e),stack:e.stack,calls:window.__calls,text:document.body.innerText.slice(-10000)});'started'"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    anima = next(f for f in json.loads((ROOT/'src/families/builtin.json').read_text(encoding='utf-8')) if f['id'] == 'anima')
    header_mapping = 'qwen3-0.6b' in anima.get('components', {}).get('textEncoders', [])
    assert header_mapping, 'Anima Qwen header mapping is required for this verification'
    results = []
    cases = [(w, l, False) for w in (1440, 768, 320) for l in ('de', 'en', 'fr', 'ja', 'tr', 'zh')]
    for width, locale, header_only in cases + [(1440, 'de', True)]:
            models = [m for m in MODELS if not header_only or m['name'] != 'qwen_3_600m.safetensors']
            manager = WebKit2.UserContentManager()
            init = fixture()+r"""
localStorage.clear();window.__unexpected=[];window.__errors=[];
window.addEventListener('error',e=>window.__errors.push(e.message));
window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
localStorage.setItem('deas.pref.install.root',JSON.stringify('/fixture/env'));
localStorage.setItem('deas.pref.backend.autostart','false');
localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify('anima/anima-preview.safetensors'));
"""+'\nlocalStorage.setItem("deas.locale.v1",'+json.dumps(locale)+');window.__models='+json.dumps(models)+';window.__headerMappingExpected='+json.dumps(header_mapping)+';window.__automaticEncoder='+json.dumps('renamed-encoder.safetensors' if header_only else 'qwen_3_600m.safetensors')+';'
            manager.add_script(WebKit2.UserScript.new(init, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
            view = WebKit2.WebView.new_with_user_content_manager(manager)
            window = Gtk.Window(); window.set_default_size(width, 1100); window.add(view)
            failures = []; started = False

            def fail(error):
                failures.append(str(error)); Gtk.main_quit()

            def snapshot(web, result, *_):
                try: web.get_snapshot_finish(result).write_to_png(str(OUT/f'component-pickers-{locale}-{width}.png'))
                except Exception as error: fail(error)
                Gtk.main_quit()

            def checked(web, result, *_):
                try:
                    report = json.loads(web.evaluate_javascript_finish(result).to_string())
                    if report is None:
                        GLib.timeout_add(100, poll); return
                    assert report.get('passed'), report
                    assert report['viewport'] == width, report
                    results.append({'locale': locale, 'width': width, 'headerOnly': header_only, **report})
                    if not header_only and locale == 'de' and width in (1440, 320):
                        web.get_snapshot(WebKit2.SnapshotRegion.FULL_DOCUMENT, WebKit2.SnapshotOptions.NONE, None, snapshot, None)
                    else: Gtk.main_quit()
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
            timeout = GLib.timeout_add_seconds(35, lambda: fail('Component picker timeout'))
            window.show_all(); view.load_uri(URL); Gtk.main()
            GLib.source_remove(timeout); window.destroy()
            (OUT/'results.json').write_text(json.dumps(results, indent=2)+'\n', encoding='utf-8')
            assert not failures, (width, locale, failures)
            print(f'PASS GTK/WebKit {width} {locale}', flush=True)
    assert len(results) == 19
    print(f'PASS: {len(results)} real GTK/WebKit renders, mocked IPC only. {OUT}')


if __name__ == '__main__':
    main()
