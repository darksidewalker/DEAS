import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createCatalog } from '../lib/i18n';
import { I18nProvider, useI18n } from './I18nProvider';

const catalog = createCatalog({
  de: { id: 'de', name: 'Deutsch', kind: 'language', version: 1 },
  en: { id: 'en', name: 'English', kind: 'language', version: 1 },
}, {
  '/src/locales/de.json': { 'app.greeting': 'Hallo {name}' },
  '/src/locales/en.json': { 'app.greeting': 'Hello {name}' },
});

function Probe() {
  const { t, locale, setLocale, languages } = useI18n();
  return <>
    <p>{t('app.greeting', { name: 'DEAS' })}</p>
    <output>{locale}</output>
    {languages.map(({ id, name }) => <button key={id} onClick={() => setLocale(id)}>{name}</button>)}
    <button onClick={() => setLocale('../unknown')}>Invalid</button>
  </>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute('lang');
});

function Mode() {
  const { custom, systemLocale, followSystemLocale } = useI18n();
  return <><span data-testid="mode">{custom ? 'custom' : `system:${systemLocale}`}</span><button onClick={followSystemLocale}>System</button></>;
}
const systemLanguages = (tags: string[]) => vi.spyOn(navigator, 'languages', 'get').mockReturnValue(tags);

test('follows the system language without storing it; an explicit choice is custom, persisted and undoable', () => {
  systemLanguages(['de-DE', 'en']);
  const view = render(<I18nProvider catalog={catalog}><Probe /><Mode /></I18nProvider>);
  expect(screen.getByText('Hallo DEAS')).toBeTruthy();
  expect(document.documentElement.lang).toBe('de');
  expect(screen.getByTestId('mode').textContent).toBe('system:de');
  expect(localStorage.getItem('deas.locale.v1')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  expect(screen.getByText('Hello DEAS')).toBeTruthy();
  expect(screen.getByTestId('mode').textContent).toBe('custom');
  expect(localStorage.getItem('deas.locale.v1')).toBe('en');
  fireEvent.click(screen.getByRole('button', { name: 'Invalid' }));
  expect(screen.getByText('Hello DEAS')).toBeTruthy();
  view.unmount();
  render(<I18nProvider catalog={catalog}><Probe /><Mode /></I18nProvider>);
  expect(screen.getByText('Hello DEAS')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'System' }));
  expect(screen.getByText('Hallo DEAS')).toBeTruthy();
  expect(localStorage.getItem('deas.locale.v1')).toBeNull();
});

test('unbundled system languages fall back to English; an invalid stored choice is dropped', () => {
  systemLanguages(['pt-BR']);
  localStorage.setItem('deas.locale.v1', 'missing');
  render(<I18nProvider catalog={catalog}><Probe /><Mode /></I18nProvider>);
  expect(screen.getByText('Hello DEAS')).toBeTruthy();
  expect(screen.getByTestId('mode').textContent).toBe('system:en');
  expect(localStorage.getItem('deas.locale.v1')).toBeNull();
});

test('storage denial does not break selection or translation', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  render(<I18nProvider catalog={catalog}><Probe /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  expect(screen.getByText('Hello DEAS')).toBeTruthy();
  expect(document.documentElement.lang).toBe('en');
});
