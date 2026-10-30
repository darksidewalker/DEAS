import { useEffect, useId, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { newSession, newStep, nextStep, continuitySource, isContinuitySession, type ContinuityPlan } from '../../lib/continuity';
import { ForgeButton, type H3Context } from '../forge/ForgeButton';
import { H3 } from '../../lib/forge';
import { ContinuityVideoSource } from './ContinuityVideoSource';
import { ContinuitySources } from './ContinuitySources';
import { h3OverlapFrames, isH3OverlapFrames } from '../../lib/videoIntent';

export interface ContinuityPlannerProps { endpoint?:string; root?:string; forgeContext?:H3Context; allowReferences?:boolean; plan:ContinuityPlan; onChange:(plan:ContinuityPlan)=>void; /** Run the next planned step (or every remaining one in sequence). */ onRun:(all:boolean)=>void; running:boolean; disabled:boolean }
/** MiniMax H3 continuity planner: planned segments with their own seconds and next action, run one or all; finished steps show the checkpoint clip they produced. */
export function ContinuityPlanner({endpoint,root,forgeContext,allowReferences=false,plan,onChange,onRun,running,disabled}:ContinuityPlannerProps){
 const {t}=useI18n();
 const [sessionDraft,setSessionDraft]=useState(plan.session);const sessionHintId=useId();
 useEffect(()=>setSessionDraft(plan.session),[plan.session]);
 const validSession=isContinuitySession(sessionDraft);
 const [forging,setForging]=useState(false);const locked=running||forging;
 const enabled=plan.enabled===true;
 const useReferences=allowReferences&&plan.useReferences===true;
 const sourceChanged=!!plan.source&&plan.source.endpoint!==endpoint;
 const next=nextStep(plan);
 const step=(id:string,patch:Partial<ContinuityPlan['steps'][number]>)=>onChange({...plan,steps:plan.steps.map(s=>s.id===id?{...s,...patch}:s)});
 return <div className="wb-continuity" data-continuity>
  <div className="wb-options">
   {/* Locked while a step runs: switching off never cancels or alters a submitted job. */}
   <label className="wb-option"><span className="wb-option-row"><input type="checkbox" data-cont-enabled aria-label={t('studio.run.cont.enabled')} checked={enabled} disabled={locked} onChange={e=>{if(!locked)onChange({...plan,enabled:e.target.checked});}}/>{t('studio.run.cont.enabled')}</span><small>{t('studio.run.cont.enabledHint')}</small></label>
   <div className="wb-option"><span>{t('studio.run.cont.session')}</span><span className="wb-option-row"><code>{plan.session}</code><button type="button" className="wb-dock-action" disabled={locked} onClick={()=>onChange({...defaultPlanKeep(plan),session:newSession()})}>{t('studio.run.cont.newSession')}</button></span>
    <form data-cont-session-form onSubmit={e=>{e.preventDefault();if(!locked&&validSession&&sessionDraft!==plan.session)onChange({...defaultPlanKeep(plan),session:sessionDraft});}}>
     <label><span>{t('studio.run.cont.sessionName')}</span><input data-cont-session aria-label={t('studio.run.cont.sessionName')} aria-describedby={sessionHintId} aria-invalid={!validSession} maxLength={80} value={sessionDraft} disabled={locked} onChange={e=>setSessionDraft(e.target.value)}/></label>
     <button data-cont-session-apply type="submit" disabled={locked||!validSession||sessionDraft===plan.session}>{t('studio.run.cont.useSession')}</button>
    </form>
    <small id={sessionHintId}>{t(validSession?'studio.run.cont.sessionNameHint':'studio.run.cont.invalidSession')}</small><small>{t('studio.run.cont.sessionHint')}</small>
   </div>
   <label className="wb-option"><span>{t('studio.run.cont.overlap')}</span><select data-cont-overlap aria-label={t('studio.run.cont.overlap')} title={t('studio.run.cont.overlapHint')} disabled={locked} value={plan.overlapFrames??22} onChange={e=>{const value=Number(e.target.value);if(isH3OverlapFrames(value))onChange({...plan,overlapFrames:value});}}>{h3OverlapFrames.map(n=><option key={n} value={n}>{n}</option>)}</select><small>{t('studio.run.cont.overlapHint')}</small></label>
   {allowReferences&&<label className="wb-option"><span className="wb-option-row"><input type="checkbox" data-cont-references aria-label={t('studio.run.cont.useReferences')} checked={useReferences} disabled={locked} onChange={e=>{if(!locked)onChange({...plan,useReferences:e.target.checked});}}/>{t('studio.run.cont.useReferences')}</span><small>{t('studio.run.cont.useReferencesHint')}</small></label>}
   <label className="wb-option"><span>{t('studio.run.cont.output')}</span><select value={plan.outputMode} disabled={locked} onChange={e=>onChange({...plan,outputMode:e.target.value as ContinuityPlan['outputMode']})}><option value="full">{t('studio.run.cont.output.full')}</option><option value="segment">{t('studio.run.cont.output.segment')}</option></select></label>
  </div>
  <ContinuitySources endpoint={endpoint} session={plan.session} sourceId={plan.source?.kind==='video'?undefined:plan.source?.clipId} running={locked} onSelect={clipId=>{if(locked)return;const next=defaultPlanKeep(plan);if(clipId&&endpoint)next.source={clipId,endpoint};onChange(next);}}/>
  <ContinuityVideoSource endpoint={endpoint} session={plan.session} running={locked} onSelect={clipId=>{if(locked||!endpoint||plan.source?.kind==='video'&&plan.source.clipId===clipId&&plan.source.endpoint===endpoint)return;const next=defaultPlanKeep(plan);next.source={clipId,endpoint,kind:'video'};onChange(next);}}/>
  {plan.source?.kind==='video'&&<p className="media-help" data-cont-selected-video>{t('studio.run.cont.videoSource')}: <code>{plan.source.clipId}</code> <button type="button" disabled={locked} onClick={()=>{if(!locked)onChange(defaultPlanKeep(plan));}}>{t('studio.run.cont.clearVideoSource')}</button></p>}
  {sourceChanged&&<p role="alert" className="media-help">{t('studio.run.cont.sourceEndpointChanged')}</p>}
  <ol className="wb-cont-steps">{plan.steps.map((s,i)=><li key={s.id} data-step={i} data-done={!!s.clipId}>
   <span className="wb-cont-index">{i+1}</span>
   <label><span>{t('studio.run.cont.seconds')}</span><input type="number" value={s.seconds} min={0.5} max={15} step={0.5} disabled={locked||!!s.clipId} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n)&&n>0&&n<=15)step(s.id,{seconds:n});}}/></label>
   <div className="wb-cont-action"><label><span>{t(i===0&&!plan.source?'studio.run.cont.firstTake':'studio.run.cont.action')}</span><textarea value={s.action} maxLength={16384} disabled={locked||!!s.clipId||(i===0&&!plan.source)} placeholder={t(i===0&&!plan.source?'studio.run.cont.firstTakeHint':'studio.run.cont.actionHint')} onChange={e=>step(s.id,{action:e.target.value})}/></label>
    {!running&&!sourceChanged&&i===next?.index&&continuitySource(plan,i)&&endpoint&&root&&forgeContext&&<ForgeButton endpoint={endpoint} root={root} dialect={H3} value={s.action} onApply={action=>step(s.id,{action})} onBusyChange={setForging} h3={{...forgeContext,duration:s.seconds,references:useReferences?forgeContext.references:[],easy:false,continuity:{source_kind:i===0&&plan.source?.kind==='video'?'video':'checkpoint',session:plan.session,clip_id:continuitySource(plan,i)!,current_prompt:s.action,use_references:useReferences,...(plan.overlapFrames===undefined?{}:{overlap_frames:plan.overlapFrames})}}}/>}
   </div>
   <span className="wb-cont-state">{s.clipId?<>✓ <code>{s.clipId.slice(0,12)}</code></>:running&&next?.index===i?t('studio.run.running'):t('studio.run.cont.planned')}</span>
   <button type="button" aria-label={t('studio.run.cont.remove')} disabled={locked} onClick={()=>onChange({...plan,steps:plan.steps.filter(x=>x.id!==s.id)})}>✕</button>
  </li>)}</ol>
  <div className="wb-cont-actions">
   <button type="button" className="wb-dock-action" disabled={locked||plan.steps.length>=50} onClick={()=>onChange({...plan,steps:[...plan.steps,newStep()]})}>{t('studio.run.cont.add')}</button>
   <button type="button" className="wb-dock-action" data-cont-run disabled={!enabled||disabled||locked||sourceChanged||!next} onClick={()=>onRun(false)}>{t('studio.run.cont.runNext')}</button>
   <button type="button" className="wb-dock-action" data-cont-run-all disabled={!enabled||disabled||locked||sourceChanged||!next} onClick={()=>onRun(true)}>{t('studio.run.cont.runAll')}</button>
   <button type="button" className="wb-dock-action" disabled={locked||!plan.steps.some(s=>s.clipId)} onClick={()=>onChange({...plan,steps:plan.steps.map(s=>({id:s.id,seconds:s.seconds,action:s.action}))})}>{t('studio.run.cont.reset')}</button>
  </div>
  <p className="media-help">{t('studio.run.cont.hint')}</p>
 </div>;
}
/** A new session keeps the authored steps but forgets their clips (they belong to the old session). */
const defaultPlanKeep=(plan:ContinuityPlan):ContinuityPlan=>{
 const next={...plan,steps:plan.steps.map(s=>({id:s.id,seconds:s.seconds,action:s.action}))};delete next.source;return next;
};
