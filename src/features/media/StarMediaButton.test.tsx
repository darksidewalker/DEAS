import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { StarMediaButton } from './StarMediaButton';
import { relocatedJob } from '../../lib/media';
import type { JobStatus } from '../../lib/jobs';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,convertFileSrc:(p:string)=>`asset:${p}`,invoke}));
beforeEach(()=>{localStorage.clear();invoke.mockReset();});
afterEach(()=>cleanup());
it('moves a file and publishes its new preview path without an unstar action',async()=>{
 invoke.mockImplementation((command:string)=>Promise.resolve(command==='native_media_star_status'?{starred:false,unavailable:null}:{oldPath:'/out/a.png',path:'/out/starred/a.png'}));
 const moved=vi.fn();
 render(<I18nProvider><StarMediaButton item={{name:'a.png',path:'/out/a.png',src:'asset:/out/a.png',media:'image'}} onMoved={moved}/></I18nProvider>);
 const button=await screen.findByRole('button',{name:'Star a.png'});
 await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));
 fireEvent.click(button);
 await waitFor(()=>expect(moved).toHaveBeenCalledWith(expect.objectContaining({path:'/out/starred/a.png',src:'asset:/out/starred/a.png'})));
 expect(screen.getByRole('button',{name:'Starred a.png'}).getAttribute('aria-pressed')).toBe('true');
 expect(screen.getByRole('button',{name:'Starred a.png'}).hasAttribute('disabled')).toBe(true);
});
it('discards late invalid availability after unmount without logging through a reset IPC mock',async()=>{
 let resolve!:(value:unknown)=>void;
 invoke.mockReturnValue(new Promise(done=>{resolve=done;}));
 const view=render(<I18nProvider><StarMediaButton item={{name:'a.png',path:'/out/a.png',src:'asset:a',media:'image'}}/></I18nProvider>);
 view.unmount();invoke.mockReset();
 await act(async()=>resolve({path:'/out',entries:[]}));
 expect(invoke).not.toHaveBeenCalled();
});
it('repairs retained queue output locations without rewriting executed settings',()=>{
 const job:JobStatus={id:'done',baseUrl:'http://localhost',promptId:null,state:'succeeded',outputs:[{filename:'a.png',subfolder:'run',type:'output'},{filename:'b.png',subfolder:'run',type:'output'}],error:null,generationReady:false};
 const moved=relocatedJob(job,'C:\\out',{oldPath:'C:\\out\\run\\a.png',path:'C:\\out\\starred\\a-2.png'});
 expect(moved.outputs[0]).toEqual({filename:'a-2.png',subfolder:'starred',type:'output'});
 expect(moved.outputs[1]).toBe(job.outputs[1]);
 expect(job.outputs[0].subfolder).toBe('run');expect(moved.intent).toBe(job.intent);
});
it('reports a failed move through the shared native diagnostic without publishing relocation',async()=>{
 invoke.mockImplementation(async(command:string)=>{
  if(command==='native_media_star_status')return {starred:false,unavailable:null};
  if(command==='native_media_star')throw new Error('Move refused');
 });
 const moved=vi.fn();render(<I18nProvider><StarMediaButton item={{name:'a.png',path:'/out/a.png',src:'asset:a',media:'image'}} onMoved={moved}/></I18nProvider>);
 const button=screen.getByRole('button',{name:'Star a.png'});await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));
 fireEvent.click(button);await screen.findByRole('alert');
 expect(invoke).toHaveBeenCalledWith('native_media_star_notice');expect(moved).not.toHaveBeenCalled();
 expect(button.getAttribute('aria-pressed')).toBe('false');
});
it.each(['success','failure'])('late %s from a cannot change b status, errors or its own pending move',async outcome=>{
 const moves=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
 invoke.mockImplementation((command:string,args?:{path:string})=>{
  if(command==='native_media_star_status')return Promise.resolve({starred:false,unavailable:null});
  if(command==='native_media_star')return new Promise((resolve,reject)=>{moves.set(args!.path,{resolve,reject});});
  return Promise.resolve();
 });
 const content=(name:string)=><I18nProvider><StarMediaButton item={{name,path:'/out/'+name,src:'asset:/out/'+name,media:'image'}}/></I18nProvider>;
 const view=render(content('a.png'));
 let button=screen.getByRole('button',{name:'Star a.png'});
 await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));fireEvent.click(button);
 view.rerender(content('b.png'));
 button=screen.getByRole('button',{name:'Star b.png'});
 await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));
 fireEvent.click(button);expect(moves.has('/out/b.png')).toBe(true);
 await act(async()=>{
  if(outcome==='success')moves.get('/out/a.png')!.resolve({oldPath:'/out/a.png',path:'/out/starred/a.png'});
  else moves.get('/out/a.png')!.reject(Error('a failed'));
 });
 expect(button.getAttribute('aria-pressed')).toBe('false');
 expect(button.hasAttribute('disabled')).toBe(true);
 expect(screen.queryByRole('alert')).toBeNull();
 fireEvent.click(button);expect(invoke.mock.calls.filter(([c])=>c==='native_media_star')).toHaveLength(2);
 await act(async()=>moves.get('/out/b.png')!.reject(Error('b failed')));
 expect(screen.getByRole('alert').textContent).toBe('Error: b failed');
 expect(button.hasAttribute('disabled')).toBe(false);
});
it.each(['success','failure'])('late %s from a leaves idle b available and unstarred',async outcome=>{
 let resolve!:(value:unknown)=>void,reject!:(error:Error)=>void;
 invoke.mockImplementation((command:string)=>command==='native_media_star'?new Promise((yes,no)=>{resolve=yes;reject=no;}):Promise.resolve({starred:false,unavailable:null}));
 const content=(name:string)=><I18nProvider><StarMediaButton item={{name,path:'/out/'+name,src:'asset:/out/'+name,media:'image'}}/></I18nProvider>;
 const view=render(content('a.png'));
 await waitFor(()=>expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false));fireEvent.click(screen.getByRole('button'));
 view.rerender(content('b.png'));
 await act(async()=>{if(outcome==='success')resolve({oldPath:'/out/a.png',path:'/out/starred/a.png'});else reject(Error('a failed'));});
 const button=screen.getByRole('button',{name:'Star b.png'});
 expect(button.getAttribute('aria-pressed')).toBe('false');expect(button.hasAttribute('disabled')).toBe(false);expect(screen.queryByRole('alert')).toBeNull();
});
it('explains an unmanaged origin rather than offering a fake favourite',async()=>{
 invoke.mockResolvedValue({starred:false,unavailable:'External/unmanaged media cannot be moved'});
 render(<I18nProvider><StarMediaButton item={{name:'a.mp4',path:'/external/a.mp4',src:'asset:a',media:'video'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button').title).toContain('External/unmanaged'));
 expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
});
