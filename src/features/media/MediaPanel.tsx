import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { MediaLibrary, mediaTypes, mediaViews, type MediaLibraryProps, type MediaSort, type MediaType, type MediaView } from './MediaLibrary';

export interface MediaControlsProps {
 query:string; onQuery:(query:string)=>void;
 sort:MediaSort; onSort:(sort:MediaSort)=>void;
 view:MediaView; onView:(view:MediaView)=>void;
 type?:MediaType; onType?:(type:MediaType)=>void;
 sorts?:readonly MediaSort[];
}
export function MediaControls({query,onQuery,sort,onSort,view,onView,type,onType,sorts=['date','name','size']}:MediaControlsProps){
 const {t}=useI18n();
 return <><input type="search" className="media-search" data-dock-search aria-label={t('studio.run.dock.search')} placeholder={t('studio.run.dock.search')} value={query} onChange={e=>onQuery(e.target.value)}/>
  <select className="wb-dock-sort" data-dock-sort aria-label={t('studio.run.dock.sort')} value={sort} onChange={e=>onSort(e.target.value as MediaSort)}>{sorts.map(s=><option key={s} value={s}>{t(`studio.run.sort.${s}`)}</option>)}</select>
  {type!==undefined&&onType&&<select className="wb-dock-sort" data-dock-type aria-label={t('studio.run.dock.type')} value={type} onChange={e=>onType(e.target.value as MediaType)}>{mediaTypes.map(v=><option key={v} value={v}>{t(`studio.run.dock.type.${v}`)}</option>)}</select>}
  <select className="wb-dock-sort" data-dock-view aria-label={t('studio.run.view')} value={view} onChange={e=>onView(e.target.value as MediaView)}>{mediaViews.map(v=><option key={v} value={v}>{t(`studio.run.view.${v}`)}</option>)}</select></>;
}
export interface MediaPanelProps extends Omit<MediaLibraryProps,'filter'|'sort'|'view'|'type'> { controls:MediaControlsProps; toolbar?:ReactNode }
export function MediaPanel({controls,toolbar,...library}:MediaPanelProps){
 return <><div className="media-toolbar">{toolbar}<MediaControls {...controls}/></div><MediaLibrary {...library} filter={controls.query} sort={controls.sort} view={controls.view} type={controls.type}/></>;
}
