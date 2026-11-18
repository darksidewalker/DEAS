import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

/** Capture on a stationary root so native OS drops cannot steal card reordering. */
export function usePointerReorder(order:string[],onOrder:(keys:string[])=>void,{rowSelector,keyAttribute,scrollSelector,root:provided,onMoved}:{rowSelector:string;keyAttribute:string;scrollSelector?:string;root?:RefObject<HTMLDivElement|null>;onMoved?:(key:string,position:number)=>void}) {
 const own=useRef<HTMLDivElement>(null),panel=provided??own;
 const current=useRef({order,onOrder,onMoved});current.current={order,onOrder,onMoved};
 const drag=useRef<{key:string;pointer:number;capture:HTMLElement;scroll:HTMLElement;x:number;y:number;startX:number;startY:number;order:string[];moving:boolean;anchor:string}|null>(null);
 const frame=useRef(0),previous=useRef(0);const [dragging,setDragging]=useState('');
 const move=(key:string,target:string)=>{const c=current.current,from=c.order.indexOf(key),to=c.order.indexOf(target);if(from<0||to<0||from===to)return;const next=[...c.order];next.splice(to,0,next.splice(from,1)[0]);c.order=next;c.onOrder(next);c.onMoved?.(key,to+1);};
 const rows=(scroll:HTMLElement)=>Array.from(scroll.querySelectorAll<HTMLElement>(rowSelector)).filter(row=>current.current.order.includes(row.getAttribute(keyAttribute)??''));
 const place=()=>{const active=drag.current;if(!active?.moving)return;const bounds=active.scroll.getBoundingClientRect();if(active.x<bounds.left||active.x>bounds.right)return;
  // Including the moving row stops oscillation after it snaps into the pointer's cell.
  let nearest:HTMLElement|undefined,distance=Infinity;
  for(const row of rows(active.scroll)){const r=row.getBoundingClientRect(),dy=active.y<r.top?r.top-active.y:active.y>r.bottom?active.y-r.bottom:0,dx=active.x-(r.left+r.width/2),d=dy*dy*100+dx*dx;if(d<distance){distance=d;nearest=row;}}
  const target=nearest?.getAttribute(keyAttribute);if(target)move(active.key,target);
 };
 const finish=(cancel=false)=>{const active=drag.current;drag.current=null;cancelAnimationFrame(frame.current);frame.current=0;previous.current=0;setDragging('');if(!active)return;active.scroll.style.overflowAnchor=active.anchor;if(active.capture.hasPointerCapture?.(active.pointer))active.capture.releasePointerCapture(active.pointer);
  if(cancel&&active.moving){const c=current.current,next=[...active.order.filter(key=>c.order.includes(key)),...c.order.filter(key=>!active.order.includes(key))];c.order=next;c.onOrder(next);}
 };
 const tick=(time:number)=>{const active=drag.current;if(!active)return;const dt=previous.current?Math.min(32,time-previous.current):16;previous.current=time;if(active.moving){const bounds=active.scroll.getBoundingClientRect(),edge=Math.min(48,bounds.height/4);if(active.x>=bounds.left&&active.x<=bounds.right){const speed=active.y<bounds.top+edge?-Math.min(1,(bounds.top+edge-active.y)/edge):active.y>bounds.bottom-edge?Math.min(1,(active.y-bounds.bottom+edge)/edge):0;active.scroll.scrollTop+=speed*700*dt/1000;place();}}frame.current=requestAnimationFrame(tick);};
 useEffect(()=>{const blur=()=>finish(true);window.addEventListener('blur',blur);return()=>{window.removeEventListener('blur',blur);const active=drag.current;drag.current=null;cancelAnimationFrame(frame.current);if(active){active.scroll.style.overflowAnchor=active.anchor;if(active.capture.hasPointerCapture?.(active.pointer))active.capture.releasePointerCapture(active.pointer);}};},[]);
 useEffect(()=>{if(drag.current&&!order.includes(drag.current.key))finish();},[order]);
 return {panel,dragging,handle:(key:string)=>({
  onPointerDown:(e:PointerEvent<HTMLButtonElement>)=>{if(e.button!==0||drag.current)return;e.preventDefault();e.currentTarget.focus({preventScroll:true});const capture=panel.current??e.currentTarget,scroll=scrollSelector?e.currentTarget.closest<HTMLElement>(scrollSelector):capture;if(!scroll)return;const anchor=scroll.style.overflowAnchor;scroll.style.overflowAnchor='none';capture.setPointerCapture?.(e.pointerId);drag.current={key,pointer:e.pointerId,capture,scroll,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,order:[...current.current.order],moving:false,anchor};frame.current=requestAnimationFrame(tick);},
  onKeyDown:(e:KeyboardEvent<HTMLButtonElement>)=>{if(e.key==='Escape'&&drag.current){e.preventDefault();e.stopPropagation();finish(true);return;}if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();const scope=scrollSelector?e.currentTarget.closest<HTMLElement>(scrollSelector):panel.current;if(!scope)return;const keys=rows(scope).map(row=>row.getAttribute(keyAttribute)!),index=keys.indexOf(key),target=keys[index+(e.key==='ArrowUp'?-1:1)];if(target)move(key,target);}},
 }),events:{
  onPointerMove:(e:PointerEvent<HTMLDivElement>)=>{const active=drag.current;if(!active||active.pointer!==e.pointerId)return;active.x=e.clientX;active.y=e.clientY;if(!active.moving&&Math.hypot(active.x-active.startX,active.y-active.startY)>=4){active.moving=true;setDragging(active.key);}place();},
  onPointerUp:(e:PointerEvent<HTMLDivElement>)=>{if(drag.current?.pointer===e.pointerId){place();finish();}},onPointerCancel:()=>finish(true),onLostPointerCapture:()=>{if(drag.current)finish(true);},
  onKeyDown:(e:KeyboardEvent<HTMLDivElement>)=>{if(e.key==='Escape'&&drag.current){e.preventDefault();e.stopPropagation();finish(true);}},
 }};
}
