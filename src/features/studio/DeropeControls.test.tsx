import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import type { RecipeAllowlist } from '../../lib/execution';
import { isVideoPost } from '../../lib/videoIntent';
import { DeropeControls, defaultDerope, fromDerope, withDerope, type DeropePref } from './DeropeControls';

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
  expect(fromDerope(full!.derope)).toEqual({ enabled: true, mode: 'full', lora: '', preset: 'economy', inject: 0.7 });
  expect(fromDerope(turbo!.derope).mode).toBe('turbo');
  expect(isVideoPost({ derope: { preset: 'balanced', inject: 0.5 } })).toBe(false);
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
