import { afterEach, expect, test, vi } from 'vitest';
import { embeddedWorkflow, sendComfyWorkflow } from './comfyWorkflow';
afterEach(()=>{vi.useRealTimers();document.body.replaceChildren();});
const workflow={nodes:[{id:1,type:'CLIPTextEncode',widgets_values:['forest']}],links:[],version:0.4};
test('accepts only embedded editor workflows, keeping unknown fields intact',()=>{
 expect(embeddedWorkflow([['Workflow',JSON.stringify(workflow)]])).toEqual(workflow);
 for(const value of ['bad','null','[]','{}','{"nodes":[null],"links":[]}','{"nodes":[{"id":1}],"links":[]}'])expect(embeddedWorkflow([['workflow',value]])).toBeNull();
 expect(embeddedWorkflow([['prompt',JSON.stringify(workflow)]])).toBeNull();
});
test('waits for the exact editor readiness, sends once, and requires an acknowledgement',async()=>{
 const frame=document.createElement('iframe');document.body.append(frame);
 const post=vi.spyOn(frame.contentWindow!,'postMessage');const controller=new AbortController();
 const result=sendComfyWorkflow(frame,'http://127.0.0.1:1234',workflow,'a.png',controller.signal);
 const {id}=post.mock.calls[0][0] as {id:string};
 const reply=(type:string,origin='http://127.0.0.1:1234',source:Window|null=frame.contentWindow)=>window.dispatchEvent(new MessageEvent('message',{source,origin,data:{id,type}}));
 reply('deas:ready','http://evil.invalid');reply('deas:ready','http://127.0.0.1:1234',window);expect(post).toHaveBeenCalledTimes(1);
 reply('deas:ready');reply('deas:ready');expect(post).toHaveBeenCalledTimes(2);
 expect(post.mock.calls[1]).toEqual([{type:'deas:load',id,workflow,name:'a.png'},'http://127.0.0.1:1234']);
 reply('deas:loaded');await result;
});
test('fails on disconnect, timeout, or editor import error',async()=>{
 vi.useFakeTimers();
 const frame=document.createElement('iframe');document.body.append(frame);
 const post=vi.spyOn(frame.contentWindow!,'postMessage');
 const controller=new AbortController();const aborted=sendComfyWorkflow(frame,'http://127.0.0.1:1234',workflow,'a',controller.signal);const abortedCheck=expect(aborted).rejects.toThrow('disconnected');controller.abort();await abortedCheck;
 const timed=sendComfyWorkflow(frame,'http://127.0.0.1:1234',workflow,'a',new AbortController().signal);const timedCheck=expect(timed).rejects.toThrow('respond');await vi.advanceTimersByTimeAsync(20000);await timedCheck;
 const failed=sendComfyWorkflow(frame,'http://127.0.0.1:1234',workflow,'a',new AbortController().signal);const failedCheck=expect(failed).rejects.toThrow('import failed');const {id}=post.mock.calls.at(-1)![0] as {id:string};
 for(const type of ['deas:ready','deas:error'])window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,origin:'http://127.0.0.1:1234',data:{id,type}}));
 await failedCheck;
});
