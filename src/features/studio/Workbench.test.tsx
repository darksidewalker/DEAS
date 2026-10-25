import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Workbench } from './Workbench';
import { defaultOptions } from './OptionsPanel';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { stopWorkbench, runWorkbenchJob, readCurrentWorkbench, pollWorkbench, uploadMask, uploadInput, readH3Session, prepareH3Video, readRefMods, loadDiagnosticJobOutput, exportDiagnosticJobOutput, type JobStatus } from '../../lib/jobs';
vi.mock('@tauri-apps/api/core',()=>({isTauri:vi.fn(()=>true),convertFileSrc:(p:string)=>`asset://localhost/${p}`,invoke:vi.fn(async()=>({path:'/env/ComfyUI/output',parent:'/env/ComfyUI',entries:[],truncated:false}))}));
vi.mock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({onCloseRequested:async()=>()=>{}})}));
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}));
vi.mock('../../lib/recipePrerequisites',()=>({checkRecipePrerequisites:vi.fn(async()=>{throw new Error('offline');})}));
vi.mock('../../lib/models',()=>({scanModels:vi.fn()}));
vi.mock('../../lib/jobs',()=>({uploadMask:vi.fn(),uploadInput:vi.fn(),readH3Session:vi.fn(),prepareH3Video:vi.fn(),readRefMods:vi.fn(),stopWorkbench:vi.fn(),runWorkbenchJob:vi.fn(),readCurrentWorkbench:vi.fn(),pollWorkbench:vi.fn(),loadDiagnosticJobOutput:vi.fn(),exportDiagnosticJobOutput:vi.fn()}));
const collection=(jobs:JobStatus[]=[],preparing=0)=>({jobs,preparing,capacity:20,stopAvailable:true,admissionEpoch:0,stopping:false});
const evidence={baseUrl:'http://127.0.0.1:7801/',recipeId:'checkpoint-text-to-image-diagnostic' as const,version:1 as const,missingNodes:[],generationReady:false as const,
 allowlist:{nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage'],checkpoints:['a.safetensors','b.safetensors'],loras:['style.safetensors'],samplers:['euler','euler_ancestral','euler_cfg_pp','er_sde'],schedulers:['normal','simple','linear_quadratic']}};
beforeEach(()=>{
 vi.mocked(stopWorkbench).mockResolvedValue({...collection(),admissionEpoch:1,outcome:'empty',discarded:0,issues:[]});
 vi.mocked(readCurrentWorkbench).mockImplementation(async()=>{
  const submitted=await Promise.all(vi.mocked(runWorkbenchJob).mock.results.filter(result=>result.type==='return').map(async result=>{try{return await result.value as JobStatus;}catch{return null;}}));
  return collection([...new Map(submitted.filter((job):job is JobStatus=>!!job).map(job=>[job.id,job])).values()]);
 });
 vi.mocked(pollWorkbench).mockResolvedValue(collection());
 localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(true);
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.open=false;}});
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({save:vi.fn(),restore:vi.fn(),arc:vi.fn(),fill:vi.fn(),beginPath:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),drawImage:vi.fn(),getImageData:vi.fn(()=>({data:new Uint8ClampedArray([0,0,0,0])}))} as unknown as CanvasRenderingContext2D);
});
afterEach(()=>{cleanup();Reflect.deleteProperty(HTMLDialogElement.prototype,'showModal');Reflect.deleteProperty(HTMLDialogElement.prototype,'close');vi.clearAllMocks();vi.unstubAllGlobals();});
const heldJob=(id:string,state:JobStatus['state'],baseUrl='http://original:7801/'):JobStatus=>({id,state,baseUrl,promptId:'p-'+id,outputs:[],error:null,generationReady:false});
test.each(['http://old:7801/','http://new:7802/'])('recovered output uses native root, not endpoint or current environment (%s)',async baseUrl=>{
 const job={...heldJob('old-environment','succeeded',baseUrl),outputRoot:'/old-env/output',outputs:[{filename:'result.png',subfolder:'raw',type:'output' as const}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
 vi.mocked(invoke).mockImplementation(async command=>command==='native_media_star_status'?{starred:false,unavailable:null}:{entries:[],truncated:false});
 render(<I18nProvider><Workbench endpoint="http://new:7802/" roots={{output:'/new-env/output'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-job-id="old-environment"] img')?.getAttribute('src')).toContain('/old-env/output/raw/result.png'));
 expect(document.querySelector('.wb-shown img')?.getAttribute('src')).toContain('/old-env/output/raw/result.png');
 expect(document.querySelectorAll('[src*="/new-env/output/"]')).toHaveLength(0);
 expect(invoke).toHaveBeenCalledWith('native_media_star_status',{path:'/old-env/output/raw/result.png'});
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
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 let resolve!:(value:ReturnType<typeof collection>)=>void;
 vi.mocked(readCurrentWorkbench).mockReturnValueOnce(new Promise(yes=>{resolve=yes;}));
 vi.mocked(pollWorkbench).mockResolvedValue(collection());
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
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
const clickMedia=(image:HTMLImageElement,clientX=400,clientY=300)=>{
 if(!image.naturalWidth)Object.defineProperties(image,{naturalWidth:{configurable:true,value:1024},naturalHeight:{configurable:true,value:640}});
 const bounds=Object.getOwnPropertyDescriptor(image,'getBoundingClientRect');
 Object.defineProperty(image,'getBoundingClientRect',{configurable:true,value:()=>({left:0,top:0,width:800,height:600})});
 fireEvent.click(image,{clientX,clientY});
 if(bounds)Object.defineProperty(image,'getBoundingClientRect',bounds);else Reflect.deleteProperty(image,'getBoundingClientRect');
};
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
 await waitFor(()=>expect((screen.getByLabelText('Preset name') as HTMLInputElement).disabled).toBe(false));
 fireEvent.change(screen.getByLabelText('Preset name'),{target:{value:'My settings'}});
 fireEvent.click(screen.getByRole('button',{name:'Save as new preset'}));
 await screen.findByText('Preset saved.');
 expect(stored).toEqual([{name:'My settings',settings:expect.objectContaining({'studio.run.positive':'saved prompt','studio.run.steps':31})}]);
 expect((stored[0] as {settings:object}).settings).not.toHaveProperty('studio.run.recentSeeds');
 expect((stored[0] as {settings:object}).settings).not.toHaveProperty('studio.run.continuity');
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'changed'}});
 view.unmount();view=mount();
 await screen.findByRole('option',{name:'My settings'});
 fireEvent.change(screen.getByLabelText('Saved preset'),{target:{value:'My settings'}});
 fireEvent.click(screen.getByRole('button',{name:'Load preset'}));
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('saved prompt');
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('31');
 fireEvent.change(screen.getByLabelText('Steps'),{target:{value:'27'}});
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 fireEvent.click(screen.getByRole('button',{name:'Update selected preset'}));
 expect((stored[0] as {settings:Record<string,unknown>}).settings['studio.run.steps']).toBe(31);
 confirm.mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:'Update selected preset'}));
 await screen.findByText('Preset saved.');
 expect((stored[0] as {settings:Record<string,unknown>}).settings['studio.run.steps']).toBe(27);
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
 confirm.mockRestore();
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
const adopt=()=>{const preview=document.querySelector('[data-browsed-preview]');if(!preview)return;const action=preview.querySelector<HTMLButtonElement>('[data-use-input], [data-edit="resample"]');if(action)fireEvent.click(action);};
const dock=(name:string)=>fireEvent.click(screen.getByRole('tab',{name}));
// The pipeline picker is one select at the top of the settings; disabled options name pipelines without a runnable model.
const pipe=(name:string)=>screen.getByRole('option',{name}) as HTMLOptionElement;
const choosePipe=(name:string)=>fireEvent.change(screen.getByRole('combobox',{name:'Pipeline'}),{target:{value:pipe(name).value}});
// HTML5 drag of a dock tile onto the editor: the tile's dragstart fills a DataTransfer the drop reads back.
const dropTile=(name:string)=>{const store:Record<string,string>={};const dt={setData:(k:string,v:string)=>{store[k]=v;},getData:(k:string)=>store[k]??'',get types(){return Object.keys(store);}};
 fireEvent.dragStart(screen.getByRole('button',{name}),{dataTransfer:dt});fireEvent.drop(document.querySelector('[data-editor-viewport]')!,{dataTransfer:dt});};
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
test('unexecuted settings survive layout reset and remount; confirmed defaults survive the next mount',async()=>{
 vi.mocked(scanModels).mockResolvedValue(['base.safetensors','last.safetensors'].map(name=>({category:'checkpoints',name,family:'sdxl',path:'/m/'+name,size:1,info:null})));
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
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
 expect(confirm).not.toHaveBeenCalled();
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
 expect(Object.fromEntries(Object.entries(localStorage))).toEqual(stored);
 confirm.mockReturnValue(true);
 act(()=>window.dispatchEvent(new Event('deas:request-studio-defaults')));
 view.unmount();mount();
 await waitFor(()=>expect(pipe('Text → Image').disabled).toBe(false));
 expect(pipe('Text → Image').selected).toBe(true);
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('');
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('28');
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1024');
 expect((screen.getByRole('textbox',{name:'Output naming'}) as HTMLInputElement).value).toBe(defaultOptions.outputNaming);
 expect(screen.getByRole('button',{name:'Random',pressed:true})).toBeTruthy();
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 confirm.mockRestore();
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
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));
 act(()=>window.dispatchEvent(new Event('deas:request-studio-defaults')));
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('edited');
 confirm.mockReturnValue(true);act(()=>window.dispatchEvent(new Event('deas:request-studio-defaults')));
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('');
 expect(localStorage.getItem('deas.pref.studio.run.checkpoint')).toBe('"base.safetensors"');
 expect(localStorage.getItem('deas.pref.studio.run.options')).toBe(JSON.stringify(defaultOptions));
 for(const key of ['post','post.tiled','wildcardEnabled'])expect(localStorage.getItem('deas.pref.studio.run.'+key)).toBe('false');
 expect(localStorage.getItem('deas.pref.studio.run.loras')).toBe('[]');expect(localStorage.getItem('deas.pref.studio.run.upscale')).toBe('1');
 expect(localStorage.getItem('deas.pref.studio.dock.height')).toBe('250');expect(localStorage.getItem('library.sentinel')).toBe('keep');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 expect((screen.getByRole('spinbutton',{name:'Steps'}) as HTMLInputElement).value).toBe('28');
 confirm.mockRestore();
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
 const preview=document.querySelector('[data-browsed-preview]')!;
 await waitFor(()=>expect(within(preview as HTMLElement).getByRole('button',{name:'Star a.png'}).hasAttribute('disabled')).toBe(false));
 clickMedia(preview.querySelector('img')!);
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
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m',output:'/out'}}/></I18nProvider>);
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

test.each([['de','Abgebrochen'],['en','Cancelled'],['fr','Annulé'],['ja','キャンセル済み'],['tr','İptal edildi'],['zh','已取消']])('cancelled job is a terminal localized result without output actions (%s)',async(locale,label)=>{
 localStorage.setItem('deas.locale.v1',locale);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'cancelled-job',baseUrl:evidence.baseUrl,promptId:'p',state:'cancelled',outputs:[],error:null,generationReady:false});
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m',output:'/out'}}/></I18nProvider>);
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
 ...['de','en','fr','ja','tr','zh'].map(locale=>({locale,generationMs:13310,state:'succeeded' as const,filename:'result.png'})),
 {locale:'en',generationMs:0,state:'succeeded' as const,filename:'zero.png'},
 {locale:'en',generationMs:null,state:'succeeded' as const,filename:'unknown.png'},
 {locale:'en',generationMs:13310,state:'failed' as const,filename:'failed.png'},
 {locale:'en',generationMs:13310,state:'succeeded' as const,filename:'clip.webm'},
])('queue and selected details use actual timing: $locale / $filename',async({locale,generationMs,state,filename})=>{
 localStorage.setItem('deas.locale.v1',locale);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async command=>command==='native_media_star_status'?{starred:false,unavailable:null}:{path:'/out',parent:'/',entries:[],truncated:false});
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'timing-job',baseUrl:evidence.baseUrl,promptId:'p',state,outputRoot:'/out',outputs:[{filename,subfolder:'',type:'output'}],error:null,generationReady:false,metadata:{startedAt:1700000000000,generationMs}});
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m',output:'/out'}}/></I18nProvider>);
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
 const m=(category:string,name:string,family?:string)=>({category,name,family,path:'/m/'+name,size:1,info:null});
 vi.mocked(scanModels).mockResolvedValue([m('diffusion_models','k2.safetensors','krea-2'),m('text_encoders','qwen3vl_4b.safetensors'),m('vae','qwen_image_vae.safetensors')]);
 vi.mocked(invoke).mockImplementation(async()=>({path:'/out',parent:'/',entries:[{name:'source.png',path:'/out/source.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 for(const [key,value] of Object.entries({checkpoint:'missing.safetensors',vae:'minimax_h3_video_vae.safetensors'}))localStorage.setItem('deas.pref.studio.run.'+key,JSON.stringify(value));
 const mount=()=>render(<I18nProvider><Workbench endpoint="" roots={{models:'/m',output:'/out'}}/></I18nProvider>);
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
 fireEvent.click(screen.getByRole('button',{name:'Post-process'}));
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
 const models=[{category:'diffusion_models',name:'k2.safetensors',family:'krea-2',path:'/m/k2',size:1,info:null},{category:'text_encoders',name:'qwen3vl_4b.safetensors',path:'/m/encoder',size:1,info:null},{category:'vae',name:'qwen_image_vae.safetensors',path:'/m/vae',size:1,info:null}];
 vi.mocked(scanModels).mockResolvedValue(models);
 localStorage.setItem('deas.pref.studio.run.vae','"minimax_h3_video_vae.safetensors"');
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
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
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'base.safetensors',path:'/m/base',size:1,info:null}]);
 vi.mocked(runWorkbenchJob).mockRejectedValueOnce(new Error('Backend connection failed'));
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await screen.findByText('Backend connection failed');
 fireEvent.change(screen.getByRole('combobox',{name:'Pipeline'}),{target:{value:'i2i'}});
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
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
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
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 act(()=>window.dispatchEvent(new Event('deas:request-studio-defaults')));
 expect(submitted.positivePrompt).toBe('immutable submission');expect(document.querySelector('.wb-shown')).not.toBeNull();
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);confirm.mockRestore();
 expect(document.querySelector('[data-browsed-preview]')).toBeNull();
 expect(document.querySelector('.wb-current-preview')?.hasAttribute('hidden')).toBe(false);
});
const projectFixture={id:'project-1',root:'/projects/one',revision:1,draft:{positivePrompt:'saved project prompt',negativePrompt:'saved negative',checkpoint:'missing.safetensors',width:1024,height:1024,steps:24,cfg:6,sampler:'euler',scheduler:'normal',seed:42,denoise:0.5,pipeline:'i2i' as const},input:null};
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
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 const mount=()=>render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 const view=mount();
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));
 const stored=Object.fromEntries(Object.entries(localStorage).filter(([key])=>key.startsWith('deas.pref.studio.run.')));
 fireEvent.click(screen.getByRole('button',{name:'Open project'}));
 await waitFor(()=>expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('saved project prompt'));
 act(()=>window.dispatchEvent(new Event('deas:request-studio-defaults')));
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('saved project prompt');
 expect(invoke).not.toHaveBeenCalledWith('native_project_save',expect.anything());
 confirm.mockReturnValue(true);act(()=>window.dispatchEvent(new Event('deas:request-studio-defaults')));
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
 confirm.mockRestore();
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
test('Options naming persists and resolves the submitted seed/model, rejecting unsafe templates before preparation',async()=>{
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

test('IPC fixture: with an environment the models folder is scanned on mount instead of probing the backend',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'sdxl/base.safetensors',path:'/m/checkpoints/sdxl/base.safetensors',size:1,info:null},{category:'loras',name:'grain.safetensors',path:'/m/loras/grain.safetensors',size:1,info:null},{category:'vae',name:'x.safetensors',path:'/m/vae/x.safetensors',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');
 expect((await screen.findByRole('button',{name:'sdxl/base.safetensors'})).getAttribute('aria-pressed')).toBe('true');
 dock('LoRAs');expect(screen.getByRole('button',{name:'grain.safetensors'}).getAttribute('aria-pressed')).toBe('false');
 expect(scanModels).toHaveBeenCalledExactlyOnceWith('/m',[]);
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1); // only the sampler/scheduler lists, never the model list
});

test('model and LoRA docks get a subfolder tree from the scanned names that filters the tiles per tab',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'sdxl/base.safetensors',path:'/m/checkpoints/sdxl/base.safetensors',size:1,info:null},{category:'checkpoints',name:'sd15/old.safetensors',path:'/m/checkpoints/sd15/old.safetensors',size:1,info:null},{category:'checkpoints',name:'sdxl/anime/pony.safetensors',path:'/m/checkpoints/sdxl/anime/pony.safetensors',size:1,info:null},{category:'loras',name:'grain.safetensors',path:'/m/loras/grain.safetensors',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');
 const tree=await screen.findByRole('navigation',{name:'Folders'});
 fireEvent.click(within(tree).getByRole('button',{name:'anime'}));
 expect(screen.getByRole('button',{name:'sdxl/anime/pony.safetensors'})).toBeTruthy();expect(screen.queryByRole('button',{name:'sdxl/base.safetensors'})).toBeNull();
 fireEvent.click(within(tree).getByRole('button',{name:'sdxl'}));
 expect(screen.getByRole('button',{name:'sdxl/base.safetensors'})).toBeTruthy();expect(screen.queryByRole('button',{name:'sd15/old.safetensors'})).toBeNull();
 dock('LoRAs');expect(screen.queryByRole('navigation',{name:'Folders'})).toBeNull();expect(screen.getByRole('button',{name:'grain.safetensors'})).toBeTruthy(); // no subfolders, no tree, unfiltered
 dock('Models');expect(within(screen.getByRole('navigation',{name:'Folders'})).getByRole('button',{name:'sdxl'}).getAttribute('aria-current')).toBe('location');
 fireEvent.click(within(screen.getByRole('navigation',{name:'Folders'})).getByRole('button',{name:'Models'}));
 expect(screen.getByRole('button',{name:'sd15/old.safetensors'})).toBeTruthy();
 // Tiles print the short name; the full path stays the accessible name. The view choice is remembered.
 expect(screen.getByRole('button',{name:'sd15/old.safetensors'}).querySelector('.wb-tile-name')!.textContent).toBe('old');
 fireEvent.change(screen.getByRole('combobox',{name:'View'}),{target:{value:'list'}});
 expect(document.querySelector('.wb-dock')!.getAttribute('data-view')).toBe('list');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.dock.view')!)).toBe('list');
});

test('IPC fixture: Image→Image is clickable without an image but greys Run and names the missing input; with an Input-folder image it submits inputImage+denoise; video pipelines stay disabled',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'ref.png',path:'/env/ComfyUI/input/ref.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'job-2',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false});
 vi.mocked(pollWorkbench).mockResolvedValue(collection([{id:'job-2',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:'x',generationReady:false}]));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'Text → Image',selected:true});
 expect(pipe('Image → Image').disabled).toBe(false);
 for(const name of ['Text → Video','Image → Video','Video → Video','Multi-reference → Video'])expect(pipe(name).disabled).toBe(true);
 choosePipe('Image → Image');
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 // The missing pick is named once, on the preview, not in the settings column.
 expect(within(screen.getByRole('region',{name:'Preview'})).getByRole('status').textContent).toBe('Pick an image from the Input or Output folder in the Media dock.');
 expect(screen.getAllByText('Pick an image from the Input or Output folder in the Media dock.').length).toBe(1);
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));adopt();
 const ref=screen.getByRole('img',{name:'ref.png'});
 Object.defineProperties(ref,{naturalWidth:{value:1920},naturalHeight:{value:1080}});fireEvent.load(ref);
 // The slider under a number field drives the same value.
 fireEvent.change(screen.getByLabelText('Denoise').parentElement!.querySelector('input.wb-slider')!,{target:{value:'0.3'}});
 expect((screen.getByLabelText('Denoise') as HTMLInputElement).value).toBe('0.3');
 fireEvent.change(screen.getByLabelText('Denoise'),{target:{value:'0.4'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({inputImage:'ref.png',denoise:0.4,checkpoint:'a.safetensors'});
 // ✕ on the preview drops the pick (and the shown job): the stage names the missing input again.
 fireEvent.click(screen.getByRole('button',{name:'Close preview'}));
 expect(screen.queryByRole('img',{name:'ref.png'})).toBeNull();
 expect(screen.queryByRole('button',{name:'Close preview'})).toBeNull();
 expect(screen.getByRole('button',{name:'ref.png'}).getAttribute('aria-current')).toBe('false');
 expect(within(screen.getByRole('region',{name:'Preview'})).getByRole('status').textContent).toBe('Pick an image from the Input or Output folder in the Media dock.');
});

test('IPC fixture: with an edit draft open, a queue pick opens beside the editor; a render opens in a zoomable full view',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'out.png',path:'/env/ComfyUI/output/out.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 let made=0;
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:`job-${++made}`,baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'succeeded',outputRoot:'/env/ComfyUI/output',outputs:[{filename:'DEAS_0001.png',subfolder:'',type:'output'}],error:null,generationReady:false,intent:vi.mocked(runWorkbenchJob).mock.lastCall![1]} as JobStatus));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'Text → Image',selected:true});
 fireEvent.click(await screen.findByRole('button',{name:'out.png'}));adopt();
 const img=screen.getByRole('img',{name:'out.png'});
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await screen.findByRole('img',{name:'DEAS_0001.png'});
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(true); // text pipeline: the render takes the stage
 choosePipe('Image → Image');
 fireEvent.click(screen.getByRole('button',{name:/Succeeded/}));
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(false);
 expect(document.querySelector('.wb-stage')?.classList.contains('wb-split')).toBe(true);
 clickMedia(screen.getByRole('img',{name:'DEAS_0001.png'}) as HTMLImageElement);
 const dialog=screen.getByRole('dialog',{name:'DEAS_0001.png'});
 expect(within(dialog).getByRole('button',{name:'Fit'})).toBeTruthy();
 fireEvent.keyDown(window,{key:'Escape'});
 expect(screen.queryByRole('dialog')).toBeNull();
 // An edit job remembers its source: after ✕ a queue pick brings it back into the editor instead of asking for a pick.
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 fireEvent.click(screen.getByRole('button',{name:'Close preview'}));
 expect(document.querySelector('.wb-editor-host')).toBeNull();
 fireEvent.click(screen.getAllByRole('button',{name:/Succeeded/})[0]); // newest first = the image-to-image job
 const back=await screen.findByRole('img',{name:'out.png'});
 Object.defineProperties(back,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(back);
 await waitFor(()=>expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(false));
 expect(screen.queryByText('Pick an image from the Input or Output folder in the Media dock.')).toBeNull();
 // Slider compare zooms with the wheel at the cursor; double-click resets.
 fireEvent.click(within(document.querySelector<HTMLElement>('.wb-shown')!).getByRole('button',{name:'Slider'}));
 const compare=document.querySelector<HTMLElement>('.wb-compare')!;
 act(()=>{compare.dispatchEvent(new WheelEvent('wheel',{deltaY:-500,clientX:10,clientY:10,cancelable:true}));});
 expect(Number(compare.dataset.zoom)).toBeGreaterThan(1);
 fireEvent.doubleClick(compare);
 expect(compare.dataset.zoom).toBe('1.00');
});

test('IPC fixture: Post-process upscales the shown image alone, then the render; the opt-in tab adds a refine pass to Run',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'out.png',path:'/env/ComfyUI/output/out.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 let n=0;
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:`job-${++n}`,baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'succeeded',outputRoot:'/env/ComfyUI/output',outputs:[{filename:`DEAS_000${n}.png`,subfolder:'',type:'output'}],error:null,generationReady:false,intent:vi.mocked(runWorkbenchJob).mock.lastCall![1]} as JobStatus));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'out.png'}));adopt();
 const img=screen.getByRole('img',{name:'out.png'});
 Object.defineProperties(img,{naturalWidth:{value:1000},naturalHeight:{value:600}});fireEvent.load(img);
 expect(screen.queryByRole('button',{name:'Refine'})).toBeNull();
 expect(screen.queryByRole('button',{name:'Upscale'})).toBeNull();
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 fireEvent.change(screen.getByLabelText('Upscale factor'),{target:{value:'2'}});
 // Post-process lives in the preview toolbar and only in the image edit modes (a video model would get an image job).
 expect(screen.queryByRole('button',{name:'Post-process'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Image to Image'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Post-process'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Post-process'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const first=vi.mocked(runWorkbenchJob).mock.calls[0][1];
 expect(first).toMatchObject({inputImage:'out.png [output]',denoise:0.25,width:1984,height:1216,inputResize:{width:1984,height:1216,crop:'disabled'}}); // 2000×1200 snapped per edge to the SDXL 64 grid
 expect(first.refine).toBeUndefined();expect(first.upscaleModel).toBeUndefined();
 // Default: side by side, the still-mounted editor on the source left, the render right.
 expect(await screen.findByRole('img',{name:'DEAS_0001.png'})).toBeTruthy();
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(false);
 expect(screen.queryByRole('slider',{name:'Original / edited divider'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Slider',pressed:false}));
 expect(screen.getByRole('img',{name:'Original'})).toBeTruthy();
 expect(screen.getByRole('slider',{name:'Original / edited divider'})).toBeTruthy();
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Slider',pressed:true}));
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(false);
 // Instant again on the shown render: transfer its actual file, never infer the backend root.
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/shown.png');
 fireEvent.click(within(document.querySelector<HTMLElement>('.wb-shown')!).getByRole('button',{name:'Post-process'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 expect(vi.mocked(runWorkbenchJob).mock.calls[1][1]).toMatchObject({inputImage:'deas-inputs/shown.png',width:3968,height:2432});
 // Opt-in: every Run gets the refine pass at the upscaled grid size.
 choosePipe('Text → Image');expect(screen.queryByRole('button',{name:'Post-process'})).toBeNull();
 fireEvent.click(screen.getByRole('checkbox',{name:'Refine / Upscale after every run'}));
 expect(screen.getByRole('tab',{name:/Post-Processing/}).textContent).toContain('✓');
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(3));
 const third=vi.mocked(runWorkbenchJob).mock.calls[2][1];
 expect(third.refine).toEqual({width:2048,height:2048,denoise:0.25});
 expect(third.inputImage).toBeUndefined();
 // Tiled refine is offered only when the backend lists the DaSiWa node; tiles = SDXL native 1024², overlap 128 on the 64 grid.
 const tiledBox=screen.getByRole('checkbox',{name:'Tiled refine (DaSiWa Tiled Diffusion)'});
 expect(tiledBox.hasAttribute('disabled')).toBe(true);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'DaSiWaTiledDiffusion']}});
 cleanup();
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'Text → Image',selected:true});
 const box=await screen.findByRole('checkbox',{name:'Tiled refine (DaSiWa Tiled Diffusion)'});
 await waitFor(()=>expect(box.hasAttribute('disabled')).toBe(false));
 fireEvent.click(box);
 expect(screen.getByText('Samples the refine pass in 1024×1024 tiles with 128 px overlap blended every step — the model’s native size, so large outputs stay sharp and seamless.')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(4));
 expect(vi.mocked(runWorkbenchJob).mock.calls[3][1].refine).toEqual({width:2048,height:2048,denoise:0.25,tiled:{tileWidth:1024,tileHeight:1024,overlap:128}});
});

test.each([{cropped:false,paintBase:false,delayed:false,paintLayer:false},{cropped:true,paintBase:false,delayed:false,paintLayer:false},{cropped:false,paintBase:true,delayed:false,paintLayer:false},{cropped:true,paintBase:false,delayed:true,paintLayer:true}])('IPC fixture: Inpaint preserves draft and submits edited base ($cropped, $paintBase)',async({cropped,paintBase,delayed,paintLayer})=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 const entry=(name:string)=>({name,path:`/env/ComfyUI/output/${name}`,kind:'file',symlink:false,media:'image',size:1,modified:1});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[entry('out.png'),entry('cat.png')],truncated:false}));
 vi.stubGlobal('Image',class{naturalWidth=200;naturalHeight=100;onload=()=>{};onerror=()=>{};decode=async()=>{};set src(_:string){setTimeout(()=>this.onload());}});
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'job-in',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:null,generationReady:false});
 const uploadedMask='deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png';
 let releaseMask!:(name:string)=>void;
 vi.mocked(uploadMask).mockResolvedValue(uploadedMask);
 if(delayed)vi.mocked(uploadMask).mockReturnValueOnce(new Promise(yes=>{releaseMask=yes;}));
 const ctx={canvas:{width:1024,height:640},save:vi.fn(),restore:vi.fn(),getImageData:vi.fn(()=>({data:new Uint8ClampedArray([255,255,255,255])})),arc:vi.fn(),fill:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),drawImage:vi.fn()};
 const restore=[vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D),
  vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(cb=>cb({arrayBuffer:async()=>new Uint8Array([137,80,78,71]).buffer} as Blob)), // jsdom Blob has no arrayBuffer
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:512,height:320} as DOMRect)];
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'out.png'}));adopt();
 const img=screen.getByRole('img',{name:'out.png'});
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Inpaint'}).hasAttribute('disabled')).toBe(false));
 expect(screen.queryByRole('checkbox',{name:'Inpaint only masked'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Inpaint'}));
 expect((screen.getByRole('spinbutton',{name:'Mask Blur (px)'}) as HTMLInputElement).value).toBe('4');
 if(cropped){fireEvent.click(screen.getByRole('checkbox',{name:'Inpaint only masked'}));fireEvent.change(screen.getByRole('spinbutton',{name:'Mask Shrink Grow (px)'}),{target:{value:'32'}});fireEvent.change(screen.getByRole('spinbutton',{name:'Mask Blur (px)'}),{target:{value:'8'}});}
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true); // nothing painted yet
 const mask=screen.getByLabelText('Inpaint mask',{selector:'canvas'}) as HTMLCanvasElement;
 const viewport=document.querySelector<HTMLElement>('[data-editor-viewport]')!;
 viewport.setPointerCapture=vi.fn();
 expect([mask.width,mask.height]).toEqual([1024,640]);
 fireEvent(viewport,new MouseEvent('pointerdown',{clientX:256,clientY:160,buttons:1,bubbles:true}));
 fireEvent(viewport,new MouseEvent('pointerup',{clientX:256,clientY:160,bubbles:true}));
 expect(ctx.arc).toHaveBeenCalledWith(512,320,24,0,Math.PI*2);
 fireEvent.click(screen.getByRole('button',{name:'Image to Image'}));
 fireEvent.click(screen.getByRole('button',{name:'Inpaint'}));
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 dropTile('cat.png');
 const layer=await screen.findByRole('group',{name:'Inserted image cat.png [output]'});
 await waitFor(()=>{
  expect(layer.classList.contains('is-selected')).toBe(true);
  expect(screen.getByRole('button',{name:'Select',pressed:true})).toBeTruthy();
 });
 fireEvent.keyDown(layer,{key:'ArrowRight'});
 fireEvent.click(screen.getByRole('button',{name:'out.png'}));adopt();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 expect(screen.getByRole('group',{name:'Inserted image cat.png [output]'})).toBe(layer);
 expect(screen.getByLabelText('Inpaint mask',{selector:'canvas'})).toBe(mask);
 expect(document.querySelector('[data-editor-viewport]')).toBe(viewport);
 if(paintLayer){
  fireEvent.click(screen.getByRole('button',{name:'Brush'}));
  fireEvent(viewport,new MouseEvent('pointerdown',{clientX:256,clientY:160,buttons:1,bubbles:true}));
  fireEvent(viewport,new MouseEvent('pointerup',{clientX:256,clientY:160,bubbles:true}));
 }
 if(paintBase){
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,blob:async()=>new Blob()})));
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({close:vi.fn()})));
  fireEvent.click(screen.getByRole('button',{name:'Base image'}));fireEvent.click(screen.getByRole('button',{name:'Brush'}));
  fireEvent(viewport,new MouseEvent('pointerdown',{clientX:200,clientY:100,buttons:1,bubbles:true}));
  fireEvent(viewport,new MouseEvent('pointerup',{clientX:200,clientY:100,bubbles:true}));
 }
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 if(delayed){
  await waitFor(()=>expect(uploadMask).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'next draft'} });
  fireEvent.change(screen.getByLabelText('Mask Blur (px)'),{target:{value:'12'}});
  fireEvent.keyDown(layer,{key:'ArrowRight'});
  expect(runWorkbenchJob).not.toHaveBeenCalled();
  await act(async()=>releaseMask(uploadedMask));
 }
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(uploadMask).toHaveBeenCalledWith('http://127.0.0.1:7801',new Uint8Array([137,80,78,71]));
 const intent=vi.mocked(runWorkbenchJob).mock.calls[0][1];
 expect(intent).toMatchObject({inputImage:paintBase?'deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png':'out.png [output]',inputMask:'deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png',denoise:0.8,width:1024,height:640});
 expect(intent.inputResize).toBeUndefined();
 if(cropped){expect(intent.maskBlur).toBe(8);expect(intent.inpaintCrop).toEqual({x:0,y:0,width:41,height:41,targetWidth:1024,targetHeight:1024});}
 else{expect(intent.maskBlur).toBe(4);expect(intent.inpaintCrop).toBeUndefined();}
 if(paintBase){expect(intent.inputLayers).toBeUndefined();expect(uploadMask).toHaveBeenCalledTimes(2);}
 else expect(intent.inputLayers).toEqual([{image:paintLayer?uploadedMask:'cat.png [output]',x:420,y:270,width:200,height:100}]); // original size, centred then moved
 // The edit job opens side by side: the same editor stays live on the left, no return needed.
 expect(screen.queryByRole('button',{name:'Return to edit draft'})).toBeNull();
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'out.png'}));adopt();
 expect(document.querySelector('[data-editor-viewport]')).toBe(viewport);
 expect(screen.getByRole('group',{name:'Inserted image cat.png [output]'})).toBe(layer);
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'cat.png'}));adopt();
 const next=screen.getByRole('img',{name:'cat.png'});
 Object.defineProperties(next,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(next);
 expect(screen.queryByRole('group',{name:'Inserted image cat.png [output]'})).toBeNull();
 expect(screen.getByLabelText('Inpaint mask',{selector:'canvas'})).not.toBe(mask);
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 restore.forEach(s=>s.mockRestore());
 vi.unstubAllGlobals();
});

test('IPC fixture: dropping a dock tile pastes the Output image as a movable layer and submits it as inputLayers in source pixels',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 const entry=(name:string)=>({name,path:`/env/ComfyUI/output/${name}`,kind:'file',symlink:false,media:'image',size:1,modified:1});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[entry('src.png'),entry('cat.png')],truncated:false}));
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'job-l',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false});
 // jsdom never loads images: report a 2:1 picture.
 vi.stubGlobal('Image',class{naturalWidth=200;naturalHeight=100;onload=()=>{};onerror=()=>{};set src(_:string){setTimeout(()=>this.onload());}});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'src.png'}));adopt();
 const img=screen.getByRole('img',{name:'src.png'});
 Object.defineProperties(img,{naturalWidth:{value:1000},naturalHeight:{value:600}});fireEvent.load(img);
 await screen.findByRole('button',{name:'Image to Image'});
 fireEvent.click(screen.getByRole('button',{name:'Image to Image'}));
 await waitFor(()=>expect(document.querySelector('[data-editor-viewport]')).not.toBeNull());
 dropTile('cat.png');
 expect(screen.getByRole('button',{name:'Image to Image',pressed:true})).toBeTruthy();
 const layer=await screen.findByRole('group',{name:'Inserted image cat.png [output]'});
 expect(screen.getByRole('img',{name:'src.png'})).toBeTruthy(); // the source stays selected
 fireEvent.keyDown(layer,{key:'ArrowRight'});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({inputImage:'src.png [output]',inputLayers:[{image:'cat.png [output]',x:408,y:250,width:200,height:100}]}); // original size centred (400,250) then ArrowRight +8
 vi.unstubAllGlobals();
});

test('checkpoint dropdown and Models tiles share selection/defaults and missing models are not substituted',async()=>{
 const model=(name:string,family='sdxl',category='checkpoints')=>({category,name,family,path:'/m/'+name,size:1,info:null});
 vi.mocked(scanModels).mockResolvedValue([model('first.safetensors'),model('second.safetensors'),model('unsupported.safetensors','unknown','diffusion_models')]);
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 const select=await screen.findByRole('combobox',{name:'Checkpoint'});
 await waitFor(()=>expect((select as HTMLSelectElement).value).toBe('first.safetensors'));
 expect((within(select).getByRole('option',{name:'unsupported.safetensors'}) as HTMLOptionElement).disabled).toBe(true);
 fireEvent.change(select,{target:{value:'second.safetensors'}});
 dock('Models');expect(screen.getByRole('button',{name:'second.safetensors'}).getAttribute('aria-pressed')).toBe('true');
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('28');
 fireEvent.click(screen.getByRole('button',{name:'first.safetensors'}));expect((select as HTMLSelectElement).value).toBe('first.safetensors');
 expect(localStorage.getItem('deas.pref.studio.run.checkpoint')).toBe('"first.safetensors"');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});
test('companion files are collapsed below the other settings and preserve their choices while closed',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'diffusion_models',name:'anima.safetensors',family:'anima',path:'/m/a',size:1,info:null},{category:'text_encoders',name:'qwen_3_600m.safetensors',path:'/m/e',size:1,info:null},{category:'vae',name:'wan_2.1_vae.safetensors',path:'/m/v',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 const summary=await screen.findByText('Model files',{selector:'summary'}),details=summary.parentElement!;
 expect(details.hasAttribute('open')).toBe(false);expect(details.contains(screen.getByLabelText('Text encoder'))).toBe(true);
 expect(details.previousElementSibling?.classList.contains('wb-controls')).toBe(true);
 fireEvent.click(summary);const encoder=screen.getByRole('combobox',{name:'Text encoder'});
 fireEvent.change(encoder,{target:{value:'qwen_3_600m.safetensors'}});
 fireEvent.click(summary);expect(details.hasAttribute('open')).toBe(false);
 fireEvent.click(summary);expect((screen.getByRole('combobox',{name:'Text encoder'}) as HTMLSelectElement).value).toBe('qwen_3_600m.safetensors');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('Anima recommends renamed header-detected companions and ignores misleading known-incompatible names',async()=>{
 const m=(category:string,name:string,family?:string,component?:string)=>({category,name,family,component,path:'/m/'+name,size:1,info:null});
 const encoder='dasiwaAnima_luminousLabyrinthV1_txt.safetensors',vae='provider-renamed-vae.safetensors';
 vi.mocked(scanModels).mockResolvedValue([m('diffusion_models','anima.safetensors','anima'),m('text_encoders',encoder,undefined,'qwen3-0.6b'),m('vae',vae,undefined,'wan-2.1-vae'),m('text_encoders','qwen_3_600m-impostor.safetensors',undefined,'qwen3-vl-8b')]);
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 await screen.findByRole('combobox',{name:'Text encoder'});
 for(const [label,name] of [['Text encoder',encoder],['VAE',vae]]){
  const select=screen.getByRole('combobox',{name:label}) as HTMLSelectElement;
  expect(select.selectedOptions[0].textContent).toBe('Automatic · '+name);
  expect(screen.getByRole('switch',{name:label+': All files'}).getAttribute('aria-checked')).toBe('false');
 }
 expect(within(screen.getByRole('combobox',{name:'Text encoder'})).queryByRole('option',{name:'qwen_3_600m-impostor.safetensors'})).toBeNull();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('companion overrides are independently selectable without inferred matches, persist and gate Run when switched off',async()=>{
 const m=(category:string,name:string,family?:string)=>({category,name,family,path:'/m/'+category+'/'+name,size:1,info:null});
 const renamed='dasiwaAnima_luminousLabyrinthV1_txt.safetensors';
 vi.mocked(scanModels).mockResolvedValue([m('diffusion_models','anima.safetensors','anima'),m('text_encoders',renamed),m('vae','custom-vae.safetensors'),m('checkpoints','not-an-encoder.safetensors')]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'component-job',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:null,generationReady:false});
 const mount=()=>render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 const view=mount();await screen.findByRole('combobox',{name:'Text encoder'});
 const encoder=screen.getByRole('combobox',{name:'Text encoder'}),vae=screen.getByRole('combobox',{name:'VAE'});
 const encoderSwitch=screen.getByRole('switch',{name:'Text encoder: All files'}),vaeSwitch=screen.getByRole('switch',{name:'VAE: All files'});
 expect(encoderSwitch.getAttribute('aria-checked')).toBe('false');
 expect(within(encoder).queryByRole('option',{name:renamed})).toBeNull();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(encoderSwitch);expect(vaeSwitch.getAttribute('aria-checked')).toBe('false');
 expect(within(encoder).queryByRole('option',{name:'not-an-encoder.safetensors'})).toBeNull();
 expect((encoder as HTMLSelectElement).value).toBe(''); // widening the list never auto-picks an arbitrary file
 fireEvent.change(encoder,{target:{value:renamed}});
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(vaeSwitch);fireEvent.change(vae,{target:{value:'custom-vae.safetensors'}});
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({checkpoint:'anima.safetensors',diffusion:{textEncoder:renamed,clipType:'stable_diffusion',vae:'custom-vae.safetensors'}});
 fireEvent.click(encoderSwitch);
 expect((encoder as HTMLSelectElement).value).toBe(renamed); // never silently replace the manual choice
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain(renamed);
 view.unmount();mount();await screen.findByRole('combobox',{name:'Text encoder'});
 expect((screen.getByRole('combobox',{name:'Text encoder'}) as HTMLSelectElement).value).toBe(renamed);
 expect(screen.getByRole('switch',{name:'Text encoder: All files'}).getAttribute('aria-checked')).toBe('false');
 expect(screen.getByRole('switch',{name:'VAE: All files'}).getAttribute('aria-checked')).toBe('true');
});

test('audio VAE and text-projection overrides submit exact manual choices and never silently fall back after filtering or removal',async()=>{
 const m=(category:string,name:string,family?:string)=>({category,name,family,path:'/m/'+name,size:1,info:null});
 let files=[m('diffusion_models','ltx.safetensors','ltx-2'),m('text_encoders','gemma.safetensors'),m('text_encoders','text_projection.safetensors'),m('text_encoders','custom-projection.safetensors'),m('vae','video_vae.safetensors'),m('vae','audio_vae.safetensors'),m('vae','custom-audio.safetensors')];
 vi.mocked(scanModels).mockImplementation(async()=>files);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'video-components-job',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:null,generationReady:false});
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 await screen.findByRole('combobox',{name:'Audio VAE'});
 for(const [label,file] of [['Audio VAE','custom-audio.safetensors'],['Text projection','custom-projection.safetensors']]){
  fireEvent.click(screen.getByRole('switch',{name:label+': All files'}));
  fireEvent.change(screen.getByRole('combobox',{name:label}),{target:{value:file}});
 }
 expect(screen.getByRole('switch',{name:'Text encoder: All files'}).getAttribute('aria-checked')).toBe('false');
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({family:'ltx-2',ltx:{audioVae:'custom-audio.safetensors',textProjection:'custom-projection.safetensors'}});
 fireEvent.click(screen.getByRole('switch',{name:'Audio VAE: All files'}));
 expect((screen.getByRole('combobox',{name:'Audio VAE'}) as HTMLSelectElement).value).toBe('custom-audio.safetensors');
 expect(screen.getByRole('alert').textContent).toContain('custom-audio.safetensors');
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByRole('switch',{name:'Audio VAE: All files'}));
 files=files.filter(file=>file.name!=='custom-audio.safetensors');dock('Models');fireEvent.click(document.querySelector('[data-run-load]')!);
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('custom-audio.safetensors'));
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 expect((screen.getByRole('combobox',{name:'Audio VAE'}) as HTMLSelectElement).value).toBe('custom-audio.safetensors');
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
});

test('IPC fixture: families gate models and LoRAs, picking applies the family defaults and a diffusion model submits its encoder and VAE',async()=>{
 const m=(category:string,name:string,family?:string)=>({category,name,path:`/m/${category}/${name}`,size:1,info:null,...(family?{family}:{})});
 vi.mocked(scanModels).mockResolvedValue([m('checkpoints','ill.safetensors','sdxl'),m('diffusion_models','k2.safetensors','krea-2'),m('diffusion_models','h3.safetensors','minimax-h3'),m('unet','odd.safetensors'),
  m('text_encoders','qwen3vl_4b.safetensors'),m('vae','Q/qwen_image_vae.safetensors'),m('loras','k-style.safetensors','krea-2'),m('loras','ill-style.safetensors','sdxl'),m('loras','mystery.safetensors')]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,samplers:['euler','er_sde','res_multistep'],schedulers:['normal','simple','beta']}});
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'job-3',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:'x',generationReady:false});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');
 expect((await screen.findByRole('button',{name:/h3\.safetensors/})).hasAttribute('disabled')).toBe(true); // video family: no image recipe
 expect(screen.getByRole('button',{name:/odd\.safetensors/}).hasAttribute('disabled')).toBe(true); // unknown diffusion model
 fireEvent.click(screen.getByRole('button',{name:/k2\.safetensors/}));
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('8');
 expect((screen.getByLabelText('CFG') as HTMLInputElement).value).toBe('1');
 expect((screen.getByLabelText('Text encoder') as HTMLSelectElement).selectedOptions[0].textContent).toBe('Automatic · qwen3vl_4b.safetensors');
 dock('LoRAs');
 expect(screen.queryByRole('button',{name:/ill-style/})).toBeNull(); // other family hidden, unknown kept
 fireEvent.click(screen.getByRole('button',{name:/k-style/}));expect(screen.getByRole('button',{name:/mystery/})).toBeTruthy();
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1); // the backend list is read once when the endpoint is known, so the first click already shows it
 await waitFor(()=>expect(Array.from((screen.getByLabelText('Sampler') as HTMLSelectElement).options,o=>o.value)).toEqual(['euler','er_sde','res_multistep']));
 fireEvent.focus(screen.getByLabelText('Sampler'));expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1);
 fireEvent.change(screen.getByLabelText('Sampler'),{target:{value:'res_multistep'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({checkpoint:'k2.safetensors',sampler:'res_multistep',scheduler:'simple',loras:[{name:'k-style.safetensors',strength:1}],diffusion:{textEncoder:'qwen3vl_4b.safetensors',clipType:'krea2',vae:'Q/qwen_image_vae.safetensors'}});
});

test('IPC fixture: a Turbo family locks steps and scheduler to its saved schedule, submits the sigmas and keeps the base family LoRAs',async()=>{
 const m=(category:string,name:string,family?:string)=>({category,name,path:`/m/${category}/${name}`,size:1,info:null,...(family?{family}:{})});
 vi.mocked(scanModels).mockResolvedValue([m('diffusion_models','turbo.safetensors','qwen-image-2.1-turbo'),m('text_encoders','qwen3vl_8b.safetensors'),m('vae','qwen_image_2.1_vae.safetensors'),m('loras','q-style.safetensors','qwen-image-2.1')]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'job-4',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:'x',generationReady:false});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');fireEvent.click(await screen.findByRole('button',{name:/turbo\.safetensors/}));
 const steps=screen.getByLabelText('Steps') as HTMLInputElement;expect(steps.value).toBe('8');expect(steps.disabled).toBe(true);
 const scheduler=screen.getByLabelText('Scheduler') as HTMLSelectElement;expect(scheduler.disabled).toBe(true);expect(scheduler.options[scheduler.selectedIndex].text).toBe('CUSTOM');
 expect((screen.getByLabelText('Sampler') as HTMLSelectElement).disabled).toBe(false);
 dock('LoRAs');expect(screen.getByRole('button',{name:/q-style/})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({checkpoint:'turbo.safetensors',steps:8,cfg:1,sampler:'euler',sigmas:[1.0,0.978453,0.95418,0.926626,0.89508,0.845148,0.704534,0.414568,0]});
 // A typed schedule in Options overrides the model's own; steps follow it.
 dock('Options');fireEvent.change(screen.getByRole('textbox',{name:'Custom sigmas'}),{target:{value:'1, 0.6, 0.3, 0'}});
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('3');
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 expect(vi.mocked(runWorkbenchJob).mock.calls[1][1]).toMatchObject({steps:3,sigmas:[1,0.6,0.3,0]});
});

test('automatic aspect is confined to media pipelines and text pipelines ignore image and video previews',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[
  {name:'wide.png',path:'/env/input/wide.png',kind:'file',symlink:false,media:'image',size:1,modified:1},
  {name:'portrait.mp4',path:'/env/input/portrait.mp4',kind:'file',symlink:false,media:'video',size:1,modified:2},
 ],truncated:false}));
 const {container}=render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/input'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'Text → Image',selected:true});
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 const aspectPicker=screen.getByLabelText('Aspect ratio') as HTMLSelectElement;
 expect(Array.from(aspectPicker.options,o=>o.value)).not.toContain('auto');
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'model'}});
 fireEvent.click(await screen.findByRole('button',{name:'wide.png'}));adopt();
 const image=screen.getByRole('img',{name:'wide.png'});
 Object.defineProperties(image,{naturalWidth:{value:1920},naturalHeight:{value:1080}});fireEvent.load(image);
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1024');
 choosePipe('Image → Image');
 expect(Array.from(aspectPicker.options,o=>o.value)).toContain('auto');
 expect(aspectPicker.value).toBe('auto');
 fireEvent.change(screen.getByLabelText('Input scaling'),{target:{value:'target'}});
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1344');
 choosePipe('Text → Image');
 expect(Array.from(aspectPicker.options,o=>o.value)).not.toContain('auto');
 expect(aspectPicker.value).toBe('1:1');
 // Native: the stage video plays a blob of the asset bytes (WebKitGTK rejects asset:// media), fetched once per selection.
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,blob:async()=>new Blob(['x'],{type:'video/mp4'})})));
 Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>'blob:deas/1')});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
 fireEvent.click(screen.getByRole('button',{name:'portrait.mp4'}));adopt();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 const video=container.querySelector('.wb-stage video')!;
 expect(fetch).toHaveBeenCalledWith('asset://localhost//env/input/portrait.mp4');
 await waitFor(()=>expect(video.getAttribute('src')).toBe('blob:deas/1'));
 Object.defineProperties(video,{videoWidth:{value:1080},videoHeight:{value:1920}});fireEvent.loadedMetadata(video);
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1024');
 expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('1024');
 expect(container.querySelector('.wb-resolution-summary')).toBeNull();
 expect(container.querySelector('.wb-aspect-picker .wb-aspect-swatch')).not.toBeNull();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 expect(pipe('Image → Video').disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('Width'),{target:{value:'640'}});
 fireEvent.change(screen.getByLabelText('Height'),{target:{value:'480'}});
 fireEvent.click(screen.getByRole('button',{name:'wide.png'}));adopt();
 const nextImage=screen.getByRole('img',{name:'wide.png'});
 Object.defineProperties(nextImage,{naturalWidth:{value:1920},naturalHeight:{value:1080}});fireEvent.load(nextImage);
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('640');
 expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('480');
 expect((screen.getByLabelText('Resolution') as HTMLSelectElement).value).toBe('fixed');
});

test('Inpaint rejects a source outside the model grid instead of silently rounding its pixels',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'odd.png',path:'/env/out/odd.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/env/out'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'odd.png'}));adopt();
 const img=screen.getByRole('img',{name:'odd.png'});
 Object.defineProperties(img,{naturalWidth:{value:1000},naturalHeight:{value:600}});fireEvent.load(img);
 fireEvent.click(screen.getByRole('button',{name:'Inpaint'}));
 expect(screen.getByText('Resample this image to the selected model’s resolution grid before inpainting.')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 expect(uploadMask).not.toHaveBeenCalled();
});

test.each(['late','error'])('Dropped tile %s loading cannot create a guessed or stale image layer',async(mode)=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',size:1,info:null,family:'sdxl'}]);
 const entry=(name:string)=>({name,path:`/env/out/${name}`,kind:'file',symlink:false,media:'image',size:1,modified:1});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[entry('base.png'),entry('cat.png'),entry('other.png')],truncated:false}));
 let loaded=()=>{},failed=()=>{};
 vi.stubGlobal('Image',class{naturalWidth=200;naturalHeight=100;onload=()=>{};onerror=()=>{};set src(_:string){loaded=()=>this.onload();failed=()=>this.onerror();}});
 try{
  render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/env/out'}}/></I18nProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'base.png'}));adopt();
  const img=screen.getByRole('img',{name:'base.png'});
  Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);
  await waitFor(()=>expect(document.querySelector('[data-editor-viewport]')).not.toBeNull());
  dropTile('cat.png');
  if(mode==='late'){
   fireEvent.click(screen.getByRole('button',{name:'other.png'}));adopt();
   const other=screen.getByRole('img',{name:'other.png'});
   Object.defineProperties(other,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(other);
   await act(async()=>loaded());
  }
  else{await act(async()=>failed());expect(screen.getByRole('alert').textContent).toBe('This image could not be loaded for insertion.');}
  expect(screen.queryByRole('group',{name:'Inserted image cat.png [output]'})).toBeNull();
 }finally{vi.unstubAllGlobals();}
});

test('native resolution is one model-driven choice and migrates the removed 768px preference',async()=>{
 localStorage.setItem('deas.pref.studio.run.resolution',JSON.stringify('auto'));
 localStorage.setItem('deas.pref.studio.run.width','768');
 localStorage.setItem('deas.pref.studio.run.height','768');
 const m=(category:string,name:string,family?:string)=>({category,name,path:`/m/${category}/${name}`,size:1,info:null,...(family?{family}:{})});
 vi.mocked(scanModels).mockResolvedValue([m('checkpoints','base.safetensors','sdxl'),m('diffusion_models','qwen.safetensors','qwen-image-2.1'),m('text_encoders','qwen3vl_8b.safetensors'),m('vae','qwen_image_2.1_vae.safetensors')]);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');
 await screen.findByRole('button',{name:/base.safetensors/});
 const picker=screen.getByLabelText('Resolution') as HTMLSelectElement;
 expect(Array.from(picker.options,o=>o.value)).not.toContain('auto');
 expect(Array.from(picker.options).filter(o=>o.textContent==='Native')).toHaveLength(1);
 expect(picker.value).toBe('model');
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1024');
 fireEvent.click(screen.getByRole('button',{name:/qwen.safetensors/}));
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('2048');
 expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('2048');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.resolution')!)).toBe('model');
});

test('resolution picker follows reference metadata, forwards padded pixels to the model and remembers settings',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'wide.png',path:'/env/input/wide.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'resolution-job',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:'fixture',generationReady:false});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/input'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'Text → Image',selected:true});
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'wide.png'}));adopt();
 choosePipe('Image → Image');
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'model'}});
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 const ref=screen.getByRole('img',{name:'wide.png'});
 Object.defineProperties(ref,{naturalWidth:{value:1920},naturalHeight:{value:1080}});fireEvent.load(ref);
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1344');
 expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('768');
 fireEvent.change(screen.getByLabelText('Aspect ratio'),{target:{value:'1:1'}});
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'1024p'}});
 fireEvent.change(screen.getByLabelText('Input scaling'),{target:{value:'pad'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({width:1024,height:1024,inputImage:'wide.png',inputResize:{width:1024,height:576,crop:'disabled',pad:{left:0,right:0,top:224,bottom:224}}});
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.inputScaling')!)).toBe('pad');
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'fixed'}});
 fireEvent.change(screen.getByLabelText('Width'),{target:{value:'8192'}});
 fireEvent.change(screen.getByLabelText('Height'),{target:{value:'8192'}});
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
});

test('IPC fixture: video families enable Image→Video; LTX submits a video intent with frames on the 8k+1 grid and a video output plays in the stage',async()=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'unet',name:'LTX2/ltx.safetensors',path:'/m/unet/LTX2/ltx.safetensors',size:1,info:null,family:'ltx-2'},
  {category:'text_encoders',name:'gemma_3_12B_it_fp8.safetensors',path:'/m/text_encoders/gemma.safetensors',size:1,info:null},
  {category:'text_encoders',name:'ltx-2.3_text_projection_bf16.safetensors',path:'/m/text_encoders/proj.safetensors',size:1,info:null},
  {category:'vae',name:'LTX2/LTX23_video_vae_bf16.safetensors',path:'/m/vae/v.safetensors',size:1,info:null},
  {category:'vae',name:'LTX2/LTX23_audio_vae_bf16.safetensors',path:'/m/vae/a.safetensors',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'ref.png',path:'/env/ComfyUI/input/ref.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:'job-v',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'succeeded',outputs:[{filename:'x_00001.webm',subfolder:'video',type:'output',format:'video/webm'}],error:null,generationReady:false,intent:vi.mocked(runWorkbenchJob).mock.lastCall![1]} as JobStatus));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Text → Video').disabled).toBe(false));
 expect(pipe('Image → Video').disabled).toBe(false);
 expect(pipe('Video → Video').disabled).toBe(false);
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));adopt();
 choosePipe('Image → Video');
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('8');
 const ref=screen.getByRole('img',{name:'ref.png'});
 Object.defineProperties(ref,{naturalWidth:{value:1280},naturalHeight:{value:704}});fireEvent.load(ref);
 fireEvent.change(screen.getByLabelText('Seconds'),{target:{value:'2'}});
 expect(screen.getByText('49 frames · 2.00 s')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({recipeId:'video-generation',family:'ltx-2',model:'LTX2/ltx.safetensors',textEncoder:'gemma_3_12B_it_fp8.safetensors',vae:'LTX2/LTX23_video_vae_bf16.safetensors',frames:49,frameRate:24,firstFrame:'ref.png',output:{codec:'Auto',container:'Auto',quality:20},ltx:{textProjection:'ltx-2.3_text_projection_bf16.safetensors',audioVae:'LTX2/LTX23_audio_vae_bf16.safetensors',passes:1}});
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).not.toHaveProperty('imageFormat');
 await waitFor(()=>expect(document.querySelector('.wb-stage video')?.getAttribute('src')).toBe('http://127.0.0.1:7801/view?filename=x_00001.webm&subfolder=video&type=output'));
 expect(screen.queryByRole('tab',{name:'Continuity'})).toBeNull();
});

test('H3 continuity opens outside the dock, preserves edits and restores focus when closed',async()=>{
 localStorage.setItem('deas.pref.studio.dock.tab',JSON.stringify('continuity'));
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({session:'kept-session',outputMode:'segment',steps:[{id:'one',seconds:5,action:''},{id:'two',seconds:6,action:'turn'}]}));
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/h3.safetensors',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Text → Video').disabled).toBe(false));choosePipe('Text → Video');
 expect(screen.queryByRole('tab',{name:'Continuity'})).toBeNull();
 expect(screen.getByRole('tab',{name:'Media'}).getAttribute('aria-selected')).toBe('true');
 const open=screen.getByRole('button',{name:'Continuity'});open.focus();fireEvent.click(open);
 const dialog=screen.getByRole('dialog',{name:'Continuity'});
 expect(within(dialog).getByText('kept-session')).toBeTruthy();
 fireEvent.change(within(dialog).getByLabelText('Next action'),{target:{value:'a new action'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 expect(screen.queryByRole('dialog',{name:'Continuity'})).toBeNull();expect(document.activeElement).toBe(open);
 fireEvent.click(open);
 expect((within(screen.getByRole('dialog',{name:'Continuity'})).getByLabelText('Next action') as HTMLTextAreaElement).value).toBe('a new action');
 fireEvent(screen.getByRole('dialog',{name:'Continuity'}),new Event('cancel',{cancelable:true}));
 expect(screen.queryByRole('dialog',{name:'Continuity'})).toBeNull();expect(document.activeElement).toBe(open);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('H3 frame people are opt-in, reach the Forge and reset on a new source picture',async()=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/h3.safetensors',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}]);
 const calls:{route:string;body:Record<string,unknown>}[]=[];
 vi.mocked(invoke).mockImplementation(async(c,a)=>{
  if(c==='native_llm_read')return {provider:'ollama',baseUrl:'http://127.0.0.1:11434'};
  if(c==='native_forge'){const x=a as {route:string;body:Record<string,unknown>};calls.push(x);return x.route==='models'?{models:[{id:'m',label:'M'}],errors:{},creativity:['balanced'],shot_counts:['Auto'],default_shots:'Auto'}:{simple_prompt:'a scene',warnings:[]};}
  return {path:(a as {path:string})?.path,parent:'/env',entries:['first.png','other.png'].map(name=>({name,path:`/env/ComfyUI/input/${name}`,kind:'file',symlink:false,media:'image',size:1,modified:1})),truncated:false};
 });
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" root="/env" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'first.png'}));adopt();
 await waitFor(()=>expect(pipe('Image → Video').disabled).toBe(false));choosePipe('Image → Video');
 fireEvent.click(screen.getByText('People & order'));
 const people=screen.getByRole('button',{name:'Character 2 in first.png'});
 expect(people.getAttribute('aria-pressed')).toBe('false');
 fireEvent.click(people);
 fireEvent.change(screen.getByRole('combobox',{name:'Character order in first.png'}),{target:{value:'y'}});
 expect(people.getAttribute('aria-pressed')).toBe('true');
 fireEvent.click(people);expect(people.getAttribute('aria-pressed')).toBe('false');
 fireEvent.click(people);
 fireEvent.click(screen.getByRole('button',{name:'Prompt Forge'}));fireEvent.click(screen.getByRole('button',{name:'LLM · Prompt Forge'}));
 await screen.findByRole('option',{name:'M'});
 fireEvent.change(screen.getByRole('textbox',{name:'Card of Character 2'}),{target:{value:'adult traveller, blue coat'}});
 fireEvent.change(screen.getByRole('textbox',{name:'Idea or prompt to enhance'}),{target:{value:'a walk'}});
 fireEvent.click(screen.getByRole('button',{name:'Write'}));
 await screen.findByRole('textbox',{name:'Result'});
 expect(calls.find(c=>c.route==='h3')!.body).toMatchObject({mode:'I2VA',easy:false,references:[{path:'first.png',who:[2],who_axis:'y'}],cast:{2:'adult traveller, blue coat'}});
 fireEvent.click(screen.getByRole('button',{name:'Apply'}));
 fireEvent.click(screen.getByRole('button',{name:'other.png'}));adopt();
 fireEvent.click(screen.getByText('People & order'));
 expect(screen.getByRole('button',{name:'Character 2 in other.png'}).getAttribute('aria-pressed')).toBe('false');
});

test.each(['new','checkpoint','video'])('IPC fixture: MiniMax H3 uploads dock references and pins continuity clips (source=%s)',async(sourceMode)=>{
 const selected=sourceMode!=='new';const video=sourceMode==='video';const videoId='a'.repeat(64);
 vi.mocked(prepareH3Video).mockResolvedValue({sourceId:videoId,filename:'clips/source.mp4',sha256:'b'.repeat(64),width:1920,height:1080,fps:24,seconds:8,hasAudio:true});
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/diffusion_models/MiniMaxH3/h3.safetensors',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'ref.png',path:'/env/ComfyUI/input/ref.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/u1.png');
 let n=0;
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:`h3-${++n}`,baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false}));
 let peerObserved=false;
 vi.mocked(pollWorkbench).mockImplementation(async()=>{
  const submitted=await Promise.all(vi.mocked(runWorkbenchJob).mock.results.map(async result=>await result.value));
  if(submitted.at(-1)?.id==='h3-2'&&!peerObserved){peerObserved=true;return collection([heldJob('unrelated-success','succeeded'),heldJob('unrelated-failure','failed'),...submitted]);}
  return collection([heldJob('unrelated-success','succeeded'),heldJob('unrelated-failure','failed'),...submitted.map(job=>({...job,state:'succeeded' as const}))]);
 });
 vi.mocked(readH3Session).mockImplementation(async()=>({latestId:null,clips:[{clipId:'chosen',parent:null,frames:124,completed:0,export:null},{clipId:'backend-import',parent:null,frames:192,completed:0,export:null,importedVideo:{sourceId:videoId,width:1024,height:768,modeFamily:'fl2va'}},{clipId:'root1',parent:video?'backend-import':selected?'chosen':null,frames:124,completed:1,export:null},{clipId:'kid1',parent:'root1',frames:200,completed:2,export:null}]}));
 const view=render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));adopt();
 await waitFor(()=>expect(pipe('Image → Video').disabled).toBe(false));choosePipe('Image → Video');
 const ref=screen.getByRole('img',{name:'ref.png'});
 Object.defineProperties(ref,{naturalWidth:{value:1024},naturalHeight:{value:768}});fireEvent.load(ref);
 expect((screen.getByLabelText('FPS') as HTMLInputElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(uploadInput).toHaveBeenCalledWith('http://127.0.0.1:7801','/env/ComfyUI/input/ref.png');
 const first=vi.mocked(runWorkbenchJob).mock.calls[0][1] as unknown as {frames:number;h3:object;firstFrame?:string};
 expect(first).toMatchObject({family:'minimax-h3',frames:124,frameRate:24,h3:{mode:'I2VA',references:[{slot:0,image:'deas-inputs/u1.png'}]}});
 expect(first.firstFrame).toBeUndefined();
 expect((first.h3 as {continuity?:object}).continuity).toBeUndefined();
 expect(readH3Session).not.toHaveBeenCalled();
 await waitFor(()=>expect(screen.getAllByText('Succeeded').length).toBeGreaterThan(0),{timeout:4000});
 fireEvent.click(screen.getByRole('button',{name:'Continuity'}));
 fireEvent.change(screen.getByRole('textbox',{name:'Session name'}),{target:{value:'Named_session-1'}});
 fireEvent.click(screen.getByRole('button',{name:'Use session'}));
 if(video){
  fireEvent.change(screen.getByRole('textbox',{name:'Video in ComfyUI input'}),{target:{value:'clips/source.mp4'}});
  fireEvent.click(screen.getByRole('button',{name:'Prepare video'}));
  fireEvent.click(await screen.findByRole('button',{name:'Use video'}));
  expect(prepareH3Video).toHaveBeenCalledWith('http://127.0.0.1:7801','clips/source.mp4');
  expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
 }else if(selected){
  fireEvent.click(screen.getByRole('button',{name:'Load checkpoints'}));
  await screen.findByRole('option',{name:'chosen'});
  fireEvent.change(screen.getByRole('combobox',{name:'Source checkpoint'}),{target:{value:'chosen'}});
  expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
 }
 fireEvent.click(screen.getByRole('button',{name:'Add step'}));fireEvent.click(screen.getByRole('button',{name:'Add step'}));
 fireEvent.change(screen.getAllByLabelText('Next action')[0],{target:{value:'she turns around'}});
 fireEvent.change(screen.getByRole('combobox',{name:'Overlap (frames)'}),{target:{value:'56'}});
 fireEvent.click(screen.getByRole('button',{name:'Run all'}));
 expect((screen.getByRole('combobox',{name:'Overlap (frames)'}) as HTMLSelectElement).disabled).toBe(true);
 fireEvent.click(within(screen.getByRole('dialog',{name:'Continuity'})).getByRole('button',{name:'Close'}));
 expect(screen.queryByRole('dialog',{name:'Continuity'})).toBeNull();
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(3),{timeout:5000});
 fireEvent.click(screen.getByRole('button',{name:'Continuity'}));
 const steps=vi.mocked(runWorkbenchJob).mock.calls.slice(1).map(c=>(c[1] as unknown as {h3:{continuity:{sourceId:string;action:string;capture:boolean}}}).h3.continuity);
 expect(steps[0]).toMatchObject({sourceId:video?videoId:selected?'chosen':'',capture:true,action:selected?'she turns around':''});
 expect(Object.hasOwn(steps[0],'overlapFrames')).toBe(selected);
 expect(Object.hasOwn(steps[0],'sourceKind')).toBe(video);
 expect(Object.hasOwn(steps[1],'sourceKind')).toBe(false);
 expect(steps[1]).toMatchObject({sourceId:'root1',capture:true,action:selected?'':'she turns around',overlapFrames:56});
 expect((screen.getByRole('combobox',{name:'Overlap (frames)'}) as HTMLSelectElement).value).toBe('56');
 await waitFor(()=>expect(screen.getByText('kid1')).toBeTruthy(),{timeout:5000});
 expect(readH3Session).toHaveBeenCalledWith('http://127.0.0.1:7801/','Named_session-1');
 expect(peerObserved).toBe(true);
 const pinned=JSON.parse(localStorage.getItem('deas.pref.studio.run.continuity')!);
 expect(pinned.steps.filter((s:{jobId?:string})=>s.jobId).map((s:{jobId:string})=>s.jobId)).toEqual(['h3-2','h3-3']);
 expect((screen.getByRole('textbox',{name:'Session name'}) as HTMLInputElement).value).toBe('Named_session-1');
 if(selected){
  fireEvent.click(screen.getByRole('button',{name:'Add step'}));
  expect((screen.getByRole('button',{name:'Run next'}) as HTMLButtonElement).disabled).toBe(false);
  view.rerender(<I18nProvider><Workbench endpoint="http://127.0.0.1:7802" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
  expect((screen.getByRole('button',{name:'Run next'}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('Backend changed');
  expect(runWorkbenchJob).toHaveBeenCalledTimes(3);
 }
},10000);

test('pending video upload is dropped on unmount before native admission',async()=>{
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 let release!:(name:string)=>void;
 vi.mocked(uploadInput).mockReturnValueOnce(new Promise(yes=>{release=yes;}));
 vi.mocked(runWorkbenchJob).mockImplementation(async(baseUrl,intent)=>{
  const job={...heldJob('late-upload-job','queued',baseUrl),intent};
  vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
  vi.mocked(pollWorkbench).mockResolvedValue(collection([job]));
  return job;
 });
 const props={endpoint:'http://127.0.0.1:7801',roots:{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Video → Video').disabled).toBe(false));choosePipe('Video → Video');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'clip.mp4'}));adopt();loadVideo('clip.mp4');
 await waitFor(()=>expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(1));
 view.unmount();localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(readCurrentWorkbench).toHaveBeenCalledTimes(2));
 await waitFor(()=>expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(false));
 await act(async()=>release('deas-inputs/late.mp4'));
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 expect(document.querySelectorAll('[data-job-id]')).toHaveLength(0);
});

test('delayed video upload submits the captured endpoint, settings, naming and source, never a rebuilt draft',async()=>{
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 let release!:(name:string)=>void;
 vi.mocked(uploadInput).mockReturnValueOnce(new Promise(yes=>{release=yes;}));
 vi.mocked(runWorkbenchJob).mockImplementation(async(baseUrl,intent)=>({...heldJob('captured','failed',baseUrl),intent}));
 localStorage.setItem('deas.pref.studio.run.seed','42');localStorage.setItem('deas.pref.studio.run.seedMode','"fixed"');
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({...defaultOptions,outputNaming:'saved/%seed%'}));
 const props={endpoint:'http://127.0.0.1:7801',roots:{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Video → Video').disabled).toBe(false));choosePipe('Video → Video');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'clip.mp4'}));adopt();loadVideo('clip.mp4');
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'/env/ComfyUI/input/clip.mp4'}});
 fireEvent.change(screen.getByLabelText('Source strength'),{target:{value:'0.7'}});
 await waitFor(()=>expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(1));
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'new prompt'}});
 fireEvent.change(screen.getByLabelText('Source strength'),{target:{value:'0.2'}});
 fireEvent.change(screen.getByLabelText('Steps'),{target:{value:'35'}});
 view.rerender(<I18nProvider><Workbench {...props} endpoint="http://changed:9999/"/></I18nProvider>);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 await act(async()=>release('deas-inputs/captured.mp4'));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0]).toEqual(['http://127.0.0.1:7801',expect.objectContaining({positivePrompt:'/env/ComfyUI/input/clip.mp4',seed:42,steps:8,outputPrefix:'raw/saved/42',sourceVideo:'deas-inputs/captured.mp4',ltx:expect.objectContaining({sourceStrength:0.7})}),0]);
});
const ltxModels=[
 {category:'unet',name:'LTX2/ltx.safetensors',path:'/m/unet/LTX2/ltx.safetensors',size:1,info:null,family:'ltx-2'},
 {category:'text_encoders',name:'gemma_3_12B_it_fp8.safetensors',path:'/m/text_encoders/gemma.safetensors',size:1,info:null},
 {category:'text_encoders',name:'ltx-2.3_text_projection_bf16.safetensors',path:'/m/text_encoders/proj.safetensors',size:1,info:null},
 {category:'vae',name:'LTX2/LTX23_video_vae_bf16.safetensors',path:'/m/vae/v.safetensors',size:1,info:null},
 {category:'vae',name:'LTX2/LTX23_audio_vae_bf16.safetensors',path:'/m/vae/a.safetensors',size:1,info:null}] as const;
const mediaEntries=[
 {name:'ref.png',path:'/env/ComfyUI/input/ref.png',kind:'file',symlink:false,media:'image',size:1,modified:1},
 {name:'clip.mp4',path:'/env/ComfyUI/input/clip.mp4',kind:'file',symlink:false,media:'video',size:1,modified:2},
 {name:'voice.wav',path:'/env/ComfyUI/input/voice.wav',kind:'file',symlink:false,media:'audio',size:1,modified:3},
 {name:'a2.wav',path:'/env/ComfyUI/input/a2.wav',kind:'file',symlink:false,media:'audio',size:1,modified:4},
 {name:'a3.wav',path:'/env/ComfyUI/input/a3.wav',kind:'file',symlink:false,media:'audio',size:1,modified:5}];
/** Right-click a Media dock tile and return its menu. */
const menuOf=(name:string)=>{fireEvent.contextMenu(screen.getByRole('button',{name}),{clientX:5,clientY:5});return within(screen.getByRole('menu',{name}));};
const markOf=(name:string)=>screen.getByRole('button',{name}).closest('li')!.dataset.mark;
const loadVideo=(name:string)=>{const v=document.querySelector<HTMLVideoElement>(`.wb-stage video`)!;Object.defineProperties(v,{videoWidth:{value:1280},videoHeight:{value:704}});fireEvent.loadedMetadata(v);void name;};

test('IPC fixture: LTX Video → Video uploads the source video; Multi-reference → Video sends image keyframes at their seconds',async()=>{
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 vi.mocked(uploadInput).mockImplementation(async(_b,path)=>path.endsWith('.mp4')?'deas-input-u.mp4':'deas-inputs/u.png');
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:'job-v',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false} as JobStatus));
 vi.mocked(pollWorkbench).mockImplementation(async()=>collection(await Promise.all(vi.mocked(runWorkbenchJob).mock.results.map(async result=>({...await result.value,state:'succeeded' as const})))));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Video → Video').disabled).toBe(false));
 expect(pipe('Multi-reference → Video').disabled).toBe(false);
 choosePipe('Video → Video');
 expect(within(screen.getByRole('region',{name:'Preview'})).getByRole('status').textContent).toBe('Pick a video from the Media dock as the source.');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 await screen.findByRole('button',{name:'clip.mp4'});
 expect(menuOf('ref.png').queryByRole('menuitem',{name:'Use as source video'})).toBeNull();fireEvent.keyDown(window,{key:'Escape'});
 fireEvent.click(menuOf('clip.mp4').getByRole('menuitem',{name:'Use as source video'}));
 loadVideo('clip.mp4');
 expect(markOf('clip.mp4')).toBe('Source video');
 expect(document.querySelector('.wb-stage-mark')?.textContent).toBe('Source video');
 fireEvent.change(screen.getByLabelText('Source strength'),{target:{value:'0.7'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(uploadInput).toHaveBeenCalledWith('http://127.0.0.1:7801','/env/ComfyUI/input/clip.mp4');
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({family:'ltx-2',sourceVideo:'deas-input-u.mp4',width:1280,height:704,ltx:{sourceStrength:0.7}});
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).not.toHaveProperty('firstFrame');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false),{timeout:5000});
 // Multi-reference: images only for LTX (no reference button on a video), placed at a second with a strength.
 choosePipe('Multi-reference → Video');
 expect(screen.queryByRole('button',{name:'Add as reference'})).toBeNull();
 expect(screen.getByText('Add at least one reference with its “Add as reference” button.')).toBeTruthy();
 const blocked=menuOf('clip.mp4').getByRole('menuitem',{name:/Add as reference/}) as HTMLButtonElement;
 expect(blocked.disabled).toBe(true);expect(blocked.textContent).toContain('LTX takes images as references only.');
 fireEvent.keyDown(window,{key:'Escape'});
 fireEvent.click(screen.getByRole('button',{name:'ref.png'}));adopt();
 const img=await screen.findByRole('img',{name:'ref.png'});
 Object.defineProperties(img,{naturalWidth:{value:1280},naturalHeight:{value:704}});fireEvent.load(img);
 fireEvent.click(screen.getAllByRole('button',{name:'Add as reference'})[0]);
 expect(markOf('ref.png')).toBe('@ 0 s');
 fireEvent.click(screen.getByRole('button',{name:'Edit'}));
 expect(screen.getByRole('tab',{name:'References'}).getAttribute('aria-selected')).toBe('true');
 // A dock video dropped on the tab is refused with the reason (LTX references are images).
 const clip={name:'clip.mp4',path:'/env/ComfyUI/input/clip.mp4',media:'video',src:'asset://localhost//env/ComfyUI/input/clip.mp4'};
 fireEvent.drop(document.querySelector('[data-references]')!,{dataTransfer:{types:['application/x-deas-media'],getData:()=>JSON.stringify(clip)}});
 expect(screen.getByRole('alert').textContent).toBe('clip.mp4: LTX takes images as references only.');
 // The References tab button takes dock drops too (the Media tab is the drag source).
 const voice={name:'voice.wav',path:'/env/ComfyUI/input/voice.wav',media:'audio',src:'asset://localhost//env/ComfyUI/input/voice.wav'};
 fireEvent.drop(screen.getByRole('tab',{name:'References'}),{dataTransfer:{types:['application/x-deas-media'],getData:()=>JSON.stringify(voice)}});
 expect(screen.getByRole('alert').textContent).toBe('voice.wav: LTX takes images as references only.');
 fireEvent.change(screen.getByLabelText('Second of ref.png'),{target:{value:'1'}});
 fireEvent.change(screen.getByLabelText('Strength of ref.png'),{target:{value:'0.5'}});
 expect(screen.queryByRole('button',{name:/Insert/})).toBeNull(); // Director labels are H3-only
 fireEvent.click(screen.getByRole('tab',{name:'Media'}));
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 await screen.findByRole('button',{name:'ref.png'});
 expect(markOf('ref.png')).toBe('@ 1 s');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 const second=vi.mocked(runWorkbenchJob).mock.calls[1][1];
 expect(second).toMatchObject({family:'ltx-2',ltx:{keyframes:[{image:'ref.png',frame:24,strength:0.5}]}});
 expect(second).not.toHaveProperty('sourceVideo');
 fireEvent.click(menuOf('ref.png').getByRole('menuitem',{name:'Remove reference ref.png'}));
 expect(markOf('ref.png')).toBeUndefined();
 // Leaving Multi-reference hides the References tab and falls back to Media.
 fireEvent.click(screen.getByRole('button',{name:'Edit'}));choosePipe('Video → Video');
 expect(screen.queryByRole('tab',{name:'References'})).toBeNull();
 await waitFor(()=>expect(screen.getByRole('tab',{name:'Media'}).getAttribute('aria-selected')).toBe('true'));
});

test('IPC fixture: MiniMax H3 runs Video → Video and Multi-reference → Video as REF2VA timeline media',async()=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3_ref2va.safetensors',path:'/m/diffusion_models/MiniMaxH3/h3_ref2va.safetensors',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>_c==='native_forge'?({models:[{id:'m',label:'M'}],errors:{},creativity:['x'],shot_counts:['Auto'],default_shots:'Auto'}):({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 vi.mocked(uploadInput).mockImplementation(async(_b,path)=>path.endsWith('.mp4')?'deas-input-v.mp4':path.endsWith('.wav')?'deas-inputs/s.wav':'deas-inputs/i.png');
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:'job-h',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false} as JobStatus));
 vi.mocked(pollWorkbench).mockImplementation(async()=>collection(await Promise.all(vi.mocked(runWorkbenchJob).mock.results.map(async result=>({...await result.value,state:'succeeded' as const})))));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" root="/env" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Video → Video').disabled).toBe(false));
 choosePipe('Video → Video');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'clip.mp4'}));adopt();
 loadVideo('clip.mp4');
 fireEvent.click(screen.getByRole('checkbox',{name:'Use the source sound'}));
 expect(screen.queryByText('MiniMax H3 runs these as REF2VA; pick a REF2VA checkpoint for best results.')).toBeNull();
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({family:'minimax-h3',h3:{mode:'REF2VA',references:[],media:[{type:'video',file:'deas-input-v.mp4',slot:0,mediaMode:'video_audio'}]}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false),{timeout:5000});
 // Multi-reference: the video (sound only), an image and an audio clip; slots count per lane.
 choosePipe('Multi-reference → Video');
 fireEvent.click(screen.getByRole('button',{name:'clip.mp4'}));adopt();
 fireEvent.click(await screen.findByRole('button',{name:'Add as reference'}));
 fireEvent.click(screen.getByRole('button',{name:'Edit'}));
 fireEvent.change(screen.getByLabelText('Use of clip.mp4'),{target:{value:'audio'}});
 fireEvent.click(screen.getByRole('tab',{name:'Media'}));
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 await screen.findByRole('button',{name:'voice.wav'});
 fireEvent.click(menuOf('voice.wav').getByRole('menuitem',{name:'Add as reference'}));
 fireEvent.click(screen.getByRole('button',{name:'ref.png'}));adopt();
 const img=await screen.findByRole('img',{name:'ref.png'});
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:768}});fireEvent.load(img);
 fireEvent.click(screen.getAllByRole('button',{name:'Add as reference'})[0]);
 expect(document.querySelector('.wb-stage-mark')?.textContent).toBe('<Picture 1>');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 expect(vi.mocked(runWorkbenchJob).mock.calls[1][1]).toMatchObject({h3:{mode:'REF2VA',media:[
  {type:'video',file:'deas-input-v.mp4',slot:0,mediaMode:'audio'},{type:'audio',file:'deas-inputs/s.wav',slot:1},{type:'image',file:'deas-inputs/i.png',slot:0}]}});
 // Badges are the Director's prompt labels; the third sound track fills the audio lane, so a fourth is refused with the reason.
 expect([markOf('clip.mp4'),markOf('voice.wav'),markOf('ref.png')]).toEqual(['<Audio 1>','<Audio 2>','<Picture 1>']);
 fireEvent.click(menuOf('a2.wav').getByRole('menuitem',{name:'Add as reference'}));
 const full=menuOf('a3.wav').getByRole('menuitem',{name:/Add as reference/}) as HTMLButtonElement;
 expect(full.disabled).toBe(true);expect(full.textContent).toContain('Director limit reached');
 fireEvent.keyDown(window,{key:'Escape'});
 fireEvent.click(menuOf('voice.wav').getByRole('menuitem',{name:'Remove reference voice.wav'}));
 expect(markOf('voice.wav')).toBeUndefined();expect(markOf('a2.wav')).toBe('<Audio 2>');
 // References tab: a too-short trim blocks Run with the reason; a valid one reaches h3.media; labels go into the prompt.
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false),{timeout:5000});
 fireEvent.click(screen.getByRole('tab',{name:'References'}));
 expect(screen.getByText('Images 1/9 · Videos 0/3 · Sound 2/3 · Files 3/12')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Start of a2.wav'),{target:{value:'1'}});
 fireEvent.change(screen.getByLabelText('End of a2.wav'),{target:{value:'2'}});
 expect(screen.getByRole('alert').textContent).toBe('A trimmed clip must last 2–15 s (end after start).');
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 fireEvent.change(screen.getByLabelText('End of a2.wav'),{target:{value:'4.5'}});
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'a singer'}});
 fireEvent.click(screen.getByRole('button',{name:'Insert <Audio 2> into the prompt'}));
 // Director input scaling: the default Fill and crop stays implicit; another mode is sent.
 expect((vi.mocked(runWorkbenchJob).mock.calls[1][1] as unknown as {h3:object}).h3).not.toHaveProperty('inputScaling');
 fireEvent.change(document.querySelector('[data-h3-scaling]')!,{target:{value:'Fit and pad'}});
 // RefMods: read the backend library on demand, add one; it travels as a Director RefMod row.
 vi.mocked(readRefMods).mockResolvedValue([{name:'chars/hero',kinds:['image'],description:'the hero'}]);
 fireEvent.click(screen.getByRole('button',{name:'Read RefMod library'}));
 fireEvent.click(await screen.findByRole('button',{name:'Add RefMod'}));
 expect(readRefMods).toHaveBeenCalledWith('http://127.0.0.1:7801');
 fireEvent.change(screen.getByLabelText('Strength of chars/hero'),{target:{value:'0.6'}});
 expect(screen.getByText('Fit the whole reference and pad to the canvas.')).toBeTruthy();
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('a singer <Audio 2>');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(3));
 expect(vi.mocked(runWorkbenchJob).mock.calls[2][1]).toMatchObject({h3:{media:[
  {type:'video',slot:0,mediaMode:'audio'},{type:'image',slot:0},{type:'audio',slot:1,trimStart:1,trimEnd:4.5}],inputScaling:'Fit and pad',refmods:[{slot:1,name:'chars/hero',strength:0.6,description:'the hero'}]}});
 expect((vi.mocked(runWorkbenchJob).mock.calls[2][1] as unknown as {h3:{media:object[]}}).h3.media[0]).not.toHaveProperty('trimStart');
 // Director prompt helpers live in the hammer panel: open it, pick the LLM step. Prefill fills the REF2VA sections around the written text (RefMod after the timeline media); [Shot N] numbers on.
 fireEvent.click(screen.getByRole('button',{name:'Prompt Forge'}));
 fireEvent.click(screen.getByRole('button',{name:'LLM · Prompt Forge'}));
 fireEvent.click(screen.getByRole('button',{name:'Prefill labels & summary'}));
 const prompt=()=>(screen.getByLabelText('Prompt') as HTMLTextAreaElement).value;
 expect(prompt()).toMatch(/^subject_definitions:\n<Picture 1> is an image reference.*\n<Audio 1> is the audio track selected from a video.*\n<Audio 2> is an audio reference.*\n<Picture 2> is a saved image reference \(RefMod 1\) User description: the hero\./);
 expect(prompt()).toContain('detailed_description:\na singer <Audio 2>');
 fireEvent.click(screen.getByRole('button',{name:'Insert [Shot N]'}));
 expect(prompt().endsWith('[Shot 1] ')).toBe(true);
});

test('IPC fixture: MiniMax H3 offers Image → Image as the Director-style edit: shifts instead of denoise, no refine pass',async()=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/diffusion_models/MiniMaxH3/h3.safetensors',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:'job-e',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false} as JobStatus));
 localStorage.setItem('deas.pref.studio.run.post',JSON.stringify(true)); // refine after every run is on, but H3 skips it
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));
 choosePipe('Image → Image');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));adopt();
 const img=await screen.findByRole('img',{name:'ref.png'});
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:768}});fireEvent.load(img);
 expect(screen.queryByLabelText('Denoise')).toBeNull();
 expect(screen.queryByRole('button',{name:'Post-process'})).toBeNull();
 fireEvent.change(screen.getByLabelText('Shift video'),{target:{value:'11'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const intent=vi.mocked(runWorkbenchJob).mock.calls[0][1];
 expect(intent).toMatchObject({recipeId:'checkpoint-text-to-image-diagnostic',checkpoint:'MiniMaxH3/h3.safetensors',inputImage:'ref.png',diffusion:{clipType:'minimax'},h3Edit:{shiftVideo:11,shiftAudio:3}});
 expect(intent).not.toHaveProperty('refine');
});


test.each(['image','ltx-2','wan','minimax-h3'] as const)('Run Plan uses the exact next Run intent without preparing, uploading or losing draft state (%s)',async family=>{
 const m=(category:string,name:string,f?:string)=>({category,name,path:`/m/${category}/${name}`,size:1,info:null,...(f?{family:f}:{})});
 const list=family==='image'?[m('checkpoints','base.safetensors','sdxl'),m('loras','style.safetensors','sdxl')]
  :family==='ltx-2'?[m('unet','ltx.safetensors',family),m('text_encoders','gemma_3_12B_it_fp8.safetensors'),m('text_encoders','ltx-2.3_text_projection_bf16.safetensors'),m('vae','LTX23_video_vae_bf16.safetensors'),m('vae','LTX23_audio_vae_bf16.safetensors')]
  :family==='wan'?[m('diffusion_models','wan_high_noise.safetensors',family),m('diffusion_models','wan_low_noise.safetensors',family),m('text_encoders','umt5_xxl_fp8.safetensors'),m('vae','wan_2.1_vae.safetensors')]
  :[m('diffusion_models','h3.safetensors',family),m('text_encoders','qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'),m('vae','minimax_h3_video_vae_fp16.safetensors'),m('vae','minimax_h3_audio_vae_fp32.safetensors')];
 vi.mocked(scanModels).mockResolvedValue(list);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'DaSiWa_WildcardPresetPromptBuilder']}});
 const options={...defaultOptions,outputNaming:'test/%seed%'};
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify(options));
 localStorage.setItem('deas.pref.studio.run.seed','42');
 localStorage.setItem('deas.pref.studio.run.seedMode',JSON.stringify('fixed'));
 localStorage.setItem('deas.pref.studio.run.positive',JSON.stringify('live forest'));
 localStorage.setItem('deas.pref.studio.run.post','true');
 localStorage.setItem('deas.pref.studio.run.wildcardEnabled','true');
 if(family==='image'){
  localStorage.setItem('deas.pref.studio.run.upscale','2');
  localStorage.setItem('deas.pref.studio.run.loras',JSON.stringify([{name:'style.safetensors',strength:0.7}]));
  localStorage.setItem('deas.pref.studio.run.wildcardEnabled','true');
 }
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'same-job',baseUrl:evidence.baseUrl,promptId:'p',state:'queued',outputs:[],error:null,generationReady:false});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'ref.png',path:'/input/ref.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 const props={endpoint:evidence.baseUrl,roots:{models:'/m',input:'/input',output:'/output'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(scanModels).toHaveBeenCalled());
 if(family!=='image')choosePipe(family==='wan'?'Image → Video':'Text → Video');
 if(family==='wan'){
  fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
  fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));adopt();
  const ref=screen.getByRole('img',{name:'ref.png'});
  Object.defineProperties(ref,{naturalWidth:{value:720},naturalHeight:{value:1280}});fireEvent.load(ref);
 }
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'edited live forest'}});
 const shell=view.container.querySelector('[data-workbench]');
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 const shown=()=>JSON.parse(view.container.querySelector('[data-plan-intent]')!.textContent!);
 expect(shown()).toMatchObject({positivePrompt:'edited live forest',seed:42,outputPrefix:'raw/test/42'});
 const preview=shown();
 if(family==='image')expect(preview).toMatchObject({refine:{width:2048,height:2048},loras:[{name:'style.safetensors',strength:0.7}],wildcard:expect.any(Object)});
 else {expect(preview.family).toBe(family);expect(preview.refine).toBeUndefined();expect(preview.wildcard).toBeUndefined();expect(screen.getByRole('region',{name:'Run Plan'}).querySelector('[data-plan-stage="refine"]')).toBeNull();}
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 expect(view.container.querySelector('[data-workbench]')).toBe(shell);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toEqual(preview);
});

test('prompt fields expand into a floating editor that edits the same text and closes with Escape',async()=>{
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801"/></I18nProvider>);
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'a castle'}});
 fireEvent.click(screen.getByRole('button',{name:'Expand Prompt into a floating editor'}));
 const big=within(screen.getByRole('dialog',{name:'Prompt'})).getByRole('textbox',{name:'Prompt'}) as HTMLTextAreaElement;
 expect(big.value).toBe('a castle');
 fireEvent.change(big,{target:{value:'a castle at dawn'}});
 expect(within(screen.getByRole('dialog',{name:'Prompt'})).getByRole('button',{name:'Prompt Forge'})).toBeTruthy();
 expect((document.querySelector('[data-run-positive]') as HTMLTextAreaElement).value).toBe('a castle at dawn');
 fireEvent.keyDown(window,{key:'Escape'});
 expect(screen.queryByRole('dialog',{name:'Prompt'})).toBeNull();
 // Both directions: the inline field feeds the open editor too.
 fireEvent.click(screen.getByRole('button',{name:'Expand Prompt into a floating editor'}));
 fireEvent.change(document.querySelector('[data-run-positive]')!,{target:{value:'inline edit'}});
 expect((within(screen.getByRole('dialog',{name:'Prompt'})).getByRole('textbox',{name:'Prompt'}) as HTMLTextAreaElement).value).toBe('inline edit');
 fireEvent.keyDown(window,{key:'Escape'});
 fireEvent.click(screen.getByRole('button',{name:'Expand Negative prompt into a floating editor'}));
 fireEvent.change(within(screen.getByRole('dialog',{name:'Negative prompt'})).getByRole('textbox'),{target:{value:'blurry'}});
 expect((document.querySelector('[data-run-negative]') as HTMLTextAreaElement).value).toBe('blurry');
 fireEvent.click(within(screen.getByRole('dialog',{name:'Negative prompt'})).getByRole('button',{name:'Close editor'}));
 expect(screen.queryByRole('dialog')).toBeNull();
});

const mossNodes=['UNETLoader','CLIPLoader','VAELoader','CLIPTextEncode','KSampler','VAEDecode','SaveImage','EmptyFlux2LatentImage','LoadImage','VAEEncode','ImageScale'];
async function mountMoss(nodes=mossNodes,clipTypes=['moss_image']){
 vi.mocked(scanModels).mockResolvedValue([
  {category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null},
  {category:'diffusion_models',name:'moss.safetensors',family:'moss-image',path:'/m/moss',size:1,info:null},
  {category:'text_encoders',name:'qwen3.5_9b.safetensors',component:'qwen3.5-9b',path:'/m/clip',size:1,info:null},
  {category:'vae',name:'flux2-vae.safetensors',component:'flux2-vae',path:'/m/vae',size:1,info:null},
  {category:'loras',name:'unknown.safetensors',path:'/m/lora',size:1,info:null},
 ]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,missingNodes:['CheckpointLoaderSimple','EmptyLatentImage'],allowlist:{...evidence.allowlist,nodes,clipTypes}});
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'moss-job',promptId:'p',baseUrl:evidence.baseUrl,state:'succeeded',outputs:[],error:null,generationReady:false} as JobStatus);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/input'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'moss.safetensors'});
 fireEvent.change(screen.getByLabelText('Checkpoint'),{target:{value:'moss.safetensors'}});
}
test.each(['moss.safetensors','a.safetensors'])('image Wildcards block %s until its plugin is available or explicitly disabled',async(checkpoint)=>{
 localStorage.setItem('deas.pref.studio.run.wildcardEnabled','true');
 await mountMoss([...mossNodes,...evidence.allowlist.nodes]);
 fireEvent.change(screen.getByLabelText('Checkpoint'),{target:{value:checkpoint}});
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain('DaSiWa_WildcardPresetPromptBuilder');
 fireEvent.click(screen.getByRole('button',{name:'Run'}));expect(runWorkbenchJob).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Disable wildcards'}));
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).not.toHaveProperty('wildcard');
});
test.each(['moss.safetensors','a.safetensors'])('image Wildcards preserve enabled intent for %s with its plugin available',async(checkpoint)=>{
 localStorage.setItem('deas.pref.studio.run.wildcardEnabled','true');
 await mountMoss([...mossNodes,...evidence.allowlist.nodes,'DaSiWa_WildcardPresetPromptBuilder']);
 fireEvent.change(screen.getByLabelText('Checkpoint'),{target:{value:checkpoint}});
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toHaveProperty('wildcard');
});
test.each([...mossNodes.filter(n=>!['LoadImage','VAEEncode','ImageScale'].includes(n)), 'moss_image'])('MOSS blocks t2i when emitted capability %s is missing',async(missing)=>{
 await mountMoss(mossNodes.filter(n=>n!==missing),missing==='moss_image'?[]:['moss_image']);
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain(missing);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));expect(runWorkbenchJob).not.toHaveBeenCalled();
});
test.each([['SaveImage'],['DaSiWa_MetadataImageSaver','DaSiWa_MetadataConfig']])('MOSS uses the available saver %s without checkpoint diagnostic nodes',async(...saver)=>{
 await mountMoss([...mossNodes.filter(n=>n!=='SaveImage'),...saver]);
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
});
async function mossInput(width=520,height=768){
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 fireEvent.click(await screen.findByRole('button',{name:'source.png'}));adopt();
 const image=screen.getByRole('img',{name:'source.png'});
 Object.defineProperties(image,{naturalWidth:{value:width},naturalHeight:{value:height}});fireEvent.load(image);
 choosePipe('Image → Image');
}
test.each(['off','auto'])('MOSS blocks an unaligned source in %s without hiding its declared size',async(mode)=>{
 localStorage.setItem('deas.pref.studio.run.inputScaling',JSON.stringify(mode));
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 await mountMoss(mossNodes.filter(n=>n!=='EmptyFlux2LatentImage'));
 await mossInput();
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 expect(document.body.textContent).toContain('Choose Target, Fit or Crop');
 expect(screen.getByTestId('editor-world').style.width).toBe('520px');
 fireEvent.click(screen.getByRole('button',{name:'Run'}));expect(runWorkbenchJob).not.toHaveBeenCalled();
});
test.each(['fit','crop','target'])('MOSS explicit %s resizes an unaligned source and i2i does not need an empty latent',async(mode)=>{
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 await mountMoss(mossNodes.filter(n=>n!=='EmptyFlux2LatentImage'));await mossInput();
 fireEvent.change(screen.getByLabelText('Input scaling'),{target:{value:mode}});
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({inputImage:'source.png',inputResize:{crop:mode==='crop'?'center':'disabled'}});
 expect(screen.getByTestId('editor-world').style.width).toBe('520px');
});
test.each([
 ['attention',{attention:'a:test'},'Attention backend'],
 ['cache',{cache:'EasyCache'},'Step cache'],
 ['compile',{compile:'inductor'},'torch.compile'],
 ['vae',{vae:'tiled'},'VAE processing'],
 ['sigmas',{sigmas:'1, 0.5, 0'},'Custom sigmas'],
] as const)('MOSS blocks remembered %s independently and preserves unrelated options on reset',async(_key,patch,label)=>{
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({...defaultOptions,...patch,outputNaming:'keep/%seed%'}));
 await mountMoss();
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain('MOSS-Image supports plain generation only');
 fireEvent.click(screen.getByRole('button',{name:`Restore ${label} defaults`}));
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.options')!).outputNaming).toBe('keep/%seed%');
});
test('MOSS blocks an unknown-family LoRA until it is explicitly removed',async()=>{
 localStorage.setItem('deas.pref.studio.run.loras',JSON.stringify([{name:'unknown.safetensors',strength:0.5}]));
 await mountMoss();
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Restore LoRAs defaults'}));
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
});
test.each(['LoadImage','VAEEncode','ImageScale'])('MOSS i2i blocks its emitted %s capability',async(missing)=>{
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 await mountMoss(mossNodes.filter(n=>n!==missing));await mossInput(512);
 if(missing==='ImageScale'){
  expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Input scaling'),{target:{value:'fit'}});
 }
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain(missing);
});
test.each(['inpaint','pad'])('MOSS retains unsupported %s until a visible reset',async(mode)=>{
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 await mountMoss();await mossInput(512);
 if(mode==='inpaint')fireEvent.click(document.querySelector('[data-edit="inpaint"]')!);
 else fireEvent.change(screen.getByLabelText('Input scaling'),{target:{value:'pad'}});
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:`Restore ${mode==='inpaint'?'Inpaint':'Input scaling'} defaults`}));
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 expect(document.querySelector('[data-run-post]')).toBeNull();
});
test('MOSS disables inserted layers explicitly without deleting the editor draft',async()=>{
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 vi.stubGlobal('Image',class{naturalWidth=200;naturalHeight=100;onload=()=>{};onerror=()=>{};set src(_:string){setTimeout(()=>this.onload());}});
 await mountMoss();await mossInput(512);dropTile('source.png');
 await screen.findByRole('group',{name:'Inserted image source.png'});
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Restore Layers defaults'}));
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 expect(screen.queryByRole('group',{name:'Inserted image source.png'})).toBeNull();
 expect(screen.getByTestId('editor-world').style.width).toBe('512px');
});
test('MOSS retains incompatible options and post on a family switch until explicit per-feature resets',async()=>{
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({...defaultOptions,cache:'EasyCache',outputNaming:'kept/%seed%'}));
 localStorage.setItem('deas.pref.studio.run.post','true');
 await mountMoss([...mossNodes,'EasyCache']);
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 expect(localStorage.getItem('deas.pref.studio.run.post')).toBe('true');
 fireEvent.click(screen.getByRole('tab',{name:/^Options/}));expect((screen.getByLabelText('Step cache') as HTMLSelectElement).value).toBe('EasyCache');
 fireEvent.click(screen.getByRole('button',{name:'Restore Step cache defaults'}));
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Restore Post-Processing defaults'}));
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.options')!).outputNaming).toBe('kept/%seed%');
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).not.toHaveProperty('options');
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).not.toHaveProperty('refine');
});

test('three rapid Run presses capture prompts and distinct random seeds while IPC is pending',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 const replies:((job:JobStatus)=>void)[]=[];
 vi.mocked(runWorkbenchJob).mockImplementation(()=>new Promise(resolve=>replies.push(resolve)));
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 const run=document.querySelector<HTMLButtonElement>('[data-run]')!;
 await waitFor(()=>expect(run.disabled).toBe(false));
 for(const prompt of ['one','two','three']){fireEvent.change(document.querySelector('[data-run-positive]')!,{target:{value:prompt}});fireEvent.click(run);}
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(3));
 const calls=vi.mocked(runWorkbenchJob).mock.calls;
 expect(calls.map(c=>c[1].positivePrompt)).toEqual(['one','two','three']);
 expect(new Set(calls.map(c=>c[1].seed)).size).toBe(3);
 expect(calls.map(c=>c[2])).toEqual([0,0,0]);expect(run.textContent).toContain('Run');
 view.unmount();await act(async()=>replies.forEach((reply,i)=>reply(heldJob('rapid-'+i,'queued'))));
});

test('Stop discards every unsent image preparation without claiming upload cancellation',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a.safetensors',size:1,info:null}]);
 const saved={...projectFixture,draft:{...projectFixture.draft,checkpoint:'a.safetensors',pipeline:'i2i'},input:{id:'input-1',path:'/projects/one/assets/input.png',sha256:'a'.repeat(64),width:1024,height:1024}};
 vi.mocked(invoke).mockImplementation(async c=>c==='native_project_open'?saved:{entries:[],truncated:false});
 let release!:(name:string)=>void;const pending=new Promise<string>(yes=>{release=yes;});vi.mocked(uploadInput).mockReturnValue(pending);
 const props={endpoint:evidence.baseUrl,roots:{models:'/m',input:'/env/in'}};
 render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Open project'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Open project'}));
 await waitFor(()=>expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('saved project prompt'));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(1));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(2));
 fireEvent.click(document.querySelector('[data-run-stop]')!);
 await waitFor(()=>expect(stopWorkbench).toHaveBeenCalledTimes(1));
 await act(async()=>release('deas-inputs/late.png'));
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(document.querySelectorAll('[data-job-id]')).toHaveLength(0);
 expect(document.querySelector('[data-run-stop]')).toBeNull();expect(pollWorkbench).not.toHaveBeenCalled();
});

test('Stop drops delayed video preparation and the next press uses the new native epoch',async()=>{
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 let release!:(name:string)=>void;
 vi.mocked(uploadInput).mockReturnValueOnce(new Promise(yes=>{release=yes;}));
 vi.mocked(runWorkbenchJob).mockImplementation(async(baseUrl,intent)=>{
  const job={...heldJob('late-upload-job','queued',baseUrl),intent};
  vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
  vi.mocked(pollWorkbench).mockResolvedValue(collection([job]));
  return job;
 });
 const props={endpoint:'http://127.0.0.1:7801',roots:{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}};
 render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Video → Video').disabled).toBe(false));choosePipe('Video → Video');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'clip.mp4'}));adopt();loadVideo('clip.mp4');
 await waitFor(()=>expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(1));
 fireEvent.click(document.querySelector('[data-run-stop]')!);
 await screen.findByText('No native work remained. Unsent preparations were discarded.');
 await act(async()=>release('deas-inputs/late.mp4'));
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 expect(document.querySelectorAll('[data-job-id]')).toHaveLength(0);
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/new.mp4');fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));expect(vi.mocked(runWorkbenchJob).mock.calls[0][2]).toBe(1);
});


const imageModels=[{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}];
test.each(['empty','settled','partial'] as const)('Stop reports %s truthfully, preserves native products/unknowns and can repeat',async outcome=>{
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 const product={...heldJob('product','succeeded'),outputs:[{filename:'keep.png',subfolder:'',type:'output' as const}],outputRoot:'/old/output'};
 const unknown=heldJob('foreign','unknown');
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([product,unknown]));
 vi.mocked(stopWorkbench).mockResolvedValue({...collection([product,unknown]),admissionEpoch:1,outcome,discarded:0,issues:outcome==='partial'?[{jobId:unknown.id,error:'Foreign backend: scoped interruption unsupported'}]:[]});
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-job-id="foreign"]')).not.toBeNull());
 fireEvent.change(screen.getByLabelText('Width'),{target:{value:'1'}});
 expect(document.querySelector<HTMLButtonElement>('[data-run-stop]')!.disabled).toBe(false);
 fireEvent.click(document.querySelector('[data-run-stop]')!);
 await waitFor(()=>expect(document.querySelector('[data-run-stop-status]')).not.toBeNull());
 expect(document.querySelector('[data-run-stop-status]')!.textContent).toContain(outcome==='empty'?'No native work':outcome==='settled'?'Stop finished':'Stop was partial');
 if(outcome==='partial')expect(screen.getByRole('alert').textContent).toContain('Foreign backend: scoped interruption unsupported');
 expect(document.querySelector('[data-job-id="foreign"] [data-state]')!.getAttribute('data-state')).toBe('unknown');
 expect(document.querySelector('[data-job-id="product"] img')!.getAttribute('src')).toContain('/old/output/keep.png');
 expect(screen.queryByRole('button',{name:/Running/})).toBeNull();
 fireEvent.click(document.querySelector('[data-run-stop]')!);await waitFor(()=>expect(stopWorkbench).toHaveBeenCalledTimes(2));
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});
test.each(['unreachable','unsupported'])('Stop %s leaves held states intact and gives a localized standard alert',async failure=>{
 const job=heldJob('retained','running');
 vi.mocked(readCurrentWorkbench).mockResolvedValue({...collection([job]),stopAvailable:failure!=='unsupported'});
 vi.mocked(stopWorkbench).mockRejectedValue(new Error('IPC unavailable'));
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-run-stop]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-run-stop]')!);
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain(failure==='unsupported'?'does not support Workbench Stop':'IPC unavailable'));
 expect(document.querySelector('[data-job-id="retained"] [data-state]')!.getAttribute('data-state')).toBe('running');
 expect(stopWorkbench).toHaveBeenCalledTimes(failure==='unsupported'?0:1);
});
test('Stop fences a sent Run reply, coalesces presses and passes the captured native epoch',async()=>{
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 vi.mocked(readCurrentWorkbench).mockResolvedValue({...collection(),admissionEpoch:7});
 let finishRun!:(job:JobStatus)=>void;let finishStop!:(value:Awaited<ReturnType<typeof stopWorkbench>>)=>void;
 vi.mocked(runWorkbenchJob).mockReturnValue(new Promise(resolve=>{finishRun=resolve;}));
 vi.mocked(stopWorkbench).mockReturnValue(new Promise(resolve=>{finishStop=resolve;}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 fireEvent.click(document.querySelector('[data-run]')!);await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][2]).toBe(7);
 const stop=document.querySelector<HTMLButtonElement>('[data-run-stop]')!;
 fireEvent.click(stop);fireEvent.click(stop);fireEvent.click(document.querySelector('[data-run]')!);
 expect(stopWorkbench).toHaveBeenCalledTimes(1);expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
 await act(async()=>finishStop({...collection([heldJob('stopped','cancelled')]),admissionEpoch:8,outcome:'settled',discarded:0,issues:[]}));
 await act(async()=>finishRun(heldJob('stale-run','running')));
 expect(document.querySelector('[data-job-id="stale-run"]')).toBeNull();
 expect(document.querySelector('[data-job-id="stopped"] [data-state]')!.getAttribute('data-state')).toBe('cancelled');
});
test('poll reply already in flight cannot overwrite Stop',async()=>{
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([heldJob('held','running')]));
 let finish!:(value:ReturnType<typeof collection>)=>void;
 vi.mocked(pollWorkbench).mockReturnValue(new Promise(resolve=>{finish=resolve;}));
 vi.mocked(stopWorkbench).mockResolvedValue({...collection([heldJob('held','cancelled')]),admissionEpoch:1,outcome:'settled',discarded:0,issues:[]});
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await waitFor(()=>expect(pollWorkbench).toHaveBeenCalledTimes(1),{timeout:2500});
 fireEvent.click(document.querySelector('[data-run-stop]')!);
 await screen.findByText('Stop finished. Check the retained job states.');
 await act(async()=>finish(collection([heldJob('held','running')])));
 expect(document.querySelector('[data-job-id="held"] [data-state]')!.getAttribute('data-state')).toBe('cancelled');
});
test('native capacity rejection retains all active and unknown peers without frontend truncation',async()=>{
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 const jobs=Array.from({length:20},(_,i)=>heldJob('capacity-'+i,i%2?'queued':'unknown'));
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection(jobs));
 vi.mocked(runWorkbenchJob).mockRejectedValue(new Error('Workbench capacity reached'));
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
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
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const job=heldJob('continuity-stop','queued');
 vi.mocked(runWorkbenchJob).mockResolvedValue(job);
 vi.mocked(pollWorkbench).mockResolvedValue(collection([{...job,state:'succeeded'}]));
 let finish!:(value:Awaited<ReturnType<typeof readH3Session>>)=>void;
 vi.mocked(readH3Session).mockReturnValue(new Promise(resolve=>{finish=resolve;}));
 vi.mocked(stopWorkbench).mockResolvedValue({...collection([{...job,state:'succeeded'}]),admissionEpoch:1,outcome:'empty',discarded:0,issues:[]});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'Continuity'}));
 fireEvent.click(screen.getByRole('button',{name:'Add step'}));fireEvent.click(screen.getByRole('button',{name:'Add step'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run all'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run all'}));
 fireEvent.click(within(screen.getByRole('dialog',{name:'Continuity'})).getByRole('button',{name:'Close'}));
 await waitFor(()=>expect(readH3Session).toHaveBeenCalledTimes(1),{timeout:3000});
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
 fireEvent.click(document.querySelector('[data-run-stop]')!);
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
  fireEvent.click(document.querySelector('[data-run-stop]')!);first.unmount();
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
