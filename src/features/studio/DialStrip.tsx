import { useId, useState, type CSSProperties, type Ref } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { DIAL_LEVEL, DIAL_ROWS, DIAL_SLIDER, DIAL_STEP, dialCurveOutline, dialLabel, dialName, dialStrength, type DialCurveConflict, type DialGate, type DialRow } from '../../lib/dials';
import type { H3DialCurve } from '../../lib/videoIntent';
import { dialMarks, dialOvercooked, dialSliderRange, dialStartStrength, type DialInfo, type DialInfoMap, type DialInfoState } from '../../lib/dialInfo';

/** Read-only picture of a row's time curve (authored corners over the clip); editing lives in the rack dialog. */
export function DialCurveThumb({curve,seconds,label}:{curve:H3DialCurve;seconds:number;label:string}){
 const {points,zero}=dialCurveOutline(curve,seconds),w=56,h=18,pad=2;
 const at=([x,y]:[number,number])=>`${(pad+x*(w-2*pad)).toFixed(1)},${(pad+y*(h-2*pad)).toFixed(1)}`;
 return <svg className="wb-dial-curve" data-dial-curve role="img" aria-label={label} viewBox={`0 0 ${w} ${h}`} width={w} height={h}><title>{label}</title>
  <line x1={pad} x2={w-pad} y1={pad+zero*(h-2*pad)} y2={pad+zero*(h-2*pad)}/><polyline points={points.map(at).join(' ')}/></svg>;
}

const fmt=(v:number)=>String(+v.toFixed(2));
/** The recorded strengths and their evidence in words, for one row. */
function DialFacts({info,over,id}:{info:DialInfo;over:number|null;id:string}){
 const {t}=useI18n();
 const sideText=(s:'pos'|'neg')=>{
  const parts=[info[s].useful!==null?t('studio.dials.info.useful',{value:fmt(info[s].useful!)}):'',info[s].overcook!==null?t('studio.dials.info.overcook',{value:fmt(info[s].overcook!)}):''].filter(Boolean);
  return parts.length?t(`studio.dials.info.${s}`,{text:parts.join(', ')}):'';
 };
 const sides=[sideText('pos'),sideText('neg')].filter(Boolean);
 return <small className="wb-dial-facts" id={id} data-dial-facts>
  {sides.length?<>{sides.join(' · ')} · <span data-dial-evidence={info.evidence??'none'}>{t(`studio.dials.info.evidence.${info.evidence??'none'}`)}</span></>:t('studio.dials.info.noStrengths')}
  {over!==null&&<span className="wb-dial-over" role="status" data-dial-over>{t('studio.dials.info.over',{value:fmt(over)})}</span>}
 </small>;
}


/**
 * Experimental Dial Rack strip (docs/DIALS.md): one line per dial. `files` are the dial files offered for adding,
 * `listed` every LoRA name the backend (or the library scan) lists, undefined while unread, `gate` the reason new rows cannot run here. A closed gate keeps the switch and
 * Remove usable, so a row that blocks Run can always be turned off. `conflicts` are the compiler's time-curve refusals for the next job
 * (`dialCurveConflicts`), shown as reasons. `onOpenRack` opens the full rack dialog; `rackRef` is its button, for returning focus. `onOpenPresets` opens the rack presets dialog.
 * `info` is what the dial files say about themselves (`dialInfo.ts`): a row with an entry shows its side labels under the slider's ends, ticks at the recorded
 * useful and overcook strengths, a slider reach that follows them, the strengths and the evidence in words and an expandable note; a new row starts at the
 * positive useful strength. A row without an entry keeps the fallbacks (file name, ±3). `infoStatus` `unavailable` adds a small note; it never disables anything.
 */
export function DialStrip({value,onChange,files,listed,gate,seconds,onRead,onOpenRack,rackRef,onOpenPresets,conflicts,info,infoStatus,onRefreshInfo}:{value:readonly DialRow[];onChange:(next:DialRow[])=>void;files:readonly string[];listed?:readonly string[];gate:DialGate;seconds:number;onRead?:()=>void;onOpenRack?:()=>void;rackRef?:Ref<HTMLButtonElement>;onOpenPresets?:()=>void;conflicts?:readonly DialCurveConflict[];info?:DialInfoMap;infoStatus?:DialInfoState['status'];onRefreshInfo?:()=>void}){
 const {t}=useI18n(),uid=useId();
 // Rows whose note (description, pipeline, notes of the dial file) is open, by dial name.
 const [noted,setNoted]=useState<readonly string[]>([]);
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
    onChange={e=>{if(e.target.value)onChange([...value,{dial:e.target.value,strength:dialStartStrength(info?.[e.target.value]),on:true}]);}}>
    <option value="">{t('studio.dials.add')}</option>{offered.map(f=><option key={f} value={f} title={f}>{dialLabel(f)}</option>)}</select>
   {onOpenRack&&<button ref={rackRef} type="button" className="wb-dock-action" data-dial-rack-open aria-haspopup="dialog" onClick={onOpenRack}>{t('studio.dials.openRack')}</button>}
   {onOpenPresets&&<button type="button" className="wb-dock-action" data-dial-presets-open aria-haspopup="dialog" onClick={onOpenPresets}>{t('studio.dials.presets.open')}</button>}
   {onRefreshInfo&&<button type="button" className="wb-dock-action" data-dial-info-refresh disabled={infoStatus==='loading'} onClick={onRefreshInfo}>{t('studio.dials.info.refresh')}</button>}
   {infoStatus==='unavailable'&&<small role="status" data-dial-info-state="unavailable">{t('studio.dials.info.unavailable')}</small>}
   {!gate&&full&&<small role="status">{addReason}</small>}
   {!gate&&listed&&!files.length&&<small data-dials-empty>{t('studio.dials.none')}</small>}
  </div>
  {value.length>0&&<ul className="wb-dial-rows" aria-label={t('studio.dials.rows')}>{value.map((row,index)=>{
   const name=dialLabel(row.dial),on=row.on!==false,missing=!!listed&&!listed.includes(dialName(row.dial));
   const about=info?.[dialName(row.dial)],range=about?dialSliderRange(about):{min:-DIAL_SLIDER,max:DIAL_SLIDER},over=dialOvercooked(about,row.strength);
   const noteText=about?[about.description,about.pipeline,about.notes].some(Boolean):false,open=noteText&&noted.includes(row.dial);
   const factsId=`${uid}facts${index}`,noteId=`${uid}note${index}`;
   return <li key={`${index}:${row.dial}`} className="wb-dial-row" data-dial-row={row.dial} data-dial-state={!on?'off':missing?'missing':'on'} data-dial-info={about?'known':undefined}>
    <input type="checkbox" data-dial="on" aria-label={t('studio.dials.on',{name})} checked={on} onChange={e=>patch(index,{on:e.target.checked})}/>
    <span className="wb-dial-name" title={row.dial}>{name}</span>
    {noteText&&<button type="button" className="wb-dock-action wb-dial-about" data-dial="about" aria-expanded={open} aria-controls={noteId} aria-label={t('studio.dials.info.about',{name})} title={about!.description||t('studio.dials.info.about',{name})}
     onClick={()=>setNoted(old=>old.includes(row.dial)?old.filter(d=>d!==row.dial):[...old,row.dial])}>i</button>}
    {missing&&<small role="alert" data-dial-missing>{t('studio.dials.missing')}</small>}
    <span className="wb-dial-slide">
     <span className="wb-dial-track">
      <input type="range" data-dial="slider" aria-label={t('studio.dials.strength',{name})} aria-describedby={about?factsId:undefined} disabled={!!gate} min={range.min} max={range.max} step={DIAL_STEP} value={Math.min(range.max,Math.max(range.min,row.strength))} onChange={e=>{setDraft(null);strength(index,e.target.value);}}/>
      {dialMarks(about).map(m=><i key={`${m.side}${m.kind}`} className="wb-dial-mark" data-dial-mark={`${m.side}-${m.kind}`} data-dial-mark-at={fmt(m.strength)} style={{'--at':m.at} as CSSProperties} title={`${t(`studio.dials.info.${m.kind}`,{value:fmt(m.value)})} (${fmt(m.strength)})`}/>)}
     </span>
     {about&&(about.negative||about.positive)&&<span className="wb-dial-sides" data-dial-sides>
      <span data-dial-side="neg" title={t('studio.dials.info.negative',{label:about.negative||'—'})}>{about.negative}</span>
      <span data-dial-side="pos" title={t('studio.dials.info.positive',{label:about.positive||'—'})}>{about.positive}</span></span>}
    </span>
    <input type="number" data-dial="strength" aria-label={t('studio.dials.strengthExact',{name})} disabled={!!gate} min={-DIAL_LEVEL} max={DIAL_LEVEL} step={DIAL_STEP} value={draft?.index===index?draft.text:row.strength}
     onChange={e=>{setDraft({index,text:e.target.value});strength(index,e.target.value);}} onBlur={()=>setDraft(null)}/>
    {/* Fixed slot, so the sliders of rows with and without a curve line up. */}
    <span className="wb-dial-curve-slot">{row.time&&<DialCurveThumb curve={row.time} seconds={seconds} label={t('studio.dials.curve',{name,count:String(row.time.points.length)})}/>}</span>
    <button type="button" className="wb-dock-action" data-dial="remove" aria-label={t('studio.dials.remove',{name})} title={t('studio.dials.remove',{name})} onClick={()=>{setDraft(null);onChange(value.filter((_,i)=>i!==index));}}>×</button>
    {about&&<DialFacts info={about} over={over} id={factsId}/>}
    {open&&<div className="wb-dial-note" id={noteId} data-dial-note>
     {about!.description&&<p data-dial-note-part="description">{about!.description}</p>}
     {about!.pipeline&&<p data-dial-note-part="pipeline">{t('studio.dials.info.pipeline',{text:about!.pipeline})}</p>}
     {about!.notes&&<p data-dial-note-part="notes">{t('studio.dials.info.notes',{text:about!.notes})}</p>}
    </div>}
   </li>;})}</ul>}
  <p className="wb-dials-hint">{t('studio.dials.hint')}</p>
 </fieldset>;
}
