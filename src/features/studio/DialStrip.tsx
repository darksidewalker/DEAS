import { useState, type Ref } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { DIAL_LEVEL, DIAL_ROWS, DIAL_SLIDER, DIAL_STEP, dialCurveOutline, dialLabel, dialName, dialStrength, type DialCurveConflict, type DialGate, type DialRow } from '../../lib/dials';
import type { H3DialCurve } from '../../lib/videoIntent';

/** Read-only picture of a row's time curve (authored corners over the clip); editing lives in the rack dialog. */
export function DialCurveThumb({curve,seconds,label}:{curve:H3DialCurve;seconds:number;label:string}){
 const {points,zero}=dialCurveOutline(curve,seconds),w=56,h=18,pad=2;
 const at=([x,y]:[number,number])=>`${(pad+x*(w-2*pad)).toFixed(1)},${(pad+y*(h-2*pad)).toFixed(1)}`;
 return <svg className="wb-dial-curve" data-dial-curve role="img" aria-label={label} viewBox={`0 0 ${w} ${h}`} width={w} height={h}><title>{label}</title>
  <line x1={pad} x2={w-pad} y1={pad+zero*(h-2*pad)} y2={pad+zero*(h-2*pad)}/><polyline points={points.map(at).join(' ')}/></svg>;
}

/**
 * Experimental Dial Rack strip (docs/DIALS.md): one line per dial. `files` are the dial files offered for adding,
 * `listed` every LoRA name the backend (or the library scan) lists, undefined while unread, `gate` the reason new rows cannot run here. A closed gate keeps the switch and
 * Remove usable, so a row that blocks Run can always be turned off. `conflicts` are the compiler's time-curve refusals for the next job
 * (`dialCurveConflicts`), shown as reasons. `onOpenRack` opens the full rack dialog; `rackRef` is its button, for returning focus. `onOpenPresets` opens the rack presets dialog.
 */
export function DialStrip({value,onChange,files,listed,gate,seconds,onRead,onOpenRack,rackRef,onOpenPresets,conflicts}:{value:readonly DialRow[];onChange:(next:DialRow[])=>void;files:readonly string[];listed?:readonly string[];gate:DialGate;seconds:number;onRead?:()=>void;onOpenRack?:()=>void;rackRef?:Ref<HTMLButtonElement>;onOpenPresets?:()=>void;conflicts?:readonly DialCurveConflict[]}){
 const {t}=useI18n();
 // A half-typed number ("-", "1.") stays in the field without rewriting the row.
 const [draft,setDraft]=useState<{index:number;text:string}|null>(null);
 const patch=(index:number,next:Partial<DialRow>)=>onChange(value.map((r,i)=>i===index?{...r,...next}:r));
 const strength=(index:number,text:string)=>{const n=dialStrength(text);if(n!==undefined)patch(index,{strength:n});};
 const offered=files.filter(f=>!value.some(r=>dialName(r.dial)===f));
 const full=value.length>=DIAL_ROWS;
 const addReason=gate?t(`studio.dials.reason.${gate}`):full?t('studio.dials.full',{count:String(DIAL_ROWS)}):'';
 return <fieldset className="wb-group wb-dials" data-dials={gate||'ready'}><legend>{t('studio.dials.title')}</legend>
  {gate&&<p className="wb-dials-reason" role="status" data-dials-reason={gate}>{t(`studio.dials.reason.${gate}`)}</p>}
  {!!conflicts?.length&&<ul className="wb-dials-conflicts" data-dial-conflicts aria-label={t('studio.dials.conflicts')}>{conflicts.map(c=><li key={c} data-dial-conflict={c}>{t(`studio.dials.conflict.${c}`)}</li>)}</ul>}
  <div className="wb-dials-add">
   <select data-dial-add aria-label={t('studio.dials.add')} value="" disabled={!!gate||full||!offered.length} title={addReason||undefined} onFocus={onRead} onPointerDown={onRead}
    onChange={e=>{if(e.target.value)onChange([...value,{dial:e.target.value,strength:1,on:true}]);}}>
    <option value="">{t('studio.dials.add')}</option>{offered.map(f=><option key={f} value={f} title={f}>{dialLabel(f)}</option>)}</select>
   {onOpenRack&&<button ref={rackRef} type="button" className="wb-dock-action" data-dial-rack-open aria-haspopup="dialog" onClick={onOpenRack}>{t('studio.dials.openRack')}</button>}
   {onOpenPresets&&<button type="button" className="wb-dock-action" data-dial-presets-open aria-haspopup="dialog" onClick={onOpenPresets}>{t('studio.dials.presets.open')}</button>}
   {!gate&&full&&<small role="status">{addReason}</small>}
   {!gate&&listed&&!files.length&&<small data-dials-empty>{t('studio.dials.none')}</small>}
  </div>
  {value.length>0&&<ul className="wb-dial-rows" aria-label={t('studio.dials.rows')}>{value.map((row,index)=>{
   const name=dialLabel(row.dial),on=row.on!==false,missing=!!listed&&!listed.includes(dialName(row.dial));
   return <li key={`${index}:${row.dial}`} className="wb-dial-row" data-dial-row={row.dial} data-dial-state={!on?'off':missing?'missing':'on'}>
    <input type="checkbox" data-dial="on" aria-label={t('studio.dials.on',{name})} checked={on} onChange={e=>patch(index,{on:e.target.checked})}/>
    <span className="wb-dial-name" title={row.dial}>{name}</span>
    {missing&&<small role="alert" data-dial-missing>{t('studio.dials.missing')}</small>}
    <input type="range" data-dial="slider" aria-label={t('studio.dials.strength',{name})} disabled={!!gate} min={-DIAL_SLIDER} max={DIAL_SLIDER} step={DIAL_STEP} value={Math.min(DIAL_SLIDER,Math.max(-DIAL_SLIDER,row.strength))} onChange={e=>{setDraft(null);strength(index,e.target.value);}}/>
    <input type="number" data-dial="strength" aria-label={t('studio.dials.strengthExact',{name})} disabled={!!gate} min={-DIAL_LEVEL} max={DIAL_LEVEL} step={DIAL_STEP} value={draft?.index===index?draft.text:row.strength}
     onChange={e=>{setDraft({index,text:e.target.value});strength(index,e.target.value);}} onBlur={()=>setDraft(null)}/>
    {/* Fixed slot, so the sliders of rows with and without a curve line up. */}
    <span className="wb-dial-curve-slot">{row.time&&<DialCurveThumb curve={row.time} seconds={seconds} label={t('studio.dials.curve',{name,count:String(row.time.points.length)})}/>}</span>
    <button type="button" className="wb-dock-action" data-dial="remove" aria-label={t('studio.dials.remove',{name})} title={t('studio.dials.remove',{name})} onClick={()=>{setDraft(null);onChange(value.filter((_,i)=>i!==index));}}>×</button>
   </li>;})}</ul>}
  <p className="wb-dials-hint">{t('studio.dials.hint')}</p>
 </fieldset>;
}
