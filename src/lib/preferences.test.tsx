import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { forgetPref, isString, oneOf, readPref, usePref, writePref } from './preferences';

beforeEach(()=>localStorage.clear());
it('restores a validated choice and falls back on missing, corrupt or foreign values',()=>{
 const valid=oneOf('newest','name');
 expect(readPref('sort','newest',valid)).toBe('newest');
 writePref('sort','name');expect(readPref('sort','newest',valid)).toBe('name');
 localStorage.setItem('deas.pref.sort','"bogus"');expect(readPref('sort','newest',valid)).toBe('newest');
 localStorage.setItem('deas.pref.sort','{not json');expect(readPref('sort','newest',valid)).toBe('newest');
 forgetPref('sort');expect(localStorage.getItem('deas.pref.sort')).toBeNull();
});
it('usePref persists changes for the next mount',()=>{
 const first=renderHook(()=>usePref('page','video',isString));
 act(()=>first.result.current[1]('map'));first.unmount();
 expect(renderHook(()=>usePref('page','video',isString)).result.current[0]).toBe('map');
});
