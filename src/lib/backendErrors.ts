import type { TranslationParams } from './i18n';

/** Translate only native discovery error categories; preserve validation/execution errors. */
export function backendErrorText(error: unknown, t: (key: string, params?: TranslationParams) => string): string {
 const message = error instanceof Error ? error.message : String(error);
 if (message.startsWith('BACKEND_UNAVAILABLE:')) return t('studio.backend.unavailable');
 if (message.startsWith('BACKEND_TIMEOUT:')) return t('studio.backend.timeout');
 if (message.startsWith('BACKEND_REQUEST_FAILED:')) return t('studio.backend.requestFailed');
 const status = message.match(/^BACKEND_HTTP_ERROR: .* returned HTTP (\d{3})\b/)?.[1];
 return status ? t('studio.backend.httpError', { status }) : t(message);
}
