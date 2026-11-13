import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bundledCatalog, I18nProvider } from '../../i18n/I18nProvider';
import { matchEntries, searchIndex } from '../../lib/search';
import { GlobalSearch } from './GlobalSearch';

beforeEach(() => localStorage.setItem('deas.locale.v1', 'en'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.querySelectorAll('[data-num="steps"]').forEach((element) => element.remove());
});

const mount = (onNavigate = vi.fn()) => {
  render(<I18nProvider><GlobalSearch onNavigate={onNavigate} /></I18nProvider>);
  return onNavigate;
};

test('Ctrl+K opens the search, Escape closes it', () => {
  mount();
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const input = screen.getByPlaceholderText('Find a control…');
  expect(input).toBeTruthy();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByPlaceholderText('Find a control…')).toBeNull();
});

test('every indexed label, section and reason exists in all six languages', () => {
  for (const entry of searchIndex) {
    for (const key of [entry.tab, entry.section, entry.label, ...(entry.reason ? [entry.reason] : [])]) {
      for (const language of bundledCatalog.languages) {
        expect(bundledCatalog.dictionaries[language.id][key], `${language.id}:${key}`).toBeTypeOf('string');
      }
    }
  }
});

test('a hit switches tab, reveals and flashes the control; an unavailable hit shows its reason', async () => {
  const steps = document.createElement('input');
  steps.setAttribute('data-num', 'steps');
  document.body.appendChild(steps);
  const onNavigate = mount();
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  fireEvent.change(screen.getByPlaceholderText('Find a control…'), { target: { value: 'steps' } });
  fireEvent.click(screen.getByRole('button', { name: /Studio › Settings › Steps/ }));
  await waitFor(() => expect(steps.classList.contains('search-flash')).toBe(true));
  expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ view: 'studio', studioTab: 'generate', target: '[data-num="steps"]' }));

  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  fireEvent.change(screen.getByPlaceholderText('Find a control…'), { target: { value: 'checkpoint' } });
  fireEvent.click(screen.getByRole('button', { name: /Studio › Settings › Checkpoint/ }));
  expect(await screen.findByText('Requires a model from the backend', {}, { timeout: 3000 })).toBeTruthy();
});

test('Music source removal is searchable and expands hidden Settings without removing the source', async () => {
 const settings=document.createElement('aside');settings.hidden=true;
 const remove=document.createElement('button');remove.dataset.musicSourceRemove='';settings.append(remove);
 const toggle=document.createElement('button');toggle.dataset.paneToggle='settings';toggle.setAttribute('aria-expanded','false');
 toggle.onclick=()=>{settings.hidden=false;toggle.setAttribute('aria-expanded','true');};
 const removed=vi.fn();remove.onclick=removed;document.body.append(settings,toggle);
 mount();fireEvent.keyDown(window,{key:'k',ctrlKey:true});
 fireEvent.change(screen.getByPlaceholderText('Find a control…'),{target:{value:'Remove cover source'}});
 fireEvent.click(screen.getByRole('button',{name:/Studio › Cover source .* › Remove cover source/}));
 await waitFor(()=>expect(remove.classList.contains('search-flash')).toBe(true));expect(settings.hidden).toBe(false);expect(removed).not.toHaveBeenCalled();
 settings.remove();toggle.remove();
});


test('Music editors select Beginner Generate and reveal collapsed prompt and Settings without authoring', async()=>{
 const settings=document.createElement('aside');settings.hidden=true;
 const prompts=document.createElement('section');prompts.hidden=true;
 const lyrics=document.createElement('textarea');lyrics.dataset.musicPrompt='lyrics';lyrics.value='authored lyrics';prompts.append(lyrics);
 const toggles=['settings','prompt'].map((pane,i)=>{const toggle=document.createElement('button');toggle.dataset.paneToggle=pane;toggle.setAttribute('aria-expanded','false');toggle.onclick=()=>{(i?prompts:settings).hidden=false;toggle.setAttribute('aria-expanded','true');};return toggle;});
 document.body.append(settings,prompts,...toggles);const onNavigate=mount();
 fireEvent.keyDown(window,{key:'k',ctrlKey:true});fireEvent.change(screen.getByPlaceholderText('Find a control…'),{target:{value:'lyrics'}});
 fireEvent.click(screen.getByRole('button',{name:/Studio › Music \(Text to Music\) › Lyrics No verified/}));
 await waitFor(()=>expect(lyrics.classList.contains('search-flash')).toBe(true));expect(lyrics.value).toBe('authored lyrics');expect(prompts.hidden).toBe(false);expect(settings.hidden).toBe(false);
 expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({beginnerTab:'generate',target:'[data-music-prompt="lyrics"]'}));
 for(const el of [settings,prompts,...toggles])el.remove();
});

test('a disabled control shows its own explanation, then the entry reason', async () => {
  const cfg = document.createElement('input');
  cfg.setAttribute('data-num', 'cfg');
  cfg.disabled = true;
  cfg.setAttribute('title', 'Custom schedule fixes CFG');
  document.body.appendChild(cfg);
  mount();
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  fireEvent.change(screen.getByPlaceholderText('Find a control…'), { target: { value: 'cfg' } });
  fireEvent.click(screen.getByRole('button', { name: /Studio › Settings › CFG/ }));
  expect(await screen.findByText('Custom schedule fixes CFG', {}, { timeout: 3000 })).toBeTruthy();
  cfg.remove();
});

test('an Options dock card selects its dock tab first, then reveals the card; Backend actions and Options are indexed', async () => {
  const dock = document.createElement('button');
  dock.setAttribute('data-dock-tab', 'options');
  dock.setAttribute('aria-selected', 'false');
  const card = document.createElement('div');
  card.setAttribute('data-option', 'cache');
  card.hidden = true;
  // The card mounts only once its tab is selected, like the Workbench dock.
  dock.addEventListener('click', () => { dock.setAttribute('aria-selected', 'true'); card.hidden = false; });
  document.body.append(dock, card);
  const onNavigate = mount();
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  fireEvent.change(screen.getByPlaceholderText('Find a control…'), { target: { value: 'teacache' } });
  fireEvent.click(screen.getByRole('button', { name: /Studio › Options › Step cache/ }));
  await waitFor(() => expect(card.classList.contains('search-flash')).toBe(true));
  expect(dock.getAttribute('aria-selected')).toBe('true');
  expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ dockTab: 'options', target: '[data-option="cache"]' }));
  dock.remove(); card.remove();
  const text = (key: string) => bundledCatalog.dictionaries.en[key] ?? key;
  expect(matchEntries(searchIndex, 'stop', text).map((entry) => entry.target)).toContain('[data-backend-action="stop"]');
  expect(matchEntries(searchIndex, 'reinstall', text).map((entry) => entry.target)).toContain('[data-setup-action="reinstall"]');
  expect(matchEntries(searchIndex, 'spellcheck', text).map((entry) => entry.target)).toContain('[data-prompt-tool="spellcheck"]');
  expect(matchEntries(searchIndex, 'torch.compile', text).map((entry) => entry.target)).toContain('[data-option="compile"]');
  expect(matchEntries(searchIndex, 'tagger', text).map((entry) => entry.target)).toContain('[data-analysis-tagger]');
  expect(matchEntries(searchIndex, 'frame', text, searchIndex.length).map((entry) => entry.target)).toContain('[data-frame-use]');
  for(const role of ['first','last','both','reference','source'])expect(matchEntries(searchIndex, role, text, searchIndex.length).map(entry=>entry.target)).toContain(`[data-video-role="${role}"]`);
});

test('a Post-Processing nested control selects the Post dock, opens its category overlay idempotently, and focuses the control', async () => {
  const dock = document.createElement('button');
  dock.setAttribute('data-dock-tab', 'post');
  dock.setAttribute('aria-selected', 'false');
  const postRoot = document.createElement('div');
  postRoot.className = 'wb-post';
  postRoot.hidden = true;
  const card = document.createElement('button');
  card.setAttribute('data-post-card', 'derope');
  card.setAttribute('aria-expanded', 'false');
  const category = document.createElement('div');
  category.setAttribute('data-post-category', 'derope');
  category.hidden = true;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('data-derope', 'keep-background');
  category.appendChild(input);
  postRoot.append(card, category);
  dock.addEventListener('click', () => {
    dock.setAttribute('aria-selected', 'true');
    postRoot.hidden = false;
  });
  let cardClicks = 0;
  card.addEventListener('click', () => {
    cardClicks += 1;
    card.setAttribute('aria-expanded', 'true');
    category.hidden = false;
  });
  document.body.append(dock, postRoot);
  const onNavigate = mount();
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  fireEvent.change(screen.getByPlaceholderText('Find a control…'), { target: { value: 'keep static background' } });
  fireEvent.click(screen.getByRole('button', { name: /Studio › De-rope \(fast motion\) › Keep static background/ }));
  await waitFor(() => expect(input.classList.contains('search-flash')).toBe(true));
  expect(dock.getAttribute('aria-selected')).toBe('true');
  expect(card.getAttribute('aria-expanded')).toBe('true');
  expect(category.hidden).toBe(false);
  expect(cardClicks).toBe(1);
  expect(document.activeElement).toBe(input);
  expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ dockTab: 'post', target: '.wb-post [data-derope="keep-background"]' }));
  // Repeating the search while the Post dock and category overlay are already open keeps the overlay open and refocuses the control.
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  fireEvent.change(screen.getByPlaceholderText('Find a control…'), { target: { value: 'keep static background' } });
  fireEvent.click(screen.getByRole('button', { name: /Studio › De-rope \(fast motion\) › Keep static background/ }));
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(card.getAttribute('aria-expanded')).toBe('true');
  expect(category.hidden).toBe(false);
  expect(cardClicks).toBe(1);
  dock.remove();
  postRoot.remove();
});

test('matching uses the current language and English aliases, and stays read-only', () => {
  const text = (key: string) => `${bundledCatalog.dictionaries.en[key] ?? key} ${bundledCatalog.dictionaries.de[key] ?? key}`;
  expect(matchEntries(searchIndex, 'Ausführen', text).map((entry) => entry.target)).toContain('[data-run]');
  expect(matchEntries(searchIndex, 'prompt', text).length).toBeGreaterThan(0);
  expect(matchEntries(searchIndex, '', text)).toHaveLength(12);
  expect(localStorage.getItem('deas.locale.v1')).toBe('en');
});
