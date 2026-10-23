import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { forgeError, randomizerList, randomizerRoll, type RandomizerBox, type RandomizerRolled } from '../../lib/forge';
import { usePref } from '../../lib/preferences';

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');

/**
 * PromptForge's Randomizer: tick categories, roll, and the result goes into the brief. No model is involved; it picks
 * from the owner's vocabulary (forge-data/randomizer.json) and the person edits what comes out.
 */
export function Randomizer({ root, onClose, onInsert }: { root: string; onClose: () => void; onInsert: (text: string, replace: boolean) => void }) {
  const { t } = useI18n();
  const [boxes, setBoxes] = useState<RandomizerBox[] | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [open, setOpen] = usePref<string[]>('forge.randomizer.open', [], isStrings);
  const [women, setWomen] = useState(0);
  const [men, setMen] = useState(0);
  const [chaos, setChaos] = useState(false);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [rolled, setRolled] = useState<RandomizerRolled | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    randomizerList(root).then(v => { if (alive) setBoxes(v); }, e => { if (alive) setError(forgeError(e)); });
    return () => { alive = false; };
  }, [root]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  // A box tick means everything in it; a box with some pieces ticked shows as part-ticked.
  const kidsOf = (b: RandomizerBox) => b.children.map(k => k.id);
  const isOn = (id: string, box: RandomizerBox) => ticked.includes(box.id) || ticked.includes(id);
  const tickBox = (box: RandomizerBox, on: boolean) => setTicked([...ticked.filter(id => id !== box.id && !kidsOf(box).includes(id)), ...(on ? [box.id] : [])]);
  const tickKid = (box: RandomizerBox, id: string, on: boolean) => {
    const kids = kidsOf(box);
    const now = new Set(ticked.includes(box.id) ? [...ticked.filter(x => x !== box.id), ...kids] : ticked);
    if (on) now.add(id); else now.delete(id);
    // Every piece ticked is the whole box.
    setTicked(kids.every(k => now.has(k)) ? [...[...now].filter(x => !kids.includes(x)), box.id] : [...now]);
  };
  const count = (box: RandomizerBox) => ticked.includes(box.id) ? box.children.length : box.children.filter(k => ticked.includes(k.id)).length;
  const picked = boxes?.reduce((n, b) => n + count(b), 0) ?? 0;

  const roll = async (surprise: boolean) => {
    setBusy(true); setError('');
    try {
      const out = await randomizerRoll(root, { categories: ticked, women, men, surprise, limits: chaos ? limits : {} });
      setRolled(out); setText(out.text);
    } catch (e) { setError(forgeError(e)); }
    finally { setBusy(false); }
  };
  const castPick = (label: string, value: number, set: (n: number) => void, name: string) =>
    <label className="forge-field forge-cast-pick"><span>{label}</span><select data-forge-random-cast={name} value={value} onChange={e => set(Number(e.target.value))}>
      {[0, 1, 2, 3, 4].map(n => <option key={n} value={n}>{n || '–'}</option>)}
    </select></label>;

  return <div className="forge-modal" role="dialog" aria-modal="true" aria-label={t('forge.random.title')} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="forge-card forge-random" data-forge-randomizer>
      <div className="forge-card-head">
        <h3 className="forge-card-title">{t('forge.random.title')}</h3>
        <button type="button" className="forge-ghost" data-forge-random-close onClick={onClose}>{t('forge.random.close')}</button>
      </div>
      <p className="forge-note">{t('forge.random.help')}</p>
      <div className="forge-random-cast">
        <span className="forge-group-label">{t('forge.random.characters')}</span>
        {castPick(t('forge.random.women'), women, setWomen, 'women')}
        {castPick(t('forge.random.men'), men, setMen, 'men')}
        <label className="forge-switch" title={t('forge.random.chaosHelp')}><input type="checkbox" data-forge-random-chaos checked={chaos} onChange={e => setChaos(e.target.checked)}/><span>{t('forge.random.chaos')}</span></label>
      </div>
      <div className="forge-random-tools">
        <button type="button" className="forge-ghost" onClick={() => setOpen([])}>{t('forge.random.collapse')}</button>
        <button type="button" className="forge-ghost" data-forge-random-clear disabled={!ticked.length} onClick={() => setTicked([])}>{t('forge.random.clear')}</button>
        <span className="forge-note">{t('forge.random.count', { count: String(picked) })}</span>
      </div>
      {!boxes && !error && <p className="forge-note">{t('forge.random.loading')}</p>}
      <div className="forge-random-grid">
        {boxes?.map(box => {
          const n = count(box), isOpen = open.includes(box.id);
          return <section key={box.id} className={`forge-rbox${isOpen ? ' open' : ''}${n ? ' on' : ''}`} data-forge-rbox={box.id}>
            <div className="forge-rbox-head">
              <input type="checkbox" aria-label={t('forge.random.all', { box: box.label })} data-forge-rparent={box.id} checked={n === box.children.length}
                ref={el => { if (el) el.indeterminate = n > 0 && n < box.children.length; }} onChange={e => tickBox(box, e.target.checked)}/>
              <button type="button" className="forge-rbox-toggle" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? open.filter(x => x !== box.id) : [...open, box.id])}>
                <span>{box.label}</span>
                <span className="forge-rbox-count">{n ? `${n}/${box.children.length}` : box.children.length}</span>
              </button>
              {chaos && n > 1 && <input type="number" className="forge-rbox-limit" aria-label={t('forge.random.limit', { box: box.label })} data-forge-rlimit={box.id} min={1} max={n} value={Math.min(limits[box.id] ?? n, n)} onChange={e => setLimits({ ...limits, [box.id]: Math.max(1, Number(e.target.value) || 1) })}/>}
            </div>
            {isOpen && <div className="forge-rbox-body">{box.children.map(k => <label key={k.id} className="forge-rkid">
              <input type="checkbox" data-forge-rkid={k.id} checked={isOn(k.id, box)} onChange={e => tickKid(box, k.id, e.target.checked)}/>
              <span>{k.label}</span><em>{k.options.toLocaleString()}</em>
            </label>)}</div>}
          </section>;
        })}
      </div>
      {rolled && <div className="forge-random-result" data-forge-random-result>
        <div className="forge-random-breakdown">{rolled.boxes.map(b => <p key={b.id}><strong>{b.label}</strong> {b.picks.map(p => p.text).join(' · ')}</p>)}</div>
        <label className="forge-field"><span>{t('forge.random.goesIn')}</span><textarea className="forge-short" data-forge-random-text value={text} onChange={e => setText(e.target.value)}/></label>
      </div>}
      {error && <p className="error-message" role="alert">{t(error)}</p>}
      <div className="forge-send">
        <button type="button" className="action-button" data-forge-random-roll disabled={busy || (!ticked.length && !women && !men)} onClick={() => void roll(false)}>{t('forge.random.roll')}</button>
        <button type="button" className="forge-ghost" data-forge-random-surprise disabled={busy} title={t('forge.random.surpriseHelp')} onClick={() => void roll(true)}>{t('forge.random.surprise')}</button>
        <button type="button" className="forge-ghost" data-forge-random-add disabled={!text.trim()} onClick={() => { onInsert(text.trim(), false); onClose(); }}>{t('forge.random.add')}</button>
        <button type="button" className="forge-ghost" data-forge-random-replace disabled={!text.trim()} onClick={() => { onInsert(text.trim(), true); onClose(); }}>{t('forge.random.replace')}</button>
      </div>
    </div>
  </div>;
}
