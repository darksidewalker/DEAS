import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { initialSetupState, setupPresentation, storageTarget, setupPlan, transitionSetup, validateBackend, type FeatureId, type InstallOptions, type NativeInstallPlan, type NativeInstallStatus, type NativeInstallDefaults, type NativeBackendStatus } from '../../lib/setup';
import './setup.css';
import { OpenComfyWorkflow, sendComfyWorkflow, type ComfyWorkflow } from '../../lib/comfyWorkflow';
import { OwnedBackendPanel } from './OwnedBackendPanel';
import { StartupPanel } from '../../features/settings/StartupPanel';
import { LlmPanel } from '../../features/llm/LlmPanel';
import { RepoLinks } from './RepoLinks';
import { DownloadWorkspace } from '../../features/downloads/DownloadWorkspace';
import { FoldersPanel, FolderFields } from '../../features/settings/FoldersPanel';
import { LanguageSetting } from '../../features/settings/LanguageSetting';
import { LogsPanel } from '../../features/logs/LogsPanel';
import { filesPresent, readFolders, type Folders } from '../../lib/settings';
import { authProviders } from '../../features/downloads/DownloadPluginPanel';
import { readAuthStatus, verifyAuthToken } from '../../lib/downloads';
import { forgetPref, isBoolean, isString, readPref, usePref, writePref } from '../../lib/preferences';
// Root of the last successful install; restored on start only while its deas-install.json still exists.
const installedKey='install.root';
/** `studio` is the studio workspace rendered under the Studio tab; `brand` sits left in the top row. */
export interface AiOSetupProps { /** `inspect` is true for the explicit Inspect button, false for the owned backend's automatic handoff. */ onConnectExisting: (baseUrl: string, inspect?: boolean) => void; onInstalled?: (features: readonly FeatureId[]) => void; /** Installed environment root plus its saved folder settings, for the Studio media roots. */ onEnvironment?: (environment: { root: string; folders: Folders } | null) => void; studio?: ReactNode; brand?: ReactNode }
/** Automatic-only setup: folder + Director, the rest recommended; Start install is the single authorization. */
export function AiOSetup({ onConnectExisting, onInstalled, onEnvironment, studio, brand }: AiOSetupProps) {
 const {t}=useI18n();
 const native=isTauri();
 const [verified,setVerified]=useState<string[]>([]);
 const [autoStart,setAutoStart]=usePref('backend.autostart',true,isBoolean);
 const [state,setState]=useState(initialSetupState);
 const [error,setError]=useState('');
 const [pickerBusy,setPickerBusy]=useState(false);const [folderPickerBusy,setFolderPickerBusy]=useState(false);
 const pickerLock=useRef(false);
 const [storageParent,setStorageParent]=useState('');
 const [technicalError,setTechnicalError]=useState('');
 const [existingUrl,setExistingUrl]=useState('');
 const [nativePlan,setNativePlan]=useState<NativeInstallPlan|null>(null);
 const reopening=!!nativePlan?.reopenId;
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
 defaultsLocked.current=!!nativePlan||busy||running||pickerBusy||folderPickerBusy;
 const edit=(event:Parameters<typeof transitionSetup>[1],field:string)=>{if(operationLock.current||running||pickerLock.current)return;touched.current.add(field);setState(s=>transitionSetup(s,event));};
 const [folders,setFolders]=useState<Folders>({});const [folderDraft,setFolderDraft]=useState<Folders>({});
 const plan=setupPlan(state);
 const signature=JSON.stringify([plan,folderDraft]);
 const planMatches=JSON.stringify(nativePlan?.request.folders??{})===JSON.stringify(folderDraft)&&!!nativePlan&&plan?.route==='managed'&&nativePlan.request.storagePath===plan.storagePath&&nativePlan.request.backend===plan.backend&&nativePlan.request.comfyRef===plan.comfyRef&&JSON.stringify(nativePlan.request.features)===JSON.stringify(plan.features)&& (Object.keys(plan.options) as (keyof InstallOptions)[]).every(id=>nativePlan.request.options?.[id]===plan.options[id]);
 const [view,setView]=useState<'studio'|'downloads'|'comfy'|'setup'|'auth'|'settings'|'logs'>('setup');
 const [backendStatus,setBackendStatus]=useState<NativeBackendStatus|null>(null);
 const comfyEndpoint=backendStatus?.state==='running'?backendStatus.endpoint??'':'';
 const [comfyLoaded,setComfyLoaded]=useState(false);
 const comfyFrame=useRef<HTMLIFrameElement>(null);
 const handoff=useRef<AbortController|null>(null);
 useEffect(()=>()=>handoff.current?.abort(),[comfyEndpoint]);
 const openWorkflow=async(workflow:ComfyWorkflow,name:string)=>{
  if(!comfyEndpoint)throw new Error('Backend disconnected');
  handoff.current?.abort();const controller=new AbortController();handoff.current=controller;
  setView('comfy');
  // Wait for React to mount the previously unvisited editor before starting its handshake.
  await new Promise<void>(resolve=>setTimeout(resolve,0));
  if(!comfyFrame.current||controller.signal.aborted)throw new Error('Backend disconnected');
  await sendComfyWorkflow(comfyFrame.current,comfyEndpoint,workflow,name,controller.signal);
 };
 useEffect(()=>setComfyLoaded(false),[comfyEndpoint]);
 const comfyVisited=useRef(false);if(view==='comfy')comfyVisited.current=true;
 // After success the review hides; Upgrade / Re-run installation live in Backend.
 const succeeded=status?.state==='succeeded';const [confirmReinstall,setConfirmReinstall]=useState(false);
 // A finished upgrade/reinstall remounts the backend panel so autostart applies to the new environment.
 const updating=useRef(false);const [updates,setUpdates]=useState(0);
 const inAuth=view==='auth';
 useEffect(()=>{if(!native||inAuth)return;let alive=true;
  readAuthStatus().then(list=>Promise.all(list.filter(m=>m.configured).map(m=>verifyAuthToken(m.providerId).catch(()=>null))))
   .then(checks=>{if(alive)setVerified(checks.filter(c=>c?.status==='verified').map(c=>c!.providerId));},()=>{});
  return()=>{alive=false;};},[native,inAuth]);
 const [restartSignal,setRestartSignal]=useState(0);
 const [installedRoot,setInstalledRoot]=useState('');const installed=succeeded||!!installedRoot;
 useEffect(()=>{onEnvironment?.(installedRoot?{root:installedRoot,folders}:null);},[installedRoot,folders,onEnvironment]);
 const review=state.opened&&!installed;const side=(view==='setup'&&(review||installed))||(view==='settings'&&installed);
 const connect=(baseUrl:string)=>{setView('studio');onConnectExisting(baseUrl,true);};
 const studioVisited=useRef(false);if(view==='studio')studioVisited.current=true;
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
  if(!native||status?.state!=='succeeded'||(!planMatches&&!reopening)||!nativePlan||startedPlan.current!==nativePlan||notifiedPlans.current.has(nativePlan.id))return;
  notifiedPlans.current.add(nativePlan.id);
  setView('studio');setInstalledRoot(nativePlan.request.storagePath);writePref(installedKey,nativePlan.request.storagePath);
  onInstalled?.(nativePlan.request.features);
 },[native,onInstalled,status,planMatches,nativePlan]);
 useEffect(()=>()=>{generation.current++;},[]);
 // Reuse one native validation/open operation across StrictMode effect replay; never reinstall on restore.
 const restoreRequest=useRef<Promise<{plan:NativeInstallPlan;status:NativeInstallStatus;folders:Folders}|null>|null>(null);
 useEffect(()=>{
  const root=readPref(installedKey,'',isString);if(!native||!root)return;let alive=true;operationLock.current=true;setBusy(true);
  restoreRequest.current??=(async()=>{
   const [found]=await filesPresent([`${root}/deas-install.json`]);if(!found){forgetPref(installedKey);return null;}
   const plan=await invoke<NativeInstallPlan>('native_install_plan',{request:{storagePath:root,backend:'cpu',features:[],options:{sage:false,radial:false,flash:false,ffmpeg:false},comfyRef:'master'}});
   if(!plan.reopenId)throw new Error('Saved environment is not a complete DEAS installation; no installation or backend was started');
   const folders=await readFolders(plan.request.storagePath);
   const status=await invoke<NativeInstallStatus>('native_install_open',{planId:plan.id,confirmed:true});
   return {plan,status,folders};
  })();
  restoreRequest.current.then(result=>{
   if(!alive||!result)return;
   touched.current.add('storage');touched.current.add('acceleration');
   setState(s=>{const next=transitionSetup(s,{type:'automatic'});return {...next,opened:s.opened,values:{...next.values,storage:result.plan.request.storagePath,acceleration:result.plan.request.backend},features:result.plan.request.features,options:result.plan.request.options,comfyRef:result.plan.request.comfyRef};});
   setInstalledRoot(result.plan.request.storagePath);setStatus(result.status);setFolders(result.folders);setView(v=>v==='setup'?'studio':v);
   if(!notifiedPlans.current.has(result.plan.id)){notifiedPlans.current.add(result.plan.id);onInstalled?.(result.plan.request.features);}
  },e=>{if(alive)setTechnicalError(String(e));}).finally(()=>{operationLock.current=false;if(alive)setBusy(false);});
  return()=>{alive=false;};
 },[native]);
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
  if(!native||running||busy||folderPickerBusy||pickerLock.current)return;
  pickerLock.current=true;setPickerBusy(true);setTechnicalError('');
  try {
   const parent=await invoke<string|null>('native_pick_directory',{title:t('setup.pickTitle')});
   if(parent!==null){touched.current.add('storage');const flags=await filesPresent([`${parent}/deas-plan.json`,`${parent}/deas-install.json`]);const target=Array.isArray(flags)&&flags.some(Boolean)?parent:storageTarget(parent,'deas-environment');setStorageParent(parent);if(target){setState(s=>transitionSetup(s,{type:'select',step:'storage',value:target}));setError('');}else setError('setup.error.child');}
  }catch(e){setTechnicalError(String(e));}
  finally{pickerLock.current=false;setPickerBusy(false);}
 };
 const prepare=async()=>{
  if(!native||operationLock.current||busy||running||pickerBusy||folderPickerBusy||error||plan?.route!=='managed')return;
  operationLock.current=true;
  const version=generation.current;
  setBusy(true);setNativePlan(null);setTechnicalError('');setStatus(null);
  const {storagePath,backend,features,options,comfyRef}=plan;
  try{const result=await invoke<NativeInstallPlan>('native_install_plan',{request:{storagePath,backend,features,options,comfyRef,...(Object.keys(folderDraft).length?{folders:folderDraft}:{})}});if(version===generation.current)setNativePlan(result);}
  catch(e){if(version===generation.current)setTechnicalError(String(e));}
  finally{operationLock.current=false;setBusy(false);}
 };
 // Plans without a separate click; Start stays the only authorization.
 useEffect(()=>{
  if(!native||installed||running||busy||folderPickerBusy||nativePlan||technicalError||error||plan?.route!=='managed')return;
  const timer=window.setTimeout(()=>void prepare(),250);
  return ()=>window.clearTimeout(timer);
 });
 const start=async()=>{
  if(!native||operationLock.current||busy||running||folderPickerBusy||!nativePlan?.canExecute||nativePlan.unsupportedOptions.length||plan?.route!=='managed'||(!planMatches&&!reopening))return;
  operationLock.current=true;
  setBusy(true);setTechnicalError('');
  startedPlan.current=nativePlan;
  try{const savedFolders=reopening?await readFolders(nativePlan.request.storagePath):folderDraft;const next=await invoke<NativeInstallStatus>(reopening?'native_install_open':'native_install_start',{planId:nativePlan.id,confirmed:true});setFolders(savedFolders);setStatus(next);}
  catch(e){startedPlan.current=null;setTechnicalError(String(e));}
  finally{operationLock.current=false;setBusy(false);}
 };
 const update=async(reinstall:boolean)=>{
  setConfirmReinstall(false);
  if(!native||operationLock.current||busy||running)return;
  operationLock.current=true;setBusy(true);setTechnicalError('');
  try{const next=await invoke<NativeInstallStatus>('native_install_update',{reinstall,confirmed:true});updating.current=true;setStatus(next);}
  catch(e){setTechnicalError(String(e));}
  finally{operationLock.current=false;setBusy(false);}
 };
 useEffect(()=>{if(updating.current&&status&&status.state!=='running'){updating.current=false;if(status.state==='succeeded')setUpdates(n=>n+1);}},[status]);
 const cancel=async()=>{
  if(!native||!running||busy)return;setBusy(true);
  try{await invoke('native_install_cancel');setStatus(await invoke<NativeInstallStatus>('native_install_status'));}
  catch(e){setTechnicalError(String(e));}finally{setBusy(false);}
 };
 return <section className={`aio-setup${view==='comfy'?' is-comfy':''}`} aria-label={t('setup.region')}>
  <header className="aio-setup-header" hidden={view==='comfy'}>{brand}
   <div className="aio-head-actions">
    <button type="button" data-node="setup:aio" className={`aio-tab aio-head aio-tab-installer ${installed?'is-done':'is-pending'}`} aria-pressed={view==='setup'} aria-label={t('setup.aio.label')} disabled={running||busy||pickerBusy||folderPickerBusy} onClick={()=>{setView('setup');if(!pickerLock.current&&!installed)setState(s=>transitionSetup(s,{type:'automatic'}));}}><span>{installed&&<span className="aio-tab-check" aria-hidden="true">✓</span>}{t('setup.aio.label')}</span><small>{t(installed?'setup.tab.installed':'setup.aio.description')}</small></button>
    <button type="button" data-node="provider-auth" className="aio-tab aio-head" aria-label={t('downloads.auth')} disabled={folderPickerBusy} aria-pressed={view==='auth'} onClick={()=>setView('auth')}><span>{verified.length>0&&<span className="aio-tab-check" aria-hidden="true">✓</span>}{t('downloads.auth')}</span>{verified.length>0&&<small>{authProviders.filter(p=>verified.includes(p.id)).map(p=>`✓ ${p.label}`).join(' · ')}</small>}</button>
    <button type="button" data-node="settings" className="aio-tab aio-head" disabled={folderPickerBusy} aria-describedby={backendStatus?.state==='starting'||backendStatus?.state==='running'?'backend-state':undefined} aria-pressed={view==='settings'} onClick={()=>setView('settings')}><span>{t('settings.button')}</span>{(backendStatus?.state==='starting'||backendStatus?.state==='running')&&<small id="backend-state" aria-hidden="true">{backendStatus.state==='running'&&<span className="aio-tab-check">✓</span>}{t(backendStatus.state==='starting'?'setup.backendStarting':'setup.backendStarted')}</small>}</button>
    <button type="button" data-node="logs" className="aio-tab aio-head" disabled={folderPickerBusy} aria-pressed={view==='logs'} onClick={()=>setView('logs')}>{t('logs.title')}</button>
    <RepoLinks canStar={verified.includes('github')}/>
   </div>
  </header>
  {view!=='comfy'&&detectionError&&<p className="aio-error" role="alert">{t('setup.detectionError')}: {detectionError}</p>}
  <div className={`aio-decision-area${side?'':' is-single'}`}>
  <div className="aio-left">
  <div className="aio-tabs" role="tablist" aria-label={t('setup.decisions')}>
   <button type="button" role="tab" data-node="studio" className="aio-tab" disabled={folderPickerBusy} aria-selected={view==='studio'} onClick={()=>setView('studio')}>{t('setup.tab.studio')}</button>
   <button type="button" role="tab" data-node="optional-downloads" className="aio-tab" disabled={folderPickerBusy} aria-selected={view==='downloads'} onClick={()=>setView('downloads')}>{t('downloads.title')}</button>
   <button type="button" role="tab" data-node="comfy" className="aio-tab" disabled={folderPickerBusy} aria-selected={view==='comfy'} onClick={()=>setView('comfy')}>{t('setup.tab.comfy')}</button>
  </div>
  {comfyVisited.current&&<div className="comfy-view" hidden={view!=='comfy'}>{(!comfyEndpoint||!comfyLoaded)&&<div className="comfy-loading" role="status"><span className="aio-spinner" aria-hidden="true"/>{t(comfyEndpoint?'setup.comfy.loading':'setup.comfy.waiting')}</div>}{comfyEndpoint&&<iframe ref={comfyFrame} title={t('setup.comfy.title')} src={comfyEndpoint} onLoad={()=>setComfyLoaded(true)} sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox" allow="clipboard-read; clipboard-write; fullscreen"/>}</div>}
  {status&&view!=='comfy'&&(running||view==='setup')&&<section className="aio-detail aio-status" aria-label={t('setup.installStatus')}><h3>{t('setup.installStatus')}</h3><p role="status">{running&&<span className="aio-spinner" aria-hidden="true"/>}{t(`setup.execution.${status.state}`)}{status.stepId&&` · ${status.stepId}`}</p>{status.state==='succeeded'&&<p>{t('setup.installedNotReady')}</p>}{status.logs.length>0&&<p className="aio-help aio-last-log">{status.logs[status.logs.length-1]}</p>}{status.error&&<p role="alert">{t('setup.technicalError')}: {status.error}</p>}{running&&<button disabled={busy} onClick={()=>void cancel()}>{t('setup.cancel')}</button>}</section>}
  {/* Once opened, the Studio stays mounted (hidden) so its panels keep their state across tab switches. */}
  {studioVisited.current&&<div hidden={view!=='studio'}><OpenComfyWorkflow.Provider value={comfyEndpoint?openWorkflow:null}>{studio}</OpenComfyWorkflow.Provider></div>}
  <DownloadWorkspace view={view==='auth'||view==='downloads'?view:null} installTarget={installedRoot||(plan?.route==='managed'?plan.storagePath:undefined)} modelsDir={installed?folders.models:folderDraft.models}/>
  {view==='setup'&&!succeeded&&installedRoot&&<p className="aio-help aio-detection" role="status">{t('setup.remembered',{path:installedRoot})}</p>}
  {view==='setup'&&review&&defaults&&!status&&<div className="aio-help aio-detection" role="status"><p>{t(defaults.backend==='nvidia'?'setup.detectedNvidia':'setup.cpuRecommendation')}</p><p>{t('setup.autoFindings')}</p>{typeof defaults.hardware?.name==='string'&&<p>{String(defaults.hardware.name)}</p>}{defaults.warnings.length>0&&<ul>{defaults.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>}</div>}
  {view==='logs'&&<LogsPanel/>}
  {view==='settings'&&<LanguageSetting/>}
  {view==='settings'&&<>{!installed&&<section className="aio-detail"><button type="button" className="download-switch backend-autostart" role="switch" aria-label={t('setup.backendAutostart')} aria-checked={autoStart} onClick={()=>setAutoStart(v=>!v)}><span>{t('setup.backendAutostart')}</span><span className="download-switch-knob" aria-hidden="true"/><span>{t(autoStart?'setup.autostartOn':'setup.autostartOff')}</span></button></section>}<FoldersPanel root={installedRoot||(plan?.route==='managed'?plan.storagePath:defaults?.storagePath)} draft={installed?undefined:folderDraft} disabled={running||busy||folderPickerBusy} onChange={installed?setFolders:setFolderDraft}/>{installed&&(installedRoot||plan?.route==='managed')&&<div className="settings-runtime-grid"><StartupPanel root={installedRoot||(plan?.route==='managed'?plan.storagePath:'')} onRestart={()=>setRestartSignal(n=>n+1)}/><LlmPanel key={folders.models??''} root={installedRoot||(plan?.route==='managed'?plan.storagePath:'')}/></div>}</>}
  {view!=='comfy'&&<>{error&&<p className="aio-error" role="alert">{t(error)}</p>}{technicalError&&<p className="aio-error" role="alert">{t('setup.technicalError')}: {technicalError}</p>}</>}
  </div>
  {/* Kept mounted (hidden) after success so backend polling and the Studio handoff continue on other tabs. */}
  {(side||installed)&&<aside className="aio-right" hidden={!side}>
  {view==='setup'&&review&&<section className="aio-detail aio-auto-review" aria-label={t('setup.autoReview')}><h3>{t('setup.autoReview')}</h3><p className="aio-help">{t(reopening?'setup.reuseHelp':native?'setup.autoHelp':'setup.autoBrowser')}</p>
   <fieldset className="aio-auto-fields" disabled={running||busy||pickerBusy||folderPickerBusy}>
    <label htmlFor="auto-storage">{t('setup.storageDirectory')}</label><input id="auto-storage" value={state.values.storage??''} onChange={e=>{setStorageParent('');setError('');edit({type:'select',step:'storage',value:e.target.value},'storage');}}/>
    <button type="button" disabled={!native} onClick={()=>void pickDirectory()}>{t('setup.pickParent')}</button>{storageParent&&<p className="aio-help">{t('setup.selectedParent')}: <code>{storageParent}</code></p>}
    {!reopening&&<><details><summary>{t('settings.optional')}</summary><p className="field-help">{t('settings.draftHelp')}</p><FolderFields folders={folderDraft} onChange={setFolderDraft} disabled={running||busy||pickerBusy||folderPickerBusy} onBusyChange={setFolderPickerBusy}/></details>
    <label title={t('setup.capabilityHelp')}><input type="checkbox" checked={state.features.includes('director')} onChange={()=>edit({type:'feature',id:'director'},'features')}/>{t('setup.feature.director.label')}</label><span className="aio-fact-sub">{t('setup.feature.director.short')}</span></>}
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
    <button className="aio-confirm-button" title={t(reopening?'setup.reuseHelp':'setup.autoConsent')} disabled={(!planMatches&&!reopening)||running||busy||folderPickerBusy||!nativePlan.canExecute||nativePlan.unsupportedOptions.length>0} onClick={()=>void start()}>{t(reopening?'setup.useExisting':'setup.autoStart')}</button>
   </div>}
   <fieldset className="aio-auto-fields" disabled={running||busy||pickerBusy||folderPickerBusy}>
    {!reopening&&<details className="aio-advanced"><summary>{t('setup.advanced')}</summary>
     <label htmlFor="auto-backend">{t('setup.request.backend')}</label><select id="auto-backend" value={state.values.acceleration??''} onChange={e=>edit({type:'select',step:'acceleration',value:e.target.value},'acceleration')}><option value="">{t('setup.manualBackend')}</option>{['cpu','nvidia','amd','intel'].map(id=><option key={id} value={id}>{t(`setup.backend.${id}.label`)}</option>)}</select>
     {(Object.keys(state.options) as (keyof InstallOptions)[]).map(id=><label key={id}><input type="checkbox" checked={state.options[id]} onChange={e=>edit({type:'option',id,enabled:e.target.checked},'options')}/>{t(`setup.option.${id}`)}</label>)}
     <p className="aio-help">{t('setup.optionsHelp')}</p>
     <label htmlFor="auto-ref">{t('setup.comfyRef')}</label><input id="auto-ref" value={state.comfyRef} maxLength={120} onChange={e=>edit({type:'ref',value:e.target.value},'ref')}/>
     <label htmlFor="existing-url">{t('setup.step.backend.label')}</label><input id="existing-url" type="url" value={existingUrl} spellCheck={false} onChange={e=>{setExistingUrl(e.target.value);setError('');}}/><p className="aio-help">{t('setup.backendHelp')}</p>
     <button type="button" disabled={!existingUrl.trim()} onClick={()=>{if(validateBackend(existingUrl.trim()))connect(existingUrl.trim());else setError('setup.error.backend');}}>{t('setup.inspect')}</button>
    </details>}
   </fieldset>{busy&&<p className="aio-help" role="status">{t('setup.busy')}</p>}
  </section>}
  {installed&&<OwnedBackendPanel key={`${installedRoot||startedPlan.current?.request.storagePath}:${updates}`} installSucceeded autoStart={autoStart} onConnectExisting={onConnectExisting} onStatusChange={setBackendStatus} locked={running} restartSignal={restartSignal} actions={<>
   <button type="button" title={t('setup.upgradeHelp')} disabled={running||busy} onClick={()=>void update(false)}>{t('setup.upgrade')}</button>
   <button type="button" className="aio-danger" disabled={running||busy} onClick={()=>setConfirmReinstall(true)}>{t('setup.reinstall')}</button>
  </>}><button type="button" className="download-switch backend-autostart" role="switch" aria-label={t('setup.backendAutostart')} aria-checked={autoStart} onClick={()=>setAutoStart(v=>!v)}><span>{t('setup.backendAutostart')}</span><span className="download-switch-knob" aria-hidden="true"/><span>{t(autoStart?'setup.autostartOn':'setup.autostartOff')}</span></button></OwnedBackendPanel>}
  {confirmReinstall&&<div className="download-dialog" role="alertdialog" aria-modal="true" aria-labelledby="reinstall-title"><div className="download-dialog-card"><h3 id="reinstall-title">{t('setup.reinstallTitle')}</h3><p>{t('setup.reinstallWarning')}</p><div className="aio-actions"><button type="button" autoFocus onClick={()=>setConfirmReinstall(false)}>{t('setup.reinstallCancel')}</button><button type="button" className="aio-danger" onClick={()=>void update(true)}>{t('setup.reinstallConfirm')}</button></div></div></div>}
  </aside>}
  </div>
 </section>;
}
export default AiOSetup;
