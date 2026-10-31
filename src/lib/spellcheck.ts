import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { DICTIONARY_EVENT, spellcheckWords } from './promptTools';

export interface SpellMark { start: number; end: number; word: string }

// Letters with inner apostrophes/hyphens; digits, underscores and symbols never form a word,
// so tag-style prompts (`1girl`, `long_hair`) are not flagged as a whole.
const WORD = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;
const MIN_LETTERS = 2;
const BATCH = 2000;
const DEBOUNCE_MS = 300;

export function tokenize(text: string): SpellMark[] {
  const marks: SpellMark[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    if (word.length < MIN_LETTERS || word === word.toUpperCase()) continue; // acronyms / ALLCAPS tags
    marks.push({ start: match.index, end: match.index + word.length, word });
  }
  return marks;
}

// Per-language verdict cache; words never leave the cache within a session, so re-typing is free.
const verdicts = new Map<string, Map<string, boolean>>();
export function resetSpellcheckCache() { verdicts.clear(); }
const cache = (language: string) => { let map = verdicts.get(language); if (!map) { map = new Map(); verdicts.set(language, map); } return map; };

/** Misspelled ranges of `text` in `language`, or an empty list while disabled/unavailable. */
export function useSpellcheck(text: string, language: string, enabled: boolean): SpellMark[] {
  const [marks, setMarks] = useState<SpellMark[]>([]);
  const [generation, setGeneration] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    const bump = () => { resetSpellcheckCache(); setGeneration(n => n + 1); };
    window.addEventListener(DICTIONARY_EVENT, bump);
    return () => window.removeEventListener(DICTIONARY_EVENT, bump);
  }, []);
  useEffect(() => {
    const request = ++latest.current;
    if (!enabled || !isTauri() || !text) { setMarks([]); return; }
    const known = cache(language);
    const tokens = tokenize(text);
    const unknown = [...new Set(tokens.filter(m => !known.has(m.word)).map(m => m.word))].slice(0, BATCH);
    const apply = () => { if (latest.current === request) setMarks(tokens.filter(m => known.get(m.word) === false)); };
    if (!unknown.length) { apply(); return; }
    const timer = setTimeout(() => {
      spellcheckWords(language, unknown).then(bad => {
        if (!Array.isArray(bad)) { if (latest.current === request) setMarks([]); return; } // malformed IPC answer: no verdicts
        const flagged = new Set(bad);
        for (const word of unknown) known.set(word, !flagged.has(word));
        apply();
      }, () => { if (latest.current === request) setMarks([]); }); // missing dictionary: no marks, Backend explains
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, language, enabled, generation]);
  return marks;
}
