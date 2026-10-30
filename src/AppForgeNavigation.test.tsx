import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import App from './App';
import type { WorkbenchProps } from './features/studio/Workbench';
import { I18nProvider, LOCALE_STORAGE_KEY } from './i18n/I18nProvider';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:()=>false}));
vi.mock('./lib/downloads',async original=>({...await original<typeof import('./lib/downloads')>(),readAuthStatus:async()=>[]}));
vi.mock('./features/forge/PromptForge',()=>({PromptForge:()=> <div data-standalone-forge>Standalone writer</div>}));
vi.mock('./features/studio/Workbench',()=>({Workbench:({onOpenPromptForge,onH3ForgeAvailable,forgeHost}:WorkbenchProps)=>{
 useEffect(()=>onH3ForgeAvailable?.(true),[onH3ForgeAvailable]);
 return <><button onClick={onOpenPromptForge}>Open H3 Forge</button>{forgeHost&&createPortal(<input aria-label="Retained H3 draft" defaultValue="draft"/>,forgeHost)}</>;
}}));
afterEach(()=>{cleanup();localStorage.clear();});

test('H3 settings navigate to the existing retained Prompt Forge tab, not a second popup',()=>{
 localStorage.setItem(LOCALE_STORAGE_KEY,'en');
 render(<I18nProvider><App/></I18nProvider>);
 fireEvent.click(screen.getByRole('tab',{name:'Studio'}));
 fireEvent.click(screen.getByRole('button',{name:'Open H3 Forge'}));
 expect(screen.getByRole('tab',{name:'Prompt Forge',selected:true})).toBeTruthy();
 expect(screen.getByText('Standalone writer').closest('[hidden]')).toBeTruthy();
 const draft=screen.getByRole('textbox',{name:'Retained H3 draft'});
 fireEvent.change(draft,{target:{value:'kept across navigation'}});
 fireEvent.click(screen.getByRole('tab',{name:'Studio'}));
 fireEvent.click(screen.getByRole('tab',{name:'Prompt Forge'}));
 expect(screen.getByRole('textbox',{name:'Retained H3 draft'})).toBe(draft);
 expect(draft).toHaveProperty('value','kept across navigation');
 expect(screen.queryByRole('dialog',{name:'Prompt Forge'})).toBeNull();
});
