import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { ReferenceHeaderTools } from './ReferenceManagerWorkspace';
import { useDialogBackdropClose } from '../../components/useDialogBackdropClose';
import './continuity-overlay.css';
import './references-overlay.css';
import './reference-manager.css';

/** Modal shell: the media picker beside an editor (video `ReferencesPanel` or the image reference bar). */
export function ReferencesOverlay({ onClose, picker, children, pickerHint, manager=false, subtitle,imageEdit=false }: { onClose:()=>void; picker:ReactNode; children:ReactNode; pickerHint?:string;manager?:boolean;subtitle?:string;imageEdit?:boolean }) {
 const {t}=useI18n();
 const dialog=useRef<HTMLDialogElement>(null),close=useRef<HTMLButtonElement>(null);
 const title=useId();
 const [tools,setTools]=useState<HTMLDivElement|null>(null);
 useEffect(()=>{
  const el=dialog.current!;el.showModal();close.current?.focus();
  return()=>{if(el.open)el.close();};
 },[]);
 const dismiss=()=>{if(dialog.current?.open)dialog.current.close();onClose();};
 const backdrop=useDialogBackdropClose(dismiss);
 return <dialog ref={dialog} {...backdrop} className="continuity-overlay references-overlay" data-reference-manager={manager||undefined} data-image-edit={imageEdit||undefined} aria-labelledby={title} onCancel={e=>{if(e.target!==e.currentTarget)return;e.preventDefault();dismiss();}}>
  <header className="continuity-overlay-header"><div className="references-dialog-title"><h2 id={title}>{t('studio.run.dock.references')}</h2>{manager&&subtitle&&<span className="references-model-badge">{subtitle}</span>}</div>{manager&&<div className="references-header-tools" ref={setTools}/>}<button ref={close} type="button" className={manager?'wb-dock-action':undefined} onClick={dismiss}>{t('studio.close')}</button></header>
  <div className="references-overlay-body">
   <section className="references-picker" aria-label={t('studio.run.dock.media')}>{!manager&&<p className="media-help">{pickerHint??t('studio.run.video.pickerHint')}</p>}{picker}</section>
   <section className="references-editor" aria-label={t('studio.run.dock.references')}><ReferenceHeaderTools.Provider value={manager?tools:null}>{children}</ReferenceHeaderTools.Provider></section>
  </div>
  {manager&&<footer className="references-dialog-footer"><p>{t('studio.run.video.referencesLayoutHint')}</p><button type="button" className="wb-dock-action" onClick={dismiss}>{t('studio.run.video.referencesDone')}</button></footer>}
 </dialog>;
}
