import { useEffect, useState, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { MediaItem } from '../../lib/media';
import { generationSettings, imageMetadataRows, readImageMetadata, type GenerationSettings, type ImageMetadata } from '../../lib/imageMetadata';
import type { JobStatus } from '../../lib/jobs';
import { useI18n } from '../../i18n/I18nProvider';

/** The explicit apply button plus what could not be carried over (unknown sampler, model not in the folder). */
function Apply({settings,onApply}:{settings:GenerationSettings;onApply:(s:GenerationSettings)=>string[]}) {
 const {t}=useI18n();const [skipped,setSkipped]=useState<string[]|null>(null);
 return <>
  <button type="button" className="wb-dock-action" data-metadata-apply onClick={()=>setSkipped(onApply(settings))}>{t('studio.run.metadata.apply')}</button>
  {skipped&&<p className="media-help" role="status">{skipped.length?t('studio.run.metadata.skipped',{items:skipped.join(' · ')}):t('studio.run.metadata.applied')}</p>}
 </>;
}

function FileMetadata({media,onApply}:{media:MediaItem;onApply?:(s:GenerationSettings)=>string[]}) {
 const {t}=useI18n();const path=media.path;
 const [file,setFile]=useState<{path:string;rows:ImageMetadata;settings:GenerationSettings|null;error:boolean}|null>(null);
 useEffect(()=>{
  if(!path||!isTauri())return;
  let alive=true;setFile(null);
  readImageMetadata(path).then(entries=>{if(alive)setFile({path,rows:imageMetadataRows(entries),settings:generationSettings(entries),error:false});},()=>{if(alive)setFile({path,rows:[],settings:null,error:true});});
  return()=>{alive=false;};
 },[path,media.src]);
 if(!path||!isTauri())return <p className="media-help">{t('studio.run.metadata.native')}</p>;
 if(file?.path!==path)return <p className="media-help" role="status">{t('studio.run.metadata.loading')}</p>;
 if(file.error)return <p className="media-help" role="status">{t('studio.run.metadata.failed')}</p>;
 if(!file.rows.length)return <p className="media-help">{t('studio.run.metadata.none')}</p>;
 const labels:Record<string,string>={prompt:'studio.run.positive',negativeprompt:'studio.run.negative',negative_prompt:'studio.run.negative',model:'studio.run.checkpoint',seed:'studio.run.seed',steps:'studio.run.steps',cfgscale:'studio.run.cfg',width:'studio.run.width',height:'studio.run.height',sampler:'studio.recipe.sampler',scheduler:'studio.recipe.scheduler',vae:'studio.run.vae',loras:'studio.run.loras',date:'studio.run.metadata.date',generation_time:'studio.run.metadata.time'};
 return <>{file.settings&&onApply&&<Apply key={path} settings={file.settings} onApply={onApply}/>}
  <dl>{file.rows.map(([name,value],index)=><div key={index}><dt>{Object.hasOwn(labels,name.toLowerCase())?t(labels[name.toLowerCase()]):name.replaceAll('_',' ')}</dt><dd>{value}</dd></div>)}</dl></>;
}

/** Read the selected job's native snapshot or the selected image; controls change only through the explicit apply button. */
export function GenerationMetadata({job,media=null,onApply}:{job:JobStatus|null;media?:MediaItem|null;onApply?:(s:GenerationSettings)=>string[]}) {
 const {t}=useI18n();const i=job?.intent;
 const row=(key:string,value:ReactNode)=><div key={key}><dt>{t(key)}</dt><dd>{value}</dd></div>;
 return <section className="wb-metadata" aria-label={t('studio.run.metadata')}>
  <h3>{t('studio.run.metadata')}</h3>
  {i?<>{onApply&&<Apply key={job.id} settings={{positive:i.positivePrompt,negative:i.negativePrompt,checkpoint:i.checkpoint,seed:i.seed,steps:i.steps,cfg:i.cfg,sampler:i.sampler,scheduler:i.scheduler,width:i.width,height:i.height,loras:i.loras?.map(l=>({...l}))}} onApply={onApply}/>}<dl>
   {row('studio.run.positive',i.positivePrompt)}
   {i.negativePrompt&&row('studio.run.negative',i.negativePrompt)}
   {row('studio.run.checkpoint',i.checkpoint)}
   {row('studio.run.resolution.title',`${i.width} × ${i.height}`)}
   {row('studio.run.seed',i.seed)}
   {row('studio.run.steps',i.steps)}
   {row('studio.run.cfg',i.cfg)}
   {row('studio.recipe.sampler',i.sampler)}
   {row('studio.recipe.scheduler',i.scheduler)}
   {i.diffusion&&<>{row('studio.run.textEncoder',i.diffusion.textEncoder)}{row('studio.run.vae',i.diffusion.vae)}</>}
   {!!i.loras?.length&&row('studio.run.loras',i.loras.map(l=>`${l.name} (${l.strength})`).join(', '))}
   {i.inputImage&&<>{row('studio.run.pipe.input',i.inputImage)}{row('studio.run.denoise',i.denoise)}</>}
   {i.options&&row('studio.run.dock.options',Object.entries(i.options).map(([k,v])=>typeof v==='object'?`${v.node} ${v.threshold}`:v===true?k:`${k}: ${v}`).join(' · '))}
   {job.metadata&&Number.isFinite(new Date(job.metadata.startedAt).getTime())&&row('studio.run.metadata.date',new Date(job.metadata.startedAt).toLocaleString())}
   {job.metadata?.generationMs!=null&&row('studio.run.metadata.time',`${(job.metadata.generationMs/1000).toFixed(2)} s`)}
   {job.appVersion&&row('studio.run.metadata.version',job.appVersion)}
  </dl></>:!job&&media&&media.media!=='audio'?<FileMetadata key={media.src} media={media} onApply={onApply}/>:<p className="media-help">{t('studio.run.metadata.empty')}</p>}
 </section>;
}
