import {useI18n} from '../../i18n/I18nProvider';
import type {Sam3VideoMaskIntentV1} from '../../lib/sam3';

export type Sam3VideoSettings = Pick<Sam3VideoMaskIntentV1,'checkpoint'|'threshold'|'maxObjects'|'detectInterval'|'startSeconds'|'durationSeconds'> & {cuts:boolean;sceneThreshold:number};
/** H3 face refinement settings; an empty prompt uses the current positive prompt. `auto` chains it after H3 generation. */
export interface FaceRefineSettings {auto:boolean;denoise:number;cropFactor:number;feather:number;prompt:string;/** Absent in preferences saved before it existed = 0 (refine every face). */minFace?:number}
export interface FaceRefineControls {value:FaceRefineSettings;onChange:(value:FaceRefineSettings)=>void;unavailable:string;autoUnavailable:string;onRefine:()=>void}
const refineFields={denoise:['studio.faceRefine.denoise','studio.faceRefine.denoiseHint',0.05,0.05,1],cropFactor:['studio.faceRefine.cropFactor','studio.faceRefine.cropFactorHint',1.2,0.1,8],feather:['studio.faceRefine.feather','studio.faceRefine.featherHint',0,1,256],minFace:['studio.faceRefine.minFace','studio.faceRefine.minFaceHint',0,8,4096]} as const;
/** Analysis and refinement run only on explicit actions; editing settings never starts computation. */
export function Sam3VideoControls({value,onChange,models,sourceName,unavailable,busy,onAnalyze,refine}:{value:Sam3VideoSettings;onChange:(value:Sam3VideoSettings)=>void;models:readonly string[];sourceName?:string;unavailable:string;busy:boolean;onAnalyze:()=>void;refine?:FaceRefineControls}){
 const {t}=useI18n();
 const num=(key:Exclude<keyof Sam3VideoSettings,'checkpoint'|'cuts'>,label:string,min:number,step:number,max?:number)=><label className="wb-option" key={key}><span>{t(label)}</span><input data-sam-video={key} type="number" disabled={key==='sceneThreshold'&&!value.cuts} title={key==='sceneThreshold'?t('studio.samVideo.cutsHint'):undefined} min={min} max={max} step={step} value={Number.isNaN(value[key])?'':value[key]} onChange={e=>onChange({...value,[key]:e.target.value===''?NaN:Number(e.target.value)})}/></label>;
 return <fieldset className="wb-group" data-post-group="face-analysis"><legend>{t('studio.samVideo.title')}</legend>
  <p data-sam-video="source">{t('studio.samVideo.source')} <strong>{sourceName||t('studio.samVideo.noSource')}</strong></p>
  <div className="wb-options">
   <label className="wb-option"><span>{t('studio.sam.model')}</span><select data-sam-video="checkpoint" value={value.checkpoint} onChange={e=>onChange({...value,checkpoint:e.target.value})}><option value="">{t('studio.sam.choose')}</option>{(value.checkpoint&&!models.includes(value.checkpoint)?[value.checkpoint,...models]:models).map(name=><option key={name} value={name}>{name}</option>)}</select></label>
   {num('threshold','studio.sam.threshold',0,0.05,1)}
   {num('startSeconds','studio.samVideo.startSeconds',0,0.1)}
   {num('durationSeconds','studio.samVideo.durationSeconds',0,0.1)}
   {num('maxObjects','studio.samVideo.maxObjects',1,1,64)}
   {num('detectInterval','studio.samVideo.detectInterval',1,1,2_147_483_647)}
   <label className="wb-option" title={t('studio.samVideo.cutsHint')}><span><input data-sam-video="cuts" type="checkbox" checked={value.cuts} onChange={e=>onChange({...value,cuts:e.target.checked})}/>{t('studio.samVideo.cuts')}</span></label>
   {num('sceneThreshold','studio.samVideo.sceneThreshold',0,0.01,1)}
  </div>
  <p className="media-help">{t('studio.samVideo.hint')}</p>
  {unavailable&&<p role="status">{unavailable}</p>}
  <button type="button" className="wb-dock-action" data-sam-video="analyze" disabled={busy||!!unavailable} title={unavailable||t('studio.samVideo.hint')} onClick={onAnalyze}>{t('studio.samVideo.analyze')}</button>
  {refine&&<div className="wb-options" data-face-refine-group>
   <label className="wb-option" title={refine.autoUnavailable||t('studio.faceRefine.autoHint')}><span><input data-face-refine="auto" type="checkbox" checked={refine.value.auto} disabled={!!refine.autoUnavailable&&!refine.value.auto} onChange={e=>refine.onChange({...refine.value,auto:e.target.checked})}/>{t('studio.faceRefine.auto')}</span></label>
   {refine.autoUnavailable&&<small data-face-refine="autoUnavailable">{refine.autoUnavailable}</small>}
   {(Object.keys(refineFields) as (keyof typeof refineFields)[]).map(key=>{const [label,hint,min,step,max]=refineFields[key];const v=refine.value[key]??0;return <label className="wb-option" key={key}><span>{t(label)}</span><input data-face-refine={key} type="number" min={min} max={max} step={step} title={t(hint)} value={Number.isNaN(v)?'':v} onChange={e=>refine.onChange({...refine.value,[key]:e.target.value===''?NaN:Number(e.target.value)})}/></label>;})}
   <label className="wb-option"><span>{t('studio.faceRefine.prompt')}</span><textarea data-face-refine="prompt" maxLength={16384} rows={2} placeholder={t('studio.faceRefine.promptHint')} value={refine.value.prompt} onChange={e=>refine.onChange({...refine.value,prompt:e.target.value})}/></label>
   <p className="media-help">{t('studio.faceRefine.hint')}</p>
   {/* One live region per group: the analysis status above; refinement blockers are plain text. */}
   {refine.unavailable&&<p className="media-help" data-face-refine="unavailable">{refine.unavailable}</p>}
   <button type="button" className="wb-dock-action" data-face-refine="run" disabled={busy||!!refine.unavailable} title={refine.unavailable||t('studio.faceRefine.hint')} onClick={refine.onRefine}>{t('studio.faceRefine.run')}</button>
  </div>}
 </fieldset>;
}
