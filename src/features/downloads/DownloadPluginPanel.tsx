import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { NeuralBlob } from '../../components/neural/NeuralBlob';
import { useI18n } from '../../i18n/I18nProvider';
import { importDownloadCatalog, restoreAuthToken, browseDownloads, cancelDownloads, pickDownloadParent, planDownloads, readAuthStatus, readDownloadCatalog, readDownloadStatus, removeAuthToken, setAuthToken, startDownloads } from '../../lib/downloads';
import type { AuthMetadata, DownloadCatalog, DownloadListing, DownloadPlan, DownloadResource, DownloadScope, DownloadStatus } from '../../lib/downloads';
import './downloads.css';

/** One operation at a time; generation changes and unmount discard late responses. */
function useNativeRequest() {
 const native=isTauri();const live=useRef(false);const epoch=useRef(0);const lock=useRef(false);
 const [busy,setBusy]=useState(false);const [error,setError]=useState(false);
 useEffect(()=>{live.current=true;return()=>{live.current=false;epoch.current++;};},[]);
 const invalidate=useCallback(()=>{epoch.current++;setError(false);},[]);
 const request=useCallback(async <T,>(operation:()=>Promise<T>,publish:(value:T)=>void)=>{
  if(!native||!live.current||lock.current)return;
  lock.current=true;setBusy(true);const generation=epoch.current;
  try {const value=await operation();if(live.current&&generation===epoch.current){publish(value);setError(false);}}
  catch {if(live.current&&generation===epoch.current)setError(true);}
  finally {lock.current=false;if(live.current)setBusy(false);}
 },[native]);
 return {native,busy,error,request,invalidate};
}

const authProviders=[{id:'huggingface',label:'Hugging Face',origin:'https://huggingface.co'},{id:'civitai',label:'CivitAI',origin:'https://civitai.com'},{id:'github',label:'GitHub',origin:'https://api.github.com'}];
export interface AuthPanelProps { onChange?:()=>void }
/** Fixed native credential audiences; never infer audiences from external catalog entries. */
export function AuthPanel({onChange}:AuthPanelProps={}) {
 const {t}=useI18n();const io=useNativeRequest();const [open,setOpen]=useState(false);
 const [providerId,setProviderId]=useState('huggingface');const [persist,setPersist]=useState(false);const [metadata,setMetadata]=useState<AuthMetadata[]>([]);
 const token=useRef<HTMLInputElement>(null);const [hasToken,setHasToken]=useState(false);
 const clear=()=>{if(token.current)token.current.value='';setHasToken(false);};
 useEffect(()=>{const input=token.current;return()=>{if(input)input.value='';};},[open]);
 const current=metadata.find(p=>p.providerId===providerId);
 const changed=(value:AuthMetadata)=>{setMetadata(old=>[...old.filter(p=>p.providerId!==value.providerId),value]);clear();onChange?.();};
 return <section className="feature-panel download-module" aria-label={t('downloads.auth')}>
  <NeuralBlob id="provider-auth" label={t('downloads.auth')} description={t('downloads.tokenHelp')} selected={open} onSelect={()=>{clear();io.invalidate();setOpen(!open);}}/>
  {open&&<div className="download-controls">
   <p className="field-help">{t(io.native?'downloads.tokenHelp':'downloads.browser')}</p>
   <label>{t('downloads.provider')}<select aria-label={t('downloads.provider')} value={providerId} disabled={io.busy} onChange={e=>{clear();io.invalidate();setProviderId(e.target.value);}}>{authProviders.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
   <p className="download-identity">{authProviders.find(p=>p.id===providerId)?.origin}</p>
   <p role="status">{t(current?.configured?'downloads.supplied':'downloads.anonymous')}{current?.persisted&&<> · {t('downloads.persisted')}</>}</p>
   <label>{t('downloads.token')}<input aria-label={t('downloads.token')} ref={token} type="password" autoComplete="off" spellCheck={false} disabled={!io.native||io.busy} onChange={e=>setHasToken(!!e.target.value.trim())}/></label>
   <label className="download-check"><input type="checkbox" checked={persist} disabled={io.busy} onChange={e=>setPersist(e.target.checked)}/>{t('downloads.persist')}</label>
   <div className="aio-actions">
    <button className="action-button" disabled={!io.native||io.busy||!hasToken} onClick={()=>{const secret=token.current?.value;if(secret)void io.request(()=>setAuthToken(providerId,secret,persist),changed);}}>{t('downloads.applyToken')}</button>
    <button className="action-button" disabled={!io.native||io.busy} onClick={()=>void io.request(()=>removeAuthToken(providerId),changed)}>{t('downloads.clearToken')}</button>
    <button className="action-button" disabled={!io.native||io.busy} onClick={()=>void io.request(()=>restoreAuthToken(providerId),changed)}>{t('downloads.restoreAuth')}</button>
    <button className="action-button" disabled={!io.native||io.busy} onClick={()=>void io.request(readAuthStatus,setMetadata)}>{t('downloads.authStatus')}</button>
   </div>
   {io.error&&<p role="alert">{t('downloads.authError')}</p>}
  </div>}
 </section>;
}

export interface DownloadPanelProps { installTarget?:string; authRevision?:number; onStatus?:(status:DownloadStatus)=>void }
const key=(r:DownloadResource)=>JSON.stringify([r.id,r.url,r.locator]);
export function DownloadPanel({installTarget,authRevision=0,onStatus}:DownloadPanelProps={}) {
 const {t}=useI18n();const io=useNativeRequest();const [open,setOpen]=useState(false);
 const [catalogText,setCatalogText]=useState('');
 const [catalog,setCatalog]=useState<DownloadCatalog|null>(null);const [providerId,setProviderId]=useState('');
 const [scope,setScope]=useState<DownloadScope>('index');const [locator,setLocator]=useState('');const [entryId,setEntryId]=useState('');const [authenticated,setAuthenticated]=useState(false);
 const [listing,setListing]=useState<DownloadListing|null>(null);const [selected,setSelected]=useState<DownloadResource[]>([]);
 const [parentPath,setParentPath]=useState('');const [folderName,setFolderName]=useState('');const [plan,setPlan]=useState<DownloadPlan|null>(null);const [consent,setConsent]=useState(false);const [status,setStatus]=useState<DownloadStatus|null>(null);
 const running=status?.state==='running';const executionLock=useRef(false);
 const edit=()=>{io.invalidate();setPlan(null);setConsent(false);};
 const sourceEdit=()=>{edit();setListing(null);setSelected([]);};
 useEffect(()=>{if(!executionLock.current)io.invalidate();setPlan(null);setConsent(false);setListing(null);setSelected([]);},[authRevision,io.invalidate]);
 const provider=catalog?.providers.find(p=>p.id===providerId);
 const load=()=>void io.request(readDownloadCatalog,value=>{sourceEdit();setCatalog(value);setProviderId(value.providers[0]?.id??'');setScope(value.providers[0]?.scopes[0]??'index');setLocator('');setEntryId('');});
 const publishStatus=useCallback((value:DownloadStatus)=>{executionLock.current=value.state==='running';setStatus(value);onStatus?.(value);},[onStatus]);
 useEffect(()=>{
  if(!io.native||!running)return;
  let alive=true;let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{await io.request(readDownloadStatus,value=>{if(alive)publishStatus(value);});if(alive)timer=setTimeout(()=>void poll(),1000);};
  timer=setTimeout(()=>void poll(),1000);
  return()=>{alive=false;clearTimeout(timer);};
 },[io.native,io.request,running,publishStatus]);
 const browse=(cursor?:string)=>{edit();void io.request(()=>browseDownloads({providerId,scope,locator,authenticated,...(cursor?{cursor}:{})}),value=>{setListing(previous=>({...value,resources:cursor?[...new Map([...(previous?.resources??[]),...value.resources].map(r=>[key(r),r])).values()]:value.resources}));});};
 const resourceDetails=(r:DownloadResource)=><dl className="download-identity"><dt>{t('downloads.identity')}</dt><dd>{r.id}</dd><dt>{t('downloads.category')}</dt><dd>{r.kind}</dd><dt>{t('downloads.source')}</dt><dd>{r.url??r.locator??t('downloads.unknown')}</dd><dt>{t('downloads.size')}</dt><dd>{r.size??t('downloads.unknown')}</dd><dt>{t('downloads.digest')}</dt><dd>{r.sha256??t('downloads.unknown')}</dd><dt>{t('downloads.license')}</dt><dd>{r.license??t('downloads.unknown')}</dd></dl>;
 return <section className="feature-panel download-module" aria-label={t('downloads.title')}>
  <NeuralBlob id="optional-downloads" label={t('downloads.title')} description={t('downloads.help')} selected={open} onSelect={()=>{if(running||executionLock.current)return;setOpen(!open);if(!open&&!catalog)load();}}/>
  {open&&<div className="download-controls" aria-busy={io.busy}>
   <p className="field-help">{t(io.native?'downloads.help':'downloads.browser')}</p><p className="field-help">{t('downloads.safety')}</p>
   {installTarget&&<p>{t('downloads.installTarget')}: <span className="download-identity">{installTarget}</span></p>}
   <button className="action-button" disabled={!io.native||io.busy||running} onClick={load}>{t('downloads.catalog')}</button>
   <details><summary>{t('downloads.importTitle')}</summary><p className="field-help">{t('downloads.importHelp')}</p><label>{t('downloads.catalogText')}<textarea aria-label={t('downloads.catalogText')} value={catalogText} maxLength={1048576} disabled={!io.native||io.busy||running} onChange={e=>setCatalogText(e.target.value)}/></label><button className="action-button" disabled={!io.native||io.busy||running||!catalogText.trim()} onClick={()=>{edit();void io.request(()=>importDownloadCatalog(catalogText),value=>{sourceEdit();setCatalog(value);setProviderId(value.providers[0]?.id??'');setScope(value.providers[0]?.scopes[0]??'index');setLocator('');setEntryId('');setCatalogText('');});}}>{t('downloads.import')}</button></details>
   {catalog&&<>
    <label>{t('downloads.provider')}<select aria-label={t('downloads.provider')} value={providerId} disabled={running||executionLock.current} onChange={e=>{sourceEdit();setProviderId(e.target.value);setScope(catalog.providers.find(p=>p.id===e.target.value)?.scopes[0]??'index');setLocator('');setEntryId('');}}>{catalog.providers.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
    <p className="download-identity">{provider?.origin}</p><p className="field-help">{provider?.anonymousNotice}</p>
    <label>{t('downloads.authMode')}<select aria-label={t('downloads.authMode')} value={String(authenticated)} disabled={running||executionLock.current} onChange={e=>{sourceEdit();setAuthenticated(e.target.value==='true');}}><option value="false">{t('downloads.anonymous')}</option><option value="true">{t('downloads.authenticated')}</option></select></label>
    <label>{t('downloads.curated')}<select aria-label={t('downloads.curated')} value={entryId} disabled={running||executionLock.current} onChange={e=>{sourceEdit();setEntryId(e.target.value);const entry=catalog.entries.find(r=>r.id===e.target.value);if(entry){setScope(entry.scope);setLocator(entry.locator);}}}><option value="">{t('downloads.custom')}</option>{catalog.entries.filter(e=>e.providerId===providerId).map(e=><option key={e.id} value={e.id}>{e.label}</option>)}</select></label>
    {entryId&&<p className="field-help">{t('downloads.catalogTarget')}: {catalog.entries.find(e=>e.id===entryId)?.target} · {catalog.entries.find(e=>e.id===entryId)?.license??t('downloads.unknown')} · {catalog.entries.find(e=>e.id===entryId)?.sha256??t('downloads.unknown')}</p>}
    <label>{t('downloads.mode')}<select aria-label={t('downloads.mode')} disabled={running||executionLock.current} value={scope} onChange={e=>{sourceEdit();setEntryId('');setScope(e.target.value as DownloadScope);}}>{provider?.scopes.map(s=><option key={s} value={s}>{t(`downloads.scope.${s}`)}</option>)}</select></label>
    <label>{t('downloads.query')}<input aria-label={t('downloads.query')} value={locator} disabled={running||executionLock.current} onChange={e=>{sourceEdit();setEntryId('');setLocator(e.target.value);}}/></label>
    <div className="aio-actions"><button className="action-button" disabled={io.busy||running||!locator.trim()||!provider} onClick={()=>browse()}>{t('downloads.list')}</button>{listing?.nextCursor&&<button className="action-button" disabled={io.busy||running} onClick={()=>browse(listing.nextCursor!)}>{t('downloads.next')}</button>}</div>
    {listing&&<p className="field-help">{t('downloads.more')}</p>}{listing?.warnings.map((w,i)=><p key={i}>{w}</p>)}
    {listing&&!listing.resources.length&&<p>{t('downloads.empty')}</p>}
    {listing?.resources.map(r=><div className="download-resource" key={key(r)}>{r.downloadable?<label className="download-check"><input type="checkbox" disabled={running||executionLock.current} checked={selected.some(s=>key(s)===key(r))} onChange={()=>{edit();setSelected(old=>old.some(s=>key(s)===key(r))?old.filter(s=>key(s)!==key(r)):[...old,r]);}}/>{r.label}</label>:r.kind==='repo'&&r.locator&&provider?.scopes.includes('repo')?<button className="action-button" disabled={io.busy||running||executionLock.current} onClick={()=>{sourceEdit();setEntryId('');setScope('repo');setLocator(r.locator!);}}>{t('downloads.openRepo',{name:r.label})}</button>:<p><strong>{r.label}</strong> · {t('downloads.backendResource')}</p>}<details><summary>{t('downloads.resourceDetails')}</summary>{resourceDetails(r)}</details></div>)}
    <p>{t('downloads.selection',{count:selected.length})}</p>
    <button className="action-button" disabled={io.busy||running} onClick={()=>void io.request(()=>pickDownloadParent(t('downloads.pick')),path=>{if(path){edit();setParentPath(path);}})}>{t('downloads.pick')}</button>{parentPath&&<p className="download-identity">{parentPath}</p>}
    <label>{t('downloads.subfolder')}<input aria-label={t('downloads.subfolder')} value={folderName} disabled={running||executionLock.current} onChange={e=>{edit();setFolderName(e.target.value);}}/></label>
    <button className="action-button" disabled={io.busy||running||!selected.length||!parentPath||!folderName.trim()} onClick={()=>{edit();void io.request(()=>planDownloads({providerId,resources:selected,parentPath,folderName,authenticated}),setPlan);}}>{t('downloads.prepare')}</button>
   </>}
   {plan&&<div className="download-plan"><h3>{t('downloads.plan')}</h3><p className="download-identity">{plan.target}</p>{plan.resources.map(r=><div key={key(r)}><strong>{r.label}</strong>{resourceDetails(r)}</div>)}<p>{t('downloads.knownBytes')}: {plan.totalKnownBytes} · {t('downloads.unknownCount')}: {plan.unknownSizeCount}</p>{plan.warnings.map((w,i)=><p key={i}>{w}</p>)}{!plan.canExecute&&<p role="alert">{t('downloads.blocked')}</p>}<label className="download-check"><input type="checkbox" disabled={io.busy||running||!plan.canExecute} checked={consent} onChange={e=>setConsent(e.target.checked)}/>{t('downloads.consent')}</label></div>}
   <div className="aio-actions"><button className="action-button" disabled={!io.native||io.busy||running||!consent||!plan?.canExecute} onClick={()=>{if(executionLock.current||!plan?.canExecute||!consent)return;executionLock.current=true;let published=false;void io.request(()=>startDownloads(plan.id),value=>{published=true;setConsent(false);setPlan(null);publishStatus(value);}).finally(()=>{if(!published)executionLock.current=false;});}}>{t('downloads.start')}</button><button className="action-button" disabled={!io.native||io.busy} onClick={()=>void io.request(readDownloadStatus,value=>{setPlan(null);setConsent(false);publishStatus(value);})}>{t('downloads.refresh')}</button>{running&&<button className="action-button" disabled={io.busy} onClick={()=>void io.request(cancelDownloads,publishStatus)}>{t('downloads.cancel')}</button>}</div>
   {io.busy&&<p role="status">{t('downloads.pending')}</p>}{status&&<div><p role="status">{t(`downloads.state.${status.state}`)}</p><p>{t('downloads.bytes')}: <output>{status.bytesDownloaded}</output> · {status.completed}/{status.total}</p>{status.error&&<p role="alert">{t('downloads.error')}: {status.error}</p>}</div>}{io.error&&<p role="alert">{t('downloads.error')}</p>}
  </div>}
 </section>;
}
/** Compatibility export for existing consumers; auth is intentionally separate. */
export const DownloadPluginPanel=DownloadPanel;
