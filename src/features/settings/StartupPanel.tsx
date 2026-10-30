import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { generationActive } from '../../lib/jobs';

/** Native `deas-startup.json`: allowlisted ComfyUI launch flags (validated again natively). */
export interface Startup { preset?:Preset; flags:string[]; fast:string[]; reserveVram?:number; cacheLru?:number }
const presetIds=['speed','compatibility','off'] as const;
type Preset=typeof presetIds[number];
const attention=['--use-pytorch-cross-attention','--use-ck-attention','--use-sage-attention','--use-flash-attention'];
const vaes=['--fp32-vae','--bf16-vae','--cpu-vae'];
const unets=['--bf16-unet','--fp16-unet'];
const caches=['--cache-classic','--cache-none'];
const fast=['fp16_accumulation','fp8_matrix_mult','autotune'];
const advancedSwitches=['--fp16-text-enc','--disable-smart-memory','--disable-dynamic-vram'];
// Flag/feature → venv package it needs; mirrors native `PACKAGES`.
const needs:Record<string,string>={'--use-sage-attention':'sageattention','--use-flash-attention':'flash_attn'};

/** Backend: startup optimizations for the owned backend; applying restarts it (never during a job). */
export function StartupPanel({root,onRestart}:{root:string;onRestart:()=>void}){
 const {t}=useI18n();const native=isTauri();
 const [value,setValue]=useState<Startup|null>(null);const [presets,setPresets]=useState<Record<Preset,Startup>|null>(null);const [saved,setSaved]=useState('');const [packages,setPackages]=useState<string[]>([]);
 const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [error,setError]=useState('');const live=useRef(true);
 useEffect(()=>{live.current=true;if(!native)return;invoke<{startup:Startup;packages:string[];presets:Record<Preset,Startup>}>('native_startup_read',{root}).then(s=>{if(!live.current)return;setValue(s.startup);setSaved(JSON.stringify(s.startup));setPackages(s.packages);setPresets(s.presets);},e=>{if(live.current)setError(String(e));});return()=>{live.current=false;};},[native,root]);
 if(!value||!presets)return <section className="aio-detail startup-panel" aria-label={t('startup.title')}><h3>{t('startup.title')}</h3><p className="aio-help">{error||t(native?'startup.loading':'downloads.browser')}</p></section>;
 // A preset is stored by name and resolved natively per GPU; the controls show its resolution, and any edit turns it into Custom.
 const shown:Startup=value.preset?presets[value.preset]:value;
 const edit=(next:Omit<Startup,'preset'>)=>setValue(next);
 const missing=(id:string)=>!!needs[id]&&!packages.includes(needs[id]);
 const note=(id:string)=>missing(id)?t('startup.needs',{package:needs[id]}):'';
 const group=(list:string[])=>shown.flags.find(f=>list.includes(f))??'';
 const setGroup=(list:string[],flag:string)=>edit({...shown,flags:[...shown.flags.filter(f=>!list.includes(f)),...(flag?[flag]:[])]});
 const toggle=(flag:string,on:boolean)=>edit({...shown,flags:on?[...shown.flags,flag]:shown.flags.filter(f=>f!==flag)});
 const select=(id:string,list:string[],labels:string)=><label className="startup-field"><span>{t(`startup.${id}`)}</span><select value={group(list)} onChange={e=>setGroup(list,e.target.value)}><option value="">{t('startup.default')}</option>{list.map(f=><option key={f} value={f} disabled={missing(f)&&group(list)!==f}>{t(`startup.${labels}.${f.slice(2)}`)}{note(f)&&` · ${note(f)}`}</option>)}</select></label>;
 const check=(flag:string)=><label key={flag} className="download-check" title={flag}><input type="checkbox" checked={shown.flags.includes(flag)} onChange={e=>toggle(flag,e.target.checked)}/><span>{t(`startup.flag.${flag.slice(2)}`)}</span></label>;
 const cache=shown.cacheLru?'lru':group(caches);
 const apply=async()=>{
  if(busy)return;setBusy(true);setError('');setMessage('');
  try{
   const next=await invoke<Startup>('native_startup_write',{root,startup:value});if(!live.current)return;
   setValue(next);setSaved(JSON.stringify(next));
   if(await generationActive())setMessage(t('startup.jobRunning'));
   else{onRestart();setMessage(t('startup.applied'));}
  }catch(e){if(live.current)setError(String(e));}finally{if(live.current)setBusy(false);}
 };
 return <section className="aio-detail startup-panel" aria-label={t('startup.title')}>
  <h3>{t('startup.title')}</h3>
  <p className="aio-help">{t('startup.help')}</p>
  <div className="startup-presets" role="group" aria-label={t('startup.preset')}>{presetIds.map(id=><button key={id} type="button" className="logs-chip" aria-pressed={value.preset===id} title={t(`startup.preset.${id}.help`)} onClick={()=>setValue({preset:id,flags:[],fast:[]})}>{t(`startup.preset.${id}`)}</button>)}<span className="aio-help">{t(value.preset?`startup.preset.${value.preset}.help`:'startup.preset.custom')}</span></div>
  {select('attention',attention,'attn')}
  <fieldset className="startup-group"><legend>{t('startup.fast')}</legend>
   {fast.map(f=><label key={f} className="download-check" title={`--fast ${f}`}><input type="checkbox" checked={shown.fast.includes(f)} disabled={missing(f)&&!shown.fast.includes(f)} onChange={e=>edit({...shown,fast:e.target.checked?[...shown.fast,f]:shown.fast.filter(x=>x!==f)})}/><span>{t(`startup.fast.${f}`)}{note(f)&&<small>{` · ${note(f)}`}</small>}</span></label>)}
   <p className="aio-help">{t('startup.fastHelp')}</p>
  </fieldset>
  <fieldset className="startup-group"><legend>{t('startup.vram')}</legend>
   {check('--highvram')}<p className="aio-help">{t('startup.highvramHelp')}</p>
   <label className="startup-field"><span>{t('startup.reserveVram')}</span><input type="number" min={0} max={128} step={0.5} value={shown.reserveVram??''} placeholder={t('startup.default')} onChange={e=>{const n=Number(e.target.value);edit({...shown,reserveVram:e.target.value&&n>0&&n<=128?n:undefined});}}/></label>
  </fieldset>
  {select('vae',vaes,'vaes')}<p className="aio-help">{t('startup.vaeHelp')}</p>
  <details className="startup-advanced"><summary>{t('startup.advanced')}</summary>
   {select('unet',unets,'unets')}
   {advancedSwitches.map(check)}
   <label className="startup-field"><span>{t('startup.cache')}</span><select value={cache} onChange={e=>{const v=e.target.value;edit({...shown,flags:shown.flags.filter(f=>!caches.includes(f)).concat(caches.includes(v)?[v]:[]),cacheLru:v==='lru'?shown.cacheLru??16:undefined});}}><option value="">{t('startup.cache.ram')}</option><option value="--cache-classic">{t('startup.cache.classic')}</option><option value="--cache-none">{t('startup.cache.none')}</option><option value="lru">{t('startup.cache.lru')}</option></select></label>
   {cache==='lru'&&<label className="startup-field"><span>{t('startup.cacheLru')}</span><input type="number" min={1} max={10000} step={1} value={shown.cacheLru} onChange={e=>{const n=Number(e.target.value);if(Number.isSafeInteger(n)&&n>=1&&n<=10000)edit({...shown,cacheLru:n});}}/></label>}
  </details>
  <div className="aio-actions"><button type="button" className="aio-confirm-button" disabled={!native||busy||JSON.stringify(value)===saved} onClick={()=>void apply()}>{t('startup.apply')}</button></div>
  {message&&<p className="aio-help" role="status">{message}</p>}
  {error&&<p className="aio-error" role="alert">{error}</p>}
 </section>;
}
