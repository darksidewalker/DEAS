import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { negotiateApi, type ApiNegotiation } from '../../lib/api';

export function ApiNegotiationPanel({ endpoint }: { endpoint: string }) {
  const { t } = useI18n();
  const epoch = useRef(0);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ApiNegotiation | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    epoch.current++;
    busy.current = false;
    setPending(false); setResult(null); setError('');
    return () => { epoch.current++; busy.current = false; };
  }, [endpoint]);
  async function check() {
    if (busy.current || !endpoint.trim()) return;
    busy.current = true;
    const version = ++epoch.current;
    setPending(true); setResult(null); setError('');
    try {
      const value = await negotiateApi(endpoint);
      if (version === epoch.current) setResult(value);
    } catch (failure) {
      if (version === epoch.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (version === epoch.current) { busy.current = false; setPending(false); }
    }
  }
  return <div className="inspection-detail" data-api-negotiation>
    <div><h3>{t('studio.api.title')}</h3><p>{t('studio.api.notice')}</p>
      <button type="button" className="action-button" disabled={pending || !endpoint.trim()} onClick={() => void check()}>{t(pending ? 'studio.api.checking' : 'studio.api.check')}</button>
      <div aria-live="polite" aria-busy={pending}>
        {error && <p className="status-message error-message" role="alert">{t('studio.api.failed')}: {error}</p>}
        {result && <><p role="status"><strong>{t(result.protocol === 'v2' ? 'studio.api.v2' : 'studio.api.classic')}</strong> · {result.baseUrl}</p><p className="field-help">{t('studio.api.notReady')}</p></>}
      </div>
    </div>
  </div>;
}
