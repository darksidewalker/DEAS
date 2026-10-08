import { useState } from 'react';
import { AuthPanel, DownloadPanel } from './DownloadPluginPanel';
export function DownloadWorkspace({installTarget}:{installTarget?:string}) {
  const [authRevision,setAuthRevision]=useState(0);
  return <><AuthPanel onChange={()=>setAuthRevision(v=>v+1)}/><DownloadPanel authRevision={authRevision} installTarget={installTarget}/></>;
}
