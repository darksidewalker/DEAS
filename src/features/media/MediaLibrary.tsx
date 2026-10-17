import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useI18n } from '../../i18n/I18nProvider';
import { describeMedia, itemFromEntry, itemFromFile, listMedia, type MediaEntry, type MediaItem, type MediaListing } from '../../lib/media';
import { usePref } from '../../lib/preferences';
import './media.css';
const depths=[1,2,3,4,5];
const isDepth=(v:unknown):v is number=>typeof v==='number'&&depths.includes(v);
// Session caches: listings show instantly on revisit (then refresh), thumbnails skip the IPC round trip.
const listings=new Map<string,MediaListing>();
const thumbs=new Map<string,string>();
/** Image tile: asks the native side for its cached small PNG, falls back to the original file. */
function Thumb({entry}:{entry:MediaEntry}){
 const key=`${entry.path}\0${entry.size}\0${entry.modified}`;
 const [src,setSrc]=useState(()=>thumbs.get(key)??'');
 useEffect(()=>{
  if(thumbs.has(key)){setSrc(thumbs.get(key)!);return;}
  let alive=true;
  invoke<string>('native_media_thumbnail',{path:entry.path}).then(p=>typeof p==='string'?p:entry.path,()=>entry.path).then(p=>{const s=convertFileSrc(p);thumbs.set(key,s);if(alive)setSrc(s);});
  return()=>{alive=false;};
 },[key]); // eslint-disable-line react-hooks/exhaustive-deps
 return src?<img src={src} alt="" loading="lazy" decoding="async"/>:<span className="media-glyph" aria-hidden="true"/>;
}
/** Renders only the tile rows in view plus two spare rows; unmeasured (jsdom, empty) renders everything. `folder` changes scroll back to the top. */
function Tiles<T>({items,render,folder,...rest}:{items:T[];render:(item:T)=>React.ReactNode;folder:string}&React.HTMLAttributes<HTMLUListElement>){
 const ul=useRef<HTMLUListElement>(null);
 const [view,setView]=useState({top:0,height:0,cols:0,rowH:1});
 // Only re-render on real changes: the padding below alters the content box, so a content-box ResizeObserver would loop (flicker).
 const measure=()=>{const el=ul.current,li=el?.firstElementChild as HTMLElement|null;if(!el||!li?.offsetWidth)return;const gap=6;const next={top:el.scrollTop,height:el.clientHeight,cols:Math.max(1,Math.floor((el.clientWidth+gap)/(li.offsetWidth+gap))),rowH:li.offsetHeight+gap};setView(v=>v.top===next.top&&v.height===next.height&&v.cols===next.cols&&v.rowH===next.rowH?v:next);};
 useLayoutEffect(()=>{if(ul.current)ul.current.scrollTop=0;},[folder]);
 useLayoutEffect(()=>{measure();if(typeof ResizeObserver==='undefined'||!ul.current)return;const ro=new ResizeObserver(measure);ro.observe(ul.current,{box:'border-box'});return()=>ro.disconnect();},[items.length]);
 const rows=view.cols?Math.ceil(items.length/view.cols):0;
 const first=view.cols?Math.min(Math.max(0,rows-1),Math.max(0,Math.floor(view.top/view.rowH)-2)):0;
 const last=view.cols?Math.min(rows,Math.ceil((view.top+view.height)/view.rowH)+2):rows;
 return <ul ref={ul} onScroll={measure} style={view.cols?{paddingTop:2+first*view.rowH,paddingBottom:4+(rows-last)*view.rowH}:undefined} {...rest}>{(view.cols?items.slice(first*view.cols,last*view.cols):items).map(render)}</ul>;
}
/** Environment folders the backend reads from and writes to; shown as quick chips. */
export interface MediaRoots { input?: string; output?: string }
export type MediaSort='date'|'name'|'size';
export interface MediaLibraryProps { selected: MediaItem|null; onSelect: (item: MediaItem) => void; roots?: MediaRoots; /** Bump after a generation finished so an open output folder re-lists. */ outputRevision?: number; /** Case-insensitive name filter. */ filter?: string; /** Folders always come first; files by newest, name or largest. */ sort?: MediaSort }
/** Media library plugin: read-only folder browsing plus drag & drop. Nothing is copied or moved. */
export function MediaLibrary({selected,onSelect,roots={},outputRevision=0,filter='',sort='date'}:MediaLibraryProps){
 const {t}=useI18n();
 const native=isTauri();
 const [listing,setListing]=useState<MediaListing|null>(null);
 const [dropped,setDropped]=useState<MediaItem[]>([]);
 const [error,setError]=useState('');
 const [dragging,setDragging]=useState(false);
 const version=useRef(0);
 const [depth,setDepth]=usePref('media.depth',3,isDepth);
 const open=async(path:string,levels=depth)=>{
  const v=++version.current;
  const key=`${path}\0${levels}`;const cached=listings.get(key);if(cached){setListing(cached);setError('');}
  try{const next=await listMedia(path,levels);listings.set(key,next);if(v===version.current){setListing(next);setError('');}}
  catch(e){listings.delete(key);if(v===version.current){setError(String(e));if(cached)setListing(l=>l===cached?null:l);}} // a stale cached view must not outlive a folder that failed to list
 };
 // The output folder is the natural start once an environment is known; before that, home.
 useEffect(()=>{if(native)void open(roots.output??'');return()=>{version.current++;};},[native,roots.output]);
 const inOutput=!!roots.output&&!!listing&&listing.path.startsWith(roots.output);
 useEffect(()=>{if(outputRevision&&inOutput&&listing)void open(listing.path);},[outputRevision]); // eslint-disable-line react-hooks/exhaustive-deps
 const changeDepth=(levels:number)=>{setDepth(levels);if(listing)void open(listing.path,levels);};
 // Clickable path segments: each opens its prefix (POSIX and Windows roots).
 const crumbs=(path:string)=>{const parts=path.split(/[\\/]+/).filter(Boolean);const root=path.startsWith('/')?'/':'';return parts.map((part,i)=>({label:part,path:root+parts.slice(0,i+1).join('/')}));};
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
 const visible=useMemo(()=>{const q=filter.trim().toLowerCase();return listing?.entries.filter(e=>(e.kind==='directory'||e.media)&&(!q||e.name.toLowerCase().includes(q)))
  .sort((a,b)=>a.kind!==b.kind?(a.kind==='directory'?-1:1):sort==='date'?b.modified-a.modified:sort==='size'?b.size-a.size:a.name.localeCompare(b.name))??[];},[listing,filter,sort]);
 // Only images get real thumbnails: video elements would open one GStreamer pipeline per tile in WebKitGTK.
 const thumb=(media:string|null,src:string|null)=>media==='image'&&src?<img src={src} alt="" loading="lazy"/>:<span className="media-glyph" aria-hidden="true">{media==='video'?'▶':media==='audio'?'♪':'▸'}</span>;
 return <aside className={`media-library${dragging?' is-dragging':''}`} aria-label={t('media.title')}
  onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)}
  onDrop={e=>{e.preventDefault();setDragging(false);addDropped([...e.dataTransfer.files].map(itemFromFile));}}>
  <header className="media-header"><h2>{t('media.title')}</h2>
   {(roots.input||roots.output)&&<div className="media-roots" role="group" aria-label={t('media.roots')}>{(['output','input'] as const).map(key=>roots[key]&&<button key={key} type="button" data-media-root={key} aria-pressed={listing?.path.startsWith(roots[key]!)} onClick={()=>void open(roots[key]!)}>{t(`media.root.${key}`)}</button>)}</div>}
   {listing&&<nav className="media-path" aria-label={t('media.currentFolder')}><button type="button" disabled={!listing.parent} aria-label={t('media.up')} onClick={()=>listing.parent&&void open(listing.parent)}>↑</button>{crumbs(listing.path).map((c,i,all)=><span key={c.path}><button type="button" className="media-crumb" aria-current={i===all.length-1?'location':undefined} onClick={()=>void open(c.path)}>{c.label}</button>{i<all.length-1&&<span className="media-sep" aria-hidden="true">/</span>}</span>)}</nav>}
   <label className="media-depth"><span>{t('media.depth')}</span><select value={depth} onChange={e=>changeDepth(Number(e.target.value))}>{depths.map(d=><option key={d} value={d}>{d}</option>)}</select></label>
   <button type="button" disabled={!native} onClick={()=>void pick()}>{t('media.openFolder')}</button></header>
  {dropped.length>0&&<ul className="media-list" aria-label={t('media.dropped')}>{dropped.map((item,i)=><li key={`${item.src}-${i}`}><button type="button" data-media={item.media} aria-current={selected?.src===item.src} onClick={()=>onSelect(item)}>{thumb(item.media,item.src)}<span className="media-name">{item.name}</span></button></li>)}</ul>}
  {error&&<p className="media-error" role="alert">{error}</p>}
  {listing&&<Tiles folder={listing.path} className="media-list" aria-label={t('media.entries')} items={visible} render={entry=><li key={entry.path}><button type="button" data-kind={entry.kind} data-media={entry.media??undefined} aria-current={selected?.path===entry.path} title={entry.name} onClick={()=>choose(entry)}>{native&&entry.media==='image'?<Thumb entry={entry}/>:thumb(entry.media,null)}<span className="media-name">{entry.name}{entry.symlink&&<span className="media-symlink" aria-label={t('media.symlink')}> ⤳</span>}</span></button></li>}/>}
  <p className="media-help">{listing&&!visible.length&&!error?t('media.empty'):listing?.truncated?t('media.truncated'):t(native?'media.dropHelp':'media.browserHelp')}</p>
 </aside>;
}
