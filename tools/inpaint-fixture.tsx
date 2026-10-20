import {createRoot} from 'react-dom/client';
import {I18nProvider,useI18n} from '../src/i18n/I18nProvider';
import {Workbench} from '../src/features/studio/Workbench';
import '../src/styles.css';
function Fixture(){
  const {locale,setLocale,languages}=useI18n();
  return <><label>Fixture language<select aria-label="Fixture language" value={locale} onChange={e=>setLocale(e.target.value)}>{languages.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
    <Workbench endpoint="http://127.0.0.1:7801" root="/env" roots={{models:'/env/ComfyUI/models',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></>;
}
createRoot(document.getElementById('fixture-root')!).render(<I18nProvider><Fixture/></I18nProvider>);
