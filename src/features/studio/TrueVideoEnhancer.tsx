import { useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import type { VideoPostInspection } from '../../lib/videoPost';
import { VideoPostProcessing } from './VideoPostProcessing';
import { TveBackendEnhance } from './TveBackendEnhance';
import { MediaPanel } from '../media/MediaPanel';
import { mediaTypes, mediaViews, type MediaRoots, type MediaSort, type MediaType, type MediaView } from '../media/MediaLibrary';
import type { MediaItem } from '../../lib/media';
import { oneOf, usePref } from '../../lib/preferences';
import './TrueVideoEnhancer.css';

/** TVE tab: inspect a source (OS chooser or Media tile) and enhance it on the owned backend; the job joins the Studio queue. */
export function TrueVideoEnhancer({ endpoint = '', roots }: { endpoint?: string; roots?: MediaRoots } = {}) {
  const { t } = useI18n();
  const [source, setSource] = useState<VideoPostInspection | null>(null);
  const [picked, setPicked] = useState<MediaItem | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = usePref<MediaSort>('tve.media.sort', 'date', oneOf('date', 'name', 'size'));
  const [view, setView] = usePref<MediaView>('tve.media.view', 'tiles', oneOf(...mediaViews));
  const [type, setType] = usePref<MediaType>('tve.media.type', 'video', oneOf(...mediaTypes));
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  return <section className="tve" data-tve aria-label={t('studio.tve.title')}>
    <header className="tve-heading"><div><p className="eyebrow">{t('studio.tab.tve')}</p><h2>{t('studio.tve.title')}</h2></div></header>
    <div className="tve-columns">
      <section className="tve-panel"><h3>{t('studio.tve.source')}</h3>
        <VideoPostProcessing picked={picked} onInspected={setSource} disabled={busy} acquire={() => { if (pending.current) return false; pending.current = true; setBusy(true); return true; }} release={() => { pending.current = false; setBusy(false); }}/>
        {roots && <div className="tve-media" data-tve-media><p className="field-help">{t('studio.tve.pick')}</p><MediaPanel selected={picked} onSelect={item => { if (item?.media === 'video' && item.path && !busy) setPicked({ ...item }); }} roots={roots} controls={{ query, onQuery: setQuery, sort, onSort: setSort, view, onView: setView, type, onType: setType }}/></div>}
      </section>
      <TveBackendEnhance endpoint={endpoint} source={source} disabled={busy}/>
    </div>
  </section>;
}
