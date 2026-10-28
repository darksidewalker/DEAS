import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { SCHEMES, useScheme } from '../../lib/theme';
import './quickSettings.css';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { reportPromptSpellcheckError, usePromptTools } from '../../lib/promptTools';

export function QuickSettings(){
 const tools=usePromptTools();
 useEffect(()=>{
  if(!isTauri())return;
  let alive=true;reportPromptSpellcheckError('');
  void invoke('native_prompt_spellcheck',{enabled:tools.spellcheck,language:tools.language}).catch(e=>{if(alive)reportPromptSpellcheckError(String(e)==='SPELLCHECK_DICTIONARY_MISSING'?'settings.prompt.dictionaryMissing':String(e)==='SPELLCHECK_UNSUPPORTED'?'settings.prompt.unsupported':'settings.prompt.failed');});
  return()=>{alive=false;};
 },[tools.spellcheck,tools.language]);
 const {t}=useI18n();const [open,setOpen]=useState(false);const [scheme,setScheme]=useScheme();const host=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null);
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
   <button type="button" aria-pressed={tools.spellcheck} onClick={()=>tools.update({spellcheck:!tools.spellcheck})}>{t('settings.prompt.spellcheck')}</button>
   <button type="button" aria-pressed={tools.autocomplete} onClick={()=>tools.update({autocomplete:!tools.autocomplete})}>{t('settings.prompt.autocomplete')}</button>
   {tools.error&&<p className="error-message" role="alert">{t(tools.error)}</p>}
   <div className="studio-quick-schemes" role="group" aria-label={t('studio.quick.scheme')}>
    <span className="studio-quick-label">{t('studio.quick.scheme')}</span>
    {SCHEMES.map(s=><button key={s.id} type="button" data-scheme={s.id} aria-pressed={scheme===s.id} onClick={()=>setScheme(s.id)}>
     <span className="studio-quick-swatch" aria-hidden="true" style={{background:s.swatch[0],boxShadow:`inset -9px 0 0 ${s.swatch[1]}`}}/>{s.name}
    </button>)}
   </div>
  </div>}
 </div>;
}
