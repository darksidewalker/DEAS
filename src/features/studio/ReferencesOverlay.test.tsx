import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ReferencesOverlay } from './ReferencesOverlay';
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>false,invoke:vi.fn()}));
const methods=Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
beforeEach(()=>{
 localStorage.setItem('deas.locale.v1','en');
 Object.defineProperties(HTMLDialogElement.prototype,{
  showModal:{configurable:true,value:function(){this.open=true;}},
  close:{configurable:true,value:function(){this.open=false;}}
 });
});
afterEach(()=>{
 cleanup();
 for(const name of ['showModal','close'])if(methods[name])Object.defineProperty(HTMLDialogElement.prototype,name,methods[name]);else Reflect.deleteProperty(HTMLDialogElement.prototype,name);
});
test.each(['button','cancel'])('References opens a named modal, hosts selection and editing, and closes via %s',method=>{
 const onClose=vi.fn(),onChange=vi.fn();
 const {unmount}=render(<StrictMode><I18nProvider><ReferencesOverlay family="ltx-2" seconds={5} refs={[]} label={()=>''} onChange={onChange} onAdd={vi.fn()} onInsert={vi.fn()} onClose={onClose} picker={<button>{'Pick fixture'}</button>}/></I18nProvider></StrictMode>);
 const dialog=screen.getByRole('dialog',{name:'References'}) as HTMLDialogElement;
 expect(dialog.open).toBe(true);expect(screen.getByRole('button',{name:'Pick fixture'})).toBeTruthy();
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'Close'}));
 expect(document.querySelector('[data-references]')).toBeTruthy();
 if(method==='button')fireEvent.click(screen.getByRole('button',{name:'Close'}));else{
  const event=new Event('cancel',{cancelable:true});fireEvent(dialog,event);expect(event.defaultPrevented).toBe(true);
 }
 expect(dialog.open).toBe(false);expect(onClose).toHaveBeenCalledTimes(1);expect(onChange).not.toHaveBeenCalled();
 unmount();expect(onClose).toHaveBeenCalledTimes(1);
});
