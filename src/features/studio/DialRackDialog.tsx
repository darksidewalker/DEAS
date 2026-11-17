import { useCallback, useEffect, useId, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { DIAL_BLEND_STEPS, DIAL_LEVEL, dialBlendSteps, dialLabel, dialName, type DialCurveConflict, type DialGate, type DialRow } from '../../lib/dials';
import { DIAL_LEVEL_SNAP, DIAL_SNAP, dialCurveText, dialFrameLevels, dialPresets, latentFrameStarts, nearPoint, parseDialCurveText, rackReduce, rackState, sampleDialCurve, widestGap, type CurveLimits, type DialTimeline, type RackAction, type RackState } from '../../lib/dialCurve';
import type { H3DialCurve } from '../../lib/videoIntent';
import { DialStrip } from './DialStrip';
import { DialPresetsDialog } from './DialPresetsDialog';
import type { DialPresetStore } from '../../lib/dialPresets';
import { dialInfoSteps, dialNoCurve, type DialInfoMap, type DialInfoState, type DialPipeline } from '../../lib/dialInfo';
import './continuity-overlay.css';
import './dial-rack.css';

/** Copy / Paste fallback while the dialog's page lives, for WebViews that block the clipboard. */
let inPageCurve='';
const fmt=(v:number,digits=2)=>String(+v.toFixed(digits));
const pct=(v:number)=>`${(v*100).toFixed(3)}%`;
/**
 * Refusals that depend on what the job is, not on the curve: editing a curve cannot resolve them, removing it can. `preDial` is about one row
 * only: it locks that row's lane (`dialNoCurve` below), not every lane.
 */
const blocksEditing=(c:DialCurveConflict)=>c!=='blendSteps'&&c!=='curveLimits'&&c!=='preDial';

/** Lane picture: the curve as the node samples it (`sampleDialCurve`), in a 1000 × 100 box stretched to the lane. */
function curvePath(curve:Pick<H3DialCurve,'points'|'interp'|'smooth'>,from:number,to:number,lo:number,hi:number){
 const x=(t:number)=>((t-from)/(to-from)*1000).toFixed(2),y=(l:number)=>((hi-l)/(hi-lo)*100).toFixed(2);
 const inside=curve.points.map(q=>q[0]).filter(t=>t>from&&t<to);
 // A step curve jumps at each point: sample just before it too, so the jump is drawn vertical.
 const times=[...new Set([...Array.from({length:201},(_,i)=>from+(to-from)*i/200),...inside,...(curve.interp==='step'?inside.map(t=>t-1e-9):[])])].sort((a,b)=>a-b);
 return sampleDialCurve(curve,times).map((l,i)=>`${i?'L':'M'}${x(times[i])} ${y(l)}`).join('');
}

/**
 * Experimental Dial Rack dialog (docs/DIALS.md): the strip's rows and one timeline with a lane per row over shared seconds. The selected lane
 * is edited (click adds a point, drag moves it, keys nudge and delete); the others are drawn dimmed. Every change goes through `rackReduce`,
 * so the strip's edits and the curve edits share one undo history while the dialog is open. `conflicts` are the compiler's time-curve refusals
 * for the next job (`dialCurveConflicts`); with one that editing cannot resolve the curve tools are disabled and only Remove curve stays.
 * `info` is the dial files' own info and `pipeline` the pack's key for the pipeline in use: the selected lane's pipeline text and notes are shown
 * beside the blend steps, and a new curve is authored with the blend steps the file records for that pipeline (never more than the job's steps).
 */
export function DialRackDialog({value,onChange,files,listed,gate,onRead,timeline,steps,conflicts,onClose,endpoint,presetStore,info,infoStatus,onRefreshInfo,pipeline}:{value:readonly DialRow[];onChange:(next:DialRow[])=>void;files:readonly string[];listed?:readonly string[];gate:DialGate;onRead?:()=>void;timeline:DialTimeline;steps:number;conflicts:readonly DialCurveConflict[];onClose:()=>void;endpoint?:string;presetStore?:DialPresetStore;info?:DialInfoMap;infoStatus?:DialInfoState['status'];onRefreshInfo?:()=>void;pipeline?:DialPipeline}){
 const {t}=useI18n();
 const dialogRef=useRef<HTMLDialogElement>(null),closeRef=useRef<HTMLButtonElement>(null),plot=useRef<HTMLDivElement>(null),titleId=useId(),helpId=useId();
 const state=useRef<RackState>(rackState(value));
 const [,redraw]=useReducer((n:number)=>n+1,0);
 // Rows changed outside the dialog (settings applied while it is open): adopt them; the dialog's own changes come back as the same list.
 if(state.current.rows!==value)state.current=JSON.stringify(state.current.rows)===JSON.stringify(value)?{...state.current,rows:value}:rackReduce({...state.current,tag:''},{type:'rows',rows:value});
 const s=state.current;
 const dispatch=(a:RackAction)=>{
  const before=state.current,next=rackReduce(before,a);
  if(next===before)return false;
  state.current=next;redraw();
  if(next.rows!==before.rows)onChange(next.rows as DialRow[]);
  return true;
 };
 // Stable, so the strip's commit listeners are not re-attached on every draw.
 const endGesture=useCallback(()=>{state.current=rackReduce(state.current,{type:'gesture'});},[]);
 const [range,setRange]=useState({lo:0,hi:1});
 const [hover,setHover]=useState<{t:number;level:number}|null>(null);
 const [note,setNote]=useState('');
 const [presetsOpen,setPresetsOpen]=useState(false);
 const [draft,setDraft]=useState<{field:string;text:string}|null>(null);
 const drag=useRef<{point:number;tag:string;x:number;y:number;moved:boolean}|null>(null),gesture=useRef(0),focusPoint=useRef(false);
 useEffect(()=>{
  const dialog=dialogRef.current!;
  dialog.showModal();
  closeRef.current?.focus();
  return()=>{if(dialog.open)dialog.close();};
 },[]);
 useEffect(()=>{
  if(!focusPoint.current)return;
  focusPoint.current=false;
  plot.current?.querySelector<HTMLElement>(`[data-dial-point="${state.current.point}"]`)?.focus();
 });
 const dismiss=()=>{if(dialogRef.current?.open)dialogRef.current.close();onClose();};

 const row=s.rows[s.row],curve=row?.time,name=row?dialLabel(row.dial):'';
 const blocking=conflicts.filter(blocksEditing);
 // A pre-refiner dial (the pack's catalog says so) takes no time curve: the node refuses it. Its lane keeps Remove curve, like any refusal.
 const pre=!!row&&dialNoCurve(info?.[dialName(row.dial)]);
 const locked=!!gate||blocking.length>0||pre;
 const lockReason=gate?t(`studio.dials.reason.${gate}`):blocking.length?t(`studio.dials.conflict.${blocking[0]}`):pre?t('studio.dials.rack.preDial',{name}):'';
 // Shown seconds: the lane, widened to points authored for a longer piece.
 const times=s.rows.flatMap(r=>r.time?.points.map(q=>q[0])??[]);
 const from=Math.min(0,...times),to=Math.max(timeline.seconds,...times,from+0.5);
 const levels=curve?.points.map(q=>q[1])??[];
 const lo=Math.min(range.lo,...levels),hi=Math.max(range.hi,...levels);
 const lim:CurveLimits={from:0,to:Math.floor(timeline.seconds*1e4)/1e4,lo,hi,edges:timeline.edges};
 const xOf=(time:number)=>(time-from)/(to-from),yOf=(level:number,a=lo,b=hi)=>(b-level)/(b-a);
 const fallback=dialBlendSteps(steps);
 // What the selected lane's dial file says: its blend steps for the pipeline in use (as recorded, and cut to the job's steps) and its texts.
 const about=row?info?.[dialName(row.dial)]:undefined,measured=pipeline?about?.pipelines?.[pipeline]:undefined;
 const fileSteps=dialInfoSteps(about,pipeline,steps);
 const fmtN=(v:number|null)=>v===null?'':fmt(v);
 const say=(key:string)=>setNote(t(key));

 const at=(e:{clientX:number;clientY:number})=>{
  const r=plot.current!.getBoundingClientRect();
  const x=Math.min(1,Math.max(0,(e.clientX-r.left)/(r.width||1))),y=Math.min(1,Math.max(0,(e.clientY-r.top)/(r.height||1)));
  return {t:from+x*(to-from),level:hi-y*(hi-lo)};
 };
 const down=(e:ReactPointerEvent<HTMLDivElement>)=>{
  if(locked||!curve||e.button!==0)return;
  const hit=(e.target as HTMLElement).closest<HTMLElement>('[data-dial-point]');
  let point=hit?Number(hit.dataset.dialPoint):-1;
  if(point<0){
   const p=at(e);
   point=nearPoint(curve,p.t);
   // A click within one latent frame of a point takes that point; elsewhere it adds one and keeps dragging it.
   if(point<0){if(!dispatch({type:'add',t:p.t,level:p.level,lim}))return;point=state.current.point;}
  }
  dispatch({type:'select',row:s.row,point});
  focusPoint.current=true;
  drag.current={point,tag:`drag:${++gesture.current}`,x:e.clientX,y:e.clientY,moved:false};
  e.currentTarget.setPointerCapture?.(e.pointerId);
  e.preventDefault();
 };
 const move=(e:ReactPointerEvent<HTMLDivElement>)=>{
  if(!curve)return;
  const p=at(e),d=drag.current;
  setHover(p);
  if(!d)return;
  // A plain click selects without moving the point onto the grid.
  if(!d.moved&&Math.hypot(e.clientX-d.x,e.clientY-d.y)<3)return;
  d.moved=true;
  dispatch({type:'move',point:d.point,t:p.t,level:p.level,lim:e.altKey?{...lim,snap:0}:lim,tag:d.tag});
 };
 const up=(e:ReactPointerEvent<HTMLDivElement>)=>{drag.current=null;e.currentTarget.releasePointerCapture?.(e.pointerId);};
 const pointKey=(e:ReactKeyboardEvent<HTMLButtonElement>,index:number)=>{
  if(locked||!curve)return;
  const big=e.shiftKey?10:1;
  const nudge=({ArrowLeft:[-DIAL_SNAP,0],ArrowRight:[DIAL_SNAP,0],ArrowUp:[0,DIAL_LEVEL_SNAP],ArrowDown:[0,-DIAL_LEVEL_SNAP]} as Record<string,[number,number]>)[e.key];
  if(nudge){e.preventDefault();dispatch({type:'nudge',point:index,dt:nudge[0]*big,dl:nudge[1]*big,lim});}
  else if(e.key==='Delete'||e.key==='Backspace'){
   e.preventDefault();
   if(!dispatch({type:'remove',point:index})){say('studio.dials.rack.keepTwo');return;}
   dispatch({type:'select',row:state.current.row,point:Math.min(index,curve.points.length-2)});
   focusPoint.current=true;
  }
 };
 const history=(e:ReactKeyboardEvent<HTMLDialogElement>)=>{
  if(!(e.ctrlKey||e.metaKey)||(e.target as HTMLElement).matches('input[type="number"], input[type="text"], textarea'))return;
  const key=e.key.toLowerCase();
  if(key==='z'){e.preventDefault();dispatch({type:e.shiftKey?'redo':'undo'});}
  else if(key==='y'){e.preventDefault();dispatch({type:'redo'});}
 };
 const copy=async()=>{
  if(!curve)return;
  inPageCurve=dialCurveText(curve);
  try{await navigator.clipboard.writeText(inPageCurve);say('studio.dials.rack.copied');}
  catch{say('studio.dials.rack.copiedHere');}
 };
 const paste=async()=>{
  // The in-page copy stands in only when the clipboard itself cannot be read.
  let text=inPageCurve;
  try{text=await navigator.clipboard.readText();}catch{text=inPageCurve;}
  const pasted=parseDialCurveText(text,timeline.seconds);
  if(pasted&&dispatch({type:'paste',curve:pasted}))say('studio.dials.rack.pasted');
  else say(pasted?'studio.dials.rack.pasted':'studio.dials.rack.pasteNone');
 };
 const typed=(field:'time'|'level',text:string)=>{
  setDraft({field,text});
  const n=Number(text),q=curve?.points[s.point];
  if(!text.trim()||!Number.isFinite(n)||!q)return;
  dispatch({type:'move',point:s.point,t:field==='time'?n:q[0],level:field==='level'?n:q[1],lim:{...lim,snap:0},tag:`typed:${field}:${s.row}:${s.point}`});
 };
 const bound=(side:'lo'|'hi',text:string)=>{
  setDraft({field:side,text});
  const n=Number(text);
  if(text.trim()&&Number.isFinite(n))setRange(r=>side==='lo'?{...r,lo:Math.min(0,Math.max(-DIAL_LEVEL,n))}:{...r,hi:Math.max(1,Math.min(DIAL_LEVEL,n))});
 };
 const blend=(text:string)=>{
  setDraft({field:'steps',text});
  const n=Number(text);
  if(!text.trim())dispatch({type:'set',patch:{steps:null}});
  else if(Number.isInteger(n)&&n>=1&&n<=DIAL_BLEND_STEPS)dispatch({type:'set',patch:{steps:n},tag:`steps:${s.row}`});
 };
 const shown=(field:string,v:string|number)=>draft?.field===field?draft.text:v;

 const selected=curve?.points[s.point];
 const read=drag.current||!hover?selected?{t:selected[0],level:selected[1]}:hover:hover;
 const strengthOf=(level:number)=>fmt(level*(row?.strength??0),3);
 const seconds=fmt(timeline.seconds,3);
 // Seconds grid: at most about a dozen labels.
 const every=[1,2,5,10,30,60,300,900,3600,7200,14400,43200].find(n=>(to-from)/n<=12)??86400;
 const marks=Array.from({length:Math.floor((to-Math.ceil(from/every)*every)/every+1e-9)+1},(_,i)=>Math.ceil(from/every)*every+i*every);
 // Latent-frame edges of the first clip; a continued segment's frames start at its own hidden context window. On a plan that continues an
 // existing clip (`planSource`) the next clip's window starts at a piece time Studio does not hold: neither the ticks nor the per-latent-frame
 // line would be the frames the model gets, so they are not drawn (and `dialCurveConflicts` holds the curves, `pieceStart`).
 const placed=timeline.basis!=='planSource';
 const ticks=placed?latentFrameStarts(timeline.basis==='plan'?Math.round((timeline.edges[0]??timeline.seconds)*24):timeline.frames).map(f=>f/24):[];
 const frames=curve&&timeline.basis==='clip'?dialFrameLevels(curve,timeline.frames):[];
 const tool=(key:string,action:()=>void,o:{disabled?:boolean;data?:string}={})=><button type="button" className="wb-dock-action" data-dial-tool={o.data??key} disabled={o.disabled} title={o.disabled&&lockReason?lockReason:undefined} onClick={()=>{setNote('');action();}}>{t(`studio.dials.rack.${key}`)}</button>;

 return <dialog ref={dialogRef} className="continuity-overlay dial-rack" data-dial-rack aria-labelledby={titleId} onKeyDown={history} onCancel={e=>{e.preventDefault();dismiss();}}>
  <header className="continuity-overlay-header"><h2 id={titleId}>{t('studio.dials.rack.title')}</h2>
   <button ref={closeRef} type="button" data-dial-rack-close onClick={dismiss}>{t('studio.close')}</button>
  </header>
  <div className="continuity-overlay-body dial-rack-body">
   <DialStrip value={s.rows} onChange={rows=>dispatch({type:'rows',rows})} onCommit={endGesture} files={files} listed={listed} gate={gate} seconds={timeline.seconds} onRead={onRead} conflicts={conflicts} info={info} infoStatus={infoStatus} onRefreshInfo={onRefreshInfo} onOpenPresets={endpoint===undefined?undefined:()=>setPresetsOpen(true)}/>
   <section className="dial-rack-timeline" data-dial-timeline={timeline.basis} aria-label={t('studio.dials.rack.timeline')}>
    <h3>{t('studio.dials.rack.timeline')} · {t('studio.dials.rack.length',{seconds})}</h3>
    {timeline.basis!=='clip'&&<p className="dial-rack-help" data-dial-basis={timeline.basis}>{t(`studio.dials.rack.basis.${timeline.basis}`,{seconds})}</p>}
    {!s.rows.length?<p className="dial-rack-help" data-dial-rack-empty>{t('studio.dials.rack.empty')}</p>:<>
     <div className="dial-rack-tools" role="group" aria-label={t('studio.dials.rack.tools',{name})}>
      <strong className="dial-rack-selected" title={row?.dial}>{name}</strong>
      {curve?tool('removeCurve',()=>dispatch({type:'removeCurve'})):tool('addCurve',()=>dispatch({type:'addCurve',seconds:timeline.seconds,steps:fileSteps}),{disabled:locked})}
      {dialPresets.map(preset=><span key={preset}>{tool(`preset.${preset}`,()=>dispatch({type:'preset',name:preset,seconds:timeline.seconds,steps:fileSteps}),{disabled:locked})}</span>)}
      {tool('addPoint',()=>{const middle=curve&&widestGap(curve,lim);if(middle==null||!dispatch({type:'add',t:middle,level:sampleDialCurve(curve!,[middle])[0],lim}))say('studio.dials.rack.noRoom');else focusPoint.current=true;},{disabled:locked||!curve})}
      {tool('copy',()=>void copy(),{disabled:!curve})}
      {tool('paste',()=>void paste(),{disabled:locked})}
      {tool('undo',()=>dispatch({type:'undo'}),{disabled:!s.past.length})}
      {tool('redo',()=>dispatch({type:'redo'}),{disabled:!s.future.length})}
     </div>
     {locked&&<p className="dial-rack-locked" role="status" data-dial-rack-locked>{t('studio.dials.rack.locked')} {lockReason}</p>}
     {curve&&<div className="dial-rack-tools dial-rack-settings">
      <label>{t('studio.dials.rack.interp')}<select data-dial-interp disabled={locked} value={curve.interp??'linear'} onChange={e=>dispatch({type:'set',patch:{interp:e.target.value as 'linear'|'step'}})}>
       <option value="linear">{t('studio.dials.rack.interp.linear')}</option><option value="step">{t('studio.dials.rack.interp.step')}</option></select></label>
      <label title={t('studio.dials.rack.smoothHelp')}>{t('studio.dials.rack.smooth')}<input type="range" data-dial-smooth min={0} max={1} step={0.05} disabled={locked||curve.interp==='step'} value={curve.smooth??0} onChange={e=>dispatch({type:'set',patch:{smooth:Number(e.target.value)},tag:`smooth:${s.row}`})}/><output>{fmt(curve.smooth??0)}</output></label>
      <label title={t('studio.dials.rack.stepsHelp')}>{t('studio.dials.rack.steps')}<input type="number" data-dial-steps min={1} max={Math.min(steps,DIAL_BLEND_STEPS)} step={1} placeholder={String(fallback)} disabled={!!gate} value={shown('steps',curve.steps??'')} onChange={e=>blend(e.target.value)} onBlur={()=>setDraft(null)}/></label>
      <small data-dial-steps-default>{t(curve.steps===undefined?'studio.dials.rack.stepsDefault':'studio.dials.rack.stepsAuthored',{count:String(curve.steps??fallback),fallback:String(fallback),steps:String(steps)})}</small>
      {fileSteps!==undefined&&<small data-dial-steps-file={fileSteps}>{t(measured!.steps!>steps?'studio.dials.rack.stepsFileCut':'studio.dials.rack.stepsFile',{value:String(measured!.steps),count:String(fileSteps),steps:String(steps),pipeline:t(`studio.dials.pipeline.${pipeline}`)})}</small>}
      {fileSteps!==undefined&&curve.steps!==fileSteps&&<button type="button" className="wb-dock-action" data-dial-steps-use disabled={!!gate} onClick={()=>{setDraft(null);dispatch({type:'set',patch:{steps:fileSteps}});}}>{t('studio.dials.rack.stepsUse',{count:String(fileSteps)})}</button>}
      <label title={t('studio.dials.rack.audioHelp')}>{t('studio.dials.rack.audio')}<select data-dial-audio disabled={locked} value={curve.audio??'follow'} onChange={e=>dispatch({type:'set',patch:{audio:e.target.value as 'follow'|'protect'}})}>
       <option value="follow">{t('studio.dials.rack.audio.follow')}</option><option value="protect">{t('studio.dials.rack.audio.protect')}</option></select></label>
      <label title={t('studio.dials.rack.rangeHelp')}>{t('studio.dials.rack.lowest')}<input type="number" data-dial-range="lo" min={-DIAL_LEVEL} max={0} step={0.5} value={shown('lo',lo)} onChange={e=>bound('lo',e.target.value)} onBlur={()=>setDraft(null)}/></label>
      <label title={t('studio.dials.rack.rangeHelp')}>{t('studio.dials.rack.highest')}<input type="number" data-dial-range="hi" min={1} max={DIAL_LEVEL} step={0.5} value={shown('hi',hi)} onChange={e=>bound('hi',e.target.value)} onBlur={()=>setDraft(null)}/></label>
     </div>}
     {about&&<section className="dial-rack-info" data-dial-rack-info={row!.dial} aria-label={t('studio.dials.rack.info.title',{name})}>
      <h4>{t('studio.dials.rack.info.title',{name})}</h4>
      {about.pipeline&&<p data-dial-rack-info-part="pipeline">{t('studio.dials.info.pipeline',{text:about.pipeline})}</p>}
      {about.notes&&<p data-dial-rack-info-part="notes">{t('studio.dials.info.notes',{text:about.notes})}</p>}
      {measured&&<p data-dial-rack-info-part="measured">{t('studio.dials.rack.info.measured',{pipeline:t(`studio.dials.pipeline.${pipeline}`)})} {[measured.useful!==null?t('studio.dials.info.useful',{value:fmtN(measured.useful)}):'',measured.overcook!==null?t('studio.dials.info.overcook',{value:fmtN(measured.overcook)}):'',measured.steps?t('studio.dials.rack.info.steps',{count:String(measured.steps)}):'',t(`studio.dials.info.evidence.${measured.evidence??'none'}`),measured.notes].filter(Boolean).join(' · ')}</p>}
      {about.description&&<p data-dial-rack-info-part="description">{about.description}</p>}
      {!about.pipeline&&!about.notes&&!measured&&!about.description&&<p data-dial-rack-info-part="none">{t('studio.dials.rack.info.none')}</p>}
     </section>}
     <div className="dial-lanes" role="list" aria-label={t('studio.dials.rack.lanes')}>
      {s.rows.map((r,i)=>{
       const active=i===s.row,label=dialLabel(r.dial),c=r.time,own=c?.points.map(q=>q[1])??[];
       const a=active?lo:Math.min(0,...own),b=active?hi:Math.max(1,...own);
       return <div key={`${i}:${r.dial}`} role="listitem" className="dial-lane" data-dial-lane={r.dial} data-selected={active} data-dial-state={r.on===false?'off':'on'} data-dial-curved={!!c}>
        <button type="button" className="dial-lane-name" aria-pressed={active} title={r.dial} onClick={()=>dispatch({type:'select',row:i})}><span>{label}</span><small>{t(c?'studio.dials.rack.laneCurve':'studio.dials.rack.laneConstant',{count:String(c?.points.length??0),strength:fmt(r.strength,3)})}</small></button>
        <div className="dial-lane-track" data-dial-track={active?'selected':'dimmed'} aria-describedby={active?helpId:undefined}
         onPointerDown={active?down:()=>dispatch({type:'select',row:i})} onPointerMove={active?move:undefined} onPointerUp={active?up:undefined} onPointerCancel={active?up:undefined} onPointerLeave={active?()=>setHover(null):undefined}
         onDoubleClick={active&&!locked?e=>{const hit=(e.target as HTMLElement).closest<HTMLElement>('[data-dial-point]');if(hit&&!dispatch({type:'remove',point:Number(hit.dataset.dialPoint)}))say('studio.dials.rack.keepTwo');}:undefined}>
         <div className="dial-lane-plot" ref={active?plot:undefined}>
          {to>timeline.seconds+1e-3&&<span className="dial-lane-beyond" style={{left:pct(xOf(timeline.seconds))}}/>}
          {timeline.edges.map(edge=><span key={edge} className="dial-lane-edge" data-dial-edge style={{left:pct(xOf(edge))}}/>)}
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
           {a<0&&<line className="dial-lane-zero" x1={0} x2={1000} y1={yOf(0,a,b)*100} y2={yOf(0,a,b)*100}/>}
           {active&&frames.length>0&&<path className="dial-lane-frames" data-dial-frames d={frames.map((f,k)=>`${k?'L':'M'}${(xOf(f.start)*1000).toFixed(2)} ${(yOf(f.level)*100).toFixed(2)}H${(xOf(f.end)*1000).toFixed(2)}`).join('')}/>}
           <path className="dial-lane-curve" data-dial-lane-curve d={curvePath(c??{points:[[from,1]]},from,to,a,b)}/>
          </svg>
          {active&&c&&c.points.map((q,k)=><button key={k} type="button" className="dial-point" data-dial-point={k} disabled={locked} aria-pressed={k===s.point}
           aria-label={t('studio.dials.rack.point',{index:String(k+1),count:String(c.points.length),time:fmt(q[0],3),level:fmt(q[1],3)})} style={{left:pct(xOf(q[0])),top:pct(yOf(q[1]))}}
           onFocus={()=>{if(state.current.point!==k)dispatch({type:'select',row:i,point:k});}} onKeyDown={e=>pointKey(e,k)}/>)}
         </div>
        </div>
       </div>;})}
     </div>
     <div className="dial-lane dial-axis" aria-hidden="true"><span/>
      <div className="dial-axis-track"><div className="dial-lane-plot">
       {ticks.filter(tick=>tick<=to+1e-9).map(tick=><i key={tick} data-dial-tick style={{left:pct(xOf(tick))}}/>)}
       {marks.map(mark=><b key={mark} data-dial-second style={{left:pct(xOf(mark))}}>{mark}</b>)}
      </div></div>
     </div>
     <div className="dial-rack-tools dial-rack-point">
      {curve&&<><label>{t('studio.dials.rack.time')}<input type="number" data-dial-point-time step={DIAL_SNAP} min={0} max={lim.to} disabled={locked||!selected} value={shown('time',selected?selected[0]:'')} onChange={e=>typed('time',e.target.value)} onBlur={()=>setDraft(null)}/></label>
      <label>{t('studio.dials.rack.level')}<input type="number" data-dial-point-level step={DIAL_LEVEL_SNAP} min={lo} max={hi} disabled={locked||!selected} value={shown('level',selected?selected[1]:'')} onChange={e=>typed('level',e.target.value)} onBlur={()=>setDraft(null)}/></label>
      {tool('deletePoint',()=>{if(!dispatch({type:'remove',point:s.point}))say('studio.dials.rack.keepTwo');},{disabled:locked||!selected})}</>}
      <output className="dial-rack-readout" data-dial-readout>{read&&curve?t(read.level>=0&&read.level<=1?'studio.dials.rack.readout':'studio.dials.rack.readoutOutside',{time:fmt(read.t),level:fmt(read.level),strength:strengthOf(read.level)}):t(curve?'studio.dials.rack.readoutNone':'studio.dials.rack.readoutConstant',{strength:strengthOf(1)})}</output>
     </div>
     <p className="dial-rack-note" role="status" data-dial-rack-note>{note}</p>
    </>}
    <p className="dial-rack-help" id={helpId}>{t('studio.dials.rack.help.keys')}</p>
    {placed&&<p className="dial-rack-help" data-dial-help="resolution">{t('studio.dials.rack.help.resolution')}</p>}
    <p className="dial-rack-help dial-rack-warning" data-dial-help="scene">{t('studio.dials.rack.help.scene')}</p>
    <p className="dial-rack-help" data-dial-help="findings">{t('studio.dials.rack.help.findings')}</p>
    <p className="dial-rack-help" data-dial-help="range">{t('studio.dials.rack.help.range')}</p>
   </section>
  </div>
  {/* A loaded preset goes through the reducer: one undo step. */}
  {presetsOpen&&endpoint!==undefined&&<DialPresetsDialog endpoint={endpoint} rows={s.rows} seconds={timeline.seconds} store={presetStore} onLoad={rows=>dispatch({type:'load',rows})} onClose={()=>setPresetsOpen(false)}/>}
 </dialog>;
}
