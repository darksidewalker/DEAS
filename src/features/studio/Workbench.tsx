import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import type { DiagnosticImageIntentV1, RecipeAllowlist } from '../../lib/execution';
import { prepareDiagnosticJob, submitDiagnosticJob, readDiagnosticJobStatus, uploadMask, type JobStatus } from '../../lib/jobs';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels, type LocalModel } from '../../lib/models';
import { MediaLibrary, type MediaRoots } from '../media/MediaLibrary';
import type { MediaItem } from '../../lib/media';
import { isBoolean, isString, oneOf, readPref, usePref } from '../../lib/preferences';
import { JobOutputPreview } from './JobOutputPreview';
import { GenerationMetadata } from './GenerationMetadata';
import type { GenerationSettings } from '../../lib/imageMetadata';
import { outputNamingTemplate, outputPrefix } from '../../lib/outputNaming';
import { OptionsPanel, defaultOptions, isOptionsPref, parseSigmas, runOptions } from './OptionsPanel';
import builtinFamilies from '../../families/builtin.json';
import { aspects, resolutions, scalingModes, canvasSize, scaleInput, validCanvas, type Size, type ScalingMode } from '../../lib/resolution';
import { StudioImageEditor, type EditorHandle } from './StudioImageEditor';
import { ForgeButton } from '../forge/ForgeButton';
import { dialectOf } from '../../lib/forge';
import { WildcardPanel } from '../wildcards/WildcardPanel';
import { defaultWildcard, isWildcardRules } from '../../lib/wildcard';
import { visibleImages, type ImageLayer } from './imageEditor';
import './workbench.css';
/** Data-only family plugin (also read natively for header detection): loader, runnable pipelines, encoder/VAE file patterns, starting settings. */
interface Family { id:string; name:string; multiple?:number; loader:string; pipelines:string[]; clipType?:string; textEncoders?:string[]; vaes?:string[]; defaults?:{width:number;height:number;steps:number;cfg:number;sampler:string;scheduler:string}; sigmas?:number[]; loraFamily?:string }
const families=new Map((builtinFamilies as Family[]).map(f=>[f.id,f]));
const modelCategories=['checkpoints','diffusion_models','unet'];
type Lora={name:string;strength:number};
const isLoras=(v:unknown):v is Lora[]=>Array.isArray(v)&&v.every(l=>l&&typeof l.name==='string'&&typeof l.strength==='number');
const isNumber=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const isMaskGrow=(v:unknown):v is number=>isNumber(v)&&Number.isInteger(v)&&v>=0&&v<=512;
const isMaskBlur=(v:unknown):v is number=>isMaskGrow(v)&&v<=31;
const clamp=(n:number,min:number,max:number)=>Math.min(max,Math.max(min,n));
const randomSeed=()=>Math.floor(Math.random()*2**32);
const isSeed=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const isSeeds=(v:unknown):v is number[]=>Array.isArray(v)&&v.length<=10&&v.every(isSeed);
const dockTabs=['media','models','loras','wildcards','post','options'] as const;
/** Pipeline taxonomy. Only `t2i`/`i2i` have a verified native recipe today; the video ones stay listed but disabled until one exists. */
const pipelines=['t2i','i2i','t2v','i2v','v2v','ref2v'] as const;
type Pipeline=typeof pipelines[number];
/** Edits of the shown image: plain image-to-image (`resample`) or inpaint; refine/upscale live in the Post-Processing tab. */
const editModes=['resample','inpaint'] as const;
export interface WorkbenchProps { endpoint:string; /** Environment folders: models are listed directly from disk (without it the running backend is asked), output enables direct previews of finished files. */ roots?:MediaRoots&{models?:string}; /** Environment root for Prompt Forge (its saved LLM endpoint). */ root?:string; /** Prompts sent from the Prompt Forge tab; `n` changes per send. */ incoming?:{positive:string;negative:string;n:number} }
/** Text-to-image workbench: settings left, preview over the prompts, queue right, bottom dock with Media · Models · LoRAs tabs. */
export function Workbench({endpoint,roots={},root,incoming}:WorkbenchProps){
 const {t}=useI18n();const native=isTauri();const modelsDir=roots.models;const outputDir=roots.output;
 const [media,setMedia]=useState<MediaItem|null>(null);
 const [outputRevision,setOutputRevision]=useState(0);
 const [dockTab,setDockTab]=usePref('studio.dock.tab','media',oneOf(...dockTabs));
 const openWildcards=()=>{setDockTab('wildcards');document.querySelector<HTMLButtonElement>('[data-dock-tab="wildcards"]')?.focus();};
 const [dockHeight,setDockHeight]=usePref('studio.dock.height',220,isNumber);
 const [sortPref,setSort]=usePref('studio.dock.sort','date',oneOf('date','name','size'));
 const [query,setQuery]=useState('');
 const [models,setModels]=useState<LocalModel[]|null>(null);
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const [positive,setPositive]=usePref('studio.run.positive','',isString);
 const [negative,setNegative]=usePref('studio.run.negative','',isString);
 const [wildcard,setWildcard]=usePref('studio.run.wildcard',defaultWildcard,isWildcardRules);
 const [wildcardEnabled,setWildcardEnabled]=usePref('studio.run.wildcardEnabled',false,isBoolean);
 useEffect(()=>{if(incoming){setPositive(incoming.positive);if(incoming.negative.trim())setNegative(incoming.negative);}},[incoming?.n]); // eslint-disable-line react-hooks/exhaustive-deps
 const [checkpointPref,setCheckpoint]=usePref('studio.run.checkpoint','',isString);
 const [loras,setLoras]=usePref<Lora[]>('studio.run.loras',[],isLoras);
 const [width,setWidth]=usePref('studio.run.width',1024,isNumber);
 const [height,setHeight]=usePref('studio.run.height',1024,isNumber);
 const [aspectPref,setAspect]=usePref('studio.run.aspect','auto',oneOf(...aspects));
 const [resolutionPref,setResolution]=usePref('studio.run.resolution',readPref('studio.run.resolution','',isString)==='auto'?'model':readPref('studio.run.width',0,isNumber)?'fixed':'model',oneOf('fixed','model','custom',...Object.keys(resolutions)));
 const [aspectWidth,setAspectWidth]=usePref('studio.run.aspectWidth',16,isNumber);
 const [aspectHeight,setAspectHeight]=usePref('studio.run.aspectHeight',9,isNumber);
 const [megapixels,setMegapixels]=usePref('studio.run.megapixels',1,isNumber);
 const [inputScaling,setInputScaling]=usePref<ScalingMode>('studio.run.inputScaling','off',oneOf(...scalingModes));
 const [mediaSize,setMediaSize]=useState<(Size&{src:string})|null>(null);
 const [steps,setSteps]=usePref('studio.run.steps',20,isNumber);
 const [cfg,setCfg]=usePref('studio.run.cfg',5,isNumber);
 const [sampler,setSampler]=usePref('studio.run.sampler','euler',isString);
 const [scheduler,setScheduler]=usePref('studio.run.scheduler','normal',isString);
 const [textEncoderPref,setTextEncoder]=usePref('studio.run.textEncoder','',isString);
 const [vaePref,setVae]=usePref('studio.run.vae','',isString);
 // Sampler/scheduler choices are whatever the running backend lists (read-only object_info); read once per endpoint, before a picker can open.
 const [choices,setChoices]=useState<RecipeAllowlist|null>(null);
 const [optionsPref,setOptions]=usePref('studio.run.options',defaultOptions,isOptionsPref);
 const [seed,setSeed]=usePref('studio.run.seed',randomSeed(),isSeed);
 const [seedMode,setSeedMode]=usePref('studio.run.seedMode','random',oneOf('random','fixed'));
 const [recentSeeds,setRecentSeeds]=usePref<number[]>('studio.run.recentSeeds',[],isSeeds);
 const [copyStatus,setCopyStatus]=useState('');
 const fixedSeed=(value:number)=>{setSeed(value);setSeedMode('fixed');};
 const copySeed=async(value:number)=>{try{await navigator.clipboard.writeText(String(value));setCopyStatus(t('studio.run.seedCopied'));}catch{setCopyStatus(t('studio.run.seedCopyFailed'));}};
 const [denoise,setDenoise]=usePref('studio.run.denoise',0.6,isNumber);
 const [pipelinePref,setPipeline]=usePref<Pipeline>('studio.run.pipeline','t2i',oneOf(...pipelines));
 const [edit,setEdit]=usePref('studio.run.edit','resample',oneOf(...editModes));
 // Post-Processing (SwarmUI Refine / Upscale): opt-in second pass after every run, or applied alone to the shown image.
 const [post,setPost]=usePref('studio.run.post',false,isBoolean);
 const [refineDenoise,setRefineDenoise]=usePref('studio.run.refineDenoise',0.25,isNumber);
 const [upscale,setUpscale]=usePref('studio.run.upscale',1,isNumber);
 const [upscaleModelPref,setUpscaleModel]=usePref('studio.run.upscaleModel','',isString);
 const [inpaintDenoise,setInpaintDenoise]=usePref('studio.run.inpaintDenoise',0.8,isNumber);
 const [inpaintOnlyMasked,setInpaintOnlyMasked]=usePref('studio.run.inpaintOnlyMasked',false,isBoolean);
 const [maskGrow,setMaskGrow]=usePref('studio.run.maskGrow',8,isMaskGrow);
 const [maskBlur,setMaskBlur]=usePref('studio.run.maskBlur',0,isMaskBlur);
 const [masked,setMasked]=useState(false);
 const editorRef=useRef<EditorHandle>(null);
 const sourceEpoch=useRef(0);
 const [strength,setStrength]=edit==='inpaint'?[inpaintDenoise,setInpaintDenoise]:[denoise,setDenoise];
 // Source image of each edit job, for the original/edited split view.
 const [sources,setSources]=useState<Record<string,string>>({});const [slider,setSlider]=useState(false);const [divide,setDivide]=useState(50);
 const [jobs,setJobs]=useState<JobStatus[]>([]);const [selectedJob,setSelectedJob]=useState('');
 const live=useRef(false);const lock=useRef(false);const epoch=useRef(0);
 const loadChoices=()=>{if(native&&!choices&&endpoint.trim())checkRecipePrerequisites(endpoint).then(e=>{if(live.current)setChoices(e.allowlist);},()=>{});};
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 // A native <select> opens synchronously on the first click; a list fetched on that click only shows on the second one.
 useEffect(()=>{setChoices(null);if(native&&endpoint.trim())checkRecipePrerequisites(endpoint).then(e=>{if(live.current)setChoices(e.allowlist);},()=>{});},[native,endpoint]);
 // Models come from the environment's models folder (read-only scan, no backend probe); the backend list is the fallback.
 async function load(){
  if(!native||lock.current||(!modelsDir&&!endpoint.trim()))return;
  lock.current=true;setBusy(true);setError('');const version=++epoch.current;
  try{
   const next=modelsDir?await scanModels(modelsDir)
    :await checkRecipePrerequisites(endpoint).then(e=>{setChoices(e.allowlist);return [...e.allowlist.checkpoints.map(name=>({category:'checkpoints',name})),...(e.allowlist.loras??[]).map(name=>({category:'loras',name}))].map(m=>({...m,path:'',size:0,info:null}));});
   if(live.current&&version===epoch.current)setModels(next);
  }catch(e){if(live.current&&version===epoch.current)setError(e instanceof Error?e.message:String(e));}
  finally{lock.current=false;if(live.current)setBusy(false);}
 }
 useEffect(()=>{setModels(null);if(modelsDir)void load();},[modelsDir]); // eslint-disable-line react-hooks/exhaustive-deps
 // Remembered picks are only valid while the folder still holds them.
 const byName=(a:LocalModel,b:LocalModel)=>a.name.localeCompare(b.name);
 const familyOf=(m?:LocalModel)=>m?.family?families.get(m.family):undefined;
 // Diffusion-model families need a separate text encoder and VAE, found by file-name pattern.
 // shortcut: name patterns, not header checks; upgrade when two families share an encoder name.
 const files=(categories:string[],patterns:string[]=[])=>(models??[]).filter(m=>categories.includes(m.category)&&patterns.some(p=>(m.name.split('/').pop()??'').toLowerCase().includes(p))).map(m=>m.name).sort();
 const parts=(f?:Family)=>f?.loader==='diffusion'?{encoders:files(['text_encoders','clip'],f.textEncoders),vaes:files(['vae'],f.vaes)}:null;
 // Unknown checkpoints stay usable (self-contained loader, like SwarmUI); everything else must be a known family with a recipe for the pipeline.
 const blocked=(m:LocalModel,p:Pipeline):string=>{
 const f=familyOf(m);
 if(!f)return m.category==='checkpoints'&&(p==='t2i'||p==='i2i')?'':'studio.run.family.unknown';
 if(!f.pipelines.includes(p))return 'studio.run.pipe.noRecipe';
 const s=parts(f);return s&&(!s.encoders.length||!s.vaes.length)?'studio.run.family.noEncoder':'';
 };
 const allModels=(models??[]).filter(m=>modelCategories.includes(m.category)).sort(byName);
 // Dock search/sort are display-only: the pick logic keeps the name-sorted lists. Models have no date, so that option exists for media only.
 const sorts=dockTab==='media'?['date','name','size'] as const:['name','size'] as const;
 const sort=(sorts as readonly string[]).includes(sortPref)?sortPref:sorts[0];
 const [folders,setFolders]=useState<Record<string,string>>({});const folder=folders[dockTab]??'';
 const match=(m:LocalModel)=>(!folder||m.name.startsWith(folder+'/'))&&m.name.toLowerCase().includes(query.trim().toLowerCase());
 // Model names carry their subfolders (`sdxl/base.safetensors`); the tree is those prefixes, always open, filtering the tiles beside it.
 const folderTree=(list:LocalModel[])=>{
  const dirs=new Set(list.flatMap(m=>m.name.split('/').slice(0,-1).map((_,i,p)=>p.slice(0,i+1).join('/'))));
  const node=(path:string,label:string):React.ReactNode=><li key={path}><div className="media-folder-row"><button type="button" className="media-folder-name" aria-current={folder===path?'location':undefined} onClick={()=>setFolders({...folders,[dockTab]:path})}>{label}</button></div>
   <ul>{[...dirs].filter(d=>d.slice(0,Math.max(d.lastIndexOf('/'),0))===path).sort().map(d=>node(d,d.slice(d.lastIndexOf('/')+1)))}</ul></li>;
  return dirs.size>0&&<nav className="media-folders" aria-label={t('media.folders')}><ul>{node('',t(`studio.run.dock.${dockTab}`))}</ul></nav>;
 };
 const bySort=(a:LocalModel,b:LocalModel)=>sort==='size'?b.size-a.size:byName(a,b);
 // ComfyUI's LoadImage reads its input folder, and its output folder through the `name [output]` annotation (resolved and contained by ComfyUI).
 const under=(item:MediaItem|null,root?:string)=>item?.media==='image'&&item.path&&root&&item.path.startsWith(root+'/')?item.path.slice(root.length+1):'';
 const comfyName=(item:MediaItem|null)=>under(item,roots.input)||(under(item,outputDir)&&`${under(item,outputDir)} [output]`);
 const inputImage=comfyName(media);
 // Extra images pasted onto the source (SwarmUI editor image layers), in source pixels; they belong to one source.
 const [layers,setLayers]=useState<ImageLayer[]>([]);const [inserting,setInserting]=useState(false);
 const why=(id:Pipeline):string=>!allModels.some(m=>!blocked(m,id))?(id==='t2i'||id==='i2i'?'studio.run.noModels':'studio.run.pipe.noRecipe'):id==='i2i'&&!inputImage?'studio.run.pipe.needsInput':'';
 const pipeline:Pipeline=why(pipelinePref)?'t2i':pipelinePref;
 const mediaPipeline=!pipeline.startsWith('t2');
 const aspect=aspectPref==='auto'&&!mediaPipeline?'1:1':aspectPref;
 // Remembered picks are only valid while the folder still holds them and they fit the pipeline.
 const usable=allModels.filter(m=>!blocked(m,pipeline));
 const model=usable.find(m=>m.name===checkpointPref)??usable[0];
 const checkpoint=model?.name??'';
 const family=familyOf(model);
 const resolution=resolutionPref==='model'&&!family?.defaults?'fixed':resolutionPref;
 const split=parts(family);
 const textEncoder=split?.encoders.includes(textEncoderPref)?textEncoderPref:split?.encoders[0]??'';
 const vae=split?.vaes.includes(vaePref)?vaePref:split?.vaes[0]??'';
 // LoRAs of another known family are hidden; unknown ones stay (their target cannot be checked).
 const loraModels=(models??[]).filter(m=>m.category==='loras'&&(!family||!m.family||m.family===(family.loraFamily??family.id))).sort(byName);
 // A custom schedule (Options tab text, else the model's own, e.g. Turbo) replaces steps/scheduler; image-to-image keeps its tail like AlignYourSteps does (round(steps·denoise) steps).
 const schedule=parseSigmas(optionsPref.sigmas??'')??family?.sigmas;
 const tail=(d:number)=>schedule&&schedule.slice(-(Math.max(1,Math.round((schedule.length-1)*d))+1));
 const sigmas=schedule&&(pipeline==='i2i'?tail(strength):schedule);
 // Unread lists keep the remembered model; native preparation rejects one the backend no longer lists.
 const upscaleModel=!choices||choices.upscaleModels?.includes(upscaleModelPref)?upscaleModelPref:'';
 const loraNames=loraModels.map(m=>m.name);
 const activeLoras=loras.filter(l=>loraNames.includes(l.name));
 const options=runOptions(optionsPref,choices);
 const source=mediaSize&&mediaSize.src===media?.src?mediaSize:undefined;
 const modelSize=family?.defaults??{width:1024,height:1024};
 // Canvas edges snap to the family's latent/patch multiple (SDXL: 64 buckets, H3/LTX: 32); unknown models use the safe 16.
 const grid=family?.multiple??16;
 const canvas=canvasSize(aspect,resolution,{width:aspectWidth,height:aspectHeight},megapixels,{width,height},modelSize,mediaPipeline?source:undefined,grid);
 // Post-processing scales both edges and snaps each to the model grid.
 const up=(s:Size):Size=>({width:Math.max(grid,Math.round(s.width*upscale/grid)*grid),height:Math.max(grid,Math.round(s.height*upscale/grid)*grid)});
 const inpaint=pipeline==='i2i'&&edit==='inpaint';
 const scaled=pipeline!=='i2i'||!source?null:scaleInput(inpaint?'off':inputScaling,source,canvas,grid);
 const editableSource=media?.media==='image'&&source&&validCanvas(source)?source:null;
 const outputSize=inpaint&&source?source:(scaled?.size??canvas);
 const sizeError=inpaint&&source&&(!validCanvas(source)||source.width%grid!==0||source.height%grid!==0)?'studio.editor.sourceSize'
  :!validCanvas(outputSize)?'studio.run.resolution.invalid'
  :pipeline==='i2i'&&!source?'studio.run.resolution.waiting'
  :mediaPipeline&&aspect==='auto'&&resolution!=='fixed'&&media&&media.media!=='audio'&&!source?'studio.run.resolution.waiting':'';
 const ratio=aspect==='auto'?(source?source.width/source.height:1):aspect==='custom'?aspectWidth/aspectHeight:Number(aspect.split(':')[0])/Number(aspect.split(':')[1]);
 const swatchRatio=Number.isFinite(ratio)&&ratio>0?ratio:1;
 const readMediaSize=(width:number,height:number)=>{if(media&&width>0&&height>0)setMediaSize({src:media.src,width,height});};
 const current=jobs.find(j=>j.state==='queued'||j.state==='running');
 const replace=(next:JobStatus)=>setJobs(list=>list.map(j=>j.id===next.id?next:j));
 /** `only` = Post-process: the refine/upscale pass alone on that image (an image-to-image job), without a first generation. */
 async function run(only?:{image:string;size:Size;src:string}){
  if(!native||lock.current||current)return;
  if(!checkpoint){setError(t('studio.run.noModels'));return;}
  const editing=!only&&inpaint;
  if(!only&&sizeError){setError(t(sizeError));return;}
  if(editing&&!masked){setError(t('studio.run.edit.needsMask'));return;}
  const target=up(only?only.size:outputSize);
  if((post||only)&&!validCanvas(target)){setError(t('studio.run.resolution.invalid'));return;}
  const naming=outputPrefix(outputNamingTemplate(optionsPref.outputNaming),{type:'image',seed,model:checkpoint});
  if(naming===null){setError(t('studio.run.opt.outputNaming.invalid'));return;}
  const inputLayers=visibleImages(layers);
  const refineSigmas=tail(refineDenoise);
  const common={recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:positive,negativePrompt:negative,checkpoint,seed,cfg,sampler,scheduler,outputPrefix:naming,...(wildcardEnabled?{wildcard:structuredClone(wildcard)}:{}),...(activeLoras.length?{loras:activeLoras}:{}),...(split&&family?.clipType?{diffusion:{textEncoder,clipType:family.clipType,vae}}:{}),...(options?{options}:{})} as const;
  const resized=!!upscaleModel||target.width!==only?.size.width||target.height!==only?.size.height;
  const intent:DiagnosticImageIntentV1=Object.freeze(only
   ?{...common,width:target.width,height:target.height,steps:refineSigmas?refineSigmas.length-1:steps,...(refineSigmas?{sigmas:refineSigmas}:{}),inputImage:only.image,denoise:refineDenoise,...(resized?{inputResize:{...target,crop:'disabled' as const}}:{}),...(upscaleModel?{upscaleModel}:{})}
   :{...common,width:outputSize.width,height:outputSize.height,steps:sigmas?sigmas.length-1:steps,...(sigmas?{sigmas}:{}),...(pipeline==='i2i'?{inputImage,denoise:strength,...(scaled?.resize?{inputResize:scaled.resize}:{}),...(inputLayers.length?{inputLayers}:{})}:{}),
    ...(post?{refine:{...target,denoise:refineDenoise,...(upscaleModel?{upscaleModel}:{}),...(refineSigmas?{sigmas:refineSigmas}:{})}}:{})});
  const from=only?.src??(pipeline==='i2i'?media?.src:undefined);
  lock.current=true;setBusy(true);setError('');
  try{
   // Capture geometry and PNG before any async upload; subsequent edits belong to the next job.
   const bounds=editing&&inpaintOnlyMasked?editorRef.current?.maskBounds(maskGrow+maskBlur):null;
   const target=bounds?canvasSize('auto','model',bounds,1,bounds,modelSize,bounds,grid):null;
   if(target&&!validCanvas(target))throw new Error(t('studio.run.resolution.invalid'));
   const inpaintCrop=bounds&&target?{...bounds,targetWidth:target.width,targetHeight:target.height}:null;
   const maskSnapshot=editing?editorRef.current?.maskPng():null;
   if(editing&&!maskSnapshot)throw new Error(t('studio.run.edit.needsMask'));
   const inputMask=maskSnapshot?await uploadMask(endpoint,await maskSnapshot):null;
   const plan=await prepareDiagnosticJob(endpoint,inputMask?Object.freeze({...intent,inputMask,...(maskBlur?{maskBlur}:{}),...(inpaintCrop?{inpaintCrop}:{})}):intent); // native: validates against the running backend's object_info
   const job=await submitDiagnosticJob(plan.id); // the Run click is the authorization
   if(live.current){setJobs(list=>[job,...list].slice(0,20));setSelectedJob(job.id);if(from)setSources(s=>({...s,[job.id]:from}));setRecentSeeds(list=>[intent.seed,...list.filter(s=>s!==intent.seed)].slice(0,10));if(seedMode==='random')setSeed(randomSeed());}
  }catch(e){if(live.current)setError(e instanceof Error?e.message:String(e));}
  finally{lock.current=false;if(live.current)setBusy(false);}
 }
 useEffect(()=>{
  if(!current||!native)return;
  const timer=window.setTimeout(async()=>{
   try{const next=await readDiagnosticJobStatus(current.id);if(!live.current)return;replace(next);if(next.state==='succeeded')setOutputRevision(r=>r+1);}
   catch(e){if(live.current){replace({...current,state:'unknown',error:e instanceof Error?e.message:String(e)});}}
  },1000);
  return()=>window.clearTimeout(timer);
 },[current,native]); // eslint-disable-line react-hooks/exhaustive-deps
 // Picking media on the strip takes over the preview until the next job is selected; while inserting it adds a layer instead.
 const select=(item:MediaItem)=>{setSelectedJob('');setInserting(false);if(media?.src===item.src)return;sourceEpoch.current++;setMedia(item);setLayers([]);setMasked(false);};
 const pickMedia=(item:MediaItem)=>{
  if(!inserting||!source||!media){select(item);return;}
  const name=comfyName(item),version=sourceEpoch.current;setInserting(false);
  if(!name||item.media!=='image'||layers.length>=4){setError(t('studio.run.edit.insertHint'));return;}
  const probe=new Image();
  probe.onload=()=>{
   if(!live.current||sourceEpoch.current!==version)return;
   if(!(probe.naturalWidth>0&&probe.naturalHeight>0)){setError(t('studio.editor.insertFailed'));return;}
   const scale=Math.min(source.width/3/probe.naturalWidth,source.height/probe.naturalHeight,8192/probe.naturalWidth,8192/probe.naturalHeight);
   const width=Math.max(8,Math.round(probe.naturalWidth*scale)),height=Math.max(8,Math.round(probe.naturalHeight*scale));
   const layer:ImageLayer={id:crypto.randomUUID(),name,src:item.src,visible:true,width,height,x:Math.max(0,Math.round((source.width-width)/2)),y:Math.max(0,Math.round((source.height-height)/2))};
   setLayers(list=>list.length>=4?list:[...list,layer]);
  };
  probe.onerror=()=>{if(live.current&&sourceEpoch.current===version)setError(t('studio.editor.insertFailed'));};
  probe.src=item.src;
 };
 // Fit the workbench into the window: height = viewport minus everything above it and the footer, so nothing scrolls.
 const shell=useRef<HTMLDivElement>(null);const [fit,setFit]=useState<number|undefined>();
 useLayoutEffect(()=>{
  const measure=()=>{const el=shell.current;if(!el||!el.offsetParent)return;const top=el.getBoundingClientRect().top;const footer=document.querySelector<HTMLElement>('.footer')?.offsetHeight??0;setFit(Math.max(420,window.innerHeight-top-footer-12));};
  measure();if(typeof ResizeObserver==='undefined'){window.addEventListener('resize',measure);return()=>window.removeEventListener('resize',measure);}
  const ro=new ResizeObserver(measure);ro.observe(document.documentElement);return()=>ro.disconnect();
 },[]);
 // Drag the dock's top edge to show more or fewer previews.
 const dragDock=(e:React.PointerEvent<HTMLDivElement>)=>{
  const startY=e.clientY,start=dockHeight,max=Math.max(120,(shell.current?.clientHeight??600)-260);e.currentTarget.setPointerCapture(e.pointerId);
  const move=(ev:PointerEvent)=>setDockHeight(Math.min(max,Math.max(120,start+(startY-ev.clientY))));
  const stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);
 };
 const shown=jobs.find(j=>j.id===selectedJob)??null;
 const original=shown?sources[shown.id]:undefined;
 // Edit jobs open side by side: the live editor (masks/layers kept until a new image is sent to edit) left, the render right.
 const sideBySide=!!original&&!slider;
 const editorLeft=sideBySide&&original===media?.src&&!!editableSource;
 const fileSrc=(o:JobStatus['outputs'][number])=>outputDir?convertFileSrc([outputDir,o.subfolder,o.filename].filter(Boolean).join('/')):null;
 const num=(id:string,value:number,set:(n:number)=>void,min:number,max:number,step:number,fixed?:string)=><label key={id} className="wb-field"><span>{t(`studio.run.${id}`)}</span><input type="number" inputMode="numeric" value={value} min={min} max={max} step={step} disabled={!!fixed} title={fixed} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n))set(n);}}/></label>;
 const outputItem=(o:JobStatus['outputs'][number]):MediaItem=>({name:o.filename,media:'image',src:fileSrc(o)!,path:[outputDir,o.subfolder,o.filename].filter(Boolean).join('/')});
 // Post-process takes the shown render (its submitted size), else the current edit source.
 const shownOutput=shown?.state==='succeeded'&&outputDir&&shown.outputs[0]&&shown.intent?outputItem(shown.outputs[0]):null;
 const postSource=shownOutput&&shown?.intent?{image:comfyName(shownOutput),size:shown.intent.refine??shown.intent,src:shownOutput.src}
  :!shown&&inputImage&&source&&media?{image:inputImage,size:source,src:media.src}:null;
 // Floating edit buttons over an editable image: a mode makes it the image-to-image source and opens that mode's controls on the left.
 const noEditModel=!allModels.some(m=>!blocked(m,'i2i'));
 const tools=(item:MediaItem)=><div className="wb-edit-tools" role="toolbar" aria-label={t('studio.run.edit.title')}>
  {editModes.map(m=><button key={m} type="button" data-edit={m} aria-pressed={pipeline==='i2i'&&edit===m&&media?.src===item.src} disabled={noEditModel} title={noEditModel?t('studio.run.noModels'):undefined} onClick={()=>{if(media?.src!==item.src)select(item);setEdit(m);setPipeline('i2i');}}>{t(`studio.run.edit.${m}`)}</button>)}
  <button type="button" data-edit-insert aria-pressed={inserting&&media?.src===item.src} disabled={noEditModel} onClick={()=>{if(media?.src!==item.src){select(item);setInserting(true);}else setInserting(!inserting);if(pipeline!=='i2i'){setEdit('resample');setPipeline('i2i');}}}>{t('studio.run.edit.insert')}</button>
  {original&&media?.src!==item.src&&<button type="button" className="wb-edit-view" data-edit-compare aria-pressed={slider} onClick={()=>setSlider(!slider)}>{t('studio.run.edit.slider')}</button>}
 </div>;
 const toggleLora=(name:string,on:boolean)=>setLoras(on?[...loras.filter(l=>l.name!==name),{name,strength:1}]:loras.filter(l=>l.name!==name));
 // Picking a model applies its family's starting settings (SwarmUI: per-class defaults).
 const pickModel=(m:LocalModel)=>{setCheckpoint(m.name);setResolution('model');const d=familyOf(m)?.defaults;if(d){setWidth(d.width);setHeight(d.height);setSteps(d.steps);setCfg(d.cfg);setSampler(d.sampler);setScheduler(d.scheduler);}};
 // Explicit "use these settings": only values the metadata carries; a model/LoRA is picked only if this folder holds it (by full name, else by basename). Returns what was skipped.
 const base=(n:string)=>(n.split('/').pop()??n).replace(/\.(safetensors|sft|ckpt|pt|gguf)$/i,'').toLowerCase();
 const applySettings=(s:GenerationSettings):string[]=>{
  const skipped=[...(s.skipped??[])];
  setWildcardEnabled(!!s.wildcard&&isWildcardRules(s.wildcard));
  if(s.wildcard&&isWildcardRules(s.wildcard))setWildcard(structuredClone(s.wildcard));
  if(s.positive!==undefined)setPositive(s.positive);if(s.negative!==undefined)setNegative(s.negative);
  if(s.seed!==undefined&&isSeed(s.seed))fixedSeed(s.seed);if(s.steps!==undefined)setSteps(s.steps);if(s.cfg!==undefined)setCfg(s.cfg);
  // Backend lists are checked when already read; otherwise native preparation rejects an unknown name later.
  for(const [key,value,list,set] of [['sampler',s.sampler,choices?.samplers,setSampler],['scheduler',s.scheduler,choices?.schedulers,setScheduler]] as const){
   if(!value)continue;if(list&&!list.includes(value))skipped.push(`${t(key==='sampler'?'studio.recipe.sampler':'studio.recipe.scheduler')}: ${value}`);else set(value);
  }
  if(s.width&&s.height){setWidth(s.width);setHeight(s.height);setResolution('fixed');}
  if(s.checkpoint){const found=allModels.find(m=>m.name===s.checkpoint)??allModels.find(m=>base(m.name)===base(s.checkpoint!));if(found)setCheckpoint(found.name);else skipped.push(`${t('studio.run.checkpoint')}: ${s.checkpoint}`);}
  if(s.loras)setLoras(s.loras.flatMap(l=>{const m=loraModels.find(x=>x.name===l.name)??loraModels.find(x=>base(x.name)===base(l.name));if(!m)skipped.push(`LoRA: ${l.name}`);return m?[{name:m.name,strength:l.strength}]:[];}));
  return skipped;
 };
 const tile=(m:LocalModel,pressed:boolean,onClick:()=>void,extra?:React.ReactNode,reason='')=><li key={`${m.category}/${m.name}`}><button type="button" aria-pressed={pressed} disabled={!!reason} title={reason?t(reason):m.name} onClick={onClick}>{m.info?.civitai?.preview?<img src={m.info.civitai.preview} alt="" loading="lazy"/>:<span className="wb-thumb" aria-hidden="true">◆</span>}<span className="wb-tile-name">{m.name}</span>{familyOf(m)&&<small className="wb-family">{familyOf(m)!.name}</small>}</button>{extra}</li>;
 const pick=(id:string,value:string,list:readonly string[],set:(v:string)=>void,onFocus?:()=>void)=><label key={id} className="wb-field"><span>{t(id)}</span><select value={value} onFocus={onFocus} onPointerDown={onFocus} onChange={e=>set(e.target.value)}>{(list.includes(value)?list:[value,...list]).map(v=><option key={v} value={v}>{v}</option>)}</select></label>;
 return <div className="workbench" data-workbench ref={shell} style={{height:fit}}>
  <div className="wb-body">
   <aside className="wb-side">
    <section className="wb-settings" aria-label={t('studio.run.settings')}>
     <p className="wb-active"><span>{t('studio.run.checkpoint')}{family&&<> · {family.name}</>}</span><strong title={checkpoint}>{checkpoint||t('studio.run.noModels')}</strong><small>{t('studio.run.loras')} {activeLoras.length}</small></p>
     <div className="wb-pipelines" role="group" aria-label={t('studio.run.pipeline')}>{pipelines.map(id=>{const reason=why(id);return <button key={id} type="button" data-pipeline={id} aria-pressed={pipeline===id} disabled={!!reason} title={reason?t(reason):undefined} onClick={()=>setPipeline(id)}>{t(`studio.run.pipe.${id}`)}</button>;})}</div>
     {pipeline==='i2i'&&<p className="wb-active"><span>{t('studio.run.pipe.input')} · {t(`studio.run.edit.${edit}`)}</span><strong title={inputImage}>{inputImage}</strong></p>}
     <div className="wb-controls">
      {inpaint?<>{!masked&&<p className="wb-resolution-hint">{t('studio.run.edit.needsMask')}</p>}{num('denoise',strength,setStrength,0,1,0.05)}<p className="wb-resolution-hint">{t('studio.run.edit.size',{width:String(outputSize.width),height:String(outputSize.height)})}</p></>:<>
      <label className="wb-field"><span>{t('studio.run.resolution.aspect')}</span><span className="wb-aspect-picker"><span className="wb-aspect-swatch" aria-hidden="true"><span style={{width:18*Math.min(1,swatchRatio),height:18*Math.min(1,1/swatchRatio)}}/></span><select value={aspect} onChange={e=>{setAspect(e.target.value as typeof aspect);if(resolution==='fixed')setResolution('model');}}>{aspects.filter(a=>a!=='auto'||mediaPipeline).map(a=><option key={a} value={a}>{a==='auto'||a==='custom'?t(`studio.run.resolution.${a}`):a}</option>)}</select></span></label>
      <label className="wb-field"><span>{t('studio.run.resolution.title')}</span><select value={resolution} onChange={e=>setResolution(e.target.value)}>{['fixed','model',...Object.keys(resolutions),'custom'].map(r=><option key={r} value={r} disabled={r==='model'&&!family?.defaults}>{r in resolutions?r:t(`studio.run.resolution.${r}`)}</option>)}</select></label>
      {aspect==='custom'&&<>{num('resolution.aspectWidth',aspectWidth,setAspectWidth,1,100,0.1)}{num('resolution.aspectHeight',aspectHeight,setAspectHeight,1,100,0.1)}</>}
      {resolution==='custom'&&num('resolution.megapixels',megapixels,setMegapixels,0.01,16,0.05)}
      {num('width',canvas.width,n=>{setWidth(n);setHeight(canvas.height);setResolution('fixed');},64,8192,8)}{num('height',canvas.height,n=>{setHeight(n);setWidth(canvas.width);setResolution('fixed');},64,8192,8)}</>}
      {pipeline==='i2i'&&!inpaint&&<><label className="wb-field wb-wide"><span>{t('studio.run.resolution.scaling')}</span><select value={inputScaling} title={t(`studio.run.resolution.hint.${inputScaling}`)} onChange={e=>setInputScaling(e.target.value as ScalingMode)}>{scalingModes.map(s=><option key={s} value={s}>{t(`studio.run.resolution.scale.${s}`)}</option>)}</select></label><p className="wb-resolution-hint">{t(`studio.run.resolution.hint.${inputScaling}`)}</p>{num('denoise',denoise,setDenoise,0,1,0.05)}</>}
      {inpaint&&<>
       <label className="wb-field wb-wide" title={t('studio.run.maskGrowHelp')}><span><input type="checkbox" style={{width:'auto'}} checked={inpaintOnlyMasked} onChange={e=>setInpaintOnlyMasked(e.target.checked)}/>{t('studio.run.inpaintOnlyMasked')}</span></label>
       {inpaintOnlyMasked&&num('maskGrow',maskGrow,n=>{if(isMaskGrow(n))setMaskGrow(n);},0,512,1)}
       {num('maskBlur',maskBlur,n=>{if(isMaskBlur(n))setMaskBlur(n);},0,31,1)}
       <p className="wb-resolution-hint">{t('studio.run.maskBlurHelp')}</p>
      </>}
      {sizeError&&<p className="wb-resolution-hint error-message" role="status">{t(sizeError)}</p>}
      {num('steps',sigmas?sigmas.length-1:steps,setSteps,1,150,1,sigmas&&t('studio.run.customSchedule.hint'))}{num('cfg',cfg,setCfg,0,30,0.5)}
      {pick('studio.recipe.sampler',sampler,choices?.samplers??[],setSampler,loadChoices)}
      {sigmas?<label className="wb-field"><span>{t('studio.recipe.scheduler')}</span><select value="custom" disabled title={t('studio.run.customSchedule.hint')}><option value="custom">{t('studio.run.customSchedule')}</option></select></label>
       :pick('studio.recipe.scheduler',scheduler,choices?.schedulers??[],setScheduler,loadChoices)}
      {split&&<>{pick('studio.run.textEncoder',textEncoder,split.encoders,setTextEncoder)}{pick('studio.run.vae',vae,split.vaes,setVae)}</>}
      <div className="wb-field wb-seed">
       <label><span>{t('studio.run.seed')}</span><input aria-label={t('studio.run.seed')} type="number" inputMode="numeric" value={seed} min={0} max={Number.MAX_SAFE_INTEGER} step={1} onChange={e=>{const n=Number(e.target.value);if(isSeed(n))fixedSeed(n);}}/></label>
       <div className="wb-seed-row"><button type="button" aria-label={t('studio.run.seedDecrease')} onClick={()=>fixedSeed(seed===0?Number.MAX_SAFE_INTEGER:seed-1)}>−</button><button type="button" aria-label={t('studio.run.seedIncrease')} onClick={()=>fixedSeed(seed===Number.MAX_SAFE_INTEGER?0:seed+1)}>+</button>{(['random','fixed'] as const).map(mode=><button key={mode} type="button" aria-pressed={seedMode===mode} onClick={()=>setSeedMode(mode)}>{t(`studio.run.seedMode.${mode}`)}</button>)}<button type="button" aria-label={t('studio.run.newSeed')} title={t('studio.run.newSeed')} onClick={()=>setSeed(randomSeed())}>⟳</button></div>
       <button type="button" disabled={!recentSeeds.length} onClick={()=>fixedSeed(recentSeeds[0])}>{t('studio.run.seedLast')}</button>
       <details className="wb-seed-history"><summary>{t('studio.run.seedHistory')}</summary>{recentSeeds.map(value=><div className="wb-seed-row" key={value}><button type="button" aria-label={t('studio.run.seedUse',{seed:String(value)})} onClick={()=>fixedSeed(value)}>{value}</button><button type="button" aria-label={t('studio.run.seedCopy',{seed:String(value)})} onClick={()=>void copySeed(value)}>⧉</button></div>)}</details>
       {copyStatus&&<span role="status">{copyStatus}</span>}
      </div>
     </div>
     {!native&&<p className="field-help">{t('studio.jobs.browser')}</p>}
     {error&&<p className="status-message error-message" role="alert">{error}</p>}
    </section>
   </aside>
   <div className="wb-center">
    <section className={`wb-stage${sideBySide?' wb-split':''}`} aria-label={t('studio.run.preview')}>
     {editableSource&&media&&<div className="wb-editor-host" hidden={!!shown&&!editorLeft}>
      <StudioImageEditor key={media.src} ref={editorRef} source={{src:media.src,name:media.name,width:editableSource.width,height:editableSource.height}} layers={layers} onLayers={setLayers} maskMode={inpaint} onMask={setMasked}/>
      {inputImage&&tools(media)}<span className="wb-editor-caption">{media.name}{inserting&&<> · {t('studio.run.edit.insertHint')}</>}</span>
     </div>}
     {sideBySide&&!editorLeft&&<figure className="media-preview"><img src={original} alt={t('studio.run.edit.original')}/></figure>}
     {shown&&media&&!sideBySide&&<button type="button" className="wb-return-draft" data-editor-return onClick={()=>setSelectedJob('')}>{t('studio.editor.returnDraft')}</button>}
     {shown?<div className="wb-shown"><p className="wb-job-line"><span data-state={shown.state}>{t(`studio.jobs.${shown.state}`)}</span> · <code>{shown.id.slice(0,8)}</code>{shown.error&&<> · <span className="error-message">{shown.error}</span></>}</p>
      {shown.state==='succeeded'&&shown.outputs.length>0&&(outputDir?<figure className="media-preview">{original&&slider?<div className="wb-compare" style={{'--divide':`${divide}%`} as React.CSSProperties}><img src={original} alt={t('studio.run.edit.original')}/><img src={fileSrc(shown.outputs[0])!} alt={shown.outputs[0].filename}/><input type="range" aria-label={t('studio.run.edit.divider')} min={0} max={100} value={divide} onChange={e=>setDivide(Number(e.target.value))}/></div>
        :shown.outputs.map(o=><img key={o.filename} src={fileSrc(o)!} alt={o.filename}/>)}{tools(outputItem(shown.outputs[0]))}<figcaption>{original&&slider&&<>{t('studio.run.edit.original')} | </>}{shown.outputs.map(o=>o.filename).join(' · ')}</figcaption></figure>:<JobOutputPreview job={shown} auto/>)}
      {(shown.state==='queued'||shown.state==='running')&&(shown.preview?<figure className="media-preview" aria-busy="true"><img src={shown.preview} alt={t('studio.run.working')}/>{shown.progress&&<figcaption><progress value={shown.progress.value} max={shown.progress.max}/> {shown.progress.value}/{shown.progress.max}</figcaption>}</figure>
       :<p className="empty-note" aria-busy="true"><span className="aio-spinner" aria-hidden="true"/> {t('studio.run.working')}{shown.progress&&<> {shown.progress.value}/{shown.progress.max}</>}</p>)}</div>
     :media&&!editableSource?<figure className="media-preview">{media.media==='image'?<img src={media.src} alt={media.name} onLoad={e=>readMediaSize(e.currentTarget.naturalWidth,e.currentTarget.naturalHeight)}/>:media.media==='video'?<video src={media.src} controls onLoadedMetadata={e=>readMediaSize(e.currentTarget.videoWidth,e.currentTarget.videoHeight)}/>:<audio src={media.src} controls/>}{inputImage&&tools(media)}<figcaption>{media.name}{inserting&&<> · {t('studio.run.edit.insertHint')}</>}</figcaption></figure>
     :!media?<p className="empty-note">{t('studio.run.empty')}</p>:null}
    </section>
    <div className="wb-prompts">
     <div className="wb-prompt"><label htmlFor="run-positive">{t('studio.run.positive')}</label><textarea id="run-positive" data-run-positive value={positive} maxLength={16384} placeholder={t('studio.run.positiveHint')} onChange={e=>setPositive(e.target.value)}/><ForgeButton endpoint={endpoint} root={root} dialect={dialectOf(model?.family)} value={positive} image={pipeline==='i2i'?inputImage||undefined:undefined} onApply={setPositive} onWildcards={openWildcards} wildcard={wildcardEnabled?wildcard:undefined}/></div>
     <label className="wb-prompt wb-negative"><span>{t('studio.run.negative')}</span><textarea data-run-negative value={negative} maxLength={16384} placeholder={t('studio.run.negativeHint')} onChange={e=>setNegative(e.target.value)}/></label>
    </div>
    {wildcardEnabled&&<div className="wildcard-prompt-status"><button type="button" className="wildcard-badge" title={t('wildcards.baseNotice')} onClick={()=>setDockTab('wildcards')}>{t(wildcard.auto_reroll?'wildcards.activeAuto':'wildcards.active')}</button><button type="button" className="wildcard-badge" onClick={()=>setWildcardEnabled(false)}>{t('wildcards.disable')}</button></div>}
   </div>
   <GenerationMetadata job={shown} media={shown?null:media} onApply={applySettings}/>
   <section className="wb-queue" aria-label={t('studio.run.queue')}>
    <h3>{t('studio.run.queue')}</h3>
    {jobs.length===0?<p className="media-help">{t('studio.run.queueEmpty')}</p>:<ul>{jobs.map(j=><li key={j.id}><button type="button" aria-current={j.id===selectedJob} data-state={j.state} onClick={()=>setSelectedJob(j.id)}>
     {outputDir&&j.state==='succeeded'&&j.outputs[0]?<img src={fileSrc(j.outputs[0])!} alt=""/>:j.preview?<img src={j.preview} alt=""/>:<span className="wb-thumb" aria-hidden="true">{j.state==='failed'||j.state==='unknown'?'!':j.state==='succeeded'?'✓':'…'}</span>}
     <span className="wb-queue-text"><strong>{t(`studio.jobs.${j.state}`)}{j.progress&&<> {j.progress.value}/{j.progress.max}</>}</strong><small>{j.outputs[0]?.filename??j.id.slice(0,8)}</small></span></button></li>)}</ul>}
    <button type="button" className="aio-confirm-button wb-run" data-run disabled={!native||busy||!!current||!!sizeError||(inpaint&&!masked)} onClick={()=>void run()}>{t(current?'studio.run.running':busy?'studio.run.preparing':'studio.run.run')}</button>
    <button type="button" className="wb-run-post" data-run-post disabled={!native||busy||!!current||!postSource?.image} title={t('studio.run.post.runHint')} onClick={()=>{if(postSource)void run(postSource);}}>{t('studio.run.post.run')}</button>
   </section>
  </div>
  <div className="wb-dock" style={{height:dockHeight}}>
   <div className="wb-dock-handle" role="separator" aria-orientation="horizontal" aria-label={t('studio.run.dockResize')} onPointerDown={dragDock}/>
   <div className="wb-dock-tabs" role="tablist" aria-label={t('studio.run.dock')}>{dockTabs.map(id=><button key={id} role="tab" type="button" data-dock-tab={id} aria-selected={dockTab===id} onClick={()=>{setDockTab(id);if(id==='options')loadChoices();}}>{t(id==='wildcards'?'wildcards.title':`studio.run.dock.${id}`)}{id==='loras'&&activeLoras.length>0&&<small> {activeLoras.length}</small>}{id==='wildcards'&&wildcardEnabled&&<small aria-label={t('wildcards.active')}> ✓</small>}{id==='post'&&post&&<small aria-label={t('studio.run.post.enabled')}> ✓</small>}{id==='options'&&options&&<small> {Object.keys(options).length}</small>}</button>)}
    {dockTab!=='options'&&dockTab!=='wildcards'&&dockTab!=='post'&&<><input type="search" className="wb-dock-search" data-dock-search aria-label={t('studio.run.dock.search')} placeholder={t('studio.run.dock.search')} value={query} onChange={e=>setQuery(e.target.value)}/>
    <select className="wb-dock-sort" data-dock-sort aria-label={t('studio.run.dock.sort')} value={sort} onChange={e=>setSort(e.target.value as typeof sortPref)}>{sorts.map(s=><option key={s} value={s}>{t(`studio.run.sort.${s}`)}</option>)}</select></>}
    {(dockTab==='models'||dockTab==='loras')&&<button type="button" className="wb-dock-action" data-run-load disabled={!native||busy||(!modelsDir&&!endpoint.trim())} onClick={()=>void load()}>{t(models?'studio.run.reload':'studio.run.load')}</button>}</div>
   {dockTab==='media'&&<MediaLibrary selected={media} onSelect={pickMedia} roots={roots} outputRevision={outputRevision} filter={query} sort={sort}/>}
   {dockTab==='wildcards'&&<div className="wb-dock-panel"><WildcardPanel endpoint={endpoint} value={wildcard} onChange={setWildcard} enabled={wildcardEnabled} onEnabled={setWildcardEnabled}/></div>}
   {dockTab==='post'&&<section className="wb-dock-panel" aria-label={t('studio.run.dock.post')}><div className="wb-options">
    <div className="wb-option"><span><label className="wb-option-row"><input type="checkbox" checked={post} onChange={e=>setPost(e.target.checked)}/>{t('studio.run.post.enabled')}</label></span><small>{t('studio.run.post.hint',{width:String(up(outputSize).width),height:String(up(outputSize).height)})}</small></div>
    <label className="wb-option"><span>{t('studio.run.post.denoise')}</span><input type="number" value={refineDenoise} min={0.05} max={1} step={0.05} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n))setRefineDenoise(clamp(n,0.05,1));}}/></label>
    <label className="wb-option"><span>{t('studio.run.upscale')}</span><input type="number" value={upscale} min={1} max={4} step={0.25} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n))setUpscale(clamp(n,1,4));}}/></label>
    <label className="wb-option"><span>{t('studio.run.post.model')}</span><select value={upscaleModel} onFocus={loadChoices} onPointerDown={loadChoices} onChange={e=>setUpscaleModel(e.target.value)}><option value="">{t('studio.run.post.lanczos')}</option>{(choices?.upscaleModels??[]).map(m=><option key={m} value={m}>{m}</option>)}</select></label>
   </div></section>}
   {dockTab==='options'&&<section className="wb-dock-panel" aria-label={t('studio.run.dock.options')}><OptionsPanel value={optionsPref} onChange={setOptions} allow={choices} family={family?.id} imageInput={pipeline==='i2i'} onRead={loadChoices} canRead={native&&!!endpoint.trim()}/></section>}
   {(dockTab==='models'||dockTab==='loras')&&<section className="wb-dock-panel" aria-label={t(`studio.run.dock.${dockTab}`)}>
    {!models&&<p className="media-help">{t(modelsDir?'studio.run.scanHelp':'studio.run.loadHelp')}</p>}
    {models&&dockTab==='models'&&(allModels.length===0?<p className="media-help">{t('studio.run.noModels')}</p>:<div className="media-browser">{folderTree(allModels)}<ul className="wb-tiles" data-run-checkpoint>{allModels.filter(match).sort(bySort).map(m=>tile(m,m===model,()=>pickModel(m),undefined,blocked(m,pipeline)))}</ul></div>)}
    {models&&dockTab==='loras'&&(loraNames.length===0?<p className="media-help">{t('studio.run.noLoras')}</p>:<div className="media-browser">{folderTree(loraModels)}<ul className="wb-tiles wb-loras">{loraModels.filter(match).sort(bySort).map(m=>{const on=loras.find(l=>l.name===m.name);return tile(m,!!on,()=>toggleLora(m.name,!on),on&&<input type="number" aria-label={t('studio.run.strength',{name:m.name})} value={on.strength} min={-10} max={10} step={0.05} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n)&&Math.abs(n)<=10)setLoras(loras.map(l=>l.name===m.name?{...l,strength:n}:l));}}/>);})}</ul></div>)}
   </section>}
  </div>
 </div>;
}
