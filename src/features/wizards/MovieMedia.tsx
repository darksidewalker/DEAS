import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import type { MediaItem } from '../../lib/media';
import type { MediaRole, MovieMedia as PoolItem } from '../../lib/movieManifest';
import { describePicture } from '../../lib/analysis';
import { prepare } from '../forge/ReferenceImages';
import { MediaPanel } from '../media/MediaPanel';
import type { MediaRoots, MediaSort, MediaType, MediaView } from '../media/MediaLibrary';
import { ReferencesOverlay } from '../studio/ReferencesOverlay';
import { ReferenceAssignmentBar } from '../studio/ReferenceAssignmentBar';
import { ReferenceThumbnail } from '../studio/ReferenceThumbnail';
import { pictureLabels } from '../studio/ReferencesPanel';
import { MoviePlayer } from './MoviePlayer';
import { sceneCaps } from './SceneInputs';

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const GLYPH: Record<string, string> = { image: '▣', video: '▶', audio: '♪' };

/**
 * The picture as a vision model takes it, scaled like Prompt Forge and Media Analysis send pictures, then described through the same
 * native describe command Media Analysis uses (its default sampling). Only the description text is kept.
 */
export async function describeMediaPicture(root: string, modelId: string, src: string, name: string): Promise<string> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const type = blob.type.startsWith('image/') ? blob.type : `image/${(name.split('.').pop() ?? 'png').toLowerCase().replace('jpg', 'jpeg')}`;
  const image = await prepare(new File([blob], name, { type }));
  const out = await describePicture(root, modelId, image, [], { temperature: 0.2, presencePenalty: 0 }, crypto.randomUUID(), () => undefined);
  return (out.description || out.text).trim();
}

/** The roles a medium can take in an H3 scene, from the family's declared capabilities (as Generate's role bar offers them). */
export function mediaRoles(media: PoolItem['media'], family = 'minimax-h3'): MediaRole[] {
  const caps = sceneCaps(family);
  const roles: MediaRole[] = [];
  if (caps?.referenceMedia.includes(media)) roles.push('reference');
  if (media === 'image') for (const r of ['first', 'last'] as const) if (caps?.roles.includes(r)) roles.push(r);
  if (media === 'video' && caps?.roles.includes('source')) roles.push('source');
  return roles;
}
/** The Director's picture labels a reference picture can carry (the individual characters and the single-subject roles). */
const LABELS = pictureLabels.filter(l => /^character-[1-8]$/.test(l) || ['place', 'style', 'pose', 'custom'].includes(l));

export interface PoolScene { id: string; name: string }
export interface MovieMediaProps {
  media: PoolItem[];
  scenes: PoolScene[];
  /** Scene ids each medium is used in and its role there (read from the scenes' inputs). */
  usedIn: (path: string) => string[];
  roleOf: (path: string) => MediaRole;
  roots?: MediaRoots;
  onAdd: (items: PoolItem[]) => void;
  onRemove: (path: string) => void;
  onOpen: (path: string) => void;
  /** A medium dropped onto a scene card: add that scene to where it is used. */
  onDropOnScene: (path: string, sceneId: string) => void;
  onDescribe: (() => Promise<void>) | null;
  describing: boolean;
  open?: string;
  toSrc: (path: string) => string;
}

/** Step 1's media: thrown in from Generate's own media panel; each card shows the whole picture, its note and where it is used. */
export function MovieMediaPool({ media, scenes, usedIn, roleOf, roots, onAdd, onRemove, onOpen, onDropOnScene, onDescribe, describing, open, toSrc }: MovieMediaProps) {
  const { t } = useI18n();
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<MediaItem | null>(null);
  const [query, setQuery] = useState(''), [sort, setSort] = useState<MediaSort>('date'), [view, setView] = useState<MediaView>('tiles'), [type, setType] = useState<MediaType>('all');
  const [ghost, setGhost] = useState<{ name: string; x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const add = (items: MediaItem[]) => onAdd(items.filter(i => i.path).map(i => ({ path: i.path!, media: i.media })));
  const unnamed = media.filter(x => x.media === 'image' && !x.note?.trim()).length;
  const sceneName = (id: string) => scenes.find(s => s.id === id)?.name ?? id;
  // Drag a card onto a scene card on the timeline (pointer events: WebView2 intercepts HTML drag-and-drop).
  const startDrag = (x: PoolItem, e: ReactPointerEvent) => {
    if ((e.button ?? 0) > 0 || e.isPrimary === false) return;
    const start = { x: e.clientX, y: e.clientY };
    dragged.current = false;
    const move = (ev: PointerEvent) => {
      if (!dragged.current && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 6) return;
      dragged.current = true; setGhost({ name: fileName(x.path), x: ev.clientX, y: ev.clientY });
    };
    const stop = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop);
      setGhost(null);
      if (!dragged.current) return;
      const card = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-movie-scene-card]');
      const id = card?.getAttribute('data-movie-scene-card');
      if (id) onDropOnScene(x.path, id);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop);
  };
  return <div className="movie-media" data-movie-media>
    <div className="movie-button-group" role="group">
      <button type="button" className="action-button" data-movie-media-add onClick={() => setPicking(true)}>{t('wizards.movie.media.add')}</button>
      {onDescribe && <button type="button" className="forge-ghost" data-movie-media-describe disabled={describing || !unnamed} title={unnamed ? undefined : t('wizards.movie.media.allDescribed')} onClick={() => void onDescribe()}>{t(describing ? 'wizards.movie.media.describing' : 'wizards.movie.media.describe', { count: String(unnamed) })}</button>}
    </div>
    {!media.length && <p className="forge-note" data-movie-media-empty>{t('wizards.movie.media.empty')}</p>}
    {!!media.length && <p className="forge-note">{t('wizards.movie.media.dragHint')}</p>}
    {!!media.length && <ul className="movie-media-grid">
      {media.map(x => { const used = usedIn(x.path); return <li key={x.path} className={`library-card movie-media-card${open === x.path ? ' is-selected' : ''}`} data-movie-media-item={x.path}>
        <button type="button" className="movie-media-main" data-movie-media-open={x.path} aria-label={t('wizards.movie.media.openNamed', { name: fileName(x.path) })}
          onPointerDown={e => startDrag(x, e)} onClick={() => { if (!dragged.current) onOpen(x.path); dragged.current = false; }}>
          <span className="movie-media-art">
            <ReferenceThumbnail reference={{ item: { name: fileName(x.path), path: x.path, src: toSrc(x.path), media: x.media }, second: 0, strength: 1, mediaMode: 'video' }}/>
            <span className="library-family-badge" aria-hidden="true">{GLYPH[x.media]}</span>
          </span>
          <span className="movie-media-caption">
            <strong className="wizards-name" title={x.path}>{fileName(x.path)}</strong>
            <span className={`movie-media-note${x.note?.trim() ? '' : ' is-empty'}`} data-movie-media-note-preview>{x.note?.trim() || t(x.media === 'image' ? 'wizards.movie.media.noNotePicture' : 'wizards.movie.media.noNote')}</span>
            <span className="movie-media-used" data-movie-media-used>{used.length ? t('wizards.movie.media.usedIn', { scenes: used.map(sceneName).join(', '), role: t(`studio.run.video.roles.${roleOf(x.path)}`) }) : t('wizards.movie.media.auto')}</span>
          </span>
        </button>
        <button type="button" className="library-text-button movie-media-remove" data-movie-media-remove aria-label={t('wizards.movie.media.remove', { name: fileName(x.path) })} onClick={() => onRemove(x.path)}>×</button>
      </li>; })}
    </ul>}
    {ghost && <span className="movie-drag-ghost" style={{ left: ghost.x + 12, top: ghost.y + 12 }} aria-hidden="true">{ghost.name}</span>}
    {picking && <ReferencesOverlay subtitle={t('wizards.movie.media.title')} pickerHint={t('studio.run.video.roles.pick')} onClose={() => setPicking(false)} onDropItems={add}
      picker={<MediaPanel selected={picked} onSelect={setPicked} roots={roots} controls={{ query, onQuery: setQuery, sort, onSort: setSort, view, onView: setView, type, onType: setType }}/>}>
      <ReferenceAssignmentBar selected={picked} actions={[{ id: 'movie', label: t('wizards.movie.media.addOne'), reason: !picked?.path ? t('studio.run.video.roles.pick') : media.some(x => x.path === picked.path) ? t('wizards.movie.media.already') : undefined, assign: () => { if (picked) add([picked]); } }]}/>
    </ReferencesOverlay>}
  </div>;
}

/**
 * A medium's own settings: the whole medium in the preview player, the full note, and how it is used — in which scenes (several, or
 * none = Auto: the planner decides), as what (the roles the scene model can take) and, for a reference picture, its Director label.
 * What the user sets here is binding for the planner.
 */
export function MovieMediaSettings({ item, scenes, used, current, refused, onNote, onAssign, toSrc }: { item: PoolItem; scenes: PoolScene[]; used: string[]; current: MediaRole; refused: string[]; onNote: (note: string) => void; onAssign: (scenes: string[], role: MediaRole, label?: string) => void; toSrc: (p: string) => string }) {
  const { t } = useI18n();
  const roles = mediaRoles(item.media);
  const role = roles.includes(current) ? current : roles[0] ?? 'reference';
  const label = role === 'reference' && item.media === 'image' ? item.label ?? '' : '';
  const name = (id: string) => scenes.find(s => s.id === id)?.name ?? id;
  return <div className="wizards-step movie-media-settings" data-movie-media-settings={item.path}>
    <MoviePlayer path={item.path} media={item.media} toSrc={toSrc} data-movie-media-player/>
    <label className="forge-field"><span>{t('wizards.movie.media.noteLabel')}</span>
      <textarea rows={4} maxLength={2000} data-movie-media-note value={item.note ?? ''} placeholder={t(item.media === 'image' ? 'wizards.movie.media.notePicture' : 'wizards.movie.media.noteOther')} onChange={e => onNote(e.target.value)}/></label>
    <fieldset className="movie-media-use" data-movie-media-use>
      <legend>{t('wizards.movie.media.useIn')}</legend>
      <label className="forge-note"><input type="checkbox" data-movie-media-auto checked={!used.length} onChange={e => { if (e.target.checked) onAssign([], role, label || undefined); }}/> {t('wizards.movie.media.autoLong')}</label>
      {!scenes.length && <p className="forge-note">{t('wizards.movie.media.noScenes')}</p>}
      {scenes.map(s => <label key={s.id} className="forge-note"><input type="checkbox" data-movie-media-scene={s.id} checked={used.includes(s.id)}
        onChange={e => onAssign(e.target.checked ? [...used, s.id] : used.filter(x => x !== s.id), role, label || undefined)}/> {s.name}</label>)}
    </fieldset>
    <div className="wizards-fields">
      <label className="forge-field"><span>{t('wizards.movie.media.as')}</span>
        <select data-movie-media-role value={role} disabled={roles.length < 2} onChange={e => onAssign(used, e.target.value as MediaRole, undefined)}>
          {roles.map(r => <option key={r} value={r}>{t(`studio.run.video.roles.${r}`)}</option>)}
        </select></label>
      {role === 'reference' && item.media === 'image' && <label className="forge-field"><span>{t('wizards.movie.media.label')}</span>
        <select data-movie-media-label value={label} onChange={e => onAssign(used, role, e.target.value || undefined)}>
          <option value="">{t('wizards.movie.media.labelAuto')}</option>
          {LABELS.map(l => <option key={l} value={l}>{t(`forge.role.${l.replace(/-\d+$/, '')}`, { n: l.slice(10) })}</option>)}
        </select></label>}
    </div>
    {!!refused.length && <p className="error-message" role="alert" data-movie-media-refused>{t('wizards.movie.media.refused', { scenes: refused.map(name).join(', ') })}</p>}
  </div>;
}
