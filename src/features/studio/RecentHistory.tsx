import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { isVideoIntent } from '../../lib/videoIntent';
import { generationDuration } from './generationDuration';
import { checkHistoryOutputs, historicalRows, historyRestore, readHistory, type HistoryOutputAvailability, type HistoryRecord, type HistoryRestore, type HistorySnapshot, type RestoreContext } from './history';
import './recentHistory.css';

export interface RecentHistoryProps {
 liveIds:string[]; context:RestoreContext; outputRoot?:string; projectOpen:boolean; authoringBusy:boolean;
 onRestore:(value:HistoryRestore)=>void;
 onOpenChange?:(open:boolean)=>void;
}
/** A bounded metadata view. Selecting a row never mounts a live job or a media preview. */
export function RecentHistory({liveIds,context,outputRoot,projectOpen,authoringBusy,onRestore,onOpenChange}:RecentHistoryProps){
 const {t,locale}=useI18n();
 const toggle=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
 const [open,setOpen]=useState(false),[snapshot,setSnapshot]=useState<HistorySnapshot|null>(null),[loading,setLoading]=useState(false),[failed,setFailed]=useState(false),[selected,setSelected]=useState(''),[confirm,setConfirm]=useState(false),[applied,setApplied]=useState(false);
 const [outputCheck,setOutputCheck]=useState<{scope:object;states:HistoryOutputAvailability[];pending:boolean}|null>(null);
 const activeOutputScope=useRef<object|null>(null),outputRequest=useRef<object|null>(null);
 const [settingsOpen,setSettingsOpen]=useState(false);
 const [revision,setRevision]=useState(0);
 useEffect(()=>{const moved=()=>setRevision(n=>n+1);window.addEventListener('deas-media-relocated',moved);return()=>window.removeEventListener('deas-media-relocated',moved);},[]);
 useEffect(()=>{
  onOpenChange?.(open);
  if(!open)return;
  panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);toggle.current?.focus();}};
  window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);
 },[open]);
 const liveKey=liveIds.join('\n');
 useEffect(()=>{
  if(!open||!isTauri())return;
  let alive=true,timer:ReturnType<typeof setTimeout>|undefined;setLoading(true);setFailed(false);
  const read=async()=>{
   try{const value=await readHistory();if(alive){setSnapshot(value);setFailed(false);}}
   catch{if(alive)setFailed(true);}
   finally{if(alive){setLoading(false);timer=setTimeout(()=>void read(),2000);}}
  };
  void read();
  return()=>{alive=false;clearTimeout(timer);};
 },[open,revision,liveKey]);
 const rows=historicalRows(snapshot?.records??[]);
 const record=rows.find(r=>r.id===selected);
 // A fresh identity also invalidates A -> B -> A and close -> reopen. Never
 // display a previous selection's result while effect cleanup is pending.
 const outputScope=useMemo(()=>({}),[open,context.endpoint,context.inputRoot,outputRoot,record?.id,record?.revision,revision]);
 useLayoutEffect(()=>{
  activeOutputScope.current=open?outputScope:null;outputRequest.current=null;
  return()=>{activeOutputScope.current=null;outputRequest.current=null;};
 },[open,outputScope]);
 const checking=outputCheck?.scope===outputScope&&outputCheck.pending;
 const availability=outputCheck?.scope===outputScope?outputCheck.states:[];
 // Effective intent is immutable for one native ID; unchanged observations need
 // no repeated clone, including large but valid wildcard selections.
 const restore=useMemo(()=>record?historyRestore(record,context):null,[record?.id,record?.revision,context.endpoint,context.inputRoot,context.allow,context.models]);
 const duration=record?generationDuration({state:record.state,metadata:{startedAt:record.startedAt??record.admittedAt,generationMs:record.generationMs??null}},locale):null;
 const effectiveJson=useMemo(()=>settingsOpen&&record?JSON.stringify(record.intent,null,2):null,[settingsOpen,record?.id,record?.revision]);
 const select=(value:HistoryRecord)=>{setSelected(value.id);setConfirm(false);setApplied(false);setSettingsOpen(false);};
 const sameRoot=!!record?.outputRoot&&!!outputRoot&&record.outputRoot.replace(/\\/g,'/').replace(/\/+$/,'')===outputRoot.replace(/\\/g,'/').replace(/\/+$/,'');
 const checkOutputs=async()=>{
  if(!record||!sameRoot||checking||!open||outputRequest.current)return;
  const request={};outputRequest.current=request;
  setOutputCheck({scope:outputScope,states:[],pending:true});
  const current=()=>activeOutputScope.current===outputScope&&outputRequest.current===request;
  try{
   const states=await checkHistoryOutputs(record.id);
   if(states.length!==record.outputs.length)throw new Error('History outputs changed.');
   if(current()){outputRequest.current=null;setOutputCheck({scope:outputScope,states,pending:false});}
  }catch{
   if(current()){outputRequest.current=null;setOutputCheck({scope:outputScope,states:record.outputs.map(()=>'unvalidated'),pending:false});}
  }
 };
 return <section className="wb-history" aria-label={t('studio.history.title')}>
  <button type="button" className="wb-dock-action" ref={toggle} data-history-toggle aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{t('studio.history.title')}</button>
  {open&&<div className="wb-history-panel" ref={panel} data-history-panel role="dialog" aria-modal="true" aria-label={t('studio.history.title')} onKeyDown={event=>{if(event.key!=='Tab')return;const controls=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),summary')];const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}}>
   <button type="button" className="wb-dock-action" data-history-close onClick={()=>{setOpen(false);toggle.current?.focus();}}>{t('studio.history.close')}</button>
   <p className="media-help">{t('studio.history.help')}</p>
   {!isTauri()?<p>{t('studio.history.native')}</p>:<>
    <button type="button" className="wb-dock-action" disabled={loading} onClick={()=>setRevision(n=>n+1)}>{t('studio.history.refresh')}</button>
    {loading&&<p role="status">{t('studio.history.loading')}</p>}
    {failed&&<p role="alert">{t('studio.history.failed')}</p>}
    {snapshot?.error&&<p role="alert">{t('studio.history.degraded')} {snapshot.error}</p>}
    {snapshot?.readOnly&&<p role="status">{t('studio.history.readOnly')}</p>}
    {!loading&&!failed&&!rows.length&&<p>{t(snapshot?.records.length?'studio.history.inQueue':'studio.history.empty')}</p>}
    <div className="wb-history-content"><ul className="wb-history-list">{rows.map(row=>{const intent=row.intent;return <li key={row.id}><button type="button" data-history-id={row.id} aria-pressed={selected===row.id} data-state={row.state} onClick={()=>select(row)}><strong>{t(`studio.jobs.${row.state}`)} · {row.id.slice(0,8)}</strong><small>{isVideoIntent(intent)?intent.model:intent.checkpoint}</small><small>{new Date(row.admittedAt).toLocaleString(locale)} · {intent.seed}</small>{liveIds.includes(row.id)&&<small>{t('studio.history.currentQueue')}</small>}</button></li>;})}</ul>
    {record&&restore&&<section className="wb-history-detail" aria-label={t('studio.history.details')} data-history-details>
     <h3>{t('studio.history.lastObserved',{state:t(`studio.jobs.${record.state}`)})}</h3>
     <p>{new Date(record.observedAt).toLocaleString(locale)} · {record.origin==='studio'?t('studio.history.origin.studio'):t('studio.history.origin.diagnostic')} · {record.appVersion}</p>
     {(record.state==='queued'||record.state==='running'||record.state==='unknown')&&<p>{t('studio.history.uncertain')}</p>}
     {record.error&&<p role="status">{record.error}</p>}
     <dl className="wb-metadata"><div><dt>{t('studio.run.seed')}</dt><dd>{record.intent.seed}</dd></div><div><dt>{t('studio.run.resolution.title')}</dt><dd>{record.intent.width} × {record.intent.height}</dd></div><div><dt>{t('studio.run.positive')}</dt><dd>{record.intent.positivePrompt}</dd></div></dl>
     {duration!==null&&<p>{t('studio.run.metadata.time')}: {duration}</p>}
     <details open={settingsOpen} onToggle={event=>setSettingsOpen(event.currentTarget.open)}><summary>{t('studio.history.effective')}</summary>{effectiveJson!==null&&<pre>{effectiveJson}</pre>}</details>
     <h4>{t('studio.history.outputs')}</h4>
     {!record.outputs.length&&<p>{t('studio.history.noOutputs')}</p>}
     <ul>{record.outputs.map((output,index)=><li key={index}>{[output.subfolder,output.filename].filter(Boolean).join('/')} · <span>{t(`studio.history.output.${availability[index]??(record.outputRoot?'unvalidated':'remote')}`)}</span></li>)}</ul>
     {!!record.outputs.length&&sameRoot&&<button type="button" className="wb-dock-action" disabled={checking} onClick={()=>void checkOutputs()}>{t('studio.history.checkOutputs')}</button>}
     {!confirm?<button type="button" data-history-restore className="wb-dock-action" disabled={authoringBusy} onClick={()=>{setConfirm(true);setApplied(false);}}>{t('studio.history.use')}</button>:<div data-history-confirm>
      <p>{t('studio.history.authoring')}</p>
      <p>{t('studio.history.replaceDraft')}</p>
      {projectOpen&&<p>{t('studio.history.project')}</p>}
      {(restore.unavailable.length>0||restore.unsupported.length>0)&&<><p>{t('studio.history.partial')}</p>{restore.unavailable.length>0&&<p>{t('studio.history.unavailable',{items:restore.unavailable.join(' · ')})}</p>}{restore.unsupported.length>0&&<p>{t('studio.history.unsupported',{items:restore.unsupported.join(' · ')})}</p>}</>}
      <button type="button" data-history-apply className="wb-dock-action" disabled={authoringBusy} onClick={()=>{onRestore(restore);setConfirm(false);setApplied(true);}}>{t(restore.unavailable.length||restore.unsupported.length?'studio.history.applyPartial':'studio.history.apply')}</button>
      <button type="button" className="wb-dock-action" onClick={()=>setConfirm(false)}>{t('studio.history.cancel')}</button>
     </div>}
     {applied&&<p role="status">{t('studio.history.applied')}</p>}
    </section>}
    </div>
   </>}
  </div>}
 </section>;
}
