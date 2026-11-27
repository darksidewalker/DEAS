import { useEffect, type ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useFloatingPosition } from '../../components/useFloatingPosition';

export type MoviePanelKind = 'scene' | 'music' | 'film' | 'media';
/**
 * A non-blocking settings window in the detached prompt editor's style: it opens centered, moves by its title bar and resizes at the
 * corner; the page stays usable (no backdrop, no focus trap). Escape or × closes it; opening another card switches its content.
 */
export function MoviePanel({ title, kind, onClose, children }: { title: string; kind: MoviePanelKind; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const floating = useFloatingPosition<HTMLElement>();
  useEffect(() => {
    // A viewer or dialog on top takes Escape first.
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return <section ref={floating.ref} style={floating.style} className={`wb-prompt-overlay movie-panel is-${kind}`} role="dialog" aria-modal="false" aria-label={title} data-movie-panel={kind}>
    <header className="wb-prompt-overlay-bar movie-panel-head" onPointerDown={floating.onPointerDown} data-movie-panel-bar>
      <span>{title}</span>
      <button type="button" data-movie-panel-close aria-label={t('wizards.movie.panel.close')} title={t('wizards.movie.panel.close')} onClick={onClose}>✕</button>
    </header>
    <div className="movie-panel-body">{children}</div>
  </section>;
}
