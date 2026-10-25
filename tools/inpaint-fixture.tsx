import {createRoot} from 'react-dom/client';
import {I18nProvider,useI18n} from '../src/i18n/I18nProvider';
import {Workbench} from '../src/features/studio/Workbench';
import '../src/styles.css';
function Fixture(){
  const {locale,setLocale,languages}=useI18n();
  const params=new URLSearchParams(location.search),root=params.get('root')??'/env';
  return <><label>Fixture language<select aria-label="Fixture language" value={locale} onChange={e=>setLocale(e.target.value)}>{languages.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
    <Workbench endpoint={params.get('endpoint')??'http://127.0.0.1:7801'} root={root} roots={{models:`${root}/ComfyUI/models`,input:`${root}/ComfyUI/input`,output:`${root}/ComfyUI/output`}}/></>;
}
createRoot(document.getElementById('fixture-root')!).render(<I18nProvider><Fixture/></I18nProvider>);
