import type { ButtonHTMLAttributes } from 'react';

/** Compact visible actions; the translated name is available to hover and assistive technology. */
export function ReferenceActionButton({kind,label,...props}:{kind:'edit'|'earlier'|'later'|'remove'|'insert'|'play'|'pause'|'source';label:string}&ButtonHTMLAttributes<HTMLButtonElement>) {
 return <button {...props} type="button" className={`reference-icon-button reference-icon-${kind}`} aria-label={label} title={label}>
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
   {kind==='source'?<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>:kind==='play'?<path d="m8 4 12 8-12 8z" fill="currentColor" stroke="none"/>:kind==='pause'?<path d="M8 5v14M16 5v14" strokeWidth="4"/>:kind==='edit'?<><path d="m15 4 5 5M4 20l5-1L21 7a2.1 2.1 0 0 0-3-3L6 16z"/></>:kind==='remove'?<><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></>:kind==='earlier'?<path d="m6 14 6-6 6 6"/>:kind==='later'?<path d="m6 10 6 6 6-6"/>:<><path d="M9 4H4v16h5M15 8l4 4-4 4M8 12h11"/></>}
  </svg>
 </button>;
}
