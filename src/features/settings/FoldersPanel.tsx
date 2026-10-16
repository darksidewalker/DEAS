import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { readFolders, writeFolders, type Folders } from '../../lib/settings';
import './settings.css';
const keys=['models','input','output'] as const;
/** Per-environment folders; saved beside the environment and honoured by the owned backend at start. */
export function FoldersPanel({root,onChange}:{root?:string;onChange?:(folders:Folders)=>void}) {
 const {t}=useI18n();const native=isTauri();
 const [folders,setFolders]=useState<Folders>({});const [saved,setSaved]=useState<Folders>({});const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 useEffect(()=>{if(!native||!root)return;let alive=true;readFolders(root).then(f=>{if(alive){setFolders(f);setSaved(f);onChange?.(f);}},e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[native,root]); // eslint-disable-line react-hooks/exhaustive-deps
 const pick=async(key:typeof keys[number])=>{try{const dir=await invoke<string|null>('native_pick_directory',{title:t(`settings.${key}`)});if(dir)setFolders(f=>({...f,[key]:dir}));}catch(e){setError(String(e));}};
 const save=async()=>{if(!root)return;setBusy(true);setError('');try{const next=await writeFolders(root,folders);setFolders(next);setSaved(next);onChange?.(next);}catch(e){setError(String(e));}finally{setBusy(false);}};
 const dirty=JSON.stringify(folders)!==JSON.stringify(saved);
 return <section className="feature-panel download-module" aria-label={t('settings.title')}>
  <div className="download-controls">
   <p className="field-help">{t(native?(root?'settings.help':'settings.noRoot'):'downloads.browser')}</p>
   {root&&keys.map(key=><div key={key} className="settings-row"><span className="settings-label">{t(`settings.${key}`)}</span><code className="download-identity">{folders[key]??t('settings.default')}</code><button type="button" className="action-button" disabled={!native||busy} onClick={()=>void pick(key)}>{t('settings.choose')}</button><button type="button" className="action-button" disabled={!folders[key]||busy} onClick={()=>setFolders(f=>{const n={...f};delete n[key];return n;})}>{t('settings.reset')}</button></div>)}
   {root&&<div className="aio-actions"><button type="button" className="action-button" disabled={!native||!dirty||busy} onClick={()=>void save()}>{t('settings.save')}</button></div>}
   {error&&<p role="alert">{error}</p>}
  </div>
 </section>;
}
