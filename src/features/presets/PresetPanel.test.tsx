import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { PresetPanel } from './PresetPanel';
import { I18nProvider } from '../../i18n/I18nProvider';
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:vi.fn()}));
beforeEach(()=>{localStorage.setItem('deas.locale.v1','en');vi.resetAllMocks();});
afterEach(cleanup);
test('read failure is visible and cannot overwrite unread presets',async()=>{
 vi.mocked(invoke).mockRejectedValue('Cannot read presets');
 render(<I18nProvider><PresetPanel disabled={false}/></I18nProvider>);
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Cannot read presets');
 expect((screen.getByRole('button',{name:'Save as new preset'}) as HTMLButtonElement).disabled).toBe(true);
 expect(invoke).toHaveBeenCalledExactlyOnceWith('native_presets_read');
});
test('write failure retains the selected preset and never reports success',async()=>{
 vi.mocked(invoke).mockImplementation(async c=>{if(c==='native_presets_read')return [];throw new Error('Disk full');});
 render(<I18nProvider><PresetPanel disabled={false}/></I18nProvider>);
 await waitFor(()=>expect((screen.getByLabelText('Preset name') as HTMLInputElement).disabled).toBe(false));
 fireEvent.change(screen.getByLabelText('Preset name'),{target:{value:'Draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Save as new preset'}));
 expect((await screen.findByRole('alert')).textContent).toContain('Disk full');
 expect(screen.queryByText('Preset saved.')).toBeNull();expect(screen.queryByRole('option',{name:'Draft'})).toBeNull();
});
test('incompatible settings fail closed and reach shared native logging',async()=>{
 vi.mocked(invoke).mockResolvedValue([{name:'Old',settings:{'studio.run.unknown':true}}]);
 render(<I18nProvider><PresetPanel disabled={false}/></I18nProvider>);
 await screen.findByRole('option',{name:'Old'});
 fireEvent.change(screen.getByLabelText('Saved preset'),{target:{value:'Old'}});
 fireEvent.click(screen.getByRole('button',{name:'Load preset'}));
 expect(screen.getByRole('alert').textContent).toContain('Nothing was changed');
 expect(invoke).toHaveBeenCalledWith('native_presets_invalid');
});
