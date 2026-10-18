import { useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import type { RecipeAllowlist, RunOptions } from '../../lib/execution';
import { defaultOutputNaming, outputNamingTemplate, outputPrefix } from '../../lib/outputNaming';
import builtinFamilies from '../../families/builtin.json';

/** Remembered Options tab state; only what the backend lists is ever submitted. `attention` is `a:<ModelAttentionBackend>`, `s:<Sage mode>` or '' (launch default). `sigmas` is the custom schedule text ('' = the model's own, if any). */
export interface OptionsPref { attention:string; vae:'full'|'tiled'; tile:number; cache:''|'EasyCache'|'LazyCache'; threshold:number; compile:string; sigmas?:string; outputNaming?:string }
const tiles=[256,512,768,1024];
const namingPlaceholders=['type','date_yyyy-mm-dd','time','seed','model'];
// Threshold 0.05: the nodes' own 0.2 (tuned for video DiTs) ruined SDXL images in a real run; 0.05 kept them coherent.
export const defaultOptions:OptionsPref={attention:'',vae:'full',tile:512,cache:'',threshold:0.05,compile:'',sigmas:'',outputNaming:defaultOutputNaming};
/** Known model-fixed schedules come from the family plugin (e.g. Qwen Image 2.1 Turbo's saved 8-step sigmas). */
export const sigmaPresets=(builtinFamilies as {id:string;name:string;sigmas?:number[]}[]).filter(f=>f.sigmas).map(f=>({id:f.id,name:f.name,sigmas:f.sigmas!}));
export const sigmaText=(s:readonly number[])=>s.join(', ');
/** Comma/space-separated, finite, strictly descending, ending at 0 (what ManualSigmas and the native validator accept); null = not a schedule. */
export function parseSigmas(text:string):number[]|null{
 const parts=text.trim().split(/[\s,]+/).filter(Boolean);const v=parts.map(Number);
 return parts.length>=2&&v.every((n,i)=>Number.isFinite(n)&&n>=0&&n<=1000&&(i===0||n<v[i-1]))&&v[v.length-1]===0?v:null;
}
// Dynamo cannot trace the Comfy Kitchen INT8 kernel (real run: TorchRuntimeError), so the two never go together.
const kitchen=(p:OptionsPref)=>p.attention==='a:comfy kitchen attention';
export const isOptionsPref=(v:unknown):v is OptionsPref=>{
 const o=v as OptionsPref;
 return !!o&&typeof o==='object'&&typeof o.attention==='string'&&(o.vae==='full'||o.vae==='tiled')&&tiles.includes(o.tile)
  &&['','EasyCache','LazyCache'].includes(o.cache)&&typeof o.threshold==='number'&&o.threshold>=0&&o.threshold<=3&&typeof o.compile==='string'&&(o.sigmas===undefined||typeof o.sigmas==='string')&&(o.outputNaming===undefined||typeof o.outputNaming==='string');
};
type Allow=Pick<RecipeAllowlist,'nodes'|'attention'|'sage'|'compile'>;

/** Intent `options` from the remembered state. Choices a read backend does not list are left out; an unread backend leaves the check to native preparation. */
export function runOptions(p:OptionsPref,allow:Allow|null):RunOptions|undefined{
 const has=(node:string)=>!allow||allow.nodes.includes(node);
 const listed=(list:readonly string[]|undefined,v:string)=>!allow||!!list?.includes(v);
 const kind=p.attention.slice(0,2),value=p.attention.slice(2);
 const o:RunOptions={
  ...(kind==='a:'&&has('ModelAttentionBackend')&&listed(allow?.attention,value)?{attention:value}:{}),
  ...(kind==='s:'&&has('PathchSageAttentionKJ')&&listed(allow?.sage,value)?{sage:value}:{}),
  ...(p.cache&&has(p.cache)?{cache:{node:p.cache,threshold:p.threshold}}:{}),
  ...(p.compile&&!kitchen(p)&&has('TorchCompileModel')&&listed(allow?.compile,p.compile)?{compile:p.compile}:{}),
  ...(p.vae==='tiled'&&has('VAEDecodeTiled')?{vaeTile:p.tile}:{}),
 };
 return Object.keys(o).length?o:undefined;
}

export interface OptionsPanelProps { value:OptionsPref; onChange:(next:OptionsPref)=>void; allow:Allow|null; /** Model family id: the Spectrum step cache belongs to MiniMax H3 only. */ family?:string; imageInput:boolean; onRead:()=>void; canRead:boolean }
/** Options tab: per-job speed/memory patches compiled into the graph, so no backend restart is needed. */
export function OptionsPanel({value:p,onChange,allow,family,imageInput,onRead,canRead}:OptionsPanelProps){
 const {t}=useI18n();
 const [help,setHelp]=useState('');
 const set=(patch:Partial<OptionsPref>)=>onChange({...p,...patch});
 const has=(node:string)=>!!allow?.nodes.includes(node);
 const off=(node:string)=>!!allow&&!has(node);
 const missing=(node:string,pack='core')=>off(node)?t(`studio.run.opt.missing.${pack}`):'';
 // A remembered value the backend does not (yet) list stays visible instead of silently changing.
 const keep=(list:string[],v:string)=>v&&!list.includes(v)?[...list,v]:list;
 const attentions=[...(allow?.attention??[]).map(a=>`a:${a}`),...(allow?.sage??[]).map(s=>`s:${s}`)];
 const h3=family!=='minimax-h3'?'studio.run.opt.cache.h3Only':has('SpectrumApplyMiniMaxH3')?'studio.run.pipe.noRecipe':'studio.run.opt.missing.h3';
 // Help sits behind "?" to keep the grid dense; an invalid value stays visible below the control.
 const card=(id:string,control:React.ReactNode,note:React.ReactNode,error?:string)=><div className="wb-option" data-option={id}>
  <span>{t(`studio.run.opt.${id}`)}<button type="button" className="wb-help" aria-label={t('studio.run.opt.help',{name:t(`studio.run.opt.${id}`)})} aria-expanded={help===id} aria-controls={`opt-help-${id}`} onClick={()=>setHelp(help===id?'':id)}>?</button></span>
  {control}{error&&<small role="alert">{error}</small>}{help===id&&<small id={`opt-help-${id}`} className="wb-help-text">{note}</small>}</div>;
 // The field shows the schedule in use: the typed override, else the model's own; a preset pick fills the text.
 const modelSigmas=sigmaPresets.find(f=>f.id===family)?.sigmas;
 const sigmas=p.sigmas??'';
 const shown=sigmas||(modelSigmas?sigmaText(modelSigmas):'');
 const preset=sigmaPresets.find(f=>sigmaText(f.sigmas)===shown.trim())?.id??(shown?'custom':'');
 const naming=outputNamingTemplate(p.outputNaming);
 const namingValid=outputPrefix(naming,{type:'image',seed:0,model:'model'})!==null;
 const namingHelp=<>{t('studio.run.opt.outputNaming.hint')}<span className="wb-help-list">{namingPlaceholders.map(k=><span key={k}><code>{`%${k}%`}</code> {outputPrefix(`%${k}%`,{type:'image',seed:42,model:'My Model.safetensors'})}</span>)}</span></>;
 return <div className="wb-options">
  {!allow&&<p className="media-help wb-options-read">{t('studio.run.opt.unread')} <button type="button" className="wb-dock-action" disabled={!canRead} onClick={onRead}>{t('studio.run.opt.read')}</button></p>}
  {card('outputNaming',<input type="text" aria-label={t('studio.run.opt.outputNaming')} aria-invalid={!namingValid} value={naming} maxLength={512} spellCheck={false} onChange={e=>set({outputNaming:e.target.value})}/>,namingHelp,namingValid?undefined:t('studio.run.opt.outputNaming.invalid'))}
  {card('attention',<select aria-label={t('studio.run.opt.attention')} value={p.attention} onChange={e=>set({attention:e.target.value})}>
   <option value="">{t('studio.run.opt.attention.default')}</option>
   {keep(attentions,p.attention).map(v=><option key={v} value={v} disabled={!attentions.includes(v)}>{v.startsWith('s:')?`Sage · ${v.slice(2)}`:v.slice(2)}</option>)}
  </select>,t(p.attention.startsWith('s:')?'studio.run.opt.attention.sage':allow&&!allow.sage?.length?'studio.run.opt.attention.noSage':'studio.run.opt.attention.hint'))}
  {card('vae',<span className="wb-option-row"><select aria-label={t('studio.run.opt.vae')} value={p.vae} disabled={off('VAEDecodeTiled')} onChange={e=>set({vae:e.target.value as OptionsPref['vae']})}><option value="full">{t('studio.run.opt.vae.full')}</option><option value="tiled">{t('studio.run.opt.vae.tiled')}</option></select>
   {p.vae==='tiled'&&<select aria-label={t('studio.run.opt.vae.tile')} value={p.tile} onChange={e=>set({tile:Number(e.target.value)})}>{tiles.map(n=><option key={n} value={n}>{`${n} px`}</option>)}</select>}</span>,
   missing('VAEDecodeTiled')||t(p.vae==='tiled'&&imageInput?'studio.run.opt.vae.both':'studio.run.opt.vae.hint'))}
  {card('cache',<span className="wb-option-row"><select aria-label={t('studio.run.opt.cache')} value={p.cache} onChange={e=>set({cache:e.target.value as OptionsPref['cache']})}>
   <option value="">{t('studio.run.opt.off')}</option>
   {(['EasyCache','LazyCache'] as const).map(n=><option key={n} value={n} disabled={off(n)}>{n}</option>)}
   <option value="spectrum" disabled>{`Spectrum H3 · ${t(h3)}`}</option>
  </select>{p.cache&&<input type="number" aria-label={t('studio.run.opt.cache.threshold')} title={t('studio.run.opt.cache.threshold')} value={p.threshold} min={0} max={3} step={0.01} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n)&&n>=0&&n<=3)set({threshold:n});}}/>}</span>,
   p.cache?missing(p.cache)||t(`studio.run.opt.cache.${p.cache}`):t('studio.run.opt.cache.hint'))}
  {card('sigmas',<span className="wb-option-row"><select aria-label={t('studio.run.opt.sigmas.preset')} value={preset} onChange={e=>{const f=sigmaPresets.find(x=>x.id===e.target.value);set({sigmas:f?sigmaText(f.sigmas):''});}}>
   <option value="">{t(modelSigmas?'studio.run.opt.sigmas.model':'studio.run.opt.off')}</option>
   {sigmaPresets.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
   <option value="custom" disabled>{t('studio.run.opt.sigmas.custom')}</option>
  </select><input type="text" className="wb-sigmas" aria-label={t('studio.run.opt.sigmas')} value={shown} placeholder={sigmaText([1,0.5,0])} spellCheck={false} onChange={e=>set({sigmas:e.target.value})}/></span>,
   missing('SamplerCustomAdvanced')||t('studio.run.opt.sigmas.hint'),shown&&!parseSigmas(shown)?t('studio.run.opt.sigmas.invalid'):undefined)}
  {card('compile',<select aria-label={t('studio.run.opt.compile')} value={p.compile} disabled={off('TorchCompileModel')||kitchen(p)} onChange={e=>set({compile:e.target.value})}><option value="">{t('studio.run.opt.off')}</option>{keep([...(allow?.compile??[])],p.compile).map(b=><option key={b} value={b} disabled={!allow?.compile?.includes(b)}>{b}</option>)}</select>,missing('TorchCompileModel')||t(kitchen(p)?'studio.run.opt.compile.kitchen':'studio.run.opt.compile.hint'))}
 </div>;
}
