import { useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import type { MediaKind } from '../../lib/media';
import { NativeVideo, nativeVideo } from '../studio/NativeVideo';
import { ImageViewer } from '../studio/ImageViewer';

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const kindOf = (path: string): MediaKind => /\.(mp4|webm|mkv|mov|m4v)$/i.test(path) ? 'video' : /\.(wav|mp3|flac|ogg|opus|m4a|aac|wma)$/i.test(path) ? 'audio' : 'image';

/**
 * Plays or shows one file the way Generate's preview does: clips and sound through the native player in the Linux app (WebKitGTK's
 * own `<video>` cannot be relied on) and the HTML elements elsewhere; a picture is shown whole and opens the full-window viewer.
 */
export function MoviePlayer({ path, media = kindOf(path), toSrc, label, ...data }: { path: string; media?: MediaKind; toSrc: (p: string) => string; label?: string } & Record<`data-${string}`, string | boolean | undefined>) {
  const { t } = useI18n();
  const [viewing, setViewing] = useState(false);
  const name = label ?? fileName(path), src = toSrc(path), native = nativeVideo();
  return <figure className={`movie-player is-${media}`} {...data}>
    {media === 'image' && <button type="button" className="movie-player-picture" aria-label={t('studio.run.viewer.open')} title={t('studio.run.viewer.open')} onClick={() => setViewing(true)}><img src={src} alt={name} draggable={false}/></button>}
    {media === 'video' && (native ? <NativeVideo key={path} source={{ path }} label={name} active/> : <video key={path} src={src} controls preload="metadata" aria-label={name}/>)}
    {media === 'audio' && (native ? <NativeVideo key={path} source={{ path }} label={name} active audioOnly/> : <audio key={path} src={src} controls aria-label={name}/>)}
    <figcaption className="forge-note wizards-name" title={path}>{name}</figcaption>
    {viewing && <ImageViewer src={src} alt={name} onClose={() => setViewing(false)}/>}
  </figure>;
}
