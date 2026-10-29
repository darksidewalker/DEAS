import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { I18nProvider } from '../../i18n/I18nProvider';
import { MusicSettings } from './MusicSettings';
import { defaultAbc, defaultMusicGeneration, type AbcSettings, type MusicGenerationSettings, type MusicPlanning } from '../../lib/musicIntent';

beforeEach(() => localStorage.setItem('deas.locale.v1', 'en'));
afterEach(cleanup);

function Harness({ pipeline = 't2m' as 't2m' | 'cover', encoders = ['sheetsage2_bf16.safetensors'], onRead = vi.fn() }) {
  const [planning, setPlanning] = useState<MusicPlanning>('full');
  const [duration, setDuration] = useState(120);
  const [encoder, setEncoder] = useState('');
  const [abc, setAbc] = useState<AbcSettings>(defaultAbc);
  const [generation, setGeneration] = useState<MusicGenerationSettings>(defaultMusicGeneration);
  return <I18nProvider><MusicSettings pipeline={pipeline} planning={planning} onPlanning={setPlanning} maxDuration={duration} onMaxDuration={setDuration}
    encoder={encoder} encoders={encoders} onEncoder={setEncoder} onReadChoices={onRead} abc={abc} onAbc={setAbc} generation={generation} onGeneration={setGeneration}/>
    <output data-state>{JSON.stringify({ planning, duration, encoder, abc, generation })}</output></I18nProvider>;
}
const state = () => JSON.parse(document.querySelector('[data-state]')!.textContent!) as { planning: string; duration: number; encoder: string; abc: AbcSettings; generation: MusicGenerationSettings };
const input = (label: string, group: 'abc' | 'generation' = 'abc') => screen.getAllByLabelText(label).find(el => (el as HTMLInputElement).dataset.musicSetting?.startsWith(group)) as HTMLInputElement ?? screen.getByLabelText(label) as HTMLInputElement;

it('text-to-music exposes Off/Full/Melody, ABC settings only while planned, and AR settings always', () => {
  render(<Harness/>);
  const planning = screen.getByLabelText('ABC Planning') as HTMLSelectElement;
  expect([...planning.options].map(o => o.textContent)).toEqual(['Off', 'Full — melody and chords', 'Melody']);
  expect(document.querySelector('[data-music-abc-settings]')).not.toBeNull();
  expect(document.querySelector('[data-music-generation-settings]')).not.toBeNull();
  expect(screen.queryByLabelText('SheetSage2 audio encoder')).toBeNull();
  fireEvent.change(planning, { target: { value: 'off' } });
  expect(state().planning).toBe('off');
  expect(document.querySelector('[data-music-abc-settings]')).toBeNull();
  expect(document.querySelector('[data-music-generation-settings]')).not.toBeNull();
  fireEvent.change(planning, { target: { value: 'melody' } });
  expect(state().abc).toEqual(defaultAbc); // leaving and returning keeps the ABC values
});

it('numeric fields accept only values inside the native bounds and keep the previous value otherwise', () => {
  render(<Harness/>);
  fireEvent.change(input('Maximum ABC tokens'), { target: { value: '20001' } });
  expect(state().abc.maxTokens).toBe(8192);
  fireEvent.change(input('Maximum ABC tokens'), { target: { value: '1.5' } });
  expect(state().abc.maxTokens).toBe(8192);
  fireEvent.change(input('Maximum ABC tokens'), { target: { value: '4096' } });
  expect(state().abc.maxTokens).toBe(4096);
  fireEvent.change(input('Autoregressive guidance', 'generation'), { target: { value: '1.01' } });
  expect(state().generation.cfgScale).toBe(1.01);
  fireEvent.change(input('Top P'), { target: { value: '' } });
  expect(state().abc.topP).toBe(0.9);
  fireEvent.change(input('Maximum duration (seconds)'), { target: { value: '901' } });
  expect(state().duration).toBe(120);
  fireEvent.change(input('Maximum duration (seconds)'), { target: { value: '30.05' } });
  expect(state().duration).toBeCloseTo(30.04, 6); // snapped to the node's 0.04 s grid
});

it('cover shows fixed Melody planning, the encoder picker and the melody hint', () => {
  const onRead = vi.fn();
  render(<Harness pipeline="cover" onRead={onRead}/>);
  expect(screen.queryByLabelText('ABC Planning')).toBeNull();
  expect(document.querySelector('[data-music-planning="melody"]')!.textContent).toContain('Melody');
  expect(document.querySelector('[data-music-abc-settings]')).toBeNull();
  const encoder = screen.getByLabelText('SheetSage2 audio encoder') as HTMLSelectElement;
  expect(encoder.value).toBe('');
  expect([...encoder.options].map(o => o.textContent)).toEqual(['Select an installed SheetSage2 audio encoder.', 'sheetsage2_bf16.safetensors']);
  fireEvent.focus(encoder);
  expect(onRead).toHaveBeenCalled();
  fireEvent.change(encoder, { target: { value: 'sheetsage2_bf16.safetensors' } });
  expect(state().encoder).toBe('sheetsage2_bf16.safetensors');
  expect(screen.getByText("Uses the source melody; does not copy the singer's voice or automatically transcribe lyrics.")).toBeTruthy();
});
