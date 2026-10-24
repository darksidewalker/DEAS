import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useI18n } from '../../i18n/I18nProvider';
import { closeProject, createProject, exportProjectPackage, importProjectPackage, importProjectImage, openProject, saveProject } from '../../lib/projects';
import type { ImageDraft, ProjectSnapshot } from '../../lib/projects';
import './projects.css';

const draftKeyOf = (value: ImageDraft) => JSON.stringify(value, Object.keys(value).sort());

export interface ProjectBarProps { draft: ImageDraft; busy: boolean; onRestore: (project: ProjectSnapshot | null) => void }
export function ProjectBar({ draft, busy, onRestore }: ProjectBarProps) {
 const { t } = useI18n();
 const [slot, setSlot] = useState<HTMLElement | null>(null);
 const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
 const menu = useRef<HTMLDetailsElement>(null);
 const placeMenu = () => {
  const details = menu.current, actions = details?.querySelector<HTMLElement>('.project-menu-actions');
  if (!details?.open || !actions) return;
  const anchor = details.querySelector('summary')!.getBoundingClientRect();
  const { width, height } = actions.getBoundingClientRect();
  const top = anchor.bottom + height + 8 <= window.innerHeight ? anchor.bottom + 4 : Math.max(8, anchor.top - height - 4);
  actions.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
  actions.style.top = `${top}px`;
 };
 useLayoutEffect(() => { setSlot(document.getElementById('project-actions-slot')); setStatusSlot(document.getElementById('project-status-slot')); }, []);
 useEffect(() => {
  const dismiss = (event: PointerEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false; };
  document.addEventListener('pointerdown', dismiss);
  window.addEventListener('resize', placeMenu);
  window.addEventListener('scroll', placeMenu, true);
  return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', placeMenu); window.removeEventListener('scroll', placeMenu, true); };
 }, []);
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
  const guard=(event:Event)=>{if(pendingClose.current||busy){event.preventDefault();setCloseBlocked(true);}};
  window.addEventListener('deas:before-update-restart',guard);
  return()=>window.removeEventListener('deas:before-update-restart',guard);
 },[busy]);
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
 const importPackage = () => {
  if (locked) return;
  void run(async () => { const opened = await importProjectPackage(t('projects.packageImport')); if (opened) restore(opened); });
 };
 const exportPackage = () => {
  if (!project || locked) return;
  void run(async () => { await exportProjectPackage(t('projects.packageExport'), project.id, project.revision); });
 };
 const retry = () => {
  if (!project || busy || working || !isTauri()) return;
  void run(() => persist(project, draft), 'save');
 };
 const status = failed ? 'projects.error' : working === 'save' ? 'projects.saving' : working || hydrating ? 'projects.working' : dirty ? 'projects.unsaved' : project ? 'projects.saved' : 'projects.none';
 const controls = <section className="project-bar" aria-label={t('projects.menu')}>
 <details ref={menu} className="project-menu" onToggle={placeMenu} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
 <summary className="wb-dock-action" aria-label={t('projects.menu')} title={t('projects.menu')}>▾</summary>
 <div className="project-menu-actions">
 <button className="wb-dock-action" data-project-new type="button" disabled={locked} onClick={create}>{t('projects.saveAs')}</button>
 <button className="wb-dock-action" data-project-open type="button" disabled={locked} onClick={open}>{t('projects.open')}</button>
 <button className="wb-dock-action" data-project-package-import type="button" disabled={locked} onClick={importPackage}>{t('projects.packageImport')}</button>
 <button className="wb-dock-action" data-project-package-export type="button" disabled={!project || locked} onClick={exportPackage}>{t('projects.packageExport')}</button>
 <button className="wb-dock-action" data-project-close type="button" disabled={!project || locked} onClick={() => close()}>{t('projects.close')}</button>
 <button className="wb-dock-action" data-project-import type="button" disabled={!project || locked} onClick={importImage}>{t('projects.import')}</button>
 <small>{t('projects.limitation')}</small>
 </div></details></section>;
 const statusControls = <div className="project-status">
 {project && <span className="project-bar-path" title={project.root}>{project.root}</span>}
 <span data-project-status role="status">{t(status)}</span>
 {failed && <small role="alert">{t('projects.error')}</small>}
 {failed && project && <button className="wb-dock-action" type="button" disabled={busy || !!working || !isTauri()} onClick={retry}>{t('projects.retry')}</button>}
 {failed && project && <button className="wb-dock-action" type="button" disabled={busy || !!working || !isTauri()} onClick={() => close(true)}>{t('projects.closeUnsaved')}</button>}
 {closeBlocked&&<small role="alert">{t('projects.closeBlocked')}</small>}
 {closeGuardFailed&&closeScope&&<small role="alert">{t('projects.closeGuardFailed')}</small>}
 </div>;
 return <>{slot ? createPortal(controls, slot) : controls}{statusSlot ? createPortal(statusControls, statusSlot) : statusControls}</>;
}
