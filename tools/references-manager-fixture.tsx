import { ImageReferencesManager } from '../src/features/studio/ImageReferencesManager';
/** Synthetic UI-only fixture: no backend, files, model discovery or generation. */
import { useState } from 'react';
import {createRoot} from 'react-dom/client';
import {I18nProvider} from '../src/i18n/I18nProvider';
import {ReferencesOverlay} from '../src/features/studio/ReferencesOverlay';
import {ReferencesPanel,directorTags,type VideoRef,type RefMod} from '../src/features/studio/ReferencesPanel';
import {ReferenceAssignmentBar} from '../src/features/studio/ReferenceAssignmentBar';
import {MediaLibrary} from '../src/features/media/MediaLibrary';
import type {MediaItem} from '../src/lib/media';
import type {RefModEntry} from '../src/lib/jobs';
import '../src/styles.css';
const svg='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#305860"/><circle cx="120" cy="60" r="28" fill="#d5bd9e"/><path d="M60 180V130Q120 70 180 130V180" fill="#81ad98"/></svg>');
const make=(media:'image'|'video'|'audio',n:number):VideoRef=>({uiKey:`${media}-${n}`,item:{name:`${media}-${n}-long-reference-name.png`,media,path:`/fixture/${media}-${n}`,src:media==='image'?svg+`#${n}`:`/fixture/${media}-${n}`},second:0,strength:1,mediaMode:'video',trimStart:0,trimEnd:5});
const library=async()=>Array.from({length:8},(_,i)=>({name:`Identity and style ${i+1}`,description:`Synthetic description ${i+1}`,kinds:['image']} as RefModEntry));
function Fixture(){
 const imageEdit=new URLSearchParams(location.search).has('imageEdit');
 const [source,setSource]=useState<MediaItem|null>(null),[imageRefs,setImageRefs]=useState<{item:MediaItem;strength:number}[]>([]);
 const useSource=(item:MediaItem,index=imageRefs.findIndex(r=>r.item.src===item.src))=>{if(index>=0)setImageRefs(old=>source?old.map((r,i)=>i===index?{...r,item:source}:r):old.filter((_,i)=>i!==index));setSource(item);};
 const [open,setOpen]=useState(true),[refs,setRefs]=useState<VideoRef[]>([]),[mods,setMods]=useState<RefMod[]>([]),[selected,setSelected]=useState<MediaItem|null>(null),[inserted,setInserted]=useState('');
 const fill=(full:boolean)=>{setSource(full?make('image',0).item:null);setImageRefs(full?Array.from({length:8},(_,i)=>({item:make('image',i+1).item,strength:.6})):[]);setRefs(full?[...Array.from({length:9},(_,i)=>make('image',i)),...Array.from({length:3},(_,i)=>make('video',i)),...Array.from({length:3},(_,i)=>make('audio',i))]:[]);setMods(full?Array.from({length:8},(_,i)=>({name:`Identity and style ${i+1}`,description:`Synthetic description ${i+1}`,strength:.8,kinds:['image']})):[]);};
 return <><button onClick={()=>setOpen(true)}>Open references</button><output data-inserted>{inserted}</output>{open&&<ReferencesOverlay manager imageEdit={imageEdit} subtitle={imageEdit?'MiniMax H3 · Image edit':'MiniMax H3 · REF2VA'} onClose={()=>setOpen(false)} picker={<><div className="media-toolbar"><button data-fixture-fill onClick={()=>fill(true)}>Fill fixture</button><button data-fixture-empty onClick={()=>fill(false)}>Empty fixture</button></div><MediaLibrary selected={selected} onSelect={setSelected} roots={{input:'/fixture/input',output:'/fixture/output'}}/></>}>
  {imageEdit?<ImageReferencesManager source={source} refs={imageRefs} selected={selected} max={8} valid={item=>!!item&&item.media==='image'&&!!item.path} onAdd={items=>{const nextSource=source??items[0];if(!source&&nextSource)setSource(nextSource);setImageRefs(old=>[...old,...items.filter(item=>item.path!==nextSource?.path).map(item=>({item,strength:.6}))].slice(0,8));}} onSource={useSource} onClearSource={()=>{const [first,...rest]=imageRefs;setSource(first?.item??null);setImageRefs(rest);}} onChange={setImageRefs} onInsert={setInserted}/>:<ReferencesPanel manager inputRoot="/fixture/input" refs={refs} onChange={setRefs} onAdd={adds=>setRefs(old=>[...old,...adds.map(x=>({...make('image',old.length),...x}))])} family="minimax-h3" seconds={5} label={(_,i)=>directorTags(refs)[i]} onInsert={setInserted} refmods={mods} onRefmods={setMods} library={library}
   assignment={<ReferenceAssignmentBar selected={selected} actions={[{id:'reference',label:'Reference',assign:()=>selected&&setRefs(old=>[...old,{uiKey:crypto.randomUUID(),item:selected,second:0,strength:1,mediaMode:'video'}])}]}/>}/>}
 </ReferencesOverlay>}</>;
}
createRoot(document.getElementById('fixture-root')!).render(<I18nProvider><Fixture/></I18nProvider>);
