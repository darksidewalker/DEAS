import { useEffect, useRef, useState } from 'react';
import { StarMediaButton } from '../media/StarMediaButton';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import type { MediaItem } from '../../lib/media';
import { useI18n } from '../../i18n/I18nProvider';
import { NativeVideo, nativeVideo } from './NativeVideo';
import { loadDiagnosticJobOutput, exportDiagnosticJobOutput, type JobExport, type JobStatus } from '../../lib/jobs';

/** `auto` loads the selected retained terminal output; diagnostics stay click-only. */
export function JobOutputPreview({ job, auto = false, outputRoot, outputIndex = 0 }: { job: JobStatus; auto?: boolean; outputRoot?:string; outputIndex?:number }) {
  const { t } = useI18n();
  const epoch = useRef(0);
  const live = useRef(false);
  const lock = useRef(false);
  const url = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [transferSettled, setTransferSettled] = useState(0);
  const [locations,setLocations]=useState<Record<number,MediaItem>>({});
  const outputItem=(index:number):MediaItem=>{const output=job.outputs[index];const path=outputRoot?[outputRoot,output.subfolder,output.filename].filter(Boolean).join('/'):undefined;return locations[index]??{name:output.filename,path,src:path?convertFileSrc(path):job.baseUrl,media:/\.flac$/i.test(output.filename)?'audio':'image'};};
  const [preview, setPreview] = useState<{ jobId: string; index: number; url: string; sha256: string; mimeType: string } | null>(null);
  const [error, setError] = useState('');
  const [exported, setExported] = useState<JobExport | null>(null);
  useEffect(() => {
    live.current = true;
    setPending(false); setPreview(null); setError(''); setExported(null); setLocations({});
    return () => {
      live.current = false; epoch.current++;
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
    };
  }, [job.id, auto ? outputIndex : 0]);
  const terminal = job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled';
  useEffect(() => { if (auto && terminal && job.outputs[outputIndex]) void load(outputIndex); }, [auto, job.id, job.state, job.outputs.length, outputIndex, transferSettled]); // eslint-disable-line react-hooks/exhaustive-deps
  async function load(index: number) {
    if (!isTauri() || !terminal || !Number.isInteger(index) || !job.outputs[index] || !live.current || lock.current) return;
    lock.current = true; setPending(true); setError(''); setExported(null);
    const version = epoch.current;
    try {
      const result = await loadDiagnosticJobOutput(job.id, index);
      if (!live.current || version !== epoch.current) return;
      const next = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: result.mimeType }));
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = next;
      setPreview({ jobId: job.id, index, url: next, sha256: result.sha256, mimeType: result.mimeType });
    } catch (failure) {
      if (live.current && version === epoch.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      lock.current = false;
      if (live.current) {
        setPending(false);
        // Native output fetches are exclusive: resume the latest selection only after the old request settles.
        if (version !== epoch.current) setTransferSettled(value => value + 1);
      }
    }
  }
  const selected = preview?.jobId === job.id ? preview : null;
  async function save() {
    if (!isTauri() || !selected || !live.current || lock.current || !terminal || !job.outputs[selected.index]) return;
    lock.current = true; setPending(true); setError(''); setExported(null);
    const version = epoch.current;
    try {
      const result = await exportDiagnosticJobOutput(job.id, selected.index, t('studio.jobs.saveTitle'));
      if (live.current && version === epoch.current) setExported(result);
    } catch (failure) {
      if (live.current && version === epoch.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      lock.current = false;
      if (live.current) {
        setPending(false);
        // Native output fetches are exclusive: resume the latest selection only after the old request settles.
        if (version !== epoch.current) setTransferSettled(value => value + 1);
      }
    }
  }
  return <div style={{ minWidth: 0, overflowWrap: 'anywhere' }} aria-busy={pending}>
    {!auto && <ul>{job.outputs.map((output, index) => <li key={index}>
      <span>{output.role && <strong>{t(`studio.jobs.role.${output.role}`)} · </strong>}{output.filename}</span>{' '}<StarMediaButton item={outputItem(index)} onMoved={item=>setLocations(locations=>({...locations,[index]:item}))}/>
      <button type="button" data-job-output-load={index} disabled={!isTauri() || pending || !terminal} onClick={() => void load(index)}>{t('studio.jobs.loadPreview')}</button>
    </li>)}</ul>}
    {selected && terminal && job.outputs[selected.index] && <>{job.outputs[selected.index].role && <p>{t(`studio.jobs.role.${job.outputs[selected.index].role}`)}</p>}{selected.mimeType==='audio/flac'&&nativeVideo()?<NativeVideo source={{baseUrl:job.baseUrl,filename:job.outputs[selected.index].filename,subfolder:job.outputs[selected.index].subfolder,type:job.outputs[selected.index].type}} label={job.outputs[selected.index].filename} audioOnly/>:selected.mimeType==='audio/flac'?<audio data-job-output-preview controls src={selected.url} aria-label={job.outputs[selected.index].filename} style={{ width: '100%' }}/>:<img data-job-output-preview src={selected.url} alt={t('studio.jobs.previewAlt')} style={{ maxWidth: '100%', height: 'auto' }} />}{!auto && <p>{selected.sha256}</p>}
      <StarMediaButton item={outputItem(selected.index)} onMoved={item=>setLocations(locations=>({...locations,[selected.index]:item}))}/>
      <button type="button" data-job-output-export disabled={!isTauri() || pending} onClick={() => void save()}>{t('studio.jobs.saveAs')}</button>
      {exported && <p role="status" data-job-output-exported>{t('studio.jobs.exported', { path: exported.path, sha256: exported.sha256 })}</p>}
    </>}
    {error && <p role="alert" className="aio-error">{t('studio.jobs.error')}: {error}</p>}
  </div>;
}
