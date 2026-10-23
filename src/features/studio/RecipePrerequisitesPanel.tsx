import { useCallback, useEffect, useRef, useState } from 'react';
import { backendErrorText } from '../../lib/backendErrors';
import { JobOutputPreview } from './JobOutputPreview';
import { isTauri } from '@tauri-apps/api/core';
import { prepareDiagnosticJob, submitDiagnosticJob, readDiagnosticJobStatus, readCurrentDiagnosticJob, type DiagnosticJobPlan, type JobStatus } from '../../lib/jobs';
import { useI18n } from '../../i18n/I18nProvider';
import { compileRecipe, type CompiledRecipe, type DiagnosticImageIntentV1 } from '../../lib/execution';
import { checkRecipePrerequisites, type RecipePrerequisites } from '../../lib/recipePrerequisites';

export function RecipePrerequisitesPanel({ endpoint }: { endpoint: string }) {
  const { t } = useI18n();
  const busy = useRef(false);
  const [jobLocked, setJobLocked] = useState(false);
  const [compiledIntent, setCompiledIntent] = useState<DiagnosticImageIntentV1 | null>(null);
  const [pending, setPending] = useState(false);
  const [evidence, setEvidence] = useState<RecipePrerequisites | null>(null);
  const [error, setError] = useState('');
  const [positivePrompt, setPositivePrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [checkpoint, setCheckpoint] = useState('');
  const [sampler, setSampler] = useState('');
  const [scheduler, setScheduler] = useState('');
  const [compiled, setCompiled] = useState<CompiledRecipe | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++; busy.current = false;
    setPending(false); setEvidence(null); setCompiled(null); setCompiledIntent(null); setError('');
    setCheckpoint(''); setSampler(''); setScheduler('');
    return () => { epoch.current++; busy.current = false; };
  }, [endpoint]);
  const samplers = evidence?.allowlist.samplers ?? [];
  const schedulers = evidence?.allowlist.schedulers ?? [];
  const canCompile = !!evidence && !pending && !jobLocked && evidence.missingNodes.length === 0 && evidence.allowlist.checkpoints.includes(checkpoint) && samplers.includes(sampler) && schedulers.includes(scheduler);
  function invalidatePreview() { setCompiled(null); setCompiledIntent(null); setError(''); }
  function compile() {
    if (!canCompile || !evidence) return;
    invalidatePreview();
    try {
      const intent = Object.freeze({ recipeId: evidence.recipeId, version: evidence.version, positivePrompt, negativePrompt, checkpoint, sampler, scheduler, width: 512, height: 512, steps: 20, cfg: 7, seed: 0, outputPrefix: 'raw/DEAS_diagnostic' });
      setCompiled(compileRecipe(intent, evidence.allowlist));
      setCompiledIntent(intent);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  async function check() {
    if (busy.current || jobLocked || !endpoint.trim()) return;
    const version = ++epoch.current;
    busy.current = true; setPending(true); setEvidence(null); invalidatePreview();
    try {
      const result = await checkRecipePrerequisites(endpoint);
      if (version !== epoch.current) return;
      setEvidence(result); setCheckpoint(result.allowlist.checkpoints[0] ?? '');
      setSampler(result.allowlist.samplers[0] ?? '');
      setScheduler(result.allowlist.schedulers[0] ?? '');
    }
    catch (failure) { if (version === epoch.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (version === epoch.current) { busy.current = false; setPending(false); } }
  }
  return <div className="inspection-detail" data-recipe-prerequisites>
    <div><h3>{t('studio.recipe.title')}</h3><p>{t('studio.recipe.notice')}</p>
      <button type="button" className="action-button" data-recipe-check disabled={pending || jobLocked || !endpoint.trim()} onClick={() => void check()}>{t(pending ? 'studio.recipe.checking' : 'studio.recipe.check')}</button>
      <div aria-live="polite" aria-busy={pending}>
        {error && <p className="status-message error-message" role="alert">{t('studio.recipe.failed')}: {backendErrorText(error,t)}</p>}
        {evidence && <><p role="status">{evidence.baseUrl}</p>
          {evidence.missingNodes.length > 0 && <><h4>{t('studio.recipe.missingNodes')}</h4><ul>{evidence.missingNodes.map(node => <li key={node}>{node}</li>)}</ul></>}
          {evidence.allowlist.checkpoints.length === 0 && <p role="alert">{t('studio.recipe.noCheckpoints')}</p>}
          {(samplers.length === 0 || schedulers.length === 0) && <p role="alert">{t('studio.recipe.noEnums')}</p>}
          <div className="draft-form">
            <div className="full-width"><label htmlFor="recipe-positive">{t('studio.recipe.positive')}</label><textarea disabled={jobLocked} id="recipe-positive" value={positivePrompt} maxLength={16384} onChange={e => { setPositivePrompt(e.target.value); invalidatePreview(); }} /></div>
            <div className="full-width"><label htmlFor="recipe-negative">{t('studio.recipe.negative')}</label><textarea disabled={jobLocked} id="recipe-negative" value={negativePrompt} maxLength={16384} onChange={e => { setNegativePrompt(e.target.value); invalidatePreview(); }} /></div>
            <div><label htmlFor="recipe-checkpoint">{t('studio.recipe.checkpoint')}</label><select disabled={jobLocked} id="recipe-checkpoint" data-recipe-checkpoint value={checkpoint} onChange={e => { setCheckpoint(e.target.value); invalidatePreview(); }}>{evidence.allowlist.checkpoints.map(id => <option key={id} value={id}>{id}</option>)}</select></div>
            <div><label htmlFor="recipe-sampler">{t('studio.recipe.sampler')}</label><select disabled={jobLocked} id="recipe-sampler" value={sampler} onChange={e => { setSampler(e.target.value); invalidatePreview(); }}>{samplers.map(id => <option key={id} value={id}>{id}</option>)}</select></div>
            <div><label htmlFor="recipe-scheduler">{t('studio.recipe.scheduler')}</label><select disabled={jobLocked} id="recipe-scheduler" value={scheduler} onChange={e => { setScheduler(e.target.value); invalidatePreview(); }}>{schedulers.map(id => <option key={id} value={id}>{id}</option>)}</select></div>
          </div>
          <p className="field-help">{t('studio.recipe.parameters')}</p>
          <button type="button" className="action-button" data-recipe-compile disabled={!canCompile} onClick={compile}>{t('studio.recipe.compile')}</button>
          {compiled && <><p role="status">{t('studio.recipe.compiled')}</p><details className="aio-detail"><summary>{t('studio.recipe.details')}</summary><pre data-recipe-graph>{JSON.stringify(compiled, null, 2)}</pre></details></>}
        </>}
      </div>
      <DiagnosticJobPanel endpoint={endpoint} intent={compiledIntent} onLocked={setJobLocked} />
    </div>
  </div>;
}

function DiagnosticJobPanel({ endpoint, intent, onLocked }: { endpoint: string; intent: DiagnosticImageIntentV1 | null; onLocked: (locked: boolean) => void }) {
  const { t } = useI18n();
  const native = isTauri();
  const live = useRef(false);
  const lifetime = useRef(0);
  const revision = useRef(0);
  const lock = useRef(false);
  const usedPlans = useRef(new Set<string>());
  const [pending, setPending] = useState(false);
  const [prepared, setPrepared] = useState<{ plan: DiagnosticJobPlan; intent: DiagnosticImageIntentV1; endpoint: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [error, setError] = useState('');
  const [noSessionJob, setNoSessionJob] = useState(false);
  const plan = prepared?.intent === intent && prepared?.endpoint === endpoint ? prepared.plan : null;
  const active = job?.state === 'queued' || job?.state === 'running';
  const blocked = pending || active || job?.state === 'unknown' || ambiguous;
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; lifetime.current++; };
  }, []);
  useEffect(() => {
    revision.current++;
    setPrepared(null); setConsent(false);
  }, [endpoint, intent]);
  useEffect(() => { onLocked(blocked); }, [blocked, onLocked]);

  async function prepare() {
    if (!native || !intent || lock.current || blocked || !live.current) return;
    lock.current = true; setPending(true); setPrepared(null); setConsent(false); setError('');
    const version = revision.current;
    const life = lifetime.current;
    try {
      const result = await prepareDiagnosticJob(endpoint, intent);
      if (live.current && life === lifetime.current && version === revision.current) setPrepared({ plan: result, intent, endpoint });
    } catch (failure) {
      if (live.current && life === lifetime.current && version === revision.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      lock.current = false;
      if (live.current && life === lifetime.current) setPending(false);
    }
  }
  async function recover() {
    if (!native || lock.current || !live.current) return;
    lock.current = true; setPending(true); setError(''); setNoSessionJob(false);
    const life = lifetime.current;
    try {
      const current = await readCurrentDiagnosticJob();
      if (live.current && life === lifetime.current) {
        if (current) { setJob(current); setAmbiguous(false); }
        else setNoSessionJob(true);
      }
    } catch (failure) {
      if (live.current && life === lifetime.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      lock.current = false;
      if (live.current && life === lifetime.current) setPending(false);
    }
  }
  async function submit() {
    if (!native || !plan || !consent || lock.current || blocked || usedPlans.current.has(plan.id) || !live.current) return;
    lock.current = true; usedPlans.current.add(plan.id); setPending(true); setConsent(false); setError('');
    const life = lifetime.current;
    try {
      const result = await submitDiagnosticJob(plan.id);
      // Submission identity survives draft/endpoint changes; only unmount discards UI updates.
      if (live.current && life === lifetime.current) setJob(result);
    } catch (failure) {
      if (live.current && life === lifetime.current) {
        setAmbiguous(true);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      lock.current = false;
      if (live.current && life === lifetime.current) setPending(false);
    }
  }
  const refresh = useCallback(async () => {
    if (!native || !job?.id || lock.current || !live.current) return;
    lock.current = true; setPending(true);
    const life = lifetime.current;
    try {
      const next = await readDiagnosticJobStatus(job.id);
      if (live.current && life === lifetime.current) { setJob(next); setError(''); }
    } catch (failure) {
      if (live.current && life === lifetime.current) {
        setJob(previous => previous ? { ...previous, state: 'unknown' } : previous);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      lock.current = false;
      if (live.current && life === lifetime.current) setPending(false);
    }
  }, [native, job?.id]);
  useEffect(() => {
    if (!active || pending) return;
    const timer = window.setTimeout(() => void refresh(), 1000);
    return () => window.clearTimeout(timer);
  }, [active, pending, job, refresh]);

  return <section className="aio-detail" style={{ minWidth: 0, overflowWrap: 'anywhere' }} data-diagnostic-jobs aria-label={t('studio.jobs.title')} aria-busy={pending}>
    <h4>{t('studio.jobs.title')}</h4><p className="aio-help">{t('studio.jobs.notice')}</p>
      <button type="button" data-job-recover disabled={!native || pending} onClick={() => void recover()}>{t('studio.jobs.recover')}</button>
      {noSessionJob && <p role="status">{t('studio.jobs.noSessionJob')}</p>}
      {!native && <p>{t('studio.jobs.browser')}</p>}
      {pending && <p role="status">{t('studio.jobs.waiting')}</p>}
      {intent && <button type="button" data-job-prepare disabled={!native || blocked} onClick={() => void prepare()}>{t('studio.jobs.prepare')}</button>}
      {plan && <><details><summary>{t('studio.jobs.plan')}</summary><pre data-job-plan>{JSON.stringify(plan, null, 2)}</pre></details>
        <label className="aio-consent"><input type="checkbox" data-job-consent checked={consent} disabled={blocked || usedPlans.current.has(plan.id)} onChange={e => setConsent(e.target.checked)} />{t('studio.jobs.consent')}</label>
        <button type="button" data-job-submit disabled={!native || blocked || !consent || usedPlans.current.has(plan.id)} onClick={() => void submit()}>{t('studio.jobs.submit')}</button>
      </>}
      {job && <><p role="status" data-job-state data-state={job.state}>{t(`studio.jobs.${job.state}`)}</p>
        <p>{t('studio.jobs.identity', { id: job.id, url: job.baseUrl })}</p>
        <p>{t('studio.jobs.promptId')}: <code>{job.promptId ?? t('studio.jobs.noPromptId')}</code></p>
        {job.baseUrl.replace(/\/$/, '') !== endpoint.replace(/\/$/, '') && <p>{t('studio.jobs.originalEndpoint')}</p>}
        <button type="button" data-job-refresh disabled={!native || pending} onClick={() => void refresh()}>{t('studio.jobs.refresh')}</button>
        {job.outputs.length > 0 && <details><summary>{t('studio.jobs.outputs')}</summary><pre data-job-outputs>{JSON.stringify(job.outputs, null, 2)}</pre></details>}
        {job.state === 'succeeded' && <JobOutputPreview key={job.id} job={job} />}
        {job.error && <p className="aio-error" role="alert">{job.error}</p>}
      </>}
      {ambiguous && <p role="alert" data-job-state data-state="unknown">{t('studio.jobs.ambiguous')}</p>}
      {(job || ambiguous) && <p className="aio-help">{t('studio.jobs.pendingFeatures')}</p>}
      {error && <p className="aio-error" role="alert">{t('studio.jobs.error')}: {error}</p>}
  </section>;
}
