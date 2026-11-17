import { useCallback, useEffect, useRef, useState } from 'react';
import { readDialCatalog, dialInfoError, type DialInfoMap, type DialInfoState } from '../../lib/dialInfo';

/**
 * The dial files' own info for the experimental Dials tab (docs/DIALS.md): read once each time `wanted` turns true (the tab or the
 * rack opens on a backend that has the pack) and on `refresh`. A failed read never blocks the strip: the state becomes
 * `unavailable`, no info is kept and the strip shows its fallbacks. Native logs the cause.
 */
export function useDialInfo(endpoint:string,wanted:boolean,read:(baseUrl:string)=>Promise<DialInfoMap>=readDialCatalog):DialInfoState&{refresh:()=>void} {
 const [state,setState]=useState<DialInfoState>({status:'idle'});
 const epoch=useRef(0),live=useRef(true);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 const refresh=useCallback(()=>{
  const turn=++epoch.current;
  setState(old=>({...old,status:'loading'}));
  read(endpoint).then(map=>{if(live.current&&turn===epoch.current)setState({status:'ready',map});},
   error=>{if(live.current&&turn===epoch.current)setState({status:'unavailable',code:dialInfoError(error)});});
 },[endpoint,read]);
 // Another backend: what was read no longer applies.
 useEffect(()=>{epoch.current++;setState({status:'idle'});},[endpoint]);
 useEffect(()=>{if(wanted)refresh();},[wanted,refresh]);
 return {...state,refresh};
}
