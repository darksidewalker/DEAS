import {useI18n} from '../i18n/I18nProvider';
import {modelCheckText,type ModelCheck} from '../lib/modelCheck';
export function ModelAdvice({check}:{check:ModelCheck}) {
 const {t}=useI18n();
 return <p className="field-help" data-model-integrity={check.integrity??'unchecked'} data-model-check={check.compatibility} data-model-availability={check.availability}>{modelCheckText(check,t)}</p>;
}
