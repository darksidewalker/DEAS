import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { TemporalPreviewData } from '../../lib/jobs';
import { NativeVideo, nativeVideo } from './NativeVideo';

type Props={preview:TemporalPreviewData;active:boolean;label:string;fallback?:string};
export function TemporalPreview(props:Props) {
 // Keying on revision would tear down the player for every preview bump and restart playback at zero.
 return <TemporalPreviewRevision key={props.preview.nodeId} {...props}/>;
}
function TemporalPreviewRevision({preview,active,label,fallback}:Props) {
 const canvas=useRef<HTMLCanvasElement>(null);
 const [video,setVideo]=useState<{revision:number;src:string}>();
 const [failed,setFailed]=useState(false);
 const owner=useRef('');
 const position=useRef(0);
 // A revision bump resets a failed open before render so the frames canvas remounts (the effect needs its context).
 const [seen,setSeen]=useState(preview.revision);
 if(seen!==preview.revision){setSeen(preview.revision);setFailed(false);}
 const fail=()=>{setFailed(true);if(isTauri())void invoke('native_video_update',{id:owner.current,action:{kind:'previewError'}}).catch(()=>{});};
 useEffect(()=>{
  let disposed=false,frame=0;
  owner.current=crypto.randomUUID();
  setFailed(false);setVideo(undefined);
  if(!active)return;
  if(preview.video){
   if(!nativeVideo())void invoke<string>('native_video_open',{id:owner.current,source:preview.video,autoPlay:true,repeat:true,muted:true}).then(src=>{if(!disposed)setVideo({revision:preview.revision,src});},()=>{if(!disposed)fail();});
  }else{
   const context=canvas.current?.getContext('2d');
   if(!context){fail();return;}
   const frames=preview.frames;
   const images=frames.map(f=>{const image=new Image();image.src=f.src;return image;});
   const loads=images.map(image=>new Promise<void>((resolve,reject)=>{if(image.complete&&image.naturalWidth)resolve();else{image.onload=()=>resolve();image.onerror=reject;}}));
   void Promise.all(loads).then(()=>{
    if(disposed||!context)return;
    let start:number|undefined;
    const total=frames.reduce((sum,f)=>sum+f.durationMs,0);
    const paint=(now:number)=>{
     if(disposed)return;
     start??=now;let elapsed=(now-start)%total,index=0;
     while(index<frames.length-1&&elapsed>=frames[index].durationMs){elapsed-=frames[index].durationMs;index++;}
     context.drawImage(images[index],0,0,preview.width,preview.height);
     frame=requestAnimationFrame(paint);
    };
    frame=requestAnimationFrame(paint);
   },()=>{if(!disposed)fail();});
   return()=>{disposed=true;cancelAnimationFrame(frame);images.forEach(image=>{image.onload=null;image.onerror=null;image.src='';});};
  }
  return()=>{disposed=true;cancelAnimationFrame(frame);};
 },[preview.revision,preview.nodeId,active]);
 if(failed)return fallback?<img src={fallback} alt={label}/>:null;
 if(preview.video){
  if(nativeVideo())return <NativeVideo source={preview.video} active={active} label={label} autoPlay loop muted resume={position.current} onStatus={status=>{if(status.error)fail();else if(status.position>=position.current-0.75)position.current=status.position;}}/>;
  return active&&video?.revision===preview.revision?<video src={video.src} aria-label={label} autoPlay loop muted playsInline onTimeUpdate={event=>{const el=event.currentTarget;if(el.currentTime>=position.current-0.75)position.current=el.currentTime;}} onLoadedMetadata={event=>{const el=event.currentTarget;if(position.current>0&&position.current<(el.duration||0))el.currentTime=position.current;}} onError={fail}/>:fallback?<img src={fallback} alt={label}/>:null;
 }
 return <canvas ref={canvas} width={preview.width} height={preview.height} role="img" aria-label={label}/>;
}
