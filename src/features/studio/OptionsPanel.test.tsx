import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../../i18n/I18nProvider';
import { OptionsPanel, defaultOptions, isOptionsPref, parseSigmas, runOptions, sigmaPresets, type OptionsPref } from './OptionsPanel';

const allow = { nodes: ['ModelAttentionBackend', 'EasyCache', 'VAEDecodeTiled'], attention: ['pytorch attention', 'comfy kitchen attention'], sage: [], compile: [] };
const all: OptionsPref = { attention: 'a:comfy kitchen attention', vae: 'tiled', tile: 768, cache: 'EasyCache', threshold: 0.3, compile: 'inductor' };

beforeEach(() => { localStorage.clear(); localStorage.setItem('deas.locale.v1', 'en'); });
afterEach(() => cleanup());

describe('run options', () => {
  it('submits only what the read backend lists, nothing by default', () => {
    expect(runOptions(defaultOptions, allow)).toBeUndefined();
    expect(runOptions(all, allow)).toEqual({ attention: 'comfy kitchen attention', cache: { node: 'EasyCache', threshold: 0.3 }, vaeTile: 768 });
    expect(runOptions({ ...all, attention: 's:auto' }, allow)).toEqual({ cache: { node: 'EasyCache', threshold: 0.3 }, vaeTile: 768 });
    // Unread backend: native preparation checks the remembered choices.
    expect(runOptions({ ...all, attention: 'a:pytorch attention' }, null)).toEqual({ attention: 'pytorch attention', cache: { node: 'EasyCache', threshold: 0.3 }, compile: 'inductor', vaeTile: 768 });
    // torch.compile cannot trace the Comfy Kitchen kernel.
    expect(runOptions(all, null)?.compile).toBeUndefined();
  });

  it('rejects stale or malformed remembered state', () => {
    expect(isOptionsPref(all)).toBe(true);
    for (const bad of [null, { ...all, tile: 500 }, { ...all, cache: 'TeaCache' }, { ...all, threshold: 4 }, { ...all, vae: 'x' }, { ...all, sigmas: 3 }]) expect(isOptionsPref(bad)).toBe(false);
  });

  it('parses custom sigma text like ManualSigmas and the native validator', () => {
    expect(parseSigmas(' 1, 0.5,0 ')).toEqual([1, 0.5, 0]);
    expect(parseSigmas('1 0.5 0')).toEqual([1, 0.5, 0]);
    for (const bad of ['', '1', '1, 0.5', '1, 0.5, 0.5, 0', '0.5, 1, 0', '1, x, 0', '-1, 0']) expect(parseSigmas(bad)).toBeNull();
  });

  it('shows the model schedule, offers the known presets and keeps a typed override', () => {
    const onChange = vi.fn();
    const turbo = sigmaPresets.find(f => f.id === 'qwen-image-2.1-turbo')!;
    const { rerender } = render(<I18nProvider><OptionsPanel value={defaultOptions} onChange={onChange} allow={allow} family="qwen-image-2.1-turbo" imageInput={false} onRead={vi.fn()} canRead/></I18nProvider>);
    const field = screen.getByRole('textbox', { name: 'Custom sigmas' }) as HTMLInputElement;
    expect(field.value).toBe('1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0');
    expect((screen.getByRole('combobox', { name: 'Sigma preset' }) as HTMLSelectElement).value).toBe('qwen-image-2.1-turbo');
    fireEvent.change(field, { target: { value: '1, 0.5, 0' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultOptions, sigmas: '1, 0.5, 0' });
    // Another model: no schedule of its own, the preset list fills the text.
    rerender(<I18nProvider><OptionsPanel value={defaultOptions} onChange={onChange} allow={allow} family="sdxl" imageInput={false} onRead={vi.fn()} canRead/></I18nProvider>);
    expect((screen.getByRole('textbox', { name: 'Custom sigmas' }) as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByRole('combobox', { name: 'Sigma preset' }), { target: { value: 'qwen-image-2.1-turbo' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultOptions, sigmas: turbo.sigmas.join(', ') });
    rerender(<I18nProvider><OptionsPanel value={{ ...defaultOptions, sigmas: '1, 0.5' }} onChange={onChange} allow={allow} family="sdxl" imageInput={false} onRead={vi.fn()} canRead/></I18nProvider>);
    expect(screen.getByText(/^Invalid/)).toBeTruthy();
  });

  it('keeps help behind ? and lists the naming placeholders, invalid naming stays visible', () => {
    const { rerender } = render(<I18nProvider><OptionsPanel value={defaultOptions} onChange={vi.fn()} allow={allow} imageInput={false} onRead={vi.fn()} canRead/></I18nProvider>);
    expect(screen.queryByText(/^Relative to Output/)).toBeNull();
    const button = screen.getByRole('button', { name: 'Explain Output naming' });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    for (const k of ['%type%', '%date_yyyy-mm-dd%', '%time%', '%seed%', '%model%']) expect(screen.getByText(k)).toBeTruthy();
    expect(screen.getByText('My-Model')).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByText('%seed%')).toBeNull();
    rerender(<I18nProvider><OptionsPanel value={{ ...defaultOptions, outputNaming: '../%seed%' }} onChange={vi.fn()} allow={allow} imageInput={false} onRead={vi.fn()} canRead/></I18nProvider>);
    expect(screen.getByRole('alert').textContent).toMatch(/^Invalid naming/);
  });

  it('offers listed backends, disables missing node packs and asks before reading', () => {
    const onChange = vi.fn(), onRead = vi.fn();
    const { rerender } = render(<I18nProvider><OptionsPanel value={defaultOptions} onChange={onChange} allow={null} imageInput={false} onRead={onRead} canRead/></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Read options' }));
    expect(onRead).toHaveBeenCalledOnce();
    rerender(<I18nProvider><OptionsPanel value={defaultOptions} onChange={onChange} allow={allow} imageInput={false} onRead={onRead} canRead/></I18nProvider>);
    expect(screen.queryByRole('button', { name: 'Read options' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Attention backend' }), { target: { value: 'a:comfy kitchen attention' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultOptions, attention: 'a:comfy kitchen attention' });
    expect((screen.getByRole('option', { name: 'LazyCache' }) as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByRole('option', { name: /^Spectrum H3/ }) as HTMLOptionElement).disabled).toBe(true);
  });
});
