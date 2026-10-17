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
const entry=(name:string,kind:MediaEntry['kind'],media:MediaEntry['media']=null,symlink=false,modified=1):MediaEntry=>({name,path:`/home/u/${name}`,kind,symlink,media,size:1,modified});
const home={path:'/home/u',parent:'/home',entries:[entry('shots','directory',null,true),entry('a.png','file','image'),entry('notes.txt','file')],truncated:false};
const shots={path:'/home/u/shots',parent:'/home/u',entries:[entry('clip.mp4','file','video')],truncated:true};
const mount=(onSelect=vi.fn())=>{render(<I18nProvider><MediaLibrary selected={null} onSelect={onSelect}/></I18nProvider>);return onSelect;};
/** Listing calls only: image tiles additionally ask `native_media_thumbnail`. */
const lists=()=>vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_media_list').map(([,a])=>a);
describe('media library plugin — IPC fixtures, not real filesystem access',()=>{
 it('starts in the environment output folder newest-first and offers input/output chips',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);
  const out={path:'/env/ComfyUI/output',parent:'/env/ComfyUI',entries:[entry('old.png','file','image',false,10),entry('new.png','file','image',false,20)],truncated:false};
  vi.mocked(invoke).mockImplementation(async(c,args)=>{const path=(args as {path:string}).path;if(c==='native_media_thumbnail'){if(path.endsWith('new.png'))return '/cache/thumbs/abc.png';throw new Error('No thumbnail for this file');}return path==='/env/ComfyUI/output'?out:home;});
  render(<I18nProvider><MediaLibrary selected={null} onSelect={vi.fn()} roots={{input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
  await screen.findByRole('button',{name:'output',current:'location'});
  expect(lists()).toEqual([{path:'/env/ComfyUI/output',depth:3}]);
  expect(screen.getAllByRole('button',{name:/\.png$/}).map(b=>b.textContent)).toEqual(['new.png','old.png']);
  // Tiles show the native cached thumbnail; without one the original file is the fallback.
  await waitFor(()=>expect(screen.getByRole('button',{name:'new.png'}).querySelector('img')?.getAttribute('src')).toBe('asset://localhost//cache/thumbs/abc.png'));
  await waitFor(()=>expect(screen.getByRole('button',{name:'old.png'}).querySelector('img')?.getAttribute('src')).toBe('asset://localhost//home/u/old.png'));
  expect(screen.getByRole('button',{name:'Output'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'Input'}));
  expect(lists().at(-1)).toEqual({path:'/env/ComfyUI/input',depth:3});
 });
 it('lists the home folder read-only, hides non-media files and marks symlinked folders',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockResolvedValue(home);
  mount();await screen.findByRole('button',{name:'u',current:'location'});
  expect(lists()).toEqual([{path:'',depth:3}]);
  expect(screen.getByRole('button',{name:/shots/})).toBeTruthy();expect(screen.getByLabelText('Symbolic link')).toBeTruthy();
  expect(screen.getByRole('button',{name:'a.png'})).toBeTruthy();expect(screen.queryByText('notes.txt')).toBeNull();
 });
 it('opens folders, selects media as asset URLs and reports truncation',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(async(_c,args)=>(args as {path:string}).path==='/home/u/shots'?shots:home);
  const onSelect=mount();await screen.findByRole('button',{name:'u',current:'location'});
  fireEvent.click(screen.getByRole('button',{name:'a.png'}));
  expect(onSelect).toHaveBeenCalledWith({name:'a.png',path:'/home/u/a.png',media:'image',src:'asset://localhost//home/u/a.png'});
  fireEvent.click(screen.getByRole('button',{name:/shots/}));await screen.findByRole('button',{name:'shots',current:'location'});
  fireEvent.click(screen.getByRole('button',{name:'home'}));expect(lists().at(-1)).toEqual({path:'/home',depth:3});
  expect(screen.getByText('Only the first 5000 entries are shown.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Parent folder'}));await waitFor(()=>expect(lists().at(-1)).toEqual({path:'/home/u',depth:3}));
 });
 it('filters by name and sorts files by newest, name or size with folders first',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);
  const mixed={path:'/home/u',parent:'/home',entries:[{...entry('b.png','file','image',false,20),size:1},{...entry('a.png','file','image',false,10),size:9},entry('zdir','directory')],truncated:false};
  vi.mocked(invoke).mockImplementation(async c=>c==='native_media_list'?mixed:'/cache/t.png');
  const names=()=>screen.getAllByRole('button',{name:/\.png$|zdir/}).map(b=>b.title);
  const {rerender}=render(<I18nProvider><MediaLibrary selected={null} onSelect={vi.fn()} sort="date"/></I18nProvider>);
  await screen.findByRole('button',{name:'u',current:'location'});
  expect(names()).toEqual(['zdir','b.png','a.png']);
  rerender(<I18nProvider><MediaLibrary selected={null} onSelect={vi.fn()} sort="name"/></I18nProvider>);expect(names()).toEqual(['zdir','a.png','b.png']);
  rerender(<I18nProvider><MediaLibrary selected={null} onSelect={vi.fn()} sort="size"/></I18nProvider>);expect(names()).toEqual(['zdir','a.png','b.png']);
  rerender(<I18nProvider><MediaLibrary selected={null} onSelect={vi.fn()} filter="B."/></I18nProvider>);expect(names()).toEqual(['b.png']);
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
