import { useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import type { MediaItem } from '../../lib/media';
import type { SceneInputs as Inputs, SceneMedia, SceneRef } from '../../lib/movieManifest';
import families from '../../families/builtin.json' with { type: 'json' };
import { MediaPanel } from '../media/MediaPanel';
import type { MediaRoots, MediaSort, MediaType, MediaView } from '../media/MediaLibrary';
import { ReferencesOverlay } from '../studio/ReferencesOverlay';
import { ReferenceAssignmentBar } from '../studio/ReferenceAssignmentBar';
import { ReferenceThumbnail } from '../studio/ReferenceThumbnail';
import { ReferencesPanel, directorTags, over, refCounts, type RefAdd, type VideoRef } from '../studio/ReferencesPanel';
import { videoRoleBlock, videoRoles, type VideoRole, type VideoRoles } from '../studio/videoRoles';

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
/** A scene's family capabilities exactly as Generate reads them (`family.video` in the family data). */
export const sceneCaps = (family: string): VideoRoles | undefined => (families as { id: string; video?: VideoRoles }[]).find(f => f.id === family)?.video;
const toItem = (m: SceneMedia, toSrc: (p: string) => string): MediaItem => ({ name: fileName(m.path), path: m.path, src: toSrc(m.path), media: m.media });
const toMedia = (item: MediaItem): SceneMedia => ({ path: item.path!, media: item.media });
const toRef = (r: SceneRef, toSrc: (p: string) => string): VideoRef => { const { path, media, ...rest } = r; return { ...rest, item: toItem({ path, media }, toSrc), uiKey: crypto.randomUUID() }; };
const fromRef = (v: VideoRef): SceneRef => { const { item, uiKey: _key, ...rest } = v; return { ...rest, path: item.path!, media: item.media }; };
/** The reference editor's view of a scene's inputs, as the plain record the manifest keeps. */
export const sceneRefs = (inputs: Inputs | undefined, toSrc: (p: string) => string): VideoRef[] => (inputs?.refs ?? []).map(r => toRef(r, toSrc));

/** Language-neutral kind badges on the timeline marks (the tooltip names role and file). */
const GLYPH: Record<string, string> = { first: '⇤', last: '⇥', source: '⟳', image: '▣', video: '▶', audio: '♪' };
/** Small typed thumbnails of a scene's inputs for its timeline card: the frames and every reference, each with its kind marked. */
export function SceneInputMarks({ inputs, toSrc }: { inputs?: Inputs; toSrc: (p: string) => string }) {
  const { t } = useI18n();
  const frames = (['first', 'last', 'source'] as const).flatMap(k => inputs?.[k] ? [{ k, m: inputs[k]! }] : []);
  if (!frames.length && !inputs?.refs?.length) return <span className="forge-note" data-scene-no-inputs>{t('wizards.movie.scene.noInputs')}</span>;
  return <span className="movie-scene-marks">
    {frames.map(({ k, m }) => <span key={k} className="movie-scene-mark" data-scene-mark={k} title={`${t(`studio.run.video.roles.${k}`)}: ${fileName(m.path)}`}><ReferenceThumbnail reference={{ item: toItem(m, toSrc), second: 0, strength: 1, mediaMode: 'video' }}/><span className="movie-scene-kind" aria-hidden="true">{GLYPH[k]}</span></span>)}
    {(inputs?.refs ?? []).map((r, n) => <span key={`${r.path}-${n}`} className="movie-scene-mark" data-scene-mark={r.media === 'video' && r.mediaMode === 'audio' ? 'audio' : r.media} title={`${t('studio.run.video.roles.reference')}: ${fileName(r.path)}${r.label ? ` · ${r.label}` : ''}`}><ReferenceThumbnail reference={toRef(r, toSrc)}/><span className="movie-scene-kind" aria-hidden="true">{GLYPH[r.media === 'video' && r.mediaMode === 'audio' ? 'audio' : r.media]}</span></span>)}
  </span>;
}

export interface SceneInputsProps {
  /** Scene family; its `family.video` capabilities decide which roles an input can take (H3: frames or references, LTX: also a source). */
  family: 'minimax-h3' | 'ltx-2';
  title: string;
  inputs?: Inputs;
  seconds: number;
  roots?: MediaRoots;
  endpoint?: string;
  root?: string;
  toSrc: (path: string) => string;
  onChange: (inputs: Inputs) => void;
  /** Appends a Director label such as `<Picture 1>` to the scene's prompt. */
  onInsert: (tag: string) => void;
  onClose: () => void;
}
/**
 * A scene's inputs in Generate's own References overlay: the media panel picks a file, the role bar assigns it (first/last frame,
 * reference, source — whatever the scene's model can take), and the References editor holds every Director option of each reference.
 * Nothing here is new UI; it only keeps the result as the scene's inputs instead of Generate's draft.
 */
export function SceneInputs({ family, title, inputs, seconds, roots, endpoint, root, toSrc, onChange, onInsert, onClose }: SceneInputsProps) {
  const { t } = useI18n();
  const caps = sceneCaps(family);
  const [refs, setRefs] = useState<VideoRef[]>(() => sceneRefs(inputs, toSrc));
  const [picked, setPicked] = useState<MediaItem | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState(''), [sort, setSort] = useState<MediaSort>('date'), [view, setView] = useState<MediaView>('tiles'), [type, setType] = useState<MediaType>('all');
  const frames = { first: inputs?.first ? toItem(inputs.first, toSrc) : null, last: inputs?.last ? toItem(inputs.last, toSrc) : null };
  const emit = (next: { refs?: VideoRef[]; first?: SceneMedia | null; last?: SceneMedia | null; source?: SceneMedia | null }) => {
    const r = next.refs ?? refs;
    if (next.refs) setRefs(next.refs);
    const pick = (k: 'first' | 'last' | 'source') => (next[k] === undefined ? inputs?.[k] : next[k] ?? undefined);
    onChange({ ...(pick('first') ? { first: pick('first')! } : {}), ...(pick('last') ? { last: pick('last')! } : {}), ...(pick('source') ? { source: pick('source')! } : {}), ...(r.length ? { refs: r.map(fromRef) } : {}) });
  };
  const state = (count = refs.length) => ({ first: !!inputs?.first, last: !!inputs?.last, source: !!inputs?.source, references: count });
  const refBlock = (item: MediaItem, next = refs) => {
    const why = videoRoleBlock(caps, 'reference', item, state(next.length));
    if (why) return why;
    if (!caps?.referenceMedia.includes(item.media)) return 'studio.run.video.roles.media';
    return family !== 'ltx-2' && over(refCounts([...next, { item, second: 0, strength: 1, mediaMode: 'video' }])) ? 'studio.run.video.refFull' : '';
  };
  const add = (adds: RefAdd[]) => {
    let next = refs; const refused: string[] = [];
    for (const { item, ...rest } of adds) {
      if (!item.path) continue;
      const why = refBlock(item, next);
      if (why) refused.push(`${item.name}: ${t(why)}`);
      else next = [...next, { item, second: next.length && family === 'ltx-2' ? seconds : 0, strength: 1, mediaMode: 'video', ...rest, uiKey: crypto.randomUUID() }];
    }
    setError(refused.join(' · '));
    if (next !== refs) emit({ refs: next });
    return !refused.length;
  };
  const assign = (role: VideoRole, item: MediaItem) => {
    if (role === 'reference') { add([{ item }]); return; }
    const why = videoRoleBlock(caps, role, item, state());
    if (why) { setError(t(why)); return; }
    setError('');
    const m = toMedia(item);
    if (role === 'source') emit({ source: m });
    else if (role === 'first') emit({ first: m, ...(inputs?.last?.path === m.path ? { last: null } : {}) });
    else if (role === 'last') emit({ last: m });
    else emit({ first: m, last: m });
  };
  // The same role filter as Generate's: on H3 only pictures take frame roles, only clips a source role.
  const actions = videoRoles.filter(role => caps?.roles.includes(role) && (family !== 'minimax-h3' || !picked || role === 'reference' || (role === 'source' ? picked.media === 'video' : picked.media === 'image')))
    .map(role => { const why = picked ? (role === 'reference' ? refBlock(picked) : videoRoleBlock(caps, role, picked, state())) : 'studio.run.video.roles.pick'; return { id: role, label: t(`studio.run.video.roles.${role}`), reason: why ? t(why) : undefined, assign: () => { if (picked) assign(role, picked); } }; });
  const tags = directorTags(refs);
  return <ReferencesOverlay manager={family !== 'ltx-2'} subtitle={title} pickerHint={t('studio.run.video.roles.pick')} onClose={onClose}
    onDropItems={items => { for (const item of items) { if (refBlock(item)) setPicked(item); else add([{ item }]); } }}
    picker={<MediaPanel toolbar={error ? <p role="alert" className="error-message" data-scene-inputs-error>{error}</p> : undefined} selected={picked} onSelect={setPicked} roots={roots}
      controls={{ query, onQuery: setQuery, sort, onSort: setSort, view, onView: setView, type, onType: setType }}/>}>
    <ReferencesPanel manager={family !== 'ltx-2'} frames={{ ...frames, onRemove: role => emit({ [role]: null }) }}
      assignment={<ReferenceAssignmentBar selected={picked} actions={actions}>{inputs?.source && <div className="reference-role-chip" data-video-role-card="source"><span>{t('studio.run.video.roles.source')}</span><strong title={inputs.source.path}>{fileName(inputs.source.path)}</strong><button type="button" data-video-role-remove="source" aria-label={t('studio.run.video.roles.remove', { role: t('studio.run.video.roles.source') })} onClick={() => emit({ source: null })}>×</button></div>}</ReferenceAssignmentBar>}
      endpoint={endpoint} root={root} refs={refs} onChange={next => emit({ refs: next })} family={family} seconds={seconds}
      label={(r, i) => family === 'ltx-2' ? t('studio.run.video.mark.at', { second: String(r.second) }) : tags[i]} onAdd={add} onInsert={onInsert} inputRoot={roots?.input} outputRoot={roots?.output}/>
  </ReferencesOverlay>;
}
