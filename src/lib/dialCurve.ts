import type { H3DialCurve } from './videoIntent';
import { videoFrames } from './videoIntent';
import { DIAL_LEVEL, DIAL_POINTS, DIAL_SECONDS, isDialCurve, isDialRows, type DialRow } from './dials';

/**
 * Time-curve maths and editing for the experimental Dial Rack dialog (docs/DIALS.md). The sampler mirrors the pack's
 * `dials/envelopes.py::keyframes` and `dials/timecurve.py::curve_fn`/`frame_weights` (ComfyUI-MAINodes 382f640) and is tested against
 * values computed by those functions (`dialCurve.fixture.json`). Editing is pure: the dialog owns no curve logic of its own.
 */
/** Seconds a point keeps from its neighbours: one latent frame (four pixel frames at 24 fps). */
export const DIAL_GAP=1/6;
export const DIAL_SNAP=0.1;
export const DIAL_LEVEL_SNAP=0.05;
/** Default ramp of the presets. Renders showed changes over about 1.5 s whatever the authored ramp (pack docs, TIMECURVE.md). */
export const DIAL_RAMP=1.5;
const H3_FPS=24,FRAME_PER_TOKEN=[1,4,4,4,4] as const;
type Points=H3DialCurve['points'];
const r4=(v:number)=>Math.round(v*1e4)/1e4;
const clamp=(v:number,lo:number,hi:number)=>Math.min(hi,Math.max(lo,v));

/** The curve's level at each of `times` (seconds), held flat before the first and after the last point. */
export function sampleDialCurve(curve:Pick<H3DialCurve,'points'|'interp'|'smooth'>,times:readonly number[]):number[] {
 const p=curve.points,n=p.length-1,smooth=curve.smooth??0;
 if(curve.interp==='step')return times.map(t=>{let i=0;while(i<n&&p[i+1][0]<=t)i++;return p[i][1];});
 if(!smooth||n<1)return times.map(t=>{
  if(t<=p[0][0])return p[0][1];
  if(t>=p[n][0])return p[n][1];
  let i=0;while(p[i+1][0]<=t)i++;
  return p[i][1]+(p[i+1][1]-p[i][1])*(t-p[i][0])/(p[i+1][0]-p[i][0]);
 });
 // Rate smoothing: each point gets one rate (the harmonic mean of its two secants, 0 at the ends and at a sign change); over s/2 of each
 // neighbouring interval the rate moves linearly between it and the interval's middle rate k. C1, piecewise quadratic, no overshoot.
 const h=p.slice(1).map(([t],i)=>t-p[i][0]),d=h.map((v,i)=>(p[i+1][1]-p[i][1])/v);
 const m=p.map((_,i)=>i&&i<n&&d[i-1]*d[i]>0?2*d[i-1]*d[i]/(d[i-1]+d[i]):0);
 const w=h.map(v=>smooth*v/2),k=d.map((v,i)=>(v-smooth*(m[i]+m[i+1])/4)/(1-smooth/2));
 return times.map(t=>{
  let i=0;while(i<n-1&&p[i+1][0]<=t)i++;
  const u=clamp(t-p[i][0],0,h[i]),v=h[i]-u;
  if(u<w[i])return p[i][1]+m[i]*u+(k[i]-m[i])*u*u/(2*w[i]);
  if(v<w[i])return p[i+1][1]-m[i+1]*v-(k[i]-m[i+1])*v*v/(2*w[i]);
  return p[i][1]+(m[i]+k[i])*w[i]/2+k[i]*(u-w[i]);
 });
}
/** Pixel-frame index at which each H3 video latent frame starts, plus the clip's end: latent frames cover 1, 4, 4, 4, 4 pixel frames. */
export function latentFrameStarts(frames:number):number[] {
 const f=[0];
 for(let k=0;f[k]<frames;k++)f.push(f[k]+FRAME_PER_TOKEN[k%5]);
 return f;
}
/** What the model gets: one level per video latent frame, the curve's mean over that frame's pixel frames (`frame_weights`). */
export function dialFrameLevels(curve:Pick<H3DialCurve,'points'|'interp'|'smooth'>,frames:number):{start:number;end:number;level:number}[] {
 const f=latentFrameStarts(frames);
 return f.slice(1).map((end,k)=>{
  const levels=sampleDialCurve(curve,Array.from({length:end-f[k]},(_,j)=>(f[k]+j)/H3_FPS));
  return {start:f[k]/H3_FPS,end:end/H3_FPS,level:levels.reduce((a,b)=>a+b,0)/levels.length};
 });
}

/** The seconds the lanes cover. `edges` are segment ends inside the piece (Continuity plan), for drawing and snapping. */
export interface DialTimeline { seconds:number; frames:number; edges:number[]; basis:'clip'|'plan'|'planSource' }
/**
 * Mirror of native `continuation_extension`: the new frames a continued Continuity step adds, in 17-frame steps. The Director snaps the
 * duration it receives. With `byDuration` that is the step's seconds (the intent carries `h3.continuity.durationSeconds`; Studio sends it
 * for REF2VA only). Otherwise it is the step's own clip length, frames / 24 with frames = 17k + 5, so the snap runs on frames / 17.
 * The two differ on some lengths: 1 s adds 17 frames by duration and 34 by frames.
 */
export const continuationFrames=(seconds:number,byDuration:boolean)=>Math.max(1,Math.floor((byDuration?seconds*H3_FPS:videoFrames('minimax-h3',seconds,H3_FPS))/17+0.5))*17;
/**
 * Lane length. Without a Continuity plan it is the clip the next job renders (its real frame count, 17k + 5 at 24 fps, not the typed
 * seconds). With a plan it is the whole piece: the first step's clip plus every later step's extension as the compiler snaps it for the
 * mode in use (`continuationFrames`; `byDuration` = the continued steps carry `durationSeconds`, REF2VA). A plan that continues an
 * existing clip or an imported video starts at a frame count Studio does not hold, so the piece cannot be laid out and the clip is used
 * (`planSource`).
 */
export function dialTimeline(clipFrames:number,plan:{steps:readonly {seconds:number}[];source?:unknown}|null|undefined,byDuration:boolean):DialTimeline {
 if(!plan||!plan.steps.length)return {seconds:clipFrames/H3_FPS,frames:clipFrames,edges:[],basis:'clip'};
 if(plan.source)return {seconds:clipFrames/H3_FPS,frames:clipFrames,edges:[],basis:'planSource'};
 let frames=0;
 const ends=plan.steps.map((s,i)=>(frames+=i?continuationFrames(s.seconds,byDuration):videoFrames('minimax-h3',s.seconds,H3_FPS))/H3_FPS);
 return {seconds:frames/H3_FPS,frames,edges:ends.slice(0,-1),basis:'plan'};
}

/** Where the mouse and keys may put a point: seconds `from`..`to`, levels `lo`..`hi`; `snap` 0 places freely. */
export interface CurveLimits { from:number; to:number; lo:number; hi:number; snap?:number; edges?:readonly number[] }
const snapTime=(t:number,lim:CurveLimits)=>{
 const step=lim.snap??DIAL_SNAP;
 if(!step)return t;
 const grid=Math.round(t/step)*step,edge=(lim.edges??[]).find(e=>Math.abs(e-t)<=step/2);
 return edge??grid;
};
const levelOf=(level:number,lim:CurveLimits)=>r4(clamp(lim.snap===0?level:Math.round(level/DIAL_LEVEL_SNAP)*DIAL_LEVEL_SNAP,Math.max(-DIAL_LEVEL,lim.lo),Math.min(DIAL_LEVEL,lim.hi)));
/** Time bounds of point `index`: one latent frame from each neighbour, the limits otherwise. Rounded inward so four decimals never close the gap. */
function room(p:Points,index:number,lim:CurveLimits):[number,number] {
 const lo=index>0?p[index-1][0]+DIAL_GAP:Math.max(-DIAL_SECONDS,lim.from),hi=index<p.length-1?p[index+1][0]-DIAL_GAP:Math.min(DIAL_SECONDS,lim.to);
 return [Math.ceil(lo*1e4-1e-6)/1e4,Math.floor(hi*1e4+1e-6)/1e4];
}
/** Index of the point within one latent frame of `t`, the nearest first; -1 when a click there adds a point. */
export function nearPoint(curve:H3DialCurve,t:number):number {
 let best=-1;
 curve.points.forEach((q,i)=>{if(Math.abs(q[0]-t)<DIAL_GAP&&(best<0||Math.abs(q[0]-t)<Math.abs(curve.points[best][0]-t)))best=i;});
 return best;
}
/**
 * Moves a point: snapped, kept between its neighbours with the minimum gap, level inside the range. Order never changes.
 * The time is touched only when a new one is asked for. A level-only edit (`t` is the point's own time: the Level field, the up and down
 * keys) keeps it as authored, so a point outside the lane (a whole-piece curve, a clip shortened after authoring, a preset in seconds
 * from a longer clip) or closer than one latent frame to its neighbour (a pasted curve) does not jump.
 */
export function movePoint(curve:H3DialCurve,index:number,t:number,level:number,lim:CurveLimits):H3DialCurve {
 const p=curve.points;
 if(!p[index])return curve;
 const [lo,hi]=room(p,index,lim);
 const time=t===p[index][0]||lo>hi?p[index][0]:r4(clamp(snapTime(t,lim),lo,hi)),next=[time,levelOf(level,lim)] as const;
 if(next[0]===p[index][0]&&next[1]===p[index][1])return curve;
 return {...curve,points:p.map((q,i)=>i===index?next:q)};
}
/** Adds a point where there is room for one (a latent frame from both neighbours); null when there is none or the curve is full. */
export function addPoint(curve:H3DialCurve,t:number,level:number,lim:CurveLimits):{curve:H3DialCurve;index:number}|null {
 const p=curve.points;
 if(p.length>=DIAL_POINTS)return null;
 const time=r4(clamp(snapTime(t,lim),lim.from,lim.to));
 const index=p.findIndex(q=>q[0]>time),at=index<0?p.length:index;
 const lo=at>0?p[at-1][0]+DIAL_GAP:-Infinity,hi=at<p.length?p[at][0]-DIAL_GAP:Infinity;
 if(time<lo-1e-9||time>hi+1e-9)return null;
 return {curve:{...curve,points:[...p.slice(0,at),[time,levelOf(level,lim)] as const,...p.slice(at)]},index:at};
}
/** Removes a point; a curve keeps at least two (null). */
export function removePoint(curve:H3DialCurve,index:number):H3DialCurve|null {
 return curve.points.length>2&&curve.points[index]?{...curve,points:curve.points.filter((_,i)=>i!==index)}:null;
}
/** Middle of the widest gap, where a keyboard user's new point goes; null when no gap has room. */
export function widestGap(curve:H3DialCurve,lim:CurveLimits):number|null {
 const p=curve.points,stops=[lim.from-DIAL_GAP,...p.map(q=>q[0]),lim.to+DIAL_GAP];
 let best:[number,number]|null=null;
 for(let i=1;i<stops.length;i++){const a=Math.max(stops[i-1],lim.from-DIAL_GAP),b=Math.min(stops[i],lim.to+DIAL_GAP);if(b-a>=2*DIAL_GAP-1e-9&&(!best||b-a>best[1]-best[0]))best=[a,b];}
 return best?(best[0]+best[1])/2:null;
}

export const dialPresets=['rampIn','rampOut','pulse','dip'] as const;
export type DialPreset=typeof dialPresets[number];
/**
 * Preset points over a lane of `seconds`, all inside levels 0..1 with ramps of about 1.5 s (shorter only when the lane is). A strong row
 * still changes the whole scene at the ramp (one-seed renders, 2026-11-16); the presets do not avoid that, they stay in the designed range.
 */
export function dialPresetPoints(name:DialPreset,seconds:number):[number,number][] {
 // The last point never passes the lane's end: its seconds are cut, not rounded, to four decimals.
 const end=Math.floor(seconds*1e4+1e-6)/1e4,ramp=Math.min(DIAL_RAMP,end);
 if(name==='rampIn')return [[0,0],[r4(ramp),1]];
 if(name==='rampOut')return [[r4(end-ramp),1],[end,0]];
 const [a,b]=name==='pulse'?[0,1]:[1,0],r=Math.min(DIAL_RAMP,Math.round(end/3/DIAL_SNAP)*DIAL_SNAP);
 return end-2*r>=DIAL_GAP&&r>=DIAL_GAP?[[0,a],[r4(r),b],[r4(end-r),b],[end,a]]:[[0,a],[r4(end/2),b],[end,a]];
}
/** A flat curve at level 1 over the lane: what "add curve" starts from, the same strength as the constant row it replaces. */
export const flatCurve=(seconds:number):H3DialCurve=>({type:'keys',points:[[0,1],[Math.floor(Math.max(seconds,2*DIAL_GAP)*1e4+1e-6)/1e4,1]],unit:'seconds'});

/** A row's curve as clipboard text: the rack row's own `time` object, so it pastes into the pack's editor too. */
export const dialCurveText=(curve:H3DialCurve)=>JSON.stringify(curve);
/**
 * Pasted text → a curve this version sends, or null. Accepts a `time` object of type `keys` (the pack's default unit is clip fractions, so a
 * missing or `normalized` unit is converted with the lane's seconds) or a bare `[[seconds, level], …]` list. The curve's audio mode
 * `protect` is kept (`follow` is the default and is not written); audio-driven curves are not carried.
 */
export function parseDialCurveText(text:string,seconds:number):H3DialCurve|null {
 let v:unknown;
 try{v=JSON.parse(text);}catch{return null;}
 const spec=(Array.isArray(v)?{type:'keys',unit:'seconds',points:v}:v) as {type?:unknown;unit?:unknown;points?:unknown;interp?:unknown;smooth?:unknown;steps?:unknown;audio?:unknown}|null;
 if(!spec||typeof spec!=='object'||spec.type!=='keys'||!Array.isArray(spec.points))return null;
 const scale=spec.unit==='seconds'?1:spec.unit===undefined||spec.unit==='normalized'?seconds:NaN;
 if(!spec.points.every(q=>Array.isArray(q)&&q.length===2&&typeof q[0]==='number'&&typeof q[1]==='number'))return null;
 const curve={type:'keys',points:(spec.points as [number,number][]).map(([t,m])=>[scale===1?t:r4(t*scale),m]),unit:'seconds',
  ...(spec.interp===undefined?{}:{interp:spec.interp}),...(spec.smooth===undefined||spec.smooth===0?{}:{smooth:spec.smooth}),...(spec.steps===undefined?{}:{steps:spec.steps}),...(spec.audio===undefined||spec.audio==='follow'?{}:{audio:spec.audio})};
 return isDialCurve(curve)?curve:null;
}

/** The open dialog's state: the rows, the selected lane and point, and undo history that lives while the dialog is open. */
export interface RackState { rows:readonly DialRow[]; row:number; point:number; past:(readonly DialRow[])[]; future:(readonly DialRow[])[]; tag:string }
export const rackState=(rows:readonly DialRow[]):RackState=>({rows,row:rows.length?0:-1,point:-1,past:[],future:[],tag:''});
export type RackAction=
 |{type:'rows';rows:readonly DialRow[]}
 |{type:'load';rows:readonly DialRow[]}
 |{type:'select';row:number;point?:number}
 |{type:'addCurve';seconds:number;steps?:number}|{type:'removeCurve'}
 |{type:'add';t:number;level:number;lim:CurveLimits}
 |{type:'move';point:number;t:number;level:number;lim:CurveLimits;tag?:string}
 |{type:'nudge';point:number;dt:number;dl:number;lim:CurveLimits}
 |{type:'remove';point:number}
 |{type:'set';patch:{interp?:'linear'|'step';smooth?:number;steps?:number|null;audio?:'follow'|'protect'};tag?:string}
 |{type:'preset';name:DialPreset;seconds:number;steps?:number}
 |{type:'paste';curve:H3DialCurve}
 |{type:'undo'}|{type:'redo'};
const HISTORY=100;
const sameRows=(a:readonly DialRow[],b:readonly DialRow[])=>JSON.stringify(a)===JSON.stringify(b);
/** One undo step per change; changes with the same non-empty tag (one drag, one slider gesture) share a step. */
function commit(s:RackState,rows:readonly DialRow[],tag:string,select:{row?:number;point?:number}={}):RackState {
 const sel={row:select.row??s.row,point:select.point??s.point};
 if(sameRows(rows,s.rows))return sel.row===s.row&&sel.point===s.point?s:{...s,...sel};
 const merge=!!tag&&tag===s.tag&&s.past.length>0;
 return {rows,...sel,past:merge?s.past:[...s.past,s.rows].slice(-HISTORY),future:[],tag};
}
const withCurve=(s:RackState,curve:H3DialCurve|undefined):readonly DialRow[]=>s.rows.map((r,i)=>{
 if(i!==s.row)return r;
 const {time,...rest}=r;void time;
 return curve?{...rest,time:curve}:rest;
});
function settle(s:RackState):RackState {
 const row=s.rows.length?clamp(s.row<0?0:s.row,0,s.rows.length-1):-1,points=s.rows[row]?.time?.points.length??0;
 const point=s.point<points?s.point:-1;
 return row===s.row&&point===s.point?s:{...s,row,point};
}
/** Every edit of the rack dialog. Unknown indices and edits without room return the state unchanged. */
export function rackReduce(s:RackState,a:RackAction):RackState {
 const curve=s.rows[s.row]?.time;
 switch(a.type){
  case 'rows':{
   // Strip edits: a changed row count is its own step; edits of one row's same field share one (a slider drag).
   const changed=a.rows.length===s.rows.length?a.rows.findIndex((r,i)=>JSON.stringify(r)!==JSON.stringify(s.rows[i])):-1;
   const field=changed<0?'':(['on','strength','time','dial'] as const).find(k=>JSON.stringify(a.rows[changed][k])!==JSON.stringify(s.rows[changed][k]))??'';
   // A removed row moves the selection onto another dial: no point of it is selected.
   return settle(commit(s,a.rows,field?`rows:${changed}:${field}`:'',a.rows[s.row]?.dial===s.rows[s.row]?.dial?{}:{point:-1}));
  }
  // A loaded preset replaces the rack: always its own undo step, selection on the first lane.
  case 'load':return isDialRows(a.rows)?settle(commit({...s,tag:''},a.rows,'',{row:a.rows.length?0:-1,point:-1})):s;
  case 'select':return s.rows[a.row]?settle({...s,row:a.row,point:a.point??-1,tag:''}):s;
  // `steps`: the blend steps the dial file records for the pipeline in use, authored into the new curve.
  case 'addCurve':return curve||!s.rows[s.row]?s:commit(s,withCurve(s,{...flatCurve(a.seconds),...(a.steps?{steps:a.steps}:{})}),'',{point:-1});
  case 'removeCurve':return curve?commit(s,withCurve(s,undefined),'',{point:-1}):s;
  case 'add':{
   const added=curve&&addPoint(curve,a.t,a.level,a.lim);
   return added?commit(s,withCurve(s,added.curve),'',{point:added.index}):s;
  }
  case 'move':return curve?commit(s,withCurve(s,movePoint(curve,a.point,a.t,a.level,a.lim)),a.tag??'',{point:curve.points[a.point]?a.point:s.point}):s;
  case 'nudge':{
   const q=curve?.points[a.point];
   // Keys step from the point itself, so a nudge is never swallowed by the grid.
   return q&&curve?commit(s,withCurve(s,movePoint(curve,a.point,q[0]+a.dt,q[1]+a.dl,{...a.lim,snap:0})),'',{point:a.point}):s;
  }
  case 'remove':{
   const next=curve&&removePoint(curve,a.point);
   return next?commit(s,withCurve(s,next),'',{point:-1}):s;
  }
  case 'set':{
   if(!curve)return s;
   const next:{-readonly [K in keyof H3DialCurve]:H3DialCurve[K]}={...curve};
   if(a.patch.interp)next.interp=a.patch.interp;
   if(a.patch.smooth!==undefined){if(a.patch.smooth>0)next.smooth=clamp(a.patch.smooth,0,1);else delete next.smooth;}
   if(a.patch.steps===null)delete next.steps;else if(a.patch.steps!==undefined)next.steps=a.patch.steps;
   // `follow` is the node's default: it is not written, so a curve that never had a mode stays as it was.
   if(a.patch.audio==='protect')next.audio='protect';else if(a.patch.audio==='follow')delete next.audio;
   return isDialCurve(next)?commit(s,withCurve(s,next),a.tag??''):s;
  }
  case 'preset':return s.rows[s.row]?commit(s,withCurve(s,curve?{...curve,points:dialPresetPoints(a.name,a.seconds),interp:'linear'}:{type:'keys',points:dialPresetPoints(a.name,a.seconds),unit:'seconds',interp:'linear',...(a.steps?{steps:a.steps}:{})}),'',{point:-1}):s;
  case 'paste':return s.rows[s.row]&&isDialCurve(a.curve)?commit(s,withCurve(s,a.curve),'',{point:-1}):s;
  case 'undo':return s.past.length?settle({...s,rows:s.past.at(-1)!,past:s.past.slice(0,-1),future:[...s.future,s.rows],tag:'',point:-1}):s;
  case 'redo':return s.future.length?settle({...s,rows:s.future.at(-1)!,future:s.future.slice(0,-1),past:[...s.past,s.rows],tag:'',point:-1}):s;
 }
}
