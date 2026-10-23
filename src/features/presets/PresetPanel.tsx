import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { applyStudioSettings, captureStudioSettings } from '../../lib/preferences';
import './presets.css';

type Preset={name:string;settings:Record<string,unknown>};
export function PresetPanel({disabled}:{disabled:boolean}){
 const {t}=useI18n();const [presets,setPresets]=useState<Preset[]|null>(null),[name,setName]=useState(''),[selected,setSelected]=useState(''),[error,setError]=useState(''),[status,setStatus]=useState(''),[saving,setSaving]=useState(false);
 const live=useRef(false),lock=useRef(false);const native=isTauri();
 useEffect(()=>{live.current=true;if(native)invoke<Preset[]>('native_presets_read').then(p=>{if(live.current)setPresets(p);},e=>{if(live.current)setError(String(e));});return()=>{live.current=false;};},[native]);
 const chosen=presets?.find(p=>p.name===selected);const trimmed=name.trim();
 const save=async(replace:boolean)=>{
  if(!presets||disabled||lock.current||(!replace&&(!trimmed||presets.some(p=>p.name===trimmed))))return;
  const target=replace?selected:trimmed;if(!target)return;
  const preset={name:target,settings:captureStudioSettings()};
  const next=replace?presets.map(p=>p.name===target?preset:p):[...presets,preset];
  lock.current=true;setSaving(true);setError('');setStatus('');
  try{
   await invoke('native_presets_write',{presets:next});
   // Read back the persisted target before reporting a successful save.
   const stored=await invoke<Preset[]>('native_presets_read');
   if(live.current){setPresets(stored);setSelected(target);setName(target);setStatus(t('presets.saved'));}
  }catch(e){if(live.current)setError(String(e));}
  finally{lock.current=false;if(live.current)setSaving(false);}
 };
 const load=()=>{
  if(!chosen||disabled||saving)return;
  setError('');setStatus('');
  if(!applyStudioSettings(chosen.settings)){setError(t('presets.invalid'));if(native)void invoke('native_presets_invalid').catch(()=>{});return;}
  setStatus(t('presets.loaded'));
 };
 return <section className="presets" aria-label={t('presets.title')}>
  <p className="aio-help">{t('presets.help')}</p>
  {!native?<p>{t('presets.native')}</p>:<>
   <div className="preset-controls">
    <label>{t('presets.select')}<select value={selected} disabled={!presets||saving} onChange={e=>{setSelected(e.target.value);setName(e.target.value);setStatus('');}}><option value="">{t('presets.choose')}</option>{presets?.map(p=><option key={p.name} value={p.name}>{p.name}</option>)}</select></label>
    <button type="button" disabled={!chosen||disabled||saving} onClick={load}>{t('presets.load')}</button>
    <label>{t('presets.name')}<input value={name} maxLength={100} disabled={!presets||saving} onChange={e=>{setName(e.target.value);setStatus('');}}/></label>
    <button type="button" disabled={!presets||disabled||saving||!trimmed||presets.length>=100||presets.some(p=>p.name===trimmed)} onClick={()=>void save(false)}>{t('presets.save')}</button>
    <button type="button" disabled={!chosen||disabled||saving} onClick={()=>{if(window.confirm(t('presets.confirm',{name:selected})))void save(true);}}>{t('presets.update')}</button>
   </div>
   {presets?.length===0&&<p className="aio-help">{t('presets.empty')}</p>}
  </>}
  {error&&<p role="alert" className="error-message">{error}</p>}
  {status&&<p role="status">{status}</p>}
 </section>;
}
