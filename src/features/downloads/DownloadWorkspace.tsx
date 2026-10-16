import { useState } from 'react';
import { AuthPanel, DownloadPanel } from './DownloadPluginPanel';
/** Renders the panel for the active top tab; the tabs themselves live in the setup header. */
export function DownloadWorkspace({view,installTarget}:{view:'auth'|'downloads'|null;installTarget?:string}) {
  const [authRevision,setAuthRevision]=useState(0);
  return <>{view==='auth'&&<AuthPanel embedded onChange={()=>setAuthRevision(v=>v+1)}/>}{view==='downloads'&&<DownloadPanel embedded authRevision={authRevision} installTarget={installTarget}/>}</>;
}
