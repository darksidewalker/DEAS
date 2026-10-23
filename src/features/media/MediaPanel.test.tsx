import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { MediaLibrary } from './MediaLibrary';
import { MediaControls, MediaPanel, type MediaControlsProps } from './MediaPanel';

vi.mock('./MediaLibrary',async importOriginal=>({...await importOriginal<typeof import('./MediaLibrary')>(),MediaLibrary:vi.fn(()=> <div data-testid="library"/>)}));
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.clearAllMocks();});
afterEach(cleanup);
const controls=():MediaControlsProps=>({query:'portrait',onQuery:vi.fn(),sort:'size',onSort:vi.fn(),view:'list',onView:vi.fn(),type:'image',onType:vi.fn()});

it('prepends the host toolbar, forwards library props and keeps controls controlled',()=>{
 const c=controls(),onSelect=vi.fn(),roots={input:'/input',output:'/output'},marks=new Map<string,string>(),actions=vi.fn(()=>[]);
 const {container}=render(<I18nProvider><MediaPanel selected={null} onSelect={onSelect} roots={roots} outputRevision={3} marks={marks} actions={actions} controls={c} toolbar={<button>Dock tabs</button>}/></I18nProvider>);
 const toolbar=container.querySelector('.media-toolbar')!;
 expect(toolbar.firstElementChild).toBe(screen.getByRole('button',{name:'Dock tabs'}));
 expect(vi.mocked(MediaLibrary).mock.calls.at(-1)![0]).toEqual({selected:null,onSelect,roots,outputRevision:3,marks,actions,filter:'portrait',sort:'size',view:'list',type:'image'});
 for(const [selector,value,callback] of [['search','new',c.onQuery],['sort','name',c.onSort],['type','video',c.onType!],['view','thumbs',c.onView]] as const){
  fireEvent.change(container.querySelector(`[data-dock-${selector}]`)!,{target:{value}});
  expect(callback).toHaveBeenCalledWith(value);
 }
});

it('omits media-only controls and date sort for model hosts',()=>{
 const {type,onType,...c}=controls();
 const {container}=render(<I18nProvider><MediaControls {...c} sorts={['name','size']}/></I18nProvider>);
 expect(container.querySelector('[data-dock-type]')).toBeNull();
 expect(within(container.querySelector('[data-dock-sort]') as HTMLSelectElement).getAllByRole('option').map(o=>(o as HTMLOptionElement).value)).toEqual(['name','size']);
});
