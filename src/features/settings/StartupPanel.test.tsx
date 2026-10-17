import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { StartupPanel } from './StartupPanel';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn(()=>true)}));
let job:unknown=null;
const presets={speed:{flags:['--use-ck-attention'],fast:['fp16_accumulation','autotune']},compatibility:{flags:[],fast:['autotune']},off:{flags:[],fast:[]}};
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(true);job=null;
 vi.mocked(invoke).mockImplementation(async(c,a)=>c==='native_startup_read'?{startup:{preset:'speed',flags:[],fast:[]},packages:[],presets}:c==='native_job_current'?job:(a as {startup:unknown}).startup);});
afterEach(()=>{cleanup();vi.resetAllMocks();});
const mount=(onRestart=vi.fn())=>{render(<I18nProvider><StartupPanel root="/env" onRestart={onRestart}/></I18nProvider>);return onRestart;};

it('defaults to Speed+, shows its resolved flags and saves presets by name', async()=>{
 const onRestart=mount();
 const attention=await screen.findByRole('combobox',{name:'Attention backend'}) as HTMLSelectElement;
 expect(screen.getByRole('button',{name:'Speed+'}).getAttribute('aria-pressed')).toBe('true');
 expect(attention.value).toBe('--use-ck-attention');
 expect((screen.getByRole('checkbox',{name:/^Autotune/}) as HTMLInputElement).checked).toBe(true);
 const apply=screen.getByRole('button',{name:'Apply (restarts backend)'}) as HTMLButtonElement;
 expect(apply.disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Optimizations off'}));
 expect(attention.value).toBe('');
 fireEvent.click(apply);
 await screen.findByText(/^Saved\. A running backend restarts/);
 expect(vi.mocked(invoke)).toHaveBeenCalledWith('native_startup_write',{root:'/env',startup:{preset:'off',flags:[],fast:[]}});
 expect(onRestart).toHaveBeenCalledOnce();
});

it('turns an edited preset into custom flags and restarts only without a running job', async()=>{
 const onRestart=mount();
 const attention=await screen.findByRole('combobox',{name:'Attention backend'});
 expect((screen.getByRole('option',{name:/^Sage · needs sageattention/}) as HTMLOptionElement).disabled).toBe(true);
 expect(screen.queryByRole('checkbox',{name:/cuBLAS|Async/})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Compatibility'}));
 fireEvent.click(screen.getByRole('checkbox',{name:/^Keep models in VRAM/}));
 expect(screen.getByText('Custom settings.')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Compatibility'}).getAttribute('aria-pressed')).toBe('false');
 job={state:'running'};
 fireEvent.click(screen.getByRole('button',{name:'Apply (restarts backend)'}));
 await screen.findByText(/A job is running/);
 expect(vi.mocked(invoke)).toHaveBeenCalledWith('native_startup_write',{root:'/env',startup:{flags:['--highvram'],fast:['autotune']}});
 expect(onRestart).not.toHaveBeenCalled();
 fireEvent.change(attention,{target:{value:'--use-ck-attention'}});
 await waitFor(()=>expect((attention as HTMLSelectElement).value).toBe('--use-ck-attention'));
});
