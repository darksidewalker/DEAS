// Pure planning data. Text is resolved by the owning module's language resources.
export type Motion = 'light' | 'paws' | 'off';
export type StepId = 'route' | 'storage' | 'pack' | 'acceleration' | 'backend' | 'review';
export type FeatureId = 'director' | 'forge' | 'refmods' | 'continuity';
export type Backend = 'cpu' | 'nvidia' | 'amd' | 'intel';
export interface InstallOptions { sage: boolean; radial: boolean; flash: boolean; ffmpeg: boolean }
export interface SetupState { mode?: 'automatic'; version: 2; opened: boolean; motion: Motion; values: Partial<Record<StepId,string>>; confirmed: Partial<Record<StepId,boolean>>; features: FeatureId[]; options: InstallOptions; comfyRef: string }
export interface SetupChoice { included?: {id:string;label:string}[]; suggested?: boolean; detected?: boolean; id: string; label: string; description?: string; status?: string; selected?: boolean; disabled?: boolean; suggests?: string[] }
export interface SetupNode { included?: {id:string;label:string}[]; suggested?: boolean; detected?: boolean; id: string; label: string; description?: string; status?: string; parentId: string|null; column: number; order: number; selected?: boolean; choices?: SetupChoice[]; selectionMode?: 'single'|'multi' }
/** Join an existing native-selected parent with a new, single safe child name. */
export function storageTarget(parent: string, child: string): string|null {
 if (!child || child.trim()!==child || /[\/\\\x00-\x1f<>:"|?*]/.test(child) || child==='.' || child==='..' || /[. ]$/.test(child) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(child)) return null;
 const windows=/^[A-Za-z]:[\/\\]/.test(parent);
 if (!(parent==='/' || validateStorage(parent) || /^[A-Za-z]:[\/\\]$/.test(parent))) return null;
 const separator=windows && parent.includes('\\')?'\\':'/';
 const target=parent.endsWith('/')||parent.endsWith('\\')?parent+child:parent+separator+child;
 return validateStorage(target)?target:null;
}
interface Option {id: string; label: string; description: string}
interface Step {label: string; description: string; kind: 'choice'|'input'|'multi'|'review'; options?: readonly Option[]; validate?: (value: string)=>boolean}
export function validateBackend(value: string): boolean {
 if (!/^https?:\/\//i.test(value) || /[\s\\?#]/.test(value)) return false;
 try { const u=new URL(value); return !!u.hostname && !u.username && !u.password && !value.includes('@'); } catch { return false; }
}
export function validateStorage(value: string): boolean {
 if (!value || value.trim()!==value || /[\x00-\x1f<>"|?*]/.test(value) || value.split(/[\\/]/).some(p=>p==='..'||p==='.')) return false;
 return (/^\/[^/]/.test(value) && !value.includes('\\') && !value.includes(':')) || (/^[A-Za-z]:[\\/].+/.test(value) && !value.slice(2).includes(':'));
}
const knownFeatures: FeatureId[] = ['director','forge','refmods','continuity'];
export const optionalFeatures: FeatureId[] = ['director'];
const directorIncluded=['forge','refmods','continuity','output'].map(id=>({id,label:`setup.feature.${id}.label`}));
export function effectiveSetupFeatures(features: readonly FeatureId[]): FeatureId[] { return knownFeatures.filter(id=>features.includes(id)||features.includes('director')); }
const option = (id: string, group: string): Option => ({id,label:`setup.${group}.${id}.label`,description:`setup.${group}.${id}.description`});
const step = (id: StepId, kind: Step['kind'], options?: Option[], validate?: Step['validate']): Step => ({label:`setup.step.${id}.label`,description:`setup.step.${id}.description`,kind,options,validate});
export const setupSteps: Record<StepId,Step> = {
 route: step('route','choice',['managed','existing'].map(id=>option(id,'route'))),
 storage: step('storage','input',undefined,validateStorage),
 pack: step('pack','multi',optionalFeatures.map(id=>option(id,'feature'))),
 acceleration: step('acceleration','choice',['cpu','nvidia','amd','intel'].map(id=>option(id,'backend'))),
 backend: step('backend','input',undefined,validateBackend),
 review: step('review','review'),
};
const routes: Record<string,readonly StepId[]> = {managed:['route','storage','pack','acceleration','review'],existing:['route','backend','review']};
export const SETUP_DRAFT_KEY='deas.setup.draft.v1'; // Keep old storage accessible; migrate explicitly.
export function initialSetupState(): SetupState { return {version:2,opened:false,motion:'light',values:{},confirmed:{},features:[],options:{sage:false,radial:false,flash:false,ffmpeg:false},comfyRef:'master'}; }
export function visibleSetupSteps(state: SetupState): StepId[] {
 if(!state.opened) return [];
 if(state.mode==='automatic') return ['route','storage','pack','acceleration','review'];
 const visible: StepId[]=[];
 for(const id of routes[state.values.route??'']??['route']) { visible.push(id); if(!state.confirmed[id]) break; }
 return visible;
}
export function activeSetupStep(state: SetupState): StepId|null { return visibleSetupSteps(state).at(-1)??null; }
export type SetupEvent = {type:'open'}|{type:'automatic'}|{type:'motion';motion:Motion}|{type:'select';step:StepId;value:string}|{type:'confirm';step:StepId}|{type:'choose';step:StepId;value:string}|{type:'feature';id:FeatureId}|{type:'option';id:keyof InstallOptions;enabled:boolean}|{type:'ref';value:string};
/** Edits invalidate this confirmation and later decisions, never silently confirm. */
function invalidateStep(state: SetupState, step: StepId): SetupState {
 const path=visibleSetupSteps(state), index=path.indexOf(step);
 const values={...state.values}, confirmed={...state.confirmed};
 for(const id of path.slice(index)) { delete confirmed[id]; if(id!==step) delete values[id]; }
 return {...state,values,confirmed};
}
export function transitionSetup(state: SetupState,event: SetupEvent): SetupState {
 if(event.type==='automatic') return {...state,mode:'automatic',opened:true,values:{...state.values,route:'managed',pack:'complete'},features:state.features.length?state.features:['director']}; // Director is the recommended package; untick to install core only
 if(event.type==='open') return {...state,opened:true};
 if(state.mode==='automatic') {
  if(event.type==='select'&&event.step==='storage') return {...state,values:{...state.values,storage:event.value}};
  if(event.type==='select'&&event.step==='acceleration'&&['cpu','nvidia','amd','intel'].includes(event.value)) return {...state,values:{...state.values,acceleration:event.value}};
  if(event.type==='feature'&&optionalFeatures.includes(event.id)) return {...state,features:state.features.includes(event.id)?state.features.filter(id=>id!==event.id):[...state.features,event.id]};
  if(event.type==='option'&&event.id in state.options) return {...state,options:{...state.options,[event.id]:event.enabled}};
  if(event.type==='ref') return {...state,comfyRef:event.value};
 }
 if(event.type==='motion') return ['light','paws','off'].includes(event.motion)?{...state,motion:event.motion}:state;
 if(event.type==='choose') { // Compatibility only; UI and detection use select/confirm.
  const selected=transitionSetup(state,{type:'select',step:event.step,value:event.value});
  return transitionSetup(selected,{type:'confirm',step:event.step});
 }
 if(event.type==='feature') {
  if(!visibleSetupSteps(state).includes('pack') || !optionalFeatures.includes(event.id)) return state;
  return {...invalidateStep(state,'pack'),features:state.features.includes(event.id)?state.features.filter(id=>id!==event.id):optionalFeatures.filter(id=>id===event.id||state.features.includes(id))};
 }
 if(event.type==='option') return visibleSetupSteps(state).includes('acceleration') && event.id in state.options && state.options[event.id]!==event.enabled ? {...invalidateStep(state,'acceleration'),options:{...state.options,[event.id]:event.enabled}}:state;
 if(event.type==='ref') return visibleSetupSteps(state).includes('acceleration') && /^[\w./-]{1,120}$/.test(event.value) && state.comfyRef!==event.value ? {...invalidateStep(state,'acceleration'),comfyRef:event.value}:state;
 const def=setupSteps[event.step];
 if(!def || !visibleSetupSteps(state).includes(event.step) || def.kind==='review') return state;
 const value=event.type==='confirm'?(def.kind==='multi'?'complete':state.values[event.step]):event.value;
 const valid=def.kind==='multi'?value==='complete':def.kind==='choice'?def.options?.some(o=>o.id===value):typeof value==='string'&&def.validate?.(value);
 if(!valid) return state;
 if(event.type==='confirm') return state.confirmed[event.step]?state:{...state,values:{...state.values,[event.step]:value},confirmed:{...state.confirmed,[event.step]:true}};
 if(state.values[event.step]===value) return state;
 const next=invalidateStep(state,event.step);
 const reset=event.step==='route'||event.step==='storage';
 return {...next,values:{...next.values,[event.step]:value},features:reset?[]:state.features,options:reset?initialSetupState().options:state.options};
}
/** View projection only: reopening a decision never mutates the saved path. */
export interface SetupMetadata { choices?: Record<string,{suggested?:boolean;detected?:boolean}> }
/** Apply trusted detection only to applicable, untouched choices. Suggestions alone never select. */
export function preselectDetectedSetup(state: SetupState, metadata: SetupMetadata, policy: {locked?:boolean;explicitChoices?:readonly string[]} = {}): SetupState {
 if(policy.locked) return state;
 const explicit=new Set(policy.explicitChoices??[]);
 const applicable=visibleSetupSteps(state);
 let next=state;
 if(applicable.includes('pack')&&!state.values.pack) for(const id of optionalFeatures) {
  const key=`setup:pack:${id}`;
  if(metadata.choices?.[key]?.detected&&!explicit.has(key)&&!explicit.has('setup:pack')&&!next.features.includes(id)) next=transitionSetup(next,{type:'feature',id});
 }
 if(applicable.includes('acceleration')&&!state.values.acceleration&&!explicit.has('setup:acceleration')) {
  const detected=setupSteps.acceleration.options?.filter(o=>metadata.choices?.[`setup:acceleration:${o.id}`]?.detected&&!explicit.has(`setup:acceleration:${o.id}`))??[];
  if(detected.length===1) next=transitionSetup(next,{type:'select',step:'acceleration',value:detected[0].id});
 }
 return next;
}
export function setupPresentation(state: SetupState, focusedStep: StepId|null = null, metadata: SetupMetadata = {}): {nodes: SetupNode[]; history: SetupNode[]} {
 const root: SetupNode={id:'setup:aio',label:'setup.aio.label',description:'setup.aio.description',status:'setup.status.notInstalled',parentId:null,column:0,order:0,selected:state.opened};
 const visible=visibleSetupSteps(state);
 const active=focusedStep&&visible.includes(focusedStep)?focusedStep:activeSetupStep(state);
 if(!active) return {nodes:[root],history:[]};
 const history: SetupNode[]=visible.filter(id=>Boolean(state.confirmed[id])&&id!==active).map((id,order)=>{
  const def=setupSteps[id];
  const selected=def.options?.find(o=>o.id===state.values[id]);
  const flags=selected?metadata.choices?.[`setup:${id}:${selected.id}`]:undefined;
  const detected=id==='pack'?state.features.some(feature=>metadata.choices?.[`setup:pack:${feature}`]?.detected):flags?.detected;
  return {included:id==='pack'&&state.features.includes('director')?directorIncluded:undefined,id:`setup:${id}`,label:def.label,status:id==='pack'?state.features.length?'setup.summary.capabilities':'setup.summary.core':selected?.label??state.values[id],detected,suggested:flags?.suggested,parentId:null,column:0,order,selected:true};
 });
 const def=setupSteps[active],nodeId=`setup:${active}`;
 const choices=def.options?.map(o=>({...metadata.choices?.[`${nodeId}:${o.id}`],id:`${nodeId}:${o.id}`,label:o.label,description:o.description,selected:def.kind==='multi'?state.features.includes(o.id as FeatureId):state.values[active]===o.id,included:active==='pack'&&o.id==='director'?directorIncluded:undefined}));
 return {nodes:[root,{id:nodeId,label:def.label,description:def.description,status:'setup.summary.next',parentId:root.id,column:1,order:0,selected:true,choices,selectionMode:def.kind==='multi'?'multi':'single'}],history};
}
export function setupGraph(state: SetupState): SetupNode[] {return setupPresentation(state).nodes;}
/** Included companions have no independent choices or suggestion roads. */
export function setupSuggestions(_state: SetupState): {id:string;fromId:string;toId:string;kind:'suggested'}[] { return []; }
export interface NativeInstallDefaults {storagePath:string;backend:'cpu'|'nvidia';hardware:Record<string,unknown>|null;warnings:string[]}
export interface NativeHardwareDetection {backend: 'nvidia'|null; hardware?:Record<string,unknown>|null; warnings?:string[]}
export interface NativeInstallRequest {storagePath:string;backend:Backend;features:FeatureId[];options:InstallOptions;comfyRef:string;folders?:import('./settings').Folders}
export interface NativeInstallPlan {id:string;reopenId?:string;request:NativeInstallRequest;steps:{id:string;labelKey:string;detail:string}[];warnings:string[];unsupportedOptions:string[];canExecute:boolean;hardware?:{vendor:string;name:string;uuid:string;driverVersion:string;computeCapability:string}|null;torch?:{packages:string[];indexUrl:string;cuda:string|null}|null}
export interface NativeInstallStatus {state:'idle'|'running'|'succeeded'|'failed'|'cancelled';stepId:string|null;logs:string[];error:string|null}
export interface NativeBackendStatus {state:'starting'|'running'|'failed'|'stopped';endpoint:string|null;error:string|null;generationReady:false}
export type SetupPlan = {version:2;provisioningAvailable:false} & ({status:'NOT INSTALLED';route:'managed'} & NativeInstallRequest | {status:'NOT INSPECTED';route:'existing';baseUrl:string});
export function setupPlan(state: SetupState): SetupPlan|null {
 if(activeSetupStep(state)!=='review'||! /^[\w./-]{1,120}$/.test(state.comfyRef)) return null;
 const v=state.values;
 if(v.route==='existing'&&v.backend&&validateBackend(v.backend)) return {version:2,status:'NOT INSPECTED',route:'existing',baseUrl:v.backend,provisioningAvailable:false};
 if(v.route==='managed'&&v.storage&&validateStorage(v.storage)&&v.pack==='complete'&&['cpu','nvidia','amd','intel'].includes(v.acceleration??'')) return {version:2,status:'NOT INSTALLED',route:'managed',storagePath:v.storage,backend:v.acceleration as Backend,features:effectiveSetupFeatures(state.features),options:{...state.options},comfyRef:state.comfyRef,provisioningAvailable:false};
 return null;
}
export function serializeSetup(state: SetupState): string {return JSON.stringify(state);}
export function restoreSetup(raw:string): SetupState|null {
 try {
  const data=JSON.parse(raw);
  if(!data || ![1,2].includes(data.version) || typeof data.opened!=='boolean' || !['light','paws','off'].includes(data.motion) || !data.values || typeof data.values!=='object' || Array.isArray(data.values)) return null;
  const legacy=data.version===1;
  const values={...data.values};
  if(legacy) {
   if(values.pack && !['director','minimal'].includes(values.pack)) return null;
   if(values.acceleration && values.acceleration!=='baseline') return null; // Never silently choose a GPU for old auto-detect intents.
   if(values.pack) values.pack='complete';
   if(values.acceleration) values.acceleration='cpu';
  }
  const features=legacy?(data.values.pack==='director'?['director']:[]):data.features;
  const options=legacy?initialSetupState().options:data.options;
  const comfyRef=legacy?'master':data.comfyRef;
  if(!Array.isArray(features)||features.some(id=>!knownFeatures.includes(id))||new Set(features).size!==features.length || !options || Object.keys(options).length!==4 || !Object.keys(initialSetupState().options).every(k=>typeof options[k]==='boolean') || typeof comfyRef!=='string'||!/^[\w./-]{1,120}$/.test(comfyRef)) return null;
  if(data.mode==='automatic') {
   if(!data.opened||values.route!=='managed'||values.pack!=='complete'||Object.keys(values).some(k=>!['route','storage','pack','acceleration'].includes(k))|| (values.storage!==undefined&&typeof values.storage!=='string') || (values.acceleration!==undefined&&!['cpu','nvidia','amd','intel'].includes(values.acceleration)))return null;
   return {...initialSetupState(),mode:'automatic',opened:true,motion:data.motion,values,features,options,comfyRef};
  }
  if(data.mode!==undefined)return null;
  const confirmations=legacy||data.confirmed===undefined?Object.fromEntries(Object.keys(values).map(id=>[id,true])):data.confirmed;
  if(!confirmations||typeof confirmations!=='object'||Array.isArray(confirmations)||Object.entries(confirmations).some(([id,value])=>!Object.hasOwn(values,id)||value!==true||id==='review'))return null;
  let state={...initialSetupState(),opened:data.opened,motion:data.motion};
  const pending=new Set(Object.keys(values));
  for(const id of routes[values.route]??['route']) {
   if(!pending.has(id)) continue;
   if(typeof values[id]!=='string') return null;
   const next=transitionSetup(state,{type:'select',step:id,value:values[id]});
   if(next===state) return null;
   state=confirmations[id]?transitionSetup(next,{type:'confirm',step:id}):next;pending.delete(id);
  }
  if(pending.size || (features.length && !visibleSetupSteps(state).includes('pack')) || (Object.values(options).some(Boolean)&&!visibleSetupSteps(state).includes('acceleration'))) return null;
  return {...state,features:features as FeatureId[],options,comfyRef};
 } catch {return null;}
}
