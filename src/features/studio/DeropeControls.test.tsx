import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bundledCatalog, I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import { matchEntries, revealTarget, searchIndex } from '../../lib/search';
import type { RecipeAllowlist } from '../../lib/execution';
import { isVideoPost } from '../../lib/videoIntent';
import { DeropeControls, defaultDerope, fromDerope, isDeropePref, withDerope, type DeropePref } from './DeropeControls';

beforeEach(() => { localStorage.setItem(LOCALE_STORAGE_KEY, 'en'); });
afterEach(() => { cleanup(); localStorage.clear(); });
const allow = (nodes: string[]) => ({ nodes, loras: ['MiniMaxH3/turbo/h3_turbo.safetensors'] }) as unknown as RecipeAllowlist;
let last: DeropePref = defaultDerope;
function Host({ nodes = ['DaSiWaH3DeropePrepare', 'DaSiWaH3DeropeRecover'], conflict = false }: { nodes?: string[]; conflict?: boolean }) {
  const [value, setValue] = useState(defaultDerope);
  return <I18nProvider><DeropeControls value={value} onChange={v => { last = v; setValue(v); }} allow={allow(nodes)} conflict={conflict}/></I18nProvider>;
}

test('off by default leaves the chain byte-identical; on adds the turbo or base-model stage', () => {
  expect(withDerope(undefined, defaultDerope)).toBeUndefined();
  const loop = { loop: { backend: 'rtx' as const, audio: 'crossfade' as const } };
  expect(withDerope(loop, defaultDerope)).toBe(loop);
  const turbo = withDerope(loop, { ...defaultDerope, enabled: true, lora: 'x.safetensors' });
  expect(turbo).toEqual({ ...loop, derope: { preset: 'balanced', inject: 0.48, lora: 'x.safetensors' } });
  expect(isVideoPost(turbo)).toBe(true);
  const full = withDerope(undefined, { ...defaultDerope, enabled: true, mode: 'full', lora: 'ignored', preset: 'economy', inject: 0.7 });
  expect(full).toEqual({ derope: { preset: 'economy', inject: 0.7 } });
  expect(fromDerope(full!.derope)).toEqual({ enabled: true, mode: 'full', lora: '', preset: 'economy', inject: 0.7, keepBackground: false, distilled: false });
  expect(fromDerope(turbo!.derope).mode).toBe('turbo');
  expect(isVideoPost({ derope: { preset: 'balanced', inject: 0.5 } })).toBe(false);
});

test('distilled is an explicit base-model flag, omitted when off and never with a turbo LoRA', () => {
  const base = { ...defaultDerope, enabled: true, mode: 'full' as const };
  expect(withDerope(undefined, base)!.derope).not.toHaveProperty('distilled');
  const on = withDerope(undefined, { ...base, distilled: true })!;
  expect(on.derope).toEqual({ preset: 'balanced', inject: 0.48, distilled: true });
  expect(isVideoPost(on)).toBe(true);
  expect(fromDerope(on.derope).distilled).toBe(true);
  expect(withDerope(undefined, { ...base, mode: 'turbo', lora: 'x.safetensors', distilled: true })!.derope).not.toHaveProperty('distilled');
  for (const distilled of [false, 'true', 1]) expect(isVideoPost({ derope: { preset: 'balanced', inject: 0.48, distilled } })).toBe(false);
  expect(isVideoPost({ derope: { preset: 'balanced', inject: 0.48, lora: 'x.safetensors', distilled: true } })).toBe(false);
  const {distilled: _removed, ...legacy} = base;
  expect(isDeropePref(legacy)).toBe(true);
});

test('keep background is opt-in, restores old intents OFF, and rejects non-booleans', () => {
  const old = { ...defaultDerope, enabled: true, mode: 'full' as const };
  const off = withDerope(undefined, old)!;
  expect(off.derope).not.toHaveProperty('keepBackground');
  expect(withDerope(undefined, { ...old, keepBackground: undefined } as unknown as DeropePref)).toEqual(off);
  const on = withDerope(undefined, { ...old, keepBackground: true })!;
  expect(on.derope?.keepBackground).toBe(true);
  expect(fromDerope(on.derope).keepBackground).toBe(true);
  expect(fromDerope(off.derope).keepBackground).toBe(false);
  const {keepBackground: _removed, ...legacy} = old;
  expect(isDeropePref(legacy)).toBe(true);
  expect(isDeropePref({...old,keepBackground:'true'})).toBe(false);
  for (const keepBackground of ['true', 1, null]) expect(isVideoPost({ derope: { ...off.derope, keepBackground } })).toBe(false);
});

test('keep background stays disabled on an old pack without disabling De-rope', () => {
  render(<Host/>);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Re-render smeared fast motion' }));
  const toggle = screen.getByRole('checkbox', { name: 'Keep static background' });
  expect(toggle).toHaveProperty('disabled', true);
  expect(toggle).toHaveProperty('checked', false);
  expect(screen.getByText(/Backend → Upgrade/)).toBeTruthy();
});

test('verified capability enables the switch; saved ON survives a missing capability without execution', () => {
  const onChange = vi.fn();
  const value = { ...defaultDerope, enabled: true, mode: 'full' as const };
  const view = render(<I18nProvider><DeropeControls value={value} onChange={onChange} allow={{...allow(['DaSiWaH3DeropePrepare','DaSiWaH3DeropeRecover']),deropeKeepBackground:true}} conflict={false}/></I18nProvider>);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep static background' }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith({...value,keepBackground:true});
  view.rerender(<I18nProvider><DeropeControls value={{...value,keepBackground:true}} onChange={onChange} allow={allow(['DaSiWaH3DeropePrepare','DaSiWaH3DeropeRecover'])} conflict={false}/></I18nProvider>);
  expect(screen.getByRole('checkbox', { name: 'Keep static background' })).toHaveProperty('checked',true);
  expect(screen.getByRole('checkbox', { name: 'Keep static background' })).toHaveProperty('disabled',true);
  expect(onChange).toHaveBeenCalledTimes(1);
});

test.each(['en','de','fr','ja','tr','zh'])('keep background has localized help and a reachable read-only search target (%s)', locale => {
  localStorage.setItem(LOCALE_STORAGE_KEY,locale);
  const text = (key:string) => bundledCatalog.dictionaries[locale][key];
  const change=vi.fn();
  render(<I18nProvider><div className="wb-post"><DeropeControls value={{...defaultDerope,enabled:true}} onChange={change} allow={allow(['DaSiWaH3DeropePrepare','DaSiWaH3DeropeRecover'])} conflict={false}/></div></I18nProvider>);
  const entry=searchIndex.find(e=>e.label==='studio.run.derope.keepBackground')!;
  expect(matchEntries(searchIndex,text(entry.label),text)).toContain(entry);
  expect(matchEntries(searchIndex,'keep static background',text)).toContain(entry);
  const toggle=screen.getByRole('checkbox',{name:text(entry.label)});
  expect(revealTarget(entry.target)).toEqual({state:'disabled',title:text('studio.run.derope.keepBackgroundMissing')});
  expect(toggle.getAttribute('title')).toBe(text('studio.run.derope.keepBackgroundMissing'));
  expect(change).not.toHaveBeenCalled();
});

test('enabling reveals the pass controls; switching to the base model resets inject to 0.70', () => {
  render(<Host/>);
  expect(screen.queryByRole('combobox', { name: 'Turbo LoRA' })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Re-render smeared fast motion' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Turbo LoRA' }), { target: { value: 'MiniMaxH3/turbo/h3_turbo.safetensors' } });
  expect(last).toMatchObject({ enabled: true, mode: 'turbo', lora: 'MiniMaxH3/turbo/h3_turbo.safetensors', inject: 0.48 });
  fireEvent.change(screen.getByRole('combobox', { name: 'Second pass' }), { target: { value: 'full' } });
  expect(last).toMatchObject({ mode: 'full', inject: 0.7 });
  expect(screen.queryByRole('combobox', { name: 'Turbo LoRA' })).toBeNull();
});

test('missing nodes disable the switch with the update reason; a conflict is named once enabled', () => {
  render(<Host nodes={[]}/>);
  expect((screen.getByRole('checkbox', { name: 'Re-render smeared fast motion' }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/node pack 0\.5\.43/)).toBeTruthy();
  cleanup();
  render(<Host conflict/>);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Re-render smeared fast motion' }));
  expect(screen.getByRole('status').textContent).toMatch(/imported video/);
});
