import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ImageReferencesManager } from './ImageReferencesManager';
import type { MediaItem } from '../../lib/media';

const native=vi.hoisted(()=>({drop:null as null|((e:{payload:{type:string;paths:string[];position:{x:number;y:number}}})=>void)}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:vi.fn(()=>false),invoke:vi.fn(),convertFileSrc:(p:string)=>p}));
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async(callback:typeof native.drop)=>{native.drop=callback;return()=>{};}})}));
beforeEach(()=>{localStorage.setItem('deas.locale.v1','en');native.drop=null;});
afterEach(()=>{cleanup();vi.mocked(isTauri).mockReturnValue(false);vi.clearAllMocks();});
const image=(name:string):MediaItem=>({name,path:`/input/${name}`,src:`asset://${name}`,media:'image'});
const base=()=>({source:image('source.png'),refs:[],selected:image('selected.png'),max:8,valid:(item:MediaItem|null)=>!!item?.path,onAdd:vi.fn(),onSource:vi.fn(),onClearSource:vi.fn(),onChange:vi.fn(),onInsert:vi.fn()});

test('an unresolved history slot keeps its position and accepts the selected replacement',()=>{
 const onReplace=vi.fn(),props={...base(),refs:[{item:{name:'missing.png',src:'missing.png',media:'image' as const},strength:.6}]};
 render(<I18nProvider><ImageReferencesManager {...props} onReplace={onReplace} replaceAllowed/></I18nProvider>);
 expect(document.querySelector('[data-history-reference-unresolved]')).toBeTruthy();
 expect(screen.getByRole('status').textContent).toContain('missing.png');
 fireEvent.click(document.querySelector('[data-history-reference-select="0"]')!);
 expect(onReplace).toHaveBeenCalledWith(0,props.selected);expect(props.onAdd).not.toHaveBeenCalled();
 fireEvent.click(document.querySelector('[data-reference-source-remove]')!);expect(props.onClearSource).toHaveBeenCalledOnce();
});

test('native drop failures reach the fixed reference-media log without sending the error path',async()=>{
 vi.mocked(isTauri).mockReturnValue(true);
 vi.mocked(invoke).mockImplementation(async command=>{if(command==='native_media_describe')throw new Error('private path');return null;});
 const view=render(<I18nProvider><ImageReferencesManager {...base()}/></I18nProvider>);
 const root=view.container.querySelector<HTMLElement>('[data-image-references]')!;
 vi.spyOn(root,'getBoundingClientRect').mockReturnValue({left:0,top:0,right:300,bottom:300,width:300,height:300,x:0,y:0,toJSON:()=>({})});
 await waitFor(()=>expect(native.drop).not.toBeNull());
 native.drop!({payload:{type:'drop',paths:['/private/picture.png'],position:{x:20,y:20}}});
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_logs_reference_media_error'));
 expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='native_logs_reference_media_error')).toEqual([['native_logs_reference_media_error']]);
});
