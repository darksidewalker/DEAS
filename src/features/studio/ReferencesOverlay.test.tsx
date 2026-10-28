import { StrictMode, useState } from 'react';
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

test('H3 overview is compact; nested edit keeps changes, identity and outer modal on Escape',()=>{
 const outerClose=vi.fn();
 function Harness(){
  const [refs,setRefs]=useState<import('./ReferencesPanel').VideoRef[]>([
   {item:{name:'clip.mp4',path:'/in/clip.mp4',src:'asset://clip.mp4',media:'video'},second:0,strength:1,mediaMode:'video',trimStart:1,trimEnd:4},
   {item:{name:'other.png',src:'asset://other.png',media:'image'},second:0,strength:1,mediaMode:'video',instructions:'keep me'}
  ]);
  return <ReferencesOverlay refs={refs} onChange={setRefs} family="minimax-h3" seconds={5} label={(_,i)=>String(i+1)} onAdd={vi.fn()} onInsert={vi.fn()} onClose={outerClose} picker={<button>{'Picker'}</button>}/>;
 }
 const pause=vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
 render(<I18nProvider><Harness/></I18nProvider>);
 expect(document.querySelectorAll('.reference-thumb')).toHaveLength(2);
 expect(document.querySelector('.reference-media')).toBeNull();
 const edit=screen.getByRole('button',{name:'Edit clip.mp4'});edit.focus();fireEvent.click(edit);
 const inner=screen.getByRole('dialog',{name:'Edit clip.mp4'});
 expect(document.querySelectorAll('.reference-media')).toHaveLength(1);
 fireEvent.change(screen.getByLabelText('Start of clip.mp4'),{target:{value:'2'}});
 fireEvent.change(screen.getByLabelText('Use of clip.mp4'),{target:{value:'audio'}});
 expect(screen.getByRole('dialog',{name:'Edit clip.mp4'})).toBe(inner);
 expect(screen.getByLabelText('Start of clip.mp4')).toHaveProperty('value','2');
 const event=new Event('cancel',{cancelable:true,bubbles:true});fireEvent(inner,event);
 expect(outerClose).not.toHaveBeenCalled();expect(screen.getByRole('dialog',{name:'References'})).toHaveProperty('open',true);
 expect(document.querySelector('.reference-media')).toBeNull();expect(pause).toHaveBeenCalled();
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'Edit clip.mp4'}));
 expect(document.querySelector('[data-ref="other.png"]')!.textContent).toContain('keep me');
 expect(document.querySelector('[data-ref="clip.mp4"]')!.textContent).toContain('2.00');
 fireEvent.click(screen.getByRole('button',{name:'Edit clip.mp4'}));
 expect(screen.getByLabelText('Start of clip.mp4')).toHaveProperty('value','2');
 expect(screen.getByLabelText('End of clip.mp4')).toHaveProperty('value','4');
 expect(screen.getByLabelText('Use of clip.mp4')).toHaveProperty('value','audio');
 pause.mockRestore();
});
