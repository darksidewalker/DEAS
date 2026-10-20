import {DownloadPanel} from './DownloadPluginPanel';
/** Library receives credential invalidations from the owning Backend workspace. */
export function DownloadWorkspace({view,installTarget,modelsDir,authRevision}:{view:'downloads'|null;installTarget?:string;modelsDir?:string;authRevision:number}){
 return view==='downloads'?<DownloadPanel embedded authRevision={authRevision} installTarget={installTarget} modelsDir={modelsDir}/>:null;
}
