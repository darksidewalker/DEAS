import { useEffect, useId, useRef } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { ContinuityPlanner, type ContinuityPlannerProps } from './ContinuityPlanner';
import './continuity-overlay.css';

export type ContinuityOverlayProps = ContinuityPlannerProps & { onClose: () => void };

export function ContinuityOverlay({ onClose, ...planner }: ContinuityOverlayProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    closeRef.current?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  const dismiss = () => {
    if (dialogRef.current?.open) dialogRef.current.close();
    onClose();
  };
  return <dialog ref={dialogRef} className="continuity-overlay" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className="continuity-overlay-header"><h2 id={titleId}>{t('studio.run.dock.continuity')}</h2>
      <button ref={closeRef} type="button" onClick={dismiss}>{t('studio.close')}</button>
    </header>
    <div className="continuity-overlay-body"><ContinuityPlanner {...planner}/></div>
  </dialog>;
}
