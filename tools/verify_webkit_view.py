"""Optional system-Python GTK/WebKit render check; IPC fixtures, no Tauri/native file moves."""
import ast
import json
from pathlib import Path
import sys
if sys.platform != 'linux':
    sys.exit('Linux-only GTK/WebKit diagnostic; use portable Chromium fixtures on Windows.')
import gi
gi.require_version('Gtk','3.0')
gi.require_version('WebKit2','4.1')
from gi.repository import Gtk, WebKit2, GLib

URL=(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:4197').rstrip('/')
OUT=Path(sys.argv[2]) if len(sys.argv)>2 else Path.home()/'.hermes/cache/scratch/deas-webkit-view'
module=ast.parse((Path(__file__).parent/'verify_projects.py').read_text(encoding='utf-8'))
INIT=next(ast.literal_eval(n.value) for n in module.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='INIT' for t in n.targets))
CHECK=r"""JSON.stringify((()=>{
 const controls=Array.from(document.querySelectorAll('.wb-dock-sort')).map(e=>{
  const s=getComputedStyle(e),r=e.getBoundingClientRect(),ctx=document.createElement('canvas').getContext('2d');ctx.font=s.font||`${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
  return {font:parseFloat(s.fontSize),height:r.height,available:r.width-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)-parseFloat(s.borderLeftWidth)-parseFloat(s.borderRightWidth),widest:Math.max(...Array.from(e.options,o=>ctx.measureText(o.text).width)),paddingTop:s.paddingTop,paddingBottom:s.paddingBottom,appearance:s.appearance};
 });
 const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
 const warning=document.querySelector('.wb-stage-warning');
 return {controls,search:rect(document.querySelector('[data-dock-search]')),run:rect(document.querySelector('[data-run]')),arrow:rect(document.querySelector('.project-menu > summary')),stage:rect(document.querySelector('.wb-stage')),warning:warning?{position:getComputedStyle(warning).position,text:warning.innerText}:null};
})())"""


def main():
 OUT.mkdir(parents=True,exist_ok=True)
 results=[]
 for missing in [False,True]:
  manager=WebKit2.UserContentManager()
  script=INIT.replace('LOCALE',json.dumps('en'))
  if missing:script+="localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify('qwen3vl_4b_fp8_scaled.safetensors'));"
  manager.add_script(WebKit2.UserScript.new(script,WebKit2.UserContentInjectedFrames.TOP_FRAME,WebKit2.UserScriptInjectionTime.START,None,None))
  view=WebKit2.WebView.new_with_user_content_manager(manager)
  window=Gtk.Window();window.set_default_size(1440,1000);window.add(view)
  failures=[];started=False;timeout_id=None
  def fail(error):
   failures.append(str(error));Gtk.main_quit()
  def snapshot_done(web,result,*_):
   try:web.get_snapshot_finish(result).write_to_png(str(OUT/('warning.png' if missing else 'toolbar.png')))
   except Exception as e:fail(e);return
   Gtk.main_quit()
  def js_done(web,result,*_):
   try:
    value=web.evaluate_javascript_finish(result)
    report=json.loads(value.to_string())
    for item in report['controls']:
     assert item['font']>=12 and item['widest']<=item['available']+1,item
     assert abs(item['height']-report['search']['height'])<=1,item
     assert item['paddingTop']=='0px' and item['paddingBottom']=='0px',item
    run,arrow=report['run'],report['arrow']
    assert run['height']>=40 and abs(run['height']-arrow['height'])<=1,(run,arrow)
    assert abs(run['x']+run['width']-arrow['x'])<=1,(run,arrow)
    if missing:assert report['warning'] and report['warning']['position']=='absolute',report
    else:assert report['warning'] is None,report
    results.append(report)
    web.get_snapshot(WebKit2.SnapshotRegion.FULL_DOCUMENT,WebKit2.SnapshotOptions.NONE,None,snapshot_done,None)
   except Exception as e:fail(e)
  def check():
   view.evaluate_javascript(CHECK,-1,None,None,None,js_done,None)
   return False
  def loaded(web,event):
   nonlocal started
   if event==WebKit2.LoadEvent.FINISHED and not started:
    started=True;GLib.timeout_add(2000,check)
  view.connect('load-changed',loaded)
  timeout_id=GLib.timeout_add_seconds(30,lambda:fail('WebKit verification timeout'))
  window.show_all();view.load_uri(URL+'/tools/inpaint-fixture.html');Gtk.main()
  if timeout_id:GLib.source_remove(timeout_id)
  window.destroy()
  assert not failures,failures
 assert all(abs(results[0]['stage'][key]-results[1]['stage'][key])<=1 for key in ['x','y','width','height']),results
 (OUT/'results.json').write_text(json.dumps(results,indent=2)+'\n', encoding='utf-8')
 print('PASS: actual GTK/WebKit readable compact selectors, attached Run dropdown and no View shift on warning (IPC fixtures).')

if __name__=='__main__':main()
