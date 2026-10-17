import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
interface RepoStars { count: number; starred: boolean | null }
/** GitHub repo link and star button; starring needs the saved GitHub token, otherwise the repo page opens. */
export function RepoLinks({ canStar }: { canStar: boolean }) {
 const {t}=useI18n();const native=isTauri();
 const [stars,setStars]=useState<RepoStars|null>(null);const [busy,setBusy]=useState(false);
 useEffect(()=>{if(!native)return;let alive=true;invoke<RepoStars>('native_repo_stars').then(s=>{if(alive)setStars(s);},()=>{});return()=>{alive=false;};},[native,canStar]);
 if(!native)return null;
 const open=()=>void invoke('native_open_repo').catch(()=>{});
 const star=async()=>{if(!canStar){open();return;}setBusy(true);try{setStars(await invoke<RepoStars>('native_repo_star'));}catch{open();}finally{setBusy(false);}};
 const label=t(stars?.starred?'setup.repo.starred':'setup.repo.star');
 return <span className="repo-links">
  <button type="button" className="repo-button" aria-label={t('setup.repo.open')} title={t('setup.repo.open')} onClick={open}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg></button>
  <button type="button" className={`repo-button${stars?.starred?' is-starred':''}`} aria-label={label} title={label} disabled={busy||!!stars?.starred} onClick={()=>void star()}><span aria-hidden="true">{stars?.starred?'★':'☆'}</span>{stars&&<span>{stars.count}</span>}</button>
 </span>;
}
