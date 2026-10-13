import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { compileRecipe, type CompiledRecipe, type DiagnosticImageIntentV1 } from '../../lib/execution';
import { checkRecipePrerequisites, type RecipePrerequisites } from '../../lib/recipePrerequisites';

export function RecipePrerequisitesPanel({ endpoint }: { endpoint: string }) {
  const { t } = useI18n();
  const busy = useRef(false);
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
    setPending(false); setEvidence(null); setCompiled(null); setError('');
    setCheckpoint(''); setSampler(''); setScheduler('');
    return () => { epoch.current++; busy.current = false; };
  }, [endpoint]);
  const samplers = (evidence?.allowlist.samplers ?? []).filter((id): id is DiagnosticImageIntentV1['sampler'] => ['euler', 'euler_ancestral', 'dpmpp_2m'].includes(id));
  const schedulers = (evidence?.allowlist.schedulers ?? []).filter((id): id is DiagnosticImageIntentV1['scheduler'] => ['normal', 'karras', 'simple'].includes(id));
  const canCompile = !!evidence && !pending && evidence.missingNodes.length === 0 && evidence.allowlist.checkpoints.includes(checkpoint) && samplers.includes(sampler as DiagnosticImageIntentV1['sampler']) && schedulers.includes(scheduler as DiagnosticImageIntentV1['scheduler']);
  function invalidatePreview() { setCompiled(null); setError(''); }
  function compile() {
    if (!canCompile || !evidence) return;
    invalidatePreview();
    try {
      setCompiled(compileRecipe({ recipeId: evidence.recipeId, version: evidence.version, positivePrompt, negativePrompt, checkpoint, sampler, scheduler, width: 512, height: 512, steps: 20, cfg: 7, seed: 0, outputPrefix: 'DEAS_diagnostic' }, evidence.allowlist));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  async function check() {
    if (busy.current || !endpoint.trim()) return;
    const version = ++epoch.current;
    busy.current = true; setPending(true); setEvidence(null); invalidatePreview();
    try {
      const result = await checkRecipePrerequisites(endpoint);
      if (version !== epoch.current) return;
      setEvidence(result); setCheckpoint(result.allowlist.checkpoints[0] ?? '');
      setSampler(result.allowlist.samplers.find(id => ['euler', 'euler_ancestral', 'dpmpp_2m'].includes(id)) ?? '');
      setScheduler(result.allowlist.schedulers.find(id => ['normal', 'karras', 'simple'].includes(id)) ?? '');
    }
    catch (failure) { if (version === epoch.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (version === epoch.current) { busy.current = false; setPending(false); } }
  }
  return <div className="inspection-detail" data-recipe-prerequisites>
    <div><h3>{t('studio.recipe.title')}</h3><p>{t('studio.recipe.notice')}</p>
      <button type="button" className="action-button" data-recipe-check disabled={pending || !endpoint.trim()} onClick={() => void check()}>{t(pending ? 'studio.recipe.checking' : 'studio.recipe.check')}</button>
      <div aria-live="polite" aria-busy={pending}>
        {error && <p className="status-message error-message" role="alert">{t('studio.recipe.failed')}: {error}</p>}
        {evidence && <><p role="status">{evidence.baseUrl}</p>
          {evidence.missingNodes.length > 0 && <><h4>{t('studio.recipe.missingNodes')}</h4><ul>{evidence.missingNodes.map(node => <li key={node}>{node}</li>)}</ul></>}
          {evidence.allowlist.checkpoints.length === 0 && <p role="alert">{t('studio.recipe.noCheckpoints')}</p>}
          {(samplers.length === 0 || schedulers.length === 0) && <p role="alert">{t('studio.recipe.noEnums')}</p>}
          <div className="draft-form">
            <div className="full-width"><label htmlFor="recipe-positive">{t('studio.recipe.positive')}</label><textarea id="recipe-positive" value={positivePrompt} maxLength={16384} onChange={e => { setPositivePrompt(e.target.value); invalidatePreview(); }} /></div>
            <div className="full-width"><label htmlFor="recipe-negative">{t('studio.recipe.negative')}</label><textarea id="recipe-negative" value={negativePrompt} maxLength={16384} onChange={e => { setNegativePrompt(e.target.value); invalidatePreview(); }} /></div>
            <div><label htmlFor="recipe-checkpoint">{t('studio.recipe.checkpoint')}</label><select id="recipe-checkpoint" data-recipe-checkpoint value={checkpoint} onChange={e => { setCheckpoint(e.target.value); invalidatePreview(); }}>{evidence.allowlist.checkpoints.map(id => <option key={id} value={id}>{id}</option>)}</select></div>
            <div><label htmlFor="recipe-sampler">{t('studio.recipe.sampler')}</label><select id="recipe-sampler" value={sampler} onChange={e => { setSampler(e.target.value); invalidatePreview(); }}>{samplers.map(id => <option key={id} value={id}>{id}</option>)}</select></div>
            <div><label htmlFor="recipe-scheduler">{t('studio.recipe.scheduler')}</label><select id="recipe-scheduler" value={scheduler} onChange={e => { setScheduler(e.target.value); invalidatePreview(); }}>{schedulers.map(id => <option key={id} value={id}>{id}</option>)}</select></div>
          </div>
          <p className="field-help">{t('studio.recipe.parameters')}</p>
          <button type="button" className="action-button" data-recipe-compile disabled={!canCompile} onClick={compile}>{t('studio.recipe.compile')}</button>
          {compiled && <><p role="status">{t('studio.recipe.compiled')}</p><details className="aio-detail"><summary>{t('studio.recipe.details')}</summary><pre data-recipe-graph>{JSON.stringify(compiled, null, 2)}</pre></details></>}
        </>}
      </div>
    </div>
  </div>;
}
