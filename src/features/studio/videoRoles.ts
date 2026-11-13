import type { MediaItem } from '../../lib/media';

export const videoRoles=['first','last','both','reference','source'] as const;
export type VideoRole=typeof videoRoles[number];
/** Declared by the family recipe, not inferred from its name. */
export interface VideoRoles { roles:VideoRole[]; referenceMedia:('image'|'video'|'audio')[]; mixReferences:boolean; lastAlone:boolean; maxReferences:number }
export interface VideoRoleState { first:boolean; last:boolean; source:boolean; references:number }
export function videoRoleBlock(cap:VideoRoles|undefined,role:VideoRole,item:MediaItem|null,state:VideoRoleState):string {
 if(!cap?.roles.includes(role))return 'studio.run.pipe.noRecipe';
 if(!cap.mixReferences&&(role==='reference'?(state.first||state.last):(role!=='source'&&state.references>0)))return 'studio.run.video.roles.mixing';
 if(role==='reference'&&state.references>=cap.maxReferences)return 'studio.run.video.refFull';
 if(!item?.path)return 'studio.run.video.roles.pick';
 if(role==='source'?item.media!=='video':role!=='reference'&&item.media!=='image')return 'studio.run.video.roles.media';
 return '';
}
/** Called on explicit role edits only: unresolved legacy/history modes keep their missing-input gates. */
export function videoRolePipeline(state:VideoRoleState):'t2v'|'i2v'|'v2v'|'ref2v' {
 return state.source?'v2v':state.references?'ref2v':state.first||state.last?'i2v':'t2v';
}
