import { invoke } from '@tauri-apps/api/core';
import { readPref, writePref } from './preferences';
import { useEffect, useState } from 'react';
import type { TagSuggestion } from './forge';

export interface TagCompletionOptions { sources:string[];limit:number;aliases:boolean;contains:boolean;minimumCount:number;floating:boolean }
export const defaultTagCompletion:TagCompletionOptions={sources:['builtin'],limit:8,aliases:true,contains:true,minimumCount:0,floating:false};
const valid=(value:unknown):value is TagCompletionOptions=>{const v=value as TagCompletionOptions;return !!v&&Array.isArray(v.sources)&&v.sources.length<=8&&v.sources.every(s=>typeof s==='string'&&/^(builtin|danbooru|e621|merged|classified|custom-[a-f0-9]{16})$/.test(s))&&[8,16,32,64].includes(v.limit)&&typeof v.aliases==='boolean'&&typeof v.contains==='boolean'&&Number.isSafeInteger(v.minimumCount)&&v.minimumCount>=0&&typeof v.floating==='boolean';};
const KEY='prompt.tagCompletion',EVENT='deas:tag-completion';
/** Removed preset entries must not remain active through an older saved selection. */
export const tagSourceVisible=(id:string)=>!['danbooru','e621','classified'].includes(id);
function readOptions(){const saved=readPref(KEY,defaultTagCompletion,valid);return {...saved,sources:saved.sources.filter(tagSourceVisible)};}
export function useTagCompletion(){
 const [options,set]=useState(readOptions);
 useEffect(()=>{
  const changed=()=>set(readOptions());
  window.addEventListener(EVENT,changed);
  const saved=readPref(KEY,defaultTagCompletion,valid);
  if(saved.sources.some(id=>!tagSourceVisible(id))){writePref(KEY,readOptions());window.dispatchEvent(new Event(EVENT));}
  return()=>window.removeEventListener(EVENT,changed);
 },[]);
 return {options,update:(patch:Partial<TagCompletionOptions>)=>{
  const next={...readOptions(),...patch};
  if(valid(next)){next.sources=next.sources.filter(tagSourceVisible);writePref(KEY,next);window.dispatchEvent(new Event(EVENT));}
 }};
}

export interface TagSource { id:string;label:string;available:boolean;ready:boolean;rows:number;skipped:number }
export const tagSources=(root:string,modelsDir?:string)=>invoke<TagSource[]>('native_prompt_tag_sources',{root,modelsDir:modelsDir??null});
export const importTagSource=(root:string,modelsDir?:string,source?:string)=>invoke<TagSource|null>('native_prompt_tag_import',{root,modelsDir:modelsDir??null,source:source??null});
export const completionSearch=(root:string,target:string,query:string,{floating:_,...options}:TagCompletionOptions)=>invoke<TagSuggestion[]>('native_prompt_tag_search',{root,target,query,options});
/** Preserve the old transport for untouched settings and other Forge consumers. */
export const usesExtraCompletion=(o:TagCompletionOptions)=>o.sources.length!==1||o.sources[0]!=='builtin'||o.limit!==8||!o.aliases||!o.contains||o.minimumCount!==0;

export const removeTagSource=(root:string,source:string)=>invoke<void>('native_prompt_tag_remove',{root,source});
