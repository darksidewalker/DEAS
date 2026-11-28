import { useEffect, useRef, useState } from 'react';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { LORA_STRENGTH, MIX_LIMITS, SAMPLING_LIMITS, manifestProblem, setRender, setShotSampling, roleOf, assignMedia, dropMedia, scenesUsing, setTransition, type MediaRole, addMedia, addScene, removeMedia, setMediaNote, markResultsMissing, removeScene, scenesSeconds, setMix, setMusicFile, setSceneInputs, setSceneSeconds, setShotLoras, setShotModel, reviseItem, newMovie, setBrief, setItemTitle, setLocked, editItem, type MovieItem, type MovieManifest } from '../../lib/movieManifest';
import type { LlmModel } from '../../lib/llm';
import { applyMusic, applyPlan, h3ActualSeconds, musicDiff, planDiff, segmentLimits, type MusicCheck, type PlanCheck, type PlanMode } from '../../lib/movieStory';
import { PLANNER_MAX_CHARS, listPlannerModels, logMovieNotice, musicPayload, plannerDestination, plannerPayload, requestMusic, requestPlan } from '../../lib/movieStoryRun';
import { recordShotRun, shotHandoff } from '../../lib/movieSegments';
import { chainHandoff, chainOf } from '../../lib/movieChainRun';
import { MUSIC_FAMILIES, isRestrictedMusicFamily, mixMusic, musicInfo, mixPlan, musicHandoff, musicSeconds, pickMusic, recordGeneratedMusic, recordScore, setMusicFields, setMusicLoras, setMusicPrompt } from '../../lib/movieMusic';
import { MUSIC_BPM, MUSIC_PRESETS, musicPreset, presetDialect, presetName, styleFor } from '../../lib/musicPresets';
import { MOVIE_RESOLUTIONS, modelVariant, movieRender, movieSize, shotSampling } from '../../lib/movieRender';
import { SHOT_FAMILY } from '../../lib/movieSegments';
import { aceLanguages } from '../../lib/musicIntent';
import { forgetPref, readPref, writePref } from '../../lib/preferences';
import { AssemblyError, assemblyPlan, assembleMovie, recordFilm } from '../../lib/movieAssemble';
import { realAssembleDeps, stopAssemblyJob } from '../../lib/movieAssembleRun';
import { advanceItemEpochs, canApplyMusicGeneration, canApplySceneStep, canCompleteFilm, canCompleteMix, captureFilmSubmission, captureMixSubmission, captureMusicSubmission, captureSceneSubmission, needsStitch, nextMovieStep, pendingTargetShot, recordCompletedChainShot, shouldRestitchAfterShot, type PendingGeneration, type SceneInputContext, type ShotOrigin, type SubmittedFilm, type SubmittedMix } from '../../lib/movieRun';
import type { JobStatus } from '../../lib/jobs';
import { AspectPicker } from '../studio/AspectPicker';
import type { MediaRoots } from '../media/MediaLibrary';
import { SceneInputMarks, SceneInputs } from './SceneInputs';
import { MovieTimeline, type MoviePanelTarget } from './MovieTimeline';
import { MoviePanel } from './MoviePanel';
import { MoviePlayer } from './MoviePlayer';
import { MovieMediaPool, MovieMediaSettings, describeMediaPicture } from './MovieMedia';
import { MoviePlanPreview } from './MoviePlanPreview';
import '../downloads/installedGallery.css';
import builtinFamilies from '../../families/builtin.json' with { type: 'json' };
import { modelsForFamilies, type WizardHandoff, type WizardModel, type WizardRun } from '../../lib/wizards';
import { checkMovie, listMovies, newMovieId, openMovie, saveMovie, type MovieCheck, type MovieList } from '../../lib/movies';

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
/** The movie being edited survives leaving the tab, switching wizards and restarting the app (saved movies stay explicit files). */
const DRAFT_KEY = 'wizards.movie.draft';
const DRAFT_MAX_CHARS = 2_000_000;
type MovieDraft = { movie: MovieManifest; dirty: boolean };
const readDraft = (): MovieDraft | null => readPref<MovieDraft | null>(DRAFT_KEY, null, (v): v is MovieDraft => !!v && typeof v === 'object' && typeof (v as MovieDraft).dirty === 'boolean' && manifestProblem((v as MovieDraft).movie) === undefined);
const languageLabel = (code: string, locale: string) => { try { return `${new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code} (${code})`; } catch { return code; } };

/**
 * Movie Maker, first stages (UX-22d2): Brief and Cast / references. This only edits and saves the movie plan; nothing here generates,
 * submits a job or analyses a picture, and reopening a saved movie never resumes anything.
 */
const PLAN_FAMILY = 'minimax-h3';
export interface MovieMakerProps {
  /** The environment root Prompt Forge and Chat use for their LLM configuration and models (not the models folder). */
  root?: string;
  /** Input/output folders for the media panel the scene inputs are picked from (Generate's own). */
  mediaRoots?: MediaRoots;
  /** Backend address for the final Join (Continuity's Join clips recipe). */
  endpoint?: string;
  /** Installed models as the Dark Wizards tab scanned them (null while unknown). */
  models?: WizardModel[] | null;
  /** Hands a shot to Generate as an ordinary draft (optionally running it); the result comes back through `outcome`. */
  onPrepare?: (handoff: Omit<WizardHandoff, 'n'>) => void;
  outcome?: { n: number; error?: string; run?: WizardRun };
  handoff?: number;
}
export function MovieMaker({ root, mediaRoots, endpoint, models = null, onPrepare, outcome, handoff }: MovieMakerProps) {
  const { t, locale } = useI18n();
  const native = isTauri();
  const restored = useRef<MovieDraft | null | undefined>(undefined);
  if (restored.current === undefined) restored.current = readDraft();
  const [movie, setMovie] = useState<MovieManifest>(() => restored.current?.movie ?? newMovie(newMovieId(), ''));
  const [dirty, setDirty] = useState(() => restored.current?.dirty ?? false);
  const [draft, setDraft] = useState(1);
  const draftRef = useRef(1);
  const openSeq = useRef(0);
  const movieRef = useRef(movie); movieRef.current = movie;
  const epochsRef = useRef<Map<string, number>>(new Map());
  // Every change is kept as the working draft (debounced); a saved movie file is still only written by *Save movie*.
  useEffect(() => {
    const id = window.setTimeout(() => { const text = JSON.stringify({ movie, dirty }); if (text.length <= DRAFT_MAX_CHARS) writePref(DRAFT_KEY, { movie, dirty }); else forgetPref(DRAFT_KEY); }, 300);
    return () => window.clearTimeout(id);
  }, [movie, dirty]);
  const latest = useRef({ movie, dirty }); latest.current = { movie, dirty };
  const updateMovie = (next: MovieManifest, nextDirty: boolean, freshDraft = false) => {
    epochsRef.current = freshDraft ? new Map() : advanceItemEpochs(movieRef.current, next, epochsRef.current);
    movieRef.current = next;
    latest.current = { movie: next, dirty: nextDirty };
    setMovie(next);
    setDirty(nextDirty);
  };
  useEffect(() => () => { const d = latest.current; if (JSON.stringify(d).length <= DRAFT_MAX_CHARS) writePref(DRAFT_KEY, d); }, []);
  const [saved, setSaved] = useState<MovieList | null>(null);
  const [note, setNote] = useState(() => restored.current?.dirty ? t('wizards.movie.restored') : '');
  const [error, setError] = useState('');
  const [gone, setGone] = useState<MovieCheck | null>(null);
  // Which card's settings are open in the non-blocking panel (a scene, the music or the film).
  const [panel, setPanel] = useState<MoviePanelTarget>(null);
  const [describing, setDescribing] = useState(false);
  const [refused, setRefused] = useState<string[]>([]);
  const [inputsOpen, setInputsOpen] = useState('');
  const [planMode, setPlanMode] = useState<PlanMode>('suggest');
  const [llm, setLlm] = useState<LlmModel[] | null>(null);
  const [llmKey, setLlmKey] = useState('');
  const [planning, setPlanning] = useState(false);
  const [ask, setAsk] = useState<{ host: string; chars: number; scenes: number; mode: PlanMode | 'music' } | null>(null);
  const [musicCheck, setMusicCheck] = useState<MusicCheck | null>(null);
  const [musicReplace, setMusicReplace] = useState(false);
  const [check, setCheck] = useState<PlanCheck | null>(null);
  const limits = segmentLimits(PLAN_FAMILY);
  const h3Models = models ? modelsForFamilies([PLAN_FAMILY], models) : [];
  // The default video model is part of the movie (its Steps/CFG belong to it); the first installed one when unset or gone.
  const render = movieRender(movie);
  const h3Model = h3Models.find(m => m.name === render.model) ?? h3Models[0];
  const startFor = (shot?: MovieItem) => shotSampling(movie, shot, SHOT_FAMILY, shot?.model || h3Model?.name || '', h3Model?.name ?? '');
  const movieSampling = startFor();
  const variant = h3Model ? modelVariant(SHOT_FAMILY, h3Model.name) : undefined;
  const fixedSize = render.source === 'movie' ? movieSize(movie.aspect, render.resolution, SHOT_FAMILY) : undefined;
  // The shot/chain/music Generate is making for us: active job ownership is global across drafts and released only when settled,
  // while permission to publish a result is checked separately against the current draft, revisions and effective submitted inputs.
  const sent = useRef<PendingGeneration | null>(null);
  const [activePending, setActivePending] = useState<PendingGeneration | null>(null);
  const setPending = (next: PendingGeneration | null) => { sent.current = next; setActivePending(next); };
  const [shotState, setShotState] = useState<{ draft: number; id: string; state: string; error?: string } | null>(null);
  const [chainBusy, setChainBusy] = useState(false);
  const chainBusyRef = useRef(false);
  const setChainActive = (next: boolean) => { chainBusyRef.current = next; setChainBusy(next); };
  const isGenBusy = () => (!!sent.current && sent.current.run) || chainBusyRef.current;
  const currentShotState = shotState?.draft === draft ? shotState : null;
  const making = (!!activePending && activePending.run) || chainBusy;
  // A shot's own model and LoRAs are checked against what is installed before anything is handed over.
  const modelsRef = useRef(models); modelsRef.current = models;
  const h3Loras = models ? models.filter(x => x.category === 'loras' && x.family === PLAN_FAMILY) : [];
  const env = {
    resolveModel: (name: string) => { const x = h3Models.find(y => y.name === name); return x && { name: x.name, path: x.path }; },
    hasLora: (name: string) => h3Loras.some(x => x.name === name),
  };
  const sceneCtxFor = (m: MovieManifest): SceneInputContext => {
    const all = modelsRef.current;
    const h3List = all ? modelsForFamilies([PLAN_FAMILY], all) : [];
    const loras = all ? all.filter(x => x.category === 'loras' && x.family === PLAN_FAMILY) : [];
    const def = h3List.find(x => x.name === movieRender(m).model) ?? h3List[0];
    const tInfo = trackInfoRef.current;
    return {
      defaultModel: def && { name: def.name, path: def.path },
      toSrc: convertFileSrc,
      env: {
        resolveModel: (name: string) => { const x = h3List.find(y => y.name === name); return x && { name: x.name, path: x.path }; },
        hasLora: (name: string) => loras.some(x => x.name === name),
      },
      track: tInfo ?? undefined,
    };
  };
  const makeShot = (id: string, run: boolean, origin: ShotOrigin = 'manual'): boolean => {
    if (isGenBusy() || !onPrepare || !h3Model) return false;
    if (referenceMode && !track) { setError(t('wizards.movie.music.trackUnknown')); return false; }
    const cur = movieRef.current;
    const r = shotHandoff(cur, id, { name: h3Model.name, path: h3Model.path }, run, convertFileSrc, env, track);
    if ('blocked' in r) { setError(r.detail ? `${t(r.blocked)} ${r.detail}` : t(r.blocked)); return false; }
    const shot = cur.items.find(i => i.id === id && i.kind === 'segment');
    const found = chainOf(cur, id), isContinued = !!found && found.chain.ids[0] !== id;
    const sub = captureSceneSubmission((handoff ?? 0) + 1, draftRef.current, cur, epochsRef.current, [id], [shot?.seconds ? h3ActualSeconds(shot.seconds, isContinued) : undefined], run, origin, false, sceneCtxFor(cur));
    if (!sub) { setError(t('wizards.movie.staleSubmission')); logMovieNotice('submission-stale'); return false; }
    setError(''); setNote(r.skipped ? t('wizards.movie.shot.skipped', { count: String(r.skipped) }) : '');
    setPending(sub); setChainActive(false); setShotState(run ? { draft: sub.draft, id, state: 'queued' } : null);
    onPrepare(r.handoff);
    return true;
  };
  // A chain reports one shot after the other (`run.step`); a lone shot reports once. The chain is busy until its last shot ends or one fails.
  const makeChain = (id: string, run: boolean, origin: ShotOrigin = 'manual'): boolean => {
    const cur = movieRef.current;
    const found = chainOf(cur, id);
    if (isGenBusy() || !onPrepare || !h3Model || !found) return false;
    const r = chainHandoff(cur, found.chain, found.index, { name: h3Model.name, path: h3Model.path }, run, convertFileSrc, env, referenceMode);
    if ('blocked' in r) { setError(r.detail ? `${t(r.blocked)} ${r.detail}` : t(r.blocked)); return false; }
    const sub = captureSceneSubmission((handoff ?? 0) + 1, draftRef.current, cur, epochsRef.current, found.chain.ids, r.actualSeconds, run, origin, true, sceneCtxFor(cur));
    if (!sub) { setError(t('wizards.movie.staleSubmission')); logMovieNotice('submission-stale'); return false; }
    setError(''); setNote(r.skipped ? t('wizards.movie.shot.skipped', { count: String(r.skipped) }) : '');
    setPending(sub); setChainActive(run); setShotState(run ? { draft: sub.draft, id, state: 'queued' } : null);
    onPrepare(r.handoff);
    return true;
  };
  useEffect(() => {
    const s = sent.current, r = outcome?.run;
    if (!s || !outcome || outcome.n !== s.n) return;
    if (outcome.error) {
      setPending(null); setChainActive(false);
      if (s.draft === draftRef.current) {
        if (autoRunRef.current) { autoRunRef.current = false; setAutoRun(false); }
        setRestitch(false);
      }
      const cur = movieRef.current;
      if (s.kind === 'music') {
        const valid = canApplyMusicGeneration(draftRef.current, cur, epochsRef.current, s, musicSeconds(cur), currentMusicModelPath());
        setShotState(valid ? { draft: s.draft, id: 'music', state: 'failed', error: outcome.error } : null);
        if (valid) setError(outcome.error);
      } else {
        const target = pendingTargetShot(s);
        const valid = !!target.id && !!canApplySceneStep(draftRef.current, cur, epochsRef.current, s, target.id, target.stepIndex, sceneCtxFor(cur));
        setShotState(valid ? { draft: s.draft, id: target.id, state: 'failed', error: outcome.error } : null);
        if (valid) setError(outcome.error);
      }
      return;
    }
    if (!r) { if (!s.run) setPending(null); return; }
    if (s.kind === 'music') {
      const cur = movieRef.current;
      const valid = canApplyMusicGeneration(draftRef.current, cur, epochsRef.current, s, musicSeconds(cur), currentMusicModelPath());
      if (r.state === 'queued' || r.state === 'running') {
        if (s.draft === draftRef.current) setShotState(valid ? { draft: s.draft, id: 'music', state: r.state, ...(r.error ? { error: r.error } : {}) } : null);
        return;
      }
      setPending(null);
      const musicOk = r.state === 'succeeded' && !!r.picture?.audio;
      if ((!musicOk || !valid) && s.draft === draftRef.current && autoRunRef.current) { autoRunRef.current = false; setAutoRun(false); }
      if (!valid) {
        if (s.draft === draftRef.current) setShotState(null);
        return;
      }
      setShotState({ draft: s.draft, id: 'music', state: r.state, ...(r.error ? { error: r.error } : {}) });
      if (r.state === 'unknown' && r.error) setError(r.error);
      const next = recordGeneratedMusic(cur, r);
      if (next !== cur) updateMovie(next, true);
      return;
    }
    const target = pendingTargetShot(s, r.step), id = target.id;
    const cur = movieRef.current;
    const matched = canApplySceneStep(draftRef.current, cur, epochsRef.current, s, id, target.stepIndex, sceneCtxFor(cur));
    if (r.state === 'queued' || r.state === 'running') {
      if (s.draft === draftRef.current) setShotState(matched ? { draft: s.draft, id, state: r.state, ...(r.error ? { error: r.error } : {}) } : null);
      return;
    }
    const shotOk = r.state === 'succeeded' && !!r.picture?.video;
    const lastShot = !r.step || r.step.index >= r.step.total - 1;
    if (lastShot || !shotOk) { setPending(null); setChainActive(false); }
    if (!shotOk && s.draft === draftRef.current) {
      if (autoRunRef.current) { autoRunRef.current = false; setAutoRun(false); }
      setRestitch(false);
    }
    if (!matched) {
      if (s.draft === draftRef.current) { setShotState(null); if (s.origin === 'auto' && autoRunRef.current) { autoRunRef.current = false; setAutoRun(false); } }
      return;
    }
    if (shotOk && !lastShot) setPending(recordCompletedChainShot(s, id));
    setShotState({ draft: s.draft, id, state: r.state, ...(r.error ? { error: r.error } : {}) });
    if (!shotOk && r.state === 'unknown' && r.error) setError(r.error);
    if (shotOk || !s.completedIds.includes(id)) {
      const next = recordShotRun(cur, id, r, matched.actualSeconds);
      if (next !== cur) updateMovie(next, true);
    }
    // A scene (re)made intentionally on its own: the film is stitched again once every scene is made.
    if (shouldRestitchAfterShot(s, lastShot, r.state, shotOk)) setRestitch(true);
  }, [outcome]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => { if (!native) return; try { setSaved(await listMovies()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!native || !root) { setLlm([]); return; }
    let alive = true;
    listPlannerModels(root).then(list => { if (alive) { setLlm(list); setLlmKey(k => k || (list[0] ? `${list[0].provider}:${list[0].id}` : '')); } }, () => { if (alive) setLlm([]); });
    return () => { alive = false; };
  }, [native, root]);
  const llmModel = llm?.find(m => `${m.provider}:${m.id}` === llmKey);
  const story = movie.items.find(i => i.kind === 'story');
  const segments = movie.items.filter(i => i.kind === 'segment');
  const payload = limits ? plannerPayload(movie, limits, planMode) : undefined;
  const planBlocked = !native || !root ? t('wizards.movie.plan.native') : !limits ? t('wizards.movie.plan.noLimits') : !llmModel ? t('wizards.movie.plan.noModel')
    : !movie.items.find(i => i.id === 'brief')?.text.trim() ? t('wizards.movie.plan.needStory') : payload && payload.chars > PLANNER_MAX_CHARS ? t('wizards.movie.plan.tooLong', { max: String(PLANNER_MAX_CHARS) }) : '';
  const run = async (mode: PlanMode | 'music') => {
    if (!llmModel || !limits || !root) return;
    const startDraft = draftRef.current, cur = movieRef.current;
    setAsk(null); setError(''); setNote('');
    if (mode === 'music') {
      setMusicCheck(null); setWritingMusic(true);
      try { const res = await requestMusic(root, llmModel, cur); if (draftRef.current === startDraft) setMusicCheck(res); }
      catch (e) { if (draftRef.current === startDraft) setError(e instanceof Error ? e.message : String(e)); }
      finally { if (draftRef.current === startDraft) setWritingMusic(false); }
      return;
    }
    setCheck(null); setPlanning(true); setPlanMode(mode);
    try { const res = await requestPlan(root, llmModel, cur, limits, mode); if (draftRef.current === startDraft) setCheck(res); }
    catch (e) { if (draftRef.current === startDraft) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (draftRef.current === startDraft) setPlanning(false); }
  };
  // A model on another machine only ever receives the brief after the destination and contents are shown and confirmed here.
  const begin = async (mode: PlanMode | 'music') => {
    if ((mode === 'music' ? musicWriteBlocked : planBlocked) || !llmModel || !limits || !root) return;
    setError(''); setNote('');
    try {
      const where = await plannerDestination(root, llmModel);
      const sent = mode === 'music' ? musicPayload(movie) : plannerPayload(movie, limits, mode);
      if (where.remote) setAsk({ host: where.host, chars: sent.disclosure.storyCharacters, scenes: sent.disclosure.scenes, mode }); else await run(mode);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const [writingMusic, setWritingMusic] = useState(false);
  const musicWriteBlocked = !native || !root ? t('wizards.movie.plan.native') : !llmModel ? t('wizards.movie.plan.noModel')
    : !movie.items.find(i => i.id === 'brief')?.text.trim() ? t('wizards.movie.plan.needStory') : musicPayload(movie).chars > PLANNER_MAX_CHARS ? t('wizards.movie.plan.tooLong', { max: String(PLANNER_MAX_CHARS) }) : '';
  const [rewriteMade, setRewriteMade] = useState(false);
  const diff = check?.plan ? planDiff(movie, check.plan, { rewriteMade }) : undefined;
  const final = movie.items.find(i => i.id === 'final');
  const filmPlan = assemblyPlan(movie);
  const owned = useRef<{ cancelled: boolean; job?: JobStatus; submitted: SubmittedFilm } | null>(null);
  const [joining, setJoining] = useState('');
  const [mismatch, setMismatch] = useState<{ got: number; want: number } | null>(null);
  const joinBlocked = !native || !endpoint ? t('wizards.movie.film.native') : !filmPlan.ok ? t('wizards.movie.film.notReady') : making ? t('wizards.movie.film.making') : '';
  const join = async () => {
    if (joinBlocked || owned.current || isGenBusy()) return;
    const cur = movieRef.current;
    const submitted = captureFilmSubmission(draftRef.current, cur, epochsRef.current);
    if (!submitted) { setError(t('wizards.movie.staleSubmission')); logMovieNotice('submission-stale'); return; }
    const mine: { cancelled: boolean; job?: JobStatus; submitted: SubmittedFilm } = { cancelled: false, submitted };
    owned.current = mine; setError(''); setNote(''); setMismatch(null); setJoining(t('wizards.movie.film.joining'));
    try {
      const r = await assembleMovie(cur, realAssembleDeps(endpoint!, job => { mine.job = job; }), () => !mine.cancelled,
        (step, n, total) => { if (owned.current === mine) setJoining(step === 'copy' ? t('wizards.movie.film.copying', { n: String(n), total: String(total) }) : step === 'check' ? t('wizards.movie.film.checking') : t('wizards.movie.film.joining')); });
      if (owned.current !== mine || !canCompleteFilm(draftRef.current, movieRef.current, epochsRef.current, mine.submitted)) {
        if (owned.current === mine && autoRunRef.current) { autoRunRef.current = false; setAutoRun(false); }
        return;
      }
      updateMovie(recordFilm(movieRef.current, r), true);
      if (r.mismatch && r.expectedSeconds !== undefined && r.seconds !== undefined) setMismatch({ got: r.seconds, want: r.expectedSeconds });
      setNote(t('wizards.movie.film.done')); logMovieNotice('join-done');
    } catch (e) {
      const code = e instanceof AssemblyError ? e.code : 'failed';
      logMovieNotice(mine.cancelled || code === 'cancelled' ? 'join-cancelled' : code === 'blocked' ? 'join-blocked' : 'join-failed');
      if (!mine.cancelled && owned.current === mine && draftRef.current === mine.submitted.draft) setError(e instanceof Error ? e.message : String(e));
    } finally { if (owned.current === mine) { owned.current = null; setJoining(''); } }
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
  const mixRef = useRef<{ submitted: SubmittedMix } | null>(null);
  const [mixing, setMixing] = useState(false);
  // Reference mode: the music goes to H3 as an audio reference of each cut shot (its slice of the track) instead of being mixed in afterwards.
  const referenceMode = score?.mix?.mode === 'h3-reference' && !!music?.file;
  const [trackInfo, setTrackInfo] = useState<{ path: string; seconds: number } | null>(null);
  const trackInfoRef = useRef<{ path: string; seconds: number } | null>(null);
  const updateTrackInfo = (next: { path: string; seconds: number } | null) => { trackInfoRef.current = next; setTrackInfo(next); };
  useEffect(() => {
    updateTrackInfo(null);
    const path = music?.file;
    if (!native || !path || score?.mix?.mode !== 'h3-reference') return;
    let alive = true;
    musicInfo(path).then(r => { if (alive) updateTrackInfo({ path, seconds: r.seconds }); }, () => undefined);
    return () => { alive = false; };
  }, [native, music?.file, score?.mix?.mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const track = referenceMode && music?.file && trackInfo?.path === music.file && trackInfo.seconds ? trackInfo : undefined;
  const musicModels = models ? modelsForFamilies(MUSIC_FAMILIES, models) : [];
  const [musicPath, setMusicPath] = useState('');
  const musicPathRef = useRef(''); musicPathRef.current = musicPath;
  const musicModel = musicModels.find(x => x.path === musicPath) ?? musicModels[0];
  const currentMusicModelPath = () => {
    const list = modelsRef.current ? modelsForFamilies(MUSIC_FAMILIES, modelsRef.current) : [];
    return (list.find(x => x.path === musicPathRef.current) ?? list[0])?.path ?? '';
  };
  // ACE-Step LoRAs of the chosen model's LoRA family (header-detected); YuE2 has no LoRA path.
  const musicLoraFamily = musicModel && !isRestrictedMusicFamily(musicModel.family) ? (builtinFamilies as { id: string; loraFamily?: string }[]).find(f => f.id === musicModel.family)?.loraFamily : undefined;
  const musicLoraModels = models && musicLoraFamily ? models.filter(x => x.category === 'loras' && x.family === musicLoraFamily) : [];
  const musicLoras = music?.loras ?? [];
  // Music texts: a preset is shown in the chosen model's dialect (ACE-Step tags or YuE2's Style line); tempo and language are ACE-Step's.
  const aceMusic = !isRestrictedMusicFamily(musicModel?.family);
  const musicStyleShown = styleFor(music?.text ?? '', music?.preset, musicModel?.family);
  const presetValue = (() => { const p = musicPreset(music?.preset); return p && [p.ace, p.yue2].includes((music?.text ?? '').trim()) ? p.id : ''; })();
  const makeMusic = (run: boolean): boolean => {
    if (isGenBusy() || !onPrepare || !musicModel) return false;
    const cur = movieRef.current;
    const r = musicHandoff(cur, { name: musicModel.name, path: musicModel.path, family: musicModel.family }, run, name => musicLoraModels.some(x => x.name === name), render.source === 'movie');
    if ('blocked' in r) { setError('detail' in r ? `${t(r.blocked)} ${r.detail}` : t(r.blocked)); return false; }
    const sub = captureMusicSubmission((handoff ?? 0) + 1, draftRef.current, cur, epochsRef.current, r.handoff.music?.seconds ?? musicSeconds(cur), run, musicModel.path);
    if (!sub) { setError(t('wizards.movie.staleSubmission')); logMovieNotice('submission-stale'); return false; }
    setError(''); setNote('');
    setPending(sub); setChainActive(false); setShotState(run ? { draft: sub.draft, id: 'music', state: 'queued' } : null);
    onPrepare(r.handoff);
    return true;
  };
  const generating = activePending?.kind === 'music' && activePending.run;
  const mixBlocked = !native ? t('wizards.movie.music.native') : musicPlan.ok ? '' : t(`wizards.movie.music.why.${musicPlan.why}`);
  const chooseMusic = async () => {
    const startDraft = draftRef.current;
    try { const path = await pickMusic(t('wizards.movie.music.pickTitle')); if (path && draftRef.current === startDraft) change(m => setMusicFile(m, path)); }
    catch (e) { if (draftRef.current === startDraft) setError(e instanceof Error ? e.message : String(e)); }
  };
  const mixIt = async () => {
    if (!musicPlan.ok || mixing || mixRef.current) return;
    const cur = movieRef.current;
    const submitted = captureMixSubmission(draftRef.current, cur, epochsRef.current);
    if (!submitted) { setError(t('wizards.movie.staleSubmission')); logMovieNotice('submission-stale'); return; }
    const mine = { submitted };
    mixRef.current = mine;
    setError(''); setNote(''); setMixing(true);
    try {
      const r = await mixMusic(musicPlan);
      if (mixRef.current !== mine || !canCompleteMix(draftRef.current, movieRef.current, epochsRef.current, mine.submitted)) {
        if (mixRef.current === mine && autoRunRef.current) { autoRunRef.current = false; setAutoRun(false); }
        return;
      }
      updateMovie(recordScore(movieRef.current, r), true);
      setNote(t('wizards.movie.music.done'));
    }
    catch (e) { if (mixRef.current === mine && draftRef.current === mine.submitted.draft) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (mixRef.current === mine) { mixRef.current = null; setMixing(false); } }
  };
  const musicSecs = musicSeconds(movie);
  // --- Make the movie: one step after the other until the film (and its music) is done; Stop ends admission of the next wizard stage.
  const [autoRun, setAutoRun] = useState(false);
  const autoRunRef = useRef(false);
  const [restitch, setRestitch] = useState(false);
  const lastStep = useRef('');
  const busy = making || !!joining || mixing;
  const isStageBusy = () => isGenBusy() || !!owned.current || !!mixRef.current;
  const caps = { musicModel: !!musicModel, canStitch: native && !!endpoint };
  const step = nextMovieStep(movie, caps);
  useEffect(() => {
    if (!autoRun || busy) return;
    const key = step.kind === 'scene' ? `scene:${step.id}:${movie.items.find(i => i.id === step.id)?.revision}` : step.kind;
    // The same step twice without progress means it could not start (the reason is on screen): stop instead of looping.
    if (key === lastStep.current && step.kind !== 'done') { autoRunRef.current = false; setAutoRun(false); return; }
    lastStep.current = key;
    const started = step.kind === 'scene' ? (step.chain ? makeChain(step.id, true, 'auto') : makeShot(step.id, true, 'auto'))
      : step.kind === 'film' ? (joinBlocked ? (setError(joinBlocked), false) : (void join(), true))
      : step.kind === 'music' ? makeMusic(true)
      : step.kind === 'mix' ? (musicPlan.ok ? (void mixIt(), true) : false)
      : null;
    if (started === false) { autoRunRef.current = false; setAutoRun(false); return; }
    if (started === null) {
      autoRunRef.current = false; setAutoRun(false);
      if (step.kind === 'done') setNote(t('wizards.movie.run.done')); else if (step.kind === 'blocked') setError(t(`wizards.movie.run.blocked.${step.why}`));
    }
  }, [autoRun, busy, step.kind, step.kind === 'scene' ? step.id : '', movie]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!restitch || autoRun || busy) return;
    setRestitch(false);
    if (native && endpoint && needsStitch(movie)) void join();
  }, [restitch, autoRun, busy, movie]); // eslint-disable-line react-hooks/exhaustive-deps
  const startRun = () => { setError(''); setNote(''); lastStep.current = ''; setRestitch(false); autoRunRef.current = true; setAutoRun(true); };
  const stopRun = () => { autoRunRef.current = false; setAutoRun(false); setRestitch(false); };
  const scoredClip = score?.state === 'done' ? score.revisions.find(r => r.n === score.revision)?.result?.outputId : undefined;
  const filmClip = final?.state === 'done' ? final.revisions.find(r => r.n === final.revision)?.result?.outputId : undefined;
  const why = (w: string) => t(`wizards.movie.film.why.${w}`);
  // The chain a shot belongs to: the first shot makes the whole chain; a continued shot is made together with it.
  const chainLen = (id: string) => { const f = chainOf(movie, id); return f && f.chain.ids[0] === id ? f.chain.ids.length : 1; };
  const continued = (id: string) => { const f = chainOf(movie, id); return !!f && f.chain.ids[0] !== id; };
  const shotBlock = (g: { id: string }, _n: number) => !h3Model ? t('wizards.movie.shot.noModel') : continued(g.id) ? t('wizards.movie.shot.withChain') : undefined;
  const change = (f: (m: MovieManifest) => MovieManifest) => {
    setError(''); setNote('');
    try { updateMovie(f(movieRef.current), true); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const resetDraftRunState = () => {
    draftRef.current += 1; setDraft(draftRef.current);
    autoRunRef.current = false; setAutoRun(false); setRestitch(false); lastStep.current = '';
    if (!isGenBusy()) setShotState(null);
    if (!owned.current) setMismatch(null);
    setPlanning(false); setWritingMusic(false); setDescribing(false);
    setAsk(null); setCheck(null); setMusicCheck(null); setMusicReplace(false); setRewriteMade(false);
    setRefused([]); setInputsOpen(''); setPanel(null);
  };
  const isSceneRunning = (id: string) =>
    making && currentShotState?.id === id && (currentShotState.state === 'queued' || currentShotState.state === 'running')
    && activePending?.kind === 'scene' && !!canApplySceneStep(draft, movie, epochsRef.current, activePending, id, activePending.chain ? activePending.shots.findIndex(x => x.id === id) : 0, sceneCtxFor(movie));
  const brief = movie.items.find(i => i.id === 'brief')!;
  // + adds after the open scene (else at the end); − removes the open scene.
  const scene = panel?.kind === 'scene' ? segments.find(i => i.id === panel.id) : undefined;
  const sceneIndex = scene ? segments.indexOf(scene) : segments.length - 1;
  // Pictures without a note are described by the chosen model through Media Analysis' describe path (only the text is kept);
  // a model on another machine only gets them after the same confirmation as the plan.
  const describeAll = async () => {
    if (!root || !llmModel || describing) return;
    const startDraft = draftRef.current;
    const todo = (movieRef.current.media ?? []).filter(x => x.media === 'image' && !x.note?.trim());
    if (!todo.length) return;
    try {
      const where = await plannerDestination(root, llmModel);
      if (draftRef.current !== startDraft) return;
      if (where.remote && !window.confirm(t('wizards.movie.media.remoteConfirm', { count: String(todo.length), host: where.host }))) return;
    } catch (e) { if (draftRef.current === startDraft) setError(e instanceof Error ? e.message : String(e)); return; }
    setDescribing(true); setError('');
    let failed = '';
    for (const x of todo) {
      if (draftRef.current !== startDraft) return;
      try { const text = await describeMediaPicture(root, llmModel.id, convertFileSrc(x.path), x.path.split(/[\\/]/).pop() ?? 'picture.png'); if (draftRef.current !== startDraft) return; if (text) updateMovie(setMediaNote(movieRef.current, x.path, text), true); }
      catch (e) { failed = e instanceof Error ? e.message : String(e); }
    }
    if (draftRef.current !== startDraft) return;
    setDescribing(false);
    if (failed) setError(t('wizards.movie.media.describeFailed', { error: failed }));
  };
  const newSceneSeconds = limits ? Math.min(limits.max, Math.max(limits.min, 5)) : 5;
  const save = async () => {
    setError(''); setNote('');
    const cur = movieRef.current, startDraft = draftRef.current;
    try { await saveMovie(cur.title.trim() ? cur : { ...cur, title: t('wizards.movie.untitled') }); if (draftRef.current === startDraft) { latest.current = { movie: movieRef.current, dirty: false }; setDirty(false); setNote(t('wizards.movie.saved')); } await refresh(); }
    catch (e) { if (draftRef.current === startDraft) setError(e instanceof Error ? e.message : String(e)); }
  };
  const open = async (id: string) => {
    if (isStageBusy()) return;
    if (dirty && !window.confirm(t('wizards.movie.discard'))) return;
    const req = ++openSeq.current;
    setError(''); setNote('');
    setGone(null);
    try {
      const loaded = await openMovie(id);
      if (req !== openSeq.current || isStageBusy()) return;
      resetDraftRunState();
      const openedDraft = draftRef.current;
      updateMovie(loaded, false, true); setNote(t('wizards.movie.opened'));
      // Read-only look at which recorded clips and reference pictures are gone; failing to look never blocks opening.
      void checkMovie(id).then(c => { if (draftRef.current === openedDraft) setGone(c.missing.length || c.truncated ? c : null); }, () => { if (draftRef.current === openedDraft) setError(t('wizards.movie.check.failed')); });
    } catch (e) { if (req === openSeq.current) setError(e instanceof Error ? e.message : String(e)); }
  };
  const fresh = () => { if (isStageBusy()) return; if (dirty && !window.confirm(t('wizards.movie.discard'))) return; openSeq.current += 1; resetDraftRunState(); updateMovie(newMovie(newMovieId(), ''), false, true); setGone(null); setError(''); setNote(''); forgetPref(DRAFT_KEY); };
  // Steps in the order a movie is made; each step says when it is done, so the next thing to do is visible.
  const steps = [
    { n: 1, key: 'idea', done: !!brief.text.trim() || !!movie.media?.length },
    { n: 2, key: 'plan', done: !!story || segments.some(g => g.text.trim()) },
    { n: 3, key: 'scenes', done: !!segments.length && segments.every(g => g.state === 'done') },
    { n: 4, key: 'film', done: final?.state === 'done' },
  ];
  // The one thing to do next: the first step that is not done.
  const nextKey = steps.find(s => !s.done)?.key;
  const panelScene = panel?.kind === 'scene' ? segments.find(i => i.id === panel.id) : undefined;
  const panelMedia = panel?.kind === 'media' ? movie.media?.find(x => x.path === panel.path) : undefined;
  const poolScenes = segments.map((g, n) => ({ id: g.id, name: g.title.trim() || t('wizards.movie.scene.untitled', { n: String(n + 1) }) }));
  const assign = (path: string, scenes: string[], role: MediaRole, label?: string) => {
    setError('');
    try { const r = assignMedia(movieRef.current, path, scenes, role, label); updateMovie(r.movie, true); setRefused(r.refused); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <div className="forge-card wizards-form movie-maker" data-wizard-form="movie">
    <div className="forge-card-head movie-head">
      <h3 className="forge-card-title">{t('wizards.movie.name')}</h3>
      <div className="movie-button-group" role="group" aria-label={t('wizards.movie.file')}>
        <button type="button" className="forge-ghost" data-movie-new disabled={busy} onClick={fresh}>{t('wizards.movie.new')}</button>
        <button type="button" className="action-button" data-movie-save disabled={!native || !dirty} onClick={() => void save()}>{t('wizards.movie.save')}</button>
      </div>
      {dirty && <span className="forge-note" data-movie-dirty>{t('wizards.movie.unsaved')}</span>}
    </div>
    <ol className="movie-steps" data-movie-steps>{steps.map(s => <li key={s.key} className={s.done ? 'is-done' : s.key === nextKey ? 'is-next' : ''} data-movie-step={s.key} aria-current={s.key === nextKey ? 'step' : undefined}><span className="movie-step-n">{s.done ? '✓' : s.n}</span>{t(`wizards.movie.steps.${s.key}`)}</li>)}</ol>
    <p className="forge-note movie-next" data-movie-next>{t(`wizards.movie.next.${nextKey ?? 'done'}`)}</p>
    <details className="movie-help" data-movie-help>
      <summary className="forge-note">{t('wizards.movie.help.title')}</summary>
      <ol className="forge-note"><li>{t('wizards.movie.help.one')}</li><li>{t('wizards.movie.help.two')}</li><li>{t('wizards.movie.help.three')}</li></ol>
    </details>
    <section className="wizards-step movie-section" data-movie-section="idea">
      <h4 className="movie-section-title"><span className="movie-step-n">{steps[0].n}</span> {t('wizards.movie.steps.idea')}</h4>
      <p className="forge-note" data-movie-notice>{t('wizards.movie.ideaHint')}</p>
      <div className="wizards-fields movie-idea-head">
        <label className="forge-field"><span>{t('wizards.movie.movieTitle')}</span>
          <input type="text" data-movie-title value={movie.title} maxLength={120} onChange={e => change(m => setBrief(m, { title: e.target.value }))}/></label>
        <label className="forge-field"><span>{t('wizards.movie.aspect')}</span>
          <AspectPicker data-movie-aspect value={movie.aspect} omit={['custom']} onChange={a => change(m => setBrief(m, { aspect: a }))}/></label>
        <label className="forge-field"><span>{t('wizards.movie.render.source')}</span>
          <select data-movie-render-source value={render.source} title={t('wizards.movie.render.sourceHint')} onChange={e => change(m => setRender(m, { source: e.target.value as 'movie' | 'generate' }))}>
            <option value="movie">{t('wizards.movie.render.movie')}</option><option value="generate">{t('wizards.movie.render.generate')}</option>
          </select></label>
        {render.source === 'movie' && <>
          <label className="forge-field"><span>{t('studio.run.resolution.title')}</span>
            <select data-movie-render-resolution value={render.resolution} onChange={e => change(m => setRender(m, { resolution: e.target.value }))}>
              {MOVIE_RESOLUTIONS.map(r => <option key={r} value={r}>{r === 'model' ? t('studio.run.resolution.model') : r}</option>)}
            </select></label>
          <label className="forge-field movie-num"><span>{t('studio.run.steps')}</span>
            <input type="number" data-movie-render-steps min={SAMPLING_LIMITS.steps[0]} max={SAMPLING_LIMITS.steps[1]} step={1} value={movieSampling?.steps ?? ''}
              onChange={e => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v)) change(m => setRender(m, { steps: v })); }}/></label>
          <label className="forge-field movie-num"><span>{t('studio.run.cfg')}</span>
            <input type="number" data-movie-render-cfg min={SAMPLING_LIMITS.cfg[0]} max={SAMPLING_LIMITS.cfg[1]} step={0.1} value={movieSampling?.cfg ?? ''}
              onChange={e => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v)) change(m => setRender(m, { cfg: v })); }}/></label>
          {(render.steps !== undefined || render.cfg !== undefined) && <button type="button" className="forge-ghost movie-render-reset" data-movie-render-reset title={t('wizards.movie.render.resetHint')} aria-label={t('wizards.movie.render.resetHint')}
            onClick={() => change(m => setRender(m, { steps: undefined, cfg: undefined }))}>{t('wizards.movie.render.reset')}</button>}
        </>}
      </div>
      <p className="forge-note" data-movie-render-note>{render.source === 'generate' ? t('wizards.movie.render.generateNote')
        : t('wizards.movie.render.movieNote', {
          size: movie.aspect === 'auto' ? t('wizards.movie.render.autoSize') : fixedSize ? `${fixedSize.width}×${fixedSize.height}` : '—',
          steps: String(movieSampling?.steps ?? '—'), cfg: String(movieSampling?.cfg ?? '—'), sampler: `${movieSampling?.sampler ?? '—'} / ${movieSampling?.scheduler ?? '—'}`,
          model: h3Model?.name ?? t('wizards.movie.render.noModel'),
        }) + (render.source === 'movie' && render.steps === undefined && render.cfg === undefined ? ` ${t(variant ? 'wizards.movie.render.variantStart' : 'wizards.movie.render.familyStart', { variant: variant?.id ?? '' })}` : '')}</p>
      {movie.aspect === 'auto' && <p className="forge-note" data-movie-aspect-auto>{t('wizards.movie.aspectAuto')}</p>}
      <label className="forge-field"><span>{t('wizards.movie.story')}</span>
        <textarea data-movie-story rows={4} maxLength={20000} value={brief.text} placeholder={t('wizards.movie.storyPlaceholder')} onChange={e => change(m => editItem(m, 'brief', e.target.value))}/></label>
      <MovieMediaPool media={movie.media ?? []} scenes={poolScenes} usedIn={path => scenesUsing(movie, path)} roleOf={path => roleOf(movie, path)} roots={mediaRoots} toSrc={convertFileSrc} describing={describing}
        open={panel?.kind === 'media' ? panel.path : undefined} onOpen={path => { setRefused([]); setPanel({ kind: 'media', path }); }}
        onAdd={items => change(m => addMedia(m, items))} onRemove={path => { change(m => dropMedia(m, path)); if (panel?.kind === 'media' && panel.path === path) setPanel(null); }}
        onDropOnScene={(path, id) => { const x = movie.media?.find(y => y.path === path); if (x) assign(path, [...new Set([...scenesUsing(movie, path), id])], roleOf(movie, path), x.label); }}
        onDescribe={native && root && llmModel ? describeAll : null}/>
      <div className="movie-music-brief" data-movie-music-brief>
        <h5 className="movie-subtitle">{t('wizards.movie.music.title')}</h5>
        <p className="forge-note">{t('wizards.movie.music.briefHint')}</p>
        <div className="wizards-fields movie-music-row">
          <label className="forge-field"><span>{t('wizards.movie.music.preset')}</span>
            <select data-movie-music-preset value={presetValue} onChange={e => { const p = musicPreset(e.target.value); change(m => p ? setMusicFields(setMusicPrompt(m, p[presetDialect(musicModel?.family)]), { preset: p.id, bpm: p.bpm }) : setMusicFields(m, { preset: undefined })); }}>
              <option value="">{t('wizards.movie.music.presetOwn')}</option>
              {MUSIC_PRESETS.map(p => <option key={p.id} value={p.id}>{presetName(p, locale)}</option>)}
            </select></label>
          {aceMusic && <label className="forge-field movie-num"><span>{t('wizards.movie.music.bpm')}</span>
            <input type="number" data-movie-music-bpm min={MUSIC_BPM[0]} max={MUSIC_BPM[1]} step={1} value={music?.bpm ?? ''} placeholder={t('wizards.movie.music.bpmAuto')} title={t('wizards.movie.music.bpmHint')}
              onChange={e => { const v = Number(e.target.value); change(m => setMusicFields(m, { bpm: e.target.value === '' || !Number.isFinite(v) ? undefined : v })); }}/></label>}
          {aceMusic && (!!music?.lyrics?.trim() || !!music?.vocals) && <label className="forge-field"><span>{t('wizards.movie.music.language')}</span>
            <select data-movie-music-language value={music?.language ?? 'en'} onChange={e => change(m => setMusicFields(m, { language: e.target.value }))}>
              {aceLanguages.filter(l => l !== 'unknown').map(l => <option key={l} value={l}>{languageLabel(l, locale)}</option>)}
            </select></label>}
        </div>
        <div className="movie-music-texts">
          <label className="forge-field"><span>{t('wizards.movie.music.prompt')}</span>
            <textarea data-movie-music-prompt rows={3} maxLength={2000} value={musicStyleShown} placeholder={t('wizards.movie.music.promptPlaceholder')} onChange={e => change(m => setMusicPrompt(m, e.target.value))}/></label>
          <label className="forge-field"><span>{t('wizards.movie.music.lyrics')}</span>
            <textarea data-movie-music-lyrics rows={3} maxLength={4000} value={music?.lyrics ?? ''} placeholder={t('wizards.movie.music.lyricsPlaceholder')} onChange={e => change(m => setMusicFields(m, { lyrics: e.target.value }))}/></label>
        </div>
        <div className="wizards-row movie-button-group">
          <label className="forge-note movie-check"><input type="checkbox" data-movie-music-vocals checked={!!music?.vocals} onChange={e => change(m => setMusicFields(m, { vocals: e.target.checked }))}/> {t('wizards.movie.music.vocals')}</label>
          <button type="button" className="forge-ghost" data-movie-music-write disabled={!!musicWriteBlocked || writingMusic || planning} title={musicWriteBlocked || t('wizards.movie.music.writeHint')} onClick={() => void begin('music')}>{t(writingMusic ? 'wizards.movie.plan.busy' : 'wizards.movie.music.write')}</button>
        </div>
        {musicCheck && !musicCheck.music && <div className="wizards-step" data-movie-music-invalid>
          <p className="error-message" role="alert">{t('wizards.movie.plan.invalid')}</p>
          <ul>{musicCheck.errors.slice(0, 6).map((e, n) => <li key={n} className="forge-note">{e}</li>)}</ul>
        </div>}
        {musicCheck?.music && (() => { const mu = musicCheck.music, d = musicDiff(movie, mu, musicReplace); return <div className="wizards-step movie-plan-music" data-movie-music-proposal>
          <strong>{t('wizards.movie.music.proposal')}</strong>
          {mu.music && <p className="forge-note">{t(`wizards.movie.plan.musicField.${d.style}`, { field: t('wizards.movie.music.prompt'), value: mu.music })}</p>}
          {mu.musicBpm && <p className="forge-note">{t(`wizards.movie.plan.musicField.${d.bpm}`, { field: t('wizards.movie.music.bpm'), value: String(mu.musicBpm) })}</p>}
          {mu.musicLyrics && <><p className="forge-note">{t(`wizards.movie.plan.musicField.${d.lyrics}`, { field: t('wizards.movie.music.lyrics'), value: t('wizards.movie.plan.lyricsBelow') })}</p><pre className="movie-plan-lyrics">{mu.musicLyrics}</pre></>}
          {musicCheck.warnings.map((w, n) => <p key={n} className="forge-note">{w}</p>)}
          <label className="forge-note movie-check"><input type="checkbox" data-movie-music-replace checked={musicReplace} onChange={e => setMusicReplace(e.target.checked)}/> {t('wizards.movie.music.replace')}</label>
          <div className="wizards-row movie-button-group">
            <button type="button" className="action-button" data-movie-music-apply onClick={() => { change(m => applyMusic(m, mu, musicReplace)); setMusicCheck(null); setMusicReplace(false); }}>{t('wizards.movie.plan.apply')}</button>
            <button type="button" className="forge-ghost" data-movie-music-discard onClick={() => { setMusicCheck(null); setMusicReplace(false); }}>{t('wizards.movie.plan.discard')}</button>
          </div>
        </div>; })()}
      </div>
    </section>
    <section className="wizards-step movie-section" data-movie-section="plan">
      <h4 className="movie-section-title"><span className="movie-step-n">{steps[1].n}</span> {t('wizards.movie.steps.plan')}</h4>
    <div data-movie-plan>
      <span className="forge-note">{t('wizards.movie.plan.title')}</span>
      <p className="forge-note">{t('wizards.movie.plan.intro')}</p>
      {limits && <p className="forge-note" data-movie-limits>{t('wizards.movie.plan.limits', { min: String(limits.min), max: String(limits.max), step: String(limits.step ?? 0.1) })}{limits.unverified ? ` ${t('wizards.movie.plan.unverified')}` : ''}</p>}
      {llm && !llm.length && <p className="forge-note" data-movie-no-model>{t('wizards.movie.plan.noModel')}</p>}
      {!!llm?.length && <label className="forge-field"><span>{t('wizards.movie.plan.model')}</span>
        <select data-movie-llm value={llmKey} onChange={e => { setLlmKey(e.target.value); setAsk(null); }}>
          {llm.map(m => <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>{m.provider === 'local' ? m.name : `${m.name} (${m.provider})`}</option>)}
        </select></label>}
      <div className="wizards-row movie-button-group">
        <button type="button" className="action-button" data-movie-plan-run disabled={!!planBlocked || planning} title={planBlocked || undefined} onClick={() => void begin('suggest')}>{t(planning && planMode === 'suggest' ? 'wizards.movie.plan.busy' : 'wizards.movie.plan.run')}</button>
        <button type="button" className="forge-ghost" data-movie-plan-write disabled={!!planBlocked || planning || !segments.length} title={planBlocked || (!segments.length ? t('wizards.movie.plan.writeNeedsScenes') : undefined)} onClick={() => void begin('write')}>{t(planning && planMode === 'write' ? 'wizards.movie.plan.busy' : 'wizards.movie.plan.write')}</button>
        {planBlocked && <span className="forge-note" data-movie-plan-blocked>{planBlocked}</span>}
      </div>
      {ask && <div className="wizards-step" role="alertdialog" aria-label={t('wizards.movie.plan.remoteTitle')} data-movie-remote>
        <strong>{t('wizards.movie.plan.remoteTitle')}</strong>
        <p className="forge-note">{t('wizards.movie.plan.remoteBody', { chars: String(ask.chars), scenes: String(ask.scenes), host: ask.host })}</p>
        <div className="wizards-row movie-button-group">
          <button type="button" className="action-button" data-movie-remote-send onClick={() => { logMovieNotice('plan-remote'); void run(ask.mode); }}>{t('wizards.movie.plan.remoteSend')}</button>
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
        {segments.some(g => g.state === 'done') && <label className="forge-note"><input type="checkbox" data-movie-plan-rewrite checked={rewriteMade} onChange={e => setRewriteMade(e.target.checked)}/> {t('wizards.movie.plan.rewriteMade')}</label>}
        {!!diff.staleAfter.length && <p className="forge-note" data-movie-plan-stale>{t('wizards.movie.plan.stale', { count: String(diff.staleAfter.length) })}</p>}
        <MoviePlanPreview movie={movie} plan={check.plan} options={{ rewriteMade }}/>
        {check.warnings.map((w, n) => <p key={n} className="forge-note" data-movie-plan-warning>{w}</p>)}
        <div className="wizards-row movie-button-group">
          <button type="button" className="action-button" data-movie-plan-apply onClick={() => { const plan = check.plan!; change(m => applyPlan(m, plan, { rewriteMade })); logMovieNotice('plan-applied'); setCheck(null); setRewriteMade(false); setNote(t('wizards.movie.plan.applied')); }}>{t('wizards.movie.plan.apply')}</button>
          <button type="button" className="forge-ghost" data-movie-plan-discard onClick={() => setCheck(null)}>{t('wizards.movie.plan.discard')}</button>
        </div>
      </div>}
    </div>
      {story && <details className="movie-lore" data-movie-story-stage>
        <summary className="forge-note">{t('wizards.movie.plan.lore')}</summary>
        <textarea aria-label={t('wizards.movie.plan.lore')} data-movie-lore rows={4} maxLength={20000} disabled={!!story.locked} value={story.text} onChange={e => change(m => editItem(m, story.id, e.target.value))}/>
      </details>}
    </section>
    <section className="wizards-step movie-section" data-movie-scenes>
      <div className="wizards-step-head">
        <h4 className="movie-section-title"><span className="movie-step-n">{steps[2].n}</span> {t('wizards.movie.steps.scenes')}</h4>
        <span className="forge-note" data-movie-length>{t('wizards.movie.scenesLength', { seconds: String(scenesSeconds(movie)), actual: String(Math.round(segments.reduce((a, g, n) => a + h3ActualSeconds(g.seconds ?? 0, !!g.continuous && n > 0), 0) * 100) / 100) })}</span>
      </div>
      <p className="forge-note">{t('wizards.movie.scenesHint')}</p>
      {!!segments.length && !h3Model && <p className="forge-note" data-movie-shot-nomodel>{t('wizards.movie.shot.noModel')}</p>}
      {!!segments.length && h3Models.length > 1 && <label className="forge-field"><span>{t('wizards.movie.shot.model')}</span>
        <select data-movie-shot-model value={h3Model?.name ?? ''} onChange={e => change(m => setRender(m, { model: e.target.value, steps: undefined, cfg: undefined }))}>{h3Models.map(m => <option key={m.path} value={m.name}>{m.name}</option>)}</select></label>}
      <MovieTimeline scenes={segments} music={music} film={final} open={panel} onOpen={setPanel} toSrc={convertFileSrc}
        running={isSceneRunning}
        onRename={(id, title) => change(m => setItemTitle(m, id, title))}
        onTransition={(id, kind, seconds) => { change(m => setTransition(m, id, kind, seconds)); if (!autoRunRef.current && !(sent.current?.kind === 'scene' && sent.current.origin === 'auto' && sent.current.draft === draftRef.current)) setRestitch(true); }}
        onAdd={() => { const next = addScene(movie, newSceneSeconds, scene?.id); change(() => next); const id = next.items.filter(i => i.kind === 'segment')[sceneIndex + 1]?.id; if (id) setPanel({ kind: 'scene', id }); }}
        onRemove={id => {
          // A made scene holds a finished clip: ask first (the file itself stays where it is). The open panel moves to a neighbour.
          if (segments.length <= 1 && (!!joining || mixing)) return;
          const at = segments.findIndex(g => g.id === id), g = segments[at];
          if (!g || (g.state === 'done' && !window.confirm(t('wizards.movie.scene.removeMade', { name: g.title.trim() || t('wizards.movie.scene.untitled', { n: String(at + 1) }) })))) return;
          change(m => removeScene(m, id));
          if (panel?.kind === 'scene' && panel.id === id) { const next = segments[at + 1]?.id ?? segments[at - 1]?.id; setPanel(next ? { kind: 'scene', id: next } : null); }
        }}/>
    </section>
    <section className="wizards-step movie-section" data-movie-section="make">
      <h4 className="movie-section-title"><span className="movie-step-n">{steps[3].n}</span> {t('wizards.movie.steps.film')}</h4>
      <p className="forge-note">{t('wizards.movie.run.hint')}</p>
      <div className="wizards-row movie-button-group">
        <button type="button" className="action-button" data-movie-run disabled={!native || !onPrepare || !h3Model || autoRun || busy || !segments.length} title={!h3Model ? t('wizards.movie.shot.noModel') : undefined} onClick={startRun}>{t(autoRun ? 'wizards.movie.run.running' : step.kind === 'done' ? 'wizards.movie.run.again' : 'wizards.movie.run.start')}</button>
        {autoRun && <button type="button" className="forge-ghost" data-movie-run-stop onClick={stopRun}>{t('wizards.movie.run.stop')}</button>}
      </div>
      {autoRun && <p className="forge-note" role="status" data-movie-run-step>{t(`wizards.movie.run.step.${step.kind}`, { name: step.kind === 'scene' ? (movie.items.find(i => i.id === step.id)?.title || t('wizards.movie.scene.untitled', { n: String(segments.findIndex(i => i.id === step.id) + 1) })) : '' })}</p>}
    </section>
    {panelScene && (() => { const g = panelScene, n = segments.indexOf(g); return <MoviePanel kind="scene" title={g.title.trim() || t('wizards.movie.scene.untitled', { n: String(n + 1) })} onClose={() => setPanel(null)}>
      <div className="wizards-step movie-scene-editor" key={g.id} data-movie-segment={g.id}>
          <div className="wizards-row">
                        <label className="forge-note">{t('wizards.movie.plan.segSeconds')} <input type="number" data-movie-seg-seconds min={limits?.min ?? 1} max={limits?.max ?? 15} step={limits?.step ?? 0.5} value={g.seconds ?? 0} disabled={!!g.locked}
              onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) change(m => setSceneSeconds(m, g.id, v)); }}/></label>
          </div>
          <textarea aria-label={t('wizards.movie.plan.segPrompt')} data-movie-seg-prompt rows={3} maxLength={4000} disabled={!!g.locked} value={g.text} placeholder={t('wizards.movie.scene.promptPlaceholder')} onChange={e => change(m => editItem(m, g.id, e.target.value))}/>
          <div className="wizards-row" data-movie-scene-inputs={g.id}>
            <SceneInputMarks inputs={g.inputs} toSrc={convertFileSrc}/>
            <button type="button" className="forge-ghost" data-movie-scene-inputs-open disabled={!!g.locked} onClick={() => setInputsOpen(g.id)}>{t('wizards.movie.scene.inputs')}</button>
          </div>
          <details data-movie-shot-settings={g.id}>
            <summary className="forge-note">{t('wizards.movie.shot.settings', { count: String(g.loras?.length ?? 0) })}</summary>
            {continued(g.id) ? <p className="forge-note" data-movie-shot-inherits>{t('wizards.movie.shot.inherits')}</p> : <>
              <label className="forge-field"><span>{t('wizards.movie.shot.ownModel')}</span>
                <select data-movie-shot-own-model value={g.model ?? ''} disabled={!!g.locked} onChange={e => change(m => setShotModel(m, g.id, e.target.value || null))}>
                  <option value="">{t('wizards.movie.shot.defaultModel', { name: h3Model?.name ?? '—' })}</option>
                  {g.model && !h3Models.some(x => x.name === g.model) && <option value={g.model}>{g.model}</option>}
                  {h3Models.map(x => <option key={x.path} value={x.name}>{x.name}</option>)}
                </select></label>
              {render.source === 'movie' && (() => { const eff = startFor(g); return <div className="wizards-row" data-movie-shot-sampling={g.id}>
                <label className="forge-note">{t('studio.run.steps')} <input type="number" data-movie-shot-steps min={SAMPLING_LIMITS.steps[0]} max={SAMPLING_LIMITS.steps[1]} step={1} value={g.sampling?.steps ?? ''} placeholder={String(eff?.steps ?? '')} disabled={!!g.locked}
                  onChange={e => { const v = Number(e.target.value); change(m => setShotSampling(m, g.id, { ...g.sampling, steps: e.target.value === '' || !Number.isFinite(v) ? undefined : v })); }}/></label>
                <label className="forge-note">{t('studio.run.cfg')} <input type="number" data-movie-shot-cfg min={SAMPLING_LIMITS.cfg[0]} max={SAMPLING_LIMITS.cfg[1]} step={0.1} value={g.sampling?.cfg ?? ''} placeholder={String(eff?.cfg ?? '')} disabled={!!g.locked}
                  onChange={e => { const v = Number(e.target.value); change(m => setShotSampling(m, g.id, { ...g.sampling, cfg: e.target.value === '' || !Number.isFinite(v) ? undefined : v })); }}/></label>
                <span className="forge-note" data-movie-shot-sampling-note>{t('wizards.movie.shot.samplingNote', { steps: String(eff?.steps ?? '—'), cfg: String(eff?.cfg ?? '—') })}</span>
              </div>; })()}
              {(g.loras ?? []).map(l => <div className="wizards-row" key={l.name} data-movie-lora={l.name}>
                <select aria-label={t('wizards.movie.shot.loraName')} data-movie-lora-name value={l.name} disabled={!!g.locked}
                  onChange={e => change(m => setShotLoras(m, g.id, (g.loras ?? []).map(x => x.name === l.name ? { ...x, name: e.target.value } : x)))}>
                  <option value={l.name}>{l.name}{h3Loras.some(x => x.name === l.name) ? '' : ` — ${t('wizards.movie.shot.loraGone')}`}</option>
                  {h3Loras.filter(x => x.name !== l.name && !(g.loras ?? []).some(y => y.name === x.name)).map(x => <option key={x.path} value={x.name}>{x.name}</option>)}
                </select>
                <input type="number" aria-label={t('wizards.movie.shot.loraStrength', { name: l.name })} data-movie-lora-strength min={LORA_STRENGTH[0]} max={LORA_STRENGTH[1]} step={0.05} value={l.strength} disabled={!!g.locked}
                  onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) change(m => setShotLoras(m, g.id, (g.loras ?? []).map(x => x.name === l.name ? { ...x, strength: v } : x))); }}/>
                <button type="button" className="forge-ghost" data-movie-lora-remove disabled={!!g.locked} aria-label={t('wizards.movie.shot.loraRemove', { name: l.name })} onClick={() => change(m => setShotLoras(m, g.id, (g.loras ?? []).filter(x => x.name !== l.name)))}>{t('wizards.movie.castRemove')}</button>
              </div>)}
              {(() => { const free = h3Loras.find(x => !(g.loras ?? []).some(l => l.name === x.name)); return <button type="button" className="forge-ghost" data-movie-lora-add disabled={!!g.locked || !free || (g.loras?.length ?? 0) >= 8} title={h3Loras.length ? undefined : t('wizards.movie.shot.noLora')}
                onClick={() => free && change(m => setShotLoras(m, g.id, [...(g.loras ?? []), { name: free.name, strength: 1 }]))}>{t('wizards.movie.shot.loraAdd')}</button>; })()}
            </>}
          </details>
          <div className="wizards-row movie-button-group" data-movie-shot={g.id}>
            <span className="forge-note" data-movie-shot-state>{t(`wizards.movie.shot.state.${isSceneRunning(g.id) ? 'running' : g.state}`)}</span>
            <button type="button" className="forge-ghost" data-movie-shot-prepare disabled={!native || !onPrepare || !h3Model || making || continued(g.id)} title={shotBlock(g, n)} onClick={() => chainLen(g.id) > 1 ? makeChain(g.id, false) : makeShot(g.id, false)}>{t(chainLen(g.id) > 1 ? 'wizards.movie.shot.prepareChain' : 'wizards.movie.shot.prepare')}</button>
            <button type="button" className="action-button" data-movie-shot-make disabled={!native || !onPrepare || !h3Model || making || continued(g.id)} title={shotBlock(g, n)} onClick={() => chainLen(g.id) > 1 ? makeChain(g.id, true) : makeShot(g.id, true)}>{chainLen(g.id) > 1 ? t(g.state === 'done' ? 'wizards.movie.shot.chainAgain' : 'wizards.movie.shot.makeChain', { count: String(chainLen(g.id)) }) : t(g.state === 'done' ? 'wizards.movie.shot.again' : 'wizards.movie.shot.make')}</button>
          </div>
          {currentShotState?.id === g.id && currentShotState.error && <p className="error-message" role="alert" data-movie-shot-error>{currentShotState.error}</p>}
          {g.state === 'done' && (() => { const out = g.revisions.find(r => r.n === g.revision)?.result?.outputId; return out && /\.(mp4|webm|mkv|mov)$/i.test(out) ? <MoviePlayer path={out} media="video" toSrc={convertFileSrc} data-movie-shot-video/> : null; })()}
          <p className="forge-note" data-movie-seg-actual>{t('wizards.movie.plan.actual', { seconds: (Math.round(h3ActualSeconds(g.seconds ?? 0, !!g.continuous) * 100) / 100).toString() })}</p>
          {(g.dialogue ?? []).map((d, k) => <p key={k} className="forge-note" data-movie-seg-line>{t('wizards.movie.plan.line', { name: d.speaker, line: d.line })}</p>)}
      </div>
    </MoviePanel>; })()}
    {panelMedia && <MoviePanel kind="media" title={panelMedia.path.split(/[\\/]/).pop() ?? panelMedia.path} onClose={() => setPanel(null)}>
      <MovieMediaSettings item={panelMedia} scenes={poolScenes} used={scenesUsing(movie, panelMedia.path)} current={roleOf(movie, panelMedia.path)} refused={refused} toSrc={convertFileSrc}
        onNote={note => change(m => setMediaNote(m, panelMedia.path, note))} onAssign={(scenes, role, label) => assign(panelMedia.path, scenes, role, label)}/>
    </MoviePanel>}
    {panel?.kind === 'music' && final && <MoviePanel kind="music" title={t('wizards.movie.music.title')} onClose={() => setPanel(null)}>
      <div className="wizards-step" data-movie-music>
      <span className="forge-note">{t('wizards.movie.music.title')}</span>
      <p className="forge-note">{t('wizards.movie.music.intro')}</p>
      <p className="forge-note" data-movie-music-summary>{musicStyleShown.trim() ? t('wizards.movie.music.summary', { style: musicStyleShown.trim(), kind: t(music?.lyrics?.trim() ? 'wizards.movie.music.withLyrics' : 'wizards.movie.music.instrumental') }) : t('wizards.movie.music.needPrompt')}</p>
      {musicModels.length > 1 && <label className="forge-field"><span>{t('wizards.movie.music.model')}</span>
        <select data-movie-music-model value={musicModel?.path ?? ''} onChange={e => setMusicPath(e.target.value)}>{musicModels.map(x => <option key={x.path} value={x.path}>{x.name}</option>)}</select></label>}
      {isRestrictedMusicFamily(musicModel?.family) && <p className="forge-note" data-movie-music-licence>{t('wizards.movie.music.licence')}</p>}
      {musicModel && (musicLoraFamily || musicLoras.length > 0) && <details data-movie-music-loras>
        <summary className="forge-note">{t('wizards.movie.music.loras')} ({musicLoras.length})</summary>
        {musicLoras.map(l => <div className="wizards-row" key={l.name} data-movie-music-lora={l.name}>
          <select aria-label={t('wizards.movie.shot.loraName')} data-movie-music-lora-name value={l.name}
            onChange={e => change(m => setMusicLoras(m, musicLoras.map(x => x.name === l.name ? { ...x, name: e.target.value } : x)))}>
            <option value={l.name}>{l.name}{musicLoraModels.some(x => x.name === l.name) ? '' : ` — ${t('wizards.movie.shot.loraGone')}`}</option>
            {musicLoraModels.filter(x => x.name !== l.name && !musicLoras.some(y => y.name === x.name)).map(x => <option key={x.path} value={x.name}>{x.name}</option>)}
          </select>
          <input type="number" aria-label={t('wizards.movie.shot.loraStrength', { name: l.name })} data-movie-music-lora-strength min={LORA_STRENGTH[0]} max={LORA_STRENGTH[1]} step={0.05} value={l.strength}
            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) change(m => setMusicLoras(m, musicLoras.map(x => x.name === l.name ? { ...x, strength: v } : x))); }}/>
          <button type="button" className="forge-ghost" data-movie-music-lora-remove aria-label={t('wizards.movie.shot.loraRemove', { name: l.name })} onClick={() => change(m => setMusicLoras(m, musicLoras.filter(x => x.name !== l.name)))}>{t('wizards.movie.castRemove')}</button>
        </div>)}
        {(() => { const free = musicLoraModels.find(x => !musicLoras.some(l => l.name === x.name)); return <button type="button" className="forge-ghost" data-movie-music-lora-add disabled={!free || musicLoras.length >= 8} title={musicLoraModels.length ? undefined : t('wizards.movie.music.noLora')}
          onClick={() => free && change(m => setMusicLoras(m, [...musicLoras, { name: free.name, strength: 1 }]))}>{t('wizards.movie.shot.loraAdd')}</button>; })()}
        {!musicLoraModels.length && <p className="forge-note" data-movie-music-nolora>{t('wizards.movie.music.noLora')}</p>}
      </details>}
      <div className="wizards-row movie-button-group">
        <button type="button" className="forge-ghost" data-movie-music-prepare disabled={!native || !onPrepare || !musicModel || making} onClick={() => makeMusic(false)}>{t('wizards.movie.music.prepare')}</button>
        <button type="button" className="action-button" data-movie-music-generate disabled={!native || !onPrepare || !musicModel || making} title={musicModel ? undefined : t('wizards.movie.music.noModel')} onClick={() => makeMusic(true)}>{t(generating ? 'wizards.movie.music.generating' : 'wizards.movie.music.generate', { seconds: String(musicSecs) })}</button>
        {!musicModel && <span className="forge-note" data-movie-music-nomodel>{t('wizards.movie.music.noModel')}</span>}
      </div>
      {currentShotState?.id === 'music' && currentShotState.error && <p className="error-message" role="alert" data-movie-music-error>{currentShotState.error}</p>}
      <div className="wizards-row movie-button-group">
        <button type="button" className="forge-ghost" data-movie-music-pick disabled={!native} onClick={() => void chooseMusic()}>{t(music?.file ? 'wizards.movie.music.change' : 'wizards.movie.music.pick')}</button>
        {music?.file && <span className="forge-note wizards-name" title={music.file} data-movie-music-file>{fileName(music.file)}</span>}
        {music?.file && <button type="button" className="forge-ghost" data-movie-music-clear onClick={() => change(m => setMusicFile(m, null))}>{t('wizards.movie.music.clear')}</button>}
      </div>
      {score?.mix?.mode === 'mix' && <div className="wizards-fields">
        {([['levelDb', 'level'], ['duckDb', 'duck'], ['fadeSeconds', 'fade']] as const).map(([key, label]) => <label className="forge-field" key={key}><span>{t(`wizards.movie.music.${label}`)}</span>
          <input type="number" data-movie-mix={key} min={MIX_LIMITS[key][0]} max={MIX_LIMITS[key][1]} step={key === 'fadeSeconds' ? 0.5 : 1} value={score.mix![key]}
            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) change(m => setMix(m, { [key]: v })); }}/></label>)}
      </div>}
      {score?.mix && <label className="forge-field"><span>{t('wizards.movie.music.mode')}</span>
        <select data-movie-mix-mode value={score.mix.mode} onChange={e => change(m => setMix(m, { mode: e.target.value as 'mix' | 'h3-reference' }))}>
          <option value="mix">{t('wizards.movie.music.modeMix')}</option><option value="h3-reference">{t('wizards.movie.music.modeH3')}</option>
        </select></label>}
      {score?.mix && <p className="forge-note" data-movie-music-hint>{t(score.mix.mode === 'mix' ? 'wizards.movie.music.hint' : 'wizards.movie.music.hintH3')}</p>}
      <div className="wizards-row movie-button-group">
        <button type="button" className="action-button" data-movie-music-run disabled={!!mixBlocked || mixing} title={mixBlocked || undefined} onClick={() => void mixIt()}>{t(mixing ? 'wizards.movie.music.mixing' : score?.state === 'done' ? 'wizards.movie.music.again' : 'wizards.movie.music.run')}</button>
        {mixBlocked && <span className="forge-note" data-movie-music-blocked>{mixBlocked}</span>}
      </div>
      {score && (score.state === 'stale' || (score.state === 'planned' && score.revisions.some(r => r.result))) && <p className="forge-note" data-movie-music-stale>{t('wizards.movie.music.stale')}</p>}
      {scoredClip && /\.(mp4|webm|mkv|mov)$/i.test(scoredClip) && <MoviePlayer path={scoredClip} media="video" toSrc={convertFileSrc} data-movie-scored-video/>}

      </div>
    </MoviePanel>}
    {panel?.kind === 'film' && (final || !!joining) && <MoviePanel kind="film" title={t('wizards.movie.film.title')} onClose={() => setPanel(null)}>
      <div className="wizards-step" data-movie-film>
      <span className="forge-note">{t('wizards.movie.film.title')}</span>
      <p className="forge-note">{t('wizards.movie.film.intro')}</p>
      {!filmPlan.ok && filmPlan.missing.length > 0 && <ul data-movie-film-missing>{filmPlan.missing.map(x => <li key={x.id} className="forge-note">{t('wizards.movie.film.missing', { title: x.title, why: why(x.why) })}</li>)}</ul>}
      {final?.state === 'stale' && <p className="forge-note" data-movie-film-stale>{t('wizards.movie.film.stale')}</p>}
      <div className="wizards-row movie-button-group">
        <button type="button" className="action-button" data-movie-film-run disabled={!!joinBlocked || !!joining} title={joinBlocked || undefined} onClick={() => void join()}>{t(final?.state === 'done' ? 'wizards.movie.film.again' : 'wizards.movie.film.run')}</button>
        {joining && <button type="button" className="forge-ghost" data-movie-film-stop onClick={stopJoin}>{t('wizards.run.stop')}</button>}
        {joining && <span className="forge-note" role="status" data-movie-film-progress>{joining}</span>}
        {joinBlocked && !joining && <span className="forge-note" data-movie-film-blocked>{joinBlocked}</span>}
      </div>
      {mismatch && <p className="forge-note" role="alert" data-movie-film-mismatch>{t('wizards.movie.film.mismatch', { got: String(mismatch.got), want: String(mismatch.want) })}</p>}
      {filmClip && /\.(mp4|webm|mkv|mov)$/i.test(filmClip) && <MoviePlayer path={filmClip} media="video" toSrc={convertFileSrc} data-movie-film-video/>}

      </div>
    </MoviePanel>}
      {inputsOpen && (() => { const g = segments.find(i => i.id === inputsOpen); return g ? <SceneInputs family="minimax-h3" title={g.title || t('wizards.movie.scene.untitled', { n: String(segments.indexOf(g) + 1) })} inputs={g.inputs} seconds={g.seconds ?? 5} roots={mediaRoots} endpoint={endpoint} root={root} toSrc={convertFileSrc}
        onChange={inputs => change(m => setSceneInputs(m, g.id, inputs))} onInsert={tag => change(m => editItem(m, g.id, `${m.items.find(i => i.id === g.id)?.text.trimEnd() ?? ''} ${tag}`.trim()))} onClose={() => setInputsOpen('')}/> : null; })()}
    <div className="wizards-step" data-movie-saved>
      <span className="forge-note">{t('wizards.movie.open')}</span>
      {saved && !saved.movies.length && <p className="forge-note" data-movie-none>{t('wizards.movie.none')}</p>}
      {saved?.movies.map(s => <div className="wizards-row" key={s.id} data-movie-saved-item={s.id}>
        <button type="button" className="forge-ghost" data-movie-open={s.id} disabled={busy} onClick={() => void open(s.id)}>{s.title || s.id}</button>
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
