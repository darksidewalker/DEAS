import { useLayoutEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { readCurrentWorkbench, readH3Session, runWorkbenchJob, waitForWorkbenchJob, type H3Clip } from '../../lib/jobs';
import { inspectVideoPost, uploadVideoPostSource } from '../../lib/videoPost';
import { useI18n } from '../../i18n/I18nProvider';
import type { H3JoinIntentV1 } from '../../lib/videoIntent';

export interface ContinuityJoinProps { endpoint?: string; session: string; running: boolean; disabled: boolean }
interface Preflight { ok: boolean; issues: string[]; seconds: number; mode: string }
interface JoinFile { filename: string; label: string; duration: number | null; trimStart: string; trimEnd: string }
const secondsOrNull = (value: string) => (value.trim() === '' ? null : Number(value));

/** Director-parity Join clips: assemble one session's saved segments, or chosen video files, into one video without loading a model. */
export function ContinuityJoin({ endpoint, session, running, disabled }: ContinuityJoinProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'segments' | 'files'>('segments');
  const [clips, setClips] = useState<H3Clip[]>([]);
  const [files, setFiles] = useState<JoinFile[]>([]);
  const [failed, setFailed] = useState(false);
  const [chain, setChain] = useState<string[] | null>(null);
  const [copy, setCopy] = useState(false);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const locked = running || busy;
  useLayoutEffect(() => {
    const id = ++request.current;
    setClips([]); setChain(null); setPreflight(null); setResult(null); setError(null); setFailed(false);
    if (!isTauri() || !endpoint) return;
    readH3Session(endpoint, session)
      .then(value => { if (request.current === id) setClips(Array.isArray(value?.clips) ? value.clips : []); })
      .catch(() => { if (request.current === id) setFailed(true); });
  }, [endpoint, session]);
  // Select chain to here: the ordered parent chain ending at this clip; ordering and
  // export coverage stay authoritative in the pack's preflight, not guessed here.
  const selectChain = (clipId: string) => {
    const byId = new Map(clips.map(c => [c.clipId, c]));
    const ids: string[] = [];
    let current: string | null = clipId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) { seen.add(current); ids.unshift(current); current = byId.get(current)?.parent ?? null; }
    setChain(ids); setPreflight(null); setResult(null);
  };
  // Files are copied into the backend Input folder on pick, so preflight sees the real rows.
  const addVideo = async () => {
    if (!endpoint) return;
    setError(null);
    try {
      const inspected = await inspectVideoPost(t('studio.videoPost.dialog'));
      if (!inspected?.sourceId) return;
      if (inspected.blockers.length) { setError(t('studio.run.cont.join.fileBlocked')); return; }
      const filename = await uploadVideoPostSource(endpoint, inspected.sourceId);
      if (files.some(f => f.filename === filename)) return;
      setFiles([...files, { filename, label: inspected.name, duration: inspected.durationSeconds, trimStart: '', trimEnd: '' }]);
      setPreflight(null); setResult(null);
    } catch { setError(t('studio.run.cont.join.addFailed')); }
  };
  const editFile = (filename: string, patch: Partial<JoinFile>) => { setFiles(files.map(f => f.filename === filename ? { ...f, ...patch } : f)); setPreflight(null); };
  const moveFile = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= files.length) return;
    const next = [...files];
    [next[index], next[to]] = [next[to], next[index]];
    setFiles(next); setPreflight(null);
  };
  const rows = () => mode === 'segments'
    ? (chain ?? []).map(clip_id => ({ kind: 'checkpoint' as const, session, clip_id }))
    : files.map(f => ({ kind: 'media' as const, filename: f.filename, trim_start: secondsOrNull(f.trimStart) ?? 0, trim_end: secondsOrNull(f.trimEnd) }));
  const ready = mode === 'segments' ? !!chain : files.length > 0;
  const runPreflight = async () => {
    const id = request.current;
    setPreflight(null); setError(null);
    try {
      const reply = await fetch(`${endpoint}/df_h3_continuity/assembly/preflight`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, rows: rows(), repair_transitions: false, audio_policy: 'preserve', copy_video: copy }) });
      const value = await reply.json();
      if (request.current !== id) return;
      setPreflight({ ok: value.ok === true, issues: Array.isArray(value.issues) ? value.issues.map(String) : [], seconds: Number(value.seconds), mode: String(value.mode ?? '') });
    } catch { if (request.current === id) setError(t('studio.run.cont.join.preflightFailed')); }
  };
  const run = async () => {
    if (!endpoint || !ready) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const snapshot = await readCurrentWorkbench();
      const join = mode === 'segments'
        ? { kind: 'segments' as const, session, chain: chain!, ...(copy ? { copyVideo: true } : {}) }
        : { kind: 'files' as const, files: files.map(f => ({ filename: f.filename, ...(secondsOrNull(f.trimStart) ? { trimStart: Number(f.trimStart) } : {}), ...(secondsOrNull(f.trimEnd) !== null ? { trimEnd: Number(f.trimEnd) } : {}) })), ...(copy ? { copyVideo: true } : {}) };
      const intent: H3JoinIntentV1 = { recipeId: 'h3-join', version: 1, h3: { join } };
      const job = await runWorkbenchJob(endpoint, intent, snapshot.admissionEpoch);
      const done = await waitForWorkbenchJob(job, () => true);
      if (done.state === 'succeeded') setResult(done.outputs[0]?.filename ?? done.id);
      else setError(done.error ?? t('studio.run.cont.join.failed'));
    } catch { setError(t('studio.run.cont.join.failed')); } finally { setBusy(false); }
  };
  return <div className="wb-cont-join" data-cont-join>
    <span className="wb-cont-join-title">{t('studio.run.cont.join.title')}</span>
    <label className="wb-option-row"><span>{t('studio.run.cont.join.mode')}</span><select data-cont-join-mode aria-label={t('studio.run.cont.join.mode')} disabled={locked} value={mode} onChange={e => { setMode(e.target.value as 'segments' | 'files'); setPreflight(null); setResult(null); }}>
      <option value="segments">{t('studio.run.cont.join.modeSegments')}</option>
      <option value="files">{t('studio.run.cont.join.modeFiles')}</option>
    </select></label>
    <p className="media-help">{t('studio.run.cont.join.hint')}</p>
    {mode === 'segments' && <>
      {failed && <p role="alert">{t('studio.run.cont.join.loadFailed')}</p>}
      <ul className="wb-cont-join-clips">{clips.map(c => <li key={c.clipId} data-cont-join-clip={c.clipId}>
        <code>{c.clipId.slice(0, 12)}</code>
        {c.frames !== null && <span>{`${(c.frames / 24).toFixed(1)} s`}</span>}
        <button type="button" className="wb-dock-action" data-cont-join-chain={c.clipId} disabled={locked} onClick={() => selectChain(c.clipId)}>{t('studio.run.cont.join.chainToHere')}</button>
      </li>)}</ul>
      {chain && <p data-cont-join-chain-count>{t('studio.run.cont.join.chain')}: {chain.length}</p>}
    </>}
    {mode === 'files' && <>
      <ul className="wb-cont-join-files">{files.map((f, i) => <li key={f.filename} data-cont-join-file={f.filename}>
        <code>{f.label}</code>
        <label><span>{t('studio.run.cont.join.trimStart')}</span><input type="number" aria-label={`${f.label}: ${t('studio.run.cont.join.trimStart')}`} data-cont-join-trim-start={f.filename} min={0} step={0.5} disabled={locked} value={f.trimStart} onChange={e => editFile(f.filename, { trimStart: e.target.value })} /></label>
        <label><span>{t('studio.run.cont.join.trimEnd')}</span><input type="number" aria-label={`${f.label}: ${t('studio.run.cont.join.trimEnd')}`} data-cont-join-trim-end={f.filename} min={0} step={0.5} disabled={locked} value={f.trimEnd} onChange={e => editFile(f.filename, { trimEnd: e.target.value })} /></label>
        <button type="button" aria-label={t('studio.run.cont.join.moveUp')} disabled={locked || i === 0} onClick={() => moveFile(i, -1)}>↑</button>
        <button type="button" aria-label={t('studio.run.cont.join.moveDown')} disabled={locked || i === files.length - 1} onClick={() => moveFile(i, 1)}>↓</button>
        <button type="button" aria-label={t('studio.run.cont.join.remove')} disabled={locked} onClick={() => { setFiles(files.filter(x => x.filename !== f.filename)); setPreflight(null); }}>✕</button>
      </li>)}</ul>
      <button type="button" className="wb-dock-action" data-cont-join-add disabled={locked || !endpoint} onClick={() => void addVideo()}>{t('studio.run.cont.join.addVideo')}</button>
    </>}
    <label className="wb-option-row"><input type="checkbox" data-cont-join-copy checked={copy} disabled={locked} onChange={e => { setCopy(e.target.checked); setPreflight(null); }} />{t('studio.run.cont.join.copyVideo')}</label>
    <button type="button" className="wb-dock-action" data-cont-join-preflight disabled={locked || !ready} onClick={() => void runPreflight()}>{t('studio.run.cont.join.preflight')}</button>
    {preflight && <p data-cont-join-preflight-result role={preflight.ok ? 'status' : 'alert'}>{preflight.ok
      ? `${preflight.mode} · ${preflight.seconds.toFixed(1)} s`
      : (preflight.issues.join('; ') || t('studio.run.cont.join.preflightFailed'))}</p>}
    <button type="button" className="wb-dock-action" data-cont-join-run disabled={disabled || locked || !preflight?.ok} onClick={() => void run()}>{t('studio.run.cont.join.run')}</button>
    {result && <p data-cont-join-result>{t('studio.run.cont.join.done')}: <code>{result}</code></p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
