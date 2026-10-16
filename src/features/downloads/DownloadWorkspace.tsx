import { useState } from 'react';
import { AuthPanel, DownloadPanel } from './DownloadPluginPanel';
/** One bubble panel at a time, so switching between bubbles swaps the view instead of stacking it. */
export function DownloadWorkspace({installTarget}:{installTarget?:string}) {
  const [authRevision,setAuthRevision]=useState(0);
  const [active,setActive]=useState<'auth'|'downloads'|null>(null);
  const toggle=(id:'auth'|'downloads')=>setActive(id); // a bubble stays open on repeated clicks; only another bubble replaces it
  return <><AuthPanel open={active==='auth'} onToggle={()=>toggle('auth')} onChange={()=>setAuthRevision(v=>v+1)}/><DownloadPanel open={active==='downloads'} onToggle={()=>toggle('downloads')} authRevision={authRevision} installTarget={installTarget}/></>;
}
