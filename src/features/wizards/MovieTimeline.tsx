import { Fragment, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { transitionOf, type MovieItem, type SceneTransition } from '../../lib/movieManifest';
import { ReferenceThumbnail } from '../studio/ReferenceThumbnail';
import { SceneInputMarks } from './SceneInputs';

export type MoviePanelTarget = { kind: 'scene'; id: string } | { kind: 'music' } | { kind: 'film' } | { kind: 'media'; path: string } | null;
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
/** Width of a scene card on the scenes lane: proportional to its length, so the lanes read as a composition. */
const sceneWidth = (seconds: number) => Math.max(132, Math.round(seconds * 26));

export interface MovieTimelineProps {
  scenes: MovieItem[];
  music?: MovieItem;
  film?: MovieItem;
  /** Which card's settings are open in the panel. */
  open: MoviePanelTarget;
  onOpen: (target: MoviePanelTarget) => void;
  onAdd: () => void;
  /** Removes that scene (its × on the card). */
  onRemove: (id: string) => void;
  onRename: (id: string, title: string) => void;
  /** How the film goes into a scene: seamless (H3 continues the take), cut, or a blend of `seconds`. */
  onTransition: (id: string, kind: SceneTransition, seconds?: number) => void;
  /** Running job per scene id (the card shows *making …*). */
  running: (id: string) => boolean;
  toSrc: (path: string) => string;
}

/** A made scene shows a frame of its own clip; otherwise its first input (frames first, then references), like a Library card cover. */
function SceneCover({ scene, toSrc }: { scene: MovieItem; toSrc: (p: string) => string }) {
  const made = scene.state === 'done' ? scene.revisions.find(r => r.n === scene.revision)?.result?.outputId : undefined;
  if (made && /\.(mp4|webm|mkv|mov)$/i.test(made)) return <ReferenceThumbnail reference={{ item: { name: fileName(made), path: made, src: toSrc(made), media: 'video' }, second: 0, strength: 1, mediaMode: 'video' }}/>;
  const v = scene.inputs, first = v?.first ?? v?.last ?? v?.source ?? v?.refs?.find(r => r.media !== 'audio') ?? v?.refs?.[0];
  if (!first) return <span className="library-placeholder movie-card-placeholder" aria-hidden="true">▤</span>;
  return <ReferenceThumbnail reference={{ item: { name: fileName(first.path), path: first.path, src: toSrc(first.path), media: first.media }, second: 0, strength: 1, mediaMode: 'video' }}/>;
}

/**
 * The composition view: a scenes lane (one card per scene, width by length), a music lane and the film lane. + sits on the left; each
 * scene card has its own × to remove it; a card opens its settings in the non-blocking panel; a scene is renamed on its card with a short field.
 */
const BLENDS = [0.5, 1, 2];
const GLYPH: Record<SceneTransition, string> = { seamless: '⟿', cut: '│', blend: '⧖' };
export function MovieTimeline({ scenes, music, film, open, onOpen, onAdd, onRemove, onRename, onTransition, running, toSrc }: MovieTimelineProps) {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const name = (g: MovieItem, n: number) => g.title.trim() || t('wizards.movie.scene.untitled', { n: String(n + 1) });
  const state = (g: MovieItem) => t(`wizards.movie.shot.state.${running(g.id) ? 'running' : g.state}`);
  const commit = () => { if (renaming) onRename(renaming.id, renaming.title.trim()); setRenaming(null); };
  return <div className="movie-timeline-wrap" data-movie-timeline-wrap>
    <div className="movie-timeline-tools" role="group" aria-label={t('wizards.movie.scenes')}>
      <button type="button" className="forge-ghost movie-icon-button" data-movie-scene-add aria-label={t('wizards.movie.scene.add')} title={t('wizards.movie.scene.add')} onClick={onAdd}>+</button>
    </div>
    <div className="movie-lanes">
      <div className="movie-lane is-video" data-movie-lane="scenes">
        <span className="movie-lane-label">{t('wizards.movie.lane.scenes')}</span>
        {!scenes.length && <p className="forge-note movie-lane-empty" data-movie-scenes-empty>{t('wizards.movie.scenesEmpty')}</p>}
        {!!scenes.length && <ol className="movie-timeline" data-movie-timeline>
          {scenes.map((g, n) => {
            const selected = open?.kind === 'scene' && open.id === g.id;
            const kind = transitionOf(g), value = kind === 'blend' ? `blend:${g.blend}` : kind;
            const blends = kind === 'blend' && !BLENDS.includes(g.blend!) ? [...BLENDS, g.blend!].sort((a, b) => a - b) : BLENDS;
            return <Fragment key={g.id}>
            {n > 0 && <li className={`movie-boundary is-${kind}`} data-movie-boundary={g.id}>
              <span className="movie-boundary-glyph" aria-hidden="true">{GLYPH[kind]}</span>
              <select data-movie-transition={g.id} aria-label={t('wizards.movie.transition.label', { a: name(scenes[n - 1], n - 1), b: name(g, n) })} title={t(`wizards.movie.transition.${kind}Hint`)} value={value}
                onChange={e => { const [k, sec] = e.target.value.split(':'); onTransition(g.id, k as SceneTransition, sec ? Number(sec) : undefined); }}>
                <option value="seamless">{t('wizards.movie.transition.seamless')}</option>
                <option value="cut">{t('wizards.movie.transition.cut')}</option>
                {blends.map(b => <option key={b} value={`blend:${b}`}>{t('wizards.movie.transition.blend', { seconds: String(b) })}</option>)}
              </select>
            </li>}
            <li style={{ flexBasis: sceneWidth(g.seconds ?? 5) }}>
              <article className={`library-card movie-card${selected ? ' is-selected' : ''} is-${running(g.id) ? 'running' : g.state}`}>
                <button type="button" className="library-card-main movie-card-main" aria-pressed={selected} data-movie-scene-card={g.id} onClick={() => onOpen({ kind: 'scene', id: g.id })}>
                  <span className="library-card-art movie-card-art">
                    <SceneCover scene={g} toSrc={toSrc}/>
                    <span className="library-family-badge" data-movie-scene-state>{state(g)}</span>
                    <span className="movie-card-flags">
                      {!!g.loras?.length && <span className="movie-flag" data-movie-flag="loras" title={t('wizards.movie.shot.settings', { count: String(g.loras.length) })}>{`◆${g.loras.length}`}</span>}
                    </span>
                  </span>
                  <span className="library-card-caption">
                    <strong data-movie-scene-name>{name(g, n)}</strong>
                    <span className="library-card-bottom"><span>{t('wizards.movie.scene.seconds', { seconds: String(g.seconds ?? 0) })}</span><SceneInputMarks inputs={g.inputs} toSrc={toSrc}/></span>
                  </span>
                </button>
                <button type="button" className="library-text-button movie-card-remove" data-movie-scene-remove={g.id} disabled={!!g.locked || running(g.id)} aria-label={t('wizards.movie.scene.removeNamed', { name: name(g, n) })} title={t('wizards.movie.scene.remove')} onClick={() => onRemove(g.id)}>✕</button>
                {renaming?.id === g.id
                  ? <input className="movie-card-rename" data-movie-scene-rename-field aria-label={t('wizards.movie.scene.rename')} value={renaming.title} maxLength={40} size={14} autoFocus
                    onChange={e => setRenaming({ id: g.id, title: e.target.value })} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setRenaming(null); }}/>
                  : <button type="button" className="library-text-button movie-card-rename-button" data-movie-scene-rename={g.id} disabled={!!g.locked} aria-label={t('wizards.movie.scene.renameNamed', { name: name(g, n) })} title={t('wizards.movie.scene.rename')} onClick={() => setRenaming({ id: g.id, title: g.title })}>✎</button>}
              </article>
            </li>
            </Fragment>;
          })}
        </ol>}
      </div>
      <div className="movie-lane is-music" data-movie-lane="music">
        <span className="movie-lane-label">{t('wizards.movie.lane.music')}</span>
        <button type="button" className={`library-card movie-card movie-wide-card is-music${open?.kind === 'music' ? ' is-selected' : ''}`} aria-pressed={open?.kind === 'music'} data-movie-music-card disabled={!scenes.length} onClick={() => onOpen({ kind: 'music' })}>
          <span className="movie-wide-glyph" aria-hidden="true">♪</span>
          <strong>{music?.file ? fileName(music.file) : t('wizards.movie.lane.musicEmpty')}</strong>
          <span className="forge-note">{music ? t(`wizards.movie.shot.state.${music.state}`) : t('wizards.movie.lane.optional')}</span>
        </button>
      </div>
      <div className="movie-lane is-film" data-movie-lane="film">
        <span className="movie-lane-label">{t('wizards.movie.lane.film')}</span>
        <button type="button" className={`library-card movie-card movie-wide-card is-film${open?.kind === 'film' ? ' is-selected' : ''}`} aria-pressed={open?.kind === 'film'} data-movie-film-card disabled={!film} onClick={() => onOpen({ kind: 'film' })}>
          <span className="movie-wide-glyph" aria-hidden="true">▶</span>
          <strong>{t('wizards.movie.film.title')}</strong>
          <span className="forge-note">{film ? t(`wizards.movie.shot.state.${film.state}`) : '—'}</span>
        </button>
      </div>
    </div>
  </div>;
}
