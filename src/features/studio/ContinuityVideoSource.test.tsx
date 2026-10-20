import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { prepareH3Video, uploadInput } from '../../lib/jobs';
import { ContinuityVideoSource } from './ContinuityVideoSource';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn()}));
vi.mock('../../lib/jobs',()=>({prepareH3Video:vi.fn(),uploadInput:vi.fn()}));
vi.mock('../../i18n/I18nProvider',()=>({useI18n:()=>({t:(key:string,params?:Record<string,string|number>)=>key+(params?JSON.stringify(params):'')})}));
beforeEach(()=>{vi.resetAllMocks();vi.mocked(isTauri).mockReturnValue(true);});
afterEach(cleanup);
const receipt={sourceId:'literal_Source-1',filename:'returned/电影 <one>.mp4',sha256:'a'.repeat(64),width:1280,height:720,fps:23.976,seconds:2.75,hasAudio:true};
const mount=()=>{
 const props={endpoint:'http://backend',session:'session-1',running:false,onSelect:vi.fn()};
 const view=render(<ContinuityVideoSource {...props}/>);
 return {...view,props};
};
const filename=()=>screen.getByRole('textbox',{name:'studio.run.cont.videoFilename'}) as HTMLInputElement;
const upload=()=>document.querySelector<HTMLButtonElement>('[data-cont-video-upload]')!;
const prepare=()=>document.querySelector<HTMLButtonElement>('[data-cont-video-prepare]')!;
const useVideo=()=>document.querySelector<HTMLButtonElement>('[data-cont-video-use]')!;
const enter=(value='draft/My VIDEO.mp4')=>fireEvent.change(filename(),{target:{value}});
const clickPrepare=async()=>{await act(async()=>{fireEvent.click(prepare());});};
const deferred=()=>{
 let resolve!:(value:typeof receipt)=>void;let reject!:(error:Error)=>void;
 const promise=new Promise<typeof receipt>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
};

test('local upload fills only the exact returned filename; prepare and Use remain separate',async()=>{
 vi.mocked(invoke).mockResolvedValue('deas-input-Returned 电影.mov');

 vi.mocked(prepareH3Video).mockResolvedValue(receipt);
 const {props}=mount();enter('previous.mp4');
 await act(async()=>fireEvent.click(upload()));
 expect(invoke).toHaveBeenCalledExactlyOnceWith('native_h3_video_upload',{baseUrl:'http://backend'});
 expect(uploadInput).not.toHaveBeenCalled();
 expect(filename().value).toBe('deas-input-Returned 电影.mov');
 expect(prepareH3Video).not.toHaveBeenCalled();expect(props.onSelect).not.toHaveBeenCalled();expect(useVideo().disabled).toBe(true);
 await clickPrepare();expect(prepareH3Video).toHaveBeenCalledExactlyOnceWith('http://backend','deas-input-Returned 电影.mov');
 expect(props.onSelect).not.toHaveBeenCalled();fireEvent.click(useVideo());expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(receipt.sourceId);
});


test.each([false,true])('cancel preserves draft and existing receipt (prepared=%s)',async prepared=>{
 vi.mocked(prepareH3Video).mockResolvedValue(receipt);vi.mocked(invoke).mockResolvedValue(null);
 mount();enter();if(prepared)await clickPrepare();
 await act(async()=>fireEvent.click(upload()));
 expect(filename().value).toBe('draft/My VIDEO.mp4');expect(useVideo().disabled).toBe(!prepared);expect(screen.queryByRole('alert')).toBeNull();
});
test('upload locks all source actions, prevents duplicate requests, and clears the old receipt on success',async()=>{
 vi.mocked(prepareH3Video).mockResolvedValue(receipt);
 let resolve!:(name:string)=>void;vi.mocked(invoke).mockReturnValue(new Promise<string>(yes=>{resolve=yes;}));
 const {props}=mount();enter();await clickPrepare();fireEvent.click(upload());
 expect(filename().disabled).toBe(true);expect(upload().disabled).toBe(true);expect(prepare().disabled).toBe(true);expect(useVideo().disabled).toBe(true);
 enter('forced.mp4');fireEvent.click(upload());fireEvent.click(useVideo());fireEvent.submit(filename().closest('form')!);
 expect(invoke).toHaveBeenCalledTimes(1);expect(prepareH3Video).toHaveBeenCalledTimes(1);expect(props.onSelect).not.toHaveBeenCalled();
 await act(async()=>resolve('returned.mp4'));expect(filename().value).toBe('returned.mp4');expect(useVideo().disabled).toBe(true);expect(screen.queryByRole('status')).toBeNull();
});
test.each(['endpoint','session','running','unmount'] as const)('ignores stale upload success and failure after %s',async change=>{
 for(const outcome of ['success','error']){
  let resolve!:(name:string)=>void;let reject!:(error:Error)=>void;
  vi.mocked(invoke).mockReturnValue(new Promise<string>((yes,no)=>{resolve=yes;reject=no;}));
  const {props,rerender,unmount}=mount();enter();fireEvent.click(upload());
  if(change==='unmount')unmount();else rerender(<ContinuityVideoSource {...props} {...(change==='endpoint'?{endpoint:'http://other'}:change==='session'?{session:'other'}:{running:true})}/>);
  await act(async()=>{if(outcome==='success')resolve('STALE.mp4');else reject(new Error('SECRET'));});
  if(change!=='unmount'){expect(filename().value).toBe('draft/My VIDEO.mp4');expect(screen.queryByRole('alert')).toBeNull();}
  expect(prepareH3Video).not.toHaveBeenCalled();expect(props.onSelect).not.toHaveBeenCalled();cleanup();
 }
});
test('an old upload cannot unlock or overwrite a newer upload after an endpoint change',async()=>{
 let oldResolve!:(name:string)=>void;let freshResolve!:(name:string)=>void;
 vi.mocked(invoke).mockReturnValueOnce(new Promise<string>(yes=>{oldResolve=yes;})).mockReturnValueOnce(new Promise<string>(yes=>{freshResolve=yes;}));
 const {props,rerender}=mount();enter();fireEvent.click(upload());
 rerender(<ContinuityVideoSource {...props} endpoint="http://other"/>);fireEvent.click(upload());
 await act(async()=>oldResolve('STALE.mp4'));expect(upload().disabled).toBe(true);expect(filename().value).toBe('draft/My VIDEO.mp4');
 await act(async()=>freshResolve('fresh.mp4'));expect(upload().disabled).toBe(false);expect(filename().value).toBe('fresh.mp4');expect(prepareH3Video).not.toHaveBeenCalled();
});
test('upload errors use fixed text without retrying or discarding the draft, then clear on explicit retry',async()=>{
 vi.mocked(invoke).mockRejectedValueOnce(new Error('http://secret:password@private/?token=SECRET')).mockResolvedValueOnce(null);
 mount();enter();await act(async()=>fireEvent.click(upload()));
 expect(screen.getByRole('alert').textContent).toBe('studio.run.cont.uploadVideoFailed');expect(filename().value).toBe('draft/My VIDEO.mp4');expect(invoke).toHaveBeenCalledTimes(1);
 await act(async()=>fireEvent.click(upload()));expect(screen.queryByRole('alert')).toBeNull();
});
test.each(['browser','endpoint','running'])('local upload is unavailable without %s capability',async reason=>{
 if(reason==='browser')vi.mocked(isTauri).mockReturnValue(false);
 const {props,rerender}=mount();if(reason==='endpoint')rerender(<ContinuityVideoSource {...props} endpoint={undefined}/>);if(reason==='running')rerender(<ContinuityVideoSource {...props} running/>);
 expect(upload().disabled).toBe(true);await act(async()=>fireEvent.click(upload()));expect(invoke).not.toHaveBeenCalled();
});

test.each([undefined,''])('requires an endpoint (%s)',async endpoint=>{
 const {props,rerender}=mount();rerender(<ContinuityVideoSource {...props} endpoint={endpoint}/>);enter();
 expect(prepare().disabled).toBe(true);await clickPrepare();expect(prepareH3Video).not.toHaveBeenCalled();
});
test('requires native capability',async()=>{
 vi.mocked(isTauri).mockReturnValue(false);mount();enter();
 expect(prepare().disabled).toBe(true);await clickPrepare();expect(prepareH3Video).not.toHaveBeenCalled();
});
test('loading locks all controls and ignores forced editing and duplicate submissions',async()=>{
 const pending=deferred();vi.mocked(prepareH3Video).mockReturnValue(pending.promise);
 const {props}=mount();enter();const draft=filename().value;fireEvent.click(prepare());
 expect(filename().disabled).toBe(true);expect(prepare().disabled).toBe(true);expect(useVideo().disabled).toBe(true);
 expect(prepare().textContent).toBe('studio.run.cont.preparingVideo');
 enter('forced.mp4');fireEvent.submit(filename().closest('form')!);fireEvent.click(useVideo());
 expect(filename().value).toBe(draft);expect(prepareH3Video).toHaveBeenCalledTimes(1);expect(props.onSelect).not.toHaveBeenCalled();
 await act(async()=>pending.resolve(receipt));expect(filename().disabled).toBe(false);expect(useVideo().disabled).toBe(false);
});
test('running locks all controls without preparing, editing or selecting',async()=>{
 const {props,rerender}=mount();enter();const draft=filename().value;
 rerender(<ContinuityVideoSource {...props} running/>);
 expect(filename().disabled).toBe(true);expect(prepare().disabled).toBe(true);expect(useVideo().disabled).toBe(true);
 enter('forced.mp4');await act(async()=>fireEvent.submit(filename().closest('form')!));fireEvent.click(useVideo());
 expect(filename().value).toBe(draft);expect(prepareH3Video).not.toHaveBeenCalled();expect(props.onSelect).not.toHaveBeenCalled();
});
test('changing the filename invalidates the receipt even if changed back',async()=>{
 vi.mocked(prepareH3Video).mockResolvedValue(receipt);const {props}=mount();enter();await clickPrepare();
 enter('changed.mp4');expect(screen.queryByRole('status')).toBeNull();expect(useVideo().disabled).toBe(true);
 enter();fireEvent.click(useVideo());expect(props.onSelect).not.toHaveBeenCalled();expect(prepareH3Video).toHaveBeenCalledTimes(1);
});
test.each(['session','endpoint','running'] as const)('invalidates an already prepared receipt on %s changes',async change=>{
 vi.mocked(prepareH3Video).mockResolvedValue(receipt);const {props,rerender}=mount();enter();await clickPrepare();
 const next={...props,...(change==='session'?{session:'other'}:change==='endpoint'?{endpoint:'http://other'}:{running:true})};
 rerender(<ContinuityVideoSource {...next}/>);rerender(<ContinuityVideoSource {...props}/>);
 expect(screen.queryByRole('status')).toBeNull();expect(useVideo().disabled).toBe(true);fireEvent.click(useVideo());
 expect(props.onSelect).not.toHaveBeenCalled();expect(prepareH3Video).toHaveBeenCalledTimes(1);
});
test.each(['session','endpoint','running'] as const)('ignores stale success on %s changes without unlocking a newer prepare',async change=>{
 const old=deferred(),fresh=deferred();vi.mocked(prepareH3Video).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
 const {props,rerender}=mount();enter();fireEvent.click(prepare());
 const next={...props,...(change==='session'?{session:'other'}:change==='endpoint'?{endpoint:'http://other'}:{running:true})};
 rerender(<ContinuityVideoSource {...next}/>);
 if(change==='running')rerender(<ContinuityVideoSource {...next} running={false}/>);
 expect(prepareH3Video).toHaveBeenCalledTimes(1);enter('fresh.mp4');fireEvent.click(prepare());
 const inspect=vi.fn();await act(async()=>old.resolve({...receipt,get filename(){inspect();return 'STALE';}}));
 expect(inspect).not.toHaveBeenCalled();expect(prepare().disabled).toBe(true);expect(useVideo().disabled).toBe(true);
 expect(screen.queryByRole('status')).toBeNull();expect(props.onSelect).not.toHaveBeenCalled();
 await act(async()=>fresh.resolve({...receipt,sourceId:'fresh-source',filename:'fresh-returned.mp4'}));
 expect(useVideo().disabled).toBe(false);expect(props.onSelect).not.toHaveBeenCalled();
 fireEvent.click(useVideo());expect(props.onSelect).toHaveBeenCalledExactlyOnceWith('fresh-source');
});
test.each(['session','endpoint','running'] as const)('ignores stale rejection on %s changes after newer success',async change=>{
 const old=deferred();vi.mocked(prepareH3Video).mockReturnValueOnce(old.promise).mockResolvedValueOnce(receipt);
 const {props,rerender}=mount();enter();fireEvent.click(prepare());
 const next={...props,...(change==='session'?{session:'other'}:change==='endpoint'?{endpoint:'http://other'}:{running:true})};
 rerender(<ContinuityVideoSource {...next}/>);
 if(change==='running')rerender(<ContinuityVideoSource {...next} running={false}/>);
 await clickPrepare();await act(async()=>old.reject(new Error('stale SECRET')));
 expect(screen.queryByRole('alert')).toBeNull();expect(useVideo().disabled).toBe(false);expect(props.onSelect).not.toHaveBeenCalled();
});
test.each(['success','error'])('unmount ignores pending %s without inspecting or selecting',async outcome=>{
 const pending=deferred();vi.mocked(prepareH3Video).mockReturnValue(pending.promise);
 const {props,unmount}=mount();enter();fireEvent.click(prepare());unmount();const inspect=vi.fn();
 await act(async()=>{if(outcome==='success')pending.resolve({...receipt,get filename(){inspect();return 'STALE';}});else pending.reject(new Error('SECRET'));});
 expect(inspect).not.toHaveBeenCalled();expect(props.onSelect).not.toHaveBeenCalled();
});
test('errors show only fixed text, never retry automatically, and clear on a new explicit request',async()=>{
 vi.mocked(prepareH3Video).mockResolvedValueOnce(receipt).mockRejectedValueOnce(new Error('http://secret:password@private/?token=TOPSECRET')).mockResolvedValueOnce(receipt);
 const {props}=mount();enter();await clickPrepare();await clickPrepare();
 expect(screen.getByRole('alert').textContent).toBe('studio.run.cont.videoFailed');expect(screen.queryByRole('status')).toBeNull();
 expect(useVideo().disabled).toBe(true);expect(prepare().disabled).toBe(false);expect(filename().disabled).toBe(false);
 expect(prepareH3Video).toHaveBeenCalledTimes(2);expect(props.onSelect).not.toHaveBeenCalled();
 await clickPrepare();expect(screen.queryByRole('alert')).toBeNull();expect(useVideo().disabled).toBe(false);
});

test.each(['','/absolute.mp4','C:/clip.mp4','https://host/clip.mp4','a\\b.mp4','a//b.mp4','a/','./a.mp4','a/../b.mp4','a/./b.mp4','a\tb.mp4','a\u0000.mp4','a\u007f.mp4','a\u0085.mp4','a.mp4 [output]','a.mp4 [temp]','a'.repeat(4097)])('rejects invalid filenames without a request (%j)',async value=>{
 mount();enter(value);expect(prepare().disabled).toBe(true);
 await act(async()=>fireEvent.submit(filename().closest('form')!));
 expect(prepareH3Video).not.toHaveBeenCalled();expect(useVideo().disabled).toBe(true);
});

test.each(['a.mp4','nested/电影.mp4',' input.mp4 ','a'.repeat(4096)])('passes valid filenames literally (%s)',async value=>{
 vi.mocked(prepareH3Video).mockResolvedValue({...receipt,hasAudio:false});mount();enter(value);
 expect(prepare().disabled).toBe(false);await clickPrepare();
 expect(prepareH3Video).toHaveBeenCalledExactlyOnceWith('http://backend',value);
 expect(screen.getByRole('status').textContent).toContain('studio.run.cont.videoSilent');
});

test.each(['click','enter'])('prepares only on explicit %s with the exact draft and requires a second confirmation',async method=>{
 vi.mocked(prepareH3Video).mockResolvedValue(receipt);
 const {props,container}=mount();
 expect(prepareH3Video).not.toHaveBeenCalled();expect(useVideo().disabled).toBe(true);
 expect(filename().hasAttribute('data-cont-video-filename')).toBe(true);
 expect(container.querySelector('input[type="file"],video,audio,img,iframe')).toBeNull();
 const literal='folder/ MiXeD 电影 <draft>.MP4 ';
 enter(literal);expect(prepareH3Video).not.toHaveBeenCalled();
 await act(async()=>{if(method==='click')fireEvent.click(prepare());else fireEvent.submit(filename().closest('form')!);});
 expect(prepareH3Video).toHaveBeenCalledExactlyOnceWith('http://backend',literal);
 expect(filename().value).toBe(literal);
 expect(screen.getByRole('status').textContent).toBe('studio.run.cont.videoReady'+JSON.stringify({name:receipt.filename,width:1280,height:720,seconds:2.75})+ ' studio.run.cont.videoHasAudio');
 expect(container.textContent).not.toContain(receipt.sha256);expect(container.textContent).not.toContain('23.976');
 expect(props.onSelect).not.toHaveBeenCalled();expect(useVideo().disabled).toBe(false);
 fireEvent.click(useVideo());expect(props.onSelect).toHaveBeenCalledExactlyOnceWith('literal_Source-1');
});
