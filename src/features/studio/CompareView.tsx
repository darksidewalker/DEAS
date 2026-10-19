import { useEffect, useRef, useState } from 'react';
import { zoomAt, type View } from './imageEditor';

/** Original/edited slider compare. Both pictures share one zoom: wheel zooms at the cursor, middle-drag pans, double-click resets.
 *  The divider stays in screen space (clip on an untransformed wrapper), so it marks the same pixel of both pictures at any zoom. */
export function CompareView({original,originalAlt,edited,editedAlt,dividerLabel}:{original:string;originalAlt:string;edited:string;editedAlt:string;dividerLabel:string}){
 const box=useRef<HTMLDivElement>(null);
 const [divide,setDivide]=useState(50);
 const [view,setView]=useState<View>({scale:1,x:0,y:0});
 useEffect(()=>{
  const el=box.current;if(!el)return;
  const wheel=(e:WheelEvent)=>{e.preventDefault();const r=el.getBoundingClientRect();setView(v=>{const next=zoomAt(v,{x:e.clientX-r.left,y:e.clientY-r.top},v.scale*Math.exp(-e.deltaY*.001));return next.scale<=1?{scale:1,x:0,y:0}:next;});};
  el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);
 },[]);
 const pan=(e:React.PointerEvent)=>{
  if(e.button!==1)return;e.preventDefault();
  const start={x:e.clientX,y:e.clientY},from=view;
  const move=(ev:PointerEvent)=>setView({...from,x:from.x+ev.clientX-start.x,y:from.y+ev.clientY-start.y});
  const stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);
 };
 const transform={transform:`translate(${view.x}px, ${view.y}px) scale(${view.scale})`};
 return <div ref={box} className="wb-compare" data-zoom={view.scale.toFixed(2)} style={{'--divide':`${divide}%`} as React.CSSProperties} onPointerDown={pan} onDoubleClick={()=>setView({scale:1,x:0,y:0})}>
  <img src={original} alt={originalAlt} style={transform}/>
  <div className="wb-compare-top"><img src={edited} alt={editedAlt} style={transform}/></div>
  <input type="range" aria-label={dividerLabel} min={0} max={100} value={divide} onChange={e=>setDivide(Number(e.target.value))}/>
 </div>;
}
