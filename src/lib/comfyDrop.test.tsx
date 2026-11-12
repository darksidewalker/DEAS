import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { comfyDropPoint, readComfyDropFiles, sendComfyDrop } from './comfyDrop';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),convertFileSrc:vi.fn((path:string)=>`asset://localhost/${path}`),isTauri:()=>true}));
beforeEach(()=>{vi.mocked(invoke).mockResolvedValue({ram:{total:80000000,used:0}});});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.clearAllMocks();document.body.replaceChildren();Reflect.deleteProperty(document,'elementFromPoint');});
const signal=()=>new AbortController().signal;
const range=(bytes:Uint8Array,start:number,end:number,total=bytes.length)=>{
 const part=bytes.slice(start,end+1),response=new Response(part,{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${total}`}});
 // jsdom File/Blob and Node fetch Response use different Blob implementations.
 vi.spyOn(response,'blob').mockResolvedValue(new Blob([part]));return response;
};
test('reads exact bytes via bounded native ranges, keeps MIME and filenames, and advances by actual returned ranges',async()=>{
 const bytes=Uint8Array.from([137,80,78,71,13,10,26,10]);
 const fetcher=vi.fn().mockResolvedValueOnce(new Response(null,{headers:{'Content-Length':'8'}})).mockResolvedValueOnce(range(bytes,0,2)).mockResolvedValueOnce(range(bytes,3,7));
 vi.stubGlobal('fetch',fetcher);
 const [file]=await readComfyDropFiles(['C:\\pics\\original.PNG'],signal());
 expect(convertFileSrc).toHaveBeenCalledWith('C:\\pics\\original.PNG');
 expect(file.name).toBe('original.PNG');expect(file.type).toBe('image/png');
 const buffer=await new Promise<ArrayBuffer>(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result as ArrayBuffer);reader.readAsArrayBuffer(file);});
 expect(new Uint8Array(buffer)).toEqual(bytes);
 expect(fetcher.mock.calls[0][1].method).toBe('HEAD');
 expect(fetcher.mock.calls[1][1].headers.Range).toBe('bytes=0-7');
 expect(fetcher.mock.calls[2][1].headers.Range).toBe('bytes=3-7');
});
test('rejects aggregate files above the proportional available-RAM budget before reading the excess file',async()=>{
 vi.mocked(invoke).mockResolvedValue({ram:{total:80,used:0}});
 const bytes=new Uint8Array(6);
 const fetcher=vi.fn().mockResolvedValueOnce(new Response(null,{headers:{'Content-Length':'6'}})).mockResolvedValueOnce(range(bytes,0,5)).mockResolvedValueOnce(new Response(null,{headers:{'Content-Length':'6'}}));
 vi.stubGlobal('fetch',fetcher);
 await expect(readComfyDropFiles(['/one.png','/two.png'],signal())).rejects.toThrow('one eighth');
 expect(fetcher).toHaveBeenCalledTimes(3);
});
test.each(['200','wrong-start','changed-size','truncated','oversized-range'])('rejects unsafe ranged response %s',async(kind)=>{
 const response=kind==='200'?new Response(new Uint8Array(2)):
  kind==='wrong-start'?range(new Uint8Array(2),1,1):
  kind==='changed-size'?range(new Uint8Array(2),0,1,3):
  kind==='oversized-range'?range(new Uint8Array(4),0,3,2):
  new Response(new Uint8Array(1),{status:206,headers:{'Content-Range':'bytes 0-1/2'}});
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(null,{headers:{'Content-Length':'2'}})).mockResolvedValueOnce(response));
 await expect(readComfyDropFiles(['/one.json'],signal())).rejects.toThrow();
});
test('missing telemetry, failed HEAD and cancellation fail without dispatch',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 vi.mocked(invoke).mockResolvedValueOnce({});
 await expect(readComfyDropFiles(['/x'],signal())).rejects.toThrow('budget');expect(fetcher).not.toHaveBeenCalled();
 fetcher.mockResolvedValueOnce(new Response(null,{status:404}));
 await expect(readComfyDropFiles(['/x'],signal())).rejects.toThrow('size');
 const controller=new AbortController();controller.abort();fetcher.mockClear();
 await expect(readComfyDropFiles(['/x'],controller.signal)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
});
test('hit testing respects active/hidden frames, borders, Linux logical coordinates, Windows DPR and overlays',()=>{
 const frame=document.createElement('iframe');document.body.append(frame);
 vi.spyOn(frame,'getBoundingClientRect').mockReturnValue({left:100,top:50,width:400,height:300} as DOMRect);
 for(const [key,value] of Object.entries({offsetWidth:400,offsetHeight:300,clientWidth:396,clientHeight:296,clientLeft:2,clientTop:2}))Object.defineProperty(frame,key,{value});
 Object.defineProperty(document,'elementFromPoint',{configurable:true,value:vi.fn(()=>frame)});
 vi.spyOn(navigator,'userAgent','get').mockReturnValue('Linux');vi.stubGlobal('devicePixelRatio',2);
 expect(comfyDropPoint(frame,{x:202,y:102})).toEqual({x:100,y:50});
 vi.spyOn(navigator,'userAgent','get').mockReturnValue('Windows');
 expect(comfyDropPoint(frame,{x:404,y:204})).toEqual({x:100,y:50});
 frame.hidden=true;expect(comfyDropPoint(frame,{x:404,y:204})).toBeNull();frame.hidden=false;
 const dialog=document.createElement('dialog');dialog.open=true;document.body.append(dialog);
 expect(comfyDropPoint(frame,{x:404,y:204})).toBeNull();dialog.hidden=true;
 expect(comfyDropPoint(frame,{x:404,y:204})).toEqual({x:100,y:50});dialog.remove();
 vi.mocked(document.elementFromPoint).mockReturnValue(document.body);
 expect(comfyDropPoint(frame,{x:404,y:204})).toBeNull();
});
test('failed file cloning cleans up its acknowledgement listener and timeout',async()=>{
 vi.useFakeTimers();
 try{
  const frame=document.createElement('iframe');document.body.append(frame);
  vi.spyOn(frame.contentWindow!,'postMessage').mockImplementation(()=>{throw new DOMException('Cannot clone','DataCloneError');});
  const remove=vi.spyOn(window,'removeEventListener');
  await expect(sendComfyDrop(frame,'http://127.0.0.1:1234',[new File(['{}'],'x.json')],{x:10,y:20},signal())).rejects.toThrow('receive');
  expect(remove).toHaveBeenCalledWith('message',expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
 }finally{vi.useRealTimers();}
});

test('dispatch requires exact-frame origin/id acknowledgement and aborts on navigation',async()=>{
 const frame=document.createElement('iframe');document.body.append(frame);
 const post=vi.spyOn(frame.contentWindow!,'postMessage');
 const controller=new AbortController();const file=new File(['{}'],'a.json',{type:'application/json'});
 const result=sendComfyDrop(frame,'http://127.0.0.1:1234',[file],{x:10,y:20},controller.signal);
 const {id}=post.mock.calls[0][0] as {id:string};
 expect(post.mock.calls[0]).toEqual([{type:'deas:drop',id,files:[file],x:10,y:20},'http://127.0.0.1:1234']);
 for(const [source,origin] of [[window,'http://127.0.0.1:1234'],[frame.contentWindow,'https://evil.invalid']] as const)window.dispatchEvent(new MessageEvent('message',{source,origin,data:{id,type:'deas:dropped'}}));
 window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,origin:'http://127.0.0.1:1234',data:{id,type:'deas:dropped'}}));
 await result;
 const cancelled=sendComfyDrop(frame,'http://127.0.0.1:1234',[file],{x:10,y:20},controller.signal);
 const check=expect(cancelled).rejects.toThrow('cancelled');controller.abort();await check;
});
