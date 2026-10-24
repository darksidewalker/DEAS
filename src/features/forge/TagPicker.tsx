import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { characterTraits, forgeError, tagSearch, type TagSuggestion } from '../../lib/forge';

export interface PickedTag { tag: string; category: string; weight: number }
export interface WeightRange { min: number; max: number; step: number; default: number }
/** As PromptForge sends them: a weight of 1 is the bare tag. */
export const weighted = (t: PickedTag) => t.weight === 1 ? t.tag : `(${t.tag}:${t.weight.toFixed(2)})`;

/**
 * PromptForge's tag builder: search the local tag database as you type, pick into pills (kept exactly in the prompt),
 * weight a pill, and a picked character's traits from the local table to click in. No online lookups.
 */
export function TagPicker({ root, target, tags, onTags, weightRange }: { root: string; target: string; tags: PickedTag[]; onTags: (tags: PickedTag[]) => void; weightRange?: WeightRange | null }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TagSuggestion[]>([]);
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(-1);
  const [character, setCharacter] = useState<{ name: string; traits: string[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); return; }
    let alive = true;
    const timer = setTimeout(() => tagSearch(root, target, q).then(v => { if (alive) { setHits(v); setCursor(0); } }, e => { if (alive) setError(forgeError(e)); }), 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, root, target]);

  const has = (tag: string) => tags.some(x => x.tag === tag);
  const add = (list: PickedTag[]) => onTags([...tags, ...list.filter((x, i) => !has(x.tag) && list.findIndex(y => y.tag === x.tag) === i)]);
  const pick = (hit: TagSuggestion) => {
    add([{ tag: hit.tag, category: hit.category, weight: weightRange?.default ?? 1 }]);
    setQuery(''); setHits([]); setError('');
    if (hit.category === 'character') characterTraits(root, target, hit.tag).then(traits => setCharacter({ name: hit.tag, traits }), e => setError(forgeError(e)));
  };
  const remove = (i: number) => { onTags(tags.filter((_, j) => j !== i)); setActive(a => a === i ? -1 : a > i ? a - 1 : a); };
  const weigh = (w: number) => onTags(tags.map((x, i) => i === active ? { ...x, weight: w } : x));

  return <div className="forge-tagpicker">
    <div className="forge-tagsearch">
      <input type="text" data-forge-tag-search value={query} autoComplete="off" placeholder={t('forge.tags.search')} aria-label={t('forge.tags.search')}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (!hits.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((cursor + 1) % hits.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((cursor - 1 + hits.length) % hits.length); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(hits[cursor]); }
          else if (e.key === 'Escape') setHits([]);
        }}/>
      {hits.length > 0 && <ul className="forge-suggest" role="listbox" aria-label={t('forge.tags.search')}>
        {hits.map((h, i) => <li key={h.tag} role="option" aria-selected={i === cursor} data-forge-suggest={h.tag} className={`cat-${h.category}`} onMouseDown={e => { e.preventDefault(); pick(h); }}>
          <span>{h.tag}</span><em>{h.category} · {h.count.toLocaleString()}</em>
        </li>)}
      </ul>}
    </div>
    {tags.length > 0 && <div className="forge-pills-head">
      <span className="forge-note">{t('forge.tags.count', { count: String(tags.length) })}</span>
      <button type="button" className="forge-ghost" data-forge-tags-clear onClick={() => { onTags([]); setActive(-1); }}>{t('forge.random.clear')}</button>
    </div>}
    <div className="forge-pills">{tags.map((x, i) => <span key={x.tag} className={`forge-pill cat-${x.category}${i === active ? ' active' : ''}`} data-forge-pill={x.tag}>
      <button type="button" className="forge-pill-label" title={weightRange ? t('forge.tags.weighHelp') : undefined} onClick={() => setActive(i === active ? -1 : i)}>{weighted(x)}</button>
      <button type="button" className="forge-pill-remove" aria-label={t('forge.tags.remove', { tag: x.tag })} onClick={() => remove(i)}>×</button>
    </span>)}</div>
    {weightRange && active >= 0 && tags[active] && <label className="forge-ladder">
      <span className="forge-ladder-head"><span>{t('forge.tags.weight')} · {tags[active].tag}</span><output className="forge-ladder-readout">{tags[active].weight.toFixed(2)}</output></span>
      <input type="range" data-forge-tag-weight min={weightRange.min} max={weightRange.max} step={weightRange.step} value={tags[active].weight} onChange={e => weigh(Number(e.target.value))}/>
    </label>}
    {character && <div className="forge-traits" data-forge-traits={character.name}>
      <div className="forge-pills-head">
        <span className="forge-note">{character.traits.length ? t('forge.tags.traits', { name: character.name }) : t('forge.tags.noTraits', { name: character.name })}</span>
        {character.traits.length > 0 && <button type="button" className="forge-ghost" data-forge-traits-all disabled={character.traits.every(has)} onClick={() => add(character.traits.map(tag => ({ tag, category: 'general', weight: weightRange?.default ?? 1 })))}>{t('forge.tags.addAll')}</button>}
      </div>
      <div className="forge-pills">{character.traits.map(tag => <button key={tag} type="button" className="forge-chip forge-trait" data-forge-trait={tag} disabled={has(tag)} onClick={() => add([{ tag, category: 'general', weight: weightRange?.default ?? 1 }])}>{tag}</button>)}</div>
    </div>}
    {error && <p className="error-message" role="alert">{t(error)}</p>}
  </div>;
}
