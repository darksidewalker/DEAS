/** Original node inputs; DEAS selects rules, the installed node resolves them. */
export interface WildcardRules {
 style: 'Booru' | 'Natural Language';
 seed: number;
 reroll: number;
 token_budget: number;
 auto_reroll: boolean;
 selection_state: Record<string,{enabled:boolean;weight:number}>;
}
export const wildcardNode='DaSiWa_WildcardPresetPromptBuilder';
export const defaultWildcard:WildcardRules={style:'Booru',seed:0,reroll:0,token_budget:200,auto_reroll:false,selection_state:{}};
export function isWildcardRules(v:unknown):v is WildcardRules {
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const r=v as WildcardRules;
 const integer=(n:number,max:number,min=0)=>Number.isInteger(n)&&n>=min&&n<=max;
 return Object.keys(r).length===6&&['Booru','Natural Language'].includes(r.style)&&integer(r.seed,0xffffffff)&&integer(r.reroll,0x7fffffff)
  &&integer(r.token_budget,10000,1)&&typeof r.auto_reroll==='boolean'&&!!r.selection_state&&typeof r.selection_state==='object'&&!Array.isArray(r.selection_state)
  &&Object.keys(r.selection_state).length<=4096&&Object.entries(r.selection_state).every(([k,s])=>k.length>0&&k.length<=512&&!k.includes('\0')&&!!s&&typeof s==='object'&&Object.keys(s).length===2&&typeof s.enabled==='boolean'&&typeof s.weight==='number'&&Number.isFinite(s.weight)&&Math.abs(s.weight)<=10);
}
