import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { MediaLibrary } from './MediaLibrary';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { MediaEntry } from '../../lib/media';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn(()=>false),convertFileSrc:(p:string)=>`asset://localhost/${p}`}));
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}));
beforeEach(()=>{localStorage.setItem('deas.locale.v1','en');});
afterEach(()=>{cleanup();vi.resetAllMocks();});
const entry=(name:string,kind:MediaEntry['kind'],media:MediaEntry['media']=null,symlink=false):MediaEntry=>({name,path:`/home/u/${name}`,kind,symlink,media,size:1});
const home={path:'/home/u',parent:'/home',entries:[entry('shots','directory',null,true),entry('a.png','file','image'),entry('notes.txt','file')],truncated:false};
const shots={path:'/home/u/shots',parent:'/home/u',entries:[entry('clip.mp4','file','video')],truncated:true};
const mount=(onSelect=vi.fn())=>{render(<I18nProvider><MediaLibrary selected={null} onSelect={onSelect}/></I18nProvider>);return onSelect;};
describe('media library plugin — IPC fixtures, not real filesystem access',()=>{
 it('lists the home folder read-only, hides non-media files and marks symlinked folders',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockResolvedValue(home);
  mount();await screen.findByText('/home/u');
  expect(invoke).toHaveBeenCalledExactlyOnceWith('native_media_list',{path:''});
  expect(screen.getByRole('button',{name:/shots/})).toBeTruthy();expect(screen.getByLabelText('Symbolic link')).toBeTruthy();
  expect(screen.getByRole('button',{name:'a.png'})).toBeTruthy();expect(screen.queryByText('notes.txt')).toBeNull();
 });
 it('opens folders, selects media as asset URLs and reports truncation',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(async(_c,args)=>(args as {path:string}).path==='/home/u/shots'?shots:home);
  const onSelect=mount();await screen.findByText('/home/u');
  fireEvent.click(screen.getByRole('button',{name:'a.png'}));
  expect(onSelect).toHaveBeenCalledWith({name:'a.png',path:'/home/u/a.png',media:'image',src:'asset://localhost//home/u/a.png'});
  fireEvent.click(screen.getByRole('button',{name:/shots/}));await screen.findByText('/home/u/shots');
  expect(screen.getByText('Only the first 5000 entries are shown.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Parent folder'}));await waitFor(()=>expect(invoke).toHaveBeenLastCalledWith('native_media_list',{path:'/home/u'}));
 });
 it('shows native listing errors without inventing entries',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockRejectedValue('/home/u: permission denied');
  mount();expect((await screen.findByRole('alert')).textContent).toContain('permission denied');expect(screen.queryByRole('list')).toBeNull();
 });
 it('accepts browser drops as revocable blob URLs and selects the first media file',()=>{
  const onSelect=mount();expect(invoke).not.toHaveBeenCalled();
  const url=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:fixture');
  fireEvent.drop(screen.getByRole('complementary',{name:'Media'}),{dataTransfer:{files:[new File(['x'],'skip.txt',{type:'text/plain'}),new File(['x'],'drop.webm',{type:'video/webm'})]}});
  expect(onSelect).toHaveBeenCalledExactlyOnceWith({name:'drop.webm',media:'video',src:'blob:fixture'});
  expect(screen.getByRole('button',{name:'drop.webm'})).toBeTruthy();expect(screen.queryByText('skip.txt')).toBeNull();url.mockRestore();
 });
});
