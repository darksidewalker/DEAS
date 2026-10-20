import { useId, useLayoutEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { prepareH3Video } from '../../lib/jobs';
import { useI18n } from '../../i18n/I18nProvider';

export interface ContinuityVideoSourceProps { endpoint?:string; session:string; running:boolean; onSelect:(sourceId:string)=>void }
export function ContinuityVideoSource({endpoint,session,running,onSelect}:ContinuityVideoSourceProps){
 const {t}=useI18n();const hintId=useId();
 const [draft,setDraft]=useState('');
 const [prepared,setPrepared]=useState<Awaited<ReturnType<typeof prepareH3Video>>|null>(null);
 const [loading,setLoading]=useState(false);
 const [failed,setFailed]=useState(false);
 const [uploading,setUploading]=useState(false);
 const [uploadFailed,setUploadFailed]=useState(false);
 const request=useRef(0);
 useLayoutEffect(()=>{
  ++request.current;setPrepared(null);setLoading(false);setFailed(false);setUploading(false);setUploadFailed(false);
  return ()=>{++request.current;};
 },[endpoint,session,running]);
 const locked=running||loading||uploading;
 const canUpload=isTauri()&&!!endpoint;
 const upload=async()=>{
  if(locked||!canUpload)return;
  const token=++request.current;setUploading(true);setUploadFailed(false);
  try{
   const name=await invoke<string|null>('native_h3_video_upload',{baseUrl:endpoint!});
   if(token===request.current&&name!==null){setDraft(name);setPrepared(null);setFailed(false);}
  }catch{if(token===request.current)setUploadFailed(true);}
  finally{if(token===request.current)setUploading(false);}
 };
 const validFilename=draft.length>0&&draft.length<=4096&&!/[\u0000-\u001f\u007f-\u009f\\:]/.test(draft)
  &&draft.split('/').every(part=>part!==''&&part!=='.'&&part!=='..')&&!/ \[(output|temp)\]$/.test(draft);
 const canPrepare=isTauri()&&!!endpoint&&validFilename;
 const prepare=async()=>{
  if(locked||!canPrepare)return;
  const token=++request.current;
  setLoading(true);setFailed(false);setPrepared(null);
  try{
   const result=await prepareH3Video(endpoint!,draft);
   if(token===request.current)setPrepared(result);
  }catch{if(token===request.current)setFailed(true);}
  finally{if(token===request.current)setLoading(false);}
 };
 return <form className="wb-option" onSubmit={e=>{e.preventDefault();void prepare();}}>
  <label><span>{t('studio.run.cont.videoFilename')}</span><input data-cont-video-filename maxLength={4096} aria-describedby={hintId} value={draft} disabled={locked} onChange={e=>{if(locked)return;++request.current;setDraft(e.target.value);setPrepared(null);setFailed(false);}}/></label>
  <button type="button" className="wb-dock-action" data-cont-video-upload disabled={locked||!canUpload} onClick={()=>void upload()}>{t(uploading?'studio.run.cont.uploadingVideo':'studio.run.cont.uploadVideo')}</button>
  <small>{t('studio.run.cont.uploadVideoHint')}</small>
  {uploadFailed&&<small role="alert">{t('studio.run.cont.uploadVideoFailed')}</small>}
  <small id={hintId}>{t('studio.run.cont.videoHint')}</small>
  <button type="submit" className="wb-dock-action" data-cont-video-prepare disabled={locked||!canPrepare}>{t(loading?'studio.run.cont.preparingVideo':'studio.run.cont.prepareVideo')}</button>
  {prepared&&<small role="status">{t('studio.run.cont.videoReady',{name:prepared.filename,width:prepared.width,height:prepared.height,seconds:prepared.seconds})}{' '}{t(prepared.hasAudio?'studio.run.cont.videoHasAudio':'studio.run.cont.videoSilent')}</small>}
  {failed&&<small role="alert">{t('studio.run.cont.videoFailed')}</small>}
  <button type="button" className="wb-dock-action" data-cont-video-use disabled={locked||!prepared} onClick={()=>{if(!locked&&prepared)onSelect(prepared.sourceId);}}>{t('studio.run.cont.useVideo')}</button>
 </form>;
}
