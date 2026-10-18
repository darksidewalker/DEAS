import { useI18n } from '../../i18n/I18nProvider';
import { newSession, newStep, nextStep, type ContinuityPlan } from '../../lib/continuity';

export interface ContinuityPlannerProps { plan:ContinuityPlan; onChange:(plan:ContinuityPlan)=>void; /** Run the next planned step (or every remaining one in sequence). */ onRun:(all:boolean)=>void; running:boolean; disabled:boolean }
/** MiniMax H3 continuity planner (dock tab): planned segments with their own seconds and next action, run one or all; finished steps show the checkpoint clip they produced. */
export function ContinuityPlanner({plan,onChange,onRun,running,disabled}:ContinuityPlannerProps){
 const {t}=useI18n();
 const next=nextStep(plan);
 const step=(id:string,patch:Partial<ContinuityPlan['steps'][number]>)=>onChange({...plan,steps:plan.steps.map(s=>s.id===id?{...s,...patch}:s)});
 return <div className="wb-continuity" data-continuity>
  <div className="wb-options">
   <div className="wb-option"><span>{t('studio.run.cont.session')}</span><span className="wb-option-row"><code>{plan.session}</code><button type="button" className="wb-dock-action" disabled={running} onClick={()=>onChange({...defaultPlanKeep(plan),session:newSession()})}>{t('studio.run.cont.newSession')}</button></span><small>{t('studio.run.cont.sessionHint')}</small></div>
   <label className="wb-option"><span>{t('studio.run.cont.output')}</span><select value={plan.outputMode} disabled={running} onChange={e=>onChange({...plan,outputMode:e.target.value as ContinuityPlan['outputMode']})}><option value="full">{t('studio.run.cont.output.full')}</option><option value="segment">{t('studio.run.cont.output.segment')}</option></select></label>
  </div>
  <ol className="wb-cont-steps">{plan.steps.map((s,i)=><li key={s.id} data-step={i} data-done={!!s.clipId}>
   <span className="wb-cont-index">{i+1}</span>
   <label><span>{t('studio.run.cont.seconds')}</span><input type="number" value={s.seconds} min={0.5} max={15} step={0.5} disabled={running||!!s.clipId} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n)&&n>0&&n<=15)step(s.id,{seconds:n});}}/></label>
   <label className="wb-cont-action"><span>{t(i===0?'studio.run.cont.firstTake':'studio.run.cont.action')}</span><textarea value={s.action} maxLength={16384} disabled={running||!!s.clipId||i===0} placeholder={t(i===0?'studio.run.cont.firstTakeHint':'studio.run.cont.actionHint')} onChange={e=>step(s.id,{action:e.target.value})}/></label>
   <span className="wb-cont-state">{s.clipId?<>✓ <code>{s.clipId.slice(0,12)}</code></>:running&&next?.index===i?t('studio.run.running'):t('studio.run.cont.planned')}</span>
   <button type="button" aria-label={t('studio.run.cont.remove')} disabled={running} onClick={()=>onChange({...plan,steps:plan.steps.filter(x=>x.id!==s.id)})}>✕</button>
  </li>)}</ol>
  <div className="wb-cont-actions">
   <button type="button" className="wb-dock-action" disabled={running||plan.steps.length>=50} onClick={()=>onChange({...plan,steps:[...plan.steps,newStep()]})}>{t('studio.run.cont.add')}</button>
   <button type="button" className="wb-dock-action" data-cont-run disabled={disabled||running||!next} onClick={()=>onRun(false)}>{t('studio.run.cont.runNext')}</button>
   <button type="button" className="wb-dock-action" data-cont-run-all disabled={disabled||running||!next} onClick={()=>onRun(true)}>{t('studio.run.cont.runAll')}</button>
   <button type="button" className="wb-dock-action" disabled={running||!plan.steps.some(s=>s.clipId)} onClick={()=>onChange({...plan,steps:plan.steps.map(s=>({id:s.id,seconds:s.seconds,action:s.action}))})}>{t('studio.run.cont.reset')}</button>
  </div>
  <p className="media-help">{t('studio.run.cont.hint')}</p>
 </div>;
}
/** A new session keeps the authored steps but forgets their clips (they belong to the old session). */
const defaultPlanKeep=(plan:ContinuityPlan):ContinuityPlan=>({...plan,steps:plan.steps.map(s=>({id:s.id,seconds:s.seconds,action:s.action}))});
