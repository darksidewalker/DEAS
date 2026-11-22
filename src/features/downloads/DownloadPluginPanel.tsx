import { MODEL_LIBRARY_UPDATED,modelPathKey,publishModelLibrary,patchModels,refreshModelPreviews,type ModelLibraryUpdate } from '../../lib/modelLibrary';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { NeuralBlob } from '../../components/neural/NeuralBlob';
import { useI18n } from '../../i18n/I18nProvider';
import { filesPresent } from '../../lib/settings';
import { verifyAuthToken, importDownloadCatalog, restoreAuthToken, browseDownloads, cancelDownloads, clearDownloadQueue, formatBytes, percentOf, pickDownloadParent, planDownloads, readAuthStatus, readDownloadCatalog, readDownloadStatus, removeAuthToken, resumeDownloads, setAuthToken, startDownloadsQueue, comfyFolder, openTokenPage } from '../../lib/downloads';
import type { AuthVerification, AuthMetadata, CatalogEntry, DownloadCatalog, DownloadJob, DownloadListing, DownloadPlan, DownloadResource, DownloadScope, DownloadStatus, PlanRequest } from '../../lib/downloads';
import { isString, oneOf, usePref } from '../../lib/preferences';
import { changeModelFiles, editLibraryLora, fetchModelInfo, linkModelInfo, readModelScanStatus, startModelScan } from '../../lib/models';
import { claimDownloadRefresh, loadInstalledListing, refreshAfterDownloads, reloadAfterFetch, rememberInstalledListing } from './installedListing';
import { InstalledGallery } from './InstalledGallery';
import { CatalogGallery,type CatalogCard } from './CatalogGallery';
import { LibraryGlyph } from './LibraryGlyph';
import type { LocalModel, LoraEdit, ModelRefreshScope, ModelScanScope, ModelScanStatus } from '../../lib/models';
import './downloads.css';
import {ModelAdvice} from '../../components/ModelAdvice';
import {checkModel} from '../../lib/modelCheck';
import {ModelCompanionAdvice} from './ModelCompanionAdvice';
import type {ModelCompanionSuggestion} from '../../lib/modelCompanionAdvice';
import { ModelDeclaredBadge, useModelMetadataUpdates } from '../../components/models/ModelMetadataEditor';
/** Explicit CivitAI link for files whose hashes CivitAI does not know (edited, converted or re-uploaded). */
function CivitaiLinkForm({disabled,onLink}:{disabled:boolean;onLink:(link:string)=>void}) {
 const {t}=useI18n();const [link,setLink]=useState('');
 const valid=/^https:\/\/(www\.)?civitai\.(com|red)\/\S+$/.test(link.trim());
 return <form className="library-civitai-link" data-library-civitai-link onSubmit={e=>{e.preventDefault();if(valid&&!disabled)onLink(link.trim());}}>
  <label>{t('downloads.installed.link')}<input type="url" value={link} maxLength={2048} placeholder={t('downloads.installed.linkPlaceholder')} disabled={disabled} onChange={e=>setLink(e.target.value)}/></label>
  <button className="action-button" type="submit" disabled={disabled||!valid}>{t('downloads.installed.linkAction')}</button>
  <p className="field-help">{t('downloads.installed.linkHelp')}</p>
 </form>;
}
const validSort=(v:unknown):v is {by:'newest'|'name';dir:1|-1}=>typeof v==='object'&&v!==null&&['newest','name'].includes((v as {by:unknown}).by as string)&&[1,-1].includes((v as {dir:unknown}).dir as number);

/** One operation at a time; generation changes and unmount discard late responses. */
function useNativeRequest() {
 const native=isTauri();const live=useRef(false);const epoch=useRef(0);const lock=useRef(false);
 const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null); // native/provider message shown verbatim in alerts
 useEffect(()=>{live.current=true;return()=>{live.current=false;epoch.current++;};},[]);
 const invalidate=useCallback(()=>{epoch.current++;setError(null);},[]);
 const request=useCallback(async <T,>(operation:()=>Promise<T>,publish:(value:T)=>void)=>{
  if(!native||!live.current||lock.current)return;
  lock.current=true;setBusy(true);const generation=epoch.current;
  try {const value=await operation();if(live.current&&generation===epoch.current){publish(value);setError(null);}}
  catch(e){if(live.current&&generation===epoch.current)setError(String(e));}
  finally {lock.current=false;if(live.current)setBusy(false);}
 },[native]);
 return {native,busy,error,request,invalidate};
}

export const authProviders=[{id:'huggingface',label:'Hugging Face',origin:'https://huggingface.co'},{id:'civitai',label:'CivitAI',origin:'https://civitai.com'},{id:'github',label:'GitHub',origin:'https://api.github.com'}];
/** `embedded` panels are always open and have no bubble; a parent tab strip decides which one is mounted. */
export interface AuthPanelProps { onChange?:()=>void; embedded?:boolean }
/** Fixed native credential audiences; never infer audiences from external catalog entries. */
export function AuthPanel({onChange,embedded=false}:AuthPanelProps={}) {
 const {t}=useI18n();const io=useNativeRequest();const [opened,setOpened]=useState(false);const open=embedded||opened;
 const [providerId,setProviderId]=useState('huggingface');const [persist,setPersist]=useState(true);const [metadata,setMetadata]=useState<AuthMetadata[]>([]);
 const token=useRef<HTMLInputElement>(null);const [hasToken,setHasToken]=useState(false);
 const clear=()=>{if(token.current)token.current.value='';setHasToken(false);};
 useEffect(()=>{const input=token.current;return()=>{if(input)input.value='';};},[open]);
 const [statusError,setStatusError]=useState(false);const metadataEpoch=useRef(0);
 useEffect(()=>{if(!open||!io.native)return;let alive=true;const epoch=metadataEpoch.current;readAuthStatus().then(value=>{if(alive&&epoch===metadataEpoch.current){setMetadata(value);setStatusError(false);}},()=>{if(alive&&epoch===metadataEpoch.current)setStatusError(true);});return()=>{alive=false;};},[open,io.native]);
 const current=metadata.find(p=>p.providerId===providerId);
 const [checkRevision,setCheckRevision]=useState(0);const [check,setCheck]=useState<{providerId:string;status:AuthVerification['status']|'checking'}|null>(null);
 useEffect(()=>{
  if(!open||!io.native||!current?.configured){setCheck(null);return;}
  let alive=true;setCheck({providerId,status:'checking'});
  verifyAuthToken(providerId).then(value=>{if(alive)setCheck(value);},()=>{if(alive)setCheck({providerId,status:'unavailable'});});
  return()=>{alive=false;};
 },[open,io.native,providerId,current?.configured,checkRevision]);
 const checkStatus=check?.providerId===providerId?check.status:null;
 const changed=(value:AuthMetadata)=>{setCheckRevision(v=>v+1);metadataEpoch.current++;setStatusError(false);setMetadata(old=>[...old.filter(p=>p.providerId!==value.providerId),value]);clear();onChange?.();};
 return <section className="feature-panel download-module" aria-label={t('downloads.auth')}>
  {!embedded&&<NeuralBlob id="provider-auth" label={t('downloads.auth')} description={t('downloads.authBubble')} selected={open} onSelect={()=>{clear();io.invalidate();setOpened(v=>!v);}}/>}
  {open&&<div className="download-controls">
   <p className="field-help">{t(io.native?'downloads.tokenHelp':'downloads.browser')}</p>
   {/* Overview: one button per provider with its saved-token state; the pressed one shows its settings below. */}
   <div className="auth-providers" role="group" aria-label={t('downloads.provider')}>{authProviders.map(p=>{const m=metadata.find(x=>x.providerId===p.id);return <button key={p.id} type="button" data-provider={p.id} className={`auth-provider${m?.configured?' is-set':''}`} aria-pressed={providerId===p.id} disabled={io.busy} onClick={()=>{if(p.id===providerId)return;clear();io.invalidate();setProviderId(p.id);}}><strong>{m?.configured&&<span className="auth-set-mark" aria-hidden="true">✓ </span>}{p.label}</strong><small>{t(m?.configured?'downloads.auth.set':'downloads.auth.none')}</small></button>;})}</div>
   <div className="auth-settings" aria-label={authProviders.find(p=>p.id===providerId)?.label} role="region">
   <p className="download-identity">{authProviders.find(p=>p.id===providerId)?.origin} <button type="button" className="download-link" disabled={!io.native||io.busy} onClick={()=>void io.request(()=>openTokenPage(providerId),()=>{})}>{t('downloads.openTokenPage')}</button></p>
   <p className="field-help">{t('downloads.tokenPageHelp')}</p>
   <p role="status"><span className={current?.configured&&checkStatus==='verified'?'auth-verified':undefined}>{current?.configured&&checkStatus==='verified'&&<span aria-hidden="true">✓ </span>}{t(current?.configured?(checkStatus?`downloads.authCheck.${checkStatus}`:'downloads.supplied'):'downloads.anonymous')}</span>{current?.persisted&&<> · {t('downloads.persisted')}</>}</p>
   <label>{t('downloads.token')}<input aria-label={t('downloads.token')} ref={token} type="password" autoComplete="off" spellCheck={false} disabled={!io.native||io.busy} onChange={e=>setHasToken(!!e.target.value.trim())}/></label>
   <label className="download-check"><input type="checkbox" checked={persist} disabled={io.busy} onChange={e=>setPersist(e.target.checked)}/>{t('downloads.persist')}</label>
   <div className="aio-actions">
    <button className="action-button" disabled={!io.native||io.busy||!hasToken} onClick={()=>{const secret=token.current?.value;if(secret)void io.request(()=>setAuthToken(providerId,secret,persist),changed);}}>{t('downloads.applyToken')}</button>
    <button className="action-button" disabled={!io.native||io.busy} onClick={()=>void io.request(()=>removeAuthToken(providerId),changed)}>{t('downloads.clearToken')}</button>
    <button className="action-button" disabled={!io.native||io.busy} onClick={()=>void io.request(()=>restoreAuthToken(providerId),changed)}>{t('downloads.restoreAuth')}</button>
    <button className="action-button" disabled={!io.native||io.busy} onClick={()=>void io.request(readAuthStatus,value=>{setCheckRevision(v=>v+1);metadataEpoch.current++;setStatusError(false);setMetadata(value);onChange?.();})}>{t('downloads.authStatus')}</button>
   </div>
   </div>
   {(io.error||statusError)&&<p role="alert">{t('downloads.authError')}</p>}
  </div>}
 </section>;
}

/** Catalog previews are plain HTTPS stills; CSP restricts them to civitai hosts. */
function Preview({src,alt}:{src?:string;alt:string}) {
 if(!src)return <span className="download-preview is-empty" aria-hidden="true"/>;
 return <img className="download-preview" src={src} alt={alt} loading="lazy"/>;
}
// ComfyUI model folder order; unknown catalog targets follow alphabetically.
const categoryOrder=['models','loras','dials','vae','text_encoders','clip_vision','controlnet','upscale_models','embeddings','workflows'];
// Checkpoints and diffusion models share one "Models" tab; the entry's own target stays the destination folder.
const modelFolders=['checkpoints','diffusion_models'];
const tabOf=(target:string)=>modelFolders.includes(target)?'models':target;
/** Files already inside the ComfyUI models folder; CivitAI metadata is fetched per file on request and cached natively. */
function InstalledModels({root,locked,category,setCategory,onCompanion}:{root:string;locked:boolean;category:string;setCategory:(c:string)=>void;onCompanion:(s:ModelCompanionSuggestion)=>void}) {
 const {t,locale}=useI18n();const io=useNativeRequest();
 const [models,setModelState]=useState<LocalModel[]|null>(null);
 const setModels=useCallback((change:SetStateAction<LocalModel[]|null>)=>setModelState(old=>{const next=typeof change==='function'?change(old):change;if(next)rememberInstalledListing(root,next);return next;}),[root]);
 useModelMetadataUpdates(setModels);const [scanError,setScanError]=useState(false);const [selected,setSelected]=useState('');
 // A refresh started elsewhere (a finished download) publishes the whole listing; show it without reopening the view.
 useEffect(()=>{const receive=(event:Event)=>{const change=(event as CustomEvent<ModelLibraryUpdate>).detail;if(!change.models||modelPathKey(change.root)!==modelPathKey(root))return;const next=change.models;setModels(next);setSelected(old=>next.some(m=>m.path===old)?old:'');};window.addEventListener(MODEL_LIBRARY_UPDATED,receive);return()=>window.removeEventListener(MODEL_LIBRARY_UPDATED,receive);},[root,setModels]);
 const [savePreview,setSavePreview]=usePref('library.fetch.savePreview',false,(v):v is boolean=>typeof v==='boolean');
 const [listingBusy,setListingBusy]=useState(false);const listingEpoch=useRef(0);
 useEffect(()=>{if(!io.native)return;const epoch=++listingEpoch.current;setModels(null);setScanError(false);setSelected('');setListingBusy(true);loadInstalledListing(root).then(v=>{if(listingEpoch.current===epoch)setModels(v);},()=>{if(listingEpoch.current===epoch)setScanError(true);}).finally(()=>{if(listingEpoch.current===epoch)setListingBusy(false);});return()=>{listingEpoch.current++;};},[root,io.native,setModels]);
 const refreshListing=(scope?:ModelRefreshScope)=>{const epoch=++listingEpoch.current;setScanError(false);setListingBusy(true);loadInstalledListing(root,true,false,scope).then(v=>{if(listingEpoch.current===epoch){setModels(v);setSelected(old=>v.some(m=>m.path===old)?old:'');}},()=>{if(listingEpoch.current===epoch)setScanError(true);}).finally(()=>{if(listingEpoch.current===epoch)setListingBusy(false);});};
 const [lastOp,setLastOp]=useState<'fetch'|'link'>('fetch');
 const publishInfo=(v:LocalModel)=>{const updates=refreshModelPreviews([v]);setModels(old=>old?patchModels(old,updates):old);publishModelLibrary({root,updates});};
 const fetch=(m:LocalModel)=>{setLastOp('fetch');void io.request(async()=>fetchModelInfo(m.path,(await readAuthStatus()).some(p=>p.providerId==='civitai'&&p.configured),savePreview),publishInfo);};
 const link=(m:LocalModel,url:string)=>{setLastOp('link');void io.request(async()=>linkModelInfo(m.path,url,(await readAuthStatus()).some(p=>p.providerId==='civitai'&&p.configured),savePreview),publishInfo);};
 const [scanScope,setScanScope]=useState<ModelScanScope>('all');
 const [scanStatus,setScanStatus]=useState<ModelScanStatus|null>(null);const [statusError,setStatusError]=useState(false);const scanEpoch=useRef(0);
 const scanning=scanStatus?.state==='running';
 const [fileBusy,setFileBusy]=useState(false);
 const fileOperation=useRef(false);
 const editLora=async(path:string,edit:LoraEdit)=>{
  if(fileOperation.current||locked||scanning||listingBusy||io.busy)throw new Error(t('library.fileBusy'));
  fileOperation.current=true;
  setFileBusy(true);
  try{
   const model=await editLibraryLora(root,path,edit);
   const updates=edit.kind==='preview'?refreshModelPreviews([model]):[model];
   setModels(old=>old?patchModels(old,updates):old);
   publishModelLibrary({root,updates});
  }finally{fileOperation.current=false;setFileBusy(false);}
 };
 const runFiles=async(paths:string[],destination?:string)=>{
  if(fileOperation.current||locked||scanning||listingBusy||io.busy)throw new Error(t('library.fileBusy'));
  fileOperation.current=true;
  setFileBusy(true);
  try{
   const result=await changeModelFiles(root,paths,destination);
   const byPath=new Map(result.changes.map(change=>[change.old,change]));
   const next=(models??[]).flatMap(model=>{
    const change=byPath.get(model.path);
    if(!change)return [model];
    return change.path&&change.name?[{...model,path:change.path,name:change.name,localPreview:change.localPreview??undefined}]:[];
   });
   if(result.changes.length){
    setModels(next);
    setSelected(current=>{const change=byPath.get(current);return change?change.path??'':current;});
    publishModelLibrary({root,models:next});
   }
   return result;
  }finally{fileOperation.current=false;setFileBusy(false);}
 };

 useEffect(()=>{if(!io.native)return;let alive=true;let timer:ReturnType<typeof setTimeout>;let seenJob='';setScanStatus(null);
  const poll=async()=>{const epoch=scanEpoch.current;try{const value=await readModelScanStatus();if(!alive)return;
   if(epoch===scanEpoch.current){setScanStatus(value);setStatusError(false);
    if(value.id&&value.root===root&&value.state!=='running'&&value.state!=='idle'&&seenJob!==value.id){
     seenJob=value.id;
     if(value.completed>value.failed)reloadAfterFetch(root,value.id).then(models=>{if(alive)setModels(models);},()=>{if(alive)setScanError(true);});
    }

   }
  }catch{if(alive)setStatusError(true);}finally{if(alive)timer=setTimeout(()=>void poll(),1000);}};
  void poll();return()=>{alive=false;clearTimeout(timer);};
 },[root,io.native]);
 const startScan=()=>{scanEpoch.current++;void io.request(async()=>startModelScan(root,scanScope,(await readAuthStatus()).some(p=>p.providerId==='civitai'&&p.configured)),value=>{scanEpoch.current++;setScanStatus(value);});};
 const fetchBatch=(targets:LocalModel[],missingOnly:boolean)=>{scanEpoch.current++;void io.request(async()=>startModelScan(root,'all',(await readAuthStatus()).some(p=>p.providerId==='civitai'&&p.configured),{paths:targets.map(m=>m.path),missingOnly,savePreview}),value=>{scanEpoch.current++;setScanStatus(value);});};
 const detail=(m:LocalModel)=>{const c=m.info?.civitai;const s=c?.settings;const settings=s?[s.sampler,s.scheduler,s.steps!==undefined&&t('downloads.installed.steps',{n:s.steps}),s.cfgScale!==undefined&&t('downloads.installed.cfg',{n:s.cfgScale}),s.size,s.clipSkip!==undefined&&t('downloads.installed.clipSkip',{n:s.clipSkip})].filter(Boolean).join(' · '):'';
  return <div className="download-picker"><ModelDeclaredBadge model={m}/><ModelAdvice check={checkModel(m)}/><ModelCompanionAdvice model={m} models={models??[]} locked={locked} onOpen={onCompanion}/><dl className="download-identity">
   {m.integrity&&<><dt>{t('downloads.installed.integrity')}</dt><dd>{t('downloads.installed.truncated')}</dd></>}
   {m.info&&<><dt>{t('downloads.installed.civitai')}</dt><dd data-civitai-match={c?c.matchedBy??'sha256':'none'}>{c?[c.name,c.version,c.base].filter(Boolean).join(' · '):t('downloads.installed.notFound',{date:new Date(m.info.fetchedAt*1000).toLocaleDateString(locale)})}{c?.matchedBy&&c.matchedBy!=='sha256'&&<small className="library-civitai-match">{t(`downloads.installed.matched.${c.matchedBy}`)}</small>}</dd></>}
   {settings&&<><dt>{t('downloads.installed.settings')}</dt><dd>{settings}</dd></>}
  </dl><p className="field-help">{t('downloads.installed.hashHelp')}</p>
  <button className="action-button" disabled={io.busy||locked||scanning||fileBusy||!scanStatus||statusError} onClick={()=>fetch(m)}>{t(m.info?'downloads.installed.refresh':'downloads.installed.fetch')}</button>
  {io.native&&<CivitaiLinkForm key={m.path} disabled={io.busy||locked||scanning||fileBusy||!scanStatus||statusError} onLink={url=>link(m,url)}/>}
  {io.busy&&<p role="status"><span className="aio-spinner" aria-hidden="true"/> {t('downloads.pending')}</p>}{io.error&&<p role="alert">{t(lastOp==='link'?'downloads.installed.linkError':'downloads.installed.fetchError')}</p>}</div>;};
 return <InstalledGallery models={models??[]} loaded={models!==null} root={root} category={category} setCategory={setCategory} selected={selected} setSelected={setSelected} locked={locked} renderDetail={detail} onFetch={io.native?fetchBatch:undefined} fetchBusy={scanning||fileBusy||io.busy||listingBusy||!scanStatus||statusError} fileActions={io.native?{run:runFiles,disabled:locked||scanning||listingBusy||io.busy||fileBusy}:undefined} previewPreference={{save:savePreview,set:setSavePreview}} editLora={io.native?editLora:undefined} refresh={io.native?{run:refreshListing,disabled:locked||listingBusy||scanning||fileBusy||io.busy}:undefined}
  actions={<>
   {io.native&&!!models&&models.length>0&&<div className="library-scan-tools">
    <label>{t('downloads.installed.scanScope')}<select data-scan-scope aria-label={t('downloads.installed.scanScope')} value={scanScope} disabled={locked||scanning||io.busy} onChange={e=>setScanScope(e.target.value as 'all'|'models'|'loras')}><option value="all">{t('downloads.installed.scopeAll')}</option><option value="models">{t('downloads.installed.scopeModels')}</option><option value="loras">{t('downloads.installed.scopeLoras')}</option></select></label>
    <button className="action-button" type="button" data-scan-files title={t('downloads.installed.scanAllHelp')} disabled={locked||scanning||fileBusy||io.busy||!scanStatus||statusError} onClick={startScan}>{t('downloads.installed.scanAll')}</button>
   </div>}
  </>}
  feedback={<>
   {scanStatus?.id&&<p role="status">{scanning&&<span className="aio-spinner" aria-hidden="true"/>} {t(scanning?'downloads.installed.scanning':scanStatus.state==='failed'?'downloads.installed.scanFailed':'downloads.installed.scanDone')} {t('downloads.installed.scanProgress',{completed:scanStatus.completed,total:scanStatus.total,remaining:scanStatus.remaining,failed:scanStatus.failed})} {scanStatus.file}</p>}
   {(statusError||(io.error&&!selected))&&<p role="alert">{t('downloads.installed.fetchError')}</p>}
   {listingBusy&&!scanError&&<p role="status">{t('library.loading')}</p>}{scanError&&<p role="alert">{t('downloads.installed.scanError')}</p>}
  </>}/>;
}
export interface DownloadPanelProps { installTarget?:string; modelsDir?:string; authRevision?:number; onStatus?:(status:DownloadStatus)=>void; embedded?:boolean; /** Keep the panel alive while an outer workspace tab is shown; the root element is hidden. */ hidden?:boolean; initialEntryId?:string; initialEntryIds?:string[]; initialCategory?:string; filenameFilter?:string|string[]; /** Another tab asks the bundled catalog to show cards matching this text (never downloads); `n` changes per ask. */ searchRequest?:{query:string;n:number} }
// Undated sources stay last; never infer publication dates from filenames or IDs.
const published=(r:{publishedAt?:string})=>Date.parse(r.publishedAt??'')||0;
const key=(r:DownloadResource)=>JSON.stringify([r.id,r.url,r.locator]);
const views=['installed','catalog','queue'] as const;
// A queue entry a "Resume" would restart; kept partial files continue where they stopped.
const resumable=(state:string)=>state==='cancelled'||state==='failed'||state==='interrupted';
/** One queue line per file. A job transfers its files in order: the first `completed` are placed,
 * the next one is active (or where the job stopped), later ones wait. Queues saved before
 * per-file progress (no `fileBytes`) derive the active file's bytes from the job total. */
export function queueFile(job:DownloadJob,index:number):{state:DownloadJob['state'];placed:number;total:number}{
 const resource=job.resources[index];
 const state:DownloadJob['state']=job.state==='succeeded'||index<job.completed?'succeeded':index===job.completed?job.state:'queued';
 const total=(job.resources.length===1?job.totalBytes||resource.size:resource.size)??0;
 const placedBefore=job.resources.slice(0,job.completed).reduce((sum,item)=>sum+(item.size??0),0);
 const placed=job.fileBytes?.[index]??(state==='succeeded'?total:index===job.completed?Math.max(0,job.bytesPlaced-placedBefore):0);
 return {state,placed,total};
}
// The bundled DaSiWa catalog stays the default source; `civitai-creator-*` user entries add live creator listings.
/** Brand name of the bundled catalog, not a translatable label. */
const BUNDLED_SOURCE='DaSiWa';
const isCreatorSource=(e:CatalogEntry)=>e.id.startsWith('civitai-creator-')&&e.scope==='user';
/** A ticked file keeps the browse context it was picked in, so selections from many cards download together. */
interface Picked {resource:DownloadResource;providerId:string;authenticated:boolean;folder:string}
interface Group {request:PlanRequest;keys:string[]}
export function DownloadPanel({installTarget,modelsDir,authRevision=0,onStatus,embedded=false,hidden=false,initialEntryId,initialEntryIds,initialCategory,filenameFilter,searchRequest}:DownloadPanelProps={}) {
 const {t}=useI18n();const io=useNativeRequest();const [opened,setOpened]=useState(false);const open=embedded||opened;
 const suggested=useMemo(()=>initialEntryIds??(initialEntryId?[initialEntryId]:undefined),[initialEntryIds,initialEntryId]);
 const [catalogText,setCatalogText]=useState('');const [sort,setSort]=usePref<{by:'newest'|'name';dir:1|-1}>('library.sort',{by:'newest',dir:-1},validSort);
 // Undated items stay last in both directions; name breaks date ties.
 const compare=(a:{label:string;publishedAt?:string},b:{label:string;publishedAt?:string})=>sort.by==='newest'?(+!published(a)-+!published(b))||sort.dir*(published(a)-published(b))||a.label.localeCompare(b.label):sort.dir*a.label.localeCompare(b.label);
 const [catalog,setCatalog]=useState<DownloadCatalog|null>(null);const [providerId,setProviderId]=useState('');
 const [scope,setScope]=useState<DownloadScope>('index');const [locator,setLocator]=useState('');const [entryId,setEntryId]=useState('');const [authenticated,setAuthenticated]=useState(false);
 const [category,setCategory]=usePref('library.category','',isString);const [folder,setFolder]=useState('');const [savedBase,setBase]=usePref('library.base','',isString);
 const [mediaFilter,setMediaFilter]=usePref('library.media','all',oneOf('all','image','video'));const [search,setSearch]=useState('');
 const [listing,setListing]=useState<DownloadListing|null>(null);const [basket,setBasket]=useState<Picked[]>([]);const [version,setVersion]=useState('');
 const [parentPath,setParentPath]=useState('');const [folderName,setFolderName]=useState('');const [blocked,setBlocked]=useState<DownloadPlan|null>(null);const [queue,setQueue]=useState<Group[]>([]);const [status,setStatus]=useState<DownloadStatus|null>(null);
 const [view,setView]=useState<'catalog'|'installed'|'queue'>('catalog');const modelsRoot=installTarget?modelsDir??`${installTarget}/ComfyUI/models`:'';
 const selectView=(next:'catalog'|'installed'|'queue')=>{if(next==='catalog'&&catalog){const tabs=categories(catalog);setCategory(c=>tabs.includes(c)?c:tabs[0]??'');}setView(next);};
 // Global search selects the Library view without touching any draft.
 const selectViewLive=useRef(selectView);selectViewLive.current=selectView;
 useEffect(()=>{const on=(e:Event)=>{const next=(e as CustomEvent).detail;if((views as readonly string[]).includes(next))selectViewLive.current(next);};window.addEventListener('deas:library-view',on);return()=>window.removeEventListener('deas:library-view',on);},[]);
 const running=status?.state==='running';const executionLock=useRef(false);const locked=running||executionLock.current||!!suggested&&!status;
 const edit=()=>{io.invalidate();setBlocked(null);};
 const sourceEdit=()=>{edit();setListing(null);setVersion('');};
 useEffect(()=>{if(!executionLock.current)io.invalidate();setBlocked(null);setListing(null);},[authRevision,io.invalidate]);
 // Embedded panels load the catalog on mount; a direct call (not io.request) survives StrictMode's effect replay.
 useEffect(()=>{if(!embedded||catalog||!io.native)return;let alive=true;readDownloadCatalog().then(value=>{if(alive)applyCatalog(value);},()=>{});return()=>{alive=false;};},[embedded,io.native]); // eslint-disable-line react-hooks/exhaustive-deps
 const authChoices=useRef(new Map<string,boolean>());
 // Providers with a saved token; null until known so the login hint never flashes.
 const [tokens,setTokens]=useState<Set<string>|null>(null);const needsLogin=(auth:boolean|undefined,id:string)=>!!auth&&!!tokens&&!tokens.has(id);
 useEffect(()=>{if(!io.native||!open)return;let alive=true;readAuthStatus().then(v=>{if(alive)setTokens(new Set(v.filter(m=>m.configured).map(m=>m.providerId)));},()=>{});return()=>{alive=false;};},[io.native,open,authRevision]);
 const provider=catalog?.providers.find(p=>p.id===providerId);
 const queueJobs=status?.jobs??[];
 const queuePending=queueJobs.filter(j=>j.state!=='succeeded').length;
 // A finished job that placed files re-reads its destination folder once, so Installed and Studio list the new models now.
 useEffect(()=>{if(!io.native||!modelsRoot)return;const done=(status?.jobs??[]).filter(j=>j.completed>0&&['succeeded','failed','cancelled','interrupted'].includes(j.state)&&claimDownloadRefresh(j.id));if(!done.length)return;void refreshAfterDownloads(modelsRoot,done.map(j=>j.target))?.catch(()=>{});},[io.native,modelsRoot,status]);
 // Every successful queue job releases its files from the selection basket.
 const releaseBasket=useCallback((jobs:DownloadJob[])=>{const done=jobs.filter(j=>j.state==='succeeded');if(!done.length)return;setBasket(old=>old.filter(b=>!done.some(j=>j.resources.some(r=>key(r)===key(b.resource)))));},[]);
 const applyCatalog=(value:DownloadCatalog)=>{sourceEdit();setCatalog(value);setProviderId(value.providers[0]?.id??'');setScope(value.providers[0]?.scopes[0]??'index');setLocator('');setEntryId('');const first=categories(value)[0];setCategory(c=>initialCategory??(categories(value).includes(c)?c:first||''));};
 const load=()=>void io.request(readDownloadCatalog,applyCatalog);
 // onStatus is often an inline callback; report through a ref so publishing never re-runs the recovery effect.
 const reportStatus=useRef(onStatus);reportStatus.current=onStatus;
 const publishStatus=useCallback((value:DownloadStatus)=>{executionLock.current=value.state==='running';if(value.state!=='running')setQueue([]);setStatus(value);releaseBasket(value.jobs??[]);reportStatus.current?.(value);},[releaseBasket]);
 useEffect(()=>{
  if(!io.native||!embedded)return;
  let alive=true;
  // Catalog browsing invalidates io.request; recovery must survive that independent read.
  // A background queue (running or resumable) reopens the queue view instead of a blank catalog.
  readDownloadStatus().then(value=>{if(!alive||!value)return;publishStatus(value);if(value.state==='running'||(value.jobs??[]).some(j=>j.state!=='succeeded')||((value.jobs?.length??0)>0&&value.state!=='idle'))setView('queue');},error=>{if(alive)void io.request(()=>Promise.reject(error),()=>{});});
  return()=>{alive=false;};
 },[embedded,io.native,publishStatus]);
 useEffect(()=>{
  if(!io.native||!running)return;
  let alive=true;let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{await io.request(readDownloadStatus,value=>{if(alive)publishStatus(value);});if(alive)timer=setTimeout(()=>void poll(),1000);};
  timer=setTimeout(()=>void poll(),1000);
  return()=>{alive=false;clearTimeout(timer);};
 },[io.native,io.request,running,publishStatus]);
 const browse=(request:{providerId:string;scope:DownloadScope;locator:string},cursor?:string)=>{edit();void io.request(async()=>{
  const authenticated=authChoices.current.get(request.providerId)??(await readAuthStatus()).some(p=>p.providerId===request.providerId&&p.configured);
  return {authenticated,listing:await browseDownloads({...request,authenticated,nsfw:true,...(cursor?{cursor}:{})})};
 },value=>{setAuthenticated(value.authenticated);const discovered=request.scope==='user'||request.scope==='search';if(discovered)setDiscovery(previous=>({providerId:request.providerId,scope:request.scope as 'user'|'search',locator:request.locator,authenticated:value.authenticated,listing:{...value.listing,resources:cursor&&previous?.providerId===request.providerId&&previous.scope===request.scope&&previous.locator===request.locator?[...new Map([...previous.listing.resources,...value.listing.resources].map(r=>[key(r),r])).values()]:value.listing.resources}}));setListing(previous=>({...value.listing,resources:cursor&&!discovered?[...new Map([...(previous?.resources??[]),...value.listing.resources].map(r=>[key(r),r])).values()]:value.listing.resources}));});};
 const current={providerId,scope,locator};
 const openEntry=(entry:CatalogEntry)=>{sourceEdit();setProviderId(entry.providerId);setScope(entry.scope);setLocator(entry.locator);setEntryId(entry.id);setFolder(entry.target);browse({providerId:entry.providerId,scope:entry.scope,locator:entry.locator});};
 const initialOpened=useRef(false);
 useEffect(()=>{if(!catalog||!suggested||initialOpened.current)return;const entry=catalog.entries.find(e=>e.id===suggested[0]);if(entry){initialOpened.current=true;setCategory(tabOf(entry.target));setBase(entry.base??'');openEntry(entry);}},[catalog,suggested]);
 const openResource=(r:DownloadResource,nextScope:DownloadScope,sourceProvider=providerId)=>{sourceEdit();setEntryId('');setProviderId(sourceProvider);setScope(nextScope);setLocator(r.locator!);if(r.category)setFolder(r.category);browse({providerId:sourceProvider,scope:nextScope,locator:r.locator!});};
 const runSearch=()=>{const civitai=catalog?.providers.find(p=>p.kind==='civitai'&&p.scopes.includes('search'));if(!civitai||!search.trim())return;sourceEdit();setSource('');setDiscovery(null);setRemoteId('');setSourceCategory('');setBase('');setMediaFilter('all');setEntryId('');setProviderId(civitai.id);setScope('search');setLocator(search.trim());browse({providerId:civitai.id,scope:'search',locator:search.trim()});};
 const resourceDetails=(r:DownloadResource)=><dl className="download-identity"><dt>{t('downloads.identity')}</dt><dd>{r.id}</dd><dt>{t('downloads.category')}</dt><dd>{r.category??r.kind}</dd><dt>{t('downloads.source')}</dt><dd>{r.url??r.locator??t('downloads.unknown')}</dd><dt>{t('downloads.size')}</dt><dd>{r.size??t('downloads.unknown')}</dd><dt>{t('downloads.digest')}</dt><dd>{r.sha256??t('downloads.unknown')}</dd><dt>{t('downloads.license')}</dt><dd>{r.license??t('downloads.unknown')}</dd></dl>;
 const [source,setSource]=useState('');
 // A wizard's "Find in Library" narrows the bundled catalog; Enter in the search field still decides about CivitAI.
 useEffect(()=>{if(!searchRequest)return;selectViewLive.current('catalog');setSource('');setDiscovery(null);setSearch(searchRequest.query);},[searchRequest?.n]); // eslint-disable-line react-hooks/exhaustive-deps
 const [discovery,setDiscovery]=useState<{providerId:string;scope:'user'|'search';locator:string;authenticated:boolean;listing:DownloadListing}|null>(null);
 const [remoteId,setRemoteId]=useState('');
 const remoteMode=!!source||!!discovery;
 // A creator source lists CivitAI models with their own category/base model; group them like the bundled catalog.
 const [sourceCategory,setSourceCategory]=useState('');
 const creatorSources=catalog?.entries.filter(isCreatorSource)??[];
 const visibleEntries=source?[]:(catalog?.entries.filter(e=>tabOf(e.target)===category&&!isCreatorSource(e))??[]).filter(e=>!suggested||suggested.includes(e.id));
 const sourceResources=discovery?.listing.resources??[];
 const sourceCategories=sortCategories([...new Set(sourceResources.map(r=>tabOf(r.category??'other')))]);
 const activeSourceCategory=sourceCategories.includes(sourceCategory)?sourceCategory:'';
 const bases=[...new Set((remoteMode?sourceResources.filter(r=>!activeSourceCategory||tabOf(r.category??'other')===activeSourceCategory):visibleEntries).map(e=>e.base).filter((b):b is string=>!!b))].sort();
 // A remembered family that this tab no longer offers falls back to All.
 const base=bases.includes(savedBase)?savedBase:'';
 // Typing narrows the catalog cards live; Enter additionally searches CivitAI.
 const entries=visibleEntries;
 const allResources=listing?.resources.filter(r=>(!filenameFilter||(filenameFilter as string[]).includes((r.locator??r.label).split('/').pop()!))&&(!base||!r.base||r.base===base)).sort(compare)??[];
 // Files of one model version (quants/formats) are picked together; the first (newest by default) version is preselected.
 const versions=[...new Set(allResources.map(r=>r.version).filter((v):v is string=>!!v))];
 const activeVersion=versions.includes(version)?version:versions[0]??'';
 const resources=allResources.filter(r=>!activeVersion||r.version===activeVersion);
 // Managed install folders receive files in place; a chosen parent (with optional new subfolder) overrides.
 const placeOf=(f:string)=>parentPath?{parentPath,folderName:folderName.trim()}:(installTarget||modelsDir)&&f?{parentPath:comfyFolder(installTarget??'',f,modelsDir),folderName:''}:null;
 const destination=placeOf(folder);
 const picked=(r:DownloadResource)=>basket.some(b=>key(b.resource)===key(r));
 const toggle=(r:DownloadResource)=>{edit();setBasket(old=>picked(r)?old.filter(b=>key(b.resource)!==key(r)):[...old,{resource:r,providerId,authenticated,folder}]);};
 // Native batches hold at most 16 files; only the first batch creates a new destination, later ones stage into it.
 const groups=():Group[]=>{const out:Group[]=[];const latest=new Map<string,Group>();const made=new Set<string>();
  for(const b of basket){const place=placeOf(b.folder)!;const dir=place.folderName?`${place.parentPath}/${place.folderName}`:place.parentPath;const id=JSON.stringify([b.providerId,b.authenticated,dir]);let g=latest.get(id);
   if(!g||g.keys.length>=16){g={request:{providerId:b.providerId,resources:[],...(made.has(dir)?{parentPath:dir,folderName:''}:place),authenticated:b.authenticated},keys:[]};made.add(dir);latest.set(id,g);out.push(g);}
   g.request.resources.push(b.resource);g.keys.push(key(b.resource));}
  return out;};
 // The Download-all click is the explicit authorization; a plan the native side marks non-executable stops the run.
 // Every folder group is planned up front and handed to the native background queue as one run;
 // the queue survives tab switches and restarts and resumes kept partials.
 const startGroups=(next:Group[])=>{if(executionLock.current||!next.length)return;executionLock.current=true;setQueue(next);let published=false;
  void io.request(async()=>{const plans:DownloadPlan[]=[];for(const group of next){const plan=await planDownloads(group.request);if(!plan.canExecute)return{plan,status:null as DownloadStatus|null};plans.push(plan);}return {plan:null as DownloadPlan|null,status:await startDownloadsQueue(plans.map(p=>p.id))};},({plan,status})=>{if(status){published=true;publishStatus(status);setView('queue');}else setBlocked(plan);}).finally(()=>{if(!published){executionLock.current=false;setQueue([]);}});};
 // Transfer speed per queue job from consecutive status samples.
 const speedSamples=useRef(new Map<string,{time:number;bytes:number}>());
 const speedOf=(job:DownloadJob,index:number,bytes:number)=>{const key=`${job.id}:${index}`;const now=Date.now();const previous=speedSamples.current.get(key);speedSamples.current.set(key,{time:now,bytes});if(job.state!=='running'||!previous||now<=previous.time||bytes<previous.bytes)return '';return ` · ${formatBytes(((bytes-previous.bytes)*1000)/(now-previous.time))}/s`;};
 const where=(b:Picked)=>{const d=placeOf(b.folder);return d?d.folderName||d.parentPath.split(/[\\/]/).pop():'';};
 const canStart=io.native&&!io.busy&&!running&&!queue.length&&basket.length>0&&basket.every(b=>placeOf(b.folder));
 const [present,setPresent]=useState<Set<string>>(new Set());
 const destinationDir=destination?(destination.folderName?`${destination.parentPath}/${destination.folderName}`:destination.parentPath):'';
 // Mark files that already exist in the destination as local; a failed check simply shows nothing.
 useEffect(()=>{setPresent(new Set());if(!io.native||!destinationDir||!listing)return;const names=listing.resources.filter(r=>r.downloadable&&r.locator).map(r=>r.locator!);if(!names.length)return;let alive=true;filesPresent(names.map(n=>`${destinationDir}/${n}`)).then(flags=>{if(alive)setPresent(new Set(names.filter((_,i)=>flags[i])));},()=>{});return()=>{alive=false;};},[io.native,destinationDir,listing]);
 const providerLabel=(id:string)=>catalog?.providers.find(p=>p.id===id)?.label??id;
 const resourceScope=(r:DownloadResource):DownloadScope=>catalog?.providers.find(p=>p.id===discovery?.providerId)?.kind==='civitai'?'model':'repo';
 const catalogItems:CatalogCard[]=remoteMode?sourceResources.filter(r=>!activeSourceCategory||tabOf(r.category??'other')===activeSourceCategory).map(r=>({id:key(r),identity:JSON.stringify([discovery?.providerId,r.kind==='repo'?resourceScope(r):r.kind,r.locator??r.id]),label:r.label,provider:providerLabel(discovery?.providerId??providerId),category:tabOf(r.category??'other'),base:r.base,preview:r.preview,nsfw:r.nsfw,publishedAt:r.publishedAt,size:r.size,authRequired:needsLogin(r.auth,discovery?.providerId??providerId)})):entries.map(e=>({id:e.id,identity:JSON.stringify([e.providerId,e.scope,e.locator]),label:e.label,provider:providerLabel(e.providerId),category:tabOf(e.target),base:e.base,media:e.media,preview:e.preview,nsfw:e.nsfw,publishedAt:e.publishedAt,authRequired:needsLogin(e.auth,e.providerId)}));
 const openCatalogCard=(item:CatalogCard)=>{if(remoteMode){const resource=sourceResources.find(r=>key(r)===item.id);if(!resource||!discovery)return;setRemoteId(item.id);if(resource.kind==='repo'&&resource.locator)openResource(resource,resourceScope(resource),discovery.providerId);else{edit();setProviderId(discovery.providerId);setAuthenticated(authChoices.current.get(discovery.providerId)??discovery.authenticated);setListing({resources:[resource],warnings:[],nextCursor:null});if(resource.category)setFolder(resource.category);}}else{const entry=entries.find(e=>e.id===item.id);if(entry){setDiscovery(null);setRemoteId('');openEntry(entry);}}};
 const categoryTabs=remoteMode?sourceCategories:sortCategories([...new Set([...(catalog?categories(catalog):[]),category].filter(Boolean))]);
 const categoryNavigation=<nav className="library-browse" aria-label={t('library.browse')}><span className="library-section-label">{t('library.browse')}</span><div className="library-types" role="tablist" aria-label={t('downloads.category')} data-source-categories={remoteMode||undefined}>{remoteMode&&<button role="tab" type="button" aria-label={t('downloads.media.all')} aria-selected={!activeSourceCategory} disabled={locked} onClick={()=>setSourceCategory('')}><LibraryGlyph name="folder"/><span>{t('downloads.media.all')}</span><small aria-hidden="true">{sourceResources.length}</small></button>}{categoryTabs.map(c=><button key={c} role="tab" type="button" data-catalog-category={c} aria-label={t(`downloads.folder.${c}`)} aria-selected={(remoteMode?activeSourceCategory:category)===c} disabled={locked} onClick={()=>{if(remoteMode)setSourceCategory(c);else{sourceEdit();setEntryId('');setCategory(c);}}}><LibraryGlyph name={c==='loras'?'model':'folder'}/><span>{t(`downloads.folder.${c}`)}</span><small aria-hidden="true">{remoteMode?sourceResources.filter(r=>tabOf(r.category??'other')===c).length:catalog?.entries.filter(e=>!isCreatorSource(e)&&tabOf(e.target)===c).length}</small></button>)}</div></nav>;
 // The file picker opens right under the clicked card; search/advanced listings keep their place below.
 const pickerInline=entries.some(e=>e.id===entryId);
 // Loading and failure of the clicked card's listing show in its picker, not at the far end of the panel.
 const browsingInline=(pickerInline||!!remoteId)&&!listing&&(io.busy||io.error);
 const picker=(listing||browsingInline)&&<div className="download-picker">
    {browsingInline&&(io.busy?<p role="status"><span className="aio-spinner" aria-hidden="true"/> {t('downloads.pending')}</p>:<p role="alert">{t('downloads.browseError')} {io.error}</p>)}
    {versions.length>0&&<div className="download-categories download-media-filter download-sort" role="group" aria-label={t('downloads.version')}><span aria-hidden="true">{t('downloads.version')}</span>{versions.map(v=><button key={v} type="button" aria-pressed={activeVersion===v} disabled={locked} onClick={()=>setVersion(v)}>{v}</button>)}</div>}
    {listing&&!resources.length&&<p>{t('downloads.empty')}</p>}
    {resources.map(r=><div className={`download-resource${picked(r)?' is-selected':''}${r.locator&&present.has(r.locator)?' is-local':''}`} key={key(r)}><Preview src={r.preview} alt=""/><div>{needsLogin(r.auth,providerId)&&<em className="download-auth">{t('downloads.authNeeded')}</em>}{r.nsfw&&<em className="download-auth download-nsfw-tag" title={t('downloads.nsfwHelp')}>{t('downloads.nsfwTag')}</em>}{r.downloadable&&r.locator&&present.has(r.locator)?<p className="download-local"><span aria-hidden="true">✓</span> {r.label} · {t('downloads.local')}</p>:r.downloadable?<label className="download-check"><input type="checkbox" disabled={locked} checked={picked(r)} onChange={()=>toggle(r)}/><span>{r.label}{r.variant&&<small className="download-variant">{r.variant}</small>}</span></label>:r.kind==='repo'&&r.locator&&provider?<button className="action-button" disabled={io.busy||locked} onClick={()=>openResource(r,provider.kind==='civitai'?'model':'repo')}>{t('downloads.openRepo',{name:r.label})}</button>:<p><strong>{r.label}</strong> · {t('downloads.backendResource')}</p>}<details><summary>{t('downloads.resourceDetails')}</summary>{resourceDetails(r)}</details>{r.downloadable&&<ModelAdvice check={checkModel(undefined,{remote:true,name:r.label})}/>}</div></div>)}
    {listing?.nextCursor&&<button className="action-button" disabled={io.busy||running} onClick={()=>browse(current,listing.nextCursor!)}>{t('downloads.next')}</button>}
    {listing&&<p className="field-help">{t('downloads.more')}</p>}{listing?.warnings.map((w,i)=><p key={i}>{w}</p>)}
 </div>;
 return <section className={`feature-panel download-module${view==='installed'?' is-installed':' is-catalog'}`} aria-label={t('downloads.title')} {...(hidden?{hidden:true}:{})}>
  {!embedded&&<NeuralBlob id="optional-downloads" label={t('downloads.title')} description={t('downloads.bubble')} selected={open} onSelect={()=>{if(locked)return;setOpened(v=>!v);if(!open&&!catalog)load();}}/>}
  {open&&<div className="download-controls" aria-busy={io.busy}>
   <div className="download-head">
    <div className="studio-tabs" role="tablist" aria-label={t('downloads.view')}>{views.filter(v=>v==='queue'?queueJobs.length>0||!!status&&status.state!=='idle':true).map(v=><button key={v} role="tab" type="button" data-library-tab={v} aria-selected={view===v} disabled={v==='queue'?false:locked||(v==='installed'&&!modelsRoot)} onClick={()=>selectView(v)}>{t(`downloads.view.${v}`)}{v==='queue'&&queuePending>0&&<small aria-hidden="true"> {queuePending}</small>}</button>)}</div>
   </div>
   {(view==='catalog'||!io.native)&&<p className="field-help">{t(io.native?'downloads.help':'downloads.browser')}</p>}
   {catalog&&<>
    {view==='installed'&&<InstalledModels root={modelsRoot} locked={locked} category={category} setCategory={setCategory} onCompanion={s=>{sourceEdit();setView('catalog');setSource('');setDiscovery(null);setRemoteId('');setSourceCategory('');setMediaFilter('all');setSearch(s.patterns[0]??'');setBase('');setEntryId('');setCategory(s.target);setFolder(s.target);}}/>}
    {view==='catalog'&&<>
    <header className="library-heading library-native-actions catalog-actions" data-catalog-actions><label className="download-source">{t('downloads.catalogSource')}<select aria-label={t('downloads.catalogSource')} value={remoteMode&&!source?'search://':source} disabled={locked||io.busy} data-download-source onChange={e=>{const entry=creatorSources.find(c=>c.id===e.target.value);setSource(entry?.id??'');setDiscovery(null);setRemoteId('');setSourceCategory('');setBase('');setMediaFilter('all');setSearch('');if(entry)openEntry(entry);else{sourceEdit();setEntryId('');}}}><option value="">{BUNDLED_SOURCE}</option>{remoteMode&&!source&&<option value="search://" disabled>{t(`downloads.scope.${discovery?.scope??'search'}`)}</option>}{creatorSources.map(c=><option key={c.id} value={c.id}>{c.locator}</option>)}</select></label><form className="download-search" onSubmit={e=>{e.preventDefault();runSearch();}}><label>{t('downloads.search')}<input data-download-search aria-label={t('downloads.search')} value={search} maxLength={120} disabled={locked} onChange={e=>setSearch(e.target.value)}/></label><button className="download-search-go" type="submit" aria-label={t('downloads.searchRun')} title={t('downloads.searchRun')} disabled={io.busy||locked||!search.trim()||!catalog.providers.some(p=>p.kind==='civitai')}><span aria-hidden="true">↵</span></button></form><button type="button" className="action-button download-start-all" disabled={!canStart} onClick={()=>{edit();startGroups(groups());}}>{t('downloads.startAll',{count:basket.length})}</button></header>
    <section className="download-basket catalog-basket" hidden={!basket.length} aria-label={t('downloads.basket')}><h3>{t('downloads.basket')} · {basket.length}</h3><ul>{basket.map(b=><li key={key(b.resource)}><span>{b.resource.label}</span><small>{where(b)}</small><button type="button" className="download-link" aria-label={t('downloads.remove',{name:b.resource.label})} disabled={locked||queue.length>0} onClick={()=>{edit();setBasket(old=>old.filter(x=>x!==b));}}>×</button></li>)}</ul></section>
    <CatalogGallery key={source||(discovery?.scope==='search'?JSON.stringify([discovery.providerId,discovery.locator]):'bundled')} items={catalogItems} selectedId={remoteMode?remoteId:entryId} onOpen={openCatalogCard} query={discovery?.scope==='search'&&search.trim()===discovery.locator?'':search} onQuery={setSearch} base={base} onBase={setBase} media={mediaFilter} onMedia={setMediaFilter} onSortChange={value=>{if(['name','nameDesc','newest','oldest'].includes(value))setSort({by:value==='name'||value==='nameDesc'?'name':'newest',dir:value==='name'||value==='oldest'?1:-1});}} locked={locked||io.busy} picker={picker}>{categoryNavigation}</CatalogGallery>
    {remoteMode&&discovery?.listing.nextCursor&&<button type="button" className="action-button" disabled={io.busy||locked} onClick={()=>{setRemoteId('');sourceEdit();browse({providerId:discovery.providerId,scope:discovery.scope,locator:discovery.locator},discovery.listing.nextCursor!);}}>{t('downloads.next')}</button>}
    {remoteMode&&discovery?.listing.warnings.map((warning,i)=><p key={i}>{warning}</p>)}
    <details><summary>{t('downloads.advanced')}</summary><div className="download-controls">
     <p className="field-help">{t('downloads.safety')}</p>
     <button className="action-button" disabled={!io.native||io.busy||running} onClick={load}>{t('downloads.catalog')}</button>
     <details><summary>{t('downloads.importTitle')}</summary><p className="field-help">{t('downloads.importHelp')}</p><label>{t('downloads.catalogText')}<textarea aria-label={t('downloads.catalogText')} value={catalogText} maxLength={1048576} disabled={!io.native||io.busy||running} onChange={e=>setCatalogText(e.target.value)}/></label><button className="action-button" disabled={!io.native||io.busy||running||!catalogText.trim()} onClick={()=>{edit();void io.request(()=>importDownloadCatalog(catalogText),value=>{applyCatalog(value);setCatalogText('');});}}>{t('downloads.import')}</button></details>
     <label>{t('downloads.provider')}<select aria-label={t('downloads.provider')} value={providerId} disabled={locked} onChange={e=>{sourceEdit();setProviderId(e.target.value);setScope(catalog.providers.find(p=>p.id===e.target.value)?.scopes[0]??'index');setLocator('');setEntryId('');}}>{catalog.providers.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
     <p className="download-identity">{provider?.origin}</p><p className="field-help">{provider?.anonymousNotice}</p>
     <label>{t('downloads.authMode')}<select aria-label={t('downloads.authMode')} value={String(authenticated)} disabled={locked} onChange={e=>{authChoices.current.set(providerId,e.target.value==='true');sourceEdit();setAuthenticated(e.target.value==='true');}}><option value="false">{t('downloads.anonymous')}</option><option value="true">{t('downloads.authenticated')}</option></select></label>
     <label>{t('downloads.curated')}<select aria-label={t('downloads.curated')} value={entryId} disabled={locked} onChange={e=>{sourceEdit();setEntryId(e.target.value);const entry=catalog.entries.find(r=>r.id===e.target.value);if(entry){setScope(entry.scope);setLocator(entry.locator);setFolder(entry.target);}}}><option value="">{t('downloads.custom')}</option>{catalog.entries.filter(e=>e.providerId===providerId).map(e=><option key={e.id} value={e.id}>{e.label}</option>)}</select></label>
     <label>{t('downloads.mode')}<select aria-label={t('downloads.mode')} disabled={locked} value={scope} onChange={e=>{sourceEdit();setEntryId('');setScope(e.target.value as DownloadScope);}}>{provider?.scopes.map(s=><option key={s} value={s}>{t(`downloads.scope.${s}`)}</option>)}</select></label>
     <label>{t('downloads.query')}<input aria-label={t('downloads.query')} value={locator} disabled={locked} onChange={e=>{sourceEdit();setEntryId('');setLocator(e.target.value);}}/></label>
     <button className="action-button" disabled={io.busy||running||!locator.trim()||!provider} onClick={()=>browse(current)}>{t('downloads.list')}</button>
    </div></details>
    {!pickerInline&&!remoteMode&&picker}
    {destination&&<p>{t('downloads.destination')}: <span className="download-identity">{destination.folderName?`${destination.parentPath}/${destination.folderName}`:destination.parentPath}</span></p>}
    {/* Managed environments route files to the Settings models folder; the picker is only needed without one (external ComfyUI). */}
    {!installTarget&&<button className="action-button" disabled={io.busy||running} onClick={()=>void io.request(()=>pickDownloadParent(t('downloads.pick')),path=>{if(path){edit();setParentPath(path);}})}>{t('downloads.pick')}</button>}
    {parentPath&&<label>{t('downloads.subfolder')}<input aria-label={t('downloads.subfolder')} value={folderName} disabled={locked} onChange={e=>{edit();setFolderName(e.target.value);}}/></label>}
    </>}
   </>}
   {blocked&&<div className="download-plan"><p role="alert">{t('downloads.blocked')}</p><p className="download-identity">{blocked.target}</p>{blocked.warnings.map((w,i)=><p key={i}>{w}</p>)}</div>}
   {view==='queue'&&<section className="download-queue" data-download-queue aria-label={t('downloads.view.queue')}>
    <p className="field-help">{t('downloads.queue.help')}</p>
    {!queueJobs.length&&!status&&<p role="status">{t('downloads.queue.empty')}</p>}
    {status&&!queueJobs.length&&<div className="download-queue-summary" role="status"><strong>{t(`downloads.state.${status.state}`)}</strong><span>{t('downloads.queue.fileStats',{placed:formatBytes(status.bytesPlaced??status.bytesDownloaded),totalBytes:status.totalBytes?formatBytes(status.totalBytes):t('downloads.unknown')})}</span></div>}
    {queueJobs.length>0&&<ul className="download-queue-list">{queueJobs.flatMap(job=>job.resources.map((resource,index)=>{const file=queueFile(job,index);const pct=percentOf(file.placed,file.total);const last=file.state===job.state&&resumable(job.state);return <li key={`${job.id}:${index}`} data-queue-job={job.id} data-queue-file={index} className={`download-queue-item is-${file.state}`}>
      <div className="download-queue-head"><strong>{resource.label}</strong><em>{t(`downloads.state.${file.state}`)}</em><span className="download-queue-provider">{job.provider.label}</span></div>
      <p className="download-identity">{job.label!==resource.label?`${job.label} · `:''}{job.target}</p>
      <div className="download-queue-bar" role="progressbar" aria-label={resource.label} aria-valuemin={0} aria-valuemax={100} {...(pct===null?{}:{'aria-valuenow':pct})}><span style={{width:`${pct??(file.state==='succeeded'?100:0)}%`}}/></div>
      <p>{t('downloads.queue.fileStats',{placed:formatBytes(file.placed),totalBytes:file.total?formatBytes(file.total):t('downloads.unknown')})}{pct!==null&&<> · <strong>{pct}%</strong></>}{file.state==='running'?speedOf(job,index,file.placed):''}</p>
      {last&&job.error&&<p role="alert">{t('downloads.error')}: {job.error}</p>}
      {last&&<button type="button" className="action-button" data-download-resume={job.id} disabled={io.busy||running} aria-label={t('downloads.queue.resumeName',{name:resource.label})} onClick={()=>void io.request(()=>resumeDownloads([job.id]),publishStatus)}>{t('downloads.queue.resume')}</button>}
    </li>;}))}</ul>}
    <div className="aio-actions">
      {running&&<button className="action-button" data-download-cancel disabled={io.busy} onClick={()=>void io.request(cancelDownloads,publishStatus)}>{t('downloads.cancel')}</button>}
      {queueJobs.some(job=>resumable(job.state))&&<button className="action-button" data-download-resume-all disabled={io.busy||running} onClick={()=>void io.request(()=>resumeDownloads(),publishStatus)}>{t('downloads.queue.resumeAll')}</button>}
      {queueJobs.some(job=>['succeeded','cancelled','failed'].includes(job.state))&&<button className="action-button" data-download-clear disabled={io.busy||running} onClick={()=>void io.request(clearDownloadQueue,publishStatus)}>{t('downloads.queue.clear')}</button>}
     <button className="action-button" disabled={!io.native||io.busy} onClick={()=>void io.request(readDownloadStatus,value=>{setBlocked(null);publishStatus(value);})}>{t('downloads.refresh')}</button>
    </div>
    {io.error&&<p role="alert">{t('downloads.error')}: {io.error}</p>}
   </section>}
   {view==='catalog'&&<>{io.busy&&!browsingInline&&<p role="status">{t('downloads.pending')}</p>}{io.error&&!browsingInline&&<p role="alert">{t('downloads.error')}: {io.error}</p>}</>}
  </div>}
 </section>;
}
function categories(catalog:DownloadCatalog):string[] {
 return sortCategories([...new Set(catalog.entries.map(e=>tabOf(e.target)))]);
}
function sortCategories(found:string[]):string[] {
 return found.sort((a,b)=>(categoryOrder.indexOf(a)+1||99)-(categoryOrder.indexOf(b)+1||99)||a.localeCompare(b));
}
/** Compatibility export for existing consumers; auth is intentionally separate. */
export const DownloadPluginPanel=DownloadPanel;
