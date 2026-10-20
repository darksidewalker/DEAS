import {useId,useRef,useState} from 'react';
import {useI18n} from '../../i18n/I18nProvider';
import {StartupPanel} from '../../features/settings/StartupPanel';
import {LlmPanel} from '../../features/llm/LlmPanel';
import {AuthPanel} from '../../features/downloads/DownloadPluginPanel';

const panels=['startup','llm','auth'] as const;
type Panel=typeof panels[number];
/** Visit lazily, then retain drafts while choosing another panel or top-level tab. */
export function BackendPanels({root,modelsDir,onRestart,onAuthChange}:{root:string;modelsDir?:string;onRestart:()=>void;onAuthChange:()=>void}){
 const {t}=useI18n(),id=useId();
 const [active,setActive]=useState<Panel>(root?'startup':'auth');
 const selected=root?active:'auth',visited=useRef(new Set<Panel>());visited.current.add(selected);
 const labels={startup:t('startup.title'),llm:t('llm.title'),auth:t('downloads.auth')};
 return <div className="backend-panels">
  <div className="backend-panel-menu" role="tablist" aria-label={t('setup.backendPanels')} aria-orientation="vertical" onKeyDown={e=>{
   if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();
   const enabled=panels.filter(p=>root||p==='auth'),index=enabled.indexOf(selected);
   const next=e.key==='Home'?enabled[0]:e.key==='End'?enabled[enabled.length-1]:enabled[(index+(e.key==='ArrowDown'?1:enabled.length-1))%enabled.length];
   setActive(next);e.currentTarget.querySelector<HTMLButtonElement>(`[data-backend-panel="${next}"]`)?.focus();
  }}>
   {panels.map(panel=><button key={panel} type="button" role="tab" className="aio-tab backend-menu-item" data-backend-panel={panel} id={`${id}-tab-${panel}`} aria-controls={`${id}-pane-${panel}`} aria-selected={selected===panel} tabIndex={selected===panel?0:-1} disabled={!root&&panel!=='auth'} title={!root&&panel!=='auth'?t('setup.backendPanels.requiresInstall'):undefined} onClick={()=>setActive(panel)}>{labels[panel]}</button>)}
  </div>
  <div className="backend-panel-content">
   {panels.map(panel=><div key={panel} className="aio-detail backend-pane" role="tabpanel" tabIndex={0} id={`${id}-pane-${panel}`} aria-labelledby={`${id}-tab-${panel}`} hidden={selected!==panel}>
    {visited.current.has(panel)&&<>
     {panel==='startup'&&root&&<StartupPanel key={root} root={root} onRestart={onRestart}/>}
     {panel==='llm'&&root&&<LlmPanel key={modelsDir??''} root={root}/>}
     {panel==='auth'&&<div className="backend-auth"><h3>{labels.auth}</h3><AuthPanel embedded onChange={onAuthChange}/></div>}
    </>}
   </div>)}
  </div>
 </div>;
}
