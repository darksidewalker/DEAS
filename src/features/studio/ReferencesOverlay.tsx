import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { ReferencesPanel, type ReferencesPanelProps } from './ReferencesPanel';
import './continuity-overlay.css';
import './references-overlay.css';

export function ReferencesOverlay({ onClose, picker, ...panel }: ReferencesPanelProps & { onClose:()=>void; picker:ReactNode }) {
 const {t}=useI18n();
 const dialog=useRef<HTMLDialogElement>(null),close=useRef<HTMLButtonElement>(null);
 const title=useId();
 useEffect(()=>{
  const el=dialog.current!;el.showModal();close.current?.focus();
  return()=>{if(el.open)el.close();};
 },[]);
 const dismiss=()=>{if(dialog.current?.open)dialog.current.close();onClose();};
 return <dialog ref={dialog} className="continuity-overlay references-overlay" aria-labelledby={title} onCancel={e=>{e.preventDefault();dismiss();}}>
  <header className="continuity-overlay-header"><h2 id={title}>{t('studio.run.dock.references')}</h2><button ref={close} type="button" onClick={dismiss}>{t('studio.close')}</button></header>
  <div className="references-overlay-body">
   <section className="references-picker" aria-label={t('studio.run.dock.media')}><p className="media-help">{t('studio.run.video.pickerHint')}</p>{picker}</section>
   <section className="references-editor" aria-label={t('studio.run.dock.references')}><ReferencesPanel {...panel}/></section>
  </div>
 </dialog>;
}
