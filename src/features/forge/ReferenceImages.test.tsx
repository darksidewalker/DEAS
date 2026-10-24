import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ReferenceImages, type RefPicture } from './ReferenceImages';
import type { NativeReferences } from '../../lib/forge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const vocab: NativeReferences = { roles: [{ key: 'style', label: 'Style' }], fidelity: [{ key: 'loose', label: 'Loose' }], defaultRole: 'style', defaultFidelity: 'loose', max: 4, analyze: true };
const picture = (id: string): RefPicture => ({ id, name: `${id}.png`, image: `data:image/png;base64,${id}`, role: 'style', fidelity: 'loose', note: '', character: '' });
function Harness() {
  const [pictures, setPictures] = useState([picture('a'), picture('b')]);
  return <ReferenceImages root="/env" target="illustrious" model="qwen" vocab={vocab} pictures={pictures} onPictures={setPictures}/>;
}
let finish!: (text: string) => void;
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('deas.locale.v1', 'en');
  vi.mocked(invoke).mockImplementation(() => new Promise(resolve => { finish = resolve as (text: string) => void; }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('does not restore a reference removed while analysis was pending', async () => {
  render(<I18nProvider><Harness/></I18nProvider>);
  fireEvent.click(screen.getAllByRole('button', { name: 'Analyze' })[0]);
  fireEvent.click(document.querySelector('[data-forge-ref-remove]')!);
  expect(screen.queryByAltText('a.png')).toBeNull();
  await act(async () => finish('Old analysis'));
  expect(screen.queryByAltText('a.png')).toBeNull();
  expect(screen.getByAltText('b.png')).toBeTruthy();
});

it('keeps edits to the analyzed reference and its neighbors when analysis returns', async () => {
  render(<I18nProvider><Harness/></I18nProvider>);
  fireEvent.click(screen.getAllByRole('button', { name: 'Analyze' })[0]);
  const notes = document.querySelectorAll('[data-forge-ref-note]');
  fireEvent.change(notes[0], { target: { value: 'new note' } });
  fireEvent.change(notes[1], { target: { value: 'neighbor edit' } });
  await act(async () => finish('Old analysis'));
  expect((notes[0] as HTMLInputElement).value).toBe('new note');
  expect((notes[1] as HTMLInputElement).value).toBe('neighbor edit');
  expect(document.querySelector('[data-forge-readback]')?.hasAttribute('open')).toBe(false);
});
