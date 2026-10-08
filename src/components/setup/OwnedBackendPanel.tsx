import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import type { NativeBackendStatus } from '../../lib/setup';

export function OwnedBackendPanel({installSucceeded,onConnectExisting}: {installSucceeded:boolean;onConnectExisting:(endpoint:string)=>void}) {
 const {t}=useI18n();
 const native=isTauri();
 const [status,setStatus]=useState<NativeBackendStatus|null>(null);
 const [busy,setBusy]=useState(false);
 const [technicalError,setTechnicalError]=useState('');
 const lock=useRef(false);
 const epoch=useRef(0);
 const live=useRef(false);
 const active=status?.state==='starting'||status?.state==='running';
 useEffect(()=>{
  live.current=true;
  return ()=>{live.current=false;epoch.current++;};
 },[]);
 const request=useCallback(async(command:'native_backend_start'|'native_backend_status'|'native_backend_stop')=>{
  if(!native||!live.current||lock.current)return;
  lock.current=true;setBusy(true);
  const version=epoch.current;
  try {
   // No environment, executable or endpoint may be supplied by the frontend.
   const next=await invoke<NativeBackendStatus>(command);
   if(live.current&&version===epoch.current){setStatus(next);setTechnicalError('');}
  } catch(e) {
   if(live.current&&version===epoch.current){
    setTechnicalError(String(e));
    // An IPC failure is not a running/readiness result. Refresh can recover the native truth.
    setStatus(null);
   }
  } finally {
   lock.current=false;
   if(live.current&&version===epoch.current)setBusy(false);
  }
 },[native]);
 useEffect(()=>{
  if(!native||!active)return;
  let alive=true;
  let timer:number;
  const poll=async()=>{
   await request('native_backend_status');
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
  <div className="aio-actions">
   {native&&installSucceeded&&!active&&<button disabled={busy} onClick={()=>void request('native_backend_start')}>{t('setup.backendLifecycle.start')}</button>}
   <button disabled={!native||busy} onClick={()=>void request('native_backend_status')}>{t('setup.backendLifecycle.refresh')}</button>
   {native&&active&&<button disabled={busy} onClick={()=>void request('native_backend_stop')}>{t('setup.backendLifecycle.stop')}</button>}
   {native&&status?.state==='running'&&status.endpoint&&<button disabled={busy} onClick={()=>onConnectExisting(status.endpoint!)}>{t('setup.backendLifecycle.inspect')}</button>}
  </div>
  {status&&<details><summary>{t('setup.backendLifecycle.logs')}</summary><pre aria-label={t('setup.backendLifecycle.logs')}>{status.logs.join('\n')}</pre></details>}
  {(technicalError||status?.error)&&<p className="aio-error" role="alert">{t('setup.technicalError')}: {technicalError||status?.error}</p>}
 </section>;
}
