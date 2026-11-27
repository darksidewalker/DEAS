import { useEffect, useRef, type ReactNode } from 'react';
import { useFloatingPosition } from '../../components/useFloatingPosition';
import { PromptTextarea } from './PromptTextarea';

/** Detached prompt editor: a floating, draggable (title bar) and resizable (corner) text window over the app.
 *  It edits the same value as the inline field; the Workbench layout does not change. Escape or ✕ closes. */
export function PromptOverlay({root,target,title,value,onChange,onClose,placeholder,maxLength,closeLabel,children}:{root?:string;target?:string;title:string;value:string;onChange:(v:string)=>void;onClose:()=>void;placeholder?:string;maxLength:number;closeLabel:string;children?:ReactNode}){
 const floating=useFloatingPosition<HTMLDivElement>();
 const close=useRef(onClose);close.current=onClose;
 // Escape inside the Forge popover closes only the popover.
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!(e.target as Element|null)?.closest?.('.forge-pop'))close.current();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
 return <div ref={floating.ref} className="wb-prompt-overlay" role="dialog" aria-label={title} style={floating.style}>
  <div className="wb-prompt-overlay-bar" onPointerDown={floating.onPointerDown}><span>{title}</span><small>{value.length} / {maxLength}</small><button type="button" aria-label={closeLabel} title={closeLabel} onClick={onClose}>✕</button></div>
  <div className="wb-prompt-overlay-body"><PromptTextarea root={root} target={target} aria-label={title} autoFocus value={value} maxLength={maxLength} placeholder={placeholder} onChange={e=>onChange(e.target.value)}/>{children&&<div className="wb-prompt-actions">{children}</div>}</div>
 </div>;
}
