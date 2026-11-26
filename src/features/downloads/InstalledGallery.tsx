import builtinFamilies from '../../families/builtin.json' with {type:'json'};
import { useModelOrganization } from '../../lib/modelOrganization';
import { hasVideoCover, ModelPreview } from '../../components/models/ModelPreview';
import { useDialogBackdropClose } from '../../components/useDialogBackdropClose';
import { requestStudioLora } from '../../lib/studioLoraSelection';
import { ModelAutoLoad, ModelViewAllControl } from '../../components/ModelAutoLoad';
import { modelFolderHidden, validHiddenModelFolders, type HiddenModelFolders } from '../../lib/modelFolders';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { ModelSortControl } from '../../components/ModelSortControl';
import { isModelSort, sortModels, useModelUsage } from '../../lib/modelBrowsing';
import { useI18n } from '../../i18n/I18nProvider';
import { isString, oneOf, usePref } from '../../lib/preferences';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { modelTriggerWords, type LocalModel, type LoraEdit, type ModelFileReport, type ModelRefreshScope } from '../../lib/models';
import { LibraryCoverEditor, LibraryPromptExamples, LibraryTriggerWords } from './LibraryLoraDetails';
import { checkModel, modelCheckText } from '../../lib/modelCheck';
import { ModelDeclaredBadge, ModelMetadataTarget, ModelMetadataEditor } from '../../components/models/ModelMetadataEditor';
import './installedGallery.css';
import { LibraryGlyph } from './LibraryGlyph';
import { reportLibraryError } from './libraryDiagnostics';
import { ModelFolderTree } from '../../components/ModelFolderTree';

const bucket=(m:LocalModel)=>['checkpoints','diffusion_models'].includes(m.category)?'models':m.category;
const folderOf=(m:LocalModel)=>m.name.split(/[\\/]/).slice(0,-1).join('/');
const filename=(m:LocalModel)=>m.name.split(/[\\/]/).at(-1)??m.name;
const titleOf=(m:LocalModel)=>m.info?.civitai?.name??filename(m).replace(/\.(safetensors|sft|ckpt|pt|pth|gguf|bin)$/i,'');
const familyOf=(m:LocalModel)=>m.familyOverride?(builtinFamilies.find(f=>f.id===m.familyOverride)?.name??m.familyOverride):m.info?.civitai?.base??m.family??'';
const sizeOf=(bytes:number)=>bytes>=1073741824?`${(bytes/1073741824).toFixed(1)} GB`:`${Math.max(0,Math.round(bytes/1048576))} MB`;
const order=['models','loras','vae','text_encoders','clip_vision','controlnet','upscale_models','embeddings'];
const PAGE_SIZE=60;


function Cover({model}:{model:LocalModel}) {
 return <ModelPreview model={model} className="download-preview" fallback={<div className="download-preview library-placeholder"><LibraryGlyph name="model"/><span>{model.name.split('.').at(-1)?.toUpperCase()}</span></div>}/>;
}

export function InstalledGallery({models,loaded,root,category,setCategory,selected,setSelected,locked,actions,feedback,renderDetail,onFetch,fetchBusy,previewPreference,fileActions,editLora,refresh}:{models:LocalModel[];loaded:boolean;root:string;category:string;setCategory:(value:string)=>void;selected:string;setSelected:(value:string)=>void;locked:boolean;actions:ReactNode;feedback:ReactNode;renderDetail:(model:LocalModel)=>ReactNode;onFetch?:(models:LocalModel[],missingOnly:boolean)=>void;fetchBusy?:boolean;previewPreference?:{save:boolean;set:(value:boolean)=>void};fileActions?:{run:(paths:string[],destination?:string)=>Promise<ModelFileReport>;disabled:boolean};editLora?:(path:string,edit:LoraEdit)=>Promise<void>;refresh?:{disabled:boolean;run:(scope?:ModelRefreshScope)=>void}}) {
 const {t}=useI18n();
 const [loraNotice,setLoraNotice]=useState<{error:boolean}|null>(null);
 useEffect(()=>{if(!loraNotice)return;const timer=setTimeout(()=>setLoraNotice(null),3000);return()=>clearTimeout(timer);},[loraNotice]);
 const addLora=(m:LocalModel)=>setLoraNotice({error:!requestStudioLora(root,m)});
 const noticeRef=useRef<HTMLDivElement>(null);
 const notice=loraNotice&&<div ref={noticeRef} popover="manual" className="library-added-notice" role={loraNotice.error?'alert':'status'}>{t(loraNotice.error?'library.loraAddFailed':'library.loraAdded')}</div>;
 const [fetchOpen,setFetchOpen]=useState(false);const [fetchTarget,setFetchTarget]=useState('filtered');const [missingOnly,setMissingOnly]=useState(true);
 const [refreshTarget,setRefreshTarget]=useState<'current'|'all'>('current');
 const [viewAll,setViewAll]=usePref('library.local.viewAll',false,(v):v is boolean=>typeof v==='boolean');
 const [query,setQuery]=usePref('library.local.query','',isString);
 const [layout,setLayout]=usePref('library.local.layout','grid',oneOf('grid','list'));
 const [sort,setSort]=usePref('library.local.sort','name',isModelSort);const usage=useModelUsage();const [shuffleSeed,setShuffleSeed]=useState(()=>Math.floor(Math.random()*2147483647));
 const {organization,annotation,annotate,isFavorite,toggleFavorite,applyFileChanges,error:organizationError}=useModelOrganization();
 const [favoritesOnly,setFavoritesOnly]=useState(false);const [folder,setFolder]=useState('');const [family,setFamily]=useState('');const [tag,setTag]=useState('');
 const [metadata,setMetadata]=useState('all');const [limit,setLimit]=useState(PAGE_SIZE);const [copied,setCopied]=useState('');
 const [blur,setBlur]=usePref('library.local.blur',true,(v):v is boolean=>typeof v==='boolean');
 const tabs=useMemo(()=>[...new Set(models.map(bucket))].sort((a,b)=>(order.indexOf(a)+1||99)-(order.indexOf(b)+1||99)||a.localeCompare(b)),[models]);
 const [hiddenByCollection,setHiddenByCollection]=usePref<HiddenModelFolders>('library.local.hiddenFolders',{},validHiddenModelFolders);
 const active=tabs.includes(category)?category:tabs[0]??'';
 const hiddenKey=`${root}:${active}`;const hiddenFolders=hiddenByCollection[hiddenKey]??[];const isHidden=(m:LocalModel)=>modelFolderHidden(m.name,hiddenByCollection[`${root}:${bucket(m)}`]??[]);
 const collection=useMemo(()=>models.filter(m=>bucket(m)===active),[models,active]);
 const families=useMemo(()=>[...new Set(collection.map(familyOf).filter(Boolean))].sort(),[collection]);
 const tags=useMemo(()=>[...new Set(collection.flatMap(m=>annotation(m.path)?.tags??[]))].sort(),[collection,organization]);
 const matching=useMemo(()=>{
  const terms=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return sortModels(collection.filter(m=>{
   const personal=annotation(m.path);const info=m.info?.civitai;
   const haystack=[m.name,info?.name,info?.version,familyOf(m),...modelTriggerWords(m),personal?.notes,...personal?.tags??[]].filter(Boolean).join(' ').toLocaleLowerCase();
   return (favoritesOnly||!isHidden(m))&&terms.every(term=>haystack.includes(term))&&(!favoritesOnly||isFavorite(m.path))&&(!folder||folderOf(m)===folder||folderOf(m).startsWith(`${folder}/`))&&(!family||familyOf(m)===family)&&(!tag||personal?.tags?.includes(tag))&&(metadata==='all'||(metadata==='known'?!!info:!info));
  }),sort,usage,shuffleSeed);
 },[collection,query,favoritesOnly,folder,family,tag,metadata,sort,organization,usage,shuffleSeed,hiddenByCollection,root]);
 useEffect(()=>{setLimit(PAGE_SIZE);},[query,active,favoritesOnly,folder,family,tag,metadata,sort,viewAll]);
 useEffect(()=>{setFolder('');setFamily('');setTag('');setMetadata('all');},[active,root]);
 const picked=models.find(m=>m.path===selected);const popup=useRef<HTMLDialogElement>(null);const [editing,setEditing]=useState(false);
 useEffect(()=>{const dialog=popup.current;if(!picked||!dialog)return;if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');return()=>{if(dialog.open&&typeof dialog.close==='function')dialog.close();};},[!!picked]);
 const [linkError,setLinkError]=useState('');
 useEffect(()=>{setEditing(false);setLinkError('');},[picked?.path]);
 const openLink=(command:string,args:Record<string,string|number|boolean>)=>{
  setLinkError('');
  void invoke(command,args).catch(()=>{setLinkError(picked?.path??'');reportLibraryError('open-link');});
 };
 const civitai=picked?.info?.civitai;
 // Use the top layer to escape Library containment, modal clipping and shared alert styles.
 useEffect(()=>{const element=noticeRef.current;if(!loraNotice||!element)return;element.showPopover?.();return()=>element.hidePopover?.();},[loraNotice,!!picked]);
 const favorite=(m:LocalModel)=>toggleFavorite(m.path);
 const copy=async(text:string,key:string)=>{try{await navigator.clipboard.writeText(text);setCopied(key);}catch{setCopied('error');reportLibraryError('clipboard');}};
 useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(''),2000);return()=>clearTimeout(timer);},[copied]);
 const reset=()=>{setQuery('');setFavoritesOnly(false);setFolder('');setFamily('');setTag('');setMetadata('all');};
 const fetchModels=fetchTarget==='all'?models.filter(m=>!isHidden(m)):fetchTarget==='category'?collection.filter(m=>!isHidden(m)):fetchTarget==='folder'?collection.filter(m=>!isHidden(m)&&(!folder||m.name.replace(/\\/g,'/').startsWith(`${folder}/`))):matching;
 const [bulk,setBulk]=useState(false);
 const [chosen,setChosen]=useState<Set<string>>(()=>new Set());
 const [confirmFiles,setConfirmFiles]=useState<LocalModel[]|null>(null);
 const [editingFiles,setEditingFiles]=useState(false);
 const [fileResult,setFileResult]=useState<{count:number;errors:string[]}|null>(null);
 useEffect(()=>{setBulk(false);setChosen(new Set());setFileResult(null);setConfirmFiles(null);},[root,active]);
 const chosenModels=collection.filter(model=>chosen.has(model.path));
 const filesDisabled=editingFiles||!fileActions||fileActions.disabled;
 const canMove=(items:LocalModel[])=>items.length>0&&items.every(model=>model.category===items[0].category);
 const toggleChosen=(path:string)=>setChosen(old=>{
  const updated=new Set(old);
  if(updated.has(path))updated.delete(path);else updated.add(path);
  return updated;
 });
 const editFiles=async(items:LocalModel[],move:boolean)=>{
  if(filesDisabled||!fileActions||!items.length)return;
  setEditingFiles(true);setFileResult(null);
  try{
   const destination=move?await invoke<string|null>('native_pick_directory',{title:t('library.moveTarget')}):undefined;
   if(move&&!destination)return;
   const result=await fileActions.run(items.map(model=>model.path),destination??undefined);
   applyFileChanges(result.changes);
   setChosen(old=>{const next=new Set(old);for(const change of result.changes)next.delete(change.old);return next;});
   setFileResult({count:result.changes.length,errors:result.errors});
  }catch(error){setFileResult({count:0,errors:[String(error)]});}
  finally{setEditingFiles(false);}
 };
 const pickedEdit=picked?.category==='loras'&&editLora?(edit:LoraEdit)=>editLora(picked.path,edit):undefined;
 const editDisabled=locked||!!fileActions?.disabled;
 const blurPicked=blur&&!!civitai?.nsfw;
 const clearSelection=()=>{const button=document.querySelector<HTMLButtonElement>('.library-card-main[aria-pressed="true"]');setSelected('');requestAnimationFrame(()=>button?.focus());};
 const backdrop=useDialogBackdropClose(()=>{(document.activeElement as HTMLElement)?.blur();clearSelection();});
 return <section className="installed-library" aria-label={t('library.collection')} data-installed-gallery>
  {confirmFiles&&<ConfirmDialog message={<><strong>{t('library.deleteCount',{count:confirmFiles.length})}</strong><br/>{t('library.deleteWarning')}<br/>{confirmFiles.slice(0,8).map(filename).join(', ')}</>} onDone={accepted=>{const files=confirmFiles;setConfirmFiles(null);if(accepted)void editFiles(files,false);}}/>}
  {!picked&&notice&&createPortal(notice,document.body)}
  <header className="library-heading"><div className="library-native-actions">{onFetch&&<button type="button" className="action-button" aria-expanded={fetchOpen} disabled={locked||fetchBusy} onClick={()=>setFetchOpen(v=>!v)}>{t('library.fetch')}</button>}{refresh&&<>
    <button className="action-button library-refresh" type="button" disabled={refresh.disabled} onClick={()=>refresh.run(refreshTarget==='current'&&active?{category:active,...(folder?{folder}:{})}:undefined)}><span aria-hidden="true">↻</span> {t('downloads.installed.refreshListing')}</button>
    <div className="library-scan-tools"><label><span>{t('library.refreshScope')}</span><select data-refresh-scope value={active?refreshTarget:'all'} disabled={refresh.disabled||!active} onChange={e=>setRefreshTarget(e.currentTarget.value==='all'?'all':'current')}>
     <option value="current">{t(folder?'library.fetchFolder':'library.fetchCategory')}</option>
     <option value="all">{t('library.fetchAll')}</option>
    </select></label></div>
   </>}{actions}</div></header>
  <div className="library-fetch-tools">{onFetch&&fetchOpen&&<div className="library-fetch-options" role="group" aria-label={t('library.fetch')}><label>{t('library.fetchTarget')}<select value={fetchTarget} disabled={fetchBusy} onChange={e=>setFetchTarget(e.target.value)}><option value="filtered">{t('library.fetchFiltered')}</option><option value="folder">{t('library.fetchFolder')}</option><option value="category">{t('library.fetchCategory')}</option><option value="all">{t('library.fetchAll')}</option></select></label><label className="library-checkbox"><input type="checkbox" checked={missingOnly} disabled={fetchBusy} onChange={e=>setMissingOnly(e.target.checked)}/>{t('library.fetchMissing')}</label><span>{t('library.fetchCount',{count:fetchModels.length})}</span><button type="button" className="action-button" disabled={locked||fetchBusy||!fetchModels.length} onClick={()=>{onFetch(fetchModels,missingOnly);setFetchOpen(false);}}>{t('library.fetchStart')}</button>{previewPreference&&<label className="library-checkbox"><input type="checkbox" checked={previewPreference.save} disabled={fetchBusy} onChange={e=>previewPreference.set(e.target.checked)}/>{t('library.savePreview')}</label>}<p className="field-help">{t('library.fetchHelp')}</p></div>}</div>
  {feedback}
  {fileResult&&<div className="library-file-result">
   <p role={fileResult.errors.length?'alert':'status'}>{t('library.filesChanged',{count:fileResult.count})}</p>
   {fileResult.errors.length>0&&<ul>{fileResult.errors.slice(0,8).map((error,i)=><li key={i}>{error}</li>)}</ul>}
  </div>}
  {organizationError&&<p role="alert">{t('library.organizationFailed')}</p>}
  <nav className="library-browse" aria-label={t('library.browse')}>
    <span className="library-section-label">{t('library.browse')}</span>
    <div className="library-types" role="tablist" aria-label={t('downloads.category')}>{tabs.map(c=><button role="tab" key={c} type="button" aria-label={t(`downloads.folder.${c}`)} aria-selected={active===c} disabled={locked} onClick={()=>{setSelected('');setCategory(c);}}><LibraryGlyph name={c==='loras'?'model':'folder'}/><span>{t(`downloads.folder.${c}`)}</span><small>{models.filter(m=>bucket(m)===c).length}</small></button>)}</div>
  </nav>
  <div className="library-layout">
   <aside className="library-sidebar" aria-label={t('library.navigation')}>

    <button className="library-favorite-filter" type="button" data-library-favorites aria-label={t('library.favorites')} aria-current={favoritesOnly?'page':undefined} onClick={()=>{setFavoritesOnly(true);setFolder('');setFamily('');setTag('');setMetadata('all');setQuery('');}}><span aria-hidden="true">★</span>{t('library.favorites')}<small>{collection.filter(m=>isFavorite(m.path)).length}</small></button>
    <div className="library-sidebar-divider"/>
    <span className="library-section-label">{t('library.filters')}</span>
    <div data-library-folder><ModelFolderTree names={collection.map(m=>m.name)} selected={favoritesOnly?'favorites://':folder} onSelect={path=>{setFavoritesOnly(false);setFolder(path);}} storageKey={`library:${root}:${active}`} rootLabel={t('library.allFolders')} disabled={locked} hiddenFolders={hiddenFolders} onToggleHidden={path=>setHiddenByCollection(old=>({...old,[hiddenKey]:(old[hiddenKey]??[]).includes(path)?(old[hiddenKey]??[]).filter(p=>p!==path):[...old[hiddenKey]??[],path]}))}/></div>
    <label>{t('library.base')}<select data-library-family value={family} onChange={e=>setFamily(e.target.value)}><option value="">{t('library.allBases')}</option>{families.map(f=><option key={f} value={f}>{f}</option>)}</select></label>
    <label>{t('library.metadata')}<select value={metadata} onChange={e=>setMetadata(e.target.value)}><option value="all">{t('library.anyMetadata')}</option><option value="known">{t('library.withMetadata')}</option><option value="missing">{t('library.missingMetadata')}</option></select></label>
    {tags.length>0&&<label>{t('library.tags')}<select value={tag} onChange={e=>setTag(e.target.value)}><option value="">{t('library.allTags')}</option>{tags.map(value=><option key={value}>{value}</option>)}</select></label>}
    <label className="library-checkbox"><input type="checkbox" checked={blur} onChange={e=>setBlur(e.target.checked)}/>{t('library.blur')}</label>
    <button className="library-text-button" type="button" onClick={reset}>{t('library.reset')}</button>
    <div className="library-root" title={root}><LibraryGlyph name="folder"/><span>{root}</span></div>
   </aside>
   <div className="library-workspace">
    <div className="library-toolbar"><div className="library-search"><LibraryGlyph name="search"/><input data-library-local-search aria-label={t('library.search')} placeholder={t('library.searchHint')} value={query} maxLength={200} onChange={e=>setQuery(e.target.value)}/>{query&&<button type="button" aria-label={t('library.clearSearch')} onClick={()=>setQuery('')}>×</button>}</div><ModelSortControl value={sort} onChange={setSort} onShuffle={()=>setShuffleSeed(n=>n+1)}/><ModelViewAllControl value={viewAll} onChange={setViewAll}/>{fileActions&&<button type="button" className="action-button" data-library-bulk aria-pressed={bulk} disabled={filesDisabled||!matching.length} onClick={()=>{setBulk(!bulk);setChosen(new Set());}}>{t('library.bulkSelect')}</button>}<div className="library-view-switch" role="group" aria-label={t('library.view')}>{(['grid','list'] as const).map(mode=><button key={mode} type="button" aria-pressed={layout===mode} aria-label={t(`library.${mode}`)} title={t(`library.${mode}`)} onClick={()=>setLayout(mode)}><LibraryGlyph name={mode}/></button>)}</div></div>

    {bulk&&fileActions&&<div className="library-bulk-tools" role="group" aria-label={t('library.bulkSelect')}>
     <span role="status">{t('library.bulkCount',{count:chosenModels.length})}</span>
     <button type="button" className="action-button" disabled={filesDisabled||!matching.length} onClick={()=>setChosen(new Set(matching.map(model=>model.path)))}>{t('library.selectResults')}</button>
     <button type="button" className="action-button" disabled={filesDisabled||!chosenModels.length} onClick={()=>setChosen(new Set())}>{t('library.clearSelection')}</button>
     <button type="button" className="action-button" disabled={filesDisabled||!canMove(chosenModels)} onClick={()=>void editFiles(chosenModels,true)}>{t('library.moveFiles')}</button>
     <button type="button" className="action-button" disabled={filesDisabled||!chosenModels.length} onClick={()=>setConfirmFiles(chosenModels)}>{t('library.deleteFiles')}</button>
    </div>}
    <div className="library-results-summary"><span>{t('library.showing',{shown:Math.min(limit,matching.length),total:matching.length})}</span><span>{sizeOf(matching.reduce((sum,m)=>sum+m.size,0))}</span></div>
    <div className="library-body" data-model-scroll>
     <div className="library-results">
      <div className={`library-card-grid is-${layout}`}>{matching.slice(0,limit).map(m=>{
       const info=m.info?.civitai;
       return <article key={m.path} className={`library-card${selected===m.path||chosen.has(m.path)?' is-selected':''}${blur&&info?.nsfw?' is-sensitive':''}${bulk?' is-bulk':''}`}>
        <ModelMetadataTarget model={m} actions={[
         ...(m.category==='loras'?[{label:t('library.addLora'),onClick:()=>addLora(m),disabled:locked}]:[]),
         ...(fileActions?[{label:t('library.moveFiles'),onClick:()=>void editFiles([m],true),disabled:filesDisabled},{label:t('library.deleteFiles'),onClick:()=>setConfirmFiles([m]),disabled:filesDisabled}]:[]),
        ]}><button type="button" className="download-card library-card-main" aria-label={m.name} aria-haspopup={bulk?undefined:"dialog"} aria-keyshortcuts="Shift+F10" aria-pressed={bulk?chosen.has(m.path):selected===m.path} disabled={locked} onClick={()=>bulk?toggleChosen(m.path):setSelected(selected===m.path?'':m.path)}>
         <div className="library-card-art"><Cover model={m}/><span className="library-family-badge">{familyOf(m)||t('library.unclassified')}</span>{info?.nsfw&&<span className="library-mature-badge">{t('downloads.nsfwTag')}</span>}</div>
         <div className="library-card-caption"><strong>{titleOf(m)}</strong><span className="library-card-version">{info?.version??filename(m)}</span><div className="library-card-bottom"><span>{sizeOf(m.size)}</span><span title={folderOf(m)}><LibraryGlyph name="folder"/>{folderOf(m).split('/').at(-1)||t('library.rootFolder')}</span></div><ModelDeclaredBadge model={m}/><small className="library-model-check">{modelCheckText(checkModel(m),t)}</small></div>
        </button></ModelMetadataTarget>
        {bulk&&<input type="checkbox" className="library-card-pick" aria-label={t('library.selectModel',{name:m.name})} checked={chosen.has(m.path)} disabled={filesDisabled} onChange={()=>toggleChosen(m.path)}/>}
        {m.category==='loras'&&<button type="button" className="library-add-lora" disabled={locked} aria-label={`${t('library.addLora')}: ${m.name}`} title={t('library.addLora')} onClick={()=>addLora(m)}>+</button>}
        <button type="button" className="library-star" aria-label={t(isFavorite(m.path)?'library.unfavorite':'library.favorite',{name:m.name})} aria-pressed={isFavorite(m.path)} onClick={()=>favorite(m)}>{isFavorite(m.path)?'★':'☆'}</button>
       </article>;
      })}</div>
      {loaded&&matching.length===0&&<div className="library-empty"><LibraryGlyph name="search"/><h3>{t('library.noResults')}</h3><p>{models.length?t('library.noResultsHelp'):t('downloads.installed.empty',{root})}</p>{models.length>0&&<button type="button" className="action-button" onClick={reset}>{t('library.reset')}</button>}</div>}
      {matching.length>limit&&(viewAll?<ModelAutoLoad onMore={()=>setLimit(n=>n+PAGE_SIZE)}/>:<button type="button" className="library-load-more" onClick={()=>setLimit(n=>n+PAGE_SIZE)}>{t('library.loadMore',{count:Math.min(PAGE_SIZE,matching.length-limit)})}</button>)}
     </div>
     {picked&&createPortal(<dialog ref={popup} {...backdrop} className="library-model-dialog" aria-label={t('library.details')} onCancel={e=>{if(e.target!==e.currentTarget)return;e.preventDefault();(document.activeElement as HTMLElement)?.blur();clearSelection();}}><aside className="library-inspector">
      <header><span className="library-section-label">{t('library.details')}</span><div className="library-popup-navigation"><button type="button" aria-label={t('library.previousModel')} disabled={matching.findIndex(m=>m.path===picked.path)<=0} onClick={()=>setSelected(matching[matching.findIndex(m=>m.path===picked.path)-1].path)}>‹</button><button type="button" aria-label={t('library.nextModel')} disabled={matching.findIndex(m=>m.path===picked.path)<0||matching.findIndex(m=>m.path===picked.path)>=matching.length-1} onClick={()=>setSelected(matching[matching.findIndex(m=>m.path===picked.path)+1].path)}>›</button><button type="button" aria-label={t('library.closeDetails')} onClick={clearSelection}>×</button></div></header>
      <h3 tabIndex={-1}>{titleOf(picked)}</h3><div className="library-detail-heading"><p className="library-detail-version">{civitai?.version??filename(picked)}</p>
       {isTauri()&&civitai&&<div className="library-civitai-links"><button className="action-button" type="button" onClick={()=>openLink('native_open_civitai_model',{modelId:civitai.modelId,versionId:civitai.versionId,nsfw:civitai.nsfw})}>{t('library.viewCivitai')}</button>{civitai.creator&&<button className="action-button" type="button" title={t('library.viewCreator')} onClick={()=>openLink('native_open_civitai_creator',{username:civitai.creator!,nsfw:civitai.nsfw})}>{civitai.creator}</button>}</div>}
      </div>
      {linkError===picked.path&&<p role="alert">{t('library.openLinkError')}</p>}
      {hasVideoCover(picked)&&<div className={blurPicked?'library-video-cover is-sensitive':'library-video-cover'}>
       <ModelPreview key={picked.path} model={picked} videoControls={!blurPicked} fallback={null}/>
      </div>}
      {picked.info?.civitai&&models.filter(m=>m.info?.civitai?.modelId===picked.info?.civitai?.modelId).length>1&&<section className="library-detail-section"><h4>{t('downloads.version')}</h4><div className="library-trigger-words">{models.filter(m=>m.info?.civitai?.modelId===picked.info?.civitai?.modelId).map(m=><button key={m.path} type="button" aria-pressed={m.path===picked.path} onClick={()=>setSelected(m.path)}>{m.info?.civitai?.version??filename(m)}</button>)}</div></section>}
      <LibraryTriggerWords key={picked.path} model={picked} copy={copy} copied={copied} onEdit={pickedEdit} disabled={editDisabled}/>
      {pickedEdit&&<LibraryCoverEditor key={picked.path+'-cover'} model={picked} onEdit={pickedEdit} disabled={editDisabled} blur={blurPicked}/>}
      <section className="library-detail-section"><h4>{t('library.organize')}</h4><label className="library-checkbox"><input type="checkbox" checked={isFavorite(picked.path)} onChange={()=>favorite(picked)}/>{t('library.favorites')}</label><label>{t('library.tags')}<input aria-label={t('library.editTags')} maxLength={500} placeholder={t('library.tagsHint')} key={picked.path} defaultValue={(annotation(picked.path)?.tags??[]).join(', ')} onBlur={e=>annotate(picked.path,{tags:[...new Set(e.currentTarget.value.split(',').map(tag=>tag.trim().slice(0,50)).filter(Boolean))].slice(0,20)})} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}}/></label><label>{t('library.notes')}<textarea data-library-notes maxLength={4000} rows={4} placeholder={t('library.notesHint')} value={annotation(picked.path)?.notes??''} onChange={e=>annotate(picked.path,{notes:e.target.value})}/></label><small>{t('library.savedLocally')}</small></section>
      <section className="library-popup-facts"><div><small>{t('downloads.version')}</small><p>{picked.info?.civitai?.version??'—'}</p></div><div><small>{t('modelMeta.filename')}</small><p>{filename(picked)}</p></div><div><small>{t('downloads.installed.path')}</small><p>{isTauri()?<button type="button" className="library-file-link" title={t('library.openFileFolder')} onClick={()=>openLink('native_media_reveal',{path:picked.path})}>{picked.path}</button>:picked.path}</p></div><div><small>{t('library.base')}</small><p>{familyOf(picked)||t('library.unclassified')}</p></div><div><small>{t('downloads.size')}</small><p>{sizeOf(picked.size)}</p></div><div><small>{t('library.modelId')}</small><p>{picked.info?.civitai?.modelId??'—'}</p></div><div><small>{t('library.versionId')}</small><p>{picked.info?.civitai?.versionId??'—'}</p></div><div><small>{t('downloads.digest')}</small><p>{picked.info?.sha256??t('downloads.installed.unhashed')}</p></div></section>
      {picked.info?.civitai?.description&&<section className="library-detail-section"><h4>{t('library.aboutVersion')}</h4><p className="library-version-description">{picked.info.civitai.description.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')}</p></section>}
      <div className="library-detail-actions">{picked.category==='loras'&&<button type="button" className="action-button" disabled={locked} onClick={()=>addLora(picked)}>{t('library.addLora')}</button>}<button type="button" className="action-button" onClick={()=>setEditing(true)}>{t('modelMeta.title')}</button></div>
      {notice}
      {editing&&<ModelMetadataEditor key={picked.path} model={picked} onClose={()=>setEditing(false)}/>}
      <div className="library-detail-section library-native-details">{renderDetail(picked)}</div>
      <button type="button" className="library-text-button" onClick={()=>void copy(picked.name,'filename')}>{copied==='filename'?t('library.copied'):t('library.copyFilename')}</button>
      {picked.category==='loras'&&<LibraryPromptExamples key={picked.path+'-examples'} model={picked} copy={copy} copied={copied} blur={blurPicked}/>}
      {copied==='error'&&<p role="alert">{t('library.copyError')}</p>}
     </aside></dialog>,document.body)}
    </div>
   </div>
  </div>
 </section>;
}
