import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useI18n } from '../../i18n/I18nProvider';
import { describeMedia, itemFromEntry, itemFromFile, listMedia, type MediaEntry, type MediaItem, type MediaListing } from '../../lib/media';
import './media.css';
export interface MediaLibraryProps { selected: MediaItem|null; onSelect: (item: MediaItem) => void }
/** Media library plugin: read-only folder browsing plus drag & drop. Nothing is copied or moved. */
export function MediaLibrary({selected,onSelect}:MediaLibraryProps){
 const {t}=useI18n();
 const native=isTauri();
 const [listing,setListing]=useState<MediaListing|null>(null);
 const [dropped,setDropped]=useState<MediaItem[]>([]);
 const [error,setError]=useState('');
 const [dragging,setDragging]=useState(false);
 const version=useRef(0);
 const open=async(path:string)=>{
  const v=++version.current;
  try{const next=await listMedia(path);if(v===version.current){setListing(next);setError('');}}
  catch(e){if(v===version.current)setError(String(e));}
 };
 useEffect(()=>{if(native)void open('');return()=>{version.current++;};},[native]);
 const addDropped=(items:(MediaItem|null)[])=>{const valid=items.filter((i):i is MediaItem=>!!i);if(valid.length){setDropped(d=>[...valid,...d]);onSelect(valid[0]);}};
 const dropPaths=async(paths:string[])=>{
  try{const entries=await describeMedia(paths);const folder=entries.find(e=>e.kind==='directory');if(folder)void open(folder.path);addDropped(entries.map(itemFromEntry));}
  catch(e){setError(String(e));}
 };
 // Native webviews deliver OS drops as paths; the HTML5 handlers below serve the browser preview.
 useEffect(()=>{
  if(!native)return;
  let alive=true,unlisten:(()=>void)|undefined;
  void (async()=>{
   try{const stop=await getCurrentWebview().onDragDropEvent(e=>{
    if(e.payload.type==='enter'||e.payload.type==='over')setDragging(true);
    else{setDragging(false);if(e.payload.type==='drop')void dropPaths(e.payload.paths);}
   });if(alive)unlisten=stop;else stop();}
   catch(e){if(alive)setError(String(e));} // drag & drop unavailable must not take the library down
  })();
  return()=>{alive=false;unlisten?.();};
 },[native]);
 const pick=async()=>{
  try{const folder=await invoke<string|null>('native_pick_directory',{title:t('media.pickTitle')});if(folder)void open(folder);}
  catch(e){setError(String(e));}
 };
 const choose=(entry:MediaEntry)=>{if(entry.kind==='directory')void open(entry.path);else{const item=itemFromEntry(entry);if(item)onSelect(item);}};
 const visible=listing?.entries.filter(e=>e.kind==='directory'||e.media)??[];
 return <aside className={`media-library${dragging?' is-dragging':''}`} aria-label={t('media.title')}
  onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)}
  onDrop={e=>{e.preventDefault();setDragging(false);addDropped([...e.dataTransfer.files].map(itemFromFile));}}>
  <header className="media-header"><h2>{t('media.title')}</h2><button type="button" disabled={!native} onClick={()=>void pick()}>{t('media.openFolder')}</button></header>
  <p className="media-help">{t(native?'media.dropHelp':'media.browserHelp')}</p>
  {dropped.length>0&&<ul className="media-list" aria-label={t('media.dropped')}>{dropped.map((item,i)=><li key={`${item.src}-${i}`}><button type="button" data-media={item.media} aria-current={selected?.src===item.src} onClick={()=>onSelect(item)}>{item.name}</button></li>)}</ul>}
  {listing&&<nav className="media-path" aria-label={t('media.currentFolder')}><button type="button" disabled={!listing.parent} aria-label={t('media.up')} onClick={()=>listing.parent&&void open(listing.parent)}>↑</button><code>{listing.path}</code></nav>}
  {error&&<p className="media-error" role="alert">{error}</p>}
  {listing&&<ul className="media-list" aria-label={t('media.entries')}>{visible.map(entry=><li key={entry.path}><button type="button" data-kind={entry.kind} data-media={entry.media??undefined} aria-current={selected?.path===entry.path} onClick={()=>choose(entry)}>{entry.kind==='directory'?'▸ ':''}{entry.name}{entry.symlink&&<span className="media-symlink" aria-label={t('media.symlink')}> ⤳</span>}</button></li>)}</ul>}
  {listing&&!visible.length&&!error&&<p className="media-help">{t('media.empty')}</p>}
  {listing?.truncated&&<p className="media-help">{t('media.truncated')}</p>}
 </aside>;
}
