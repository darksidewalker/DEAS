import { useLayoutEffect, useRef, useState } from "react";

/** Reveal text inside its existing button. Never create another bubble or portal. */
export function NeuralHelp({ id, description, open }: {
  id: string;
  description?: string;
  open: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const pointer = useRef({x:0,y:0});
  const lockedPointer = useRef<{x:number;y:number}|null>(null);
  useLayoutEffect(() => {
    const dismiss = () => { lockedPointer.current={...pointer.current}; setDismissed(true); };
    const move = (event:PointerEvent) => {
      pointer.current={x:event.clientX,y:event.clientY};
      const locked=lockedPointer.current;
      if(locked && Math.hypot(event.clientX-locked.x,event.clientY-locked.y)>4) { lockedPointer.current=null; setDismissed(false); }
    };
    const keyboard = (event:KeyboardEvent) => {
      if(event.key==='Tab') { lockedPointer.current=null; setDismissed(false); }
      if(event.key==='Escape') dismiss();
    };
    window.addEventListener('deas:neural-select', dismiss);
    window.addEventListener('pointermove',move);
    window.addEventListener('keydown',keyboard);
    return () => { window.removeEventListener('deas:neural-select', dismiss); window.removeEventListener('pointermove',move); window.removeEventListener('keydown',keyboard); };
  }, []);
  if (!description) return null;
  return <span id={id} className={`neural-help${open && !dismissed ? "" : " neural-help-reserved"}`}>{description}</span>;
}
