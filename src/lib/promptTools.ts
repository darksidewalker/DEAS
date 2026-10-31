import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { readPref, writePref } from './preferences';

interface PromptTools { spellcheck: boolean; autocomplete: boolean; language: string }
const KEY = 'prompt.tools';
const EVENT = 'deas:prompt-tools';
const STATUS_EVENT = 'deas:prompt-spellcheck-status';
/** Fired after a dictionary install so open prompt fields re-check their words. */
export const DICTIONARY_EVENT = 'deas:spellcheck-dictionary';
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

/** Pinned-pair status for a language; read-only, no network. */
export interface SpellcheckStatus {
 available: boolean;
 installed: boolean;
 license?: string | null;
 bytes?: number | null;
}
export async function readSpellcheckStatus(language: string): Promise<SpellcheckStatus> {
 if (!isTauri()) return { available: false, installed: false };
 return invoke<SpellcheckStatus>('native_spellcheck_status', { language });
}

/** Explicit install into the DEAS dictionary folder; the engine picks it up on the next check. */
export interface SpellcheckDictionary { path: string; license: string }
export async function installSpellcheckDictionary(language: string): Promise<SpellcheckDictionary> {
 const result = await invoke<SpellcheckDictionary>('native_spellcheck_install', { language });
 reportPromptSpellcheckError('');
 window.dispatchEvent(new Event(DICTIONARY_EVENT));
 return result;
}

/** Words the installed dictionary does not know; bounded by the native side. */
export const spellcheckWords = (language: string, words: string[]) => invoke<string[]>('native_spellcheck_check', { language, words });
export const spellcheckSuggest = (language: string, word: string) => invoke<string[]>('native_spellcheck_suggest', { language, word });
