import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { applyStudioSettings, captureStudioSettings, forgetPref, isString, oneOf, readPref, usePref, writePref, PreferencePersistenceContext } from './preferences';
import type { ReactNode } from 'react';

it('project values cannot leak back into global Studio defaults when the project closes',()=>{
 writePref('studio.run.wildcard','original');
 let persist=true;
 const wrapper=({children}:{children:ReactNode})=><PreferencePersistenceContext.Provider value={persist}>{children}</PreferencePersistenceContext.Provider>;
 const hook=renderHook(()=>usePref('studio.run.wildcard','global',isString),{wrapper});
 persist=false;hook.rerender();
 act(()=>hook.result.current[1]('project-only'));
 expect(readPref('studio.run.wildcard','',isString)).toBe('original');
 persist=true;hook.rerender();
 expect(hook.result.current[0]).toBe('original');
 expect(readPref('studio.run.wildcard','',isString)).toBe('original');
 hook.unmount();
});

it('presets capture live project values and reject invalid loads atomically',()=>{
 writePref('studio.run.positive','global');
 const wrapper=({children}:{children:ReactNode})=><PreferencePersistenceContext.Provider value={false}>{children}</PreferencePersistenceContext.Provider>;
 const hook=renderHook(()=>({prompt:usePref('studio.run.positive','',isString),history:usePref('studio.run.recentSeeds','history',isString),layout:usePref('studio.layout.width','layout',isString)}),{wrapper});
 act(()=>hook.result.current.prompt[1]('project draft'));
 expect(captureStudioSettings()).toEqual({'studio.run.positive':'project draft'});
 for(const settings of [{'studio.run.positive':42},{'studio.run.positive':'bad','studio.run.unknown':true}]){
  act(()=>expect(applyStudioSettings(settings)).toBe(false));expect(hook.result.current.prompt[0]).toBe('project draft');
 }
 act(()=>expect(applyStudioSettings({'studio.run.positive':'loaded'})).toBe(true));
 expect(hook.result.current.prompt[0]).toBe('loaded');expect(readPref('studio.run.positive','',isString)).toBe('global');
 hook.unmount();
});

beforeEach(()=>localStorage.clear());
it('restores a validated choice and falls back on missing, corrupt or foreign values',()=>{
 const valid=oneOf('newest','name');
 expect(readPref('sort','newest',valid)).toBe('newest');
 writePref('sort','name');expect(readPref('sort','newest',valid)).toBe('name');
 localStorage.setItem('deas.pref.sort','"bogus"');expect(readPref('sort','newest',valid)).toBe('newest');
 localStorage.setItem('deas.pref.sort','{not json');expect(readPref('sort','newest',valid)).toBe('newest');
 forgetPref('sort');expect(localStorage.getItem('deas.pref.sort')).toBeNull();
});
it('resets only editable Studio preferences in the current project scope',()=>{
 writePref('studio.run.options','custom');writePref('studio.run.recentSeeds','history');writePref('studio.dock.height',300);
 const wrapper=({children}:{children:ReactNode})=><PreferencePersistenceContext.Provider value={false}>{children}</PreferencePersistenceContext.Provider>;
 const hook=renderHook(()=>({options:usePref('studio.run.options','default',isString),history:usePref('studio.run.recentSeeds','',isString),layout:usePref('studio.dock.height',220,(v):v is number=>typeof v==='number')}),{wrapper});
 act(()=>window.dispatchEvent(new Event('deas:reset-studio-preferences')));
 expect(hook.result.current.options[0]).toBe('default');
 expect(readPref('studio.run.options','',isString)).toBe('custom');
 expect(hook.result.current.history[0]).toBe('history');expect(hook.result.current.layout[0]).toBe(300);
 hook.unmount();
});
it('usePref persists changes for the next mount',()=>{
 const first=renderHook(()=>usePref('page','video',isString));
 act(()=>first.result.current[1]('map'));first.unmount();
 expect(renderHook(()=>usePref('page','video',isString)).result.current[0]).toBe('map');
});
