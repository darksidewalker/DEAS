import type { H3DialCurve, H3DialRow, VideoIntentV1 } from './videoIntent';

/**
 * Experimental Dial Rack rows for MiniMax H3 video (docs/DIALS.md). Every limit mirrors native
 * `jobs_video.rs::validate_dial_row`/`validate_dials`, which stays authoritative: a row this module
 * accepts is one the compiler accepts, and nothing here compiles a graph.
 */
export const dialRackNode='MAIDialRack';
/** Needed only when De-rope runs with a time curve. */
export const dialHoldMapNode='MAIDialHoldMap';
export const DIAL_ROWS=8;
export const DIAL_POINTS=64;
export const DIAL_LEVEL=20;
export const DIAL_SECONDS=86_400;
/** Bound of a curve's authored blend steps (native `DIAL_BLEND_STEPS`); an active row may not exceed the job's own sampler steps. */
export const DIAL_BLEND_STEPS=150;
/**
 * Mirror of native `dial_blend_steps`: the blend steps the compiler writes for a curve without an authored count. A job of at most
 * 8 sampler steps blends on all of them, a longer one on a third, at least 2. Each blended step is one extra model call.
 * Provisional (2026-11-16, one seed each): on the 6-step chain a look dial followed its curve with 6 blend steps and not with 2, and the
 * motion dial behaved the same with 6 as with 2; at 25 steps the motion dial acted with 8 and not with 2.
 */
export const DIAL_BLEND_ALL=8;
export const dialBlendSteps=(steps:number)=>steps<=DIAL_BLEND_ALL?Math.max(1,steps):Math.max(2,Math.floor((2*steps+3)/6));
/** Slider reach of the dock strip; the number field beside it accepts the full ±DIAL_LEVEL. */
export const DIAL_SLIDER=3;
export const DIAL_STEP=0.05;
/** A rack row as edited in Studio: the intent row itself, so the strip, the rack dialog and the compiler share one shape. Absent `on` means on. */
export type DialRow=H3DialRow;
export const noDials:readonly DialRow[]=[];

const inRange=(v:unknown,min:number,max:number):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const keysIn=(v:object,allowed:readonly string[])=>Object.keys(v).every(k=>allowed.includes(k));
const hasControl=(s:string)=>[...s].some(c=>{const n=c.codePointAt(0)!;return n<32||(n>=127&&n<160);});
/** Backend model lists use the host's separators; dial names are compared and sent with forward slashes. */
export const dialName=(name:string)=>name.replace(/\\/g,'/');
/** Mirror of native `dial_file`: a `.safetensors` file inside `dials/`, forward slashes, no traversal. */
export function isDialFile(v:unknown):v is string {
 if(typeof v!=='string'||v.length>255||!v.startsWith('dials/')||!v.toLowerCase().endsWith('.safetensors'))return false;
 return v.split('/').every(s=>s!==''&&s!=='.'&&s!=='..'&&s.trim()===s&&!hasControl(s)&&!/[\\:%]/.test(s));
}
/** Dial files among backend/library LoRA names, as the pack's own catalog lists them: inside `dials/`, folders starting with `_` left out. */
export function dialCatalog(names:readonly string[]):string[] {
 return [...new Set(names.map(dialName).filter(n=>isDialFile(n)&&!n.split('/').slice(1,-1).some(d=>d.startsWith('_'))))].sort((a,b)=>a.localeCompare(b));
}
/** File name without folder and extension; the label until the file's own dial info reaches the UI. */
export const dialLabel=(dial:string)=>dialName(dial).split('/').at(-1)!.replace(/\.safetensors$/i,'');

export function isDialCurve(v:unknown):v is H3DialCurve {
 const c=v as H3DialCurve;
 if(!c||typeof c!=='object'||Array.isArray(c)||!keysIn(c,['type','points','unit','interp','smooth','steps','audio'])||c.type!=='keys'||c.unit!=='seconds')return false;
 if(c.interp!==undefined&&c.interp!=='linear'&&c.interp!=='step')return false;
 if(c.smooth!==undefined&&!inRange(c.smooth,0,1))return false;
 if(c.audio!==undefined&&c.audio!=='follow'&&c.audio!=='protect')return false;
 if(c.steps!==undefined&&!(Number.isInteger(c.steps)&&inRange(c.steps,1,DIAL_BLEND_STEPS)))return false;
 const p=c.points;
 if(!Array.isArray(p)||p.length<1||p.length>DIAL_POINTS)return false;
 return p.every((q,i)=>Array.isArray(q)&&q.length===2&&inRange(q[0],-DIAL_SECONDS,DIAL_SECONDS)&&inRange(q[1],-DIAL_LEVEL,DIAL_LEVEL)&&(i===0||p[i-1][0]<q[0]));
}
export function isDialRow(v:unknown):v is DialRow {
 const r=v as DialRow;
 return !!r&&typeof r==='object'&&!Array.isArray(r)&&keysIn(r,['dial','strength','on','time'])&&isDialFile(r.dial)&&inRange(r.strength,-DIAL_LEVEL,DIAL_LEVEL)
  &&(r.on===undefined||typeof r.on==='boolean')&&(r.time===undefined||isDialCurve(r.time));
}
export const isDialRows=(v:unknown):v is DialRow[]=>Array.isArray(v)&&v.length<=DIAL_ROWS&&v.every(isDialRow);
/** Rows that do something: on, with a non-zero strength (native `active_dials`). */
export const activeDials=(rows:readonly DialRow[])=>rows.filter(r=>r.on!==false&&r.strength!==0);
/** A typed or dragged strength, clamped to the compiler's range; undefined for an unfinished number. */
export function dialStrength(text:string):number|undefined {
 if(!text.trim())return undefined;
 const n=Number(text);
 return Number.isFinite(n)?Math.min(DIAL_LEVEL,Math.max(-DIAL_LEVEL,n)):undefined;
}

/** Adds the active rows to a plain MiniMax H3 intent. Without one the intent is returned unchanged, so it stays byte-identical; inactive rows are not sent. */
export function withDials<T extends VideoIntentV1>(intent:T,rows:readonly DialRow[]):T {
 const active=activeDials(rows);
 if(intent.family!=='minimax-h3'||!active.length)return intent;
 return {...intent,dials:active.map(r=>({dial:r.dial,strength:r.strength,...(r.time?{time:r.time}:{})}))};
}
/** Rows of a restored intent; anything the validator rejects restores as no rows. */
export function fromDials(rows:unknown):DialRow[] {
 return isDialRows(rows)?rows.map(r=>({...r,on:r.on!==false})):[];
}

export type DialGate=''|'h3VideoOnly'|'nodeMissing'|'gguf';
/** Why rows cannot run here (first match), mirroring the compiler's refusals for rows without a time curve; '' = usable. */
export function dialGate(p:{h3Video:boolean;nodes?:readonly string[];gguf:boolean}):DialGate {
 return !p.h3Video?'h3VideoOnly':p.nodes&&!p.nodes.includes(dialRackNode)?'nodeMissing':p.gguf?'gguf':'';
}

/**
 * Why a time curve cannot run, in the order native `validate_dials` checks; the last two are found by the prerequisite check and by `validate_dial_row`.
 * `pieceStart` is Studio's own: native compiles that job, but Studio cannot show the curve the model would get (see `DialCurveFacts.pieceStartUnknown`).
 */
export const dialCurveConflictIds=['blendSteps','transition','faceRefine','tiledUpscale','deropeContinued','importedVideo','sourceFrames','shift','pieceStart','holdMapMissing','curveLimits'] as const;
export type DialCurveConflict=typeof dialCurveConflictIds[number];
/**
 * What the next job is, as far as time curves care. `continued` = the segment pins a source (`h3.continuity.sourceId`); `windowStart` = seconds at
 * which its sampled window starts in the piece: a number when known, null when the pinned clip's frame count is known to be missing, undefined
 * while unknown (Studio does not hold the session list before Run, so native reports that case when the job is prepared).
 * `pieceStartUnknown` = the Continuity plan continues an existing clip or an imported video (`dialTimeline` basis `planSource`): curve seconds count from
 * the start of the whole piece and native moves every point by the pinned clip's cumulative length less the context frames, a length Studio does not
 * hold. The rack then cannot draw the curve where the model gets it, so Studio holds active curves instead of sending one nobody could author.
 */
export interface DialCurveFacts { rows:readonly DialRow[]; steps:number; transition?:boolean; faceRefine?:boolean; tiledUpscale?:boolean; derope?:boolean; continued?:boolean; importedVideo?:boolean; windowStart?:number|null; pieceStartUnknown?:boolean; nodes?:readonly string[] }
/**
 * Every reason the compiler would refuse the active rows' time curves, mirroring native `validate_dials` (which stays authoritative and reports
 * only the first). Empty without an active curve: rows without one are a plain model patch and run everywhere.
 */
export function dialCurveConflicts(f:DialCurveFacts):DialCurveConflict[] {
 const curves=activeDials(f.rows).flatMap(r=>r.time?[r.time]:[]);
 if(!curves.length)return [];
 const out:DialCurveConflict[]=[];
 if(curves.some(c=>c.steps!==undefined&&c.steps>f.steps))out.push('blendSteps');
 if(f.transition)out.push('transition');
 if(f.faceRefine)out.push('faceRefine');
 if(f.tiledUpscale)out.push('tiledUpscale');
 if(f.continued){
  if(f.derope)out.push('deropeContinued');
  if(f.importedVideo)out.push('importedVideo');
  else if(f.windowStart===null)out.push('sourceFrames');
  else if(typeof f.windowStart==='number'&&curves.some(c=>c.points.some((q,i)=>i>0&&c.points[i-1][0]-f.windowStart!>=q[0]-f.windowStart!)))out.push('shift');
 }
 if(f.pieceStartUnknown)out.push('pieceStart');
 if(f.derope&&f.nodes&&!f.nodes.includes(dialHoldMapNode))out.push('holdMapMissing');
 if(curves.some(c=>!isDialCurve(c)))out.push('curveLimits');
 return out;
}
/** The facts of a built intent, for callers that hold one (the join's transition jobs). The window start is left unknown: native adds the pinned clip's frame count when it prepares the job. */
export function dialIntentFacts(i:VideoIntentV1,nodes?:readonly string[]):DialCurveFacts {
 const h3=i.family==='minimax-h3'?i:undefined,c=h3?.h3.continuity;
 return {rows:h3?.dials??[],steps:i.steps,transition:!!h3?.h3.transition,faceRefine:!!i.faceRefine,tiledUpscale:!!h3?.latentUpscale&&!h3.latentUpscale.regenerate,derope:!!i.videoPost?.derope,
  continued:!!c?.sourceId,importedVideo:c?.sourceKind==='video',...(nodes?{nodes}:{})};
}

/**
 * Corner points of a curve for a read-only thumbnail, as fractions of the box: x over the shown time span, y from the top.
 * The span covers the clip (0..seconds) and every point; the level held before the first and after the last point is drawn to the
 * edges. `smooth` is not applied: the thumbnail shows the authored corners, not the per-frame values the node computes.
 */
export function dialCurveOutline(curve:H3DialCurve,seconds:number):{points:[number,number][];zero:number} {
 const p=curve.points,t0=Math.min(0,p[0][0]),t1=Math.max(seconds>0?seconds:0,p.at(-1)![0],t0+1e-6);
 const levels=p.map(q=>q[1]),lo=Math.min(0,...levels),hi=Math.max(0,...levels),span=hi-lo||1;
 const x=(t:number)=>(t-t0)/(t1-t0),y=(l:number)=>(hi-l)/span;
 const out:[number,number][]=[[0,y(p[0][1])]];
 p.forEach((q,i)=>{if(i>0&&curve.interp==='step')out.push([x(q[0]),y(p[i-1][1])]);out.push([x(q[0]),y(q[1])]);});
 out.push([1,y(p.at(-1)![1])]);
 return {points:out,zero:y(0)};
}
