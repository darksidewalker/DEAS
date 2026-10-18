export const defaultOutputNaming='%type%/%date_yyyy-mm-dd%/%time%-%seed%-%model%';

/** Upgrade only the former default; keep user-authored templates unchanged. */
export const outputNamingTemplate=(value?:string)=>value===undefined||value==='%type%/%date_yyyy_mm_dd%/%time%-%seed%-%model%'?defaultOutputNaming:value;

/** Resolved prefixes only: no backend %-expansion, traversal or Windows device paths. Mirrored in jobs.rs. */
export function safeOutputPrefix(value:unknown):value is string {
 return typeof value==='string'&&value.length<=512&&value.slice(0,Math.max(0,value.lastIndexOf('/'))).length<=255&&value.split('/').every(p=>
  p.length>0&&p.length<=180&&/^[A-Za-z0-9_.-]+$/.test(p)&&p!=='.'&&p!=='..'&&!p.endsWith('.')&&!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p));
}

/** Snapshot local submission time and actual seed/model before handing an immutable intent to native. */
export function outputPrefix(template:string,context:{type:'image'|'video'|'audio';seed:number;model:string},now=new Date()):string|null {
 if(template.length>512)return null;
 const pad=(n:number)=>String(n).padStart(2,'0');
 const model=context.model.split(/[\\/]/).pop()!.replace(/\.[^.]+$/,'').replace(/[^A-Za-z0-9-]+/g,'-').slice(0,120).replace(/^-+|-+$/g,'')||'model';
 const values:Record<string,string>={type:context.type,seed:String(context.seed),model,
  'date_yyyy-mm-dd':`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`,
  date_yyyy_mm_dd:`${now.getFullYear()}_${pad(now.getMonth()+1)}_${pad(now.getDate())}`,
  time:`${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`};
 const resolved=template.replace(/%([^%]+)%/g,(token,key:string)=>values[key]??token);
 return safeOutputPrefix(resolved)?resolved:null;
}
