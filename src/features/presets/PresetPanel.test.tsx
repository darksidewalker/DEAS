import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { PresetPanel } from './PresetPanel';
import { I18nProvider } from '../../i18n/I18nProvider';
import { isBoolean, usePref, type Valid } from '../../lib/preferences';
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:vi.fn()}));
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.resetAllMocks();HTMLDialogElement.prototype.showModal??=function(this:HTMLDialogElement){this.open=true;};});
afterEach(cleanup);
type Video={seconds:number;fps:number};
const isSteps:Valid<number>=(v):v is number=>typeof v==='number'&&v>=1&&v<=100;
const isVideo:Valid<Video>=(v):v is Video=>!!v&&typeof (v as Video).seconds==='number'&&typeof (v as Video).fps==='number';
let live:{steps:number;video:Video;post:boolean}={steps:0,video:{seconds:0,fps:0},post:false};
/** Stand-in Studio controls: the defaults passed here are what presets compare against. */
function Controls({videoDefault={seconds:5,fps:24}}:{videoDefault?:Video}){
 const [steps]=usePref('studio.run.steps',20,isSteps);const [video]=usePref('studio.run.video',videoDefault,isVideo);const [post]=usePref('studio.run.post',false,isBoolean);
 live={steps,video,post};return null;
}
const mount=(videoDefault?:Video)=>render(<I18nProvider><Controls videoDefault={videoDefault}/><PresetPanel disabled={false}/></I18nProvider>);
const store=(presets:unknown[])=>{let saved=presets;vi.mocked(invoke).mockImplementation(async(c,a)=>{if(c==='native_presets_read')return saved;if(c==='native_presets_write'){saved=(a as {presets:unknown[]}).presets;return null;}return null;});return ()=>saved;};
const menuFor=async(name:string)=>{fireEvent.contextMenu(await screen.findByRole('button',{name:new RegExp(name)}));return screen.getByRole('menu',{name});};

test('read failure is visible and cannot overwrite unread presets',async()=>{
 vi.mocked(invoke).mockRejectedValue('Cannot read presets');
 render(<I18nProvider><PresetPanel disabled={false}/></I18nProvider>);
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Cannot read presets');
 expect((screen.getByRole('button',{name:'Save as new preset'}) as HTMLButtonElement).disabled).toBe(true);
 expect(invoke).toHaveBeenCalledExactlyOnceWith('native_presets_read');
});
test('write failure never reports success or shows the unsaved tile',async()=>{
 vi.mocked(invoke).mockImplementation(async c=>{if(c==='native_presets_read')return [];throw new Error('Disk full');});
 mount();
 await waitFor(()=>expect((screen.getByLabelText('Preset name') as HTMLInputElement).disabled).toBe(false));
 fireEvent.change(screen.getByLabelText('Preset name'),{target:{value:'Draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Save as new preset'}));
 expect((await screen.findByRole('alert')).textContent).toContain('Disk full');
 expect(screen.queryByText('Preset saved.')).toBeNull();expect(screen.queryByRole('button',{name:/Draft/})).toBeNull();
});
test('saving stores only settings that differ from the defaults',async()=>{
 localStorage.setItem('deas.pref.studio.run.video',JSON.stringify({seconds:8,fps:24}));
 const saved=store([]);mount();
 await waitFor(()=>expect((screen.getByLabelText('Preset name') as HTMLInputElement).disabled).toBe(false));
 fireEvent.change(screen.getByLabelText('Preset name'),{target:{value:'Long'}});
 fireEvent.click(screen.getByRole('button',{name:'Save as new preset'}));
 expect((await screen.findByRole('button',{name:/Long.*1 changed/})).getAttribute('aria-pressed')).toBe('true');
 expect(saved()).toEqual([{name:'Long',settings:{'studio.run.video':{seconds:8}}}]);
});
test('right-click Apply merges the overrides onto today\'s defaults',async()=>{
 localStorage.setItem('deas.pref.studio.run.steps','42');
 store([{name:'Long',settings:{'studio.run.video':{seconds:8}}}]);mount({seconds:5,fps:30});
 fireEvent.click(within(await menuFor('Long')).getByRole('menuitem',{name:'Apply'}));
 await waitFor(()=>expect(live).toEqual({steps:20,video:{seconds:8,fps:30},post:false}));
 expect(screen.getByRole('status').textContent).toContain('Preset applied');
});
test('legacy full snapshots highlight only values that differ from the current defaults',async()=>{
 store([{name:'Old',settings:{'studio.run.steps':20,'studio.run.video':{seconds:5,fps:24},'studio.run.post':true}}]);mount();
 expect(await screen.findByRole('button',{name:/Old.*1 changed/})).toBeTruthy();
 fireEvent.click(within(await menuFor('Old')).getByRole('menuitem',{name:'Edit…'}));
 const dialog=screen.getByRole('dialog',{name:'Edit preset'});
 expect([...dialog.querySelectorAll('li[data-changed="true"] code')].map(c=>c.textContent)).toEqual(['post']);
 fireEvent.click(within(dialog).getByRole('checkbox',{name:'Also show settings at their default'}));
 expect(dialog.querySelectorAll('li[data-changed="false"]')).toHaveLength(3);
});
test('editing changes, resets and renames fields without overwriting from the live controls',async()=>{
 localStorage.setItem('deas.pref.studio.run.steps','77');
 const saved=store([{name:'Draft',settings:{'studio.run.post':true}}]);mount();
 fireEvent.click(within(await menuFor('Draft')).getByRole('menuitem',{name:'Edit…'}));
 const dialog=screen.getByRole('dialog',{name:'Edit preset'});
 fireEvent.click(within(dialog).getByRole('checkbox',{name:'Also show settings at their default'}));
 fireEvent.change(within(dialog).getByRole('spinbutton',{name:'video › seconds'}),{target:{value:'9'}});
 fireEvent.change(within(dialog).getByRole('spinbutton',{name:'steps'}),{target:{value:'500'}});
 expect(within(dialog).getByRole('alert').textContent).toContain('Not a valid value');
 expect((within(dialog).getByRole('button',{name:'Save changes'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(within(within(dialog).getByRole('spinbutton',{name:'steps'}).closest('li')!).getByRole('button',{name:'Reset to default'}));
 fireEvent.click(within(within(dialog).getByRole('checkbox',{name:'post'}).closest('li')!).getByRole('button',{name:'Reset to default'}));
 fireEvent.change(within(dialog).getByRole('textbox',{name:'Preset name'}),{target:{value:'Renamed'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'Save changes'}));
 await waitFor(()=>expect(saved()).toEqual([{name:'Renamed',settings:{'studio.run.video':{seconds:9}}}]));
 expect(await screen.findByRole('button',{name:/Renamed/})).toBeTruthy();
});
test('settings this version does not know block Apply, reach native logging and can be removed in Edit',async()=>{
 const saved=store([{name:'Old',settings:{'studio.run.unknown':true,'studio.run.post':true}}]);mount();
 fireEvent.click(within(await menuFor('Old')).getByRole('menuitem',{name:'Apply'}));
 expect(screen.getByRole('alert').textContent).toContain('Nothing was changed');
 expect(invoke).toHaveBeenCalledWith('native_presets_invalid');expect(live.post).toBe(false);
 fireEvent.click(within(await menuFor('Old')).getByRole('menuitem',{name:'Edit…'}));
 const dialog=screen.getByRole('dialog',{name:'Edit preset'});
 fireEvent.click(within(dialog).getByRole('button',{name:'Remove'}));
 fireEvent.click(within(dialog).getByRole('button',{name:'Save changes'}));
 await waitFor(()=>expect(saved()).toEqual([{name:'Old',settings:{'studio.run.post':true}}]));
});
test('Shift+F10 opens the menu and Escape returns focus to the tile',async()=>{
 store([{name:'Draft',settings:{}}]);mount();
 const tile=await screen.findByRole('button',{name:/Draft/});tile.focus();
 fireEvent.keyDown(tile,{key:'F10',shiftKey:true});
 const menu=screen.getByRole('menu',{name:'Draft'});
 await waitFor(()=>expect(document.activeElement).toBe(within(menu).getByRole('menuitem',{name:'Apply'})));
 fireEvent.keyDown(menu,{key:'Escape'});
 expect(screen.queryByRole('menu')).toBeNull();expect(document.activeElement).toBe(tile);
});
