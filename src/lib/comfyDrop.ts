import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { dropCssPoint } from './media';

/** Native file drops are intercepted by Wry; only the visible editor receives them. */
export function comfyDropPoint(frame:HTMLIFrameElement,position:{x:number;y:number}) {
 const p=dropCssPoint(position),r=frame.getBoundingClientRect();
 if(frame.closest('[hidden]')||!r.width||!r.height||[...document.querySelectorAll('dialog[open]')].some(dialog=>!dialog.closest('[hidden]'))||document.elementFromPoint(p.x,p.y)!==frame)return null;
 const x=(p.x-r.left)*frame.offsetWidth/r.width-frame.clientLeft,y=(p.y-r.top)*frame.offsetHeight/r.height-frame.clientTop;
 return x>=0&&y>=0&&x<frame.clientWidth&&y<frame.clientHeight?{x,y}:null;
}

/** Asset GET buffers natively: HEAD + single ranges bound each read before allocation. */
export async function readComfyDropFiles(paths:readonly string[],signal:AbortSignal):Promise<File[]> {
 const sample=await invoke<{ram?:{total:number;used:number}}>('native_monitoring_sample',{root:null});
 const ram=sample?.ram,available=ram?ram.total-ram.used:NaN;
 // Reserve room for native ranges, IPC, Blob storage and the editor's own decoding.
 const budget=Math.floor(available/8);
 if(!Number.isSafeInteger(budget)||budget<=0)throw Error('Drop memory budget unavailable');
 let total=0;
 const files:File[]=[];
 for(const path of paths){
  signal.throwIfAborted();
  const url=convertFileSrc(path),options={signal,credentials:'omit' as const,redirect:'error' as const};
  const head=await fetch(url,{...options,method:'HEAD'});
  const length=head.headers.get('content-length'),size=length&&/^\d+$/.test(length)?Number(length):NaN;
  if(!head.ok||!Number.isSafeInteger(size)||size<0)throw Error('Dropped file size unavailable');
  total+=size;
  if(total>budget)throw Error('Dropped files exceed one eighth of available RAM');
  const parts:Blob[]=[];
  for(let start=0;start<size;){
   const response=await fetch(url,{...options,headers:{Range:`bytes=${start}-${Math.min(size-1,start+1000*1024-1)}`}});
   const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')??'');
   if(response.status!==206||!range||Number(range[1])!==start||Number(range[3])!==size||Number(range[2])<start||Number(range[2])>=Math.min(size,start+1000*1024)){
    await response.body?.cancel();throw Error('Dropped file changed or ranged reading unavailable');
   }
   const part=await response.blob();
   if(part.size!==Number(range[2])-start+1)throw Error('Dropped file truncated');
   parts.push(part);start+=part.size;
  }
  const name=path.split(/[\\/]/).at(-1)!;
  const types:Record<string,string>={png:'image/png',webp:'image/webp',jpg:'image/jpeg',jpeg:'image/jpeg',json:'application/json'};
  files.push(new File(parts,name,{type:types[name.split('.').at(-1)!.toLowerCase()]??head.headers.get('content-type')??'application/octet-stream'}));
 }
 signal.throwIfAborted();
 return files;
}

/** ACK means dispatched to Comfy's own handlers, not that its asynchronous import succeeded. */
export function sendComfyDrop(frame:HTMLIFrameElement,endpoint:string,files:File[],point:{x:number;y:number},signal:AbortSignal):Promise<void> {
 const origin=new URL(endpoint).origin,id=crypto.randomUUID(),target=frame.contentWindow;
 return new Promise((resolve,reject)=>{
  const finish=(error?:Error)=>{clearTimeout(timeout);window.removeEventListener('message',receive);signal.removeEventListener('abort',abort);error?reject(error):resolve();};
  const abort=()=>finish(new Error('Drop cancelled'));
  const receive=(e:MessageEvent)=>{
   if(e.source!==target||e.origin!==origin||e.data?.id!==id)return;
   if(e.data.type==='deas:dropped')finish();
   else if(e.data.type==='deas:error')finish(new Error('Editor rejected drop'));
  };
  const timeout=setTimeout(()=>finish(new Error('Editor did not accept drop')),10000);
  window.addEventListener('message',receive);signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();else try{target?.postMessage({type:'deas:drop',id,files,...point},origin);}catch{finish(new Error('Editor could not receive drop'));}
 });
}
