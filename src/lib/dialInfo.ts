import { invoke, isTauri } from '@tauri-apps/api/core';
import { DIAL_BLEND_STEPS, DIAL_LEVEL, DIAL_SLIDER, DIAL_STEP, dialName, isDialFile } from './dials';

/**
 * What a dial file says about itself (docs/DIALS.md): side labels, description, notes, useful and overcook strengths, evidence and
 * per-pipeline measurements, as the Dial Rack pack's catalog route returns them (`dials/core.py::check_dial_info`). Native
 * `jobs_dial_info.rs` reads and bounds the answer; this module re-checks what the strip does arithmetic on and derives the slider
 * range, its marks, a new row's starting strength and a new curve's blend steps. Nothing here is parsed out of free text.
 */
export const dialEvidence=['creator','one-seed','multi-seed','multi-scene'] as const;
export type DialEvidence=typeof dialEvidence[number];
/** The pack's `INFO_PIPELINES`: text to video, reference pictures, first/last frame. */
export const dialPipelines=['t2v','ref2v','fl2v'] as const;
export type DialPipeline=typeof dialPipelines[number];
/** `null` = not recorded in the dial file. */
export interface DialSide { useful:number|null; overcook:number|null }
export interface DialMeasured extends DialSide { steps?:number; evidence:DialEvidence|null; notes:string }
/**
 * `family` is the model family the dial file was made for (the pack's `model_family`, `MiniMax H3` for files from before families were recorded) and
 * `mode` where it acts: `post` (after the text refiner, the hook file) or `pre` (before it, the LoRA-style file). Both are absent when the catalog
 * does not say.
 */
export interface DialInfo { description:string; negative:string; positive:string; pipeline:string; notes:string; neg:DialSide; pos:DialSide; evidence:DialEvidence|null; kind?:string; family?:string; mode?:'pre'|'post'; pipelines?:Partial<Record<DialPipeline,DialMeasured>> }
/** Dial name (forward slashes) → its info. A dial without an entry keeps the strip's fallbacks. */
export type DialInfoMap=Readonly<Record<string,DialInfo>>;

const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,limit:number)=>typeof v==='string'?v.slice(0,limit):'';
const strength=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=DIAL_LEVEL?v:null;
const evidenceOf=(v:unknown)=>dialEvidence.find(e=>e===v)??null;
function side(v:unknown):DialSide {
 const s=isObject(v)?v:{},useful=strength(s.useful),overcook=strength(s.overcook);
 return {useful,overcook:useful!==null&&overcook!==null&&overcook<useful?null:overcook};
}
/** One catalog entry's info, or undefined when it is not info version 2. Unknown keys are not carried. */
export function dialInfoOf(v:unknown,family?:unknown,mode?:unknown):DialInfo|undefined {
 if(!isObject(v)||v.version!==2)return undefined;
 const out:DialInfo={description:text(v.description,2000),negative:text(v.negative,60),positive:text(v.positive,60),pipeline:text(v.pipeline,60),notes:text(v.notes,500),neg:side(v.neg),pos:side(v.pos),evidence:evidenceOf(v.evidence)};
 if(typeof v.kind==='string'&&v.kind.length<=20)out.kind=v.kind;
 if(typeof family==='string'&&family)out.family=family.slice(0,64);
 if(mode==='pre'||mode==='post')out.mode=mode;
 if(isObject(v.pipelines)){
  const measured:Partial<Record<DialPipeline,DialMeasured>>={};
  for(const key of dialPipelines){
   const p=v.pipelines[key];
   if(!isObject(p))continue;
   measured[key]={...side(p),...(Number.isInteger(p.steps)&&(p.steps as number)>=1&&(p.steps as number)<=DIAL_BLEND_STEPS?{steps:p.steps as number}:{}),evidence:evidenceOf(p.evidence),notes:text(p.notes,500)};
  }
  if(Object.keys(measured).length)out.pipelines=measured;
 }
 return out;
}
/** The native command's answer `{dials:[{dial, family, mode, info}]}` as a map; null when it is not that shape. */
export function parseDialCatalog(v:unknown):DialInfoMap|null {
 if(!isObject(v)||!Array.isArray(v.dials))return null;
 const out:Record<string,DialInfo>={};
 for(const entry of v.dials){
  if(!isObject(entry)||typeof entry.dial!=='string')continue;
  const dial=dialName(entry.dial),info=dialInfoOf(entry.info,entry.family,entry.mode);
  if(info&&isDialFile(dial)&&!(dial in out))out[dial]=info;
 }
 return out;
}

/** The pack's name for the family of the MiniMax H3 video and image models (`core.TEXT_PATHS`, `DEFAULT_FAMILY`; ComfyUI-MAINodes 382f640). */
export const DIAL_FAMILY_H3='MiniMax H3';
/**
 * The catalog says this dial was made for another model family: the node refuses it on a MiniMax H3 model (`core.check_family`), so Studio does
 * not offer it there. False without an entry or a recorded family: then nothing is known and the dial stays offered.
 */
export const dialOtherFamily=(info?:DialInfo)=>!!info?.family&&info.family!==DIAL_FAMILY_H3;
/**
 * The catalog says this is a pre-refiner dial. The node runs time curves on post-refiner dials only (`timecurve.apply_rack`: "time curves support
 * post-refiner dials only; pre-refiner rows cannot vary over time"); a constant row of it runs. False when the catalog does not say.
 */
export const dialNoCurve=(info?:DialInfo)=>info?.mode==='pre';
/** The dial names of `map` that take no time curve, for `dialCurveConflicts`; undefined without a catalog. */
export const dialNoCurveNames=(map?:DialInfoMap)=>map?Object.keys(map).filter(d=>dialNoCurve(map[d])):undefined;
const up=(v:number)=>Math.min(DIAL_LEVEL,Math.ceil(Math.round(v/DIAL_STEP*1e6)/1e6)*DIAL_STEP);
const reach=(s:DialSide|undefined)=>+Math.max(DIAL_SLIDER,up(s?.overcook??(s?.useful??0)*1.5)).toFixed(2);
/**
 * Slider reach per side: at least ±3, else up to the side's overcook strength, or one and a half times its useful strength when no
 * overcook is recorded. The number field beside the slider keeps the full ±20.
 */
export function dialSliderRange(info?:DialInfo):{min:number;max:number} {
 return {min:-reach(info?.neg),max:reach(info?.pos)};
}
export interface DialMark { side:'neg'|'pos'; kind:'useful'|'overcook'; value:number; strength:number; at:number }
/** The recorded useful and overcook strengths as ticks: `strength` signed, `at` the fraction along the slider (0 = left end). */
export function dialMarks(info?:DialInfo):DialMark[] {
 if(!info)return [];
 const {min,max}=dialSliderRange(info);
 return (['neg','pos'] as const).flatMap(s=>(['useful','overcook'] as const).flatMap(kind=>{
  const value=info[s][kind];
  if(value===null)return [];
  const signed=s==='neg'?-value:value;
  return [{side:s,kind,value,strength:signed,at:(signed-min)/(max-min)}];
 }));
}
/** The overcook strength a row's strength is above on its side, or null. */
export function dialOvercooked(info:DialInfo|undefined,value:number):number|null {
 const limit=value<0?info?.neg.overcook:info?.pos.overcook;
 return limit!=null&&Math.abs(value)>limit?limit:null;
}
/** A new row's strength: the dial's positive useful strength when the file records one, else 1. */
export const dialStartStrength=(info?:DialInfo)=>info?.pos.useful??1;
/**
 * DEAS's MiniMax H3 modes as the pack's pipeline keys. T2VA is text to video and REF2VA reference media. FL2VA (first and last frame)
 * is the pack's first/last frame; I2VA (first frame only) and L2VA (last frame only) condition the same way with one frame and are
 * read as first/last frame too, which no dial file measurement confirms.
 */
export function dialPipelineOf(mode:string):DialPipeline|undefined {
 return mode==='T2VA'?'t2v':mode==='REF2VA'?'ref2v':mode==='FL2VA'||mode==='I2VA'||mode==='L2VA'?'fl2v':undefined;
}
/** Blend steps the dial file records for `pipeline`, never more than the job's sampler steps; undefined when it records none. */
export function dialInfoSteps(info:DialInfo|undefined,pipeline:DialPipeline|undefined,jobSteps:number):number|undefined {
 const steps=pipeline&&info?.pipelines?.[pipeline]?.steps;
 return steps?Math.max(1,Math.min(steps,jobSteps,DIAL_BLEND_STEPS)):undefined;
}

/** Native failure text is `CODE: detail`, as for the rack presets. */
export const dialInfoErrorCodes=['DIAL_INFO_ENDPOINT','DIAL_INFO_UNREACHABLE','DIAL_INFO_TOO_LARGE','DIAL_INFO_UNAVAILABLE','DIAL_INFO_FAILED','DIAL_INFO_MALFORMED','DIAL_INFO_NATIVE'] as const;
export type DialInfoErrorCode=typeof dialInfoErrorCodes[number];
export function dialInfoError(error:unknown):DialInfoErrorCode|'' {
 const message=error instanceof Error?error.message:error&&typeof error==='object'&&'message' in error?String((error as {message:unknown}).message):String(error);
 return dialInfoErrorCodes.find(c=>message.startsWith(`${c}: `))??'';
}
/** Reads the pack's catalog through `native_dial_catalog` (failures are logged natively). Rejects with `CODE: detail`. */
export async function readDialCatalog(baseUrl:string):Promise<DialInfoMap> {
 if(!isTauri())throw new Error('DIAL_INFO_NATIVE: Dial info needs the DEAS desktop app.');
 const map=parseDialCatalog(await invoke<unknown>('native_dial_catalog',{baseUrl}));
 if(!map)throw new Error('DIAL_INFO_MALFORMED: The dial catalog could not be read.');
 return map;
}
/** `idle` before the first read, `unavailable` when it failed: the strip then keeps its fallbacks and says so. */
export interface DialInfoState { status:'idle'|'loading'|'ready'|'unavailable'; map?:DialInfoMap; code?:DialInfoErrorCode|'' }
