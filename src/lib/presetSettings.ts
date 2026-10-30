/**
 * Presets store only what differs from the canonical Studio defaults, down to nested object fields.
 * Applying merges those overrides onto the defaults of the running version, so a later default change
 * reaches every field a preset never changed, and "changed" highlights always compare with today's defaults.
 */
export type Settings=Record<string,unknown>;
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);

export function equal(a:unknown,b:unknown):boolean{
 if(a===b)return true;
 if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>equal(x,b[i]));
 if(!plain(a)||!plain(b))return false;
 const keys=new Set([...Object.keys(a),...Object.keys(b)]);
 return [...keys].every(k=>equal(a[k],b[k]));
}
/** The part of `value` that differs from `fallback`; undefined when equal. Arrays and primitives are atomic. */
export function diff(value:unknown,fallback:unknown):unknown{
 // shortcut: a field the default has but the value lacks cannot be expressed and falls back to the default; add tombstones if a setting ever needs that.
 if(plain(value)&&plain(fallback)){
  const out:Settings={};
  for(const k of Object.keys(value)){const d=diff(value[k],fallback[k]);if(d!==undefined)out[k]=d;}
  return Object.keys(out).length?out:undefined;
 }
 return equal(value,fallback)?undefined:structuredClone(value);
}
export function merge(fallback:unknown,over:unknown):unknown{
 if(over===undefined)return structuredClone(fallback);
 if(!plain(fallback)||!plain(over))return structuredClone(over);
 const out:Settings=structuredClone(fallback);
 for(const k of Object.keys(over))out[k]=merge(fallback[k],over[k]);
 return out;
}
/** Sparse overrides of `settings`; keys the running version does not know are kept so the user can see and remove them. */
export function overrides(settings:Settings,defaults:Settings):Settings{
 const out:Settings={};
 for(const [k,v] of Object.entries(settings)){
  if(!Object.hasOwn(defaults,k)){out[k]=structuredClone(v);continue;}
  const d=diff(v,defaults[k]);if(d!==undefined)out[k]=d;
 }
 return out;
}
/** Every known setting at its default, with the preset's overrides merged in (unknown keys included, so applying fails closed). */
export function resolve(over:Settings,defaults:Settings):Settings{
 const out:Settings={};
 for(const k of Object.keys(defaults))out[k]=merge(defaults[k],over[k]);
 for(const k of Object.keys(over))if(!Object.hasOwn(defaults,k))out[k]=structuredClone(over[k]);
 return out;
}
/** Editable leaves: nested plain-object fields are flattened, arrays and primitives are single values. */
export function leaves(value:unknown,path:string[]=[]):{path:string[];value:unknown}[]{
 if(plain(value)&&Object.keys(value).length)return Object.keys(value).flatMap(k=>leaves(value[k],[...path,k]));
 return [{path,value}];
}
export function getAt(value:unknown,path:string[]):unknown{return path.reduce<unknown>((v,k)=>plain(v)?v[k]:undefined,value);}
export function setAt(value:unknown,path:string[],next:unknown):unknown{
 if(!path.length)return structuredClone(next);
 const base=plain(value)?structuredClone(value):{};
 base[path[0]]=setAt(base[path[0]],path.slice(1),next);
 return base;
}
/** Number of changed leaves, the count a preset tile shows. */
export const changedCount=(over:Settings)=>Object.values(over).reduce<number>((n,v)=>n+leaves(v).length,0);
