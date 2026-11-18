import { useI18n } from '../i18n/I18nProvider';
import type { ModelSort } from '../lib/modelBrowsing';
import './modelSortControl.css';
const groups:{name:string; values:ModelSort[]}[]=[{name:'name',values:['name','nameDesc']},{name:'added',values:['newest','oldest']},{name:'size',values:['size','smallest']},{name:'use',values:['mostUsed','leastUsed']},{name:'versions',values:['mostVersions','fewestVersions']},{name:'random',values:['random']},{name:'base',values:['family']}];
export function ModelSortControl({value,onChange,onShuffle,supportedSorts,dateLabel}:{value:ModelSort;onChange:(sort:ModelSort)=>void;onShuffle:()=>void;supportedSorts?:readonly ModelSort[];dateLabel?:string}) {
 const {t}=useI18n();
 return <div className="model-sort-control"><label><span>{t('downloads.sort')}</span><select data-model-sort aria-label={t('library.sort')} value={value} onChange={e=>onChange(e.target.value as ModelSort)}>{groups.map(group=>({...group,values:group.values.filter(sort=>!supportedSorts||supportedSorts.includes(sort))})).filter(group=>group.values.length).map(group=><optgroup key={group.name} label={group.name==='added'&&dateLabel?dateLabel:t(`library.sortGroup.${group.name}`)}>{group.values.map(sort=><option key={sort} value={sort}>{t(`library.sortMode.${sort}`)}</option>)}</optgroup>)}</select></label>{value==='random'&&<button type="button" onClick={onShuffle} title={t('library.shuffle')}>{t('library.shuffle')}</button>}</div>;
}
