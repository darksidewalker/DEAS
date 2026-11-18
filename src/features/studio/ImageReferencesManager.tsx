import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useI18n } from '../../i18n/I18nProvider';
import { usePointerReorder } from '../../components/usePointerReorder';
import { describeMedia, draggedItem, dropCssPoint, itemFromEntry, MEDIA_DRAG, type MediaItem } from '../../lib/media';
import { ReferenceHeaderTools } from './ReferenceManagerWorkspace';
import { ReferenceActionButton } from './ReferenceActionButton';
import { ReferenceEditorDialog } from './ReferenceEditorDialog';

type ImageRef={item:MediaItem;strength:number};
type Props={source:MediaItem|null;refs:ImageRef[];selected:MediaItem|null;max:number;valid:(item:MediaItem|null)=>boolean;onAdd:(items:MediaItem[])=>void;onSource:(item:MediaItem,index?:number)=>void;onClearSource:()=>void;onChange:(refs:ImageRef[])=>void;onInsert:(tag:string)=>void;onReplace?:(index:number,item:MediaItem)=>void;replaceAllowed?:boolean};
/** Image edit keeps Picture 1 pinned; only the following reference pictures reorder. */
export function ImageReferencesManager({source,refs,selected,max,valid,onAdd,onSource,onClearSource,onChange,onInsert,onReplace,replaceAllowed=false}:Props) {
 const {t}=useI18n(),header=useContext(ReferenceHeaderTools),root=useRef<HTMLDivElement>(null),ids=useRef(new WeakMap<ImageRef,string>());
 const keyOf=(r:ImageRef)=>{let key=ids.current.get(r);if(!key){key=crypto.randomUUID();ids.current.set(r,key);}return key;};
 const [preview,setPreview]=useState<{item:MediaItem;opener:HTMLButtonElement}|null>(null),[error,setError]=useState('');
 const current=useRef({onAdd,valid});current.current={onAdd,valid};
 const logged=useRef(false);const report=(error:unknown)=>{setError(String(error));if(!logged.current){logged.current=true;void invoke('native_logs_reference_media_error').catch(()=>{});}};
 const reorder=usePointerReorder(refs.map(keyOf),keys=>{const byKey=new Map(refs.map(r=>[keyOf(r),r]));onChange(keys.flatMap(key=>byKey.has(key)?[byKey.get(key)!]:[]));},{root,rowSelector:'[data-image-ref-key]',keyAttribute:'data-image-ref-key',scrollSelector:'.reference-pane-list'});
 useEffect(()=>{if(!isTauri())return;let alive=true,stop:(()=>void)|undefined;void getCurrentWebview().onDragDropEvent(event=>{if(event.payload.type!=='drop')return;const p=dropCssPoint(event.payload.position),r=root.current?.getBoundingClientRect();if(!r||p.x<r.left||p.x>r.right||p.y<r.top||p.y>r.bottom||Array.from(document.querySelectorAll('dialog[open]')).some(d=>!d.contains(root.current)))return;void describeMedia(event.payload.paths).then(entries=>{if(alive)current.current.onAdd(entries.map(itemFromEntry).flatMap(item=>item&&current.current.valid(item)?[item]:[]));},e=>{if(alive)report(e);});}).then(unlisten=>{if(alive)stop=unlisten;else unlisten();},e=>{if(alive)report(e);});return()=>{alive=false;stop?.();};},[]);
 const open=(item:MediaItem,opener:HTMLButtonElement)=>setPreview({item,opener});
 const move=(index:number,direction:number)=>{const to=index+direction;if(to<0||to>=refs.length)return;const next=[...refs];next.splice(to,0,next.splice(index,1)[0]);onChange(next);};
 const clear=<div className="reference-pack-tools"><button type="button" className="wb-dock-action" data-image-role="reference" disabled={!selected||!valid(selected)||!!source&&(selected.path===source.path||refs.length>=max)} title={selected?.name} onClick={()=>{if(selected&&valid(selected))onAdd([selected]);}}>{t('studio.run.video.addRef')}</button><button type="button" className="wb-dock-action" disabled={!refs.length} onClick={()=>onChange([])}>{t('studio.run.video.refsClear')}</button></div>;
 return <div ref={root} {...reorder.events} className="reference-manager image-reference-manager" data-image-references onDragOver={e=>{if(e.dataTransfer.types.includes(MEDIA_DRAG))e.preventDefault();}} onDrop={e=>{const item=draggedItem(e.dataTransfer);if(item&&valid(item)){e.preventDefault();onAdd([item]);}}}>
  <div className="reference-assigned-heading"><h3>{t('studio.run.dock.type.image')}</h3><span className="reference-count">{`${refs.length+(source?1:0)} / ${max+1}`}</span>{header?createPortal(clear,header):clear}</div>
  <div className="reference-feedback">{error?<span role="alert">{error}</span>:t('studio.run.reference.h3Tags')}</div>
  <section className="image-reference-source" data-reference-source role="group" aria-label={t('studio.run.reference.sourceCard')} onDragOver={e=>{if(e.dataTransfer.types.includes(MEDIA_DRAG))e.preventDefault();}} onDrop={e=>{const item=draggedItem(e.dataTransfer);if(item&&valid(item)){e.preventDefault();e.stopPropagation();onSource(item);}}}>
   <button type="button" className="reference-thumb" disabled={!source} aria-label={t('studio.run.reference.preview',{name:source?.name??t('studio.run.reference.sourceEmpty')})} onClick={e=>source&&open(source,e.currentTarget)}>{source?<img src={source.src} alt={source.name} draggable={false}/>:<span aria-hidden="true">◇</span>}</button>
   <div className="image-source-name"><span className="media-mark wb-reference-position">{1}</span><strong title={source?.path}>{source?.name??t('studio.run.reference.sourceEmpty')}</strong><small>{t('studio.run.reference.sourceCard')}</small></div>
   <div className="reference-card-actions"><ReferenceActionButton kind="insert" label={t('studio.run.video.insertLabel',{label:'<Picture 1>'})} onClick={()=>onInsert('<Picture 1>')} disabled={!source}/><ReferenceActionButton kind="remove" data-reference-source-remove label={t('studio.run.reference.sourceRemove')} onClick={onClearSource} disabled={!source}/></div>
  </section>
  <section className="reference-manager-pane reference-manager-image image-edit-grid" aria-label={t('studio.run.dock.type.image')}>
   <header className="reference-pane-heading"><h3>{t('studio.run.dock.references')}</h3><span className="reference-count">{`${refs.length} / ${max}`}</span></header>
   <ul className="reference-pane-list">{!refs.length&&<li className="reference-empty">{t('studio.run.video.referencesEmpty')}</li>}{refs.map((r,i)=><li className={`wb-ref reference-manager-card${reorder.dragging===keyOf(r)?' is-reordering':''}`} key={keyOf(r)} data-image-ref-key={keyOf(r)} data-reference-controls data-reference-position={i+1} data-history-reference-unresolved={!r.item.path||undefined} onDragOver={e=>{if(!r.item.path&&e.dataTransfer.types.includes(MEDIA_DRAG))e.preventDefault();}} onDrop={e=>{const item=draggedItem(e.dataTransfer);if(!r.item.path&&item&&valid(item)&&replaceAllowed){e.preventDefault();e.stopPropagation();onReplace?.(i,item);}}}>
    <button type="button" className="reference-drag-grip" {...reorder.handle(keyOf(r))} aria-label={t('studio.run.video.referencesReorder',{name:r.item.name})} title={t('studio.run.video.referencesReorder',{name:r.item.name})}>⠿</button>
    <button type="button" className="reference-thumb" data-preview-reference aria-label={t('studio.run.reference.preview',{name:r.item.name})} disabled={!r.item.path} onClick={e=>open(r.item,e.currentTarget)}>{r.item.path?<img src={r.item.src} alt={r.item.name} draggable={false}/>:<span role="status" title={r.item.name}>{t('studio.history.missingInput',{name:r.item.name})}</span>}</button>
    <strong className="reference-card-heading" title={r.item.path??r.item.name}><span className="media-mark wb-reference-position">{i+2}</span><span className="reference-card-name">{r.item.name}</span></strong>
    <p className="reference-card-summary">{r.item.path?`<Picture ${i+2}>`:t('studio.history.referenceReselect')}</p><div className="reference-card-actions">
     <ReferenceActionButton kind="earlier" label={t('studio.run.video.moveEarlier',{name:r.item.name})} disabled={!i} onClick={()=>move(i,-1)}/>
     <ReferenceActionButton kind="later" label={t('studio.run.video.moveLater',{name:r.item.name})} disabled={i===refs.length-1} onClick={()=>move(i,1)}/>
     {r.item.path?<ReferenceActionButton kind="source" data-reference-make-source label={t('studio.run.reference.useSource')} onClick={()=>onSource(r.item,i)}/>:<ReferenceActionButton kind="source" data-history-reference-select={i} label={t('studio.history.referenceUseSelected',{position:i+1})} disabled={!replaceAllowed||!selected||!valid(selected)} onClick={()=>selected&&onReplace?.(i,selected)}/>}
     <ReferenceActionButton kind="insert" data-reference-insert label={t('studio.run.video.insertLabel',{label:`<Picture ${i+2}>`})} onClick={()=>onInsert(`<Picture ${i+2}>`)}/>
     <ReferenceActionButton kind="remove" data-reference-remove label={`${t('studio.run.reference.remove')} · ${i+1}`} onClick={()=>onChange(refs.filter((_,j)=>j!==i))}/>
    </div>
   </li>)}</ul>
  </section>
  {preview&&<ReferenceEditorDialog name={preview.item.name} heading={t('studio.run.reference.preview',{name:preview.item.name})} onClose={()=>setPreview(null)} restoreFocus={()=>preview.opener.isConnected?preview.opener:null}><img className="image-reference-preview" src={preview.item.src} alt={preview.item.name}/><p>{preview.item.name}</p></ReferenceEditorDialog>}
 </div>;
}
