import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { installSpellcheckDictionary, readSpellcheckStatus, usePromptTools, type SpellcheckStatus } from '../../lib/promptTools';

/** Language follows the system until the user picks one; a custom pick is labelled and can be undone. */
export function LanguageSetting() {
 const {t,locale,setLocale,custom,systemLocale,followSystemLocale,languages}=useI18n();
 const tools=usePromptTools();
 const name=(id:string)=>languages.find(l=>l.id===id)?.name??id;
 // A missing dictionary offers its pinned Hunspell pair; nothing is fetched before the explicit click.
 const missing=tools.error==='settings.prompt.dictionaryMissing';
 const [status,setStatus]=useState<SpellcheckStatus|null>(null);
 const [installing,setInstalling]=useState(false);const [installed,setInstalled]=useState(false);const [failed,setFailed]=useState(false);
 useEffect(()=>{
  if(!missing||!isTauri()){setStatus(null);return;}
  let alive=true;
  readSpellcheckStatus(tools.language).then(info=>{if(alive)setStatus(info);},()=>{if(alive)setStatus(null);});
  return()=>{alive=false;};
 },[missing,tools.language]);
 const install=async()=>{
  if(!status?.available||installing)return;
  setInstalling(true);setFailed(false);setInstalled(false);
  try{await installSpellcheckDictionary(tools.language);setInstalled(true);}
  catch{setFailed(true);}
  finally{setInstalling(false);}
 };
 return <section className="feature-panel download-module language-setting">
  <div className="download-controls">
   <label>{t('app.language')}<select id="language-select" aria-label={t('app.language')} value={custom?locale:''} onChange={e=>e.target.value?setLocale(e.target.value):followSystemLocale()}>
    <option value="">{t('settings.language.system',{name:`${name(systemLocale)} (${systemLocale})`})}</option>
    {languages.map(l=><option key={l.id} value={l.id}>{l.name} ({l.id})</option>)}
   </select></label>
   <p className="field-help">{custom?<><strong className="language-custom">{t('settings.language.customTag')}</strong> {t('settings.language.custom',{name:name(systemLocale)})}</>:t('settings.language.auto')}</p>
   <label className="download-check"><input type="checkbox" checked={tools.spellcheck} onChange={e=>tools.update({spellcheck:e.target.checked})}/>{t('settings.prompt.spellcheck')}</label>
   <label>{t('settings.prompt.language')}<select aria-label={t('settings.prompt.language')} value={tools.languageChoice} onChange={e=>tools.update({language:e.target.value})}>
    <option value="">{t('settings.language.system',{name:tools.systemLanguage})}</option>
    {languages.map(l=><option key={l.id} value={l.id}>{l.name} ({l.id})</option>)}
   </select></label>
   <p className="field-help">{t('settings.prompt.spellcheckHelp')}</p>
   {missing&&status?.available&&<div className="spellcheck-dictionary"><button type="button" className="action-button" disabled={installing} onClick={()=>void install()}>{t(installing?'settings.spellcheck.installBusy':'settings.spellcheck.install')}</button><p className="field-help">{t('settings.spellcheck.installHelp',{language:tools.language,size:String(Math.max(1,Math.round((status.bytes??0)/1048576))),license:status.license??''})}</p></div>}
   {installed&&!tools.error&&<p role="status" className="field-help">{t('settings.spellcheck.installed')}</p>}
   {failed&&<p className="error-message" role="alert">{t('settings.spellcheck.failed')}</p>}
   {tools.error&&!missing&&<p className="error-message" role="alert">{t(tools.error)}</p>}
   <label className="download-check"><input type="checkbox" checked={tools.autocomplete} onChange={e=>tools.update({autocomplete:e.target.checked})}/>{t('settings.prompt.autocomplete')}</label>
   <p className="field-help">{t('settings.prompt.autocompleteHelp')}</p>
  </div>
 </section>;
}
