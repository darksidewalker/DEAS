import {useEffect,useImperativeHandle,useRef,useState,type Ref} from 'react';
import {useI18n} from '../../i18n/I18nProvider';
import {oneOf,usePref} from '../../lib/preferences';
import {sourcePoint,zoomAt,stampStroke,maskBounds,type ImageLayer,type Point,type View} from './imageEditor';
import './imageEditor.css';
export interface EditorHandle{maskPng:()=>Promise<Uint8Array>;maskBounds:(padding:number)=>{x:number;y:number;width:number;height:number}}
type Mask={id:string;n:number;visible:boolean;canvas:HTMLCanvasElement;content:boolean};
export type Props={ref?:Ref<EditorHandle>;source:{src:string;name:string;width:number;height:number};layers:ImageLayer[];onLayers:(layers:ImageLayer[])=>void;maskMode:boolean;onMask:(present:boolean)=>void};
const diameterOK=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=2&&v<=1024;
const opacityOK=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=100;
const icons={select:'M5 3l13 7-6 1.5L9 18z',brush:'M19 3l2 2-9 9-2-2zM9 13c-3 0-4 2-4 4s-1 3-3 3c3 1 8 1 9-4',erase:'M15 4l5 5-10 10H6l-3-3zM8.5 10.5l5 5M11 19h10',pan:'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3'};
const Icon=({d}:{d:string})=><svg viewBox="0 0 24 24" aria-hidden="true"><path d={d}/></svg>;
function newMask(n:number,width:number,height:number):Mask{
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  return {id:crypto.randomUUID(),n,visible:true,canvas,content:false};
}
function Thumbnail({mask,revision}:{mask:Mask;revision:number}){
  const ref=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{const c=ref.current,ctx=c?.getContext('2d');if(c&&ctx){ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(mask.canvas,0,0,c.width,c.height);}},[mask,revision]);
  return <canvas ref={ref} width={44} height={36} aria-hidden="true"/>;
}
export function StudioImageEditor({ref,source,layers,onLayers,maskMode,onMask}:Props){
  const {t}=useI18n(),label=(key:string)=>t(`studio.editor.${key}`);
  const viewport=useRef<HTMLDivElement>(null),world=useRef<HTMLDivElement>(null),overlay=useRef<HTMLCanvasElement>(null);
  const cursor=useRef<HTMLDivElement>(null);
  const [view,setView]=useState<View>({scale:1,x:0,y:0});
  const [tool,setTool]=useState<'select'|'brush'|'erase'|'pan'>(maskMode?'brush':'select');
  const [diameter,setDiameter]=usePref('studio.run.brush',48,diameterOK);
  const [shape,setShape]=usePref('studio.editor.shape','round',oneOf('round','square'));
  const [opacity,setOpacity]=usePref('studio.editor.overlay',50,opacityOK);
  const [masks,setMasks]=useState<Mask[]>(()=>[newMask(1,source.width,source.height)]);
  const nextMask=useRef(2),[active,setActive]=useState('mask:1'),[revision,setRevision]=useState(0),[error,setError]=useState('');
  const masksRef=useRef(masks);masksRef.current=masks;
  const gesture=useRef<null|{pointer:number;kind:'paint';mask:Mask;last:Point;erase:boolean;diameter:number;shape:'round'|'square'}|{pointer:number;kind:'pan';start:Point;view:View}|{pointer:number;kind:'move'|'resize';start:Point;layer:ImageLayer}>(null);
  const activeMask=masks.find(m=>`mask:${m.n}`===active);
  const activeImage=layers.find(l=>l.id===active);
  const brushEnabled=maskMode&&!!activeMask?.visible;
  const painting=tool==='brush'||tool==='erase';
  function track(e:React.PointerEvent){const c=cursor.current,r=viewport.current?.getBoundingClientRect();if(c&&r){c.style.left=`${e.clientX-r.left}px`;c.style.top=`${e.clientY-r.top}px`;c.hidden=false;}}
  function fail(){setError(label('canvasError'));onMask(false);}
  function redraw(){
    const c=overlay.current,ctx=c?.getContext('2d');if(!c||!ctx){fail();return;}
    ctx.clearRect(0,0,c.width,c.height);
    for(const m of masksRef.current)if(m.visible)ctx.drawImage(m.canvas,0,0);
    setRevision(r=>r+1);
  }
  function finish(){
    const g=gesture.current;gesture.current=null;
    if(g?.kind==='paint'){
      try{const ctx=g.mask.canvas.getContext('2d');if(!ctx)throw Error();
        const pixels=ctx.getImageData(0,0,source.width,source.height).data;
        g.mask.content=false;for(let i=3;i<pixels.length;i+=4)if(pixels[i]){g.mask.content=true;break;}
        onMask(masksRef.current.some(m=>m.visible&&m.content));redraw();
      }catch{fail();}
    }
  }
  // Stays fitted across viewport resizes (e.g. entering side-by-side compare) until the user zooms or pans.
  const auto=useRef(true);
  function fit(){const r=viewport.current?.getBoundingClientRect();if(r&&r.width>0&&r.height>0){auto.current=true;const scale=Math.min(r.width/source.width,r.height/source.height);setView({scale,x:(r.width-source.width*scale)/2,y:(r.height-source.height*scale)/2});}}
  useEffect(()=>{fit();const el=viewport.current;if(!el||typeof ResizeObserver==='undefined')return;const ro=new ResizeObserver(()=>{if(auto.current&&!gesture.current)fit();});ro.observe(el);return()=>ro.disconnect();},[source.width,source.height]);
  useEffect(()=>{
    const el=viewport.current;if(!el)return;
    const wheel=(e:WheelEvent)=>{e.preventDefault();if(gesture.current)return;auto.current=false;const r=el.getBoundingClientRect();setView(v=>zoomAt(v,{x:e.clientX-r.left,y:e.clientY-r.top},v.scale*Math.exp(-e.deltaY*.001)));};
    el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);
  },[]);
  const priorMaskMode=useRef(maskMode);
  useEffect(()=>{
    if(maskMode&&!priorMaskMode.current&&activeMask?.visible)setTool('brush');
    if(!maskMode)setTool('select');
    priorMaskMode.current=maskMode;
  },[maskMode]);
  useEffect(()=>{onMask(masks.some(m=>m.visible&&m.content));redraw();},[masks]);
  const previousImageIds=useRef(new Set(layers.map(l=>l.id)));
  useEffect(()=>{const added=layers.find(l=>!previousImageIds.current.has(l.id));previousImageIds.current=new Set(layers.map(l=>l.id));if(added){setActive(added.id);setTool('select');}},[layers]);
  useEffect(()=>()=>{gesture.current=null;},[]);
  function maskCanvas(){
    finish();const c=document.createElement('canvas');c.width=source.width;c.height=source.height;
    const ctx=c.getContext('2d');if(!ctx)throw new Error(label('canvasError'));
    if(!masksRef.current.some(m=>m.visible&&m.content))throw new Error(label('emptyMask'));
    ctx.fillStyle='#000';ctx.fillRect(0,0,c.width,c.height);
    for(const m of masksRef.current)if(m.visible)ctx.drawImage(m.canvas,0,0);
    return c;
  }
  useImperativeHandle(ref,()=>({maskBounds:(padding)=>{
    const c=maskCanvas(),bounds=maskBounds(c.getContext('2d')!.getImageData(0,0,c.width,c.height).data,c.width,c.height,padding);
    if(!bounds)throw new Error(label('emptyMask'));
    return bounds;
  },maskPng:async()=>{
    const c=maskCanvas();
    const blob=await new Promise<Blob|null>(done=>c.toBlob(done,'image/png'));
    if(!blob)throw new Error(label('canvasError'));
    return new Uint8Array(await blob.arrayBuffer());
  }}));
  function point(e:{clientX:number;clientY:number}){return sourcePoint(e.clientX,e.clientY,world.current!.getBoundingClientRect(),source.width,source.height);}
  function begin(e:React.PointerEvent,layer?:ImageLayer,resize=false){
    if(gesture.current||(![0,1].includes(e.button)))return;
    const pan=e.button===1||tool==='pan';
    if(!pan&&!layer&&(!brushEnabled||(tool!=='brush'&&tool!=='erase')))return;
    if(!pan&&layer&&tool!=='select')return;
    e.preventDefault();e.stopPropagation();viewport.current?.setPointerCapture(e.pointerId);
    if(pan){auto.current=false;gesture.current={pointer:e.pointerId,kind:'pan',start:{x:e.clientX,y:e.clientY},view};}
    else if(layer){setActive(layer.id);gesture.current={pointer:e.pointerId,kind:resize?'resize':'move',start:point(e),layer:{...layer}};}
    else if(activeMask){
      const p=point(e);if(p.x<0||p.y<0||p.x>=source.width||p.y>=source.height)return;
      const ctx=activeMask.canvas.getContext('2d');if(!ctx){fail();return;}
      gesture.current={pointer:e.pointerId,kind:'paint',mask:activeMask,last:p,erase:tool==='erase',diameter,shape};
      stampStroke(ctx,p,p,diameter,shape,tool==='erase');redraw();
    }
  }
  function move(e:React.PointerEvent){
    track(e);
    const g=gesture.current;if(!g||g.pointer!==e.pointerId)return;
    if(g.kind==='pan'){setView({...g.view,x:g.view.x+e.clientX-g.start.x,y:g.view.y+e.clientY-g.start.y});return;}
    const p=point(e);
    if(g.kind==='paint'){const ctx=g.mask.canvas.getContext('2d');if(!ctx){fail();return;}stampStroke(ctx,g.last,p,g.diameter,g.shape,g.erase);g.last=p;redraw();return;}
    const dx=Math.round(p.x-g.start.x),dy=Math.round(p.y-g.start.y),l=g.layer;
    const width=Math.max(8,Math.min(8192,l.width+dx));
    onLayers(layers.map(v=>v.id!==l.id?v:g.kind==='move'?{...v,x:Math.max(0,Math.min(source.width-1,l.x+dx)),y:Math.max(0,Math.min(source.height-1,l.y+dy))}:{...v,width,height:Math.max(8,Math.min(8192,Math.round(width*l.height/l.width)))}));
  }
  function imageKey(e:React.KeyboardEvent,l:ImageLayer){
    if(tool!=='select')return;const step=e.shiftKey?64:8;
    const dx=e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0,dy=e.key==='ArrowDown'?step:e.key==='ArrowUp'?-step:0;
    if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();onLayers(layers.filter(v=>v.id!==l.id));setActive('base');return;}
    const grow=e.key==='+'?step:e.key==='-'?-step:0;if(!dx&&!dy&&!grow)return;e.preventDefault();
    const width=Math.max(8,Math.min(8192,l.width+grow));
    onLayers(layers.map(v=>v.id!==l.id?v:{...v,x:Math.max(0,Math.min(source.width-1,l.x+dx)),y:Math.max(0,Math.min(source.height-1,l.y+dy)),...(grow?{width,height:Math.max(8,Math.min(8192,Math.round(width*l.height/l.width)))}:{})}));
  }
  function reorder(delta:number){const i=layers.findIndex(l=>l.id===active),j=i+delta;if(i<0||j<0||j>=layers.length)return;const next=[...layers];[next[i],next[j]]=[next[j],next[i]];onLayers(next);}
  function row(id:string,name:string,thumb:React.ReactNode,visible:boolean,choose:()=>void,toggle?:()=>void,remove?:()=>void){return <li key={id}><button type="button" aria-pressed={active===id} onClick={()=>{finish();setActive(id);choose();}}>{thumb}<span>{name}</span></button>{toggle&&<button type="button" aria-label={t(`studio.editor.${visible?'hide':'show'}`,{name})} onClick={()=>{finish();toggle();}}>{visible?'◉':'○'}</button>}{remove&&<button type="button" aria-label={t('studio.editor.remove',{name})} onClick={()=>{finish();remove();}}>×</button>}</li>;}
  return <section className="sie" aria-label={label('title')}>
    <div className="sie-tools" role="toolbar" aria-label={label('title')}>
      <span className="sie-seg">{(maskMode?['select','brush','erase','pan'] as const:['select','pan'] as const).map(v=><button type="button" className="sie-tool" key={v} aria-pressed={tool===v} disabled={(v==='brush'||v==='erase')&&!brushEnabled} onClick={()=>{finish();setTool(v);}}><Icon d={icons[v]}/>{label(v)}</button>)}</span>
      {maskMode&&<>
      <label>{label('diameter')}<input type="number" min={2} max={1024} value={diameter} onChange={e=>{const n=Number(e.target.value);if(diameterOK(n))setDiameter(n);}}/></label>
      <input type="range" aria-label={label('diameter')} min={2} max={1024} value={diameter} onChange={e=>setDiameter(Number(e.target.value))}/>
      <span className="sie-seg" role="group" aria-label={label('shape')}>{(['round','square'] as const).map(v=><button type="button" className="sie-tool" key={v} aria-pressed={shape===v} onClick={()=>setShape(v)}><i className={`sie-shape is-${v}`} aria-hidden="true"/>{label(v)}</button>)}</span>
      <button type="button" className="sie-tool" disabled={!brushEnabled} onClick={()=>{finish();const m=activeMask;if(!m)return;try{const ctx=m.canvas.getContext('2d');if(!ctx)throw Error();ctx.clearRect(0,0,source.width,source.height);m.content=false;onMask(masks.some(v=>v.visible&&v.content));redraw();}catch{fail();}}}>{t('studio.run.edit.clear')}</button>
      </>}
      <span className="sie-view">
      <button type="button" aria-label={label('zoomOut')} onClick={()=>{finish();auto.current=false;setView(v=>zoomAt(v,{x:(viewport.current?.clientWidth??0)/2,y:(viewport.current?.clientHeight??0)/2},v.scale/1.25));}}>−</button>
      <button type="button" onClick={()=>{finish();fit();}}>{label('fit')}</button>
      <button type="button" onClick={()=>{finish();auto.current=false;setView(v=>zoomAt(v,{x:(viewport.current?.clientWidth??0)/2,y:(viewport.current?.clientHeight??0)/2},1));}}>{label('actual')}</button>
      <button type="button" aria-label={label('zoomIn')} onClick={()=>{finish();auto.current=false;setView(v=>zoomAt(v,{x:(viewport.current?.clientWidth??0)/2,y:(viewport.current?.clientHeight??0)/2},v.scale*1.25));}}>+</button>
      {maskMode&&<label>{label('overlay')}<input type="range" min={0} max={100} value={opacity} onChange={e=>setOpacity(Number(e.target.value))}/></label>}
      </span>
    </div>
    <div className="sie-body">
      <div ref={viewport} className="sie-viewport" data-editor-viewport data-tool={painting&&!brushEnabled?'off':tool} onPointerDown={e=>{track(e);begin(e);}} onPointerMove={move} onPointerLeave={()=>{if(cursor.current)cursor.current.hidden=true;}} onPointerUp={e=>{if(gesture.current?.pointer===e.pointerId)finish();}} onPointerCancel={finish} onLostPointerCapture={finish}>
        <div ref={world} className="sie-world" data-testid="editor-world" style={{width:source.width,height:source.height,transform:`translate(${view.x}px, ${view.y}px) scale(${view.scale})`}}>
          <img className="sie-base" src={source.src} alt={source.name} draggable={false}/>
          {layers.filter(l=>l.visible).map(l=><div className={`sie-image${active===l.id?' is-selected':''}`} key={l.id} role="group" aria-label={t('studio.run.edit.layer',{name:l.name})} tabIndex={0} style={{left:l.x,top:l.y,width:l.width,height:l.height,pointerEvents:tool==='select'?'auto':'none'}} onFocus={()=>setActive(l.id)} onPointerDown={e=>begin(e,l)} onKeyDown={e=>imageKey(e,l)}><img src={l.src} alt="" draggable={false}/>{active===l.id&&tool==='select'&&<button className="sie-resize" type="button" aria-label={t('studio.editor.resize',{name:l.name})} onPointerDown={e=>begin(e,l,true)}>↘</button>}</div>)}
          <canvas ref={overlay} className="sie-mask" aria-label={t('studio.run.edit.mask')} width={source.width} height={source.height} style={{opacity:maskMode?opacity/100:0}}/>
        </div>
        {painting&&brushEnabled&&<div ref={cursor} className={`sie-cursor is-${shape}${tool==='erase'?' is-erase':''}`} hidden aria-hidden="true" style={{width:diameter*view.scale,height:diameter*view.scale}}/>}
      </div>
      <aside className="sie-rail" aria-label={label('layers')}>
        {maskMode&&<button type="button" disabled={masks.length>=4} onClick={()=>{finish();const n=nextMask.current++;setMasks(v=>[...v,newMask(n,source.width,source.height)]);setActive(`mask:${n}`);setTool('brush');}}>{label('addMask')}</button>}
        <ul>{maskMode&&[...masks].reverse().map(m=>{const name=t('studio.editor.mask',{n:String(m.n)});return row(`mask:${m.n}`,name,<Thumbnail mask={m} revision={revision}/>,m.visible,()=>setTool('brush'),()=>setMasks(v=>v.map(x=>x.id===m.id?{...x,visible:!x.visible}:x)),()=>{setMasks(v=>v.filter(x=>x.id!==m.id));if(active===`mask:${m.n}`){setActive('base');setTool('select');}});})}
          {[...layers].reverse().map(l=>row(l.id,l.name,<img src={l.src} alt=""/>,l.visible,()=>setTool('select'),()=>onLayers(layers.map(x=>x.id===l.id?{...x,visible:!x.visible}:x)),()=>{onLayers(layers.filter(x=>x.id!==l.id));if(active===l.id)setActive('base');}))}
          {row('base',label('base'),<img src={source.src} alt=""/>,true,()=>setTool('select'))}</ul>
        <button type="button" disabled={!activeImage||layers.at(-1)?.id===active} onClick={()=>reorder(1)}>{label('raise')}</button>
        <button type="button" disabled={!activeImage||layers[0]?.id===active} onClick={()=>reorder(-1)}>{label('lower')}</button>
      </aside>
    </div>{error&&<p role="alert">{error}</p>}
  </section>;
}
