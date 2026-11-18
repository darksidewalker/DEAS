import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { PromptTagOptions } from './PromptTagOptions';
import { useTagCompletion } from '../../lib/tagCompletion';
import { revealTarget, searchIndex } from '../../lib/search';

it('global search reveals tag options without changing settings or importing sources',async()=>{
 render(<PromptTagOptions root='/env'/>);
 const entry=searchIndex.find(entry=>entry.target==='[data-tag-option="import"]')!;
 expect(entry.label).toBe('tagCompletion.import');
 act(()=>{revealTarget(entry.target);});
 expect(screen.getByRole('dialog')).toBeTruthy();
 expect(document.querySelector(entry.target)?.classList.contains('search-flash')).toBe(true);
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_prompt_tag_sources',{root:'/env',modelsDir:null}));
 expect(vi.mocked(invoke).mock.calls.every(([command])=>command==='native_prompt_tag_sources')).toBe(true);
 expect(localStorage.getItem('deas.pref.prompt.tagCompletion')).toBeNull();
});
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:vi.fn()}));
vi.mock('../../i18n/I18nProvider',()=>({useI18n:()=>({t:(s:string)=>s})}));
const builtin={id:'builtin',label:'builtin',ready:true,available:true,rows:0,skipped:0};
const merged={id:'merged',label:'merged.csv',ready:false,available:true,rows:0,skipped:0};
function Observer(){const {options}=useTagCompletion();return <output>{JSON.stringify(options)}</output>;}
beforeEach(()=>{localStorage.clear();vi.mocked(invoke).mockResolvedValue([builtin,merged]);HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};});
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('shares on/off, floating display and count settings without rewriting unrelated choices',async()=>{
 localStorage.setItem('deas.pref.prompt.tagCompletion',JSON.stringify({sources:['builtin','classified','danbooru','e621'],limit:8,aliases:true,contains:true,minimumCount:0,floating:false}));
 render(<><PromptTagOptions root='/env'/><Observer/></>);
 expect(JSON.parse(localStorage.getItem('deas.pref.prompt.tagCompletion')!).sources).toEqual(['builtin']);
 fireEvent.click(screen.getByRole('button',{name:'tagCompletion.title'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'settings.prompt.autocomplete'}));
 fireEvent.click(screen.getByRole('radio',{name:'tagCompletion.floating'}));
 fireEvent.change(screen.getByLabelText('tagCompletion.limit'),{target:{value:'32'}});
 expect(JSON.parse(localStorage.getItem('deas.pref.prompt.tools')!).autocomplete).toBe(true);
 expect(screen.getByRole('status').textContent).toContain('"floating":true');
 expect(screen.getByRole('status').textContent).toContain('"limit":32');
 fireEvent.click(screen.getByRole('button',{name:'studio.close'}));
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'tagCompletion.title'}));
});
it('imports only an explicitly enabled source, survives StrictMode, and preserves later display choices',async()=>{
 let finish!:(v:unknown)=>void;
 vi.mocked(invoke).mockImplementation(async cmd=>cmd==='native_prompt_tag_sources'?[builtin,merged]:new Promise(r=>{finish=r;}));
 render(<StrictMode><PromptTagOptions root='/env' modelsDir='/models'/><Observer/></StrictMode>);
 fireEvent.click(screen.getByRole('button',{name:'tagCompletion.title'}));
 const source=await screen.findByRole('checkbox',{name:/tagCompletion.merged/});
 expect(invoke).not.toHaveBeenCalledWith('native_prompt_tag_import',expect.anything());
 fireEvent.click(source);
 expect(invoke).toHaveBeenCalledWith('native_prompt_tag_import',{root:'/env',modelsDir:'/models',source:'merged'});
 fireEvent.click(screen.getByRole('radio',{name:'tagCompletion.floating'}));
 await act(async()=>finish({...merged,ready:true,rows:120}));
 expect(screen.getByRole('status').textContent).toContain('"merged"');
 expect(screen.getByRole('status').textContent).toContain('"floating":true');
 expect(screen.getByRole('checkbox',{name:/tagCompletion.merged/})).toBeTruthy();
 expect((screen.getByRole('checkbox',{name:'settings.prompt.autocomplete'}) as HTMLInputElement).checked).toBe(false);
});
it('keeps source disabled after a cancelled file picker and reports failures without closing',async()=>{
 render(<PromptTagOptions root='/env'/>);fireEvent.click(screen.getByRole('button',{name:'tagCompletion.title'}));
 await screen.findByRole('checkbox',{name:/tagCompletion.merged/});
 vi.mocked(invoke).mockResolvedValueOnce(null);
 fireEvent.click(screen.getByRole('button',{name:'tagCompletion.import'}));
 await waitFor(()=>expect(screen.queryByText('tagCompletion.indexing')).toBeNull());
 vi.mocked(invoke).mockRejectedValueOnce(new Error('Unreadable CSV'));
 fireEvent.click(screen.getByRole('checkbox',{name:/tagCompletion.merged/}));
 expect((await screen.findByRole('alert')).textContent).toContain('Unreadable CSV');
 expect(screen.getByRole('dialog')).toBeTruthy();
 expect(JSON.parse(localStorage.getItem('deas.pref.prompt.tagCompletion')??'{"sources":["builtin"]}').sources).toEqual(['builtin']);
});

it('removes an imported source after native success and retains it on error',async()=>{
 const custom={id:'custom-0123456789abcdef',label:'my-tags.csv',available:true,ready:true,rows:20,skipped:0};
 vi.mocked(invoke).mockResolvedValueOnce([builtin,merged,custom]);
 render(<><PromptTagOptions root='/env'/><Observer/></>);
 fireEvent.click(screen.getByRole('button',{name:'tagCompletion.title'}));
 fireEvent.click(await screen.findByRole('checkbox',{name:/my-tags.csv/}));
 vi.mocked(invoke).mockRejectedValueOnce(new Error('Index is busy'));
 fireEvent.click(screen.getAllByRole('button',{name:'tagCompletion.remove'}).at(-1)!);
 expect((await screen.findByRole('alert')).textContent).toContain('Index is busy');
 expect((screen.getByRole('checkbox',{name:/my-tags.csv/}) as HTMLInputElement).checked).toBe(true);
 vi.mocked(invoke).mockResolvedValueOnce(null);
 fireEvent.click(screen.getAllByRole('button',{name:'tagCompletion.remove'}).at(-1)!);
 await waitFor(()=>expect(screen.queryByRole('checkbox',{name:/my-tags.csv/})).toBeNull());
 expect(invoke).toHaveBeenLastCalledWith('native_prompt_tag_remove',{root:'/env',source:custom.id});
 expect(JSON.parse(localStorage.getItem('deas.pref.prompt.tagCompletion')!).sources).toEqual(['builtin']);
});

it('allows removing the merged CSV entry and clears its active selection',async()=>{
 render(<><PromptTagOptions root='/env'/><Observer/></>);
 fireEvent.click(screen.getByRole('button',{name:'tagCompletion.title'}));
 await screen.findByRole('checkbox',{name:/tagCompletion.merged/});
 expect(screen.getByRole('checkbox',{name:'tagCompletion.builtin'}).closest('.tag-source-entry')!.querySelector('button')).toBeNull();
 vi.mocked(invoke).mockResolvedValueOnce(null);
 fireEvent.click(screen.getByRole('button',{name:'tagCompletion.remove'}));
 await waitFor(()=>expect(screen.queryByRole('checkbox',{name:/tagCompletion.merged/})).toBeNull());
 expect(invoke).toHaveBeenLastCalledWith('native_prompt_tag_remove',{root:'/env',source:'merged'});
});
