import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n/I18nProvider';
import { useDialogBackdropClose } from '../../components/useDialogBackdropClose';
import { dialLabel, type DialRow } from '../../lib/dials';
import { dialPresetError, fromPresetRows, isDialPresetName, nativeDialPresets, toPresetRows, type DialPresetStore, type PresetConversion } from '../../lib/dialPresets';
import './loraSets.css';
import './dial-rack.css';

const fmt=(v:number)=>String(+v.toFixed(3));
type Failure={code:string;detail:string};
/** Failures whose detail is the pack's or the validator's own sentence, shown beside the localized one. */
const detailed=['DIAL_PRESET_REFUSED','DIAL_PRESET_EXISTS','DIAL_PRESET_NOT_FOUND','DIAL_PRESET_ROWS','DIAL_PRESETS_FAILED',''];

/**
 * Experimental rack presets (docs/DIALS.md), with the look of the LoRA sets dialog: the current rack on the left, the presets of the
 * backend on the right. The store is the Dial Rack pack's own preset files, reached through `store` (native commands over the pack's
 * routes), so nothing is kept in DEAS. Loading hands the converted rows to `onLoad` (one undo step inside the rack dialog); every row
 * the preset holds is listed with what was left out, what changed and the pack's own warnings. Saving creates a new file and never
 * overwrites: an existing name shows the pack's answer. Without the pack or its route the dialog says so and offers nothing.
 */
export function DialPresetsDialog({endpoint,rows,seconds,onLoad,onClose,store=nativeDialPresets}:{endpoint:string;rows:readonly DialRow[];seconds:number;onLoad:(rows:DialRow[])=>void;onClose:()=>void;store?:DialPresetStore}){
 const {t}=useI18n();
 const dialog=useRef<HTMLDialogElement>(null),epoch=useRef(0),live=useRef(true);
 const [names,setNames]=useState<string[]|null>(null);
 const [chosen,setChosen]=useState('');
 const [preset,setPreset]=useState<{name:string;conversion:PresetConversion}|null>(null);
 const [name,setName]=useState('');
 const [busy,setBusy]=useState(false);
 // `listFailure` is the store itself not answering (no pack, no route, no backend): it stays until a refresh succeeds and keeps every control off.
 const [failure,setFailure]=useState<Failure|null>(null),[listFailure,setListFailure]=useState<Failure|null>(null);
 const [status,setStatus]=useState('');
 useEffect(()=>{const opener=document.activeElement as HTMLElement|null;const el=dialog.current!;el.showModal();live.current=true;return()=>{live.current=false;if(el.open)el.close();if(opener?.isConnected)opener.focus();};},[]);
 const backdrop=useDialogBackdropClose(onClose);
 const fail=(e:unknown)=>setFailure(dialPresetError(e));
 const refresh=useCallback(async()=>{
  const turn=++epoch.current;
  setFailure(null);setListFailure(null);setNames(null);
  try{const list=await store.list(endpoint);if(live.current&&turn===epoch.current)setNames(list);}
  catch(e){if(live.current&&turn===epoch.current){setNames([]);setListFailure(dialPresetError(e));}}
 },[endpoint,store]);
 useEffect(()=>{void refresh();},[refresh]);
 const choose=async(next:string)=>{
  const turn=++epoch.current;
  setChosen(next);setPreset(null);setFailure(null);setStatus('');
  if(!next)return;
  setBusy(true);
  try{const p=await store.load(endpoint,next);if(live.current&&turn===epoch.current)setPreset({name:next,conversion:fromPresetRows(p.rows,seconds,p.warnings)});}
  catch(e){if(live.current&&turn===epoch.current)fail(e);}
  finally{if(live.current)setBusy(false);}
 };
 const validName=isDialPresetName(name);
 const save=async()=>{
  if(!rows.length||!validName||busy)return;
  setBusy(true);setFailure(null);setStatus('');
  try{
   await store.save(endpoint,name,toPresetRows(rows));
   if(!live.current)return;
   const saved=name;
   setNames(old=>old&&!old.includes(saved)?[...old,saved].sort():old);
   await choose(saved);
   if(live.current)setStatus(t('studio.dials.presets.savedStatus',{name:saved}));
  }catch(e){if(live.current)fail(e);}
  finally{if(live.current)setBusy(false);}
 };
 const load=()=>{
  if(!preset?.conversion.rows.length)return;
  onLoad(preset.conversion.rows);
  setStatus(t('studio.dials.presets.loadedStatus',{count:String(preset.conversion.rows.length),total:String(preset.conversion.report.length)}));
 };
 const summary=(strength:number|null,curve:boolean,on:boolean)=>`${t(curve?'studio.dials.presets.row.curve':'studio.dials.presets.row.constant',{strength:strength===null?'?':fmt(strength)})}${on?'':` · ${t('studio.dials.presets.row.off')}`}`;
 const unavailable=!!listFailure,shown=failure??listFailure;
 return createPortal(<dialog ref={dialog} {...backdrop} className="lora-sets-dialog dial-presets-dialog" data-dial-presets aria-label={t('studio.dials.presets.title')}
  // React hands a portal's events to its React parents: over the rack dialog, Esc and Ctrl+Z here must not also close or undo the rack.
  onKeyDown={e=>e.stopPropagation()} onCancel={e=>{e.preventDefault();e.stopPropagation();onClose();}}>
  <header><h2>{t('studio.dials.presets.title')}</h2><button type="button" className="action-button" data-dial-presets-close onClick={onClose}>{t('studio.close')}</button></header>
  <div className="lora-sets-body">
   <section className="lora-selected-panel"><h3>{t('studio.dials.presets.current')} · {rows.length}</h3>
    <div className="lora-selected-scroll" role="region" aria-label={t('studio.dials.presets.current')} tabIndex={0}>
     {!rows.length&&<p data-dial-presets-empty>{t('studio.dials.presets.empty')}</p>}
     <ul>{rows.map((r,i)=><li key={`${i}:${r.dial}`} data-dial-preset-current={r.dial} className={r.on===false?'is-disabled':''}><div className="dial-preset-entry"><span className="lora-entry-name" title={r.dial}>{dialLabel(r.dial)}</span><span>{summary(r.strength,!!r.time,r.on!==false)}</span></div></li>)}</ul>
    </div>
    <footer>
     <label>{t('studio.dials.presets.name')}<input type="text" data-dial-preset-name maxLength={80} value={name} aria-invalid={!!name&&!validName} onChange={e=>{setName(e.target.value);setFailure(null);setStatus('');}}/></label>
     <small className={name&&!validName?'error-message':undefined} data-dial-preset-name-help>{t('studio.dials.presets.nameHelp')}</small>
     <div className="lora-set-actions"><button type="button" className="action-button" data-dial-preset-save disabled={!rows.length||!validName||busy||unavailable} onClick={()=>void save()}>{t('studio.dials.presets.save')}</button></div>
    </footer>
   </section>
   <section className="lora-saved-panel"><h3>{t('studio.dials.presets.saved')}</h3>
    <label><select data-dial-preset-select aria-label={t('studio.dials.presets.saved')} value={chosen} disabled={names===null||unavailable} onChange={e=>void choose(e.target.value)}>
     <option value="">{unavailable?'—':t(names===null?'studio.dials.presets.loading':names.length?'studio.dials.presets.none':'studio.dials.presets.listEmpty')}</option>{names?.map(n=><option key={n} value={n}>{n}</option>)}</select></label>
    <div className="lora-set-actions">
     <button type="button" className="action-button" data-dial-preset-refresh disabled={names===null||busy} onClick={()=>{setChosen('');setPreset(null);setStatus('');void refresh();}}>{t('studio.dials.presets.refresh')}</button>
     <button type="button" className="action-button" data-dial-preset-load disabled={!preset?.conversion.rows.length||busy||unavailable} onClick={load}>{t('studio.dials.presets.load')}</button>
    </div>
    {preset&&<ul data-dial-preset-rows={preset.name}>{preset.conversion.report.map(r=><li key={r.index} data-dial-preset-row={r.index} data-dial-preset-state={r.leftOut.length?'left-out':r.warnings.length?'warning':'ok'} className={r.leftOut.length?'is-disabled':''}>
     <div className="dial-preset-entry"><span className="lora-entry-name" title={r.dial}>{r.dial?dialLabel(r.dial):t('studio.dials.presets.row.unnamed',{index:String(r.index+1)})}</span><span>{summary(r.strength,r.curve,r.on)}</span></div>
     {r.leftOut.map(k=><small key={k} className="error-message" data-dial-preset-left={k}>{t('studio.dials.presets.leftOut')} {t(`studio.dials.presets.leftOut.${k}`)}</small>)}
     {r.changed.map(k=><small key={k} data-dial-preset-changed={k}>{t(`studio.dials.presets.changed.${k}`,{seconds:fmt(seconds)})}</small>)}
     {r.warnings.map(k=><small key={k} className="error-message" data-dial-preset-warning={k}>{t(`studio.dials.presets.warning.${k}`)}</small>)}
    </li>)}</ul>}
    {shown&&<p role="alert" className="error-message" data-dial-preset-error={shown.code||'other'}>{t(`studio.dials.presets.error.${shown.code||'other'}`)}{shown.detail&&detailed.includes(shown.code)&&<> <q>{shown.detail}</q></>}</p>}
    <p role="status" className="dial-preset-status" data-dial-preset-status>{status}</p>
    <p className="media-help">{t('studio.dials.presets.info')}</p>
   </section>
  </div>
 </dialog>,document.body);
}
