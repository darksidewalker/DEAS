import { adopt, askCancel, askConfirm, askDialog, choosePipe, clickMedia, collection, dock, dropTile, evidence, heldJob, ltxModels, sharedNativeDropFailure as nativeDropFailure, sharedNativeDrops as nativeDrops, pipe, projectFixture, promptDrop, recentHistoryRecord, referenceModels, referenceNodes, refsEvidence, reorderReferences, sessionModel, sessionModels, sessionSettings, settingsDrop, videoEvidence } from './Workbench.testHarness';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Workbench } from './Workbench';
import { defaultOptions } from './OptionsPanel';
import { captureStudioSettings } from '../../lib/preferences';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { runWorkbenchJob, readCurrentWorkbench, pollWorkbench, uploadInput, readH3Session, loadDiagnosticJobOutput, exportDiagnosticJobOutput, type JobStatus } from '../../lib/jobs';
import { readImageMetadata } from '../../lib/imageMetadata';

test('latent family preferences persist independently and never replace an explicit missing model',async()=>{
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify('LTX2/ltx.safetensors'));
 localStorage.setItem('deas.pref.studio.run.latent.ltx',JSON.stringify({enabled:false,model:'ltx-missing.safetensors',scale:2,steps:1,denoise:0.2}));
 localStorage.setItem('deas.pref.studio.run.latent.h3',JSON.stringify({enabled:true,model:'h3-missing.safetensors',scale:3,steps:2,denoise:0.3}));
 vi.mocked(scanModels).mockResolvedValue([...ltxModels,{category:'diffusion_models',name:'h3.safetensors',family:'minimax-h3',path:'/m/h3',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,latentUpscaleModels:['ltx-present.safetensors'],h3LatentUpscaleModels:['h3-present.safetensors']}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('LTX2/ltx.safetensors'));
 fireEvent.click(document.querySelector('[data-dock-tab="post"]')!);
 expect(document.querySelector('[data-latent-upscale-model]')).toHaveProperty('value','ltx-missing.safetensors');
 expect(document.querySelector('[data-latent-upscale-enabled]')).toHaveProperty('checked',false);
 fireEvent.change(document.querySelector('[data-model-picker]')!,{target:{value:'h3.safetensors'}});
 expect(document.querySelector('[data-latent-upscale-model]')).toHaveProperty('value','h3-missing.safetensors');
 expect(document.querySelector('[data-latent-upscale-scale]')).toHaveProperty('value','3');
 expect(document.querySelector('[data-latent-upscale-enabled]')).toHaveProperty('checked',true);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 fireEvent.change(document.querySelector('[data-model-picker]')!,{target:{value:'LTX2/ltx.safetensors'}});
 expect(document.querySelector('[data-latent-upscale-model]')).toHaveProperty('value','ltx-missing.safetensors');
 expect(document.querySelector('[data-latent-upscale-enabled]')).toHaveProperty('checked',false);
 expect(document.querySelector('[data-latent-upscale-scale]')).toHaveProperty('value','2');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('latent H3 segment capture is allowed in Continuity with the core baseline decode',async()=>{
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.latent.h3',JSON.stringify({enabled:true,model:'h3-post.safetensors',scale:2,steps:1,denoise:0.2}));
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({enabled:true,session:'test',outputMode:'segment',steps:[{id:'one',seconds:5,action:''}]}));
 vi.mocked(scanModels).mockResolvedValue([{category:'diffusion_models',name:'h3.safetensors',family:'minimax-h3'},{category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'},{category:'vae',name:'minimax_h3_video_vae_fp16.safetensors'},{category:'vae',name:'minimax_h3_audio_vae_fp32.safetensors'}].map(m=>({...m,path:'/m/'+m.name,size:1,info:null})));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','DaSiWaH3TiledUpscale'],h3LatentUpscaleModels:['h3-post.safetensors']}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('button',{name:'Continuity'}));
 const dialog=screen.getByRole('dialog',{name:'Continuity'});
 expect(dialog.textContent).not.toContain('turn off latent upscale');
 expect(dialog.querySelector('[data-cont-run]')).toHaveProperty('disabled',false);
 expect(dialog.querySelector('[data-cont-run-all]')).toHaveProperty('disabled',false);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('Continuity is off by default: planner runs are blocked, ordinary Run stays unconditioned and enabling submits nothing',async()=>{
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 const stored={session:'test',outputMode:'segment',steps:[{id:'one',seconds:5,action:''}]};
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify(stored));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'diffusion_models',name:'h3.safetensors',family:'minimax-h3'},{category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'},{category:'vae',name:'minimax_h3_video_vae_fp16.safetensors'},{category:'vae',name:'minimax_h3_audio_vae_fp32.safetensors'}].map(m=>({...m,path:'/m/'+m.name,size:1,info:null})));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('button',{name:'Continuity · off'}));
 const dialog=screen.getByRole('dialog',{name:'Continuity'});
 expect(dialog.querySelector('[data-cont-run]')).toHaveProperty('disabled',true);
 expect(dialog.querySelector('[data-cont-run-all]')).toHaveProperty('disabled',true);
 fireEvent.click(within(dialog).getByRole('checkbox',{name:'Continuity active'}));
 expect(dialog.querySelector('[data-cont-run]')).toHaveProperty('disabled',false);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.continuity')!)).toEqual({...stored,enabled:true});
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 fireEvent.click(within(dialog).getByRole('checkbox',{name:'Continuity active'}));
 fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('plain','failed'),error:'fixture'});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({family:'minimax-h3'});
 expect((vi.mocked(runWorkbenchJob).mock.lastCall![1] as unknown as {h3:object}).h3).not.toHaveProperty('continuity');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.continuity')!)).toEqual({...stored,enabled:false});
});

test('late latent capability replies from an old endpoint cannot enable the new backend',async()=>{
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.latent.ltx',JSON.stringify({enabled:true,model:'ltx-post.safetensors',scale:2,steps:1,denoise:0.2}));
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 let finish!:(value:Awaited<ReturnType<typeof checkRecipePrerequisites>>)=>void;
 vi.mocked(checkRecipePrerequisites).mockImplementation(url=>url.includes('old')?new Promise(resolve=>{finish=resolve;}):Promise.resolve(videoEvidence));
 const props={roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props} endpoint="http://old:7801"/></I18nProvider>);
 await waitFor(()=>expect(finish).toBeTypeOf('function'));
 view.rerender(<I18nProvider><Workbench {...props} endpoint="http://new:7801"/></I18nProvider>);
 await act(async()=>{});
 await act(async()=>finish({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','LatentUpscaleModelLoader','LTXVLatentUpsampler'],latentUpscaleModels:['ltx-post.safetensors']}}));
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(document.querySelector('.wb-stage-warning')?.textContent).toContain('LatentUpscaleModelLoader');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('a pending capability probe is not a missing latent upscale model',async()=>{
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.latent.ltx',JSON.stringify({enabled:true,model:'ltx-2.3-spatial-upscaler-x2-1.1.safetensors',scale:2,steps:1,denoise:0.2}));
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 let finish!:(value:Awaited<ReturnType<typeof checkRecipePrerequisites>>)=>void;
 vi.mocked(checkRecipePrerequisites).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 render(<I18nProvider><Workbench roots={{models:'/m'}} endpoint="http://127.0.0.1:7801"/></I18nProvider>);
 await waitFor(()=>expect(finish).toBeTypeOf('function'));
 // Backend still answering: Run is disabled by the pending notice alone, the selected model is not reported missing.
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(document.body.textContent).not.toContain('Missing compatible latent upscale model');
 await act(async()=>finish({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','LatentUpscaleModelLoader','LTXVLatentUpsampler'],latentUpscaleModels:['ltx-2.3-spatial-upscaler-x2-1.1.safetensors']}}));
 expect(document.body.textContent).not.toContain('Missing compatible latent upscale model');
});

test.each(['cancel','download'] as const)('missing latent model opens the actual Library offer without automatic work (%s)',async action=>{
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.latent.ltx',JSON.stringify({enabled:false,model:'explicit-missing.safetensors',scale:2,steps:1,denoise:0.2}));
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 const filename='ltx-2.3-spatial-upscaler-x2-1.1.safetensors';
 let installed=false,started=false;
 vi.mocked(checkRecipePrerequisites).mockImplementation(async()=>({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','LatentUpscaleModelLoader','LTXVLatentUpsampler'],latentUpscaleModels:installed?[filename]:[]}}));
 const file={id:'file',label:filename,locator:filename,downloadable:true,kind:'file',url:'https://huggingface.co/file',size:1};
 vi.mocked(invoke).mockImplementation(async c=>{
  if(c==='native_download_catalog')return {version:1,providers:[{id:'huggingface',kind:'huggingface',label:'Hugging Face',origin:'https://huggingface.co',scopes:['repo'],anonymousNotice:''}],entries:[{id:'ltx-latent-upscaler',label:'LTX',providerId:'huggingface',scope:'repo',locator:'models:Lightricks/LTX-2.3',kind:'repo',target:'latent_upscale_models'}]};
  if(c==='native_auth_status')return [];
  if(c==='native_download_browse')return {resources:[file],warnings:[],nextCursor:null};
  if(c==='native_files_present')return [false];
  if(c==='native_download_plan')return {id:'consented',target:'/configured/latent_upscale_models',resources:[file],canExecute:true,warnings:[],totalKnownBytes:1,unknownSizeCount:0};
  if(c==='native_download_start_queue'){started=true;return {state:'running',completed:0,total:1,bytesDownloaded:0,error:null};}
  if(c==='native_download_status'){if(!started)return {state:'idle',completed:0,total:0,bytesDownloaded:0,error:null};installed=true;return {state:'succeeded',completed:1,total:1,bytesDownloaded:1,error:null};}
  return {path:'/input',parent:'/',entries:[],truncated:false};
 });
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} root="/env" roots={{models:'/configured'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('LTX2/ltx.safetensors'));
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 fireEvent.click(screen.getByLabelText('Latent upscale after sampling'));
 const dialog=screen.getByRole('dialog',{name:'Get latent upscale model…'});
 await within(dialog).findByLabelText(filename);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_download_plan'||c==='native_download_start')).toBe(false);
 const before=vi.mocked(checkRecipePrerequisites).mock.calls.length;
 if(action==='download'){
  fireEvent.click(within(dialog).getByLabelText(filename));
  fireEvent.click(within(dialog).getByRole('button',{name:'Download all (1)'}));
  await within(dialog).findByText('Running');
  for(let i=0;i<4;i++){
   await act(async()=>{await new Promise(resolve=>setTimeout(resolve,300));});
   view.rerender(<I18nProvider><Workbench endpoint={evidence.baseUrl} root="/env" roots={{models:'/configured'}}/></I18nProvider>);
  }
  expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_download_status')).toHaveLength(2);
  await within(dialog).findByText('Succeeded');
  expect(invoke).toHaveBeenCalledWith('native_download_plan',{request:{providerId:'huggingface',resources:[file],parentPath:'/configured/latent_upscale_models',folderName:'',authenticated:false}});
  await waitFor(()=>expect(checkRecipePrerequisites).toHaveBeenCalledTimes(before+1));
 }
 fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 expect(screen.getByLabelText('Latent upscale model')).toHaveProperty('value','explicit-missing.safetensors');
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each([true,false])('paired video role selection renders one player even without output root (%s)',async owned=>{
 const job:JobStatus={...heldJob('video-pair','succeeded'),...(owned?{outputRoot:'/old/output'}:{}),outputs:[{filename:'processed.mp4',subfolder:'',type:'output',format:'video/mp4',role:'processed'},{filename:'original.mp4',subfolder:'',type:'output',format:'video/mp4',role:'original'},{filename:'processed-first.png',subfolder:'frames',type:'output',role:'processed'},{filename:'original-last.png',subfolder:'frames',type:'output',role:'original'}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 vi.mocked(loadDiagnosticJobOutput).mockImplementation(async(jobId,index)=>({jobId,index,mimeType:'image/png',width:1,height:1,sha256:'a'.repeat(64),bytes:[137,80,78,71]}));
 vi.stubGlobal('URL',Object.assign(class extends URL {},{createObjectURL:vi.fn(()=>'blob:video-side-frame'),revokeObjectURL:vi.fn()}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-output-role="original"]')).toBeTruthy());
 expect(document.querySelectorAll('.wb-shown video')).toHaveLength(1);
 if(owned){const slider=document.querySelector<HTMLButtonElement>('[data-edit-compare]')!;expect(slider.disabled).toBe(false);fireEvent.click(slider);const original=document.querySelector<HTMLVideoElement>('.wb-compare video')!,edited=document.querySelector<HTMLVideoElement>('.wb-compare-top video')!;expect(original.src).toContain('original.mp4');expect(edited.src).toContain('processed.mp4');const toggle=document.querySelector<HTMLButtonElement>('.wb-compare-play')!;expect(toggle.getAttribute('aria-pressed')).toBe('false');fireEvent.click(toggle);expect(toggle.getAttribute('aria-pressed')).toBe('true');original.currentTime=3;edited.currentTime=0;original.dispatchEvent(new Event('timeupdate'));expect(edited.currentTime).toBe(3);fireEvent.click(slider);expect(document.querySelector('.wb-compare')).toBeNull();}
 fireEvent.click(document.querySelector('[data-output-role="original"]')!);
 expect(document.querySelectorAll('.wb-shown video')).toHaveLength(1);
 expect(document.querySelector('.wb-shown video')?.getAttribute('src')).toContain('original.mp4');
 for(const index of [2,3]){
  fireEvent.click(document.querySelectorAll('.wb-output-choices button')[index]);
  if(owned){
   expect(document.querySelector('.wb-shown img')?.getAttribute('src')).toContain(`/old/output/frames/${job.outputs[index].filename}`);
   expect(loadDiagnosticJobOutput).not.toHaveBeenCalled();
  }else{
   await waitFor(()=>expect(loadDiagnosticJobOutput).toHaveBeenLastCalledWith(job.id,index));
   await waitFor(()=>expect(document.querySelector('[data-job-output-preview]')?.getAttribute('src')).toBe('blob:video-side-frame'));
   expect(loadDiagnosticJobOutput).toHaveBeenCalledTimes(index-1);
  }
  expect(document.querySelectorAll('.wb-shown video')).toHaveLength(0);
 }
 fireEvent.click(document.querySelector('[data-output-role="processed"]')!);
 expect(document.querySelectorAll('.wb-shown video')).toHaveLength(1);
 expect(document.querySelector('.wb-shown video')?.getAttribute('src')).toContain('processed.mp4');
 expect(document.querySelector('.wb-shown img')).toBeNull();
 expect(document.querySelector('[data-job-output-preview]')).toBeNull();
 if(!owned)expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video-side-frame');
});

test.each([false,true])('video workspace navigation seam is optional (%s) and leaves image Post settings intact',async connected=>{
 const onOpen=vi.fn();
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" onOpenVideoPost={connected?onOpen:undefined}/></I18nProvider>);
 await act(async()=>{});
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 expect(document.querySelector('[data-video-post]')).toBeNull();
 const upscale=screen.getByLabelText('Upscale factor');
 fireEvent.change(upscale,{target:{value:'3'}});
 const navigate=document.querySelector('[data-open-video-post]');
 expect(!!navigate).toBe(connected);
 // The TVE link lives inside its own category, never loose above the groups.
 if(navigate)expect(navigate.closest('[data-post-group="tve"]')).not.toBeNull();
 const calls=vi.mocked(invoke).mock.calls.length;
 const probes=vi.mocked(checkRecipePrerequisites).mock.calls.length;
 if(navigate)fireEvent.click(navigate);
 expect(onOpen).toHaveBeenCalledTimes(connected?1:0);
 expect(upscale).toHaveProperty('value','3');
 expect(invoke).toHaveBeenCalledTimes(calls);
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(checkRecipePrerequisites).toHaveBeenCalledTimes(probes);
});

test('paired products select their own actions and compare the encoded baseline, not the editor input',async()=>{
 const intent={recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:'held',negativePrompt:'',checkpoint:'a.safetensors',seed:42,cfg:6,sampler:'euler',scheduler:'normal',outputPrefix:'raw/old',width:1024,height:1024,steps:20,inputImage:'unrelated.png',refine:{width:2048,height:2048,denoise:0.25}} as const;
 const job:JobStatus={...heldJob('pair','succeeded'),outputRoot:'/old/output',intent,outputs:[{filename:'one.png',subfolder:'raw',type:'output',role:'processed'},{filename:'two.png',subfolder:'raw',type:'output',role:'original'}]};
 const captured=JSON.stringify(intent);
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 render(<I18nProvider><Workbench endpoint="http://new:7802/"/></I18nProvider>);
 await waitFor(()=>expect(document.querySelectorAll('[data-job-id="pair"] .wb-queue-select')).toHaveLength(2));
 const queue=document.querySelector('[data-job-id="pair"]')!;
 expect(queue.textContent).toContain('Original (before processing)');expect(queue.textContent).toContain('Processed');
 expect(document.querySelector('.wb-shown img')?.getAttribute('src')).toContain('/old/output/raw/one.png');
 fireEvent.click(document.querySelector('[data-output-role="original"]')!);
 expect(document.querySelector('.wb-shown img')?.getAttribute('src')).toContain('/old/output/raw/two.png');
 clickMedia(document.querySelector<HTMLImageElement>('.wb-shown img')!);
 expect(document.querySelector('.wb-viewer img')?.getAttribute('src')).toContain('/old/output/raw/two.png');
 fireEvent.keyDown(window,{key:'Escape'});
 fireEvent.click(document.querySelector('[data-edit-compare]')!);
 expect(document.querySelector('.wb-compare > img')?.getAttribute('src')).toContain('/old/output/raw/two.png');
 expect(document.querySelector('.wb-compare-top img')?.getAttribute('src')).toContain('/old/output/raw/one.png');
 expect(document.querySelector('.wb-compare')?.textContent).not.toContain('unrelated.png');
 fireEvent.click(queue.querySelectorAll('.wb-queue-select')[0]);
 expect(document.querySelector('.wb-compare')).toBeNull();
 expect(document.querySelector('.wb-shown img')?.getAttribute('src')).toContain('/old/output/raw/one.png');
 expect(document.querySelector('.wb-stage > [data-media-tools] [data-use-input]')).toBeTruthy();
 expect(JSON.stringify(intent)).toBe(captured);expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['failed','cancelled'] as const)('%s keeps a retained baseline accessible without inventing a processed result',async state=>{
 const job:JobStatus={...heldJob('partial',state),outputRoot:'/old/output',outputs:[{filename:'baseline.png',subfolder:'raw',type:'output',role:'original'}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 render(<I18nProvider><Workbench endpoint="http://new:7802/"/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('.wb-shown img')?.getAttribute('src')).toContain('/old/output/raw/baseline.png'));
 expect(document.querySelector('[data-job-id="partial"]')?.textContent).toContain('Original (before processing)');
 expect(document.querySelector('[data-output-role="processed"]')).toBeNull();
 expect(document.querySelector('[data-edit-compare]')).toBeNull();
 expect(document.querySelector('.wb-stage > [data-media-tools] [data-use-input]')).toBeTruthy();
 expect(document.querySelector('.wb-shown .media-star')).toBeTruthy();
});

test.each(['succeeded','failed','cancelled'] as const)('rootless %s baseline uses its native index for preview and export',async state=>{
 const job:JobStatus={...heldJob('bound-pair',state),outputs:[...(state==='succeeded'?[{filename:'final.png',subfolder:'',type:'output' as const,role:'processed' as const}]:[]),{filename:'baseline.png',subfolder:'',type:'output',role:'original'}]};
 const index=job.outputs.length-1;
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 vi.mocked(loadDiagnosticJobOutput).mockImplementation(async(jobId,index)=>({jobId,index,mimeType:'image/png',width:1,height:1,sha256:'a'.repeat(64),bytes:[137,80,78,71]}));
 vi.mocked(exportDiagnosticJobOutput).mockResolvedValue(null);
 vi.stubGlobal('URL',Object.assign(class extends URL {},{createObjectURL:vi.fn(()=>'blob:paired'),revokeObjectURL:vi.fn()}));
 render(<I18nProvider><Workbench endpoint="http://new:7802/"/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-output-role="original"]')).toBeTruthy());
 fireEvent.click(document.querySelectorAll('[data-job-id="bound-pair"] .wb-queue-select')[index]);
 await waitFor(()=>expect(loadDiagnosticJobOutput).toHaveBeenLastCalledWith(job.id,index));
 await waitFor(()=>expect(document.querySelector('[data-job-output-preview]')).toBeTruthy());
 fireEvent.click(document.querySelector('[data-job-output-export]')!);
 await waitFor(()=>expect(exportDiagnosticJobOutput).toHaveBeenCalledWith(job.id,index,expect.any(String)));
 expect(document.querySelector('[data-edit-compare]')).toBeNull();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('ordinary results keep their existing multi-output presentation without paired labels',async()=>{
 const job:JobStatus={...heldJob('ordinary','succeeded'),outputRoot:'/old/output',outputs:[{filename:'a.png',subfolder:'',type:'output'},{filename:'b.png',subfolder:'',type:'output'}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 render(<I18nProvider><Workbench endpoint="http://new:7802/"/></I18nProvider>);
 await waitFor(()=>expect(document.querySelectorAll('.wb-shown img')).toHaveLength(2));
 expect(document.querySelector('[data-output-role]')).toBeNull();expect(document.querySelector('[data-edit-compare]')).toBeNull();
});

test.each(['http://old:7801/','http://new:7802/'])('recovered output uses native root, not endpoint or current environment (%s)',async baseUrl=>{
 const job={...heldJob('old-environment','succeeded',baseUrl),outputRoot:'/old-env/output',outputs:[{filename:'result.png',subfolder:'raw',type:'output' as const}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 vi.mocked(invoke).mockImplementation(async command=>command==='native_media_star_status'?{starred:false,unavailable:null}:{entries:[],truncated:false});
 render(<I18nProvider><Workbench endpoint="http://new:7802/" roots={{output:'/new-env/output'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-job-id="old-environment"] img')?.getAttribute('src')).toContain('/old-env/output/raw/result.png'));
 expect(document.querySelector('.wb-shown img')?.getAttribute('src')).toContain('/old-env/output/raw/result.png');
 expect(document.querySelectorAll('[src*="/new-env/output/"]')).toHaveLength(0);
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_media_star_status',{path:'/old-env/output/raw/result.png'}));
 clickMedia(document.querySelector<HTMLImageElement>('.wb-shown img')!);
 expect(document.querySelector('.wb-viewer img')?.getAttribute('src')).toContain('/old-env/output/raw/result.png');
 fireEvent.keyDown(window,{key:'Escape'});
 fireEvent(window,new CustomEvent('deas-media-relocated',{detail:{oldPath:'/old-env/output/raw/result.png',path:'/old-env/output/starred/result.png'}}));
 await waitFor(()=>expect(document.querySelector('[data-job-id="old-environment"] img')?.getAttribute('src')).toContain('/old-env/output/starred/result.png'));
});

test('unknown output root uses bound preview/export with no local-path actions',async()=>{
 const job={...heldJob('remote-result','succeeded'),outputs:[{filename:'result.png',subfolder:'raw',type:'output' as const}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 vi.mocked(loadDiagnosticJobOutput).mockResolvedValue({jobId:job.id,index:0,mimeType:'image/png',width:1,height:1,sha256:'a'.repeat(64),bytes:[137,80,78,71]});
 vi.mocked(exportDiagnosticJobOutput).mockResolvedValue({path:'/chosen/result.png',sha256:'a'.repeat(64),size:4});
 vi.stubGlobal('URL',Object.assign(class extends URL {},{createObjectURL:vi.fn(()=>'blob:bound-output'),revokeObjectURL:vi.fn()}));
 render(<I18nProvider><Workbench endpoint="http://new:7802/" roots={{output:'/new-env/output'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-job-output-preview]')?.getAttribute('src')).toBe('blob:bound-output'));
 expect(loadDiagnosticJobOutput).toHaveBeenCalledWith(job.id,0);
 expect(document.querySelector('[data-job-id="remote-result"] img')).toBeNull();
 expect(document.querySelector('[data-run-post]')).toBeNull();
 expect(document.querySelector('[data-use-input]')).toBeNull();
 expect(invoke).not.toHaveBeenCalledWith('native_media_star_status',expect.anything());
 expect((screen.getByRole('button',{name:'Star result.png'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(document.querySelector('[data-job-output-export]')!);
 await waitFor(()=>expect(exportDiagnosticJobOutput).toHaveBeenCalledWith(job.id,0,expect.any(String)));
});

test.each(['/new-env/output','/old-env/output'])('recovered image Post-process transfers its native-held file even when UI roots match (%s)',async output=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 localStorage.setItem('deas.pref.studio.run.pipeline','"i2i"');
 const intent={recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:'old',negativePrompt:'',checkpoint:'a.safetensors',seed:42,cfg:6,sampler:'euler',scheduler:'normal',outputPrefix:'raw/old',width:1024,height:1024,steps:20} as const;
 const job={...heldJob('old-image','succeeded'),outputRoot:'/old-env/output',intent,outputs:[{filename:'result.png',subfolder:'raw',type:'output' as const}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/original.png');
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('post','failed'),baseUrl:evidence.baseUrl});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output}}/></I18nProvider>);
 const post=await waitFor(()=>{const post=document.querySelector<HTMLButtonElement>('[data-run-post]');expect(post).not.toBeNull();expect(post!.disabled).toBe(false);return post!;});
 fireEvent.click(post);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(uploadInput).toHaveBeenCalledWith(evidence.baseUrl,'/old-env/output/raw/result.png');
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({inputImage:'deas-inputs/original.png'});
});

test('More stays on a selected image in a video pipeline, between Inpaint and the star, with only its passes disabled',async()=>{
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 vi.mocked(invoke).mockResolvedValue({path:'/out',parent:'/',entries:[{name:'still.png',path:'/out/still.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'still.png'}));
 const bar=await waitFor(()=>{const el=document.querySelector<HTMLElement>('[data-media-tools]');expect(el?.querySelector('summary[data-more]')).not.toBeNull();return el!;});
 const order=[...bar.querySelectorAll('[data-edit="inpaint"], details.wb-more, .media-star')].map(el=>el.matches('.media-star')?'star':el.matches('details')?'more':'inpaint');
 expect(order.indexOf('more')).toBe(order.indexOf('inpaint')+1);
 if(order.includes('star'))expect(order.indexOf('star')).toBeGreaterThan(order.indexOf('more'));
 fireEvent.click(bar.querySelector('summary[data-more]')!);
 expect(bar.querySelector<HTMLButtonElement>('[data-run-post]')).toMatchObject({disabled:true});
 expect(bar.querySelector<HTMLButtonElement>('[data-run-post]')!.title).toContain('image pipeline');
 expect(bar.querySelector<HTMLButtonElement>('[data-more-apply]')!.disabled).toBe(false);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('More offers Refine and Upscale; Upscale runs the pass alone (denoise 0, no sigmas)',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 localStorage.setItem('deas.pref.studio.run.pipeline','"i2i"');
 localStorage.setItem('deas.pref.studio.run.upscale','2');
 const intent={recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:'old',negativePrompt:'',checkpoint:'a.safetensors',seed:42,cfg:6,sampler:'euler',scheduler:'normal',outputPrefix:'raw/old',width:1024,height:1024,steps:20} as const;
 const job={...heldJob('more-image','succeeded'),outputRoot:'/old-env/output',intent,outputs:[{filename:'result.png',subfolder:'raw',type:'output' as const}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/result.png');
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('upscaled','failed'),baseUrl:evidence.baseUrl});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/old-env/output'}}/></I18nProvider>);
 expect(await screen.findByText('More')).toBeTruthy();
 const refine=document.querySelector<HTMLButtonElement>('[data-run-post]')!,up=document.querySelector<HTMLButtonElement>('[data-run-upscale]')!;
 expect(refine.disabled).toBe(false);expect(up.disabled).toBe(false);
 expect(refine.title).toContain('Refine AND Upscale');expect(up.title).toContain('Upscale pass');
 fireEvent.click(up);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const sent=vi.mocked(runWorkbenchJob).mock.calls[0][1];
 expect(sent).toMatchObject({denoise:0,inputImage:'deas-inputs/result.png',width:2048,height:2048});
 expect(sent.sigmas).toBeUndefined(); // upscale-only: sigmas absent (the backend's valid_sigmas rejects an empty [])
 expect(sent.steps).toBeGreaterThan(0); // no empty-tail steps = -1
});

test('preview settings drop reads the dropped file without submitting or replacing the editor source',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(readImageMetadata).mockResolvedValue([['parameters','dropped prompt\nNegative prompt: dropped negative\nSteps: 7, Sampler: Euler, CFG scale: 3, Seed: 11, Size: 512x512, Model: a.safetensors']]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 settingsDrop('/outside/dropped.png');
 await waitFor(()=>expect(screen.getByLabelText('Prompt')).toHaveProperty('value','dropped prompt'));
 expect(screen.getByLabelText('Steps')).toHaveProperty('value','7');
 expect(document.querySelector('[data-browsed-preview]')).not.toBeNull();
 expect(readImageMetadata).toHaveBeenCalledWith('/outside/dropped.png');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test.each(['layer','base'] as const)('queued settings ask before discarding editor %s edits and cancellation preserves the draft',async edited=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const intent={recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:'queued prompt',negativePrompt:'',checkpoint:'a.safetensors',seed:42,cfg:6,sampler:'euler',scheduler:'normal',outputPrefix:'raw/old',width:1024,height:1024,steps:20} as const;
 const job={...heldJob('layer-reuse','succeeded'),baseUrl:evidence.baseUrl,outputRoot:'/out',intent,outputs:[{filename:'result.png',subfolder:'',type:'output' as const}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_media_star_status'?{starred:false,unavailable:null}:{path:(args as {path?:string})?.path??'/out',parent:'/',entries:['source.png','insert.png'].map(name=>({name,path:'/out/'+name,kind:'file',media:'image',symlink:false,size:1,modified:1})),truncated:false});
 vi.stubGlobal('Image',class{naturalWidth=200;naturalHeight=100;onload=()=>{};set src(_:string){queueMicrotask(()=>this.onload());}});
 try{
  render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'source.png'}));adopt();
  const img=screen.getByRole('img',{name:'source.png'});Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);
  fireEvent.click(screen.getByRole('button',{name:'Image to Image'}));
  let layer:HTMLElement;
  if(edited==='base'){layer=screen.getByRole('group',{name:'Base image'});fireEvent.keyDown(layer,{key:'ArrowRight'});expect(layer.style.left).toBe('8px');}
  else{dropTile('insert.png');layer=await screen.findByRole('group',{name:'Inserted image insert.png [output]'});}
  const row=document.querySelector('[data-job-id="layer-reuse"] .wb-queue-select')!;
  (row as HTMLElement).focus();fireEvent.keyDown(row,{key:'F10',shiftKey:true});
  const menuItem=screen.getByRole('menuitem',{name:'Use these settings'});expect(document.activeElement).toBe(menuItem);
  fireEvent.keyDown(menuItem,{key:'Escape'});expect(screen.queryByRole('menu')).toBeNull();expect(document.activeElement).toBe(row);
  fireEvent.keyDown(row,{key:'F10',shiftKey:true});fireEvent.click(screen.getByRole('menuitem',{name:'Use these settings'}));
  expect(askDialog()).not.toBeNull();expect(document.querySelector('[data-editor-viewport]')).not.toBeNull();expect(layer.isConnected).toBe(true);
  expect(screen.getByLabelText('Prompt')).not.toHaveProperty('value','queued prompt');
  askCancel();expect(askDialog()).toBeNull();
  fireEvent.keyDown(row,{key:'ContextMenu'});fireEvent.click(screen.getByRole('menuitem',{name:'Use these settings'}));askConfirm();
  expect(screen.getByLabelText('Prompt')).toHaveProperty('value','queued prompt');expect(layer.isConnected).toBe(false);
  expect(job.intent).toEqual(intent);expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
 }finally{}
});

test('file named schedules and explicit empty LoRAs replace stale same-family settings',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null},{category:'loras',name:'style.safetensors',family:'sdxl',path:'/m/style',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({...defaultOptions,sigmas:'2, 1, 0'}));
 localStorage.setItem('deas.pref.studio.run.loras',JSON.stringify([{name:'style.safetensors',strength:1}]));
 vi.mocked(readImageMetadata).mockResolvedValue([['prompt',JSON.stringify({'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'a.safetensors'}},'5':{class_type:'KSampler',inputs:{model:['1',0],seed:42,steps:20,cfg:4,sampler_name:'euler',scheduler:'normal'}}})]]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')).toHaveProperty('value','a.safetensors'));
 settingsDrop('/outside/named.png');
 await waitFor(()=>expect(captureStudioSettings()['studio.run.options']).toMatchObject({sigmas:''}));
 expect(captureStudioSettings()['studio.run.loras']).toEqual([]);expect(screen.getByLabelText('Steps')).toHaveProperty('value','20');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('file settings resolve LoRAs against the restored model family, not the previous draft',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'diffusion_models',name:'qwen.safetensors',family:'qwen-image-2.1',path:'/m/qwen',size:1,info:null},{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null},{category:'loras',name:'style.safetensors',family:'sdxl',path:'/m/style',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 localStorage.setItem('deas.pref.studio.run.checkpoint','"qwen.safetensors"');
 vi.mocked(readImageMetadata).mockResolvedValue([['parameters','restored <lora:style.safetensors:0.75>\nSteps: 7, Sampler: Euler, CFG scale: 3, Seed: 11, Size: 512x512, Model: a.safetensors']]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')).toHaveProperty('value','qwen.safetensors'));
 settingsDrop('/outside/restored.png');
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')).toHaveProperty('value','a.safetensors'));
 expect(captureStudioSettings()['studio.run.loras']).toEqual([{name:'style.safetensors',strength:0.75,enabled:true}]);
 expect(screen.queryByText(/Not carried over:/)).toBeNull();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['missing.safetensors','same.safetensors','exact.safetensors'])('file settings keep a missing or ambiguous model blocked (%s)',async name=>{
 vi.mocked(scanModels).mockResolvedValue(['a.safetensors','one/same.safetensors','two/same.safetensors','exact.safetensors','exact.safetensors'].map((name,index)=>({category:'checkpoints',name,family:'sdxl',path:'/m/'+index+'/'+name,size:1,info:null})));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(readImageMetadata).mockResolvedValue([['parameters',`restore\nSteps: 7, Sampler: Euler, CFG scale: 3, Seed: 11, Size: 512x512, Model: ${name}`]]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 settingsDrop('/outside/missing.png');
 await waitFor(()=>expect(captureStudioSettings()['studio.run.checkpoint']).toBe(name));
 expect(document.querySelector('[data-run]')).toHaveProperty('disabled',true);
 expect(screen.getByText(new RegExp('Not carried over:.*'+name.replaceAll('.','\\.')))).toBeTruthy();
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['sync','async'] as const)('unavailable native drop API does not crash Studio (%s)',async failure=>{
 nativeDropFailure[failure]=true;
 vi.mocked(scanModels).mockResolvedValue([]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 expect(await screen.findByText('Native file drops are unavailable in this view. Use the media library instead.')).toBeTruthy();
 expect(document.querySelector('[data-workbench]')).not.toBeNull();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('native preview drop is bounded to the visible stage and resolves a local video without uploading',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const previous=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_media_describe'?[{name:'clip.mp4',path:'/outside/clip.mp4',kind:'file',media:'video',size:1,modified:1,symlink:false}]:previous(command,args));
 vi.mocked(readImageMetadata).mockResolvedValue([['parameters','native clip prompt\nSteps: 7, Sampler: Euler, CFG scale: 3, Seed: 11, Size: 512x512']]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 const stage=screen.getByRole('region',{name:'Preview'});
 vi.spyOn(stage,'getBoundingClientRect').mockReturnValue({left:100,top:100,right:500,bottom:500,width:400,height:400,x:100,y:100,toJSON:()=>({})});
 const drop=(x:number,y:number)=>act(()=>{for(const handler of nativeDrops)handler({payload:{type:'drop',paths:['/outside/clip.mp4'],position:{x,y}}});});
 drop(20,20);expect(readImageMetadata).not.toHaveBeenCalled();
 drop(150*window.devicePixelRatio,150*window.devicePixelRatio);
 await waitFor(()=>expect(screen.getByLabelText('Prompt')).toHaveProperty('value','native clip prompt'));
 expect(readImageMetadata).toHaveBeenCalledWith('/outside/clip.mp4');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
 vi.mocked(invoke).mockImplementation(previous);
});

test('native drop positions arrive already logical on WebKitGTK despite fractional scaling',async()=>{
 localStorage.setItem('deas.pref.interface.experience',JSON.stringify('advanced'));
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const previous=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_media_describe'?[{name:'clip.mp4',path:'/outside/clip.mp4',kind:'file',media:'video',size:1,modified:1,symlink:false}]:previous(command,args));
 vi.mocked(readImageMetadata).mockResolvedValue([['parameters','scaled drop prompt\nSteps: 7, Sampler: Euler, CFG scale: 3, Seed: 11, Size: 512x512']]);
 Object.defineProperty(window,'devicePixelRatio',{configurable:true,value:1.25});
 try{
  render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
  await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
  const stage=screen.getByRole('region',{name:'Preview'});
  vi.spyOn(stage,'getBoundingClientRect').mockReturnValue({left:100,top:600,right:500,bottom:800,width:400,height:200,x:100,y:600,toJSON:()=>({})});
  act(()=>{for(const handler of nativeDrops)handler({payload:{type:'drop',paths:['/outside/clip.mp4'],position:{x:300,y:700}}});});
  await waitFor(()=>expect(screen.getByLabelText('Prompt')).toHaveProperty('value','scaled drop prompt'));
 }finally{Object.defineProperty(window,'devicePixelRatio',{configurable:true,value:1});vi.mocked(invoke).mockImplementation(previous);}
});

test('beginner starting image row accepts a native OS drop',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const previous=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_media_describe'?[{name:'clip.png',path:'/m/clip.png',kind:'file',media:'image',size:1,modified:1,symlink:false}]:previous(command,args));
 vi.mocked(readImageMetadata).mockResolvedValue([]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}} beginner/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-beginner-aspect]')).not.toBeNull());
 expect(document.querySelector<HTMLSelectElement>('#beginner-mode')!.value).toBe('image');
 expect(document.querySelector('.beginner-empty-preview')!.textContent).toContain('watch your imagination take shape here');
 const row=await waitFor(()=>{const el=document.querySelector('.beginner-input');if(!el)throw Error('no input row');return el;});
 vi.spyOn(row as HTMLElement,'getBoundingClientRect').mockReturnValue({left:20,top:20,right:320,bottom:80,width:300,height:60,x:20,y:20,toJSON:()=>({})});
 act(()=>{for(const handler of nativeDrops)handler({payload:{type:'drop',paths:['/m/clip.png'],position:{x:170,y:50}}});});
 await waitFor(()=>expect(row.textContent).toContain('clip.png'));
 vi.mocked(invoke).mockImplementation(previous);
});

test.each(['edit','edit back','selection','base','base revert','new drop','unmount'] as const)('late metadata cannot overwrite a newer %s',async change=>{
 vi.mocked(scanModels).mockResolvedValue(['a','b'].map(n=>({category:'checkpoints',name:n+'.safetensors',family:'sdxl',path:'/m/'+n,size:1,info:null})));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 let finish!:(entries:[string,string][])=>void;
 vi.mocked(readImageMetadata).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue([]);
 if(change.startsWith('base'))vi.mocked(invoke).mockImplementation(async command=>command==='native_media_star_status'?{starred:false,unavailable:null}:{path:'/out',parent:'/',entries:[{name:'source.png',path:'/out/source.png',kind:'file',media:'image',symlink:false,size:1,modified:1}],truncated:false});
 const mounted=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 if(change.startsWith('base')){fireEvent.click(await screen.findByRole('button',{name:'source.png'}));adopt();const img=screen.getByRole('img',{name:'source.png'});Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);fireEvent.click(screen.getByRole('button',{name:'Image to Image'}));}
 settingsDrop('/outside/old.png');await waitFor(()=>expect(finish).toBeTypeOf('function'));
 if(change==='edit'||change==='edit back'){const prompt=screen.getByLabelText('Prompt');const previous=(prompt as HTMLTextAreaElement).value;fireEvent.change(prompt,{target:{value:'newer edit'}});if(change==='edit back')fireEvent.change(prompt,{target:{value:previous}});}
 else if(change==='base'||change==='base revert'){const base=screen.getByRole('group',{name:'Base image'});fireEvent.keyDown(base,{key:'ArrowRight'});if(change==='base revert')fireEvent.keyDown(base,{key:'ArrowLeft'});}
 else if(change==='selection')fireEvent.change(document.querySelector('[data-model-picker]')!,{target:{value:'b.safetensors'}});
 else if(change==='new drop'){settingsDrop('/outside/new.png');await screen.findByText('The shown file carries no reusable settings or prompt.');}
 else mounted.unmount();
 await act(async()=>finish([['parameters','stale prompt\nSteps: 7, Sampler: Euler, CFG scale: 3, Seed: 11, Size: 512x512']]));
 if(change!=='unmount')expect(screen.getByLabelText('Prompt')).not.toHaveProperty('value','stale prompt');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('More closes on its own summary and outside clicks; metadata actions apply settings and reuse only the prompt',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 localStorage.setItem('deas.pref.studio.run.pipeline','"i2i"');
 const job={...heldJob('more-menu','succeeded'),outputRoot:'/old-env/output',outputs:[{filename:'result.png',subfolder:'raw',type:'output' as const}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 vi.mocked(readImageMetadata).mockResolvedValue([['parameters','imported prompt\nSteps: 7, Sampler: Euler, CFG scale: 3, Seed: 11, Size: 512x512, Model: a.safetensors']]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/old-env/output'}}/></I18nProvider>);
 const more=await waitFor(()=>{const el=document.querySelector<HTMLButtonElement>('[data-run-post]');expect(el).not.toBeNull();return el;});
 const summary=document.querySelector('summary[data-more]')!;
 expect(more!.disabled).toBe(false);
 fireEvent.click(summary);
 expect(summary.closest('details')!.open).toBe(true);
 fireEvent.click(summary);
 expect(summary.closest('details')!.open).toBe(false);
 fireEvent.click(summary);
 fireEvent.mouseDown(document.body);
 expect(summary.closest('details')!.open).toBe(false);
 fireEvent.click(summary);
 fireEvent.click(document.querySelector('[data-more-apply]')!);
 await waitFor(()=>expect(screen.getByText('Only the settings found in this file were applied; missing settings were left unchanged.')).toBeTruthy());
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('imported prompt');
 expect((screen.getByRole('spinbutton',{name:'Seed'}) as HTMLInputElement).value).toBe('11');
 expect(summary.closest('details')!.open).toBe(false);
 fireEvent.click(summary);
 fireEvent.click(document.querySelector('[data-more-reuse]')!);
 await waitFor(()=>expect(screen.getByText('All settings applied.')).toBeTruthy());
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('imported prompt');
 expect((screen.getByRole('spinbutton',{name:'Seed'}) as HTMLInputElement).value).toBe('11');
});

test('a video gets the More menu: its own job refills the prompt, an uncorrelated file reads metadata',async()=>{
 const made={...heldJob('made','succeeded'),outputRoot:'/out',outputs:[{filename:'clip.mp4',subfolder:'',type:'output' as const}],intent:{recipeId:'video-generation',version:1,family:'ltx-2',positivePrompt:'made clip',negativePrompt:'no blur'} as unknown as JobStatus['intent']};
 const bare={...heldJob('bare','succeeded'),outputRoot:'/out',outputs:[{filename:'other.mp4',subfolder:'',type:'output' as const}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([made,bare]));
 render(<I18nProvider><Workbench endpoint="http://original:7801/" roots={{output:'/out'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-job-id="made"]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-job-id="bare"] .wb-queue-select')!);
 expect((await waitFor(()=>document.querySelector<HTMLButtonElement>('[data-more-apply]')!)).disabled).toBe(false);
 vi.mocked(readImageMetadata).mockResolvedValueOnce([]);
 fireEvent.click(document.querySelector('[data-more-apply]')!);
 await screen.findByText('The shown file carries no reusable settings or prompt.');
 fireEvent.click(document.querySelector('[data-job-id="made"] .wb-queue-select')!);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-more-reuse]')!.disabled).toBe(false));
 fireEvent.click(document.querySelector('[data-more-reuse]')!);
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','made clip');
 expect(document.querySelector('#run-negative')).toHaveProperty('value','no blur');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['all','prompt','stale'] as const)('video More reuses validated saved history before broken file metadata (%s)',async mode=>{
 const {imageFormat,imageCompression,...output}=defaultOptions.output!;void imageFormat;void imageCompression;
 const intent={recipeId:'video-generation',version:1,family:'ltx-2',positivePrompt:'historical film',negativePrompt:'',model:ltxModels[0].name,textEncoder:ltxModels[1].name,vae:ltxModels[3].name,seed:42,width:768,height:512,frames:49,frameRate:24,steps:8,cfg:1,sampler:'euler',scheduler:'simple',outputPrefix:'raw/video/history',output,ltx:{textProjection:ltxModels[2].name,audioVae:ltxModels[4].name,passes:1}} as const;
 const old={...recentHistoryRecord(intent),outputRoot:'/out',outputs:[{filename:'clip.mp4',subfolder:'starred/video/date',type:'output' as const}]};
 const bare={...heldJob('history-file','succeeded'),outputRoot:'/out',outputs:old.outputs};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([bare]));
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,textEncoders:ltxModels.filter(m=>m.category==='text_encoders').map(m=>m.name),vaes:ltxModels.filter(m=>m.category==='vae').map(m=>m.name)}});
 const previous=vi.mocked(invoke).getMockImplementation()!;
 let resolve!:(value:unknown)=>void;
 const snapshot={schemaVersion:1,records:[old],readOnly:false,error:null};
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_jobs_history'?(mode==='stale'?new Promise(done=>{resolve=done;}):snapshot):command==='native_jobs_history_outputs'?['available']:previous(command,args));
 try{
  render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
  await waitFor(()=>expect(document.querySelector('[data-job-id="history-file"]')).not.toBeNull());
  fireEvent.click(document.querySelector('[data-job-id="history-file"] .wb-queue-select')!);
  await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-more-apply]')?.disabled).toBe(false));
  fireEvent.click(document.querySelector(mode==='prompt'?'[data-more-reuse]':'[data-more-apply]')!);
  if(mode==='stale'){
   await waitFor(()=>expect(resolve).toBeTypeOf('function'));
   fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'new draft'}});
   await act(async()=>resolve(snapshot));
   expect(screen.getByLabelText('Prompt')).toHaveProperty('value','new draft');
  }else{
   await waitFor(()=>expect(screen.getByLabelText('Prompt')).toHaveProperty('value','historical film'));
   expect(document.querySelector('#run-negative')).toHaveProperty('value','');
   if(mode==='all'){
    expect(document.querySelector('[data-num="steps"]')).toHaveProperty('value','8');
    expect(document.querySelector('[data-num="cfg"]')).toHaveProperty('value','1');
   }
  }
  expect(readImageMetadata).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
 }finally{vi.mocked(invoke).mockImplementation(previous);}
});

test('video metadata reserves preview space without reopening the player and More stays keyboard usable',async()=>{
 const agent=vi.spyOn(navigator,'userAgent','get').mockReturnValue('Linux');
 const previous=vi.mocked(invoke).getMockImplementation()!;
 const status={position:2,duration:20,width:640,height:360,paused:true,muted:false,volume:100};
 vi.mocked(invoke).mockImplementation(async(command,args)=>command.startsWith('native_video_')?status:previous(command,args));
 const job={...heldJob('metadata-video','succeeded'),outputRoot:'/out',outputs:[{filename:'clip.mp4',subfolder:'raw',type:'output' as const}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 try{
  render(<I18nProvider><Workbench endpoint="http://original:7801/" roots={{output:'/out'}}/></I18nProvider>);
  await waitFor(()=>expect(document.querySelector('[data-job-id="metadata-video"]')).not.toBeNull());
  fireEvent.click(document.querySelector('[data-job-id="metadata-video"] .wb-queue-select')!);
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_video_open',expect.anything()));
  const player=document.querySelector('[data-native-video]');
  fireEvent.click(document.querySelector('[data-metadata-toggle]')!);
  expect(document.querySelector('.wb-stage')?.getAttribute('data-video-metadata')).toBe('true');
  const more=document.querySelector<HTMLElement>('[data-more]')!;
  fireEvent.click(more);expect(more.parentElement).toHaveProperty('open',true);
  fireEvent.keyDown(more,{key:'Escape'});expect(more.parentElement).toHaveProperty('open',false);expect(document.activeElement).toBe(more);
  fireEvent.click(document.querySelector('[data-metadata-toggle]')!);
  expect(document.querySelector('.wb-stage')?.hasAttribute('data-video-metadata')).toBe(false);
  expect(document.querySelector('[data-native-video]')).toBe(player);
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='native_video_open')).toHaveLength(1);
 }finally{cleanup();vi.mocked(invoke).mockImplementation(previous);agent.mockRestore();}
});

test.each([true,false])('native video playback uses captured root when available (owned=%s)',async owned=>{
 const agent=vi.spyOn(navigator,'userAgent','get').mockReturnValue('Linux');
 try{
  const job={...heldJob('old-video','succeeded'),...(owned?{outputRoot:'/old-env/output'}:{}),outputs:[{filename:'clip.mp4',subfolder:'raw',type:'output' as const}]};
  vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
  render(<I18nProvider><Workbench endpoint="http://new:7802/" roots={{output:'/new-env/output'}}/></I18nProvider>);
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_video_open',expect.objectContaining({source:owned?{path:'/old-env/output/raw/clip.mp4'}:{baseUrl:job.baseUrl,filename:'clip.mp4',subfolder:'raw',type:'output'}})));
 }finally{cleanup();agent.mockRestore();}
});

test.each(['reply','lost reply','rejected'] as const)('real IPC admission survives remount before native reservation (%s)',async outcome=>{
 const actual=await vi.importActual<typeof import('../../lib/jobs')>('../../lib/jobs');
 const previous=[vi.mocked(runWorkbenchJob).getMockImplementation(),vi.mocked(readCurrentWorkbench).getMockImplementation(),vi.mocked(pollWorkbench).getMockImplementation()] as const;
 const previousInvoke=vi.mocked(invoke).getMockImplementation();
 let finish!:(job:JobStatus)=>void;let fail!:(error:Error)=>void;
 let snapshot=collection();
 const commands:string[]=[];
 vi.mocked(runWorkbenchJob).mockImplementation(actual.runWorkbenchJob);
 vi.mocked(readCurrentWorkbench).mockImplementation(actual.readCurrentWorkbench);
 vi.mocked(pollWorkbench).mockImplementation(actual.pollWorkbench);
 vi.mocked(invoke).mockImplementation((command,args)=>{
  commands.push(command);
  if(command==='native_workbench_run')return new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
  if(command==='native_workbench_current'||command==='native_workbench_poll')return Promise.resolve(snapshot);
  return previousInvoke!(command,args);
 });
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 const props={endpoint:'http://original:7801/',roots:{models:'/m'}};
 try{
  const first=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
  fireEvent.click(document.querySelector('[data-run]')!);
  await waitFor(()=>expect(commands.filter(c=>c==='native_workbench_run')).toHaveLength(1));
  vi.useFakeTimers();first.unmount();
  render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await act(async()=>{});
  const run=document.querySelector<HTMLButtonElement>('[data-run]')!;
  expect(run.disabled).toBe(true);
  fireEvent.click(run);
  expect(commands.filter(c=>c==='native_workbench_run')).toHaveLength(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(commands.filter(c=>c==='native_workbench_current')).toHaveLength(3);
  expect(commands).not.toContain('native_workbench_poll');
  expect(run.disabled).toBe(true);
  const job=heldJob('late-admitted','queued',props.endpoint);
  await act(async()=>{
   if(outcome!=='rejected')snapshot=collection([job]);
   if(outcome==='reply')finish(job);else fail(new Error(outcome==='lost reply'?'IPC response lost':'Native rejected'));
  });
  // The old mount ignores its reply; only continued collection observation can restore this job.
  expect(document.querySelector('[data-job-id="late-admitted"]')).toBeNull();
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(commands.filter(c=>c==='native_workbench_current')).toHaveLength(4);
  if(outcome!=='rejected'){
   expect(document.querySelector('[data-job-id="late-admitted"]')).not.toBeNull();
   expect(run.disabled).toBe(false);
   snapshot=collection([{...job,state:'failed'}]);
   await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  }
  expect(run.disabled).toBe(false);
  const reads=commands.filter(c=>c.startsWith('native_workbench_')).length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
  expect(commands.filter(c=>c.startsWith('native_workbench_'))).toHaveLength(reads);
 }finally{
  cleanup();vi.useRealTimers();
  vi.mocked(runWorkbenchJob).mockImplementation(previous[0]!);
  vi.mocked(readCurrentWorkbench).mockImplementation(previous[1]!);
  vi.mocked(pollWorkbench).mockImplementation(previous[2]!);
  vi.mocked(invoke).mockImplementation(previousInvoke!);
 }
});

test('terminal admission reconciles native eviction before reopening Run',async()=>{
 const old=Array.from({length:20},(_,i)=>heldJob('old-'+i,'failed'));
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection(old));
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>{const job=heldJob('newest','failed');vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([...old.slice(1),job]));return job;});
 render(<I18nProvider><Workbench endpoint="http://original:7801/" roots={{models:'/m'}}/></I18nProvider>);
 const run=document.querySelector<HTMLButtonElement>('[data-run]')!;
 await waitFor(()=>expect(run.disabled).toBe(false));fireEvent.click(run);
 await waitFor(()=>expect(document.querySelector('[data-job-id="newest"]')).not.toBeNull());
 await waitFor(()=>expect(document.querySelectorAll('[data-job-id]')).toHaveLength(20));
 expect(document.querySelector('[data-job-id="old-0"]')).toBeNull();expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
});

test.each(['unknown','preparing'] as const)('ambiguous Run rejection recovers authoritative %s before another admission',async state=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 let recover!:(value:ReturnType<typeof collection>)=>void;
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>{vi.mocked(readCurrentWorkbench).mockReturnValueOnce(new Promise(yes=>{recover=yes;}));throw new Error('IPC response lost');});
 render(<I18nProvider><Workbench endpoint="http://original:7801/" roots={{models:'/m'}}/></I18nProvider>);
 const run=document.querySelector<HTMLButtonElement>('[data-run]')!;
 await waitFor(()=>expect(run.disabled).toBe(false));fireEvent.click(run);
 await screen.findByText('IPC response lost');expect(run.disabled).toBe(true);
 await waitFor(()=>expect(readCurrentWorkbench).toHaveBeenCalledTimes(2));
 const snapshot=state==='unknown'?collection([heldJob('lost-response','unknown')]):collection([],1);
 vi.mocked(pollWorkbench).mockResolvedValue(snapshot);await act(async()=>recover(snapshot));
 expect(run.disabled).toBe(false);expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
 if(state==='unknown')expect(document.querySelector('[data-job-id="lost-response"]')).not.toBeNull();
});

test('unmount after native admission recovers held work without cancelling or resubmitting',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection());
 let release!:(job:JobStatus)=>void;const held=heldJob('admitted','unknown');
 vi.mocked(runWorkbenchJob).mockImplementation(()=>{vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([held]));return new Promise(yes=>{release=yes;});});
 const props={endpoint:'http://original:7801/',roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 const run=document.querySelector<HTMLButtonElement>('[data-run]')!;
 await waitFor(()=>expect(run.disabled).toBe(false));fireEvent.click(run);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));view.unmount();
 render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-job-id="admitted"]')).not.toBeNull());
 await act(async()=>release({...held,state:'failed'}));
 expect(document.querySelector('[data-job-id="admitted"] [data-state]')?.getAttribute('data-state')).toBe('unknown');
 expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(false);
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
});

test('collection recovery is read-only, preserves every held job and polls mixed endpoints including unknown',async()=>{
 const held=[heldJob('old','running'),heldJob('uncertain','unknown','http://other:7802/'),heldJob('waiting','queued')];
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection(held,1));
 vi.mocked(pollWorkbench).mockResolvedValueOnce(collection([ {...held[0],state:'succeeded'},held[1],{...held[2],state:'failed'}]));
 render(<I18nProvider><Workbench endpoint="http://changed:9999/"/></I18nProvider>);
 await waitFor(()=>expect(document.querySelectorAll('.wb-queue-output')).toHaveLength(3));
 expect(readCurrentWorkbench).toHaveBeenCalledWith();expect(runWorkbenchJob).not.toHaveBeenCalled();
 expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(true);
 await waitFor(()=>expect(pollWorkbench).toHaveBeenCalledTimes(1),{timeout:2500});
 await screen.findByRole('button',{name:/Succeeded/});
 expect(document.querySelectorAll('.wb-queue-output')).toHaveLength(3);
 expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(true);
 expect(pollWorkbench).toHaveBeenCalledWith();expect(readH3Session).not.toHaveBeenCalled();
});

test('collection IPC failure never fabricates unknown states or removes unrelated peers',async()=>{
 const held=[heldJob('one','running'),heldJob('two','queued')];
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection(held));
 vi.mocked(pollWorkbench).mockRejectedValueOnce(new Error('IPC unavailable')).mockResolvedValue(collection(held));
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await screen.findByText('IPC unavailable',{}, {timeout:2500});
 expect(screen.getAllByRole('button',{name:/Running/}).length).toBeGreaterThan(0);
 expect(screen.getByRole('button',{name:/Queued/})).toBeTruthy();
 expect(screen.queryByRole('button',{name:/Unknown/})).toBeNull();
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('late recovery after unmount cannot replace a new Workbench collection',async()=>{
 let resolve!:(value:ReturnType<typeof collection>)=>void;
 vi.mocked(readCurrentWorkbench).mockReturnValueOnce(new Promise(yes=>{resolve=yes;}));
 const view=render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await waitFor(()=>expect(readCurrentWorkbench).toHaveBeenCalledTimes(1));view.unmount();
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([heldJob('new','cancelled')]));
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await screen.findByRole('button',{name:/Cancelled/});
 await act(async()=>resolve(collection([heldJob('stale','running')])));
 expect(screen.queryByRole('button',{name:/Running/})).toBeNull();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('unresolved recovery blocks admission; recovered preparation keeps Run and Stop reachable',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 let resolve!:(value:ReturnType<typeof collection>)=>void;
 vi.mocked(readCurrentWorkbench).mockReturnValueOnce(new Promise(yes=>{resolve=yes;}));
 vi.mocked(pollWorkbench).mockResolvedValue(collection());
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'a.safetensors'});
 const run=screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 expect(run.disabled).toBe(true);fireEvent.click(run);expect(runWorkbenchJob).not.toHaveBeenCalled();
 await act(async()=>resolve(collection([],1)));
 expect(run.disabled).toBe(false);expect(screen.getByRole('button',{name:'Stop'})).toBeTruthy();
 await waitFor(()=>expect(run.disabled).toBe(false),{timeout:2500});
 expect(runWorkbenchJob).not.toHaveBeenCalled();await waitFor(()=>expect(pollWorkbench).toHaveBeenCalledTimes(1),{timeout:2500});
});

test('late collection poll after unmount cannot alter a remounted queue',async()=>{
 vi.mocked(readCurrentWorkbench).mockResolvedValueOnce(collection([heldJob('old','running')]));
 let resolve!:(value:ReturnType<typeof collection>)=>void;
 vi.mocked(pollWorkbench).mockReturnValueOnce(new Promise(yes=>{resolve=yes;}));
 const view=render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await waitFor(()=>expect(pollWorkbench).toHaveBeenCalledTimes(1),{timeout:2500});view.unmount();
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([heldJob('new','cancelled')]));
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await screen.findByRole('button',{name:/Cancelled/});
 await act(async()=>resolve(collection([heldJob('old','succeeded')])));
 expect(screen.queryByRole('button',{name:/Succeeded/})).toBeNull();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each([
 ['BACKEND_UNAVAILABLE', 'Backend not reachable'],
 ['BACKEND_TIMEOUT', 'did not respond in time'],
])('Studio displays friendly discovery failure %s without claiming the model is ready',async(code,expected)=>{
 const previous=vi.mocked(checkRecipePrerequisites).getMockImplementation()!;
 vi.mocked(checkRecipePrerequisites).mockRejectedValue(new Error(`${code}: object_info request failed http://127.0.0.1:45519/object_info`));
 try{
  render(<I18nProvider><Workbench endpoint="http://127.0.0.1:45519"/></I18nProvider>);
  dock('Models');
  fireEvent.click(document.querySelector('[data-run-load]')!);
  await screen.findByText(new RegExp(expected));
  expect(document.body.textContent).not.toContain('object_info request failed');
  expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(true);
  expect(runWorkbenchJob).not.toHaveBeenCalled();
 }finally{vi.mocked(checkRecipePrerequisites).mockImplementation(previous);}
});

test.each(['success','failure'] as const)('switching model folders scans the installed root and ignores an old scan %s',async(outcome)=>{
 let resolve!:(models:Awaited<ReturnType<typeof scanModels>>)=>void;let reject!:(reason:Error)=>void;
 const old=new Promise<Awaited<ReturnType<typeof scanModels>>>((yes,no)=>{resolve=yes;reject=no;});
 const model=(name:string)=>({category:'checkpoints',name,family:'sdxl',path:'/installed/'+name,size:1,info:null});
 vi.mocked(scanModels).mockImplementation(path=>path==='/old'?old:Promise.resolve([model('installed.safetensors')]));
 const view=render(<I18nProvider><Workbench endpoint="" roots={{models:'/old'}}/></I18nProvider>);
 await waitFor(()=>expect(scanModels).toHaveBeenCalledWith('/old',[]));
 view.rerender(<I18nProvider><Workbench endpoint="" roots={{models:'/installed'}}/></I18nProvider>);
 await waitFor(()=>expect(scanModels).toHaveBeenCalledWith('/installed',[]));
 dock('Models');await screen.findByRole('button',{name:'installed.safetensors'});
 await act(async()=>{if(outcome==='success')resolve([model('stale.safetensors')]);else reject(new Error('stale scan failed'));});
 expect(screen.getByRole('button',{name:'installed.safetensors'})).toBeTruthy();
 expect(screen.queryByRole('button',{name:'stale.safetensors'})).toBeNull();
 expect(screen.queryByText('stale scan failed')).toBeNull();
});

test('separate Presets saves live settings, reloads across remounts and updates explicitly without executing',async()=>{
 let stored:unknown[]=[];
 vi.mocked(invoke).mockImplementation(async(command,args)=>{
  if(command==='native_presets_read')return structuredClone(stored);
  if(command==='native_presets_write'){stored=structuredClone((args as {presets:unknown[]}).presets);return;}
  return {path:'/input',parent:'/',entries:[],truncated:false};
 });
 const mount=()=>render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 let view=mount();
 expect(screen.getByRole('tab',{name:'Wildcards'})).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'saved prompt'}});
 fireEvent.change(screen.getByLabelText('Steps'),{target:{value:'31'}});
 dock('Presets');
 await waitFor(()=>expect((screen.getByRole('button',{name:'New preset…'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'New preset…'}));
 const presetDialog=screen.getByRole('dialog',{name:'New preset'});
 fireEvent.change(within(presetDialog).getByRole('textbox',{name:'Preset name'}),{target:{value:'My settings'}});
 fireEvent.click(within(presetDialog).getByRole('button',{name:'Save preset'}));
 await screen.findByText('Preset saved.');
 expect(stored).toEqual([{name:'My settings',settings:expect.objectContaining({'studio.run.positive':'saved prompt','studio.run.steps':31})}]);
 expect((stored[0] as {settings:object}).settings).not.toHaveProperty('studio.run.recentSeeds');
 expect((stored[0] as {settings:object}).settings).not.toHaveProperty('studio.run.continuity');
 // Only differences from the defaults are stored, so later default changes reach the rest.
 expect((stored[0] as {settings:object}).settings).not.toHaveProperty('studio.run.negative');
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'changed'}});
 view.unmount();view=mount();
 const menu=async()=>{fireEvent.contextMenu(await screen.findByRole('button',{name:/My settings/}));return within(screen.getByRole('menu',{name:'My settings'}));};
 fireEvent.click((await menu()).getByRole('menuitem',{name:'Apply'}));
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('saved prompt');
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('31');
 fireEvent.change(screen.getByLabelText('Steps'),{target:{value:'27'}});
 fireEvent.click((await menu()).getByRole('menuitem',{name:'Overwrite with current settings'}));
 askCancel(); // cancel keeps the stored settings
 expect((stored[0] as {settings:Record<string,unknown>}).settings['studio.run.steps']).toBe(31);
 fireEvent.click((await menu()).getByRole('menuitem',{name:'Overwrite with current settings'}));askConfirm();
 await screen.findByText('Preset saved.');
 expect((stored[0] as {settings:Record<string,unknown>}).settings['studio.run.steps']).toBe(27);
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('Linux native input never creates a WebKit video decoder',async()=>{
 vi.spyOn(window.navigator,'userAgent','get').mockReturnValue('Linux');
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'clip.webm',path:'/input/clip.webm',kind:'file',media:'video',size:1,modified:1}],truncated:false});
 const view=render(<I18nProvider><Workbench endpoint="" roots={{input:'/input'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'clip.webm'}));
 expect(view.container.querySelector('video')).toBeNull();
 expect(view.container.querySelector('[data-native-video]')).not.toBeNull();
 vi.restoreAllMocks();
});

test.each(['/output','/external'])('media thumbnail drop retains the prompt and uploads ReVision input on explicit Run (root=%s)',async output=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'CLIPVisionLoader','LoadImage','CLIPVisionEncode','unCLIPConditioning'],visionModels:['clip_vision_g.safetensors']}});
 vi.mocked(invoke).mockImplementation(async command=>command==='native_media_star_status'?{starred:false,unavailable:null}:{path:'/output',parent:null,entries:[{name:'ref.png',path:'/output/ref.png',kind:'file',media:'image',size:1,modified:1,symlink:false}],truncated:false});
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/ref.png');
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('reference-job','failed'));
 localStorage.setItem('deas.pref.studio.run.positive','"unchanged prompt"');
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output}}/></I18nProvider>);
 const tile=await screen.findByRole('button',{name:'ref.png'});
 const data=new Map([['text/uri-list','asset://localhost/thumbnail.png']]);
 const transfer={clearData:()=>data.clear(),setData:(k:string,v:string)=>data.set(k,v),getData:(k:string)=>data.get(k)??'',get types(){return [...data.keys()];},effectAllowed:'uninitialized',dropEffect:'none'};
 const image=await waitFor(()=>{const image=tile.querySelector('img');expect(image).not.toBeNull();return image!;});
 fireEvent.dragStart(image,{dataTransfer:transfer});
 expect(transfer.types).toEqual(['application/x-deas-media','application/x-deas-image']);
 const prompt=screen.getByRole('textbox',{name:'Prompt'});
 expect(fireEvent.dragOver(prompt,{dataTransfer:transfer})).toBe(false);
 expect(transfer.dropEffect).toBe('copy');
 fireEvent.drop(prompt,{dataTransfer:transfer});
 expect(document.querySelector('[data-reference-controls] img')?.getAttribute('alt')).toBe('ref.png');
 expect((prompt as HTMLTextAreaElement).value).toBe('unchanged prompt');
 expect(uploadInput).not.toHaveBeenCalled();
 fireEvent.change(document.querySelector('[data-reference-chip] select')!,{target:{value:'clip_vision_g.safetensors'}});
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(uploadInput).toHaveBeenCalledWith(evidence.baseUrl,'/output/ref.png');
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({positivePrompt:'unchanged prompt',imageReference:{visionModel:'clip_vision_g.safetensors',images:[{image:'deas-inputs/ref.png',strength:0.6}]}});
});

test.each(['qwen-image-2.1','qwen-image-2.1-turbo','krea-2','moss-image'])('native prompt references preview and submit an immutable upload snapshot (%s)',async family=>{
 const method=family==='qwen-image-2.1-turbo'?'qwen-image-2.1':family;
 const width=method==='qwen-image-2.1'?1024:1008;
 vi.mocked(scanModels).mockResolvedValue(referenceModels(family));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...refsEvidence,allowlist:{...refsEvidence.allowlist,nodes:[...refsEvidence.allowlist.nodes,...referenceNodes,'DEAS_ImagePromptEncode','UNETLoader','CLIPLoader','VAELoader','EmptyFlux2LatentImage','SkipLayerGuidanceDiTSimple'],clipTypes:['moss_image'],visionModels:['clip_vision_g.safetensors']}});
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('qwen-reference','failed'));
 localStorage.setItem('deas.pref.studio.run.checkpoint','"qwen.safetensors"');
 localStorage.setItem('deas.pref.studio.run.width','1008');localStorage.setItem('deas.pref.studio.run.height','1008');
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1008');
 expect(promptDrop().dropEffect).toBe('copy');
 expect(document.querySelector('[data-reference-controls] img')?.getAttribute('alt')).toBe('ref.png');
 expect(document.querySelector('[data-reference-chip] select')).toBeNull();
 expect(screen.queryByLabelText('Reference strength')).toBeNull();
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe(String(width));
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 const preview=JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
 expect(preview.nativeImageReference).toEqual({method,images:['/outside/ref.png']});
 expect(document.querySelector('.run-plan')!.textContent).toContain('ref.png');
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 let release!:(name:string)=>void;vi.mocked(uploadInput).mockReturnValueOnce(new Promise(yes=>{release=yes;}));
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(uploadInput).toHaveBeenCalledWith(evidence.baseUrl,'/outside/ref.png'));
 fireEvent.click(document.querySelector('[data-reference-remove]')!);
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1008');
 fireEvent.change(screen.getByRole('combobox',{name:'Checkpoint'}),{target:{value:'a.safetensors'}});
 await act(async()=>release('deas-inputs/captured.png'));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({checkpoint:'qwen.safetensors',width,height:width,nativeImageReference:{method,images:['deas-inputs/captured.png']}});
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).not.toHaveProperty('imageReference');
});

test('vision offer card shows the hosting platform and downloads via the Library flow',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 let installed=false,started=false;
 const file={id:'cv',label:'clip_vision_g.safetensors',locator:'clip_vision_g.safetensors',downloadable:true,kind:'file',url:'https://huggingface.co/file',size:1};
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'CLIPVisionLoader','LoadImage','CLIPVisionEncode','unCLIPConditioning'],visionModels:installed?['clip_vision_g.safetensors']:[]}});
 vi.mocked(invoke).mockImplementation(async c=>{
  if(c==='native_download_catalog')return {version:1,providers:[{id:'huggingface',kind:'huggingface',label:'Hugging Face',origin:'https://huggingface.co',scopes:['repo'],anonymousNotice:''},{id:'civitai',kind:'civitai',label:'CivitAI',origin:'https://civitai.com',scopes:['model','search'],anonymousNotice:''}],entries:[{id:'clip-vision-revision',label:'SDXL ReVision vision tower',providerId:'huggingface',scope:'repo',locator:'models:comfyanonymous/clip_vision_g',kind:'repo',target:'clip_vision'},{id:'clip-vision-revision-civitai',label:'ReVision CivitAI mirror',providerId:'civitai',scope:'search',locator:'clip vision bigG',kind:'model',target:'clip_vision'}]};
  if(c==='native_auth_status')return [];
  if(c==='native_download_browse')return {resources:[file],warnings:[],nextCursor:null};
  if(c==='native_files_present')return [installed];
  if(c==='native_download_plan')return {id:'cvplan',target:'/configured/clip_vision',resources:[file],canExecute:true,warnings:[],totalKnownBytes:1,unknownSizeCount:0};
  if(c==='native_download_start_queue'){started=true;return {state:'running',completed:0,total:1,bytesDownloaded:0,error:null};}
  if(c==='native_download_status'){if(!started)return {state:'idle',completed:0,total:0,bytesDownloaded:0,error:null};installed=true;return {state:'succeeded',completed:1,total:1,bytesDownloaded:1,error:null};}
  return {path:'/input',parent:'/',entries:[],truncated:false};
 });
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} root="/env" roots={{models:'/configured'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('a.safetensors'));
 expect(promptDrop().dropEffect).toBe('copy');
 const dialog=await screen.findByRole('dialog',{name:/No CLIP vision model installed/});
 expect(document.querySelector('[data-vision-download]')).not.toBeNull();
 for(const [text,tag] of [['SDXL ReVision vision tower','strong'],['ReVision CivitAI mirror','strong'],['Hugging Face','em.download-auth'],['CivitAI','em.download-auth']] as const)expect(within(dialog).getByText(text,{selector:tag})).not.toBeNull();
 const before=vi.mocked(checkRecipePrerequisites).mock.calls.length;
 await within(dialog).findByLabelText('clip_vision_g.safetensors');
 fireEvent.click(within(dialog).getByLabelText('clip_vision_g.safetensors'));
 fireEvent.click(within(dialog).getByRole('button',{name:'Download all (1)'}));
 await within(dialog).findByText('Running');
 for(let i=0;i<4;i++){
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,300));});
  view.rerender(<I18nProvider><Workbench endpoint={evidence.baseUrl} root="/env" roots={{models:'/configured'}}/></I18nProvider>);
 }
 await screen.findByText('Succeeded',undefined,{timeout:2000});
 expect(invoke).toHaveBeenCalledWith('native_download_plan',{request:{providerId:'huggingface',resources:[file],parentPath:'/configured/clip_vision',folderName:'',authenticated:false}});
 await waitFor(()=>expect(checkRecipePrerequisites).toHaveBeenCalledTimes(before+1));
});

test.each(['qwen-image-2.1','qwen-image-2.1-turbo','krea-2','moss-image'])('reference thumbnails reorder, renumber and submit captured positions (%s)',async family=>{
 vi.mocked(scanModels).mockResolvedValue(referenceModels(family));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...refsEvidence,allowlist:{...refsEvidence.allowlist,nodes:[...refsEvidence.allowlist.nodes,...referenceNodes,'DEAS_ImagePromptEncode','UNETLoader','CLIPLoader','VAELoader','EmptyFlux2LatentImage','SkipLayerGuidanceDiTSimple'],clipTypes:['moss_image']}});
 localStorage.setItem('deas.pref.studio.run.checkpoint','"qwen.safetensors"');
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('reordered-reference','failed'));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 const cards=()=>Array.from(document.querySelectorAll<HTMLElement>('[data-reference-controls]'));
 const names=()=>cards().map(card=>card.querySelector('img')!.alt);
 promptDrop('image','/outside/one.png');promptDrop('image','/outside/two.png');
 const data=new Map([['text/uri-list','asset://localhost/one.png'],['application/x-deas-media','stale']]);
 const transfer={clearData:()=>data.clear(),setData:(key:string,value:string)=>data.set(key,value),getData:(key:string)=>data.get(key)??'',get types(){return [...data.keys()];},effectAllowed:'uninitialized',dropEffect:'none'};
 fireEvent.dragStart(cards()[0],{dataTransfer:transfer});
 expect(transfer.types).toEqual(['application/x-deas-reference-order']);expect(transfer.effectAllowed).toBe('move');
 const prompt=screen.getByRole('textbox',{name:'Prompt'});
 expect(fireEvent.dragOver(prompt,{dataTransfer:transfer})).toBe(true);fireEvent.drop(prompt,{dataTransfer:transfer});
 expect(names()).toEqual(['one.png','two.png']);
 expect(fireEvent.dragOver(cards()[1],{dataTransfer:transfer})).toBe(false);expect(transfer.dropEffect).toBe('move');
 fireEvent.drop(cards()[1],{dataTransfer:transfer});fireEvent.dragEnd(cards()[0],{dataTransfer:transfer});
 expect(names()).toEqual(['two.png','one.png']);
 promptDrop('image','/outside/three.png');promptDrop('image','/outside/four.png');
 expect(promptDrop('image','/outside/five.png').dropEffect).toBe('none');expect(cards()).toHaveLength(4);
 expect(cards().map(card=>card.dataset.referencePosition)).toEqual(['1','2','3','4']);
 expect(cards().map(card=>card.querySelector('.wb-reference-position')!.textContent)).toEqual(['1','2','3','4']);
 for(const card of cards()){
  const img=card.querySelector('img')!;expect(img.draggable).toBe(false);expect(img.title).toBe(img.alt);
  expect(card.textContent).not.toContain('.png');
  for(const button of card.querySelectorAll('button'))expect(button.type).toBe('button');
 }
 expect(document.querySelector('[data-reference-move]')).toBeNull();
 reorderReferences(1,2);
 expect(names()).toEqual(['two.png','three.png','one.png','four.png']);
 let release!:(name:string)=>void;
 vi.mocked(uploadInput).mockReturnValueOnce(new Promise(yes=>{release=yes;})).mockImplementation(async(_endpoint,path)=>`uploaded/${path.split('/').at(-1)}`);
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(4));
 reorderReferences(3,2);
 fireEvent.click(screen.getByRole('button',{name:'Remove reference · 2'}));
 expect(names()).toEqual(['two.png','four.png','one.png']);
 expect(cards().map(card=>card.dataset.referencePosition)).toEqual(['1','2','3']);
 await act(async()=>release('uploaded/two.png'));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(uploadInput).mock.calls.map(call=>call[1])).toEqual(['/outside/two.png','/outside/three.png','/outside/one.png','/outside/four.png']);
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({nativeImageReference:{method:family==='qwen-image-2.1-turbo'?'qwen-image-2.1':family,images:['uploaded/two.png','uploaded/three.png','uploaded/one.png','uploaded/four.png']}});
});

test.each([
 ['en','Reference 1'],['de','Referenz 1'],['fr','Référence 1'],
 ['ja','参照 1'],['ru','Референс 1'],['tr','Referans 1'],['zh','参考图 1'],
])('reference controls are localized and duplicate attachments remain independent (%s)',async(locale,position)=>{
 localStorage.setItem('deas.locale.v1',locale);localStorage.setItem('deas.pref.studio.run.checkpoint','"qwen.safetensors"');
 vi.mocked(scanModels).mockResolvedValue(referenceModels());
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...refsEvidence,allowlist:{...refsEvidence.allowlist,nodes:[...refsEvidence.allowlist.nodes,...referenceNodes]}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 const item={name:'same.png',src:'asset://localhost/same.png',path:'/outside/same.png',media:'image'};
 const transfer={types:['application/x-deas-media'],getData:()=>JSON.stringify(item)};
 for(let i=0;i<2;i++)fireEvent.drop(document.querySelector('[data-run-positive]')!,{dataTransfer:transfer});
 expect(screen.getByRole('group',{name:position})).toBeTruthy();
 reorderReferences(0,1);
 expect(document.querySelectorAll('[data-reference-controls]')).toHaveLength(2);
 fireEvent.click(document.querySelector('[data-reference-remove]')!);
 expect(document.querySelectorAll('[data-reference-controls]')).toHaveLength(1);
 expect(document.querySelector('[data-reference-controls]')?.getAttribute('data-reference-position')).toBe('1');
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('ReVision uploads ordered external references with captured vision model and strengths despite authoring edits',async()=>{
 vi.mocked(scanModels).mockResolvedValue(referenceModels());
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...refsEvidence,allowlist:{...refsEvidence.allowlist,nodes:[...refsEvidence.allowlist.nodes,'CLIPVisionLoader','LoadImage','CLIPVisionEncode','unCLIPConditioning'],visionModels:['first.safetensors','second.safetensors']}});
 localStorage.setItem('deas.pref.studio.run.checkpoint','"a.safetensors"');
 localStorage.setItem('deas.pref.studio.run.imageRef.vision','"first.safetensors"');
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('revision-snapshot','failed'));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 promptDrop();promptDrop('image','C:\\Pictures\\second.png');
 fireEvent.change(screen.getAllByLabelText('Reference strength')[1],{target:{value:'0.2'}});
 reorderReferences(1,0);
 expect(screen.getAllByLabelText('Reference strength').map(input=>(input as HTMLInputElement).value)).toEqual(['0.2','0.6']);
 let release!:(name:string)=>void;
 vi.mocked(uploadInput).mockReturnValueOnce(new Promise(yes=>{release=yes;})).mockResolvedValueOnce('deas-inputs/second.png');
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(2));
 reorderReferences(0,1);
 fireEvent.change(screen.getByLabelText('CLIP-vision model'),{target:{value:'second.safetensors'}});
 fireEvent.change(screen.getAllByLabelText('Reference strength')[0],{target:{value:'0.9'}});
 fireEvent.click(document.querySelector('[data-reference-remove]')!);
 fireEvent.change(screen.getByRole('combobox',{name:'Checkpoint'}),{target:{value:'qwen.safetensors'}});
 await act(async()=>release('deas-inputs/first.png'));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(uploadInput).mock.calls.map(call=>call[1])).toEqual(['C:\\Pictures\\second.png','/outside/ref.png']);
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({checkpoint:'a.safetensors',imageReference:{visionModel:'first.safetensors',images:[{image:'deas-inputs/first.png',strength:0.2},{image:'deas-inputs/second.png',strength:0.6}]}});
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).not.toHaveProperty('nativeImageReference');
});

test.each(['qwen-image-2.1','qwen-image-2.1-turbo','krea-2','moss-image'])('native references coexist with the image-to-image source (%s)',async family=>{
 const method=family==='qwen-image-2.1-turbo'?'qwen-image-2.1':family,width=method==='qwen-image-2.1'?992:1008;
 vi.mocked(scanModels).mockResolvedValue(referenceModels(family));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...refsEvidence,allowlist:{...refsEvidence.allowlist,nodes:[...refsEvidence.allowlist.nodes,...referenceNodes,'DEAS_ImagePromptEncode','UNETLoader','CLIPLoader','VAELoader','EmptyFlux2LatentImage','SkipLayerGuidanceDiTSimple','VAEEncode'],clipTypes:['moss_image']}});
 vi.mocked(invoke).mockImplementation(async()=>({path:'/env/input',parent:'/env',entries:[{name:'source.png',path:'/env/input/source.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/ref.png');
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('qwen-i2i','failed'));
 localStorage.setItem('deas.pref.studio.run.checkpoint','"qwen.safetensors"');
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/env/input'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'source.png'}));adopt();choosePipe('Image → Image');
 const source=screen.getByRole('img',{name:'source.png'});Object.defineProperties(source,{naturalWidth:{value:1008},naturalHeight:{value:1008}});fireEvent.load(source);
 expect(promptDrop().dropEffect).toBe('copy');
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({inputImage:'source.png',width,height:width,nativeImageReference:{method,images:['deas-inputs/ref.png']}});
});

test('native reference upload failure never submits an unresolved local filename',async()=>{
 vi.mocked(scanModels).mockResolvedValue(referenceModels());
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...refsEvidence,allowlist:{...refsEvidence.allowlist,nodes:[...refsEvidence.allowlist.nodes,...referenceNodes]}});
 localStorage.setItem('deas.pref.studio.run.checkpoint','"qwen.safetensors"');
 vi.mocked(uploadInput).mockRejectedValueOnce(new Error('Reference upload failed'));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));promptDrop();
 fireEvent.click(document.querySelector('[data-run]')!);
 await screen.findByText('Reference upload failed');expect(runWorkbenchJob).not.toHaveBeenCalled();
 expect(document.querySelector('[data-reference-controls] img')?.getAttribute('alt')).toBe('ref.png');
});

test.each(['krea-2','moss-image'])('native adapter references require the installed image-prompt node (%s)',async family=>{
 vi.mocked(scanModels).mockResolvedValue(referenceModels(family));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...refsEvidence,allowlist:{...refsEvidence.allowlist,nodes:[...refsEvidence.allowlist.nodes,'UNETLoader','CLIPLoader','VAELoader','EmptyFlux2LatentImage','SkipLayerGuidanceDiTSimple','LoadImage'],clipTypes:['moss_image']}});
 localStorage.setItem('deas.pref.studio.run.checkpoint','"qwen.safetensors"');
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 expect(promptDrop().dropEffect).toBe('copy');
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain('DEAS_ImagePromptEncode');
 expect(document.querySelector('[data-reference-chip] select')).toBeNull();expect(screen.queryByLabelText('Reference strength')).toBeNull();
 fireEvent.click(document.querySelector('[data-reference-remove]')!);
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false);
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(referenceNodes)('native prompt reference blocks Run when %s is missing',async missing=>{
 vi.mocked(scanModels).mockResolvedValue(referenceModels());
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...refsEvidence,allowlist:{...refsEvidence.allowlist,nodes:[...refsEvidence.allowlist.nodes,...referenceNodes.filter(n=>n!==missing)]}});
 localStorage.setItem('deas.pref.studio.run.checkpoint','"qwen.safetensors"');
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));promptDrop();
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain(missing);
 expect(uploadInput).not.toHaveBeenCalled();
});

test('retains inactive reference chips across unsupported family changes and never submits without them',async()=>{
 vi.mocked(scanModels).mockResolvedValue(referenceModels());
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...refsEvidence,allowlist:{...refsEvidence.allowlist,nodes:[...refsEvidence.allowlist.nodes,...referenceNodes]}});
 localStorage.setItem('deas.pref.studio.run.checkpoint','"qwen.safetensors"');
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));promptDrop();
 fireEvent.change(screen.getByRole('combobox',{name:'Checkpoint'}),{target:{value:'anima.safetensors'}});
 expect(document.querySelector('[data-reference-controls] img')?.getAttribute('alt')).toBe('ref.png');
 expect(document.querySelector('[data-reference-chip]')?.textContent).toContain('inactive');
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);
 expect(promptDrop().dropEffect).toBe('none');
 fireEvent.change(screen.getByRole('combobox',{name:'Checkpoint'}),{target:{value:'qwen.safetensors'}});
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false);
 fireEvent.click(document.querySelector('[data-reference-remove]')!);expect(document.querySelector('[data-reference-controls]')).toBeNull();
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each([['audio','/outside/a.wav'],['video','/outside/a.mp4'],['image',''],['image','relative.png'],['image',123]])('prompt rejects invalid reference media/path (%s %s)',async(media,path)=>{
 vi.mocked(scanModels).mockResolvedValue(referenceModels());
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...refsEvidence,allowlist:{...refsEvidence.allowlist,nodes:[...refsEvidence.allowlist.nodes,...referenceNodes]}});
 localStorage.setItem('deas.pref.studio.run.checkpoint','"qwen.safetensors"');
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 expect(promptDrop(String(media),path as string).dropEffect).toBe('none');
 expect(document.querySelector('[data-reference-chip]')).toBeNull();expect(uploadInput).not.toHaveBeenCalled();
});

test('unsupported model refuses prompt image drops without adding a notice below the prompt',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'diffusion_models',name:'anima.safetensors',family:'anima',path:'/m/anima',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('combobox',{name:'Checkpoint'}).getAttribute('title')).toBe('anima.safetensors'));
 const prompt=screen.getByRole('textbox',{name:'Prompt'});
 const item={name:'ref.png',path:'/ref.png',src:'asset://localhost/ref.png',media:'image'};
 const transfer={types:['application/x-deas-media'],getData:()=>JSON.stringify(item),dropEffect:'copy'};
 fireEvent.dragOver(prompt,{dataTransfer:transfer});
 expect(transfer.dropEffect).toBe('none');
 expect(fireEvent.drop(prompt,{dataTransfer:transfer})).toBe(false);
 expect(document.querySelector('[data-reference-chip]')).toBeNull();
 expect(document.querySelector('[data-reference-reject]')).toBeNull();
 expect(uploadInput).not.toHaveBeenCalled();
});

test.each(['image','video','audio'] as const)('protected drag payload advertises only attachable images (%s)',async kind=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,visionModels:['clip_vision_g.safetensors']}});
 const name=`protected-${kind}.${kind==='image'?'png':kind==='video'?'mp4':'wav'}`,path=`/protected-${kind}/${name}`;
 vi.mocked(invoke).mockImplementation(async command=>command==='native_media_star_status'?{starred:false,unavailable:null}:{path:`/protected-${kind}`,parent:null,entries:[{name,path,kind:'file',media:kind,size:1,modified:1,symlink:false}],truncated:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:`/protected-${kind}`}}/></I18nProvider>);
 const source=await screen.findByRole('button',{name});
 const data=new Map<string,string>();let readable=false;
 const transfer={clearData:()=>data.clear(),setData:(key:string,value:string)=>data.set(key,value),getData:(key:string)=>readable?(data.get(key)??''):'',get types(){return [...data.keys()];},effectAllowed:'uninitialized',dropEffect:'none'};
 fireEvent.dragStart(source,{dataTransfer:transfer});
 const prompt=screen.getByRole('textbox',{name:'Prompt'});
 fireEvent.dragOver(prompt,{dataTransfer:transfer});
 expect(transfer.dropEffect).toBe(kind==='image'?'copy':'none');
 readable=true;fireEvent.drop(prompt,{dataTransfer:transfer});
 expect(document.querySelectorAll('[data-reference-controls]')).toHaveLength(kind==='image'?1:0);
});

test('column keyboard resizing persists independently and layout reset leaves authoring intact',async()=>{
 vi.mocked(isTauri).mockReturnValue(false);
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 const left=screen.getByRole('separator',{name:'Resize Settings'}),right=screen.getByRole('separator',{name:'Resize Queue'});
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'keep'}});
 fireEvent.keyDown(left,{key:'ArrowRight'});fireEvent.keyDown(right,{key:'ArrowLeft'});
 expect(Number(left.getAttribute('aria-valuenow'))).toBe(288);expect(Number(right.getAttribute('aria-valuenow'))).toBe(168);
 expect(localStorage.getItem('deas.pref.studio.layout.settingsWidth')).toBe('288');
 act(()=>window.dispatchEvent(new Event('deas:reset-studio-layout')));
 expect(left.getAttribute('aria-valuenow')).toBe('272');expect(right.getAttribute('aria-valuenow')).toBe('152');
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('keep');
});

test('edge arrows fully hide and show Settings and the bottom dock, persist, and layout reset restores them',()=>{
 vi.mocked(isTauri).mockReturnValue(false);
 const view=render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'keep'}});
 const settings=document.getElementById('studio-settings')!,dock=document.getElementById('studio-dock')!;
 fireEvent.click(screen.getByRole('button',{name:'Collapse Settings'}));
 expect(settings.hidden).toBe(true);
 const expand=screen.getByRole('button',{name:'Expand Settings'});
 expect(expand.getAttribute('aria-expanded')).toBe('false');
 // A collapsed pane is not resized by its line.
 fireEvent.keyDown(screen.getByRole('separator',{name:'Resize Settings'}),{key:'ArrowRight'});
 expect(screen.getByRole('separator',{name:'Resize Settings'}).getAttribute('aria-valuenow')).toBe('272');
 fireEvent.click(screen.getByRole('button',{name:'Collapse bottom panel'}));
 expect(dock.hasAttribute('data-collapsed')).toBe(true);
 expect(localStorage.getItem('deas.pref.studio.layout.settingsHidden')).toBe('true');
 expect(localStorage.getItem('deas.pref.studio.dock.hidden')).toBe('true');
 view.unmount();
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 expect(document.getElementById('studio-settings')!.hidden).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Expand Settings'}));
 expect(document.getElementById('studio-settings')!.hidden).toBe(false);
 act(()=>window.dispatchEvent(new Event('deas:reset-studio-layout')));
 expect(document.getElementById('studio-dock')!.hasAttribute('data-collapsed')).toBe(false);
 expect(screen.getByRole('button',{name:'Collapse bottom panel'}).getAttribute('aria-expanded')).toBe('true');
});

test('unexecuted settings survive layout reset and remount; confirmed defaults survive the next mount',async()=>{
 vi.mocked(scanModels).mockResolvedValue(['base.safetensors','last.safetensors'].map(name=>({category:'checkpoints',name,family:'sdxl',path:'/m/'+name,size:1,info:null})));
 const mount=()=>render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 let view=mount();
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));
 dock('Models');fireEvent.click(screen.getByRole('button',{name:'last.safetensors'}));
 choosePipe('Image → Image');
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'  unexecuted draft\n'}});
 fireEvent.change(screen.getByLabelText('Steps'),{target:{value:'31'}});
 fireEvent.change(screen.getByLabelText('CFG'),{target:{value:'0'}});
 fireEvent.change(screen.getByLabelText('Width'),{target:{value:'768'}});
 fireEvent.change(screen.getByLabelText('Seed'),{target:{value:'0'}});
 dock('Options');
 fireEvent.change(screen.getByRole('textbox',{name:'Output naming'}),{target:{value:'draft/%seed%'}});
 fireEvent.keyDown(screen.getByRole('separator',{name:'Resize Settings'}),{key:'ArrowRight'});
 act(()=>window.dispatchEvent(new Event('deas:reset-studio-layout')));
 expect(askDialog()).toBeNull();
 view.unmount();view=mount();
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));
 expect(pipe('Image → Image').selected).toBe(true);
 expect((screen.getByRole('combobox',{name:'Checkpoint'}) as HTMLSelectElement).value).toBe('last.safetensors');
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('  unexecuted draft\n');
 for(const [name,value] of [['Steps','31'],['CFG','0'],['Width','768'],['Seed','0']])expect((screen.getByLabelText(name) as HTMLInputElement).value).toBe(value);
 expect(screen.getByRole('button',{name:'Fixed',pressed:true})).toBeTruthy();
 expect((screen.getByRole('textbox',{name:'Output naming'}) as HTMLInputElement).value).toBe('draft/%seed%');
 expect(screen.getByRole('separator',{name:'Resize Settings'}).getAttribute('aria-valuenow')).toBe('272');
 const stored=Object.fromEntries(Object.entries(localStorage));
 act(()=>window.dispatchEvent(new Event('deas:request-studio-defaults')));
 expect(askDialog()).not.toBeNull();
 expect(Object.fromEntries(Object.entries(localStorage))).toEqual(stored);
 askCancel();
 act(()=>window.dispatchEvent(new Event('deas:request-studio-defaults')));askConfirm();
 view.unmount();mount();
 await waitFor(()=>expect(pipe('Text → Image').disabled).toBe(false));
 expect(pipe('Text → Image').selected).toBe(true);
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('');
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('28');
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1024');
 expect((screen.getByRole('textbox',{name:'Output naming'}) as HTMLInputElement).value).toBe(defaultOptions.outputNaming);
 expect(screen.getByRole('button',{name:'Random',pressed:true})).toBeTruthy();
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('column pointer cancellation, independent queue dragging, restored bounds and dock keyboard resize',()=>{
 vi.mocked(isTauri).mockReturnValue(false);
 vi.stubGlobal('PointerEvent',class extends MouseEvent {pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
 const view=render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 const left=screen.getByRole('separator',{name:'Resize Settings'}),right=screen.getByRole('separator',{name:'Resize Queue'});
 fireEvent.pointerDown(left,{button:0,pointerId:1,clientX:272});fireEvent.pointerMove(window,{pointerId:1,clientX:322});expect(left.getAttribute('aria-valuenow')).toBe('322');
 fireEvent.keyDown(window,{key:'Escape'});expect(left.getAttribute('aria-valuenow')).toBe('272');
 fireEvent.pointerMove(window,{pointerId:1,clientX:500});expect(left.getAttribute('aria-valuenow')).toBe('272');
 fireEvent.pointerDown(right,{button:0,pointerId:1,clientX:700});fireEvent.pointerMove(window,{pointerId:1,clientX:650});fireEvent.pointerUp(window,{pointerId:1});expect(right.getAttribute('aria-valuenow')).toBe('202');
 fireEvent.pointerDown(left,{button:0,pointerId:1,clientX:272});fireEvent.pointerMove(window,{pointerId:1,clientX:350});fireEvent.pointerCancel(window,{pointerId:1});expect(left.getAttribute('aria-valuenow')).toBe('272');
 const bottom=screen.getByRole('separator',{name:'Drag to resize the bottom panel'});fireEvent.keyDown(bottom,{key:'ArrowUp'});expect(bottom.getAttribute('aria-valuenow')).toBe('236');
 view.unmount();render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 expect(screen.getByRole('separator',{name:'Resize Queue'}).getAttribute('aria-valuenow')).toBe('202');
 const shell=document.querySelector('[data-workbench]')!;Object.defineProperty(shell,'clientWidth',{configurable:true,value:910});fireEvent.resize(window);
 fireEvent.keyDown(screen.getByRole('separator',{name:'Resize Settings'}),{key:'End'});
 const settings=Number(screen.getByRole('separator',{name:'Resize Settings'}).getAttribute('aria-valuenow')),queue=Number(screen.getByRole('separator',{name:'Resize Queue'}).getAttribute('aria-valuenow'));
 expect(settings+queue+20+320).toBeLessThanOrEqual(910);
});

test('defaults reset confirms, uses family defaults and leaves jobs, libraries and layout untouched',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'base.safetensors',family:'sdxl',path:'/m/base',size:1,info:null}]);
 const initial:Record<string,unknown>={positive:'edited',checkpoint:'missing.safetensors',options:{...defaultOptions,batch:3},loras:[{name:'missing-lora',strength:0.5}],wildcardEnabled:true,wildcard:{style:'Booru',seed:10,reroll:2,token_budget:300,auto_reroll:true,selection_state:{}},post:true,'post.tiled':true,upscale:2,refineDenoise:0.7};
 for(const [key,value] of Object.entries(initial))localStorage.setItem('deas.pref.studio.run.'+key,JSON.stringify(value));
 localStorage.setItem('library.sentinel','keep');localStorage.setItem('deas.pref.studio.dock.height','250');
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'base.safetensors'});
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));
 act(()=>window.dispatchEvent(new Event('deas:request-studio-defaults')));
 expect(askDialog()).not.toBeNull(); // cancel first: nothing resets
 askCancel();
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('edited');
 act(()=>window.dispatchEvent(new Event('deas:request-studio-defaults')));askConfirm();
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('');
 expect(localStorage.getItem('deas.pref.studio.run.checkpoint')).toBe('"base.safetensors"');
 expect(localStorage.getItem('deas.pref.studio.run.options')).toBe(JSON.stringify(defaultOptions));
 for(const key of ['post','post.tiled','wildcardEnabled'])expect(localStorage.getItem('deas.pref.studio.run.'+key)).toBe('false');
 expect(localStorage.getItem('deas.pref.studio.run.loras')).toBe('[]');expect(localStorage.getItem('deas.pref.studio.run.upscale')).toBe('2');
 expect(localStorage.getItem('deas.pref.studio.dock.height')).toBe('250');expect(localStorage.getItem('library.sentinel')).toBe('keep');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 expect((screen.getByRole('spinbutton',{name:'Steps'}) as HTMLInputElement).value).toBe('28');
});

test('starring an adopted preview repairs its location without remounting or losing editor geometry',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 let moved=false;
 vi.mocked(invoke).mockImplementation(async(command,args)=>{
  if(command==='native_media_star_status')return {starred:(args as {path:string}).path.includes('/starred/'),unavailable:null};
  if(command==='native_media_star'){moved=true;return {oldPath:'/out/a.png',path:'/out/starred/a.png'};}
  if(command==='native_media_star_notice')return;
  return {path:'/out',parent:'/',entries:[{name:'a.png',path:moved?'/out/starred/a.png':'/out/a.png',kind:'file',media:'image',symlink:false,size:1,modified:1}],truncated:false};
 });
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'a.png'}));
 const preview=document.querySelector('.wb-stage > [data-media-tools]')!;
 const previewFigure=document.querySelector('[data-browsed-preview]')!;
 await waitFor(()=>expect(within(preview as HTMLElement).getByRole('button',{name:'Star a.png'}).hasAttribute('disabled')).toBe(false));
 clickMedia(previewFigure.querySelector('img')!);
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_media_star_status',{path:'/out/a.png'}));
 fireEvent.keyDown(window,{key:'Escape'});adopt();
 const sourceImage=screen.getByRole('img',{name:'a.png'});
 Object.defineProperties(sourceImage,{naturalWidth:{configurable:true,value:1024},naturalHeight:{configurable:true,value:1024}});fireEvent.load(sourceImage);
 fireEvent.click(screen.getByRole('button',{name:'Select'}));
 const base=document.querySelector<HTMLElement>('[data-layer="base"]')!;
 fireEvent.keyDown(base,{key:'ArrowLeft'});expect(base.style.left).toBe('-8px');
 const editor=document.querySelector('[data-editor-viewport]');
 const toolbar=screen.getByRole('toolbar',{name:'Edit image'});
 await waitFor(()=>expect(within(toolbar).getByRole('button',{name:'Star a.png'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(within(toolbar).getByRole('button',{name:'Star a.png'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_media_star',{path:'/out/a.png'}));
 await waitFor(()=>expect(base.querySelector('img')?.getAttribute('src')).toContain('/out/starred/a.png'));
 expect(document.querySelector('[data-editor-viewport]')).toBe(editor);
 expect(editor?.closest('[hidden]')).toBeNull();
 expect(document.querySelector('[data-browsed-preview]')).toBeNull();
 expect(screen.getByRole('toolbar',{name:'Edit image'})).toBe(toolbar);
 expect(screen.getByRole('button',{name:'a.png'}).getAttribute('aria-current')).toBe('true');
 expect(document.querySelector('[data-layer="base"]')).toBe(base);expect(base.style.left).toBe('-8px');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('stars every queued result and repairs output locations without changing its submitted intent',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(command,args)=>{
  if(command==='native_media_star_status')return {starred:(args as {path:string}).path.includes('/starred/'),unavailable:null};
  if(command==='native_media_star'){const path=(args as {path:string}).path;return {oldPath:path,path:path.replace('/out/','/out/starred/')};}
  if(command==='native_media_unstar'){const path=(args as {path:string}).path;return {oldPath:path,path:path.replace('/starred/','/')};}
  return {path:'/out',parent:'/',entries:[],truncated:false};
 });
 let intent:JobStatus['intent'];
 const outputs:JobStatus['outputs']=[{filename:'one.png',subfolder:'',type:'output'},{filename:'two.png',subfolder:'',type:'output'}];
 vi.mocked(runWorkbenchJob).mockImplementation(async(_baseUrl,value)=>{intent=value;return ({id:'star-job',baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputRoot:'/out',outputs,intent,error:null,generationReady:false});});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 const queue=screen.getByRole('region',{name:'Queue'});
 await within(queue).findByRole('button',{name:'Star one.png'});
 expect(within(queue).getByRole('button',{name:'Star two.png'})).toBeTruthy();
 for(const name of ['one.png','two.png']){
  const star=within(queue).getByRole('button',{name:`Star ${name}`});
  const tile=star.closest('.wb-queue-output')!;
  expect(tile).not.toBeNull();
  const select=within(tile as HTMLElement).getByRole('button',{name:new RegExp(`Succeeded.*${name.replace('.', '\\.')}`)});
  expect(select.contains(star)).toBe(false);expect(star.closest('button')).toBe(star);
  expect(select.querySelector('img')?.getAttribute('src')).toContain(name);
  select.focus();expect(document.activeElement).toBe(select);
  fireEvent.click(select);expect(select.getAttribute('aria-current')).toBe('true');
  star.focus();expect(document.activeElement).toBe(star);
 }
 expect(queue.querySelector('button button')).toBeNull();
 const snapshot=JSON.stringify(intent);
 const result=document.querySelector('.wb-shown')!;
 await waitFor(()=>expect(within(result as HTMLElement).getByRole('button',{name:'Star one.png'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(within(result as HTMLElement).getByRole('button',{name:'Star one.png'}));
 await waitFor(()=>expect(result.querySelector('img')?.getAttribute('src')).toContain('/out/starred/one.png'));
 expect(within(queue).getByRole('button',{name:'Unstar one.png'})).toBeTruthy();
 const selectedBefore=Array.from(queue.querySelectorAll('.wb-queue-select')).map(button=>button.getAttribute('aria-current'));
 await waitFor(()=>expect(within(queue).getByRole('button',{name:'Star two.png'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(within(queue).getByRole('button',{name:'Star two.png'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_media_star',{path:'/out/two.png'}));
 expect(within(queue).getByRole('button',{name:'Unstar two.png'}).closest('.wb-queue-output')?.querySelector('img')?.getAttribute('src')).toContain('/out/starred/two.png');
 await waitFor(()=>expect(within(queue).getByRole('button',{name:'Unstar one.png'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(within(queue).getByRole('button',{name:'Unstar one.png'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_media_unstar',{path:'/out/starred/one.png'}));
 expect(within(queue).getByRole('button',{name:'Star one.png'}).closest('.wb-queue-output')?.querySelector('img')?.getAttribute('src')).toContain('/out/one.png');
 expect(Array.from(queue.querySelectorAll('.wb-queue-select')).map(button=>button.getAttribute('aria-current'))).toEqual(selectedBefore);
 expect(document.querySelector('.wb-shown')).toBe(result);
 expect(outputs[0].subfolder).toBe('');expect(JSON.stringify(intent)).toBe(snapshot);
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
});

test.each([['de','Abgebrochen'],['en','Cancelled'],['fr','Annulé'],['ja','キャンセル済み'],['ru','Отменено'],['tr','İptal edildi'],['zh','已取消']])('cancelled job is a terminal localized result without output actions (%s)',async(locale,label)=>{
 localStorage.setItem('deas.locale.v1',locale);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'cancelled-job',baseUrl:evidence.baseUrl,promptId:'p',state:'cancelled',outputs:[],error:null,generationReady:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 const run=document.querySelector<HTMLButtonElement>('[data-run]')!;
 await waitFor(()=>expect(run.disabled).toBe(false));fireEvent.click(run);
 const tile=await waitFor(()=>{const tile=document.querySelector<HTMLButtonElement>('.wb-queue-select');expect(tile).not.toBeNull();return tile!;});
 expect(tile.textContent).toContain(label);expect(tile.querySelector('.wb-thumb')?.textContent).toBe('×');
 expect(tile.querySelector('[data-generation-duration]')).toBeNull();
 expect(document.querySelector('.wb-queue-output')?.querySelectorAll('button')).toHaveLength(1);
 await waitFor(()=>expect(run.disabled).toBe(false));expect(pollWorkbench).not.toHaveBeenCalled();
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
});

test.each([
 ...['de','en','fr','ja','ru','tr','zh'].map(locale=>({locale,generationMs:13310,state:'succeeded' as const,filename:'result.png'})),
 {locale:'en',generationMs:0,state:'succeeded' as const,filename:'zero.png'},
 {locale:'en',generationMs:null,state:'succeeded' as const,filename:'unknown.png'},
 {locale:'en',generationMs:13310,state:'failed' as const,filename:'failed.png'},
 {locale:'en',generationMs:13310,state:'succeeded' as const,filename:'clip.webm'},
])('queue and selected details use actual timing: $locale / $filename',async({locale,generationMs,state,filename})=>{
 localStorage.setItem('deas.locale.v1',locale);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async command=>command==='native_media_star_status'?{starred:false,unavailable:null}:{path:'/out',parent:'/',entries:[],truncated:false});
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'timing-job',baseUrl:evidence.baseUrl,promptId:'p',state,outputRoot:'/out',outputs:[{filename,subfolder:'',type:'output'}],error:null,generationReady:false,metadata:{startedAt:1700000000000,generationMs}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 const run=document.querySelector<HTMLButtonElement>('[data-run]')!;
 await waitFor(()=>expect(run.disabled).toBe(false));fireEvent.click(run);
 await waitFor(()=>expect(document.querySelector('.wb-queue-select')).not.toBeNull());
 const tile=document.querySelector<HTMLButtonElement>('.wb-queue-select')!;
 const header=document.querySelector('.wb-job-line')!;
 expect(tile.textContent).toContain(filename);expect(header.textContent).toContain('timing-j');
 const expected=generationMs!==null&&state==='succeeded'?new Intl.NumberFormat(locale,{style:'unit',unit:'second',unitDisplay:'short',maximumFractionDigits:2}).format(generationMs/1000):null;
 if(expected){expect(tile.textContent).toContain(expected);expect(header.textContent).toContain(expected);}
 else {expect(tile.querySelector('[data-generation-duration]')).toBeNull();expect(header.querySelector('[data-generation-duration]')).toBeNull();}
 fireEvent.click(tile);expect(tile.getAttribute('aria-current')).toBe('true');
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
});

test('missing remembered model and LoRAs are explicit blockers, never silently substituted',async()=>{
 localStorage.setItem('deas.pref.studio.run.checkpoint','"missing.safetensors"');
 localStorage.setItem('deas.pref.studio.run.loras',JSON.stringify([{name:'missing-lora.safetensors',strength:1}]));
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'other.safetensors',path:'/m/other',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 expect((screen.getByRole('combobox',{name:'Checkpoint'}) as HTMLSelectElement).value).toBe('missing.safetensors');expect(screen.getByText(/missing-lora.safetensors/)).toBeTruthy();
 expect(screen.getByRole('alert').closest('.wb-stage')).toBeTruthy();
 expect(screen.getByRole('alert').classList.contains('wb-stage-warning')).toBe(true);
 dock('Models');fireEvent.click(screen.getByRole('button',{name:'other.safetensors'}));
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('dependency warnings follow corrected selections after a blocked post-process and reopen',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,diffusionModels:['k2.safetensors'],nodes:[...evidence.allowlist.nodes,'UNETLoader']}});
 const m=(category:string,name:string,family?:string)=>({category,name,family,path:'/m/'+name,size:1,info:null});
 vi.mocked(scanModels).mockResolvedValue([m('diffusion_models','k2.safetensors','krea-2'),m('text_encoders','qwen3vl_4b.safetensors'),m('vae','qwen_image_vae.safetensors')]);
 vi.mocked(invoke).mockImplementation(async()=>({path:'/out',parent:'/',entries:[{name:'source.png',path:'/out/source.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 for(const [key,value] of Object.entries({checkpoint:'missing.safetensors',vae:'minimax_h3_video_vae.safetensors'}))localStorage.setItem('deas.pref.studio.run.'+key,JSON.stringify(value));
 const mount=()=>render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 const view=mount();
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));
 expect(screen.getByRole('alert').textContent).toContain('missing.safetensors');
 dock('Models');fireEvent.click(screen.getByRole('button',{name:'k2.safetensors'}));
 expect(screen.getByRole('alert').textContent).not.toContain('missing.safetensors');
 expect(screen.getByRole('alert').textContent).toContain('minimax_h3_video_vae.safetensors');
 dock('Media');fireEvent.click(await screen.findByRole('button',{name:'source.png'}));adopt();
 const img=screen.getByRole('img',{name:'source.png'});
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:1024}});fireEvent.load(img);
 fireEvent.click(screen.getByRole('button',{name:'Image to Image'}));
 fireEvent.click(screen.getByRole('button',{name:'Refine'}));
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 fireEvent.change(screen.getByRole('combobox',{name:'VAE'}),{target:{value:'qwen_image_vae.safetensors'}});
 expect(screen.queryByRole('alert')).toBeNull();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 view.unmount();
 localStorage.setItem('deas.pref.studio.run.vae','"minimax_h3_video_vae.safetensors"');
 const reopened=mount();
 await waitFor(()=>expect(screen.getByRole('combobox',{name:'VAE'})).toBeTruthy());
 expect(screen.getByRole('alert').textContent).toContain('minimax_h3_video_vae.safetensors');
 expect(screen.getByRole('alert').textContent).not.toContain('missing.safetensors');
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 fireEvent.change(screen.getByRole('combobox',{name:'VAE'}),{target:{value:'qwen_image_vae.safetensors'}});
 reopened.unmount();mount();
 await waitFor(()=>expect(screen.getByRole('combobox',{name:'VAE'})).toBeTruthy());
 expect(screen.queryByRole('alert')).toBeNull();
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('pending model refresh validates the latest selection, not the selection at scan start',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,diffusionModels:['k2.safetensors'],nodes:[...evidence.allowlist.nodes,'UNETLoader']}});
 const models=[{category:'diffusion_models',name:'k2.safetensors',family:'krea-2',path:'/m/k2',size:1,info:null},{category:'text_encoders',name:'qwen3vl_4b.safetensors',path:'/m/encoder',size:1,info:null},{category:'vae',name:'qwen_image_vae.safetensors',path:'/m/vae',size:1,info:null}];
 vi.mocked(scanModels).mockResolvedValue(models);
 localStorage.setItem('deas.pref.studio.run.vae','"minimax_h3_video_vae.safetensors"');
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await screen.findByRole('combobox',{name:'VAE'});
 let finish!:(value:typeof models)=>void;
 vi.mocked(scanModels).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 dock('Models');fireEvent.click(document.querySelector('[data-run-load]')!);
 fireEvent.change(screen.getByRole('combobox',{name:'VAE'}),{target:{value:'qwen_image_vae.safetensors'}});
 await act(async()=>finish(models));
 expect(screen.queryByRole('alert')).toBeNull();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('selection changes do not erase an unrelated preparation error',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,checkpoints:['base.safetensors']}});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'base.safetensors',path:'/m/base',size:1,info:null}]);
 vi.mocked(runWorkbenchJob).mockRejectedValueOnce(new Error('Backend connection failed'));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await screen.findByText('Backend connection failed');
 fireEvent.change(screen.getByRole('combobox',{name:'Pipeline'}),{target:{value:'video'}});
 expect(screen.getByRole('alert').textContent).toContain('Backend connection failed');
});

test('dock clicks preview only and preserve the adopted editor until explicit replacement',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async()=>({path:'/out',parent:'/',entries:['one.png','two.png'].map(name=>({name,path:'/out/'+name,kind:'file',media:'image',symlink:false,size:1,modified:1})),truncated:false}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));choosePipe('Image → Image');
 fireEvent.click(await screen.findByRole('button',{name:'one.png'}));
 expect(document.querySelector('[data-browsed-preview]')).not.toBeNull();
 expect(document.querySelector('[data-editor-viewport]')).toBeNull();
 const bounds=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:800,height:600} as DOMRect);
 const previewImage=document.querySelector<HTMLImageElement>('[data-browsed-preview] img')!;
 clickMedia(previewImage,400,10);expect(screen.queryByRole('dialog')).toBeNull();
 fireEvent.click(screen.getByRole('region',{name:'Preview'}));expect(screen.queryByRole('dialog')).toBeNull();
 clickMedia(previewImage);
 const dialog=screen.getByRole('dialog',{name:'one.png'}),full=dialog.querySelector('img')!;
 Object.defineProperties(full,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(full);
 const before=full.style.transform;fireEvent.wheel(dialog.querySelector('.wb-viewer-box')!,{deltaY:-200,clientX:200,clientY:200});
 expect(full.style.transform).not.toBe(before);
 fireEvent.keyDown(window,{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();bounds.mockRestore();
 expect(document.querySelector('[data-browsed-preview]')).not.toBeNull();
 // Previewing does not make a picture to edit: the Image pipeline stays text to image.
 expect(document.querySelector('[data-edit][aria-pressed="true"]')).toBeNull();expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
 adopt();const img=screen.getByRole('img',{name:'one.png'});
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);
 const editor=document.querySelector('[data-editor-viewport]');expect(editor).not.toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'two.png'}));
 expect(document.querySelector('[data-editor-viewport]')).toBe(editor);
 expect(editor?.closest('[hidden]')).not.toBeNull();
 fireEvent.click(document.querySelector('[data-preview-close]')!);
 expect(document.querySelector('[data-editor-viewport]')).toBe(editor);
 expect(editor?.closest('[hidden]')).toBeNull();
});

test('an explicit Run replaces a browsed preview with the accepted job',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async()=>({path:'/out',parent:'/',entries:[{name:'browse.png',path:'/out/browse.png',kind:'file',media:'image',symlink:false,size:1,modified:1}],truncated:false}));
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'browse-job',baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(await screen.findByRole('button',{name:'browse.png'}));
 expect(document.querySelector('[data-browsed-preview]')).not.toBeNull();
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'immutable submission'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(document.querySelector('.wb-shown')).not.toBeNull());
 const submitted=vi.mocked(runWorkbenchJob).mock.calls[0][1];
 act(()=>window.dispatchEvent(new Event('deas:request-studio-defaults')));askConfirm();
 expect(submitted.positivePrompt).toBe('immutable submission');expect(document.querySelector('.wb-shown')).not.toBeNull();
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
 expect(document.querySelector('[data-browsed-preview]')).toBeNull();
 expect(document.querySelector('.wb-current-preview')?.hasAttribute('hidden')).toBe(false);
});

test('session drafts restore last edited controls and prompts per full model path and pipeline without Run',async()=>{
 vi.mocked(scanModels).mockResolvedValue(sessionModels);vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('folder/a.safetensors'));
 sessionModel('folder/a.safetensors');
 const a={positive:'A edited, never run',negative:'A negative',steps:37,cfg:4.5,seed:123,seedMode:'fixed',loras:[{name:'style.safetensors',strength:0.35}],options:{...defaultOptions,outputNaming:'a/%seed%'},post:true,upscale:2,textEncoder:'a-encoder',vae:'a-vae',componentOverrides:{textEncoders:true,vaes:true,audioVaes:false,textProjections:false}};
 sessionSettings(a);sessionModel('other/a.safetensors');
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('37'); // first visit to a same-family checkpoint keeps the current settings for comparison
 sessionSettings({positive:'B draft',negative:'B negative',steps:41,seed:456,post:false});
 sessionModel('folder/a.safetensors');
 // The checkpoint's settings return; the prompts on screen stay.
 expect(captureStudioSettings()).toMatchObject(Object.fromEntries(Object.entries({...a,positive:'B draft',negative:'B negative'}).map(([key,value])=>['studio.run.'+key,value])));
 // Text → Image and Image → Image are one Image pipeline with one draft per model: nothing switches.
 choosePipe('Image → Image');
 expect(document.querySelector('[data-model-picker]')).toHaveProperty('value','folder/a.safetensors');
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','B draft');
 expect(screen.getByLabelText('Steps')).toHaveProperty('value','37');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('session draft cache resets on a fresh Workbench session without adding storage records',async()=>{
 vi.mocked(scanModels).mockResolvedValue(sessionModels);vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const mount=()=>render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 let view=mount();await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('folder/a.safetensors'));
 sessionSettings({positive:'old A',steps:39});sessionModel('other/a.safetensors');sessionSettings({positive:'last global',steps:42});
 const keys=Object.keys(localStorage);expect(keys.some(k=>/cache|draft|session/i.test(k))).toBe(false);expect(sessionStorage.length).toBe(0);
 view.unmount();view=mount();await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('folder/a.safetensors'));
 sessionModel('folder/a.safetensors');expect(screen.getByLabelText('Steps')).toHaveProperty('value','42'); // drafts are gone: A's 39 never returns, the persisted global value stands
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','last global');expect(runWorkbenchJob).not.toHaveBeenCalled();view.unmount();
});

test('session drafts restore prompt image ordering, removals and input sources rather than another models media',async()=>{
 vi.mocked(scanModels).mockResolvedValue(sessionModels);vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,visionModels:['clip_vision_g.safetensors']}});
 vi.mocked(invoke).mockResolvedValue({path:'/out',parent:'/',entries:['one.png','two.png'].map(name=>({name,path:'/out/'+name,kind:'file',symlink:false,media:'image',size:1,modified:1})),truncated:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 await screen.findByRole('button',{name:'one.png'});sessionModel('folder/a.safetensors');
 promptDrop('image','/out/one.png');promptDrop('image','/out/two.png');reorderReferences(0,1);
 fireEvent.click(screen.getByRole('button',{name:'one.png'}));adopt();
 const img=document.querySelector<HTMLImageElement>('.wb-current-preview img')!;Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);
 fireEvent.click(screen.getByRole('button',{name:'Image to Image'}));
 fireEvent.keyDown(document.querySelector('[data-layer="base"]')!,{key:'ArrowLeft'});
 let finish=()=>{};vi.stubGlobal('Image',class{naturalWidth=64;naturalHeight=64;onload=()=>{};onerror=()=>{};set src(_:string){finish=()=>this.onload();}});
 dropTile('two.png');act(()=>finish());dropTile('two.png');
 sessionModel('other/a.safetensors');act(()=>finish());expect(document.querySelectorAll('[data-layer]')).toHaveLength(2);
 fireEvent.click(document.querySelector('[data-reference-remove]')!);
 fireEvent.click(screen.getByRole('button',{name:'two.png'}));adopt();
 const second=document.querySelector<HTMLImageElement>('.wb-current-preview img')!;Object.defineProperties(second,{naturalWidth:{value:1024},naturalHeight:{value:1024}});fireEvent.load(second);
 sessionModel('folder/a.safetensors');
 expect(Array.from(document.querySelectorAll<HTMLImageElement>('[data-reference-controls] img')).map(img=>img.alt)).toEqual(['two.png','one.png']);
 expect(document.querySelector('[data-layer="base"] img')?.getAttribute('src')).toContain('/out/one.png');
 expect(document.querySelector<HTMLElement>('[data-layer="base"]')?.style.left).toBe('-8px');expect(document.querySelectorAll('[data-layer]')).toHaveLength(2);
 sessionModel('other/a.safetensors');
 expect(Array.from(document.querySelectorAll<HTMLImageElement>('[data-reference-controls] img')).map(img=>img.alt)).toEqual(['one.png']);
 expect(document.querySelector('[data-layer="base"] img')?.getAttribute('src')).toContain('/out/two.png');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('session video drafts restore video/audio references and trims without uploading',async()=>{
 const files=['h3-a.safetensors','h3-b.safetensors'].map(name=>({category:'diffusion_models',name,family:'minimax-h3',path:'/m/'+name,size:1,info:null}));
 vi.mocked(scanModels).mockResolvedValue(files);vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(invoke).mockResolvedValue({path:'/out',parent:'/',entries:[],truncated:false});
 vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m',input:'/input'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Multi-reference → Video').disabled).toBe(false));choosePipe('Multi-reference → Video');
 const add=(name:string,media:string)=>{fireEvent.drop(document.querySelector('[data-open-references]')!,{dataTransfer:{types:['application/x-deas-media'],getData:()=>JSON.stringify({name,media,path:'/input/'+name,src:'asset://localhost/'+name})}});fireEvent.click(document.querySelector('[data-video-role="reference"]')!);};
 add('clip.mp4','video');add('voice.wav','audio');add('picture.png','image');
 fireEvent.click(document.querySelector('[data-open-references]')!);fireEvent.click(screen.getByRole('button',{name:'Edit clip.mp4'}));
 fireEvent.change(screen.getByLabelText('Use of clip.mp4'),{target:{value:'audio'}});
 fireEvent.change(screen.getByLabelText('Start of clip.mp4'),{target:{value:'2'}});
 fireEvent.change(screen.getByLabelText('End of clip.mp4'),{target:{value:'6'}});
 fireEvent.click(within(screen.getByRole('dialog',{name:'Edit clip.mp4'})).getByRole('button',{name:'Close'}));dock('Media');
 sessionSettings({positive:'video A',video:{seconds:7,fps:24,passes:1,upscaler:'',shiftHigh:5,shiftLow:5,refinerStep:2,shiftVideo:11,shiftAudio:4,audioVae:'a-vae',textProjection:''}});
 sessionModel('h3-b.safetensors');sessionSettings({positive:'video B'});
 fireEvent.click(document.querySelector('[data-open-references]')!);fireEvent.click(screen.getByRole('button',{name:'Remove reference clip.mp4'}));dock('Media');
 sessionModel('h3-a.safetensors');
 expect(document.querySelector('[data-open-references]')?.textContent).toContain('3');expect(screen.getByLabelText('Prompt')).toHaveProperty('value','video B');
 fireEvent.click(document.querySelector('[data-open-references]')!);fireEvent.click(screen.getByRole('button',{name:'Edit clip.mp4'}));
 expect(screen.getByLabelText('Use of clip.mp4')).toHaveProperty('value','audio');expect(screen.getByLabelText('Start of clip.mp4')).toHaveProperty('value','2');expect(screen.getByLabelText('End of clip.mp4')).toHaveProperty('value','6');
 fireEvent.click(within(screen.getByRole('dialog',{name:'Edit clip.mp4'})).getByRole('button',{name:'Close'}));dock('Media');
 choosePipe('Text → Video');sessionSettings({positive:'text video'});choosePipe('Multi-reference → Video');
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','text video');sessionModel('h3-b.safetensors');expect(document.querySelector('[data-open-references]')?.textContent).toContain('2'); // same output kind: the prompt carries over, references stay per pipeline
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();view.unmount();
});

test('session cache is environment scoped and never substitutes a disappeared exact model path',async()=>{
 vi.mocked(scanModels).mockResolvedValue(sessionModels);vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const ui=(root:string)=><I18nProvider><Workbench endpoint={evidence.baseUrl} root={root} roots={{models:root+'/models'}}/></I18nProvider>;
 const view=render(ui('/first'));await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('folder/a.safetensors'));
 sessionModel('folder/a.safetensors');sessionSettings({positive:'first environment A'});sessionModel('other/a.safetensors');
 const second=sessionModels.map(m=>({...m,path:'/second/'+m.name}));vi.mocked(scanModels).mockResolvedValue(second);view.rerender(ui('/second'));
 await waitFor(()=>expect(scanModels).toHaveBeenCalledWith('/second/models',[]));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('other/a.safetensors'));
 sessionModel('folder/a.safetensors');sessionSettings({positive:'second environment A'});sessionModel('other/a.safetensors');sessionModel('folder/a.safetensors');
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','second environment A');
 vi.mocked(scanModels).mockResolvedValue(sessionModels);view.rerender(ui('/first'));
 await waitFor(()=>expect(scanModels).toHaveBeenCalledWith('/first/models',[]));
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')).toHaveProperty('value','other/a.safetensors'));
 sessionModel('folder/a.safetensors');expect(screen.getByLabelText('Prompt')).toHaveProperty('value','first environment A');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each([false,true])('environment transition saves the active last edit under its outgoing scope (same paths=%s)',async samePaths=>{
 vi.mocked(scanModels).mockResolvedValue(sessionModels);vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const ui=(root:string)=><I18nProvider><Workbench endpoint={evidence.baseUrl} root={root} roots={{models:root+'/models'}}/></I18nProvider>;
 const view=render(ui('/first'));await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('folder/a.safetensors'));
 sessionModel('folder/a.safetensors');sessionSettings({positive:'first original',steps:31});
 sessionModel('other/a.safetensors');sessionModel('folder/a.safetensors');sessionSettings({positive:'first last unsaved edit',steps:47});
 vi.mocked(scanModels).mockResolvedValue(samePaths?sessionModels:sessionModels.map(m=>({...m,path:'/second/'+m.name})));
 view.rerender(ui('/second'));await waitFor(()=>expect(scanModels).toHaveBeenLastCalledWith('/second/models',[]));
 await act(async()=>{});sessionModel('folder/a.safetensors');sessionSettings({positive:'second own draft',steps:52});
 sessionModel('other/a.safetensors');sessionModel('folder/a.safetensors');expect(screen.getByLabelText('Prompt')).toHaveProperty('value','second own draft');
 vi.mocked(scanModels).mockResolvedValue(sessionModels);view.rerender(ui('/first'));
 await waitFor(()=>expect(screen.getByLabelText('Prompt')).toHaveProperty('value','first last unsaved edit'));
 expect(screen.getByLabelText('Steps')).toHaveProperty('value','47');
 view.rerender(ui('/second'));await waitFor(()=>expect(screen.getByLabelText('Prompt')).toHaveProperty('value','second own draft'));
 expect(screen.getByLabelText('Steps')).toHaveProperty('value','52');expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each([['anima','Anima'],['krea-2','Krea 2']])('tiled refine is refused with a reason on %s, whose latents are not flat',async(familyId)=>{
 localStorage.setItem('deas.pref.studio.run.post.tiled','true');
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'DaSiWaTiledDiffusion']}});
 vi.mocked(scanModels).mockResolvedValue([{category:'diffusion_models',name:'a.safetensors',family:familyId,path:'/m/a',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 fireEvent.click( await screen.findByRole('tab',{name:/Post-Processing/}));
 fireEvent.click(document.querySelector('[data-post-card="refine"]')!);
 const box=await screen.findByRole('checkbox',{name:'Tiled refine (DaSiWa Tiled Diffusion)'});
 await waitFor(()=>expect(box.hasAttribute('disabled')).toBe(true));
 expect(box).toHaveProperty('checked',false);
 expect(screen.getByText(/cannot run on it/)).toBeTruthy();
});

test('post-processing cards re-read backend model lists on every open, not only before the first read',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('tab',{name:/Post-Processing/}));
 await waitFor(()=>expect(document.querySelector('[data-post-card="refine"]')).not.toBeNull());
 await act(async()=>{});
 const before=vi.mocked(checkRecipePrerequisites).mock.calls.length;
 fireEvent.click(document.querySelector('[data-post-card="refine"]')!);
 await waitFor(()=>expect(vi.mocked(checkRecipePrerequisites).mock.calls.length).toBe(before+1));
});

test('window refocus preserves Run readiness and models until explicit Reload',async()=>{
 const a={category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null};
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);vi.mocked(scanModels).mockResolvedValue([a]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelectorAll('[data-model-picker] option')).toHaveLength(1));
 const run=screen.getByRole('button',{name:'Run'});
 await waitFor(()=>expect(run).toHaveProperty('disabled',false));
 vi.mocked(scanModels).mockResolvedValue([a,{...a,name:'b.safetensors',path:'/m/b'}]);
 const before=vi.mocked(scanModels).mock.calls.length;const capabilities=vi.mocked(checkRecipePrerequisites).mock.calls.length;
 fireEvent.blur(window);fireEvent.focus(window);fireEvent.focus(window);fireEvent(document,new Event('visibilitychange'));
 await act(async()=>{});
 expect(vi.mocked(scanModels).mock.calls).toHaveLength(before);
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(capabilities);
 expect(run).toHaveProperty('disabled',false);
 expect(document.querySelectorAll('[data-model-picker] option')).toHaveLength(1);
 dock('Models');fireEvent.click(document.querySelector('[data-run-load]')!);
 await waitFor(()=>expect(document.querySelectorAll('[data-model-picker] option')).toHaveLength(2));
 expect(scanModels).toHaveBeenLastCalledWith('/m',[],true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('session cache distinguishes same names in separate categories and absolute model roots',async()=>{
 const files=[{...sessionModels[0],name:'same.safetensors',path:'/one/same.safetensors'},{...sessionModels[0],name:'same.safetensors',category:'diffusion_models',family:'qwen-image-2.1',path:'/two/same.safetensors'},{...sessionModels[0],name:'same.safetensors',path:'/three/same.safetensors'}];
 vi.mocked(scanModels).mockResolvedValue(files);vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelectorAll('[data-model-picker] option')).toHaveLength(3));
 const ids=files.map(m=>JSON.stringify([m.category,m.path,m.name]));
 sessionSettings({steps:31});sessionModel(ids[1]);sessionSettings({steps:32});sessionModel(ids[2]);sessionSettings({steps:33});
 sessionModel(ids[0]);expect(screen.getByLabelText('Steps')).toHaveProperty('value','31');
 sessionModel(ids[1]);expect(screen.getByLabelText('Steps')).toHaveProperty('value','32');
 sessionModel(ids[2]);expect(screen.getByLabelText('Steps')).toHaveProperty('value','33');
});

test('opening a project restores its draft without substituting a missing checkpoint or overwriting global defaults',async()=>{
 localStorage.setItem('deas.pref.studio.run.positive',JSON.stringify('global prompt'));
 localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify('a.safetensors'));
 vi.mocked(scanModels).mockResolvedValue([]);
 vi.mocked(invoke).mockImplementation(async c=>c==='native_project_open'?projectFixture:c==='native_project_close'?null:{entries:[],truncated:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(scanModels).toHaveBeenCalled());
 fireEvent.click(screen.getByRole('button',{name:'Open project'}));
 await waitFor(()=>expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('saved project prompt'));
 expect((screen.getByRole('spinbutton',{name:'Seed'}) as HTMLInputElement).value).toBe('42');
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
 expect(localStorage.getItem('deas.pref.studio.run.positive')).toBe(JSON.stringify('global prompt'));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Close project'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Close project'}));
 await waitFor(()=>expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('global prompt'));
});

test('project defaults reset stays project-local and closing restores global last-used controls',async()=>{
 const global={positive:'global draft',checkpoint:'base.safetensors',steps:33,cfg:0,seed:0,seedMode:'fixed',options:{...defaultOptions,outputNaming:'global/%seed%'},upscale:2,refineDenoise:0.7,textEncoder:'global-encoder.safetensors',vae:'global-vae.safetensors',componentOverrides:{textEncoders:true,vaes:true,audioVaes:false,textProjections:false}};
 for(const [key,value] of Object.entries(global))localStorage.setItem('deas.pref.studio.run.'+key,JSON.stringify(value));
 localStorage.setItem('deas.pref.studio.layout.settingsWidth','304');
 localStorage.setItem('deas.pref.backend.autostart','false');
 const saved={...projectFixture,draft:{...projectFixture.draft,checkpoint:'base.safetensors'}};
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'base.safetensors',family:'sdxl',path:'/m/base',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(command,args)=>{
  if(command==='native_project_open')return saved;
  if(command==='native_project_save')return {...saved,revision:2,draft:(args as {draft:typeof saved.draft}).draft};
  if(command==='native_project_close')return null;
  return {entries:[],truncated:false};
 });
 const mount=()=>render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 const view=mount();
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));
 const stored=Object.fromEntries(Object.entries(localStorage).filter(([key])=>key.startsWith('deas.pref.studio.run.')));
 fireEvent.click(screen.getByRole('button',{name:'Open project'}));
 await waitFor(()=>expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('saved project prompt'));
 act(()=>window.dispatchEvent(new Event('deas:request-studio-defaults')));
 expect(askDialog()).not.toBeNull();
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('saved project prompt');
 expect(invoke).not.toHaveBeenCalledWith('native_project_save',expect.anything());
 askCancel();
 act(()=>window.dispatchEvent(new Event('deas:request-studio-defaults')));askConfirm();
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('');
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('28');
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_project_save',expect.objectContaining({projectId:saved.id,draft:expect.objectContaining({positivePrompt:'',steps:28,pipeline:'t2i'})})));
 expect(Object.fromEntries(Object.entries(localStorage).filter(([key])=>key.startsWith('deas.pref.studio.run.')))).toEqual(stored);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Close project'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Close project'}));
 await waitFor(()=>expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('global draft'));
 view.unmount();mount();
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));
 for(const [name,value] of [['Steps','33'],['CFG','0'],['Seed','0']])expect((screen.getByLabelText(name) as HTMLInputElement).value).toBe(value);
 dock('Options');expect((screen.getByRole('textbox',{name:'Output naming'}) as HTMLInputElement).value).toBe(global.options.outputNaming);
 dock('Post-Processing');expect((screen.getByLabelText('Upscale factor') as HTMLInputElement).value).toBe('2');
 expect(screen.getByRole('separator',{name:'Resize Settings'}).getAttribute('aria-valuenow')).toBe('304');
 expect(localStorage.getItem('deas.pref.backend.autostart')).toBe('false');
 for(const key of ['textEncoder','vae','componentOverrides'] as const)expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.'+key)!)).toEqual(global[key]);
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('pending image upload is dropped on unmount before native admission',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a.safetensors',size:1,info:null}]);
 const saved={...projectFixture,draft:{...projectFixture.draft,checkpoint:'a.safetensors',pipeline:'i2i'},input:{id:'input-1',path:'/projects/one/assets/input.png',sha256:'a'.repeat(64),width:1024,height:1024}};
 vi.mocked(invoke).mockImplementation(async c=>c==='native_project_open'?saved:{entries:[],truncated:false});
 let release!:(name:string)=>void;vi.mocked(uploadInput).mockReturnValueOnce(new Promise(yes=>{release=yes;}));
 const props={endpoint:evidence.baseUrl,roots:{models:'/m',input:'/env/in'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Open project'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Open project'}));
 await waitFor(()=>expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('saved project prompt'));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(1));
 view.unmount();localStorage.setItem('deas.pref.studio.run.pipeline','"t2i"');
 render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(readCurrentWorkbench).toHaveBeenCalledTimes(2));
 await act(async()=>release('deas-inputs/late.png'));
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(document.querySelectorAll('[data-job-id]')).toHaveLength(0);
});

test('a reopened managed PNG becomes an image source and uploads only on explicit Run',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a.safetensors',size:1,info:null}]);
 const saved={...projectFixture,draft:{...projectFixture.draft,checkpoint:'a.safetensors',pipeline:'i2i'},input:{id:'input-1',path:'/projects/one/assets/input.png',sha256:'a'.repeat(64),width:1024,height:1024}};
 vi.mocked(invoke).mockImplementation(async c=>c==='native_project_open'?saved:{entries:[],truncated:false});
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/project.png');
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'project-job',baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/env/in'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Open project'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Open project'}));
 await waitFor(()=>expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('saved project prompt'));
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(uploadInput).toHaveBeenCalledWith(evidence.baseUrl,'/projects/one/assets/input.png');
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({inputImage:'deas-inputs/project.png',seed:42,denoise:0.5});
});

test('wildcard dock and hammer keep base text, snapshot active rules per run and allow disabling without clearing',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,checkpoints:['m.safetensors'],nodes:[...evidence.allowlist.nodes,'DaSiWa_WildcardPresetPromptBuilder']}});
 localStorage.setItem('deas.pref.studio.run.wildcard',JSON.stringify({style:'Booru',seed:7,reroll:3,token_budget:200,auto_reroll:true,selection_state:{'Art/Light/wildcards':{enabled:true,weight:1.2}}}));
 vi.mocked(invoke).mockImplementation(async c=>c==='native_wildcard_library'?JSON.stringify({categories:{Art:[{subject:'Light',booru_wildcards:['{red|blue} light']}]}}):{entries:[],truncated:false});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'m.safetensors',path:'/m/checkpoints/m.safetensors',size:1,info:null}]);
 let submits=0;
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:`wild-job-${++submits}`,baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false,intent:vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1]}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'manual base'}});
 fireEvent.click(screen.getByRole('button',{name:'Prompt Forge'}));
 fireEvent.click(screen.getByRole('button',{name:'Wildcards'}));
 expect(document.activeElement).toBe(screen.getByRole('tab',{name:'Wildcards'}));
 await screen.findByText('Art');
 fireEvent.click(screen.getByRole('checkbox',{name:'Active for generation'}));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const first=vi.mocked(runWorkbenchJob).mock.calls[0][1];
 expect(first.positivePrompt).toBe('manual base');expect(first.wildcard?.auto_reroll).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'New picks'}));
 expect(first.wildcard?.reroll).toBe(3);
 fireEvent.change(screen.getByRole('spinbutton',{name:'Wildcard seed'}),{target:{value:'9'}});
 // Metadata is an overlay opened from the preview, not a permanent column.
 expect(screen.queryByRole('region',{name:'Generation metadata'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Metadata'}));
 fireEvent.click(within(screen.getByRole('region',{name:'Generation metadata'})).getByRole('button',{name:'Use these settings'}));
 expect((screen.getByRole('spinbutton',{name:'Wildcard seed'}) as HTMLInputElement).value).toBe('7');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Disable wildcards'}));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 expect(vi.mocked(runWorkbenchJob).mock.calls[1][1].wildcard).toBeUndefined();
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('manual base');
 fireEvent.click(screen.getByRole('checkbox',{name:'Active for generation'}));
 fireEvent.click(screen.getByRole('button',{name:'Use these settings'}));
 expect((screen.getByRole('checkbox',{name:'Active for generation'}) as HTMLInputElement).checked).toBe(false);
});

test('My wildcards imports a pack and submits the same expansion shown in its preview',async()=>{
 const pack={id:'a'.repeat(64),name:'Fixture pack',lists:{scene:1,'worlds/sky/outfit':1,'worlds/ground/outfit':1}};
 const second={id:'b'.repeat(64),name:'Second pack',lists:{old:1}};
 let finish!: (prompts:{positive:string;negative:string})=>void;
 vi.mocked(invoke).mockImplementation(async command=>{
  if(command==='native_wildcard_packs')return [second];
  if(command==='native_import_wildcard_pack')return [pack,second];
  if(command==='native_remove_wildcard_pack')return [second];
  if(command==='native_expand_wildcard_packs')return new Promise(resolve=>{finish=resolve;});
  if(command==='native_wildcard_library')return JSON.stringify({categories:{}});
  return {entries:[],truncated:false};
 });
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a.safetensors',family:'sdxl',size:1,info:null}]);
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'pack-job',baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 const runButton=screen.getByRole('button',{name:'Run'});
 await waitFor(()=>expect(runButton).toHaveProperty('disabled',false));
 dock('Wildcards');
 fireEvent.keyDown(screen.getByRole('tab',{name:'Library'}),{key:'ArrowRight'});
 expect(screen.getByRole('tab',{name:'My wildcards'}).getAttribute('aria-selected')).toBe('true');
 const mine=screen.getByRole('tabpanel',{name:'My wildcards'});
 const importFolder=within(mine).getByRole('button',{name:'Import wildcard folder'});
 await waitFor(()=>expect(importFolder).toHaveProperty('disabled',false));
 expect(invoke).toHaveBeenCalledWith('native_wildcard_packs');
 fireEvent.click(importFolder);
 const folders=await within(mine).findByRole('navigation',{name:'Folders'});
 await within(folders).findByRole('button',{name:'Fixture pack'});
 const lists=within(mine).getByRole('navigation',{name:'Wildcard lists'});
 fireEvent.click(within(folders).getByRole('button',{name:'worlds'}));
 fireEvent.click(within(folders).getByRole('button',{name:'sky'}));
 expect(within(lists).getByRole('button',{name:/^outfit\s+1$/}).getAttribute('title')).toBe('worlds/sky/outfit');
 expect(within(lists).queryByRole('button',{name:/^scene/})).toBeNull();
 fireEvent.click(within(folders).getByRole('button',{name:'All wildcards'}));
 fireEvent.change(screen.getByRole('textbox',{name:'Prompt'}),{target:{value:'portrait,'}});
 fireEvent.click(within(mine).getByRole('button',{name:'Insert in prompt'}));
 expect(screen.getByRole('textbox',{name:'Prompt'})).toHaveProperty('value','portrait, __scene__');
 expect(runButton).toHaveProperty('disabled',true);
 fireEvent.click(runButton);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_expand_wildcard_packs',{
  positive:'portrait, __scene__',negative:'',seed:0,
 }));
 await act(async()=>finish({positive:'portrait, blue coat, sky city',negative:''}));
 expect(within(mine).getByText('portrait, blue coat, sky city')).toBeTruthy();
 fireEvent.click(runButton);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({positivePrompt:'portrait, blue coat, sky city',negativePrompt:'',wildcardSeed:0});
 expect(screen.getByRole('textbox',{name:'Prompt'})).toHaveProperty('value','portrait, __scene__');
 const remove=within(folders).getByRole('button',{name:'Remove pack Fixture pack'});
 fireEvent.click(remove);
 fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Cancel'}));
 expect(invoke).not.toHaveBeenCalledWith('native_remove_wildcard_pack',{id:pack.id});
 fireEvent.click(remove);
 fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Confirm'}));
 await waitFor(()=>expect(within(mine).queryByRole('button',{name:'Remove pack Fixture pack'})).toBeNull());
 expect(invoke).toHaveBeenCalledWith('native_remove_wildcard_pack',{id:pack.id});
 expect(within(folders).getByRole('button',{name:'Second pack'})).toBeTruthy();
});

test('inline wildcard choices run without packs and Random advances the seed for the next preview',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,checkpoints:['inline.safetensors']}});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'inline.safetensors',path:'/m/checkpoints/inline.safetensors',size:1,info:null}]);
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'inline-job',baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false});
 vi.mocked(invoke).mockImplementation(async (command,args)=>{
  if(command==='native_wildcard_packs')return [];
  if(command==='native_expand_wildcard_packs')return {positive:`choice at ${(args as {seed:number}).seed}`,negative:'grainy'};
  return null;
 });
 localStorage.setItem('deas.pref.studio.run.seedMode','"fixed"');
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 dock('Wildcards');
 fireEvent.click(screen.getByRole('tab',{name:'My wildcards'}));
 const mine=within(screen.getByRole('tabpanel',{name:'My wildcards'}));
 const prompt=screen.getByRole('textbox',{name:'Prompt'});
 const runButton=screen.getByRole('button',{name:'Run'});
 fireEvent.change(prompt,{target:{value:'{1|2|3}'}});
 fireEvent.change(screen.getByRole('textbox',{name:'Negative prompt'}),{target:{value:'{blurry|grainy}'}});
 fireEvent.change(mine.getByRole('spinbutton',{name:'Wildcard seed'}),{target:{value:'42'}});
 expect(mine.getByRole('button',{name:'Fixed',pressed:true})).toBeTruthy();
 await mine.findByText('choice at 42');
 await waitFor(()=>expect(runButton).toHaveProperty('disabled',false));
 fireEvent.click(runButton);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({positivePrompt:'choice at 42',negativePrompt:'grainy',wildcardSeed:42});
 expect(mine.getByRole('spinbutton',{name:'Wildcard seed'})).toHaveProperty('value','42');
 const rng=vi.spyOn(Math,'random');
 try {
  rng.mockReturnValueOnce(0.25);
  fireEvent.click(mine.getByRole('button',{name:'Random'}));
  expect(mine.getByRole('button',{name:'Random',pressed:true})).toBeTruthy();
  await mine.findByText('choice at 1073741824');
  await waitFor(()=>expect(runButton).toHaveProperty('disabled',false));
  rng.mockReturnValueOnce(0.5);
  fireEvent.click(runButton);
  await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
  expect(vi.mocked(runWorkbenchJob).mock.calls[1][1]).toMatchObject({positivePrompt:'choice at 1073741824',negativePrompt:'grainy'});
  await mine.findByText('choice at 2147483648');
  expect(prompt).toHaveProperty('value','{1|2|3}');
 } finally { rng.mockRestore(); }
});

test('an unknown wildcard name stops Run even when no pack is imported',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,checkpoints:['unknown.safetensors']}});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'unknown.safetensors',path:'/m/checkpoints/unknown.safetensors',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async command=>{
  if(command==='native_wildcard_packs')return [];
  if(command==='native_expand_wildcard_packs')return Promise.reject('Unknown wildcard __missing__');
  return null;
 });
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 const runButton=screen.getByRole('button',{name:'Run'});
 await waitFor(()=>expect(runButton).toHaveProperty('disabled',false));
 fireEvent.change(screen.getByRole('textbox',{name:'Prompt'}),{target:{value:'portrait, __missing__'}});
 await waitFor(()=>expect(runButton).toHaveProperty('disabled',true));
 await waitFor(()=>expect(runButton.getAttribute('title')).toContain('Unknown wildcard __missing__'));
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 view.unmount();
});

test('Options naming persists and resolves the submitted seed/model, rejecting unsafe templates before preparation',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,checkpoints:['folder/My Model.safetensors']}});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'folder/My Model.safetensors',path:'/m/checkpoints/folder/My Model.safetensors',size:1,info:null}]);
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'naming-job',baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false});
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 dock('Options');
 const field=screen.getByRole('textbox',{name:'Output naming'}) as HTMLInputElement;
 expect(field.value).toBe('%type%/%date_yyyy-mm-dd%/%time%-%seed%-%model%');
 fireEvent.change(screen.getByRole('spinbutton',{name:'Seed'}),{target:{value:'42'}});
 fireEvent.change(field,{target:{value:'custom/%type%/%seed%-%model%'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1].outputPrefix).toBe('raw/custom/image/42-My-Model');
 fireEvent.change(field,{target:{value:'../%seed%'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
 expect(field.getAttribute('aria-invalid')).toBe('true');
 view.unmount();
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 dock('Options');expect((screen.getByRole('textbox',{name:'Output naming'}) as HTMLInputElement).value).toBe('../%seed%');
});

test('seed controls restore submitted seeds, preserve mode on New and wrap exact integer steps',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,checkpoints:['seed.safetensors']}});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'seed.safetensors',path:'/m/checkpoints/seed.safetensors',size:1,info:null}]);
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'seed-job',baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false});
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(scanModels).toHaveBeenCalled());
 const input=()=>screen.getByRole('spinbutton',{name:'Seed'}) as HTMLInputElement;
 fireEvent.change(input(),{target:{value:'42'}});
 expect(screen.getByRole('button',{name:'Fixed',pressed:true})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1].seed).toBe(42);
 expect(input().value).toBe('42');
 fireEvent.click(screen.getByRole('button',{name:'New random seed'}));
 expect(screen.getByRole('button',{name:'Fixed',pressed:true})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Use last seed'}));
 expect(input().value).toBe('42');
 fireEvent.change(input(),{target:{value:'0'}});
 fireEvent.click(screen.getByRole('button',{name:'Decrease seed'}));
 expect(input().value).toBe(String(Number.MAX_SAFE_INTEGER));
 fireEvent.click(screen.getByRole('button',{name:'Increase seed'}));
 expect(input().value).toBe('0');
 fireEvent.click(screen.getByRole('button',{name:'Use seed 42'}));
 expect(input().value).toBe('42');
 fireEvent.click(screen.getByRole('button',{name:'Copy seed 42'}));
 await screen.findByText('Copy failed; select the seed and copy it manually.'); // A project has its own independent status region.
 const writeText=vi.fn().mockResolvedValue(undefined);
 Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true});
 fireEvent.click(screen.getByRole('button',{name:'Copy seed 42'}));
 await waitFor(()=>expect(writeText).toHaveBeenCalledWith('42'));
 expect(screen.getByText('Seed copied')).toBeTruthy();
 const promptBox=screen.getByLabelText('Prompt') as HTMLTextAreaElement;const before=promptBox.value;
 fireEvent.change(promptBox,{target:{value:'a red fox'}});
 fireEvent.click(screen.getByRole('button',{name:'Copy Prompt'}));
 await waitFor(()=>expect(writeText).toHaveBeenCalledWith('a red fox'));
 fireEvent.click(screen.getByRole('button',{name:'Clear Prompt'}));
 expect(promptBox.value).toBe('');
 expect((screen.getByRole('button',{name:'Clear Prompt'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(promptBox,{target:{value:before}});
 fireEvent.click(screen.getByRole('button',{name:'Random'}));
 vi.mocked(runWorkbenchJob).mockResolvedValueOnce({id:'seed-job-2',baseUrl:evidence.baseUrl,promptId:'p2',state:'succeeded',outputs:[],error:null,generationReady:false});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 expect(input().value).not.toBe('42');
 view.unmount();
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl}/></I18nProvider>);
 expect(screen.getByRole('button',{name:'Random',pressed:true})).toBeTruthy();
 expect(screen.getByRole('button',{name:'Use seed 42'})).toBeTruthy();
});

test('seed history caps at ten, deduplicates submitted values and ignores failed preparation',async()=>{
 localStorage.setItem('deas.pref.studio.run.recentSeeds',JSON.stringify([1,2,3,4,5,6,7,8,9,10]));
 localStorage.setItem('deas.pref.studio.run.seed','12');
 localStorage.setItem('deas.pref.studio.run.seedMode',JSON.stringify('fixed'));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,checkpoints:['seed.safetensors']}});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'seed.safetensors',path:'/m/checkpoints/seed.safetensors',size:1,info:null}]);
 vi.mocked(runWorkbenchJob).mockRejectedValueOnce(new Error('prepare failed'));
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:String(Math.random()),baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await screen.findByText('prepare failed');
 const history=()=>JSON.parse(localStorage.getItem('deas.pref.studio.run.recentSeeds')!);
 expect(history()).toEqual([1,2,3,4,5,6,7,8,9,10]);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(history()).toEqual([12,1,2,3,4,5,6,7,8,9]));
 fireEvent.change(screen.getByRole('spinbutton',{name:'Seed'}),{target:{value:'3'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(history()).toEqual([3,12,1,2,4,5,6,7,8,9]));
});

test('IPC fixture: Load models → pick LoRA → Run prepares and submits one intent, polls to success and previews the output file',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const queued:JobStatus={id:'job-1234',baseUrl:evidence.baseUrl,promptId:'p',state:'queued',outputs:[],error:null,generationReady:false};
 vi.mocked(runWorkbenchJob).mockResolvedValue(queued);
 vi.mocked(pollWorkbench).mockResolvedValue(collection([{...queued,state:'succeeded',outputRoot:'/env/ComfyUI/output',outputs:[{filename:'DEAS_0001.png',subfolder:'',type:'output'}]}]));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{output:'/env/ComfyUI/output'}}/></I18nProvider>);
 expect(screen.getByRole('complementary',{name:'Media'})).toBeTruthy(); // the media dock tab is the default
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1); // sampler/scheduler lists are read once per endpoint; models still need the explicit Load
 dock('Models');fireEvent.click(screen.getByRole('button',{name:'Load models'}));
 fireEvent.click(await screen.findByRole('button',{name:'b.safetensors'}));
 expect(screen.getByRole('button',{name:'b.safetensors'}).getAttribute('aria-pressed')).toBe('true');
 dock('LoRAs');fireEvent.click(screen.getByRole('button',{name:'style.safetensors'}));
 fireEvent.change(screen.getByLabelText('Strength of style.safetensors'),{target:{value:'0.7'}});
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'a quiet forest'}});
 fireEvent.change(screen.getByLabelText('Width'),{target:{value:'768'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 const [baseUrl,intent]=vi.mocked(runWorkbenchJob).mock.calls[0];
 expect(baseUrl).toBe('http://127.0.0.1:7801');
 expect(intent).toMatchObject({positivePrompt:'a quiet forest',checkpoint:'b.safetensors',width:768,height:1024,loras:[{name:'style.safetensors',strength:0.7}],outputPrefix:expect.stringMatching(new RegExp(`^raw/image/\\d{4}-\\d{2}-\\d{2}/\\d{2}-\\d{2}-\\d{2}-${intent.seed}-b$`))});
 expect(Object.isFrozen(intent)).toBe(true);
 expect(screen.getByRole('button',{name:/Queued/})).toBeTruthy();
 await waitFor(()=>expect((screen.getByRole('img',{name:'DEAS_0001.png'}) as HTMLImageElement).src).toBe('asset://localhost//env/ComfyUI/output/DEAS_0001.png'),{timeout:3000});
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.loras')!)).toEqual([{name:'style.safetensors',strength:0.7}]);
});

test('an Upscale-alone output restores the generation from its source upload, its own aspect and components, and the Upscale pass',async()=>{
 const krea=[{category:'diffusion_models',name:'Krea2/k.safetensors',family:'krea-2'},{category:'loras',name:'Krea2/style.safetensors',family:'krea-2'},{category:'text_encoders',name:'qwen3vl_4b_bf16.safetensors'},{category:'vae',name:'QwenImage/qwen_image_vae.safetensors'}].map(m=>({...m,path:'/m/'+m.name,size:1,info:null}));
 vi.mocked(scanModels).mockResolvedValue(krea);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const shared=(prompt:string,seed:number,latent:unknown)=>({'1':{class_type:'UNETLoader',inputs:{unet_name:'Krea2/k.safetensors',weight_dtype:'default'}},C:{class_type:'CLIPLoader',inputs:{clip_name:'qwen3vl_4b_bf16.safetensors',type:'krea2'}},
  L1:{class_type:'LoraLoader',inputs:{model:['1',0],clip:['C',0],lora_name:'Krea2/style.safetensors',strength_model:0.25,strength_clip:0.25}},V:{class_type:'VAELoader',inputs:{vae_name:'QwenImage/qwen_image_vae.safetensors'}},
  '2':{class_type:'CLIPTextEncode',inputs:{clip:['L1',1],text:prompt}},'3':{class_type:'CLIPTextEncode',inputs:{clip:['L1',1],text:''}},
  '5':{class_type:'KSampler',inputs:{model:['L1',0],positive:['2',0],negative:['3',0],latent_image:['9',0],seed,steps:8,cfg:1,sampler_name:'euler',scheduler:'simple',denoise:latent?1:0}},
  '6':{class_type:'VAEDecode',inputs:{samples:['5',0],vae:['V',0]}},...(latent?{'9':latent}:{})});
 const generated=shared('the original prompt',122329910,{class_type:'EmptyLatentImage',inputs:{width:896,height:1152,batch_size:1}});
 const upscaled={...shared('whatever the controls held',4155682127,null),'8':{class_type:'LoadImage',inputs:{image:'deas-inputs/cfb3ec09-e98e-49e1-8b5d-d2bdbfcd29d4.png'}},UL:{class_type:'UpscaleModelLoader',inputs:{model_name:'2x-up.safetensors'}},
  UM:{class_type:'ImageUpscaleWithModel',inputs:{upscale_model:['UL',0],image:['8',0]}},S:{class_type:'ImageScale',inputs:{image:['UM',0],upscale_method:'lanczos',width:1792,height:2304,crop:'disabled'}},'9':{class_type:'VAEEncode',inputs:{pixels:['S',0],vae:['V',0]}}};
 vi.mocked(readImageMetadata).mockImplementation(async path=>[['prompt',JSON.stringify(path==='/in/deas-inputs/cfb3ec09-e98e-49e1-8b5d-d2bdbfcd29d4.png'?generated:upscaled)]]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/in'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')).toHaveProperty('value','Krea2/k.safetensors'));
 settingsDrop('/outside/12-08-10-upscaled.png');
 expect(await screen.findByText(/post-process result/)).toBeTruthy();
 expect(readImageMetadata).toHaveBeenCalledWith('/in/deas-inputs/cfb3ec09-e98e-49e1-8b5d-d2bdbfcd29d4.png');
 const saved=captureStudioSettings();
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','the original prompt');
 expect(saved).toMatchObject({'studio.run.seed':122329910,'studio.run.width':896,'studio.run.height':1152,'studio.run.resolution':'fixed','studio.run.aspect':'7:9',
  'studio.run.textEncoder':'qwen3vl_4b_bf16.safetensors','studio.run.vae':'QwenImage/qwen_image_vae.safetensors','studio.run.upscale':2,'studio.run.upscaleModel':'2x-up.safetensors','studio.run.post':false});
 expect(saved['studio.run.loras']).toEqual([{name:'Krea2/style.safetensors',strength:0.25,enabled:true}]);
 expect(screen.queryByText(/Not carried over:/)).toBeNull();expect(runWorkbenchJob).not.toHaveBeenCalled();
});
