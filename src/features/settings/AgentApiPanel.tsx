import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { NumberField } from '../../components/NumberField';
import builtinFamilies from '../../families/builtin.json' with { type: 'json' };

/** Native `deas-agent-settings.json` snapshot: every field verbatim plus `exists`/`sourcePath`. */
export interface AgentSettings { enabled:boolean; port:number; standingKey?:string|null; originAllowlist:string[] }
export interface SettingsSnapshot extends AgentSettings { exists:boolean; sourcePath:string }
/** The guard file's raw `watchdog` block; the wire key is `vramStaticMiB` (named by hand natively). */
export interface Watchdog { windowSec?:number; utilMedianPct?:number; vramStaticMiB?:number; graceSec?:number; guardOwnRuns?:boolean }
/** The guard file's `caps` block (ruling E21): every key optional, absent is the shipped native default; whole numbers 1..=8192 MiB. */
export interface GuardCaps { uploadSingleMiB?:number; jobUploadMiB?:number; downloadSingleMiB?:number }
export interface GuardSnapshot { unloadCommand?:string; restoreCommand?:string; readyUrl?:string; autoCycleVram?:boolean; freeOnQueueEnd?:boolean; watchdog?:Watchdog|null; caps?:GuardCaps|null; configured:boolean; exists:boolean; problem?:string; sourcePath:string }
/** One dial block: dial names are the closed native vocabulary, absent means "fall through". */
export interface Dials { [dial:string]:unknown }
export interface DefaultsSnapshot { configured:boolean; sourcePath:string; sheet:{version:number;global:Dials;families:Record<string,Dials>;combos:Record<string,Dials>} }
/** The confirm wall's honest answer: `applied:false` plus the before/after diff; `true` answers the landed state. */
export interface WriteAnswer { applied:boolean; changes:string[]; before?:Dials; after?:Dials; key?:string; settings?:AgentSettings; guard?:GuardSnapshot; configurable?:DefaultsSnapshot['sheet'] }
type Pending = { command:string; args:Record<string,unknown>; body:WriteAnswer };

// The closed native vocabularies (defaults.rs MODES/DIAL_NAMES); the panel mirrors, never invents.
const modes=['t2i','i2i','inpaint','refine','upscale','refmod','ref2va','video','music','t2v','i2v','v2v','t2m'] as const;
const dialNames=['seedMode','imageFormat','steps','cfg','sampler','scheduler','width','height','negativePrompt','denoise','options'] as const;
const numericDials=['steps','cfg','width','height','denoise'] as const;
const editableDials=dialNames.filter(d=>d!=='options'); // `options` stays an opaque object: display and removal only.
const numberish=(d:string)=>(numericDials as readonly string[]).includes(d);
// Shipped guard/watchdog defaults, mirroring the native missing-field law; empty watchdog means these.
const watchdogDefault:Watchdog={windowSec:60,utilMedianPct:20,vramStaticMiB:3072,graceSec:120,guardOwnRuns:true};
// Shipped cap defaults (caps.rs DEFAULT_*_MIB) shown as placeholders only: a blank field omits the key and lets the native default stand.
const capKeys=['uploadSingleMiB','jobUploadMiB','downloadSingleMiB'] as const;
const capsDefault:Required<GuardCaps>={uploadSingleMiB:50,jobUploadMiB:100,downloadSingleMiB:500};
interface GuardDraft { unloadCommand:string; restoreCommand:string; readyUrl:string; autoCycleVram:boolean; freeOnQueueEnd:boolean; watchdog:Watchdog; caps:GuardDraftCaps }
type GuardDraftCaps={[K in keyof Required<GuardCaps>]?:number};
const guardDraftOf=(g:GuardSnapshot):GuardDraft=>({unloadCommand:g.unloadCommand??'',restoreCommand:g.restoreCommand??'',readyUrl:g.readyUrl??'',autoCycleVram:g.autoCycleVram??true,freeOnQueueEnd:g.freeOnQueueEnd??true,watchdog:{...watchdogDefault,...g.watchdog??{}},caps:{...g.caps??{}}});
const settingsDraftOf=(s:SettingsSnapshot)=>({enabled:s.enabled,port:s.port,standingKey:s.standingKey??'',origins:(s.originAllowlist??[]).join(', ')});
const fmt=(v:unknown)=>v===undefined?'—':JSON.stringify(v);
const maskKey=(k:string,v:unknown)=>k!=='standingKey'?fmt(v):(v===null||v===undefined||v===''?'null':'"••••••"');

/** Backend: operator controls for the /v1 agent plane. Every write runs the confirm wall: preview diff first, explicit confirm second. */
export function AgentApiPanel(){
 const {t}=useI18n();const native=isTauri();
 const [settings,setSettings]=useState<SettingsSnapshot|null>(null);
 const [guard,setGuard]=useState<GuardSnapshot|null>(null);
 const [defaults,setDefaults]=useState<DefaultsSnapshot|null>(null);
 const [draft,setDraft]=useState<ReturnType<typeof settingsDraftOf>|null>(null);
 const [gdraft,setGdraft]=useState<GuardDraft|null>(null);
 const [patches,setPatches]=useState<Record<string,Dials>>({}); // per-combo three-state dial patches
 const [adding,setAdding]=useState<Record<string,string[]>>({}); // combo key → dials added but still unset
 const [newCombos,setNewCombos]=useState<string[]>([]);
 const [add,setAdd]=useState({family:'',mode:'t2i'});
 const [reveal,setReveal]=useState(false);
 const [pending,setPending]=useState<Pending|null>(null);
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');const [error,setError]=useState('');const [refusal,setRefusal]=useState('');
 const live=useRef(true);
 useEffect(()=>{live.current=true;if(!native)return;
  const read=<T,>(command:string,set:(v:T)=>void)=>invoke<T>(command).then(v=>{if(live.current)set(v);},e=>{if(live.current)setError(String(e));});
  read<SettingsSnapshot>('native_agent_settings_read',s=>{setSettings(s);setDraft(settingsDraftOf(s));});
  read<GuardSnapshot>('native_agent_guard_read',g=>{setGuard(g);setGdraft(guardDraftOf(g));});
  read<DefaultsSnapshot>('native_agent_defaults_read',setDefaults);
  return()=>{live.current=false;};},[native]);
 const apply=(command:string,args:Record<string,unknown>)=>{ // confirm wall leg one: the native side answers the diff and writes nothing
  if(busy)return;setBusy(true);setError('');setMessage('');
  invoke<WriteAnswer>(command,{...args,confirm:false}).then(r=>{if(!live.current)return;
   if(r.applied===true)land(command,r); // the honest answer even here: a changed file can land straight away
   else setPending({command,args,body:r});
  },e=>{if(live.current){setError(String(e));setRefusal(String(e));}}).finally(()=>{if(live.current)setBusy(false);});
 };
 const confirm=()=>{ // leg two: the same arguments with confirm:true; a mid-cycle refusal arrives as the stock native string
  if(busy||!pending)return;setBusy(true);setError('');
  invoke<WriteAnswer>(pending.command,{...pending.args,confirm:true}).then(r=>{if(!live.current)return;
   if(r.applied===true){land(pending.command,r);setMessage(t('agentApi.applied',{changes:r.changes.join(', ')}));setPending(null);}
   else{setPending({...pending,body:r});setError(t('agentApi.changedSince'));}
  },e=>{if(live.current){setError(String(e));setRefusal(String(e));}}).finally(()=>{if(live.current)setBusy(false);});
 };
 const land=(command:string,r:WriteAnswer)=>{
  if(command==='native_agent_settings_write'&&r.settings)setBothSettings(r.settings);
  if(command==='native_agent_guard_write'&&r.guard)setBothGuard(r.guard);
  if(command==='native_agent_defaults_write'&&r.configurable&&r.key){setDefaults(d=>d&&{...d,configured:true,sheet:r.configurable!});setPatches(p=>Object.fromEntries(Object.entries(p).filter(([k])=>k!==r.key)));setAdding(a=>Object.fromEntries(Object.entries(a).filter(([k])=>k!==r.key)));setNewCombos(n=>n.filter(k=>k!==r.key));}
 };
 const setBothSettings=(next:AgentSettings)=>{setSettings(s=>s&&{...s,...next});setDraft(settingsDraftOf({enabled:next.enabled,port:next.port,standingKey:next.standingKey??null,originAllowlist:next.originAllowlist??[],exists:true,sourcePath:''}));};
 const setBothGuard=(raw:GuardSnapshot)=>{setGuard(g=>g&&{...g,...raw,configured:true,exists:true});setGdraft(guardDraftOf(raw));};
 const settingsPatch=():Dials=>{if(!settings||!draft)return{};const p:Dials={};
  if(draft.enabled!==settings.enabled)p.enabled=draft.enabled;
  if(draft.port!==settings.port)p.port=draft.port;
  if(draft.standingKey!==(settings.standingKey??''))p.standingKey=draft.standingKey===''?null:draft.standingKey; // empty clears to the shipped default (null)
  const origins=draft.origins.split(',').map(s=>s.trim()).filter(Boolean);
  if(origins.join('\n')!==(settings.originAllowlist??[]).join('\n'))p.originAllowlist=origins;
  return p;};
 const guardPatch=():Dials=>{if(!guard||!gdraft)return{};const base=guardDraftOf(guard);const p:Dials={};
  for(const k of ['unloadCommand','restoreCommand','readyUrl','autoCycleVram','freeOnQueueEnd'] as const)if(gdraft[k]!==base[k])p[k]=gdraft[k];
  if(JSON.stringify(gdraft.watchdog)!==JSON.stringify(base.watchdog))p.watchdog=gdraft.watchdog; // one whole block: the shown numbers are the sent numbers
  if(JSON.stringify(gdraft.caps)!==JSON.stringify(base.caps)){const set=Object.fromEntries(Object.entries(gdraft.caps).filter(([,v])=>v!==undefined));p.caps=Object.keys(set).length?set:null;} // caps: whole block like watchdog; an emptied block clears to the native defaults
  return p;};
 if(!native)return <section className="aio-detail agent-api-panel" aria-label={t('agentApi.title')}><h3>{t('agentApi.title')}</h3><p className="aio-help">{t('agentApi.notNative')}</p></section>;
 if(!settings&&!guard&&!defaults)return <section className="aio-detail agent-api-panel" aria-label={t('agentApi.title')}><h3>{t('agentApi.title')}</h3><p className="aio-help">{error||t('agentApi.loading')}</p></section>;
 const guardWord=guard?(guard.configured?t('agentApi.guardConfigured'):guard.problem?t('agentApi.guardInvalid'):t('agentApi.guardPlain')):t('agentApi.loading');
 const sheet=defaults?.sheet;
 const comboKeys=[...new Set([...Object.keys(sheet?.combos??{}),...newCombos])].sort();
 const dialValue=(key:string,dial:string)=>{const p=patches[key]??{};return dial in p?p[dial]:sheet?.combos[key]?.[dial];};
 const setDial=(key:string,dial:string,value:string|number|null)=>{setPatches(p=>({...p,[key]:{...(p[key]??{}),[dial]:value}}));setAdding(a=>({...a,[key]:(a[key]??[]).filter(d=>d!==dial)}));};
 const clearDial=(key:string,dial:string)=>setDial(key,dial,null);
 const restoreDial=(key:string,dial:string)=>setPatches(p=>{const q={...(p[key]??{})};delete q[dial];return{...p,[key]:q};});
 const addRow=(label:string,node:React.ReactNode,hook:string)=><label className="startup-field" data-agentapi-field={hook}><span>{label}</span>{node}</label>;
 const capRow=(k:(typeof capKeys)[number])=>{const v=gdraft?.caps[k]; // blank = the key is absent = the shipped native default; the Remove chip returns a set cap to that posture
  return <label className="startup-field agent-api-cap" data-agentapi-cap={k} key={k}><span>{t(`agentApi.${k}`)}</span><NumberField min={1} max={8192} step={1} placeholder={String(capsDefault[k])} text={v===undefined?'':String(v)} onCommit={n=>{if(Number.isInteger(n))setGdraft(g=>g&&{...g,caps:{...g.caps,[k]:n}});}}/>{v!==undefined&&<button type="button" className="logs-chip" data-agentapi-cap-remove={k} onClick={()=>setGdraft(g=>g&&{...g,caps:{...g.caps,[k]:undefined}})}>{t('agentApi.remove')}</button>}</label>;};
 const dialRow=(key:string,dial:string)=>{const value=dialValue(key,dial);const cleared=value===null&&dial in (patches[key]??{});
  return <div className="startup-field agent-api-dial" data-agentapi-dial={`${key}:${dial}`} key={dial}>
   <span>{dial}</span>
   {dial==='options'
    ? <code className="aio-help">{cleared?'—':fmt(value)}</code>
    : numberish(dial)
     ? <NumberField aria-label={`${dial} for ${key}`} min={dial==='cfg'||dial==='denoise'?0:1} max={dial==='cfg'?100:dial==='denoise'?1:16384} step={dial==='cfg'||dial==='denoise'?0.5:1} reject={false} disabled={cleared} text={typeof value==='number'?String(value):''} onCommit={n=>setDial(key,dial,n)}/>
     : <input type="text" aria-label={`${dial} for ${key}`} disabled={cleared} value={typeof value==='string'?value:''} onChange={e=>setDial(key,dial,e.target.value)}/>}
   {dial in (sheet?.combos[key]??{})&&!cleared&&<button type="button" className="logs-chip" data-agentapi-dial-remove={`${key}:${dial}`} onClick={()=>clearDial(key,dial)}>{t('agentApi.remove')}</button>}
   {cleared&&dial in (sheet?.combos[key]??{})&&<button type="button" className="logs-chip" data-agentapi-dial-restore={`${key}:${dial}`} onClick={()=>restoreDial(key,dial)}>{t('agentApi.restore')}</button>}
  </div>;};
 return <section className="aio-detail agent-api-panel" aria-label={t('agentApi.title')}>
  <h3>{t('agentApi.title')}</h3>
  <p className="aio-help">{t('agentApi.help')}</p>
  {settings&&<p className="aio-help" role="status" data-agentapi-status>{t('agentApi.statusLine',{state:t(settings.enabled?'agentApi.on':'agentApi.off'),port:settings.port,key:t(settings.standingKey?'agentApi.keySet':'agentApi.keyUnset'),origins:settings.originAllowlist?.length??0,guard:guardWord,combos:Object.keys(sheet?.combos??{}).length})}</p>}
  {guard?.problem&&<p className="aio-error" role="alert">{t('agentApi.guardProblem')} {guard.problem}</p>}
  {refusal&&<p className="aio-help" data-agentapi-refusal>{t('agentApi.refused')} {refusal}</p>}
  {settings&&draft&&<fieldset className="startup-group" data-agentapi-section="access"><legend>{t('agentApi.access')}</legend>
   <label className="download-check" data-agentapi-check="enabled"><input type="checkbox" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/><span>{t('agentApi.enabled')}</span></label>
   {addRow(t('agentApi.port'),<NumberField min={1} max={65535} step={1} reject={false} text={String(draft.port)} onCommit={n=>setDraft({...draft,port:Number.isSafeInteger(n)?n:draft.port})}/>,'port')}
   <div className="startup-field agent-api-key-field" data-agentapi-field="standingKey"><label><span>{t('agentApi.standingKey')}</span><input type={reveal?'text':'password'} autoComplete="off" spellCheck={false} data-agentapi-key value={draft.standingKey} onChange={e=>setDraft({...draft,standingKey:e.target.value})}/></label><button type="button" className="logs-chip" data-agentapi-reveal aria-pressed={reveal} onClick={()=>setReveal(r=>!r)}>{t(reveal?'agentApi.hide':'agentApi.reveal')}</button></div>
   <p className="aio-help">{t('agentApi.standingKeyHelp')}</p>
   {addRow(t('agentApi.origins'),<input type="text" data-agentapi-origins value={draft.origins} onChange={e=>setDraft({...draft,origins:e.target.value})}/>,'origins')}
   <p className="aio-help">{t('agentApi.originsHelp')}</p>
   <p className="aio-help">{t('agentApi.restartNote')}</p>
   <div className="aio-actions"><button type="button" className="aio-confirm-button" data-agentapi-apply="settings" disabled={busy||Object.keys(settingsPatch()).length===0} onClick={()=>apply('native_agent_settings_write',{patch:settingsPatch()})}>{t('agentApi.apply')}</button></div>
  </fieldset>}
  {guard&&gdraft&&<fieldset className="startup-group" data-agentapi-section="guard"><legend>{t('agentApi.guard')}</legend>
   {addRow(t('agentApi.unloadCommand'),<textarea rows={2} value={gdraft.unloadCommand} onChange={e=>setGdraft({...gdraft,unloadCommand:e.target.value})}/>,'unloadCommand')}
   {addRow(t('agentApi.restoreCommand'),<textarea rows={2} value={gdraft.restoreCommand} onChange={e=>setGdraft({...gdraft,restoreCommand:e.target.value})}/>,'restoreCommand')}
   {addRow(t('agentApi.readyUrl'),<textarea rows={1} value={gdraft.readyUrl} onChange={e=>setGdraft({...gdraft,readyUrl:e.target.value})}/>,'readyUrl')}
   <label className="download-check" data-agentapi-check="autoCycleVram"><input type="checkbox" checked={gdraft.autoCycleVram} onChange={e=>setGdraft({...gdraft,autoCycleVram:e.target.checked})}/><span>{t('agentApi.autoCycle')}</span></label>
   <label className="download-check" data-agentapi-check="freeOnQueueEnd"><input type="checkbox" checked={gdraft.freeOnQueueEnd} onChange={e=>setGdraft({...gdraft,freeOnQueueEnd:e.target.checked})}/><span>{t('agentApi.freeOnQueueEnd')}</span></label>
   <p className="aio-help">{t('agentApi.guardHint')}</p>
   <p className="aio-help">{t('agentApi.watchdog')}</p>
   {addRow(t('agentApi.windowSec'),<NumberField min={30} max={1800} step={1} reject={false} text={String(gdraft.watchdog.windowSec)} onCommit={n=>setGdraft({...gdraft,watchdog:{...gdraft.watchdog,windowSec:n}})}/>,'windowSec')}
   {addRow(t('agentApi.utilMedian'),<NumberField min={0} max={100} step={1} reject={false} text={String(gdraft.watchdog.utilMedianPct)} onCommit={n=>setGdraft({...gdraft,watchdog:{...gdraft.watchdog,utilMedianPct:n}})}/>,'utilMedianPct')}
   {addRow(t('agentApi.vramStatic'),<NumberField min={0} step={1} reject={false} text={String(gdraft.watchdog.vramStaticMiB)} onCommit={n=>setGdraft({...gdraft,watchdog:{...gdraft.watchdog,vramStaticMiB:n}})}/>,'vramStaticMiB')}
   {addRow(t('agentApi.graceSec'),<NumberField min={0} step={1} reject={false} text={String(gdraft.watchdog.graceSec)} onCommit={n=>setGdraft({...gdraft,watchdog:{...gdraft.watchdog,graceSec:n}})}/>,'graceSec')}
   <label className="download-check" data-agentapi-check="guardOwnRuns"><input type="checkbox" checked={gdraft.watchdog.guardOwnRuns??true} onChange={e=>setGdraft({...gdraft,watchdog:{...gdraft.watchdog,guardOwnRuns:e.target.checked}})}/><span>{t('agentApi.guardOwnRuns')}</span></label>
   {capKeys.map(k=>capRow(k))}
   <p className="aio-help">{t('agentApi.midCycleHelp')}</p>
   <div className="aio-actions"><button type="button" className="aio-confirm-button" data-agentapi-apply="guard" disabled={busy||Object.keys(guardPatch()).length===0} onClick={()=>apply('native_agent_guard_write',{patch:guardPatch()})}>{t('agentApi.apply')}</button></div>
  </fieldset>}
  {defaults&&sheet&&<fieldset className="startup-group" data-agentapi-section="defaults"><legend>{t('agentApi.defaults')}</legend>
   <p className="aio-help">{t('agentApi.defaultsHelp')}</p>
   <p className="startup-field" data-agentapi-scope="global"><span>{t('agentApi.global')}</span><code className="aio-help">{Object.keys(sheet.global).length?Object.entries(sheet.global).map(([k,v])=>`${k}=${fmt(v)}`).join(' · '):'—'}</code></p>
   {Object.entries(sheet.families).map(([family,dials])=><p className="startup-field" data-agentapi-scope={`family:${family}`} key={family}><span>{family}</span><code className="aio-help">{Object.keys(dials).length?Object.entries(dials).map(([k,v])=>`${k}=${fmt(v)}`).join(' · '):'—'}</code></p>)}
   <p className="aio-help">{t('agentApi.comboOnly')}</p>
   {comboKeys.map(key=>{const patch=patches[key]??{};const rows=[...new Set([...Object.keys(sheet.combos[key]??{}),...(adding[key]??[])])].sort((a,b)=>dialNames.indexOf(a as never)-dialNames.indexOf(b as never));const unsetDials=editableDials.filter(d=>dialValue(key,d)===undefined);
    return <fieldset className="startup-group" data-agentapi-combo={key} key={key}><legend>{key} <span className="logs-chip">{t('agentApi.scopeCombo')}</span></legend>
     {rows.map(dial=>dialRow(key,dial))}
     {unsetDials.length>0&&<label className="startup-field"><span>{t('agentApi.addDial')}</span><select data-agentapi-add-dial={key} value="" onChange={e=>{const d=e.target.value;if(d)setAdding(a=>({...a,[key]:[...(a[key]??[]),d]}));}}><option value="">{t('agentApi.default')}</option>{unsetDials.map(d=><option key={d} value={d}>{d}</option>)}</select></label>}
     <div className="aio-actions">
      <button type="button" className="aio-confirm-button" data-agentapi-combo-save={key} disabled={busy||Object.keys(patch).length===0} onClick={()=>apply('native_agent_defaults_write',{key,dials:patch})}>{t('agentApi.saveCombo')}</button>
      {Object.keys(sheet.combos[key]??{}).length>0&&<button type="button" className="logs-chip" data-agentapi-combo-clear={key} disabled={busy} onClick={()=>apply('native_agent_defaults_write',{key,dials:Object.fromEntries(Object.keys(sheet.combos[key]).map(d=>[d,null]))})}>{t('agentApi.clearCombo')}</button>}
     </div>
    </fieldset>;})}
   <label className="startup-field" data-agentapi-combo-add><span>{t('agentApi.comboAdd')}</span>
    <span className="agent-api-key"><input type="text" list="agent-api-families" placeholder={t('agentApi.family')} value={add.family} onChange={e=>setAdd({...add,family:e.target.value.trim()})}/>
    <select data-agentapi-mode value={add.mode} onChange={e=>setAdd({...add,mode:e.target.value})}>{modes.map(m=><option key={m} value={m}>{m}</option>)}</select>
    <button type="button" className="logs-chip" data-agentapi-combo-add-go disabled={!add.family||comboKeys.includes(`${add.family}:${add.mode}`)} onClick={()=>{const key=`${add.family}:${add.mode}`;setNewCombos(n=>[...n,key]);setPatches(p=>({...p,[key]:{}}));setAdd({family:'',mode:'t2i'});}}>{t('agentApi.comboAdd')}</button></span>
   </label>
   <datalist id="agent-api-families">{(builtinFamilies as {id:string}[]).map(f=><option key={f.id} value={f.id}/>)}</datalist>
  </fieldset>}
  {pending&&<fieldset className="startup-group" data-agentapi-preview><legend>{t('agentApi.previewTitle')}{pending.body.key?` · ${pending.body.key}`:''}</legend>
   {pending.body.changes.map(k=><p className="startup-field" data-agentapi-change={k} key={k}><span>{k}</span><code className="aio-help">{maskKey(k,(pending.body.before??{})[k])} → {maskKey(k,(pending.body.after??{})[k])}</code></p>)}
   <div className="aio-actions">
    <button type="button" className="aio-confirm-button" data-agentapi-confirm disabled={busy} onClick={()=>void confirm()}>{t('agentApi.confirm')}</button>
    <button type="button" className="logs-chip" data-agentapi-cancel disabled={busy} onClick={()=>setPending(null)}>{t('agentApi.cancel')}</button>
   </div>
  </fieldset>}
  <div className="aio-actions">{message&&<p className="aio-help" role="status">{message}</p>}</div>
  {error&&<p className="aio-error" role="alert">{error}</p>}
 </section>;
}
