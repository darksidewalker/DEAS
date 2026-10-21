import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { relocatedMediaItem, starMedia, type MediaItem, type MediaRelocation } from '../../lib/media';

/** Per-file action; pass no path for remote/blob previews so they explicitly remain unavailable. */
export function StarMediaButton({item,onMoved}:{item:MediaItem;onMoved?:(item:MediaItem)=>void}) {
 const {t}=useI18n();
 const [status,setStatus]=useState<{starred:boolean;unavailable:string|null}|null>(null);
 const [pending,setPending]=useState(false);
 const [error,setError]=useState('');
 const lock=useRef(false);
 const scope=useRef<object|null>(null);
 useEffect(()=>{
  scope.current={};lock.current=false;setPending(false);
  return()=>{scope.current=null;};
 },[item.path]);
 useEffect(()=>{
  let alive=true;setStatus(null);setError('');
  if(!isTauri()||!item.path){setStatus({starred:false,unavailable:t('media.star.external')});return;}
  invoke<{starred:boolean;unavailable:string|null}>('native_media_star_status',{path:item.path}).then(s=>{if(!alive)return;if(typeof s?.starred!=='boolean'||!(s.unavailable===null||typeof s.unavailable==='string'))throw new Error('Invalid native star availability');setStatus(s);}).catch(e=>{if(!alive)return;void invoke('native_media_star_notice').catch(()=>{});setStatus({starred:false,unavailable:String(e)});});
  return()=>{alive=false;};
 },[item.path,t]);
 useEffect(()=>{
  const moved=(event:Event)=>{const move=(event as CustomEvent<MediaRelocation>).detail;if(move.oldPath===item.path){setStatus({starred:true,unavailable:null});onMoved?.(relocatedMediaItem(item,move));}};
  window.addEventListener('deas-media-relocated',moved);return()=>window.removeEventListener('deas-media-relocated',moved);
 },[item,onMoved]);
 const star=async()=>{
  const current=scope.current;
  if(!current||lock.current||!item.path||!status||status.unavailable||status.starred)return;
  lock.current=true;setPending(true);setError('');
  try{await starMedia(item.path);if(scope.current===current)setStatus({starred:true,unavailable:null});}
  catch(e){void Promise.resolve(invoke('native_media_star_notice')).catch(()=>{});if(scope.current===current)setError(String(e));}
  finally{if(scope.current===current){lock.current=false;setPending(false);}}
 };
 const label=t(status?.starred?'media.starred':'media.star',{name:item.name});
 const reason=error||status?.unavailable||(!status?t('media.star.checking'):'');
 return <span className="media-star-control" title={reason||label}>
  <button type="button" className="media-star" aria-label={label} title={reason||label} aria-description={reason||undefined} aria-pressed={status?.starred??false} disabled={pending||!status||!!status.unavailable||status.starred} onClick={e=>{e.stopPropagation();void star();}}>{status?.starred?'★':'☆'}</button>
  {reason&&<span className="media-star-reason" role={error?'alert':undefined}>{reason}</span>}
 </span>;
}
