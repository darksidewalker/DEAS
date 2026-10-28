import { useEffect, useState } from 'react';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import type { VideoRef } from './ReferencesPanel';

/** Static selected-frame preview: native video never creates a WebKit decoder. */
export function ReferenceThumbnail({reference:r}:{reference:VideoRef}){
 const [frame,setFrame]=useState('');
 const start=r.trimStart??0,key=`${r.item.src}:${start}`;
 useEffect(()=>{
  setFrame('');
  if(r.item.media!=='video'||!isTauri()||!r.item.path)return;
  let alive=true;
  void invoke<string>('native_media_reference_thumbnail',{path:r.item.path,seconds:start}).then(path=>{if(alive)setFrame(convertFileSrc(path));},()=>{});
  return()=>{alive=false;};
 },[key,r.item.media,r.item.path]);
 if(r.item.media==='image')return <img src={r.item.src} alt={r.item.name} loading="lazy" draggable={false}/>;
 if(r.item.media==='video'){
  if(isTauri())return frame?<img src={frame} alt={r.item.name} draggable={false}/>:<span aria-hidden="true">▸</span>;
  return <video key={key} src={r.item.src} muted preload="metadata" playsInline aria-label={r.item.name} onLoadedMetadata={e=>{e.currentTarget.currentTime=start;}}/>;
 }
 return <span aria-hidden="true">♫</span>;
}
