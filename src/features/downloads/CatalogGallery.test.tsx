import { useState } from 'react';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { CatalogGallery,type CatalogCard } from './CatalogGallery';
const fox:CatalogCard={id:'fox',identity:'["hf","Repo","Fox"]',label:'Fox',provider:'HuggingFace',category:'loras',base:'SDXL',media:'image',nsfw:true};
const lamp:CatalogCard={id:'lamp',identity:'["civitai","loras","2"]',label:'Lamp',provider:'CivitAI',category:'loras',media:'video'};
const open=vi.fn();
function Host({items=[fox,lamp],locked=false}:{items?:CatalogCard[];locked?:boolean}){const [query,onQuery]=useState(''),[base,onBase]=useState(''),[media,onMedia]=useState<'all'|'image'|'video'>('all'),[selected,setSelected]=useState('');return <I18nProvider><input aria-label="Parent search" value={query} onChange={e=>onQuery(e.target.value)}/><CatalogGallery items={items} selectedId={selected} onOpen={item=>{open(item);setSelected(item.id);}} query={query} onQuery={onQuery} base={base} onBase={onBase} media={media} onMedia={onMedia} locked={locked} picker={<div data-testid="picker"/>}><nav data-testid="categories"/></CatalogGallery></I18nProvider>;}
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');open.mockClear();});afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('reuses gallery appearance and delegates selection without adding another search',()=>{
 render(<Host/>);expect(screen.getAllByRole('textbox')).toHaveLength(1);
 expect(document.querySelector('.download-preview.library-placeholder svg')).toBeTruthy();
 expect(screen.getByTestId('categories').compareDocumentPosition(document.querySelector('.library-layout')!)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Fox'}));expect(open).toHaveBeenCalledWith(fox);
 expect(document.querySelector('.library-card.is-selected')?.nextElementSibling).toBe(screen.getByTestId('picker'));
 expect(screen.queryByRole('dialog')).toBeNull();
});

it('saves favorites, tags and notes in a modal and searches personal metadata',async()=>{
 const view=render(<Host/>);const details=screen.getByRole('button',{name:'Model details: Fox'});details.focus();fireEvent.click(details);
 expect(screen.getByRole('dialog',{name:'Model details'})).toBeTruthy();expect(open).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('Personal notes'),{target:{value:'warm lighting'}});
 fireEvent.change(screen.getByLabelText('Edit model tags'),{target:{value:'portrait, warm, portrait'}});fireEvent.blur(screen.getByLabelText('Edit model tags'));
 fireEvent.click(screen.getByLabelText('Favorites',{selector:'input'}));
 fireEvent.click(screen.getByRole('button',{name:'Close model details'}));
 await waitFor(()=>expect(document.activeElement).toBe(details));
 expect(JSON.parse(localStorage.getItem('deas.pref.library.catalog.organization')!)[fox.identity]).toEqual({notes:'warm lighting',tags:['portrait','warm'],favorite:true});
 view.unmount();render(<Host/>);fireEvent.change(screen.getByLabelText('Parent search'),{target:{value:'warm portrait'}});
 expect(screen.getByRole('button',{name:'Fox'})).toBeTruthy();expect(screen.queryByRole('button',{name:'Lamp'})).toBeNull();
});

it('filters actual bases/media/metadata and provider folders with independent hidden groups',()=>{
 const view=render(<Host/>);fireEvent.change(screen.getByLabelText('Base model'),{target:{value:'SDXL'}});expect(screen.queryByRole('button',{name:'Lamp'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));fireEvent.change(screen.getByLabelText('Model type'),{target:{value:'video'}});expect(screen.queryByRole('button',{name:'Fox'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));fireEvent.click(screen.getByRole('treeitem',{name:'CivitAI'}));expect(screen.queryByRole('button',{name:'Fox'})).toBeNull();
 fireEvent.click(screen.getByRole('treeitem',{name:'All folders'}));fireEvent.click(screen.getByRole('button',{name:'Add Fox to favorites'}));fireEvent.click(screen.getByRole('button',{name:'Hide HuggingFace folder'}));expect(screen.queryByRole('button',{name:'Fox'})).toBeNull();
 fireEvent.change(screen.getByLabelText('Parent search'),{target:{value:'absent'}});fireEvent.click(screen.getByRole('button',{name:'Favorites'}));expect(screen.getByRole('button',{name:'Fox'})).toBeTruthy();expect(screen.queryByRole('button',{name:'Lamp'})).toBeNull();
 fireEvent.click(screen.getByRole('treeitem',{name:'All folders'}));expect(screen.queryByRole('button',{name:'Fox'})).toBeNull();
 view.unmount();render(<Host/>);expect(screen.queryByRole('button',{name:'Fox'})).toBeNull();expect(localStorage.getItem('deas.pref.library.local.hiddenFolders')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Show HuggingFace folder'}));fireEvent.change(screen.getByLabelText('Metadata'),{target:{value:'missing'}});expect(screen.queryByRole('button',{name:'Fox'})).toBeNull();
});

it('bounds cards, supports list/manual and automatic paging and omits unsupported remote sorts',async()=>{
 const items=Array.from({length:125},(_,index)=>({...fox,id:String(index),identity:String(index),label:`Model ${index}`}));
 const view=render(<Host items={items}/>);expect(document.querySelectorAll('.library-card')).toHaveLength(60);
 expect(document.querySelector('option[value="mostUsed"]')).toBeNull();expect(document.querySelector('option[value="mostVersions"]')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Show 60 more'}));expect(document.querySelectorAll('.library-card')).toHaveLength(120);
 fireEvent.click(screen.getByRole('button',{name:'List view'}));expect(document.querySelector('.library-card-grid.is-list')).toBeTruthy();
 fireEvent.click(screen.getByLabelText('View all'));await waitFor(()=>expect(document.querySelectorAll('.library-card')).toHaveLength(125));
 view.unmount();render(<Host items={items}/>);expect(screen.getByLabelText('View all')).toHaveProperty('checked',true);expect(screen.getByRole('button',{name:'List view'}).getAttribute('aria-pressed')).toBe('true');
 await waitFor(()=>expect(document.querySelectorAll('.library-card')).toHaveLength(125));
});

it('sorts unknown dates and sizes last in both directions without invented values',()=>{
 render(<Host items={[{...fox,publishedAt:'2025-01-01',size:200},{...lamp,publishedAt:'2024-01-01',size:100},{...fox,id:'unknown',identity:'unknown',label:'AAA',publishedAt:'invalid'}]}/>);
 const labels=()=>[...document.querySelectorAll('.library-card-main')].map(node=>node.getAttribute('aria-label'));
 for(const [sort,expected] of [['newest',['Fox','Lamp','AAA']],['oldest',['Lamp','Fox','AAA']],['size',['Fox','Lamp','AAA']],['smallest',['Lamp','Fox','AAA']]] as const){fireEvent.change(screen.getByLabelText('Sort models'),{target:{value:sort}});expect(labels()).toEqual(expected);}
});
it('renders provider/auth/mature badges with still previews and a fallback instead of embedded video',()=>{
 render(<Host items={[{...fox,authRequired:true,preview:'https://example.com/fox.jpg'},{...lamp,preview:'https://example.com/lamp.mp4'}]}/>);
 expect(document.querySelector('em.download-auth.download-platform')?.getAttribute('title')).toBe('HuggingFace');
 expect(document.querySelectorAll('em.download-auth')).toHaveLength(3);
 expect(document.querySelector('.library-mature-badge')).toBeTruthy();expect(document.querySelector('.library-card.is-sensitive')).toBeTruthy();
 expect(document.querySelector('video.download-preview')).toBeNull();fireEvent.error(document.querySelector('img.download-preview')!);expect(document.querySelector('.download-preview.library-placeholder')).toBeTruthy();
 fireEvent.click(screen.getByLabelText('Blur mature previews'));expect(document.querySelector('.library-card.is-sensitive')).toBeNull();
});
it('uses showModal and closes with Escape or a genuine backdrop click, returning focus',async()=>{
 const show=vi.fn(function(this:HTMLDialogElement){this.setAttribute('open','');});Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:show});
 render(<Host/>);const button=screen.getByRole('button',{name:'Model details: Fox'});button.focus();fireEvent.click(button);expect(show).toHaveBeenCalledTimes(1);
 fireEvent(screen.getByRole('dialog'),new Event('cancel',{cancelable:true}));expect(screen.queryByRole('dialog')).toBeNull();await waitFor(()=>expect(document.activeElement).toBe(button));
 fireEvent.click(button);const dialog=screen.getByRole('dialog');fireEvent.click(dialog,{clientX:5,clientY:5});expect(screen.getByRole('dialog')).toBeTruthy();
 fireEvent(dialog,new MouseEvent('pointerdown',{bubbles:true,clientX:-5,clientY:-5}));fireEvent.click(dialog,{clientX:-5,clientY:-5});expect(screen.queryByRole('dialog')).toBeNull();await waitFor(()=>expect(document.activeElement).toBe(button));
});

it('keeps locked card actions inert, ignores absent selections and refuses non-HTTPS previews',()=>{
 render(<Host locked items={[{...fox,preview:'file:///private/model.png'}]}/>);
 const card=screen.getByRole('button',{name:'Fox'});expect(card).toHaveProperty('disabled',true);fireEvent.click(card);expect(open).not.toHaveBeenCalled();
 expect(screen.queryByTestId('picker')).toBeNull();expect(document.querySelector('img')).toBeNull();expect(document.querySelector('.library-placeholder')).toBeTruthy();
});

it.each(['escape','backdrop'])('persists focused tag edits before %s dismissal',method=>{
 render(<Host/>);fireEvent.click(screen.getByRole('button',{name:'Model details: Fox'}));
 const input=screen.getByLabelText('Edit model tags');input.focus();
 fireEvent.change(input,{target:{value:'portrait, warm'}});
 const dialog=screen.getByRole('dialog');
 if(method==='escape')fireEvent(dialog,new Event('cancel',{cancelable:true}));
 else{fireEvent(dialog,new MouseEvent('pointerdown',{bubbles:true,clientX:-5,clientY:-5}));fireEvent.click(dialog,{clientX:-5,clientY:-5});}
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(JSON.parse(localStorage.getItem('deas.pref.library.catalog.organization')!)[fox.identity].tags).toEqual(['portrait','warm']);
});
