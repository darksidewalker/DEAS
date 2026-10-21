import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useI18n} from '../../i18n/I18nProvider';
import {cancelForge,findPeople,forgeError,labelCharacters,readPeopleBoxes,type H3Reference,type PeopleBox} from '../../lib/forge';
import {ModelSelect,useForgeModels} from '../forge/ForgeButton';

/** Explicit vision operation; candidates never overwrite manual boxes until Apply. */
export function PeopleDetector({endpoint,root,reference,onApply}:{endpoint:string;root?:string;reference:H3Reference;onApply:(boxes:PeopleBox[])=>void}){
 const {t}=useI18n();const forge=useForgeModels(endpoint,root);
 const fit=JSON.stringify([endpoint,root,reference,forge.model,forge.rev]);const latest=useRef(fit);latest.current=fit;
 const current=useRef<{id:string;fit:string;endpoint:string;root:string;pending:boolean;cancelled:boolean}|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[cancelled,setCancelled]=useState(false);
 const [found,setFound]=useState<{fit:string;boxes:PeopleBox[]}|null>(null);
 useEffect(()=>{if(endpoint&&reference.path)forge.load();},[endpoint,root,reference.path,forge.rev]); // eslint-disable-line react-hooks/exhaustive-deps
 // Invalidate the old request before the new model/reference controls become interactive.
 useLayoutEffect(()=>{
  setBusy(false);setFound(null);setError('');setCancelled(false);
  return()=>{const c=current.current;current.current=null;if(c?.pending&&!c.cancelled){c.cancelled=true;void cancelForge(c.endpoint,c.root,c.id).catch(()=>{});}};
 },[fit]);
 const run=async()=>{
  const c:NonNullable<typeof current.current>={id:crypto.randomUUID(),fit,endpoint,root:root!,pending:true,cancelled:false};current.current=c;
  setBusy(true);setFound(null);setError('');setCancelled(false);
  try{
   const result=await findPeople(endpoint,root!,{model:forge.model,path:reference.path!,request_id:c.id});
   if(current.current!==c||c.cancelled||latest.current!==c.fit)return;
   // The Director retains existing identities left-to-right when the detected count matches.
   const had=reference.boxes?.length?[...reference.boxes].sort((a,b)=>a.box[0]+a.box[2]-b.box[0]-b.box[2]).map(b=>b.n):reference.who??labelCharacters(reference.easy_role).map(Number);
   const boxes=readPeopleBoxes(result.people.map((p,i)=>({n:had.length===result.people.length?had[i]:i+1,box:p.box})));
   if(!boxes)throw new Error('Invalid people detection response');
   setFound({fit:c.fit,boxes});
  }catch(e){if(current.current===c&&!c.cancelled&&latest.current===c.fit){const text=e instanceof Error?e.message:String(e);setError(text.includes('no_vision')?'forge.detectVision':text.startsWith('409 ')||text.includes('(busy)')?'forge.detectBusy':forgeError(e));}}
  finally{c.pending=false;if(current.current===c&&!c.cancelled)setBusy(false);}
 };
 const cancel=()=>{const c=current.current;if(!c||!c.pending)return;c.cancelled=true;setBusy(false);setFound(null);setCancelled(true);
  void cancelForge(c.endpoint,c.root,c.id).catch(e=>{if(current.current===c&&latest.current===c.fit)setError(forgeError(e));});};
 const ready=!!endpoint&&!!root&&!!reference.path;
 const candidates=found?.fit===fit?found:null;
 return <div className="people-detector" data-people-detector>
  <p className="media-help">{t(ready?'forge.detectHelp':'forge.detectInput')}</p>
  {ready&&<ModelSelect forge={forge}/>}
  {busy?<button type="button" onClick={cancel}>{t('forge.cancel')}</button>:<button type="button" disabled={!ready||!forge.model} onClick={()=>void run()}>{t('forge.detect')}</button>}
  {busy&&<span role="status">{t('forge.detecting')}</span>}
  {cancelled&&<span role="status">{t('forge.detectCancelled')}</span>}
  {error&&<p className="error-message" role="alert">{t(error)}</p>}
  {candidates&&<><span role="status">{t(candidates.boxes.length?'forge.detectCount':'forge.detectNone',{count:String(candidates.boxes.length)})}</span>
   {candidates.boxes.length>0&&<button type="button" onClick={()=>{if(latest.current===candidates.fit)onApply(candidates.boxes);}}>{t('forge.detectApply')}</button>}</>}
 </div>;
}
