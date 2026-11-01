import { useEffect, useRef, useState } from 'react';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import type { JobIntent } from '../../lib/jobs';
import { isVideoEnhanceIntent, isVideoIntent, type VideoEnhanceIntentV1 } from '../../lib/videoIntent';
import { isMusicIntent } from '../../lib/musicIntent';
import { historicalRows, readHistory, type HistoryRecord } from '../studio/history';
import './monitoring.css';

/** Native `native_monitoring_sample` reply; every field may be absent on an unsupported host. */
export interface MonitoringSample {
 at:number; source:string;
 cpu:{percent:number;count:number}|null; ram:{used:number;total:number}|null; swap:{used:number;total:number}|null;
 disks:{path:string;used:number;total:number}[];
 gpus:{index:number;name:string;utilization:number|null;memoryUsed:number|null;memoryTotal:number|null;temperature:number|null;powerW:number|null;powerLimitW:number|null}[];
 warnings?:string[];
}
export const SAMPLE_LIMIT=60;
const lines=[
 {key:'cpu',color:'#38bdf8',value:(s:MonitoringSample)=>s.cpu?.percent??null},
 {key:'ram',color:'#a78bfa',value:(s:MonitoringSample)=>s.ram&&s.ram.total>0?s.ram.used/s.ram.total*100:null},
 {key:'gpu',color:'#4ade80',value:(s:MonitoringSample)=>s.gpus[0]?.utilization??null},
 {key:'vram',color:'#22d3ee',value:(s:MonitoringSample)=>{const g=s.gpus[0];return g?.memoryUsed!=null&&g.memoryTotal?g.memoryUsed/g.memoryTotal*100:null;}},
] as const;

/** What a finished attempt ran, read from its immutable effective intent. */
export function describeIntent(intent:JobIntent|VideoEnhanceIntentV1):{pipeline:string;model:string;size:string;steps:number|null;seed:number|null} {
 if(isVideoEnhanceIntent(intent))return {pipeline:'video-enhance',model:'',size:'',steps:null,seed:intent.seed};
 if(isMusicIntent(intent))return {pipeline:`music/${intent.mode}`,model:intent.checkpoint,size:`${intent.maxDuration}s`,steps:null,seed:intent.seed};
 if(isVideoIntent(intent))return {pipeline:`${intent.family}${intent.family==='minimax-h3'?`/${intent.h3.mode}`:''}`,model:intent.model,size:`${intent.width}×${intent.height} · ${intent.frames}f @ ${intent.frameRate}`,steps:intent.steps,seed:intent.seed};
 return {pipeline:intent.inputImage?'i2i':'t2i',model:intent.checkpoint,size:`${intent.width}×${intent.height}`,steps:intent.steps,seed:intent.seed};
}
/** queued = admission → start; running = start → generation end (or last observation while no end is known). */
export function timeline(r:HistoryRecord):{queuedMs:number;runningMs:number;wallMs:number} {
 const started=r.startedAt??null;
 const queuedMs=Math.max(0,(started??r.observedAt)-r.admittedAt);
 const runningMs=started==null?0:Math.max(0,r.generationMs??(r.observedAt-started));
 return {queuedMs,runningMs,wallMs:queuedMs+runningMs};
}
const gib=(bytes:number,locale:string)=>new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(bytes/2**30)+' GiB';
const seconds=(ms:number,locale:string)=>new Intl.NumberFormat(locale,{style:'unit',unit:'second',unitDisplay:'short',maximumFractionDigits:1}).format(ms/1000);

function Graph({samples,label}:{samples:MonitoringSample[];label:string}){
 const canvas=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{
  const el=canvas.current,ctx=el?.getContext('2d');if(!el||!ctx)return;
  const w=el.width,h=el.height;ctx.clearRect(0,0,w,h);
  ctx.strokeStyle='rgba(255,255,255,.12)';ctx.lineWidth=1;
  for(const y of [0.25,0.5,0.75]){ctx.beginPath();ctx.moveTo(0,y*h);ctx.lineTo(w,y*h);ctx.stroke();}
  const step=w/(SAMPLE_LIMIT-1);
  for(const line of lines){
   ctx.strokeStyle=line.color;ctx.lineWidth=1.5;ctx.beginPath();let pen=false;
   samples.forEach((s,i)=>{const v=line.value(s);const x=w-(samples.length-1-i)*step;if(v==null){pen=false;return;}const y=h-Math.min(100,Math.max(0,v))/100*h;if(pen)ctx.lineTo(x,y);else ctx.moveTo(x,y);pen=true;});
   ctx.stroke();
  }
 },[samples]);
 return <canvas ref={canvas} className="monitoring-graph" width={600} height={160} role="img" aria-label={label} data-monitoring-graph/>;
}

/** Monitoring tab: the last ten native attempts with their timing, and live host/GPU telemetry while the tab is visible. */
export function Monitoring({active,root}:{active:boolean;root?:string}){
 const {t,locale}=useI18n();
 const [records,setRecords]=useState<HistoryRecord[]>([]);
 const [historyFailed,setHistoryFailed]=useState(false);
 const [samples,setSamples]=useState<MonitoringSample[]>([]);
 const [sampleError,setSampleError]=useState('');
 const native=isTauri();
 useEffect(()=>{
  if(!active||!native)return;
  let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
  const read=async()=>{
   try{const value=await readHistory();if(alive){setRecords(historicalRows(value.records));setHistoryFailed(false);}}
   catch{if(alive)setHistoryFailed(true);}
   finally{if(alive)timer=setTimeout(()=>void read(),2000);}
  };
  void read();return()=>{alive=false;clearTimeout(timer);};
 },[active,native]);
 useEffect(()=>{
  if(!active||!native)return;
  let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{
   if(document.visibilityState==='visible'){
    try{const s=await invoke<MonitoringSample>('native_monitoring_sample',{root:root??null});if(alive){setSamples(prev=>[...prev,s].slice(-SAMPLE_LIMIT));setSampleError('');}}
    catch(e){if(alive)setSampleError(String(e));}
   }
   if(alive)timer=setTimeout(()=>void poll(),1000);
  };
  void poll();return()=>{alive=false;clearTimeout(timer);};
 },[active,native,root]);
 const finished=records.filter(r=>r.state!=='queued'&&r.state!=='running').slice(0,10);
 const latest=finished.find(r=>r.state==='succeeded'&&r.generationMs!=null);
 const maxWall=Math.max(1,...finished.map(r=>timeline(r).wallMs));
 const current=samples[samples.length-1];
 const pct=(v:number|null|undefined)=>v==null?'—':`${Math.round(v)} %`;
 return <section className="monitoring" data-monitoring aria-label={t('monitoring.title')}>
  <header className="monitoring-heading"><div><p className="eyebrow">{t('monitoring.tab')}</p><h2>{t('monitoring.title')}</h2></div>
   {latest&&<p className="monitoring-headline" data-monitoring-headline><strong>{seconds(latest.generationMs!,locale)}</strong><span>{t('monitoring.lastDuration')}</span></p>}</header>
  {!native&&<p className="field-help">{t('studio.history.native')}</p>}
  <div className="monitoring-columns">
   <section className="monitoring-panel" aria-labelledby="monitoring-generations"><h3 id="monitoring-generations">{t('monitoring.generations')}</h3>
    {historyFailed&&<p className="error-message" role="alert">{t('studio.history.failed')}</p>}
    {native&&!historyFailed&&finished.length===0&&<p className="field-help">{t('studio.history.empty')}</p>}
    {finished.length>0&&<table className="monitoring-table"><thead><tr><th>{t('monitoring.col.outcome')}</th><th>{t('monitoring.col.pipeline')}</th><th>{t('monitoring.col.model')}</th><th>{t('monitoring.col.size')}</th><th>{t('monitoring.col.steps')}</th><th>{t('monitoring.col.seed')}</th><th>{t('monitoring.col.queued')}</th><th>{t('monitoring.col.duration')}</th><th>{t('monitoring.col.timeline')}</th></tr></thead>
     <tbody>{finished.map(r=>{const d=describeIntent(r.intent),tl=timeline(r);return <tr key={r.id} data-monitoring-row={r.state}>
      <td><span data-state={r.state}>{t(`studio.jobs.${r.state}`)}</span></td><td>{d.pipeline}</td><td className="monitoring-model" title={d.model}>{d.model}</td><td>{d.size}</td><td>{d.steps??'—'}</td><td>{d.seed??'—'}</td>
      <td>{seconds(tl.queuedMs,locale)}</td><td>{r.generationMs!=null?seconds(r.generationMs,locale):'—'}</td>
      <td><div className="monitoring-timeline" role="img" aria-label={t('monitoring.timeline',{queued:seconds(tl.queuedMs,locale),running:seconds(tl.runningMs,locale)})}><span className="is-queued" style={{width:`${tl.queuedMs/maxWall*100}%`}}/><span className={`is-${r.state}`} style={{width:`${tl.runningMs/maxWall*100}%`}}/></div></td>
     </tr>;})}</tbody></table>}
   </section>
   <section className="monitoring-panel" aria-labelledby="monitoring-system"><h3 id="monitoring-system">{t('monitoring.system')}</h3>
    {sampleError&&<p className="error-message" role="alert">{sampleError}</p>}
    {current&&<>
     <dl className="monitoring-values" data-monitoring-values>
      <div><dt>{t('monitoring.cpu')}</dt><dd>{pct(current.cpu?.percent)}{current.cpu?` · ${current.cpu.count} ${t('monitoring.threads')}`:''}</dd></div>
      <div><dt>{t('monitoring.ram')}</dt><dd>{current.ram?`${gib(current.ram.used,locale)} / ${gib(current.ram.total,locale)}`:'—'}</dd></div>
      {current.swap&&current.swap.total>0&&<div><dt>{t('monitoring.swap')}</dt><dd>{gib(current.swap.used,locale)} / {gib(current.swap.total,locale)}</dd></div>}
      {current.disks.map(d=><div key={d.path}><dt>{t('monitoring.disk')}</dt><dd title={d.path}>{gib(d.used,locale)} / {gib(d.total,locale)}</dd></div>)}
      {current.gpus.map(g=><div key={g.index} className="monitoring-gpu"><dt>{`${t('monitoring.gpu')}${g.index} · ${g.name}`}</dt><dd>{t('monitoring.gpuUtil')} {pct(g.utilization)} · {t('monitoring.vram')} {g.memoryUsed!=null&&g.memoryTotal!=null?`${gib(g.memoryUsed,locale)} / ${gib(g.memoryTotal,locale)}`:'—'} · {g.temperature!=null?`${Math.round(g.temperature)} °C`:'—'} · {g.powerW!=null?`${Math.round(g.powerW)} W${g.powerLimitW!=null?` / ${Math.round(g.powerLimitW)} W`:''}`:'—'}</dd></div>)}
      {current.gpus.length===0&&<div><dt>{t('monitoring.gpu')}</dt><dd>{t('monitoring.noGpu')}</dd></div>}
     </dl>
     <Graph samples={samples} label={t('monitoring.graph')}/>
     <ul className="monitoring-legend">{lines.map(l=><li key={l.key}><span style={{background:l.color}}/>{t(`monitoring.${l.key}`)}</li>)}</ul>
     <p className="field-help">{t('monitoring.source',{source:current.source})}{current.warnings?.length?` · ${current.warnings.join(' · ')}`:''}</p>
    </>}
   </section>
  </div>
 </section>;
}
