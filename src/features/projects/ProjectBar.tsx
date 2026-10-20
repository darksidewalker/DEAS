import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useI18n } from '../../i18n/I18nProvider';
import { closeProject, createProject, importProjectImage, openProject, saveProject } from '../../lib/projects';
import type { ImageDraft, ProjectSnapshot } from '../../lib/projects';
import './projects.css';

const draftKeyOf = (value: ImageDraft) => JSON.stringify(value, Object.keys(value).sort());

export interface ProjectBarProps { draft: ImageDraft; busy: boolean; onRestore: (project: ProjectSnapshot | null) => void }
export function ProjectBar({ draft, busy, onRestore }: ProjectBarProps) {
 const { t } = useI18n();
 const [project, setProject] = useState<ProjectSnapshot | null>(null);
 const [working, setWorking] = useState<'operation' | 'save' | null>(null);
 const [failed, setFailed] = useState(false);
 const [hydrating, setHydrating] = useState<string | null>(null);
 const inFlight = useRef(false);
 const mounted = useRef(true);
 useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
 const initialRestore = useRef(false);
 const draftKey = draftKeyOf(draft);
 const latestDraftKey = useRef(draftKey);
 useLayoutEffect(() => { latestDraftKey.current = draftKey; }, [draftKey]);
 useEffect(() => { if (hydrating === draftKey) setHydrating(null); }, [hydrating, draftKey]);
 const dirty = !!project && !hydrating && draftKeyOf(project.draft) !== draftKey;
 const locked = busy || !!working || !!hydrating || dirty || !isTauri();
 const [closeBlocked,setCloseBlocked]=useState(false);
 const [closeGuardFailed,setCloseGuardFailed]=useState(false);
 const pendingClose=useRef(false);
 const closeScope=!!project||!!working;
 useLayoutEffect(()=>{pendingClose.current=dirty||!!working||!!hydrating;},[dirty,working,hydrating]);
 useEffect(()=>{if(!dirty&&!working&&!hydrating)setCloseBlocked(false);},[dirty,working,hydrating]);
 useEffect(()=>{
  if(!closeScope||!isTauri())return;
  let active=true;let unlisten:(()=>void)|undefined;
  setCloseGuardFailed(false);
  const unavailable=()=>{if(active){setCloseGuardFailed(true);void invoke('native_project_close_notice',{reason:'unavailable'}).catch(()=>{});}};
  try{
   void getCurrentWindow().onCloseRequested(event=>{
    if(active&&pendingClose.current){event.preventDefault();setCloseBlocked(true);void invoke('native_project_close_notice',{reason:'blocked'}).catch(()=>{});}
   }).then(stop=>{if(active)unlisten=stop;else stop();},unavailable);
  }catch{unavailable();}
  return()=>{active=false;unlisten?.();};
 },[closeScope]);
 const run = async (task: () => Promise<void>, kind: 'operation' | 'save' = 'operation') => {
  if (inFlight.current) return;
  inFlight.current = true; setWorking(kind); setFailed(false);
  try { await task(); } catch { if (mounted.current) setFailed(true); }
  finally { inFlight.current = false; if (mounted.current) setWorking(null); }
 };
 const restore = (value: ProjectSnapshot) => {
  if (!mounted.current) return;
  setProject(value); setHydrating(draftKeyOf(value.draft)); onRestore(value);
 };
 const persist = async (value: ProjectSnapshot, captured: ImageDraft) => {
  setWorking('save');
  const saved = await saveProject(value.id, value.revision, captured);
  if (!mounted.current) return;
  setProject(saved);
  if (initialRestore.current && latestDraftKey.current === draftKeyOf(saved.draft)) { initialRestore.current = false; restore(saved); }
 };
 useEffect(() => {
  if (!project || !dirty || busy || working || failed || !isTauri()) return;
  const timer = setTimeout(() => {
   void run(() => persist(project, JSON.parse(draftKey) as ImageDraft), 'save');
  }, 500);
  return () => clearTimeout(timer);
 }, [project, dirty, draftKey, busy, working, failed]);
 const create = () => {
  if (locked) return;
  void run(async () => {
   const created = await createProject(t('projects.new'));
   if (mounted.current && created) {
    setProject(created); initialRestore.current = true;
    await persist(created, draft);
   }
  });
 };
 const open = () => {
  if (locked) return;
  void run(async () => { const opened = await openProject(t('projects.open')); if (opened) restore(opened); });
 };
 const close = (withoutSaving = false) => {
  if (!project || busy || working || !isTauri() || (locked && !(withoutSaving && failed))) return;
  void run(async () => { await closeProject(project.id); if (mounted.current) { initialRestore.current = false; setHydrating(null); setProject(null); onRestore(null); } });
 };
 const importImage = () => {
  if (!project || locked) return;
  void run(async () => {
   const imported = await importProjectImage(t('projects.import'), project.id, project.revision);
   if (imported) restore(imported);
  });
 };
 const retry = () => {
  if (!project || busy || working || !isTauri()) return;
  void run(() => persist(project, draft), 'save');
 };
 const status = failed ? 'projects.error' : working === 'save' ? 'projects.saving' : working || hydrating ? 'projects.working' : dirty ? 'projects.unsaved' : project ? 'projects.saved' : 'projects.none';
 return <section className="project-bar"><button className="wb-dock-action" data-project-new type="button" disabled={locked} onClick={create}>{t('projects.new')}</button>
 <button className="wb-dock-action" data-project-open type="button" disabled={locked} onClick={open}>{t('projects.open')}</button>
 <button className="wb-dock-action" data-project-close type="button" disabled={!project || locked} onClick={() => close()}>{t('projects.close')}</button>
 <button className="wb-dock-action" data-project-import type="button" disabled={!project || locked} onClick={importImage}>{t('projects.import')}</button>
 {project && <span className="project-bar-path" title={project.root}>{project.root}</span>}
 <span data-project-status role="status">{t(status)}</span>
 {failed && <small role="alert">{t('projects.error')}</small>}
 {failed && project && <button className="wb-dock-action" type="button" disabled={busy || !!working || !isTauri()} onClick={retry}>{t('projects.retry')}</button>}
 {failed && project && <button className="wb-dock-action" type="button" disabled={busy || !!working || !isTauri()} onClick={() => close(true)}>{t('projects.closeUnsaved')}</button>}
 {closeBlocked&&<small role="alert">{t('projects.closeBlocked')}</small>}
 {closeGuardFailed&&closeScope&&<small role="alert">{t('projects.closeGuardFailed')}</small>}
 <small>{t('projects.limitation')}</small></section>;
}
