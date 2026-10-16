import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { LogsPanel, levelOf } from './LogsPanel';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn(()=>true)}));
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(true);});
afterEach(()=>{cleanup();vi.resetAllMocks();});
const entry=(seq:number,source:'deas'|'comfyui'|'cli',text:string)=>({seq,time:0,source,text});
describe('logs view — mock IPC fixtures',()=>{
 it('classifies levels from Python, uv and git output',()=>{
  expect(levelOf('[INFO] Starting server')).toBe('info');
  expect(levelOf('[WARNING] slow')).toBe('warning');
  expect(levelOf('/x.py:1491: FutureWarning: deprecated')).toBe('warning');
  expect(levelOf('Traceback (most recent call last):')).toBe('error');
  expect(levelOf('error: Failed to resolve')).toBe('error');
  expect(levelOf('ModuleNotFoundError: No module named x')).toBe('error');
  expect(levelOf('[DEBUG] detail')).toBe('debug');
 });
 it('reads incrementally and filters by source, level and search; copies the matches',async()=>{
  let call=0;
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
   if(command!=='native_logs')return null;
   call++;
   if(call===1){expect(args).toEqual({after:0});return [entry(1,'deas','Starting owned backend'),entry(2,'comfyui','[INFO] Starting server'),entry(3,'cli','error: resolution failed')];}
   expect(args).toEqual({after:3});return [];
  });
  const writeText=vi.fn(async()=>{});Object.assign(navigator,{clipboard:{writeText}});
  render(<I18nProvider><LogsPanel/></I18nProvider>);
  const lines=()=>screen.getByLabelText('Log lines').textContent!;
  await waitFor(()=>expect(lines()).toContain('Starting server'));
  await waitFor(()=>expect(call).toBeGreaterThan(1),{timeout:2500});
  fireEvent.click(screen.getByRole('button',{name:'ComfyUI'}));
  expect(lines()).not.toContain('Starting server');expect(lines()).toContain('Starting owned backend');
  fireEvent.click(screen.getByRole('button',{name:'Info'}));
  expect(lines()).toContain('[cli] [error] error: resolution failed');expect(lines()).not.toContain('Starting owned backend');
  fireEvent.click(screen.getByRole('button',{name:'Info'}));fireEvent.change(screen.getByRole('searchbox',{name:'Search logs'}),{target:{value:'OWNED'}});
  expect(lines()).toContain('Starting owned backend');expect(lines()).not.toContain('resolution failed');
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Copy'}));});
  expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^\d\d:\d\d:\d\d \[deas\] \[info\] Starting owned backend$/));
 });
});
