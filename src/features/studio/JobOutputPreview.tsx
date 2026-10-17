import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { loadDiagnosticJobOutput, exportDiagnosticJobOutput, type JobExport, type JobStatus } from '../../lib/jobs';

/** `auto` loads the first output as soon as the job succeeded (workbench); the diagnostic panel stays click-only. */
export function JobOutputPreview({ job, auto = false }: { job: JobStatus; auto?: boolean }) {
  const { t } = useI18n();
  const epoch = useRef(0);
  const live = useRef(false);
  const lock = useRef(false);
  const url = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<{ jobId: string; index: number; url: string; sha256: string } | null>(null);
  const [error, setError] = useState('');
  const [exported, setExported] = useState<JobExport | null>(null);
  useEffect(() => {
    live.current = true; lock.current = false;
    setPending(false); setPreview(null); setError(''); setExported(null);
    return () => {
      live.current = false; epoch.current++;
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
    };
  }, [job.id]);
  useEffect(() => { if (auto && job.outputs.length > 0) void load(0); }, [auto, job.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function load(index: number) {
    if (!isTauri() || job.state !== 'succeeded' || !live.current || lock.current) return;
    lock.current = true; setPending(true); setError(''); setExported(null);
    const version = epoch.current;
    try {
      const result = await loadDiagnosticJobOutput(job.id, index);
      if (!live.current || version !== epoch.current) return;
      const next = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: result.mimeType }));
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = next;
      setPreview({ jobId: job.id, index, url: next, sha256: result.sha256 });
    } catch (failure) {
      if (live.current && version === epoch.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (live.current && version === epoch.current) { lock.current = false; setPending(false); }
    }
  }
  const selected = preview?.jobId === job.id ? preview : null;
  async function save() {
    if (!isTauri() || !selected || !live.current || lock.current || job.state !== 'succeeded') return;
    lock.current = true; setPending(true); setError(''); setExported(null);
    const version = epoch.current;
    try {
      const result = await exportDiagnosticJobOutput(job.id, selected.index, t('studio.jobs.saveTitle'));
      if (live.current && version === epoch.current) setExported(result);
    } catch (failure) {
      if (live.current && version === epoch.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (live.current && version === epoch.current) { lock.current = false; setPending(false); }
    }
  }
  return <div style={{ minWidth: 0, overflowWrap: 'anywhere' }} aria-busy={pending}>
    {!auto && <ul>{job.outputs.map((output, index) => <li key={index}>
      <span>{output.filename}</span>{' '}
      <button type="button" data-job-output-load={index} disabled={!isTauri() || pending || job.state !== 'succeeded'} onClick={() => void load(index)}>{t('studio.jobs.loadPreview')}</button>
    </li>)}</ul>}
    {selected && <><img data-job-output-preview src={selected.url} alt={t('studio.jobs.previewAlt')} style={{ maxWidth: '100%', height: 'auto' }} />{!auto && <p>{selected.sha256}</p>}
      <button type="button" data-job-output-export disabled={!isTauri() || pending} onClick={() => void save()}>{t('studio.jobs.saveAs')}</button>
      {exported && <p role="status" data-job-output-exported>{t('studio.jobs.exported', { path: exported.path, sha256: exported.sha256 })}</p>}
    </>}
    {error && <p role="alert" className="aio-error">{t('studio.jobs.error')}: {error}</p>}
  </div>;
}
