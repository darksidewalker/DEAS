import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { MEDIA_DRAG, type MediaItem } from '../../lib/media';
import { ReferencesPanel, directorTags, forgeLabels, fromPack, h3ForgeContext, prefillItems, refsProblem, slotsOf, toPack, type VideoRef } from './ReferencesPanel';

const os=vi.hoisted(()=>({drop:null as null|((e:{payload:unknown})=>void)}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:vi.fn(()=>false),invoke:vi.fn(),convertFileSrc:(p:string)=>`asset://${p}`}));
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async(h:(e:{payload:unknown})=>void)=>{os.drop=h;return()=>{};}})}));
beforeEach(()=>localStorage.setItem('deas.locale.v1','en'));
afterEach(()=>{cleanup();vi.mocked(isTauri).mockReturnValue(false);os.drop=null;});
const item=(name:string,media:MediaItem['media']):MediaItem=>({name,media,src:`asset://${name}`,path:`/in/${name}`});
const ref=(name:string,media:MediaItem['media'],x:Partial<VideoRef>={}):VideoRef=>({item:item(name,media),second:0,strength:1,mediaMode:'video',...x});

test('Director labels follow the node load order: images, then video items (picture and/or sound), then audio files, each by slot',()=>{
 // An audio file picked before a sound-only video still comes after it, as in the Director's prefill and the node.
 const refs=[ref('song.wav','audio'),ref('talk.mp4','video',{mediaMode:'audio'}),ref('walk.mp4','video',{mediaMode:'video_audio'}),ref('a.png','image'),ref('b.png','image')];
 expect(slotsOf(refs)).toEqual([0,1,0,0,1]);
 expect(directorTags(refs)).toEqual(['<Audio 3>','<Audio 2>','<Video 1> <Audio 1>','<Picture 1>','<Picture 2>']);
});

test('limits and trims: too many sound tracks or a trim outside 2–15 s is a run problem',()=>{
 expect(refsProblem([ref('a.png','image')])).toBe('');
 expect(refsProblem([1,2,3,4].map(n=>ref(`${n}.wav`,'audio')))).toBe('studio.run.video.refFull');
 expect(refsProblem([ref('s.wav','audio',{trimStart:3,trimEnd:4})])).toBe('studio.run.video.trimInvalid');
 expect(refsProblem([ref('s.wav','audio',{trimStart:3,trimEnd:18.5})])).toBe('studio.run.video.trimInvalid');
 expect(refsProblem([ref('s.wav','audio',{trimStart:3})])).toBe(''); // the clip length is the node's to check
});

test('the panel reorders inside a lane, edits trims, inserts the label and removes',()=>{
 const onChange=vi.fn(),onInsert=vi.fn();
 const refs=[ref('a.png','image'),ref('s.wav','audio'),ref('b.png','image')];
 render(<I18nProvider><ReferencesPanel refs={refs} onChange={onChange} family="minimax-h3" seconds={5} label={(_,i)=>directorTags(refs)[i]} onAdd={vi.fn()} onInsert={onInsert}/></I18nProvider>);
 expect(screen.getByText('Images 2/9 · Videos 0/3 · Sound 1/3 · Files 3/12')).toBeTruthy();
 expect((screen.getByRole('button',{name:'Move a.png earlier'}) as HTMLButtonElement).disabled).toBe(true);
 expect((screen.getByRole('button',{name:'Move s.wav later'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Move a.png later'}));
 expect(onChange.mock.lastCall![0].map((r:VideoRef)=>r.item.name)).toEqual(['b.png','s.wav','a.png']); // swaps with the next image, skipping the audio
 fireEvent.change(screen.getByLabelText('End of s.wav'),{target:{value:'7.5'}});
 expect(onChange.mock.lastCall![0][1]).toMatchObject({trimEnd:7.5});
 expect(screen.queryByLabelText('Start of a.png')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Insert <Picture 2> into the prompt'}));
 expect(onInsert).toHaveBeenCalledWith('<Picture 2>');
 fireEvent.click(screen.getByRole('button',{name:'Remove reference s.wav'}));
 expect(onChange.mock.lastCall![0].map((r:VideoRef)=>r.item.name)).toEqual(['a.png','b.png']);
});

const mount=(refs:VideoRef[])=>{const onChange=vi.fn(),onAdd=vi.fn();render(<I18nProvider><ReferencesPanel refs={refs} onChange={onChange} family="minimax-h3" seconds={5} label={()=>''} onAdd={onAdd} onInsert={vi.fn()} inputRoot="/env/in"/></I18nProvider>);return {onChange,onAdd};};
const card=(name:string)=>document.querySelector(`[data-ref="${name}"]`)!;

test('dragging a card onto another of its lane moves it there; other lanes ignore it; a dock tile dropped on the tab is added',()=>{
 const {onChange,onAdd}=mount([ref('a.png','image'),ref('s.wav','audio'),ref('b.png','image')]);
 const none={types:[] as string[],getData:()=>''};
 fireEvent.dragStart(card('a.png').querySelector('strong')!,{dataTransfer:{setData:vi.fn(),effectAllowed:''}});
 fireEvent.drop(card('s.wav'),{dataTransfer:none});
 expect(onChange).not.toHaveBeenCalled();
 fireEvent.dragStart(card('a.png').querySelector('strong')!,{dataTransfer:{setData:vi.fn(),effectAllowed:''}});
 fireEvent.drop(card('b.png'),{dataTransfer:none});
 expect(onChange.mock.lastCall![0].map((r:VideoRef)=>r.item.name)).toEqual(['s.wav','b.png','a.png']);
 const tile=item('clip.mp4','video');
 fireEvent.drop(document.querySelector('[data-references]')!,{dataTransfer:{types:[MEDIA_DRAG],getData:(k:string)=>k===MEDIA_DRAG?JSON.stringify(tile):''}});
 expect(onAdd).toHaveBeenCalledWith([{item:tile}]);
});

test('native OS file drops add references only when dropped over the tab',async()=>{
 vi.mocked(isTauri).mockReturnValue(true);
 vi.mocked(invoke).mockResolvedValue([{name:'v.wav',path:'/os/v.wav',kind:'file',symlink:false,media:'audio',size:1,modified:1}]);
 const {onAdd}=mount([]);
 await waitFor(()=>expect(os.drop).not.toBeNull());
 Object.defineProperty(document.querySelector('[data-references]')!,'getBoundingClientRect',{value:()=>({left:0,top:0,right:100,bottom:100})});
 os.drop!({payload:{type:'drop',paths:['/os/v.wav'],position:{x:500*devicePixelRatio,y:10}}});
 expect(invoke).not.toHaveBeenCalled();
 os.drop!({payload:{type:'drop',paths:['/os/v.wav'],position:{x:20*devicePixelRatio,y:20*devicePixelRatio}}});
 await waitFor(()=>expect(onAdd).toHaveBeenCalledWith([{item:{name:'v.wav',path:'/os/v.wav',media:'audio',src:'asset:///os/v.wav'}}]));
 expect(invoke).toHaveBeenCalledWith('native_media_describe',{paths:['/os/v.wav']});
});

const at=(name:string,media:MediaItem['media'],dir='/env/in')=>({name,media,src:`asset://${dir}/${name}`,path:`${dir}/${name}`});
const refAt=(name:string,media:MediaItem['media'],x:Partial<VideoRef>={},dir='/env/in'):VideoRef=>({item:at(name,media,dir),second:0,strength:1,mediaMode:'video',...x});

test('Director reference packs: saved in the node\'s files format (type, then lane slot as _rank), input-relative, outside files skipped; read back safely',()=>{
 const refs=[refAt('voice.wav','audio',{trimStart:1,trimEnd:4}),refAt('deas-input-v.mp4','video',{mediaMode:'audio'}),refAt('sub/a.png','image'),refAt('out.png','image',{},'/env/out')];
 const {pack,skipped}=toPack(refs,'/env/in/',[{name:'chars/hero',strength:0.5,description:'the hero'}]);
 expect(skipped).toEqual(['out.png']);
 expect(pack).toMatchObject({dasiwa_minimax_h3_reference_pack:true,schema_version:1,model_mode:'REF2VA',items:[
  {type:'image',value:'sub/a.png',_rank:0},{type:'video',value:'deas-input-v.mp4',media_mode:'audio',_rank:0},{type:'audio',value:'voice.wav',trim_start:1,trim_end:4,_rank:0}],refmods:[{slot:1,name:'chars/hero',enabled:true,strength:0.5,description:'the hero'}]});
 expect(fromPack(JSON.parse(JSON.stringify(pack)),'/env/in')).toEqual({invalid:0,refmods:[{name:'chars/hero',strength:0.5,description:'the hero'}],adds:[{path:'/env/in/sub/a.png'},{path:'/env/in/deas-input-v.mp4',mediaMode:'audio'},{path:'/env/in/voice.wav',trimStart:1,trimEnd:4}]});
 // As the Director writes it: trim_start 0 / trim_end '' mean untrimmed; unsafe names never leave the input folder.
 const director={dasiwa_minimax_h3_reference_pack:true,schema_version:1,model_mode:'REF2VA',items:[
  {type:'audio',value:'s.wav',_rank:0,trim_start:0,trim_end:''},{type:'image',value:'b.png',_rank:1},{type:'image',value:'a.png',_rank:0},
  {type:'image',value:'../etc/x.png'},{type:'image',value:'/abs.png'},{type:'image',value:'C:/x.png'},{type:'image',value:'a\\b.png'},{type:'model',value:'m.bin'}],
  // Director RefMod rows: slot order, default strength 1, numeric strings, disabled rows dropped, bad names counted.
  refmods:[{slot:4,name:'place',strength:'0.5'},{slot:2,name:'hero'},{slot:3,name:'off',enabled:false},{slot:5,name:'../x',strength:1}]};
 expect(fromPack(director,'C:\\env\\in')).toEqual({invalid:6,refmods:[{name:'hero',strength:1,description:''},{name:'place',strength:0.5,description:''}],adds:[{path:'C:/env/in/a.png'},{path:'C:/env/in/b.png'},{path:'C:/env/in/s.wav'}]});
 expect(fromPack({items:[]},'/env/in')).toBeNull();
});

test('pack Save/Load go through the native JSON dialogs; missing files are reported, not added; Clear empties the list',async()=>{
 vi.mocked(isTauri).mockReturnValue(true);
 const pack={dasiwa_minimax_h3_reference_pack:true,schema_version:1,model_mode:'REF2VA',items:[{type:'image',value:'a.png',_rank:0},{type:'video',value:'gone.mp4',_rank:0,media_mode:'video_audio'}]};
 vi.mocked(invoke).mockImplementation(async(c,args)=>{
  if(c==='native_json_open')return JSON.stringify(pack);
  if(c==='native_json_save')return true;
  const [p]=(args as {paths:string[]}).paths;if(p.endsWith('gone.mp4'))throw Error('missing');
  return [{name:'a.png',path:p,kind:'file',symlink:false,media:'image',size:1,modified:1}];
 });
 const {onChange,onAdd}=mount([refAt('a.png','image'),refAt('far.png','image',{},'/elsewhere')]);
 fireEvent.click(screen.getByRole('button',{name:'Load pack (replace)…'}));
 await waitFor(()=>expect(onAdd).toHaveBeenCalledWith([{item:{name:'a.png',path:'/env/in/a.png',media:'image',src:'asset:///env/in/a.png'}}],true));
 expect(screen.getByRole('status').textContent).toBe('Loaded 1 references · 1 missing or invalid skipped');
 fireEvent.click(screen.getByRole('button',{name:'Save pack…'}));
 await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('Saved 1 references · skipped (not in the input folder): far.png'));
 const saved=JSON.parse((vi.mocked(invoke).mock.calls.find(([c])=>c==='native_json_save')![1] as {text:string}).text);
 expect(saved.items).toEqual([{type:'image',value:'a.png',_rank:0}]);
 fireEvent.click(screen.getByRole('button',{name:'Clear'}));
 expect(onChange).toHaveBeenCalledWith([]);
});

test('RefMods: read the library on demand, add, edit strength/description, insert the alias, remove',async()=>{
 const onRefmods=vi.fn(),onInsert=vi.fn();
 const library=vi.fn(async()=>[{name:'chars/hero',kinds:['image' as const,'audio' as const],description:'the hero'}]);
 const {rerender}=render(<I18nProvider><ReferencesPanel refs={[]} onChange={vi.fn()} family="minimax-h3" seconds={5} label={()=>''} onAdd={vi.fn()} onInsert={onInsert} refmods={[]} onRefmods={onRefmods} library={library}/></I18nProvider>);
 expect(library).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Read RefMod library'}));
 expect((await screen.findByRole('option',{name:'chars/hero (image + audio)'}))).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Add RefMod'}));
 expect(onRefmods).toHaveBeenLastCalledWith([{name:'chars/hero',strength:1,description:'the hero',kinds:['image','audio']}]);
 const rows=[{name:'chars/hero',strength:1,description:'the hero'}];
 rerender(<I18nProvider><ReferencesPanel refs={[]} onChange={vi.fn()} family="minimax-h3" seconds={5} label={()=>''} onAdd={vi.fn()} onInsert={onInsert} refmods={rows} onRefmods={onRefmods} library={library}/></I18nProvider>);
 fireEvent.change(screen.getByLabelText('Strength of chars/hero'),{target:{value:'0.4'}});
 expect(onRefmods).toHaveBeenLastCalledWith([{name:'chars/hero',strength:0.4,description:'the hero'}]);
 fireEvent.change(screen.getByLabelText('Description of chars/hero'),{target:{value:'red coat'}});
 expect(onRefmods).toHaveBeenLastCalledWith([{name:'chars/hero',strength:1,description:'red coat'}]);
 fireEvent.click(screen.getByRole('button',{name:'Insert <RefMod 1> into the prompt'}));
 expect(onInsert).toHaveBeenCalledWith('<RefMod 1>');
 fireEvent.click(screen.getByRole('button',{name:'Remove reference chars/hero'}));
 expect(onRefmods).toHaveBeenLastCalledWith([]);
});

test.each([false,true])('a pack loaded after the library hydrates RefMod kinds from cached entries (replace=%s)',async replace=>{
 vi.mocked(isTauri).mockReturnValue(true);
 const library=vi.fn(async()=>[{name:'chars/hero',kinds:['image' as const,'audio' as const],description:'library description'}]);
 const rows=[{name:'chars/hero',strength:0.4,description:'pack description'},{name:'unknown',strength:1,description:''}];
 vi.mocked(invoke).mockImplementation(async c=>c==='native_json_open'?JSON.stringify(toPack([],'/env/in',rows).pack):undefined);
 const onRefmods=vi.fn();
 render(<I18nProvider><ReferencesPanel refs={[]} onChange={vi.fn()} family="minimax-h3" seconds={5} label={()=>''} onAdd={vi.fn()} onInsert={vi.fn()} inputRoot="/env/in" refmods={[{name:'existing',strength:0.7,description:'keep',kinds:['video']}]} onRefmods={onRefmods} library={library}/></I18nProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Read RefMod library'}));
 await screen.findByRole('option',{name:'chars/hero (image + audio)'});
 onRefmods.mockClear();
 fireEvent.click(screen.getByRole('button',{name:replace?'Load pack (replace)…':'Load pack (add)…'}));
 const incoming=[{...rows[0],kinds:['image','audio']},{...rows[1],kinds:undefined}];
 await waitFor(()=>expect(onRefmods).toHaveBeenLastCalledWith([...(replace?[]:[{name:'existing',strength:0.7,description:'keep',kinds:['video']}]),...incoming]));
 expect(library).toHaveBeenCalledTimes(1);
});

test('Save pack is disabled when empty and saves RefMods-only packs through the native dialog',async()=>{
 vi.mocked(isTauri).mockReturnValue(true);
 vi.mocked(invoke).mockResolvedValue(true);
 const rows=[{name:'chars/hero',strength:0.4,description:'red coat',kinds:['image']}];
 const view=(refmods:typeof rows)=><I18nProvider><ReferencesPanel refs={[]} onChange={vi.fn()} family="minimax-h3" seconds={5} label={()=>''} onAdd={vi.fn()} onInsert={vi.fn()} inputRoot="/env/in" refmods={refmods} onRefmods={vi.fn()}/></I18nProvider>;
 const {rerender}=render(view([]));
 expect((screen.getByRole('button',{name:'Save pack…'}) as HTMLButtonElement).disabled).toBe(true);
 rerender(view(rows));
 expect((screen.getByRole('button',{name:'Save pack…'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Save pack…'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_json_save',expect.anything()));
 const saved=JSON.parse((vi.mocked(invoke).mock.calls.find(([c])=>c==='native_json_save')![1] as {text:string}).text);
 expect(saved.items).toEqual([]);
 expect(saved.refmods).toEqual([{slot:1,name:'chars/hero',enabled:true,strength:0.4,description:'red coat'}]);
});

test('Director Forge context follows the intent: frame modes from first/last frame, REF2VA references in node order with input paths only',()=>{
 const canvas={width:1024,height:576},base={media:null,lastFrame:null,refs:[],sourceAudio:false,seconds:5,canvas,inputRoot:'/env/in'};
 expect(h3ForgeContext({...base,pipeline:'t2v'})).toEqual({mode:'T2VA',duration:5,canvas,references:[],easy:false});
 const first=at('a.png','image'),last=at('z.png','image','/elsewhere');
 expect(h3ForgeContext({...base,pipeline:'t2v',lastFrame:last}).mode).toBe('L2VA');
 expect(h3ForgeContext({...base,pipeline:'i2v',media:first,lastFrame:last})).toEqual({mode:'FL2VA',duration:5,canvas,easy:false,references:[
  {kind:'image',path:'a.png',role:'keyframe',subject_group:''},{kind:'image',role:'keyframe',subject_group:''}]});
 expect(h3ForgeContext({...base,pipeline:'v2v',media:at('v.mp4','video'),sourceAudio:true}).references).toEqual([{kind:'video',role:'motion',stream:'both'}]);
 const refs=[refAt('s.wav','audio',{trimStart:1,trimEnd:4}),refAt('v.mp4','video',{mediaMode:'audio'}),refAt('p.png','image')];
 expect(h3ForgeContext({...base,pipeline:'ref2v',refs}).references).toEqual([
  {kind:'image',path:'p.png',role:'subject',subject_group:'A',easy_role:'character-1'},{kind:'video',role:'motion',stream:'audio'},{kind:'audio',duration_seconds:3}]);
 expect(h3ForgeContext({...base,pipeline:'ref2v',refs}).easy).toBe(false); // labels apply only when every reference is a picture
});

test('Director picture labels: chosen labels stay, the rest take the next free Character; roles, groups and instructions reach the Forge; packs keep them',()=>{
 const canvas={width:1024,height:576};
 const refs=[refAt('a.png','image'),refAt('b.png','image',{label:'character-1'}),refAt('c.png','image',{label:'place',instructions:' the old harbour '}),refAt('d.png','image',{label:'custom',instructions:'the coat'})];
 expect(forgeLabels(refs)).toEqual(['character-2','character-1','place','custom']);
 expect(forgeLabels([refAt('s.wav','audio'),refAt('x.png','image',{label:'bogus'})])).toEqual(['','character-1']);
 const ctx=h3ForgeContext({pipeline:'ref2v',media:null,lastFrame:null,refs,sourceAudio:false,seconds:5,canvas,inputRoot:'/env/in'});
 expect(ctx.easy).toBe(true);
 expect(ctx.references).toEqual([
  {kind:'image',path:'a.png',role:'subject',subject_group:'B',easy_role:'character-2'},
  {kind:'image',path:'b.png',role:'subject',subject_group:'A',easy_role:'character-1'},
  {kind:'image',path:'c.png',role:'subject',subject_group:'',easy_role:'place',instructions:'the old harbour'},
  {kind:'image',path:'d.png',role:'custom',subject_group:'',easy_role:'custom',instructions:'the coat'}]);
 const {pack}=toPack(refs,'/env/in');
 expect(pack.items.map(i=>[(i as {forge_label?:string}).forge_label,(i as {forge_instructions?:string}).forge_instructions])).toEqual([[undefined,undefined],['character-1',undefined],['place','the old harbour'],['custom','the coat']]);
 expect(fromPack(pack,'/env/in')!.adds.map(a=>[a.label,a.instructions])).toEqual([[undefined,undefined],['character-1',undefined],['place','the old harbour'],['custom','the coat']]);
});

test('the panel edits the picture label and instructions',()=>{
 const onChange=vi.fn();
 render(<I18nProvider><ReferencesPanel refs={[refAt('a.png','image')]} onChange={onChange} family="minimax-h3" seconds={5} label={()=>''} onAdd={vi.fn()} onInsert={vi.fn()}/></I18nProvider>);
 const select=screen.getByLabelText('Forge label of a.png') as HTMLSelectElement;
 expect(select.value).toBe('character-1');
 expect(screen.getByRole('option',{name:'Character 1'})).toBeTruthy();
 fireEvent.change(select,{target:{value:'style'}});
 expect(onChange.mock.lastCall![0][0]).toMatchObject({label:'style'});
 fireEvent.change(screen.getByLabelText('Forge instructions for a.png'),{target:{value:'the brush strokes'}});
 expect(onChange.mock.lastCall![0][0]).toMatchObject({instructions:'the brush strokes'});
});

test('keep / ignore reach the Forge and packs; the description feeds the prefill only',()=>{
 const refs=[refAt('a.png','image',{keep:' the coat ',drop:'the rain',description:'hero in red'})];
 const ctx=h3ForgeContext({pipeline:'ref2v',media:null,lastFrame:null,refs,sourceAudio:false,seconds:5,canvas:{width:64,height:64},inputRoot:'/env/in'});
 expect(ctx.references[0]).toMatchObject({keep:'the coat',drop:'the rain'});
 expect(ctx.references[0]).not.toHaveProperty('description');
 const {pack}=toPack(refs,'/env/in');
 expect(pack.items[0]).toMatchObject({forge_keep:'the coat',forge_drop:'the rain'});
 expect(pack.items[0]).not.toHaveProperty('prompt');
 expect(fromPack(pack,'/env/in')!.adds[0]).toMatchObject({keep:'the coat',drop:'the rain'});
 expect(prefillItems(refs)).toEqual([{type:'image',slot:0,mediaMode:'video',description:'hero in red'}]);
 const onChange=vi.fn();
 render(<I18nProvider><ReferencesPanel refs={refs} onChange={onChange} family="minimax-h3" seconds={5} label={()=>''} onAdd={vi.fn()} onInsert={vi.fn()}/></I18nProvider>);
 fireEvent.change(screen.getByLabelText('Ignore from a.png'),{target:{value:'the umbrella'}});
 expect(onChange.mock.lastCall![0][0]).toMatchObject({drop:'the umbrella',keep:' the coat '});
});
