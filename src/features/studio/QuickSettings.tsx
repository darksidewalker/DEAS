import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import './quickSettings.css';

export function QuickSettings(){
 const {t}=useI18n();const [open,setOpen]=useState(false);const host=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null);
 useEffect(()=>{
  if(!open)return;
  const outside=(e:PointerEvent)=>{if(!host.current?.contains(e.target as Node))setOpen(false);};
  const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);button.current?.focus();}};
  window.addEventListener('pointerdown',outside);window.addEventListener('keydown',escape);
  return()=>{window.removeEventListener('pointerdown',outside);window.removeEventListener('keydown',escape);};
 },[open]);
 // Studio is lazy-mounted; reset events have no receiver before its first visit.
 const ready=!!document.querySelector('[data-workbench]');
 const request=(event:string)=>{setOpen(false);button.current?.focus();window.dispatchEvent(new Event(event));};
 return <div className="studio-quick" ref={host}>
  <button type="button" ref={button} className="repo-button" aria-label={t('studio.quick.title')} title={t('studio.quick.title')} aria-expanded={open} aria-controls="studio-quick-actions" onClick={()=>setOpen(!open)}>{t('studio.quick.title')}</button>
  {open&&<div id="studio-quick-actions" className="studio-quick-actions" aria-label={t('studio.quick.title')}>
   {!ready&&<p id="studio-quick-unavailable">{t('studio.quick.openStudioFirst')}</p>}
   <button type="button" disabled={!ready} aria-describedby={!ready?'studio-quick-unavailable':undefined} onClick={()=>request('deas:reset-studio-layout')}>{t('studio.quick.layout')}</button>
   <button type="button" disabled={!ready} aria-describedby={!ready?'studio-quick-unavailable':undefined} onClick={()=>request('deas:request-studio-defaults')}>{t('studio.quick.defaults')}</button>
  </div>}
 </div>;
}
