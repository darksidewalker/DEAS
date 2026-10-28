import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { initialSetupState, setupPresentation, storageTarget, setupPlan, transitionSetup, validateBackend, type FeatureId, type InstallOptions, type NativeInstallPlan, type NativeInstallStatus, type NativeInstallDefaults, type NativeBackendStatus } from '../../lib/setup';
import './setup.css';
import { OpenComfyWorkflow, sendComfyWorkflow, type ComfyWorkflow } from '../../lib/comfyWorkflow';
import { OwnedBackendPanel } from './OwnedBackendPanel';
import { BackendPanels } from './BackendPanels';
import { llmSetupEvent } from '../../lib/llm';
import { RepoLinks } from './RepoLinks';
import { QuickSettings } from '../../features/studio/QuickSettings';
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
/** Keeps the studio/backend alive while top-level views change. */
export interface AiOSetupProps { /** `inspect` is true for the explicit Connect button, false for the owned backend's automatic handoff. */ onConnectExisting: (baseUrl: string, inspect?: boolean) => void; onInstalled?: (features: readonly FeatureId[]) => void; /** Installed environment root plus its saved folder settings, for the Studio media roots. */ onEnvironment?: (environment: { root: string; folders: Folders } | null) => void; studio?: ReactNode; footer?: ReactNode; studioTab?: 'generate'|'forge'|'chat'|'tve'|'map'; onStudioTab?: (tab:'generate'|'forge'|'chat'|'tve'|'map')=>void; onStudioActiveChange?: (active:boolean)=>void }
/** Automatic-only setup: folder + Director, the rest recommended; Start install is the single authorization. */
export function AiOSetup({ onConnectExisting, onInstalled, onEnvironment, studio, footer, studioTab='generate', onStudioTab, onStudioActiveChange }: AiOSetupProps) {
 const {t}=useI18n();
 const native=isTauri();
 const [verified,setVerified]=useState<string[]>([]);
 const [configured,setConfigured]=useState<string[]>([]);const [authRevision,setAuthRevision]=useState(0);
 const [autoStart,setAutoStart]=usePref('backend.autostart',true,isBoolean);
 const [state,setState]=useState(()=>transitionSetup(initialSetupState(),{type:'automatic'}));
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
 const [takeoverOn,setTakeoverOn]=useState(false);const [takeoverPath,setTakeoverPath]=useState('');const [confirmTakeover,setConfirmTakeover]=useState(false);
 const plan=setupPlan(state);
 const signature=JSON.stringify([plan,folderDraft,takeoverOn,takeoverPath]);
 const planMatches=(['models','input','output'] as const).every(key=>nativePlan?.request.folders?.[key]===folderDraft[key])&&!!nativePlan&&plan?.route==='managed'&&nativePlan.request.storagePath===(takeoverOn&&takeoverPath?takeoverPath:plan.storagePath)&&(nativePlan.request.takeover??false)===takeoverOn&&nativePlan.request.backend===plan.backend&&nativePlan.request.comfyRef===plan.comfyRef&&JSON.stringify(nativePlan.request.features)===JSON.stringify(plan.features)&& (Object.keys(plan.options) as (keyof InstallOptions)[]).every(id=>nativePlan.request.options?.[id]===plan.options[id]);
 const [view,setView]=useState<'studio'|'downloads'|'comfy'|'backend'|'logs'>('backend');
 // Invalidate retained Studio work in the visibility commit, before deferred reads can redirect.
 useLayoutEffect(()=>{onStudioActiveChange?.(view==='studio');},[view,onStudioActiveChange]);
 const [llmSetupRequest,setLlmSetupRequest]=useState(0);
 useEffect(()=>{const open=()=>{setLlmSetupRequest(n=>n+1);setView('backend');};window.addEventListener(llmSetupEvent,open);return()=>window.removeEventListener(llmSetupEvent,open);},[]);
 const [backendStatus,setBackendStatus]=useState<NativeBackendStatus|null>(null);
 const [backendStartedNotice,setBackendStartedNotice]=useState(false);
 useEffect(()=>{
  setBackendStartedNotice(backendStatus?.state==='running');
  if(backendStatus?.state!=='running')return;
  const timer=window.setTimeout(()=>setBackendStartedNotice(false),3000);
  return()=>window.clearTimeout(timer);
 },[backendStatus?.state]);
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
 const [available,setAvailable]=useState<{app:string|null;comfy:boolean;nodepack:boolean}|null>(null);
 const [confirmUpgrade,setConfirmUpgrade]=useState(false);
 const [appReplaced,setAppReplaced]=useState(false);
 useEffect(()=>{if(!native)return;let alive=true;invoke<typeof available>('native_update_check').then(value=>{if(alive)setAvailable(value);},()=>{});return()=>{alive=false;};},[native]);
 const pending=available?[available.app&&`DEAS ${available.app}`,available.comfy&&'ComfyUI',available.nodepack&&t('app.updateNodes')].filter(Boolean):[];
 const updateHint=pending.length?t('app.update',{list:pending.join(' · ')}):'';
 const inBackend=view==='backend';
 useEffect(()=>{if(!native)return;let alive=true;
  readAuthStatus().then(list=>{
   if(!alive)return null;
   const ids=list.filter(m=>m.configured).map(m=>m.providerId);setConfigured(ids);setVerified(old=>old.filter(id=>ids.includes(id)));
   return inBackend?null:Promise.all(ids.map(id=>verifyAuthToken(id).catch(()=>null)));
  }).then(checks=>{if(alive&&checks)setVerified(checks.filter(c=>c?.status==='verified').map(c=>c!.providerId));},()=>{});
  return()=>{alive=false;};},[native,inBackend,authRevision]);
 const [restartSignal,setRestartSignal]=useState(0);
 const [installedRoot,setInstalledRoot]=useState('');const installed=succeeded||!!installedRoot;
 useEffect(()=>{onEnvironment?.(installedRoot?{root:installedRoot,folders}:null);},[installedRoot,folders,onEnvironment]);
 const review=state.opened&&!installed;const side=inBackend&&(review||installed);
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
   setInstalledRoot(result.plan.request.storagePath);setStatus(result.status);setFolders(result.folders);setView(v=>v==='backend'?'studio':v);
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
 const pickTakeover=async()=>{
  if(!native||running||busy||folderPickerBusy||pickerLock.current)return;
  pickerLock.current=true;setPickerBusy(true);setTechnicalError('');
  try {
   const dir=await invoke<string|null>('native_pick_directory',{title:t('setup.takeover.pickTitle')});
   if(dir!==null){const flags=await filesPresent([`${dir}/ComfyUI/main.py`,`${dir}/deas-plan.json`]);if(Array.isArray(flags)&&flags[0]&&!flags[1]){setTakeoverPath(dir);setNativePlan(null);}else setTechnicalError(flags[1]?t('setup.takeover.managedError'):t('setup.takeover.mainpyError'));}
  }catch(e){setTechnicalError(String(e));}
  finally{pickerLock.current=false;setPickerBusy(false);}
 };
 const prepare=async()=>{
  if(!native||operationLock.current||busy||running||pickerBusy||folderPickerBusy||error||plan?.route!=='managed')return;
  operationLock.current=true;
  const version=generation.current;
  setBusy(true);setNativePlan(null);setTechnicalError('');setStatus(null);
  const {storagePath,backend,features,options,comfyRef}=plan;
  try{const result=await invoke<NativeInstallPlan>('native_install_plan',{request:{storagePath:takeoverOn&&takeoverPath?takeoverPath:storagePath,backend,features,options,comfyRef,...(takeoverOn?{takeover:true}:{}),...(Object.keys(folderDraft).length?{folders:folderDraft}:{})}});if(version===generation.current)setNativePlan(result);}
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
  setConfirmReinstall(false);setConfirmUpgrade(false);
  if(!native||operationLock.current||busy||running)return;
  operationLock.current=true;setBusy(true);setTechnicalError('');
  try{
   if(!reinstall){const replaced=await invoke<boolean>('native_app_update',{confirmed:true});if(replaced){setAppReplaced(true);setAvailable(old=>old?{...old,app:null}:old);}}
   if(reinstall||installed){const next=await invoke<NativeInstallStatus>('native_install_update',{reinstall,confirmed:true});updating.current=true;setStatus(next);}
  }
  catch(e){setTechnicalError(String(e));}
  finally{operationLock.current=false;setBusy(false);}
 };
 useEffect(()=>{if(updating.current&&status&&status.state!=='running'){updating.current=false;if(status.state==='succeeded'&&!appReplaced)setUpdates(n=>n+1);}},[status,appReplaced]);
 useEffect(()=>{
  if(!appReplaced||busy||running||(installed&&status?.state!=='succeeded'))return;
  let active=true,inflight=false,requested=false;
  const restart=async()=>{
   if(inflight||requested||!window.dispatchEvent(new Event('deas:before-update-restart',{cancelable:true})))return;
   inflight=true;
   try{requested=await invoke<boolean>('native_app_restart');}
   catch(e){if(active){setTechnicalError(String(e));requested=true;}}
   finally{inflight=false;}
  };
  void restart();const timer=window.setInterval(()=>void restart(),1000);
  return()=>{active=false;window.clearInterval(timer);};
 },[appReplaced,busy,running,installed,status?.state]);
 const cancel=async()=>{
  if(!native||!running||busy)return;setBusy(true);
  try{await invoke('native_install_cancel');setStatus(await invoke<NativeInstallStatus>('native_install_status'));}
  catch(e){setTechnicalError(String(e));}finally{setBusy(false);}
 };
 return <section className={`aio-setup${view==='comfy'?' is-comfy':''}${inBackend?' is-backend':''}`} aria-label={t('setup.region')} data-workspace-view={view}>
  <div className="aio-topbar">  <div className="aio-tabs" role="tablist" aria-label={t('setup.decisions')}>
   <button type="button" role="tab" data-node="studio" className="aio-tab" disabled={folderPickerBusy} data-studio-tab="generate" aria-selected={view==='studio'&&studioTab==='generate'} onClick={()=>{onStudioTab?.('generate');setView('studio');}}>{t('setup.tab.studio')}</button>
   <button type="button" role="tab" data-node="optional-downloads" className="aio-tab" disabled={folderPickerBusy} aria-selected={view==='downloads'} onClick={()=>setView('downloads')}>{t('downloads.title')}</button>
   <button type="button" role="tab" data-studio-tab="forge" className="aio-tab" disabled={folderPickerBusy} aria-selected={view==='studio'&&studioTab==='forge'} onClick={()=>{onStudioTab?.('forge');setView('studio');window.dispatchEvent(new Event('deas:forge-open'));}}>{t('studio.tab.forge')}</button>
   <button type="button" role="tab" data-studio-tab="chat" className="aio-tab" disabled={folderPickerBusy} aria-selected={view==='studio'&&studioTab==='chat'} onClick={()=>{onStudioTab?.('chat');setView('studio');window.dispatchEvent(new Event('deas:forge-open'));}}>{t('studio.tab.chat')}</button>
   <button type="button" role="tab" data-studio-tab="tve" className="aio-tab" title={t('studio.tve.title')} disabled={folderPickerBusy} aria-selected={view==='studio'&&studioTab==='tve'} onClick={()=>{onStudioTab?.('tve');setView('studio');}}>{t('studio.tab.tve')}</button>
   <button type="button" role="tab" data-studio-tab="map" className="aio-tab" disabled={folderPickerBusy} aria-selected={view==='studio'&&studioTab==='map'} onClick={()=>{onStudioTab?.('map');setView('studio');}}>{t('studio.tab.map')}</button>
   <button type="button" role="tab" data-node="comfy" className="aio-tab" disabled={folderPickerBusy} aria-selected={view==='comfy'} onClick={()=>setView('comfy')}>{t('setup.tab.comfy')}</button>
   <button type="button" role="tab" data-node="settings" className="aio-tab" disabled={folderPickerBusy} aria-selected={inBackend} onClick={()=>setView('backend')}>{t('settings.button')}</button>
   <button type="button" role="tab" data-node="logs" className="aio-tab" disabled={folderPickerBusy} aria-selected={view==='logs'} onClick={()=>setView('logs')}>{t('logs.title')}</button>
  </div>
<QuickSettings/><RepoLinks canStar={verified.includes('github')}/></div>
  {inBackend&&<div className="backend-overview" aria-label={t('setup.overview')}>
   <span data-backend-installed className={installed?'is-set':undefined}>{installed&&<span aria-hidden="true">✓ </span>}{t('setup.backendLifecycle.title')} · <span>{t(installed?'setup.tab.installed':'setup.overview.missing')}</span>{(backendStatus?.state==='starting'||backendStatus?.state==='running')&&<small data-backend-state> · {t(backendStatus.state==='running'?'setup.backendStarted':'setup.backendStarting')}</small>}</span>
   {authProviders.filter(p=>configured.includes(p.id)).map(p=><span key={p.id} className="is-set" title={t('downloads.auth.set')} data-provider-configured={p.id}><span aria-hidden="true">✓ </span>{p.label} · {t('downloads.auth.set')}</span>)}
  </div>}
  {view!=='comfy'&&detectionError&&<p className="aio-error" role="alert">{t('setup.detectionError')}: {detectionError}</p>}
  <div className={`aio-decision-area${side?'':' is-single'}`}>
  <div className="aio-left">
  {comfyVisited.current&&<div className="comfy-view" hidden={view!=='comfy'}>{(!comfyEndpoint||!comfyLoaded)&&<div className="comfy-loading" role="status"><span className="aio-spinner" aria-hidden="true"/>{t(comfyEndpoint?'setup.comfy.loading':'setup.comfy.waiting')}</div>}{comfyEndpoint&&<iframe ref={comfyFrame} title={t('setup.comfy.title')} src={comfyEndpoint} onLoad={()=>setComfyLoaded(true)} sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox" allow="clipboard-read; clipboard-write; fullscreen"/>}</div>}
  {status&&status.state!=='succeeded'&&view!=='comfy'&&(running||inBackend)&&<section className="aio-detail aio-status" aria-label={t('setup.installStatus')}><h3>{t('setup.installStatus')}</h3><p role="status">{running&&<span className="aio-spinner" aria-hidden="true"/>}{t(`setup.execution.${status.state}`)}{status.stepId&&` · ${status.stepId}`}</p>{status.logs.length>0&&<p className="aio-help aio-last-log">{status.logs[status.logs.length-1]}</p>}{status.error&&<p role="alert">{t('setup.technicalError')}: {status.error}</p>}{running&&<button disabled={busy} onClick={()=>void cancel()}>{t('setup.cancel')}</button>}</section>}
  {/* Once opened, the Studio stays mounted (hidden) so its panels keep their state across tab switches. */}
  {studioVisited.current&&<div className="aio-studio-host" hidden={view!=='studio'}><OpenComfyWorkflow.Provider value={comfyEndpoint?openWorkflow:null}>{studio}</OpenComfyWorkflow.Provider></div>}
  {inBackend&&!succeeded&&installedRoot&&<p className="aio-help aio-detection" role="status">{t('setup.remembered',{path:installedRoot})}</p>}
  {inBackend&&review&&defaults&&!status&&<div className="aio-help aio-detection" role="status"><p>{t(defaults.backend==='nvidia'?'setup.detectedNvidia':'setup.cpuRecommendation')}</p><p>{t('setup.autoFindings')}</p>{typeof defaults.hardware?.name==='string'&&<p>{String(defaults.hardware.name)}</p>}{defaults.warnings.length>0&&<ul>{defaults.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>}</div>}
  {view==='logs'&&<LogsPanel/>}
  {inBackend&&<LanguageSetting/>}
  {inBackend&&!installed&&<button type="button" disabled={!native||running||busy} onClick={()=>setConfirmUpgrade(true)}>{t('setup.upgrade')}</button>}
  {appReplaced&&<p role="status">{t('setup.updateRestart')}</p>}
  {inBackend&&<>{!installed&&<section className="aio-detail"><button type="button" className="download-switch backend-autostart" role="switch" aria-label={t('setup.backendAutostart')} aria-checked={autoStart} onClick={()=>setAutoStart(v=>!v)}><span>{t('setup.backendAutostart')}</span><span className="download-switch-knob" aria-hidden="true"/><span>{t(autoStart?'setup.autostartOn':'setup.autostartOff')}</span></button></section>}{installedRoot&&<FoldersPanel root={installedRoot} disabled={running||busy||folderPickerBusy} onChange={setFolders}/>}</>}
  <div hidden={!inBackend}><BackendPanels llmSetupRequest={llmSetupRequest} root={installedRoot} modelsDir={folders.models} onRestart={()=>setRestartSignal(n=>n+1)} onAuthChange={()=>{setConfigured([]);setVerified([]);setAuthRevision(n=>n+1);}}/></div>
  <DownloadWorkspace view={view==='downloads'?'downloads':null} authRevision={authRevision} installTarget={installedRoot||(plan?.route==='managed'?plan.storagePath:undefined)} modelsDir={installed?folders.models:folderDraft.models}/>
  {view!=='comfy'&&<>{error&&<p className="aio-error" role="alert">{t(error)}</p>}{technicalError&&<p className="aio-error" role="alert">{t('setup.technicalError')}: {technicalError}</p>}</>}
  </div>
  {/* Kept mounted (hidden) after success so backend polling and the Studio handoff continue on other tabs. */}
  {(side||installed)&&<aside className="aio-right" hidden={!side}>
  {inBackend&&review&&<section className="aio-detail aio-auto-review" aria-label={t('setup.autoReview')}><h3>{t('setup.autoReview')}</h3><p className="aio-help">{t(reopening?'setup.reuseHelp':native?'setup.autoHelp':'setup.autoBrowser')}</p>
   <fieldset className="aio-auto-fields" disabled={running||busy||pickerBusy||folderPickerBusy}>
    {!takeoverOn&&<><label htmlFor="auto-storage">{t('setup.storageDirectory')}</label><input id="auto-storage" value={state.values.storage??''} onChange={e=>{setStorageParent('');setError('');edit({type:'select',step:'storage',value:e.target.value},'storage');}}/></>}
    <div className="aio-row">
     <button type="button" disabled={!native||takeoverOn} onClick={()=>void pickDirectory()}>{t('setup.pickParent')}</button>
     {!reopening&&<button type="button" className="action-button" aria-pressed={takeoverOn} title={t('setup.takeover.help')} onClick={()=>{setTakeoverOn(v=>!v);setNativePlan(null);setTechnicalError('');setTakeoverPath('');}}>{t('setup.takeover.label')}</button>}
    </div>
    {storageParent&&!takeoverOn&&<p className="aio-help">{t('setup.selectedParent')}: <code>{storageParent}</code></p>}
    {takeoverOn&&<><p className="aio-help">{t('setup.takeover.warning')}</p><label htmlFor="auto-takeover">{t('setup.takeover.directory')}</label><div className="aio-row"><input id="auto-takeover" value={takeoverPath} spellCheck={false} onChange={e=>{setTakeoverPath(e.target.value);setNativePlan(null);setTechnicalError('');}}/><button type="button" disabled={!native} onClick={()=>void pickTakeover()}>{t('setup.takeover.pick')}</button></div><p className="aio-help">{t('setup.takeover.help')}</p></>}
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
    <button className="aio-confirm-button" title={t(reopening?'setup.reuseHelp':'setup.autoConsent')} disabled={(!planMatches&&!reopening)||running||busy||folderPickerBusy||!nativePlan.canExecute||nativePlan.unsupportedOptions.length>0} onClick={()=>{if(takeoverOn&&takeoverPath&&planMatches&&nativePlan.canExecute)setConfirmTakeover(true);else void start();}}>{t(reopening?'setup.useExisting':takeoverOn&&takeoverPath?'setup.takeover.start':'setup.autoStart')}</button>
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
   <button type="button" title={t('setup.updateWarning')} disabled={running||busy} onClick={()=>setConfirmUpgrade(true)}>{t('setup.upgrade')}</button>
   <button type="button" className="aio-danger" disabled={running||busy} onClick={()=>setConfirmReinstall(true)}>{t('setup.reinstall')}</button>
  </>}><button type="button" className="download-switch backend-autostart" role="switch" aria-label={t('setup.backendAutostart')} aria-checked={autoStart} onClick={()=>setAutoStart(v=>!v)}><span>{t('setup.backendAutostart')}</span><span className="download-switch-knob" aria-hidden="true"/><span>{t(autoStart?'setup.autostartOn':'setup.autostartOff')}</span></button></OwnedBackendPanel>}
  {confirmReinstall&&<div className="download-dialog" role="alertdialog" aria-modal="true" aria-labelledby="reinstall-title"><div className="download-dialog-card"><h3 id="reinstall-title">{t('setup.reinstallTitle')}</h3><p>{t('setup.reinstallWarning')}</p><div className="aio-actions"><button type="button" autoFocus onClick={()=>setConfirmReinstall(false)}>{t('setup.reinstallCancel')}</button><button type="button" className="aio-danger" onClick={()=>void update(true)}>{t('setup.reinstallConfirm')}</button></div></div></div>}
  {confirmTakeover&&<div className="download-dialog" role="alertdialog" aria-modal="true" aria-labelledby="takeover-title"><div className="download-dialog-card"><h3 id="takeover-title">{t('setup.takeover.title')}</h3><p>{t('setup.takeover.warning')}</p><p><code>{takeoverPath}</code></p><div className="aio-actions"><button type="button" autoFocus onClick={()=>setConfirmTakeover(false)}>{t('setup.takeover.cancel')}</button><button type="button" className="aio-danger" onClick={()=>{setConfirmTakeover(false);void start();}}>{t('setup.takeover.confirm')}</button></div></div></div>}
  </aside>}
  </div>
  {confirmUpgrade&&<div className="download-dialog" role="alertdialog" aria-modal="true" aria-labelledby="upgrade-title" onKeyDown={e=>{if(e.key==='Escape')setConfirmUpgrade(false);}}><div className="download-dialog-card"><h3 id="upgrade-title">{t('setup.updateTitle')}</h3><p>{t(installed?'setup.updateWarning':'setup.updateAppWarning')}</p><div className="aio-actions"><button type="button" autoFocus onClick={()=>setConfirmUpgrade(false)}>{t('setup.reinstallCancel')}</button><button type="button" disabled={!native||running||busy} onClick={()=>void update(false)}>{t('setup.updateConfirm')}</button></div></div></div>}
  <footer className="footer">
   {(backendStatus?.state==='starting'||(backendStartedNotice&&backendStatus?.state==='running'))&&<span data-backend-notice role="status" className={`footer-backend${backendStatus.state==='running'?' is-ready':''}`}>
    {backendStatus.state==='starting'?t('setup.footer.starting'):<><span aria-hidden="true">✓ </span><span>{t('setup.footer.started')}</span></>}
   </span>}{footer??<button type="button" className={`footer-version${updateHint?' is-update':''}`} title={updateHint||t('setup.updateTitle')} onClick={()=>{setView('backend');setConfirmUpgrade(true);}}>{`${t('app.brand')} v${__APP_VERSION__}`}{updateHint&&<span aria-hidden="true"> ↑</span>}</button>}
  </footer>
 </section>;
}
export default AiOSetup;
