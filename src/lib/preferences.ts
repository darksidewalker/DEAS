import { createContext, useContext, useEffect, useRef, useState } from 'react';

/** Project image drafts must not replace the user's global Studio defaults. */
export const PreferencePersistenceContext=createContext(true);

/**
 * Remembered user choices: one JSON value per key in the app's webview storage, which survives restarts.
 * Every read is validated, so stale, foreign or corrupt values fall back to the default instead of breaking a page.
 * Secrets never go here (tokens use the OS credential store); per-environment folders stay in deas-settings.json.
 */
const prefix='deas.pref.';
export type Valid<T>=(value:unknown)=>value is T;
export const oneOf=<T extends string>(...values:readonly T[]):Valid<T>=>(v):v is T=>values.includes(v as T);
export const isString:Valid<string>=(v):v is string=>typeof v==='string';
export const isBoolean:Valid<boolean>=(v):v is boolean=>typeof v==='boolean';

export function readPref<T>(key:string,fallback:T,valid:Valid<T>):T {
 try {const raw=localStorage.getItem(prefix+key);if(raw===null)return fallback;const value:unknown=JSON.parse(raw);return valid(value)?value:fallback;}
 catch {return fallback;}
}
export function writePref(key:string,value:unknown){try{localStorage.setItem(prefix+key,JSON.stringify(value));}catch{/* Storage may be unavailable; the choice then lasts for this session only. */}}
export function forgetPref(key:string){try{localStorage.removeItem(prefix+key);}catch{/* Storage may be unavailable. */}}

export const STUDIO_RESET_EVENT='deas:reset-studio-preferences';
const preservedStudioPreferenceKeys=['studio.run.recentSeeds','studio.run.continuity','studio.run.metadataOpen'];
const STUDIO_SETTINGS_EVENT='deas:studio-settings';
type SettingsTransfer={mode:'capture'|'defaults'|'validate'|'apply';settings:Record<string,unknown>;keys:Set<string>;invalid:string[]};
/** Capture live controls, including an unsaved project draft, not stale localStorage. */
export function captureStudioSettings(){
 const detail:SettingsTransfer={mode:'capture',settings:{},keys:new Set(),invalid:[]};
 window.dispatchEvent(new CustomEvent(STUDIO_SETTINGS_EVENT,{detail}));return detail.settings;
}
export function applyStudioSettings(settings:Record<string,unknown>){
 const detail:SettingsTransfer={mode:'validate',settings,keys:new Set(),invalid:[]};
 window.dispatchEvent(new CustomEvent(STUDIO_SETTINGS_EVENT,{detail}));
 if(detail.invalid.length||Object.keys(settings).some(key=>!detail.keys.has(key)))return false;
 detail.mode='apply';window.dispatchEvent(new CustomEvent(STUDIO_SETTINGS_EVENT,{detail}));return true;
}
/** Canonical defaults of every live transferable control (what Reset to defaults restores). */
export function studioDefaults(){
 const detail:SettingsTransfer={mode:'defaults',settings:{},keys:new Set(),invalid:[]};
 window.dispatchEvent(new CustomEvent(STUDIO_SETTINGS_EVENT,{detail}));return detail.settings;
}
/** Keys of `settings` the live controls do not know, and keys whose value they reject; nothing is applied. */
export function checkStudioSettings(settings:Record<string,unknown>){
 const detail:SettingsTransfer={mode:'validate',settings,keys:new Set(),invalid:[]};
 window.dispatchEvent(new CustomEvent(STUDIO_SETTINGS_EVENT,{detail}));
 return {unknown:Object.keys(settings).filter(key=>!detail.keys.has(key)),invalid:[...new Set(detail.invalid)]};
}
/** Reset live editable controls; persistence still follows the active project scope. */
export function resetStudioPreferences(){window.dispatchEvent(new Event(STUDIO_RESET_EVENT));}

/** useState that is restored on the next start; use it for any remembered page, filter or configuration choice. */
export function usePref<T>(key:string,fallback:T,valid:Valid<T>) {
 const persist=useContext(PreferencePersistenceContext)||!key.startsWith('studio.run.');
 const [value,setValue]=useState<T>(()=>readPref(key,fallback,valid));
 const canonicalDefault=useRef(fallback);
 useEffect(()=>{
  if(!key.startsWith('studio.run.')||preservedStudioPreferenceKeys.includes(key))return;
  const transfer=(event:Event)=>{
   const detail=(event as CustomEvent<SettingsTransfer>).detail;detail.keys.add(key);
   if(detail.mode==='capture')detail.settings[key]=structuredClone(value);
   else if(detail.mode==='defaults')detail.settings[key]=structuredClone(canonicalDefault.current);
   else if(Object.hasOwn(detail.settings,key)){
    if(!valid(detail.settings[key]))detail.invalid.push(key);
    else if(detail.mode==='apply')setValue(structuredClone(detail.settings[key]));
   }
  };
  window.addEventListener(STUDIO_SETTINGS_EVENT,transfer);return()=>window.removeEventListener(STUDIO_SETTINGS_EVENT,transfer);
 },[key,value,valid]);
 useEffect(()=>{
  if(!key.startsWith('studio.run.')||preservedStudioPreferenceKeys.includes(key))return;
  const reset=()=>setValue(structuredClone(canonicalDefault.current));
  window.addEventListener(STUDIO_RESET_EVENT,reset);return()=>window.removeEventListener(STUDIO_RESET_EVENT,reset);
 },[key]);
 const previousPersist=useRef(persist);
 useEffect(()=>{
  if(persist&&!previousPersist.current){previousPersist.current=true;setValue(readPref(key,fallback,valid));return;}
  previousPersist.current=persist;
  if(persist)writePref(key,value);
 },[key,value,persist]);
 return [value,setValue] as const;
}
