import type { JobStatus } from '../../lib/jobs';

/** Only native completion timing is a measured generation duration. */
export function generationDuration(job:Pick<JobStatus,'state'|'metadata'>|null,locale:string):string|null {
 const ms=job?.metadata?.generationMs;
 return job?.state==='succeeded'&&ms!=null&&Number.isFinite(ms)&&ms>=0
  ?new Intl.NumberFormat(locale,{style:'unit',unit:'second',unitDisplay:'short',maximumFractionDigits:2}).format(ms/1000)
  :null;
}
