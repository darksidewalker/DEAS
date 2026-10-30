import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ContinuityOverlay } from './ContinuityOverlay';
import type { ContinuityPlannerProps } from './ContinuityPlanner';

const showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
const close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });

const dialogMethods = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
beforeEach(() => {
  localStorage.setItem('deas.locale.v1', 'en');
  vi.clearAllMocks();
  // jsdom has no native dialog lifecycle; preserve its open-state semantics here only.
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: showModal },
    close: { configurable: true, value: close },
  });
});
afterEach(() => {
  cleanup();
  for (const method of ['showModal', 'close']) {
    if (dialogMethods[method]) Object.defineProperty(HTMLDialogElement.prototype, method, dialogMethods[method]);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
  }
});

function props(): ContinuityPlannerProps & { onClose: () => void } {
  return {
    plan: { enabled: true, session: 'test-session', outputMode: 'segment', steps: [
      { id: 'first', seconds: 5, action: '' },
      { id: 'next', seconds: 3, action: 'Turn around' },
    ] },
    onChange: vi.fn(), onRun: vi.fn(), running: false, disabled: false, onClose: vi.fn(),
  };
}

const overlay = (value: ReturnType<typeof props>) => <I18nProvider><ContinuityOverlay {...value}/></I18nProvider>;

describe('ContinuityOverlay', () => {
  it.each(['button', 'cancel'] as const)('closes natively before notifying the parent via %s, without duplicate cleanup', (method) => {
    const value = props();
    const { unmount } = render(overlay(value));
    const dialog = screen.getByRole('dialog', { name: 'Continuity' }) as HTMLDialogElement;
    vi.mocked(value.onClose).mockImplementation(() => { expect(dialog.open).toBe(false); });
    if (method === 'button') fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    else {
      const cancel = new Event('cancel', { bubbles: false, cancelable: true });
      fireEvent(dialog, cancel);
      expect(cancel.defaultPrevented).toBe(true);
    }
    expect(value.onClose).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    unmount();
    expect(close).toHaveBeenCalledTimes(1);
    expect(value.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the native lifecycle balanced under StrictMode', () => {
    const value = props();
    const { unmount } = render(<StrictMode>{overlay(value)}</StrictMode>);
    const dialog = screen.getByRole('dialog', { name: 'Continuity' }) as HTMLDialogElement;
    expect(showModal).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(true);
    unmount();
    expect(close).toHaveBeenCalledTimes(2);
    expect(value.onClose).not.toHaveBeenCalled();
  });

  it('forwards planner editing, run callbacks and disabled/running state unchanged', () => {
    const value = props();
    const { rerender } = render(overlay(value));
    const seconds = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    expect(seconds.map(input => input.value)).toEqual(['5', '3']);
    fireEvent.change(seconds[1], { target: { value: '4' } });
    expect(value.onChange).toHaveBeenLastCalledWith({ ...value.plan, steps: [value.plan.steps[0], { ...value.plan.steps[1], seconds: 4 }] });
    const action = screen.getByRole('textbox', { name: 'Next action' }) as HTMLTextAreaElement;
    fireEvent.change(action, { target: { value: 'Wave' } });
    expect(value.onChange).toHaveBeenLastCalledWith({ ...value.plan, steps: [value.plan.steps[0], { ...value.plan.steps[1], action: 'Wave' }] });
    const next = document.querySelector<HTMLButtonElement>('[data-cont-run]')!;
    const all = document.querySelector<HTMLButtonElement>('[data-cont-run-all]')!;
    fireEvent.click(next);
    fireEvent.click(all);
    expect(value.onRun).toHaveBeenNthCalledWith(1, false);
    expect(value.onRun).toHaveBeenNthCalledWith(2, true);
    rerender(overlay({ ...value, disabled: true }));
    expect(next.disabled).toBe(true);
    expect(all.disabled).toBe(true);
    expect(seconds[1].disabled).toBe(false);
    rerender(overlay({ ...value, running: true }));
    expect(seconds[1].disabled).toBe(true);
    expect(action.disabled).toBe(true);
    expect(next.disabled).toBe(true);
    expect(all.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(false);
    expect(showModal).toHaveBeenCalledTimes(1);
  });

  it('opens a named native modal, focuses Close and closes on unmount', () => {
    const value = props();
    const { unmount } = render(overlay(value));
    const dialog = screen.getByRole('dialog', { name: 'Continuity' }) as HTMLDialogElement;
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(showModal.mock.instances[0]).toBe(dialog);
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    unmount();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.instances[0]).toBe(dialog);
    expect(dialog.open).toBe(false);
    expect(value.onClose).not.toHaveBeenCalled();
  });
});
