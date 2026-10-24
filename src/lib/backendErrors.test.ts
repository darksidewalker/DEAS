import { expect, it } from 'vitest';
import { bundledCatalog } from '../i18n/I18nProvider';
import { translate } from './i18n';
import { backendErrorText } from './backendErrors';

it.each(['en','de','fr','ja','tr','zh'])('localizes backend failures without exposing transport URLs (%s)', locale => {
 const t = (key: string, params?: Record<string, string|number>) => translate(bundledCatalog,locale,key,params);
 for (const [code,key] of [['BACKEND_UNAVAILABLE','studio.backend.unavailable'],['BACKEND_TIMEOUT','studio.backend.timeout'],['BACKEND_REQUEST_FAILED','studio.backend.requestFailed']]) {
  const text = backendErrorText(new Error(`${code}: object_info request failed http://127.0.0.1:45519/object_info`),t);
  expect(text).toBe(t(key));
  expect(text).not.toContain('45519');
  expect(text).not.toContain('object_info');
  expect(text).not.toContain(key);
 }
 expect(backendErrorText('BACKEND_HTTP_ERROR: object_info returned HTTP 503 Service Unavailable',t)).toBe(t('studio.backend.httpError',{status:'503'}));
});

it('does not relabel authentication, validation or execution failures as an unavailable backend', () => {
 const t = (key: string) => key;
 for (const message of ['object_info returned invalid JSON','Unknown checkpoint','HTTP_ERROR: forbidden','BACKEND_HTTP_ERROR: malformed status','Native job request failed; execution may be unknown']) {
  expect(backendErrorText(new Error(message),t)).toBe(message);
 }
});
