import { useEffect, useRef, useState } from 'react';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { pickMedia } from '../../lib/analysis';
import { MIX_LIMITS, MOVIE_CAST_ROLES, addCast, markResultsMissing, setMix, setMusicFile, deliveredSeconds, reviseItem, newMovie, removeCast, setBrief, setCastRefs, setCastRole, setItemTitle, setLocked, editItem, type MovieCastRole, type MovieManifest } from '../../lib/movieManifest';
import type { LlmModel } from '../../lib/llm';
import { applyPlan, h3ActualSeconds, planDiff, segmentLimits, type PlanCheck } from '../../lib/movieStory';
import { PLANNER_MAX_CHARS, listPlannerModels, logMovieNotice, plannerDestination, plannerPayload, requestPlan } from '../../lib/movieStoryRun';
import { recordShotRun, shotHandoff } from '../../lib/movieSegments';
import { chainHandoff, chainOf } from '../../lib/movieChainRun';
import { mixMusic, mixPlan, pickMusic, recordScore } from '../../lib/movieMusic';
import { AssemblyError, assemblyPlan, assembleMovie, recordFilm } from '../../lib/movieAssemble';
import { realAssembleDeps, stopAssemblyJob } from '../../lib/movieAssembleRun';
import type { JobStatus } from '../../lib/jobs';
import { modelsForFamilies, type WizardHandoff, type WizardModel, type WizardRun } from '../../lib/wizards';
import { checkMovie, listMovies, newMovieId, openMovie, saveMovie, type MovieCheck, type MovieList } from '../../lib/movies';

const ASPECTS = ['16:9', '9:16', '1:1', '4:3'];
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * Movie Maker, first stages (UX-22d2): Brief and Cast / references. This only edits and saves the movie plan; nothing here generates,
 * submits a job or analyses a picture, and reopening a saved movie never resumes anything.
 */
const PLAN_FAMILY = 'minimax-h3';
export interface MovieMakerProps {
  modelsRoot?: string;
  /** Backend address for the final Join (Continuity's Join clips recipe). */
  endpoint?: string;
  /** Installed models as the Dark Wizards tab scanned them (null while unknown). */
  models?: WizardModel[] | null;
  /** Hands a shot to Generate as an ordinary draft (optionally running it); the result comes back through `outcome`. */
  onPrepare?: (handoff: Omit<WizardHandoff, 'n'>) => void;
  outcome?: { n: number; error?: string; run?: WizardRun };
  handoff?: number;
}
export function MovieMaker({ modelsRoot, endpoint, models = null, onPrepare, outcome, handoff }: MovieMakerProps) {
  const { t } = useI18n();
  const native = isTauri();
  const [movie, setMovie] = useState<MovieManifest>(() => newMovie(newMovieId(), ''));
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<MovieList | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [gone, setGone] = useState<MovieCheck | null>(null);
  const [role, setRole] = useState<MovieCastRole>('actor');
  const [name, setName] = useState('');
  const [llm, setLlm] = useState<LlmModel[] | null>(null);
  const [llmKey, setLlmKey] = useState('');
  const [planning, setPlanning] = useState(false);
  const [ask, setAsk] = useState<{ host: string; chars: number; cast: number } | null>(null);
  const [check, setCheck] = useState<PlanCheck | null>(null);
  const limits = segmentLimits(PLAN_FAMILY);
  const h3Models = models ? modelsForFamilies([PLAN_FAMILY], models) : [];
  const [h3Path, setH3Path] = useState('');
  const h3Model = h3Models.find(m => m.path === h3Path) ?? h3Models[0];
  // The shot Generate is making for us: which hand-over number it has and which segment it belongs to.
  const sent = useRef<{ n: number; id: string } | null>(null);
  const [shotState, setShotState] = useState<{ id: string; state: string; error?: string } | null>(null);
  const [chainBusy, setChainBusy] = useState(false);
  const making = chainBusy || (!!shotState && (shotState.state === 'queued' || shotState.state === 'running'));
  const makeShot = (id: string, run: boolean) => {
    if (!onPrepare || !h3Model) return;
    const r = shotHandoff(movie, id, { name: h3Model.name, path: h3Model.path }, run, convertFileSrc);
    if ('blocked' in r) { setError(t(r.blocked)); return; }
    setError(''); setNote(r.skipped ? t('wizards.movie.shot.skipped', { count: String(r.skipped) }) : '');
    sent.current = { n: (handoff ?? 0) + 1, id }; setShotState(run ? { id, state: 'queued' } : null);
    onPrepare(r.handoff);
  };
  // A chain reports one shot after the other (`run.step`); a lone shot reports once. The chain is busy until its last shot ends or one fails.
  const makeChain = (id: string, run: boolean) => {
    const found = chainOf(movie, id);
    if (!onPrepare || !h3Model || !found) return;
    const r = chainHandoff(movie, found.chain, found.index, { name: h3Model.name, path: h3Model.path }, run, convertFileSrc);
    if ('blocked' in r) { setError(r.detail ? `${t(r.blocked)} ${r.detail}` : t(r.blocked)); return; }
    setError(''); setNote(r.skipped ? t('wizards.movie.shot.skipped', { count: String(r.skipped) }) : '');
    sent.current = { n: (handoff ?? 0) + 1, id }; setChainBusy(run); setShotState(run ? { id, state: 'queued' } : null);
    onPrepare(r.handoff);
  };
  useEffect(() => {
    const s = sent.current, r = outcome?.run;
    if (!s || !outcome || outcome.n !== s.n) return;
    if (outcome.error) { setShotState({ id: s.id, state: 'failed', error: outcome.error }); sent.current = null; setChainBusy(false); return; }
    if (!r) return;
    const id = r.step?.shotId || s.id;
    setShotState({ id, state: r.state, ...(r.error ? { error: r.error } : {}) });
    if (r.state === 'queued' || r.state === 'running') return;
    const lastShot = !r.step || r.step.index >= r.step.total - 1;
    if (lastShot || r.state !== 'succeeded') { sent.current = null; setChainBusy(false); }
    const shot = movie.items.find(i => i.id === id), found = chainOf(movie, id);
    const continued = !!found && found.chain.ids[0] !== id;
    setMovie(m => recordShotRun(m, id, r, shot?.seconds ? h3ActualSeconds(shot.seconds, continued) : undefined)); setDirty(true);
  }, [outcome]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => { if (!native) return; try { setSaved(await listMovies()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!native || !modelsRoot) { setLlm([]); return; }
    let alive = true;
    listPlannerModels(modelsRoot).then(list => { if (alive) { setLlm(list); setLlmKey(k => k || (list[0] ? `${list[0].provider}:${list[0].id}` : '')); } }, () => { if (alive) setLlm([]); });
    return () => { alive = false; };
  }, [native, modelsRoot]);
  const llmModel = llm?.find(m => `${m.provider}:${m.id}` === llmKey);
  const story = movie.items.find(i => i.kind === 'story');
  const segments = movie.items.filter(i => i.kind === 'segment');
  const nameOf = (id: string) => movie.items.find(i => i.id === id)?.title || id;
  const payload = limits ? plannerPayload(movie, limits) : undefined;
  const planBlocked = !native || !modelsRoot ? t('wizards.movie.plan.native') : !limits ? t('wizards.movie.plan.noLimits') : !llmModel ? t('wizards.movie.plan.noModel')
    : !movie.items.find(i => i.id === 'brief')?.text.trim() ? t('wizards.movie.plan.needStory') : payload && payload.chars > PLANNER_MAX_CHARS ? t('wizards.movie.plan.tooLong', { max: String(PLANNER_MAX_CHARS) }) : '';
  const run = async () => {
    if (!llmModel || !limits || !modelsRoot) return;
    setAsk(null); setError(''); setNote(''); setCheck(null); setPlanning(true);
    try { setCheck(await requestPlan(modelsRoot, llmModel, movie, limits)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPlanning(false); }
  };
  // A model on another machine only ever receives the brief after the destination and contents are shown and confirmed here.
  const begin = async () => {
    if (planBlocked || !llmModel || !payload || !modelsRoot) return;
    setError(''); setNote('');
    try {
      const where = await plannerDestination(modelsRoot, llmModel);
      if (where.remote) setAsk({ host: where.host, chars: payload.disclosure.storyCharacters, cast: payload.disclosure.castEntries }); else await run();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const diff = check?.plan ? planDiff(movie, check.plan) : undefined;
  const final = movie.items.find(i => i.id === 'final');
  const filmPlan = assemblyPlan(movie);
  const owned = useRef<{ cancelled: boolean; job?: JobStatus } | null>(null);
  const [joining, setJoining] = useState('');
  const [mismatch, setMismatch] = useState<{ got: number; want: number } | null>(null);
  const joinBlocked = !native || !endpoint ? t('wizards.movie.film.native') : !filmPlan.ok ? t('wizards.movie.film.notReady') : making ? t('wizards.movie.film.making') : '';
  const join = async () => {
    if (joinBlocked || owned.current) return;
    const mine = { cancelled: false } as { cancelled: boolean; job?: JobStatus };
    owned.current = mine; setError(''); setNote(''); setMismatch(null); setJoining(t('wizards.movie.film.joining'));
    try {
      const r = await assembleMovie(movie, realAssembleDeps(endpoint!, job => { mine.job = job; }), () => !mine.cancelled,
        (step, n, total) => setJoining(step === 'copy' ? t('wizards.movie.film.copying', { n: String(n), total: String(total) }) : step === 'check' ? t('wizards.movie.film.checking') : t('wizards.movie.film.joining')));
      setMovie(m => recordFilm(m, r)); setDirty(true);
      if (r.mismatch && r.expectedSeconds !== undefined && r.seconds !== undefined) setMismatch({ got: r.seconds, want: r.expectedSeconds });
      setNote(t('wizards.movie.film.done')); logMovieNotice('join-done');
    } catch (e) {
      const code = e instanceof AssemblyError ? e.code : 'failed';
      logMovieNotice(mine.cancelled || code === 'cancelled' ? 'join-cancelled' : code === 'blocked' ? 'join-blocked' : 'join-failed');
      if (!mine.cancelled) setError(e instanceof Error ? e.message : String(e));
    } finally { if (owned.current === mine) owned.current = null; setJoining(''); }
  };
  const stopJoin = () => {
    const o = owned.current; if (!o || o.cancelled) return;
    o.cancelled = true;
    if (o.job && (o.job.state === 'queued' || o.job.state === 'running')) void stopAssemblyJob(o.job).catch(e => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => () => { const o = owned.current; if (o) { o.cancelled = true; if (o.job && (o.job.state === 'queued' || o.job.state === 'running')) void stopAssemblyJob(o.job).catch(() => undefined); } }, []);
  // Music bed: choose a track, set level/ducking/fade, mix it onto the joined film (the film itself is never changed).
  const music = movie.items.find(i => i.kind === 'music'), score = movie.items.find(i => i.kind === 'score');
  const musicPlan = mixPlan(movie);
  const [mixing, setMixing] = useState(false);
  const mixBlocked = !native ? t('wizards.movie.music.native') : musicPlan.ok ? '' : t(`wizards.movie.music.why.${musicPlan.why}`);
  const chooseMusic = async () => {
    try { const path = await pickMusic(t('wizards.movie.music.pickTitle')); if (path) change(m => setMusicFile(m, path)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const mixIt = async () => {
    if (!musicPlan.ok || mixing) return;
    setError(''); setNote(''); setMixing(true);
    try { const r = await mixMusic(musicPlan); setMovie(m => recordScore(m, r)); setDirty(true); setNote(t('wizards.movie.music.done')); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setMixing(false); }
  };
  const scoredClip = score?.state === 'done' ? score.revisions.find(r => r.n === score.revision)?.result?.outputId : undefined;
  const filmClip = final?.state === 'done' ? final.revisions.find(r => r.n === final.revision)?.result?.outputId : undefined;
  const why = (w: string) => t(`wizards.movie.film.why.${w}`);
  // The chain a shot belongs to: the first shot makes the whole chain; a continued shot is made together with it.
  const chainLen = (id: string) => { const f = chainOf(movie, id); return f && f.chain.ids[0] === id ? f.chain.ids.length : 1; };
  const continued = (id: string) => { const f = chainOf(movie, id); return !!f && f.chain.ids[0] !== id; };
  const shotBlock = (g: { id: string }, _n: number) => !h3Model ? t('wizards.movie.shot.noModel') : continued(g.id) ? t('wizards.movie.shot.withChain') : undefined;
  const change = (f: (m: MovieManifest) => MovieManifest) => {
    setError(''); setNote('');
    try { setMovie(f(movie)); setDirty(true); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const brief = movie.items.find(i => i.id === 'brief')!;
  const cast = movie.items.filter(i => i.kind === 'cast');
  const save = async () => {
    setError(''); setNote('');
    try { await saveMovie(movie.title.trim() ? movie : { ...movie, title: t('wizards.movie.untitled') }); setDirty(false); setNote(t('wizards.movie.saved')); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const open = async (id: string) => {
    if (dirty && !window.confirm(t('wizards.movie.discard'))) return;
    setError(''); setNote('');
    setGone(null);
    try {
      setMovie(await openMovie(id)); setDirty(false); setNote(t('wizards.movie.opened'));
      // Read-only look at which recorded clips and reference pictures are gone; failing to look never blocks opening.
      void checkMovie(id).then(c => setGone(c.missing.length || c.truncated ? c : null), () => setError(t('wizards.movie.check.failed')));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const fresh = () => { if (dirty && !window.confirm(t('wizards.movie.discard'))) return; setMovie(newMovie(newMovieId(), '')); setGone(null); setDirty(false); setError(''); setNote(''); };
  const addRefs = async (id: string, current: string[]) => {
    try { const path = await pickMedia(t('wizards.movie.refsTitle')); if (path && !current.includes(path)) change(m => setCastRefs(m, id, [...current, path])); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return <div className="forge-card wizards-form" data-wizard-form="movie">
    <div className="forge-card-head"><h3 className="forge-card-title">{t('wizards.movie.name')}</h3></div>
    <p className="forge-note" data-movie-notice>{t('wizards.movie.notice')}</p>
    <div className="wizards-step">
      <span className="forge-note">{t('wizards.movie.brief')}</span>
      <div className="wizards-fields">
        <label className="forge-field"><span>{t('wizards.movie.movieTitle')}</span>
          <input type="text" data-movie-title value={movie.title} maxLength={120} onChange={e => change(m => setBrief(m, { title: e.target.value }))}/></label>
        <label className="forge-field"><span>{t('wizards.movie.seconds')}</span>
          <input type="number" data-movie-seconds min={1} max={600} step={1} value={movie.targetSeconds}
            onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 1 && n <= 600) change(m => setBrief(m, { targetSeconds: n })); }}/></label>
        <label className="forge-field"><span>{t('wizards.movie.aspect')}</span>
          <select data-movie-aspect value={movie.aspect} onChange={e => change(m => setBrief(m, { aspect: e.target.value }))}>
            {(ASPECTS.includes(movie.aspect) ? ASPECTS : [...ASPECTS, movie.aspect]).map(a => <option key={a} value={a}>{a}</option>)}
          </select></label>
      </div>
      <label className="forge-field"><span>{t('wizards.movie.story')}</span>
        <textarea data-movie-story rows={5} maxLength={20000} value={brief.text} placeholder={t('wizards.movie.storyPlaceholder')} onChange={e => change(m => editItem(m, 'brief', e.target.value))}/></label>
    </div>
    <div className="wizards-step" data-movie-cast>
      <span className="forge-note">{t('wizards.movie.cast')}</span>
      <p className="forge-note">{t('wizards.movie.castHint')}</p>
      <div className="wizards-row">
        <label className="forge-field"><span>{t('wizards.movie.castRole')}</span>
          <select data-movie-new-role value={role} onChange={e => setRole(e.target.value as MovieCastRole)}>
            {MOVIE_CAST_ROLES.map(r => <option key={r} value={r}>{t(`wizards.movie.role.${r}`)}</option>)}
          </select></label>
        <label className="forge-field"><span>{t('wizards.movie.castName')}</span>
          <input type="text" data-movie-new-name value={name} maxLength={80} onChange={e => setName(e.target.value)}/></label>
        <button type="button" className="forge-ghost" data-movie-add disabled={!name.trim()} onClick={() => { change(m => addCast(m, role, name.trim())); setName(''); }}>{t('wizards.movie.castAdd')}</button>
      </div>
      {!cast.length && <p className="forge-note" data-movie-cast-empty>{t('wizards.movie.castEmpty')}</p>}
      {cast.map(c => <div className="wizards-step" key={c.id} data-movie-cast-item={c.id}>
        <div className="wizards-row">
          <select aria-label={t('wizards.movie.castRole')} data-movie-role value={c.role ?? 'actor'} disabled={!!c.locked} onChange={e => change(m => setCastRole(m, c.id, e.target.value as MovieCastRole))}>
            {MOVIE_CAST_ROLES.map(r => <option key={r} value={r}>{t(`wizards.movie.role.${r}`)}</option>)}
          </select>
          <input type="text" aria-label={t('wizards.movie.castName')} data-movie-cast-name value={c.title} maxLength={80} disabled={!!c.locked} onChange={e => change(m => setItemTitle(m, c.id, e.target.value))}/>
          <label className="forge-note"><input type="checkbox" data-movie-lock checked={!!c.locked} onChange={e => change(m => setLocked(m, c.id, e.target.checked))}/> {t('wizards.movie.lock')}</label>
          <button type="button" className="forge-ghost" data-movie-remove disabled={!!c.locked} onClick={() => change(m => removeCast(m, c.id))}>{t('wizards.movie.castRemove')}</button>
        </div>
        <textarea aria-label={t('wizards.movie.castDesc')} data-movie-cast-text rows={2} maxLength={2000} disabled={!!c.locked} value={c.text} placeholder={t('wizards.movie.castDescPlaceholder')} onChange={e => change(m => editItem(m, c.id, e.target.value))}/>
        <div className="wizards-row">
          <button type="button" className="forge-ghost" data-movie-add-ref disabled={!native || !!c.locked || (c.refs?.length ?? 0) >= 16} onClick={() => void addRefs(c.id, c.refs ?? [])}>{t('wizards.movie.refsAdd')}</button>
          <span className="forge-note">{t('wizards.movie.refsCount', { count: String(c.refs?.length ?? 0) })}</span>
        </div>
        {(c.refs ?? []).map(p => <div className="wizards-row" key={p} data-movie-ref>
          <span className="forge-note wizards-name" title={p}>{fileName(p)}</span>
          <button type="button" className="forge-ghost" data-movie-ref-remove disabled={!!c.locked} aria-label={t('wizards.movie.refRemove', { name: fileName(p) })} onClick={() => change(m => setCastRefs(m, c.id, (c.refs ?? []).filter(x => x !== p)))}>{t('wizards.movie.refRemoveShort')}</button>
        </div>)}
      </div>)}
    </div>
    <div className="wizards-step" data-movie-plan>
      <span className="forge-note">{t('wizards.movie.plan.title')}</span>
      <p className="forge-note">{t('wizards.movie.plan.intro')}</p>
      {limits && <p className="forge-note" data-movie-limits>{t('wizards.movie.plan.limits', { min: String(limits.min), max: String(limits.max), step: String(limits.step ?? 0.1) })}{limits.unverified ? ` ${t('wizards.movie.plan.unverified')}` : ''}</p>}
      {llm && !llm.length && <p className="forge-note" data-movie-no-model>{t('wizards.movie.plan.noModel')}</p>}
      {!!llm?.length && <label className="forge-field"><span>{t('wizards.movie.plan.model')}</span>
        <select data-movie-llm value={llmKey} onChange={e => { setLlmKey(e.target.value); setAsk(null); }}>
          {llm.map(m => <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>{m.provider === 'local' ? m.name : `${m.name} (${m.provider})`}</option>)}
        </select></label>}
      <div className="wizards-row">
        <button type="button" className="action-button" data-movie-plan-run disabled={!!planBlocked || planning} title={planBlocked || undefined} onClick={() => void begin()}>{t(planning ? 'wizards.movie.plan.busy' : 'wizards.movie.plan.run')}</button>
        {planBlocked && <span className="forge-note" data-movie-plan-blocked>{planBlocked}</span>}
      </div>
      {ask && <div className="wizards-step" role="alertdialog" aria-label={t('wizards.movie.plan.remoteTitle')} data-movie-remote>
        <strong>{t('wizards.movie.plan.remoteTitle')}</strong>
        <p className="forge-note">{t('wizards.movie.plan.remoteBody', { chars: String(ask.chars), cast: String(ask.cast), host: ask.host })}</p>
        <div className="wizards-row">
          <button type="button" className="action-button" data-movie-remote-send onClick={() => { logMovieNotice('plan-remote'); void run(); }}>{t('wizards.movie.plan.remoteSend')}</button>
          <button type="button" className="forge-ghost" data-movie-remote-cancel onClick={() => setAsk(null)}>{t('wizards.movie.plan.cancel')}</button>
        </div>
      </div>}
      {check && !check.plan && <div className="wizards-step" data-movie-plan-invalid>
        <p className="error-message" role="alert">{t('wizards.movie.plan.invalid')}</p>
        <ul>{check.errors.slice(0, 12).map((e, n) => <li key={n} className="forge-note">{e}</li>)}</ul>
      </div>}
      {check?.plan && diff && <div className="wizards-step" data-movie-plan-diff>
        <strong>{t('wizards.movie.plan.diffTitle', { segments: String(check.plan.segments.length) })}</strong>
        <p className="forge-note">{t('wizards.movie.plan.diffLine', { added: String(diff.added), changed: String(diff.changed.length), unchanged: String(diff.unchanged.length), locked: String(diff.lockedKept.length), removed: String(diff.removed.length) })}</p>
        <p className="forge-note">{t('wizards.movie.plan.diffStory', { state: t(`wizards.movie.plan.state.${diff.story}`) })}</p>
        {!!diff.staleAfter.length && <p className="forge-note" data-movie-plan-stale>{t('wizards.movie.plan.stale', { count: String(diff.staleAfter.length) })}</p>}
        {check.warnings.map((w, n) => <p key={n} className="forge-note" data-movie-plan-warning>{w}</p>)}
        <div className="wizards-row">
          <button type="button" className="action-button" data-movie-plan-apply onClick={() => { const plan = check.plan!; change(m => applyPlan(m, plan)); logMovieNotice('plan-applied'); setCheck(null); setNote(t('wizards.movie.plan.applied')); }}>{t('wizards.movie.plan.apply')}</button>
          <button type="button" className="forge-ghost" data-movie-plan-discard onClick={() => setCheck(null)}>{t('wizards.movie.plan.discard')}</button>
        </div>
      </div>}
    </div>
    {story && <div className="wizards-step" data-movie-story-stage>
      <span className="forge-note">{t('wizards.movie.plan.lore')}</span>
      <textarea aria-label={t('wizards.movie.plan.lore')} data-movie-lore rows={4} maxLength={20000} disabled={!!story.locked} value={story.text} onChange={e => change(m => editItem(m, story.id, e.target.value))}/>
      <label className="forge-note"><input type="checkbox" data-movie-lock-story checked={!!story.locked} onChange={e => change(m => setLocked(m, story.id, e.target.checked))}/> {t('wizards.movie.lock')}</label>
      <span className="forge-note">{t('wizards.movie.plan.segments')}</span>
      {!!segments.length && !h3Model && <p className="forge-note" data-movie-shot-nomodel>{t('wizards.movie.shot.noModel')}</p>}
      {!!segments.length && h3Models.length > 1 && <label className="forge-field"><span>{t('wizards.movie.shot.model')}</span>
        <select data-movie-shot-model value={h3Model?.path ?? ''} onChange={e => setH3Path(e.target.value)}>{h3Models.map(m => <option key={m.path} value={m.path}>{m.name}</option>)}</select></label>}
      {segments.map((g, n) => <div className="wizards-step" key={g.id} data-movie-segment={g.id}>
        <div className="wizards-row">
          <strong className="forge-note">{n + 1}</strong>
          <input type="text" aria-label={t('wizards.movie.plan.segTitle')} data-movie-seg-title value={g.title} maxLength={200} disabled={!!g.locked} onChange={e => change(m => setItemTitle(m, g.id, e.target.value))}/>
          <label className="forge-note">{t('wizards.movie.plan.segSeconds')} <input type="number" data-movie-seg-seconds min={limits?.min ?? 1} max={limits?.max ?? 15} step={limits?.step ?? 0.5} value={g.seconds ?? 0} disabled={!!g.locked}
            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) change(m => reviseItem(m, g.id, { seconds: v })); }}/></label>
          <label className="forge-note"><input type="checkbox" data-movie-seg-continuous checked={!!g.continuous} disabled={n === 0 || !!g.locked} onChange={e => change(m => reviseItem(m, g.id, { continuous: e.target.checked }))}/> {t('wizards.movie.plan.segContinuous')}</label>
          <label className="forge-note"><input type="checkbox" data-movie-seg-lock checked={!!g.locked} onChange={e => change(m => setLocked(m, g.id, e.target.checked))}/> {t('wizards.movie.lock')}</label>
        </div>
        <textarea aria-label={t('wizards.movie.plan.segPrompt')} data-movie-seg-prompt rows={2} maxLength={4000} disabled={!!g.locked} value={g.text} onChange={e => change(m => editItem(m, g.id, e.target.value))}/>
        <div className="wizards-row" data-movie-shot={g.id}>
          <span className="forge-note" data-movie-shot-state>{t(`wizards.movie.shot.state.${shotState?.id === g.id && (shotState.state === 'queued' || shotState.state === 'running') ? 'running' : g.state}`)}</span>
          <button type="button" className="forge-ghost" data-movie-shot-prepare disabled={!native || !onPrepare || !h3Model || making || continued(g.id)} title={shotBlock(g, n)} onClick={() => chainLen(g.id) > 1 ? makeChain(g.id, false) : makeShot(g.id, false)}>{t(chainLen(g.id) > 1 ? 'wizards.movie.shot.prepareChain' : 'wizards.movie.shot.prepare')}</button>
          <button type="button" className="action-button" data-movie-shot-make disabled={!native || !onPrepare || !h3Model || making || continued(g.id)} title={shotBlock(g, n)} onClick={() => chainLen(g.id) > 1 ? makeChain(g.id, true) : makeShot(g.id, true)}>{chainLen(g.id) > 1 ? t(g.state === 'done' ? 'wizards.movie.shot.chainAgain' : 'wizards.movie.shot.makeChain', { count: String(chainLen(g.id)) }) : t(g.state === 'done' ? 'wizards.movie.shot.again' : 'wizards.movie.shot.make')}</button>
        </div>
        {shotState?.id === g.id && shotState.error && <p className="error-message" role="alert" data-movie-shot-error>{shotState.error}</p>}
        {g.state === 'done' && (() => { const out = g.revisions.find(r => r.n === g.revision)?.result?.outputId; return out && /\.(mp4|webm|mkv|mov)$/i.test(out) ? <video className="wizards-preview" src={convertFileSrc(out)} controls preload="metadata" data-movie-shot-video/> : null; })()}
        <p className="forge-note" data-movie-seg-actual>{t('wizards.movie.plan.actual', { seconds: (Math.round(h3ActualSeconds(g.seconds ?? 0, !!g.continuous) * 100) / 100).toString() })}</p>
        {(g.dialogue ?? []).map((d, k) => <p key={k} className="forge-note" data-movie-seg-line>{t('wizards.movie.plan.line', { name: nameOf(d.castId), line: d.line })}</p>)}
      </div>)}
      {!!segments.length && <p className="forge-note" data-movie-total>{t('wizards.movie.plan.total', {
        planned: String(deliveredSeconds(movie, 0)), actual: String(Math.round(segments.reduce((a, g) => a + h3ActualSeconds(g.seconds ?? 0, !!g.continuous), 0) * 100) / 100), target: String(movie.targetSeconds) })}</p>}
    </div>}
    {final && <div className="wizards-step" data-movie-film>
      <span className="forge-note">{t('wizards.movie.film.title')}</span>
      <p className="forge-note">{t('wizards.movie.film.intro')}</p>
      {!filmPlan.ok && filmPlan.missing.length > 0 && <ul data-movie-film-missing>{filmPlan.missing.map(x => <li key={x.id} className="forge-note">{t('wizards.movie.film.missing', { title: x.title, why: why(x.why) })}</li>)}</ul>}
      {final.state === 'stale' && <p className="forge-note" data-movie-film-stale>{t('wizards.movie.film.stale')}</p>}
      <div className="wizards-row">
        <button type="button" className="action-button" data-movie-film-run disabled={!!joinBlocked || !!joining} title={joinBlocked || undefined} onClick={() => void join()}>{t(final.state === 'done' ? 'wizards.movie.film.again' : 'wizards.movie.film.run')}</button>
        {joining && <button type="button" className="forge-ghost" data-movie-film-stop onClick={stopJoin}>{t('wizards.run.stop')}</button>}
        {joining && <span className="forge-note" role="status" data-movie-film-progress>{joining}</span>}
        {joinBlocked && !joining && <span className="forge-note" data-movie-film-blocked>{joinBlocked}</span>}
      </div>
      {mismatch && <p className="forge-note" role="alert" data-movie-film-mismatch>{t('wizards.movie.film.mismatch', { got: String(mismatch.got), want: String(mismatch.want) })}</p>}
      {filmClip && /\.(mp4|webm|mkv|mov)$/i.test(filmClip) && <video className="wizards-preview" src={convertFileSrc(filmClip)} controls preload="metadata" data-movie-film-video/>}
    </div>}
    {final && <div className="wizards-step" data-movie-music>
      <span className="forge-note">{t('wizards.movie.music.title')}</span>
      <p className="forge-note">{t('wizards.movie.music.intro')}</p>
      <div className="wizards-row">
        <button type="button" className="forge-ghost" data-movie-music-pick disabled={!native} onClick={() => void chooseMusic()}>{t(music?.file ? 'wizards.movie.music.change' : 'wizards.movie.music.pick')}</button>
        {music?.file && <span className="forge-note wizards-name" title={music.file} data-movie-music-file>{fileName(music.file)}</span>}
        {music?.file && <button type="button" className="forge-ghost" data-movie-music-clear onClick={() => change(m => setMusicFile(m, null))}>{t('wizards.movie.music.clear')}</button>}
      </div>
      {score?.mix && <div className="wizards-fields">
        {([['levelDb', 'level'], ['duckDb', 'duck'], ['fadeSeconds', 'fade']] as const).map(([key, label]) => <label className="forge-field" key={key}><span>{t(`wizards.movie.music.${label}`)}</span>
          <input type="number" data-movie-mix={key} min={MIX_LIMITS[key][0]} max={MIX_LIMITS[key][1]} step={key === 'fadeSeconds' ? 0.5 : 1} value={score.mix![key]}
            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) change(m => setMix(m, { [key]: v })); }}/></label>)}
      </div>}
      {score?.mix && <p className="forge-note" data-movie-music-hint>{t('wizards.movie.music.hint')}</p>}
      <div className="wizards-row">
        <button type="button" className="action-button" data-movie-music-run disabled={!!mixBlocked || mixing} title={mixBlocked || undefined} onClick={() => void mixIt()}>{t(mixing ? 'wizards.movie.music.mixing' : score?.state === 'done' ? 'wizards.movie.music.again' : 'wizards.movie.music.run')}</button>
        {mixBlocked && <span className="forge-note" data-movie-music-blocked>{mixBlocked}</span>}
      </div>
      {score && (score.state === 'stale' || (score.state === 'planned' && score.revisions.some(r => r.result))) && <p className="forge-note" data-movie-music-stale>{t('wizards.movie.music.stale')}</p>}
      {scoredClip && /\.(mp4|webm|mkv|mov)$/i.test(scoredClip) && <video className="wizards-preview" src={convertFileSrc(scoredClip)} controls preload="metadata" data-movie-scored-video/>}
    </div>}
    <div className="wizards-row wizards-actions">
      <button type="button" className="action-button" data-movie-save disabled={!native || !dirty} onClick={() => void save()}>{t('wizards.movie.save')}</button>
      <button type="button" className="forge-ghost" data-movie-new onClick={fresh}>{t('wizards.movie.new')}</button>
      {dirty && <span className="forge-note" data-movie-dirty>{t('wizards.movie.unsaved')}</span>}
    </div>
    <div className="wizards-step" data-movie-saved>
      <span className="forge-note">{t('wizards.movie.open')}</span>
      {saved && !saved.movies.length && <p className="forge-note" data-movie-none>{t('wizards.movie.none')}</p>}
      {saved?.movies.map(s => <div className="wizards-row" key={s.id} data-movie-saved-item={s.id}>
        <button type="button" className="forge-ghost" data-movie-open={s.id} onClick={() => void open(s.id)}>{s.title || s.id}</button>
        <span className="forge-note">{t('wizards.movie.savedInfo', { items: String(s.items), seconds: String(s.targetSeconds) })}</span>
      </div>)}
      {!!saved?.damaged && <p className="forge-note" data-movie-damaged>{t('wizards.movie.damaged', { count: String(saved.damaged) })}</p>}
    </div>
    {gone && <div className="wizards-step" role="alert" data-movie-gone>
      <p className="forge-note">{t('wizards.movie.check.missing', { count: String(gone.missing.length) })}</p>
      <ul>{gone.missing.slice(0, 30).map((f, n) => <li key={n} className="forge-note" title={f.path}>{t(`wizards.movie.check.${f.kind}`, { title: movie.items.find(i => i.id === f.id)?.title || f.id, name: fileName(f.path) })}</li>)}</ul>
      {gone.truncated && <p className="forge-note">{t('wizards.movie.check.truncated')}</p>}
      <div className="wizards-row">
        {gone.missing.some(f => f.kind === 'result') && <button type="button" className="forge-ghost" data-movie-gone-mark onClick={() => { const ids = [...new Set(gone.missing.filter(f => f.kind === 'result').map(f => f.id))]; change(m => markResultsMissing(m, ids)); setGone(g => g && { ...g, missing: g.missing.filter(f => f.kind !== 'result') }); }}>{t('wizards.movie.check.mark')}</button>}
        <button type="button" className="forge-ghost" data-movie-gone-dismiss onClick={() => setGone(null)}>{t('wizards.movie.check.dismiss')}</button>
      </div>
    </div>}
    {note && <p className="forge-note" role="status" data-movie-note>{note}</p>}
    {error && <p className="error-message" role="alert" data-movie-error>{error}</p>}
  </div>;
}
