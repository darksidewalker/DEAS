import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import type { NativeBackendStatus } from '../../lib/setup';

/** `children` (e.g. the autostart switch) render above the action row; `actions` extend it; `locked` disables lifecycle buttons while the environment is being changed. */
export function OwnedBackendPanel({installSucceeded,onConnectExisting,autoStart=false,children,actions,locked=false}: {installSucceeded:boolean;onConnectExisting:(endpoint:string)=>void;autoStart?:boolean;children?:ReactNode;actions?:ReactNode;locked?:boolean}) {
 const {t}=useI18n();
 const native=isTauri();
 const [status,setStatus]=useState<NativeBackendStatus|null>(null);
 const [busy,setBusy]=useState(false);
 const [technicalError,setTechnicalError]=useState('');
 const lock=useRef(false);
 const epoch=useRef(0);
 const live=useRef(false);
 const active=status?.state==='starting'||status?.state==='running';
 const connectedEndpoint=useRef<string|null>(null);
 useEffect(()=>{
  const endpoint=native&&status?.state==='running'&&status.endpoint?status.endpoint:null;
  if(!endpoint){connectedEndpoint.current=null;return;}
  if(connectedEndpoint.current===endpoint)return;
  connectedEndpoint.current=endpoint;
  onConnectExisting(endpoint);
 },[native,status,onConnectExisting]);
 useEffect(()=>{
  live.current=true;
  return ()=>{live.current=false;epoch.current++;};
 },[]);
 // `quiet` (background polls) skips the busy state: toggling disabled every second made the buttons flicker.
 const request=useCallback(async(command:'native_backend_start'|'native_backend_status'|'native_backend_stop',quiet=false)=>{
  if(!native||!live.current)return;
  // A click during a background poll waits for it instead of being dropped.
  if(lock.current){if(quiet)return;while(lock.current)await new Promise(r=>setTimeout(r,50));if(!live.current)return;}
  lock.current=true;if(!quiet)setBusy(true);
  const version=epoch.current;
  try {
   // No environment, executable or endpoint may be supplied by the frontend.
   const next=await invoke<NativeBackendStatus>(command);
   if(live.current&&version===epoch.current){setStatus(next);setTechnicalError('');return next;}
  } catch(e) {
   if(live.current&&version===epoch.current){
    setTechnicalError(String(e));
    // An IPC failure is not a running/readiness result. Refresh can recover the native truth.
    setStatus(null);
   }
  } finally {
   lock.current=false;
   if(!quiet&&live.current&&version===epoch.current)setBusy(false);
  }
 },[native]);
 const autoAttempted=useRef(false);
 useEffect(()=>{
  if(!native||!installSucceeded||!autoStart||autoAttempted.current)return;
  let alive=true;
  const timer=window.setTimeout(async()=>{
   if(!alive||autoAttempted.current)return;autoAttempted.current=true;
   const current=await request('native_backend_status');
   if(alive&&current?.state==='stopped')await request('native_backend_start');
  },0);
  return()=>{alive=false;window.clearTimeout(timer);};
 },[native,installSucceeded,autoStart,request]);
 useEffect(()=>{
  if(!native||!active)return;
  let alive=true;
  let timer:number;
  const poll=async()=>{
   await request('native_backend_status',true);
   if(alive)timer=window.setTimeout(()=>void poll(),1000);
  };
  timer=window.setTimeout(()=>void poll(),1000);
  return ()=>{alive=false;window.clearTimeout(timer);};
 },[native,active,request]);
 return <section className="aio-detail" aria-label={t('setup.backendLifecycle.title')}>
  <h3>{t('setup.backendLifecycle.title')}</h3>
  <p className="aio-help">{t(native?'setup.backendLifecycle.help':'setup.backendLifecycle.browser')}</p>
  <p role={status?'status':undefined}>{t(status?`setup.backendLifecycle.${status.state}`:'setup.backendLifecycle.unknown')}</p>
  <p className="aio-help">{t('setup.backendLifecycle.notReady')}</p>
  {status?.endpoint&&<p>{t('setup.backendLifecycle.endpoint')}: <code>{status.endpoint}</code></p>}
  {children}
  <div className="aio-actions">
   {native&&installSucceeded&&!active&&<button disabled={busy||locked} onClick={()=>void request('native_backend_start')}>{t('setup.backendLifecycle.start')}</button>}
   <button disabled={!native||busy} onClick={()=>void request('native_backend_status')}>{t('setup.backendLifecycle.refresh')}</button>
   {native&&status?.state==='running'&&<button disabled={busy||locked} onClick={()=>void request('native_backend_stop').then(s=>{if(s?.state==='stopped')return request('native_backend_start');})}>{t('setup.backendLifecycle.restart')}</button>}
   {native&&active&&<button disabled={busy} onClick={()=>void request('native_backend_stop')}>{t('setup.backendLifecycle.stop')}</button>}
   {native&&status?.state==='running'&&status.endpoint&&<button disabled={busy} onClick={()=>onConnectExisting(status.endpoint!)}>{t('setup.backendLifecycle.inspect')}</button>}
   {actions}
  </div>
  {(technicalError||status?.error)&&<p className="aio-error" role="alert">{t('setup.technicalError')}: {technicalError||status?.error}</p>}
 </section>;
}
