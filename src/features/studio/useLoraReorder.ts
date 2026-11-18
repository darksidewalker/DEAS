import { usePointerReorder } from '../../components/usePointerReorder';
import type { SelectedLora } from './LoraSetsDialog';

export function useLoraReorder(selected:SelectedLora[],onChange:(value:SelectedLora[])=>void,onMoved:(name:string,position:number)=>void) {
 return usePointerReorder(selected.map(l=>l.name),keys=>{const byName=new Map(selected.map(l=>[l.name,l]));onChange(keys.flatMap(key=>byName.has(key)?[byName.get(key)!]:[]));},{rowSelector:'[data-lora-row]',keyAttribute:'data-lora-row',onMoved});
}
