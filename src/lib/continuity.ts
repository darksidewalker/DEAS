import type { H3Clip, H3ImportedVideo } from './jobs';
import { isH3OverlapFrames, type H3Continuity, type H3OverlapFrames } from './videoIntent.ts';
/** DEAS-owned MiniMax H3 continuity plan: step 0 is a captured first take, later steps extend the clip the previous step produced. */
export interface ContinuityStep { id:string; seconds:number; action:string; clipId?:string; jobId?:string }
export interface ContinuityPlan { session:string; outputMode:'full'|'segment'; overlapFrames?:H3OverlapFrames; source?:{clipId:string;endpoint:string;kind?:'video'}; steps:ContinuityStep[] }
const idOk=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(s);
export const isContinuitySession=(s:unknown):s is string=>idOk(s)&&s!=='_imports';
export const newSession=()=>`deas-${crypto.randomUUID().slice(0,8)}`;
export const newStep=(seconds=5):ContinuityStep=>({id:crypto.randomUUID(),seconds,action:''});
export const defaultPlan=():ContinuityPlan=>({session:newSession(),outputMode:'full',steps:[]});
export const isContinuityPlan=(v:unknown):v is ContinuityPlan=>{
 const p=v as ContinuityPlan;
 return !!p&&typeof p==='object'&&isContinuitySession(p.session)&&(p.outputMode==='full'||p.outputMode==='segment')&&Array.isArray(p.steps)&&p.steps.length<=50
  &&(p.overlapFrames===undefined||isH3OverlapFrames(p.overlapFrames))
  &&(p.source===undefined||!!p.source&&typeof p.source==='object'&&idOk(p.source.clipId)&&(p.source.kind===undefined||p.source.kind==='video'&&/^[a-f0-9]{64}$/.test(p.source.clipId))&&typeof p.source.endpoint==='string'&&p.source.endpoint.length>0&&p.source.endpoint.length<=2048)
  &&p.steps.every(s=>!!s&&typeof s.id==='string'&&typeof s.seconds==='number'&&s.seconds>0&&s.seconds<=15&&typeof s.action==='string'&&(s.clipId===undefined||idOk(s.clipId))&&(s.jobId===undefined||typeof s.jobId==='string'));
};
export const continuitySource=(plan:ContinuityPlan,index:number):string|undefined=>index>0?plan.steps[index-1]?.clipId:plan.source?.clipId;
/** The first step without a clip, with the intent's continuity block: step 0 captures a new take; later steps pin the previous clip and send their action. Null when done or when the previous step has no clip yet. */
export function nextStep(plan:ContinuityPlan):{index:number;continuity:H3Continuity}|null{
 const index=plan.steps.findIndex(s=>!s.clipId);
 if(index<0)return null;
 const sourceId=continuitySource(plan,index);
 if(index>0&&!sourceId)return null;
 return {index,continuity:{session:plan.session,sourceId:sourceId??'',...(index===0&&plan.source?.kind==='video'?{sourceKind:'video' as const}:{}),capture:true,action:plan.steps[index].action,outputMode:plan.outputMode,...(sourceId&&plan.overlapFrames!==undefined?{overlapFrames:plan.overlapFrames}:{})}};
}
/** After a step's job succeeded: the newest clip whose parent is the previous step's clip (roots for step 0). */
export function resolveClip(clips:readonly H3Clip[],previous:string|undefined,imported?:H3ImportedVideo):string|undefined{
 if(imported){
  // shortcut: parent must be in the bounded session listing; add targeted lookup if cached parents are omitted.
  const parents=clips.filter(c=>c.importedVideo?.sourceId===imported.sourceId&&c.importedVideo.width===imported.width&&c.importedVideo.height===imported.height&&c.importedVideo.modeFamily===imported.modeFamily);
  if(parents.length!==1)return undefined;
  previous=parents[0].clipId;
 }
 return clips.filter(c=>(c.parent??'')===(previous??'')).sort((a,b)=>b.completed-a.completed)[0]?.clipId;
}
