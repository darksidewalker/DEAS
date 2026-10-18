import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRecipe } from '../src/lib/execution.ts';

const intent = {recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:'my subject',negativePrompt:'blur',checkpoint:'m.safetensors',seed:42,width:512,height:512,steps:1,cfg:1,sampler:'euler',scheduler:'normal',outputPrefix:'DEAS'};
const allow = {nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage','DaSiWa_WildcardPresetPromptBuilder'],checkpoints:['m.safetensors'],samplers:['euler'],schedulers:['normal']};
const wildcard = {style:'Booru',seed:7,reroll:3,token_budget:200,auto_reroll:true,selection_state:{'Art/Light/wildcards':{enabled:true,weight:1.2}}};
test('metadata saver receives evaluated wildcard strings rather than graph-traced placeholders',()=>{
 const graph=compileRecipe({...intent,wildcard},{...allow,nodes:[...allow.nodes,'DaSiWa_MetadataConfig','DaSiWa_MetadataImageSaver']}).graph;
 assert.deepEqual(graph.M.inputs.text_positive,['WP',0]);
 assert.deepEqual(graph.M.inputs.text_negative,['WP',1]);
});
test('wildcard plugin receives base prompts, selections and per-execution reroll without frontend expansion',()=>{
 const graph=compileRecipe({...intent,wildcard},allow).graph;
 assert.deepEqual(graph.WP,{class_type:'DaSiWa_WildcardPresetPromptBuilder',inputs:{...wildcard,selection_state:JSON.stringify(wildcard.selection_state),positive_input:'my subject',negative_input:'blur'}});
 assert.deepEqual(graph['2'].inputs.text,['WP',0]);
 assert.deepEqual(graph['3'].inputs.text,['WP',1]);
 assert.equal(graph.WP.inputs.auto_reroll,true);
 assert.equal(compileRecipe(intent,allow).graph.WP,undefined);
});
test('wildcards fail closed when plugin is absent or settings are invalid',()=>{
 assert.throws(()=>compileRecipe({...intent,wildcard},{...allow,nodes:allow.nodes.slice(0,-1)}),/DaSiWa_WildcardPresetPromptBuilder/);
 for(const patch of [{seed:-1},{seed:2**32},{reroll:2**31},{token_budget:0},{auto_reroll:'yes'},{style:'other'},{selection_state:[]},{selection_state:{x:{enabled:true,weight:Infinity}}},{extra:true}]){
  assert.throws(()=>compileRecipe({...intent,wildcard:{...wildcard,...patch}},allow),/wildcard/);
 }
});
