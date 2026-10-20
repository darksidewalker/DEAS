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

/** useState that is restored on the next start; use it for any remembered page, filter or configuration choice. */
export function usePref<T>(key:string,fallback:T,valid:Valid<T>) {
 const persist=useContext(PreferencePersistenceContext)||!key.startsWith('studio.run.');
 const [value,setValue]=useState<T>(()=>readPref(key,fallback,valid));
 const previousPersist=useRef(persist);
 useEffect(()=>{
  if(persist&&!previousPersist.current){previousPersist.current=true;setValue(readPref(key,fallback,valid));return;}
  previousPersist.current=persist;
  if(persist)writePref(key,value);
 },[key,value,persist]);
 return [value,setValue] as const;
}
