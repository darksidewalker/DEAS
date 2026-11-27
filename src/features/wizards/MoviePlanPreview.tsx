import { useI18n } from '../../i18n/I18nProvider';
import { h3ActualSeconds, musicDiff, planRows, type ApplyOptions, type PlanRow, type StoryPlan } from '../../lib/movieStory';
import type { MovieManifest } from '../../lib/movieManifest';

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * The proposal in full before anything changes (UX-22d8): the story bible, then every scene as the film would have it — status (new /
 * changed / unchanged / kept as made), title, length and what H3 will really make, transition, what happens, start and end state, the
 * spoken lines and the media placed in it; a changed scene shows what it was. Scenes that would be removed, the music the plan suggests
 * (style, tempo, lyrics) and what would go outdated close the list. Read-only: *Apply plan* / *Discard* stay with the caller.
 */
export function MoviePlanPreview({ movie, plan, options }: { movie: MovieManifest; plan: StoryPlan; options: ApplyOptions }) {
  const { t } = useI18n();
  const { rows, removed, keptAfter } = planRows(movie, plan, options);
  const story = movie.items.find(i => i.kind === 'story');
  const music = musicDiff(movie, plan);
  const pool = movie.media ?? [];
  const seconds = (n: number) => (Math.round(n * 100) / 100).toString();
  const total = plan.segments.reduce((a, s, n) => a + h3ActualSeconds(s.seconds, s.continuous && n > 0), 0);
  const scene = (r: PlanRow) => {
    // A kept (made) scene stays as it is: show the scene, and the plan's suggestion only as a note.
    const shown = r.status === 'kept' && r.current ? { ...r.planned, title: r.current.title, prompt: r.current.text, seconds: r.current.seconds ?? r.planned.seconds, continuous: !!r.current.continuous, entry: r.current.entry, exit: r.current.exit, dialogue: r.current.dialogue ?? [] } : r.planned;
    const media = (r.planned.inputs ?? []).map(i => `${fileName(pool[i.media]?.path ?? '')} (${t(`studio.run.video.roles.${i.role}`)})`).filter(Boolean);
    return <li key={r.n} className={`movie-plan-scene is-${r.status}`} data-movie-plan-scene={r.n} data-movie-plan-status={r.status}>
      <div className="movie-plan-scene-head">
        <span className="movie-step-n">{r.n}</span>
        <strong>{shown.title}</strong>
        <span className={`movie-plan-badge is-${r.status}`}>{t(`wizards.movie.plan.row.${r.status}`)}</span>
        <span className="forge-note">{t('wizards.movie.plan.rowLength', { seconds: seconds(shown.seconds), actual: seconds(h3ActualSeconds(shown.seconds, shown.continuous && r.n > 1)) })}</span>
        {r.n > 1 && <span className="forge-note">{t(shown.continuous ? 'wizards.movie.transition.seamless' : 'wizards.movie.transition.cut')}</span>}
      </div>
      <p className="movie-plan-text" data-movie-plan-prompt>{shown.prompt}</p>
      {shown.entry && <p className="forge-note"><b>{t('wizards.movie.plan.entry')}</b> {shown.entry}</p>}
      {shown.exit && <p className="forge-note"><b>{t('wizards.movie.plan.exit')}</b> {shown.exit}</p>}
      {!!shown.dialogue.length && <ul className="movie-plan-lines" data-movie-plan-lines>{shown.dialogue.map((d, k) => <li key={k}>{t(d.delivery ? 'wizards.movie.plan.spokenDelivery' : 'wizards.movie.plan.spoken', { name: d.speaker, line: d.line, delivery: d.delivery ?? '' })}</li>)}</ul>}
      {!!pool.length && <p className="forge-note" data-movie-plan-media>{t('wizards.movie.plan.rowMedia', { media: media.join(', ') || t('wizards.movie.plan.placedNone') })}</p>}
      {r.status === 'changed' && r.current && <details className="movie-plan-before" data-movie-plan-before>
        <summary className="forge-note">{t('wizards.movie.plan.before')}</summary>
        <p className="forge-note">{t('wizards.movie.plan.beforeLine', { title: r.current.title, seconds: seconds(r.current.seconds ?? 0) })}</p>
        <p className="movie-plan-text">{r.current.text || '—'}</p>
      </details>}
      {r.status === 'kept' && <p className="forge-note" data-movie-plan-kept>{t('wizards.movie.plan.keptNote', { title: r.planned.title })}</p>}
    </li>;
  };
  return <div className="movie-plan-preview" data-movie-plan-preview>
    <p className="forge-note">{t('wizards.movie.plan.previewTotal', { scenes: String(plan.segments.length), seconds: seconds(total) })}</p>
    <details className="movie-plan-bible" open data-movie-plan-bible>
      <summary><strong>{t('wizards.movie.plan.lore')}</strong> <span className="forge-note">{t(`wizards.movie.plan.state.${story?.locked ? 'locked' : !story ? 'new' : story.text === plan.lore ? 'same' : 'changed'}`)}</span></summary>
      <p className="movie-plan-text">{plan.lore || '—'}</p>
    </details>
    <ol className="movie-plan-scenes">{rows.map(scene)}</ol>
    {!!removed.length && <p className="forge-note" data-movie-plan-removed>{t('wizards.movie.plan.removedList', { names: removed.map(x => x.title || x.id).join(', ') })}</p>}
    {!!keptAfter.length && <p className="forge-note" data-movie-plan-kept-after>{t('wizards.movie.plan.keptAfter', { names: keptAfter.map(x => x.title || x.id).join(', ') })}</p>}
    {(plan.music || plan.musicLyrics || plan.musicBpm) && <div className="movie-plan-music" data-movie-plan-music>
      <strong>{t('wizards.movie.music.title')}</strong>
      {plan.music && <p className="forge-note" data-movie-plan-music-style>{t(`wizards.movie.plan.musicField.${music.style}`, { field: t('wizards.movie.music.prompt'), value: plan.music })}</p>}
      {plan.musicBpm && <p className="forge-note" data-movie-plan-music-bpm>{t(`wizards.movie.plan.musicField.${music.bpm}`, { field: t('wizards.movie.music.bpm'), value: String(plan.musicBpm) })}</p>}
      {plan.musicLyrics && <>
        <p className="forge-note">{t(`wizards.movie.plan.musicField.${music.lyrics}`, { field: t('wizards.movie.music.lyrics'), value: t('wizards.movie.plan.lyricsBelow') })}</p>
        <pre className="movie-plan-lyrics" data-movie-plan-music-lyrics>{plan.musicLyrics}</pre>
      </>}
    </div>}
  </div>;
}
