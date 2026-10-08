import { useI18n } from "../../i18n/I18nProvider";

/** Metadata badges never select an option or create another neural node. */
export function NeuralFlags({ suggested, detected }: {suggested?:boolean;detected?:boolean}) {
  const {t}=useI18n();
  return <span className="neural-flags">
    <span className={`neural-flag${detected ? "" : " neural-flag-reserved"}`} data-flag={detected ? "detected" : undefined} aria-hidden={detected ? undefined : true}>{t('neural.detected')}</span>
    <span className={`neural-flag${suggested ? "" : " neural-flag-reserved"}`} data-flag={suggested ? "suggested" : undefined} aria-hidden={suggested ? undefined : true}>{t('neural.suggested')}</span>
  </span>;
}
