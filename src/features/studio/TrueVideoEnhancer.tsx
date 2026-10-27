import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { checkVideoPostDraft, type VideoPostDraft, type VideoPostInspection, type VideoPostSettings } from '../../lib/videoPost';
import { VideoPostProcessing } from './VideoPostProcessing';
import './TrueVideoEnhancer.css';

const blockerCodes = ['cadenceUnknown', 'cadenceMismatch', 'interlaced', 'rotation', 'alpha', 'hdr', 'colorUnknown', 'unsupportedPixelFormat', 'multipleVideoStreams', 'unsupportedDimensions', 'fieldOrderUnknown', 'nonSquarePixels', 'pixelAspectUnknown', 'outputDimensions', 'subtitlesUnsupported'];

export function TrueVideoEnhancer() {
  const { t } = useI18n();
  const [source, setSource] = useState<VideoPostInspection | null>(null);
  const [settings, setSettings] = useState<VideoPostSettings>({ scale: 2, profile: 'mp4-h264' });
  const [draft, setDraft] = useState<VideoPostDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);

  function invalidate() {
    epoch.current++;
    setDraft(null);
    setError(null);
  }
  function inspected(value: VideoPostInspection) {
    invalidate();
    setSource(value);
  }
  function options(value: VideoPostSettings) {
    invalidate();
    setSettings(value);
  }
  async function check() {
    if (!source || pending.current || !isTauri()) return;
    const current = epoch.current;
    pending.current = true;
    setBusy(true);
    setDraft(null);
    setError(null);
    try {
      const value = await checkVideoPostDraft(source, settings);
      if (epoch.current === current) setDraft(value);
    } catch (failure) {
      if (epoch.current === current) setError(failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : String(failure));
    } finally {
      pending.current = false;
      // A changed draft still waits for the old read-only request to settle.
      if (mounted.current) setBusy(false);
    }
  }
  // Source diagnostics already appear beside the inspector.
  const outputBlockers = draft?.blockers.filter(code => !source?.blockers.includes(code)) ?? [];
  return <section className="tve" data-tve aria-label={t('studio.tve.title')}>
    <header className="tve-heading"><div><p className="eyebrow">{t('studio.tab.tve')}</p><h2>{t('studio.tve.title')}</h2></div><span className="plugin-kind">{t('studio.tve.draft')}</span></header>
    <div className="tve-columns">
      <section className="tve-panel"><h3>{t('studio.tve.source')}</h3><VideoPostProcessing onInspected={inspected}/></section>
      <section className="tve-panel" aria-label={t('studio.tve.output')} aria-busy={busy}>
        <h3>{t('studio.tve.output')}</h3>
        <div className="tve-options">
          <label>{t('studio.tve.scale')}<select data-tve-scale value={settings.scale} onChange={e => options({ ...settings, scale: Number(e.target.value) as VideoPostSettings['scale'] })}>{([1, 2, 4] as const).map(scale => <option key={scale} value={scale}>{scale}×</option>)}</select></label>
          <label>{t('studio.tve.profile')}<select data-tve-profile value={settings.profile} onChange={e => options({ ...settings, profile: e.target.value as VideoPostSettings['profile'] })}><option value="mp4-h264">{t('studio.tve.profile.mp4')}</option><option value="mkv-h264">{t('studio.tve.profile.mkv')}</option><option value="webm-vp9">{t('studio.tve.profile.webm')}</option></select></label>
        </div>
        <button type="button" className="wb-dock-action" data-tve-check disabled={!source || busy || !isTauri()} onClick={() => void check()}>{t(busy ? 'studio.tve.checking' : 'studio.tve.check')}</button>
        {!source && <p className="field-help">{t('studio.tve.needsSource')}</p>}
        {error !== null && <p role="alert">{t('studio.tve.failed')}: {error}</p>}
        {draft && <div className="tve-draft" data-tve-draft>
          <strong>{draft.output.filename}</strong>
          <dl>
            <div><dt>{t('studio.tve.geometry')}</dt><dd>{draft.output.width} × {draft.output.height}</dd></div>
            <div><dt>{t('studio.tve.fps')}</dt><dd>{t('studio.tve.rate', { numerator: draft.output.fpsNumerator, denominator: draft.output.fpsDenominator })}</dd></div>
            <div><dt>{t('studio.tve.video')}</dt><dd>{draft.output.container} · {draft.output.videoEncoder} · {draft.output.pixelFormat}</dd></div>
            <div><dt>{t('studio.tve.audio')}</dt><dd>{draft.output.audioEncoder ? <>{draft.output.audioEncoder}{draft.output.audioBitrate !== undefined && ` · ${draft.output.audioBitrate} bit/s`}</> : t('studio.tve.noAudio')}</dd></div>
          </dl>
          {outputBlockers.length > 0 && <ul>{outputBlockers.map((code, index) => <li key={`${code}-${index}`} data-tve-blocker>{t(`studio.videoPost.blocker.${blockerCodes.includes(code) ? code : 'unknown'}`)}</li>)}</ul>}
        </div>}
        <p className="field-help tve-limit">{t('studio.tve.limit')}</p>
      </section>
    </div>
  </section>;
}
