import {useI18n} from '../../i18n/I18nProvider';
import {ModelAdvice} from '../../components/ModelAdvice';
import {modelCompanionAdvice,type ModelCompanionSuggestion} from '../../lib/modelCompanionAdvice';
import type {LocalModel} from '../../lib/models';

/** Missing slots are advice, not an execution gate or permission to download. */
export function ModelCompanionAdvice({model,models,onOpen,locked=false}:{model:LocalModel;models:readonly LocalModel[];onOpen:(suggestion:ModelCompanionSuggestion)=>void;locked?:boolean}) {
 const {t}=useI18n();
 const labels={textEncoders2:'studio.run.textEncoder2',textEncoders:'studio.run.textEncoder',vaes:'studio.run.vae',audioVaes:'studio.run.video.audioVae',textProjections:'studio.run.video.textProjection'};
 return <>{modelCompanionAdvice(model,models).map(s=><div key={s.slot} data-model-companion={s.slot}>
  <ModelAdvice check={{identity:'unverified',compatibility:'unknown',availability:'missing',evidence:[],reasons:[{code:'missingCompanion',detail:t(labels[s.slot])}]}}/>
  <p className="field-help">{s.patterns.join(' · ')}</p>
  <button type="button" className="action-button" disabled={locked} onClick={()=>onOpen(s)}>{t('downloads.title')} · {t(labels[s.slot])}</button>
 </div>)}</>;
}
