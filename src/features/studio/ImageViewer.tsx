import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { zoomAt, type View } from './imageEditor';

/** Full-window picture view: wheel zooms at the cursor, drag pans, Fit/100 %, Escape or ✕ closes. Read-only. */
export function ImageViewer({src,alt,onClose}:{src:string;alt:string;onClose:()=>void}){
 const {t}=useI18n();
 const box=useRef<HTMLDivElement>(null);const close=useRef(onClose);close.current=onClose;
 const [size,setSize]=useState<{width:number;height:number}|null>(null);
 const [view,setView]=useState<View|null>(null);
 const centre=()=>{const r=box.current?.getBoundingClientRect();return {x:(r?.width??0)/2,y:(r?.height??0)/2};};
 const fit=()=>{const r=box.current?.getBoundingClientRect();if(!r||!size||!r.width||!r.height)return;const scale=Math.min(r.width/size.width,r.height/size.height,1);setView({scale,x:(r.width-size.width*scale)/2,y:(r.height-size.height*scale)/2});};
 useEffect(fit,[size]); // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{
  const el=box.current;if(!el)return;
  const wheel=(e:WheelEvent)=>{e.preventDefault();const r=el.getBoundingClientRect();setView(v=>v&&zoomAt(v,{x:e.clientX-r.left,y:e.clientY-r.top},v.scale*Math.exp(-e.deltaY*.001)));};
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape')close.current();};
  el.addEventListener('wheel',wheel,{passive:false});window.addEventListener('keydown',key);
  return()=>{el.removeEventListener('wheel',wheel);window.removeEventListener('keydown',key);};
 },[]);
 const pan=(e:React.PointerEvent)=>{
  if(!view||e.button!==0)return;e.preventDefault();
  const start={x:e.clientX,y:e.clientY},from=view;
  const move=(ev:PointerEvent)=>setView({...from,x:from.x+ev.clientX-start.x,y:from.y+ev.clientY-start.y});
  const stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);
 };
 const zoom=(scale:(s:number)=>number)=>setView(v=>v&&zoomAt(v,centre(),scale(v.scale)));
 return <div className="wb-viewer" role="dialog" aria-modal="true" aria-label={alt}>
  <div className="wb-viewer-tools">
   <span className="wb-viewer-name">{alt}{view&&<> · {Math.round(view.scale*100)} %</>}</span>
   <button type="button" aria-label={t('studio.editor.zoomOut')} onClick={()=>zoom(s=>s/1.25)}>−</button>
   <button type="button" onClick={fit}>{t('studio.editor.fit')}</button>
   <button type="button" onClick={()=>zoom(()=>1)}>{t('studio.editor.actual')}</button>
   <button type="button" aria-label={t('studio.editor.zoomIn')} onClick={()=>zoom(s=>s*1.25)}>+</button>
   <button type="button" aria-label={t('studio.run.close')} autoFocus onClick={onClose}>✕</button>
  </div>
  <div ref={box} className="wb-viewer-box" onPointerDown={pan}>
   <img src={src} alt={alt} draggable={false} onLoad={e=>setSize({width:e.currentTarget.naturalWidth,height:e.currentTarget.naturalHeight})}
    style={view?{width:size!.width,height:size!.height,transform:`translate(${view.x}px, ${view.y}px) scale(${view.scale})`}:{visibility:'hidden'}}/>
  </div>
 </div>;
}
