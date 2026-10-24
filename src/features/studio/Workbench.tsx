import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { backendErrorText } from '../../lib/backendErrors';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import type { DiagnosticImageIntentV1, RecipeAllowlist } from '../../lib/execution';
import { prepareDiagnosticJob, submitDiagnosticJob, readDiagnosticJobStatus, uploadMask, uploadInput, readH3Session, readRefMods, type JobStatus, type JobIntent, type H3ImportedVideo } from '../../lib/jobs';
import { chunkCount, defaultVideoOutput, h3Scalings, isVideoIntent, videoFrames, type H3Scaling, type VideoFamily, type VideoIntentV1, type VideoOutput } from '../../lib/videoIntent';
import { RunPlan } from './RunPlan';
import { ContinuityOverlay } from './ContinuityOverlay';
import { defaultPlan, isContinuityPlan, nextStep, resolveClip, continuitySource, type ContinuityPlan } from '../../lib/continuity';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels, type LocalModel } from '../../lib/models';
import { componentFiles, defaultComponentOverrides, isComponentOverrides, type ComponentFamily, type ComponentSlot } from '../../lib/modelComponents';
import { ComponentPicker } from './ComponentPicker';
import { ReferencePeople, type FramePeople, ReferencesPanel, directorTags, h3ForgeContext, prefillItems, h3Full, over, refCounts, refsProblem, slotsOf, type RefAdd, type RefMod, type VideoRef } from './ReferencesPanel';
import { mediaTypes, mediaViews, type MediaAction, type MediaRoots, type MediaType, type MediaView } from '../media/MediaLibrary';
import { MediaPanel, MediaControls } from '../media/MediaPanel';
import { draggedItem, MEDIA_DRAG, relocatedJob, relocatedMediaItem, type MediaItem, type MediaRelocation } from '../../lib/media';
import { isBoolean, isString, oneOf, readPref, usePref, PreferencePersistenceContext, resetStudioPreferences } from '../../lib/preferences';
import { ProjectBar } from '../projects/ProjectBar';
import type { ImageDraft, ProjectSnapshot } from '../../lib/projects';
import { JobOutputPreview } from './JobOutputPreview';
import { GenerationMetadata } from './GenerationMetadata';
import { generationDuration } from './generationDuration';
import type { GenerationSettings } from '../../lib/imageMetadata';
import { outputNamingTemplate, outputPrefix } from '../../lib/outputNaming';
import { OptionsPanel, defaultOptions, isOptionsPref, parseSigmas, runOptions } from './OptionsPanel';
import builtinFamilies from '../../families/builtin.json' with { type: 'json' };
import { aspects, resolutions, scalingModes, canvasSize, scaleInput, validCanvas, type Size, type ScalingMode } from '../../lib/resolution';
import { StudioImageEditor, type EditorHandle } from './StudioImageEditor';
import { ImageViewer } from './ImageViewer';
import { StarMediaButton } from '../media/StarMediaButton';
import { CompareView } from './CompareView';
import { PromptOverlay } from './PromptOverlay';
import { ForgeButton } from '../forge/ForgeButton';
import { applyRefPrefill, nextShot, promptStructure, refPrefill } from '../../lib/h3Prompt';
import { dialectOf } from '../../lib/forge';
import { PresetPanel } from '../presets/PresetPanel';
import { WildcardPanel } from '../wildcards/WildcardPanel';
import { defaultWildcard, isWildcardRules } from '../../lib/wildcard';
import { containedImageHit, flattenLayer, visibleImages, type ImageLayer } from './imageEditor';
import './workbench.css';
import { NativeVideo, nativeVideo } from './NativeVideo';
/** Data-only family plugin (also read natively for header detection): loader, runnable pipelines, encoder/VAE file patterns, starting settings. */
interface Family extends ComponentFamily { id:string; name:string; multiple?:number; loader:string; pipelines:string[]; clipType?:string; textEncoders?:string[]; textProjections?:string[]; vaes?:string[]; audioVaes?:string[]; defaults?:{width:number;height:number;steps:number;cfg:number;sampler:string;scheduler:string}; sigmas?:number[]; loraFamily?:string; /** Video families: native fps/seconds, fixed fps (H3 is 24), Wan's high→low file-name pair. */ video?:{fps:number;seconds:number;fixedFps?:boolean;lowModel?:[string,string]} }
/** Remembered video controls; family rows read only their own keys. */
interface VideoPref { seconds:number; fps:number; passes:1|2|3; upscaler:string; shiftHigh:number; shiftLow:number; refinerStep:number; shiftVideo:number; shiftAudio:number; audioVae:string; textProjection:string }
const defaultLayout={settings:272,queue:152,dock:220};
const defaultVideo:VideoPref={seconds:5,fps:24,passes:1,upscaler:'',shiftHigh:5,shiftLow:5,refinerStep:2,shiftVideo:10,shiftAudio:3,audioVae:'',textProjection:''};
const isVideoPref=(v:unknown):v is VideoPref=>{const o=v as VideoPref;return !!o&&typeof o==='object'&&Object.keys(defaultVideo).every(k=>typeof (o as unknown as Record<string,unknown>)[k]===typeof (defaultVideo as unknown as Record<string,unknown>)[k])&&[1,2,3].includes(o.passes);};
const families=new Map((builtinFamilies as Family[]).map(f=>[f.id,f]));
const modelCategories=['checkpoints','diffusion_models','unet'];
type Lora={name:string;strength:number};
const isLoras=(v:unknown):v is Lora[]=>Array.isArray(v)&&v.every(l=>l&&typeof l.name==='string'&&typeof l.strength==='number');
const isNumber=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const isMaskGrow=(v:unknown):v is number=>isNumber(v)&&Number.isInteger(v)&&v>=0&&v<=512;
const isMaskBlur=(v:unknown):v is number=>isMaskGrow(v)&&v<=31;
const clamp=(n:number,min:number,max:number)=>Math.min(max,Math.max(min,n));
const isUnit=(v:unknown):v is number=>typeof v==='number'&&v>=0&&v<=1;
/** Locale keys of the Director scaling modes (shared with the image input-scaling labels). */
const h3ScalingKey:Record<H3Scaling,string>={Off:'off',Auto:'auto',Target:'target',Fit:'fit','Fill and crop':'crop','Fit and pad':'pad','Long side with divisible crop':'long'};
const videoPipelines:readonly string[]=['t2v','i2v','v2v','ref2v'];
const randomSeed=()=>Math.floor(Math.random()*2**32);
/** WebKitGTK media needs a blob URL; asset fetches also need connect-src permission in the app CSP. */
function useBlobSrc(src:string|undefined,active:boolean):{url?:string;error?:string}{
 const [state,setState]=useState<{url?:string;error?:string}>({});
 useEffect(()=>{
  setState({});if(!active||!src)return;
  let live=true,made='';
  fetch(src).then(r=>{if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.blob();}).then(b=>{if(!live)return;made=URL.createObjectURL(b);setState({url:made});}).catch(e=>{if(live)setState({error:e instanceof Error?e.message:String(e)});});
  return()=>{live=false;if(made)URL.revokeObjectURL(made);};
 },[src,active]);
 return state;
}
/** Media element failures are invisible in the native webview; the caption shows them. */
const mediaError=(e:React.SyntheticEvent<HTMLMediaElement>)=>{const m=e.currentTarget.error;return m?`error ${m.code}${m.message?`: ${m.message}`:''}`:'';};
const isSeed=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const isSeeds=(v:unknown):v is number[]=>Array.isArray(v)&&v.length<=10&&v.every(isSeed);
const dockTabs=['media','references','models','loras','presets','wildcards','post','options'] as const;
/** Pipeline taxonomy. `t2i`/`i2i` (images) and `t2v`/`i2v` (LTX, Wan, MiniMax H3 per family data) have native recipes; `v2v`/`ref2v` stay listed but disabled. */
const pipelines=['t2i','i2i','t2v','i2v','v2v','ref2v'] as const;
type Pipeline=typeof pipelines[number];
/** Edits of the shown image: plain image-to-image (`resample`) or inpaint; refine/upscale live in the Post-Processing tab. */
const editModes=['resample','inpaint'] as const;
export interface WorkbenchProps { endpoint:string; planVisible?:boolean; /** Environment folders: models are listed directly from disk (without it the running backend is asked), output enables direct previews of finished files. `extraModels` are additional model roots on other drives. */ roots?:MediaRoots&{models?:string;extraModels?:string[]}; /** Environment root for Prompt Forge (its saved LLM endpoint). */ root?:string; /** Prompts sent from the Prompt Forge tab; `n` changes per send. */ incoming?:{positive:string;negative:string;n:number} }
/** Text-to-image workbench: settings left, preview over the prompts, queue right, bottom dock with Media · Models · LoRAs tabs. */
export function Workbench(props:WorkbenchProps){
 const [project,setProject]=useState<ProjectSnapshot|null>(null);
 return <PreferencePersistenceContext.Provider value={!project}><WorkbenchContent {...props} project={project} onProject={setProject}/></PreferencePersistenceContext.Provider>;
}
function WorkbenchContent({endpoint,roots={},root,incoming,planVisible=false,project,onProject}:WorkbenchProps&{project:ProjectSnapshot|null;onProject:(project:ProjectSnapshot|null)=>void}){
 const {t,locale}=useI18n();const native=isTauri();const linuxVideo=nativeVideo();const modelsDir=roots.models;const outputDir=roots.output;const extraModelsKey=(roots.extraModels??[]).join('\n');
 const [media,setMedia]=useState<MediaItem|null>(null);
 const [browsed,setBrowsed]=useState<MediaItem|null>(null);
 const browsedBlob=useBlobSrc(browsed?.src,native&&browsed?.media!=='image'&&!(linuxVideo&&browsed?.media==='video'));
 const mediaBlob=useBlobSrc(media?.src,native&&media?.media!=='image'&&!(linuxVideo&&media?.media==='video'));const [mediaFault,setMediaFault]=useState('');
 useEffect(()=>setMediaFault(''),[media?.src]);
 const [outputRevision,setOutputRevision]=useState(0);
 const [dockTab,setDockTab]=usePref('studio.dock.tab','media',oneOf(...dockTabs));
 const focusDockTab=useRef(false);
 useLayoutEffect(()=>{if(focusDockTab.current){document.querySelector<HTMLButtonElement>(`[data-dock-tab="${dockTab}"]`)?.focus();focusDockTab.current=false;}},[dockTab]);
 const openWildcards=()=>{focusDockTab.current=true;setDockTab('wildcards');document.querySelector<HTMLButtonElement>('[data-dock-tab="wildcards"]')?.focus();};
 const [dockHeight,setDockHeight]=usePref('studio.dock.height',defaultLayout.dock,isNumber);
 const [settingsWidth,setSettingsWidth]=usePref('studio.layout.settingsWidth',defaultLayout.settings,isNumber);
 const [queueWidth,setQueueWidth]=usePref('studio.layout.queueWidth',defaultLayout.queue,isNumber);
 const [bodyWidth,setBodyWidth]=useState(1000);
 const [sortPref,setSort]=usePref('studio.dock.sort','date',oneOf('date','name','size'));
 const [dockView,setDockView]=usePref<MediaView>('studio.dock.view','tiles',oneOf(...mediaViews));
 const [dockType,setDockType]=usePref<MediaType>('studio.dock.type','all',oneOf(...mediaTypes));
 const [query,setQuery]=useState('');
 const [models,setModels]=useState<LocalModel[]|null>(null);
 const [working,setBusy]=useState(false);const [scanning,setScanning]=useState(false);const busy=working||scanning;const [error,setError]=useState('');
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
 const [componentOverrides,setComponentOverrides]=usePref('studio.run.componentOverrides',defaultComponentOverrides,isComponentOverrides);
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
 const [video,setVideo]=usePref('studio.run.video',defaultVideo,isVideoPref);
 const [lastFrame,setLastFrame]=useState<MediaItem|null>(null);
 // shortcut: source URLs identify frame pictures; use asset revisions when same-path edits are supported.
 const [framePeople,setFramePeople]=useState<Record<string,FramePeople>>({});
 useEffect(()=>{setFramePeople(p=>Object.fromEntries(Object.entries(p).filter(([src])=>src===media?.src||src===lastFrame?.src)));},[media?.src,lastFrame?.src]);
 const [refs,setRefs]=useState<VideoRef[]>([]);const [refmods,setRefmods]=useState<RefMod[]>([]);
 const [detached,setDetached]=useState<'positive'|'negative'|null>(null);
 const [copiedPrompt,setCopiedPrompt]=useState<'positive'|'negative'|null>(null);
 // Copy + clear sit under the expand button of each prompt field.
 const promptActions=(kind:'positive'|'negative',value:string,set:(v:string)=>void)=>{const name=t(`studio.run.${kind}`);return <>
  <button type="button" className="wb-prompt-expand wb-prompt-copy" data-prompt-copy={kind} aria-label={t('studio.run.prompt.copy',{name})} title={t('studio.run.prompt.copy',{name})} disabled={!value} onClick={()=>void navigator.clipboard.writeText(value).then(()=>{setCopiedPrompt(kind);setTimeout(()=>setCopiedPrompt(c=>c===kind?null:c),1500);},()=>setError(t('studio.run.prompt.copyFailed')))}>{copiedPrompt===kind?'✓':'⧉'}</button>
  <button type="button" className="wb-prompt-expand wb-prompt-clear" data-prompt-clear={kind} aria-label={t('studio.run.prompt.clear',{name})} title={t('studio.run.prompt.clear',{name})} disabled={!value} onClick={()=>set('')}>✕</button></>;};
 const [sourceStrength,setSourceStrength]=usePref('studio.run.video.sourceStrength',1,isUnit);
 const [sourceAudio,setSourceAudio]=usePref('studio.run.video.sourceAudio',false,isBoolean);
 const [h3Scaling,setH3Scaling]=usePref<H3Scaling>('studio.run.video.h3Scaling','Fill and crop',oneOf(...h3Scalings));
 // MiniMax H3 continuity plan (overlay): steps run one by one, each pinning the clip the previous one produced.
 const [plan,setPlan]=usePref('studio.run.continuity',defaultPlan(),isContinuityPlan);
 const [continuityOpen,setContinuityOpen]=useState(false);const continuityButton=useRef<HTMLButtonElement>(null);
 const planRun=useRef<{index:number;all:boolean;imported?:H3ImportedVideo}|null>(null);const [autoPlan,setAutoPlan]=useState(false);const [resolving,setResolving]=useState(false);
 const [edit,setEdit]=usePref('studio.run.edit','resample',oneOf(...editModes));
 // Post-Processing (SwarmUI Refine / Upscale): opt-in second pass after every run, or applied alone to the shown image.
 const [post,setPost]=usePref('studio.run.post',false,isBoolean);
 const [postTiled,setPostTiled]=usePref('studio.run.post.tiled',false,isBoolean);
 const [refineDenoise,setRefineDenoise]=usePref('studio.run.refineDenoise',0.25,isNumber);
 const [upscale,setUpscale]=usePref('studio.run.upscale',1,isNumber);
 const [upscaleModelPref,setUpscaleModel]=usePref('studio.run.upscaleModel','',isString);
 const [inpaintDenoise,setInpaintDenoise]=usePref('studio.run.inpaintDenoise',0.8,isNumber);
 const [inpaintOnlyMasked,setInpaintOnlyMasked]=usePref('studio.run.inpaintOnlyMasked',false,isBoolean);
 const [maskGrow,setMaskGrow]=usePref('studio.run.maskGrow',8,isMaskGrow);
 const [maskBlur,setMaskBlur]=usePref('studio.run.maskBlur',4,isMaskBlur);
 const [masked,setMasked]=useState(false);
 const editorRef=useRef<EditorHandle>(null);
 const sourceEpoch=useRef(0);
 const [strength,setStrength]=edit==='inpaint'?[inpaintDenoise,setInpaintDenoise]:[denoise,setDenoise];
 // Source image of each edit job, for the original/edited split view.
 const [sources,setSources]=useState<Record<string,MediaItem>>({});const [slider,setSlider]=useState(false);
 const [jobs,setJobs]=useState<JobStatus[]>([]);const [selectedJob,setSelectedJob]=useState('');
 const live=useRef(false);const lock=useRef(false);const epoch=useRef(0);
 const loadChoices=()=>{if(native&&!choices&&endpoint.trim())checkRecipePrerequisites(endpoint).then(e=>{if(live.current)setChoices(e.allowlist);},()=>{});};
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 // A native <select> opens synchronously on the first click; a list fetched on that click only shows on the second one.
 useEffect(()=>{setChoices(null);if(native&&endpoint.trim())checkRecipePrerequisites(endpoint).then(e=>{if(live.current)setChoices(e.allowlist);},()=>{});},[native,endpoint]);
 // Models come from the environment's models folder (read-only scan, no backend probe); the backend list is the fallback.
 async function load(automatic=false){
  if(!native||(!automatic&&(lock.current||scanning))||(!modelsDir&&!endpoint.trim()))return;
  setScanning(true);setError('');const version=++epoch.current;
  try{
   const next=modelsDir?await scanModels(modelsDir,extraModelsKey?extraModelsKey.split('\n'):[])
    :await checkRecipePrerequisites(endpoint).then(e=>{if(live.current&&version===epoch.current)setChoices(e.allowlist);return [...e.allowlist.checkpoints.map(name=>({category:'checkpoints',name})),...(e.allowlist.loras??[]).map(name=>({category:'loras',name}))].map(m=>({...m,path:'',size:0,info:null}));});
   if(live.current&&version===epoch.current)setModels(next);
  }catch(e){if(live.current&&version===epoch.current)setError(e instanceof Error?e.message:String(e));}
  finally{if(live.current&&version===epoch.current)setScanning(false);}
 }
 // A new root supersedes a pending scan; old replies must not restore the previous folder.
 useEffect(()=>{setModels(null);if(modelsDir)void load(true);else setScanning(false);return()=>{epoch.current++;};},[modelsDir,extraModelsKey]); // eslint-disable-line react-hooks/exhaustive-deps
 // Remembered picks are only valid while the folder still holds them.
 const byName=(a:LocalModel,b:LocalModel)=>a.name.localeCompare(b.name);
 // Tiles show the file name without folder (the tree shows it) and model extension; the full name stays the accessible name.
 const shortName=(n:string)=>(n.split('/').pop()??n).replace(/\.(safetensors|sft|ckpt|pt|pth|gguf)$/i,'');
 const familyOf=(m?:LocalModel)=>m?.family?families.get(m.family):undefined;
 // Content-detected components take precedence; unknown formats retain the family filename hints.
 const parts=(f?:Family)=>f?.loader==='diffusion'?{encoders:componentFiles(models??[],f,'textEncoders',componentOverrides.textEncoders),vaes:componentFiles(models??[],f,'vaes',componentOverrides.vaes),audioVaes:componentFiles(models??[],f,'audioVaes',componentOverrides.audioVaes),projections:componentFiles(models??[],f,'textProjections',componentOverrides.textProjections)}:null;
 // Wan 2.2 ships HIGH/LOW files; the counterpart is the same name with the pair swapped (case kept).
 // shortcut: file-name swap; upgrade when a header flag tells high from low.
 const lowOf=(m:LocalModel,f?:Family)=>{const [hi,lo]=f?.video?.lowModel??[];if(!hi||!lo)return '';const low=m.name.replace(new RegExp(hi,'i'),x=>x===x.toUpperCase()?lo.toUpperCase():lo);return low!==m.name&&(models??[]).some(x=>x.name===low&&x.category===m.category)?low:'';};
 // Unknown checkpoints stay usable (self-contained loader, like SwarmUI); everything else must be a known family with a recipe for the pipeline.
 const blocked=(m:LocalModel,p:Pipeline):string=>{
 const f=familyOf(m);
 if(!f)return m.category==='checkpoints'&&(p==='t2i'||p==='i2i')?'':'studio.run.family.unknown';
 if(!f.pipelines.includes(p))return 'studio.run.pipe.noRecipe';
 // Missing companions block Run, not model selection: users must be able to open their pickers.
 if(videoPipelines.includes(p)&&f.video?.lowModel&&!lowOf(m,f))return 'studio.run.family.noEncoder';
 return '';
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
 // The overview names the picture only; the full ComfyUI name (folders, `[output]`) stays in the tooltip.
 const fileName=(name:string)=>(name.replace(/ \[output\]$/,'').split('/').pop()??name);
 const comfyName=(item:MediaItem|null)=>under(item,roots.input)||(under(item,outputDir)&&`${under(item,outputDir)} [output]`);
 const projectInput=project?.input?.path===media?.path?project?.input:null;
 const inputImage=comfyName(media)||(projectInput?projectInput.id+'.png':'');
 // Extra images pasted onto the source (SwarmUI editor image layers), in source pixels; they belong to one source.
 const [layers,setLayers]=useState<ImageLayer[]>([]);
 // Image pipelines stay clickable without an input; the missing picture only greys Run and names what to pick.
// A chip whose pipeline the remembered model cannot run picks the first compatible model (with its family defaults).
 const why=(id:Pipeline):string=>!allModels.some(m=>!blocked(m,id))?(id==='t2i'||id==='i2i'?'studio.run.noModels':'studio.run.pipe.noRecipe'):'';
 const pipeline:Pipeline=pipelinePref;
 // What the pipeline still needs picked: an image (i2i/i2v), a video (v2v) or at least one reference (ref2v).
 const mediaPipeline=!pipeline.startsWith('t2');
 const isVideo=videoPipelines.includes(pipeline);
 // First/last-frame and the H3 continuity planner belong to text/image-to-video only.
 const frameVideo=pipeline==='t2v'||pipeline==='i2v';
 const aspect=aspectPref==='auto'&&!mediaPipeline?'1:1':aspectPref;
 // Remembered picks are only valid while the folder still holds them and they fit the pipeline.
 const usable=allModels.filter(m=>!blocked(m,pipeline));
 const model=checkpointPref?usable.find(m=>m.name===checkpointPref):usable[0];
 const checkpoint=model?.name??'';
 const family=familyOf(model);
 const resolution=resolutionPref==='model'&&!family?.defaults?'fixed':resolutionPref;
 const split=parts(family);
 const recommended=family?{textEncoders:componentFiles(models??[],family,'textEncoders'),vaes:componentFiles(models??[],family,'vaes'),audioVaes:componentFiles(models??[],family,'audioVaes'),textProjections:componentFiles(models??[],family,'textProjections')}:null;
 const textEncoder=textEncoderPref||recommended?.textEncoders[0]||'';
 const vae=vaePref||recommended?.vaes[0]||'';
 const videoFamily=family?.video?family.id as VideoFamily:undefined;
 const continuityAvailable=videoFamily==='minimax-h3'&&frameVideo;
 useEffect(()=>{if(!continuityAvailable||planVisible)setContinuityOpen(false);},[continuityAvailable,planVisible]);
 const needsInput=(pipeline==='i2i'||pipeline==='i2v')&&!inputImage?'studio.run.pipe.needsInput'
  :pipeline==='v2v'&&!(media?.media==='video'&&media.path)?'studio.run.pipe.needsVideo'
  :pipeline==='ref2v'&&!refs.length&&!(videoFamily==='minimax-h3'&&refmods.length)?'studio.run.pipe.needsRefs'
  :pipeline==='ref2v'?refsProblem(refs):'';
 const fps=family?.video?.fixedFps?family.video.fps:video.fps;
 const frames=videoFamily?videoFrames(videoFamily,video.seconds,fps):0;
 const audioVae=video.audioVae||recommended?.audioVaes[0]||'';
 const textProjection=video.textProjection||recommended?.textProjections[0]||'';
 const lastFrameName=comfyName(lastFrame);
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
 const moss=family?.id==='moss-image';
 const mossIssues:{name:string;reset:()=>void}[]=!moss?[]:[
  ...(loras.length?[{name:t('studio.run.loras'),reset:()=>setLoras([])}]:[]),
  ...(['attention','cache','compile','vae','sigmas'] as const).filter(k=>k==='vae'?optionsPref.vae==='tiled':!!optionsPref[k]?.trim()).map(k=>({name:t(`studio.run.opt.${k}`),reset:()=>setOptions({...optionsPref,[k]:defaultOptions[k]})})),
  ...(post?[{name:t('studio.run.dock.post'),reset:()=>setPost(false)}]:[]),
  ...(pipeline==='i2i'&&edit==='inpaint'?[{name:t('studio.run.edit.inpaint'),reset:()=>setEdit('resample')}]:[]),
  ...(pipeline==='i2i'&&visibleImages(layers).length?[{name:t('studio.editor.layers'),reset:()=>setLayers(layers.map(l=>({...l,visible:false})))}]:[]),
  ...(pipeline==='i2i'&&inputScaling==='pad'?[{name:t('studio.run.resolution.scaling'),reset:()=>setInputScaling('off')}]:[]),
 ];
 const unavailable=[
  ...mossIssues.map(i=>t('studio.run.moss.plain',{name:i.name})),
  ...(models?loras.filter(l=>!loraNames.includes(l.name)).map(l=>`LoRA: ${l.name}`):[]),
  ...(split&&!split.encoders.includes(textEncoder)?[textEncoder||t('studio.run.textEncoder')]:[]),
  ...(split&&!split.vaes.includes(vae)?[vae||t('studio.run.vae')]:[]),
  ...(split&&isVideo&&family?.audioVaes&&!split.audioVaes.includes(audioVae)?[audioVae||t('studio.run.video.audioVae')]:[]),
  ...(split&&isVideo&&family?.textProjections&&!split.projections.includes(textProjection)?[textProjection||t('studio.run.video.textProjection')]:[]),
  ...(choices?[...(!choices.samplers.includes(sampler)?[sampler]:[]),...(!choices.schedulers.includes(scheduler)?[scheduler]:[]),
   ...(post&&upscaleModelPref&&!choices.upscaleModels?.includes(upscaleModelPref)?[upscaleModelPref]:[]),
   ...(post&&postTiled&&!choices.nodes.includes('DaSiWaTiledDiffusion')?['DaSiWaTiledDiffusion']:[]),
   ...(optionsPref.attention&&!options?.attention&&!options?.sage?[optionsPref.attention]:[]),
   ...(optionsPref.cache&&!options?.cache?[optionsPref.cache]:[]),...(optionsPref.compile&&!options?.compile?[optionsPref.compile]:[]),
   ...(optionsPref.vae==='tiled'&&!options?.vaeTile?['VAEDecodeTiled']:[])]:[])
 ];
 const source=mediaSize&&mediaSize.src===media?.src?mediaSize:undefined;
 const modelSize=family?.defaults??{width:1024,height:1024};
 // Canvas edges snap to the family's latent/patch multiple (SDXL: 64 buckets, H3/LTX: 32); unknown models use the safe 16.
 const grid=family?.multiple??16;
 const canvas=canvasSize(aspect,resolution,{width:aspectWidth,height:aspectHeight},megapixels,{width,height},modelSize,mediaPipeline?source:undefined,grid);
 // Post-processing scales both edges and snaps each to the model grid.
 const up=(s:Size):Size=>({width:Math.max(grid,Math.round(s.width*upscale/grid)*grid),height:Math.max(grid,Math.round(s.height*upscale/grid)*grid)});
 // Tiled refine: tiles at the model's native size, overlap an eighth of the shorter edge (at least 64 px), all on the model grid.
 const snap=(n:number)=>Math.max(grid,Math.round(n/grid)*grid);
 const tiled=postTiled&&choices?.nodes?.includes('DaSiWaTiledDiffusion')?{tileWidth:snap(modelSize.width),tileHeight:snap(modelSize.height),overlap:snap(Math.max(64,Math.min(modelSize.width,modelSize.height)/8))}:null;
 const inpaint=pipeline==='i2i'&&edit==='inpaint';
 // MiniMax H3 edits a still like the Director's "Image Inpaint" mode: no denoise, no refine pass.
 const h3Image=pipeline==='i2i'&&family?.id==='minimax-h3';
 const scaled=pipeline!=='i2i'||!source?null:scaleInput(inpaint?'off':inputScaling,source,canvas,grid);
 if(moss){
  // Check this variant's emitted nodes, not the checkpoint diagnostic's missingNodes.
  const saver=['DaSiWa_MetadataImageSaver','DaSiWa_MetadataConfig'].every(n=>choices?.nodes.includes(n))?['DaSiWa_MetadataImageSaver','DaSiWa_MetadataConfig']:['SaveImage'];
  const required=['UNETLoader','CLIPLoader','VAELoader','CLIPTextEncode','KSampler','VAEDecode',...saver,...(pipeline==='i2i'?['LoadImage','VAEEncode',...(scaled?.resize?['ImageScale']:[])]:['EmptyFlux2LatentImage'])];
  unavailable.push(...(!choices?[t('studio.run.opt.unread')]:[...required.filter(n=>!choices.nodes.includes(n)),...(!choices.clipTypes?.includes('moss_image')?['CLIPLoader: moss_image']:[])]));
 }
 // Video snaps the canvas to the family multiple like images; a video source only drives Auto aspect.
 const editableSource=media?.media==='image'&&source&&validCanvas(source)?source:null;
 const outputSize=(inpaint||(moss&&pipeline==='i2i'&&!scaled?.resize))&&source?source:(scaled?.size??canvas);
 const sizeError=inpaint&&source&&(!validCanvas(source)||source.width%grid!==0||source.height%grid!==0)?'studio.editor.sourceSize'
  :needsInput?needsInput
  :moss&&pipeline==='i2i'&&source&&!scaled?.resize&&(source.width%grid!==0||source.height%grid!==0)?'studio.run.moss.resize'
  :(!validCanvas(outputSize)||(moss&&(outputSize.width%grid!==0||outputSize.height%grid!==0)))?'studio.run.resolution.invalid'
  :(pipeline==='i2i'||pipeline==='i2v'||pipeline==='v2v')&&!source?'studio.run.resolution.waiting'
  :mediaPipeline&&aspect==='auto'&&resolution!=='fixed'&&media&&media.media!=='audio'&&!source?'studio.run.resolution.waiting':'';
 const ratio=aspect==='auto'?(source?source.width/source.height:1):aspect==='custom'?aspectWidth/aspectHeight:Number(aspect.split(':')[0])/Number(aspect.split(':')[1]);
 const swatchRatio=Number.isFinite(ratio)&&ratio>0?ratio:1;
 const readMediaSize=(width:number,height:number)=>{if(media&&width>0&&height>0)setMediaSize({src:media.src,width,height});};
 const current=jobs.find(j=>j.state==='queued'||j.state==='running');
 const replace=(next:JobStatus)=>setJobs(list=>list.map(j=>j.id===next.id?next:j));
 function buildImageIntent(naming:string,out:VideoOutput,only?:{image:string;size:Size}):DiagnosticImageIntentV1{
  const target=up(only?only.size:outputSize);
  const refinePass=post&&!h3Image;
  const inputLayers=visibleImages(layers);
  const refineSigmas=tail(refineDenoise);
  const common={recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:positive,negativePrompt:negative,checkpoint,seed,cfg,sampler,scheduler,outputPrefix:naming,...(wildcardEnabled?{wildcard:structuredClone(wildcard)}:{}),...(activeLoras.length?{loras:activeLoras}:{}),...(split&&family?.clipType?{diffusion:{textEncoder,clipType:family.clipType,vae}}:{}),...(h3Image?{h3Edit:{shiftVideo:video.shiftVideo,shiftAudio:video.shiftAudio}}:{}),...(options?{options}:{}),...(out.imageFormat!=='png'||out.imageCompression!==44?{imageFormat:out.imageFormat,imageCompression:out.imageCompression}:{})} as const;
  const resized=!!upscaleModel||target.width!==only?.size.width||target.height!==only?.size.height;
  return Object.freeze(only
   ?{...common,width:target.width,height:target.height,steps:refineSigmas?refineSigmas.length-1:steps,...(refineSigmas?{sigmas:refineSigmas}:{}),inputImage:only.image,denoise:refineDenoise,...(resized?{inputResize:{...target,crop:'disabled' as const}}:{}),...(upscaleModel?{upscaleModel}:{})}
   :{...common,width:outputSize.width,height:outputSize.height,steps:sigmas?sigmas.length-1:steps,...(sigmas?{sigmas}:{}),...(pipeline==='i2i'?{inputImage,denoise:strength,...(scaled?.resize?{inputResize:scaled.resize}:{}),...(inputLayers.length?{inputLayers}:{})}:{}),
    ...(refinePass?{refine:{...target,denoise:refineDenoise,...(upscaleModel?{upscaleModel}:{}),...(refineSigmas?{sigmas:refineSigmas}:{}),...(tiled?{tiled}:{})}}:{})});
 }
 /** `only` = Post-process: the refine/upscale pass alone on that image (an image-to-image job), without a first generation. */
 /** `step` = a continuity planner step (H3): its seconds and action replace the controls, and the finished job's clip is pinned to it. */
 async function run(only?:{image:string;size:Size;src:string;item:MediaItem},step?:{index:number;all:boolean}){
  if(!native||lock.current||current||(moss&&only))return;
  if(!checkpoint){setError(t('studio.run.noModels'));return;}
  if(unavailable.length)return; // The overlay derives dependency warnings from the current selections.
  const editing=!only&&inpaint;
  if(!only&&sizeError){setError(t(sizeError,{multiple:String(grid)}));return;}
  if(editing&&!masked){setError(t('studio.run.edit.needsMask'));return;}
  const target=up(only?only.size:outputSize);
  const refinePass=post&&!h3Image;
  if((refinePass||only)&&!validCanvas(target)){setError(t('studio.run.resolution.invalid'));return;}
  const naming=outputPrefix(outputNamingTemplate(optionsPref.outputNaming),{type:isVideo&&!only?'video':'image',seed,model:checkpoint});
  if(naming===null){setError(t('studio.run.opt.outputNaming.invalid'));return;}
  const out=optionsPref.output??defaultVideoOutput;
  if(isVideo&&!only){await runVideo(naming,out,step);return;}
  const inputLayers=visibleImages(layers);
  const intent=buildImageIntent(naming,out,only);
  const from=only?.item??(pipeline==='i2i'?media:null);
  lock.current=true;setBusy(true);setError('');
  try{
   // Capture geometry and PNG before any async upload; subsequent edits belong to the next job.
   const bounds=editing&&inpaintOnlyMasked?editorRef.current?.maskBounds(maskGrow+maskBlur):null;
   const target=bounds?canvasSize('auto','model',bounds,1,bounds,modelSize,bounds,grid):null;
   if(target&&!validCanvas(target))throw new Error(t('studio.run.resolution.invalid'));
   const inpaintCrop=bounds&&target?{...bounds,targetWidth:target.width,targetHeight:target.height}:null;
   const maskSnapshot=editing?editorRef.current?.maskPng():null;
   if(editing&&!maskSnapshot)throw new Error(t('studio.run.edit.needsMask'));
   const imageSnapshot=!only&&pipeline==='i2i'?editorRef.current?.imagePng():null;
   const [maskPng,imagePng]=await Promise.all([maskSnapshot,imageSnapshot]);
   const inputMask=maskPng?await uploadMask(endpoint,maskPng):null;
   // A changed base needs the complete image stack baked once, with the mask kept separate.
   const painted=imagePng||only||pipeline!=='i2i'?[]:await Promise.all(layers.filter(l=>l.visible).map(async l=>{const png=await flattenLayer(l);return png?await uploadMask(endpoint,png):l.name;}));
   const withLayers=imagePng?{...intent,inputImage:await uploadMask(endpoint,imagePng)}:painted.some((name,i)=>name!==inputLayers[i].image)?{...intent,inputLayers:inputLayers.map((l,i)=>({...l,image:painted[i]}))}:{...intent};
   if(projectInput&&!imagePng&&!only&&pipeline==='i2i')withLayers.inputImage=await uploadInput(endpoint,projectInput.path);
   if(imagePng)delete withLayers.inputLayers;
   const plan=await prepareDiagnosticJob(endpoint,Object.freeze(inputMask?{...withLayers,inputMask,...(maskBlur?{maskBlur}:{}),...(inpaintCrop?{inpaintCrop}:{})}:withLayers)); // native: validates against the running backend's object_info
   const job=await submitDiagnosticJob(plan.id); // the Run click is the authorization
   if(live.current){setJobs(list=>[job,...list].slice(0,20));setBrowsed(null);setSelectedJob(job.id);if(from)setSources(s=>({...s,[job.id]:from}));setRecentSeeds(list=>[intent.seed,...list.filter(s=>s!==intent.seed)].slice(0,10));if(seedMode==='random')setSeed(randomSeed());}
  }catch(e){if(live.current)setError(e instanceof Error?e.message:String(e));}
  finally{lock.current=false;if(live.current)setBusy(false);}
 }
 function buildVideoIntent(vf:VideoFamily,naming:string,out:VideoOutput,nameOf:(item:MediaItem,force?:boolean)=>string,cont:ReturnType<typeof nextStep>=null):VideoIntentV1{
  const seconds=cont?plan.steps[cont.index].seconds:video.seconds;
  const count=videoFrames(vf,seconds,fps);
  const chunks=optionsPref.chunkHeadroom?chunkCount(count,outputSize.width,outputSize.height,optionsPref.chunkHeadroom):undefined;
  const {imageFormat,imageCompression,...output}=out;void imageFormat;void imageCompression;
  const base={recipeId:'video-generation',version:1,positivePrompt:positive,negativePrompt:negative,model:checkpoint,textEncoder,vae,seed,width:outputSize.width,height:outputSize.height,frames:count,frameRate:fps,steps,cfg,sampler,scheduler,outputPrefix:naming,output,
   ...(activeLoras.length?{loras:activeLoras}:{}),...(options?{options}:{}),...(chunks?{chunks}:{})} as const;
   let intent:VideoIntentV1;
   // The Director's default canvas fit for DEAS stays implicit, so unchanged intents stay byte-identical.
   const scaling=h3Scaling!=='Fill and crop'?{inputScaling:h3Scaling}:{};
   const last=frameVideo&&lastFrameName?{lastFrame:lastFrameName}:{};
   // Dock files outside the ComfyUI input/output folders (and every video, which core LoadVideo reads from the input root) are copied there.
   if(vf==='ltx-2'){
    const source=pipeline==='v2v'&&media?.path?{sourceVideo:nameOf(media,true)}:{};
    const keyframes=pipeline==='ref2v'?refs.map(r=>({image:nameOf(r.item),frame:Math.min(count-1,Math.round(r.second*fps)),strength:r.strength})):[];
    intent={...base,...(pipeline==='i2v'?{firstFrame:inputImage}:{}),...last,...source,family:'ltx-2',ltx:{textProjection,audioVae,passes:video.passes,...(video.passes>1?{spatialUpscaler:video.upscaler}:{}),
     ...(keyframes.length?{keyframes}:{}),...('sourceVideo' in source?{sourceStrength}:{})}};
   }
   else if(vf==='wan')intent={...base,firstFrame:inputImage,...last,family:'wan',wan:{lowModel:lowOf(model!,family),shiftHigh:video.shiftHigh,shiftLow:video.shiftLow,refinerStep:video.refinerStep}};
   else if(pipeline==='v2v'||pipeline==='ref2v'){
    // H3 has no video-to-video mode: both run REF2VA, the source video (with or without its sound) as a video reference.
    const picks:VideoRef[]=pipeline==='v2v'&&media?[{item:media,second:0,strength:1,mediaMode:sourceAudio?'video_audio':'video'}]:refs;
    const slots=slotsOf(picks);
    const items=picks.map((r,i)=>({type:r.item.media as 'image'|'video'|'audio',file:nameOf(r.item,true),slot:slots[i],...(r.item.media==='video'?{mediaMode:r.mediaMode}:{}),
     ...(r.item.media!=='image'&&r.trimStart!==undefined?{trimStart:r.trimStart}:{}),...(r.item.media!=='image'&&r.trimEnd!==undefined?{trimEnd:r.trimEnd}:{})}));
    intent={...base,family:'minimax-h3',h3:{mode:'REF2VA',audioVae,shiftVideo:video.shiftVideo,shiftAudio:video.shiftAudio,references:[],media:items,...scaling,
     ...(pipeline==='ref2v'&&refmods.length?{refmods:refmods.map((r,i)=>({slot:i+1,name:r.name,strength:r.strength,...(r.description.trim()?{description:r.description.trim()}:{})}))}:{})}};
   }
   else{
    // The Director owns H3 references; they must live in the backend input folder, so dock files are copied there explicitly.
    const refs:{slot:0|1;image:string}[]=[];
    if(pipeline==='i2v'&&media?.path)refs.push({slot:0,image:nameOf(media,true)});
    if(lastFrame?.path)refs.push({slot:1,image:nameOf(lastFrame,true)});
    const mode=refs.length===0?'T2VA':refs.length===2?'FL2VA':refs[0].slot===0?'I2VA':'L2VA';
    intent={...base,family:'minimax-h3',h3:{mode,audioVae,shiftVideo:video.shiftVideo,shiftAudio:video.shiftAudio,references:refs,...(cont?{continuity:cont.continuity}:{}),...(refs.length?scaling:{})}};
   }
   return intent;
 }
 async function runVideo(naming:string,out:VideoOutput,step?:{index:number;all:boolean}){
  if(!videoFamily||!family||!split||!model)return;
  if(step&&plan.source&&plan.source.endpoint!==endpoint){setError(t('studio.run.cont.sourceEndpointChanged'));setAutoPlan(false);return;}
  const cont=step?nextStep(plan):null;
  if(step&&cont?.index!==step.index){setError(t('studio.run.cont.stale'));return;}
  lock.current=true;setBusy(true);setError('');
  try{
   const uploads=new Set<string>();
   const identify=(item:MediaItem,force=false)=>{const name=!force&&comfyName(item);if(name)return name;uploads.add(item.path!);return item.path!;};
   const draft=buildVideoIntent(videoFamily,naming,out,identify,cont);
   const names=new Map(await Promise.all([...uploads.keys()].map(async path=>[path,await uploadInput(endpoint,path)] as const)));
   const intent=uploads.size?buildVideoIntent(videoFamily,naming,out,(item,force=false)=>(!force&&comfyName(item))||names.get(item.path!)!,cont):draft;
   const prepared=await prepareDiagnosticJob(endpoint,Object.freeze(intent));
   const job=await submitDiagnosticJob(prepared.id);
   if(live.current){
    setJobs(list=>[job,...list].slice(0,20));setBrowsed(null);setSelectedJob(job.id);setRecentSeeds(list=>[seed,...list.filter(s=>s!==seed)].slice(0,10));if(seedMode==='random')setSeed(randomSeed());
    if(cont&&step){planRun.current={...step,...(cont.continuity.sourceKind==='video'&&intent.family==='minimax-h3'?{imported:{sourceId:cont.continuity.sourceId,width:intent.width,height:intent.height,modeFamily:intent.h3.mode==='REF2VA'?'ref2va' as const:'fl2va' as const}}:{})};setPlan({...plan,steps:plan.steps.map((x,i)=>i===cont.index?{...x,jobId:job.id}:x)});}
   }
  }catch(e){if(live.current){setError(e instanceof Error?e.message:String(e));setAutoPlan(false);}}
  finally{lock.current=false;if(live.current)setBusy(false);}
 }
 // Planner: after a step's job succeeded, read the session once and pin the newest clip that continues the previous one.
 async function pinClip(job:JobStatus){
  const step=planRun.current;planRun.current=null;
  if(!step)return;
  setResolving(true);
  try{
   const session=await readH3Session(job.baseUrl,plan.session);
   const clipId=resolveClip(session.clips,continuitySource(plan,step.index),step.imported);
   if(!live.current)return;
   if(!clipId)throw new Error(t('studio.run.cont.noClip'));
   setPlan({...plan,steps:plan.steps.map((x,i)=>i===step.index?{...x,clipId,jobId:job.id}:x)});
  }catch(e){if(live.current){setError(e instanceof Error?e.message:String(e));setAutoPlan(false);}}
  finally{if(live.current)setResolving(false);}
 }
 useEffect(()=>{
  if(!current||!native)return;
  const timer=window.setTimeout(async()=>{
   try{const next=await readDiagnosticJobStatus(current.id);if(!live.current)return;replace(next);if(next.state==='succeeded'){setOutputRevision(r=>r+1);void pinClip(next);}else if(next.state==='failed'||next.state==='unknown'){planRun.current=null;setAutoPlan(false);}}
   catch(e){if(live.current){replace({...current,state:'unknown',error:e instanceof Error?e.message:String(e)});planRun.current=null;setAutoPlan(false);}}
  },1000);
  return()=>window.clearTimeout(timer);
 },[current,native]); // eslint-disable-line react-hooks/exhaustive-deps
 // Run all: start the next planned step once the previous clip is pinned and nothing is in flight.
 useEffect(()=>{
  if(!autoPlan||current||busy||resolving)return;
  const next=nextStep(plan);
  if(!next||videoFamily!=='minimax-h3'||!frameVideo){setAutoPlan(false);return;}
  void run(undefined,{index:next.index,all:true});
 },[autoPlan,current,busy,resolving,plan]); // eslint-disable-line react-hooks/exhaustive-deps
 const runPlan=(all:boolean)=>{const next=nextStep(plan);if(!next||videoFamily!=='minimax-h3'||!frameVideo)return;if(all)setAutoPlan(true);else void run(undefined,{index:next.index,all:false});};
 // Picking media on the strip takes over the preview until the next job is selected.
 const select=(item:MediaItem)=>{setBrowsed(null);setSelectedJob('');if(media?.src===item.src)return;sourceEpoch.current++;setMedia(item);setLayers([]);setMasked(false);};
 // A dock tile dropped on the editor becomes a layer at its original size, centred on the drop point (image-to-image only).
 const insertLayer=(item:MediaItem,at:{x:number;y:number})=>{
  if(!source||!media)return;
  const name=comfyName(item),version=sourceEpoch.current;
  if(!name||item.media!=='image'||layers.length>=4){setError(t('studio.run.edit.insertHint'));return;}
  if(pipeline!=='i2i'){setEdit('resample');setPipeline('i2i');}
  const probe=new Image();
  probe.onload=()=>{
   if(!live.current||sourceEpoch.current!==version)return;
   if(!(probe.naturalWidth>0&&probe.naturalHeight>0)){setError(t('studio.editor.insertFailed'));return;}
   const scale=Math.min(1,8192/probe.naturalWidth,8192/probe.naturalHeight); // original pixel size, capped at the 8192 px layer limit
   const width=Math.max(8,Math.round(probe.naturalWidth*scale)),height=Math.max(8,Math.round(probe.naturalHeight*scale));
   const cx=Number.isFinite(at.x)?at.x:source.width/2,cy=Number.isFinite(at.y)?at.y:source.height/2;
   const layer:ImageLayer={id:crypto.randomUUID(),name,src:item.src,visible:true,width,height,x:Math.max(1-width,Math.min(source.width-1,Math.round(cx-width/2))),y:Math.max(1-height,Math.min(source.height-1,Math.round(cy-height/2)))};
   setLayers(list=>list.length>=4?list:[...list,layer]);
  };
  probe.onerror=()=>{if(live.current&&sourceEpoch.current===version)setError(t('studio.editor.insertFailed'));};
  probe.src=item.src;
 };
 // Fill the viewport below the project bar; the floating version reserves no height.
 const shell=useRef<HTMLDivElement>(null);const [fit,setFit]=useState<number|undefined>();
 useEffect(()=>{if(browsed)shell.current?.querySelectorAll<HTMLMediaElement>('.wb-current-preview video, .wb-current-preview audio').forEach(el=>{if(!el.paused)el.pause();});},[browsed?.src]);
 useLayoutEffect(()=>{
  const measure=()=>{const el=shell.current;if(!el||!el.offsetParent)return;const top=el.getBoundingClientRect().top;setFit(Math.max(420,window.innerHeight-top-3));};
  measure();if(typeof ResizeObserver==='undefined'){window.addEventListener('resize',measure);return()=>window.removeEventListener('resize',measure);}
  const ro=new ResizeObserver(measure);ro.observe(document.documentElement);document.querySelectorAll<HTMLElement>('.aio-topbar,.project-bar').forEach(el=>ro.observe(el));return()=>ro.disconnect();
 },[t]);
 useLayoutEffect(()=>{
  const measure=()=>{const width=shell.current?.clientWidth;if(width)setBodyWidth(width);};measure();
  window.addEventListener('resize',measure);
  const ro=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);if(shell.current)ro?.observe(shell.current);
  return()=>{window.removeEventListener('resize',measure);ro?.disconnect();};
 },[]);
 const sideSize=clamp(settingsWidth,220,Math.max(220,bodyWidth-128-320-20));
 const queueSize=clamp(queueWidth,128,Math.max(128,bodyWidth-sideSize-320-20));
 const sideMax=Math.max(220,bodyWidth-queueSize-320-20),queueMax=Math.max(128,bodyWidth-sideSize-320-20);
 const dockMax=Math.max(120,(fit??600)-260),dockSize=clamp(dockHeight,120,dockMax);
 const dragCleanup=useRef<()=>void>(()=>{});
 useEffect(()=>()=>dragCleanup.current(),[]);
 const dragPane=(e:React.PointerEvent<HTMLDivElement>,start:number,min:number,max:number,set:(n:number)=>void,vertical=false,reverse=false)=>{
  if(e.button!==0)return;e.preventDefault();dragCleanup.current();
  const el=e.currentTarget,id=e.pointerId,at=vertical?e.clientY:e.clientX,sign=vertical||reverse?-1:1;
  el.setPointerCapture?.(id);
  const stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);window.removeEventListener('keydown',escape);el.removeEventListener('lostpointercapture',cancel);if(el.hasPointerCapture?.(id))el.releasePointerCapture(id);dragCleanup.current=()=>{};};
  const move=(ev:PointerEvent)=>{if(ev.pointerId===id)set(clamp(start+((vertical?ev.clientY:ev.clientX)-at)*sign,min,max));};
  const up=(ev:PointerEvent)=>{if(ev.pointerId===id)stop();};
  const cancel=()=>{set(start);stop();};
  const escape=(ev:KeyboardEvent)=>{if(ev.key==='Escape'){ev.preventDefault();cancel();}};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);window.addEventListener('keydown',escape);el.addEventListener('lostpointercapture',cancel);dragCleanup.current=stop;
 };
 const resizeKey=(e:React.KeyboardEvent,start:number,min:number,max:number,set:(n:number)=>void,vertical=false,reverse=false)=>{
  const delta=(e.key===(vertical?'ArrowUp':'ArrowRight')?1:e.key===(vertical?'ArrowDown':'ArrowLeft')?-1:0)*(reverse?-1:1);
  if(e.key==='Home'||e.key==='End'||delta){e.preventDefault();set(e.key==='Home'?min:e.key==='End'?max:clamp(start+delta*(e.shiftKey?64:16),min,max));}
 };
 const columnHandle=(side:'settings'|'queue')=>{const left=side==='settings',size=left?sideSize:queueSize,min=left?220:128,max=left?sideMax:queueMax,set=left?setSettingsWidth:setQueueWidth;return <div className="wb-column-handle" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t(`studio.layout.${side}`)} title={t(`studio.layout.${side}`)} aria-controls={`studio-${side}`} aria-valuemin={min} aria-valuemax={max} aria-valuenow={size} onKeyDown={e=>resizeKey(e,size,min,max,set,false,!left)} onPointerDown={e=>dragPane(e,size,min,max,set,false,!left)}/>;};
 const shown=jobs.find(j=>j.id===selectedJob)??null;
 const duration=(job:JobStatus)=>{const value=generationDuration(job,locale);return value!==null?<span data-generation-duration> · {value}</span>:null;};
 // Metadata is an overlay on the preview, opened on demand, so the stage keeps the column's width.
 const [metaOpen,setMetaOpen]=usePref('studio.run.metadataOpen',false,isBoolean);
 // A queue pick of an edit job brings its source back into the editor (with the job's mode) when no other draft is open,
 // e.g. after ✕ or browsing elsewhere; an open draft with masks or inserted layers is never replaced.
 const pickJob=(j:JobStatus)=>{
  setBrowsed(null);
  setSelectedJob(j.id);const from=sources[j.id];
  if(!from||media?.src===from.src||(media&&(masked||layers.length>0||editorRef.current?.imageEdited())))return;
  sourceEpoch.current++;setMedia(from);setLayers([]);setMasked(false);
  if(j.intent&&!isVideoIntent(j.intent)&&j.intent.inputImage){setPipeline('i2i');setEdit(j.intent.inputMask?'inpaint':'resample');}
 };
 const closePreview=()=>{if(browsed){setBrowsed(null);return;}setSelectedJob('');sourceEpoch.current++;setMedia(null);setLayers([]);setMasked(false);};
 const original=shown?sources[shown.id]?.src:undefined;
 // Edit jobs open side by side: the live editor (masks/layers kept until a new image is sent to edit) left, the render right.
 // While an edit draft is open, any queue pick opens beside it, so its controls never vanish behind a result.
 const sideBySide=!!shown&&(!!original||(pipeline==='i2i'&&!!editableSource))&&!(slider&&original);
 const editorLeft=sideBySide&&!!editableSource&&(!original||original===media?.src);
 // What still blocks Run is shown on the preview, where the missing pick or mask belongs (the mask only while the editor is visible).
 const hint=sizeError||(inpaint&&!masked&&(!shown||editorLeft)?'studio.run.edit.needsMask':'');
 // Click a render (or a browsed picture) for a full-window, zoomable view.
 const [viewer,setViewer]=useState<{src:string;alt:string;item?:MediaItem}|null>(null); const fileSrc=(o:JobStatus['outputs'][number])=>outputDir?convertFileSrc([outputDir,o.subfolder,o.filename].filter(Boolean).join('/')):null;
 const openImage=(event:React.MouseEvent<HTMLImageElement>,item:MediaItem)=>{
  const image=event.currentTarget;
  if(containedImageHit({x:event.clientX,y:event.clientY},{width:image.naturalWidth,height:image.naturalHeight},image.getBoundingClientRect()))setViewer({src:item.src,alt:item.name,item});
 };
 // WebKitGTK refuses <video> on custom schemes (asset://) with FormatError before any request; the backend's /view endpoint serves the same file over HTTP with Range support.
 const videoSrc=(job:JobStatus,o:JobStatus['outputs'][number])=>`${job.baseUrl}view?${new URLSearchParams({filename:o.filename,subfolder:o.subfolder,type:o.type})}`;
 const num=(id:string,value:number,set:(n:number)=>void,min:number,max:number,step:number,fixed?:string,slider=false)=><label key={id} className="wb-field"><span>{t(`studio.run.${id}`)}</span><input type="number" inputMode="numeric" value={value} min={min} max={max} step={step} disabled={!!fixed} title={fixed} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n))set(n);}}/>
  {/* Pointer shortcut for the number field above, which stays the labelled, keyboard-reachable control. */}
  {slider&&<input type="range" className="wb-slider" aria-hidden="true" tabIndex={-1} value={value} min={min} max={max} step={step} disabled={!!fixed} onChange={e=>set(Number(e.target.value))}/>}</label>;
 const outputItem=(o:JobStatus['outputs'][number]):MediaItem=>({name:o.filename,media:o.format?.startsWith('audio/')||/\.(wav|mp3|flac|ogg|m4a)$/i.test(o.filename)?'audio':isVideoOut(o)?'video':'image',src:fileSrc(o)??'',...(outputDir?{path:[outputDir,o.subfolder,o.filename].filter(Boolean).join('/')}:{})});
 useEffect(()=>{
  const moved=(event:Event)=>{
   const move=(event as CustomEvent<MediaRelocation>).detail;
   if(!move||typeof move.oldPath!=='string'||typeof move.path!=='string')return;
   const oldSrc=native?convertFileSrc(move.oldPath):move.oldPath,newSrc=native?convertFileSrc(move.path):move.path;
   const repair=(item:MediaItem|null)=>item?relocatedMediaItem(item,move):null;
   setMedia(repair);setBrowsed(repair);setLastFrame(repair);
   setMediaSize(value=>value?.src===oldSrc?{...value,src:newSrc}:value);
   setSources(values=>Object.fromEntries(Object.entries(values).map(([key,item])=>[key,relocatedMediaItem(item,move)])));
   setRefs(values=>values.map(ref=>({...ref,item:relocatedMediaItem(ref.item,move)})));
   setFramePeople(values=>{if(!values[oldSrc])return values;const next={...values,[newSrc]:values[oldSrc]};delete next[oldSrc];return next;});
   if(outputDir){
    setJobs(values=>values.map(job=>relocatedJob(job,outputDir,move)));
    const relative=move.path.replace(/\\/g,'/').slice(outputDir.replace(/\\/g,'/').replace(/\/+$/,'').length+1);
    setLayers(values=>values.map(layer=>layer.src===oldSrc?{...layer,src:newSrc,name:`${relative} [output]`}:layer));
   }
   setViewer(value=>value?.src===oldSrc?{src:newSrc,alt:move.path.split(/[\\/]/).at(-1)!,item:value.item?relocatedMediaItem(value.item,move):undefined}:value);
  };
  window.addEventListener('deas-media-relocated',moved);return()=>window.removeEventListener('deas-media-relocated',moved);
 },[native,outputDir]);
 // Post-process takes the shown render (its submitted size), else the current edit source.
 const isVideoOut=(o:JobStatus['outputs'][number])=>!!o.format?.startsWith('video/')||/\.(webm|mkv|mp4|avif)$/i.test(o.filename);
 const shownOutput=shown?.state==='succeeded'&&outputDir&&shown.outputs[0]&&shown.intent&&!isVideoIntent(shown.intent)?outputItem(shown.outputs[0]):null;
 const postFor=(item:MediaItem)=>shownOutput?.src===item.src&&shown?.intent&&!isVideoIntent(shown.intent)?{image:comfyName(shownOutput),size:shown.intent.refine??shown.intent,src:shownOutput.src,item:shownOutput}
  :media?.src===item.src&&inputImage&&source?{image:inputImage,size:source,src:media.src,item:media}:null;
 // Floating edit buttons over an editable image: a mode makes it the image-to-image source and opens that mode's controls on the left.
 const noEditModel=!allModels.some(m=>!blocked(m,'i2i'));
 // References: LTX keyframes are images; H3 REF2VA also takes videos and audio within the Director limits. Returns why an item cannot be added.
 const isRef=(item:MediaItem)=>refs.some(r=>r.item.src===item.src);
 const refBlock=(item:MediaItem,list=refs)=>videoFamily!=='minimax-h3'?(item.media==='image'?'':'studio.run.video.refImagesOnly'):h3Full(list,item)?'studio.run.video.refFull':'';
 // Adds in order; already referenced or path-less (browser) items are skipped, refused ones are named with the reason.
 const addRefs=(adds:RefAdd[],replace=false)=>{
  let next=replace?[]:refs;const refused:string[]=[];
  for(const {item,...rest} of adds){if(!item.path||next.some(r=>r.item.src===item.src))continue;
   const ref:VideoRef={item,second:next.length?video.seconds:0,strength:1,mediaMode:'video',...rest};
   // Limits count the reference as it will be used (a pack may bring a sound-only video).
   const why=videoFamily!=='minimax-h3'?refBlock(item,next):over(refCounts([...next,ref]))?'studio.run.video.refFull':'';
   if(why)refused.push(`${item.name}: ${t(why)}`);else next=[...next,ref];}
  setRefs(next);if(refused.length)setError(refused.join(' · '));
 };
 const toggleRef=(item:MediaItem)=>isRef(item)?setRefs(refs.filter(r=>r.item.src!==item.src)):addRefs([{item}]);
 // H3 badges are the Director's own prompt labels, so what the dock shows is what the prompt may reference.
 const refTags=directorTags(refs);
 const refLabel=(r:VideoRef,i:number)=>videoFamily==='ltx-2'?t('studio.run.video.mark.at',{second:String(r.second)}):refTags[i];
 const refsTab=pipeline==='ref2v'&&(videoFamily==='ltx-2'||videoFamily==='minimax-h3');
 useEffect(()=>{if(dockTab==='references'&&!refsTab)setDockTab('media');},[dockTab,refsTab]); // eslint-disable-line react-hooks/exhaustive-deps
 const marks=new Map(pipeline==='ref2v'?refs.flatMap((r,i)=>r.item.path?[[r.item.path,refLabel(r,i)] as const]:[]):pipeline==='v2v'&&media?.media==='video'&&media.path?[[media.path,t('studio.run.video.source')] as const]:[]);
 const mediaActions=(item:MediaItem):MediaAction[]=>!item.path?[]:pipeline==='ref2v'&&videoFamily?[isRef(item)?{label:t('studio.run.video.removeRef',{name:item.name}),onClick:()=>toggleRef(item)}:{label:t('studio.run.video.addRef'),onClick:()=>toggleRef(item),blocked:refBlock(item)&&t(refBlock(item))}]
  :pipeline==='v2v'&&item.media==='video'?[{label:t('studio.run.video.useSource'),onClick:()=>select(item)}]:[];
 const stageMark=media?.path&&marks.get(media.path);
 // MiniMax H3 video: the hammer is the Director's Prompt Forge for this run (same mode/references the intent gets).
 const forgeContext=videoFamily==='minimax-h3'&&isVideo?h3ForgeContext({pipeline,media,lastFrame,refs,framePeople,sourceAudio,seconds:video.seconds,canvas:outputSize,inputRoot:roots.input}):undefined;
 // Insert at the cursor of the positive prompt (else append), like the node's toolbar.
 const insertPrompt=(text:string)=>{const el=document.getElementById('run-positive') as HTMLTextAreaElement|null;const at=el&&document.activeElement===el?el.selectionStart:positive.length;setPositive(positive.slice(0,at)+text+positive.slice(at));};
 const prefill=()=>{
  if(refmods.some(r=>!r.kinds?.length)){setError(t('studio.run.prompt.prefillKinds'));return;}
  const picks=pipeline==='v2v'?(media?.media==='video'?[{type:'video' as const,slot:0,mediaMode:sourceAudio?'video_audio' as const:'video' as const}]:[]):prefillItems(refs);
  const fields=refPrefill(picks,pipeline==='ref2v'?refmods.map((r,i)=>({slot:i+1,kinds:r.kinds!,description:r.description})):[]);
  if(!fields){setError(t('studio.run.prompt.prefillEmpty'));return;}
  setPositive(applyRefPrefill(positive,fields));
};
// Director prompt helpers live inside the hammer panel (H3 video only); insert at the cursor of the positive prompt (else append), like the node's toolbar.
const promptTools=forgeContext&&<>
 <button type="button" data-insert-structure onClick={()=>insertPrompt(promptStructure(forgeContext.mode))}>{t('studio.run.prompt.structure')}</button>
 <button type="button" data-insert-shot onClick={()=>insertPrompt(nextShot(positive))}>{t('studio.run.prompt.shot')}</button>
 {forgeContext.mode==='REF2VA'&&<button type="button" data-prefill onClick={prefill}>{t('studio.run.prompt.prefill')}</button>}</>;
 const tools=(item:MediaItem,showStar=true)=><div className="wb-edit-tools" role="toolbar" aria-label={t('studio.run.edit.title')}>
  {showStar&&<StarMediaButton item={item}/>}
  <button type="button" data-use-input onClick={()=>select(item)}>{t('studio.run.useInput')}</button>
  {item.media==='image'&&editModes.map(m=><button key={m} type="button" data-edit={m} aria-pressed={pipeline==='i2i'&&edit===m&&media?.src===item.src} disabled={noEditModel} title={noEditModel?t('studio.run.noModels'):undefined} onClick={()=>{select(item);setEdit(m);setPipeline('i2i');}}>{t(`studio.run.edit.${m}`)}</button>)}
  {/* Post-process (refine/upscale alone) only in the image edit modes: the active checkpoint is then an image model. */}
  {pipeline==='i2i'&&!h3Image&&!moss&&(()=>{const only=postFor(item);return only&&<button type="button" data-run-post disabled={!native||busy||!!current} title={t('studio.run.post.runHint')} onClick={()=>void run(only)}>{t('studio.run.post.run')}</button>;})()}
  {item.media==='image'&&<button type="button" data-view-full onClick={()=>setViewer({src:item.src,alt:item.name,item})}>{t('studio.run.viewer.open')}</button>}
  {frameVideo&&item.media==='image'&&<button type="button" data-edit-last aria-pressed={lastFrame?.src===item.src} onClick={()=>setLastFrame(lastFrame?.src===item.src?null:item)}>{t('studio.run.video.lastFrame')}</button>}
  {/* LTX keyframes are images; H3 REF2VA also takes videos and audio. */}
  {pipeline==='ref2v'&&item.path&&(item.media==='image'||videoFamily==='minimax-h3')&&<button type="button" data-edit-ref aria-pressed={isRef(item)} disabled={!isRef(item)&&!!refBlock(item)} title={!isRef(item)&&refBlock(item)?t(refBlock(item)):undefined} onClick={()=>toggleRef(item)}>{t('studio.run.video.addRef')}</button>}
  {original&&media?.src!==item.src&&<button type="button" className="wb-edit-view" data-edit-compare aria-pressed={slider} onClick={()=>setSlider(!slider)}>{t('studio.run.edit.slider')}</button>}
 </div>;
 const toggleLora=(name:string,on:boolean)=>setLoras(on?[...loras.filter(l=>l.name!==name),{name,strength:1}]:loras.filter(l=>l.name!==name));
 // Picking a model applies its family's starting settings (SwarmUI: per-class defaults).
 const pickModel=(m:LocalModel)=>{setCheckpoint(m.name);setResolution('model');const d=familyOf(m)?.defaults;if(d){setWidth(d.width);setHeight(d.height);setSteps(d.steps);setCfg(d.cfg);setSampler(d.sampler);setScheduler(d.scheduler);}};
 useEffect(()=>{
  const layout=()=>{dragCleanup.current();setSettingsWidth(defaultLayout.settings);setQueueWidth(defaultLayout.queue);setDockHeight(defaultLayout.dock);};
  const defaults=()=>{if(!window.confirm(t(project?'studio.quick.confirmProject':'studio.quick.confirm')))return;resetStudioPreferences();setResolution('model');const first=allModels.find(m=>!blocked(m,'t2i'));if(first)pickModel(first);};
  window.addEventListener('deas:reset-studio-layout',layout);window.addEventListener('deas:request-studio-defaults',defaults);
  return()=>{window.removeEventListener('deas:reset-studio-layout',layout);window.removeEventListener('deas:request-studio-defaults',defaults);};
 });
 // Explicit "use these settings": only values the metadata carries; a model/LoRA is picked only if this folder holds it (by full name, else by basename). Returns what was skipped.
 const base=(n:string)=>shortName(n).toLowerCase();
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
 const tile=(m:LocalModel,pressed:boolean,onClick:()=>void,extra?:React.ReactNode,reason='')=><li key={`${m.category}/${m.name}`}><button type="button" aria-label={m.name} aria-pressed={pressed} disabled={!!reason} title={reason?t(reason):m.name} onClick={onClick}>{m.info?.civitai?.preview?<img src={m.info.civitai.preview} alt="" loading="lazy"/>:<span className="wb-thumb" aria-hidden="true">◆</span>}<span className="wb-tile-name">{shortName(m.name)}</span>{familyOf(m)&&<small className="wb-family">{familyOf(m)!.name}</small>}</button>{extra}</li>;
 const pick=(id:string,value:string,list:readonly string[],set:(v:string)=>void,onFocus?:()=>void)=><label key={id} className="wb-field"><span>{t(id)}</span><select value={value} onFocus={onFocus} onPointerDown={onFocus} onChange={e=>set(e.target.value)}>{(list.includes(value)?list:[value,...list]).map(v=><option key={v} value={v}>{v}</option>)}</select></label>;
 const componentPick=(id:string,slot:ComponentSlot,value:string,list:readonly string[],set:(value:string)=>void)=><ComponentPicker key={slot} label={t(id)} value={value} automatic={recommended?.[slot][0]??''} files={list} all={componentOverrides[slot]} onAll={all=>setComponentOverrides({...componentOverrides,[slot]:all})} onChange={set}/>;
 const naming=outputPrefix(outputNamingTemplate(optionsPref.outputNaming),{type:isVideo?'video':'image',seed,model:checkpoint});
 const preview=planVisible&&naming!==null?(isVideo?(videoFamily&&model&&split?buildVideoIntent(videoFamily,naming,optionsPref.output??defaultVideoOutput,(item,force=false)=>(!force&&comfyName(item))||item.path||item.name):null):buildImageIntent(naming,optionsPref.output??defaultVideoOutput)):null;
 const planNotices=[t('studio.plan.validation'),...(unavailable.length?[t('studio.quick.unavailable',{names:unavailable.join(', ')})]:[]),...(!checkpoint?[t('studio.run.noModels')]:[]),...(sizeError?[t(sizeError,{multiple:String(grid)})]:[]),...(inpaint&&!masked?[t('studio.run.edit.needsMask')]:[]),...(naming===null?[t('studio.run.opt.outputNaming.invalid')]:[]),...(!choices?[t('studio.run.opt.unread')]:[]),...((isVideo&&(post||wildcardEnabled||optionsPref.sigmas?.trim()))||(h3Image&&post)?[t('studio.plan.imageOnly')]:[])];
 const inputNotes=[...(inpaint?[t('studio.plan.mask',{blur:String(maskBlur),grow:String(maskGrow),crop:t(inpaintOnlyMasked?'studio.plan.yes':'studio.plan.no')})]:[]),...(pipeline==='i2i'&&layers.some(l=>l.visible)?[t('studio.plan.layersPending')]:[]),...(isVideo?[t('studio.plan.uploadPending')]:[])];
 const projectDraft:ImageDraft={positivePrompt:positive,negativePrompt:negative,checkpoint:project?checkpointPref:checkpoint,width:project&&!model?width:outputSize.width,height:project&&!model?height:outputSize.height,steps,cfg,sampler,scheduler,seed,denoise,pipeline:pipeline==='i2i'?'i2i':'t2i'};
 const restoreProject=(next:ProjectSnapshot|null)=>{
  const d=next?.draft??{positivePrompt:readPref('studio.run.positive','',isString),negativePrompt:readPref('studio.run.negative','',isString),checkpoint:readPref('studio.run.checkpoint','',isString),width:readPref('studio.run.width',1024,isNumber),height:readPref('studio.run.height',1024,isNumber),steps:readPref('studio.run.steps',20,isNumber),cfg:readPref('studio.run.cfg',5,isNumber),sampler:readPref('studio.run.sampler','euler',isString),scheduler:readPref('studio.run.scheduler','normal',isString),seed:readPref('studio.run.seed',0,isSeed),denoise:readPref('studio.run.denoise',0.6,isNumber),pipeline:readPref('studio.run.pipeline','t2i',oneOf(...pipelines))};
  onProject(next);setPositive(d.positivePrompt);setNegative(d.negativePrompt);setCheckpoint(d.checkpoint);setWidth(d.width);setHeight(d.height);setSteps(d.steps);setCfg(d.cfg);setSampler(d.sampler);setScheduler(d.scheduler);setSeed(d.seed);setDenoise(d.denoise);setPipeline(d.pipeline);
  setSeedMode(next?'fixed':readPref('studio.run.seedMode','random',oneOf('random','fixed')));
  setResolution(next?'fixed':readPref('studio.run.resolution','fixed',oneOf('fixed','model','custom',...Object.keys(resolutions))));
  setAspect(next?'auto':readPref('studio.run.aspect','auto',oneOf(...aspects)));
  // This first project schema stores baseline image controls, not optional processing/editor state.
  setLoras(next?[]:readPref('studio.run.loras',[],isLoras));setPost(next?false:readPref('studio.run.post',false,isBoolean));setOptions(next?defaultOptions:readPref('studio.run.options',defaultOptions,isOptionsPref));
  setTextEncoder(next?'':readPref('studio.run.textEncoder','',isString));setVae(next?'':readPref('studio.run.vae','',isString));
  setComponentOverrides(next?defaultComponentOverrides:readPref('studio.run.componentOverrides',defaultComponentOverrides,isComponentOverrides));setVideo(next?defaultVideo:readPref('studio.run.video',defaultVideo,isVideoPref));
  setWildcardEnabled(next?false:readPref('studio.run.wildcardEnabled',false,isBoolean));setEdit(next?'resample':readPref('studio.run.edit','resample',oneOf(...editModes)));setInputScaling(next?'off':readPref('studio.run.inputScaling','off',oneOf(...scalingModes)));
  setRecentSeeds(readPref('studio.run.recentSeeds',[],isSeeds));
  sourceEpoch.current++;setLayers([]);setMasked(false);setBrowsed(null);setSelectedJob('');
  const input=next?.input;
  setMedia(input?{name:input.id+'.png',path:input.path,src:convertFileSrc(input.path),media:'image'}:null);
  setMediaSize(input?{src:convertFileSrc(input.path),width:input.width,height:input.height}:null);
 };
 const stageWarnings=[...new Set([
  ...(checkpointPref&&!model?[t('studio.quick.unavailable',{names:checkpointPref})]:[]),
  ...(unavailable.length?[t('studio.quick.unavailable',{names:unavailable.join(', ')})]:[]),
  ...(error?[backendErrorText(error,t)]:[]),...(shown?.error?[backendErrorText(shown.error,t)]:[]),
 ])];
 const dockNavigation=<div className="wb-dock-tabs" role="tablist" aria-label={t('studio.run.dock')}>{dockTabs.filter(id=>id!=='references'||refsTab).map(id=><button key={id} role="tab" type="button" data-dock-tab={id} aria-selected={dockTab===id} onClick={()=>{focusDockTab.current=true;setDockTab(id);if(id==='options'||id==='post')loadChoices();}}
    // Media tiles live in another tab of this dock, so the References tab button itself takes the drop.
    {...(id==='references'?{onDragOver:(e:React.DragEvent)=>{if(e.dataTransfer.types.includes(MEDIA_DRAG))e.preventDefault();},onDrop:(e:React.DragEvent)=>{const item=draggedItem(e.dataTransfer);if(item){e.preventDefault();addRefs([{item}]);}}}:{})}>{t(id==='wildcards'?'wildcards.title':id==='presets'?'presets.title':`studio.run.dock.${id}`)}{id==='loras'&&activeLoras.length>0&&<small> {activeLoras.length}</small>}{id==='wildcards'&&wildcardEnabled&&<small aria-label={t('wildcards.active')}> ✓</small>}{id==='post'&&post&&<small aria-label={t('studio.run.post.enabled')}> ✓</small>}{id==='options'&&options&&<small> {Object.keys(options).length}</small>}</button>)}</div>;
 return <>
 <ProjectBar draft={projectDraft} busy={busy||!!current||autoPlan||resolving} onRestore={restoreProject}/>
 {planVisible&&<RunPlan intent={preview} pipeline={pipeline} notices={planNotices} outputRoot={outputDir} inputNotes={inputNotes}/>}
 <div hidden={planVisible}>
 <div className="workbench" data-workbench ref={shell} style={{height:fit}}>
  <div className="wb-body">
   <aside id="studio-settings" className="wb-side" style={{flexBasis:sideSize}}>
    <section className="wb-settings" aria-label={t('studio.run.settings')}>
     <label className="wb-field wb-pipeline"><span>{t('studio.run.pipeline')}</span><select data-pipeline value={pipeline} onChange={e=>{const id=e.target.value as Pipeline;setPipeline(id);if(!allModels.some(m=>m.name===checkpointPref&&!blocked(m,id))){const first=allModels.find(m=>!blocked(m,id));if(first)pickModel(first);}}}>{pipelines.map(id=>{const reason=why(id);return <option key={id} value={id} disabled={!!reason} title={reason?t(reason):undefined}>{t(`studio.run.pipe.${id}`)}</option>;})}</select></label>
     <div className="wb-checkpoint"><label className="wb-field"><span>{t('studio.run.checkpoint')}{family&&<> · {family.name}</>}</span><select data-model-picker aria-label={t('studio.run.checkpoint')} title={checkpointPref||checkpoint} value={checkpointPref||checkpoint} onChange={e=>{const next=allModels.find(m=>m.name===e.target.value&&!blocked(m,pipeline));if(next)pickModel(next);}}>
      {!checkpointPref&&!checkpoint&&<option value="" disabled>{t('studio.run.noModels')}</option>}
      {checkpointPref&&!allModels.some(m=>m.name===checkpointPref)&&<option value={checkpointPref} disabled>{checkpointPref}</option>}
      {allModels.map(m=>{const reason=blocked(m,pipeline);return <option key={`${m.category}/${m.name}`} value={m.name} disabled={!!reason} title={reason?t(reason):m.name}>{m.name}</option>;})}
     </select></label><small>{t('studio.run.loras')} {activeLoras.length}</small></div>
     {pipeline==='i2i'&&<p className="wb-active"><span>{t('studio.run.pipe.input')} · {t(`studio.run.edit.${edit}`)}</span><strong title={inputImage}>{fileName(inputImage)}</strong></p>}
    {pipeline==='i2v'&&<p className="wb-active"><span>{t('studio.run.pipe.input')}</span><strong title={inputImage}>{fileName(inputImage)}</strong></p>}
    {pipeline==='v2v'&&<p className="wb-active"><span>{t('studio.run.video.source')}</span><strong title={media?.path}>{media?.media==='video'?media.name:''}</strong></p>}
     <div className="wb-controls">
      {h3Image&&<p className="wb-resolution-hint wb-wide">{t('studio.run.h3EditHint')}</p>}
      {inpaint?<>{!h3Image&&num('denoise',strength,setStrength,0,1,0.05,undefined,true)}<p className="wb-resolution-hint">{t('studio.run.edit.size',{width:String(outputSize.width),height:String(outputSize.height)})}</p></>:<>
      <label className="wb-field"><span>{t('studio.run.resolution.aspect')}</span><span className="wb-aspect-picker"><span className="wb-aspect-swatch" aria-hidden="true"><span style={{width:18*Math.min(1,swatchRatio),height:18*Math.min(1,1/swatchRatio)}}/></span><select value={aspect} onChange={e=>{setAspect(e.target.value as typeof aspect);if(resolution==='fixed')setResolution('model');}}>{aspects.filter(a=>a!=='auto'||mediaPipeline).map(a=><option key={a} value={a}>{a==='auto'||a==='custom'?t(`studio.run.resolution.${a}`):a}</option>)}</select></span></label>
      <label className="wb-field"><span>{t('studio.run.resolution.title')}</span><select value={resolution} onChange={e=>setResolution(e.target.value)}>{['fixed','model',...Object.keys(resolutions),'custom'].map(r=><option key={r} value={r} disabled={r==='model'&&!family?.defaults}>{r in resolutions?r:t(`studio.run.resolution.${r}`)}</option>)}</select></label>
      {aspect==='custom'&&<>{num('resolution.aspectWidth',aspectWidth,setAspectWidth,1,100,0.1)}{num('resolution.aspectHeight',aspectHeight,setAspectHeight,1,100,0.1)}</>}
      {resolution==='custom'&&num('resolution.megapixels',megapixels,setMegapixels,0.01,16,0.05)}
      {num('width',canvas.width,n=>{setWidth(n);setHeight(canvas.height);setResolution('fixed');},64,8192,8)}{num('height',canvas.height,n=>{setHeight(n);setWidth(canvas.width);setResolution('fixed');},64,8192,8)}</>}
      {isVideo&&family?.video&&split&&<>
       {num('video.seconds',video.seconds,n=>setVideo({...video,seconds:clamp(n,0.5,15)}),0.5,15,0.5)}{num('video.fps',fps,n=>setVideo({...video,fps:clamp(n,1,120)}),1,120,1,family.video.fixedFps?t('studio.run.video.fixedFps',{fps:String(family.video.fps)}):undefined)}
       <p className="wb-resolution-hint wb-wide">{t('studio.run.video.length',{frames:String(frames),seconds:((frames-1)/fps).toFixed(2)})}</p>
       {videoFamily==='ltx-2'&&<>
        <label className="wb-field"><span>{t('studio.run.video.passes')}</span><select value={video.passes} onChange={e=>setVideo({...video,passes:Number(e.target.value) as VideoPref['passes']})}>{[1,2,3].map(n=><option key={n} value={n} disabled={n>1&&!(choices?.latentUpscaleModels?.length||!choices)}>{n}</option>)}</select></label>
        {video.passes>1&&pick('studio.run.video.upscaler',video.upscaler||choices?.latentUpscaleModels?.[0]||'',choices?.latentUpscaleModels??[],v=>setVideo({...video,upscaler:v}),loadChoices)}</>}
       {videoFamily==='wan'&&<>{num('video.shiftHigh',video.shiftHigh,n=>setVideo({...video,shiftHigh:clamp(n,0.5,20)}),0.5,20,0.5)}{num('video.shiftLow',video.shiftLow,n=>setVideo({...video,shiftLow:clamp(n,0.5,20)}),0.5,20,0.5)}{num('video.refinerStep',Math.min(video.refinerStep,steps-1),n=>setVideo({...video,refinerStep:clamp(Math.round(n),1,Math.max(1,steps-1))}),1,Math.max(1,steps-1),1)}</>}
       {videoFamily==='minimax-h3'&&<>{num('video.shiftVideo',video.shiftVideo,n=>setVideo({...video,shiftVideo:clamp(n,0.01,100)}),0.01,100,0.5)}{num('video.shiftAudio',video.shiftAudio,n=>setVideo({...video,shiftAudio:clamp(n,0.01,100)}),0.01,100,0.5)}
        {/* The Director scales every reference picture/video (incl. first/last frame) to the canvas with this mode. */}
        {(pipeline!=='t2v'||!!lastFrame)&&<><label className="wb-field wb-wide"><span>{t('studio.run.resolution.scaling')}</span><select data-h3-scaling value={h3Scaling} title={t(`studio.run.resolution.hint.${h3ScalingKey[h3Scaling]}`)} onChange={e=>setH3Scaling(e.target.value as H3Scaling)}>{h3Scalings.map(s=><option key={s} value={s}>{t(`studio.run.resolution.scale.${h3ScalingKey[s]}`)}</option>)}</select></label><p className="wb-resolution-hint wb-wide">{t(`studio.run.resolution.hint.${h3ScalingKey[h3Scaling]}`)}</p></>}</>}
       {pipeline==='v2v'&&(videoFamily==='ltx-2'?num('video.sourceStrength',sourceStrength,n=>setSourceStrength(clamp(n,0,1)),0,1,0.05,undefined,true)
        :<label className="wb-field wb-wide"><span><input type="checkbox" style={{width:'auto'}} checked={sourceAudio} onChange={e=>setSourceAudio(e.target.checked)}/>{t('studio.run.video.sourceAudio')}</span></label>)}
       {refsTab&&<p className="wb-active wb-wide"><span>{t('studio.run.video.refs')} · {refs.length}</span><button type="button" className="wb-dock-action" data-open-references onClick={()=>setDockTab('references')}>{t('studio.run.video.editRefs')}</button></p>}
       {videoFamily==='minimax-h3'&&(pipeline==='v2v'||pipeline==='ref2v')&&!/ref2va/i.test(checkpoint)&&<p className="wb-resolution-hint wb-wide">{t('studio.run.video.ref2vaHint')}</p>}
       {frameVideo&&videoFamily==='minimax-h3'&&[pipeline==='i2v'&&media?.media==='image'?media:null,lastFrame].map((item,i)=>item&&<div className="wb-wide" key={`${i}:${item.src}`} data-frame-people={i===0?'first':'last'}>
        <p className="wb-resolution-hint">{t(i===0?'forge.role.first-frame':'forge.role.last-frame')} · {item.name}</p>
        <ReferencePeople key={item.src} r={{item,second:0,strength:1,mediaMode:'video',who:[],...framePeople[item.src]}} label="" allowEmpty endpoint={endpoint} root={root} inputRoot={roots.input} onChange={x=>setFramePeople(p=>({...p,[item.src]:{...p[item.src],...x}}))}/>
       </div>)}
       {continuityAvailable&&<button ref={continuityButton} type="button" className="wb-dock-action wb-wide" data-continuity-open aria-haspopup="dialog" aria-expanded={continuityOpen} onClick={()=>setContinuityOpen(true)}>{t('studio.run.dock.continuity')}</button>}
       {frameVideo&&<p className="wb-resolution-hint wb-wide">{lastFrame?<>{t('studio.run.video.lastFrame')}: <strong>{lastFrame.name}</strong> <button type="button" aria-label={t('studio.run.cont.remove')} title={t('studio.run.cont.remove')} onClick={()=>setLastFrame(null)}>✕</button></>:t('studio.run.video.lastFrameHint')}</p>}
      </>}
      {pipeline==='i2i'&&!inpaint&&<><label className="wb-field wb-wide"><span>{t('studio.run.resolution.scaling')}</span><select value={inputScaling} title={t(`studio.run.resolution.hint.${inputScaling}`)} onChange={e=>setInputScaling(e.target.value as ScalingMode)}>{scalingModes.map(s=><option key={s} value={s}>{t(`studio.run.resolution.scale.${s}`)}</option>)}</select></label><p className="wb-resolution-hint">{t(`studio.run.resolution.hint.${inputScaling}`)}</p>{!h3Image&&num('denoise',denoise,setDenoise,0,1,0.05,undefined,true)}{h3Image&&<>{num('video.shiftVideo',video.shiftVideo,n=>setVideo({...video,shiftVideo:clamp(n,0.01,100)}),0.01,100,0.5)}{num('video.shiftAudio',video.shiftAudio,n=>setVideo({...video,shiftAudio:clamp(n,0.01,100)}),0.01,100,0.5)}</>}</>}
      {inpaint&&<>
       <label className="wb-field wb-wide" title={t('studio.run.maskGrowHelp')}><span><input type="checkbox" style={{width:'auto'}} checked={inpaintOnlyMasked} onChange={e=>setInpaintOnlyMasked(e.target.checked)}/>{t('studio.run.inpaintOnlyMasked')}</span></label>
       {inpaintOnlyMasked&&num('maskGrow',maskGrow,n=>{if(isMaskGrow(n))setMaskGrow(n);},0,512,1,undefined,true)}
       {num('maskBlur',maskBlur,n=>{if(isMaskBlur(n))setMaskBlur(n);},0,31,1,undefined,true)}
       {h3Image&&<>{num('video.shiftVideo',video.shiftVideo,n=>setVideo({...video,shiftVideo:clamp(n,0.01,100)}),0.01,100,0.5)}{num('video.shiftAudio',video.shiftAudio,n=>setVideo({...video,shiftAudio:clamp(n,0.01,100)}),0.01,100,0.5)}</>}
      </>}
      {num('steps',sigmas?sigmas.length-1:steps,setSteps,1,150,1,sigmas&&t('studio.run.customSchedule.hint'),true)}{num('cfg',cfg,setCfg,0,30,0.5,undefined,true)}
      {pick('studio.recipe.sampler',sampler,choices?.samplers??[],setSampler,loadChoices)}
      {sigmas?<label className="wb-field"><span>{t('studio.recipe.scheduler')}</span><select value="custom" disabled title={t('studio.run.customSchedule.hint')}><option value="custom">{t('studio.run.customSchedule')}</option></select></label>
       :pick('studio.recipe.scheduler',scheduler,choices?.schedulers??[],setScheduler,loadChoices)}
      <div className="wb-field wb-seed">
       <label><span>{t('studio.run.seed')}</span><input aria-label={t('studio.run.seed')} type="number" inputMode="numeric" value={seed} min={0} max={Number.MAX_SAFE_INTEGER} step={1} onChange={e=>{const n=Number(e.target.value);if(isSeed(n))fixedSeed(n);}}/></label>
       <div className="wb-seed-row"><button type="button" aria-label={t('studio.run.seedDecrease')} title={t('studio.run.seedDecrease')} onClick={()=>fixedSeed(seed===0?Number.MAX_SAFE_INTEGER:seed-1)}>−</button><button type="button" aria-label={t('studio.run.seedIncrease')} title={t('studio.run.seedIncrease')} onClick={()=>fixedSeed(seed===Number.MAX_SAFE_INTEGER?0:seed+1)}>+</button>{(['random','fixed'] as const).map(mode=><button key={mode} type="button" aria-pressed={seedMode===mode} onClick={()=>setSeedMode(mode)}>{t(`studio.run.seedMode.${mode}`)}</button>)}<button type="button" aria-label={t('studio.run.newSeed')} title={t('studio.run.newSeed')} onClick={()=>setSeed(randomSeed())}>⟳</button></div>
       <button type="button" disabled={!recentSeeds.length} onClick={()=>fixedSeed(recentSeeds[0])}>{t('studio.run.seedLast')}</button>
       <details className="wb-seed-history"><summary>{t('studio.run.seedHistory')}</summary>{recentSeeds.map(value=><div className="wb-seed-row" key={value}><button type="button" aria-label={t('studio.run.seedUse',{seed:String(value)})} title={t('studio.run.seedUse',{seed:String(value)})} onClick={()=>fixedSeed(value)}>{value}</button><button type="button" aria-label={t('studio.run.seedCopy',{seed:String(value)})} title={t('studio.run.seedCopy',{seed:String(value)})} onClick={()=>void copySeed(value)}>⧉</button></div>)}</details>
       {copyStatus&&<span role="status">{copyStatus}</span>}
      </div>
     </div>
     {split&&<details className="wb-model-files"><summary>{t('studio.components.title')}</summary><div className="wb-component-menu">
      {componentPick('studio.run.textEncoder','textEncoders',textEncoderPref,split.encoders,setTextEncoder)}
      {componentPick('studio.run.vae','vaes',vaePref,split.vaes,setVae)}
      {isVideo&&family?.audioVaes&&componentPick('studio.run.video.audioVae','audioVaes',video.audioVae,split.audioVaes,v=>setVideo({...video,audioVae:v}))}
      {isVideo&&family?.textProjections&&componentPick('studio.run.video.textProjection','textProjections',video.textProjection,split.projections,v=>setVideo({...video,textProjection:v}))}
     </div></details>}
     {!native&&<p className="field-help">{t('studio.jobs.browser')}</p>}
    </section>
   </aside>
   {columnHandle('settings')}
   <div className="wb-center">
    <section className={`wb-stage${!browsed&&sideBySide?' wb-split':''}`} aria-label={t('studio.run.preview')}>
     {stageWarnings.length>0&&<div className="wb-stage-warning" role="alert">{stageWarnings.map(message=><p key={message}>{message}</p>)}{mossIssues.map(issue=><button type="button" key={issue.name} onClick={issue.reset}>{t('studio.run.opt.reset',{name:issue.name})}</button>)}</div>}
     {(browsed||media||shown)&&<button type="button" className="wb-stage-close" data-preview-close aria-label={t('studio.run.close')} title={t('studio.run.close')} onClick={closePreview}>✕</button>}
     {(browsed||media||shown)&&<button type="button" className="wb-stage-meta" data-metadata-toggle aria-pressed={metaOpen} onClick={()=>setMetaOpen(!metaOpen)}>{t('studio.run.metadata.button')}</button>}
     {!browsed&&(media||shown)&&(hint||(!shown&&stageMark))&&<div className="wb-stage-notes">{!shown&&stageMark&&<span className="media-mark wb-stage-mark">{stageMark}</span>}{hint&&<p className="wb-stage-hint" role="status">{t(hint,{multiple:String(grid)})}</p>}</div>}
     {(browsed||media||shown)&&metaOpen&&<GenerationMetadata job={browsed?null:shown} media={browsed??(shown?null:media)} onApply={applySettings}/>}
     {browsed&&<figure className="media-preview" data-browsed-preview>{browsed.media==='image'?<img className="wb-zoomable" src={browsed.src} alt={browsed.name} role="button" tabIndex={0} aria-label={t('studio.run.viewer.open')} title={t('studio.run.viewer.open')} onClick={e=>openImage(e,browsed)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setViewer({src:browsed.src,alt:browsed.name,item:browsed});}}}/>:browsed.media==='video'?linuxVideo?<NativeVideo source={{path:browsed.path??''}} label={browsed.name}/>:<video src={native?browsedBlob.url:browsed.src} controls/>:<audio src={native?browsedBlob.url:browsed.src} controls/>}{tools(browsed)}<figcaption>{browsed.name}{browsedBlob.error&&<span className="error-message"> · {browsedBlob.error}</span>}</figcaption></figure>}
     <div className="wb-current-preview" hidden={!!browsed}>
     {editableSource&&media&&<div className="wb-editor-host" hidden={!!shown&&!editorLeft}>
      <StudioImageEditor key={sourceEpoch.current} ref={editorRef} source={{src:media.src,name:media.name,width:editableSource.width,height:editableSource.height}} layers={layers} onLayers={setLayers} maskMode={inpaint} onMask={setMasked} onInsert={insertLayer} layout={sideBySide?'split':'full'}/>
      {inputImage&&tools(media)}<span className="wb-editor-caption">{media.name} · {t('studio.run.edit.insertHint')}</span>
     </div>}
     {sideBySide&&!editorLeft&&<figure className="media-preview"><img src={original} alt={t('studio.run.edit.original')}/></figure>}
     {shown&&media&&!sideBySide&&<button type="button" className="wb-return-draft" data-editor-return onClick={()=>setSelectedJob('')}>{t('studio.editor.returnDraft')}</button>}
     {shown?<div className="wb-shown"><p className="wb-job-line"><span data-state={shown.state}>{t(`studio.jobs.${shown.state}`)}</span> · <code>{shown.id.slice(0,8)}</code>{duration(shown)}</p>
      {shown.state==='succeeded'&&shown.outputs.length>0&&(outputDir?<figure className="media-preview">{original&&slider?<CompareView key={`${original}|${shown.id}`} original={original} originalAlt={t('studio.run.edit.original')} edited={fileSrc(shown.outputs[0])!} editedAlt={shown.outputs[0].filename} dividerLabel={t('studio.run.edit.divider')}/>
        :shown.outputs.map(o=>isVideoOut(o)?linuxVideo?<NativeVideo key={o.filename} source={{baseUrl:shown.baseUrl,filename:o.filename,subfolder:o.subfolder,type:o.type}} label={o.filename} active={!browsed} autoPlay loop/>:<video key={o.filename} src={videoSrc(shown,o)} controls autoPlay loop onError={e=>setMediaFault(mediaError(e))}/>:<img key={o.filename} className="wb-zoomable" src={fileSrc(o)!} alt={o.filename} title={t('studio.run.viewer.open')} onClick={e=>openImage(e,outputItem(o))}/>)}{!isVideoOut(shown.outputs[0])&&tools(outputItem(shown.outputs[0]),false)}<figcaption><span className="wb-output-stars">{shown.outputs.map(o=><StarMediaButton key={o.filename} item={outputItem(o)}/>)}</span>{original&&slider&&<>{t('studio.run.edit.original')} | </>}{shown.outputs.map(o=>o.filename).join(' · ')}{mediaFault&&<> · <span className="error-message">{mediaFault}</span></>}</figcaption></figure>:isVideoOut(shown.outputs[0])?<figure className="media-preview">{shown.outputs.filter(isVideoOut).map(o=>linuxVideo?<NativeVideo key={o.filename} source={{baseUrl:shown.baseUrl,filename:o.filename,subfolder:o.subfolder,type:o.type}} label={o.filename} active={!browsed} autoPlay loop/>:<video key={o.filename} src={videoSrc(shown,o)} controls autoPlay loop onError={e=>setMediaFault(mediaError(e))}/>)}<figcaption><span className="wb-output-stars">{shown.outputs.map(o=><StarMediaButton key={o.filename} item={outputItem(o)}/>)}</span>{shown.outputs.map(o=>o.filename).join(' · ')}{mediaFault&&<> · <span className="error-message">{mediaFault}</span></>}</figcaption></figure>:<JobOutputPreview job={shown} outputRoot={outputDir} auto/>)}
      {(shown.state==='queued'||shown.state==='running')&&(shown.preview?<figure className="media-preview" aria-busy="true"><img src={shown.preview} alt={t('studio.run.working')}/>{shown.progress&&<figcaption><progress value={shown.progress.value} max={shown.progress.max}/> {shown.progress.value}/{shown.progress.max}</figcaption>}</figure>
       :<p className="empty-note" aria-busy="true"><span className="aio-spinner" aria-hidden="true"/> {t('studio.run.working')}{shown.progress&&<> {shown.progress.value}/{shown.progress.max}</>}</p>)}</div>
     :media&&!editableSource?<figure className="media-preview">{media.media==='image'?<img className="wb-zoomable" src={media.src} alt={media.name} title={t('studio.run.viewer.open')} onClick={e=>openImage(e,media)} onLoad={e=>readMediaSize(e.currentTarget.naturalWidth,e.currentTarget.naturalHeight)}/>:media.media==='video'?linuxVideo?<NativeVideo source={{path:media.path??''}} label={media.name} active={!browsed} onSize={readMediaSize}/>:<video src={native?mediaBlob.url:media.src} controls onError={e=>setMediaFault(mediaError(e))} onLoadedMetadata={e=>readMediaSize(e.currentTarget.videoWidth,e.currentTarget.videoHeight)}/>:<audio src={native?mediaBlob.url:media.src} controls onError={e=>setMediaFault(mediaError(e))}/>}{(inputImage||(pipeline==='ref2v'&&media.path))?tools(media):<StarMediaButton item={media}/>}<figcaption>{media.name}{(mediaBlob.error||mediaFault)&&<> · <span className="error-message">{mediaBlob.error??mediaFault}</span></>}</figcaption></figure>
     :!media?<p className="empty-note" role={hint?'status':undefined}>{t(hint||'studio.run.empty')}</p>:null}
     </div>
     {viewer&&<ImageViewer src={viewer.src} alt={viewer.alt} item={viewer.item} onClose={()=>setViewer(null)}/>}
    </section>
    <div className="wb-prompts">
     <div className="wb-prompt"><label htmlFor="run-positive">{t('studio.run.positive')}</label><textarea id="run-positive" data-run-positive value={positive} maxLength={16384} placeholder={t('studio.run.positiveHint')} onChange={e=>setPositive(e.target.value)}/><button type="button" className="wb-prompt-expand" data-prompt-expand="positive" aria-label={t('studio.run.prompt.expand',{name:t('studio.run.positive')})} title={t('studio.run.prompt.expand',{name:t('studio.run.positive')})} aria-pressed={detached==='positive'} onClick={()=>setDetached(detached==='positive'?null:'positive')}>⤢</button>{promptActions('positive',positive,setPositive)}<ForgeButton endpoint={endpoint} root={root} dialect={dialectOf(model?.family)} value={positive} image={pipeline==='i2i'?inputImage||undefined:undefined} onApply={setPositive} onWildcards={openWildcards} wildcard={wildcardEnabled?wildcard:undefined} h3={forgeContext} tools={promptTools}/></div>
     <div className="wb-prompt wb-negative"><label htmlFor="run-negative">{t('studio.run.negative')}</label><textarea id="run-negative" data-run-negative value={negative} maxLength={16384} placeholder={t('studio.run.negativeHint')} onChange={e=>setNegative(e.target.value)}/><button type="button" className="wb-prompt-expand" data-prompt-expand="negative" aria-label={t('studio.run.prompt.expand',{name:t('studio.run.negative')})} title={t('studio.run.prompt.expand',{name:t('studio.run.negative')})} aria-pressed={detached==='negative'} onClick={()=>setDetached(detached==='negative'?null:'negative')}>⤢</button>{promptActions('negative',negative,setNegative)}</div>
     {detached&&<PromptOverlay key={detached} title={t(`studio.run.${detached}`)} value={detached==='positive'?positive:negative} onChange={detached==='positive'?setPositive:setNegative} onClose={()=>setDetached(null)} placeholder={t(detached==='positive'?'studio.run.positiveHint':'studio.run.negativeHint')} maxLength={16384} closeLabel={t('studio.run.prompt.close')}>{detached==='positive'&&<ForgeButton endpoint={endpoint} root={root} dialect={dialectOf(model?.family)} value={positive} image={pipeline==='i2i'?inputImage||undefined:undefined} onApply={setPositive} onWildcards={openWildcards} wildcard={wildcardEnabled?wildcard:undefined} h3={forgeContext} tools={promptTools}/>}</PromptOverlay>}
    </div>
    {wildcardEnabled&&<div className="wildcard-prompt-status"><button type="button" className="wildcard-badge" title={t('wildcards.baseNotice')} onClick={()=>setDockTab('wildcards')}>{t(wildcard.auto_reroll?'wildcards.activeAuto':'wildcards.active')}</button><button type="button" className="wildcard-badge" onClick={()=>setWildcardEnabled(false)}>{t('wildcards.disable')}</button></div>}
   </div>
   {columnHandle('queue')}
   <section id="studio-queue" style={{flexBasis:queueSize}} className="wb-queue" aria-label={t('studio.run.queue')}>
    <h3>{t('studio.run.queue')}</h3>
    {jobs.length===0?<p className="media-help">{t('studio.run.queueEmpty')}</p>:<ul>{jobs.map(j=><li key={j.id}>{(j.state==='succeeded'&&j.outputs.length?j.outputs:[null]).map((o,index)=><div className="wb-queue-output" key={index}><button className="wb-queue-select" type="button" aria-current={j.id===selectedJob} data-state={j.state} onClick={()=>pickJob(j)}>
     {outputDir&&o&&!isVideoOut(o)?<img src={fileSrc(o)!} alt=""/>:o&&isVideoOut(o)?<span className="wb-thumb" aria-hidden="true">▶</span>:j.preview?<img src={j.preview} alt=""/>:<span className="wb-thumb" aria-hidden="true">{j.state==='failed'||j.state==='unknown'?'!':j.state==='succeeded'?'✓':'…'}</span>}
     <span className="wb-queue-text"><strong>{t(`studio.jobs.${j.state}`)} · {j.id.slice(0,8)}{duration(j)}{j.progress&&<> {j.progress.value}/{j.progress.max}</>}</strong><small>{o?.filename??j.outputs[0]?.filename??j.id.slice(0,8)}</small></span></button>{o&&<StarMediaButton item={outputItem(o)}/>}</div>)}</li>)}</ul>}
     <div className="wb-run-actions">
     <button type="button" className="aio-confirm-button wb-run" data-run disabled={!native||busy||!!current||!!sizeError||(inpaint&&!masked)||!checkpoint||unavailable.length>0} title={!native?t('studio.backendHelp'):busy||current?undefined:sizeError?t(sizeError,{multiple:String(grid)}):inpaint&&!masked?t('studio.run.edit.needsMask'):!checkpoint?t('studio.run.noModels'):unavailable.length?t('studio.quick.unavailable',{names:unavailable.join(', ')}):undefined} onClick={()=>void run()}>{t(current?'studio.run.running':busy?'studio.run.preparing':'studio.run.run')}</button><span id="project-actions-slot"/></div>
     <div id="project-status-slot"/>
   </section>
  </div>
  <div className="wb-dock" data-view={dockView} style={{height:dockSize}}>
   <div className="wb-dock-handle" role="separator" aria-orientation="horizontal" aria-label={t('studio.run.dockResize')} title={t('studio.run.dockResize')} tabIndex={0} aria-valuemin={120} aria-valuemax={dockMax} aria-valuenow={dockSize} onKeyDown={e=>resizeKey(e,dockSize,120,dockMax,setDockHeight,true)} onPointerDown={e=>dragPane(e,dockSize,120,dockMax,setDockHeight,true)}/>
   {dockTab==='media'?<MediaPanel selected={browsed??media} onSelect={setBrowsed} roots={roots} outputRevision={outputRevision} controls={{query,onQuery:setQuery,sort,onSort:setSort,view:dockView,onView:setDockView,type:dockType,onType:setDockType}} toolbar={dockNavigation} marks={marks} actions={mediaActions}/>:<div className="media-toolbar">{dockNavigation}
    {(dockTab==='models'||dockTab==='loras')&&<><MediaControls query={query} onQuery={setQuery} sort={sort} onSort={setSort} view={dockView} onView={setDockView} sorts={sorts}/><button type="button" className="wb-dock-action" data-run-load disabled={!native||busy||(!modelsDir&&!endpoint.trim())} onClick={()=>void load()}>{t(models?'studio.run.reload':'studio.run.load')}</button></>}
   </div>}
   {dockTab==='presets'&&<div className="wb-dock-panel"><PresetPanel disabled={busy||!!current||autoPlan||resolving}/></div>}
    {dockTab==='wildcards'&&<div className="wb-dock-panel"><WildcardPanel endpoint={endpoint} value={wildcard} onChange={setWildcard} enabled={wildcardEnabled} onEnabled={setWildcardEnabled}/></div>}
   {dockTab==='post'&&<section className="wb-dock-panel" aria-label={t('studio.run.dock.post')}><div className="wb-options">
    <div className="wb-option"><span><label className="wb-option-row"><input type="checkbox" checked={post} onChange={e=>setPost(e.target.checked)}/>{t('studio.run.post.enabled')}</label></span><small>{t('studio.run.post.hint',{width:String(up(outputSize).width),height:String(up(outputSize).height)})}</small></div>
    <div className="wb-option"><span><label className="wb-option-row"><input type="checkbox" checked={postTiled} disabled={!!choices&&!choices.nodes?.includes('DaSiWaTiledDiffusion')} onChange={e=>setPostTiled(e.target.checked)}/>{t('studio.run.post.tiled')}</label></span><small>{t(choices&&!choices.nodes?.includes('DaSiWaTiledDiffusion')?'studio.run.post.tiledMissing':'studio.run.post.tiledHint',{width:String(snap(modelSize.width)),height:String(snap(modelSize.height)),overlap:String(snap(Math.max(64,Math.min(modelSize.width,modelSize.height)/8)))})}</small></div>
    <label className="wb-option"><span>{t('studio.run.post.denoise')}</span><input type="number" value={refineDenoise} min={0.05} max={1} step={0.05} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n))setRefineDenoise(clamp(n,0.05,1));}}/></label>
    <label className="wb-option"><span>{t('studio.run.upscale')}</span><input type="number" value={upscale} min={1} max={4} step={0.25} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n))setUpscale(clamp(n,1,4));}}/></label>
    <label className="wb-option"><span>{t('studio.run.post.model')}</span><select value={upscaleModel} onFocus={loadChoices} onPointerDown={loadChoices} onChange={e=>setUpscaleModel(e.target.value)}><option value="">{t('studio.run.post.lanczos')}</option>{(choices?.upscaleModels??[]).map(m=><option key={m} value={m}>{m}</option>)}</select></label>
   </div></section>}
   {dockTab==='references'&&refsTab&&<section className="wb-dock-panel" aria-label={t('studio.run.dock.references')}><ReferencesPanel endpoint={endpoint} root={root} refs={refs} onChange={setRefs} family={videoFamily as 'ltx-2'|'minimax-h3'} seconds={video.seconds} label={refLabel} onAdd={addRefs} inputRoot={roots.input} refmods={refmods} onRefmods={setRefmods} library={native&&endpoint.trim()?()=>readRefMods(endpoint):undefined} onInsert={tag=>setPositive(positive.trim()?`${positive.trimEnd()} ${tag}`:tag)}/></section>}
   {dockTab==='options'&&<section className="wb-dock-panel" aria-label={t('studio.run.dock.options')}><OptionsPanel value={optionsPref} onChange={setOptions} allow={choices} family={family?.id} imageInput={pipeline==='i2i'} onRead={loadChoices} canRead={native&&!!endpoint.trim()}/></section>}
   {(dockTab==='models'||dockTab==='loras')&&<section className="wb-dock-panel" aria-label={t(`studio.run.dock.${dockTab}`)}>
    {!models&&<p className="media-help">{t(modelsDir?'studio.run.scanHelp':'studio.run.loadHelp')}</p>}
    {models&&dockTab==='models'&&(allModels.length===0?<p className="media-help">{t('studio.run.noModels')}</p>:<div className="media-browser">{folderTree(allModels)}<ul className="wb-tiles" data-run-checkpoint>{allModels.filter(match).sort(bySort).map(m=>tile(m,m===model,()=>pickModel(m),undefined,blocked(m,pipeline)))}</ul></div>)}
    {models&&dockTab==='loras'&&(loraNames.length===0?<p className="media-help">{t('studio.run.noLoras')}</p>:<div className="media-browser">{folderTree(loraModels)}<ul className="wb-tiles wb-loras">{loraModels.filter(match).sort(bySort).map(m=>{const on=loras.find(l=>l.name===m.name);return tile(m,!!on,()=>toggleLora(m.name,!on),on&&<input type="number" aria-label={t('studio.run.strength',{name:m.name})} value={on.strength} min={-10} max={10} step={0.05} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n)&&Math.abs(n)<=10)setLoras(loras.map(l=>l.name===m.name?{...l,strength:n}:l));}}/>);})}</ul></div>)}
   </section>}
  </div>
 </div>
 {continuityOpen&&continuityAvailable&&!planVisible&&<ContinuityOverlay endpoint={endpoint} root={root} forgeContext={forgeContext} plan={plan} onChange={setPlan} onRun={runPlan} running={autoPlan||resolving||!!planRun.current||!!current} disabled={!native||busy||!isVideo||!!sizeError} onClose={()=>{setContinuityOpen(false);continuityButton.current?.focus();}}/>}
 </div></>;
}
