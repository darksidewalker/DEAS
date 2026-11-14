import type {LocalModel} from './models';
import type {TranslationParams} from './i18n';
export interface ModelCheck { integrity?:'headerChecked'|'broken'|'unchecked'; identity:'sha256'|'unverified'; compatibility:'suitable'|'blocked'|'unknown'; availability:'available'|'missing'|'unknown'; evidence:string[]; reasons:{code:string;detail?:string}[] }
export interface ModelCheckContext {family?:string;component?:readonly string[];available?:readonly string[];loaders?:readonly string[];requiredLoaders?:readonly string[];specialized?:{ready:boolean;reason?:string;evidence?:string};remote?:boolean;name?:string}
/** Pure projection of inspected facts. Advice is never native execution permission. */
export function checkModel(model?:LocalModel,context:ModelCheckContext={}):ModelCheck {
 const remote=context.remote===true||model?.path==='';
 const native=remote?undefined:model?.check;
 const result:ModelCheck={integrity:remote?'unchecked':model?.integrity?'broken':native?.integrity??'unchecked',identity:native?.identity??(!remote&&model?.info?'sha256':'unverified'),compatibility:native?.compatibility??'unknown',availability:!remote&&model?'available':'unknown',evidence:[...(native?.evidence??[])],reasons:[...(native?.reasons.filter(r=>r.code!=='unverified')??[])]};
 const reason=(code:string,detail?:string)=>{if(!result.reasons.some(r=>r.code===code&&r.detail===detail))result.reasons.push({code,...(detail?{detail}:{})});};
 const block=(code:string,detail?:string)=>{result.compatibility='blocked';reason(code,detail);};
 if(remote)reason('remote');
 if(model&&!remote){
  if(model.info)result.evidence.push('sha256');
  if(model.familyEvidence)result.evidence.push(model.familyEvidence);
  if(model.component)result.evidence.push('component');
  if(model.familyOverride)result.evidence.push('declaration');
  if(model.metadataError)block('metadata');
  if(model.integrity)block('integrity');
  if(model.familyEvidence==='conflict')block('conflict');
  if(model.misplacedAllInOne)block('component');
  if(context.family&&model.family){if(context.family!==model.family)block('family',model.family);else if(result.compatibility!=='blocked')result.compatibility='suitable';}
  if(context.component&&model.component){if(!context.component.includes(model.component))block('component',model.component);else if(result.compatibility!=='blocked')result.compatibility='suitable';}
 }
 const name=context.name??model?.name;
 if(context.available){result.availability=name&&context.available.includes(name)?'available':'missing';if(result.availability==='missing')reason('missingModel',name);}
 for(const loader of context.requiredLoaders??[]){if(!context.loaders?.includes(loader)){result.availability='missing';reason('missingLoader',loader);}}
 if(context.specialized){
  const {ready,evidence,reason:detail}=context.specialized;
  if(evidence)result.evidence.push(evidence);
  if(!ready){result.availability='missing';block('specialized',detail);}else if(result.availability!=='missing')result.availability='available';
 }
 if(result.compatibility==='unknown')reason('unverified');
 result.evidence=[...new Set(result.evidence)];
 return result;
}
export function modelCheckText(check:ModelCheck,t:(key:string,params?:TranslationParams)=>string):string {
 const status=check.compatibility==='blocked'?'blocked':check.availability==='missing'?'missing':check.compatibility;
 const reasons=check.reasons.map(({code,detail})=>{
  const translated=detail?t(detail):'';
  // Native diagnostics are not localized prose; stable reason codes carry the explanation.
  const value=code==='specialized'?translated:['missingModel','missingLoader','missingCompanion','family','component'].includes(code)?translated:'';
  return `${t(`modelCheck.reason.${code}`)}${value?`: ${value}`:''}`;
 });
 return [t(`modelCheck.status.${status}`),...reasons].join(' · ');
}
