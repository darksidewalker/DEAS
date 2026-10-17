import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import type { DiagnosticImageIntentV1 } from '../../lib/execution';
import { prepareDiagnosticJob, submitDiagnosticJob, readDiagnosticJobStatus, type JobStatus } from '../../lib/jobs';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels, type LocalModel } from '../../lib/models';
import { MediaLibrary, type MediaRoots } from '../media/MediaLibrary';
import type { MediaItem } from '../../lib/media';
import { isString, oneOf, readPref, usePref } from '../../lib/preferences';
import { JobOutputPreview } from './JobOutputPreview';
import builtinFamilies from '../../families/builtin.json';
import { aspects, resolutions, scalingModes, canvasSize, scaleInput, validCanvas, type Size, type ScalingMode } from '../../lib/resolution';
import './workbench.css';
/** Data-only family plugin (also read natively for header detection): loader, runnable pipelines, encoder/VAE file patterns, starting settings. */
interface Family { id:string; name:string; loader:string; pipelines:string[]; clipType?:string; textEncoders?:string[]; vaes?:string[]; defaults?:{width:number;height:number;steps:number;cfg:number;sampler:string;scheduler:string} }
const families=new Map((builtinFamilies as Family[]).map(f=>[f.id,f]));
const modelCategories=['checkpoints','diffusion_models','unet'];
type Lora={name:string;strength:number};
const isLoras=(v:unknown):v is Lora[]=>Array.isArray(v)&&v.every(l=>l&&typeof l.name==='string'&&typeof l.strength==='number');
const isNumber=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const randomSeed=()=>Math.floor(Math.random()*2**32);
const dockTabs=['media','models','loras'] as const;
/** Pipeline taxonomy. Only `t2i`/`i2i` have a verified native recipe today; the video ones stay listed but disabled until one exists. */
const pipelines=['t2i','i2i','t2v','i2v','v2v','ref2v'] as const;
type Pipeline=typeof pipelines[number];
export interface WorkbenchProps { endpoint:string; /** Environment folders: models are listed directly from disk (without it the running backend is asked), output enables direct previews of finished files. */ roots?:MediaRoots&{models?:string} }
/** Text-to-image workbench: settings left, preview over the prompts, queue right, bottom dock with Media · Models · LoRAs tabs. */
export function Workbench({endpoint,roots={}}:WorkbenchProps){
 const {t}=useI18n();const native=isTauri();const modelsDir=roots.models;const outputDir=roots.output;
 const [media,setMedia]=useState<MediaItem|null>(null);
 const [outputRevision,setOutputRevision]=useState(0);
 const [dockTab,setDockTab]=usePref('studio.dock.tab','media',oneOf(...dockTabs));
 const [dockHeight,setDockHeight]=usePref('studio.dock.height',220,isNumber);
 const [sortPref,setSort]=usePref('studio.dock.sort','date',oneOf('date','name','size'));
 const [query,setQuery]=useState('');
 const [models,setModels]=useState<LocalModel[]|null>(null);
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const [positive,setPositive]=usePref('studio.run.positive','',isString);
 const [negative,setNegative]=usePref('studio.run.negative','',isString);
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
 // Sampler/scheduler choices are whatever the backend lists; read on first use of a picker (no auto-inspection).
 const [choices,setChoices]=useState<{samplers:readonly string[];schedulers:readonly string[]}|null>(null);
 const [seed,setSeed]=useState(randomSeed);const [lockSeed,setLockSeed]=useState(false);
 const [denoise,setDenoise]=usePref('studio.run.denoise',0.6,isNumber);
 const [pipelinePref,setPipeline]=usePref<Pipeline>('studio.run.pipeline','t2i',oneOf(...pipelines));
 const [jobs,setJobs]=useState<JobStatus[]>([]);const [selectedJob,setSelectedJob]=useState('');
 const live=useRef(false);const lock=useRef(false);const epoch=useRef(0);
 const loadChoices=()=>{if(native&&!choices&&endpoint.trim())checkRecipePrerequisites(endpoint).then(e=>{if(live.current)setChoices(e.allowlist);},()=>{});};
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
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
 const match=(m:LocalModel)=>m.name.toLowerCase().includes(query.trim().toLowerCase());
 const bySort=(a:LocalModel,b:LocalModel)=>sort==='size'?b.size-a.size:byName(a,b);
 // ComfyUI's LoadImage only reads its input folder, so image-to-image needs a picked image from exactly there.
 const inputImage=media?.media==='image'&&media.path&&roots.input&&media.path.startsWith(roots.input+'/')?media.path.slice(roots.input.length+1):'';
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
 const loraModels=(models??[]).filter(m=>m.category==='loras'&&(!family||!m.family||m.family===family.id)).sort(byName);
 const loraNames=loraModels.map(m=>m.name);
 const activeLoras=loras.filter(l=>loraNames.includes(l.name));
 const source=mediaSize&&mediaSize.src===media?.src?mediaSize:undefined;
 const modelSize=family?.defaults??{width:1024,height:1024};
 const canvas=canvasSize(aspect,resolution,{width:aspectWidth,height:aspectHeight},megapixels,{width,height},modelSize,mediaPipeline?source:undefined);
 const scaled=pipeline==='i2i'&&source?scaleInput(inputScaling,source,canvas):null;
 const outputSize=scaled?.size??canvas;
 const sizeError=!validCanvas(canvas)||!validCanvas(outputSize)?'studio.run.resolution.invalid'
  :pipeline==='i2i'&&!source?'studio.run.resolution.waiting'
  :mediaPipeline&&aspect==='auto'&&resolution!=='fixed'&&media&&media.media!=='audio'&&!source?'studio.run.resolution.waiting':'';
 const ratio=aspect==='auto'?(source?source.width/source.height:1):aspect==='custom'?aspectWidth/aspectHeight:Number(aspect.split(':')[0])/Number(aspect.split(':')[1]);
 const swatchRatio=Number.isFinite(ratio)&&ratio>0?ratio:1;
 const readMediaSize=(width:number,height:number)=>{if(media&&width>0&&height>0)setMediaSize({src:media.src,width,height});};
 const current=jobs.find(j=>j.state==='queued'||j.state==='running');
 const replace=(next:JobStatus)=>setJobs(list=>list.map(j=>j.id===next.id?next:j));
 async function run(){
  if(!native||lock.current||current)return;
  if(!checkpoint){setError(t('studio.run.noModels'));return;}
  if(sizeError){setError(t(sizeError));return;}
  const intent:DiagnosticImageIntentV1=Object.freeze({recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:positive,negativePrompt:negative,checkpoint,seed,width:outputSize.width,height:outputSize.height,steps,cfg,sampler,scheduler,outputPrefix:'DEAS',...(activeLoras.length?{loras:activeLoras}:{}),...(pipeline==='i2i'?{inputImage,denoise,...(scaled?.resize?{inputResize:scaled.resize}:{})}:{}),...(split&&family?.clipType?{diffusion:{textEncoder,clipType:family.clipType,vae}}:{})});
  lock.current=true;setBusy(true);setError('');
  try{
   const plan=await prepareDiagnosticJob(endpoint,intent); // native: validates against the running backend's object_info
   const job=await submitDiagnosticJob(plan.id); // the Run click is the authorization
   if(live.current){setJobs(list=>[job,...list].slice(0,20));setSelectedJob(job.id);if(!lockSeed)setSeed(randomSeed());}
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
 // Picking media on the strip takes over the preview until the next job is selected.
 const pickMedia=(item:MediaItem)=>{setMedia(item);setSelectedJob('');};
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
 const fileSrc=(o:JobStatus['outputs'][number])=>outputDir?convertFileSrc([outputDir,o.subfolder,o.filename].filter(Boolean).join('/')):null;
 const num=(id:string,value:number,set:(n:number)=>void,min:number,max:number,step:number)=><label key={id} className="wb-field"><span>{t(`studio.run.${id}`)}</span><input type="number" inputMode="numeric" value={value} min={min} max={max} step={step} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n))set(n);}}/></label>;
 const toggleLora=(name:string,on:boolean)=>setLoras(on?[...loras.filter(l=>l.name!==name),{name,strength:1}]:loras.filter(l=>l.name!==name));
 // Picking a model applies its family's starting settings (SwarmUI: per-class defaults).
 const pickModel=(m:LocalModel)=>{setCheckpoint(m.name);setResolution('model');const d=familyOf(m)?.defaults;if(d){setWidth(d.width);setHeight(d.height);setSteps(d.steps);setCfg(d.cfg);setSampler(d.sampler);setScheduler(d.scheduler);}};
 const tile=(m:LocalModel,pressed:boolean,onClick:()=>void,extra?:React.ReactNode,reason='')=><li key={`${m.category}/${m.name}`}><button type="button" aria-pressed={pressed} disabled={!!reason} title={reason?t(reason):m.name} onClick={onClick}>{m.info?.civitai?.preview?<img src={m.info.civitai.preview} alt="" loading="lazy"/>:<span className="wb-thumb" aria-hidden="true">◆</span>}<span className="wb-tile-name">{m.name}</span>{familyOf(m)&&<small className="wb-family">{familyOf(m)!.name}</small>}</button>{extra}</li>;
 const pick=(id:string,value:string,list:readonly string[],set:(v:string)=>void,onFocus?:()=>void)=><label key={id} className="wb-field"><span>{t(id)}</span><select value={value} onFocus={onFocus} onPointerDown={onFocus} onChange={e=>set(e.target.value)}>{(list.includes(value)?list:[value,...list]).map(v=><option key={v} value={v}>{v}</option>)}</select></label>;
 return <div className="workbench" data-workbench ref={shell} style={{height:fit}}>
  <div className="wb-body">
   <aside className="wb-side">
    <section className="wb-settings" aria-label={t('studio.run.settings')}>
     <p className="wb-active"><span>{t('studio.run.checkpoint')}{family&&<> · {family.name}</>}</span><strong title={checkpoint}>{checkpoint||t('studio.run.noModels')}</strong><small>{t('studio.run.loras')} {activeLoras.length}</small></p>
     <div className="wb-pipelines" role="group" aria-label={t('studio.run.pipeline')}>{pipelines.map(id=>{const reason=why(id);return <button key={id} type="button" data-pipeline={id} aria-pressed={pipeline===id} disabled={!!reason} title={reason?t(reason):undefined} onClick={()=>setPipeline(id)}>{t(`studio.run.pipe.${id}`)}</button>;})}</div>
     {pipeline==='i2i'&&<p className="wb-active"><span>{t('studio.run.pipe.input')}</span><strong title={inputImage}>{inputImage}</strong></p>}
     <div className="wb-controls">
      <label className="wb-field"><span>{t('studio.run.resolution.aspect')}</span><span className="wb-aspect-picker"><span className="wb-aspect-swatch" aria-hidden="true"><span style={{width:18*Math.min(1,swatchRatio),height:18*Math.min(1,1/swatchRatio)}}/></span><select value={aspect} onChange={e=>{setAspect(e.target.value as typeof aspect);if(resolution==='fixed')setResolution('model');}}>{aspects.filter(a=>a!=='auto'||mediaPipeline).map(a=><option key={a} value={a}>{a==='auto'||a==='custom'?t(`studio.run.resolution.${a}`):a}</option>)}</select></span></label>
      <label className="wb-field"><span>{t('studio.run.resolution.title')}</span><select value={resolution} onChange={e=>setResolution(e.target.value)}>{['fixed','model',...Object.keys(resolutions),'custom'].map(r=><option key={r} value={r} disabled={r==='model'&&!family?.defaults}>{r in resolutions?r:t(`studio.run.resolution.${r}`)}</option>)}</select></label>
      {aspect==='custom'&&<>{num('resolution.aspectWidth',aspectWidth,setAspectWidth,1,100,0.1)}{num('resolution.aspectHeight',aspectHeight,setAspectHeight,1,100,0.1)}</>}
      {resolution==='custom'&&num('resolution.megapixels',megapixels,setMegapixels,0.01,16,0.05)}
      {num('width',canvas.width,n=>{setWidth(n);setHeight(canvas.height);setResolution('fixed');},64,8192,8)}{num('height',canvas.height,n=>{setHeight(n);setWidth(canvas.width);setResolution('fixed');},64,8192,8)}
      {pipeline==='i2i'&&<><label className="wb-field wb-wide"><span>{t('studio.run.resolution.scaling')}</span><select value={inputScaling} title={t(`studio.run.resolution.hint.${inputScaling}`)} onChange={e=>setInputScaling(e.target.value as ScalingMode)}>{scalingModes.map(s=><option key={s} value={s}>{t(`studio.run.resolution.scale.${s}`)}</option>)}</select></label><p className="wb-resolution-hint">{t(`studio.run.resolution.hint.${inputScaling}`)}</p>{num('denoise',denoise,setDenoise,0,1,0.05)}</>}
      {sizeError&&<p className="wb-resolution-hint error-message" role="status">{t(sizeError)}</p>}
      {num('steps',steps,setSteps,1,150,1)}{num('cfg',cfg,setCfg,0,30,0.5)}
      {pick('studio.recipe.sampler',sampler,choices?.samplers??[],setSampler,loadChoices)}
      {pick('studio.recipe.scheduler',scheduler,choices?.schedulers??[],setScheduler,loadChoices)}
      {split&&<>{pick('studio.run.textEncoder',textEncoder,split.encoders,setTextEncoder)}{pick('studio.run.vae',vae,split.vaes,setVae)}</>}
      <label className="wb-field wb-seed"><span>{t('studio.run.seed')}</span><span className="wb-seed-row"><input type="number" inputMode="numeric" value={seed} min={0} step={1} onChange={e=>{const n=Number(e.target.value);if(Number.isSafeInteger(n)&&n>=0)setSeed(n);}}/><button type="button" aria-label={t('studio.run.newSeed')} title={t('studio.run.newSeed')} onClick={()=>setSeed(randomSeed())}>⟳</button><button type="button" aria-pressed={lockSeed} aria-label={t('studio.run.lockSeed')} title={t('studio.run.lockSeed')} onClick={()=>setLockSeed(v=>!v)}>{lockSeed?'🔒':'🔓'}</button></span></label>
     </div>
     {!native&&<p className="field-help">{t('studio.jobs.browser')}</p>}
     {error&&<p className="status-message error-message" role="alert">{error}</p>}
    </section>
   </aside>
   <div className="wb-center">
    <section className="wb-stage" aria-label={t('studio.run.preview')}>
     {shown?<div className="wb-shown"><p className="wb-job-line"><span data-state={shown.state}>{t(`studio.jobs.${shown.state}`)}</span> · <code>{shown.id.slice(0,8)}</code>{shown.error&&<> · <span className="error-message">{shown.error}</span></>}</p>
      {shown.state==='succeeded'&&shown.outputs.length>0&&(outputDir?<figure className="media-preview">{shown.outputs.map(o=><img key={o.filename} src={fileSrc(o)!} alt={o.filename}/>)}<figcaption>{shown.outputs.map(o=>o.filename).join(' · ')}</figcaption></figure>:<JobOutputPreview job={shown} auto/>)}
      {(shown.state==='queued'||shown.state==='running')&&(shown.preview?<figure className="media-preview" aria-busy="true"><img src={shown.preview} alt={t('studio.run.working')}/>{shown.progress&&<figcaption><progress value={shown.progress.value} max={shown.progress.max}/> {shown.progress.value}/{shown.progress.max}</figcaption>}</figure>
       :<p className="empty-note" aria-busy="true"><span className="aio-spinner" aria-hidden="true"/> {t('studio.run.working')}{shown.progress&&<> {shown.progress.value}/{shown.progress.max}</>}</p>)}</div>
     :media?<figure className="media-preview">{media.media==='image'?<img src={media.src} alt={media.name} onLoad={e=>readMediaSize(e.currentTarget.naturalWidth,e.currentTarget.naturalHeight)}/>:media.media==='video'?<video src={media.src} controls onLoadedMetadata={e=>readMediaSize(e.currentTarget.videoWidth,e.currentTarget.videoHeight)}/>:<audio src={media.src} controls/>}<figcaption>{media.name}</figcaption></figure>
     :<p className="empty-note">{t('studio.run.empty')}</p>}
    </section>
    <div className="wb-prompts">
     <label className="wb-prompt"><span>{t('studio.run.positive')}</span><textarea data-run-positive value={positive} maxLength={16384} placeholder={t('studio.run.positiveHint')} onChange={e=>setPositive(e.target.value)}/></label>
     <label className="wb-prompt wb-negative"><span>{t('studio.run.negative')}</span><textarea data-run-negative value={negative} maxLength={16384} placeholder={t('studio.run.negativeHint')} onChange={e=>setNegative(e.target.value)}/></label>
    </div>
   </div>
   <section className="wb-queue" aria-label={t('studio.run.queue')}>
    <h3>{t('studio.run.queue')}</h3>
    {jobs.length===0?<p className="media-help">{t('studio.run.queueEmpty')}</p>:<ul>{jobs.map(j=><li key={j.id}><button type="button" aria-current={j.id===selectedJob} data-state={j.state} onClick={()=>setSelectedJob(j.id)}>
     {outputDir&&j.state==='succeeded'&&j.outputs[0]?<img src={fileSrc(j.outputs[0])!} alt=""/>:j.preview?<img src={j.preview} alt=""/>:<span className="wb-thumb" aria-hidden="true">{j.state==='failed'||j.state==='unknown'?'!':j.state==='succeeded'?'✓':'…'}</span>}
     <span className="wb-queue-text"><strong>{t(`studio.jobs.${j.state}`)}{j.progress&&<> {j.progress.value}/{j.progress.max}</>}</strong><small>{j.outputs[0]?.filename??j.id.slice(0,8)}</small></span></button></li>)}</ul>}
    <button type="button" className="aio-confirm-button wb-run" data-run disabled={!native||busy||!!current||!!sizeError} onClick={()=>void run()}>{t(current?'studio.run.running':busy?'studio.run.preparing':'studio.run.run')}</button>
   </section>
  </div>
  <div className="wb-dock" style={{height:dockHeight}}>
   <div className="wb-dock-handle" role="separator" aria-orientation="horizontal" aria-label={t('studio.run.dockResize')} onPointerDown={dragDock}/>
   <div className="wb-dock-tabs" role="tablist" aria-label={t('studio.run.dock')}>{dockTabs.map(id=><button key={id} role="tab" type="button" data-dock-tab={id} aria-selected={dockTab===id} onClick={()=>setDockTab(id)}>{t(`studio.run.dock.${id}`)}{id==='loras'&&activeLoras.length>0&&<small> {activeLoras.length}</small>}</button>)}
    <input type="search" className="wb-dock-search" data-dock-search aria-label={t('studio.run.dock.search')} placeholder={t('studio.run.dock.search')} value={query} onChange={e=>setQuery(e.target.value)}/>
    <select className="wb-dock-sort" data-dock-sort aria-label={t('studio.run.dock.sort')} value={sort} onChange={e=>setSort(e.target.value as typeof sortPref)}>{sorts.map(s=><option key={s} value={s}>{t(`studio.run.sort.${s}`)}</option>)}</select>
    {dockTab!=='media'&&<button type="button" className="wb-dock-action" data-run-load disabled={!native||busy||(!modelsDir&&!endpoint.trim())} onClick={()=>void load()}>{t(models?'studio.run.reload':'studio.run.load')}</button>}</div>
   {dockTab==='media'&&<MediaLibrary selected={media} onSelect={pickMedia} roots={roots} outputRevision={outputRevision} filter={query} sort={sort}/>}
   {dockTab!=='media'&&<section className="wb-dock-panel" aria-label={t(`studio.run.dock.${dockTab}`)}>
    {!models&&<p className="media-help">{t(modelsDir?'studio.run.scanHelp':'studio.run.loadHelp')}</p>}
    {models&&dockTab==='models'&&(allModels.length===0?<p className="media-help">{t('studio.run.noModels')}</p>:<ul className="wb-tiles" data-run-checkpoint>{allModels.filter(match).sort(bySort).map(m=>tile(m,m===model,()=>pickModel(m),undefined,blocked(m,pipeline)))}</ul>)}
    {models&&dockTab==='loras'&&(loraNames.length===0?<p className="media-help">{t('studio.run.noLoras')}</p>:<ul className="wb-tiles wb-loras">{loraModels.filter(match).sort(bySort).map(m=>{const on=loras.find(l=>l.name===m.name);return tile(m,!!on,()=>toggleLora(m.name,!on),on&&<input type="number" aria-label={t('studio.run.strength',{name:m.name})} value={on.strength} min={-10} max={10} step={0.05} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n)&&Math.abs(n)<=10)setLoras(loras.map(l=>l.name===m.name?{...l,strength:n}:l));}}/>);})}</ul>)}
   </section>}
  </div>
 </div>;
}
