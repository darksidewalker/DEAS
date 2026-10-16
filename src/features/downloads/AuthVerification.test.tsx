import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { AuthPanel } from './DownloadPluginPanel';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:()=>true}));
const saved={providerId:'huggingface',configured:true,persisted:true};
beforeEach(()=>{localStorage.setItem('deas.locale.v1','en');vi.mocked(invoke).mockImplementation(async c=>c==='native_auth_status'?[saved]:saved);});
afterEach(()=>{cleanup();vi.resetAllMocks();});
const mount=()=>render(<I18nProvider><AuthPanel embedded/></I18nProvider>);
it('automatically checks a restored token and shows a checkmark only after provider confirmation',async()=>{
 let resolve!:(value:unknown)=>void;
 vi.mocked(invoke).mockImplementation(async c=>c==='native_auth_status'?[saved]:new Promise(r=>{resolve=r;}));
 mount();await screen.findByText('Checking token…');expect(document.querySelector('.auth-verified')).toBeNull();
 expect(invoke).toHaveBeenCalledWith('native_auth_verify',{providerId:'huggingface'});
 await act(async()=>resolve({providerId:'huggingface',status:'verified'}));
 expect(screen.getByText('Token verified')).toBeTruthy();expect(document.querySelector('.auth-verified')?.textContent).toContain('✓');
 expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('');
});
it.each([['rejected','Token rejected or access denied'],['unavailable','Token check unavailable; try again'],['unsupported','Automatic token check is not supported']])('does not show a checkmark for %s',async(status,label)=>{
 vi.mocked(invoke).mockImplementation(async c=>c==='native_auth_status'?[saved]:{providerId:'huggingface',status});
 mount();await screen.findByText(label);expect(document.querySelector('.auth-verified')).toBeNull();
});
it('checks a newly saved token and discards an older in-flight check',async()=>{
 let old!:(value:unknown)=>void;let latest!:(value:unknown)=>void;let checks=0;
 vi.mocked(invoke).mockImplementation(async c=>c==='native_auth_status'?[saved]:c==='native_auth_verify'?new Promise(r=>{if(++checks===1)old=r;else latest=r;}):saved);
 mount();await screen.findByText('Checking token…');
 fireEvent.change(screen.getByLabelText('Token'),{target:{value:'replacement-fixture'}});fireEvent.click(screen.getByRole('button',{name:'Save token'}));await act(async()=>{});
 expect(checks).toBe(2);await act(async()=>old({providerId:'huggingface',status:'verified'}));expect(document.querySelector('.auth-verified')).toBeNull();
 await act(async()=>latest({providerId:'huggingface',status:'rejected'}));expect(screen.getByText('Token rejected or access denied')).toBeTruthy();
});
