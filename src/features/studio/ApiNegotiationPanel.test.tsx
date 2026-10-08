import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import { negotiateApi, type ApiNegotiation } from '../../lib/api';
import { ApiNegotiationPanel } from './ApiNegotiationPanel';
vi.mock('../../lib/api', () => ({ negotiateApi: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); });
function view(endpoint = 'http://127.0.0.1:7801') {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  return <I18nProvider><ApiNegotiationPanel endpoint={endpoint} /></I18nProvider>;
}
const result: ApiNegotiation = {baseUrl:'http://127.0.0.1:7801/', protocol:'classic', generationReady:false, capabilities:['classicQueueStatus']};
test('only explicit action negotiates; reports protocol but never generation readiness', async () => {
  vi.mocked(negotiateApi).mockResolvedValue(result);
  render(view());
  expect(negotiateApi).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {name:'Check execution API'}));
  expect(await screen.findByText('Classic API')).toBeTruthy();
  expect(screen.getByText(/Generation has not been verified/)).toBeTruthy();
  expect(negotiateApi).toHaveBeenCalledWith('http://127.0.0.1:7801');
  expect(screen.queryByRole('button', {name:/run|generate|cancel/i})).toBeNull();
});
test('endpoint edits invalidate evidence and stale requests, without another automatic probe', async () => {
  let resolve!: (value:ApiNegotiation)=>void;
  vi.mocked(negotiateApi).mockReturnValue(new Promise(r=>{resolve=r;}));
  const rendered=render(view());
  fireEvent.click(screen.getByRole('button', {name:'Check execution API'}));
  expect(screen.getByRole('button', {name:'Checking execution API…'}).hasAttribute('disabled')).toBe(true);
  rendered.rerender(view('http://127.0.0.1:8189'));
  await act(async()=>resolve(result));
  expect(screen.queryByText('Classic API')).toBeNull();
  expect(negotiateApi).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', {name:'Check execution API'}).hasAttribute('disabled')).toBe(false);
});
test('failures remain visible and retryable without classic success or submission', async () => {
  vi.mocked(negotiateApi).mockRejectedValue(new Error('authentication · api/v2/jobs: HTTP 401'));
  render(view());
  fireEvent.click(screen.getByRole('button', {name:'Check execution API'}));
  expect((await screen.findByRole('alert')).textContent).toContain('authentication');
  expect(screen.queryByText('Classic API')).toBeNull();
  expect(screen.getByRole('button', {name:'Check execution API'}).hasAttribute('disabled')).toBe(false);
});
test('successful evidence clears on endpoint change and unmounted results are discarded', async () => {
  vi.mocked(negotiateApi).mockResolvedValue({...result,protocol:'v2'});
  const rendered=render(view());
  fireEvent.click(screen.getByRole('button', {name:'Check execution API'}));
  expect(await screen.findByText('API v2')).toBeTruthy();
  rendered.rerender(view('http://127.0.0.1:8189'));
  expect(screen.queryByText('API v2')).toBeNull();
  let resolve!: (value:ApiNegotiation)=>void;
  vi.mocked(negotiateApi).mockReturnValue(new Promise(r=>{resolve=r;}));
  fireEvent.click(screen.getByRole('button', {name:'Check execution API'}));
  rendered.unmount();
  await act(async()=>resolve(result));
  expect(screen.queryByText('Classic API')).toBeNull();
});
