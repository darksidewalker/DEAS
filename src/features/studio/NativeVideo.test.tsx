import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { createRef } from 'react';
import { NativeVideo, nativeVideo, type NativeVideoControl } from './NativeVideo';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn(()=>true)}));
const state={position:1,duration:5,width:768,height:992,paused:true,muted:false,volume:100};
beforeEach(()=>{
 localStorage.setItem('deas.locale.v1','en');
 vi.mocked(invoke).mockImplementation(async(cmd,args)=>cmd==='native_video_update'&&(args as {action:{kind:string}}).action.kind==='status'?state:undefined);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.clearAllMocks();});
const view=(path='/clip.webm',active=true)=><I18nProvider><NativeVideo source={{path}} label="Clip" active={active}/></I18nProvider>;
test('localized accessible typed controls and cleanup',async()=>{
 const ui=render(view());
 await waitFor(()=>expect(screen.getByRole('slider',{name:'Seek video'}).getAttribute('max')).toBe('5'));
 fireEvent.click(screen.getByRole('button',{name:'Play'}));
 // Clicking the picture toggles like the Play button.
 fireEvent.click(ui.container.querySelector('.native-video-surface')!);
 expect(vi.mocked(invoke).mock.calls.filter(([c,a])=>c==='native_video_update'&&(a as {action:{kind:string}}).action.kind==='pause')).toHaveLength(2);
 fireEvent.change(screen.getByRole('slider',{name:'Seek video'}),{target:{value:'2'}});
 fireEvent.click(screen.getByRole('button',{name:'Mute'}));
 fireEvent.change(screen.getByRole('slider',{name:'Video volume'}),{target:{value:'25'}});
 const actions=vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_video_update').map(([,a])=>(a as {action:object}).action);
 expect(actions).toContainEqual({kind:'pause',paused:false});expect(actions).toContainEqual({kind:'seek',seconds:2});
 expect(actions).toContainEqual({kind:'mute',muted:true});expect(actions).toContainEqual({kind:'volume',volume:25});
 ui.unmount();expect(invoke).toHaveBeenCalledWith('native_video_update',expect.objectContaining({action:{kind:'close'}}));
});
test('timeline and volume fill follow native status, including both endpoints',async()=>{
 let current={...state,position:65,duration:125,volume:25};
 vi.mocked(invoke).mockImplementation(async(cmd,args)=>cmd==='native_video_update'&&(args as {action:{kind:string}}).action.kind==='status'?current:undefined);
 const ui=render(view());
 const seek=screen.getByRole('slider',{name:'Seek video'}),volume=screen.getByRole('slider',{name:'Video volume'});
 await waitFor(()=>expect(screen.getByText('1:05 / 2:05')).toBeTruthy());
 expect((seek as HTMLElement).style.getPropertyValue('--progress')).toBe(`${65/125*100}%`);
 expect((volume as HTMLElement).style.getPropertyValue('--progress')).toBe('25%');
 expect(screen.getByText('25%')).toBeTruthy();
 expect(seek.getAttribute('aria-valuetext')).toBe('1:05 / 2:05');
 for(const end of [0,100]){
  current={...current,position:125*end/100,volume:end};
  await act(async()=>{window.dispatchEvent(new Event('resize'));});
  await waitFor(()=>expect((seek as HTMLElement).style.getPropertyValue('--progress')).toBe(`${end}%`));
  expect((volume as HTMLElement).style.getPropertyValue('--progress')).toBe(`${end}%`);
  expect(screen.getByText(`${end}%`)).toBeTruthy();
 }
 current={...current,position:0,duration:0};
 await act(async()=>{window.dispatchEvent(new Event('resize'));});
 await waitFor(()=>expect(screen.getByText('0:00 / 0:00')).toBeTruthy());
 expect((seek as HTMLInputElement).disabled).toBe(true);
 expect((seek as HTMLElement).style.getPropertyValue('--progress')).toBe('0%');
 ui.unmount();
});
test('late open completion closes only its old UUID after replacement',async()=>{
 let finish!:()=>void;
 vi.mocked(invoke).mockImplementation(async(cmd,args)=>{
  if(cmd==='native_video_open'&&(args as {source:{path:string}}).source.path==='/old.webm')await new Promise<void>(r=>{finish=r;});
  if(cmd==='native_video_update'&&(args as {action:{kind:string}}).action.kind==='status')return state;
 });
 const ui=render(view('/old.webm'));const old=(vi.mocked(invoke).mock.calls[0][1] as {id:string}).id;
 ui.rerender(view('/new.webm'));
 await waitFor(()=>expect(screen.getByRole('slider',{name:'Seek video'}).getAttribute('max')).toBe('5'));
 await act(async()=>finish());
 expect(invoke).toHaveBeenCalledWith('native_video_update',{id:old,action:{kind:'close'}});
 expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_video_open')).toHaveLength(2);
});
test('optional status and transport refs expose native actions and clean up',async()=>{
 const onStatus=vi.fn(),controlRef=createRef<NativeVideoControl>();
 const ui=render(<I18nProvider><NativeVideo source={{path:'/clip.webm'}} label="Clip" onStatus={onStatus} controlRef={controlRef}/></I18nProvider>);
 await waitFor(()=>expect(onStatus).toHaveBeenCalledWith(state));
 act(()=>{controlRef.current!.seek(2);controlRef.current!.pause();controlRef.current!.play();controlRef.current!.playCrop(1,3);});
 for(const action of [{kind:'seek',seconds:2},{kind:'pause',paused:true},{kind:'pause',paused:false},{kind:'crop',start:1,end:3}])expect(invoke).toHaveBeenCalledWith('native_video_update',expect.objectContaining({action}));
 ui.unmount();expect(controlRef.current).toBeNull();
});
test('control failures are reported through status without losing the visible error',async()=>{
 const onStatus=vi.fn(),controlRef=createRef<NativeVideoControl>();
 render(<I18nProvider><NativeVideo source={{path:'/clip.webm'}} label="Clip" onStatus={onStatus} controlRef={controlRef}/></I18nProvider>);
 await waitFor(()=>expect(onStatus).toHaveBeenCalledWith(state));
 vi.mocked(invoke).mockRejectedValueOnce('crop failed');
 act(()=>controlRef.current!.playCrop(1,3));
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Video playback unavailable. crop failed');
 await waitFor(()=>expect(onStatus).toHaveBeenCalledWith({...state,error:'crop failed'}));
});
test('forced mute cannot be overridden and audio-only keeps visible transport bounds',async()=>{
 const onStatus=vi.fn();
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:10,top:10,right:210,bottom:50,width:200,height:40,x:10,y:10,toJSON:()=>({})});
 Object.defineProperty(document,'elementFromPoint',{configurable:true,value:vi.fn(()=>screen.getByRole('slider',{name:'Seek video'}))});
 const ui=render(<I18nProvider><NativeVideo source={{path:'/clip.webm'}} label="Clip" muted audioOnly onStatus={onStatus}/></I18nProvider>);
 await waitFor(()=>expect(onStatus).toHaveBeenCalledWith({...state,muted:true}));
 expect((screen.getByRole('button',{name:'Unmute'}) as HTMLButtonElement).disabled).toBe(true);
 expect(invoke).toHaveBeenCalledWith('native_video_open',expect.objectContaining({muted:true}));
 expect(document.querySelector<HTMLElement>('.native-video-surface')!.style.display).toBe('none');
 expect(invoke).toHaveBeenCalledWith('native_video_update',expect.objectContaining({action:expect.objectContaining({kind:'bounds',visible:true,audioOnly:true})}));
 expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({muted:true}));
 fireEvent.click(screen.getByRole('button',{name:'Unmute'}));
 expect(invoke).not.toHaveBeenCalledWith('native_video_update',expect.objectContaining({action:{kind:'mute',muted:false}}));
 ui.rerender(<I18nProvider><NativeVideo source={{path:'/clip.webm'}} label="Clip" muted={false} audioOnly/></I18nProvider>);
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_video_update',expect.objectContaining({action:{kind:'mute',muted:false}})));
 expect(vi.mocked(invoke).mock.calls.filter(([cmd])=>cmd==='native_video_open')).toHaveLength(1);
});
test('own modal is allowed while background or occluded native surfaces stay hidden',async()=>{
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:10,top:10,right:210,bottom:110,width:200,height:100,x:10,y:10,toJSON:()=>({})});
 const hit=vi.fn(()=>document.querySelector('.native-video-surface'));
 Object.defineProperty(document,'elementFromPoint',{configurable:true,value:hit});
 const ui=render(<I18nProvider><div role="dialog" aria-modal="true"><NativeVideo source={{path:'/clip.webm'}} label="Clip"/></div></I18nProvider>);
 const bounds=(visible:boolean)=>expect(invoke).toHaveBeenCalledWith('native_video_update',expect.objectContaining({action:expect.objectContaining({kind:'bounds',visible})}));
 await waitFor(()=>bounds(true));
 vi.mocked(invoke).mockClear();
 const covering=document.createElement('dialog');covering.open=true;document.body.append(covering);
 await waitFor(()=>bounds(false));
 covering.remove();await waitFor(()=>bounds(true));
 vi.mocked(invoke).mockClear();hit.mockReturnValue(document.body);
 await act(async()=>{window.dispatchEvent(new Event('resize'));});await waitFor(()=>bounds(false));
 ui.unmount();
});
test('inactive preview does not open; failures remain visible',async()=>{
 const ui=render(view('/clip.webm',false));expect(invoke).not.toHaveBeenCalled();
 vi.mocked(invoke).mockRejectedValueOnce('Install libmpv.so.2');ui.rerender(view());
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Video playback unavailable. Install libmpv.so.2');
 expect((screen.getByRole('button',{name:'Play'}) as HTMLButtonElement).disabled).toBe(true);
});
test('native path is Linux-only, never selected for browser or Windows',()=>{
 vi.spyOn(navigator,'userAgent','get').mockReturnValue('Windows');expect(nativeVideo()).toBe(false);
 vi.spyOn(navigator,'userAgent','get').mockReturnValue('Linux');vi.mocked(isTauri).mockReturnValue(false);expect(nativeVideo()).toBe(false);
 vi.mocked(isTauri).mockReturnValue(true);expect(nativeVideo()).toBe(true);
});
