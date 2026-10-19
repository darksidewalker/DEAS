import {useRef,useState,type PointerEvent} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {useI18n} from '../../i18n/I18nProvider';
import type {PeopleBox} from '../../lib/forge';

/** Source-image fractions, as used by the Director. Keep a usable 2% minimum side. */
export function adjustPeopleBox(box:PeopleBox['box'],dx:number,dy:number,resize:boolean):PeopleBox['box']{
 const [x1,y1,x2,y2]=box;
 let result:PeopleBox['box'];
 if(resize)result=[x1,y1,Math.min(1,Math.max(x1+0.02,x2+dx)),Math.min(1,Math.max(y1+0.02,y2+dy))];
 else{
  dx=Math.min(1-x2,Math.max(-x1,dx));dy=Math.min(1-y2,Math.max(-y1,dy));
  result=[x1+dx,y1+dy,x2+dx,y2+dy];
 }
 // Subtraction must meet the node pack's strict minimum even after floating-point translation.
 for(const i of [0,1])if(result[i+2]-result[i]<0.02){
  result[i+2]=Math.min(1,result[i]+0.02+Number.EPSILON);
  if(result[i+2]-result[i]<0.02)result[i]=result[i+2]-0.02-Number.EPSILON;
 }
 return result;
}

/** Manual boxes only: no detection, inference, source-file edits or baked overlay. */
export function PeopleBoxes({src,boxes,onChange}:{src:string;boxes:PeopleBox[];onChange:(boxes:PeopleBox[])=>void}){
 const {t}=useI18n();const svg=useRef<SVGSVGElement>(null);
 const [ready,setReady]=useState(false),[bad,setBad]=useState(false);const reported=useRef(false);
 const drag=useRef<{n:number;x:number;y:number;resize:boolean;box:PeopleBox['box'];original:PeopleBox[]}|null>(null);
 const set=(n:number,box:PeopleBox['box'])=>onChange(boxes.map(b=>b.n===n?{...b,box}:b));
 const point=(e:PointerEvent)=>{const r=svg.current!.getBoundingClientRect();return r.width>0&&r.height>0?{x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}:null;};
 const start=(e:PointerEvent,n:number,resize:boolean)=>{if(!ready||e.button!==0)return;const p=point(e);if(!p)return;e.preventDefault();e.stopPropagation();svg.current!.setPointerCapture(e.pointerId);drag.current={n,...p,resize,box:boxes.find(b=>b.n===n)!.box,original:boxes};};
 const key=(e:React.KeyboardEvent,n:number,resize:boolean)=>{const moves:Record<string,[number,number]>={ArrowLeft:[-0.01,0],ArrowRight:[0.01,0],ArrowUp:[0,-0.01],ArrowDown:[0,0.01]};const d=moves[e.key];if(!d||!ready)return;e.preventDefault();set(n,adjustPeopleBox(boxes.find(b=>b.n===n)!.box,...d,resize));};
 const finish=(e:PointerEvent,cancel=false)=>{if(cancel&&drag.current)onChange(drag.current.original);drag.current=null;if(svg.current?.hasPointerCapture(e.pointerId))svg.current.releasePointerCapture(e.pointerId);};
 let next=1;while(boxes.some(b=>b.n===next))next++;
 return <div className="people-boxes" data-people-boxes>
  <p className="media-help">{t('forge.boxHint')}</p>
  {bad&&<p role="alert" className="error-message">{t('forge.boxImageError')}</p>}
  <div className="people-box-picture">
   <img data-people-image src={src} alt="" draggable={false} onLoad={()=>{setReady(true);setBad(false);}} onError={()=>{setReady(false);setBad(true);drag.current=null;if(!reported.current&&isTauri()){reported.current=true;void invoke('native_logs_people_image_error').catch(()=>{});}}}/>
   {ready&&<svg ref={svg} viewBox="0 0 1 1" preserveAspectRatio="none" aria-label={t('forge.boxes')} onPointerMove={e=>{const d=drag.current,p=point(e);if(d&&p)set(d.n,adjustPeopleBox(d.box,p.x-d.x,p.y-d.y,d.resize));}} onPointerUp={e=>finish(e)} onPointerCancel={e=>finish(e,true)}>
    {boxes.map(({n,box:[x1,y1,x2,y2]})=><g key={n}>
     <rect data-people-move={n} x={x1} y={y1} width={x2-x1} height={y2-y1} role="button" tabIndex={0} aria-label={t('forge.boxMove',{n:String(n)})} onPointerDown={e=>start(e,n,false)} onKeyDown={e=>key(e,n,false)}/>
     <rect data-people-resize={n} className="people-box-handle" x={x2-0.015} y={y2-0.015} width={0.03} height={0.03} role="button" tabIndex={0} aria-label={t('forge.boxResize',{n:String(n)})} onPointerDown={e=>start(e,n,true)} onKeyDown={e=>key(e,n,true)}/>
    </g>)}
   </svg>}
   {ready&&boxes.map(b=><span key={b.n} className="people-box-number" aria-hidden="true" style={{left:`${b.box[0]*100}%`,top:`${b.box[1]*100}%`}}>{b.n}</span>)}
  </div>
  <button type="button" disabled={!ready||next>32} onClick={()=>onChange([...boxes,{n:next,box:[0.25,0.25,0.75,0.75]}])}>{t('forge.boxAdd')}</button>
  {boxes.map(b=><div className="wb-ref-actions" key={b.n}>
   <label><span>{t('forge.role.character',{n:String(b.n)})}</span><select aria-label={t('forge.boxNumber',{n:String(b.n)})} value={b.n} disabled={!ready} onChange={e=>{const n=Number(e.target.value);if(!boxes.some(x=>x.n===n))onChange(boxes.map(x=>x===b?{...x,n}:x));}}>{Array.from({length:32},(_,i)=>i+1).map(n=><option key={n} value={n} disabled={n!==b.n&&boxes.some(x=>x.n===n)}>{n}</option>)}</select></label>
   <button type="button" aria-label={t('forge.boxRemove',{n:String(b.n)})} onClick={()=>onChange(boxes.filter(x=>x!==b))}>✕</button>
  </div>)}
 </div>;
}
