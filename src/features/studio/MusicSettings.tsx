import {useI18n} from '../../i18n/I18nProvider';
import {musicBounds,musicMaxDuration,type AbcSettings,type MusicGenerationSettings,type MusicPlanning} from '../../lib/musicIntent';

export interface MusicSettingsProps {
 pipeline:'t2m'|'cover';
 planning:MusicPlanning; onPlanning:(v:MusicPlanning)=>void;
 maxDuration:number; onMaxDuration:(v:number)=>void;
 /** Cover only: installed SheetSage2 encoders as the backend lists them. */
 encoder:string; encoders:readonly string[]; onEncoder:(v:string)=>void; onReadChoices?:()=>void;
 abc:AbcSettings; onAbc:(v:AbcSettings)=>void;
 generation:MusicGenerationSettings; onGeneration:(v:MusicGenerationSettings)=>void;
}
const planningModes:MusicPlanning[]=['off','full','melody'];
/** YuE2 controls: planning mode, maximum duration, cover encoder, and the two advanced groups (bounds from `musicBounds`). */
export function MusicSettings({pipeline,planning,onPlanning,maxDuration,onMaxDuration,encoder,encoders,onEncoder,onReadChoices,abc,onAbc,generation,onGeneration}:MusicSettingsProps){
 const {t}=useI18n();
 const cover=pipeline==='cover';
 const field=<G extends 'abc'|'generation'>(group:G,key:keyof typeof musicBounds[G]&string,value:number,set:(n:number)=>void)=>{
  const [min,max,integer]=musicBounds[group][key] as readonly [number,number,boolean];
  return <label key={`${group}.${key}`} className="wb-field"><span>{t(key==='cfgScale'?'studio.music.arCfg':`studio.music.${key}`)}</span><input type="number" inputMode={integer?'numeric':'decimal'} data-music-setting={`${group}.${key}`} value={value} min={min} max={max} step={integer?1:0.01} onChange={e=>{const n=Number(e.target.value);if(e.target.value!==''&&Number.isFinite(n)&&n>=min&&n<=max&&(!integer||Number.isInteger(n)))set(n);}}/></label>;
 };
 return <>
  {cover?<p className="wb-active wb-wide" data-music-planning="melody"><span>{t('studio.music.planning')}</span><strong>{t('studio.music.melody')}</strong></p>
  :<label className="wb-field wb-wide"><span>{t('studio.music.planning')}</span><select data-music-planning value={planning} onChange={e=>onPlanning(e.target.value as MusicPlanning)}>{planningModes.map(m=><option key={m} value={m}>{t(`studio.music.${m}`)}</option>)}</select></label>}
  <label className="wb-field"><span>{t('studio.music.maxDuration')}</span><input type="number" inputMode="decimal" data-music-duration value={maxDuration} min={musicMaxDuration.step} max={musicMaxDuration.limit} step={musicMaxDuration.step} onChange={e=>{const n=Number(e.target.value);if(e.target.value!==''&&Number.isFinite(n)&&n>=musicMaxDuration.step&&n<=musicMaxDuration.limit)onMaxDuration(Math.round(n/musicMaxDuration.step)*musicMaxDuration.step);}}/></label>
  <p className="wb-resolution-hint">{t('studio.music.durationHint')}</p>
  {cover&&<><label className="wb-field wb-wide"><span>{t('studio.music.audioEncoder')}</span><select data-music-encoder value={encoder} onFocus={onReadChoices} onPointerDown={onReadChoices} onChange={e=>onEncoder(e.target.value)}>{!encoders.includes(encoder)&&<option value={encoder}>{encoder||t('studio.music.needsEncoder')}</option>}{encoders.map(v=><option key={v} value={v}>{v}</option>)}</select></label><p className="wb-resolution-hint wb-wide">{t('studio.music.coverHint')}</p></>}
  {!cover&&planning!=='off'&&<details className="wb-model-files wb-wide" data-music-abc-settings><summary>{t('studio.music.abcSettings')}</summary><div className="wb-controls">
   {field('abc','maxTokens',abc.maxTokens,n=>onAbc({...abc,maxTokens:n}))}{field('abc','temperature',abc.temperature,n=>onAbc({...abc,temperature:n}))}
   {field('abc','topP',abc.topP,n=>onAbc({...abc,topP:n}))}{field('abc','topK',abc.topK,n=>onAbc({...abc,topK:n}))}
   {field('abc','repetitionPenalty',abc.repetitionPenalty,n=>onAbc({...abc,repetitionPenalty:n}))}{field('abc','penaltyWindow',abc.penaltyWindow,n=>onAbc({...abc,penaltyWindow:n}))}
  </div></details>}
  <details className="wb-model-files wb-wide" data-music-generation-settings><summary>{t('studio.music.generationSettings')}</summary><div className="wb-controls">
   {field('generation','temperature',generation.temperature,n=>onGeneration({...generation,temperature:n}))}{field('generation','topP',generation.topP,n=>onGeneration({...generation,topP:n}))}
   {field('generation','topK',generation.topK,n=>onGeneration({...generation,topK:n}))}{field('generation','repetitionPenalty',generation.repetitionPenalty,n=>onGeneration({...generation,repetitionPenalty:n}))}
   {field('generation','cfgScale',generation.cfgScale,n=>onGeneration({...generation,cfgScale:n}))}
  </div></details>
 </>;
}
