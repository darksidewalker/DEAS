import { useId, useLayoutEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { readH3Session } from '../../lib/jobs';
import { useI18n } from '../../i18n/I18nProvider';

export interface ContinuitySourcesProps { endpoint?:string; session:string; sourceId?:string; running:boolean; onSelect:(sourceId?:string)=>void }
export function ContinuitySources({endpoint,session,sourceId,running,onSelect}:ContinuitySourcesProps){
 const {t}=useI18n();const hintId=useId();
 const [ids,setIds]=useState<string[]>([]);
 const [loading,setLoading]=useState(false);
 const [loaded,setLoaded]=useState(false);
 const [failed,setFailed]=useState(false);
 const request=useRef(0);
 useLayoutEffect(()=>{
  ++request.current;setIds([]);setLoading(false);setLoaded(false);setFailed(false);
  return ()=>{++request.current;};
 },[endpoint,session]);
 useLayoutEffect(()=>{if(running){++request.current;setLoading(false);}},[running]);
 const canLoad=isTauri()&&!!endpoint;
 const locked=running||loading;
 const load=async()=>{
  if(locked||!canLoad)return;
  const token=++request.current;
  setLoading(true);setFailed(false);setLoaded(false);
  try{
   const result=await readH3Session(endpoint!,session);
   if(token!==request.current)return;
   // A true end-of-input assertion rejects trailing newlines too (unlike `$`).
   setIds([...new Set(result.clips.slice(0,200).filter(c=>
    c&&typeof c.clipId==='string'&&/^[A-Za-z0-9_-]{1,80}(?![\s\S])/.test(c.clipId)
    &&typeof c.frames==='number'&&Number.isInteger(c.frames)&&c.frames>=5
   ).map(c=>c.clipId))]);
   setLoaded(true);
  }catch{if(token===request.current)setFailed(true);}
  finally{if(token===request.current)setLoading(false);}
 };
 return <div className="wb-option">
  <button type="button" className="wb-dock-action" data-cont-load-sources disabled={locked||!canLoad} onClick={load}>{t(loading?'studio.run.cont.loadingSources':'studio.run.cont.loadSources')}</button>
  <label><span>{t('studio.run.cont.source')}</span><select data-cont-source aria-describedby={hintId} disabled={locked} value={sourceId??''} onChange={e=>{const id=e.target.value;if(!locked&&id!==(sourceId??'')&&(!id||ids.includes(id)))onSelect(id||undefined);}}>
   <option value="">{t('studio.run.cont.newTake')}</option>
   {sourceId&&!ids.includes(sourceId)&&<option value={sourceId}>{sourceId}</option>}
   {ids.map(id=><option key={id} value={id}>{id}</option>)}
  </select></label>
  <small id={hintId}>{t('studio.run.cont.sourceHint')}</small>
  {loaded&&!ids.length&&<small role="status">{t('studio.run.cont.noSources')}</small>}
  {failed&&<small role="alert">{t('studio.run.cont.sourceFailed')}</small>}
 </div>;
}
