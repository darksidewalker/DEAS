import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
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

/** Which pinned Hunspell pair exists for a language; read-only, no network. */
export interface SpellcheckDictionaryInfo {
 available: boolean;
 license?: string | null;
 bytes?: number | null;
}
export async function readSpellcheckDictionaryInfo(language: string): Promise<SpellcheckDictionaryInfo> {
 if (!isTauri()) return { available: false };
 return invoke<SpellcheckDictionaryInfo>('native_spellcheck_dictionary_info', { language });
}

/** Explicit install into the user-level Enchant path; `loaded:false` means a restart is required. */
export interface SpellcheckDictionary {
 path: string;
 license: string;
 loaded: boolean;
}
export async function installSpellcheckDictionary(language: string, enabled: boolean): Promise<SpellcheckDictionary> {
 const result = await invoke<SpellcheckDictionary>('native_spellcheck_dictionary_install', { language, enabled });
 reportPromptSpellcheckError(result.loaded ? '' : 'settings.prompt.dictionaryRestart');
 return result;
}
