import { aceControl, aceModel, aceNodes, aceVariants, adopt, askConfirm, askDialog, assignRole, beginnerView, changeAceModel, choosePipe, clickMedia, closeRoles, collection, dock, dropHistoryReference, evidence, heldJob, historicalImage, imageModels, ltxModels, markOf, mediaEntries, menuOf, mountAce, mountMusic, music, musicEvidence, musicJob, musicNodes, navJobs, openHistoryRecord, pipe, projectFixture, recentHistoryRecord, referenceModels, referenceNodes, refsEvidence, roleFile, roleVideoFixture, sessionModel, sessionModels, sessionSettings, stopAll, videoEvidence, yue2Models } from './Workbench.testHarness';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Workbench } from './Workbench';
import { GlobalSearch } from '../../components/setup/GlobalSearch';
import { defaultOptions } from './OptionsPanel';
import { defaultTve } from './TvePostControls';
import { h3LatentDefaults } from '../../lib/videoIntent';
import { faceRefineNodes, sam3VideoNodes } from '../../lib/sam3';
import { normalizeAceDuration, defaultAceSettings } from '../../lib/musicIntent';
import { captureStudioSettings } from '../../lib/preferences';
import { aspects, resolutions } from '../../lib/resolution';
import type { ForgeCanvasContext } from '../../lib/forgeCanvas';
import { revealTarget } from '../../lib/search';
import type { LocalModel } from '../../lib/models';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { autoRefine, stopWorkbench, runWorkbenchJob, readCurrentWorkbench, pollWorkbench, uploadMask, uploadInput, readH3Session, readRefMods, type JobStatus } from '../../lib/jobs';
import { readImageMetadata } from '../../lib/imageMetadata';

test('poll reply already in flight cannot overwrite Stop',async()=>{
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([heldJob('held','running')]));
 let finish!:(value:ReturnType<typeof collection>)=>void;
 vi.mocked(pollWorkbench).mockReturnValue(new Promise(resolve=>{finish=resolve;}));
 vi.mocked(stopWorkbench).mockResolvedValue({...collection([heldJob('held','cancelled')]),admissionEpoch:1,outcome:'settled',discarded:0,issues:[]});
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await waitFor(()=>expect(pollWorkbench).toHaveBeenCalledTimes(1),{timeout:2500});
 stopAll();
 await screen.findByText('Stop finished. Check the retained job states.');
 await act(async()=>finish(collection([heldJob('held','running')])));
 expect(document.querySelector('[data-job-id="held"] [data-state]')!.getAttribute('data-state')).toBe('cancelled');
});

test('native capacity rejection retains all active and unknown peers without frontend truncation',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 const jobs=Array.from({length:20},(_,i)=>heldJob('capacity-'+i,i%2?'queued':'unknown'));
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection(jobs));
 vi.mocked(runWorkbenchJob).mockRejectedValue(new Error('Workbench capacity reached'));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 fireEvent.click(document.querySelector('[data-run]')!);
 await screen.findByText('Workbench capacity reached');
 await waitFor(()=>expect(readCurrentWorkbench).toHaveBeenCalledTimes(2));
 expect(document.querySelectorAll('[data-job-id]')).toHaveLength(20);expect(stopWorkbench).not.toHaveBeenCalled();
});

test.each(['fixed','random'] as const)('rapid %s presses pin settings, naming and seed before uploads settle',async mode=>{
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 localStorage.setItem('deas.pref.studio.run.seed','42');localStorage.setItem('deas.pref.studio.run.seedMode',JSON.stringify(mode));
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({...defaultOptions,outputNaming:'press/%seed%'}));
 const pending:((job:JobStatus)=>void)[]=[];vi.mocked(runWorkbenchJob).mockImplementation(()=>new Promise(resolve=>pending.push(resolve)));
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 const run=document.querySelector<HTMLButtonElement>('[data-run]')!;await waitFor(()=>expect(run.disabled).toBe(false));
 act(()=>{fireEvent.click(run);fireEvent.click(run);fireEvent.click(run);});
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(3));
 const intents=vi.mocked(runWorkbenchJob).mock.calls.map(call=>call[1]);
 expect(intents[0].seed).toBe(42);
 expect(new Set(intents.map(intent=>intent.seed)).size).toBe(mode==='fixed'?1:3);
 expect(intents.map(intent=>intent.outputPrefix)).toEqual(intents.map(intent=>`raw/press/${intent.seed}`));
 view.unmount();await act(async()=>pending.forEach((finish,i)=>finish(heldJob('fixed-'+i,'queued'))));
});

test('Stop disables serial Continuity before a pending clip read can continue Run all',async()=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/h3',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a',size:1,info:null}]);
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 const job=heldJob('continuity-stop','queued');
 vi.mocked(runWorkbenchJob).mockResolvedValue(job);
 vi.mocked(pollWorkbench).mockResolvedValue(collection([{...job,state:'succeeded'}]));
 let finish!:(value:Awaited<ReturnType<typeof readH3Session>>)=>void;
 vi.mocked(readH3Session).mockReturnValue(new Promise(resolve=>{finish=resolve;}));
 vi.mocked(stopWorkbench).mockResolvedValue({...collection([{...job,state:'succeeded'}]),admissionEpoch:1,outcome:'empty',discarded:0,issues:[]});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'Continuity · off'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'Continuity active'}));
 fireEvent.click(screen.getByRole('button',{name:'Add step'}));fireEvent.click(screen.getByRole('button',{name:'Add step'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run all'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run all'}));
 fireEvent.click(within(screen.getByRole('dialog',{name:'Continuity'})).getByRole('button',{name:'Close'}));
 await waitFor(()=>expect(readH3Session).toHaveBeenCalledTimes(1),{timeout:3000});
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
 stopAll();
 await waitFor(()=>expect(stopWorkbench).toHaveBeenCalledTimes(1));
 await act(async()=>finish({latestId:'root',clips:[{clipId:'root',parent:null,frames:124,completed:1,export:null}]}));
 await act(async()=>{});
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
 const plan=JSON.parse(localStorage.getItem('deas.pref.studio.run.continuity')!);
 expect(plan.steps.every((step:{clipId?:string})=>!step.clipId)).toBe(true);
});

test('real IPC Stop ownership survives remount, blocks Run and releases after current-state recovery',async()=>{
 const actual=await vi.importActual<typeof import('../../lib/jobs')>('../../lib/jobs');
 const previous={stop:vi.mocked(stopWorkbench).getMockImplementation(),read:vi.mocked(readCurrentWorkbench).getMockImplementation(),poll:vi.mocked(pollWorkbench).getMockImplementation(),invoke:vi.mocked(invoke).getMockImplementation()};
 let finish!:(value:Awaited<ReturnType<typeof stopWorkbench>>)=>void;
 let snapshot=collection([heldJob('owned-stop','running')]);
 vi.mocked(stopWorkbench).mockImplementation(actual.stopWorkbench);
 vi.mocked(readCurrentWorkbench).mockImplementation(actual.readCurrentWorkbench);vi.mocked(pollWorkbench).mockImplementation(actual.pollWorkbench);
 vi.mocked(invoke).mockImplementation((command,args)=>{
  if(command==='native_workbench_current'||command==='native_workbench_poll')return Promise.resolve(snapshot);
  if(command==='native_workbench_stop')return new Promise(resolve=>{finish=resolve;});
  return previous.invoke!(command,args);
 });
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 try{
  const first=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(()=>expect(document.querySelector('[data-run-stop]')).not.toBeNull());
  stopAll();first.unmount();
  render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run-stop]')?.disabled).toBe(true));
  expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);
  fireEvent.click(document.querySelector('[data-run]')!);expect(runWorkbenchJob).not.toHaveBeenCalled();
  snapshot={...collection([heldJob('owned-stop','cancelled')]),admissionEpoch:1};
  await act(async()=>finish({...snapshot,outcome:'settled',discarded:0,issues:[]}));
  await waitFor(()=>expect(document.querySelector('[data-job-id="owned-stop"] [data-state]')?.getAttribute('data-state')).toBe('cancelled'),{timeout:2500});
  expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false);
  expect(vi.mocked(invoke).mock.calls.filter(call=>call[0]==='native_workbench_stop')).toHaveLength(1);
 }finally{
  cleanup();vi.mocked(stopWorkbench).mockImplementation(previous.stop!);vi.mocked(readCurrentWorkbench).mockImplementation(previous.read!);vi.mocked(pollWorkbench).mockImplementation(previous.poll!);vi.mocked(invoke).mockImplementation(previous.invoke!);
 }
});

test('held jobs continue polling while another local Run IPC is still pending',async()=>{
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 const peer=heldJob('poll-peer','queued');let finish!:(job:JobStatus)=>void;
 vi.mocked(runWorkbenchJob).mockResolvedValueOnce(peer).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 vi.mocked(pollWorkbench).mockResolvedValue(collection([{...peer,state:'succeeded'}]));
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 const run=document.querySelector<HTMLButtonElement>('[data-run]')!;await waitFor(()=>expect(run.disabled).toBe(false));
 fireEvent.click(run);fireEvent.click(run);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 await waitFor(()=>expect(document.querySelector('[data-job-id="poll-peer"] [data-state]')?.getAttribute('data-state')).toBe('succeeded'),{timeout:2500});
 view.unmount();await act(async()=>finish(heldJob('late-peer','queued')));
});

test('overlapping fixed-seed Runs restart an invalidated in-flight peer poll while both IPCs remain pending',async()=>{
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 localStorage.setItem('deas.pref.studio.run.seed','42');
 localStorage.setItem('deas.pref.studio.run.seedMode','"fixed"');
 const peer=heldJob('overlap-peer','queued');
 const succeeded=collection([{...peer,state:'succeeded' as const}]);
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([peer]));
 let finishPoll!:(value:ReturnType<typeof collection>)=>void;
 vi.mocked(pollWorkbench).mockReturnValueOnce(new Promise(resolve=>{finishPoll=resolve;})).mockResolvedValue(succeeded);
 const runs:((job:JobStatus)=>void)[]=[];
 vi.mocked(runWorkbenchJob).mockImplementation(()=>new Promise(resolve=>runs.push(resolve)));
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 const run=document.querySelector<HTMLButtonElement>('[data-run]')!;
 await waitFor(()=>expect(run.disabled).toBe(false));
 vi.useFakeTimers();
 try{
  await act(async()=>fireEvent.click(run));
  expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(pollWorkbench).toHaveBeenCalledTimes(1);
  await act(async()=>fireEvent.click(run));
  expect(runWorkbenchJob).toHaveBeenCalledTimes(2);
  await act(async()=>finishPoll(succeeded));
  expect(document.querySelector('[data-job-id="overlap-peer"] [data-state]')?.getAttribute('data-state')).toBe('queued');
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(pollWorkbench).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[data-job-id="overlap-peer"] [data-state]')?.getAttribute('data-state')).toBe('succeeded');
  // Neither Run reply has settled; observing a terminal peer must not submit or poll idle work.
  await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
  expect(runWorkbenchJob).toHaveBeenCalledTimes(2);
  expect(pollWorkbench).toHaveBeenCalledTimes(2);
  expect(readCurrentWorkbench).toHaveBeenCalledTimes(1);
 }finally{
  view.unmount();await act(async()=>runs.forEach((finish,i)=>finish(heldJob('overlap-'+i,'queued'))));
  vi.useRealTimers();
 }
});

test('session cached targets never override explicit metadata, history or project restore and later edits win',async()=>{
 vi.mocked(scanModels).mockResolvedValue(sessionModels);vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const intent={...historicalImage,checkpoint:'folder/a.safetensors'};
 const record=recentHistoryRecord(intent),before=JSON.stringify(record);
 const saved={...projectFixture,draft:{...projectFixture.draft,checkpoint:'folder/a.safetensors'}};
 vi.mocked(invoke).mockImplementation(async(command,args)=>{
  if(command==='native_jobs_history')return {schemaVersion:1,records:[record],readOnly:false,error:null};
  if(command==='native_project_open')return saved;
  if(command==='native_project_save')return {...saved,revision:2,draft:(args as {draft:typeof saved.draft}).draft};
  return {path:'/out',parent:'/',entries:[{name:'meta.png',path:'/out/meta.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false};
 });
 vi.mocked(readImageMetadata).mockResolvedValue([['parameters','metadata wins\nSteps: 7, Sampler: Euler, CFG scale: 3, Seed: 11, Size: 512x512, Model: folder/a.safetensors']]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 await screen.findByRole('button',{name:'meta.png'});sessionModel('folder/a.safetensors');
 sessionSettings({positive:'cached t2i',steps:39});choosePipe('Image → Image');sessionSettings({positive:'cached i2i',steps:40});choosePipe('Text → Image');sessionModel('other/a.safetensors');
 fireEvent.click(screen.getByRole('button',{name:'meta.png'}));fireEvent.click(document.querySelector('[data-more]')!);fireEvent.click(document.querySelector('[data-more-apply]')!);
 await waitFor(()=>expect(screen.getByLabelText('Prompt')).toHaveProperty('value','metadata wins'));
 expect(screen.getByLabelText('Steps')).toHaveProperty('value','7');sessionModel('other/a.safetensors');sessionModel('folder/a.safetensors');
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','metadata wins');
 sessionModel('other/a.safetensors');await openHistoryRecord();fireEvent.click(document.querySelector('[data-history-apply]')!);fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value',intent.positivePrompt);expect(screen.getByLabelText('Steps')).toHaveProperty('value','17');
 sessionSettings({positive:'edited after history'});sessionModel('other/a.safetensors');sessionModel('folder/a.safetensors');
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','edited after history');
 fireEvent.click(screen.getByRole('button',{name:'Open project'}));
 await waitFor(()=>expect(screen.getByLabelText('Prompt')).toHaveProperty('value',saved.draft.positivePrompt));
 expect(screen.getByLabelText('Steps')).toHaveProperty('value','24');
 expect(JSON.stringify(record)).toBe(before);expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('history restores independent latent post settings without submitting or changing the record',async()=>{
 localStorage.setItem('deas.pref.studio.run.latent.h3',JSON.stringify({enabled:true,model:'h3-remembered.safetensors',scale:3,steps:2,denoise:0.3}));
 const original=recentHistoryRecord({recipeId:'video-generation',version:1,family:'ltx-2',positivePrompt:'historic video',negativePrompt:'',model:ltxModels[0].name,textEncoder:ltxModels[1].name,vae:ltxModels[3].name,seed:19,width:768,height:512,frames:121,frameRate:24,steps:8,cfg:1,sampler:'euler',scheduler:'simple',outputPrefix:'raw/video/old',output:{codec:'Auto',container:'Auto',bitDepth:'Auto',quality:20,audioCodec:'AAC',audioBitrate:'192k',saveFirstFrame:false,saveLastFrame:false},ltx:{passes:1,audioVae:ltxModels[4].name,textProjection:ltxModels[2].name},latentUpscale:{model:'ltx-held.safetensors',scale:2}});
 const before=JSON.stringify(original);
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','LatentUpscaleModelLoader','LTXVLatentUpsampler'],latentUpscaleModels:['ltx-held.safetensors'],textEncoders:[ltxModels[1].name,ltxModels[2].name],vaes:[ltxModels[3].name,ltxModels[4].name]}});
 vi.mocked(invoke).mockImplementation(async c=>c==='native_jobs_history'?{schemaVersion:1,records:[original],readOnly:false,error:null}:{path:'/env/input',parent:'/env',entries:[],truncated:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Text → Video').disabled).toBe(false));
 await openHistoryRecord();fireEvent.click(document.querySelector('[data-history-apply]')!);
 fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 fireEvent.click(document.querySelector('[data-dock-tab="post"]')!);
 expect(document.querySelector('[data-latent-upscale-enabled]')).toHaveProperty('checked',true);
 expect(document.querySelector('[data-latent-upscale-model]')).toHaveProperty('value','ltx-held.safetensors');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.latent.ltx')!)).toMatchObject({enabled:true,model:'ltx-held.safetensors',scale:2});
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.latent.h3')!)).toMatchObject({enabled:true,model:'h3-remembered.safetensors',scale:3});
 expect(JSON.stringify(original)).toBe(before);expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('history restores exact rich settings without probing or submitting and keeps native queue snapshots immutable',async()=>{
 const original=recentHistoryRecord({...historicalImage,loras:[{name:'style.safetensors',strength:0.75}],options:{attention:'sdpa',cache:{node:'EasyCache',threshold:0.03},compile:'inductor',vaeTile:1536},imageReference:{visionModel:'vision.safetensors',images:[{image:'second.png',strength:0.2},{image:'first.png',strength:0.9}]},refine:{width:2432,height:1664,denoise:0.35},imageFormat:'webp',imageCompression:83});
 const encoded=JSON.stringify(original);
 const live={...heldJob('existing-native-job','failed'),intent:{...historicalImage,positivePrompt:'Immutable existing run'}};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([live]));
 const liveBefore=JSON.stringify(live);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null},{category:'loras',name:'style.safetensors',family:'sdxl',path:'/m/lora',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'DEAS_ImagePostprocessGate','ModelAttentionBackend','EasyCache','TorchCompileModel','VAEDecodeTiled','CLIPVisionLoader','LoadImage','CLIPVisionEncode','unCLIPConditioning'],attention:['sdpa'],compile:['inductor'],visionModels:['vision.safetensors'],images:['first.png','second.png']}});
 vi.mocked(invoke).mockImplementation(async c=>c==='native_jobs_history'?{schemaVersion:1,records:[original],readOnly:false,error:null}:{path:'/env/ComfyUI/input',parent:'/env',entries:['first.png','second.png'].map(name=>({name,path:'/env/ComfyUI/input/'+name,kind:'file',media:'image',size:1,modified:1,symlink:false})),truncated:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 const probes=vi.mocked(checkRecipePrerequisites).mock.calls.length;
 await openHistoryRecord();
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).not.toBe(historicalImage.positivePrompt);
 fireEvent.click(screen.getByRole('button',{name:'Apply partial settings'}));
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe(historicalImage.positivePrompt);
 expect((screen.getByRole('spinbutton',{name:'Seed'}) as HTMLInputElement).value).toBe(String(historicalImage.seed));
 expect(screen.getByRole('button',{name:'Fixed',pressed:true})).toBeTruthy();
 expect(document.querySelectorAll('[data-reference-controls]')).toHaveLength(2);
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(probes);expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);
 expect(document.querySelectorAll('[data-reference-controls] img')).toHaveLength(0);
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'second.png'}));
 fireEvent.click(document.querySelector('[data-history-reference-select="0"]')!);
 const transfer=new Map<string,string>();const data={clearData:()=>transfer.clear(),setData:(key:string,value:string)=>transfer.set(key,value),getData:(key:string)=>transfer.get(key)??'',get types(){return [...transfer.keys()];}};
 fireEvent.dragStart(screen.getByRole('button',{name:'first.png'}),{dataTransfer:data});
 fireEvent.drop(document.querySelectorAll('[data-reference-controls]')[1],{dataTransfer:data});
 expect(document.querySelectorAll('[data-reference-controls]')).toHaveLength(2);
 expect(document.querySelectorAll('[data-reference-controls] img')).toHaveLength(2);
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(probes);expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false);
 // This separate user Run is the first computation/transfer, using the restored order and strengths.
 vi.mocked(uploadInput).mockImplementation(async(_base,path)=>path.endsWith('second.png')?'uploaded-second.png':'uploaded-first.png');
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('new-history-run','failed'),baseUrl:evidence.baseUrl});
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({...historicalImage,seed:historicalImage.seed,outputPrefix:expect.stringMatching(/^raw\/image\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}-987654321-a$/),loras:[{name:'style.safetensors',strength:0.75}],options:{attention:'sdpa',cache:{node:'EasyCache',threshold:0.03},compile:'inductor',vaeTile:1536},imageReference:{visionModel:'vision.safetensors',images:[{image:'uploaded-second.png',strength:0.2},{image:'uploaded-first.png',strength:0.9}]},refine:{width:2432,height:1664,denoise:0.35},imageFormat:'webp',imageCompression:83});
 expect(JSON.stringify(original)).toBe(encoded);expect(JSON.stringify(live)).toBe(liveBefore);
});

test('partial history restore clears unrelated input and keeps unresolved mask/reference gates blocking Run',async()=>{
 const original=recentHistoryRecord({...historicalImage,inputImage:'missing-input.png',inputMask:'deas-masks/missing.png',imageReference:{visionModel:'missing-vision.safetensors',images:[{image:'missing-ref.png',strength:0.4}]}});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(invoke).mockImplementation(async c=>c==='native_jobs_history'?{schemaVersion:1,records:[original],readOnly:false,error:null}:{entries:[],truncated:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 await openHistoryRecord();expect(screen.getByText(/Cannot reconstruct.*inputMask/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Apply partial settings'}));
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);
 expect(document.querySelector('[data-history-draft]')?.textContent).toContain('inputMask');
 expect(document.querySelector('[data-reference-controls]')?.textContent).toContain('missing-ref.png');
 expect(document.querySelector('.wb-editor-host')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 fireEvent.click(document.querySelector('[data-run]')!);
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();
});

test('history authoring uses active project autosave and keeps failed-save unsaved protection',async()=>{
 const original=recentHistoryRecord(historicalImage);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(invoke).mockImplementation(async c=>{if(c==='native_project_open')return projectFixture;if(c==='native_jobs_history')return {schemaVersion:1,records:[original],readOnly:false,error:null};if(c==='native_project_save')throw Error('disk full');return {entries:[],truncated:false};});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Open project'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Open project'}));
 await waitFor(()=>expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe(projectFixture.draft.positivePrompt));
 await openHistoryRecord();expect(screen.getByText(/active project keeps its autosave/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Apply settings'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_project_save',expect.objectContaining({projectId:projectFixture.id,draft:expect.objectContaining({positivePrompt:historicalImage.positivePrompt,seed:historicalImage.seed,width:historicalImage.width,height:historicalImage.height})})));
 expect(document.querySelector('#project-status-slot')?.textContent).not.toContain('Saved');
 const restart=new Event('deas:before-update-restart',{cancelable:true});window.dispatchEvent(restart);expect(restart.defaultPrevented).toBe(true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('history text-to-image keeps native-valid 1000 square canvas without family-preset snapping',async()=>{
 // 1088 is a 17x64 square: valid on SDXL's own 64 grid (PLAN D-15: the family plugin's
 // `multiple` is the canvas law, so a 1000 square is refused instead of padded inside the
 // model) and outside every preset bucket, which is what this test is about — an applied
 // history record keeps its EXACT canvas instead of snapping to the nearest preset.
 const original=recentHistoryRecord({...historicalImage,width:1088,height:1088});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(invoke).mockImplementation(async c=>c==='native_jobs_history'?{schemaVersion:1,records:[original],readOnly:false,error:null}:{entries:[],truncated:false});
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('exact-square-run','failed'),baseUrl:evidence.baseUrl});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 await openHistoryRecord();fireEvent.click(screen.getByRole('button',{name:'Apply settings'}));
 expect(runWorkbenchJob).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false);
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({width:1088,height:1088,seed:historicalImage.seed});
});

test('Forge canvas handoff uses effective fixed dimensions and preserves immutable jobs until explicit Run',async()=>{
 // 1088/1216 are both SDXL 64-grid edges (PLAN D-15 `requiredCanvasGrid`): the fixed
 // canvas survives the handoff verbatim, and the published context names the grid the
 // canvas must sit on.
 for(const [key,value] of Object.entries({resolution:'fixed',width:1088,height:1088,seed:73,seedMode:'fixed',positive:'original draft',negative:'kept negative'}))localStorage.setItem('deas.pref.studio.run.'+key,JSON.stringify(value));
 const held={...heldJob('before-forge','failed'),intent:{...historicalImage,positivePrompt:'immutable job'}};
 const before=JSON.stringify(held);vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([held]));
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const publish=vi.fn<(context:ForgeCanvasContext|undefined)=>void>();
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'},onCanvasContext:publish};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 const context=await waitFor(()=>{const value=publish.mock.calls.at(-1)?.[0];expect(value?.effective).toEqual({width:1088,height:1088});return value!;});
 expect(context.requiredGrid).toBe(64);expect(context.grid).toBe(64);expect(context.acceptsCanvas?.({width:1088,height:1088})).toBe(true);
 // A canvas off the family grid is refused, not silently padded: 1000 clears the generic
 // 8-cell wall and SDXL's UNet would pad the latent inside the model.
 expect(context.acceptsCanvas?.({width:1000,height:1000})).toBe(false);
 const probes=vi.mocked(checkRecipePrerequisites).mock.calls.length;
 // Publishing a read-only context never changes authoring or starts work.
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('original draft');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 view.rerender(<I18nProvider><Workbench {...props} incoming={{positive:'sent landscape',negative:'',n:1,canvas:{contextKey:context.key,canvas:{width:1216,height:832}}}}/></I18nProvider>);
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('sent landscape');
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1216');expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('832');
 expect((screen.getByLabelText('Resolution') as HTMLSelectElement).value).toBe('fixed');
 expect((screen.getByLabelText('Seed') as HTMLInputElement).value).toBe('73');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.negative')!)).toBe('kept negative');
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(probes);expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();expect(JSON.stringify(held)).toBe(before);
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('after-forge','failed'),baseUrl:evidence.baseUrl});
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({positivePrompt:'sent landscape',negativePrompt:'kept negative',checkpoint:'a.safetensors',seed:73,width:1216,height:832});expect(JSON.stringify(held)).toBe(before);
});

test('Forge canvas rejects stale or invalid handoffs before changing text and keeps prompt-only callers compatible',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 localStorage.setItem('deas.pref.studio.run.positive',JSON.stringify('original'));
 const publish=vi.fn<(context:ForgeCanvasContext|undefined)=>void>();const props={endpoint:evidence.baseUrl,roots:{models:'/m'},onCanvasContext:publish};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 const context=await waitFor(()=>{const value=publish.mock.calls.at(-1)?.[0];expect(value?.effective).not.toBeNull();expect(value?.acceptsCanvas?.({width:1024,height:1024})).toBe(true);return value!;});
 for(const [n,contextKey,canvas] of [[1,'stale-context',{width:1216,height:832}],[2,context.key,{width:8192,height:8192}]] as const){
  view.rerender(<I18nProvider><Workbench {...props} incoming={{positive:'must not apply',negative:'',n,canvas:{contextKey,canvas}}}/></I18nProvider>);
  expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('original');
 }
 view.rerender(<I18nProvider><Workbench {...props} incoming={{positive:'prompt-only',negative:'',n:3}}/></I18nProvider>);
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('prompt-only');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();
});

test('Forge canvas uses actual inpaint source and preserves editor identity and the required mask gate',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(_command,args)=>({path:(args as {path?:string})?.path??'/env/out',parent:'/env',entries:[{name:'wide.png',path:'/env/out/wide.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 const publish=vi.fn<(context:ForgeCanvasContext|undefined)=>void>();const props={endpoint:evidence.baseUrl,roots:{models:'/m',output:'/env/out'},onCanvasContext:publish};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'wide.png'}));adopt();
 const img=screen.getByRole('img',{name:'wide.png'});Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);
 fireEvent.click(screen.getByRole('button',{name:'Inpaint'}));
 const context=await waitFor(()=>{const value=publish.mock.calls.at(-1)?.[0];expect(value?.effective).toEqual({width:1024,height:640});expect(value?.requiredGrid).toBe(64);return value!;});
 expect(context.acceptsCanvas?.({width:1216,height:832})).toBe(false);expect(context.acceptsCanvas?.({width:1024,height:640})).toBe(true);
 const editor=document.querySelector('.wb-editor-host');expect(editor).not.toBeNull();
 view.rerender(<I18nProvider><Workbench {...props} incoming={{positive:'inpaint draft',negative:'',n:1,canvas:{contextKey:context.key,canvas:{width:1024,height:640}}}}/></I18nProvider>);
 expect(document.querySelector('.wb-editor-host')).toBe(editor);expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('inpaint draft');
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);expect(screen.getByRole('button',{name:'Inpaint',pressed:true})).toBeTruthy();
 expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each([['ltx-2',32],['minimax-h3',32]] as const)('Forge canvas retains required video alignment for %s without accepting an image-valid fixed square',async(family,grid)=>{
 for(const [key,value] of Object.entries({pipeline:'t2v',resolution:'fixed',width:1000,height:1000,checkpoint:'video.safetensors'}))localStorage.setItem('deas.pref.studio.run.'+key,JSON.stringify(value));
 vi.mocked(scanModels).mockResolvedValue([{category:'unet',name:'video.safetensors',family,path:'/m/video',size:1,info:null}]);
 const publish=vi.fn<(context:ForgeCanvasContext|undefined)=>void>();
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}} onCanvasContext={publish}/></I18nProvider>);
 await waitFor(()=>{const value=publish.mock.calls.at(-1)?.[0];expect(value?.grid).toBe(grid);expect(value?.requiredGrid).toBe(grid);expect(value?.effective).toBeNull();expect(value?.acceptsCanvas?.({width:1000,height:1000})).toBe(false);expect(value?.acceptsCanvas?.({width:1024,height:1024})).toBe(true);});
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();
});

test('Forge canvas handoff follows project autosave and retains failed-save unsaved protection',async()=>{
 const saved={...projectFixture,draft:{...projectFixture.draft,checkpoint:'a.safetensors',pipeline:'t2i'}};
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async command=>{
    if (command === 'native_audio_enhance_install_status') return { running: false, mode: '', stage: '', downloaded: 0, total: 0 };if(command==='native_project_open')return saved;if(command==='native_project_save')throw Error('disk full');return {entries:[],truncated:false};});
 const publish=vi.fn<(context:ForgeCanvasContext|undefined)=>void>();const props={endpoint:evidence.baseUrl,roots:{models:'/m'},onCanvasContext:publish};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Open project'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Open project'}));
 await waitFor(()=>expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe(saved.draft.positivePrompt));
 const context=await waitFor(()=>{const value=publish.mock.calls.at(-1)?.[0];expect(value?.key).toContain(saved.id);expect(value?.effective).toEqual({width:1024,height:1024});return value!;});
 view.rerender(<I18nProvider><Workbench {...props} incoming={{positive:'project landscape',negative:'',n:1,canvas:{contextKey:context.key,canvas:{width:1216,height:832}}}}/></I18nProvider>);
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_project_save',expect.objectContaining({projectId:saved.id,draft:expect.objectContaining({positivePrompt:'project landscape',width:1216,height:832,seed:42,checkpoint:'a.safetensors'})})));
 const restart=new Event('deas:before-update-restart',{cancelable:true});window.dispatchEvent(restart);expect(restart.defaultPrevented).toBe(true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();
});

test('history source collision stays unresolved until explicit Media selection and invalidates again on input-root changes',async()=>{
 const original={...recentHistoryRecord({...historicalImage,inputImage:'same.png',denoise:0.6}),outputRoot:'/environment-B/output',outputRootIdentity:'output-is-not-input-provenance'};
 const before=JSON.stringify(original),endpoint='http://127.0.0.1:7801/backend-B/';
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,images:['same.png','unrelated.png']}});
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_jobs_history'?{schemaVersion:1,records:[original],readOnly:false,error:null}:{path:(args as {path?:string})?.path??'/environment-B/input',parent:'/environment-B',entries:['same.png','unrelated.png'].map(name=>({name,path:((args as {path?:string})?.path??'/environment-B/input')+'/'+name,kind:'file',media:'image',size:1,modified:1,symlink:false})),truncated:false});
 const props={endpoint,roots:{models:'/m',input:'/environment-B/input',output:'/environment-B/output'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'unrelated.png'}));adopt();
 const unrelated=screen.getByRole('img',{name:'unrelated.png'});Object.defineProperties(unrelated,{naturalWidth:{value:1216},naturalHeight:{value:832}});fireEvent.load(unrelated);
 const probes=vi.mocked(checkRecipePrerequisites).mock.calls.length;
 await openHistoryRecord();fireEvent.click(screen.getByRole('button',{name:'Apply partial settings'}));fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);expect(document.querySelector('.wb-editor-host')).toBeNull();
 expect(document.querySelector('[data-history-draft]')?.textContent).toContain('same.png');
 fireEvent.click(screen.getByRole('button',{name:'same.png'}));
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true); // Preview alone is not source selection.
 adopt();const chosen=screen.getByRole('img',{name:'same.png'});Object.defineProperties(chosen,{naturalWidth:{value:1216},naturalHeight:{value:832}});fireEvent.load(chosen);
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false);
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(probes);expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
 view.rerender(<I18nProvider><Workbench {...props} roots={{...props.roots,input:'/environment-C/input'}}/></I18nProvider>);
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);expect(document.querySelector('.wb-editor-host')).toBeNull();
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);expect(JSON.stringify(original)).toBe(before);
});

test('history native references require explicit ordered replacement and reselect after same-origin backend-prefix changes',async()=>{
 const original=recentHistoryRecord({...historicalImage,checkpoint:'qwen.safetensors',width:1024,height:1024,diffusion:{textEncoder:'qwen3vl_8b.safetensors',clipType:'qwen_image',vae:'qwen_image_2.1_vae.safetensors'},nativeImageReference:{method:'qwen-image-2.1',images:['same.png','second.png']}});
 const before=JSON.stringify(original),input='/environment-B/input';
 vi.mocked(scanModels).mockResolvedValue(referenceModels());
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...refsEvidence,allowlist:{...refsEvidence.allowlist,nodes:[...refsEvidence.allowlist.nodes,...referenceNodes,'UNETLoader','CLIPLoader','VAELoader'],images:['same.png','second.png'],textEncoders:['qwen3vl_8b.safetensors'],vaes:['qwen_image_2.1_vae.safetensors']}});
 vi.mocked(invoke).mockImplementation(async command=>command==='native_jobs_history'?{schemaVersion:1,records:[original],readOnly:false,error:null}:{entries:[],truncated:false});
 const props={endpoint:'http://127.0.0.1:7801/backend-A/',roots:{models:'/m',input}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 const probes=vi.mocked(checkRecipePrerequisites).mock.calls.length;
 await openHistoryRecord();fireEvent.click(screen.getByRole('button',{name:'Apply partial settings'}));fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);expect(document.querySelectorAll('[data-reference-controls] img')).toHaveLength(0);
 for(const media of ['video','audio']){
  let readable=false;const transfer={types:['application/x-deas-media'],getData:()=>readable?JSON.stringify({name:'not-an-image',path:input+'/foreign.bin',media,src:'asset://foreign'}):'',dropEffect:'none'};
  fireEvent.dragOver(document.querySelectorAll('[data-reference-controls]')[0],{dataTransfer:transfer});expect(transfer.dropEffect).toBe('none');
  readable=true;fireEvent.drop(document.querySelectorAll('[data-reference-controls]')[0],{dataTransfer:transfer});
  expect(document.querySelectorAll('[data-reference-controls] img')).toHaveLength(0);
 }
 dropHistoryReference(0,'current-two.png',input+'/current-two.png');dropHistoryReference(1,'current-one.png',input+'/current-one.png');
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false);expect(screen.queryByLabelText('Reference strength')).toBeNull();
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(probes);expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
 const nextEndpoint='http://127.0.0.1:7801/backend-B/';view.rerender(<I18nProvider><Workbench {...props} endpoint={nextEndpoint}/></I18nProvider>);
 await waitFor(()=>expect(checkRecipePrerequisites).toHaveBeenCalledTimes(probes+1));
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);expect(document.querySelectorAll('[data-reference-controls] img')).toHaveLength(0);
 dropHistoryReference(0,'current-two.png',input+'/current-two.png');dropHistoryReference(1,'current-one.png',input+'/current-one.png');
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false);
 vi.mocked(uploadInput).mockImplementation(async(_endpoint,path)=>path.endsWith('current-two.png')?'uploaded-two.png':'uploaded-one.png');
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('explicit-history-reference','failed'),baseUrl:nextEndpoint});
 fireEvent.click(document.querySelector('[data-run]')!);await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][0]).toBe(nextEndpoint);
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({seed:historicalImage.seed,width:1024,height:1024,nativeImageReference:{method:'qwen-image-2.1',images:['uploaded-two.png','uploaded-one.png']}});
 expect(JSON.stringify(original)).toBe(before);
});

test('history video first and last frames remain unresolved until each explicit Media choice without upload or probes',async()=>{
 const original=recentHistoryRecord({recipeId:'video-generation',version:1,family:'ltx-2',positivePrompt:'historical video',negativePrompt:'',model:'LTX2/ltx.safetensors',textEncoder:'gemma_3_12B_it_fp8.safetensors',vae:'LTX2/LTX23_video_vae_bf16.safetensors',seed:43,width:1024,height:768,frames:49,frameRate:24,steps:20,cfg:5,sampler:'euler',scheduler:'normal',outputPrefix:'raw/history/video',output:{codec:'Auto',container:'Auto',bitDepth:'Auto',quality:20,audioCodec:'Auto',audioBitrate:'192k',saveFirstFrame:false,saveLastFrame:false},firstFrame:'same.png',lastFrame:'same-last.png',ltx:{passes:1,audioVae:'LTX2/LTX23_audio_vae_bf16.safetensors',textProjection:'ltx-2.3_text_projection_bf16.safetensors'}});
 const before=JSON.stringify(original),input='/environment-B/input';
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([{...heldJob('old-frame-result','succeeded'),outputRoot:'/environment-A/output',outputs:[{filename:'foreign-last.png',subfolder:'raw',type:'output'}]}]));
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,images:['same.png','same-last.png'],textEncoders:['gemma_3_12B_it_fp8.safetensors','ltx-2.3_text_projection_bf16.safetensors'],vaes:['LTX2/LTX23_video_vae_bf16.safetensors','LTX2/LTX23_audio_vae_bf16.safetensors']}});
 vi.mocked(invoke).mockImplementation(async command=>command==='native_jobs_history'?{schemaVersion:1,records:[original],readOnly:false,error:null}:command==='native_media_star_status'?{starred:false,unavailable:null}:{path:input,parent:'/environment-B',entries:['same.png','same-last.png'].map(name=>({name,path:input+'/'+name,kind:'file',media:'image',size:1,modified:1,symlink:false})),truncated:false});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801/backend-B/" roots={{models:'/m',input}}/></I18nProvider>);
 await waitFor(()=>expect(scanModels).toHaveBeenCalled());const probes=vi.mocked(checkRecipePrerequisites).mock.calls.length;
 await openHistoryRecord();fireEvent.click(screen.getByRole('button',{name:'Apply partial settings'}));fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);
 expect(document.querySelector('[data-history-draft]')?.textContent).toContain('same-last.png');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'same.png'}));adopt();
 const chosen=screen.getByRole('img',{name:'same.png'});Object.defineProperties(chosen,{naturalWidth:{value:1024},naturalHeight:{value:768}});fireEvent.load(chosen);
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);
 fireEvent.click(document.querySelector('[data-job-id="old-frame-result"] .wb-queue-select')!);
 fireEvent.click(within(document.querySelector<HTMLElement>('.wb-stage > [data-media-tools]')!).getByRole('button',{name:'Use as last frame'}));
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false); // Explicit external frames upload on Run; history's unresolved name alone never does.
 fireEvent.click(screen.getByRole('button',{name:'same-last.png'}));fireEvent.click(within(document.querySelector<HTMLElement>('.wb-stage > [data-media-tools]')!).getByRole('button',{name:'Use as last frame'}));
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false);
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(probes);expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();expect(JSON.stringify(original)).toBe(before);
});

test.each([
 ['text','T2VA',[]],['first','I2VA',[{slot:0,image:'uploaded/frame.png'}]],
 ['last','L2VA',[{slot:1,image:'uploaded/frame.png'}]],
 ['both','FL2VA',[{slot:0,image:'uploaded/frame.png'},{slot:1,image:'uploaded/frame.png'}]],
 ['reference','REF2VA',[]],
] as const)('Video roles preserve the captured H3 %s intent shape',async(role,mode,references)=>{
 await roleVideoFixture('minimax-h3');
 expect([...document.querySelector<HTMLSelectElement>('[data-pipeline]')!.options].map(o=>o.value)).toEqual(['image','video','music']);
 if(role!=='text'){assignRole('frame.png',role);closeRoles();}
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const intent=vi.mocked(runWorkbenchJob).mock.lastCall![1];
 expect(intent).toMatchObject({family:'minimax-h3',h3:{mode,references}});
 if(role==='reference')expect(intent).toMatchObject({h3:{media:[{type:'image',slot:0,file:'uploaded/frame.png'}]}});
 expect(document.querySelector('[data-video-mode]')?.textContent).toContain(mode);
});

test('LTX retains independent source, first, last and ordered guides, uploading every external frame on explicit Run only',async()=>{
 await roleVideoFixture();
 assignRole('first.png','first');assignRole('last.png','last');assignRole('source.mp4','source','video');assignRole('guide.png','reference');
 fireEvent.change(screen.getByLabelText('Second of guide.png'),{target:{value:'1'}});
 fireEvent.change(screen.getByLabelText('Strength of guide.png'),{target:{value:'0.5'}});
 closeRoles();
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(uploadInput).mock.calls.map(c=>c[1]).sort()).toEqual(['/external/first.png','/external/last.png','/external/source.mp4','/external/guide.png'].sort());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({family:'ltx-2',firstFrame:'uploaded/first.png',lastFrame:'uploaded/last.png',sourceVideo:'uploaded/source.mp4',ltx:{keyframes:[{image:'uploaded/guide.png',frame:24,strength:0.5}]}});
});

test('H3 duplicate pictures keep independent editors, moves and removal; Run uploads once and retains both slots',async()=>{
 await roleVideoFixture('minimax-h3',false,'ref2v');
 assignRole('same.png','reference');assignRole('same.png','reference');
 const rows=()=>Array.from(document.querySelectorAll<HTMLElement>('[data-ref="same.png"]'));
 expect(rows()).toHaveLength(2);
 fireEvent.click(rows()[1].querySelector('.reference-icon-edit')!);
 fireEvent.change(document.querySelector('[data-ref-label]')!,{target:{value:'style'}});
 fireEvent.change(document.querySelector('[data-ref-instructions]')!,{target:{value:'Use the colors'}});
 fireEvent.click(within(screen.getByRole('dialog',{name:'Edit same.png'})).getByRole('button',{name:'Close'}));
 expect(rows()[0].querySelector('.reference-card-summary')?.textContent).toBe('Character 1');
 expect(rows()[1].querySelector('.reference-card-summary')?.textContent).toBe('Style');
 fireEvent.click(rows()[1].querySelector('.reference-icon-earlier')!);
 expect(rows()[0].querySelector('.reference-card-summary')?.textContent).toBe('Style');
 fireEvent.click(rows()[0].querySelector('.reference-icon-remove')!);
 expect(rows()).toHaveLength(1);expect(rows()[0].querySelector('.reference-card-summary')?.textContent).toBe('Character 1');
 assignRole('same.png','reference');closeRoles();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(uploadInput).toHaveBeenCalledTimes(1);
 const intent=vi.mocked(runWorkbenchJob).mock.lastCall![1];
 expect(intent).toMatchObject({h3:{mode:'REF2VA',media:[{type:'image',slot:0,file:'uploaded/same.png'},{type:'image',slot:1,file:'uploaded/same.png'}]}});
 expect(JSON.stringify(intent)).not.toContain('uiKey');
});

test('repeated H3 pictures count toward the same nine-image limit',async()=>{
 await roleVideoFixture('minimax-h3',false,'ref2v');
 for(let i=0;i<9;i++)assignRole('same.png','reference');
 expect(document.querySelectorAll('[data-ref="same.png"]')).toHaveLength(9);
 expect(document.querySelector('[data-reference-lane="image"] .reference-count')?.textContent).toBe('9 / 9');
 assignRole('same.png','reference');
 expect(document.querySelector('[data-video-role="reference"]')).toHaveProperty('disabled',true);
 expect(document.querySelectorAll('[data-ref="same.png"]')).toHaveLength(9);
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('H3 disabled mixing preserves the existing frame and no picker preview adopts or submits',async()=>{
 await roleVideoFixture('minimax-h3');assignRole('first.png','first');
 fireEvent.drop(document.querySelector('[data-open-references]')!,{dataTransfer:{types:['application/x-deas-media'],getData:()=>JSON.stringify(roleFile('preview.png'))}});
 fireEvent.change(document.querySelector('.reference-assignment select')!,{target:{value:'reference'}});
 const reference=document.querySelector<HTMLButtonElement>('[data-video-role="reference"]')!;
 expect(reference.disabled).toBe(true);expect(reference.title).toContain('cannot be mixed');fireEvent.click(reference);
 expect(document.querySelector('[data-video-role-card="first"]')?.textContent).toContain('first.png');
 expect(document.querySelectorAll('[data-ref]')).toHaveLength(0);
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('all Video roles survive exact-model draft round trips and current prompts carry over',async()=>{
 await roleVideoFixture('ltx-2',true);assignRole('first.png','first');assignRole('source.mp4','source','video');closeRoles();
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'edited prompt'}});
 fireEvent.change(document.querySelector('[data-model-picker]')!,{target:{value:'other.safetensors'}});
 assignRole('second.png','first');closeRoles();fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'current prompt'}});
 fireEvent.change(document.querySelector('[data-model-picker]')!,{target:{value:'LTX2/ltx.safetensors'}});
 fireEvent.click(document.querySelector('[data-open-references]')!);
 expect(document.querySelector('[data-video-role-card="first"]')?.textContent).toContain('first.png');
 expect(document.querySelector('[data-video-role-card="source"]')?.textContent).toContain('source.mp4');
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','current prompt');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('Beginner isolates and restores the Advanced independent source video and shows one Video choice',async()=>{
 const {view,props}=await roleVideoFixture();assignRole('source.mp4','source','video');closeRoles();
 view.rerender(<I18nProvider><Workbench {...props} beginner/></I18nProvider>);
 expect([...document.querySelector<HTMLSelectElement>('#beginner-mode')!.options].filter(o=>o.value==='video')).toHaveLength(1);
 fireEvent.click(document.querySelector('[data-open-references]')!);expect(document.querySelector('[data-video-role-card="source"]')).toBeNull();closeRoles();
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);fireEvent.click(document.querySelector('[data-open-references]')!);
 expect(document.querySelector('[data-video-role-card="source"]')?.textContent).toContain('source.mp4');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('returning to an H3 scope restores its reference draft after another scope became empty',async()=>{
 const {view,props}=await roleVideoFixture('minimax-h3');
 assignRole('saved-guide.png','reference');closeRoles();
 view.rerender(<I18nProvider><Workbench {...props} roots={{models:'/m2',input:'/input'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-open-references]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-open-references]')!);
 fireEvent.click(within(screen.getByRole('dialog',{name:'References'})).getByRole('button',{name:'Clear'}));closeRoles();
 await waitFor(()=>expect(document.querySelector('[data-video-mode]')?.textContent).toContain('T2VA'));
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-video-mode]')?.textContent).toContain('REF2VA'));
 fireEvent.click(document.querySelector('[data-open-references]')!);
 expect(document.querySelector('[data-ref="saved-guide.png"]')).not.toBeNull();
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('empty pinned H3 Continuity retains its reference mode instead of becoming a new text draft',async()=>{
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({session:'role-session',outputMode:'full',enabled:true,source:{clipId:'pinned',endpoint:evidence.baseUrl},steps:[]}));
 await roleVideoFixture('minimax-h3',false,'ref2v');
 expect(captureStudioSettings()['studio.run.pipeline']).toBe('ref2v');
 expect(document.querySelector('[data-video-mode]')?.textContent).toContain('REF2VA');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('pinned H3 Continuity refuses removing its last reference and preserves the source mode family',async()=>{
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({session:'role-session',outputMode:'full',enabled:true,source:{clipId:'pinned',endpoint:evidence.baseUrl},steps:[]}));
 await roleVideoFixture('minimax-h3',false,'ref2v');assignRole('guide.png','reference');closeRoles();
 fireEvent.click(document.querySelector('[data-open-references]')!);fireEvent.click(screen.getByRole('button',{name:'Remove reference guide.png'}));
 expect(document.querySelector('[data-ref="guide.png"]')).not.toBeNull();
 expect(document.querySelector('[data-video-mode]')?.textContent).toContain('REF2VA');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('search opens the empty Video roles editor without adopting media or submitting',async()=>{
 await roleVideoFixture();
 let outcome;act(()=>{outcome=revealTarget('[data-video-role="first"]');});
 expect(outcome).toMatchObject({state:'disabled'});
 expect(screen.getByRole('dialog',{name:'References'})).toBeTruthy();
 expect(document.querySelector('[data-video-role-card]')).toBeNull();
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('H3 role search selects the requested role but does not assign without a picked file',async()=>{
 await roleVideoFixture('minimax-h3');
 let outcome;act(()=>{outcome=revealTarget('[data-video-role="first"]');});
 expect(outcome).toMatchObject({state:'disabled'});
 expect(document.querySelector<HTMLSelectElement>('.reference-assignment select')?.value).toBe('first');
 expect(document.querySelector('[data-video-role="first"]')).toHaveProperty('disabled',true);
 expect(document.querySelector('[data-video-role-card]')).toBeNull();
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['i2v','ref2v','v2v'])('empty ordinary H3 draft resets stale %s preference to text-to-video',async previous=>{
 await roleVideoFixture('minimax-h3',false,previous);
 await waitFor(()=>expect(captureStudioSettings()['studio.run.pipeline']).toBe('t2v'));
 expect(document.querySelector('[data-video-mode]')?.textContent).toContain('T2VA');
 expect(document.querySelector('[data-open-references]')?.textContent).toContain('0');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({h3:{mode:'T2VA',references:[]}});
});

test.each(['i2v','ref2v','v2v'])('legacy Video preference %s remains readable and missing input never collapses to text mode',async pipeline=>{
 await roleVideoFixture('ltx-2',false,pipeline);
 expect(document.querySelector('[data-pipeline]')).toHaveProperty('value','video');
 expect(captureStudioSettings()['studio.run.pipeline']).toBe(pipeline);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('H3 RefMods survive switching to LTX, block unsupported Run and can be removed explicitly',async()=>{
 const {view,props}=await roleVideoFixture('minimax-h3');
 fireEvent.click(document.querySelector('[data-open-references]')!);
 vi.mocked(readRefMods).mockResolvedValue([{name:'hero',kinds:['image'],description:'hero'}]);
 fireEvent.click(screen.getByRole('button',{name:'Read RefMod library'}));fireEvent.click(await screen.findByRole('button',{name:'Add RefMod'}));closeRoles();
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 view.rerender(<I18nProvider><Workbench {...props} roots={{models:'/m2',input:'/input'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('LTX2/ltx.safetensors'));
 fireEvent.change(document.querySelector('[data-model-picker]')!,{target:{value:'LTX2/ltx.safetensors'}});
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 fireEvent.click(document.querySelector('[data-open-references]')!);
 expect(document.querySelector('[data-video-refmods-clear]')).not.toBeNull();
 fireEvent.click(document.querySelector('[data-video-refmods-clear]')!);expect(document.querySelector('[data-video-refmods-clear]')).toBeNull();
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('restored LTX source history is satisfied by its explicit independent video role, not the preview media slot',async()=>{
 const {view,props}=await roleVideoFixture();assignRole('source.mp4','source','video');closeRoles();
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const intent=vi.mocked(runWorkbenchJob).mock.lastCall![1];const original=recentHistoryRecord(intent as Parameters<typeof recentHistoryRecord>[0]);view.unmount();
 const previous=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_jobs_history'?{schemaVersion:1,records:[original],readOnly:false,error:null}:previous(command,args));
 render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await openHistoryRecord();fireEvent.click(screen.getByRole('button',{name:'Apply partial settings'}));fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 assignRole('frame.png','first');assignRole('replacement.mp4','source','video');closeRoles();
 expect(document.querySelector('[data-history-draft]')?.textContent).not.toContain('Reselect input');
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false);
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
});

test('LTX disables the ninth guide without replacing, reordering or uploading the existing eight',async()=>{
 await roleVideoFixture();
 for(let i=0;i<8;i++)assignRole(`guide-${i}.png`,'reference');
 fireEvent.drop(document.querySelector('[data-open-references]')!,{dataTransfer:{types:['application/x-deas-media'],getData:()=>JSON.stringify(roleFile('ninth.png'))}});
 expect(document.querySelector<HTMLButtonElement>('[data-video-role="reference"]')!.disabled).toBe(true);
 fireEvent.click(document.querySelector('[data-video-role="reference"]')!);
 expect([...document.querySelectorAll('[data-ref]')].map(e=>e.getAttribute('data-ref'))).toEqual(Array.from({length:8},(_,i)=>`guide-${i}.png`));
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('a pinned REF2VA pack replacing a RefMod with media retains reference mode atomically',async()=>{
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({session:'role-session',outputMode:'full',enabled:true,source:{clipId:'pinned',endpoint:evidence.baseUrl},steps:[]}));
 await roleVideoFixture('minimax-h3',false,'ref2v');fireEvent.click(document.querySelector('[data-open-references]')!);
 vi.mocked(readRefMods).mockResolvedValue([{name:'old-mod',kinds:['image'],description:'old'}]);
 fireEvent.click(screen.getByRole('button',{name:'Read RefMod library'}));fireEvent.click(await screen.findByRole('button',{name:'Add RefMod'}));
 const previous=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_json_open'?JSON.stringify({dasiwa_minimax_h3_reference_pack:true,schema_version:1,model_mode:'REF2VA',items:[{type:'image',value:'new.png',_rank:0}],refmods:[]}):command==='native_media_describe'?[{name:'new.png',path:'/input/new.png',kind:'file',symlink:false,media:'image',size:1,modified:1}]:previous(command,args));
 fireEvent.change(screen.getByRole('combobox',{name:'Load pack…'}),{target:{value:'replace'}});
 await waitFor(()=>expect(document.querySelector('[data-ref="new.png"]')).not.toBeNull());
 expect(document.querySelector('[data-video-mode]')?.textContent).toContain('REF2VA');
 expect(document.querySelector('[data-refmod="old-mod"]')).toBeNull(); // the library option stays available; its authored row was removed
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['model','custom'] as const)('LTX source-only geometry becomes ready after first-frame removal at %s resolution through NativeVideo',async resolution=>{
 const agent=vi.spyOn(navigator,'userAgent','get').mockReturnValue('Linux');
 try{
  await roleVideoFixture();
  const previous=vi.mocked(invoke).getMockImplementation()!;
  let ready=false;
  vi.mocked(invoke).mockImplementation(async(command,args)=>command.startsWith('native_video_')?{position:0,duration:5,width:ready?640:0,height:ready?1280:0,paused:true,muted:false,volume:100}:previous(command,args));
  assignRole('first.png','first');assignRole('source.mp4','source','video');
  fireEvent.change(document.querySelector('[data-resolution]')!,{target:{value:resolution}});
  fireEvent.change(document.querySelector('[data-aspect]')!,{target:{value:'auto'}});
  fireEvent.click(document.querySelector('[data-video-role-remove="first"]')!);closeRoles();
  expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_video_open',expect.objectContaining({source:{path:'/external/source.mp4'}})));
  ready=true;
  await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
  expect(document.querySelector('.wb-stage video')).toBeNull();
  expect(uploadInput).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Run'}));
  await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
  const intent=vi.mocked(runWorkbenchJob).mock.lastCall![1];
  expect(intent).toMatchObject({sourceVideo:'uploaded/source.mp4',...(resolution==='model'?{width:672,height:1344}:{width:736,height:1440})});expect(intent).not.toHaveProperty('firstFrame');
 }finally{cleanup();agent.mockRestore();}
});

test('Wan exposes retained unsupported guide and source cards for explicit recovery without upload',async()=>{
 const {view,props}=await roleVideoFixture();assignRole('first.png','first');assignRole('guide.png','reference');assignRole('source.mp4','source','video');closeRoles();
 const wan:LocalModel={category:'diffusion_models',name:'wan_high.safetensors',path:'/m/wan',family:'wan',size:1,info:null};
 vi.mocked(scanModels).mockResolvedValue([wan,{...wan,name:'wan_low.safetensors',path:'/m/wan-low'},{category:'text_encoders',name:'umt5_xxl_fp8.safetensors',path:'/m/umt5',size:1,info:null},{category:'vae',name:'wan_2.1_vae.safetensors',path:'/m/wan-vae',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'UNETLoader','CLIPLoader','VAELoader'],diffusionModels:[wan.name,'wan_low.safetensors'],textEncoders:['umt5_xxl_fp8.safetensors'],vaes:['wan_2.1_vae.safetensors'],clipTypes:['wan']}});
 view.rerender(<I18nProvider><Workbench {...props} roots={{models:'/m-wan',input:'/input'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain(wan.name));
 fireEvent.change(document.querySelector('[data-model-picker]')!,{target:{value:wan.name}});
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 fireEvent.click(document.querySelector('[data-open-references]')!);
 expect(document.querySelector('[data-ref="guide.png"]')).not.toBeNull();
 expect(document.querySelector('[data-video-role-card="source"]')?.textContent).toContain('source.mp4');
 fireEvent.click(screen.getByRole('button',{name:'Clear'}));
 expect(document.querySelector('[data-ref="guide.png"]')).toBeNull();
 expect(document.querySelector('[data-video-role-card="source"]')).not.toBeNull();
 fireEvent.click(document.querySelector('[data-video-role-remove="source"]')!);
 expect(document.querySelector('[data-video-role-card="source"]')).toBeNull();
 expect(document.querySelector('[data-video-role-card="first"]')?.textContent).toContain('first.png');
 closeRoles();const frame=screen.getByRole('img',{name:'first.png'});Object.defineProperties(frame,{naturalWidth:{value:720},naturalHeight:{value:1280}});fireEvent.load(frame);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}),document.querySelector('.wb-stage')?.textContent??'').toHaveProperty('disabled',false));
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('relocation repairs independent source and pending role picker before explicit uploads',async()=>{
 await roleVideoFixture();assignRole('source.mp4','source','video');
 fireEvent(window,new CustomEvent('deas-media-relocated',{detail:{oldPath:'/external/source.mp4',path:'/external/starred/source.mp4'}}));
 // Reassign from the retained picker too: neither handle may resurrect the old path.
 fireEvent.click(document.querySelector('[data-video-role="source"]')!);closeRoles();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(uploadInput).mock.calls.map(c=>c[1])).toEqual(['/external/starred/source.mp4']);
});

test('pinned REF2VA media-to-RefMod replacement is atomic and a refused pack leaves both lists intact',async()=>{
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({session:'role-session',outputMode:'full',enabled:true,source:{clipId:'pinned',endpoint:evidence.baseUrl},steps:[]}));
 await roleVideoFixture('minimax-h3',false,'ref2v');assignRole('old.png','reference');
 const previous=vi.mocked(invoke).getMockImplementation()!;
 let items:unknown[]=[];
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_json_open'?JSON.stringify({dasiwa_minimax_h3_reference_pack:true,schema_version:1,model_mode:'REF2VA',items,refmods:[{slot:1,name:'new-mod',strength:1}]}):command==='native_media_describe'?[{name:'bad.mp4',path:'/input/bad.mp4',kind:'file',symlink:false,media:'video',size:1,modified:1}]:previous(command,args));
 fireEvent.change(screen.getByRole('combobox',{name:'Load pack…'}),{target:{value:'replace'}});
 await waitFor(()=>expect(document.querySelector('[data-refmod="new-mod"]')).not.toBeNull());
 expect(document.querySelector('[data-ref="old.png"]')).toBeNull();expect(document.querySelector('[data-video-mode]')?.textContent).toContain('REF2VA');
 // Four visual videos exceed the Director's final-state limit; no replacement row may leak through.
 items=Array.from({length:4},(_,i)=>({type:'video',value:`bad-${i}.mp4`,_rank:i}));
 let describes=0;
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_json_open'?JSON.stringify({dasiwa_minimax_h3_reference_pack:true,schema_version:1,model_mode:'REF2VA',items,refmods:[{slot:1,name:'refused-mod',strength:1}]}):command==='native_media_describe'?[{name:`bad-${describes}.mp4`,path:`/input/bad-${describes++}.mp4`,kind:'file',symlink:false,media:'video',size:1,modified:1}]:previous(command,args));
 fireEvent.change(screen.getByRole('combobox',{name:'Load pack…'}),{target:{value:'replace'}});
 await waitFor(()=>expect(document.querySelector('[role="alert"]')?.textContent).toContain('bad-3.mp4'));
 expect(document.querySelector('[data-refmod="new-mod"]')).not.toBeNull();expect(document.querySelector('[data-refmod="refused-mod"]')).toBeNull();expect(document.querySelectorAll('[data-ref]')).toHaveLength(0);
 expect(document.querySelector('[data-video-mode]')?.textContent).toContain('REF2VA');expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('beginner offers exactly Image Video Music with capability reasons and derives Image intent on explicit adopt and clear',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{...yue2Models[1],family:'sdxl'}]);vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_media_star_status'?{starred:false,unavailable:null}:command==='native_jobs_history'?{schemaVersion:1,records:[],readOnly:false,error:null}:{path:(args as {path?:string})?.path??'/env/ComfyUI/output',parent:'/env',entries:mediaEntries,truncated:false});
 vi.mocked(uploadInput).mockResolvedValue('beginner-input.png');
 const view=render(beginnerView());
 await waitFor(()=>expect(captureStudioSettings()['studio.run.cfg']).toBe(3.5));
 const options=[...document.querySelector<HTMLSelectElement>('#beginner-mode')!.options];
 expect(options.map(o=>[o.value,o.textContent])).toEqual([['image','Image'],['video','Video'],['music','Music']]);
 expect(options.map(o=>o.disabled)).toEqual([false,true,true]);expect(options[1].title).not.toBe('');expect(options[2].title).not.toBe('');
 view.rerender(beginnerView(true,'collection'));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));
 expect(captureStudioSettings()['studio.run.pipeline']).toBe('t2i');
 fireEvent.click(within(document.querySelector('.beginner-collection-actions')!).getByRole('button',{name:'Use as picture to edit'}));
 view.rerender(beginnerView());
 await waitFor(()=>expect(captureStudioSettings()['studio.run.pipeline']).toBe('i2i'));
 const img=screen.getByRole('img',{name:'ref.png'});Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:1024}});fireEvent.load(img);
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'authored image'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('beginner-image','failed'),error:'fixture'});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({inputImage:expect.any(String),positivePrompt:'authored image',steps:28,cfg:3.5});
 fireEvent.click(screen.getByRole('button',{name:'Close preview'}));
 await waitFor(()=>expect(captureStudioSettings()['studio.run.pipeline']).toBe('t2i'));
 expect(document.querySelector('[data-image-mode]')!.textContent).toBe('Text → Image');
 expect(captureStudioSettings()['studio.run.positive']).toBe('authored image');
 expect(captureStudioSettings()['studio.run.cfg']).toBe(3.5);
});

test('beginner music model use exposes texts and shared settings, submits exact text cover and cleared intents only on Run',async()=>{
 const view=await mountMusic('Music (Text to Music)');
 vi.mocked(uploadInput).mockResolvedValue('beginner-cover.wav');
 view.rerender(beginnerView(true,'models'));
 fireEvent.click(screen.getByRole('button',{name:'Music'}));
 expect(screen.getAllByRole('button',{name:/Use this model/})).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:/Use this model/}));
 view.rerender(beginnerView());
 expect(document.querySelector<HTMLSelectElement>('#beginner-mode')!.value).toBe('music');
 expect(document.querySelector('[data-beginner-aspect]')).toBeNull();expect(document.querySelector('[data-num="steps"]')).toBeNull();
 fireEvent.change(music().style,{target:{value:'handwritten style'}});fireEvent.change(music().lyrics,{target:{value:'[Verse]\nhandwritten lyrics'}});
 for(const advanced of ['[data-music-planning]','[data-music-abc-settings]','[data-music-generation-settings]'])expect(document.querySelector(advanced)).toBeNull();
 fireEvent.change(screen.getByLabelText('Maximum duration (seconds)'),{target:{value:'90'}});
 const run=()=>screen.getByRole('button',{name:'Run'});
 await waitFor(()=>expect(run()).toHaveProperty('disabled',false));fireEvent.click(run());
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({recipeId:'music-generation',family:'yue2',mode:'t2m',style:'handwritten style',lyrics:'[Verse]\nhandwritten lyrics',maxDuration:90,steps:32,cfg:1,sampler:'dpm_2',scheduler:'sgm_uniform'});
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).not.toHaveProperty('sourcePath');expect(uploadInput).not.toHaveBeenCalled();
 view.rerender(beginnerView(true,'collection'));
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'voice.wav'}));
 expect(captureStudioSettings()['studio.run.pipeline']).toBe('t2m');
 fireEvent.click(within(document.querySelector('.beginner-collection-actions')!).getByRole('button',{name:'Use for music cover'}));
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
 view.rerender(beginnerView());
 expect(document.querySelector('[data-music-mode]')!.textContent).toBe('Music (Cover Music)');
 expect(screen.getByLabelText('SheetSage2 audio encoder')).toHaveProperty('value','sheetsage2_bf16.safetensors');
 fireEvent.change(screen.getByLabelText('Maximum duration (seconds)'),{target:{value:'180'}});
 await waitFor(()=>expect(run()).toHaveProperty('disabled',false));
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({...musicJob('cover-beginner'),state:'failed',error:'fixture'}));
 fireEvent.click(run());await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 expect(vi.mocked(uploadInput).mock.calls.map(c=>c[1])).toEqual(['/env/ComfyUI/input/voice.wav']);
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({mode:'cover',planning:'melody',sourceAudio:'beginner-cover.wav',audioEncoder:'sheetsage2_bf16.safetensors',maxDuration:180,style:'handwritten style',lyrics:'[Verse]\nhandwritten lyrics'});
 view.rerender(beginnerView(true,'collection'));
 await screen.findByRole('button',{name:'voice.wav'});fireEvent.click(menuOf('voice.wav').getByRole('menuitem',{name:'Remove cover source'}));
 view.rerender(beginnerView());
 expect(document.querySelector('[data-music-mode]')!.textContent).toBe('Music (Text to Music)');
 expect(screen.getByLabelText('Maximum duration (seconds)')).toHaveProperty('value','90');
 expect(uploadInput).toHaveBeenCalledTimes(1);
 fireEvent.click(run());await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(3));
 for(const key of ['sourceAudio','audioEncoder'])expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).not.toHaveProperty(key);
});

test('beginner music authored drafts and source roles survive experience switches while Advanced technical settings stay isolated',async()=>{
 localStorage.setItem('deas.pref.studio.run.negative',JSON.stringify('advanced negative'));
 const view=await mountMusic('Music (Text to Music)');
 fireEvent.change(music().style,{target:{value:'advanced style'}});
 fireEvent.change(screen.getByLabelText('Seed'),{target:{value:'321'}});
 view.rerender(beginnerView());
 fireEvent.change(music().style,{target:{value:'beginner style'}});fireEvent.change(music().lyrics,{target:{value:''}});
 fireEvent.change(screen.getByLabelText('Maximum duration (seconds)'),{target:{value:'75'}});
 view.rerender(beginnerView(true,'collection'));
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 await screen.findByRole('button',{name:'voice.wav'});fireEvent.click(menuOf('voice.wav').getByRole('menuitem',{name:'Use for music cover'}));
 view.rerender(beginnerView(false));
 await waitFor(()=>expect(music().style.value).toBe('beginner style'));
 expect(music().lyrics.value).toBe('');expect(document.querySelector('[data-music-source]')!.textContent).toContain('voice.wav');
 expect(document.querySelector('[data-music-mode]')!.textContent).toBe('Music (Cover Music)');
 expect(captureStudioSettings()['studio.run.negative']).toBe('advanced negative');expect(screen.getByLabelText('Seed')).toHaveProperty('value','321');
 fireEvent.click(document.querySelector('[data-music-source-remove]')!);
 expect(screen.getByLabelText('Maximum duration (seconds)')).toHaveProperty('value','75');
 view.rerender(beginnerView());view.rerender(beginnerView(false));
 expect(document.querySelector('[data-music-source]')!.textContent).not.toContain('voice.wav');expect(document.querySelector('[data-music-mode]')!.textContent).toBe('Music (Text to Music)');
 expect(music().style.value).toBe('beginner style');expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('beginner ACE all-in-one outside checkpoints explains the move instead of offering component downloads',async()=>{
 const aio={...aceModel('ace-step-1-5-turbo','unet'),misplacedAllInOne:true};
 const view=await mountMusic('Music (Text to Music)',false,musicEvidence({diffusionModels:[aio.name],nodes:[...evidence.allowlist.nodes,...musicNodes,...aceNodes]}),[...yue2Models,aio]);
 view.rerender(beginnerView(true,'models'));
 const card=[...document.querySelectorAll<HTMLElement>('.beginner-model-card')].find(el=>el.textContent?.includes(aio.name))!;
 fireEvent.click(within(card).getByRole('button',{name:/Use this model/}));view.rerender(beginnerView());
 await waitFor(()=>expect(document.querySelector('[data-beginner-misplaced-aio]')?.textContent).toContain('/m/checkpoints'));
 expect(document.querySelector('[data-beginner-components]')).toBeNull();
 expect(document.body.textContent).not.toContain('Unavailable or incompatible selections');
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
});

test('beginner split ACE model without its text encoders offers the component download instead of a dependency warning',async()=>{
 const ace=aceModel('ace-step-1-5-turbo','diffusion_models');
 const view=await mountMusic('Music (Text to Music)',false,musicEvidence({diffusionModels:[ace.name],nodes:[...evidence.allowlist.nodes,...musicNodes,...aceNodes]}),[...yue2Models,ace,{category:'vae',name:'ace_1.5_vae.safetensors',path:'/m/vae/ace_1.5_vae.safetensors',size:1,info:null}]);
 view.rerender(beginnerView(true,'models'));
 const card=[...document.querySelectorAll<HTMLElement>('.beginner-model-card')].find(el=>el.textContent?.includes(ace.name))!;
 fireEvent.click(within(card).getByRole('button',{name:/Use this model/}));view.rerender(beginnerView());
 await waitFor(()=>expect(document.querySelector('[data-beginner-components]')).not.toBeNull());
 // Only the missing encoders are offered (the VAE is installed), into text_encoders.
 expect(document.querySelectorAll('[data-beginner-components] .beginner-base-download')).toHaveLength(1);
 expect(document.body.textContent).not.toContain('Unavailable or incompatible selections');
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('beginner resolved ACE model use reuses conditioning controls and blocks cover assignment without losing YuE2 drafts',async()=>{
 const ace=aceModel('ace-step-1-5-turbo'),unresolved=aceModel('ace-step-1-5');
 const view=await mountMusic('Music (Text to Music)',false,musicEvidence({checkpoints:[yue2Models[0].name,ace.name,unresolved.name],nodes:[...evidence.allowlist.nodes,...musicNodes,...aceNodes]}),[...yue2Models,ace,unresolved]);
 view.rerender(beginnerView());
 fireEvent.change(music().style,{target:{value:'shared music'}});fireEvent.change(music().lyrics,{target:{value:'[Verse]\nshared'}});
 fireEvent.change(screen.getByLabelText('Maximum duration (seconds)'),{target:{value:'85'}});
 view.rerender(beginnerView(true,'collection'));fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 await screen.findByRole('button',{name:'voice.wav'});fireEvent.click(menuOf('voice.wav').getByRole('menuitem',{name:'Use for music cover'}));
 view.rerender(beginnerView(true,'models'));
 const modelCard=(name:string)=>[...document.querySelectorAll<HTMLElement>('.beginner-model-card')].find(el=>el.textContent?.includes(name))!;
 expect(within(modelCard('ace-step-1-5.safetensors')).getByRole('button',{name:/Use this model/})).toHaveProperty('disabled',true);
 fireEvent.click(within(modelCard(ace.name)).getByRole('button',{name:/Use this model/}));view.rerender(beginnerView());
 expect(captureStudioSettings()['studio.run.checkpoint']).toBe(ace.name);
 expect(document.querySelector('[data-music-source]')!.textContent).not.toContain('voice.wav');
 expect(document.querySelector('[data-music-planning]')).toBeNull();expect(document.querySelector('[data-music-encoder]')).toBeNull();
 expect([...document.querySelectorAll<HTMLElement>('[data-ace-setting]')].map(el=>el.dataset.aceSetting)).toEqual(['bpm','language','keyScale']);
 expect(screen.getByLabelText('Sampler')).toBeTruthy();
 fireEvent.change(document.querySelector('[data-ace-setting="bpm"]')!,{target:{value:'137'}});
 fireEvent.change(screen.getByLabelText('Maximum duration (seconds)'),{target:{value:'60'}});
 fireEvent.change(screen.getByLabelText('Steps'),{target:{value:'11'}});
 view.rerender(beginnerView(true,'collection'));fireEvent.click(await screen.findByRole('button',{name:'voice.wav'}));
 const use=within(document.querySelector('.beginner-collection-actions')!).getByRole('button',{name:'Use for music cover'});
 expect(use).toHaveProperty('disabled',true);expect(use.title).not.toBe('');fireEvent.click(use);
 view.rerender(beginnerView(false));
 await waitFor(()=>expect(document.querySelector('[data-ace-setting="bpm"]')).toHaveProperty('value','137'));
 expect(screen.getByLabelText('Maximum duration (seconds)')).toHaveProperty('value','60');expect(screen.getByLabelText('Steps')).toHaveProperty('value','11');
 view.rerender(beginnerView());
 view.rerender(beginnerView(true,'models'));fireEvent.click(within(modelCard(yue2Models[0].name)).getByRole('button',{name:/Use this model/}));view.rerender(beginnerView());
 expect(document.querySelector('[data-music-source]')!.textContent).toContain('voice.wav');expect(document.querySelector('[data-music-mode]')!.textContent).toBe('Music (Cover Music)');
 fireEvent.click(document.querySelector('[data-music-source-remove]')!);expect(screen.getByLabelText('Maximum duration (seconds)')).toHaveProperty('value','85');
 view.rerender(beginnerView(true,'models'));fireEvent.click(within(modelCard(ace.name)).getByRole('button',{name:/Use this model/}));view.rerender(beginnerView());
 expect(document.querySelector('[data-ace-setting="bpm"]')).toHaveProperty('value','137');expect(screen.getByLabelText('Maximum duration (seconds)')).toHaveProperty('value','60');
 expect(music().style.value).toBe('shared music');expect(music().lyrics.value).toBe('[Verse]\nshared');
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
 const run=screen.getByRole('button',{name:'Run'});await waitFor(()=>expect(run).toHaveProperty('disabled',false));fireEvent.click(run);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({family:'ace-step-1-5-turbo',mode:'t2m',planning:'off',maxDuration:60,steps:11,cfg:1,ace:{bpm:137},style:'shared music',lyrics:'[Verse]\nshared'});
 for(const key of ['sourceAudio','audioEncoder','generation','abc'])expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).not.toHaveProperty(key);
});

test.each(['Music (Text to Music)','Music (Cover Music)'] as const)('Audio enhancement card follows pipeline kind and retains preferences from %s',async(pipeline)=>{
 localStorage.setItem('deas.pref.studio.audioEnhance.post.mode',JSON.stringify('clean'));
 await mountMusic(pipeline);
 dock('Post-Processing');
 const card=()=>document.querySelector<HTMLButtonElement>('[data-post-card="audio"]')!;
 expect(card().disabled).toBe(false);
 fireEvent.click(card());
 expect(card().getAttribute('aria-expanded')).toBe('true');
 for(const imagePipeline of ['Text → Image','Image → Image']){
  choosePipe(imagePipeline);
  expect(card().disabled).toBe(true);
  expect(card().dataset.postState).toBe('unavailable');
  expect(card().dataset.postCount).toBe('0');
  expect(card().title).toBe('Audio or video pipelines only.');
  expect(card().getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(card());
  expect(screen.queryByRole('dialog')).toBeNull();
 }
 expect(localStorage.getItem('deas.pref.studio.audioEnhance.post.mode')).toBe('"clean"');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('remembered image refinement does not require its baseline gate for music',async()=>{
 localStorage.setItem('deas.pref.studio.run.post','true');
 await mountMusic('Music (Text to Music)');
 fireEvent.change(music().style,{target:{value:'Instrumental ambient'}});
 const run=screen.getByRole('button',{name:'Run'});
 await waitFor(()=>expect(run).toHaveProperty('disabled',false));
 expect(screen.queryByText(/Refine requires the DEAS baseline-first adapter/)).toBeNull();
 fireEvent.click(run);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).not.toHaveProperty('refine');
 // Incompatible cards are disabled without clearing remembered settings.
 fireEvent.click(screen.getByRole('tab',{name:/Post-Processing/}));
 const card=document.querySelector<HTMLButtonElement>('[data-post-card="refine"]')!;
 expect(card.disabled).toBe(true);
 fireEvent.click(card);
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(localStorage.getItem('deas.pref.studio.run.post')).toBe('true');
});

test('text-to-music lists only YuE2 checkpoints, two music editors, no canvas/negative, and submits the music intent without uploads',async()=>{
 await mountMusic('Music (Text to Music)');
 const picker=screen.getByRole('combobox',{name:'Checkpoint'}) as HTMLSelectElement;
 expect([...picker.options].filter(o=>!o.disabled).map(o=>o.value)).toEqual(['yue2_3b.safetensors']);
 expect(screen.queryByRole('textbox',{name:'Prompt'})).toBeNull();expect(screen.queryByRole('textbox',{name:'Negative prompt'})).toBeNull();
 expect(screen.queryByLabelText('Width')).toBeNull();expect(screen.queryByLabelText('Aspect ratio')).toBeNull();
 expect(screen.getByLabelText('ABC Planning')).toHaveProperty('value','full');
 expect(screen.getByLabelText('Maximum duration (seconds)')).toHaveProperty('value','120');
 const run=screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 await waitFor(()=>expect(run.title).toBe('Enter a song style.'));
 expect(run.disabled).toBe(true);
 // An empty Style is a draft hint, not an incompatible-dependency warning.
 expect(document.body.textContent).not.toMatch(/Unavailable or incompatible selections[^.]*Enter a song style/);
 fireEvent.change(music().style,{target:{value:'English, indie pop'}});fireEvent.change(music().lyrics,{target:{value:'[Verse]\nHello world'}});
 fireEvent.change(screen.getByLabelText('Seed'),{target:{value:'42'}});
 await waitFor(()=>expect(run.disabled).toBe(false));
 fireEvent.click(run);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();
 const intent=vi.mocked(runWorkbenchJob).mock.calls[0][1] as unknown as Record<string,unknown>;
 expect(intent).toMatchObject({recipeId:'music-generation',version:1,family:'yue2',mode:'t2m',planning:'full',checkpoint:'yue2_3b.safetensors',style:'English, indie pop',lyrics:'[Verse]\nHello world',seed:42,maxDuration:120,steps:32,cfg:1,sampler:'dpm_2',scheduler:'sgm_uniform',abc:{maxTokens:8192,temperature:0.7,topP:0.9,topK:30,repetitionPenalty:1.005,penaltyWindow:100},generation:{temperature:1,topP:0.95,topK:100,repetitionPenalty:1.2,cfgScale:1}});
 expect(intent.outputPrefix).toMatch(/^raw\/audio\//);
 for(const key of ['positivePrompt','negativePrompt','width','height','loras','options','sourceAudio','audioEncoder','imageFormat','refine'])expect(intent).not.toHaveProperty(key);
});

test('Music role selection shares text/settings, never adopts a preview, and submits text after explicit removal',async()=>{
 await mountMusic('Music (Text to Music)');
 expect([...document.querySelector<HTMLSelectElement>('[data-pipeline]')!.options].map(o=>o.value)).toEqual(['image','video','music']);
 expect(document.querySelector('[data-music-source]')).not.toBeNull();
 fireEvent.change(music().style,{target:{value:'  exact style  '}});fireEvent.change(music().lyrics,{target:{value:'[Verse]\nexact words'}});
 fireEvent.change(screen.getByLabelText('Steps'),{target:{value:'27'}});
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'voice.wav'}));
 expect(document.querySelector('[data-music-mode]')?.textContent).toBe('Music (Text to Music)');
 expect(document.querySelector('[data-music-source]')?.textContent).not.toContain('voice.wav');
 fireEvent.click(menuOf('voice.wav').getByRole('menuitem',{name:'Use for music cover'}));
 expect(document.querySelector('[data-music-mode]')?.textContent).toBe('Music (Cover Music)');
 expect(music().style.value).toBe('  exact style  ');expect(music().lyrics.value).toBe('[Verse]\nexact words');
 fireEvent.change(screen.getByLabelText('Autoregressive guidance'),{target:{value:'1.5'}});
 fireEvent.change(music().style,{target:{value:''}});fireEvent.change(music().lyrics,{target:{value:''}});
 fireEvent.click(document.querySelector('[data-music-source-remove]')!);
 expect(document.querySelector('[data-music-mode]')?.textContent).toBe('Music (Text to Music)');
 expect(music().style.value).toBe('');expect(music().lyrics.value).toBe('');
 expect(screen.getByLabelText('Steps')).toHaveProperty('value','27');expect(screen.getByLabelText('Autoregressive guidance')).toHaveProperty('value','1.5');
 fireEvent.click(menuOf('clip.mp4').getByRole('menuitem',{name:'Use for music cover'}));
 fireEvent.click(menuOf('clip.mp4').getByRole('menuitem',{name:'Remove cover source'}));
 fireEvent.change(music().style,{target:{value:'text again'}});
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
 const run=screen.getByRole('button',{name:'Run'});await waitFor(()=>expect(run).toHaveProperty('disabled',false));fireEvent.click(run);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({mode:'t2m',style:'text again',lyrics:'',steps:27,generation:{cfgScale:1.5}});expect(uploadInput).not.toHaveBeenCalled();
});

test('Music per-model drafts keep distinct sources/settings through role toggles and relocation, including ACE recovery',async()=>{
 const second={...yue2Models[0],name:'yue2_other.safetensors',path:'/m/checkpoints/yue2_other.safetensors'};
 const ace=aceModel('ace-step-1-5-turbo');
 await mountMusic('Music (Text to Music)',false,musicEvidence({checkpoints:[yue2Models[0].name,second.name,ace.name],nodes:[...evidence.allowlist.nodes,...musicNodes,...aceNodes]}),[...yue2Models,second,ace]);
 fireEvent.change(music().style,{target:{value:'shared'}});
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));await screen.findByRole('button',{name:'voice.wav'});
 fireEvent.click(menuOf('voice.wav').getByRole('menuitem',{name:'Use for music cover'}));fireEvent.change(screen.getByLabelText('Steps'),{target:{value:'29'}});
 sessionModel(second.name);expect(document.querySelector('[data-music-mode]')?.textContent).toBe('Music (Text to Music)');expect(document.querySelector('[data-music-source]')?.textContent).not.toContain('voice.wav');
 fireEvent.click(menuOf('clip.mp4').getByRole('menuitem',{name:'Use for music cover'}));fireEvent.change(screen.getByLabelText('Steps'),{target:{value:'31'}});
 act(()=>window.dispatchEvent(new CustomEvent('deas-media-relocated',{detail:{oldPath:'/env/ComfyUI/input/voice.wav',path:'/env/ComfyUI/input/renamed.wav'}})));
 sessionModel(yue2Models[0].name);expect(document.querySelector('[data-music-source]')?.textContent).toContain('renamed.wav');expect(screen.getByLabelText('Steps')).toHaveProperty('value','29');expect(document.querySelector('[data-music-mode]')?.textContent).toBe('Music (Cover Music)');
 sessionModel(second.name);expect(document.querySelector('[data-music-source]')?.textContent).toContain('clip.mp4');expect(screen.getByLabelText('Steps')).toHaveProperty('value','31');
 sessionModel(ace.name);expect(document.querySelector('[data-music-mode]')?.textContent).toBe('Music (Text to Music)');
 const unsupported=menuOf('voice.wav').getByRole('menuitem',{name:/Use for music cover/});expect(unsupported).toHaveProperty('disabled',true);expect(unsupported.textContent).toContain('No verified recipe');fireEvent.click(unsupported);fireEvent.keyDown(window,{key:'Escape'});
 expect(document.querySelector('[data-music-source]')?.textContent).not.toContain('voice.wav');expect(document.querySelector('[data-music-mode]')?.textContent).toBe('Music (Text to Music)');
 const run=screen.getByRole('button',{name:'Run'});expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
 sessionModel(second.name);expect(document.querySelector('[data-music-source]')?.textContent).toContain('clip.mp4');sessionModel(ace.name);
 expect(document.querySelector('[data-music-source]')?.textContent).not.toContain('voice.wav');expect(document.querySelector('[data-music-mode]')?.textContent).toBe('Music (Text to Music)');
 await waitFor(()=>expect(run).toHaveProperty('disabled',false));fireEvent.click(run);await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({family:'ace-step-1-5-turbo',mode:'t2m',style:'shared'});expect(uploadInput).not.toHaveBeenCalled();
});

test('ABC Off drops the planner, switches AR guidance to 1.01 once, and keeps ABC values for returning to Full',async()=>{
 await mountMusic('Music (Text to Music)');
 fireEvent.change(music().style,{target:{value:'lofi'}});
 fireEvent.change(screen.getAllByLabelText('Maximum ABC tokens')[0],{target:{value:'2048'}});
 fireEvent.change(screen.getByLabelText('ABC Planning'),{target:{value:'off'}});
 expect(screen.queryByLabelText('Maximum ABC tokens')).toBeNull();
 const arCfg=screen.getByLabelText('Autoregressive guidance') as HTMLInputElement;
 expect(arCfg.value).toBe('1.01');
 fireEvent.change(arCfg,{target:{value:'2'}});
 fireEvent.change(screen.getByLabelText('ABC Planning'),{target:{value:'melody'}});
 fireEvent.change(screen.getByLabelText('ABC Planning'),{target:{value:'off'}});
 expect((screen.getByLabelText('Autoregressive guidance') as HTMLInputElement).value).toBe('2');
 await waitFor(()=>expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const off=vi.mocked(runWorkbenchJob).mock.calls[0][1] as unknown as Record<string,unknown>;
 expect(off).toMatchObject({mode:'t2m',planning:'off',generation:{cfgScale:2}});expect(off).not.toHaveProperty('abc');
 fireEvent.change(screen.getByLabelText('ABC Planning'),{target:{value:'full'}});
 expect((screen.getAllByLabelText('Maximum ABC tokens')[0] as HTMLInputElement).value).toBe('2048');
});

test('cover mode stage toolbar offers the same "Use for music cover" action as the media menu',async()=>{
 await mountMusic('Music (Cover Music)');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'voice.wav'}));
 const use=await waitFor(()=>{const b=document.querySelector('[data-media-tools] [data-media-action]') as HTMLButtonElement|null;expect(b).not.toBeNull();return b!;});
 expect(use.textContent).toBe('Use for music cover');
 expect(screen.queryByRole('button',{name:'Use as input'})).toBeNull();
 fireEvent.click(use);
 await waitFor(()=>expect(document.querySelector('[data-music-source]')?.textContent).toContain('voice.wav'));
 expect(markOf('voice.wav')).toBe('Cover source (audio or video)');
});

test('cover needs an explicitly selected audio or video source, uploads it once on Run, and is immutable to later edits',async()=>{
 let uploaded!:(name:string)=>void;
 vi.mocked(uploadInput).mockImplementation(()=>new Promise<string>(resolve=>{uploaded=resolve;}));
 await mountMusic('Music (Cover Music)');
 fireEvent.change(music().style,{target:{value:'bossa nova'}});
 expect(screen.queryByLabelText('ABC Planning')).toBeNull();
 expect(screen.getByLabelText('SheetSage2 audio encoder')).toHaveProperty('value','sheetsage2_bf16.safetensors');
 expect(screen.getByLabelText('Maximum duration (seconds)')).toHaveProperty('value','360');
 const run=screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 await waitFor(()=>expect(run.title).toBe('Select an audio file or a video with an audio track.'));
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 await screen.findByRole('button',{name:'voice.wav'});
 expect(menuOf('ref.png').queryByRole('menuitem',{name:'Use for music cover'})).toBeNull();fireEvent.keyDown(window,{key:'Escape'});
 fireEvent.click(menuOf('clip.mp4').getByRole('menuitem',{name:'Use for music cover'}));
 expect(markOf('clip.mp4')).toBe('Cover source (audio or video)');
 fireEvent.click(menuOf('voice.wav').getByRole('menuitem',{name:'Use for music cover'}));
 expect(markOf('clip.mp4')).toBeUndefined();expect(document.querySelector('[data-music-source]')!.textContent).toContain('voice.wav');
 expect(uploadInput).not.toHaveBeenCalled();
 await waitFor(()=>expect(run.disabled).toBe(false));
 fireEvent.click(run);
 // Edits during the awaited upload belong to the next job.
 fireEvent.change(music().style,{target:{value:'changed after run'}});fireEvent.click(menuOf('clip.mp4').getByRole('menuitem',{name:'Use for music cover'}));
 fireEvent.click(document.querySelector('[data-music-source-remove]')!);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 await act(async()=>{uploaded('deas-input-voice.wav');});
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(uploadInput).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:7801','/env/ComfyUI/input/voice.wav');
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({recipeId:'music-generation',mode:'cover',planning:'melody',style:'bossa nova',sourceAudio:'deas-input-voice.wav',audioEncoder:'sheetsage2_bf16.safetensors',maxDuration:360});
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).not.toHaveProperty('abc');
 expect(Object.isFrozen(vi.mocked(runWorkbenchJob).mock.calls[0][1])).toBe(true);
});

test('music without the cover nodes still offers text-to-music, and a missing encoder blocks only covers',async()=>{
 await mountMusic('Music (Text to Music)',false,musicEvidence({nodes:[...evidence.allowlist.nodes,...musicNodes.filter(n=>!['LoadAudio','AudioEncoderLoader','SheetSage2AudioToABC'].includes(n))],audioEncoders:[]}));
 fireEvent.change(music().style,{target:{value:'jazz'}});
 await waitFor(()=>expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false));
 choosePipe('Music (Cover Music)');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 await screen.findByRole('button',{name:'voice.wav'});
 fireEvent.click(menuOf('voice.wav').getByRole('menuitem',{name:'Use for music cover'}));
 const run=screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 await waitFor(()=>expect(run.title).toContain('SheetSage2AudioToABC'));
 expect(run.disabled).toBe(true);expect(run.title).toContain('LoadAudio');expect(run.title).toContain('Select an installed SheetSage2 audio encoder.');
 fireEvent.click(document.querySelector('[data-music-source-remove]')!);
 await waitFor(()=>expect(run.disabled).toBe(false));expect(document.querySelector('[data-music-mode]')?.textContent).toBe('Music (Text to Music)');
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('switching t2i → music → t2i keeps image prompts and music texts as separate drafts and blocks Forge handoff while authoring music',async()=>{
 const view=await mountMusic('Music (Text to Music)');
 fireEvent.change(music().style,{target:{value:'synthwave'}});fireEvent.change(music().lyrics,{target:{value:'[Chorus]\nneon'}});
 choosePipe('Text → Image');
 await waitFor(()=>expect((screen.getByRole('combobox',{name:'Checkpoint'}) as HTMLSelectElement).value).toBe('a.safetensors'));
 expect(screen.getByRole('textbox',{name:'Prompt'})).toHaveProperty('value','');
 fireEvent.change(screen.getByRole('textbox',{name:'Prompt'}),{target:{value:'a cat'}});fireEvent.change(screen.getByRole('textbox',{name:'Negative prompt'}),{target:{value:'blurry'}});
 choosePipe('Music (Text to Music)');
 await waitFor(()=>expect(screen.getByRole('textbox',{name:'Style'})).toHaveProperty('value','synthwave'));
 expect(music().lyrics.value).toBe('[Chorus]\nneon');
 expect(screen.queryByRole('textbox',{name:'Negative prompt'})).toBeNull();
 view.rerender(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" root="/env" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}} incoming={{positive:'from forge',negative:'forge negative',n:1}}/></I18nProvider>);
 expect(music().style.value).toBe('synthwave');expect(music().lyrics.value).toBe('[Chorus]\nneon');
 expect(screen.getByRole('alert').textContent).toContain('Prompt Forge sends image prompts');
 choosePipe('Text → Image');
 await waitFor(()=>expect(screen.getByRole('textbox',{name:'Prompt'})).toHaveProperty('value','a cat'));
 expect(screen.getByRole('textbox',{name:'Negative prompt'})).toHaveProperty('value','blurry');
 choosePipe('Music (Text to Music)');
 await waitFor(()=>expect(screen.getByRole('textbox',{name:'Style'})).toHaveProperty('value','synthwave'));
});

test('Run Plan in music mode shows the music stages from the captured intent and never uploads or submits',async()=>{
 await mountMusic('Music (Cover Music)',true);
 const plan=screen.getByRole('region',{name:'Run Plan'});
 expect(within(plan).getByText('Music (Cover Music)')).toBeTruthy();
 for(const stage of ['input','model','prompt','abc','generate','output'])expect(plan.querySelector(`[data-plan-stage="${stage}"]`)).not.toBeNull();
 expect(plan.querySelector('[data-plan-stage="refine"]')).toBeNull();
 const intent=JSON.parse(plan.querySelector('[data-plan-intent]')!.textContent!);
 expect(intent).toMatchObject({recipeId:'music-generation',mode:'cover',planning:'melody',sourceAudio:''});
 expect(intent).not.toHaveProperty('positivePrompt');expect(intent).not.toHaveProperty('width');
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each([false,true])('audio enhancement exports the clicked output and matching filename (paired=%s)',async paired=>{
 const job:JobStatus={...musicJob('audio-pair'),state:'succeeded',outputRoot:'/env/ComfyUI/output',outputs:[{filename:'first.flac',subfolder:'raw/audio',type:'output',...(paired?{role:'original' as const}:{})},{filename:'second.flac',subfolder:'raw/audio',type:'output',...(paired?{role:'processed' as const}:{})}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 await mountMusic('Music (Text to Music)');
 await waitFor(()=>expect(document.querySelectorAll('[data-job-id="audio-pair"] .wb-queue-select').length).toBe(2));
 fireEvent.click(document.querySelectorAll('[data-job-id="audio-pair"] .wb-queue-select')[1]);
 fireEvent.click(document.querySelector('[data-dock-tab="post"]')!);
 expect(document.querySelector('[data-audio-enhance-source]')?.textContent).toBe('second.flac');
 vi.mocked(invoke).mockImplementation(async command=>command==='native_audio_enhance_capabilities'?{clean:true,deep:false,stems:false}:null);
 await act(async()=>{fireEvent.focus(document.querySelector('[data-audio-enhance-mode]')!);});
 fireEvent.change(document.querySelector('[data-audio-enhance-mode]')!,{target:{value:'clean'}});
 await act(async()=>{fireEvent.click(document.querySelector('[data-audio-enhance-run]')!);});
 expect(invoke).toHaveBeenCalledWith('native_audio_enhance_export',{request:expect.objectContaining({jobId:'audio-pair',index:1})});
});

test('a retained music job renders a controls-only audio player, audio queue glyph, and music metadata',async()=>{
 const job:JobStatus={...musicJob('job-m'),state:'succeeded',outputRoot:'/env/ComfyUI/output',outputs:[{filename:'YuE2_00001.flac',subfolder:'raw/audio',type:'output'}],intent:{recipeId:'music-generation',version:1,family:'yue2',mode:'t2m',planning:'off',checkpoint:'yue2_3b.safetensors',style:'retained style',lyrics:'',seed:1,maxDuration:30,steps:32,cfg:1,sampler:'dpm_2',scheduler:'sgm_uniform',generation:{temperature:1,topP:0.95,topK:100,repetitionPenalty:1.2,cfgScale:1.01},outputPrefix:'raw/audio/x'}};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 await mountMusic('Music (Text to Music)');
 await waitFor(()=>expect(document.querySelector('[data-job-id="job-m"]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-job-id="job-m"] .wb-queue-select')!);
 const player=await waitFor(()=>{const el=document.querySelector<HTMLAudioElement>('.wb-shown [data-output-audio]');expect(el).not.toBeNull();return el!;});
 expect(player.getAttribute('src')).toBe('asset://localhost//env/ComfyUI/output/raw/audio/YuE2_00001.flac');
 expect(player.hasAttribute('controls')).toBe(true);expect(player.hasAttribute('autoplay')).toBe(false);
 expect(document.querySelector('.wb-shown img')).toBeNull();
 expect(document.querySelector('[data-job-id="job-m"] .wb-thumb')!.textContent).toBe('♪');
 fireEvent.click(document.querySelector('[data-metadata-toggle]')!);
 const meta=document.querySelector('[data-music-metadata]')!;
 expect(meta.textContent).toContain('retained style');expect(meta.textContent).toContain('Off');expect(meta.textContent).not.toContain('Negative');
});

test.each(['off','clean','deep','stems'] as const)('Recent history restores audio selection %s without stale preferences or implicit installation',async mode=>{
 const record=recentHistoryRecord({recipeId:'music-generation',version:1,family:'yue2',mode:'t2m',planning:'off',checkpoint:'yue2_3b.safetensors',style:'historic audio',lyrics:'',seed:777,maxDuration:30,steps:20,cfg:1,sampler:'dpm_2',scheduler:'sgm_uniform',generation:{temperature:1,topP:0.95,topK:100,repetitionPenalty:1.2,cfgScale:1},outputPrefix:'raw/audio/old',...(mode==='off'?{}:{audioEnhance:{mode,profile:mode==='deep'?'speech' as const:'mix' as const}})});
 await mountMusic('Music (Text to Music)');
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_audio_enhance_capabilities'?{clean:true,deep:true,stems:true}:command==='native_jobs_history'?{schemaVersion:1,records:[record],readOnly:false,error:null}:command==='native_media_star_status'?{starred:false,unavailable:null}:{path:(args as {path?:string})?.path??'/env/ComfyUI/input',parent:'/env',entries:mediaEntries,truncated:false});
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 await act(async()=>{fireEvent.focus(document.querySelector('[data-audio-enhance-mode]')!);});
 fireEvent.change(document.querySelector('[data-audio-enhance-mode]')!,{target:{value:mode==='stems'?'clean':'stems'}});
 await openHistoryRecord();fireEvent.click(document.querySelector('[data-history-apply]')!);fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 expect(document.querySelector('[data-audio-enhance-mode]')).toHaveProperty('value',mode);
 expect(document.querySelector('[data-audio-enhance-profile]')).toHaveProperty('value',mode==='deep'?'speech':'mix');
 if(mode==='stems')expect(document.querySelector('[data-audio-enhance-device]')).toHaveProperty('value','auto');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 expect(invoke).not.toHaveBeenCalledWith('native_audio_enhance_install',expect.anything());
});

test('Recent history restores a music record into the cover pipeline with every setting and an unresolved source',async()=>{
 const record=recentHistoryRecord({recipeId:'music-generation',version:1,family:'yue2',mode:'cover',planning:'melody',checkpoint:'yue2_3b.safetensors',style:'historic style',lyrics:'[Verse]\nold words',seed:777,maxDuration:200.04,steps:20,cfg:1,sampler:'dpm_2',scheduler:'sgm_uniform',generation:{temperature:0.8,topP:0.9,topK:50,repetitionPenalty:1.1,cfgScale:1.5},outputPrefix:'raw/audio/old',sourceAudio:'deas-input-old.wav',audioEncoder:'sheetsage2_bf16.safetensors'});
 await mountMusic('Music (Text to Music)');
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_jobs_history'?{schemaVersion:1,records:[record],readOnly:false,error:null}:command==='native_media_star_status'?{starred:false,unavailable:null}:{path:(args as {path?:string})?.path??'/env/ComfyUI/input',parent:'/env',entries:mediaEntries,truncated:false});
 fireEvent.change(music().style,{target:{value:'current draft'}});
 await openHistoryRecord();fireEvent.click(document.querySelector('[data-history-apply]')!);fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 await waitFor(()=>expect((screen.getByRole('combobox',{name:'Pipeline'}) as HTMLSelectElement).value).toBe('music'));
 expect(document.querySelector('[data-music-mode]')?.textContent).toBe('Music (Cover Music)');
 expect(music().style.value).toBe('historic style');expect(music().lyrics.value).toBe('[Verse]\nold words');
 expect(screen.getByLabelText('Seed')).toHaveProperty('value','777');expect(screen.getByLabelText('Steps')).toHaveProperty('value','20');
 expect(screen.getByLabelText('Maximum duration (seconds)')).toHaveProperty('value','200.04');
 expect((screen.getByLabelText('Autoregressive guidance') as HTMLInputElement).value).toBe('1.5');
 const run=screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 expect(run.disabled).toBe(true);expect(run.title).toContain('deas-input-old.wav');
 choosePipe('Text → Image');choosePipe('Music (Text to Music)');
 expect(document.querySelector('[data-music-mode]')?.textContent).toBe('Music (Cover Music)');expect(run.disabled).toBe(true);expect(run.title).toContain('deas-input-old.wav');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 await screen.findByRole('button',{name:'voice.wav'});
 fireEvent.click(menuOf('voice.wav').getByRole('menuitem',{name:'Use for music cover'}));
 await waitFor(()=>expect(run.disabled).toBe(false));
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('variable chips show picks and remove exactly that token occurrence from the prompt',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,checkpoints:['m.safetensors'],nodes:[...evidence.allowlist.nodes,'DaSiWa_WildcardPresetPromptBuilder']}});
 localStorage.setItem('deas.pref.studio.run.wildcardEnabled',JSON.stringify(true));
 localStorage.setItem('deas.pref.studio.run.wildcard',JSON.stringify({style:'Booru',seed:7,reroll:3,token_budget:200,auto_reroll:false}));
 localStorage.setItem('deas.pref.studio.run.customVariables',JSON.stringify({color:['red','blue']}));
 vi.mocked(invoke).mockImplementation(async c=>c==='native_wildcard_library'?JSON.stringify({categories:{}}):{entries:[],truncated:false});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'m.safetensors',path:'/m/checkpoints/m.safetensors',size:1,info:null}]);
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'chip-job',baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false,intent:undefined as never});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 const positive=screen.getByLabelText('Prompt') as HTMLTextAreaElement;
 fireEvent.change(positive,{target:{value:'a $color cat with ${color}-light and $color'}});
 const chips=await screen.findAllByRole('button',{name:/^\$color/});
 expect(chips.length).toBe(3);
 fireEvent.click(screen.getAllByRole('button',{name:'Remove color from the prompt'})[0]);
 await waitFor(()=>expect(positive.value).toBe('a  cat with ${color}-light and $color'));
 fireEvent.click(screen.getAllByRole('button',{name:'Remove color from the prompt'})[0]);
 await waitFor(()=>expect(positive.value).toBe('a  cat with -light and $color'));
});

test('beginner submits through the real Workbench adapter and restores advanced technical settings',async()=>{
 localStorage.setItem('deas.pref.studio.run.cfg','7');localStorage.setItem('deas.pref.studio.run.negative',JSON.stringify('advanced negative'));
 vi.mocked(scanModels).mockResolvedValue([{name:'a.safetensors',category:'checkpoints',path:'/m/a',size:1,info:null,family:'sdxl'}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('beginner','failed'),error:'fixture'});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props} beginner/></I18nProvider>);
 await waitFor(()=>expect(captureStudioSettings()['studio.run.cfg']).toBe(3.5));
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.cfg')!)).toBe(7);
 fireEvent.change(document.querySelector('[data-run-positive]')!,{target:{value:'A house by a lake'}});
 const button=screen.getByRole('button',{name:'Run'});await waitFor(()=>expect(button).toHaveProperty('disabled',false));
 expect(button.closest('#studio-queue')).not.toBeNull();
 expect(document.querySelector('.beginner-studio-heading')).toBeNull();
 expect(document.querySelector('.beginner-local-badge')).toBeNull();
 expect(document.querySelector('.beginner-composer-top')).toBeNull();
 expect(document.querySelector('[data-run-positive]')!.getAttribute('placeholder')).toBe('Describe what you imagine…');
 expect(document.querySelector('.beginner-composer')!.closest('#studio-settings')).not.toBeNull();
 expect(document.querySelector('#project-actions-slot')!.hasAttribute('hidden')).toBe(true);
 expect(document.querySelector('#project-status-slot')!.hasAttribute('hidden')).toBe(true);
 expect(screen.getByRole('heading',{name:'What will you bring to life?'})).toBeTruthy();
 expect(document.querySelector('.beginner-empty-preview')!.textContent).toContain('watch your imagination take shape here');
 expect(document.querySelectorAll('[data-run-positive]')).toHaveLength(1);
 expect(document.querySelector('[data-run-positive]')!.closest('.wb-center')).not.toBeNull();
 expect(screen.getByRole('button',{name:'Recent generations'}).closest('#studio-queue')).not.toBeNull();
 expect(runWorkbenchJob).not.toHaveBeenCalled();fireEvent.click(button);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({positivePrompt:'A house by a lake',negativePrompt:'',checkpoint:'a.safetensors',cfg:3.5,steps:28,sampler:'euler',scheduler:'normal'});
 view.rerender(<I18nProvider><Workbench {...props} beginner={false}/></I18nProvider>);
 await waitFor(()=>expect(captureStudioSettings()['studio.run.cfg']).toBe(7));
 expect(captureStudioSettings()['studio.run.negative']).toBe('advanced negative');
 expect((document.querySelector('[data-run-positive]') as HTMLTextAreaElement).value).toBe('A house by a lake');
});

test('beginner model selection keeps the prompt and changes the actual Studio model without executing',async()=>{
 vi.mocked(scanModels).mockResolvedValue(['a','b'].map(n=>({name:n+'.safetensors',category:'checkpoints',path:'/m/'+n,size:1,info:null,family:'sdxl'})));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);const onPage=vi.fn();
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}} beginner beginnerPage="models" onBeginnerPage={onPage}/></I18nProvider>);
 await waitFor(()=>expect(screen.getAllByRole('button',{name:/Use this model/})).toHaveLength(2));
 fireEvent.change(document.querySelector('[data-run-positive]')!,{target:{value:'Keep this idea'}});
 fireEvent.click(screen.getAllByRole('button',{name:/Use this model/})[1]);
 await waitFor(()=>expect(captureStudioSettings()['studio.run.checkpoint']).toBe('b.safetensors'));
 expect(captureStudioSettings()['studio.run.positive']).toBe('Keep this idea');expect(onPage).toHaveBeenCalledWith('generate');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('beginner LoRAs use known matching families, native strengths and Ctrl+Enter without overwriting Advanced',async()=>{
 const advanced=[{name:'advanced-only.safetensors',strength:0.4}];localStorage.setItem('deas.pref.studio.run.loras',JSON.stringify(advanced));
 vi.mocked(scanModels).mockResolvedValue([
  {name:'a.safetensors',category:'checkpoints',path:'/m/a',size:1,info:null,family:'sdxl'},
  {name:'watercolor.safetensors',category:'loras',path:'/m/watercolor',size:1,info:null,family:'sdxl'},
  {name:'other.safetensors',category:'loras',path:'/m/other',size:1,info:null,family:'anima'},
  {name:'unknown.safetensors',category:'loras',path:'/m/unknown',size:1,info:null}
 ]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('beginner-lora','failed'),error:'fixture'});
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};const view=render(<I18nProvider><Workbench {...props} beginner/></I18nProvider>);
 fireEvent.click(screen.getByText('LoRAs (optional)'));
 await waitFor(()=>expect(screen.getByRole('option',{name:'watercolor'})).toBeDefined());
 expect(screen.queryByRole('option',{name:'other'})).toBeNull();expect(screen.queryByRole('option',{name:'unknown'})).toBeNull();
 fireEvent.change(screen.getByRole('combobox',{name:'Add a LoRA…'}),{target:{value:'watercolor.safetensors'}});
 fireEvent.change(screen.getByRole('spinbutton',{name:/watercolor/}),{target:{value:'0.65'}});
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.loras')!)).toEqual(advanced);
 const run=screen.getByRole('button',{name:'Run'});await waitFor(()=>expect(run).toHaveProperty('disabled',false));
 fireEvent.keyDown(window,{key:'Enter',ctrlKey:true});await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({family:'sdxl',loras:[{name:'watercolor.safetensors',strength:0.65}]});
 view.rerender(<I18nProvider><Workbench {...props} beginner={false}/></I18nProvider>);await waitFor(()=>expect(captureStudioSettings()['studio.run.loras']).toEqual(advanced));
 view.rerender(<I18nProvider><Workbench {...props} beginner/></I18nProvider>);fireEvent.click(screen.getByText('LoRAs (optional)'));await waitFor(()=>expect(screen.getByRole('spinbutton',{name:/watercolor/})).toHaveProperty('value','0.65'));
 fireEvent.click(screen.getByRole('button',{name:'Remove watercolor.safetensors'}));expect(screen.queryByRole('spinbutton',{name:/watercolor/})).toBeNull();
});

test('beginner format and quality reuse the shared aspect and resolution options without a fork',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{name:'a.safetensors',category:'checkpoints',path:'/m/a',size:1,info:null,family:'sdxl'}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const held=heldJob('beginner-size','queued');vi.mocked(runWorkbenchJob).mockResolvedValue(held);
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}} beginner/></I18nProvider>);
 await waitFor(()=>expect(captureStudioSettings()['studio.run.cfg']).toBe(3.5));
 const aspect=document.querySelector('[data-beginner-aspect]')! as HTMLSelectElement;
 const resolution=document.querySelector('[data-beginner-resolution]')! as HTMLSelectElement;
 // same shared option sets as the advanced panel, no beginner-specific values
 expect(Array.from(aspect.options).map(o=>o.value)).toEqual(aspects.filter(a=>a!=='custom'&&a!=='auto'));
 expect(Array.from(resolution.options).map(o=>o.value)).toEqual(['model',...Object.keys(resolutions)]);
 fireEvent.change(aspect,{target:{value:'3:4'}});fireEvent.change(resolution,{target:{value:'1024p'}});
 expect(captureStudioSettings()['studio.run.aspect']).toBe('3:4');expect(captureStudioSettings()['studio.run.resolution']).toBe('1024p');
 fireEvent.change(document.querySelector('[data-run-positive]')!,{target:{value:'A house by a lake'}});
 const button=screen.getByRole('button',{name:'Run'});await waitFor(()=>expect(button).toHaveProperty('disabled',false));
 fireEvent.click(button);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 // model-exact: SDXL 3:4 at 1 MP snaps to 896x1152 on the family grid
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({width:896,height:1152});
 // shared canvas intent survives the round-trip into advanced
 view.rerender(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}} beginner={false}/></I18nProvider>);
 expect(captureStudioSettings()['studio.run.aspect']).toBe('3:4');expect(captureStudioSettings()['studio.run.resolution']).toBe('1024p');
});

test('dock tabs badge how many settings are active or changed from default',async()=>{
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({attention:'',vae:'tiled',tile:512,cache:'EasyCache',threshold:0.05,compile:''}));
 localStorage.setItem('deas.pref.studio.run.wildcardEnabled','true');
 vi.mocked(scanModels).mockResolvedValue([{name:'a.safetensors',category:'checkpoints',path:'/m/a',size:1,info:null,family:'sdxl'}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 const badge=(id:string)=>document.querySelector(`[data-dock-tab="${id}"] .wb-dock-badge`);
 await waitFor(()=>expect(badge('options')?.textContent).toBe('2'));
 expect(badge('options')!.getAttribute('title')).toBe('2 active or changed from default');expect(screen.getByRole('tab',{name:'Options'})).toBeTruthy();
 expect(badge('wildcards')?.textContent).toBe('1');
 expect(badge('post')).toBeNull();
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 fireEvent.click(document.querySelector('[data-post-card="refine"]')!);
 fireEvent.click(screen.getByRole('checkbox',{name:'Refine / Upscale after every run'}));
 expect(badge('post')?.textContent).toBe('1');
});

test('beginner edits Steps and CFG directly and keeps them across experience switches',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{name:'a.safetensors',category:'checkpoints',path:'/m/a',size:1,info:null,family:'sdxl'}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('beginner-sampling','queued'));
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props} beginner/></I18nProvider>);
 await waitFor(()=>expect(captureStudioSettings()['studio.run.cfg']).toBe(3.5));
 const composer=document.querySelector('.beginner-composer')!;
 fireEvent.change(composer.querySelector('[data-num="steps"]')!,{target:{value:'33'}});
 fireEvent.change(composer.querySelector('[data-num="cfg"]')!,{target:{value:'6'}});
 fireEvent.change(document.querySelector('[data-run-positive]')!,{target:{value:'A house by a lake'}});
 const run=screen.getByRole('button',{name:'Run'});await waitFor(()=>expect(run).toHaveProperty('disabled',false));
 fireEvent.click(run);await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({steps:33,cfg:6});
 view.rerender(<I18nProvider><Workbench {...props} beginner={false}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLInputElement>('[data-num="steps"]')!.value).toBe('33'));
 expect(captureStudioSettings()).toMatchObject({'studio.run.steps':33,'studio.run.cfg':6});
 fireEvent.change(document.querySelector('[data-num="cfg"]')!,{target:{value:'4.5'}});
 view.rerender(<I18nProvider><Workbench {...props} beginner/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLInputElement>('.beginner-composer [data-num="cfg"]')!.value).toBe('4.5'));
 expect(captureStudioSettings()).toMatchObject({'studio.run.steps':33,'studio.run.cfg':4.5});
});

test('beginner resizes and collapses the prompt below preview without changing the Advanced media dock',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{name:'a.safetensors',category:'checkpoints',path:'/m/a',size:1,info:null,family:'sdxl'}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 localStorage.setItem('deas.pref.studio.dock.height','300');
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props} beginner/></I18nProvider>);
 await waitFor(()=>expect(captureStudioSettings()['studio.run.cfg']).toBe(3.5));
 const dock=document.getElementById('studio-dock')!,prompts=document.getElementById('studio-prompts')!;
 expect(dock.hidden).toBe(true);
 const handle=screen.getByRole('separator',{name:'Resize prompt area'});
 expect(handle.getAttribute('aria-controls')).toBe('studio-prompts');
 fireEvent.keyDown(handle,{key:'ArrowUp'});expect(handle.getAttribute('aria-valuenow')).toBe('126');
 fireEvent.change(document.querySelector('[data-run-positive]')!,{target:{value:'Keep this prompt'}});
 fireEvent.click(screen.getByRole('button',{name:'Collapse prompt area'}));expect(prompts.hidden).toBe(true);
 fireEvent.keyDown(handle,{key:'ArrowUp'});expect(handle.getAttribute('aria-valuenow')).toBe('126');
 fireEvent.click(screen.getByRole('button',{name:'Expand prompt area'}));expect(prompts.hidden).toBe(false);
 expect(document.querySelector('[data-run-positive]')).toHaveProperty('value','Keep this prompt');
 act(()=>window.dispatchEvent(new Event('deas:reset-studio-layout')));
 expect(handle.getAttribute('aria-valuenow')).toBe('110');
 expect(screen.getByRole('button',{name:'Collapse prompt area'}).getAttribute('aria-expanded')).toBe('true');
 view.rerender(<I18nProvider><Workbench {...props} beginner={false}/></I18nProvider>);
 expect(dock.hidden).toBe(false);expect(prompts.hidden).toBe(false);
 expect(screen.queryByRole('separator',{name:'Resize prompt area'})).toBeNull();
});

test.each(aceVariants)('ACE authoring %s submits variant defaults and no YuE2/image fields',async(family,steps,cfg,shift)=>{
 await mountAce();changeAceModel(family);
 const picker=screen.getByRole('combobox',{name:'Checkpoint'}) as HTMLSelectElement;
 for(const f of ['ace-step','ace-step-1-5','ace-step-1-5-xl'])expect([...picker.options].some(o=>o.value===`${f}.safetensors`)).toBe(false);
 expect(document.querySelector('[data-num="steps"]')).toHaveProperty('value',String(steps));expect(document.querySelector('[data-num="cfg"]')).toHaveProperty('value',String(cfg));
 expect(aceControl('shift')).toHaveProperty('value',String(shift));
 expect(screen.queryByLabelText('ABC Planning')).toBeNull();expect(document.querySelector('[data-music-generation-settings]')).toBeNull();expect(document.querySelector('.forge-hammer')).toBeNull();
 expect(screen.queryByRole('textbox',{name:'Negative prompt'})).toBeNull();expect(screen.queryByLabelText('Width')).toBeNull();
 if(family==='ace-step-1-0'){expect(aceControl('lyricsStrength')).toHaveProperty('value','1');expect(aceControl('bpm')).toBeNull();}
 else {expect(aceControl('generateAudioCodes')).toHaveProperty('checked',true);expect(aceControl('lmCfg')).toHaveProperty('value','2');expect(aceControl('temperature')).toHaveProperty('value','0.85');}
 fireEvent.change(music().style,{target:{value:'Ambient piano'}});fireEvent.change(music().lyrics,{target:{value:''}});
 const run=screen.getByRole('button',{name:'Run'});await waitFor(()=>expect(run).toHaveProperty('disabled',false));fireEvent.click(run);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const intent=vi.mocked(runWorkbenchJob).mock.lastCall![1];expect(intent).toMatchObject({family,mode:'t2m',planning:'off',steps,cfg,sampler:'euler',scheduler:'simple',ace:{...defaultAceSettings,shift},style:'Ambient piano',lyrics:'',maxDuration:normalizeAceDuration(120,family)});
 for(const key of ['abc','generation','sourceAudio','audioEncoder','options','loras','diffusion'])expect(intent).not.toHaveProperty(key);
 expect(uploadInput).not.toHaveBeenCalled();
});

test('ACE model in unet remains selectable for Text to Music',async()=>{
 await mountAce('unet');changeAceModel('ace-step-1-5-turbo');
 expect(screen.getByRole('combobox',{name:'Checkpoint'})).toHaveProperty('value','ace-step-1-5-turbo.safetensors');
 expect(aceControl('shift')).toHaveProperty('value','3');
 expect(document.querySelector('[data-num="steps"]')).toHaveProperty('value','8');
 expect(screen.getByRole('combobox',{name:'Text encoder'})).toBeTruthy();
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('ACE initial auto-selection applies its profile before accepting authored overrides',async()=>{
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify('t2m'));
 await mountAce();
 expect(document.querySelector('[data-num="steps"]')).toHaveProperty('value','50');
 fireEvent.change(document.querySelector('[data-num="steps"]')!,{target:{value:'21'}});
 expect(document.querySelector('[data-num="steps"]')).toHaveProperty('value','21');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('ACE upgrades a remembered checkpoint to its profile without rewriting bound saved overrides',async()=>{
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify('t2m'));
 localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify('ace-step-1-5-turbo.safetensors'));
 localStorage.setItem('deas.pref.studio.run.steps','20');
 const view=await mountAce();
 expect(document.querySelector('[data-num="steps"]')).toHaveProperty('value','8');
 fireEvent.change(document.querySelector('[data-num="steps"]')!,{target:{value:'14'}});
 view.unmount();
 await mountAce();
 expect(document.querySelector('[data-num="steps"]')).toHaveProperty('value','14');
});

test('ACE authoring keeps empty prompts and explicit per-model settings on revisits without submitting',async()=>{
 await mountAce();changeAceModel('ace-step-1-5-turbo');
 fireEvent.change(music().style,{target:{value:'will clear'}});fireEvent.change(music().lyrics,{target:{value:'will clear'}});
 fireEvent.change(aceControl('shift'),{target:{value:'4.5'}});fireEvent.change(document.querySelector('[data-num="steps"]')!,{target:{value:'11'}});fireEvent.click(aceControl('generateAudioCodes'));
 changeAceModel('ace-step-1-5-xl-sft');expect(aceControl('shift')).toHaveProperty('value','3');
 fireEvent.change(music().style,{target:{value:''}});fireEvent.change(music().lyrics,{target:{value:''}});
 changeAceModel('ace-step-1-5-turbo');expect(music().style.value).toBe('');expect(music().lyrics.value).toBe('');expect(aceControl('shift')).toHaveProperty('value','4.5');expect(aceControl('generateAudioCodes')).toHaveProperty('checked',false);expect(document.querySelector('[data-num="steps"]')).toHaveProperty('value','11');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('ACE authoring missing actual conditioning node blocks Run without YuE2 requirements',async()=>{
 await mountAce('checkpoints',['TextEncodeAceStepAudio1.5']);changeAceModel('ace-step-1-5-turbo');fireEvent.change(music().style,{target:{value:'lofi'}});
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);expect(document.body.textContent).toContain('TextEncodeAceStepAudio1.5');expect(document.body.textContent).not.toContain('YuE2GenerateMusic');
});

test('Chat renders draw its own prompt and size with Generate settings and leave the Studio fields alone',async()=>{
 localStorage.setItem('deas.pref.studio.run.positive',JSON.stringify('my own studio prompt'));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',family:'sdxl',size:1,info:null}]);
 const job:JobStatus={id:'chat-job',baseUrl:evidence.baseUrl,promptId:'prompt',state:'queued',outputs:[],error:null,generationReady:false};
 vi.mocked(runWorkbenchJob).mockResolvedValue(job);
 const onChatStudio=vi.fn(),onChatRender=vi.fn();
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'},onChatStudio,onChatRender};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 // Chat learns what draws: the checkpoint and its Forge dialect, not blocked.
 await waitFor(()=>expect(onChatStudio).toHaveBeenLastCalledWith({checkpoint:'a.safetensors',dialect:'Illustrious'}));
 view.rerender(<I18nProvider><Workbench {...props} chatRender={{id:'r1',positive:'1girl, fox ears, snow',negative:'lowres',aspect:'1:1',resolution:'1080p'}}/></I18nProvider>);
 await waitFor(()=>expect(onChatRender).toHaveBeenCalledWith('r1',expect.objectContaining({job,width:1088,height:1088,checkpoint:'a.safetensors'})));
 const intent=vi.mocked(runWorkbenchJob).mock.calls[0][1] as {positivePrompt:string;negativePrompt:string;width:number;height:number};
 expect(intent).toMatchObject({positivePrompt:'1girl, fox ears, snow',negativePrompt:'lowres',width:1088,height:1088});
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.positive')!)).toBe('my own studio prompt');
 // A size it cannot read is refused with a reason, and nothing runs.
 view.rerender(<I18nProvider><Workbench {...props} chatRender={{id:'r2',positive:'x',negative:'',aspect:'cinematic'}}/></I18nProvider>);
 await waitFor(()=>expect(onChatRender).toHaveBeenCalledWith('r2',{error:expect.stringContaining('That size could not be used')}));
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
});

test('Chat cannot render while Generate is not on text-to-image, and says what to change',async()=>{
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify('i2i'));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',family:'sdxl',size:1,info:null}]);
 const onChatStudio=vi.fn();
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}} onChatStudio={onChatStudio}/></I18nProvider>);
 await waitFor(()=>expect(onChatStudio).toHaveBeenLastCalledWith(expect.objectContaining({checkpoint:'a.safetensors',blocked:expect.stringContaining('Switch its pipeline to text-to-image')})));
});

test('running jobs show a step-time estimate after two step updates and drop it on completion',async()=>{
 let clock=0,polls=0;const now=vi.spyOn(Date,'now').mockImplementation(()=>clock);
 try{
  const job=heldJob('eta','running');
  vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([{...job,progress:{value:0,max:10}}]));
  vi.mocked(pollWorkbench).mockImplementation(async()=>{polls++;if(polls<=2)clock=polls*1000;return collection([polls>=4?{...job,state:'succeeded'}:{...job,progress:{value:Math.min(polls,2),max:10}}]);});
  render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
  await waitFor(()=>expect(document.querySelector('.wb-shown .empty-note')?.textContent).toContain('1/10'),{timeout:4000});
  expect(document.querySelector('[data-step-eta]')).toBeNull();
  await waitFor(()=>expect(document.querySelector('[data-job-id="eta"]')?.textContent).toContain('2/10 · ~8 sec left'),{timeout:4000});
  expect(document.querySelector('.wb-shown .empty-note')?.textContent).toContain('2/10 · ~8 sec left');
  await waitFor(()=>expect(document.querySelector('[data-job-id="eta"] [data-state]')?.getAttribute('data-state')).toBe('succeeded'),{timeout:4000});
  expect(document.querySelector('[data-step-eta]')).toBeNull();
 }finally{now.mockRestore();}
});

test('full view steps through recent image results in queue order, skips video, stops at the ends and leaves the draft alone',async()=>{
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection(navJobs()));
 render(<I18nProvider><Workbench endpoint="http://new:7802/"/></I18nProvider>);
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'keep'}});
 await waitFor(()=>expect(document.querySelector('.wb-shown img')?.getAttribute('src')).toContain('/out/c.png'));
 clickMedia(document.querySelector<HTMLImageElement>('.wb-shown img')!);
 const src=()=>document.querySelector('.wb-viewer img')?.getAttribute('src'),name=()=>document.querySelector('.wb-viewer-name')!.textContent;
 expect(name()).toContain('1 / 3');expect(screen.getByRole('button',{name:'Previous picture'})).toHaveProperty('disabled',true);
 fireEvent.keyDown(window,{key:'ArrowLeft'});expect(src()).toContain('/out/c.png');
 fireEvent.keyDown(document.querySelector('#run-positive')!,{key:'ArrowRight'});expect(src()).toContain('/out/c.png');
 fireEvent.keyDown(window,{key:'ArrowRight'});expect(src()).toContain('/out/raw/one.png');expect(name()).toContain('2 / 3');
 fireEvent.click(screen.getByRole('button',{name:'Next picture'}));expect(src()).toContain('/out/raw/two.png');
 expect(screen.getByRole('button',{name:'Next picture'})).toHaveProperty('disabled',true);
 fireEvent.keyDown(window,{key:'ArrowRight'});expect(src()).toContain('/out/raw/two.png');
 fireEvent.keyDown(window,{key:'Escape'});expect(document.querySelector('.wb-viewer')).toBeNull();
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('keep');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();
});

test.each(['image','video','audio'] as const)('secondary preview actions stay in More and retain the media context menu (%s)',async(media)=>{
 const filename=media==='image'?'c.png':media==='video'?'c.mp4':'c.flac';
 const job={...heldJob('secondary','succeeded'),outputRoot:'/out',outputs:[{filename,subfolder:'',type:'output' as const}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 vi.mocked(invoke).mockImplementation(async command=>command==='native_media_star_status'?{starred:false,unavailable:null}:{path:'/out',parent:'/',entries:[{name:filename,path:'/out/'+filename,kind:'file',symlink:false,media,size:1,modified:1}],truncated:false});
 const onAnalyze=vi.fn();render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{output:'/out'}} onAnalyze={onAnalyze}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-job-id="secondary"]')).not.toBeNull());
 const toolbar=document.querySelector('.wb-stage > [data-media-tools]')!;
 const clean=toolbar.querySelector('[data-media-export-clean]')!;
 expect(clean.closest('.wb-more-menu')).not.toBeNull();
 expect(toolbar.querySelector(':scope > [data-media-export-clean]')).toBeNull();
 const analyze=within(toolbar as HTMLElement).queryByText('Open in Media Analysis');
 if(media!=='audio'){
  expect(analyze).not.toBeNull();expect(analyze!.closest('.wb-more-menu')).not.toBeNull();
  fireEvent.click(toolbar.querySelector('[data-more]')!);
  fireEvent.mouseDown(analyze!);fireEvent.click(analyze!);
  expect(onAnalyze).toHaveBeenCalledWith(expect.objectContaining({path:'/out/'+filename,media}));
 }else expect(analyze).toBeNull();
 fireEvent.contextMenu(document.querySelector('[data-job-id="secondary"] .wb-queue-select')!);
 expect(screen.getByRole('menuitem',{name:'Export without metadata…'})).toBeTruthy();
 fireEvent.keyDown(document,{key:'Escape'});
 fireEvent.contextMenu(await screen.findByRole('button',{name:filename}));
 expect(screen.getByRole('menuitem',{name:'Export without metadata…'})).toBeTruthy();
 if(media!=='audio')expect(screen.getByRole('menuitem',{name:'Open in Media Analysis'})).toBeTruthy();
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(autoRefine).not.toHaveBeenCalled();
});

test('Export without metadata saves a clean copy from the queue menu and preview toolbar; cancel is silent, errors show',async()=>{
 const job=navJobs()[2];
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 let reply:()=>Promise<unknown>=async()=>({path:'/save/c.png',size:3});
 vi.mocked(invoke).mockImplementation(async(command)=>command==='native_media_export_clean'?reply():command==='native_media_star_status'?{starred:false,unavailable:null}:{entries:[],truncated:false});
 const view=render(<I18nProvider><Workbench endpoint="http://new:7802/"/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-job-id="last"]')).not.toBeNull());
 fireEvent.contextMenu(document.querySelector('[data-job-id="last"] .wb-queue-select')!);
 const item=screen.getByRole('menuitem',{name:'Export without metadata…'});
 expect(item.getAttribute('title')).toContain('can be replaced after confirmation');fireEvent.click(item);
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_media_export_clean',{path:'/out/c.png',title:'Export without metadata',replaceTitle:'Replace existing file?',replaceMessage:'Replace the selected file with a copy without metadata? Choosing the original file replaces it too.'}));
 await screen.findByText('Saved a copy without metadata: /save/c.png');
 reply=async()=>null;const toolbar=()=>document.querySelector<HTMLButtonElement>('[data-media-export-clean]')!;
 expect(toolbar().closest('.wb-more-menu')).not.toBeNull();
 fireEvent.click(document.querySelector('[data-more]')!);
 fireEvent.click(toolbar());
 await waitFor(()=>expect(vi.mocked(invoke).mock.calls.filter(c=>c[0]==='native_media_export_clean')).toHaveLength(2));
 expect(document.querySelector('.wb-more-feedback')).toBeNull();
 reply=async()=>{throw new Error('disk full');};fireEvent.click(document.querySelector('[data-more]')!);fireEvent.click(toolbar());
 await screen.findByText('Export without metadata failed: disk full');
 vi.mocked(isTauri).mockReturnValue(false);view.rerender(<I18nProvider><Workbench endpoint="http://new:7802/"/></I18nProvider>);
 expect(toolbar().disabled).toBe(true);expect(toolbar().title).toBe('Exporting without metadata requires a local file in the desktop app.');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['settled','pending'] as const)('model changes clear %s export feedback and preview selection without removing queue history',async state=>{
 vi.mocked(scanModels).mockResolvedValue([...imageModels,{...imageModels[0],name:'b.safetensors',path:'/m/b'}]);
 const job=navJobs()[2];
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 let finish!:(value:unknown)=>void;
 vi.mocked(invoke).mockImplementation(async command=>command==='native_media_export_clean'?(state==='settled'?{path:'/save/old.png',size:3}:new Promise(resolve=>{finish=resolve;})):command==='native_media_star_status'?{starred:false,unavailable:null}:{entries:[],truncated:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-job-id="last"]')).not.toBeNull());
 await waitFor(()=>expect(document.querySelector('[data-model-picker] option[value="b.safetensors"]')).not.toBeNull());
 fireEvent.contextMenu(document.querySelector('[data-job-id="last"] .wb-queue-select')!);
 fireEvent.click(screen.getByRole('menuitem',{name:'Export without metadata…'}));
 if(state==='settled')await screen.findByText('Saved a copy without metadata: /save/old.png');
 else await waitFor(()=>expect(finish).toBeDefined());
 fireEvent.change(document.querySelector('[data-model-picker]')!,{target:{value:'b.safetensors'}});
 if(state==='pending')await act(async()=>finish({path:'/save/old.png',size:3}));
 expect(document.querySelector('.wb-more-feedback')).toBeNull();
 expect(document.querySelector('.wb-job-line')).toBeNull();
 expect(document.querySelector('[data-job-id="last"] [data-state="succeeded"]')).not.toBeNull();
 fireEvent.click(document.querySelector('[data-job-id="last"] .wb-queue-select')!);
 expect(document.querySelector('.wb-job-line')?.textContent).toContain('Succeeded');
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(stopWorkbench).not.toHaveBeenCalled();
});

test('Post-Processing category cards show ordered status/counts, guard incompatible remembered settings, and open accessible overlays without side effects',async()=>{
 localStorage.setItem('deas.pref.studio.run.derope',JSON.stringify({enabled:true,mode:'full',distilled:true,keepBackground:true,lora:'',preset:'balanced',inject:0.7}));
 localStorage.setItem('deas.pref.studio.run.tve',JSON.stringify({...defaultTve,loop:true,denoise:true,upscaleModel:'4x-UltraSharp.pth'}));
 localStorage.setItem('deas.pref.studio.run.latent.h3',JSON.stringify({enabled:true,model:'minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors',scale:2,steps:10,denoise:0.4,advanced:{...h3LatentDefaults,spikeGuard:true}}));
 vi.mocked(scanModels).mockResolvedValue([
  {category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null},
  {category:'diffusion_models',name:'h3.safetensors',family:'minimax-h3',path:'/m/h3',size:1,info:null},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/te',size:1,info:null},
  {category:'vae',name:'minimax_h3_video_vae_fp16.safetensors',path:'/m/vae',size:1,info:null},
  {category:'vae',name:'minimax_h3_audio_vae_fp32.safetensors',path:'/m/avae',size:1,info:null},
 ]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DaSiWaTiledDiffusion','DEAS_VideoPostprocessGate','DaSiWaH3DeropePrepare','DaSiWaH3DeropeRecover','DaSiWaH3TiledUpscale'],deropeKeepBackground:true}});
 const onOpenVideoPost=vi.fn();
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}} onOpenVideoPost={onOpenVideoPost}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('a.safetensors'));
 dock('Post-Processing');
 const cards=()=>Array.from(document.querySelectorAll<HTMLButtonElement>('[data-post-card]'));
 expect(cards().map(c=>c.dataset.postCard)).toEqual(['audio','latent','regenerate','face-analysis','sam','refine','model','derope','tve']);
 // Audio/video categories stay unavailable on image pipelines, with 0 active functions.
 for(const id of ['audio','latent','regenerate','face-analysis','derope','tve']){
  const card=document.querySelector<HTMLButtonElement>(`[data-post-card="${id}"]`)!;
  expect(card.dataset.postState).toBe('unavailable');
  expect(card.dataset.postCount).toBe('0');
  expect(card.disabled).toBe(true);
  fireEvent.click(card);
  expect(card.getAttribute('aria-expanded')).toBe('false');
 }
 expect(document.querySelector('[data-dock-tab="post"] .wb-dock-badge')).toBeNull();
 const before=captureStudioSettings();
 const refineCard=document.querySelector<HTMLButtonElement>('[data-post-card="refine"]')!;
 fireEvent.click(refineCard);
 const dialog=screen.getByRole('dialog',{name:'Refine / Upscale'});
 expect(document.activeElement).toBe(within(dialog).getByRole('button',{name:'Close'}));
 expect(captureStudioSettings()).toEqual(before);
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
 fireEvent.keyDown(document,{key:'Escape'});
 expect(screen.queryByRole('dialog',{name:'Refine / Upscale'})).toBeNull();
 expect(document.activeElement).toBe(refineCard);
 // Intentional edits inside the overlay update card state, count, and dock badge, and persist across close/reopen.
 fireEvent.click(refineCard);
 fireEvent.click(screen.getByRole('checkbox',{name:'Refine / Upscale after every run'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'Tiled refine (DaSiWa Tiled Diffusion)'}));
 expect(refineCard.dataset.postState).toBe('active');
 expect(refineCard.dataset.postCount).toBe('2');
 expect(document.querySelector('[data-dock-tab="post"] .wb-dock-badge')?.textContent).toBe('2');
 fireEvent.click(screen.getByRole('button',{name:'Close'}));
 expect(document.activeElement).toBe(refineCard);
 // Pipeline-incompatible categories cannot open or navigate to another workspace.
 fireEvent.click(document.querySelector('[data-post-card="tve"]')!);
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(onOpenVideoPost).not.toHaveBeenCalled();
 // An open image category closes when switching to an incompatible video pipeline.
 fireEvent.click(refineCard);
 // Switching to MiniMax H3 video activates the remembered video post-processing counts and deactivates image refine.
 localStorage.setItem('deas.pref.studio.run.samVideoCuts','true');
 localStorage.setItem('deas.pref.studio.run.faceRefine',JSON.stringify({auto:false,denoise:0.3,cropFactor:2.5,feather:6,prompt:''}));
 choosePipe('Text → Video');
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-post-card="derope"]')!.dataset.postCount).toBe('3'));
 expect(document.querySelector<HTMLButtonElement>('[data-post-card="latent"]')!.dataset.postCount).toBe('2');
 expect(document.querySelector<HTMLButtonElement>('[data-post-card="model"]')!.dataset.postCount).toBe('1');
 expect(document.querySelector<HTMLButtonElement>('[data-post-card="tve"]')!.dataset.postCount).toBe('2');
 // A remembered scene-cuts option does not count as a running function when face refinement is not enabled.
 expect(document.querySelector<HTMLButtonElement>('[data-post-card="face-analysis"]')!.dataset.postState).toBe('inactive');
 expect(document.querySelector<HTMLButtonElement>('[data-post-card="face-analysis"]')!.dataset.postCount).toBe('0');
 expect(localStorage.getItem('deas.pref.studio.run.samVideoCuts')).toBe('true');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.faceRefine')!).auto).toBe(false);
 expect(document.querySelector<HTMLButtonElement>('[data-post-card="refine"]')!.dataset.postState).toBe('unavailable');
 expect(document.querySelector<HTMLButtonElement>('[data-post-card="refine"]')!.dataset.postCount).toBe('0');
 expect(refineCard.disabled).toBe(true);
 expect(document.querySelector<HTMLButtonElement>('[data-post-card="audio"]')!.disabled).toBe(false);
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(document.querySelector('[data-dock-tab="post"] .wb-dock-badge')?.textContent).toBe('8');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('Post-Processing overlay allows Tab focus outside, ignores hidden dialogs, lets native dialogs handle Escape, supports Ctrl+K and SAM reveal, and keeps audio install feedback reachable on close',async()=>{
 const sam='SAM3/sam3.1_multiplex_fp16.safetensors';
 localStorage.setItem('deas.pref.studio.run.samVideoCuts','true');
 localStorage.setItem('deas.pref.studio.run.faceRefine',JSON.stringify({auto:false,denoise:0.3,cropFactor:2.5,feather:6,prompt:'sharp face'}));
 vi.mocked(scanModels).mockResolvedValue([
  {category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null},
  {category:'checkpoints',name:sam,family:'sam3',path:'/m/'+sam,size:1,info:null},
  {category:'diffusion_models',name:'h3.safetensors',family:'minimax-h3',path:'/m/h3',size:1,info:null},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/te',size:1,info:null},
  {category:'vae',name:'minimax_h3_video_vae_fp16.safetensors',path:'/m/vae',size:1,info:null},
  {category:'vae',name:'minimax_h3_audio_vae_fp32.safetensors',path:'/m/avae',size:1,info:null},
 ]);
 const fullAllowlist={...videoEvidence.allowlist,checkpoints:[...videoEvidence.allowlist.checkpoints,sam],nodes:[...videoEvidence.allowlist.nodes,'SAM3_Detect',...sam3VideoNodes,...faceRefineNodes,'DaSiWaTiledDiffusion','DEAS_VideoPostprocessGate','DaSiWaH3DeropePrepare','DaSiWaH3DeropeRecover'],deropeKeepBackground:true};
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:fullAllowlist});
 let releaseInstall!:()=>void;
 let failInstall!:(err:Error)=>void;
 let installCalls=0;
 vi.mocked(invoke).mockImplementation(async(command)=>{
  if(command==='native_audio_enhance_capabilities')return{clean:true,deep:false,stems:false,cuda:false,gpuRepair:false};
  if(command==='native_audio_enhance_install_status')return{running:installCalls>0,mode:installCalls>0?'deep':null,stage:'downloading',downloaded:12,total:100};
  if(command==='native_audio_enhance_install'){
   installCalls+=1;
   return new Promise<void>((resolve,reject)=>{releaseInstall=resolve;failInstall=reject;});
  }
  if(command==='native_audio_enhance_install_cancel')return null;
  return{path:'/env/ComfyUI/output',parent:'/env/ComfyUI',entries:[{name:'source.png',path:'/env/ComfyUI/output/source.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false};
 });
 const view=render(<I18nProvider><GlobalSearch onNavigate={()=>{}}/><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('a.safetensors'));

 // Ctrl+K with a mounted Workbench switches to Post-Processing, opens the category overlay idempotently, and focuses the indexed control.
 fireEvent.keyDown(window,{key:'k',ctrlKey:true});
 fireEvent.change(screen.getByPlaceholderText('Find a control…'),{target:{value:'Refine / Upscale after every run'}});
 fireEvent.click(screen.getByRole('button',{name:/Studio › Refine \/ Upscale › Refine \/ Upscale after every run/}));
 const autoRefineInput=await waitFor(()=>{
  const el=document.querySelector<HTMLInputElement>('.wb-post [data-refine="auto"]');
  expect(el).not.toBeNull();
  expect(document.activeElement).toBe(el);
  return el!;
 });
 const refineCard=document.querySelector<HTMLButtonElement>('[data-post-card="refine"]')!;
 expect(refineCard.getAttribute('aria-expanded')).toBe('true');
 // Repeating Ctrl+K for the same indexed control while already open keeps the overlay open and refocuses the control.
 fireEvent.keyDown(window,{key:'k',ctrlKey:true});
 fireEvent.change(screen.getByPlaceholderText('Find a control…'),{target:{value:'Refine / Upscale after every run'}});
 fireEvent.click(screen.getByRole('button',{name:/Studio › Refine \/ Upscale › Refine \/ Upscale after every run/}));
 await waitFor(()=>expect(document.activeElement).toBe(autoRefineInput));
 expect(refineCard.getAttribute('aria-expanded')).toBe('true');

 // The floating category panel has no backdrop and never traps Tab; its DOM ancestry preserves search/reveal and hidden-pane handling.
 const hiddenHost=document.createElement('div');
 hiddenHost.hidden=true;
 const hiddenDialog=document.createElement('dialog');
 hiddenDialog.open=true;
 hiddenHost.appendChild(hiddenDialog);
 document.body.appendChild(hiddenHost);
 const getOverlay=()=>document.querySelector<HTMLElement>('.wb-post-overlay')!;
 expect(getOverlay().closest('.wb-dock-panel')).not.toBeNull();
 expect(getOverlay().getAttribute('aria-modal')).toBeNull();
 expect(document.querySelector('.wb-post-overlay-backdrop')).toBeNull();
 const closeBtn=within(getOverlay()).getByRole('button',{name:'Close'});
 closeBtn.focus();
 expect(fireEvent.keyDown(document,{key:'Tab'})).toBe(true);
 expect(fireEvent.keyDown(document,{key:'Tab',shiftKey:true})).toBe(true);

 // When the Studio pane is hidden, the Post overlay ignores Tab and Escape.
 const workbenchHost=document.querySelector<HTMLElement>('.workbench-host')!;
 workbenchHost.hidden=true;
 fireEvent.keyDown(document,{key:'Escape'});
 expect(refineCard.getAttribute('aria-expanded')).toBe('true');
 workbenchHost.hidden=false;

 // When Ctrl+K is open above the category overlay, Escape closes only GlobalSearch and leaves the category overlay open.
 fireEvent.keyDown(window,{key:'k',ctrlKey:true});
 const searchInput=screen.getByPlaceholderText('Find a control…');
 fireEvent.keyDown(searchInput,{key:'Escape'});
 expect(document.querySelector('#global-search-panel')).toBeNull();
 expect(refineCard.getAttribute('aria-expanded')).toBe('true');
 fireEvent.keyDown(document,{key:'Escape'});
 expect(refineCard.getAttribute('aria-expanded')).toBe('false');
 expect(document.activeElement).toBe(refineCard);
 hiddenHost.remove();

 // Inpaint keeps the target mask action in the SAM overlay, with normal dialog focus.
 fireEvent.click(screen.getByRole('tab',{name:'Media'}));
 fireEvent.click(await screen.findByRole('button',{name:'source.png'}));adopt();
 const srcImg=screen.getByRole('img',{name:'source.png'});
 Object.defineProperties(srcImg,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(srcImg);
 fireEvent.click(document.querySelector('[data-edit="inpaint"]')!);
 expect(document.querySelector('.wb-side [data-sam="mask"]')).toBeNull();
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 const samCard=document.querySelector<HTMLButtonElement>('[data-post-card="sam"]')!;
 fireEvent.click(samCard);
 expect(document.activeElement).toBe(within(getOverlay()).getByRole('button',{name:'Close'}));
 fireEvent.click(within(getOverlay()).getByRole('button',{name:'Close'}));
 expect(document.activeElement).toBe(samCard);
 fireEvent.click(samCard);
 expect(document.activeElement).toBe(within(getOverlay()).getByRole('button',{name:'Close'}));
 fireEvent.click(within(getOverlay()).getByRole('button',{name:'Close'}));
 expect(document.activeElement).toBe(samCard);

 // H3 I2V must allow automatic face refinement with both prompt fields empty.
 choosePipe('Image → Video');
 fireEvent.change(screen.getByRole('textbox',{name:/^Prompt$/}),{target:{value:''}});
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-post-card="face-analysis"]')!.dataset.postState).toBe('inactive'));
 const faceCard=document.querySelector<HTMLButtonElement>('[data-post-card="face-analysis"]')!;
 expect(faceCard.dataset.postCount).toBe('0');
 expect(document.querySelector('[data-dock-tab="post"] .wb-dock-badge')).toBeNull();
 expect(localStorage.getItem('deas.pref.studio.run.samVideoCuts')).toBe('true');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.faceRefine')!).auto).toBe(false);

 // (2) Auto on and available even without prompts: card and dock report 2 active functions.
 fireEvent.click(faceCard);
 fireEvent.change(document.querySelector<HTMLTextAreaElement>('[data-face-refine="prompt"]')!,{target:{value:''}});
 const cutsCheckbox=document.querySelector<HTMLInputElement>('[data-sam-video="cuts"]')!;
 expect(cutsCheckbox.checked).toBe(true);
 const faceAutoCheckbox=await waitFor(()=>{
  const el=document.querySelector<HTMLInputElement>('[data-face-refine="auto"]')!;
  expect(document.querySelector('[data-face-refine="autoUnavailable"]')?.textContent??'').toBe('');
  expect(el.disabled).toBe(false);
  return el;
 });
 fireEvent.click(faceAutoCheckbox);
 expect(faceCard.dataset.postState).toBe('active');
 expect(faceCard.dataset.postCount).toBe('2');
 expect(document.querySelector('[data-dock-tab="post"] .wb-dock-badge')?.textContent).toBe('2');
 expect(localStorage.getItem('deas.pref.studio.run.samVideoCuts')).toBe('true');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.faceRefine')!).auto).toBe(true);
 fireEvent.click(within(getOverlay()).getByRole('button',{name:'Close'}));
 expect(document.activeElement).toBe(faceCard);

 // (3) Auto on but blocked (missing faceRefineNodes): card and dock both report 0 while preserving saved preferences.
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,checkpoints:[...videoEvidence.allowlist.checkpoints,sam]}});
 view.rerender(<I18nProvider><GlobalSearch onNavigate={()=>{}}/><Workbench endpoint="http://127.0.0.1:7802/" roots={{models:'/m',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-post-card="face-analysis"]')!.dataset.postCount).toBe('0'));
 expect(document.querySelector<HTMLButtonElement>('[data-post-card="face-analysis"]')!.dataset.postState).toBe('inactive');
 expect(document.querySelector('[data-post-card="face-analysis"] .wb-post-card-reason')?.textContent).toBeTruthy();
 expect(document.querySelector('[data-dock-tab="post"] .wb-dock-badge')).toBeNull();
 expect(localStorage.getItem('deas.pref.studio.run.samVideoCuts')).toBe('true');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.faceRefine')!).auto).toBe(true);

 // Native dialog handles its own Escape; once consented, closing the Audio overlay restores focus and keeps progress, cancel, and errors reachable in the Post dock.
 const audioCard=document.querySelector<HTMLButtonElement>('[data-post-card="audio"]')!;
 fireEvent.click(audioCard);
 const deepInstallBtn=await waitFor(()=>{
  const btn=document.querySelector<HTMLButtonElement>('[data-audio-enhance-install="deep"]');
  expect(btn?.disabled).toBe(false);
  return btn!;
 });
 fireEvent.click(deepInstallBtn);
 expect(askDialog()).not.toBeNull();
 // Escape keydown is ignored by the Post overlay while a native dialog is open; the native dialog's cancel event closes only the dialog.
 const escEvent=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});
 document.dispatchEvent(escEvent);
 expect(escEvent.defaultPrevented).toBe(false);
 expect(audioCard.getAttribute('aria-expanded')).toBe('true');
 fireEvent(askDialog()!,new Event('cancel',{cancelable:true}));
 expect(askDialog()).toBeNull();
 expect(audioCard.getAttribute('aria-expanded')).toBe('true');
 expect(installCalls).toBe(0);

 // Start install via the existing consent flow, then close the Audio overlay.
 fireEvent.click(deepInstallBtn);
 askConfirm();
 await waitFor(()=>expect(installCalls).toBe(1));
 expect(document.querySelector('[data-audio-enhance-install-status]')).not.toBeNull();
 fireEvent.click(within(getOverlay()).getByRole('button',{name:'Close'}));
 expect(audioCard.getAttribute('aria-expanded')).toBe('false');
 expect(document.activeElement).toBe(audioCard);
 expect(installCalls).toBe(1);
 const dockStatus=document.querySelector('[data-audio-enhance-dock-feedback] [data-audio-enhance-install-status]');
 const dockCancel=document.querySelector<HTMLButtonElement>('[data-audio-enhance-dock-feedback] [data-audio-enhance-install-cancel]');
 expect(dockStatus).not.toBeNull();
 expect(dockCancel).not.toBeNull();
 fireEvent.click(dockCancel!);
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_audio_enhance_install_cancel'));
 await act(async()=>{failInstall(new Error('network interrupted'));});
 await waitFor(()=>expect(document.querySelector('[data-audio-enhance-dock-feedback] [role="alert"]')?.textContent).toContain('network interrupted'));
 void releaseInstall;
});
