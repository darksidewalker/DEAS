import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { NeuralGraph } from '../neural/NeuralGraph';
import { SETUP_DRAFT_KEY, initialSetupState, restoreSetup, serializeSetup, setupPresentation, preselectDetectedSetup, storageTarget, setupPlan, setupSteps, transitionSetup, visibleSetupSteps, type Motion, type StepId, type FeatureId, type InstallOptions, type NativeInstallPlan, type NativeInstallStatus, type SetupMetadata, type NativeHardwareDetection, type NativeInstallDefaults } from '../../lib/setup';
import './setup.css';
import { OwnedBackendPanel } from './OwnedBackendPanel';
import { DownloadWorkspace } from '../../features/downloads/DownloadWorkspace';
export interface AiOSetupProps { onConnectExisting: (baseUrl: string) => void }
export function AiOSetup({ onConnectExisting }: AiOSetupProps) {
 const {t}=useI18n();
 const native=isTauri();
 const [state,setState]=useState(initialSetupState);
 const [focusedStep,setFocusedStep]=useState<StepId|null>(null);
 const [downloadsOpen,setDownloadsOpen]=useState(false);
 const [draftInput,setDraftInput]=useState('');
 const [error,setError]=useState('');
 const [pickerBusy,setPickerBusy]=useState(false);
 const pickerLock=useRef(false);
 const [storageParent,setStorageParent]=useState('');
 const [storageChild,setStorageChild]=useState('deas-environment');
 const [technicalError,setTechnicalError]=useState('');
 const [notice,setNotice]=useState('');
 const [hasSaved,setHasSaved]=useState(()=>{try{return !!localStorage.getItem(SETUP_DRAFT_KEY);}catch{return false;}});
 const [nativePlan,setNativePlan]=useState<NativeInstallPlan|null>(null);
 const [defaults,setDefaults]=useState<NativeInstallDefaults|null>(null);
 const defaultsRequest=useRef<Promise<NativeInstallDefaults>|null>(null);
 const touched=useRef(new Set<string>());
 const operationLock=useRef(false);
 const [confirmed,setConfirmed]=useState(false);
 const [busy,setBusy]=useState(false);
 const [status,setStatus]=useState<NativeInstallStatus|null>(null);
 const [detection,setDetection]=useState<NativeHardwareDetection|null>(null);
 const [detectionError,setDetectionError]=useState('');
 const detectionRequest=useRef<Promise<NativeHardwareDetection>|null>(null);
 const explicitBackend=useRef(false);
 const detectionMetadata=useMemo<SetupMetadata>(()=>detection?.backend==='nvidia'?{choices:{'setup:acceleration:nvidia':{detected:true,suggested:true}}}:{},[detection]);
 const inputRef=useRef<HTMLInputElement>(null);
 const generation=useRef(0);
 const running=status?.state==='running';
 const automatic=state.mode==='automatic';
 const defaultsLocked=useRef(false);
 defaultsLocked.current=!!nativePlan||busy||running||pickerBusy;
 const edit=(event:Parameters<typeof transitionSetup>[1],field:string)=>{if(operationLock.current||running||pickerLock.current)return;touched.current.add(field);setState(s=>transitionSetup(s,event));};
 const visible=visibleSetupSteps(state);
 const step=focusedStep&&visible.includes(focusedStep)?focusedStep:visible.at(-1)??null;
 const definition=step?setupSteps[step]:null;
 const plan=setupPlan(state);
 const signature=JSON.stringify(plan);
 const planMatches=!!nativePlan&&plan?.route==='managed'&&nativePlan.request.storagePath===plan.storagePath&&nativePlan.request.backend===plan.backend&&nativePlan.request.comfyRef===plan.comfyRef&&JSON.stringify(nativePlan.request.features)===JSON.stringify(plan.features)&& (Object.keys(plan.options) as (keyof InstallOptions)[]).every(id=>nativePlan.request.options?.[id]===plan.options[id]);
 const presentation=useMemo(()=>{
  const view=setupPresentation(state,step,detectionMetadata);
  const translateIncluded=(items?: {id:string;label:string}[])=>items?.map(item=>({...item,label:t(item.label)}));
  const translate=(n: typeof view.nodes[number])=>({...n,included:translateIncluded(n.included),label:t(n.label),description:n.description?t(n.description):undefined,status:n.status&&/^setup\./.test(n.status)?t(n.status,{count:state.features.length}):n.status,disabled:running||busy||pickerBusy,choices:n.choices?.map(choice=>({...choice,included:translateIncluded(choice.included),label:t(choice.label),description:choice.description?t(choice.description):undefined,disabled:running||busy||pickerBusy}))});
  return {nodes:(automatic?view.nodes.filter(n=>n.id==='setup:aio'):view.nodes).map(translate),history:automatic?[]:view.history.map(translate)};
 },[state,step,t,running,busy,pickerBusy,detectionMetadata,automatic]);
 // One read-only request per mounted setup, also reused by StrictMode effect replay.
 useEffect(()=>{
  if(!native||!state.opened||automatic) return;
  let alive=true;
  detectionRequest.current??=invoke<NativeHardwareDetection>('native_detect_hardware',{});
  void detectionRequest.current.then(result=>{if(alive&&result&&typeof result==='object'&&(result.backend===null||result.backend==='nvidia'))setDetection(result);},e=>{if(alive)setDetectionError(String(e));});
  return ()=>{alive=false;};
 },[native,state.opened,automatic]);
 useEffect(()=>{
  if(!native||!state.opened||!automatic)return;
  let alive=true;
  defaultsRequest.current??=invoke<NativeInstallDefaults>('native_install_defaults',{});
  void defaultsRequest.current.then(result=>{
   if(!alive)return;
   if(!result||typeof result.storagePath!=='string'||!['cpu','nvidia'].includes(result.backend)||!Array.isArray(result.warnings)){setDetectionError(t('setup.defaultsInvalid'));return;}
   setDefaults(result);
   setState(s=>{
    if(s.mode!=='automatic'||defaultsLocked.current||touched.current.has('restore'))return s;
    return {...s,values:{...s.values,...(!touched.current.has('storage')&&!s.values.storage?{storage:result.storagePath}:{}),...(!touched.current.has('acceleration')&&!s.values.acceleration?{acceleration:result.backend}:{})}};
   });
  },e=>{if(alive)setDetectionError(String(e));});
  return ()=>{alive=false;};
 },[native,state.opened,automatic,t]);
 useEffect(()=>{
  if(!detection||explicitBackend.current||nativePlan||busy||running||pickerBusy) return;
  setState(s=>preselectDetectedSetup(s,detectionMetadata,{locked:explicitBackend.current,explicitChoices:explicitBackend.current?['setup:acceleration']:[]}));
 },[detection,detectionMetadata,state,nativePlan,busy,running,pickerBusy]);
 useEffect(()=>{generation.current++;setNativePlan(null);setConfirmed(false);setTechnicalError('');},[signature]);
 useEffect(()=>{if(definition?.kind==='input'){setDraftInput(state.values[step!]??'');inputRef.current?.focus();}},[step,definition?.kind]);
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
 const clear=()=>{setError('');setNotice('');};
 const select=(id:string)=>{
  if(running||busy||pickerLock.current) return;
  clear();
  if(id==='setup:aio'){setState(s=>transitionSetup(s,{type:s.opened?'open':'automatic'}));setFocusedStep(null);return;}
  const [,rawStep,option]=id.split(':');if(!(rawStep in setupSteps))return;
  const chosenStep=rawStep as StepId;
  if(option&&chosenStep==='acceleration')explicitBackend.current=true;
  if(option){setState(s=>transitionSetup(s,chosenStep==='pack'?{type:'feature',id:option as FeatureId}:{type:'select',step:chosenStep,value:option}));setFocusedStep(chosenStep);setDraftInput('');}
  else {setFocusedStep(chosenStep);setDraftInput(state.values[chosenStep]??'');setStorageParent('');}
 };
 const pickDirectory=async()=>{
  if(!native||running||busy||pickerLock.current)return;
  pickerLock.current=true;setPickerBusy(true);setTechnicalError('');
  try {
   const parent=await invoke<string|null>('native_pick_directory',{title:t('setup.pickTitle')});
   if(parent!==null){touched.current.add('storage');const target=storageTarget(parent,storageChild);setStorageParent(parent);if(target){setDraftInput(target);setState(s=>transitionSetup(s,{type:'select',step:'storage',value:target}));setError('');}else setError('setup.error.child');}
  }catch(e){setTechnicalError(String(e));}
  finally{pickerLock.current=false;setPickerBusy(false);}
 };
 const confirmStep=()=>{
  if(!step||running||busy||pickerLock.current)return;
  const next=transitionSetup(state,{type:'confirm',step});
  setState(next);setFocusedStep(visibleSetupSteps(next)[visibleSetupSteps(next).indexOf(step)+1]??null);clear();
 };
 const confirmInput=()=>{
  if(pickerLock.current||running||busy)return;
  if(!step||!definition?.validate)return;
  if(step==='storage'&&storageParent&&!storageTarget(storageParent,storageChild)){setError('setup.error.child');return;}
  if(!definition.validate(draftInput)){setError(step==='backend'?'setup.error.backend':'setup.error.storage');return;}
  const next=transitionSetup(transitionSetup(state,{type:'select',step,value:draftInput}),{type:'confirm',step});
  setState(next);setFocusedStep(visibleSetupSteps(next)[visibleSetupSteps(next).indexOf(step)+1]??null);setDraftInput('');clear();
 };
 const save=()=>{try{localStorage.setItem(SETUP_DRAFT_KEY,serializeSetup(state));setHasSaved(true);setNotice('setup.notice.saved');}catch{setError('setup.error.save');}};
 const restore=()=>{
  try{const saved=restoreSetup(localStorage.getItem(SETUP_DRAFT_KEY)??'');if(!saved){setError('setup.error.invalidDraft');return;}
   touched.current.add('restore');
   if(saved.values.acceleration)explicitBackend.current=true;
   setState(saved);setFocusedStep(null);setDraftInput('');setStatus(null);setError('');setNotice('setup.notice.restored');
  }catch{setError('setup.error.restore');}
 };
 const exportPlan=()=>{
  if(!plan)return;const url=URL.createObjectURL(new Blob([JSON.stringify(plan,null,2)],{type:'application/json'}));const a=document.createElement('a');
  a.href=url;a.download='deas-setup-plan-v2.json';document.body.append(a);a.click();a.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice('setup.notice.exported');
 };
 const prepare=async()=>{
  if(!native||operationLock.current||busy||running||pickerBusy||error||plan?.route!=='managed')return;
  operationLock.current=true;
  const version=generation.current;
  setBusy(true);setNativePlan(null);setConfirmed(false);setTechnicalError('');setStatus(null);
  const {storagePath,backend,features,options,comfyRef}=plan;
  try{const result=await invoke<NativeInstallPlan>('native_install_plan',{request:{storagePath,backend,features,options,comfyRef}});if(version===generation.current)setNativePlan(result);}
  catch(e){if(version===generation.current)setTechnicalError(String(e));}
  finally{operationLock.current=false;setBusy(false);}
 };
 const start=async()=>{
  if(!native||operationLock.current||busy||running||(!automatic&&!confirmed)||!nativePlan?.canExecute||nativePlan.unsupportedOptions.length||plan?.route!=='managed')return;
  if(!planMatches)return;
  operationLock.current=true;
  setBusy(true);setTechnicalError('');
  try{const next=await invoke<NativeInstallStatus>('native_install_start',{planId:nativePlan.id,confirmed:true});setConfirmed(false);setStatus(next);}
  catch(e){setTechnicalError(String(e));}
  finally{operationLock.current=false;setBusy(false);}
 };
 const cancel=async()=>{
  if(!native||!running||busy)return;setBusy(true);
  try{await invoke('native_install_cancel');setStatus(await invoke<NativeInstallStatus>('native_install_status'));}
  catch(e){setTechnicalError(String(e));}finally{setBusy(false);}
 };
 return <section className="aio-setup" aria-label={t('setup.region')}>
  <header className="aio-setup-header"><p className="aio-setup-eyebrow">{t('setup.eyebrow')}</p>
   <fieldset className="aio-motion" disabled={running||busy||pickerBusy}><legend>{t('setup.motion')}</legend>{(['light','paws','off'] as Motion[]).map(m=><label key={m}><input type="radio" name="setup-motion" checked={state.motion===m} onChange={()=>setState(s=>transitionSetup(s,{type:'motion',motion:m}))}/>{t(`setup.motion.${m}`)}</label>)}</fieldset>
  </header>
  {automatic&&defaults&&!status&&<div className="aio-help" role="status"><p>{t(defaults.backend==='nvidia'?'setup.detectedNvidia':'setup.cpuRecommendation')}</p><p>{t('setup.autoFindings')}</p>{typeof defaults.hardware?.name==='string'&&<p>{String(defaults.hardware.name)}</p>}{defaults.warnings.length>0&&<ul>{defaults.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>}</div>}
  {native&&detection&&<div className="aio-help" role="status">{detection.backend==='nvidia'&&<p>{t('setup.detectedNvidia')}</p>}<p>{t('setup.detectionReadOnly')}</p>{detection.warnings?.length? <ul>{detection.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul>:null}</div>}
  {detectionError&&<p className="aio-error" role="alert">{t('setup.detectionError')}: {detectionError}</p>}
  <div className="aio-decision-area">
  <NeuralGraph nodes={presentation.nodes} history={presentation.history} motion={state.motion} onSelect={select} label={t('setup.decisions')}/>
  {automatic&&<section className="aio-detail aio-auto-review" aria-label={t('setup.autoReview')}><h3>{t('setup.autoReview')}</h3><p className="aio-help">{t(native?'setup.autoHelp':'setup.autoBrowser')}</p>
   <fieldset className="aio-auto-fields" disabled={running||busy||pickerBusy}>
    <label htmlFor="auto-storage">{t('setup.storageDirectory')}</label><input id="auto-storage" value={state.values.storage??''} onChange={e=>{setStorageParent('');setError('');edit({type:'select',step:'storage',value:e.target.value},'storage');}}/>
    <button type="button" disabled={!native} onClick={()=>void pickDirectory()}>{t('setup.pickParent')}</button>
    <label htmlFor="auto-backend">{t('setup.request.backend')}</label><select id="auto-backend" value={state.values.acceleration??''} onChange={e=>edit({type:'select',step:'acceleration',value:e.target.value},'acceleration')}><option value="">{t('setup.manualBackend')}</option>{['cpu','nvidia','amd','intel'].map(id=><option key={id} value={id}>{t(`setup.backend.${id}.label`)}</option>)}</select>
    <label><input type="checkbox" checked={state.features.includes('director')} onChange={()=>edit({type:'feature',id:'director'},'features')}/>{t('setup.feature.director.label')}</label><p className="aio-help">{t('setup.capabilityHelp')}</p>
    {(Object.keys(state.options) as (keyof InstallOptions)[]).map(id=><label key={id}><input type="checkbox" checked={state.options[id]} onChange={e=>edit({type:'option',id,enabled:e.target.checked},'options')}/>{t(`setup.option.${id}`)}</label>)}
    <label htmlFor="auto-ref">{t('setup.comfyRef')}</label><input id="auto-ref" value={state.comfyRef} maxLength={120} onChange={e=>edit({type:'ref',value:e.target.value},'ref')}/>
   </fieldset><p className="aio-help">{t('setup.optionsHelp')}</p><p className="aio-help">{t('setup.autoConsent')}</p>
   <div className="aio-actions"><button disabled={!native||!plan||running||busy||pickerBusy} onClick={()=>void prepare()}>{t(busy?'setup.busy':'setup.prepare')}</button><button data-setup-mode="guided" disabled={running||busy||pickerBusy} onClick={()=>{touched.current.add('restore');setState(s=>({...initialSetupState(),opened:true,motion:s.motion}));setFocusedStep(null);}}>{t('setup.manualMode')}</button><button disabled={running||busy||pickerBusy} onClick={()=>{touched.current.add('restore');setState(s=>transitionSetup(transitionSetup({...initialSetupState(),opened:true,motion:s.motion},{type:'select',step:'route',value:'existing'}),{type:'confirm',step:'route'}));setFocusedStep(null);}}>{t('setup.route.existing.label')}</button></div>
  </section>}
  {!automatic&&definition&&<section className={`aio-detail${definition.kind==='multi'?' is-multi-action':''}`} aria-label={t(definition.label)}>{definition.kind!=='multi'&&<h3>{t(definition.label)}</h3>}
   {definition.kind==='choice'&&<p className="aio-help">{t('setup.choiceHelp')}</p>}
   {definition.kind==='input'&&<form id="aio-step-input-form" onSubmit={e=>{e.preventDefault();confirmInput();}}><fieldset className="aio-controls" disabled={running||busy||pickerBusy}>
    {step==='storage'&&<div className="aio-storage-picker"><button type="button" disabled={!native||pickerBusy} onClick={()=>void pickDirectory()}>{t(pickerBusy?'setup.busy':'setup.pickParent')}</button><p className="aio-help">{t(native?'setup.pickHelp':'setup.pickBrowser')}</p>{storageParent&&<><p>{t('setup.selectedParent')}: <code>{storageParent}</code></p><label htmlFor="aio-storage-child">{t('setup.childName')}</label><input id="aio-storage-child" value={storageChild} onChange={e=>{const child=e.target.value;setStorageChild(child);const target=storageTarget(storageParent,child);if(target){setDraftInput(target);setState(s=>transitionSetup(s,{type:'select',step:'storage',value:target}));setError('');}else setError('setup.error.child');}}/></>}</div>}
    <label htmlFor="aio-setup-input">{t(step==='backend'?'setup.backendUrl':'setup.storageDirectory')}</label>
    <div className="aio-input-row"><input ref={inputRef} id="aio-setup-input" value={draftInput} onChange={e=>{setDraftInput(e.target.value);if(step==='storage')setStorageParent('');if(step)setState(s=>transitionSetup(s,{type:'select',step,value:e.target.value}));setError('');}} autoComplete="off" spellCheck={false} aria-describedby="aio-input-help" aria-invalid={!!error}/></div>
    <p id="aio-input-help" className="aio-help">{t(step==='backend'?'setup.backendHelp':'setup.storageHelp')}</p></fieldset></form>}
   {step==='acceleration'&&<fieldset className="aio-options" disabled={running||busy||pickerBusy}><legend>{t('setup.options')}</legend>
    {(Object.keys(state.options) as (keyof InstallOptions)[]).map(id=><label key={id}><input type="checkbox" checked={state.options[id]} onChange={e=>setState(s=>transitionSetup(s,{type:'option',id,enabled:e.target.checked}))}/>{t(`setup.option.${id}`)}</label>)}
    <p className="aio-help">{t('setup.optionsHelp')}</p><label htmlFor="comfy-ref">{t('setup.comfyRef')}</label><input id="comfy-ref" value={state.comfyRef} maxLength={120} onChange={e=>setState(s=>transitionSetup(s,{type:'ref',value:e.target.value}))}/>
   </fieldset>}
   {definition.kind==='review'&&plan&&<><p className="aio-plan-status">{t(plan.route==='managed'?'setup.status.notInstalled':'setup.status.notInspected')} · {t('setup.noReadiness')}</p><details><summary>{t('setup.exactPlan')}</summary><pre aria-label={t('setup.exactPlan')}>{JSON.stringify(plan,null,2)}</pre></details><p>{t('setup.notImplemented')}</p>
    <div className="aio-actions"><button type="button" onClick={exportPlan}>{t('setup.export')}</button>{plan.route==='existing'?<button onClick={()=>onConnectExisting(plan.baseUrl)}>{t('setup.inspect')}</button>:<button disabled={!native||running||busy} onClick={()=>void prepare()}>{t(busy?'setup.busy':'setup.prepare')}</button>}</div>
    {plan.route==='existing'?<p>{t('setup.readOnly')}</p>:<p>{t(native?'setup.nativeNotice':'setup.browserNotice')}</p>}
   </>}
  </section>}
  {!automatic&&definition&&definition.kind!=='review'&&<div className="aio-confirm-rail"><button className="aio-confirm-button" type={definition.kind==='input'?'submit':'button'} form={definition.kind==='input'?'aio-step-input-form':undefined} onClick={definition.kind==='input'?undefined:confirmStep} disabled={running||busy||pickerBusy||(definition.kind==='choice'&&!state.values[step!])}>{t('setup.confirmStep')}</button></div>}
  </div>
  {nativePlan&&<section className="aio-detail" aria-label={t('setup.nativePlan')}><h3>{t('setup.nativePlan')}</h3><dl className="aio-request-summary" aria-label={t('setup.exactNativePlan')}>{Object.entries(nativePlan.request).map(([key,value])=><div key={key}><dt>{t(`setup.request.${key}`)}</dt><dd>{typeof value==='object'?JSON.stringify(value):String(value)}</dd></div>)}</dl><details><summary>{t('setup.requestJson')}</summary><pre>{JSON.stringify(nativePlan.request,null,2)}</pre></details>
   {(nativePlan.hardware||nativePlan.torch)&&<><h4>{t('setup.runtimeProfile')}</h4><dl className="aio-request-summary" aria-label={t('setup.runtimeProfile')}>{Object.entries({...nativePlan.hardware,...nativePlan.torch}).map(([key,value])=><div key={key}><dt>{t(`setup.profile.${key}`)}</dt><dd>{Array.isArray(value)?value.join(', '):String(value??t('setup.profile.none'))}</dd></div>)}</dl><details><summary>{t('setup.profileJson')}</summary><pre>{JSON.stringify({hardware:nativePlan.hardware??null,torch:nativePlan.torch??null},null,2)}</pre></details></>}
   <details><summary>{t('setup.nativeSteps')}</summary><ol>{nativePlan.steps.map(s=><li key={s.id}><strong>{t(s.labelKey)}</strong><p>{s.detail}</p></li>)}</ol></details>
   {nativePlan.warnings.length>0&&<><h4>{t('setup.warnings')}</h4><ul>{nativePlan.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></>}
   {nativePlan.unsupportedOptions.length>0&&<><h4>{t('setup.unsupported')}</h4><ul>{nativePlan.unsupportedOptions.map(o=><li key={o}>{o}</li>)}</ul></>}
   {!nativePlan.canExecute&&<p role="alert">{t('setup.blocked')}</p>}
   {!automatic&&<label className="aio-consent"><input type="checkbox" checked={confirmed} disabled={running||busy||!nativePlan.canExecute||nativePlan.unsupportedOptions.length>0} onChange={e=>setConfirmed(e.target.checked)}/>{t('setup.confirmNative')}</label>}
   <button disabled={!planMatches||(!automatic&&!confirmed)||running||busy||status?.state==='succeeded'||!nativePlan.canExecute||nativePlan.unsupportedOptions.length>0} onClick={()=>void start()}>{t(automatic?'setup.autoStart':'setup.install')}</button>
  </section>}
  {status&&<section className="aio-detail" aria-label={t('setup.installStatus')}><h3>{t('setup.installStatus')}</h3><p role="status">{t(`setup.execution.${status.state}`)}{status.stepId&&` · ${status.stepId}`}</p>{status.state==='succeeded'&&<p>{t('setup.installedNotReady')}</p>}<details><summary>{t('setup.logs')}</summary><pre aria-label={t('setup.logs')}>{status.logs.join('\n')}</pre></details>{status.error&&<p role="alert">{t('setup.technicalError')}: {status.error}</p>}{running&&<button disabled={busy} onClick={()=>void cancel()}>{t('setup.cancel')}</button>}</section>}
  {(native||plan)&&<OwnedBackendPanel installSucceeded={status?.state==='succeeded'} onConnectExisting={onConnectExisting}/>}
  {state.opened&&<details className="aio-detail" onToggle={e=>setDownloadsOpen(e.currentTarget.open)}><summary>{t('setup.downloadPlugins')}</summary>{downloadsOpen&&<DownloadWorkspace installTarget={plan?.route==='managed'?plan.storagePath:undefined}/>}</details>}
  <div className="aio-draft-actions"><button disabled={running||busy||pickerBusy} onClick={save}>{t('setup.save')}</button>{hasSaved&&<button disabled={running||busy||pickerBusy} onClick={restore}>{t('setup.restore')}</button>}</div>
  {error&&<p className="aio-error" role="alert">{t(error)}</p>}{technicalError&&<p className="aio-error" role="alert">{t('setup.technicalError')}: {technicalError}</p>}{notice&&<p className="aio-notice" role="status">{t(notice)}</p>}
 </section>;
}
export default AiOSetup;
