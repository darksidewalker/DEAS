import { createContext } from 'react';

export type ComfyWorkflow=Record<string,unknown> & {nodes:Record<string,unknown>[];links:unknown[]};
/** Only editor graphs; API prompts do not contain the original editor layout. */
export function embeddedWorkflow(entries:[string,string][]):ComfyWorkflow|null {
 for(const [key,value] of entries){
  if(key.toLowerCase()!=='workflow')continue;
  try{const w=JSON.parse(value);if(w&&typeof w==='object'&&!Array.isArray(w)&&Array.isArray(w.nodes)&&Array.isArray(w.links)&&w.nodes.every((n:unknown)=>n&&typeof n==='object'&&!Array.isArray(n)&&typeof (n as Record<string,unknown>).type==='string'&&['string','number'].includes(typeof (n as Record<string,unknown>).id)))return w;}catch{/* Untrusted metadata is not necessarily JSON. */}
 }
 return null;
}
export const OpenComfyWorkflow=createContext<((workflow:ComfyWorkflow,name:string)=>Promise<void>)|null>(null);

/** Readiness handshake: iframe load does not mean Comfy's app has finished initializing. */
export function sendComfyWorkflow(frame:HTMLIFrameElement,endpoint:string,workflow:ComfyWorkflow,name:string,signal:AbortSignal):Promise<void> {
 const origin=new URL(endpoint).origin,id=crypto.randomUUID();
 return new Promise((resolve,reject)=>{
  let sent=false;
  const finish=(error?:Error)=>{clearInterval(retry);clearTimeout(timeout);window.removeEventListener('message',receive);signal.removeEventListener('abort',abort);error?reject(error):resolve();};
  const abort=()=>finish(new Error('Backend disconnected'));
  const probe=()=>frame.contentWindow?.postMessage({type:'deas:probe',id},origin);
  const receive=(event:MessageEvent)=>{
   if(event.source!==frame.contentWindow||event.origin!==origin||event.data?.id!==id)return;
   if(event.data.type==='deas:ready'&&!sent){sent=true;frame.contentWindow?.postMessage({type:'deas:load',id,workflow,name},origin);}
   if(sent&&event.data.type==='deas:loaded')finish();
   if(sent&&event.data.type==='deas:error')finish(new Error('Workflow import failed'));
  };
  const retry=setInterval(probe,500),timeout=setTimeout(()=>finish(new Error('Editor did not respond')),20000);
  window.addEventListener('message',receive);signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();else probe();
 });
}
