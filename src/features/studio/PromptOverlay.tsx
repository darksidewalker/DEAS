import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Detached prompt editor: a floating, draggable (title bar) and resizable (corner) text window over the app.
 *  It edits the same value as the inline field; the Workbench layout does not change. Escape or ✕ closes. */
export function PromptOverlay({title,value,onChange,onClose,placeholder,maxLength,closeLabel,children}:{title:string;value:string;onChange:(v:string)=>void;onClose:()=>void;placeholder?:string;maxLength:number;closeLabel:string;children?:ReactNode}){
 const [pos,setPos]=useState<{x:number;y:number}|null>(null);
 const panel=useRef<HTMLDivElement>(null);const close=useRef(onClose);close.current=onClose;
 // Escape inside the Forge popover closes only the popover.
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!(e.target as Element|null)?.closest?.('.forge-pop'))close.current();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
 const drag=(e:React.PointerEvent)=>{
  if(e.button!==0||(e.target as HTMLElement).closest('button'))return;
  const r=panel.current!.getBoundingClientRect(),dx=e.clientX-r.left,dy=e.clientY-r.top;
  // Keep the title bar reachable: the panel may leave the window only partly.
  const move=(ev:PointerEvent)=>setPos({x:Math.min(Math.max(ev.clientX-dx,40-r.width),window.innerWidth-40),y:Math.min(Math.max(ev.clientY-dy,0),window.innerHeight-32)});
  const stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);
 };
 return <div ref={panel} className="wb-prompt-overlay" role="dialog" aria-label={title} style={pos?{left:pos.x,top:pos.y,transform:'none'}:undefined}>
  <div className="wb-prompt-overlay-bar" onPointerDown={drag}><span>{title}</span><small>{value.length} / {maxLength}</small><button type="button" aria-label={closeLabel} title={closeLabel} onClick={onClose}>✕</button></div>
  <div className="wb-prompt-overlay-body"><textarea aria-label={title} autoFocus value={value} maxLength={maxLength} placeholder={placeholder} onChange={e=>onChange(e.target.value)}/>{children}</div>
 </div>;
}
