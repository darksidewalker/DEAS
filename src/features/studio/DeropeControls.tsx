import { useI18n } from '../../i18n/I18nProvider';
import type { RecipeAllowlist } from '../../lib/execution';
import { deropeInjects, deropePresets, type DeropePreset, type VideoPost } from '../../lib/videoIntent';

/** MiniMax H3 de-rope second pass (Motion Lab): turbo LoRA (6 steps) or the base model (25 steps). */
export interface DeropePref { enabled:boolean; keepBackground:boolean; mode:'turbo'|'full'; lora:string; preset:DeropePreset; inject:typeof deropeInjects[number] }
export const defaultDerope:DeropePref={enabled:false,keepBackground:false,mode:'turbo',lora:'',preset:'balanced',inject:0.48};
export const isDeropePref=(v:unknown):v is DeropePref=>{const o=v as Record<string,unknown>;return !!o&&typeof o==='object'&&Object.entries(defaultDerope).every(([k,d])=>o[k]===undefined||typeof o[k]===typeof d);};
export const deropeNodes=['DaSiWaH3DeropePrepare','DaSiWaH3DeropeRecover'] as const;
/** Adds the enabled stage to the TVE chain; off leaves the intent byte-identical. */
export function withDerope(post:VideoPost|undefined,p:DeropePref):VideoPost|undefined{
 if(!p.enabled)return post;
 return {...post,derope:{preset:p.preset,inject:p.inject,...(p.keepBackground===true?{keepBackground:true}:{}),...(p.mode==='turbo'?{lora:p.lora}:{})}};
}
export function fromDerope(v:VideoPost['derope']):DeropePref{
 return v?{enabled:true,mode:v.lora?'turbo':'full',lora:v.lora??'',preset:v.preset,inject:v.inject,keepBackground:v.keepBackground??false}:defaultDerope;
}

export function DeropeControls({value,onChange,allow,onRead,conflict}:{value:DeropePref;onChange:(next:DeropePref)=>void;allow:RecipeAllowlist|null;onRead?:()=>void;conflict:boolean}){
 const {t}=useI18n();
 const set=(patch:Partial<DeropePref>)=>onChange({...defaultDerope,...value,...patch});
 const missing=!!allow&&deropeNodes.some(n=>!allow.nodes.includes(n));
 const loras=allow?.loras??[];
 return <fieldset className="wb-group" data-post-group="derope"><legend>{t('studio.run.derope.title')}</legend><div className="wb-options">
  <div className="wb-option"><span><label className="wb-option-row"><input type="checkbox" data-derope="enabled" disabled={missing} checked={value.enabled} onChange={e=>set({enabled:e.target.checked})}/>{t('studio.run.derope.enabled')}</label></span>
   <small>{t(missing?'studio.run.derope.missing':'studio.run.derope.hint')}</small>
   {value.enabled&&conflict&&<small role="status">{t('studio.run.derope.conflict')}</small>}</div>
  <div className="wb-option"><span><label className="wb-option-row"><input type="checkbox" data-derope="keep-background" disabled={!value.enabled||!allow?.deropeKeepBackground} checked={value.keepBackground??false} title={t(!allow?.deropeKeepBackground?'studio.run.derope.keepBackgroundMissing':!value.enabled?'studio.run.derope.keepBackgroundInactive':'studio.run.derope.keepBackgroundHint')} onChange={e=>set({keepBackground:e.target.checked})}/>{t('studio.run.derope.keepBackground')}</label></span>
   <small>{t(!allow?.deropeKeepBackground?'studio.run.derope.keepBackgroundMissing':'studio.run.derope.keepBackgroundHint')}</small></div>
  {value.enabled&&<>
   <label className="wb-option"><span>{t('studio.run.derope.mode')}</span><select data-derope="mode" value={value.mode} onChange={e=>{const mode=e.target.value as DeropePref['mode'];set({mode,inject:mode==='turbo'?0.48:0.7});}}>
    <option value="turbo">{t('studio.run.derope.turbo')}</option><option value="full">{t('studio.run.derope.full')}</option></select></label>
   {value.mode==='turbo'&&<label className="wb-option"><span>{t('studio.run.derope.lora')}</span><select data-derope="lora" aria-label={t('studio.run.derope.lora')} value={value.lora} onFocus={onRead} onPointerDown={onRead} onChange={e=>set({lora:e.target.value})}>
    {!loras.includes(value.lora)&&<option value={value.lora}>{value.lora||t('studio.run.latent.choose')}</option>}{loras.map(m=><option key={m} value={m}>{m}</option>)}</select><small>{t('studio.run.derope.loraHint')}</small></label>}
   <label className="wb-option"><span>{t('studio.run.derope.preset')}</span><select data-derope="preset" value={value.preset} onChange={e=>set({preset:e.target.value as DeropePreset})}>
    {deropePresets.map(p=><option key={p} value={p}>{t(`studio.run.derope.preset.${p.replace(' ','')}`)}</option>)}</select></label>
   <label className="wb-option"><span>{t('studio.run.derope.inject')}</span><select data-derope="inject" aria-label={t('studio.run.derope.inject')} value={value.inject} onChange={e=>set({inject:Number(e.target.value) as DeropePref['inject']})}>
    {deropeInjects.map(v=><option key={v} value={v}>{t(v===0.48?'studio.run.derope.inject.sharp':'studio.run.derope.inject.safe')}</option>)}</select><small>{t('studio.run.derope.injectHint')}</small></label>
  </>}
 </div></fieldset>;
}
