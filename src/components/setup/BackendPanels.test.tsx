import {cleanup,fireEvent,render,screen,waitFor,act} from '@testing-library/react';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {I18nProvider} from '../../i18n/I18nProvider';
import {defaultLlmConfig} from '../../lib/llm';
import {BackendPanels} from './BackendPanels';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:()=>true}));
beforeEach(()=>{
 localStorage.setItem('deas.locale.v1','en');
 vi.mocked(invoke).mockImplementation(async command=>{
  if(command==='native_startup_read')return {startup:{flags:[],fast:[]},packages:[],presets:{speed:{flags:[],fast:[]},compatibility:{flags:[],fast:[]},off:{flags:[],fast:[]}}};
  if(command==='native_llm_read')return defaultLlmConfig;
  if(command==='native_llm_models')return {models:[],warnings:[]};
  if(command==='native_auth_status')return [];
  throw Error('Unexpected fixture IPC '+command);
 });
});
afterEach(()=>{cleanup();vi.resetAllMocks();localStorage.clear();});
const props={root:'/env',onRestart:vi.fn(),onAuthChange:vi.fn()};
const mount=(root='/env')=>render(<I18nProvider><BackendPanels {...props} root={root}/></I18nProvider>);
const choose=(name:string)=>fireEvent.click(screen.getByRole('tab',{name}));
test('one common pane at a time, lazy reads and retained drafts without execution',async()=>{
 mount();await screen.findByRole('button',{name:'Compatibility'});
 expect(invoke).not.toHaveBeenCalledWith('native_llm_read',expect.anything());
 expect(invoke).not.toHaveBeenCalledWith('native_auth_status');
 fireEvent.click(screen.getByRole('button',{name:'Compatibility'}));
 choose('LLM backend');const provider=await screen.findByRole('combobox',{name:'Provider'});
 await waitFor(()=>expect(provider.closest('fieldset')?.disabled).toBe(false));
 fireEvent.change(provider,{target:{value:'openai'}});fireEvent.change(screen.getByLabelText('Endpoint URL'),{target:{value:'https://endpoint.invalid/v1'}});
 choose('Provider authorization');fireEvent.change(await screen.findByLabelText('Token'),{target:{value:'draft-only-not-a-credential'}});
 choose('Startup optimizations');expect(screen.getByRole('button',{name:'Compatibility'}).getAttribute('aria-pressed')).toBe('true');
 choose('LLM backend');expect((screen.getByLabelText('Endpoint URL') as HTMLInputElement).value).toBe('https://endpoint.invalid/v1');
 expect((screen.getByRole('combobox',{name:'Provider'}) as HTMLSelectElement).value).toBe('openai');
 choose('Provider authorization');expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('draft-only-not-a-credential');
 expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
 for(const command of ['native_startup_read','native_llm_read','native_auth_status'])expect(vi.mocked(invoke).mock.calls.filter(([c])=>c===command)).toHaveLength(1);
 expect(vi.mocked(invoke).mock.calls.every(([c])=>['native_startup_read','native_llm_read','native_llm_models','native_auth_status'].includes(c))).toBe(true);
});
test('vertical keyboard navigation wraps and focuses the chosen panel',async()=>{
 mount();const menu=screen.getByRole('tablist',{name:'Backend panels'});
 for(const [key,label] of [['ArrowDown','LLM backend'],['End','Provider authorization'],['Home','Startup optimizations'],['ArrowUp','Provider authorization']]){
  fireEvent.keyDown(menu,{key});expect(document.activeElement).toBe(screen.getByRole('tab',{name:label}));
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(document.activeElement?.id);
 }
 await act(async()=>{});
});
test('authorization remains available without an installed root; runtime tabs are disabled',async()=>{
 mount('');expect(screen.getByRole('tab',{name:'Startup optimizations'}).hasAttribute('disabled')).toBe(true);
 expect(screen.getByRole('tab',{name:'LLM backend'}).hasAttribute('disabled')).toBe(false);
 const menu=screen.getByRole('tablist',{name:'Backend panels'});fireEvent.keyDown(menu,{key:'ArrowDown'});
 expect(document.activeElement).toBe(screen.getByRole('tab',{name:'LLM backend'}));
 await act(async()=>{});expect(vi.mocked(invoke).mock.calls.map(([c])=>c)).toEqual(['native_auth_status']);
});
test('changing environment discards runtime drafts but retains the global authorization draft',async()=>{
 const view=mount('/one');fireEvent.click(await screen.findByRole('button',{name:'Compatibility'}));
 choose('Provider authorization');fireEvent.change(await screen.findByLabelText('Token'),{target:{value:'local-draft'}});
 view.rerender(<I18nProvider><BackendPanels {...props} root="/two"/></I18nProvider>);
 choose('Startup optimizations');await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_startup_read',{root:'/two'}));
 expect(screen.getByRole('button',{name:'Compatibility'}).getAttribute('aria-pressed')).toBe('false');
 choose('Provider authorization');expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('local-draft');
});
