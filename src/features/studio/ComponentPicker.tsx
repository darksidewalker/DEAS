import { useId } from 'react';
import { useI18n } from '../../i18n/I18nProvider';

/** Full-width model names and an explicit, category-bounded compatibility override. */
export function ComponentPicker({label,value,automatic,files,all,onAll,onChange}:{label:string;value:string;automatic:string;files:readonly string[];all:boolean;onAll:(all:boolean)=>void;onChange:(value:string)=>void}) {
 const {t}=useI18n();const id=useId();const missing=!!value&&!files.includes(value);
 return <div className="wb-component wb-wide">
  <label className="wb-field" htmlFor={id}><span>{label}</span></label>
  <select id={id} className="wb-dock-sort" value={value} title={value||automatic||t('studio.components.empty')} onChange={e=>onChange(e.target.value)}>
   <option value="">{automatic?t('studio.components.auto',{name:automatic}):t('studio.components.empty')}</option>
   {missing&&<option value={value} disabled>{t('studio.components.unavailable',{name:value})}</option>}
   {files.map(name=><option key={name} value={name}>{name}</option>)}
  </select>
  <button type="button" className="download-switch" role="switch" aria-label={t('studio.components.allFor',{name:label})} aria-checked={all} title={t('studio.components.help')} onClick={()=>onAll(!all)}><span>{t('studio.components.filtered')}</span><span className="download-switch-knob" aria-hidden="true"/><span>{t('studio.components.all')}</span></button>
 </div>;
}
