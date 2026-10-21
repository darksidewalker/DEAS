import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { QuickSettings } from './QuickSettings';

test('Quick Settings exposes separate layout and authoring reset requests and closes with Escape',()=>{
 localStorage.setItem('deas.locale.v1','en');
 const layout=vi.fn(),defaults=vi.fn();window.addEventListener('deas:reset-studio-layout',layout);window.addEventListener('deas:request-studio-defaults',defaults);
 const target=document.createElement('div');target.setAttribute('data-workbench','');document.body.append(target);
 const view=render(<I18nProvider><QuickSettings/></I18nProvider>);
 const trigger=screen.getByRole('button',{name:'Quick Settings'});
 fireEvent.click(trigger);fireEvent.click(screen.getByRole('button',{name:'Reset layout'}));
 expect(layout).toHaveBeenCalledOnce();expect(defaults).not.toHaveBeenCalled();expect(trigger.getAttribute('aria-expanded')).toBe('false');
 fireEvent.click(trigger);fireEvent.click(screen.getByRole('button',{name:'Reset to defaults…'}));expect(defaults).toHaveBeenCalledOnce();
 fireEvent.click(trigger);fireEvent.keyDown(window,{key:'Escape'});expect(trigger.getAttribute('aria-expanded')).toBe('false');expect(document.activeElement).toBe(trigger);
 view.unmount();target.remove();window.removeEventListener('deas:reset-studio-layout',layout);window.removeEventListener('deas:request-studio-defaults',defaults);
});

test('reset actions explain why they are unavailable before Studio mounts',()=>{
 localStorage.setItem('deas.locale.v1','en');
 const request=vi.fn();window.addEventListener('deas:reset-studio-layout',request);window.addEventListener('deas:request-studio-defaults',request);
 const view=render(<I18nProvider><QuickSettings/></I18nProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Quick Settings'}));
 for(const name of ['Reset layout','Reset to defaults…']){
  const action=screen.getByRole('button',{name});
  expect(action.hasAttribute('disabled')).toBe(true);
  expect(document.getElementById(action.getAttribute('aria-describedby')!)?.textContent).toBe('Open Studio first to enable reset actions.');
  fireEvent.click(action);
 }
 expect(request).not.toHaveBeenCalled();
 view.unmount();window.removeEventListener('deas:reset-studio-layout',request);window.removeEventListener('deas:request-studio-defaults',request);
});
