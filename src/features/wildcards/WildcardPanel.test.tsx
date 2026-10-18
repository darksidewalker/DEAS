import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { useState } from 'react';
import { I18nProvider } from '../../i18n/I18nProvider';
import { WildcardPanel } from './WildcardPanel';
import { defaultWildcard } from '../../lib/wildcard';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:()=>true}));
const library={categories:{Art:[{subject:'Lighting',booru_wildcards:['{red|blue} light'],nl_wildcards:['{Red|Blue} light.'],booru_presets:['cinematic'],nl_presets:['Cinematic.']}],'Negative Prompts':[{subject:'Blur',booru_presets:['blur']}]}};
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale','en');vi.mocked(invoke).mockResolvedValue(JSON.stringify(library));});
afterEach(()=>{cleanup();vi.clearAllMocks();});
function Harness(){const [rules,setRules]=useState(defaultWildcard);const [enabled,setEnabled]=useState(false);return <I18nProvider><WildcardPanel endpoint="http://127.0.0.1:7801" value={rules} onChange={setRules} enabled={enabled} onEnabled={setEnabled}/><output data-testid="rules">{JSON.stringify(rules)}</output></I18nProvider>;}
it('loads the original library, preserves independent preset/wildcard weights and explicit activation',async()=>{
 render(<Harness/>);
 fireEvent.click(await screen.findByText('Art'));
 fireEvent.click(screen.getByRole('checkbox',{name:'Lighting · Wildcards'}));
 fireEvent.change(screen.getByRole('spinbutton',{name:'Weight: Lighting · Wildcards'}),{target:{value:'1.2'}});
 fireEvent.click(screen.getByRole('checkbox',{name:'Lighting · Presets'}));
 expect(screen.getByText('Lighting · Wildcards ×1.2').parentElement?.textContent).toBe('Lighting · Wildcards ×1.2 {red|blue} light');
 expect(screen.getByText('Lighting · Presets').parentElement?.textContent).toBe('Lighting · Presets cinematic');
 fireEvent.click(screen.getByRole('checkbox',{name:'Active for generation'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'New picks on every generation'}));
 const r=JSON.parse(screen.getByTestId('rules').textContent!);
 expect(r.selection_state['Art/Lighting/wildcards']).toEqual({enabled:true,weight:1.2});
 expect(r.selection_state['Art/Lighting/presets']).toEqual({enabled:true,weight:1});
 expect(r.auto_reroll).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'New picks'}));
 expect(JSON.parse(screen.getByTestId('rules').textContent!).selection_state).toEqual(r.selection_state);
 expect(invoke).toHaveBeenCalledWith('native_wildcard_library',{baseUrl:'http://127.0.0.1:7801'});
});
it('shows a retryable library error, never a fake catalog',async()=>{
 vi.mocked(invoke).mockRejectedValueOnce('404 missing plugin');render(<Harness/>);
 expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('404'));
 fireEvent.click(screen.getByRole('button',{name:'Reload library'}));
 await screen.findByText('Art');
});
it('random selection chooses available subjects without changing rule modes',async()=>{
 render(<Harness/>);await screen.findByText('Art');
 fireEvent.click(screen.getByRole('button',{name:'Random select'}));
 await waitFor(()=>expect(Object.keys(JSON.parse(screen.getByTestId('rules').textContent!).selection_state).length).toBeGreaterThan(0));
 const r=JSON.parse(screen.getByTestId('rules').textContent!);
 expect(r.auto_reroll).toBe(false);expect(r.seed).toBe(0);
 fireEvent.click(screen.getByRole('button',{name:'Clear selection'}));
 expect(JSON.parse(screen.getByTestId('rules').textContent!).selection_state).toEqual({});
});
