import { useEffect, useState } from 'react';
import { readPref, writePref } from './preferences';

interface PromptTools { spellcheck: boolean; autocomplete: boolean; language: string }
const KEY = 'prompt.tools';
const EVENT = 'deas:prompt-tools';
const STATUS_EVENT = 'deas:prompt-spellcheck-status';
let spellcheckError = '';
export function reportPromptSpellcheckError(error: string) {
 spellcheckError = error;
 window.dispatchEvent(new Event(STATUS_EVENT));
}
const defaults: PromptTools = { spellcheck: true, autocomplete: false, language: '' };
const valid = (v: unknown): v is PromptTools => {
 if (!v || typeof v !== 'object') return false;
 const s = v as PromptTools;
 return typeof s.spellcheck === 'boolean' && typeof s.autocomplete === 'boolean' && typeof s.language === 'string' && ['', 'de', 'en', 'fr', 'ja', 'tr', 'zh'].includes(s.language);
};
/** Global writing aids stay independent of project drafts and the interface language. */
export function usePromptTools() {
 const system = new Intl.Locale(navigator.languages?.[0] || navigator.language || 'en');
 const systemLanguage = [system.language, system.script, system.region].filter(Boolean).join('-');
 const [settings, setSettings] = useState(() => readPref(KEY, defaults, valid));
 const [error, setError] = useState(spellcheckError);
 useEffect(() => {
  const changed = () => setError(spellcheckError);
  window.addEventListener(STATUS_EVENT, changed);
  return () => window.removeEventListener(STATUS_EVENT, changed);
 }, []);
 useEffect(() => {
  const changed = (e: Event) => { const next: unknown = (e as CustomEvent).detail; if (valid(next)) setSettings(next); };
  window.addEventListener(EVENT, changed);
  return () => window.removeEventListener(EVENT, changed);
 }, []);
 const update = (patch: Partial<PromptTools>) => {
  const next = { ...settings, ...patch };
  if (!valid(next)) return;
  writePref(KEY, next);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
 };
 return { ...settings, error, systemLanguage, language: settings.language || systemLanguage, languageChoice: settings.language, update };
}
