import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * A floating window that opens where its CSS puts it (centered) and moves by its title bar, like the detached prompt editor.
 * The title bar stays reachable: the window may leave the screen only partly. Buttons in the bar do not start a drag.
 */
export function useFloatingPosition<T extends HTMLElement>() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<T>(null);
  const onPointerDown = (e: ReactPointerEvent) => {
    if ((e.button ?? 0) > 0 || (e.target as HTMLElement).closest('button, input, select, textarea') || !ref.current) return;
    const r = ref.current.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => setPos({ x: Math.min(Math.max(ev.clientX - dx, 40 - r.width), window.innerWidth - 40), y: Math.min(Math.max(ev.clientY - dy, 0), window.innerHeight - 32) });
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop);
  };
  return { ref, onPointerDown, style: pos ? { left: pos.x, top: pos.y, transform: 'none' } : undefined, moved: !!pos };
}
