import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { NeuralBlob } from '../../components/neural/NeuralBlob';
import { useI18n } from '../../i18n/I18nProvider';
import { importDownloadCatalog, restoreAuthToken, browseDownloads, cancelDownloads, pickDownloadParent, planDownloads, readAuthStatus, readDownloadCatalog, readDownloadStatus, removeAuthToken, setAuthToken, startDownloads, comfyFolder } from '../../lib/downloads';
import type { AuthMetadata, CatalogEntry, DownloadCatalog, DownloadListing, DownloadPlan, DownloadResource, DownloadScope, DownloadStatus } from '../../lib/downloads';
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
  <NeuralBlob id="provider-auth" label={t('downloads.auth')} description={t('downloads.authBubble')} selected={open} onSelect={()=>{clear();io.invalidate();setOpen(!open);}}/>
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

/** Catalog previews are plain HTTPS media; CSP restricts them to known image hosts. */
function Preview({src,alt}:{src?:string;alt:string}) {
 if(!src)return <span className="download-preview is-empty" aria-hidden="true"/>;
 return /\.(mp4|webm)(\?|$)/i.test(src)?<video className="download-preview" src={src} muted loop autoPlay playsInline aria-label={alt}/>:<img className="download-preview" src={src} alt={alt} loading="lazy"/>;
}
// ComfyUI model folder order; unknown catalog targets follow alphabetically.
const categoryOrder=['checkpoints','diffusion_models','loras','vae','text_encoders','clip_vision','controlnet','upscale_models','embeddings','workflows'];
export interface DownloadPanelProps { installTarget?:string; authRevision?:number; onStatus?:(status:DownloadStatus)=>void }
const key=(r:DownloadResource)=>JSON.stringify([r.id,r.url,r.locator]);
export function DownloadPanel({installTarget,authRevision=0,onStatus}:DownloadPanelProps={}) {
 const {t}=useI18n();const io=useNativeRequest();const [open,setOpen]=useState(false);
 const [catalogText,setCatalogText]=useState('');
 const [catalog,setCatalog]=useState<DownloadCatalog|null>(null);const [providerId,setProviderId]=useState('');
 const [scope,setScope]=useState<DownloadScope>('index');const [locator,setLocator]=useState('');const [entryId,setEntryId]=useState('');const [authenticated,setAuthenticated]=useState(false);
 const [category,setCategory]=useState('');const [search,setSearch]=useState('');
 const [listing,setListing]=useState<DownloadListing|null>(null);const [selected,setSelected]=useState<DownloadResource[]>([]);
 const [parentPath,setParentPath]=useState('');const [folderName,setFolderName]=useState('');const [plan,setPlan]=useState<DownloadPlan|null>(null);const [consent,setConsent]=useState(false);const [status,setStatus]=useState<DownloadStatus|null>(null);
 const running=status?.state==='running';const executionLock=useRef(false);const locked=running||executionLock.current;
 const edit=()=>{io.invalidate();setPlan(null);setConsent(false);};
 const sourceEdit=()=>{edit();setListing(null);setSelected([]);};
 useEffect(()=>{if(!executionLock.current)io.invalidate();setPlan(null);setConsent(false);setListing(null);setSelected([]);},[authRevision,io.invalidate]);
 const provider=catalog?.providers.find(p=>p.id===providerId);
 const applyCatalog=(value:DownloadCatalog)=>{sourceEdit();setCatalog(value);setProviderId(value.providers[0]?.id??'');setScope(value.providers[0]?.scopes[0]??'index');setLocator('');setEntryId('');const first=categories(value)[0];setCategory(c=>c||first||'');};
 const load=()=>void io.request(readDownloadCatalog,applyCatalog);
 const publishStatus=useCallback((value:DownloadStatus)=>{executionLock.current=value.state==='running';setStatus(value);onStatus?.(value);},[onStatus]);
 useEffect(()=>{
  if(!io.native||!running)return;
  let alive=true;let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{await io.request(readDownloadStatus,value=>{if(alive)publishStatus(value);});if(alive)timer=setTimeout(()=>void poll(),1000);};
  timer=setTimeout(()=>void poll(),1000);
  return()=>{alive=false;clearTimeout(timer);};
 },[io.native,io.request,running,publishStatus]);
 const browse=(request:{providerId:string;scope:DownloadScope;locator:string},cursor?:string)=>{edit();void io.request(()=>browseDownloads({...request,authenticated,...(cursor?{cursor}:{})}),value=>{setListing(previous=>({...value,resources:cursor?[...new Map([...(previous?.resources??[]),...value.resources].map(r=>[key(r),r])).values()]:value.resources}));});};
 const current={providerId,scope,locator};
 const openEntry=(entry:CatalogEntry)=>{sourceEdit();setProviderId(entry.providerId);setScope(entry.scope);setLocator(entry.locator);setEntryId(entry.id);setCategory(entry.target);browse({providerId:entry.providerId,scope:entry.scope,locator:entry.locator});};
 const openResource=(r:DownloadResource,nextScope:DownloadScope)=>{sourceEdit();setEntryId('');setScope(nextScope);setLocator(r.locator!);if(r.category)setCategory(r.category);browse({providerId,scope:nextScope,locator:r.locator!});};
 const runSearch=()=>{const civitai=catalog?.providers.find(p=>p.kind==='civitai'&&p.scopes.includes('search'));if(!civitai||!search.trim())return;sourceEdit();setEntryId('');setProviderId(civitai.id);setScope('search');setLocator(search.trim());browse({providerId:civitai.id,scope:'search',locator:search.trim()});};
 const resourceDetails=(r:DownloadResource)=><dl className="download-identity"><dt>{t('downloads.identity')}</dt><dd>{r.id}</dd><dt>{t('downloads.category')}</dt><dd>{r.category??r.kind}</dd><dt>{t('downloads.source')}</dt><dd>{r.url??r.locator??t('downloads.unknown')}</dd><dt>{t('downloads.size')}</dt><dd>{r.size??t('downloads.unknown')}</dd><dt>{t('downloads.digest')}</dt><dd>{r.sha256??t('downloads.unknown')}</dd><dt>{t('downloads.license')}</dt><dd>{r.license??t('downloads.unknown')}</dd></dl>;
 const entries=catalog?.entries.filter(e=>e.target===category)??[];
 // Managed install folders receive files in place; a chosen parent (with optional new subfolder) overrides.
 const destination=parentPath?{parentPath,folderName:folderName.trim()}:installTarget&&category?{parentPath:comfyFolder(installTarget,category),folderName:''}:null;
 return <section className="feature-panel download-module" aria-label={t('downloads.title')}>
  <NeuralBlob id="optional-downloads" label={t('downloads.title')} description={t('downloads.bubble')} selected={open} onSelect={()=>{if(locked)return;setOpen(!open);if(!open&&!catalog)load();}}/>
  {open&&<div className="download-controls" aria-busy={io.busy}>
   <p className="field-help">{t(io.native?'downloads.help':'downloads.browser')}</p>
   {catalog&&<>
    <div className="download-categories" role="tablist" aria-label={t('downloads.category')}>{categories(catalog).map(c=><button key={c} role="tab" type="button" aria-selected={category===c} disabled={locked} onClick={()=>{sourceEdit();setEntryId('');setCategory(c);}}>{t(`downloads.folder.${c}`)}</button>)}</div>
    <div className="download-cards">{entries.map(e=><button key={e.id} type="button" className="download-card" aria-pressed={entryId===e.id} disabled={locked||io.busy} onClick={()=>openEntry(e)}><Preview src={e.preview} alt=""/><span>{e.label}</span></button>)}</div>
    {!entries.length&&<p className="field-help">{t('downloads.emptyCategory')}</p>}
    <form className="download-search" onSubmit={e=>{e.preventDefault();runSearch();}}><label>{t('downloads.search')}<input aria-label={t('downloads.search')} value={search} maxLength={120} disabled={locked} onChange={e=>setSearch(e.target.value)}/></label><button className="action-button" type="submit" disabled={io.busy||locked||!search.trim()||!catalog.providers.some(p=>p.kind==='civitai')}>{t('downloads.searchRun')}</button></form>
    <details><summary>{t('downloads.advanced')}</summary><div className="download-controls">
     <p className="field-help">{t('downloads.safety')}</p>
     <button className="action-button" disabled={!io.native||io.busy||running} onClick={load}>{t('downloads.catalog')}</button>
     <details><summary>{t('downloads.importTitle')}</summary><p className="field-help">{t('downloads.importHelp')}</p><label>{t('downloads.catalogText')}<textarea aria-label={t('downloads.catalogText')} value={catalogText} maxLength={1048576} disabled={!io.native||io.busy||running} onChange={e=>setCatalogText(e.target.value)}/></label><button className="action-button" disabled={!io.native||io.busy||running||!catalogText.trim()} onClick={()=>{edit();void io.request(()=>importDownloadCatalog(catalogText),value=>{applyCatalog(value);setCatalogText('');});}}>{t('downloads.import')}</button></details>
     <label>{t('downloads.provider')}<select aria-label={t('downloads.provider')} value={providerId} disabled={locked} onChange={e=>{sourceEdit();setProviderId(e.target.value);setScope(catalog.providers.find(p=>p.id===e.target.value)?.scopes[0]??'index');setLocator('');setEntryId('');}}>{catalog.providers.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
     <p className="download-identity">{provider?.origin}</p><p className="field-help">{provider?.anonymousNotice}</p>
     <label>{t('downloads.authMode')}<select aria-label={t('downloads.authMode')} value={String(authenticated)} disabled={locked} onChange={e=>{sourceEdit();setAuthenticated(e.target.value==='true');}}><option value="false">{t('downloads.anonymous')}</option><option value="true">{t('downloads.authenticated')}</option></select></label>
     <label>{t('downloads.curated')}<select aria-label={t('downloads.curated')} value={entryId} disabled={locked} onChange={e=>{sourceEdit();setEntryId(e.target.value);const entry=catalog.entries.find(r=>r.id===e.target.value);if(entry){setScope(entry.scope);setLocator(entry.locator);setCategory(entry.target);}}}><option value="">{t('downloads.custom')}</option>{catalog.entries.filter(e=>e.providerId===providerId).map(e=><option key={e.id} value={e.id}>{e.label}</option>)}</select></label>
     <label>{t('downloads.mode')}<select aria-label={t('downloads.mode')} disabled={locked} value={scope} onChange={e=>{sourceEdit();setEntryId('');setScope(e.target.value as DownloadScope);}}>{provider?.scopes.map(s=><option key={s} value={s}>{t(`downloads.scope.${s}`)}</option>)}</select></label>
     <label>{t('downloads.query')}<input aria-label={t('downloads.query')} value={locator} disabled={locked} onChange={e=>{sourceEdit();setEntryId('');setLocator(e.target.value);}}/></label>
     <button className="action-button" disabled={io.busy||running||!locator.trim()||!provider} onClick={()=>browse(current)}>{t('downloads.list')}</button>
    </div></details>
    {listing&&<p className="field-help">{t('downloads.more')}</p>}{listing?.warnings.map((w,i)=><p key={i}>{w}</p>)}
    {listing&&!listing.resources.length&&<p>{t('downloads.empty')}</p>}
    {listing?.resources.map(r=><div className="download-resource" key={key(r)}><Preview src={r.preview} alt=""/><div>{r.downloadable?<label className="download-check"><input type="checkbox" disabled={locked} checked={selected.some(s=>key(s)===key(r))} onChange={()=>{edit();setSelected(old=>old.some(s=>key(s)===key(r))?old.filter(s=>key(s)!==key(r)):[...old,r]);}}/>{r.label}</label>:r.kind==='repo'&&r.locator&&provider?<button className="action-button" disabled={io.busy||locked} onClick={()=>openResource(r,provider.kind==='civitai'?'model':'repo')}>{t('downloads.openRepo',{name:r.label})}</button>:<p><strong>{r.label}</strong> · {t('downloads.backendResource')}</p>}<details><summary>{t('downloads.resourceDetails')}</summary>{resourceDetails(r)}</details></div></div>)}
    {listing?.nextCursor&&<button className="action-button" disabled={io.busy||running} onClick={()=>browse(current,listing.nextCursor!)}>{t('downloads.next')}</button>}
    <p>{t('downloads.selection',{count:selected.length})}</p>
    {destination&&<p>{t('downloads.destination')}: <span className="download-identity">{destination.folderName?`${destination.parentPath}/${destination.folderName}`:destination.parentPath}</span></p>}
    <button className="action-button" disabled={io.busy||running} onClick={()=>void io.request(()=>pickDownloadParent(t('downloads.pick')),path=>{if(path){edit();setParentPath(path);}})}>{t('downloads.pick')}</button>
    {parentPath&&<label>{t('downloads.subfolder')}<input aria-label={t('downloads.subfolder')} value={folderName} disabled={locked} onChange={e=>{edit();setFolderName(e.target.value);}}/></label>}
    <button className="action-button" disabled={io.busy||running||!selected.length||!destination} onClick={()=>{if(!destination)return;edit();void io.request(()=>planDownloads({providerId,resources:selected,...destination,authenticated}),setPlan);}}>{t('downloads.prepare')}</button>
   </>}
   {plan&&<div className="download-plan"><h3>{t('downloads.plan')}</h3><p className="download-identity">{plan.target}</p>{plan.resources.map(r=><div key={key(r)}><strong>{r.label}</strong>{resourceDetails(r)}</div>)}<p>{t('downloads.knownBytes')}: {plan.totalKnownBytes} · {t('downloads.unknownCount')}: {plan.unknownSizeCount}</p>{plan.warnings.map((w,i)=><p key={i}>{w}</p>)}{!plan.canExecute&&<p role="alert">{t('downloads.blocked')}</p>}<label className="download-check"><input type="checkbox" disabled={io.busy||running||!plan.canExecute} checked={consent} onChange={e=>setConsent(e.target.checked)}/>{t('downloads.consent')}</label></div>}
   <div className="aio-actions"><button className="action-button" disabled={!io.native||io.busy||running||!consent||!plan?.canExecute} onClick={()=>{if(executionLock.current||!plan?.canExecute||!consent)return;executionLock.current=true;let published=false;void io.request(()=>startDownloads(plan.id),value=>{published=true;setConsent(false);setPlan(null);publishStatus(value);}).finally(()=>{if(!published)executionLock.current=false;});}}>{t('downloads.start')}</button><button className="action-button" disabled={!io.native||io.busy} onClick={()=>void io.request(readDownloadStatus,value=>{setPlan(null);setConsent(false);publishStatus(value);})}>{t('downloads.refresh')}</button>{running&&<button className="action-button" disabled={io.busy} onClick={()=>void io.request(cancelDownloads,publishStatus)}>{t('downloads.cancel')}</button>}</div>
   {io.busy&&<p role="status">{t('downloads.pending')}</p>}{status&&<div><p role="status">{t(`downloads.state.${status.state}`)}</p><p>{t('downloads.bytes')}: <output>{status.bytesDownloaded}</output> · {status.completed}/{status.total}</p>{status.error&&<p role="alert">{t('downloads.error')}: {status.error}</p>}</div>}{io.error&&<p role="alert">{t('downloads.error')}</p>}
  </div>}
 </section>;
}
function categories(catalog:DownloadCatalog):string[] {
 const found=[...new Set(catalog.entries.map(e=>e.target))];
 return found.sort((a,b)=>(categoryOrder.indexOf(a)+1||99)-(categoryOrder.indexOf(b)+1||99)||a.localeCompare(b));
}
/** Compatibility export for existing consumers; auth is intentionally separate. */
export const DownloadPluginPanel=DownloadPanel;
