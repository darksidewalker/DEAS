import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bundledCatalog, I18nProvider } from '../../i18n/I18nProvider';
import { matchEntries, searchIndex } from '../../lib/search';
import { GlobalSearch } from './GlobalSearch';

beforeEach(() => localStorage.setItem('deas.locale.v1', 'en'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.querySelectorAll('[data-num="steps"]').forEach((element) => element.remove());
});

const mount = (onNavigate = vi.fn()) => {
  render(<I18nProvider><GlobalSearch onNavigate={onNavigate} /></I18nProvider>);
  return onNavigate;
};

test('Ctrl+K opens the search, Escape closes it', () => {
  mount();
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const input = screen.getByPlaceholderText('Find a control…');
  expect(input).toBeTruthy();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByPlaceholderText('Find a control…')).toBeNull();
});

test('every indexed label, section and reason exists in all six languages', () => {
  for (const entry of searchIndex) {
    for (const key of [entry.tab, entry.section, entry.label, ...(entry.reason ? [entry.reason] : [])]) {
      for (const language of bundledCatalog.languages) {
        expect(bundledCatalog.dictionaries[language.id][key], `${language.id}:${key}`).toBeTypeOf('string');
      }
    }
  }
});

test('a hit switches tab, reveals and flashes the control; an unavailable hit shows its reason', async () => {
  const steps = document.createElement('input');
  steps.setAttribute('data-num', 'steps');
  document.body.appendChild(steps);
  const onNavigate = mount();
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  fireEvent.change(screen.getByPlaceholderText('Find a control…'), { target: { value: 'steps' } });
  fireEvent.click(screen.getByRole('button', { name: /Studio › Settings › Steps/ }));
  await waitFor(() => expect(steps.classList.contains('search-flash')).toBe(true));
  expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ view: 'studio', studioTab: 'generate', target: '[data-num="steps"]' }));

  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  fireEvent.change(screen.getByPlaceholderText('Find a control…'), { target: { value: 'checkpoint' } });
  fireEvent.click(screen.getByRole('button', { name: /Studio › Settings › Checkpoint/ }));
  expect(await screen.findByText('Requires a model from the backend', {}, { timeout: 3000 })).toBeTruthy();
});

test('a disabled control shows its own explanation, then the entry reason', async () => {
  const cfg = document.createElement('input');
  cfg.setAttribute('data-num', 'cfg');
  cfg.disabled = true;
  cfg.setAttribute('title', 'Custom schedule fixes CFG');
  document.body.appendChild(cfg);
  mount();
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  fireEvent.change(screen.getByPlaceholderText('Find a control…'), { target: { value: 'cfg' } });
  fireEvent.click(screen.getByRole('button', { name: /Studio › Settings › CFG/ }));
  expect(await screen.findByText('Custom schedule fixes CFG', {}, { timeout: 3000 })).toBeTruthy();
  cfg.remove();
});

test('matching uses the current language and English aliases, and stays read-only', () => {
  const text = (key: string) => `${bundledCatalog.dictionaries.en[key] ?? key} ${bundledCatalog.dictionaries.de[key] ?? key}`;
  expect(matchEntries(searchIndex, 'Ausführen', text).map((entry) => entry.target)).toContain('[data-run]');
  expect(matchEntries(searchIndex, 'prompt', text).length).toBeGreaterThan(0);
  expect(matchEntries(searchIndex, '', text)).toHaveLength(12);
  expect(localStorage.getItem('deas.locale.v1')).toBe('en');
});
