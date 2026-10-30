import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { LanguageSetting } from './LanguageSetting';
import { QuickSettings } from '../studio/QuickSettings';
import { usePromptTools, reportPromptSpellcheckError } from '../../lib/promptTools';
import { invoke, isTauri } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn(()=>false)}));
function Probe(){const tools=usePromptTools();return <output data-testid="tools">{JSON.stringify({language:tools.language,spellcheck:tools.spellcheck,autocomplete:tools.autocomplete})}</output>;}
beforeEach(()=>{vi.mocked(isTauri).mockReturnValue(false);vi.mocked(invoke).mockReset();reportPromptSpellcheckError('');localStorage.clear();localStorage.setItem('deas.locale.v1','en');});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const state=()=>JSON.parse(screen.getByTestId('tools').textContent!);
test('writing aids default to detected system language independently of UI; explicit choice persists and synchronizes quick settings',()=>{
 const view=render(<I18nProvider><LanguageSetting/><QuickSettings/><Probe/></I18nProvider>);
 const initialLanguage=state().language;
 expect(state()).toEqual({language:initialLanguage,spellcheck:true,autocomplete:false});
 fireEvent.change(screen.getByLabelText('Spellcheck language'),{target:{value:'fr'}});
 expect(state().language).toBe('fr');
 fireEvent.change(screen.getByLabelText('Language'),{target:{value:'de'}});
 expect(state().language).toBe('fr');
 fireEvent.click(screen.getByRole('button',{name:'Schnelleinstellungen'}));
 fireEvent.click(screen.getByRole('button',{name:'Tag-Autovervollständigung'}));
 expect(state().autocomplete).toBe(true);
 expect((screen.getByRole('checkbox',{name:'Tag-Autovervollständigung'}) as HTMLInputElement).checked).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Prompt-Rechtschreibprüfung'}));
 expect(state().spellcheck).toBe(false);
 view.unmount();
 render(<I18nProvider><LanguageSetting/><Probe/></I18nProvider>);
 expect(state()).toEqual({language:'fr',spellcheck:false,autocomplete:true});
 fireEvent.change(screen.getByLabelText('Sprache der Rechtschreibprüfung'),{target:{value:''}});
 expect(state().language).toBe(initialLanguage);
});
test.each(['es-ES','en-GB','zh-Hant-TW'])('system spelling locale keeps %s independently of bundled UI languages',language=>{
 vi.spyOn(navigator,'languages','get').mockReturnValue([language]);
 render(<I18nProvider><LanguageSetting/><Probe/></I18nProvider>);
 expect(state().language).toBe(language);
 const selector=screen.getByLabelText('Spellcheck language') as HTMLSelectElement;
 expect(selector.options[0].textContent).toContain(language);
});
test('native dictionary failure is localized under Backend and retries after a settings change',async()=>{
 vi.mocked(isTauri).mockReturnValue(true);
 vi.mocked(invoke).mockRejectedValueOnce('SPELLCHECK_DICTIONARY_MISSING').mockResolvedValue(null);
 render(<I18nProvider><LanguageSetting/><QuickSettings/></I18nProvider>);
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','No dictionary for the selected language is installed. Install its system spelling dictionary, then toggle spellcheck off/on.');
 fireEvent.click(screen.getByRole('button',{name:'Quick Settings'}));
 expect(screen.getAllByRole('alert')).toHaveLength(1);
 expect((screen.getByRole('button',{name:'Prompt spellcheck'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('Spellcheck language'),{target:{value:'fr'}});
 expect(invoke).toHaveBeenLastCalledWith('native_prompt_spellcheck',{enabled:true,language:'fr'});
 expect(screen.queryByRole('alert')).toBeNull();
});
test('corrupt saved writing settings fall back without breaking the interface',()=>{
 localStorage.setItem('deas.pref.prompt.tools',JSON.stringify({language:'../bad',spellcheck:true,autocomplete:true}));
 render(<I18nProvider><Probe/></I18nProvider>);
 expect(state().spellcheck).toBe(true);expect(state().autocomplete).toBe(false);
});
