import { useI18n } from '../../i18n/I18nProvider';

/** Language follows the system until the user picks one; a custom pick is labelled and can be undone. */
export function LanguageSetting() {
 const {t,locale,setLocale,custom,systemLocale,followSystemLocale,languages}=useI18n();
 const name=(id:string)=>languages.find(l=>l.id===id)?.name??id;
 return <section className="feature-panel download-module language-setting">
  <div className="download-controls">
   <label>{t('app.language')}<select id="language-select" aria-label={t('app.language')} value={custom?locale:''} onChange={e=>e.target.value?setLocale(e.target.value):followSystemLocale()}>
    <option value="">{t('settings.language.system',{name:`${name(systemLocale)} (${systemLocale})`})}</option>
    {languages.map(l=><option key={l.id} value={l.id}>{l.name} ({l.id})</option>)}
   </select></label>
   <p className="field-help">{custom?<><strong className="language-custom">{t('settings.language.customTag')}</strong> {t('settings.language.custom',{name:name(systemLocale)})}</>:t('settings.language.auto')}</p>
  </div>
 </section>;
}
