import families from '../families/builtin.json' with {type:'json'};
import type {LocalModel} from './models';
import type {CatalogEntry} from './downloads';
import {componentFiles,componentFilesNamed,componentSlots,type ComponentSlot} from './modelComponents';

export interface ModelCompanionSuggestion {slot:ComponentSlot|'textEncoders2';target:string;patterns:readonly string[];entries:CatalogEntry[]}
/** Recommendations only. Pass bundled/trusted entries, never provider search results or imported catalogs. */
export function modelCompanionAdvice(model:LocalModel,models:readonly LocalModel[],trustedEntries:readonly CatalogEntry[]=[]):ModelCompanionSuggestion[] {
 const family=families.find(f=>f.id===model.family);
 if(!family||family.loader!=='diffusion'||!['diffusion_models','unet'].includes(model.category)||model.misplacedAllInOne||model.integrity||model.metadataError||model.familyEvidence==='conflict')return [];
 const slots:ModelCompanionSuggestion['slot'][]=[...componentSlots,...(family.clip?.loader==='dual'?['textEncoders2' as const]:[])];
 return slots.flatMap(slot=>{
  const patterns=slot==='textEncoders2'?(family.clip?.encoders?.slice(1,2)??[]):(family as Partial<Record<ComponentSlot,string[]>>)[slot]??[];
  const matching=(files:readonly LocalModel[])=>slot==='textEncoders2'?componentFilesNamed(files,patterns):componentFiles(files,family,slot);
  if(!patterns.length||matching(models).length)return [];
  const target=slot==='vaes'||slot==='audioVaes'?'vae':'text_encoders';
  // Catalog labels/repo names are not file identity; only direct file basenames provide a filename hint.
  const entries=trustedEntries.filter(entry=>{
   if(entry.target!==target||entry.kind!=='file'||entry.scope!=='index'||!entry.locator.startsWith('direct:https://'))return false;
   try {const name=decodeURIComponent(new URL(entry.locator.slice(7)).pathname.split('/').pop()??'');return matching([{category:target,name,path:'',size:0,info:null}]).length>0;}catch{return false;}
  });
  return [{slot,target,patterns,entries}];
 });
}
