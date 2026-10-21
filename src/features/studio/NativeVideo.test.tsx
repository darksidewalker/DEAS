import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { NativeVideo, nativeVideo } from './NativeVideo';
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
 fireEvent.change(screen.getByRole('slider',{name:'Seek video'}),{target:{value:'2'}});
 fireEvent.click(screen.getByRole('button',{name:'Mute'}));
 fireEvent.change(screen.getByRole('slider',{name:'Video volume'}),{target:{value:'25'}});
 const actions=vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_video_update').map(([,a])=>(a as {action:object}).action);
 expect(actions).toContainEqual({kind:'pause',paused:false});expect(actions).toContainEqual({kind:'seek',seconds:2});
 expect(actions).toContainEqual({kind:'mute',muted:true});expect(actions).toContainEqual({kind:'volume',volume:25});
 ui.unmount();expect(invoke).toHaveBeenCalledWith('native_video_update',expect.objectContaining({action:{kind:'close'}}));
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
