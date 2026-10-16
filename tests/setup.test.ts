import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSetupState, setupGraph, setupPresentation, storageTarget, transitionSetup, setupPlan, serializeSetup, restoreSetup, validateBackend, validateStorage, activeSetupStep, setupSuggestions, preselectDetectedSetup, type SetupState, type StepId } from '../src/lib/setup.ts';
const select=(s:SetupState,step:StepId,value:string)=>transitionSetup(s,{type:'select',step,value});
const confirm=(s:SetupState,step:StepId)=>transitionSetup(s,{type:'confirm',step});
function through(last:StepId='acceleration') {
 let s=transitionSetup(initialSetupState(),{type:'open'});
 for(const [step,value] of [['route','managed'],['storage','/data/DEAS'],['pack','complete'],['acceleration','cpu']] as const){s=confirm(select(s,step,value),step);if(step===last)break;}
 return s;
}
test('automatic review keeps all fields editable without per-step confirmation',()=>{
 let s=transitionSetup(initialSetupState(),{type:'automatic'});
 assert.equal(activeSetupStep(s),'review');assert.equal(setupPlan(s),null);assert.deepEqual(s.features,['director']);
 s=transitionSetup(s,{type:'feature',id:'director'});assert.deepEqual(s.features,[]);
 s=select(s,'storage','/data/new');s=select(s,'acceleration','cpu');
 assert.ok(setupPlan(s));
 s=transitionSetup(s,{type:'option',id:'ffmpeg',enabled:true});
 s=select(s,'storage','/data/other');
 assert.equal(s.options.ffmpeg,true);assert.equal(activeSetupStep(s),'review');
 assert.deepEqual(restoreSetup(serializeSetup(s)),s);
 s=select(s,'storage','');assert.equal(setupPlan(s),null);
});
test('selection requires explicit confirmation before continuing',()=>{
 let s=transitionSetup(initialSetupState(),{type:'open'});s=select(s,'route','managed');
 assert.equal(s.values.route,'managed');assert.equal(activeSetupStep(s),'route');assert.equal(setupPlan(s),null);
 assert.equal(activeSetupStep(confirm(s,'route')),'storage');
});
test('every input and choice blocks progression until confirmed',()=>{
 let s=transitionSetup(initialSetupState(),{type:'open'});
 for(const [step,value] of [['route','managed'],['storage','/data/DEAS'],['pack','complete'],['acceleration','cpu']] as const){s=select(s,step,value);assert.equal(activeSetupStep(s),step);assert.equal(setupPlan(s),null);s=confirm(s,step);}
 assert.equal(activeSetupStep(s),'review');assert.deepEqual(setupPlan(s)?.route,'managed');
});
test('cannot confirm missing or invalid selections or skip steps',()=>{
 const s=transitionSetup(initialSetupState(),{type:'open'});
 assert.equal(confirm(s,'route'),s);assert.equal(select(s,'acceleration','cpu'),s);assert.equal(select(s,'route','unknown'),s);
});
test('Director is the sole selectable package and expands the canonical install bundle',()=>{
 let s=through('storage');s=transitionSetup(s,{type:'feature',id:'director'});
 assert.deepEqual(s.features,['director']);assert.deepEqual(setupSuggestions(s),[]);
 assert.equal(transitionSetup(s,{type:'feature',id:'forge'}),s);
 const view=setupPresentation(s);const choices=view.nodes.at(-1)!.choices!;
 assert.deepEqual(choices.map(c=>c.id),['setup:pack:director']);
 assert.deepEqual(choices[0].included?.map(c=>c.id),['forge','refmods','continuity','output']);assert.equal(choices[0].suggests,undefined);
 s=confirm(s,'pack');s=confirm(select(s,'acceleration','cpu'),'acceleration');
 const plan=setupPlan(s);assert.ok(plan?.route==='managed');assert.deepEqual(plan.features,['director','forge','refmods','continuity']);
 assert.deepEqual(setupPresentation(s).history.find(n=>n.id==='setup:pack')?.included,choices[0].included);
});
test('core only is valid without optional packages or generation claims',()=>{
 const s=through(),plan=setupPlan(s);assert.ok(plan?.route==='managed');assert.deepEqual(plan.features,[]);assert.equal(plan.status,'NOT INSTALLED');
 assert.equal(new Set(setupGraph(s).map(n=>n.id)).size,setupGraph(s).length);
});
test('backend selection retains all explicit options and ref without skipping',()=>{
 let s=through('pack');s=select(s,'acceleration','nvidia');
 for(const id of ['sage','radial','flash','ffmpeg'] as const)s=transitionSetup(s,{type:'option',id,enabled:true});
 s=transitionSetup(s,{type:'ref',value:'v0.3.50'});s=select(s,'acceleration','cpu');
 assert.equal(activeSetupStep(s),'acceleration');assert.equal(setupPlan(s),null);assert.ok(Object.values(s.options).every(Boolean));assert.equal(s.comfyRef,'v0.3.50');
 s=confirm(s,'acceleration');assert.equal(activeSetupStep(s),'review');
 assert.equal(select(s,'storage','/other').options.sage,false);
});
test('editing architecture options or ref invalidates confirmation and plan',()=>{
 for(const event of [{type:'option',id:'sage',enabled:true},{type:'ref',value:'v0.3.50'}] as const){const s=transitionSetup(through(),event);assert.equal(activeSetupStep(s),'acceleration');assert.equal(s.confirmed.acceleration,undefined);assert.equal(setupPlan(s),null);}
});
test('detected NVIDIA only prefills and must be confirmed',()=>{
 const s=through('pack'),metadata={choices:{'setup:acceleration:nvidia':{detected:true,suggested:true}}};
 const next=preselectDetectedSetup(s,metadata);assert.equal(next.values.acceleration,'nvidia');assert.equal(activeSetupStep(next),'acceleration');assert.equal(setupPlan(next),null);
 assert.equal(setupPresentation(next,null,metadata).nodes.at(-1)?.choices?.find(c=>c.id.endsWith(':nvidia'))?.detected,true);
 assert.equal(setupPresentation(confirm(next,'acceleration'),null,metadata).history.find(n=>n.id==='setup:acceleration')?.detected,true);
});
test('late detection never overrides manual, restored, prepared or running choices',()=>{
 const metadata={choices:{'setup:acceleration:nvidia':{detected:true}}};const s=through('pack');
 for(const policy of [{locked:true},{explicitChoices:['setup:acceleration']}])assert.equal(preselectDetectedSetup(s,metadata,policy),s);
 const manual=select(s,'acceleration','cpu');assert.equal(preselectDetectedSetup(manual,metadata),manual);const prepared=through();assert.equal(preselectDetectedSetup(prepared,metadata),prepared);
 const restored=restoreSetup(serializeSetup(manual))!;assert.equal(preselectDetectedSetup(restored,metadata),restored);
});
test('suggestions and detected included companions never select packages',()=>{
 const s=through('storage');assert.equal(preselectDetectedSetup(s,{choices:{'setup:pack:forge':{detected:true},'setup:pack:director':{suggested:true}}}),s);
});
test('reopening history is passive and unchanged selections retain confirmations',()=>{
 const s=through(),raw=serializeSetup(s);setupPresentation(s,'route');setupPresentation(s,'pack');assert.equal(serializeSetup(s),raw);assert.equal(select(s,'route','managed'),s);
});
test('history edits never skip an unconfirmed step and clear incompatible downstream',()=>{
 const s=select(through(),'route','existing');assert.deepEqual(s.values,{route:'existing'});assert.deepEqual(s.confirmed,{});assert.equal(activeSetupStep(s),'route');
 assert.equal(setupPresentation(s,'acceleration').nodes.at(-1)?.id,'setup:route');assert.equal(activeSetupStep(confirm(s,'route')),'backend');
});
test('saved confirmations preserve an unfinished selection exactly',()=>{
 let s=select(through('pack'),'acceleration','nvidia');s=transitionSetup(s,{type:'option',id:'sage',enabled:true});
 assert.deepEqual(restoreSetup(serializeSetup(s)),s);assert.equal(activeSetupStep(restoreSetup(serializeSetup(s))!),'acceleration');
 const pack=transitionSetup(through('storage'),{type:'feature',id:'director'});assert.deepEqual(restoreSetup(serializeSetup(pack)),pack);
});
test('old v2 drafts infer confirmations and honor saved standalone feature choices',()=>{
 const {confirmed,...old}=through();const restored=restoreSetup(JSON.stringify({...old,features:['director']}));assert.equal(activeSetupStep(restored!),'review');assert.deepEqual(restored?.features,['director']);
 const legacyExtras=restoreSetup(JSON.stringify({...old,features:['forge']}));assert.deepEqual(legacyExtras?.features,['forge']);
 assert.ok(setupPlan(legacyExtras!)?.route==='managed');
});
test('legacy Director drafts expand bundle without changing paths or backend',()=>{
 const s=restoreSetup(JSON.stringify({version:1,opened:true,motion:'paws',values:{route:'managed',storage:'/data/DEAS',pack:'director',acceleration:'baseline'}}));assert.deepEqual(s?.features,['director']);const plan=setupPlan(s!);assert.ok(plan?.route==='managed');assert.deepEqual(plan.features,['director','forge','refmods','continuity']);assert.equal(plan.backend,'cpu');
});
test('rejects malformed drafts and confirmation gaps without changing saved original',()=>{
 const s=through();for(const raw of ['null','{}','{bad',JSON.stringify({...s,version:99}),JSON.stringify({...s,features:['unknown']}),JSON.stringify({...s,opened:false}),JSON.stringify({...s,confirmed:{route:true,pack:true}}),JSON.stringify({...s,confirmed:{route:'yes'}})])assert.equal(restoreSetup(raw),null);
 assert.equal(restoreSetup(JSON.stringify({version:1,opened:true,motion:'light',values:{route:'managed',storage:'/data/DEAS',pack:'image'}})),null);
});
test('existing route URL also requires confirmation before explicit read-only handoff',()=>{
 let s=confirm(select(transitionSetup(initialSetupState(),{type:'open'}),'route','existing'),'route');s=select(s,'backend','https://localhost:8188/comfy');assert.equal(setupPlan(s),null);s=confirm(s,'backend');assert.deepEqual(setupPlan(s),{version:2,status:'NOT INSPECTED',route:'existing',baseUrl:'https://localhost:8188/comfy',provisioningAvailable:false});
});
test('validates URLs and absolute storage',()=>{
 for(const v of ['', 'localhost:8188','ftp://localhost','https://user:pass@localhost','https://localhost?','https://localhost#','https://localhost/ space'])assert.equal(validateBackend(v),false,v);
 for(const v of ['', '~/.deas','relative/path','/','/data/../etc','C:\\','/data\nname'])assert.equal(validateStorage(v),false,v);
 for(const v of ['/data/deas','C:\\DEAS','D:/Models'])assert.equal(validateStorage(v),true,v);
});
test('native folder joining preserves Linux and Windows parent spelling and rejects unsafe child names',()=>{
 assert.equal(storageTarget('/data','deas-environment'),'/data/deas-environment');
 assert.equal(storageTarget('/','new'),'/new');
 assert.equal(storageTarget('C:\\Models','new'),'C:\\Models\\new');
 assert.equal(storageTarget('D:/Models/','new'),'D:/Models/new');
 assert.equal(storageTarget('C:\\','new'),'C:\\new');
 for(const child of ['','..','../escape','a/b','a\\b','CON','x.',' x','bad:name'])assert.equal(storageTarget('/data',child),null,child);
});
