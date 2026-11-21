import { adopt, choosePipe, collection, dock, evidence, faceAnalysisFixture, faceField, h3VideoFiles, heldJob, ltxModels, mediaEntries, music, musicEvidence, openHistoryRecord, pipe, recentHistoryRecord, videoEvidence, videoSam, yue2Models } from './Workbench.testHarness';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { Workbench } from './Workbench';
import { defaultOptions } from './OptionsPanel';
import { defaultTve } from './TvePostControls';
import { regenerateSize, type H3LatentUpscale, type H3RegenerateUpscale } from '../../lib/videoIntent';
import { sam3VideoNodes, type Sam3VideoMaskIntentV1 } from '../../lib/sam3';
import { applyStudioSettings, captureStudioSettings, resetStudioPreferences } from '../../lib/preferences';
import type { LocalModel } from '../../lib/models';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels, writeModelFamily } from '../../lib/models';
import { autoRefine, waitForWorkbenchJob, stopWorkbench, runWorkbenchJob, readCurrentWorkbench, pollWorkbench, uploadMask, uploadInput, prepareH3Video, loadDiagnosticJobOutput, type JobStatus } from '../../lib/jobs';

test.each([false,true])('H3 face analysis is explicit, snapshots source/settings/endpoint before upload and previews its shared queue output (cuts=%s)',async cuts=>{
 const {view,sourceJob}=await faceAnalysisFixture();
 expect(faceField('cuts').checked).toBe(false);expect(faceField('sceneThreshold').disabled).toBe(true);
 if(cuts){fireEvent.click(faceField('cuts'));fireEvent.change(faceField('sceneThreshold'),{target:{value:'0.4'}});}
 const button=screen.getByRole('button',{name:'Analyze face masks'});
 await waitFor(()=>expect(button).toHaveProperty('disabled',false));
 expect(faceField('durationSeconds').value).toBe('2');expect(faceField('maxObjects').value).toBe('4');expect(faceField('detectInterval').value).toBe('1');
 fireEvent.change(faceField('startSeconds'),{target:{value:'1.5'}});fireEvent.change(faceField('durationSeconds'),{target:{value:'1.25'}});
 expect(document.querySelector('[data-sam-video="source"]')!.textContent).toContain('shown.mp4');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();expect(autoRefine).not.toHaveBeenCalled();
 expect(document.querySelector('.wb-post [data-sam="refine"]')).toBeNull();
 let finishUpload!:(value:string)=>void;
 vi.mocked(uploadInput).mockReturnValueOnce(new Promise(resolve=>{finishUpload=resolve;}));
 const analysisIntent:Sam3VideoMaskIntentV1={recipeId:'sam3-video-mask',version:1,checkpoint:videoSam,sourceVideo:'uploaded.mp4',outputPrefix:'DEAS/SAM3/face-mask',threshold:0.5,maxObjects:4,detectInterval:1,startSeconds:1.5,durationSeconds:1.25,...(cuts?{sceneThreshold:0.4}:{})};
 const result={...heldJob('face-masks','succeeded',evidence.baseUrl),intent:analysisIntent,outputRoot:'/out',outputs:[{filename:'face-masks.mp4',subfolder:'analysis',type:'output' as const,format:'video/mp4',role:'mask-preview' as const}]};
 vi.mocked(runWorkbenchJob).mockResolvedValueOnce(result);
 fireEvent.click(button);
 await waitFor(()=>expect(uploadInput).toHaveBeenCalledWith(evidence.baseUrl,'/out/clips/shown.mp4'));
 if(cuts)fireEvent.change(faceField('sceneThreshold'),{target:{value:'0.9'}});
 fireEvent.click(faceField('cuts'));if(!cuts)fireEvent.change(faceField('sceneThreshold'),{target:{value:'0.9'}});
 fireEvent.click(document.querySelector('[data-job-id="other-video"] .wb-queue-select')!);
 expect(document.querySelector('[data-sam-video="source"]')!.textContent).toContain('other.mp4');
 fireEvent.change(faceField('durationSeconds'),{target:{value:'8'}});fireEvent.change(faceField('maxObjects'),{target:{value:'12'}});fireEvent.change(faceField('threshold'),{target:{value:'0.8'}});fireEvent.change(faceField('checkpoint'),{target:{value:'SAM3/sam3.1_other.safetensors'}});
 view.rerender(<I18nProvider><Workbench endpoint="http://127.0.0.1:9999/" roots={{models:'/m',output:'/out',input:'/in'}}/></I18nProvider>);
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([sourceJob,result]));
 await act(async()=>finishUpload('uploaded.mp4'));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledExactlyOnceWith(evidence.baseUrl,analysisIntent,0));
 await waitFor(()=>expect(document.querySelector('[data-job-id="face-masks"]')).not.toBeNull());
 expect(document.querySelector('.wb-shown video')?.getAttribute('src')).toContain('face-masks.mp4');
 expect(document.querySelector('[data-job-id="face-masks"]')?.textContent).toContain('Mask preview');
 expect(document.querySelector('.wb-output-choices')).toBeNull();
 expect(document.querySelector<HTMLButtonElement>('[data-more-apply]')?.disabled).toBe(true);
 expect(document.querySelector<HTMLButtonElement>('[data-more-reuse]')?.disabled).toBe(true);
 expect(autoRefine).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();
});

test.each([undefined,false,true])('H3 hard-cut preference defaults OFF and persists explicit ON/OFF (%s)',async saved=>{
 if(saved!==undefined)localStorage.setItem('deas.pref.studio.run.samVideoCuts',JSON.stringify(saved));
 const {view}=await faceAnalysisFixture();
 expect(faceField('cuts').checked).toBe(saved??false);expect(faceField('sceneThreshold').value).toBe('0.3');
 fireEvent.click(faceField('cuts'));fireEvent.change(faceField('sceneThreshold'),{target:{value:'0.45'}});
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
 view.unmount();const next=await faceAnalysisFixture();
 expect(faceField('cuts').checked).toBe(!(saved??false));expect(faceField('sceneThreshold').value).toBe('0.45');
 fireEvent.click(faceField('cuts'));next.view.unmount();await faceAnalysisFixture();
 expect(faceField('cuts').checked).toBe(saved??false);
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('H3 missing optional shot adapter blocks only hard-cut analysis',async()=>{
 await faceAnalysisFixture('DEAS_SAM3ShotMask');const button=screen.getByRole('button',{name:'Analyze face masks'});
 await waitFor(()=>expect(button).toHaveProperty('disabled',false));
 fireEvent.click(faceField('cuts'));expect(button).toHaveProperty('disabled',true);
 expect(within(screen.getByRole('group',{name:'H3 Face-Refiner'})).getByRole('status').textContent).toContain('DEAS_SAM3ShotMask');fireEvent.click(button);
 fireEvent.click(faceField('cuts'));expect(button).toHaveProperty('disabled',false);
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['0','-0.1','1.01',''])('H3 hard-cut analysis rejects invalid frame difference %s before upload',async value=>{
 await faceAnalysisFixture();const button=screen.getByRole('button',{name:'Analyze face masks'});
 await waitFor(()=>expect(button).toHaveProperty('disabled',false));fireEvent.click(faceField('cuts'));
 fireEvent.change(faceField('sceneThreshold'),{target:{value}});expect(button).toHaveProperty('disabled',true);fireEvent.click(button);
 expect(within(screen.getByRole('group',{name:'H3 Face-Refiner'})).getByRole('status').textContent).toContain('frame-difference threshold > 0');
 fireEvent.click(faceField('cuts'));expect(button).toHaveProperty('disabled',false);
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each([...sam3VideoNodes,'checkpoint','none','rootless'] as const)('H3 face analysis blocks missing prerequisite %s before uploading',async missing=>{
 await faceAnalysisFixture(missing,missing==='none'?'none':missing==='rootless'?'rootless':'queue');
 const button=screen.getByRole('button',{name:'Analyze face masks'});
 expect(button).toHaveProperty('disabled',true);fireEvent.click(button);
 const group=screen.getByRole('group',{name:'H3 Face-Refiner'});
 expect(group.textContent).toContain(missing==='DEAS_SAM3VideoWindow'?'Restart or update':missing==='checkpoint'?'checkpoint':missing==='rootless'?'local video path':missing==='none'?'Select a video':missing);
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();expect(autoRefine).not.toHaveBeenCalled();
});

test.each([['maxObjects','0'],['maxObjects','65'],['maxObjects','1.5'],['detectInterval','0'],['detectInterval','1.5'],['detectInterval','2147483648'],['durationSeconds','0'],['durationSeconds',''],['startSeconds','-1'],['threshold','1.1']] as const)('H3 face analysis rejects invalid %s=%s without uploading',async(key,value)=>{
 await faceAnalysisFixture();
 await waitFor(()=>expect(screen.getByRole('button',{name:'Analyze face masks'})).toHaveProperty('disabled',false));
 fireEvent.change(faceField(key),{target:{value}});
 const button=screen.getByRole('button',{name:'Analyze face masks'});expect(button).toHaveProperty('disabled',true);fireEvent.click(button);
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each([false,true])('H3 face analysis prefers the browsed video / current input (%s) over a selected queue row',async adopted=>{
 const previous=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_media_list'?{path:'/out',parent:'/',entries:[{name:'browsed.mov',path:'/out/browsed.mov',kind:'file',media:'video',symlink:false,size:1,modified:1}],truncated:false}:previous(command,args));
 try{
  await faceAnalysisFixture();dock('Media');fireEvent.click(await screen.findByRole('button',{name:'browsed.mov'}));
  if(adopted)adopt();
  dock('Post-Processing');
  expect(document.querySelector('[data-sam-video="source"]')!.textContent).toContain('browsed.mov');
  expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
  vi.mocked(uploadInput).mockResolvedValueOnce('browsed-upload.mov');vi.mocked(runWorkbenchJob).mockResolvedValueOnce({...heldJob('analysis','failed'),error:'fixture'});
  fireEvent.click(screen.getByRole('button',{name:'Analyze face masks'}));
  await waitFor(()=>expect(uploadInput).toHaveBeenCalledExactlyOnceWith(evidence.baseUrl,'/out/browsed.mov'));
  await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledOnce());
  expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({recipeId:'sam3-video-mask',sourceVideo:'browsed-upload.mov',checkpoint:videoSam});
  expect(autoRefine).not.toHaveBeenCalled();
 }finally{vi.mocked(invoke).mockImplementation(previous);}
});

test('H3 face analysis requires an explicit endpoint and never executes on a missing backend',async()=>{
 const {view}=await faceAnalysisFixture();
 view.rerender(<I18nProvider><Workbench endpoint="" roots={{models:'/m',output:'/out',input:'/in'}}/></I18nProvider>);
 expect(screen.getByRole('button',{name:'Analyze face masks'})).toHaveProperty('disabled',true);
 expect(screen.getByRole('group',{name:'H3 Face-Refiner'}).textContent).toContain('Select an owned backend endpoint');
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('H3 face analysis Stop fences a pending source upload',async()=>{
 await faceAnalysisFixture();
 let resolve!:(value:string)=>void;vi.mocked(uploadInput).mockReturnValueOnce(new Promise(done=>{resolve=done;}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Analyze face masks'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('button',{name:'Analyze face masks'}));await waitFor(()=>expect(uploadInput).toHaveBeenCalledOnce());
 fireEvent.click(screen.getByRole('button',{name:'Stop'}));
 await waitFor(()=>expect(stopWorkbench).toHaveBeenCalledOnce());
 await act(async()=>resolve('uploaded.mp4'));
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(autoRefine).not.toHaveBeenCalled();
});

test('SAM refinement defaults off, preserves saved OFF/ON and uses an explicit checkpoint',async()=>{
 const sam='SAM3/sam3.1_multiplex_fp16.safetensors';
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'SAM3_Detect'],checkpoints:[...evidence.allowlist.checkpoints,sam]}});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',family:'sdxl',size:1,info:null}]);
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 const enabled=await waitFor(()=>{const el=document.querySelector<HTMLInputElement>('[data-sam="enabled"]');expect(el).not.toBeNull();return el!;});
 expect(enabled.checked).toBe(false);
 expect(document.querySelector<HTMLInputElement>('[data-sam="denoise"]')!.value).toBe('0.25');
 expect(document.querySelector<HTMLInputElement>('[data-sam="margin"]')!.value).toBe('32');
 await waitFor(()=>expect(document.querySelector<HTMLSelectElement>('[data-sam="model"]')!.options.length).toBe(2));
 await waitFor(()=>expect(document.querySelector<HTMLSelectElement>('[data-sam="model"]')!.value).toBe(sam));
 fireEvent.click(enabled);expect(enabled.checked).toBe(true);
 expect(autoRefine).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
 view.unmount();render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 expect(document.querySelector<HTMLInputElement>('[data-sam="enabled"]')!.checked).toBe(true);
 fireEvent.click(document.querySelector('[data-sam="enabled"]')!);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.samEnabled')!)).toBe(false);
});

test.each(['missing','', 'SAM3/sam3.1_z.safetensors'])('SAM checkpoint fallback preserves an available saved choice (%s)',async(saved)=>{
 const first='SAM3/sam3.1_a.safetensors',last='SAM3/sam3.1_z.safetensors';
 localStorage.setItem('deas.pref.studio.run.samCheckpoint',JSON.stringify(saved));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,checkpoints:[...evidence.allowlist.checkpoints,last,first]}});
 vi.mocked(scanModels).mockResolvedValue([]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl}/></I18nProvider>);
 dock('Post-Processing');
 await waitFor(()=>expect(document.querySelector<HTMLSelectElement>('.wb-post [data-sam="model"]')!.value).toBe(saved===last?last:first));
 expect(autoRefine).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();
});

test('explicit model Reload discovers and auto-selects a newly installed SAM checkpoint',async()=>{
 const sam='SAM3/sam3.1_new.safetensors';
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',family:'sdxl',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 dock('Post-Processing');
 await waitFor(()=>expect(document.querySelector<HTMLSelectElement>('[data-sam="model"]')!.value).toBe(''));
 await waitFor(()=>expect(scanModels).toHaveBeenCalled());
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'SAM3_Detect'],checkpoints:[...evidence.allowlist.checkpoints,sam]}});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:sam,path:'/m/'+sam,family:'sam3',size:1,info:null}]);
 dock('Models');fireEvent.click(document.querySelector('[data-run-load]')!);
 dock('Post-Processing');
 await waitFor(()=>expect(document.querySelector<HTMLSelectElement>('[data-sam="model"]')!.value).toBe(sam));
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(autoRefine).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();
});

test.each([['point',false],['point',true],['box',false],['target',false]] as const)('SAM %s masks only the current editor source and preserves queue selection (preview %s)',async(kind,preview)=>{
 const sam='SAM3/sam3.1.safetensors',png=new Uint8Array([137,80,78,71,13,10,26,10]);
 for(const [key,value] of Object.entries({samEnabled:true,samTargets:''}))localStorage.setItem('deas.pref.studio.run.'+key,JSON.stringify(value));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'SAM3_Detect'],checkpoints:[...evidence.allowlist.checkpoints,sam]}});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',family:'sdxl',size:1,info:null}]);
 const old={...heldJob('latest','succeeded'),outputRoot:'/out',outputs:[{filename:'latest.png',subfolder:'',type:'output' as const}]};
 let submitted:JobStatus|undefined;
 vi.mocked(readCurrentWorkbench).mockImplementation(async()=>collection(submitted?[old,submitted]:[old]));
 vi.mocked(pollWorkbench).mockImplementation(async()=>collection(submitted?[old,submitted]:[old]));
 vi.mocked(runWorkbenchJob).mockImplementation(async(_url,intent)=>submitted={...heldJob('sam-only','succeeded'),intent,outputs:[{filename:'mask.png',subfolder:'',type:'output'}]});
 vi.mocked(waitForWorkbenchJob).mockImplementation(async job=>job);
 vi.mocked(loadDiagnosticJobOutput).mockResolvedValue({jobId:'sam-only',index:0,bytes:Array.from(png),mimeType:'image/png',width:1024,height:640,sha256:'fixture'});
 vi.mocked(uploadMask).mockResolvedValue('current-source.png');
 vi.mocked(invoke).mockImplementation(async command=>command==='native_media_star_status'?{starred:false,unavailable:null}:{path:'/out',parent:'/',entries:[{name:'source.png',path:'/out/source.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false});
 const fetchSource=vi.fn(async()=>({ok:true,blob:async()=>new Blob()}));vi.stubGlobal('fetch',fetchSource);
 vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1024,height:640,close:vi.fn()})));
 vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(function(done){done({arrayBuffer:async()=>png.buffer} as Blob);});
 vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({save:vi.fn(),restore:vi.fn(),clearRect:vi.fn(),drawImage:vi.fn(),fillRect:vi.fn(),putImageData:vi.fn(),getImageData:()=>({data:new Uint8ClampedArray([255,255,255,255])})} as unknown as CanvasRenderingContext2D);
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 await screen.findByRole('button',{name:'source.png'});fireEvent.click(screen.getByRole('button',{name:'source.png'}));adopt();
 const source=screen.getByRole('img',{name:'source.png'});Object.defineProperties(source,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(source);
 fireEvent.click(document.querySelector('[data-edit="inpaint"]')!);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-sam-tool="samPoint"]')!.disabled).toBe(false));
 expect(document.querySelector('.wb-side [data-sam-controls]')).toBeNull();
 expect(within(document.querySelector('.wb-side')!).queryByRole('button',{name:'Post-Processing'})).toBeNull();
 expect(document.querySelector('.wb-side [data-sam="mask"]')).toBeNull();
 dock('Post-Processing');
 fireEvent.click(document.querySelector('[data-post-card="sam"]')!);
 const target=document.querySelector<HTMLInputElement>('.wb-post [data-sam="targets"]')!;
 expect(document.querySelector('[data-dock-tab="post"]')?.getAttribute('aria-selected')).toBe('true');
 expect(document.querySelector('.wb-post [data-sam="mask"]')).toHaveProperty('disabled',true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();expect(autoRefine).not.toHaveBeenCalled();
 fireEvent.change(target,{target:{value:'eyes'}});
 expect(document.querySelector('.wb-post [data-sam-controls]')).not.toBeNull();
 if(preview)fireEvent.click(document.querySelector('[data-job-id="latest"] .wb-queue-select')!);
 const selected=()=>[...document.querySelectorAll('.wb-queue-select[aria-current="true"]')].map(el=>el.closest('[data-job-id]')!.getAttribute('data-job-id'));
 const before=selected(),canvas=document.querySelector('.sie-mask'),editor=document.querySelector('.wb-editor-host');
 const viewport=document.querySelector('[data-editor-viewport]')!;
 Object.defineProperty(viewport,'setPointerCapture',{configurable:true,value:vi.fn()});Object.defineProperty(viewport,'releasePointerCapture',{configurable:true,value:vi.fn()});
 const pointer=(type:string,x:number,y:number)=>{const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:1});fireEvent(viewport,event);};
 vi.spyOn(screen.getByTestId('editor-world'),'getBoundingClientRect').mockReturnValue({left:0,top:0,width:1024,height:640} as DOMRect);
 if(kind==='target')fireEvent.click(document.querySelector('.wb-post [data-sam="mask"]')!);
 else {
  fireEvent.click(document.querySelector(`[data-sam-tool="${kind==='point'?'samPoint':'samBox'}"]`)!);
  pointer('pointerdown',20,30);
  if(kind==='box')pointer('pointerup',80,90);
 }
 await waitFor(()=>expect(document.querySelector('.wb-side [role="status"]')?.textContent).toContain('A separate SAM mask layer was added.'));
 await waitFor(()=>expect(readCurrentWorkbench).toHaveBeenCalledTimes(2),{timeout:3000});
 expect(selected()).toEqual(before);expect(document.querySelector('.wb-editor-host')).toBe(editor);expect(document.querySelector('.sie-mask')).toBe(canvas);
 expect(document.querySelector('.sie-image img')?.getAttribute('src')).toBe(source.getAttribute('src'));
 expect(fetchSource).toHaveBeenCalledTimes(1);expect(fetchSource).toHaveBeenCalledWith(source.getAttribute('src'));
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({recipeId:'sam3-mask',checkpoint:sam,inputImage:'current-source.png',width:1024,height:640,...(kind==='point'?{positivePoints:[{x:20,y:30}],negativePoints:[]}:kind==='box'?{box:{x:20,y:30,width:60,height:60}}:{prompt:'eyes'})});
 expect(autoRefine).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
 expect(vi.mocked(invoke).mock.calls.some(([command])=>/generate|auto_refine/.test(command))).toBe(false);
 view.unmount();
});

test.each([undefined,0,4,31,32])('SAM blur shares the saved Inpaint preference with default four (%s)',async saved=>{
 if(saved!==undefined)localStorage.setItem('deas.pref.studio.run.maskBlur',JSON.stringify(saved));
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 dock('Post-Processing');fireEvent.click(document.querySelector('[data-post-card="sam"]')!);
 const blur=document.querySelector<HTMLInputElement>('.wb-post [data-sam="maskBlur"]')!;
 expect(blur.value).toBe(String(saved===undefined||saved===32?4:saved));
 fireEvent.change(blur,{target:{value:'12'}});
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.maskBlur')!)).toBe(12);
 expect(uploadMask).not.toHaveBeenCalled();expect(autoRefine).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('SAM automatic refinement hands the exact submitted job to the native serial group chain',async()=>{
 const sam='SAM3/sam3.1_multiplex_fp16.safetensors';
 for(const [key,value] of Object.entries({samCheckpoint:sam,samTargets:'eyes, feet; hands',samEnabled:true,samDenoise:0.35,maskBlur:8,steps:23}))localStorage.setItem('deas.pref.studio.run.'+key,JSON.stringify(value));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'SAM3_Detect'],checkpoints:[...evidence.allowlist.checkpoints,sam]}});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',family:'sdxl',size:1,info:null}]);
 const job:JobStatus={id:'base-job',baseUrl:evidence.baseUrl,promptId:'prompt',state:'queued',outputs:[],error:null,generationReady:false};
 vi.mocked(runWorkbenchJob).mockResolvedValue(job);vi.mocked(autoRefine).mockResolvedValue({job:null,skipped:0});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 const run=screen.getByRole('button',{name:'Run'});await waitFor(()=>expect(run).toHaveProperty('disabled',false));fireEvent.click(run);
 await waitFor(()=>expect(autoRefine).toHaveBeenCalledTimes(1));
 const [url,intent,settings,fence,sourceJob]=vi.mocked(autoRefine).mock.calls[0];
 expect(url).toBe(evidence.baseUrl);expect(intent).toEqual(vi.mocked(runWorkbenchJob).mock.calls[0][1]);
 expect(settings).toEqual({checkpoint:sam,targets:['eyes','feet','hands'],denoise:0.35,margin:32,maskBlur:8,threshold:0.5});
 expect(fence).toBe(0);expect(sourceJob).toBe(job.id);expect(waitForWorkbenchJob).not.toHaveBeenCalled();
});

test('SAM automatic refinement keeps polling so its native passes show in the queue while the chain runs',async()=>{
 const sam='SAM3/sam3.1_multiplex_fp16.safetensors';
 for(const [key,value] of Object.entries({samCheckpoint:sam,samTargets:'hands',samEnabled:true}))localStorage.setItem('deas.pref.studio.run.'+key,JSON.stringify(value));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'SAM3_Detect'],checkpoints:[...evidence.allowlist.checkpoints,sam]}});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',family:'sdxl',size:1,info:null}]);
 const job:JobStatus={id:'base-job',baseUrl:evidence.baseUrl,promptId:'prompt',state:'queued',outputs:[],error:null,generationReady:false};
 vi.mocked(runWorkbenchJob).mockResolvedValue(job);vi.mocked(autoRefine).mockReturnValue(new Promise(()=>{}));
 const done={...job,state:'succeeded' as const};
 vi.mocked(pollWorkbench).mockResolvedValueOnce(collection([done])).mockResolvedValueOnce(collection([done])).mockResolvedValue({...collection([done,heldJob('refine-pass','running')]),autoRefining:true});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 const run=screen.getByRole('button',{name:'Run'});await waitFor(()=>expect(run).toHaveProperty('disabled',false));fireEvent.click(run);
 await waitFor(()=>expect(autoRefine).toHaveBeenCalledTimes(1));
 await waitFor(()=>expect(document.querySelector('[data-job-id="refine-pass"]')).not.toBeNull(),{timeout:5000});
});

test('dual encoder advice belongs to each effective filename, including automatic selection',async()=>{
 localStorage.setItem('deas.pref.studio.run.textEncoder2',JSON.stringify('broken-t5.safetensors'));
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'flux.safetensors',family:'flux',path:'/m/flux',size:1,info:null},
  {category:'text_encoders',name:'clip_l.safetensors',component:'clip-l',path:'/m/clip',size:1,info:null},
  {category:'text_encoders',name:'broken-t5.safetensors',component:'t5xxl',integrity:'truncated',path:'/m/t5',size:1,info:null},
  {category:'vae',name:'ae.safetensors',component:'flux-vae',path:'/m/vae',size:1,info:null}
 ]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,diffusionModels:['flux.safetensors'],nodes:[...evidence.allowlist.nodes,'UNETLoader','DualCLIPLoader','VAELoader']}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('flux.safetensors'));
 expect(document.querySelector('[data-run-component="textEncoders"] [data-model-check]')).toBeNull();
 expect(document.querySelector('[data-run-component="textEncoders2"] [data-model-check]')?.getAttribute('data-model-check')).toBe('blocked');
 expect(document.querySelector('[data-run-component="textEncoders2"]')?.textContent).toContain('File integrity check failed');
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['integrity','conflict'] as const)('shared model helper keeps a saved %s checkpoint blocked without replacement',async issue=>{
 const file={category:'checkpoints',name:'a.safetensors',path:'/m/a.safetensors',size:1,info:null,...(issue==='integrity'?{integrity:'truncated'}:{check:{identity:'sha256' as const,compatibility:'blocked' as const,availability:'available' as const,evidence:['header','provider'],reasons:[{code:'conflict'}]}})};
 localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify(file.name));
 vi.mocked(scanModels).mockResolvedValue([file]);vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain(file.name));
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(document.querySelector('[data-model-check="blocked"]')).not.toBeNull();
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each([undefined,1,2])('image model card uses image preferences and captures upscale factor (%s)',async saved=>{
 if(saved!==undefined)localStorage.setItem('deas.pref.studio.run.upscale',JSON.stringify(saved));
 const name='4x-UltraSharp.pth';
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'DEAS_ImagePostprocessGate'],upscaleModels:[name]}});
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('image-model-card','failed'));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 dock('Post-Processing');
 const card=document.querySelector<HTMLButtonElement>('[data-post-card="model"]')!;
 expect(card.disabled).toBe(false);fireEvent.click(card);
 const picker=within(screen.getByRole('dialog')).getByRole('combobox',{name:'Upscale model'});
 fireEvent.change(picker,{target:{value:name}});
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.upscaleModel')!)).toBe(name);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.tve')??'{}').upscaleModel??'').toBe('');
 expect(card.dataset.postState).toBe('active');
 fireEvent.keyDown(document,{key:'Escape'});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const intent=vi.mocked(runWorkbenchJob).mock.lastCall![1] as import('../../lib/execution').DiagnosticImageIntentV1;
 expect(intent.refine).toMatchObject({width:intent.width*(saved??2),height:intent.height*(saved??2),upscaleModel:name});
 expect(intent).not.toHaveProperty('videoPost');
 fireEvent.click(card);fireEvent.change(within(screen.getByRole('dialog')).getByRole('combobox',{name:'Upscale model'}),{target:{value:''}});
 expect(intent.refine?.upscaleModel).toBe(name);
 expect(card.dataset.postState).toBe('inactive');
});

test('image model card retains a missing saved choice and its enabled-pass blocker',async()=>{
 localStorage.setItem('deas.pref.studio.run.post','true');
 localStorage.setItem('deas.pref.studio.run.upscaleModel',JSON.stringify('missing.pth'));
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'DEAS_ImagePostprocessGate'],upscaleModels:[]}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('a.safetensors'));
 dock('Post-Processing');fireEvent.click(document.querySelector('[data-post-card="model"]')!);
 expect(within(screen.getByRole('dialog')).getByRole('combobox',{name:'Upscale model'})).toHaveProperty('value','missing.pth');
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each([false,true])('shared model helper checks an enabled auxiliary upscaler, not a disabled saved choice (%s)',async enabled=>{
 localStorage.setItem('deas.pref.studio.run.post',JSON.stringify(enabled));
 localStorage.setItem('deas.pref.studio.run.upscaleModel',JSON.stringify('broken-up.safetensors'));
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',size:1,info:null},{category:'upscale_models',name:'broken-up.safetensors',path:'/m/up',size:1,info:null,integrity:'truncated'}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'DEAS_ImagePostprocessGate'],upscaleModels:['broken-up.safetensors']}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('a.safetensors'));
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',enabled);
 if(enabled)expect(screen.getByRole('alert').textContent).toContain('broken-up.safetensors');
});

test.each((['music','video'] as const).flatMap(pipeline=>(['upscaler','sam'] as const).map(stage=>({pipeline,stage}))))('inactive image $stage does not block $pipeline Run or change saved choices',async({pipeline,stage})=>{
 const name=stage==='sam'?'SAM3/sam3.1_multiplex_fp16.safetensors':'broken-up.safetensors';
 const saved=stage==='sam'?{samEnabled:true,samCheckpoint:name,samTargets:'hands'}:{post:true,upscaleModel:name};
 for(const [key,value] of Object.entries(saved))localStorage.setItem('deas.pref.studio.run.'+key,JSON.stringify(value));
 const bad:LocalModel={category:stage==='sam'?'checkpoints':'upscale_models',name,path:'/m/'+name,size:1,info:null,integrity:'truncated'};
 const ready=pipeline==='music'?musicEvidence({samplers:evidence.allowlist.samplers,schedulers:evidence.allowlist.schedulers}):videoEvidence;
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...ready,allowlist:{...ready.allowlist,upscaleModels:[name]}});
 vi.mocked(scanModels).mockResolvedValue([...(pipeline==='music'?yue2Models:ltxModels),bad]);
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify(pipeline==='music'?'t2m':'t2v'));
 localStorage.setItem('deas.pref.studio.audioEnhance.post.mode',JSON.stringify('off'));
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('inactive-stage','failed'));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 if(pipeline==='music')fireEvent.change(await screen.findByRole('textbox',{name:'Style'}),{target:{value:'instrumental'}});
 const run=screen.getByRole('button',{name:'Run'});
 await waitFor(()=>expect(run).toHaveProperty('disabled',false));fireEvent.click(run);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({recipeId:pipeline==='music'?'music-generation':'video-generation'});
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).not.toHaveProperty('refine');expect(autoRefine).not.toHaveBeenCalled();
 for(const [key,value] of Object.entries(saved))expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.'+key)!)).toEqual(value);
});

test.each([false,true])('automatic SAM model protection applies to expert image Run, not beginner (%s)',async beginner=>{
 const sam='SAM3/sam3.1_multiplex_fp16.safetensors';
 for(const [key,value] of Object.entries({samEnabled:true,samCheckpoint:sam,samTargets:'hands'}))localStorage.setItem('deas.pref.studio.run.'+key,JSON.stringify(value));
 vi.mocked(scanModels).mockResolvedValue([{...yue2Models[1],family:'sdxl'},{category:'checkpoints',name:sam,path:'/m/sam',size:1,info:null,integrity:'truncated'}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'SAM3_Detect'],checkpoints:[...evidence.allowlist.checkpoints,sam]}});
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('beginner-no-sam','failed'));
 render(<I18nProvider><Workbench beginner={beginner} endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker], #beginner-mode')).not.toBeNull());
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',!beginner));
 if(beginner){fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));}
 else {expect(screen.getByRole('alert').textContent).toContain(sam);expect(runWorkbenchJob).not.toHaveBeenCalled();}
 expect(autoRefine).not.toHaveBeenCalled();expect(localStorage.getItem('deas.pref.studio.run.samEnabled')).toBe('true');expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.samCheckpoint')!)).toBe(sam);
});

test.each([false,true])('H3 image edit ignores unsupported saved image post/upscaler (backend lists file=%s)',async listed=>{
 const upscaler='broken-up.safetensors';
 for(const [key,value] of Object.entries({pipeline:'i2i',post:true,upscaleModel:upscaler}))localStorage.setItem('deas.pref.studio.run.'+key,JSON.stringify(value));
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'h3.safetensors',path:'/m/h3',family:'minimax-h3',size:1,info:null},
  {category:'text_encoders',name:'minimax_h3_encoder.safetensors',path:'/m/t',size:1,info:null},
  {category:'vae',name:'h3_video_vae.safetensors',path:'/m/v',size:1,info:null},
  {category:'vae',name:'h3_audio_vae.safetensors',path:'/m/a',size:1,info:null},
  {category:'upscale_models',name:upscaler,path:'/m/up',size:1,info:null,integrity:'truncated'}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,upscaleModels:listed?[upscaler]:[]}});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('h3-no-image-post','failed'));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/env/ComfyUI/input'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));choosePipe('Image → Image');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));adopt();
 const img=(await screen.findAllByRole('img',{name:'ref.png'})).find(e=>e.classList.contains('wb-zoomable'))!;
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:768}});fireEvent.load(img);
 const run=screen.getByRole('button',{name:'Run'});await waitFor(()=>expect(run).toHaveProperty('disabled',false));fireEvent.click(run);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({family:'minimax-h3',h3Edit:expect.any(Object)});
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).not.toHaveProperty('refine');
 dock('Post-Processing');expect(document.querySelector('[data-post-card="model"]')).toHaveProperty('disabled',true);
 expect(localStorage.getItem('deas.pref.studio.run.post')).toBe('true');expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.upscaleModel')!)).toBe(upscaler);
});

test('enabled video upscaler still blocks Run for a damaged model with image post disabled',async()=>{
 const name='broken-up.safetensors';
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify('t2v'));
 localStorage.setItem('deas.pref.studio.run.tve',JSON.stringify({...defaultTve,upscaleModel:name}));
 localStorage.setItem('deas.pref.studio.audioEnhance.post.mode',JSON.stringify('off'));
 vi.mocked(scanModels).mockResolvedValue([...ltxModels,{category:'upscale_models',name,path:'/m/up',size:1,info:null,integrity:'truncated'}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,upscaleModels:[name]}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('File integrity check failed'));
 expect(screen.getByRole('alert').textContent).toContain(name);
 const run=screen.getByRole('button',{name:'Run'});expect(run).toHaveProperty('disabled',true);fireEvent.click(run);expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('model metadata action enables an unknown supported file while GGUF stays usable',async()=>{
 const unknown={category:'diffusion_models',name:'unknown.safetensors',path:'/m/unknown.safetensors',size:1,info:null};
 const bad={...unknown,name:'bad.safetensors',path:'/m/bad.safetensors',family:'anima',metadataError:'invalid sidecar'};
 const gguf={...unknown,name:'declared.gguf',path:'/m/declared.gguf',family:'anima',familyOverride:'anima'};
 vi.mocked(scanModels).mockResolvedValue([unknown,bad,gguf]);
 vi.mocked(writeModelFamily).mockResolvedValue({...unknown,family:'anima',familyOverride:'anima'});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 fireEvent.click(screen.getByRole('tab',{name:'Models'}));
 const tile=await screen.findByRole('button',{name:unknown.name});
 expect(tile.getAttribute('aria-disabled')).toBe('true');
 expect(tile).toHaveProperty('disabled',false);tile.focus();expect(document.activeElement).toBe(tile);
 fireEvent.keyDown(tile,{key:'F10',shiftKey:true});fireEvent.click(screen.getByRole('menuitem',{name:'Edit meta…'}));
 fireEvent.change(screen.getByLabelText('Model family'),{target:{value:'anima'}});fireEvent.click(screen.getByRole('button',{name:'Save'}));
 await waitFor(()=>expect(tile.getAttribute('aria-disabled')).toBe('false'));
 const picker=document.querySelector('[data-model-picker]') as HTMLSelectElement;
 expect(picker.value).toBe(gguf.name);
 expect([...document.querySelector<HTMLSelectElement>('[data-pipeline]')!.options].find(o=>o.value==='video')).toHaveProperty('disabled',true);
 expect([...picker.options].find(o=>o.value===bad.name)).toBeUndefined();
 expect([...picker.options].find(o=>o.value===gguf.name)?.disabled).toBe(false);
 expect(tile.querySelector('.model-declared-compact')?.getAttribute('title')).toContain('User-declared family');
 fireEvent.contextMenu(tile);fireEvent.click(screen.getByRole('menuitem',{name:'Edit meta…'}));
 vi.mocked(writeModelFamily).mockResolvedValue(unknown);fireEvent.click(screen.getByRole('button',{name:'Reset to detection'}));
 await waitFor(()=>expect(tile.getAttribute('aria-disabled')).toBe('true'));
 expect([...picker.options].find(o=>o.value===unknown.name)).toBeUndefined();
 // The usable declared GGUF stays selected; Run stays gated by the offline backend, not by the unknown file.
 expect(picker.value).toBe(gguf.name);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('Ctrl+Enter presses Run once, and never while Run is disabled, hidden or behind a dialog',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 const view=render(<I18nProvider><div data-host><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></div></I18nProvider>);
 const run=document.querySelector<HTMLButtonElement>('[data-run]')!;
 const prompt=document.querySelector('#run-negative')!;
 const clicked=vi.spyOn(run,'click');clicked.mockImplementation(()=>{});
 await waitFor(()=>expect(run.disabled).toBe(false));
 fireEvent.keyDown(prompt,{key:'Enter'});
 fireEvent.keyDown(prompt,{key:'Enter',ctrlKey:true,repeat:true});
 const dialog=document.body.appendChild(document.createElement('dialog'));dialog.setAttribute('open','');
 fireEvent.keyDown(prompt,{key:'Enter',ctrlKey:true});dialog.remove();
 const host=view.container.querySelector<HTMLElement>('[data-host]')!;host.hidden=true;
 fireEvent.keyDown(prompt,{key:'Enter',ctrlKey:true});host.hidden=false;
 expect(clicked).not.toHaveBeenCalled();
 fireEvent.keyDown(prompt,{key:'Enter',ctrlKey:true});
 expect(clicked).toHaveBeenCalledTimes(1);
});

test('checkpoint picker stays a compact native select without a custom filter or list',async()=>{
 const files=['anima_a','anima_b','illu_c','krea_d','wan_e','ltx_f','sdxl_g','pony_h','moss_i'].map(n=>({category:'checkpoints',name:`${n}.safetensors`,path:`/m/${n}.safetensors`,size:1,info:null,family:'sdxl'}));
 vi.mocked(scanModels).mockResolvedValue(files);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 const picker=await waitFor(()=>{const p=document.querySelector<HTMLSelectElement>('[data-model-picker]')!;expect(p.options.length).toBe(9);return p;});
 expect(picker.tagName).toBe('SELECT');expect(picker.multiple).toBe(false);expect(picker.size).toBe(0);
 expect(fireEvent.mouseDown(picker)).toBe(true);
 expect(fireEvent.keyDown(picker,{key:'ArrowDown'})).toBe(true);
 expect(document.querySelector('[data-model-filter]')).toBeNull();
 expect(document.querySelector('[data-model-list]')).toBeNull();
 expect(picker.options.length).toBe(9);
 fireEvent.change(picker,{target:{value:'krea_d.safetensors'}});
 expect(picker.value).toBe('krea_d.safetensors');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.checkpoint')!)).toBe('krea_d.safetensors');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('checkpoint picker filters mixed inventories on image/video pipeline changes and restores drafts',async()=>{
 const files=[
  {category:'checkpoints',name:'image.safetensors',family:'sdxl'},
  {category:'checkpoints',name:'unknown.safetensors'},
  {category:'checkpoints',name:'wrong-folder.safetensors',family:'anima'},
  {category:'diffusion_models',name:'video.safetensors',family:'ltx-2'},
  {category:'diffusion_models',name:'unknown-split.safetensors'},
  {category:'diffusion_models',name:'invalid.safetensors',family:'anima',metadataError:'invalid sidecar'},
 ].map(m=>({...m,path:'/m/'+m.name,size:1,info:null}));
 vi.mocked(scanModels).mockResolvedValue(files);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 const picker=document.querySelector<HTMLSelectElement>('[data-model-picker]')!;
 const values=()=>[...picker.options].map(o=>o.value);
 await waitFor(()=>expect(values()).toEqual(['image.safetensors','unknown.safetensors']));
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'  image draft\n'}});
 fireEvent.change(screen.getByLabelText('Negative prompt'),{target:{value:''}});
 fireEvent.change(picker,{target:{value:'unknown.safetensors'}});
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','  image draft\n');
 expect(screen.getByLabelText('Negative prompt')).toHaveProperty('value','');
 fireEvent.change(document.querySelector('[data-pipeline]')!,{target:{value:'video'}});
 expect(values()).toEqual(['video.safetensors']);expect(picker.value).toBe('video.safetensors');
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'video draft'}});
 fireEvent.change(document.querySelector('[data-pipeline]')!,{target:{value:'image'}});
 expect(values()).toEqual(['image.safetensors','unknown.safetensors']);expect(picker.value).toBe('unknown.safetensors');
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','  image draft\n');
 expect(screen.getByLabelText('Negative prompt')).toHaveProperty('value','');
 fireEvent.change(document.querySelector('[data-pipeline]')!,{target:{value:'video'}});
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','video draft');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test.each(['missing','incompatible','invalid','wrong-folder','unsupported','empty'] as const)('checkpoint picker retains a saved %s selection with its disabled reason',async kind=>{
 const name='saved.safetensors';
 localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify(name));
 const saved={category:kind==='incompatible'?'diffusion_models':'checkpoints',name,path:'/m/'+name,size:1,info:null,...(kind==='incompatible'?{family:'ltx-2'}:kind==='invalid'?{metadataError:'bad sidecar'}:kind==='wrong-folder'?{family:'anima'}:{})};
 const selected=kind==='unsupported'?{...saved,name:'saved.gguf',family:'sdxl'}:saved;
 localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify(selected.name));
 vi.mocked(scanModels).mockResolvedValue(kind==='empty'?[]:[{category:'checkpoints',name:'compatible.safetensors',path:'/m/compatible',size:1,info:null},...(kind==='missing'?[]:[selected])]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await act(async()=>{});
 const picker=document.querySelector<HTMLSelectElement>('[data-model-picker]')!;
 const option=picker.selectedOptions[0];
 expect(picker.value).toBe(selected.name);expect(option.disabled).toBe(true);
 expect(option.title).toBeTruthy();expect(option.textContent).toContain(option.title);expect(picker.title).toBe(option.title);
 expect(option.title).toMatch(kind==='incompatible'?/recipe/i:kind==='invalid'?/metadata/i:kind==='wrong-folder'?/diffusion_models/i:kind==='unsupported'?/GGUF/i:/unavailable/i);
 expect([...picker.options].map(o=>o.value)).toEqual(kind==='empty'?[selected.name]:[selected.name,'compatible.safetensors']);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.checkpoint')!)).toBe(selected.name);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each([false,true])('checkpoint picker shows the disabled empty state without compatible models (empty inventory: %s)',async empty=>{
 vi.mocked(scanModels).mockResolvedValue(empty?[]:[{category:'diffusion_models',name:'video.safetensors',family:'ltx-2',path:'/m/video',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await act(async()=>{});
 const picker=document.querySelector<HTMLSelectElement>('[data-model-picker]')!;
 expect([...picker.options].map(o=>o.value)).toEqual(['']);expect(picker.selectedOptions[0].disabled).toBe(true);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
});

test('declared GGUF runs through the GGUF loader while invalid metadata fails closed',async()=>{
 const file={category:'diffusion_models',name:'declared.gguf',path:'/m/declared.gguf',size:1,info:null,family:'anima',familyOverride:'anima'};
 const companions=[{category:'text_encoders',name:'qwen_3_600m.gguf',path:'/m/text_encoders/qwen_3_600m.gguf',size:1,info:null},{category:'vae',name:'wan_2.1_vae.safetensors',path:'/m/vae/wan_2.1_vae.safetensors',size:1,info:null}];
 vi.mocked(scanModels).mockResolvedValue([file,...companions]);vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'UnetLoaderGGUF','CLIPLoaderGGUF','VAELoader'],ggufDiffusionModels:[file.name],ggufTextEncoders:[companions[0].name],ggufClipTypes:['stable_diffusion'],vaes:[companions[1].name]}});
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain(file.name));
 expect([...document.querySelector<HTMLSelectElement>('[data-model-picker]')!.options].find(o=>o.value===file.name)).toHaveProperty('disabled',false);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false);
 view.unmount();
 vi.mocked(scanModels).mockResolvedValue([{...file,category:'checkpoints'},...companions]);
 localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify(file.name));
 const second=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain(file.name));
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 second.unmount();
 localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify('invalid.safetensors'));
 vi.mocked(scanModels).mockResolvedValue([{...file,name:'invalid.safetensors',path:'/m/invalid.safetensors',metadataError:'invalid metadata'}]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('invalid.safetensors'));
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['node','file','encoder','vae','plain-base'])('GGUF Run stays blocked when quantized backend %s evidence is missing',async missing=>{
 const file={category:'diffusion_models',name:missing==='plain-base'?'base.safetensors':'base.gguf',path:'/m/base',size:1,info:null,family:'anima'};
 const encoder=missing==='plain-base'?'qwen_3_600m.gguf':'qwen_3_600m.safetensors';
 vi.mocked(scanModels).mockResolvedValue([file,{category:'text_encoders',name:encoder,path:'/m/'+encoder,size:1,info:null},{category:'vae',name:'wan_2.1_vae.safetensors',path:'/m/wan_2.1_vae.safetensors',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'UNETLoader','CLIPLoader','CLIPLoaderGGUF','VAELoader',...(missing==='node'?[]:['UnetLoaderGGUF'])],ggufDiffusionModels:missing==='file'?[]:[file.name],diffusionModels:[],textEncoders:missing==='encoder'?[]:[encoder],ggufTextEncoders:[encoder],clipTypes:['stable_diffusion'],ggufClipTypes:['stable_diffusion'],vaes:missing==='vae'?[]:['wan_2.1_vae.safetensors']}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain(file.name));
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each((['checkpoints','diffusion_models'] as const).flatMap(category=>(['file','loader'] as const).map(missing=>({category,missing}))))('main $category model blocks Run when backend $missing evidence is missing',async({category,missing})=>{
 const split=category==='diffusion_models',name=split?'anima.safetensors':'a.safetensors',loader=split?'UNETLoader':'CheckpointLoaderSimple';
 const main={category,name,family:split?'anima':'sdxl',path:'/m/'+name,size:1,info:null};
 vi.mocked(scanModels).mockResolvedValue([main,{category:'text_encoders',name:'qwen_3_600m.safetensors',path:'/m/e',size:1,info:null},{category:'vae',name:'wan_2.1_vae.safetensors',path:'/m/v',size:1,info:null}]);
 const ready={...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'UNETLoader'],checkpoints:split?[]:[name],diffusionModels:split?[name]:[]}};
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...ready,allowlist:{...ready.allowlist,...(missing==='file'?{checkpoints:[],diffusionModels:[]}:{nodes:ready.allowlist.nodes.filter(n=>n!==loader)})}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await screen.findByRole('option',{name});
 await waitFor(()=>expect(document.querySelector('[data-model-availability]')?.getAttribute('data-model-availability')).toBe('missing'));
 const run=screen.getByRole('button',{name:'Run'});
 expect(run).toHaveProperty('disabled',true);
 expect(screen.getByRole('alert').textContent).toContain(missing==='file'?name:loader);
 fireEvent.click(run);expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(ready);
 dock('Models');fireEvent.click(document.querySelector('[data-run-load]')!);
 await waitFor(()=>expect(run).toHaveProperty('disabled',false));
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('Wan LOW metadata errors remain visible dependencies of the selected HIGH model',async()=>{
 localStorage.setItem('deas.pref.studio.run.pipeline','"i2v"');
 const file={category:'diffusion_models',name:'wan_high.gguf',path:'/m/wan_high.gguf',size:1,info:null,family:'wan'};
 vi.mocked(scanModels).mockResolvedValue([file,{...file,name:'wan_low.gguf',path:'/m/wan_low.gguf',metadataError:'stale LOW sidecar'}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'UnetLoaderGGUF'],ggufDiffusionModels:['wan_high.gguf','wan_low.gguf']}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLSelectElement>('[data-model-picker]')?.value).toBe(file.name));
 expect(screen.getByText(/Invalid model metadata blocks generation/)).toBeTruthy();
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['metadata','gguf','integrity','conflict'])('selected LoRA %s policy keeps file/format failures blocking and family labels advisory' ,async issue=>{
 const name=issue==='gguf'?'bad.gguf':'bad.safetensors';
 localStorage.setItem('deas.pref.studio.run.loras',JSON.stringify([{name,strength:1}]));
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a.safetensors',size:1,info:null},{category:'loras',name,path:'/m/'+name,size:1,info:null,...(issue==='metadata'?{metadataError:'invalid metadata'}:issue==='integrity'?{integrity:'truncated'}:issue==='conflict'?{familyEvidence:'conflict' as const}:{family:'sdxl',familyOverride:'sdxl'})}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('a.safetensors'));
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',issue!=='conflict');if(issue!=='conflict')expect(screen.getByRole('alert').textContent).toContain(name);
 if(issue==='integrity')expect(screen.getByRole('alert').textContent).toContain('File integrity check failed');
 if(issue==='conflict')expect(screen.queryByRole('alert')).toBeNull();
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('automatic audio readiness blocks video while probe is pending/missing; Off restores ordinary Run',async()=>{
 let resolve!: (value:unknown)=>void;
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify('t2v'));
 localStorage.setItem('deas.pref.studio.audioEnhance.post.mode',JSON.stringify('stems'));
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(invoke).mockImplementation(async command=>command==='native_audio_enhance_capabilities'?new Promise(r=>{resolve=r;}):{path:'/out',parent:'/',entries:[],truncated:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('LTX2/ltx.safetensors'));
 const run=screen.getByRole('button',{name:'Run'});
 expect(run).toHaveProperty('disabled',true);
 await act(async()=>{resolve({clean:true,deep:false,stems:false});});
 expect(run).toHaveProperty('disabled',true);
 expect(run.title).toContain('Audio enhancement is not ready');
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 fireEvent.change(document.querySelector('[data-audio-enhance-mode]')!,{target:{value:'off'}});
 await waitFor(()=>expect(run).toHaveProperty('disabled',false));
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each((['ltx-2','minimax-h3','yue2'] as const).flatMap(family=>(['off','clean','deep','stems'] as const).flatMap(mode=>(mode==='stems'?['auto','cpu','cuda'] as const:['auto'] as const).map(device=>({family,mode,device})))))('automatic audio $family / $mode / $device reaches Run Plan and immutable native Run',async({family,mode,device})=>{
 const h3=family==='minimax-h3',musicFamily=family==='yue2';
 localStorage.setItem('deas.pref.studio.audioEnhance.post.device',JSON.stringify(device));
 const files=musicFamily?[...yue2Models]:h3?[
  {category:'diffusion_models',name:'h3.safetensors',family},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'},
  {category:'vae',name:'minimax_h3_video_vae_fp16.safetensors'},
  {category:'vae',name:'minimax_h3_audio_vae_fp32.safetensors'}
 ].map(m=>({...m,path:'/m/'+m.name,size:1,info:null})):[...ltxModels];
 vi.mocked(scanModels).mockResolvedValue(files);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(musicFamily?musicEvidence():videoEvidence);
 vi.mocked(invoke).mockImplementation(async command=>command==='native_audio_enhance_capabilities'?{clean:true,deep:true,stems:true,cuda:true}:command==='native_jobs_history'?{schemaVersion:1,records:[],readOnly:false,error:null}:{path:'/out',parent:'/',entries:[],truncated:false});
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('audio-chain','failed'),error:'fixture'});
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify(musicFamily?'t2m':'t2v'));
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 if(musicFamily)fireEvent.change(music().style,{target:{value:'indie pop'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 await act(async()=>{fireEvent.focus(document.querySelector('[data-audio-enhance-mode]')!);});
 fireEvent.change(document.querySelector('[data-audio-enhance-mode]')!,{target:{value:mode}});
 if(mode==='deep'){
  expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
  fireEvent.change(document.querySelector('[data-audio-enhance-profile]')!,{target:{value:'speech'}});
 }
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 const plan=JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
 const audio=mode==='off'?undefined:{mode,profile:mode==='deep'?'speech':'mix',...(mode==='stems'?{device}:{})};
 if(audio){expect(plan.audioEnhance).toEqual(audio);expect(document.querySelector('[data-plan-stage="audioEnhance"]')).not.toBeNull();}
 else expect(plan).not.toHaveProperty('audioEnhance');
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 if(mode==='stems')fireEvent.change(document.querySelector('[data-audio-enhance-device]')!,{target:{value:device==='cpu'?'auto':'cpu'}});
 fireEvent.change(document.querySelector('[data-audio-enhance-mode]')!,{target:{value:mode==='off'?'clean':'off'}});
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 const submitted=vi.mocked(runWorkbenchJob).mock.lastCall![1];
 if(audio)expect(submitted).toHaveProperty('audioEnhance',audio);else expect(submitted).not.toHaveProperty('audioEnhance');
 expect(invoke).not.toHaveBeenCalledWith('native_audio_enhance_export',expect.anything());
});

test.each((['ltx-2','minimax-h3'] as const).flatMap(family=>([undefined,true,false,'missing'] as const).map(preference=>({family,preference}))))('enhanced preview $family / $preference shares Run Plan and immutable Run',async({family,preference})=>{
 const h3=family==='minimax-h3';
 const config={decoder:'tiny' as const,model:h3?'taeh3.safetensors':'taeltx.safetensors'};
 const files=h3?[
  {category:'diffusion_models',name:'h3.safetensors',family},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'},
  {category:'vae',name:'minimax_h3_video_vae_fp16.safetensors'},
  {category:'vae',name:'minimax_h3_audio_vae_fp32.safetensors'}
 ].map(m=>({...m,path:'/m/'+m.name,size:1,info:null})):[...ltxModels];
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 if(typeof preference==='boolean')localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({...defaultOptions,enhancedPreview:preference}));
 vi.mocked(scanModels).mockResolvedValue(files);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,videoPreviews:preference==='missing'?{}:{[family]:config}}});
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('preview-run','failed'),error:'fixture'});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('tab',{name:'Options'}));
 const toggle=screen.getByRole('switch',{name:'Enhanced preview'});
 const enabled=preference!==false&&preference!=='missing';
 expect(toggle).toHaveProperty('checked',enabled);
 expect(toggle).toHaveProperty('disabled',preference==='missing');
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 const planned=JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
 if(enabled)expect(planned.enhancedPreview).toEqual(config);else expect(planned).not.toHaveProperty('enhancedPreview');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 if(preference!=='missing')fireEvent.click(screen.getByRole('switch',{name:'Enhanced preview'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledOnce());
 const submitted=vi.mocked(runWorkbenchJob).mock.lastCall![1];
 if(enabled)expect(submitted).toHaveProperty('enhancedPreview',config);else expect(submitted).not.toHaveProperty('enhancedPreview');
});

test('Anima LoRA compatibility is off by default and an Anima Run captures the enabled choice',async()=>{
 const name='anima-2.9b.safetensors',lora='legacy-anima.safetensors';
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name,family:'anima',path:'/m/anima',size:1,info:null},
  {category:'text_encoders',name:'qwen_3_600m.safetensors',path:'/m/clip',size:1,info:null},
  {category:'vae',name:'wan_2.1_vae.safetensors',path:'/m/vae',size:1,info:null},
  {category:'loras',name:lora,path:'/m/lora',size:1,info:null},
 ]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,
  nodes:[...evidence.allowlist.nodes,'UNETLoader','DEAS_AnimaLoraLoader'],diffusionModels:[name],loras:[lora],
 }});
 localStorage.setItem('deas.pref.studio.run.loras',JSON.stringify([{name:lora,strength:0.7}]));
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('anima-run','failed'),error:'fixture'});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await screen.findByRole('option',{name});
 fireEvent.click(document.querySelector('[data-open-lora-sets]')!);
 const toggle=await screen.findByRole('checkbox',{name:'Anima 2.9B LoRA compatibility'});
 expect(toggle).toHaveProperty('checked',false);
 await waitFor(()=>expect(toggle).toHaveProperty('disabled',false));
 const dialog=screen.getByRole('dialog',{name:'Selected LoRAs and sets'});
 fireEvent.click(toggle);
 fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!)).toHaveProperty('animaLoraRemap',true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 const run=screen.getByRole('button',{name:'Run'});
 await waitFor(()=>expect(run).toHaveProperty('disabled',false));
 fireEvent.click(run);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledOnce());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({animaLoraRemap:true,loras:[{name:lora,strength:0.7}]});
});

test('enhanced preview follows only the selected running video and cleans up on OFF, browsing, hidden panes, overlays and terminal selection',async()=>{
 const config={decoder:'tiny' as const,model:'taeltx.safetensors'};
 const previewImages:{src:string;onload:unknown;onerror:unknown}[]=[];
 vi.stubGlobal('Image',class{src='';complete=false;onload=null;onerror=null;constructor(){previewImages.push(this);}});
 const intent={recipeId:'video-generation',version:1,family:'ltx-2',positivePrompt:'preview',negativePrompt:'',model:ltxModels[0].name,textEncoder:ltxModels[1].name,vae:ltxModels[3].name,seed:42,width:768,height:512,frames:49,frameRate:24,steps:8,cfg:1,sampler:'euler',scheduler:'simple',outputPrefix:'raw/preview',output:defaultOptions.output!,ltx:{textProjection:ltxModels[2].name,audioVae:ltxModels[4].name,passes:1},enhancedPreview:config} as const;
 const running:JobStatus={...heldJob('running-video','running'),intent,preview:'data:image/png;base64,ordinary',temporalPreview:{revision:1,nodeId:'preview',width:320,height:192,fps:8,frames:[{src:'data:image/png;base64,frame-a',durationMs:125},{src:'data:image/png;base64,frame-b',durationMs:125}]}};
 const other:JobStatus={...running,id:'other-video',temporalPreview:{...running.temporalPreview!,width:160}};
 const inactive=(['queued','succeeded','failed','cancelled','unknown'] as const).map(state=>({...running,id:state,state}));
 const image:JobStatus={...running,id:'image-job',intent:undefined};
 const jobs=[running,other,...inactive,image];
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection(jobs));vi.mocked(pollWorkbench).mockResolvedValue(collection(jobs));
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,videoPreviews:{'ltx-2':config}}});
 vi.mocked(invoke).mockImplementation(async command=>command==='native_media_star_status'?{starred:false,unavailable:null}:{path:'/input',parent:'/',entries:[mediaEntries[0]],truncated:false});
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 const props={endpoint:evidence.baseUrl,roots:{models:'/m',input:'/input'}};
 const content=(hidden=false,planVisible=false)=><div hidden={hidden}><I18nProvider><Workbench {...props} planVisible={planVisible}/></I18nProvider></div>;
 const view=render(content());
 const canvas=()=>document.querySelector<HTMLCanvasElement>('.wb-shown canvas');
 const select=(id:string)=>fireEvent.click(document.querySelector(`[data-job-id="${id}"] .wb-queue-select`)!);
 await waitFor(()=>expect(document.querySelector('[data-job-id="running-video"]')).not.toBeNull());
 expect(canvas()).toBeNull();
 select(running.id);await waitFor(()=>expect(canvas()?.width).toBe(320));
 select(other.id);expect(canvas()?.width).toBe(160);
 for(const job of [...inactive,image]){select(job.id);expect(canvas()).toBeNull();}
 select(running.id);expect(canvas()?.width).toBe(320);
 fireEvent.click(screen.getByRole('tab',{name:'Options'}));
 fireEvent.click(screen.getByRole('switch',{name:'Enhanced preview'}));
 expect(canvas()).toBeNull();
 expect(previewImages.length).toBeGreaterThan(0);
 expect(previewImages.every(image=>image.src===''&&image.onload===null&&image.onerror===null)).toBe(true);
 expect(document.querySelector('.wb-shown img')?.getAttribute('src')).toBe(running.preview);
 expect(running.intent).toHaveProperty('enhancedPreview',config);
 fireEvent.click(screen.getByRole('switch',{name:'Enhanced preview'}));expect(canvas()?.width).toBe(320);
 view.rerender(content(true));await waitFor(()=>expect(canvas()).toBeNull());
 view.rerender(content());await waitFor(()=>expect(canvas()?.width).toBe(320));
 view.rerender(content(false,true));await waitFor(()=>expect(canvas()).toBeNull());
 view.rerender(content());await waitFor(()=>expect(canvas()?.width).toBe(320));
 fireEvent.click(screen.getByRole('button',{name:'Stop'}));expect(canvas()).toBeNull();
 fireEvent.mouseDown(document.body);
 await waitFor(()=>expect(canvas()?.width).toBe(320));
 fireEvent.click(screen.getByRole('tab',{name:'Media'}));fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));
 expect(canvas()).toBeNull();expect(document.querySelector('[data-browsed-preview]')).not.toBeNull();
 fireEvent.click(document.querySelector('[data-preview-close]')!);expect(canvas()?.width).toBe(320);
 vi.mocked(pollWorkbench).mockResolvedValue(collection(jobs.map(job=>job.id===running.id?{...job,state:'cancelled'}:job)));
 await waitFor(()=>expect(document.querySelector('.wb-shown [data-state]')?.getAttribute('data-state')).toBe('cancelled'),{timeout:2000});
 expect(canvas()).toBeNull();
 fireEvent.click(document.querySelector('[data-preview-close]')!);expect(canvas()).toBeNull();
 view.unmount();expect(canvas()).toBeNull();
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('enhanced preview capability refresh preserves saved OFF without computation',async()=>{
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({...defaultOptions,enhancedPreview:false}));
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('tab',{name:'Options'}));
 expect(screen.getByRole('switch',{name:'Enhanced preview'})).toHaveProperty('disabled',true);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,videoPreviews:{'ltx-2':{decoder:'tiny',model:'taeltx.safetensors'}}}});
 fireEvent.click(screen.getByRole('tab',{name:'Media'}));fireEvent.click(screen.getByRole('tab',{name:'Options'}));
 await waitFor(()=>expect(screen.getByRole('switch',{name:'Enhanced preview'})).toHaveProperty('disabled',false));
 expect(screen.getByRole('switch',{name:'Enhanced preview'})).toHaveProperty('checked',false);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.options')!).enhancedPreview).toBe(false);
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test.each(['ltx-2','minimax-h3'] as const)('latent post-processing is opt-in, family scoped, and held in Run Plan and Run (%s)',async family=>{
 const h3=family==='minimax-h3';
 const files=h3?[
  {category:'diffusion_models',name:'h3.safetensors',family},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'},
  {category:'vae',name:'minimax_h3_video_vae_fp16.safetensors'},
  {category:'vae',name:'minimax_h3_audio_vae_fp32.safetensors'}
 ].map(m=>({...m,path:'/m/'+m.name,size:1,info:null})):[...ltxModels];
 vi.mocked(scanModels).mockResolvedValue(files);
 const ltx='ltx-2.3-spatial-upscaler-x2-1.1.safetensors',h3Model='minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors';
 const compatible={...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','DaSiWaH3TiledUpscale','LatentUpscaleModelLoader','LTXVLatentUpsampler'],latentUpscaleModels:[ltx,h3Model,'ltx-2.3-temporal-upscaler-x2-1.0.safetensors'],h3LatentUpscaleModels:[h3Model,ltx,'interpolation']}};
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...compatible,allowlist:{...compatible.allowlist,nodes:compatible.allowlist.nodes.filter(n=>n!=='DEAS_VideoPostprocessGate')}});
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('latent','failed'),error:'fixture'});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 const view=render(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-plan-intent]')?.textContent).toContain('video-generation'));
 expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!)).not.toHaveProperty('latentUpscale');
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 fireEvent.click(screen.getByLabelText('Latent upscale after sampling'));
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(document.body.textContent).toContain('DEAS_VideoPostprocessGate');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(compatible);
 fireEvent.click(screen.getByRole('tab',{name:'Options'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 const picker=screen.getByLabelText('Latent upscale model') as HTMLSelectElement;
 expect([...picker.options].map(o=>o.value)).toContain(h3?h3Model:ltx);
 expect([...picker.options].map(o=>o.value)).not.toContain(h3?ltx:h3Model);
 expect([...picker.options].map(o=>o.value)).not.toContain('ltx-2.3-temporal-upscaler-x2-1.0.safetensors');
 fireEvent.change(picker,{target:{value:h3?h3Model:ltx}});
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 const plan=JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
 expect(plan.latentUpscale).toEqual(h3?{model:h3Model,scale:2,steps:1,denoise:0.2}:{model:ltx,scale:2});
 expect(plan.output).toMatchObject({audioCodec:'Auto',audioBitrate:'192k'});
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 fireEvent.click(document.querySelector('[data-latent-upscale-enabled]')!);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({latentUpscale:plan.latentUpscale,width:plan.width,height:plan.height,frames:plan.frames,output:plan.output});
});

test('TVE post stages are opt-in on video pipelines, badge-marked, and travel as videoPost into Run Plan and Run',async()=>{
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DaSiWa_RTX_UpscalerRefiner','DaSiWa_RTX_FrameGeneration','FrameInterpolate'],upscaleModels:['2x-AnimeSharpV4_RCAN.safetensors'],frameInterpolationModels:['rife_v4.26.safetensors'],rtxUpscaleModes:['Off','VSR','High Bitrate']}});
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('tve','failed'),error:'fixture'});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 const view=render(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-plan-intent]')?.textContent).toContain('video-generation'));
 expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!)).not.toHaveProperty('videoPost');
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 expect(document.querySelectorAll('[data-tve-post] .tve-badge').length).toBeGreaterThan(0);
 fireEvent.change(document.querySelector('[data-tve-post="upscaleModel"]')!,{target:{value:'2x-AnimeSharpV4_RCAN.safetensors'}});
 fireEvent.click(document.querySelector('[data-tve-post="rtxUpscale"]')!);
 const modes=[...(document.querySelector('[data-tve-post="rtxMode"]') as HTMLSelectElement).options].map(o=>o.value);
 expect(modes).toEqual(['VSR','High Bitrate']);
 fireEvent.click(document.querySelector('[data-tve-post="frameGenEnabled"]')!);
 fireEvent.change(document.querySelector('[data-tve-post="engine"]')!,{target:{value:'rife'}});
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 fireEvent.change(document.querySelector('[data-tve-post="rifeModel"]')!,{target:{value:'rife_v4.26.safetensors'}});
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 const plan=JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
 expect(plan.videoPost).toEqual({upscaleModel:'2x-AnimeSharpV4_RCAN.safetensors',rtx:{upscale:{mode:'VSR',quality:'Ultra',scale:2}},frameGeneration:{engine:'rife',multiplier:2,model:'rife_v4.26.safetensors'}});
 expect(document.querySelector('[data-plan-stage="tve"]')?.textContent).toContain('48');
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({videoPost:plan.videoPost});
});

test('Seamless loop is a default-off post stage gated on the audio-aware node and travels as videoPost.loop',async()=>{
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 const allow={...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'FrameInterpolate'],frameInterpolationModels:['rife49.pth','rife_v4.26.safetensors']};
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:allow});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('tab',{name:'Post-Processing'})).toBeTruthy());
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 const toggle=await waitFor(()=>document.querySelector('.wb-post [data-tve-post="loopEnabled"]') as HTMLInputElement);
 expect(toggle.checked).toBe(false);
 await waitFor(()=>expect(toggle.disabled).toBe(true)); // Installed pack without the audio-aware loop.
 expect(document.querySelector('[data-tve-post="loop"]')?.textContent).toContain('0.5.41');
 view.unmount();
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...allow,nodes:[...allow.nodes,'DaSiWa_SeamlessLoop']}});
 const next=render(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-plan-intent]')?.textContent).toContain('video-generation'));
 expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!)).not.toHaveProperty('videoPost');
 next.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 await waitFor(()=>expect((document.querySelector('[data-tve-post="loopEnabled"]') as HTMLInputElement).disabled).toBe(false));
 fireEvent.click(document.querySelector('[data-tve-post="loopEnabled"]')!);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true); // RIFE needs a model.
 expect([...document.querySelectorAll('[data-tve-post="loopModel"] option')].map(o=>o.getAttribute('value'))).not.toContain('rife49.pth'); // The loop node lists only .safetensors.
 fireEvent.change(document.querySelector('[data-tve-post="loopModel"]')!,{target:{value:'rife_v4.26.safetensors'}});
 fireEvent.change(document.querySelector('[data-tve-post="loopAudio"]')!,{target:{value:'beat'}});
 next.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!).videoPost).toEqual({loop:{backend:'rife',model:'rife_v4.26.safetensors',audio:'beat'}});
 expect(document.querySelector('[data-plan-stage="tve"]')?.textContent).toContain('Seamless loop rife_v4.26.safetensors beat-aware');
});

test.each([undefined,false,true])('De-rope keep background restores %s, gates Run on discovery and never executes while editing',async saved=>{
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.derope',JSON.stringify({enabled:true,mode:'full',lora:'',preset:'balanced',inject:0.7,...(saved===undefined?{}:{keepBackground:saved})}));
 vi.mocked(scanModels).mockResolvedValue([{category:'diffusion_models',name:'h3.safetensors',family:'minimax-h3'},{category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'},{category:'vae',name:'minimax_h3_video_vae_fp16.safetensors'},{category:'vae',name:'minimax_h3_audio_vae_fp32.safetensors'}].map(m=>({...m,path:'/m/'+m.name,size:1,info:null})));
 const allow={...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','DaSiWaH3DeropePrepare','DaSiWaH3DeropeRecover']};
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:allow});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('tab',{name:'Post-Processing'}));
 fireEvent.click(document.querySelector('[data-post-card="derope"]')!);
 await waitFor(()=>expect(screen.getByRole('checkbox',{name:'Keep static background'})).toHaveProperty('disabled',true));
 expect(screen.getByRole('checkbox',{name:'Keep static background'})).toHaveProperty('checked',saved??false);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',saved===true));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...allow,deropeKeepBackground:true}});
 fireEvent.click(screen.getByRole('tab',{name:'Options'}));
 await waitFor(()=>expect(document.querySelector('[data-dock-tab="options"]')?.getAttribute('aria-selected')).toBe('true'));
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 await waitFor(()=>expect(screen.getByRole('checkbox',{name:'Keep static background'})).toHaveProperty('disabled',false));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 if(saved!==true)fireEvent.click(screen.getByRole('checkbox',{name:'Keep static background'}));
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 await waitFor(()=>expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!).videoPost.derope.keepBackground).toBe(true));
 expect(document.querySelector('[data-plan-stage="tve"]')?.textContent).toContain('keep static background');
 const settings=captureStudioSettings();
 expect(settings['studio.run.derope']).toMatchObject({keepBackground:true});
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 act(()=>resetStudioPreferences());
 expect(captureStudioSettings()['studio.run.derope']).toMatchObject({enabled:false,keepBackground:false});
 act(()=>{expect(applyStudioSettings(settings)).toBe(true);});
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 if(document.querySelector('[data-post-card="derope"]')?.getAttribute('aria-expanded')!=='true')fireEvent.click(document.querySelector('[data-post-card="derope"]')!);
 await waitFor(()=>expect(screen.getByRole('checkbox',{name:'Keep static background'})).toHaveProperty('checked',true));
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();expect(prepareH3Video).not.toHaveBeenCalled();
 if(saved===true){
  vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('derope-keep','failed'),error:'fixture'});
  fireEvent.click(screen.getByRole('button',{name:'Run'}));
  await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
  expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({videoPost:{derope:{keepBackground:true}}});
 }
});

test('H3 latent upscaler options sit in their own menu, keep separate refine steps and reach Run Plan only when changed',async()=>{
 const files=[
  {category:'diffusion_models',name:'h3.safetensors',family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'},
  {category:'vae',name:'minimax_h3_video_vae_fp16.safetensors'},
  {category:'vae',name:'minimax_h3_audio_vae_fp32.safetensors'}
 ].map(m=>({...m,path:'/m/'+m.name,size:1,info:null}));
 vi.mocked(scanModels).mockResolvedValue(files);
 const h3Model='minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors';
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,schedulers:['simple','beta'],nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','DaSiWaH3TiledUpscale'],h3LatentUpscaleModels:[h3Model]}});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.latent.h3',JSON.stringify({enabled:true,model:h3Model,scale:2,steps:1,denoise:0.2}));
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('tab',{name:'Post-Processing'}));
 await waitFor(()=>expect(document.querySelector('[data-latent-upscale-more]')).not.toBeNull());
 const more=document.querySelector('[data-latent-upscale-more]') as HTMLDetailsElement;
 expect(more.open).toBe(false);
 fireEvent.change(document.querySelector('[data-latent-upscale-steps]')!,{target:{value:'4'}});
 expect(screen.getByText('Upscale refine steps')).toBeTruthy();
 more.open=true;
 fireEvent.change(more.querySelector('[data-latent-advanced="cfg"]')!,{target:{value:'1.5'}});
 fireEvent.change(more.querySelector('[data-latent-advanced="scheduler"]')!,{target:{value:'beta'}});
 expect(more.querySelector('[data-latent-advanced="guardSensitivity"]')).toBeNull();
 fireEvent.click(more.querySelector('[data-latent-advanced="spikeGuard"]')!);
 expect(more.querySelector('[data-latent-advanced="guardSensitivity"]')).not.toBeNull();
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 await waitFor(()=>expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!).latentUpscale).toEqual({model:h3Model,scale:2,steps:4,denoise:0.2,advanced:{cfg:1.5,scheduler:'beta',spikeGuard:true}}));
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-latent-advanced-reset]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-latent-advanced-reset]')!);
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 await waitFor(()=>expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!).latentUpscale).toEqual({model:h3Model,scale:2,steps:4,denoise:0.2}));
});

test.each([[true,true],[false,false]])('H3 2D upscaler is the default model and sends sharpness only when the pack supports it (pack %s)',async(ready,sent)=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'h3.safetensors',family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'},
  {category:'vae',name:'minimax_h3_video_vae_fp16.safetensors'},
  {category:'vae',name:'minimax_h3_audio_vae_fp32.safetensors'}
 ].map(m=>({...m,path:'/m/'+m.name,size:1,info:null})));
 const d3='minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors',d2='minimax_h3_latent_upscaler_2d_conv_v1_fp16.safetensors';
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','DaSiWaH3TiledUpscale'],h3LatentUpscaleModels:[d3,d2],h3LatentSharpness:ready}});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.latent.h3',JSON.stringify({enabled:true,model:'',scale:2,steps:1,denoise:0.2,advanced:{sharpness:4}}));
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('tab',{name:'Post-Processing'}));
 await waitFor(()=>expect((document.querySelector('[data-latent-upscale-model]') as HTMLSelectElement|null)?.value).toBe(d2));
 expect((document.querySelector('[data-latent-advanced="sharpness"]') as HTMLInputElement).disabled).toBe(!ready);
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 await waitFor(()=>expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!).latentUpscale).toEqual({model:d2,scale:2,steps:1,denoise:0.2,...(sent?{advanced:{sharpness:4}}:{})}));
});

test.each([true,false])('H3 temporal join and tile references default to the low-VRAM prefix join and send overrides only to a 0.5.62 pack (pack %s)',async ready=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'h3.safetensors',family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'},
  {category:'vae',name:'minimax_h3_video_vae_fp16.safetensors'},
  {category:'vae',name:'minimax_h3_audio_vae_fp32.safetensors'}
 ].map(m=>({...m,path:'/m/'+m.name,size:1,info:null})));
 const d3='minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors';
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','DaSiWaH3TiledUpscale'],h3LatentUpscaleModels:[d3],h3LowVramTiling:ready}});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.latent.h3',JSON.stringify({enabled:true,model:d3,scale:2,steps:1,denoise:0.2}));
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('tab',{name:'Post-Processing'}));
 await waitFor(()=>expect(document.querySelector('[data-latent-advanced="temporalJoin"]')).not.toBeNull());
 const join=document.querySelector('[data-latent-advanced="temporalJoin"]') as HTMLSelectElement;
 const refs=document.querySelector('[data-latent-advanced="tileReferences"]') as HTMLSelectElement;
 expect([join.value,refs.value]).toEqual(['prefix','full']);
 expect([join.disabled,refs.disabled]).toEqual([!ready,!ready]);
 expect(screen.getAllByText(ready?/hand-off is exact/:/node pack 0\.5\.62/).length).toBeGreaterThan(0);
 // The defaults are DEAS's own: an untouched panel sends no advanced block (the compiler emits prefix + one-tile estimate).
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 await waitFor(()=>expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!).latentUpscale).toEqual({model:d3,scale:2,steps:1,denoise:0.2}));
 fireEvent.change(join,{target:{value:'crossfade'}});
 fireEvent.change(refs,{target:{value:'crop_video'}});
 const residency=document.querySelector('[data-latent-advanced="weightResidency"]') as HTMLSelectElement;
 expect([residency.value,(document.querySelector('[data-latent-advanced="maxResidentGb"]') as HTMLInputElement).value,residency.disabled]).toEqual(['auto','0',!ready]);
 fireEvent.change(document.querySelector('[data-latent-advanced="maxResidentGb"]')!,{target:{value:'6.5'}});
 fireEvent.change(residency,{target:{value:'keep'}});
 await waitFor(()=>expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!).latentUpscale).toEqual({model:d3,scale:2,steps:1,denoise:0.2,...(ready?{advanced:{temporalJoin:'crossfade',tileReferences:'crop_video',maxResidentGb:6.5,weightResidency:'keep'}}:{})}));
 // Stream ignores the cap, so the cap field hides.
 fireEvent.change(residency,{target:{value:'stream'}});
 expect(document.querySelector('[data-latent-advanced="maxResidentGb"]')).toBeNull();
});

test('latent models added after the first capability read are found when Post-Processing opens',async()=>{
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 const ltx='ltx-2.3-spatial-upscaler-x2-1.1.safetensors';
 const allow=(latentUpscaleModels:string[])=>({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','LatentUpscaleModelLoader','LTXVLatentUpsampler'],latentUpscaleModels}});
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(allow([]));
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(checkRecipePrerequisites).toHaveBeenCalled());
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(allow([ltx]));
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 await waitFor(()=>expect((screen.getByLabelText('Latent upscale model') as HTMLSelectElement).value).toBe(ltx));
 fireEvent.click(screen.getByLabelText('Latent upscale after sampling'));
 expect(document.querySelector('[data-latent-upscale-download]')).toBeNull();
});

test('H3 Hi-Res Regenerate card blocks Run on missing node/LoRA, builds the pinned intent and excludes Latent upscale',async()=>{
 vi.mocked(scanModels).mockResolvedValue(h3VideoFiles());
 const d3='minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors',d2='minimax_h3_latent_upscaler_2d_conv_v1_fp16.safetensors',lora='H3/open_h3_regenerate_2k_h3.safetensors';
 const allow=(extraNodes:string[],loras:string[])=>({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','DaSiWaH3TiledUpscale',...extraNodes],h3LatentUpscaleModels:[d2,d3],h3RegenerateTuning:true,loras}});
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(allow([],['style.safetensors']));
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 fireEvent.click(document.querySelector('[data-regenerate-enabled]')!);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 const card=document.querySelector('[data-post-category="regenerate"]')!;
 expect(card.textContent).toContain('DaSiWaH3HiResRegenerate');expect(card.textContent).toContain('0.5.50');expect(card.textContent).toContain('Diffusers → H3');
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(allow(['DaSiWaH3HiResRegenerate'],['style.safetensors',lora]));
 fireEvent.click(screen.getByRole('tab',{name:'Options'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 expect((document.querySelector('[data-regenerate-lora]') as HTMLSelectElement).value).toBe(lora);
 expect([...(document.querySelector('[data-regenerate-lora]') as HTMLSelectElement).options].map(o=>o.value)).not.toContain('style.safetensors');
 expect((document.querySelector('[data-regenerate-model]') as HTMLSelectElement).value).toBe(d3);
 expect(document.querySelector('[data-latent-upscale-enabled]')).toHaveProperty('disabled',true);
 expect(document.querySelector('[data-latent-regenerate-on]')).not.toBeNull();
 fireEvent.change(document.querySelector('[data-regenerate-target]')!,{target:{value:'4K'}});
 fireEvent.click(document.querySelector('[data-regenerate-tiling]')!);
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 const plan=JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
 expect(plan.latentUpscale).toEqual({model:d3,regenerate:{lora,target:'4K',denoise:0.2,spatialTiling:false}});
 const size=regenerateSize(plan.width,plan.height,'4K');
 expect(document.querySelector('[data-plan-stage="latentUpscale"]')?.textContent).toContain(`${size.width} × ${size.height}`);
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 fireEvent.click(document.querySelector('[data-regenerate-tiling]')!);
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!).latentUpscale).toEqual({model:d3,regenerate:{lora,target:'4K',denoise:0.2}});
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 fireEvent.click(document.querySelector('[data-regenerate-enabled]')!);
 fireEvent.click(document.querySelector('[data-latent-upscale-enabled]')!);
 expect(document.querySelector('[data-regenerate-enabled]')).toHaveProperty('disabled',true);
 expect(document.querySelector('[data-regenerate-latent-on]')).not.toBeNull();
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!).latentUpscale).toEqual({model:d2,scale:2,steps:1,denoise:0.2});
});

test('H3 Regenerate exposes an independent persisted LoRA strength and submits explicit zero',async()=>{
 const up='minimax_h3_latent_upscaler_2d_conv_v1_fp16.safetensors',lora='H3/regenerate.safetensors';
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.latent.h3',JSON.stringify({enabled:false,model:up,scale:2,steps:1,denoise:1}));
 localStorage.setItem('deas.pref.studio.run.regenerate.h3',JSON.stringify({enabled:true,lora,target:'2K',model:up,spatialTiling:true,strength:0.65}));
 vi.mocked(scanModels).mockResolvedValue(h3VideoFiles());
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','DaSiWaH3HiResRegenerate'],h3LatentUpscaleModels:[up],loras:[lora]}});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 fireEvent.click(document.querySelector('[data-post-card="regenerate"]')!);
 const strength=document.querySelector('[data-regenerate-strength]') as HTMLInputElement;
 expect(strength).not.toBeNull();expect(strength.value).toBe('0.65');
 expect(strength.min).toBe('0');expect(strength.max).toBe('2');expect(strength.step).toBe('0.05');
 fireEvent.change(strength,{target:{value:'0'}});
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.regenerate.h3')!).strength).toBe(0);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.latent.h3')!).denoise).toBe(1);
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 const plan=JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
 expect(plan.latentUpscale.regenerate).toEqual({lora,target:'2K',strength:0});
 expect(document.querySelector('[data-plan-stage="latentUpscale"]')?.textContent).toContain('Refiner LoRA strength');
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('regenerate-strength','queued',evidence.baseUrl));
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({latentUpscale:plan.latentUpscale});
});

test('H3 Regenerate shares denoise and 2D sharpness bidirectionally with Latent upscale',async()=>{
 const up='minimax_h3_latent_upscaler_2d_conv_v1_fp16.safetensors',lora='H3/regenerate.safetensors';
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.latent.h3',JSON.stringify({enabled:false,model:up,scale:2,steps:1,denoise:0.35,advanced:{sharpness:3}}));
 localStorage.setItem('deas.pref.studio.run.regenerate.h3',JSON.stringify({enabled:true,lora,target:'2K',model:up,spatialTiling:true,strength:0.65}));
 vi.mocked(scanModels).mockResolvedValue(h3VideoFiles());
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','DaSiWaH3HiResRegenerate','DaSiWaH3TiledUpscale'],h3LatentUpscaleModels:[up],h3LatentSharpness:true,h3RegenerateTuning:true,loras:[lora]}});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 fireEvent.click(document.querySelector('[data-post-card="regenerate"]')!);
 const input=(name:string)=>document.querySelector(`[data-${name}]`) as HTMLInputElement;
 expect(input('regenerate-denoise')).not.toBeNull();
 expect(input('regenerate-denoise').value).toBe('0.35');expect(input('regenerate-sharpness').value).toBe('3');
 fireEvent.change(input('regenerate-denoise'),{target:{value:'0.6'}});
 fireEvent.change(input('regenerate-sharpness'),{target:{value:'4'}});
 expect(input('latent-upscale-denoise').value).toBe('0.6');
 expect((document.querySelector('[data-latent-advanced="sharpness"]') as HTMLInputElement).value).toBe('4');
 fireEvent.keyDown(document,{key:'Escape'});fireEvent.click(document.querySelector('[data-post-card="latent"]')!);
 fireEvent.click(document.querySelector('[data-latent-upscale-more] summary')!);
 fireEvent.change(input('latent-upscale-denoise'),{target:{value:'0.4'}});
 fireEvent.change(document.querySelector('[data-latent-advanced="sharpness"]')!,{target:{value:'2'}});
 expect(input('regenerate-denoise').value).toBe('0.4');expect(input('regenerate-sharpness').value).toBe('2');
 expect(input('regenerate-strength').value).toBe('0.65');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.latent.h3')!)).toMatchObject({denoise:0.4,advanced:{sharpness:2}});
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.regenerate.h3')!)).not.toHaveProperty('denoise');
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!).latentUpscale.regenerate).toEqual({lora,target:'2K',strength:0.65,denoise:0.4,sharpness:2});
 view.unmount();
 render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('tab',{name:'Post-Processing'}));
 expect(input('regenerate-denoise').value).toBe('0.4');expect(input('regenerate-sharpness').value).toBe('2');
 fireEvent.click(input('regenerate-enabled'));fireEvent.click(input('latent-upscale-enabled'));
 expect(input('latent-upscale-denoise').value).toBe('0.4');
});

test.each([{denoise:2,sharpness:3},{denoise:0.3,sharpness:7}])('H3 shared refinement controls reject invalid persisted values ($denoise / $sharpness)',async({denoise,sharpness})=>{
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.latent.h3',JSON.stringify({enabled:false,model:'',scale:2,steps:1,denoise,advanced:{sharpness}}));
 vi.mocked(scanModels).mockResolvedValue(h3VideoFiles());
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('tab',{name:'Post-Processing'}));
 await waitFor(()=>expect((document.querySelector('[data-regenerate-denoise]') as HTMLInputElement|null)?.value).toBe('0.2'));
 expect((document.querySelector('[data-regenerate-sharpness]') as HTMLInputElement).value).toBe('1');
 expect((document.querySelector('[data-regenerate-strength]') as HTMLInputElement).value).toBe('1');
});

test.each([{denoise:0.2,sharpness:1,dimension:'3d'},{denoise:1,sharpness:4,dimension:'2d'}])('H3 Regenerate refuses unsupported shared tuning ($dimension)',async({denoise,sharpness,dimension})=>{
 const up=`minimax_h3_latent_upscaler_${dimension}_conv_v1_fp16.safetensors`,lora='H3/regenerate.safetensors';
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.latent.h3',JSON.stringify({enabled:false,model:up,scale:2,steps:1,denoise,advanced:{sharpness}}));
 localStorage.setItem('deas.pref.studio.run.regenerate.h3',JSON.stringify({enabled:true,lora,target:'2K',model:up,spatialTiling:true,strength:0.6}));
 vi.mocked(scanModels).mockResolvedValue(h3VideoFiles());
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','DaSiWaH3HiResRegenerate'],h3LatentUpscaleModels:[up],h3RegenerateTuning:false,loras:[lora]}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('tab',{name:'Post-Processing'}));
 await waitFor(()=>expect((document.querySelector('[data-regenerate-denoise]') as HTMLInputElement).value).toBe(String(denoise)));
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(document.querySelector('[data-post-category="regenerate"]')?.textContent).toContain('0.5.55');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 fireEvent.change(document.querySelector('[data-regenerate-denoise]')!,{target:{value:'1'}});
 if(dimension==='2d')fireEvent.change(document.querySelector('[data-regenerate-sharpness]')!,{target:{value:'1'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 expect((document.querySelector('[data-regenerate-strength]') as HTMLInputElement).value).toBe('0.6');
});

test.each([true,false])('H3 Original bypasses learned upscalers only with node target support (%s)',async supported=>{
 const lora='H3/regenerate.safetensors',saved='remembered-up.safetensors';
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.regenerate.h3',JSON.stringify({enabled:true,lora,target:'Original',model:saved,spatialTiling:true}));
 vi.mocked(scanModels).mockResolvedValue(h3VideoFiles());
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','DaSiWaH3HiResRegenerate'],h3LatentUpscaleModels:[],h3RegenerateOriginal:supported,h3RegenerateTuning:true,loras:[lora]}});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 if(!supported){
  fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
  await waitFor(()=>expect(document.querySelector('[data-post-category="regenerate"]')?.textContent).toContain('0.5.52'));
  expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
  expect(runWorkbenchJob).not.toHaveBeenCalled();return;
 }
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 expect(document.querySelector('[data-regenerate-model]')).toBeNull();
 const target=document.querySelector('[data-regenerate-target]') as HTMLSelectElement;
 expect(target.value).toBe('Original');
 expect(target.selectedOptions[0].textContent).toBe('Regenerate only, keep input resolution');
 expect(document.querySelector('[data-regenerate-enabled]')!.closest('label')!.textContent).toBe('Regenerate only, keep input resolution');
 expect(document.querySelector('[data-post-category="regenerate"]')?.textContent).toContain('may reinterpret details');
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 const plan=JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
 expect(plan.latentUpscale).toEqual({model:'interpolation',regenerate:{lora,target:'Original',denoise:0.2}});
 const stage=document.querySelector('[data-plan-stage="latentUpscale"]')!;
 expect(stage.textContent).toContain('Regenerate only, keep input resolution');
 expect(stage.textContent).toContain(`${plan.width} × ${plan.height}`);
 expect(stage.textContent).not.toContain('interpolation');
 expect(stage.textContent).toContain('may reinterpret details');
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.change(document.querySelector('[data-regenerate-target]')!,{target:{value:'2K'}});
 expect(document.querySelector('[data-regenerate-model]')).toHaveProperty('value',saved);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.regenerate.h3')!).model).toBe(saved);
 fireEvent.change(document.querySelector('[data-regenerate-target]')!,{target:{value:'Original'}});
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('original-regenerate','queued',evidence.baseUrl));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({latentUpscale:plan.latentUpscale});
});

test('H3 Hi-Res Regenerate is offered for H3 video only',async()=>{
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.regenerate.h3',JSON.stringify({enabled:true,lora:'r.safetensors',target:'2K',model:'',spatialTiling:true}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}} planVisible/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-plan-intent]')?.textContent).toContain('ltx-2'));
 expect(JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!)).not.toHaveProperty('latentUpscale');
 cleanup();
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('tab',{name:'Post-Processing'}));
 await waitFor(()=>expect(document.querySelector('[data-post-unavailable="regenerate"]')?.textContent).toBe('MiniMax H3 video pipelines only.'));
});

test.each((['1080P','Original'] as const).flatMap(target=>[false,true].map(tuned=>({target,tuned}))))('history restores H3 Regenerate $target tuning=$tuned without stale strengths or a sentinel upscaler',async({target,tuned})=>{
 localStorage.setItem('deas.pref.studio.run.regenerate.h3',JSON.stringify({enabled:false,lora:'',target:'2K',model:'up.safetensors',spatialTiling:true,strength:0.9}));
 localStorage.setItem('deas.pref.studio.run.latent.h3',JSON.stringify({enabled:true,model:'h3-remembered.safetensors',scale:3,steps:2,denoise:0.3,advanced:{sharpness:6}}));
 const files=h3VideoFiles();
 const h3Record=(latentUpscale:H3LatentUpscale|H3RegenerateUpscale)=>recentHistoryRecord({recipeId:'video-generation',version:1,family:'minimax-h3',positivePrompt:'historic h3',negativePrompt:'',model:files[0].name,textEncoder:files[1].name,vae:files[2].name,seed:19,width:1344,height:768,frames:124,frameRate:24,steps:8,cfg:1,sampler:'euler',scheduler:'simple',outputPrefix:'raw/video/old',output:{codec:'Auto',container:'Auto',bitDepth:'Auto',quality:20,audioCodec:'AAC',audioBitrate:'192k',saveFirstFrame:false,saveLastFrame:false},h3:{mode:'T2VA',audioVae:files[3].name,shiftVideo:10,shiftAudio:3,references:[]},latentUpscale});
 let records=[h3Record({model:target==='Original'?'interpolation':'up.safetensors',regenerate:{lora:'regen.safetensors',target,spatialTiling:false,...(tuned?{strength:0,denoise:0.45,sharpness:4}:{})}})];
 vi.mocked(scanModels).mockResolvedValue(files);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'DEAS_VideoPostprocessGate','DaSiWaH3TiledUpscale','DaSiWaH3HiResRegenerate'],h3LatentUpscaleModels:['up.safetensors'],loras:['regen.safetensors']}});
 vi.mocked(invoke).mockImplementation(async c=>c==='native_jobs_history'?{schemaVersion:1,records,readOnly:false,error:null}:{path:'/env/input',parent:'/env',entries:[],truncated:false});
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Text → Video').disabled).toBe(false));
 await openHistoryRecord();fireEvent.click(document.querySelector('[data-history-apply]')!);
 fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.regenerate.h3')!)).toEqual({enabled:true,lora:'regen.safetensors',target,model:'up.safetensors',spatialTiling:false,...(tuned?{strength:0}:{})});
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.latent.h3')!)).toMatchObject({enabled:false,model:'h3-remembered.safetensors',denoise:tuned?0.45:1,advanced:{sharpness:tuned?4:1}});
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 view.unmount();
 records=[h3Record({model:'up.safetensors',scale:2,steps:1,denoise:0.2})];
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Text → Video').disabled).toBe(false));
 await openHistoryRecord();fireEvent.click(document.querySelector('[data-history-apply]')!);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.regenerate.h3')!)).toMatchObject({enabled:false,lora:'regen.safetensors'});
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.latent.h3')!)).toMatchObject({enabled:true,model:'up.safetensors',scale:2});
});
