import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { readStartMode, writeStartMode, DEFAULT_START_MODE, START_MODES, type StartMode } from '../../lib/window';

/**
 * How DEAS's own window opens on the next start. Choosing never rearranges the window the user is looking at,
 * so a fullscreen choice can always be undone before it takes effect.
 */
export function WindowSetting() {
 const { t } = useI18n();
 const [mode, setMode] = useState<StartMode | null>(null);
 const [saved, setSaved] = useState(false);
 const [error, setError] = useState('');
 useEffect(() => {
  let alive = true;
  // The native store is the authority; a failure leaves the documented default visible.
  void readStartMode().then(value => { if (alive) setMode(value); }, () => { if (alive) setMode(DEFAULT_START_MODE); });
  return () => { alive = false; };
 }, []);
 async function choose(next: string) {
  if (!isMode(next) || mode === next) return;
  setSaved(false); setError('');
  try { setMode(await writeStartMode(next)); setSaved(true); }
  catch (e) { setError(e instanceof Error ? e.message : String(e)); }
 }
 return <section className="feature-panel download-module window-setting">
  <div className="download-controls">
   <label htmlFor="window-start-mode">{t('settings.window.title')}
    <select id="window-start-mode" data-window-start-mode aria-label={t('settings.window.title')} value={mode ?? ''} disabled={mode === null} onChange={e => void choose(e.target.value)}>
     {mode === null && <option value="">{t('settings.window.reading')}</option>}
     {START_MODES.map(id => <option key={id} value={id}>{t(`settings.window.${id}`)}</option>)}
    </select></label>
   <p className="field-help">{t('settings.window.help')}</p>
   {saved && <p role="status" className="field-help">{t('settings.window.saved')}</p>}
   {error && <p className="error-message" role="alert">{t('settings.window.error')}: {error}</p>}
  </div>
 </section>;
}

function isMode(value: string): value is StartMode { return (START_MODES as readonly string[]).includes(value); }
