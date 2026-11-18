import { useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import type { MediaItem } from '../../lib/media';
import { ReferenceThumbnail } from './ReferenceThumbnail';

export function ReferenceAssignmentBar({selected,actions,children,videoRoles=true}:{selected:MediaItem|null;actions:{id:string;label:string;reason?:string;assign:()=>void}[];children?:ReactNode;videoRoles?:boolean}) {
 const {t}=useI18n();const [role,setRole]=useState('reference');const chosen=actions.find(a=>a.id===role)??actions[0];
 return <section className="reference-assignment" aria-label={t('studio.run.video.roles.title')} data-video-roles>
  <div className="reference-assignment-pick">
   <div className="reference-assignment-thumb">{selected?<ReferenceThumbnail reference={{item:selected,second:0,strength:1,mediaMode:'video'}}/>:<span aria-hidden="true">◇</span>}</div>
   <div className="reference-assignment-name"><strong title={selected?.name}>{selected?.name??t('studio.run.video.roles.pick')}</strong><small title={chosen?.reason}>{chosen?.reason??t('studio.run.video.referencesSelected')}</small></div>
   <select aria-label={t('studio.run.video.roles.title')} value={chosen?.id??''} onChange={e=>setRole(e.target.value)}>{actions.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select>
   <button type="button" className="wb-dock-action" data-video-role={videoRoles?chosen?.id:undefined} data-image-role={!videoRoles?chosen?.id:undefined} aria-label={chosen?.label} disabled={!selected||!chosen||!!chosen.reason} title={chosen?.reason} onClick={()=>chosen?.assign()}>{t('studio.run.video.referencesAssign')}</button>
  </div>
  <div className="reference-assignment-slots">{children}</div>
 </section>;
}
