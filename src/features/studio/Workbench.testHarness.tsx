// Shared mocks, hooks and fixtures of the Workbench suite (split across Workbench.*.test.tsx for parallel runs).
// Import it first in every Workbench test file: its vi.mock calls must register before Workbench loads.
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
export const askDialog=()=>document.querySelector('dialog.confirm-dialog');
export const askConfirm=()=>fireEvent.click(document.querySelector('dialog.confirm-dialog [data-confirm-dialog]')!);
export const askCancel=()=>{const d=document.querySelector('dialog.confirm-dialog')!;fireEvent.click(d.querySelectorAll('button')[1]!);};
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Workbench } from './Workbench';
import { GlobalSearch } from '../../components/setup/GlobalSearch';
import { defaultOptions } from './OptionsPanel';
import { defaultTve } from './TvePostControls';
import { h3LatentDefaults, regenerateSize, type H3LatentUpscale, type H3RegenerateUpscale } from '../../lib/videoIntent';
import { faceRefineNodes, sam3VideoNodes, type Sam3VideoMaskIntentV1 } from '../../lib/sam3';
import {normalizeAceDuration,defaultAceSettings,type AceStepFamily} from '../../lib/musicIntent';
import { applyStudioSettings, captureStudioSettings, resetStudioPreferences } from '../../lib/preferences';
import { aspects, resolutions } from '../../lib/resolution';
import type { HistoryRecord } from './history';
import type { ForgeCanvasContext } from '../../lib/forgeCanvas';
import { revealTarget } from '../../lib/search';
import type { LocalModel } from '../../lib/models';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels, writeModelFamily } from '../../lib/models';
import { autoRefine, waitForWorkbenchJob, stopWorkbench, stopWorkbenchJob, runWorkbenchJob, readCurrentWorkbench, pollWorkbench, uploadMask, uploadInput, readH3Session, prepareH3Video, readRefMods, loadDiagnosticJobOutput, exportDiagnosticJobOutput, type JobStatus } from '../../lib/jobs';
import { readImageMetadata } from '../../lib/imageMetadata';
vi.mock('@tauri-apps/api/core',()=>({isTauri:vi.fn(()=>true),convertFileSrc:(p:string)=>`asset://localhost/${p}`,invoke:vi.fn(async()=>({path:'/env/ComfyUI/output',parent:'/env/ComfyUI',entries:[],truncated:false}))}));
vi.mock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({onCloseRequested:async()=>()=>{}})}));
const nativeDrops=vi.hoisted(()=>new Set<(event:{payload:{type:'drop';paths:string[];position:{x:number;y:number}}})=>void>());
export const sharedNativeDrops=nativeDrops;
const nativeDropFailure=vi.hoisted(()=>({sync:false,async:false}));
export const sharedNativeDropFailure=nativeDropFailure;
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>{if(nativeDropFailure.sync)throw Error('missing webview');return {onDragDropEvent:async(handler:(event:{payload:{type:'drop';paths:string[];position:{x:number;y:number}}})=>void)=>{if(nativeDropFailure.async)throw Error('unavailable listener');nativeDrops.add(handler);return()=>nativeDrops.delete(handler);}};}}));
vi.mock('../../lib/recipePrerequisites',()=>({checkRecipePrerequisites:vi.fn(async()=>{throw new Error('offline');})}));
vi.mock('../../lib/models',()=>({scanModels:vi.fn(),writeModelFamily:vi.fn(),writeModelFamilies:vi.fn()}));
vi.mock('../../lib/imageMetadata',async importOriginal=>({...await importOriginal<typeof import('../../lib/imageMetadata')>(),readImageMetadata:vi.fn(async()=>[] as [string,string][])}));
vi.mock('../../lib/jobs',()=>({autoRefine:vi.fn(),waitForWorkbenchJob:vi.fn(),stopWorkbenchJob:vi.fn(),uploadMask:vi.fn(),uploadInput:vi.fn(),checkMusicSource:vi.fn(),readH3Session:vi.fn(),prepareH3Video:vi.fn(),readRefMods:vi.fn(),stopWorkbench:vi.fn(),runWorkbenchJob:vi.fn(),readCurrentWorkbench:vi.fn(),pollWorkbench:vi.fn(),loadDiagnosticJobOutput:vi.fn(),exportDiagnosticJobOutput:vi.fn(),isImageIntent:(i:{recipeId?:string})=>i?.recipeId==='checkpoint-text-to-image-diagnostic'}));
export const collection=(jobs:JobStatus[]=[],preparing=0)=>({jobs,preparing,capacity:20,stopAvailable:true,admissionEpoch:0,stopping:false});
export const evidence={baseUrl:'http://127.0.0.1:7801/',recipeId:'checkpoint-text-to-image-diagnostic' as const,version:1 as const,missingNodes:[],generationReady:false as const,
 allowlist:{nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage'],checkpoints:['a.safetensors','b.safetensors'],loras:['style.safetensors'],samplers:['euler','euler_ancestral','euler_cfg_pp','er_sde','dpmpp_2m','dpm_2','res_multistep','uni_pc','lcm'],schedulers:['normal','simple','linear_quadratic','karras','sgm_uniform','beta']}};
export const videoEvidence={...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'UNETLoader'],diffusionModels:['LTX2/ltx.safetensors','h3.safetensors','MiniMaxH3/h3.safetensors','MiniMaxH3/h3_ref2va.safetensors']}};
export const refsEvidence={...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'UNETLoader'],diffusionModels:['qwen.safetensors','anima.safetensors']}};
beforeEach(()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(this:HTMLDialogElement){this.open=true;}});
 nativeDrops.clear();nativeDropFailure.sync=false;nativeDropFailure.async=false;
 vi.mocked(stopWorkbench).mockResolvedValue({...collection(),admissionEpoch:1,outcome:'empty',discarded:0,issues:[]});
 vi.mocked(readCurrentWorkbench).mockImplementation(async()=>{
  const submitted=await Promise.all(vi.mocked(runWorkbenchJob).mock.results.filter(result=>result.type==='return').map(async result=>{try{return await result.value as JobStatus;}catch{return null;}}));
  return collection([...new Map(submitted.filter((job):job is JobStatus=>!!job).map(job=>[job.id,job])).values()]);
 });
 vi.mocked(pollWorkbench).mockResolvedValue(collection());
 vi.mocked(readH3Session).mockResolvedValue({latestId:null,clips:[]});
 localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(true);
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.open=false;}});
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({save:vi.fn(),restore:vi.fn(),arc:vi.fn(),fill:vi.fn(),beginPath:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),drawImage:vi.fn(),getImageData:vi.fn(()=>({data:new Uint8ClampedArray([0,0,0,0])}))} as unknown as CanvasRenderingContext2D);
});
afterEach(()=>{cleanup();Reflect.deleteProperty(HTMLDialogElement.prototype,'showModal');Reflect.deleteProperty(HTMLDialogElement.prototype,'close');Reflect.deleteProperty(HTMLVideoElement.prototype,'src');vi.clearAllMocks();vi.unstubAllGlobals();});
export const videoSam='SAM3/sam3.1_multiplex_fp16.safetensors';
export async function faceAnalysisFixture(missing='',source:'queue'|'rootless'|'none'='queue'){
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify('t2v'));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...sam3VideoNodes.filter(n=>n!==missing),...(missing==='DEAS_SAM3ShotMask'?[]:['DEAS_SAM3ShotMask'])],checkpoints:missing==='checkpoint'?[]:[videoSam,'SAM3/sam3.1_other.safetensors']}});
 vi.mocked(scanModels).mockResolvedValue([{category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/h3',family:'minimax-h3',size:1,info:null}]);
 const sourceJob={...heldJob('source-video','succeeded',evidence.baseUrl),...(source==='rootless'?{}:{outputRoot:'/out'}),outputs:[{filename:'shown.mp4',subfolder:'clips',type:'output' as const}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection(source==='none'?[]:[sourceJob,{...sourceJob,id:'other-video',outputs:[{filename:'other.mp4',subfolder:'clips',type:'output'}]}]));
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out',input:'/in'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Text → Video').disabled).toBe(false));choosePipe('Text → Video');dock('Post-Processing');
 fireEvent.click(document.querySelector('[data-post-card="face-analysis"]')!);
 await screen.findByRole('group',{name:'H3 Face-Refiner'});
 if(source!=='none'){await waitFor(()=>expect(document.querySelector('[data-job-id="source-video"]')).not.toBeNull());fireEvent.click(document.querySelector('[data-job-id="source-video"] .wb-queue-select')!);}
 await waitFor(()=>expect(document.querySelector<HTMLSelectElement>('[data-sam-video="checkpoint"]')!.value).toBe(missing==='checkpoint'?'':videoSam));
 return {view,sourceJob};
}
export const faceField=(key:string)=>document.querySelector<HTMLInputElement>(`[data-sam-video="${key}"]`)!;
export const heldJob=(id:string,state:JobStatus['state'],baseUrl='http://original:7801/'):JobStatus=>({id,state,baseUrl,promptId:'p-'+id,outputs:[],error:null,generationReady:false});
export const h3VideoFiles=()=>[
 {category:'diffusion_models',name:'h3.safetensors',family:'minimax-h3'},
 {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'},
 {category:'vae',name:'minimax_h3_video_vae_fp16.safetensors'},
 {category:'vae',name:'minimax_h3_audio_vae_fp32.safetensors'}
].map(m=>({...m,path:'/m/'+m.name,size:1,info:null}));
export const settingsDrop=(path:string)=>fireEvent.drop(screen.getByRole('region',{name:'Preview'}),{dataTransfer:{types:['application/x-deas-media'],getData:()=>JSON.stringify({name:path.split('/').at(-1),path,src:'asset://localhost/'+path,media:path.endsWith('.mp4')?'video':'image'})}});
export const clickMedia=(image:HTMLImageElement,clientX=400,clientY=300)=>{
 if(!image.naturalWidth)Object.defineProperties(image,{naturalWidth:{configurable:true,value:1024},naturalHeight:{configurable:true,value:640}});
 const bounds=Object.getOwnPropertyDescriptor(image,'getBoundingClientRect');
 Object.defineProperty(image,'getBoundingClientRect',{configurable:true,value:()=>({left:0,top:0,width:800,height:600})});
 fireEvent.click(image,{clientX,clientY});
 if(bounds)Object.defineProperty(image,'getBoundingClientRect',bounds);else Reflect.deleteProperty(image,'getBoundingClientRect');
};
export const adopt=()=>fireEvent.click(document.querySelector('.wb-stage > [data-media-tools] [data-use-input]:not(:disabled)')!);
export const dock=(name:string)=>{if(document.querySelector('.references-overlay[open]'))fireEvent.click(within(screen.getByRole('dialog',{name:'References'})).getByRole('button',{name:'Close'}));fireEvent.click(name==='References'?document.querySelector('[data-open-references]')!:screen.getByRole('tab',{name}));};
export // The pipeline picker is one select at the top of the settings; disabled options name pipelines without a runnable model.
// Text → Image and Image → Image are one Image pipeline; the picture to edit (adopt()) selects the edit mode.
const pipe=(name:string)=>screen.getByRole('option',{name:name==='Text → Image'||name==='Image → Image'?'Image':['Text → Video','Image → Video','Video → Video','Multi-reference → Video'].includes(name)?'Video':name.startsWith('Music (')?'Music':name}) as HTMLOptionElement;
export const choosePipe=(name:string)=>fireEvent.change(screen.getByRole('combobox',{name:'Pipeline'}),{target:{value:pipe(name).value}});
export // HTML5 drag of a dock tile onto the editor: the tile's dragstart fills a DataTransfer the drop reads back.
const dropTile=(name:string)=>{const store:Record<string,string>={};const dt={clearData:()=>{for(const key of Object.keys(store))delete store[key];},setData:(k:string,v:string)=>{store[k]=v;},getData:(k:string)=>store[k]??'',get types(){return Object.keys(store);}};
 fireEvent.dragStart(screen.getByRole('button',{name}),{dataTransfer:dt});fireEvent.drop(document.querySelector('[data-editor-viewport]')!,{dataTransfer:dt});};
export const promptDrop=(media='image',path:string|undefined='/outside/ref.png')=>{const name=typeof path==='string'?path.split(/[\\/]/).at(-1)||'ref.png':'ref.png';const item={name,src:`asset://localhost/${name}`,media,path};const transfer={types:['application/x-deas-media'],getData:()=>JSON.stringify(item),dropEffect:'none'};const prompt=screen.getByRole('textbox',{name:'Prompt'});fireEvent.dragOver(prompt,{dataTransfer:transfer});fireEvent.drop(prompt,{dataTransfer:transfer});return transfer;};
export const referenceNodes=['TextEncodeQwenImage21','LoadImage','ImageScale'];
export const referenceModels=(family='qwen-image-2.1')=>[
 {category:'diffusion_models',name:'qwen.safetensors',family,path:'/m/q',size:1,info:null},
 {category:'text_encoders',name:family==='krea-2'?'qwen3vl_4b.safetensors':family==='moss-image'?'qwen3.5_9b.safetensors':'qwen3vl_8b.safetensors',path:'/m/e',size:1,info:null},
 {category:'vae',name:family==='krea-2'?'qwen_image_vae.safetensors':family==='moss-image'?'flux2-vae.safetensors':'qwen_image_2.1_vae.safetensors',path:'/m/v',size:1,info:null},
 {category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null},
 {category:'diffusion_models',name:'anima.safetensors',family:'anima',path:'/m/anima',size:1,info:null}
];
export function reorderReferences(from:number,to:number){
 const cards=document.querySelectorAll('[data-reference-controls]'),data=new Map<string,string>();
 const transfer={clearData:()=>data.clear(),setData:(key:string,value:string)=>data.set(key,value),getData:(key:string)=>data.get(key)??'',get types(){return [...data.keys()];},effectAllowed:'uninitialized',dropEffect:'none'};
 fireEvent.dragStart(cards[from],{dataTransfer:transfer});fireEvent.dragOver(cards[to],{dataTransfer:transfer});fireEvent.drop(cards[to],{dataTransfer:transfer});fireEvent.dragEnd(cards[from],{dataTransfer:transfer});
}
export const sessionModels=['folder/a.safetensors','other/a.safetensors','c.safetensors'].map(name=>({category:'checkpoints',name,family:'sdxl',path:'/m/'+name,size:1,info:null}));
export const sessionModel=(name:string)=>fireEvent.change(document.querySelector('[data-model-picker]')!,{target:{value:name}});
export const sessionSettings=(settings:Record<string,unknown>)=>act(()=>{expect(applyStudioSettings(Object.fromEntries(Object.entries(settings).map(([key,value])=>['studio.run.'+key,value])))).toBe(true);});
export const projectFixture={id:'project-1',root:'/projects/one',revision:1,draft:{positivePrompt:'saved project prompt',negativePrompt:'saved negative',checkpoint:'missing.safetensors',width:1024,height:1024,steps:24,cfg:6,sampler:'euler',scheduler:'normal',seed:42,denoise:0.5,pipeline:'i2i' as const},input:null};
export const ltxModels=[
 {category:'unet',name:'LTX2/ltx.safetensors',path:'/m/unet/LTX2/ltx.safetensors',size:1,info:null,family:'ltx-2'},
 {category:'text_encoders',name:'gemma_3_12B_it_fp8.safetensors',path:'/m/text_encoders/gemma.safetensors',size:1,info:null},
 {category:'text_encoders',name:'ltx-2.3_text_projection_bf16.safetensors',path:'/m/text_encoders/proj.safetensors',size:1,info:null},
 {category:'vae',name:'LTX2/LTX23_video_vae_bf16.safetensors',path:'/m/vae/v.safetensors',size:1,info:null},
 {category:'vae',name:'LTX2/LTX23_audio_vae_bf16.safetensors',path:'/m/vae/a.safetensors',size:1,info:null}] as const;
export const mediaEntries=[
 {name:'ref.png',path:'/env/ComfyUI/input/ref.png',kind:'file',symlink:false,media:'image',size:1,modified:1},
 {name:'clip.mp4',path:'/env/ComfyUI/input/clip.mp4',kind:'file',symlink:false,media:'video',size:1,modified:2},
 {name:'voice.wav',path:'/env/ComfyUI/input/voice.wav',kind:'file',symlink:false,media:'audio',size:1,modified:3},
 {name:'a2.wav',path:'/env/ComfyUI/input/a2.wav',kind:'file',symlink:false,media:'audio',size:1,modified:4},
 {name:'a3.wav',path:'/env/ComfyUI/input/a3.wav',kind:'file',symlink:false,media:'audio',size:1,modified:5}];
export /** Right-click a Media dock tile and return its menu. */
const menuOf=(name:string)=>{fireEvent.contextMenu(screen.getByRole('button',{name}),{clientX:5,clientY:5});return within(screen.getByRole('menu',{name}));};
export const markOf=(name:string)=>screen.getByRole('button',{name}).closest('li')!.dataset.mark;
export const loadVideo=(name:string)=>{const v=document.querySelector<HTMLVideoElement>(`.wb-stage video`)!;Object.defineProperties(v,{videoWidth:{value:1280},videoHeight:{value:704}});fireEvent.loadedMetadata(v);void name;};
export const mossNodes=['UNETLoader','CLIPLoader','VAELoader','CLIPTextEncode','KSampler','VAEDecode','SaveImage','EmptyFlux2LatentImage','SkipLayerGuidanceDiTSimple','LoadImage','VAEEncode','ImageScale','LoadImageMask','SetLatentNoiseMask','ImageCompositeMasked'];
export async function mountMoss(nodes=mossNodes,clipTypes=['moss_image']){
 vi.mocked(scanModels).mockResolvedValue([
  {category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null},
  {category:'diffusion_models',name:'moss.safetensors',family:'moss-image',path:'/m/moss',size:1,info:null},
  {category:'text_encoders',name:'qwen3.5_9b.safetensors',component:'qwen3.5-9b',path:'/m/clip',size:1,info:null},
  {category:'vae',name:'flux2-vae.safetensors',component:'flux2-vae',path:'/m/vae',size:1,info:null},
  {category:'loras',name:'unknown.safetensors',path:'/m/lora',size:1,info:null},
 ]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,missingNodes:['CheckpointLoaderSimple','EmptyLatentImage'],allowlist:{...evidence.allowlist,diffusionModels:['moss.safetensors'],nodes,clipTypes}});
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'moss-job',promptId:'p',baseUrl:evidence.baseUrl,state:'succeeded',outputs:[],error:null,generationReady:false} as JobStatus);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/input'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'moss.safetensors'});
 fireEvent.change(screen.getByLabelText('Checkpoint'),{target:{value:'moss.safetensors'}});
}
export async function mossInput(width=520,height=768){
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 fireEvent.click(await screen.findByRole('button',{name:'source.png'}));adopt();
 const image=screen.getByRole('img',{name:'source.png'});
 Object.defineProperties(image,{naturalWidth:{value:width},naturalHeight:{value:height}});fireEvent.load(image);
 choosePipe('Image → Image');
}
export // A single run stops on the button itself; only more queued work opens the choice.
const stopAll=()=>{fireEvent.click(document.querySelector('[data-run-stop]')!);const all=screen.queryByRole('menuitem',{name:'Stop all'});if(all)fireEvent.click(all);};
export const imageModels=[{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}];
export const recentHistoryRecord=(intent:HistoryRecord['intent']):HistoryRecord=>({id:'historical-attempt',clientId:'historic-client',promptId:'historic-prompt',origin:'studio',appVersion:'0.1.48',admittedAt:1700000000000,observedAt:1700000001000,revision:3,state:'failed',intent,outputs:[],outputRoot:'/env/ComfyUI/output',backendOrigin:'http://127.0.0.1:7801',error:null});
export const historicalImage={recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:'Exact historic prompt 猫',negativePrompt:'historic negative',checkpoint:'a.safetensors',seed:987654321,width:1216,height:832,steps:17,cfg:4.25,sampler:'euler',scheduler:'normal',outputPrefix:'raw/history/exact'} as const;
export const openHistoryRecord=async()=>{
 fireEvent.click(screen.getByRole('button',{name:'Recent generations'}));
 await waitFor(()=>expect(document.querySelector('[data-history-id]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-history-id]')!);
 fireEvent.click(screen.getByRole('button',{name:'Use settings'}));
};
export const dropHistoryReference=(index:number,name:string,path:string)=>{
 const item={name,path,media:'image',src:'asset://localhost/'+path};
 fireEvent.drop(document.querySelectorAll('[data-reference-controls]')[index],{dataTransfer:{types:['application/x-deas-media'],getData:()=>JSON.stringify(item)}});
};
export // Role-based Video exercises the public controls; legacy preference tests above intentionally retain internal ids.
async function roleVideoFixture(family:'ltx-2'|'minimax-h3'='ltx-2',extraModels=false,legacyPipeline='t2v'){
 const ms:LocalModel[]=family==='ltx-2'?[...ltxModels]:[
  {category:'diffusion_models',name:'h3.safetensors',path:'/m/h3',family:'minimax-h3',size:1,info:null},
  {category:'text_encoders',name:'minimax_h3_encoder.safetensors',path:'/m/t',size:1,info:null},
  {category:'vae',name:'h3_video_vae.safetensors',path:'/m/v',size:1,info:null},
  {category:'vae',name:'h3_audio_vae.safetensors',path:'/m/a',size:1,info:null}];
 if(extraModels)ms.push({...ms[0],name:'other.safetensors',path:'/m/other'});
 vi.mocked(scanModels).mockResolvedValue(ms);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'UNETLoader','CLIPLoader','DualCLIPLoader','VAELoader'],diffusionModels:ms.filter(m=>m.family).map(m=>m.name),textEncoders:ms.filter(m=>m.category==='text_encoders').map(m=>m.name),vaes:ms.filter(m=>m.category==='vae').map(m=>m.name),clipTypes:['ltxv','minimax']}});
 vi.mocked(invoke).mockImplementation(async command=>command==='native_jobs_history'?{schemaVersion:1,records:[],readOnly:false,error:null}:{path:'/input',parent:'/',entries:[],truncated:false});
 vi.mocked(uploadInput).mockImplementation(async(_base,path)=>`uploaded/${path.split('/').at(-1)}`);
 vi.mocked(runWorkbenchJob).mockImplementation(async(base,intent)=>({...heldJob('role-capture','failed',base),intent}));
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify(legacyPipeline));
 localStorage.setItem('deas.pref.studio.run.resolution','"fixed"');
 localStorage.setItem('deas.pref.studio.run.width','1024');localStorage.setItem('deas.pref.studio.run.height','768');
 const props={endpoint:evidence.baseUrl,roots:{models:'/m',input:'/input'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain(ms[0].name));
 return {view,props};
}
export const roleFile=(name:string,media:'image'|'video'='image')=>({name,media,path:'/external/'+name,src:'asset:///'+name});
export function assignRole(name:string,role:'first'|'last'|'both'|'reference'|'source',media:'image'|'video'='image'){
 fireEvent.drop(document.querySelector('[data-open-references]')!,{dataTransfer:{types:['application/x-deas-media'],getData:()=>JSON.stringify(roleFile(name,media))}});
 const choice=document.querySelector('.reference-assignment select');if(choice)fireEvent.change(choice,{target:{value:role}});
 fireEvent.click(document.querySelector(`[data-video-role="${role}"]`)!);
}
export function closeRoles(){fireEvent.click(within(screen.getByRole('dialog',{name:'References'})).getByRole('button',{name:'Close'}));}
export const beginnerMusicProps={endpoint:'http://127.0.0.1:7801',root:'/env',roots:{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}};
export const beginnerView=(beginner=true,beginnerPage:'generate'|'models'|'collection'='generate')=><I18nProvider><Workbench {...beginnerMusicProps} beginner={beginner} beginnerPage={beginnerPage}/></I18nProvider>;
export // ── YuE2 music ────────────────────────────────────────────────────────────────
const yue2Models=[
 {category:'checkpoints',name:'yue2_3b.safetensors',path:'/m/checkpoints/yue2_3b.safetensors',size:1,info:null,family:'yue2'},
 {category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null}] as const;
export const musicNodes=['YuE2GenerateABC','YuE2GenerateMusic','ConditioningZeroOut','EmptyYuE2LatentAudio','VAEDecodeAudio','SaveAudioAdvanced','LoadAudio','AudioEncoderLoader','SheetSage2AudioToABC'];
export const musicEvidence=(extra:Partial<typeof evidence.allowlist&{audioEncoders:string[];diffusionModels:string[];dualTextEncoders:string[];textEncoders:string[];vaes:string[]}>={})=>({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,...musicNodes],checkpoints:['yue2_3b.safetensors','a.safetensors'],samplers:[...evidence.allowlist.samplers,'dpm_2'],schedulers:[...evidence.allowlist.schedulers,'sgm_uniform'],audioEncoders:['sheetsage2_bf16.safetensors'],...extra}});
export const musicJob=(id:string):JobStatus=>({id,baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false});
export async function mountMusic(pipeline:'Music (Text to Music)'|'Music (Cover Music)',planVisible=false,allow=musicEvidence(),models:LocalModel[]=[...yue2Models]){
 vi.mocked(scanModels).mockResolvedValue(models);vi.mocked(checkRecipePrerequisites).mockResolvedValue(allow);
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify(pipeline==='Music (Cover Music)'?'cover':'t2m'));
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_media_star_status'?{starred:false,unavailable:null}:command==='native_jobs_history'?{schemaVersion:1,records:[],readOnly:false,error:null}:{path:(args as {path?:string})?.path??'/env/ComfyUI/input',parent:'/env',entries:mediaEntries,truncated:false});
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>musicJob('job-m'));
 const view=render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" root="/env" planVisible={planVisible} roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 if(planVisible){await waitFor(()=>expect(document.querySelector('[data-plan-intent]')?.textContent).toContain('music-generation'));return view;}
 await waitFor(()=>expect(pipe(pipeline).disabled).toBe(false));choosePipe(pipeline);
 sessionModel('yue2_3b.safetensors');
 await waitFor(()=>expect((screen.getByRole('combobox',{name:'Checkpoint'}) as HTMLSelectElement).value).toBe('yue2_3b.safetensors'));
 return view;
}
export const music=()=>({style:screen.getByRole('textbox',{name:'Style'}) as HTMLTextAreaElement,lyrics:screen.getByRole('textbox',{name:'Lyrics'}) as HTMLTextAreaElement});
export // ACE-Step authoring uses the shared music pipeline, never YuE2 conditioning.
const aceVariants=[
 ['ace-step-1-0',50,5,5],['ace-step-1-5-base',50,7,1],['ace-step-1-5-sft',50,7,1],['ace-step-1-5-turbo',8,1,3],
 ['ace-step-1-5-xl-base',50,6,3],['ace-step-1-5-xl-sft',50,7,3],['ace-step-1-5-xl-turbo',8,1,3],
] as const;
export const aceModel=(family:string,category='checkpoints')=>({category,name:`${family}.safetensors`,path:`/m/${category}/${family}.safetensors`,size:1,info:null,family});
export const aceNodes=['LatentOperationTonemapReinhard','LatentApplyOperationCFG','KSampler','ConditioningZeroOut','VAEDecodeAudio','SaveAudioAdvanced','CheckpointLoaderSimple','ModelSamplingSD3','ModelSamplingAuraFlow','TextEncodeAceStepAudio','EmptyAceStepLatentAudio','TextEncodeAceStepAudio1.5','EmptyAceStep1.5LatentAudio','UNETLoader','DualCLIPLoader','VAELoader'];
/** `loras`: extra LoRA files (listed by the backend, `LoraLoaderModelOnly` available). */
export async function mountAce(category='checkpoints',missing:string[]=[],loras:LocalModel[]=[]) {
 const ms=aceVariants.map(([f])=>aceModel(f,category));
 vi.mocked(scanModels).mockResolvedValue([...ms,aceModel('ace-step'),aceModel('ace-step-1-5'),aceModel('ace-step-1-5-xl'),...yue2Models,...loras]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(musicEvidence({nodes:[...aceNodes.filter(n=>!missing.includes(n)),...(loras.length?['LoraLoaderModelOnly']:[])],checkpoints:ms.map(m=>m.name),diffusionModels:ms.map(m=>m.name),...(loras.length?{loras:loras.map(l=>l.name)}:{})}));
 vi.mocked(invoke).mockImplementation(async command=>command==='native_media_star_status'?{starred:false,unavailable:null}:command==='native_jobs_history'?{schemaVersion:1,records:[],readOnly:false,error:null}:{path:'/env/ComfyUI/input',parent:'/env',entries:[],truncated:false});
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>musicJob('job-ace'));
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} root="/env" roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Music (Text to Music)').disabled).toBe(false));choosePipe('Music (Text to Music)');
 await screen.findByRole('textbox',{name:'Style'});
 return view;
}
export const aceControl=(key:string)=>document.querySelector<HTMLInputElement|HTMLSelectElement>(`[data-ace-setting="${key}"]`)!;
export const changeAceModel=(family:string)=>fireEvent.change(screen.getByRole('combobox',{name:'Checkpoint'}),{target:{value:`${family}.safetensors`}});
export const navJobs=()=>[
 {...heldJob('pair','succeeded'),outputRoot:'/out',outputs:[{filename:'one.png',subfolder:'raw',type:'output' as const,role:'processed' as const},{filename:'two.png',subfolder:'raw',type:'output' as const,role:'original' as const}]},
 {...heldJob('clip','succeeded'),outputRoot:'/out',outputs:[{filename:'clip.mp4',subfolder:'',type:'output' as const}]},
 {...heldJob('last','succeeded'),outputRoot:'/out',outputs:[{filename:'c.png',subfolder:'',type:'output' as const}]}];
export const h3UploadCases=['t2v','i2v','v2v','ref2v'].flatMap(pipeline=>['new','checkpoint','video'].flatMap(sourceMode=>
 (pipeline==='ref2v'?[false,true]:[false]).map(useReferences=>({pipeline,sourceMode,useReferences}))));
export const h3UploadTitle='IPC fixture: MiniMax H3 uploads dock references and pins continuity clips ($pipeline / $sourceMode / references=$useReferences)';
export const h3UploadTimeout=10000;
export const h3UploadCase=async({pipeline,sourceMode,useReferences}:typeof h3UploadCases[number])=>{
 const selected=sourceMode!=='new';const video=sourceMode==='video';const videoId='a'.repeat(64);
 const ref2va=pipeline==='v2v'||pipeline==='ref2v';const mode=ref2va?'REF2VA':pipeline==='i2v'?'I2VA':'T2VA';
 const outputMode=sourceMode==='checkpoint'?'segment':'full';
 vi.mocked(prepareH3Video).mockResolvedValue({sourceId:videoId,filename:'clips/source.mp4',sha256:'b'.repeat(64),width:1920,height:1080,fps:24,seconds:8,hasAudio:true});
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/diffusion_models/MiniMaxH3/h3.safetensors',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 vi.mocked(uploadInput).mockImplementation(async(_endpoint,path)=>path.endsWith('.mp4')?'deas-inputs/clip.mp4':'deas-inputs/u1.png');
 const expectedMedia=pipeline==='v2v'?[{type:'video',file:'deas-inputs/clip.mp4',slot:0,mediaMode:'video'}]:[
  {type:'image',file:'deas-inputs/u1.png',slot:0},
  {type:'video',file:'deas-inputs/clip.mp4',slot:0,mediaMode:'video',trimStart:1,trimEnd:4.5}];
 const expectedRefmods=[{slot:1,name:'chars/hero',strength:0.6,description:'the hero'}];
 let n=0;
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:`h3-${++n}`,baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false}));
 let peerObserved=false;
 vi.mocked(pollWorkbench).mockImplementation(async()=>{
  const submitted=await Promise.all(vi.mocked(runWorkbenchJob).mock.results.map(async result=>await result.value));
  if(submitted.at(-1)?.id==='h3-2'&&!peerObserved){peerObserved=true;return collection([heldJob('unrelated-success','succeeded'),heldJob('unrelated-failure','failed'),...submitted]);}
  return collection([heldJob('unrelated-success','succeeded'),heldJob('unrelated-failure','failed'),...submitted.map(job=>({...job,state:'succeeded' as const}))]);
 });
 vi.mocked(readH3Session).mockImplementation(async()=>({latestId:null,clips:[{clipId:'chosen',parent:null,frames:124,completed:0,export:null},{clipId:'backend-import',parent:null,frames:192,completed:0,export:null,importedVideo:{sourceId:videoId,width:1024,height:768,modeFamily:ref2va?'ref2va':'fl2va'}},{clipId:'root1',parent:video?'backend-import':selected?'chosen':null,frames:124,completed:1,export:null},{clipId:'kid1',parent:'root1',frames:200,completed:2,export:null}]}));
 const view=render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));
 await waitFor(()=>expect(pipe('Image → Video').disabled).toBe(false));
 choosePipe('Text → Video');
 if(pipeline==='i2v'){fireEvent.click(menuOf('ref.png').getByRole('menuitem',{name:'Use as first frame'}));const ref=screen.getByRole('img',{name:'ref.png'});Object.defineProperties(ref,{naturalWidth:{value:1024},naturalHeight:{value:768}});fireEvent.load(ref);}
 if(pipeline==='v2v'){
  fireEvent.click(screen.getByRole('button',{name:'clip.mp4'}));adopt();loadVideo('clip.mp4');
  fireEvent.change(screen.getByLabelText('Width'),{target:{value:'1024'}});
  fireEvent.change(screen.getByLabelText('Height'),{target:{value:'768'}});
 }
 if(pipeline==='ref2v'){
  fireEvent.click(menuOf('ref.png').getByRole('menuitem',{name:'Add as reference'}));
  fireEvent.click(menuOf('clip.mp4').getByRole('menuitem',{name:'Add as reference'}));
  dock('References');
  fireEvent.click(screen.getByRole('button',{name:'Edit clip.mp4'}));
  fireEvent.change(screen.getByLabelText('Start of clip.mp4'),{target:{value:'1'}});
  fireEvent.change(screen.getByLabelText('End of clip.mp4'),{target:{value:'4.5'}});
  fireEvent.click(within(screen.getByRole('dialog',{name:'Edit clip.mp4'})).getByRole('button',{name:'Close'}));
  vi.mocked(readRefMods).mockResolvedValue([{name:'chars/hero',kinds:['image'],description:'the hero'}]);
  fireEvent.click(screen.getByRole('button',{name:'Read RefMod library'}));
  fireEvent.click(await screen.findByRole('button',{name:'Add RefMod'}));
  fireEvent.change(screen.getByLabelText('Strength of chars/hero'),{target:{value:'0.6'}});
 }
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'fixed'}});
 fireEvent.change(screen.getByLabelText('Width'),{target:{value:'1024'}});
 fireEvent.change(screen.getByLabelText('Height'),{target:{value:'768'}});
 expect(screen.getByRole('button',{name:'Continuity · off'})).toBeTruthy();
 expect((screen.getByLabelText('FPS') as HTMLInputElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 if(pipeline==='t2v')expect(uploadInput).not.toHaveBeenCalled();
 else expect(uploadInput).toHaveBeenCalledWith('http://127.0.0.1:7801',`/env/ComfyUI/input/${pipeline==='v2v'?'clip.mp4':'ref.png'}`);
 const first=vi.mocked(runWorkbenchJob).mock.calls[0][1] as unknown as {frames:number;h3:object;firstFrame?:string};
 expect(first).toMatchObject({family:'minimax-h3',frames:124,frameRate:24,h3:{mode,references:pipeline==='i2v'?[{slot:0,image:'deas-inputs/u1.png'}]:[]}});
 if(ref2va)expect(first).toMatchObject({h3:{media:expectedMedia}});
 if(pipeline==='ref2v')expect(first).toMatchObject({h3:{refmods:expectedRefmods}});
 expect(first.firstFrame).toBeUndefined();
 expect((first.h3 as {continuity?:object}).continuity).toBeUndefined();
 expect(readH3Session).not.toHaveBeenCalled();
 await waitFor(()=>expect(screen.getAllByText('Succeeded').length).toBeGreaterThan(0),{timeout:4000});
 if(pipeline==='v2v'&&selected){
  fireEvent.click(document.querySelector('[data-preview-close]')!);
  expect(document.querySelector('[data-editor-viewport]')).toBeNull();
  expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false); // closing the preview never removes its explicit reference role
 }
 fireEvent.click(screen.getByRole('button',{name:'Continuity · off'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'Continuity active'}));
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
 fireEvent.change(screen.getByRole('combobox',{name:'Output'}),{target:{value:outputMode}});
 if(useReferences)fireEvent.click(screen.getByRole('checkbox',{name:'Use current references for continuations'}));
 fireEvent.click(screen.getByRole('button',{name:'Add step'}));fireEvent.click(screen.getByRole('button',{name:'Add step'}));
 if(ref2va)fireEvent.change(document.querySelector('[data-step="0"] input[type="number"]')!,{target:{value:'6'}});
 const uploadsBeforePlan=vi.mocked(uploadInput).mock.calls.length;
 fireEvent.change(screen.getAllByLabelText('Next action')[0],{target:{value:'she turns around'}});
 fireEvent.change(screen.getByRole('combobox',{name:'Overlap (frames)'}),{target:{value:'56'}});
 fireEvent.click(screen.getByRole('button',{name:'Run all'}));
 expect((screen.getByRole('combobox',{name:'Overlap (frames)'}) as HTMLSelectElement).disabled).toBe(true);
 fireEvent.click(within(screen.getByRole('dialog',{name:'Continuity'})).getByRole('button',{name:'Close'}));
 expect(screen.queryByRole('dialog',{name:'Continuity'})).toBeNull();
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(3),{timeout:5000});
 fireEvent.click(screen.getByRole('button',{name:'Continuity'}));
 const steps=vi.mocked(runWorkbenchJob).mock.calls.slice(1).map(c=>(c[1] as unknown as {h3:{continuity:{sourceId:string;action:string;capture:boolean}}}).h3.continuity);
 expect(steps[0]).toMatchObject({session:'Named_session-1',sourceId:video?videoId:selected?'chosen':'',capture:true,action:selected?'she turns around':'',outputMode});
 if(video)expect(steps[0]).toMatchObject({sourceKind:'video',overlapFrames:56});
 if(selected)expect(steps[0]).toMatchObject({overlapFrames:56});
 expect(Object.hasOwn(steps[0],'overlapFrames')).toBe(selected);
 expect(Object.hasOwn(steps[0],'sourceKind')).toBe(video);
 expect(Object.hasOwn(steps[1],'sourceKind')).toBe(false);
 expect(steps[1]).toMatchObject({session:'Named_session-1',sourceId:'root1',capture:true,action:selected?'':'she turns around',outputMode,overlapFrames:56});
 const planned=vi.mocked(runWorkbenchJob).mock.calls.slice(1).map(call=>call[1] as unknown as {h3:{mode:string;media?:object[];refmods?:object[];continuity:{useReferences?:boolean}}});
 for(const [index,intent] of planned.entries()){
  expect(intent.h3.mode).toBe(mode);
  if(ref2va){
   if(selected||index>0)expect(intent.h3.continuity).toHaveProperty('durationSeconds',index===0?6:5);
   else expect(intent.h3.continuity).not.toHaveProperty('durationSeconds');
   const keepRefs=!selected&&index===0||useReferences;
   if(useReferences&&(selected||index>0))expect(intent.h3.continuity.useReferences).toBe(true);
   else expect(intent.h3.continuity).not.toHaveProperty('useReferences');
   expect(intent.h3.media).toEqual(keepRefs?expectedMedia:[]);
   if(pipeline==='ref2v'&&keepRefs)expect(intent.h3.refmods).toEqual(expectedRefmods);
   else expect(intent.h3).not.toHaveProperty('refmods');
  }
 }
 if(ref2va)expect(uploadInput).toHaveBeenCalledTimes(uploadsBeforePlan+(useReferences?2:!selected?1:0)*(pipeline==='ref2v'?2:1));
 expect((screen.getByRole('combobox',{name:'Overlap (frames)'}) as HTMLSelectElement).value).toBe('56');
 await waitFor(()=>expect(document.querySelector('[data-step="1"] .wb-cont-state')?.textContent).toContain('kid1'),{timeout:5000});
 expect(readH3Session).toHaveBeenCalledWith('http://127.0.0.1:7801/','Named_session-1');
 expect(peerObserved).toBe(true);
 const pinned=JSON.parse(localStorage.getItem('deas.pref.studio.run.continuity')!);
 expect(pinned.steps.filter((s:{jobId?:string})=>s.jobId).map((s:{jobId:string})=>s.jobId)).toEqual(['h3-2','h3-3']);
 expect(pinned.steps.map((s:{clipId?:string})=>s.clipId)).toEqual(['root1','kid1']);
 expect((screen.getByRole('textbox',{name:'Session name'}) as HTMLInputElement).value).toBe('Named_session-1');
 if(selected){
  fireEvent.click(screen.getByRole('button',{name:'Add step'}));
  expect((screen.getByRole('button',{name:'Run next'}) as HTMLButtonElement).disabled).toBe(false);
  view.rerender(<I18nProvider><Workbench endpoint="http://127.0.0.1:7802" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
  expect((screen.getByRole('button',{name:'Run next'}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('Backend changed');
  expect(runWorkbenchJob).toHaveBeenCalledTimes(3);
 }
};
