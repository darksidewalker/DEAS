import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { bindVideoPost, runVideoPost, videoPostCapabilities, videoPostJobCommand, type VideoPostBinding, type VideoPostJob, checkVideoPostDraft, prepareVideoPost, recheckVideoPost, type VideoPostPrepared, type VideoPostDraft, type VideoPostInspection, type VideoPostSettings } from '../../lib/videoPost';
import { VideoPostProcessing } from './VideoPostProcessing';
import './TrueVideoEnhancer.css';

const blockerCodes = ['cadenceUnknown', 'cadenceMismatch', 'interlaced', 'rotation', 'alpha', 'hdr', 'colorUnknown', 'unsupportedPixelFormat', 'multipleVideoStreams', 'unsupportedDimensions', 'fieldOrderUnknown', 'nonSquarePixels', 'pixelAspectUnknown', 'outputDimensions', 'subtitlesUnsupported'];

export function TrueVideoEnhancer() {
  const { t } = useI18n();
  const [source, setSource] = useState<VideoPostInspection | null>(null);
  const [settings, setSettings] = useState<VideoPostSettings>({ scale: 2, profile: 'mp4-h264' });
  const [draft, setDraft] = useState<VideoPostDraft | null>(null);
  const [prepared, setPrepared] = useState<VideoPostPrepared | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const [available, setAvailable] = useState(false);
  const [binding, setBinding] = useState<VideoPostBinding | null>(null);
  const [job, setJob] = useState<VideoPostJob | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const capability = useRef<Promise<boolean> | null>(null);
  const jobEpoch = useRef(0);
  const jobRef = useRef<VideoPostJob | null>(null);
  const statusPending = useRef(false);
  const stopPending = useRef(false);
  const active = !!job && ['starting', 'running', 'stopping'].includes(job.state);
  const detail = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);
  function updateJob(value: VideoPostJob) { jobRef.current = value; setJob(value); }
  useEffect(() => {
    mounted.current = true;
    let live = true;
    if (isTauri()) {
      capability.current ??= videoPostCapabilities();
      void capability.current.then(value => { if (live) setAvailable(value); }, () => { if (live) setAvailable(false); });
    }
    return () => { live = false; mounted.current = false; epoch.current++; jobEpoch.current++; };
  }, []);
  useEffect(() => {
    if (!active || jobError || !job || !isTauri()) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const id = job.id;
    async function poll() {
      if (!live) return;
      if (statusPending.current || stopPending.current) { timer = setTimeout(() => void poll(), 750); return; }
      const current = jobEpoch.current;
      statusPending.current = true;
      try {
        const value = await videoPostJobCommand('status', id);
        if (live && mounted.current && current === jobEpoch.current && jobRef.current?.id === id) updateJob(value);
      } catch (failure) {
        if (live && mounted.current && current === jobEpoch.current) setJobError(detail(failure));
      } finally {
        statusPending.current = false;
        if (live) timer = setTimeout(() => void poll(), 750);
      }
    }
    timer = setTimeout(() => void poll(), 750);
    return () => { live = false; clearTimeout(timer); };
  }, [active, job?.id, job?.state, jobError]);
  async function bind() {
    if (!available || !isTauri() || pending.current || active) return;
    pending.current = true; setBusy(true); setBindingError(null);
    try {
      const value = await bindVideoPost({ runtime: t('studio.tve.runtimeDialog'), model: t('studio.tve.modelDialog'), dependency: t('studio.tve.dependencyDialog') });
      if (mounted.current && value) setBinding(value);
    } catch (failure) { if (mounted.current) setBindingError(detail(failure)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function run() {
    if (!available || !isTauri() || !prepared || !binding || pending.current || active) return;
    pending.current = true; setBusy(true); setJobError(null);
    const current = ++jobEpoch.current;
    try {
      const value = await runVideoPost(prepared.id, binding.id);
      if (mounted.current && current === jobEpoch.current) updateJob(value);
    } catch (failure) { if (mounted.current && current === jobEpoch.current) setJobError(detail(failure)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function stop() {
    const target = jobRef.current;
    if (!isTauri() || !target || !['starting', 'running'].includes(target.state) || stopPending.current) return;
    stopPending.current = true; setStopBusy(true);
    const current = ++jobEpoch.current;
    try {
      const value = await videoPostJobCommand('stop', target.id);
      if (mounted.current && current === jobEpoch.current && jobRef.current?.id === target.id) { setJobError(null); updateJob(value); }
    } catch (failure) { if (mounted.current && current === jobEpoch.current) setJobError(detail(failure)); }
    finally { stopPending.current = false; if (mounted.current) setStopBusy(false); }
  }

  function invalidate() {
    epoch.current++;
    setDraft(null);
    setPrepared(null);
    setPrepareError(null);
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
  async function preparation(recheck = false) {
    if (!source?.sourceId || settings.profile !== 'mp4-h264' || pending.current || !isTauri() || (recheck && !prepared)) return;
    const current = epoch.current;
    pending.current = true;
    setBusy(true);
    setPrepareError(null);
    try {
      const value = recheck ? await recheckVideoPost(prepared!) : await prepareVideoPost(source.sourceId, settings, t('studio.tve.outputDialog'));
      if (mounted.current && epoch.current === current && value) setPrepared(value);
    } catch (failure) {
      if (mounted.current && epoch.current === current) {
        if (recheck) setPrepared(null);
        setPrepareError(failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : String(failure));
      }
    } finally {
      pending.current = false;
      // Keep the chooser lock even after edits invalidate this request.
      if (mounted.current) setBusy(false);
    }
  }
  // Source diagnostics already appear beside the inspector.
  const outputBlockers = draft?.blockers.filter(code => !source?.blockers.includes(code)) ?? [];
  return <section className="tve" data-tve aria-label={t('studio.tve.title')}>
    <header className="tve-heading"><div><p className="eyebrow">{t('studio.tab.tve')}</p><h2>{t('studio.tve.title')}</h2></div><span className="plugin-kind" data-tve-build-mode={available ? 'native' : 'draft'}>{t(available ? 'studio.tve.engineIncluded' : 'studio.tve.draft')}</span></header>
    <div className="tve-columns">
      <section className="tve-panel"><h3>{t('studio.tve.source')}</h3><VideoPostProcessing onInspected={inspected} disabled={busy} acquire={() => { if (pending.current) return false; pending.current = true; setBusy(true); return true; }} release={() => { pending.current = false; if (mounted.current) setBusy(false); }}/></section>
      <section className="tve-panel" aria-label={t('studio.tve.output')} aria-busy={busy}>
        <h3>{t('studio.tve.output')}</h3>
        <div className="tve-options">
          <label>{t('studio.tve.scale')}<select data-tve-scale value={settings.scale} onChange={e => options({ ...settings, scale: Number(e.target.value) as VideoPostSettings['scale'] })}>{([1, 2, 4] as const).map(scale => <option key={scale} value={scale}>{scale}×</option>)}</select></label>
          <label>{t('studio.tve.profile')}<select data-tve-profile value={settings.profile} onChange={e => options({ ...settings, profile: e.target.value as VideoPostSettings['profile'] })}><option value="mp4-h264">{t('studio.tve.profile.mp4')}</option><option value="mkv-h264">{t('studio.tve.profile.mkv')}</option><option value="webm-vp9">{t('studio.tve.profile.webm')}</option></select></label>
        </div>
        <button type="button" className="wb-dock-action" data-tve-check disabled={!source || busy || !isTauri()} onClick={() => void check()}>{t(busy ? 'studio.tve.checking' : 'studio.tve.check')}</button>
        <div className="tve-actions">
          <button type="button" className="wb-dock-action" data-tve-prepare disabled={!source?.sourceId || settings.profile !== 'mp4-h264' || busy || !isTauri()} onClick={() => void preparation()}>{t('studio.tve.prepare')}</button>
          {prepared && <button type="button" className="wb-dock-action" data-tve-recheck disabled={busy || !isTauri()} onClick={() => void preparation(true)}>{t('studio.tve.recheck')}</button>}
        </div>
        {prepareError !== null && <p role="alert" data-tve-prepare-error>{t('studio.tve.prepareFailed')}: {prepareError}</p>}
        {prepared && <div className="tve-draft" data-tve-prepared>
          <dl>
            <div><dt>{t('studio.tve.source')}</dt><dd>{prepared.sourceName}</dd></div>
            <div><dt>{t('studio.tve.output')}</dt><dd>{prepared.outputName}</dd></div>
            <div><dt>{t('studio.tve.geometry')}</dt><dd>{prepared.width} × {prepared.height}</dd></div>
            <div><dt>{t('studio.tve.fps')}</dt><dd>{t('studio.tve.rate', { numerator: prepared.fpsNumerator, denominator: prepared.fpsDenominator })}</dd></div>
          </dl>
          <p className="field-help tve-limit">{t('studio.tve.prepareLimit')}</p>
        </div>}
        {!source && <p className="field-help">{t('studio.tve.needsSource')}</p>}
        {error !== null && <p role="alert">{t('studio.tve.failed')}: {error}</p>}
        {draft && <div className="tve-draft" data-tve-draft>
          <strong>{draft.output.filename}</strong>
          <dl>
            <div><dt>{t('studio.tve.geometry')}</dt><dd>{draft.output.width} × {draft.output.height}</dd></div>
            <div><dt>{t('studio.tve.fps')}</dt><dd>{t('studio.tve.rate', { numerator: draft.output.fpsNumerator, denominator: draft.output.fpsDenominator })}</dd></div>
            <div><dt>{t('studio.tve.video')}</dt><dd>{draft.output.container} · {draft.output.videoEncoder} · {draft.output.pixelFormat}</dd></div>
            <div><dt>{t('studio.tve.audio')}</dt><dd>{draft.output.audioEncoder ? <>{draft.output.audioEncoder}{draft.output.audioBitrate !== undefined && ` · ${t('studio.tve.bitrate', { bitrate: draft.output.audioBitrate })}`}</> : t('studio.tve.noAudio')}</dd></div>
          </dl>
          {outputBlockers.length > 0 && <ul>{outputBlockers.map((code, index) => <li key={`${code}-${index}`} data-tve-blocker>{t(`studio.videoPost.blocker.${blockerCodes.includes(code) ? code : 'unknown'}`)}</li>)}</ul>}
        </div>}
        <section className="tve-runtime" aria-label={t('studio.tve.binding')}>
          <h3>{t('studio.tve.binding')}</h3>
          <p className="field-help">{t('studio.tve.trust')}</p>
          {!available && <p className="field-help">{t('studio.tve.unavailable')}</p>}
          <button type="button" className="wb-dock-action" data-tve-bind disabled={!available || !isTauri() || busy || active} onClick={() => void bind()}>{t('studio.tve.bind')}</button>
          {bindingError && <p role="alert">{t('studio.tve.bindFailed')}: {bindingError}</p>}
          {binding && <dl data-tve-profile-binding>
            <div><dt>{t('studio.tve.runtime')}</dt><dd>{binding.runtimeName}</dd></div>
            <div><dt>{t('studio.tve.model')}</dt><dd>{binding.modelName}</dd></div>
            {binding.dependencyName && <div><dt>{t('studio.tve.dependency')}</dt><dd>{binding.dependencyName}</dd></div>}
          </dl>}
          <p className="field-help">{t('studio.tve.runChecks')}</p>
          <div className="tve-actions">
            <button type="button" className="wb-dock-action" data-tve-run disabled={!available || !isTauri() || !prepared || !binding || busy || active} onClick={() => void run()}>{t('studio.tve.run')}</button>
            <button type="button" className="wb-dock-action" data-tve-stop disabled={!isTauri() || !active || job?.state === 'stopping' || stopBusy} onClick={() => void stop()}>{t('studio.tve.stop')}</button>
          </div>
          {job && <div className="tve-draft" data-tve-job data-state={job.state} aria-live="polite">
            <strong>{t(`studio.tve.state.${job.state}`)}</strong>
            <dl>
              <div><dt>{t('studio.tve.source')}</dt><dd>{job.sourceName}</dd></div>
              <div><dt>{t('studio.tve.outputFile')}</dt><dd>{job.outputName}</dd></div>
              {job.frames !== undefined && <div><dt>{t('studio.tve.frames')}</dt><dd>{job.frames}</dd></div>}
              {job.width !== undefined && job.height !== undefined && <div><dt>{t('studio.tve.geometry')}</dt><dd>{job.width} × {job.height}</dd></div>}
            </dl>
            {job.error && <p role="alert" data-tve-job-error>{t('studio.tve.jobFailed')}: {job.error}</p>}
          </div>}
          {jobError && <p role="alert" data-tve-job-error>{t('studio.tve.jobControlFailed')}: {jobError}</p>}
        </section>
        <p className="field-help tve-limit">{t('studio.tve.limit')}</p>
      </section>
    </div>
  </section>;
}
