import { invoke, isTauri } from '@tauri-apps/api/core';
import { DIAL_LEVEL, DIAL_ROWS, dialName, isDialCurve, isDialFile, isDialRow, type DialRow } from './dials';
import type { H3DialCurve } from './videoIntent';

/**
 * Experimental Dial Rack presets (docs/DIALS.md). The store is the node pack's own preset files on the backend
 * (`models/loras/dials/presets/<name>.json`), reached through native commands over the pack's routes, so a rack saved in
 * ComfyUI shows here and the reverse. This module converts between the pack's rows and the rows DEAS sends, and says for
 * every row what it could not keep: nothing is changed or left out without a note.
 */

/** The pack's `core.NAME`. */
export const isDialPresetName=(name:string)=>/^[A-Za-z0-9_-]{1,80}$/.test(name);

/** Why a preset row is not loaded. */
export type PresetLeftOut='wired'|'hold'|'envelope'|'blocks'|'audioCurve'|'dial'|'strength'|'curve'|'tooMany';
/** What changed on a row that is loaded. `fractions`: curve times were clip fractions; `solo`/`soloOff`: solo became switching the other rows off. */
export type PresetChanged='fractions'|'solo'|'soloOff';
/** The pack's own load warnings: the dial file is not on the backend, or its tensors changed since the preset was saved. */
export type PresetWarning='missing'|'changed';
export interface PresetRowReport { index:number; dial:string; strength:number|null; on:boolean; curve:boolean; leftOut:PresetLeftOut[]; changed:PresetChanged[]; warnings:PresetWarning[] }
export interface PresetConversion { rows:DialRow[]; report:PresetRowReport[] }

const r4=(v:number)=>Math.round(v*1e4)/1e4;
const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);

/** A pack `time` object of type `keys` as a DEAS curve in whole-piece seconds; `unit` absent or `normalized` means clip fractions, scaled by `seconds`. */
function presetCurve(time:Record<string,unknown>,seconds:number):{curve?:H3DialCurve;fractions:boolean} {
 const fractions=time.unit===undefined||time.unit==='normalized';
 if(!Array.isArray(time.points)||(!fractions&&time.unit!=='seconds')||!time.points.every(q=>Array.isArray(q)&&q.length===2&&typeof q[0]==='number'&&typeof q[1]==='number'))return {fractions};
 const curve={type:'keys',points:(time.points as [number,number][]).map(([t,level])=>[fractions?r4(t*seconds):t,level]),unit:'seconds',
  ...(time.interp===undefined?{}:{interp:time.interp}),...(time.smooth===undefined||time.smooth===0?{}:{smooth:time.smooth}),...(time.steps===undefined?{}:{steps:time.steps}),
  // The curve's audio mode is kept: `protect` as it is, `follow` (the node's default) as no key. Any other value fails the curve check.
  ...(time.audio===undefined||time.audio==='follow'?{}:{audio:time.audio})};
 return {curve:isDialCurve(curve)?curve:undefined,fractions};
}

/**
 * Pack preset rows to rack rows. `seconds` is the lane length (the clip, or the whole Continuity piece), used for curves stored as
 * clip fractions. A row with a kind this version does not send (hold, step envelope, block strengths, audio-driven curve, wired
 * input) or outside the compiler's limits is left out and reported; a rack holds at most 8 rows. `solo` has no switch in DEAS: when
 * an active preset row is solo, the pack runs only the solo rows, so the other rows are loaded switched off.
 */
export function fromPresetRows(rows:readonly unknown[],seconds:number,warnings:readonly {row:number;reason:PresetWarning}[]=[]):PresetConversion {
 const active=(r:unknown)=>isObject(r)&&r.on!==false&&(r.hold===true||(typeof r.strength==='number'&&r.strength!==0));
 const soloed=rows.some(r=>active(r)&&(r as Record<string,unknown>).solo===true);
 const out:DialRow[]=[];
 const report=rows.map((raw,index):PresetRowReport=>{
  const r=isObject(raw)?raw:{};
  const dial=typeof r.dial==='string'?dialName(r.dial):'',strength=typeof r.strength==='number'&&Number.isFinite(r.strength)?r.strength:null;
  const time=isObject(r.time)?r.time:undefined;
  const leftOut:PresetLeftOut[]=[],changed:PresetChanged[]=[];
  if('input' in r)leftOut.push('wired');
  if(r.hold===true)leftOut.push('hold');
  if('envelope' in r)leftOut.push('envelope');
  if('blocks' in r)leftOut.push('blocks');
  if(!('input' in r)&&!isDialFile(dial))leftOut.push('dial');
  if(strength===null||Math.abs(strength)>DIAL_LEVEL)leftOut.push('strength');
  let curve:H3DialCurve|undefined;
  if(time?.type==='audio')leftOut.push('audioCurve');
  else if('time' in r){
   const c=presetCurve(time??{},seconds);
   curve=c.curve;
   if(!curve)leftOut.push('curve');
   else if(c.fractions)changed.push('fractions');
  }
  let on=r.on!==false;
  if(soloed){if(r.solo===true)changed.push('solo');else if(on){on=false;changed.push('soloOff');}}
  if(!leftOut.length&&out.length>=DIAL_ROWS)leftOut.push('tooMany');
  const row:DialRow={dial,strength:strength??0,on,...(curve?{time:curve}:{})};
  if(!leftOut.length&&isDialRow(row))out.push(row);
  else if(!leftOut.length)leftOut.push('dial');
  return {index,dial,strength,on,curve:'time' in r,leftOut,changed:leftOut.length?[]:changed,warnings:warnings.filter(w=>w.row===index).map(w=>w.reason)};
 });
 return {rows:out,report};
}

/** Rack rows as the pack's routes take them: only what DEAS sends (`dial`, `strength`, `on`, and a keys curve in seconds with its audio mode when it is `protect`). No `sha256`: the pack computes it from the dial file when it saves. */
export function toPresetRows(rows:readonly DialRow[]):DialRow[] {
 return rows.map(r=>({dial:dialName(r.dial),strength:r.strength,on:r.on!==false,...(r.time?{time:{...r.time,unit:'seconds' as const}}:{})}));
}

export interface DialPreset { rows:unknown[]; warnings:{row:number;reason:PresetWarning}[] }
/** How the dialog reaches the store; the native commands by default, a fixture in tests. */
export interface DialPresetStore { list(baseUrl:string):Promise<string[]>; load(baseUrl:string,name:string):Promise<DialPreset>; save(baseUrl:string,name:string,rows:readonly DialRow[]):Promise<DialPreset> }
async function native<T>(command:string,args:Record<string,unknown>):Promise<T> {
 if(!isTauri())throw new Error('DIAL_PRESETS_NATIVE: Rack presets need the DEAS desktop app.');
 try{return await invoke<T>(command,args);}
 catch(error){throw new Error(error&&typeof error==='object'&&'message' in error?String((error as {message:unknown}).message):String(error));}
}
/** Native commands over the pack's `/mainodes/dials/presets` routes (`jobs_dial_presets.rs`); failures are logged natively. */
export const nativeDialPresets:DialPresetStore={
 list:baseUrl=>native('native_dial_presets',{baseUrl}),
 load:(baseUrl,name)=>native('native_dial_preset_load',{baseUrl,name}),
 save:(baseUrl,name,rows)=>native('native_dial_preset_save',{baseUrl,name,rows}),
};
/** Native failure text is `CODE: detail`; the code picks the localized sentence, the detail is the backend's or the validator's own reason. */
export const dialPresetErrorCodes=['DIAL_PRESETS_ENDPOINT','DIAL_PRESET_NAME','DIAL_PRESET_ROWS','DIAL_PRESETS_UNREACHABLE','DIAL_PRESETS_UNAVAILABLE','DIAL_PRESET_NOT_FOUND','DIAL_PRESET_EXISTS','DIAL_PRESET_REFUSED','DIAL_PRESETS_FAILED','DIAL_PRESETS_MALFORMED','DIAL_PRESETS_NATIVE'] as const;
export type DialPresetErrorCode=typeof dialPresetErrorCodes[number];
export function dialPresetError(error:unknown):{code:DialPresetErrorCode|'';detail:string} {
 const text=error instanceof Error?error.message:String(error),split=text.indexOf(': ');
 const code=dialPresetErrorCodes.find(c=>c===text.slice(0,split));
 return code?{code,detail:text.slice(split+2)}:{code:'',detail:text};
}
