import { invoke } from '@tauri-apps/api/core';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { usePref, oneOf } from '../../lib/preferences';
import type { WildcardPacks } from './useWildcardPacks';
import './wildcards.css';

const tabs = ['library', 'mine'] as const;
const isTab = oneOf(...tabs);
type Props = {
  library: ReactNode;
  catalog: WildcardPacks;
  native: boolean;
  seed: number;
  seedMode: 'random' | 'fixed';
  onSeed: (seed: number) => void;
  onSeedMode: (mode: 'random' | 'fixed') => void;
  onReroll: () => void;
  onInsert: (token: string, side: 'positive' | 'negative') => void;
};

export function WildcardTabs({ library, ...browser }: Props) {
  const { t } = useI18n();
  const id = useId();
  const [tab, setTab] = usePref('studio.wildcardTab', 'library', isTab);
  return <div className="wildcard-workspace">
    <div className="wb-dock-tabs wildcard-tabs" role="tablist" aria-label={t('wildcards.title')} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'library' : event.key === 'End' ? 'mine' : tab === 'library' ? 'mine' : 'library';
      setTab(next);
      document.getElementById(`${id}-${next}`)?.focus();
    }}>
      {tabs.map(name => <button key={name} type="button" role="tab" id={`${id}-${name}`}
        aria-selected={tab === name} aria-controls={`${id}-panel-${name}`}
        tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)}>{t(`wildpacks.${name}`)}</button>)}
    </div>
    <div role="tabpanel" id={`${id}-panel-library`} aria-labelledby={`${id}-library`} hidden={tab !== 'library'}>
      {tab === 'library' && library}
    </div>
    <div role="tabpanel" id={`${id}-panel-mine`} aria-labelledby={`${id}-mine`} hidden={tab !== 'mine'}>
      {tab === 'mine' && <PackBrowser {...browser}/>}
    </div>
  </div>;
}

type Pack = WildcardPacks['packs'][number];
type Folder = {
  id: string;
  name: string;
  path: string;
  pack: Pack;
  children: Map<string, Folder>;
};
type List = { name: string; label: string; count: number; folder: Folder };

function organizePacks(packs: Pack[]) {
  const folders = new Map<string, Folder>();
  const lists: List[] = [];
  const roots = packs.map(pack => {
    const root: Folder = { id: pack.id, name: pack.name, path: '', pack, children: new Map() };
    folders.set(root.id, root);
    for (const [name, count] of Object.entries(pack.lists)) {
      const segments = name.split('/');
      const label = segments.pop()!;
      let folder = root;
      for (const segment of segments) {
        let child = folder.children.get(segment);
        if (!child) {
          const path = folder.path ? `${folder.path}/${segment}` : segment;
          child = { id: `${pack.id}:${path}`, name: segment, path, pack, children: new Map() };
          folder.children.set(segment, child);
          folders.set(child.id, child);
        }
        folder = child;
      }
      lists.push({ name, label, count, folder });
    }
    return root;
  });
  return { roots, folders, lists };
}

function PackBrowser({ catalog, native, seed, seedMode, onSeed, onSeedMode, onReroll, onInsert }: Omit<Props, 'library'>) {
  const { t } = useI18n();
  const { packs, preview, pending, error, loading, importing, importError, importFolder, removePack } = catalog;
  const [search, setSearch] = useState('');
  const [folderId, setFolderId] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedName, setSelectedName] = useState('');
  const [removing, setRemoving] = useState('');
  const { roots, folders, lists } = useMemo(() => organizePacks(packs), [packs]);
  const folder = folders.get(folderId);
  const query = search.trim().toLocaleLowerCase();
  const filtered = lists.filter(item => {
    const inScope = !folder || item.folder.id === folder.id || (!!query && item.folder.pack.id === folder.pack.id
      && (!folder.path || item.folder.path.startsWith(`${folder.path}/`)));
    return inScope && item.name.toLocaleLowerCase().includes(query);
  });
  const selected = filtered.find(item => item.name === selectedName) ?? filtered[0];
  const removingPack = packs.find(pack => pack.id === removing);
  const startImport = () => void importFolder(t('wildpacks.import'));
  const promptPreview = <div className="wildpacks-preview">
    <h3>{t('wildcards.preview')}</h3>
    {pending ? <p role="status">{t('wildpacks.resolving')}</p>
      : error ? <p className="error-message" role="alert">{error}</p>
      : preview ? <>
        <p><strong>{t('wildcards.positive')}</strong><span>{preview.positive}</span></p>
        {preview.negative && <p><strong>{t('wildcards.negative')}</strong><span>{preview.negative}</span></p>}
      </> : <p>{t('wildpacks.previewEmpty')}</p>}
  </div>;

  function folderRow(branch: Folder): ReactNode {
    const hasChildren = branch.children.size > 0;
    const open = expanded[branch.id] ?? !branch.path;
    const children = Array.from(branch.children.values()).sort((a, b) => a.name.localeCompare(b.name));
    return <li key={branch.id}>
      <div className="wildpacks-folder-row">
        {hasChildren ? <button type="button" className="wildpacks-folder-toggle" aria-expanded={open}
          aria-label={t(open ? 'wildpacks.collapse' : 'wildpacks.expand', { name: branch.name })}
          onClick={() => setExpanded(current => ({ ...current, [branch.id]: !open }))}>
          <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button> : <span className="wildpacks-folder-toggle" aria-hidden="true"/>}
        <button type="button" className="wildpacks-folder-name" aria-pressed={folderId === branch.id}
          title={branch.path || branch.name} onClick={() => {
            setFolderId(branch.id);
            if (hasChildren) setExpanded(current => ({ ...current, [branch.id]: true }));
          }}>{branch.name}</button>
        {!branch.path && <button type="button" className="wildpacks-remove" disabled={importing}
          aria-label={t('wildpacks.remove', { name: branch.name })} title={t('wildpacks.remove', { name: branch.name })}
          onClick={() => setRemoving(branch.pack.id)}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>}
      </div>
      {hasChildren && open && <ul>{children.map(folderRow)}</ul>}
    </li>;
  }

  return <section className="wildpacks" aria-label={t('wildpacks.mine')}>
    <div className="wildcard-toolbar wildpacks-toolbar">
      <button type="button" disabled={!native || importing || loading} onClick={startImport}>{t(importing ? 'wildpacks.importing' : 'wildpacks.import')}</button>
      <label>{t('wildcards.seed')}<input type="number" min={0} max={0xffffffff} step={1} value={seed}
        onChange={event => { const next = Number(event.target.value); if (Number.isInteger(next) && next >= 0 && next <= 0xffffffff) onSeed(next); }}/></label>
      <div className="wb-seed-row" role="group" aria-label={t('wildcards.seed')}>
        {(['random', 'fixed'] as const).map(mode => <button key={mode} type="button"
          aria-pressed={seedMode === mode} onClick={() => onSeedMode(mode)}>{t(`studio.run.seedMode.${mode}`)}</button>)}
      </div>
      <button type="button" onClick={onReroll}>{t('wildpacks.reroll')}</button>
      {packs.length > 0 && <label>{t('wildpacks.search')}<input type="search" value={search} onChange={event => setSearch(event.target.value)}/></label>}
    </div>
    {importError && <p className="error-message" role="alert">{importError}</p>}
    {!packs.length ? <>
      <p className="wildpacks-empty" role={loading ? 'status' : undefined}>{t(loading ? 'wildcards.loading' : 'wildpacks.empty')}</p>
      {promptPreview}
    </> : <div className="wildpacks-grid">
      <nav className="wildpacks-folders" aria-label={t('wildpacks.folders')}>
        <h3>{t('wildpacks.folders')}</h3>
        <button type="button" className="wildpacks-all" aria-pressed={!folder} onClick={() => setFolderId('')}>{t('wildpacks.all')}</button>
        <ul className="wildpacks-tree">{roots.map(folderRow)}</ul>
      </nav>
      <nav className="wildpacks-browser" aria-label={t('wildpacks.lists')}>
        <h3>{t('wildpacks.lists')}</h3>
        {folder && <small className="wildpacks-path" title={folder.path}>{folder.pack.name}{folder.path && ` / ${folder.path}`}</small>}
        {!filtered.length && <p className="wildpacks-empty">{t(query ? 'wildpacks.noMatch' : 'wildpacks.emptyFolder')}</p>}
        <ul className="wildpacks-list">
          {filtered.map(item => <li key={item.name}>
            <button type="button" title={item.name} aria-pressed={selected?.name === item.name} onClick={() => setSelectedName(item.name)}>
              <span>{folder && !query ? item.label : item.name}</span><small>{item.count}</small>
            </button>
          </li>)}
        </ul>
      </nav>
      <div className="wildpacks-detail">
        {selected && <>
          <h3><code>{`__${selected.name}__`}</code></h3>
          <div className="wildcard-toolbar">
            <button type="button" onClick={() => onInsert(`__${selected.name}__`, 'positive')}>{t('wildpacks.insertPositive')}</button>
            <button type="button" onClick={() => onInsert(`__${selected.name}__`, 'negative')}>{t('wildpacks.insertNegative')}</button>
          </div>
          <WildcardChoices key={selected.name} name={selected.name} count={selected.count} revision={packs}/>
        </>}
        {promptPreview}
      </div>
    </div>}
    {removingPack && <ConfirmDialog focusCancel message={t('wildpacks.confirmRemove', { name: removingPack.name })}
      onDone={confirmed => { if (confirmed) void removePack(removingPack.id); setRemoving(''); }}/>}
  </section>;
}

function WildcardChoices({ name, count, revision }: { name: string; count: number; revision: Pack[] }) {
  const { t } = useI18n();
  const pageSize = 100;
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const offset = Math.min(page * pageSize, Math.floor((count - 1) / pageSize) * pageSize);
  const [result, setResult] = useState<{ offset: number; revision: Pack[]; choices?: string[]; error?: string }>();

  useEffect(() => {
    if (!open) return;
    let live = true;
    void invoke<string[]>('native_wildcard_choices', { name, offset }).then(
      choices => { if (live) setResult({ offset, revision, choices }); },
      error => { if (live) setResult({ offset, revision, error: String(error) }); },
    );
    return () => { live = false; };
  }, [name, offset, open, revision]);

  const current = result?.offset === offset && result.revision === revision ? result : undefined;
  return <details className="wildpacks-choices" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t('wildpacks.choices', { count })}</summary>
    {open && <>
      {count > pageSize && <div className="wildcard-toolbar wildpacks-choice-pages">
        <button type="button" disabled={offset === 0} onClick={() => setPage(offset / pageSize - 1)}>{t('wildpacks.previous')}</button>
        <small>{offset + 1}–{Math.min(offset + pageSize, count)} / {count}</small>
        <button type="button" disabled={offset + pageSize >= count} onClick={() => setPage(offset / pageSize + 1)}>{t('wildpacks.next')}</button>
      </div>}
      {current?.error ? <p className="error-message" role="alert">{current.error}</p>
        : current?.choices ? <ul>{current.choices.map((choice, i) => <li key={i}>{choice}</li>)}</ul>
        : <p role="status">{t('wildpacks.loadingChoices')}</p>}
    </>}
  </details>;
}
