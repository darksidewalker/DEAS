import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkCount, videoFrames } from '../src/lib/videoIntent.ts';
import { nextStep, resolveClip, isContinuityPlan, type ContinuityPlan } from '../src/lib/continuity.ts';

test('frame counts follow the owner workflows: 8k+1 for LTX/Wan, 17k+5 at 24 fps for MiniMax H3', () => {
  assert.equal(videoFrames('wan', 5, 16), 81);
  assert.equal(videoFrames('ltx-2', 5, 24), 121);
  assert.equal(videoFrames('ltx-2', 2, 24), 49);
  assert.equal(videoFrames('minimax-h3', 5, 24), 124);
  assert.equal(videoFrames('minimax-h3', 2, 24), 56);
  assert.equal(videoFrames('minimax-h3', 0.1, 24), 5);
});

test('chunk count is the FastFidelity formula max(1, round((frames·w·h/120e6)^1.3·0.5·headroom)); 1 means no chunking node', () => {
  assert.equal(chunkCount(81, 528, 768, 1), undefined);
  assert.equal(chunkCount(121, 1920, 1088, 4), Math.round(((121 * 1920 * 1088) / 120_000_000) ** 1.3 * 0.5 * 4));
  assert.equal(chunkCount(121, 1920, 1088, 4), 5);
});

test('explicit continuity overlap reaches extensions but not the initial capture',()=>{
  for(const overlapFrames of [73,56,39,22,5] as const){
    const plan={session:'deas-test',outputMode:'full' as const,overlapFrames,steps:[{id:'a',seconds:5,action:'',clipId:'root'},{id:'b',seconds:3,action:'turn'}]};
    assert.equal(nextStep(plan)?.continuity.overlapFrames,overlapFrames);
    plan.steps[0].clipId=undefined;
    assert.equal(Object.hasOwn(nextStep(plan)!.continuity,'overlapFrames'),false);
  }
});

test('saved continuity plans validate overlap without migrating old plans',()=>{
  const old={session:'deas-test',outputMode:'segment',steps:[]};
  assert.equal(isContinuityPlan(old),true);
  assert.equal(Object.hasOwn(old,'overlapFrames'),false);
  for(const overlapFrames of [73,56,39,22,5])assert.equal(isContinuityPlan({...old,overlapFrames}),true);
  for(const overlapFrames of [null,true,'22',22.5,0,-1,74,NaN,Infinity])assert.equal(isContinuityPlan({...old,overlapFrames}),false,String(overlapFrames));
});

test('saved continuity reference opt-in is optional and strictly boolean',()=>{
  const old={session:'deas-test',outputMode:'full',steps:[]};
  assert.equal(isContinuityPlan(old),true);
  assert.equal(Object.hasOwn(old,'useReferences'),false);
  for(const useReferences of [true,false])assert.equal(isContinuityPlan({...old,useReferences}),true);
  for(const useReferences of [null,'true','false',0,1,[],{}])assert.equal(isContinuityPlan({...old,useReferences}),false,JSON.stringify(useReferences));
});

test('explicit reference choices reach continuations but never the initial capture',()=>{
  for(const useReferences of [undefined,false,true]){
    const plan={session:'deas-test',outputMode:'full' as const,...(useReferences===undefined?{}:{useReferences}),steps:[{id:'a',seconds:5,action:'',clipId:undefined as string|undefined},{id:'b',seconds:3,action:'turn'}]};
    assert.equal(Object.hasOwn(nextStep(plan)!.continuity,'useReferences'),false);
    plan.steps[0].clipId='root';
    assert.equal(Object.hasOwn(nextStep(plan)!.continuity,'useReferences'),useReferences!==undefined);
    assert.equal(nextStep(plan)!.continuity.useReferences,useReferences);
    const source={clipId:'chosen',endpoint:'http://localhost:7801'};
    plan.steps[0].clipId=undefined;
    assert.equal(nextStep({...plan,source})!.continuity.useReferences,useReferences);
    assert.equal(nextStep({...plan,source:{...source,clipId:'a'.repeat(64),kind:'video'}})!.continuity.useReferences,useReferences);
  }
});

test('continuity sessions preserve literal valid names and reject reserved or unsafe identifiers',()=>{
  const old={session:'deas-test',outputMode:'full',steps:[]};
  for(const session of ['test_1-2','a','a'.repeat(80),'_imports-other'])assert.equal(isContinuityPlan({...old,session}),true);
  for(const session of ['_imports','','a'.repeat(81),'a/b','a b','ümlaut'])assert.equal(isContinuityPlan({...old,session}),false,session);
});

test('selected checkpoint anchors the first continuation and later steps use their own predecessor',()=>{
 const plan:ContinuityPlan={session:'deas-test',outputMode:'segment',overlapFrames:56,source:{clipId:'chosen-root',endpoint:'http://127.0.0.1:7801'},steps:[{id:'a',seconds:5,action:'turn'},{id:'b',seconds:3,action:'walk'}]};
 assert.deepEqual(nextStep(plan),{index:0,continuity:{session:'deas-test',sourceId:'chosen-root',capture:true,action:'turn',outputMode:'segment',overlapFrames:56}});
 plan.steps[0]={...plan.steps[0],clipId:'child'};
 assert.equal(nextStep(plan)?.continuity.sourceId,'child');
});

test('saved checkpoint source requires a valid clip and bounded endpoint identity',()=>{
 const old={session:'deas-test',outputMode:'full',steps:[]};
 assert.equal(isContinuityPlan({...old,source:{clipId:'clip_1',endpoint:'http://127.0.0.1:7801'}}),true);
 for(const source of [null,{}, {clipId:'bad/path',endpoint:'x'}, {clipId:'',endpoint:'x'}, {clipId:'ok',endpoint:''},{clipId:'ok',endpoint:42},{clipId:'ok',endpoint:'x'.repeat(2049)}])assert.equal(isContinuityPlan({...old,source}),false);
});

test('prepared video is used only for the first step and its generated child resolves through backend provenance',()=>{
 const sourceId='a'.repeat(64);const endpoint='http://127.0.0.1:7801';
 const plan:ContinuityPlan={session:'deas-test',outputMode:'full',source:{clipId:sourceId,endpoint,kind:'video'},steps:[{id:'a',seconds:5,action:'turn'},{id:'b',seconds:3,action:'walk'}]};
 assert.equal(nextStep(plan)?.continuity.sourceKind,'video');
 const imported={sourceId,width:768,height:512,modeFamily:'fl2va' as const};
 const clips=[{clipId:'backend-import',parent:null,frames:240,completed:1,export:null,importedVideo:imported},{clipId:'child',parent:'backend-import',frames:360,completed:2,export:null},{clipId:'wrong',parent:null,frames:360,completed:99,export:null}];
 assert.equal(resolveClip(clips,sourceId,imported),'child');
 assert.equal(resolveClip(clips,sourceId,{...imported,width:1024}),undefined);
 assert.equal(resolveClip([...clips,{...clips[0],clipId:'ambiguous-import'}],sourceId,imported),undefined);
 plan.steps[0].clipId='child';
 assert.equal(nextStep(plan)?.continuity.sourceId,'child');
 assert.equal(Object.hasOwn(nextStep(plan)!.continuity,'sourceKind'),false);
});

test('saved video sources reject unknown kinds and malformed manifest IDs without altering old checkpoint plans',()=>{
 const old={session:'deas-test',outputMode:'full',steps:[]};
 assert.equal(isContinuityPlan({...old,source:{clipId:'a'.repeat(64),endpoint:'http://localhost:7801',kind:'video'}}),true);
 for(const source of [{clipId:'not-a-manifest',endpoint:'x',kind:'video'},{clipId:'A'.repeat(64),endpoint:'x',kind:'video'},{clipId:'clip',endpoint:'x',kind:'unknown'},{clipId:'clip',endpoint:'x',kind:null}])assert.equal(isContinuityPlan({...old,source}),false);
});

test('continuity plan runs steps in order and pins the newest child clip of the previous step', () => {
  const plan: ContinuityPlan = { session: 'deas-ab12', outputMode: 'full', steps: [{ id: 'a', seconds: 5, action: '' }, { id: 'b', seconds: 3, action: 'she turns' }, { id: 'c', seconds: 2, action: 'cut' }] };
  assert.deepEqual(nextStep(plan), { index: 0, continuity: { session: 'deas-ab12', sourceId: '', capture: true, action: '', outputMode: 'full' } });
  const clips = [{ clipId: 'r1', parent: null, frames: 124, completed: 1, export: null }, { clipId: 'r2', parent: null, frames: 124, completed: 2, export: null }, { clipId: 'k1', parent: 'r2', frames: 200, completed: 3, export: null }];
  assert.equal(resolveClip(clips, undefined), 'r2');
  plan.steps[0].clipId = 'r2';
  assert.equal(nextStep(plan)?.continuity.sourceId, 'r2');
  assert.equal(nextStep(plan)?.continuity.action, 'she turns');
  assert.equal(resolveClip(clips, 'r2'), 'k1');
  assert.equal(resolveClip(clips, 'nope'), undefined);
  plan.steps[1].clipId = undefined; plan.steps[2].clipId = 'k9';
  assert.equal(nextStep(plan)?.index, 1);
  plan.steps[1].clipId = 'k1';
  assert.equal(nextStep(plan), null);
});
