import type { LocalModel } from './models';

export const componentSlots=['textEncoders','vaes','audioVaes','textProjections'] as const;
export type ComponentSlot=typeof componentSlots[number];
export interface ComponentFamily {
 textEncoders?:string[]; vaes?:string[]; audioVaes?:string[]; textProjections?:string[];
 components?:Partial<Record<ComponentSlot,string[]>>;
}
export const defaultComponentOverrides={textEncoders:false,vaes:false,audioVaes:false,textProjections:false};
export const isComponentOverrides=(value:unknown):value is typeof defaultComponentOverrides=>!!value&&typeof value==='object'&&Object.keys(value).length===componentSlots.length&&componentSlots.every(key=>typeof (value as Record<string,unknown>)[key]==='boolean');

/** Header identities win over filename hints; explicit overrides only widen the current category. */
export function componentFiles(models:readonly LocalModel[],family:ComponentFamily,slot:ComponentSlot,all=false):string[] {
 const categories=slot==='vaes'||slot==='audioVaes'?['vae']:['text_encoders','clip'];
 return [...new Set(models.filter(model=>categories.includes(model.category)&&(all||(model.component
  ?family.components?.[slot]?.includes(model.component)
  :(family[slot]??[]).some(pattern=>(model.name.split('/').pop()??'').toLowerCase().includes(pattern)))))
  .map(model=>model.name))].sort((a,b)=>a.localeCompare(b));
}
