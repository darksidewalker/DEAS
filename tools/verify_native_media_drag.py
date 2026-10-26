"""X11 mouse regression for the real debug app's GTK overlay and media-to-prompt drop.
Usage: DISPLAY=:0 XAUTHORITY=... python tools/verify_native_media_drag.py BINARY OUT [VIDEO]
Uses isolated XDG state, three generated PNGs and tiny header-only model-discovery fixtures;
no model/backend execution. Build the debug binary without custom-protocol with build.devUrl pointing to the Vite
/tools/inpaint-fixture.html page. DEAS_DRAG_FAMILY selects sdxl (default),
qwen-image-2.1, qwen-image-2.1-turbo, krea-2 or moss-image. Optional local VIDEO
exercises native playback across successful/cancelled drags. Needs XTest/xprop.
Checks thumbnail numbering, real mouse reordering and overlay-X removal.
"""
import ctypes
import json
import os
from pathlib import Path
import re
import signal
import struct
import subprocess
import sys
import threading
import time
import zlib

if sys.platform != 'linux':
    sys.exit('Linux-only X11 native drag diagnostic; not Windows acceptance.')

binary, destination, *videos = sys.argv[1:]
out = Path(destination).resolve()
out.mkdir(parents=True, exist_ok=False)
family_id = os.environ.get('DEAS_DRAG_FAMILY', 'sdxl')
family = next(f for f in json.loads((Path(__file__).resolve().parents[1] / 'src/families/builtin.json').read_text(encoding='utf-8')) if f['id'] == family_id)
model_dir = out / 'ComfyUI/models' / ('checkpoints' if family_id == 'sdxl' else 'diffusion_models')
model_dir.mkdir(parents=True)
keys = family['model'][0]
header = json.dumps({key: {'dtype': 'F32', 'shape': [1], 'data_offsets': [4*i, 4*i+4]} for i, key in enumerate(keys)}).encode()
(model_dir / f'{family_id}.safetensors').write_bytes(struct.pack('<Q',len(header)) + header + b'\0' * (4*len(keys)))
image = out / 'ComfyUI/output/raw/reference-1.png'
image.parent.mkdir(parents=True)
(out / 'ComfyUI/input').mkdir()
def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
for index, color in enumerate((b'\xe0\x50\x20', b'\x20\xc0\x90', b'\x40\x70\xe0'), 1):
    image.with_name(f'reference-{index}.png').write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\0' + color * 64) * 64)) + chunk(b'IEND', b''))
script = r'''
history.replaceState(null,'','?root='+encodeURIComponent(ROOT));
localStorage.setItem('deas.pref.studio.run.positive',JSON.stringify('unchanged prompt'));
document.addEventListener('DOMContentLoaded',()=>{(async()=>{
 const api=window.__TAURI_INTERNALS__,invoke=api.invoke.bind(api);
 const report=payload=>invoke('plugin:event|emit',{event:'deas-video-probe',payload});
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const assert=(ok,message)=>{if(!ok)throw Error(message);};
 const until=async(fn)=>{for(let i=0;i<120;i++){if(fn())return;await sleep(50);}throw Error('UI timeout');};
 const video=VIDEO,family=FAMILY,model={name:family+'.safetensors'};
 localStorage.setItem('deas.locale.v1','en');
 localStorage.setItem('deas.pref.studio.run.positive',JSON.stringify('unchanged prompt'));
 window.confirm=()=>false;
 let id;
 try{
  await until(()=>document.querySelector('[data-node=studio]')||document.querySelector('#run-positive'));
  document.querySelector('[data-node=studio]')?.click();
  document.querySelector('[data-dock-tab=models]').click();
  await until(()=>document.querySelector('[data-run-load]')&&!document.querySelector('[data-run-load]').disabled);
  document.querySelector('[data-run-load]').click();
  await until(()=>document.querySelector('[data-model-picker]')?.value===model.name);
  document.querySelector('[data-dock-tab=media]').click();
  await until(()=>document.querySelector('[data-media-root=output]'));
  document.querySelector('[data-media-root=output]').click();
  await until(()=>document.querySelector('[data-media=image] img')?.naturalWidth>0);
  const counts=()=>document.querySelectorAll('[data-reference-controls]').length;
  const drag=async(n,cancel=false)=>{
   await sleep(350);
   const a=document.querySelectorAll('[data-media=image]')[n-1],b=document.querySelector('#run-positive');
   const r=a.getBoundingClientRect(),q=b.getBoundingClientRect();
   await report({phase:'drag',n,cancel,points:[r.x+r.width/2,r.y+r.height/2,q.x+q.width/2,q.y+q.height/2]});
   if(cancel){await sleep(1800);assert(counts()===n-1,'Cancelled drag added a reference');}
   else await until(()=>counts()===n);
   assert(b.value==='unchanged prompt','Drop edited the prompt');
  };
  await drag(1);
  let before;
  if(video){
   id=crypto.randomUUID();
   await invoke('native_video_open',{id,source:{path:video},autoPlay:true,repeat:true});
   await invoke('native_video_update',{id,action:{kind:'bounds',x:320,y:130,width:300,height:180,visible:true}});
   await sleep(1000);
   before=await invoke('native_video_update',{id,action:{kind:'status'}});
   assert(!before.error&&before.width>0,'Native video did not decode');
  }
  await drag(2);
  await drag(3,true);
  await drag(3);
  const cards=()=>[...document.querySelectorAll('[data-reference-controls]')];
  const order=()=>cards().map(c=>c.querySelector('img')?.getAttribute('src'));
  const numbered=()=>assert(cards().every((c,i)=>c.dataset.referencePosition===String(i+1)),'Reference positions are not consecutive');
  await until(()=>cards().every(c=>c.querySelector('img')?.naturalWidth>0));
  numbered();
  const original=order(),a=cards()[0].querySelector('img').getBoundingClientRect(),b=cards()[2].querySelector('img').getBoundingClientRect();
  await sleep(350);
  await report({phase:'drag',n:4,cancel:false,points:[a.x+a.width/2,a.y+a.height/2,b.x+b.width/2,b.y+b.height/2]});
  await until(()=>JSON.stringify(order())===JSON.stringify([original[1],original[2],original[0]]));
  numbered();
  assert(!document.querySelector('[data-reference-move]'),'Unexpected arrow controls');
  cards()[0].querySelector('[data-reference-remove]').click();
  await until(()=>counts()===2);
  assert(JSON.stringify(order())===JSON.stringify([original[2],original[0]]),'Removing a reference changed other pictures');
  numbered();
  assert(document.querySelector('#run-positive').value==='unchanged prompt','Reference reorder edited the prompt');
  let after;
  if(id){await sleep(700);after=await invoke('native_video_update',{id,action:{kind:'status'}});assert(!after.error&&after.width>0&&!after.paused&&after.position>before.position,'Video failed across drag');await invoke('native_video_update',{id,action:{kind:'close'}});}
  await report({phase:'passed',count:counts(),prompt:document.querySelector('#run-positive').value,before,after});
 }catch(e){await report({phase:'failed',error:String(e),location:location.href,body:document.body?.innerText.slice(0,2000),image:document.querySelector('[data-media=image]')?.outerHTML});}
 await invoke('plugin:window|destroy',{label:'main'});
})();},{once:true});
'''.replace('ROOT', json.dumps(str(out))).replace('VIDEO', json.dumps(str(Path(videos[0]).resolve()) if videos else None)).replace('FAMILY', json.dumps(family_id))
(out / 'probe.js').write_text(script, encoding='utf-8')
env = dict(os.environ, GDK_BACKEND='x11', DEAS_VIDEO_TEST_SCRIPT=str(out / 'probe.js'), DEAS_VIDEO_PROBE='1', XDG_CONFIG_HOME=str(out / 'config'), XDG_DATA_HOME=str(out / 'data'), XDG_CACHE_HOME=str(out / 'cache'))
x = ctypes.CDLL('libX11.so.6')
t = ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
d = x.XOpenDisplay(None)
assert d, 'X11 display unavailable'
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x.XDefaultRootWindow.restype = ctypes.c_ulong
x.XTranslateCoordinates.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong)]
class ClientMessage(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int), ('display', ctypes.c_void_p), ('window', ctypes.c_ulong), ('message_type', ctypes.c_ulong), ('format', ctypes.c_int), ('data', ctypes.c_long * 5)]
class XEvent(ctypes.Union):
    _fields_ = [('message', ClientMessage), ('pad', ctypes.c_long * 24)]
x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x.XInternAtom.restype = ctypes.c_ulong
x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(XEvent)]
x.XFlush.argtypes = [ctypes.c_void_p]
t.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
t.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
p = subprocess.Popen([str(Path(binary).resolve())], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
timer = threading.Timer(35, lambda: p.terminate() if p.poll() is None else None)
timer.start()
reports, lines = [], []
try:
    assert p.stdout is not None
    for line in p.stdout:
        lines.append(line)
        if 'DEAS_VIDEO_PROBE ' not in line:
            continue
        result = json.loads(line.split('DEAS_VIDEO_PROBE ', 1)[1])
        reports.append(result)
        if result['phase'] != 'drag':
            continue
        windows = re.findall(r'0x[0-9a-f]+', subprocess.check_output(['xprop', '-root', '_NET_CLIENT_LIST'], env=env, text=True))
        owned = [w for w in windows if f'= {p.pid}' in subprocess.check_output(['xprop', '-id', w, '_NET_WM_PID'], env=env, text=True)]
        assert len(owned) == 1, owned
        wid = int(owned[0], 16)
        ox, oy, child = ctypes.c_int(), ctypes.c_int(), ctypes.c_ulong()
        x.XTranslateCoordinates(d, wid, x.XDefaultRootWindow(d), 0, 0, ctypes.byref(ox), ctypes.byref(oy), ctypes.byref(child))
        event = XEvent()
        event.message = ClientMessage(33, 0, 1, d, wid, x.XInternAtom(d, b'_NET_ACTIVE_WINDOW', 0), 32, (ctypes.c_long * 5)(2, 0, 0, 0, 0))
        x.XSendEvent(d, x.XDefaultRootWindow(d), 0, (1 << 20) | (1 << 19), ctypes.byref(event))
        x.XFlush(d)
        time.sleep(.3)
        x.XTranslateCoordinates(d, wid, x.XDefaultRootWindow(d), 0, 0, ctypes.byref(ox), ctypes.byref(oy), ctypes.byref(child))
        sx, sy, ex, ey = result['points']
        if result['cancel']:
            ex, ey = 50, 50  # Release over the non-droppable header, not another application.
        for i in range(31):
            t.XTestFakeMotionEvent(d, -1, round(ox.value + sx + (ex - sx) * i / 30), round(oy.value + sy + (ey - sy) * i / 30), 0)
            if i == 0:
                t.XTestFakeButtonEvent(d, 1, 1, 0)
            x.XFlush(d)
            time.sleep(.04)
        t.XTestFakeButtonEvent(d, 1, 0, 0)
        x.XFlush(d)
    code = p.wait(timeout=5)
finally:
    timer.cancel()
    if p.poll() is None:
        os.killpg(p.pid, signal.SIGTERM)
    (out / 'native.log').write_text(''.join(lines), encoding='utf-8')
    (out / 'results.json').write_text(json.dumps(reports, indent=2), encoding='utf-8')
assert code == 0 and any(r['phase'] == 'passed' for r in reports), ''.join(lines)[-5000:]
if videos:
    frames = re.findall(r'DEAS_VIDEO_FRAME .* hash=(\d+) range=(\d+) gl_error=(\d+)', ''.join(lines))
    assert len({f[0] for f in frames}) >= 2 and all(f[2] == '0' for f in frames), frames
print(json.dumps({'passed': True, 'drags': sum(r['phase'] == 'drag' for r in reports), 'nativeVideo': bool(videos), 'output': str(out)}))
