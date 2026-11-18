import { useState } from 'react';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { useModelOrganization } from './modelOrganization';
import { invoke } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:vi.fn().mockResolvedValue(undefined)}));
function Panel({name}:{name:string}){const {isFavorite,toggleFavorite,annotate,error}=useModelOrganization();return <div><button aria-label={name} aria-pressed={isFavorite('L:/models/style.safetensors')} onClick={()=>toggleFavorite('L:/models/style.safetensors')}>Favorite</button><button onClick={()=>annotate('L:/models/style.safetensors',{notes:'preserved note',tags:['warm light']})}>Notes {name}</button>{error&&<p role="alert">failed</p>}</div>;}
beforeEach(()=>{localStorage.clear();vi.mocked(invoke).mockClear();});afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('shares favorites immediately and preserves notes/tags while matching Windows path spelling',()=>{
 localStorage.setItem('deas.pref.library.local.organization',JSON.stringify({'l:\\models\\style.safetensors':{notes:'old',tags:['old']}}));
 render(<><Panel name="Library"/><Panel name="Studio"/></>);fireEvent.click(screen.getByRole('button',{name:'Notes Library'}));fireEvent.click(screen.getByRole('button',{name:'Studio'}));expect(screen.getByRole('button',{name:'Library'}).getAttribute('aria-pressed')).toBe('true');
 const values=Object.values(JSON.parse(localStorage.getItem('deas.pref.library.local.organization')!));expect(values).toEqual([{notes:'preserved note',tags:['warm light'],favorite:true}]);
 fireEvent.click(screen.getByRole('button',{name:'Library'}));expect(screen.getByRole('button',{name:'Studio'}).getAttribute('aria-pressed')).toBe('false');
});
it('keeps previous saved organization and reports persistence refusal',()=>{
 render(<Panel name="Library"/>);vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('quota');});fireEvent.click(screen.getByRole('button',{name:'Library'}));expect(screen.getByRole('alert')).toBeTruthy();expect(invoke).toHaveBeenCalledWith('native_logs_library_error',{operation:'organization'});
});

function EmptyPanel(){const {isFavorite,toggleFavorite,setFavorites}=useModelOrganization();return <><button aria-pressed={isFavorite('')} onClick={()=>toggleFavorite('')}>Empty path</button><button onClick={()=>setFavorites([''],true)}>Empty batch</button></>;}
it('ignores pathless backend entries even with a legacy empty-path favorite',()=>{
 const value=JSON.stringify({'':{favorite:true},'/m/local.safetensors':{favorite:true}});localStorage.setItem('deas.pref.library.local.organization',value);
 render(<EmptyPanel/>);expect(screen.getByRole('button',{name:'Empty path'}).getAttribute('aria-pressed')).toBe('false');
 const write=vi.spyOn(Storage.prototype,'setItem');fireEvent.click(screen.getByRole('button',{name:'Empty path'}));fireEvent.click(screen.getByRole('button',{name:'Empty batch'}));expect(write).not.toHaveBeenCalled();expect(localStorage.getItem('deas.pref.library.local.organization')).toBe(value);
});

function BulkPanel(){const {setFavorites,error}=useModelOrganization();const paths=['L:/models/style.safetensors','L:/models/other.safetensors','l:\\models\\STYLE.safetensors'];return <><button onClick={()=>setFavorites(paths,true)}>Favorite selected</button><button onClick={()=>setFavorites(paths,false)}>Unfavorite selected</button>{error&&<p role="alert">Batch failed</p>}</>;}
it('sets mixed favorites explicitly in one write, preserving annotations and shared views',()=>{
 const first='l:\\models\\style.safetensors',second='L:/models/other.safetensors';
 localStorage.setItem('deas.pref.library.local.organization',JSON.stringify({[first]:{favorite:true,notes:'keep'},[second]:{favorite:false,tags:['warm']}}));
 render(<><Panel name="Library"/><Panel name="Studio"/><BulkPanel/></>);const write=vi.spyOn(Storage.prototype,'setItem');
 fireEvent.click(screen.getByRole('button',{name:'Favorite selected'}));expect(write).toHaveBeenCalledTimes(1);
 expect(JSON.parse(localStorage.getItem('deas.pref.library.local.organization')!)).toEqual({[first]:{favorite:true,notes:'keep'},[second]:{favorite:true,tags:['warm']}});
 fireEvent.click(screen.getByRole('button',{name:'Unfavorite selected'}));expect(write).toHaveBeenCalledTimes(2);
 expect(JSON.parse(localStorage.getItem('deas.pref.library.local.organization')!)).toEqual({[first]:{favorite:false,notes:'keep'},[second]:{favorite:false,tags:['warm']}});
 expect(screen.getByRole('button',{name:'Library'}).getAttribute('aria-pressed')).toBe('false');expect(screen.getByRole('button',{name:'Studio'}).getAttribute('aria-pressed')).toBe('false');
});
it('leaves a mixed saved selection intact when the batch preference write fails',()=>{
 const value=JSON.stringify({'L:/models/style.safetensors':{favorite:true},'L:/models/other.safetensors':{favorite:false}});localStorage.setItem('deas.pref.library.local.organization',value);
 render(<><Panel name="Library"/><BulkPanel/></>);vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('quota');});
 fireEvent.click(screen.getByRole('button',{name:'Favorite selected'}));expect(localStorage.getItem('deas.pref.library.local.organization')).toBe(value);expect(screen.getByRole('button',{name:'Library'}).getAttribute('aria-pressed')).toBe('true');expect(screen.getByRole('alert').textContent).toBe('Batch failed');expect(invoke).toHaveBeenCalledWith('native_logs_library_error',{operation:'organization'});
});

function ScopedPanel({scope,name,identity}:{scope:'local'|'catalog';name:string;identity:string}){const {isFavorite,toggleFavorite}=useModelOrganization(scope);return <button aria-label={name} aria-pressed={isFavorite(identity)} onClick={()=>toggleFavorite(identity)}>Favorite</button>;}
it('isolates catalog storage/events and preserves exact remote identities',()=>{
 const identity='["hf","Repo","Folder/Model"]';
 render(<><ScopedPanel scope="local" name="local" identity={identity}/><ScopedPanel scope="catalog" name="catalog" identity={identity}/><ScopedPanel scope="catalog" name="mirror" identity={identity}/><ScopedPanel scope="catalog" name="different" identity={identity.toLowerCase()}/></>);
 fireEvent.click(screen.getByRole('button',{name:'catalog'}));
 expect(screen.getByRole('button',{name:'mirror'}).getAttribute('aria-pressed')).toBe('true');
 expect(screen.getByRole('button',{name:'local'}).getAttribute('aria-pressed')).toBe('false');
 expect(screen.getByRole('button',{name:'different'}).getAttribute('aria-pressed')).toBe('false');
 expect(JSON.parse(localStorage.getItem('deas.pref.library.catalog.organization')!)).toEqual({[identity]:{favorite:true}});
 expect(localStorage.getItem('deas.pref.library.local.organization')).toBeNull();
});

it('reloads only the matching storage namespace and follows scope changes',()=>{
 const identity='remote';const view=render(<><ScopedPanel scope="local" name="local" identity={identity}/><ScopedPanel scope="catalog" name="catalog" identity={identity}/></>);
 localStorage.setItem('deas.pref.library.catalog.organization',JSON.stringify({[identity]:{favorite:true}}));
 fireEvent(window,new StorageEvent('storage',{key:'deas.pref.library.local.organization'}));expect(screen.getByRole('button',{name:'catalog'}).getAttribute('aria-pressed')).toBe('false');
 fireEvent(window,new StorageEvent('storage',{key:'deas.pref.library.catalog.organization'}));expect(screen.getByRole('button',{name:'catalog'}).getAttribute('aria-pressed')).toBe('true');expect(screen.getByRole('button',{name:'local'}).getAttribute('aria-pressed')).toBe('false');
 view.rerender(<><ScopedPanel scope="catalog" name="local" identity={identity}/><ScopedPanel scope="catalog" name="catalog" identity={identity}/></>);expect(screen.getByRole('button',{name:'local'}).getAttribute('aria-pressed')).toBe('true');
});
