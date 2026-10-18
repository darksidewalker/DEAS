import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import type { WildcardRules } from '../../lib/wildcard';
import './wildcards.css';

type Subject={subject:string;booru_wildcards?:string[];nl_wildcards?:string[];booru_presets?:string[];nl_presets?:string[]};
type Library=Record<string,Subject[]>;
const kinds=['wildcards','presets'] as const;
/** Same rejection-sampled crypto picks as the node's Random Select. */
function randomIndex(limit:number){const range=0x100000000,ceiling=range-range%limit,n=new Uint32Array(1);do{crypto.getRandomValues(n);}while(n[0]>=ceiling);return n[0]%limit;}
function parseLibrary(text:string):Library {
 const value=JSON.parse(text)?.categories;
 if(!value||typeof value!=='object'||Array.isArray(value)||!Object.entries(value).every(([category,subjects])=>category.length>0&&Array.isArray(subjects)&&subjects.every(s=>s&&typeof s.subject==='string'&&kinds.every(k=>['booru','nl'].every(style=>s[`${style}_${k}`]===undefined||(Array.isArray(s[`${style}_${k}`])&&s[`${style}_${k}`].every((v:unknown)=>typeof v==='string')))))))throw new Error('Invalid wildcard library');
 return value;
}
export function WildcardPanel({endpoint,value,onChange,enabled,onEnabled}:{endpoint:string;value:WildcardRules;onChange:(v:WildcardRules)=>void;enabled:boolean;onEnabled:(v:boolean)=>void}){
 const {t}=useI18n();const [library,setLibrary]=useState<Library|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0),[query,setQuery]=useState('');
 useEffect(()=>{let live=true;setLibrary(null);setError('');
  if(!isTauri()||!endpoint.trim()){setError(t('wildcards.noBackend'));return;}
  invoke<string>('native_wildcard_library',{baseUrl:endpoint}).then(text=>{const next=parseLibrary(text);if(live)setLibrary(next);}).catch(e=>{if(live)setError(String(e));});
  return()=>{live=false;};
 },[endpoint,revision]);
 const prefix=value.style==='Booru'?'booru':'nl';
 const entries=Object.entries(library??{}).flatMap(([category,subjects])=>subjects.flatMap(subject=>kinds.flatMap(kind=>{
  const text=subject[`${prefix}_${kind}`]??[];
  return text.length?[{category,subject:subject.subject,kind,text,key:`${category}/${subject.subject}/${kind}`}]:[];
 })));
 const used=entries.filter(e=>value.selection_state[e.key]?.enabled);
 const negative=(category:string)=>category.toLowerCase().includes('negative prompt');
 const update=(patch:Partial<WildcardRules>)=>onChange({...value,...patch});
 const select=(key:string,patch:{enabled?:boolean;weight?:number})=>update({selection_state:{...value.selection_state,[key]:{...(value.selection_state[key]??{enabled:false,weight:1}),...patch}}});
 const randomSelect=()=>{const candidates=[...entries],state:WildcardRules['selection_state']={};const count=Math.min(candidates.length,1+randomIndex(10));
  for(let i=0;i<count;i++){const j=i+randomIndex(candidates.length-i);[candidates[i],candidates[j]]=[candidates[j],candidates[i]];const key=candidates[i].key;state[key]={enabled:true,weight:value.selection_state[key]?.weight??1};}update({selection_state:state});
 };
 return <section className="wildcards" aria-label={t('wildcards.title')}>
  <div className="wildcard-toolbar">
   <label className="wildcard-check"><input type="checkbox" checked={enabled} onChange={e=>onEnabled(e.target.checked)}/>{t('wildcards.enabled')}</label>
   <label>{t('wildcards.style')}<select value={value.style} onChange={e=>update({style:e.target.value as WildcardRules['style']})}><option value="Booru">{t('wildcards.booru')}</option><option value="Natural Language">{t('wildcards.nl')}</option></select></label>
   <label>{t('wildcards.seed')}<input type="number" min={0} max={0xffffffff} step={1} value={value.seed} onChange={e=>{const n=Number(e.target.value);if(Number.isInteger(n)&&n>=0&&n<=0xffffffff)update({seed:n});}}/></label>
   <label>{t('wildcards.budget')}<input type="number" min={1} max={10000} step={1} value={value.token_budget} onChange={e=>{const n=Number(e.target.value);if(Number.isInteger(n)&&n>=1&&n<=10000)update({token_budget:n});}}/></label>
   <label className="wildcard-check"><input type="checkbox" checked={value.auto_reroll} onChange={e=>update({auto_reroll:e.target.checked})}/>{t('wildcards.auto')}</label>
   <button type="button" onClick={()=>update({reroll:randomIndex(0x80000000)})}>{t('wildcards.picks')}</button>
   <button type="button" disabled={!entries.length} onClick={randomSelect}>{t('wildcards.random')}</button>
   <button type="button" disabled={!Object.keys(value.selection_state).length} onClick={()=>update({selection_state:{}})}>{t('wildcards.clear')}</button>
   <button type="button" onClick={()=>setRevision(n=>n+1)}>{t('wildcards.reload')}</button>
   <input type="search" value={query} aria-label={t('wildcards.search')} placeholder={t('wildcards.search')} onChange={e=>setQuery(e.target.value)}/>
  </div>
  <p className="wildcard-help">{t('wildcards.help')} <strong role="status">{t('wildcards.selected',{count:used.length})}</strong></p>
  {error?<p className="error-message" role="alert">{error}</p>:!library?<p role="status">{t('wildcards.loading')}</p>:entries.length===0?<p>{t('wildcards.empty')}</p>:<div className="wildcard-body"><div className="wildcard-categories">
   {Object.keys(library).map(category=>{const list=entries.filter(e=>e.category===category&&`${category} ${e.subject} ${e.text.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));if(!list.length)return null;const count=entries.filter(e=>e.category===category&&value.selection_state[e.key]?.enabled).length;
    return <details key={category} className={count?'is-selected':''} open={query.trim()?true:undefined}>
     <summary><span>{category}</span><small>{t(negative(category)?'wildcards.negative':'wildcards.positive')}</small>{count>0&&<strong>{t('wildcards.selected',{count})}</strong>}</summary>
     {kinds.map(kind=>{const items=list.filter(e=>e.kind===kind);return items.length>0&&<div key={kind} className="wildcard-section"><h4>{t(`wildcards.${kind}`)}</h4>{items.map(e=>{const state=value.selection_state[e.key];const label=`${e.subject} · ${t(`wildcards.${kind}`)}`;return <div key={e.key} className="wildcard-row">
      <label className="wildcard-check"><input type="checkbox" checked={state?.enabled??false} aria-label={label} onChange={event=>select(e.key,{enabled:event.target.checked})}/>{e.subject}</label>
      <input type="number" min={-10} max={10} step={0.05} value={state?.weight??1} aria-label={t('wildcards.weight',{name:label})} onChange={event=>{const n=Number(event.target.value);if(Number.isFinite(n)&&Math.abs(n)<=10)select(e.key,{weight:Math.round(n*100)/100});}}/>
      <small>{e.text.join(', ')}</small>
     </div>;})}</div>;})}
    </details>;
   })}
  </div>
  <aside className="wildcard-preview" aria-label={t('wildcards.preview')}><h3>{t('wildcards.preview')}</h3>
   {[false,true].map(neg=>{const side=used.filter(e=>negative(e.category)===neg);return side.length>0&&<div key={String(neg)}><h4>{t(neg?'wildcards.negative':'wildcards.positive')}</h4><ul>
    {side.map(e=>{const weight=value.selection_state[e.key].weight;return <li key={e.key}><strong>{e.subject} · {t(`wildcards.${e.kind}`)}{weight!==1&&` ×${weight}`}</strong> {e.text.join(', ')}</li>;})}
   </ul></div>;})}
  </aside></div>}
 </section>;
}
