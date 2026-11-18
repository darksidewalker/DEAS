import { createContext, useRef, type ReactNode } from 'react';
import { usePref } from '../../lib/preferences';
import { useI18n } from '../../i18n/I18nProvider';

export const ReferenceHeaderTools=createContext<HTMLElement|null>(null);

/** Content counts never size these panes; only window size or an explicit divider drag does. */
export function ReferenceManagerWorkspace({images,video,audio,refmods}:{images:ReactNode;video:ReactNode;audio:ReactNode;refmods:ReactNode}) {
 const {t}=useI18n();
 const [split,setSplit]=usePref('studio.references.lowerSplit',60,(v):v is number=>typeof v==='number'&&v>=35&&v<=72);
 const lower=useRef<HTMLDivElement>(null),drag=useRef<{id:number;start:number}|null>(null);
 const stop=(el:HTMLElement)=>{if(drag.current&&el.hasPointerCapture(drag.current.id))el.releasePointerCapture(drag.current.id);drag.current=null;};
 return <div className="reference-manager-workspace" data-reference-workspace>
  {images}
  <div ref={lower} className="reference-manager-lower" style={{gridTemplateColumns:`minmax(0,${split}fr) .65rem minmax(0,${100-split}fr)`}}>
   <div className="reference-manager-av">{video}{audio}</div>
   <div className="reference-manager-divider" role="separator" aria-label={t('studio.run.video.referencesResize')} aria-orientation="vertical" tabIndex={0} aria-valuemin={35} aria-valuemax={72} aria-valuenow={Math.round(split)}
    onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();drag.current={id:e.pointerId,start:split};e.currentTarget.setPointerCapture(e.pointerId);}}
    onPointerMove={e=>{if(drag.current?.id!==e.pointerId||!lower.current)return;const r=lower.current.getBoundingClientRect();setSplit(Math.max(35,Math.min(72,(e.clientX-r.left)/r.width*100)));}}
    onPointerUp={e=>stop(e.currentTarget)} onLostPointerCapture={()=>{drag.current=null;}} onPointerCancel={e=>{if(drag.current)setSplit(drag.current.start);stop(e.currentTarget);}}
    onKeyDown={e=>{if(e.key==='Escape'&&drag.current){e.preventDefault();e.stopPropagation();setSplit(drag.current.start);stop(e.currentTarget);}else if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();setSplit(e.key==='Home'?35:e.key==='End'?72:Math.max(35,Math.min(72,split+(e.key==='ArrowLeft'?-2:2))));}}}><span aria-hidden="true">⋮</span></div>
   {refmods}
  </div>
 </div>;
}
