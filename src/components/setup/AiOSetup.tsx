import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { initialSetupState, setupPresentation, storageTarget, setupPlan, transitionSetup, validateBackend, type FeatureId, type InstallOptions, type NativeInstallPlan, type NativeInstallStatus, type NativeInstallDefaults } from '../../lib/setup';
import './setup.css';
import { OwnedBackendPanel } from './OwnedBackendPanel';
import { DownloadWorkspace } from '../../features/downloads/DownloadWorkspace';
export interface AiOSetupProps { onConnectExisting: (baseUrl: string) => void; onInstalled?: (features: readonly FeatureId[]) => void }
/** Automatic-only setup: folder + Director, the rest recommended; Start install is the single authorization. */
export function AiOSetup({ onConnectExisting, onInstalled }: AiOSetupProps) {
 const {t}=useI18n();
 const native=isTauri();
 const [state,setState]=useState(initialSetupState);
 const [error,setError]=useState('');
 const [pickerBusy,setPickerBusy]=useState(false);
 const pickerLock=useRef(false);
 const [storageParent,setStorageParent]=useState('');
 const [technicalError,setTechnicalError]=useState('');
 const [existingUrl,setExistingUrl]=useState('');
 const [nativePlan,setNativePlan]=useState<NativeInstallPlan|null>(null);
 const startedPlan=useRef<NativeInstallPlan|null>(null);
 const notifiedPlans=useRef(new Set<string>());
 const [defaults,setDefaults]=useState<NativeInstallDefaults|null>(null);
 const defaultsRequest=useRef<Promise<NativeInstallDefaults>|null>(null);
 const touched=useRef(new Set<string>());
 const operationLock=useRef(false);
 const [busy,setBusy]=useState(false);
 const [status,setStatus]=useState<NativeInstallStatus|null>(null);
 const [detectionError,setDetectionError]=useState('');
 const generation=useRef(0);
 const running=status?.state==='running';
 const defaultsLocked=useRef(false);
 defaultsLocked.current=!!nativePlan||busy||running||pickerBusy;
 const edit=(event:Parameters<typeof transitionSetup>[1],field:string)=>{if(operationLock.current||running||pickerLock.current)return;touched.current.add(field);setState(s=>transitionSetup(s,event));};
 const plan=setupPlan(state);
 const signature=JSON.stringify(plan);
 const planMatches=!!nativePlan&&plan?.route==='managed'&&nativePlan.request.storagePath===plan.storagePath&&nativePlan.request.backend===plan.backend&&nativePlan.request.comfyRef===plan.comfyRef&&JSON.stringify(nativePlan.request.features)===JSON.stringify(plan.features)&& (Object.keys(plan.options) as (keyof InstallOptions)[]).every(id=>nativePlan.request.options?.[id]===plan.options[id]);
 const [view,setView]=useState<'setup'|'auth'|'downloads'>('setup');
 // One read-only defaults request per mounted setup, also reused by StrictMode effect replay.
 useEffect(()=>{
  if(!native||!state.opened)return;
  let alive=true;
  defaultsRequest.current??=invoke<NativeInstallDefaults>('native_install_defaults',{});
  void defaultsRequest.current.then(result=>{
   if(!alive)return;
   if(!result||typeof result.storagePath!=='string'||!['cpu','nvidia'].includes(result.backend)||!Array.isArray(result.warnings)){setDetectionError(t('setup.defaultsInvalid'));return;}
   setDefaults(result);
   setState(s=>{
    if(defaultsLocked.current)return s;
    return {...s,values:{...s.values,...(!touched.current.has('storage')&&!s.values.storage?{storage:result.storagePath}:{}),...(!touched.current.has('acceleration')&&!s.values.acceleration?{acceleration:result.backend}:{})}};
   });
  },e=>{if(alive)setDetectionError(String(e));});
  return ()=>{alive=false;};
 },[native,state.opened,t]);
 useEffect(()=>{generation.current++;setNativePlan(null);setTechnicalError('');},[signature]);
 useEffect(()=>{
  if(!native||!onInstalled||status?.state!=='succeeded'||!planMatches||!nativePlan||startedPlan.current!==nativePlan||notifiedPlans.current.has(nativePlan.id))return;
  notifiedPlans.current.add(nativePlan.id);
  onInstalled(nativePlan.request.features);
 },[native,onInstalled,status,planMatches,nativePlan]);
 useEffect(()=>()=>{generation.current++;},[]);
 useEffect(()=>{
  if(!native||!running) return;
  let alive=true,inflight=false;
  const poll=async()=>{
   if(inflight) return;inflight=true;
   try { const next=await invoke<NativeInstallStatus>('native_install_status');if(alive){setStatus(next);setTechnicalError('');} }
   catch(e){if(alive)setTechnicalError(String(e));}
   finally{inflight=false;}
  };
  void poll();const timer=window.setInterval(()=>void poll(),1000);
  return ()=>{alive=false;window.clearInterval(timer);};
 },[native,running]);
 const pickDirectory=async()=>{
  if(!native||running||busy||pickerLock.current)return;
  pickerLock.current=true;setPickerBusy(true);setTechnicalError('');
  try {
   const parent=await invoke<string|null>('native_pick_directory',{title:t('setup.pickTitle')});
   if(parent!==null){touched.current.add('storage');const target=storageTarget(parent,'deas-environment');setStorageParent(parent);if(target){setState(s=>transitionSetup(s,{type:'select',step:'storage',value:target}));setError('');}else setError('setup.error.child');}
  }catch(e){setTechnicalError(String(e));}
  finally{pickerLock.current=false;setPickerBusy(false);}
 };
 const prepare=async()=>{
  if(!native||operationLock.current||busy||running||pickerBusy||error||plan?.route!=='managed')return;
  operationLock.current=true;
  const version=generation.current;
  setBusy(true);setNativePlan(null);setTechnicalError('');setStatus(null);
  const {storagePath,backend,features,options,comfyRef}=plan;
  try{const result=await invoke<NativeInstallPlan>('native_install_plan',{request:{storagePath,backend,features,options,comfyRef}});if(version===generation.current)setNativePlan(result);}
  catch(e){if(version===generation.current)setTechnicalError(String(e));}
  finally{operationLock.current=false;setBusy(false);}
 };
 // Plans without a separate click; Start stays the only authorization.
 useEffect(()=>{
  if(!native||running||busy||nativePlan||technicalError||error||plan?.route!=='managed')return;
  const timer=window.setTimeout(()=>void prepare(),250);
  return ()=>window.clearTimeout(timer);
 });
 const start=async()=>{
  if(!native||operationLock.current||busy||running||!nativePlan?.canExecute||nativePlan.unsupportedOptions.length||plan?.route!=='managed'||!planMatches)return;
  operationLock.current=true;
  setBusy(true);setTechnicalError('');
  startedPlan.current=nativePlan;
  try{const next=await invoke<NativeInstallStatus>('native_install_start',{planId:nativePlan.id,confirmed:true});setStatus(next);}
  catch(e){startedPlan.current=null;setTechnicalError(String(e));}
  finally{operationLock.current=false;setBusy(false);}
 };
 const cancel=async()=>{
  if(!native||!running||busy)return;setBusy(true);
  try{await invoke('native_install_cancel');setStatus(await invoke<NativeInstallStatus>('native_install_status'));}
  catch(e){setTechnicalError(String(e));}finally{setBusy(false);}
 };
 return <section className="aio-setup" aria-label={t('setup.region')}>
  <header className="aio-setup-header"><p className="aio-setup-eyebrow">{t('setup.eyebrow')}</p>
  </header>
  {state.opened&&defaults&&!status&&<div className="aio-help" role="status"><p>{t(defaults.backend==='nvidia'?'setup.detectedNvidia':'setup.cpuRecommendation')}</p><p>{t('setup.autoFindings')}</p>{typeof defaults.hardware?.name==='string'&&<p>{String(defaults.hardware.name)}</p>}{defaults.warnings.length>0&&<ul>{defaults.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>}</div>}
  {detectionError&&<p className="aio-error" role="alert">{t('setup.detectionError')}: {detectionError}</p>}
  <div className="aio-decision-area">
  <div className="aio-left">
  <div className="aio-tabs" role="tablist" aria-label={t('setup.decisions')}>
   <button type="button" role="tab" data-node="setup:aio" className={`aio-tab aio-tab-installer ${status?.state==='succeeded'?'is-done':'is-pending'}`} aria-selected={view==='setup'} aria-label={t('setup.aio.label')} disabled={running||busy||pickerBusy} onClick={()=>{setView('setup');if(!pickerLock.current)setState(s=>transitionSetup(s,{type:'automatic'}));}}>{status?.state==='succeeded'&&<span className="aio-tab-check" aria-hidden="true">✓</span>}{t('setup.aio.label')}<small>{t(status?.state==='succeeded'?'setup.tab.installed':'setup.aio.description')}</small></button>
   <button type="button" role="tab" data-node="provider-auth" className="aio-tab" aria-selected={view==='auth'} onClick={()=>setView('auth')}>{t('downloads.auth')}</button>
   <button type="button" role="tab" data-node="optional-downloads" className="aio-tab" aria-selected={view==='downloads'} onClick={()=>setView('downloads')}>{t('downloads.title')}</button>
  </div>
  <DownloadWorkspace view={view==='setup'?null:view} installTarget={plan?.route==='managed'?plan.storagePath:undefined}/>
  {error&&<p className="aio-error" role="alert">{t(error)}</p>}{technicalError&&<p className="aio-error" role="alert">{t('setup.technicalError')}: {technicalError}</p>}
  </div>
  <aside className="aio-right">
  {state.opened&&<section className="aio-detail aio-auto-review" aria-label={t('setup.autoReview')}><h3>{t('setup.autoReview')}</h3><p className="aio-help">{t(native?'setup.autoHelp':'setup.autoBrowser')}</p>
   <fieldset className="aio-auto-fields" disabled={running||busy||pickerBusy}>
    <label htmlFor="auto-storage">{t('setup.storageDirectory')}</label><input id="auto-storage" value={state.values.storage??''} onChange={e=>{setStorageParent('');setError('');edit({type:'select',step:'storage',value:e.target.value},'storage');}}/>
    <button type="button" disabled={!native} onClick={()=>void pickDirectory()}>{t('setup.pickParent')}</button>{storageParent&&<p className="aio-help">{t('setup.selectedParent')}: <code>{storageParent}</code></p>}
    <label title={t('setup.capabilityHelp')}><input type="checkbox" checked={state.features.includes('director')} onChange={()=>edit({type:'feature',id:'director'},'features')}/>{t('setup.feature.director.label')}</label><span className="aio-fact-sub">{t('setup.feature.director.short')}</span>
   </fieldset>
   {nativePlan&&<div className="aio-start">
    <dl className="aio-facts">
     <div><dt>{t('setup.request.backend')}</dt><dd>{t(`setup.backend.${nativePlan.request.backend}.label`)}{typeof nativePlan.hardware?.name==='string'&&<span className="aio-fact-sub">{nativePlan.hardware.name}</span>}</dd></div>
     <div><dt>{t('setup.summary.selected')}</dt><dd>{nativePlan.request.features.includes('director')?t('setup.summary.director'):t('setup.summary.core')}</dd></div>
     {Array.isArray(nativePlan.torch?.packages)&&<div><dt>{t('setup.profile.packages')}</dt><dd>{String(nativePlan.torch.packages[0]).replace('==',' ')}{typeof nativePlan.torch.cuda==='string'&&<span className="aio-fact-sub">{t('setup.profile.cuda')} {nativePlan.torch.cuda}</span>}</dd></div>}
    </dl>
    <ol className="aio-chain" aria-label={t('setup.nativeSteps')}>{nativePlan.steps.map(s=><li key={s.id}><span title={s.detail}>{t(`installer.chain.${s.id}`)}</span></li>)}</ol>
    {nativePlan.warnings.length>0&&<details className="aio-notes"><summary>{t('setup.notes',{count:nativePlan.warnings.length})}</summary><ul className="aio-help">{nativePlan.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></details>}
    {nativePlan.unsupportedOptions.length>0&&<><h4>{t('setup.unsupported')}</h4><ul>{nativePlan.unsupportedOptions.map(o=><li key={o}>{o}</li>)}</ul></>}
    {!nativePlan.canExecute&&<p role="alert">{t('setup.blocked')}</p>}
    <button className="aio-confirm-button" title={t('setup.autoConsent')} disabled={!planMatches||running||busy||!nativePlan.canExecute||nativePlan.unsupportedOptions.length>0} onClick={()=>void start()}>{t(status?.state==='succeeded'?'setup.rerun':'setup.autoStart')}</button>
   </div>}
   <fieldset className="aio-auto-fields" disabled={running||busy||pickerBusy}>
    <details className="aio-advanced"><summary>{t('setup.advanced')}</summary>
     <label htmlFor="auto-backend">{t('setup.request.backend')}</label><select id="auto-backend" value={state.values.acceleration??''} onChange={e=>edit({type:'select',step:'acceleration',value:e.target.value},'acceleration')}><option value="">{t('setup.manualBackend')}</option>{['cpu','nvidia','amd','intel'].map(id=><option key={id} value={id}>{t(`setup.backend.${id}.label`)}</option>)}</select>
     {(Object.keys(state.options) as (keyof InstallOptions)[]).map(id=><label key={id}><input type="checkbox" checked={state.options[id]} onChange={e=>edit({type:'option',id,enabled:e.target.checked},'options')}/>{t(`setup.option.${id}`)}</label>)}
     <p className="aio-help">{t('setup.optionsHelp')}</p>
     <label htmlFor="auto-ref">{t('setup.comfyRef')}</label><input id="auto-ref" value={state.comfyRef} maxLength={120} onChange={e=>edit({type:'ref',value:e.target.value},'ref')}/>
     <label htmlFor="existing-url">{t('setup.step.backend.label')}</label><input id="existing-url" type="url" value={existingUrl} spellCheck={false} onChange={e=>{setExistingUrl(e.target.value);setError('');}}/><p className="aio-help">{t('setup.backendHelp')}</p>
     <button type="button" disabled={!existingUrl.trim()} onClick={()=>{if(validateBackend(existingUrl.trim()))onConnectExisting(existingUrl.trim());else setError('setup.error.backend');}}>{t('setup.inspect')}</button>
    </details>
   </fieldset>{busy&&<p className="aio-help" role="status">{t('setup.busy')}</p>}
  </section>}
  {status&&<section className="aio-detail" aria-label={t('setup.installStatus')}><h3>{t('setup.installStatus')}</h3><p role="status">{t(`setup.execution.${status.state}`)}{status.stepId&&` · ${status.stepId}`}</p>{status.state==='succeeded'&&<p>{t('setup.installedNotReady')}</p>}<details><summary>{t('setup.logs')}</summary><pre aria-label={t('setup.logs')}>{status.logs.join('\n')}</pre></details>{status.error&&<p role="alert">{t('setup.technicalError')}: {status.error}</p>}{running&&<button disabled={busy} onClick={()=>void cancel()}>{t('setup.cancel')}</button>}</section>}
  {status?.state==='succeeded'&&<OwnedBackendPanel installSucceeded onConnectExisting={onConnectExisting}/>}
  </aside>
  </div>
 </section>;
}
export default AiOSetup;
