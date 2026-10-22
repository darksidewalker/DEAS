import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultOutputNaming, outputNamingTemplate, outputPrefix, safeOutputPrefix } from '../src/lib/outputNaming.ts';
import { compileRecipe } from '../src/lib/execution.ts';

const context={type:'image' as const,seed:42,model:'nested/My Model.v2.safetensors'};
const now=new Date(2026,0,2,3,4,5);
test('new generations resolve literal relative templates under raw without changing submitted prefixes',()=>{
 assert.equal(defaultOutputNaming,'%type%/%date_yyyy-mm-dd%/%time%-%seed%-%model%');
 assert.equal(outputPrefix('custom/%type%/%seed%-%model%',context,now),'raw/custom/image/42-My-Model-v2');
 assert.equal(outputNamingTemplate('raw/custom/%seed%'),'raw/custom/%seed%');
 assert.equal(outputPrefix('raw/custom/%seed%',context,now),'raw/raw/custom/42');
 assert.equal(safeOutputPrefix('legacy/image/42'),true);
});
test('naming snapshots local date/time, exact seed and sanitized basename, independent of saver',()=>{
 assert.equal(outputPrefix(defaultOutputNaming,context,now),'raw/image/2026-01-02/03-04-05-42-My-Model-v2');
 for(const type of ['image','video','audio'] as const) assert.equal(outputPrefix('%type%/%seed%-%model%',{...context,type},now),`raw/${type}/42-My-Model-v2`);
 assert.equal(outputPrefix('%seed%-%seed%',{...context,seed:Number.MAX_SAFE_INTEGER},now),'raw/9007199254740991-9007199254740991');
 assert.equal(outputPrefix('%model%',{...context,model:'folder/模型.safetensors'},now),'raw/model');
 for(const template of ['', '../%seed%', '/%model%', '%unknown%', '%seed', 'CON', 'a/aux.png','a/name.','a//b','a/./b','a/../b','a\\b','a:b','a\n','x'.repeat(181),`${'a'.repeat(130)}/${'b'.repeat(130)}/file`]) assert.equal(outputPrefix(template,context,now),null,template);
 assert.equal(safeOutputPrefix('x'.repeat(180)),true);
 assert.equal(outputNamingTemplate('%type%/%date_yyyy_mm_dd%/%time%-%seed%-%model%'),defaultOutputNaming);
 assert.equal(outputNamingTemplate('custom/%date_yyyy_mm_dd%/%model%'),'custom/%date_yyyy-mm-dd%/%model%');
 assert.equal(outputNamingTemplate(undefined),defaultOutputNaming);
 assert.equal(outputPrefix(outputNamingTemplate('%date_yyyy_mm_dd%'),context,now),'raw/2026-01-02');
 assert.equal(outputPrefix('%model%',{...context,model:'My_Model_.safetensors'},now),'raw/My-Model');
});
test('validates the full raw path against existing prefix limits',()=>{
 const atLimit=`${'a'.repeat(125)}/${'b'.repeat(125)}/${'c'.repeat(180)}`;
 const overLimit=`a${atLimit}`;
 assert.equal(safeOutputPrefix(overLimit),true);
 assert.equal(outputPrefix(atLimit,context,now),`raw/${atLimit}`);
 assert.equal(outputPrefix(overLimit,context,now),null);
 assert.equal(outputPrefix('x'.repeat(180),context,now),`raw/${'x'.repeat(180)}`);
 assert.equal(outputPrefix('a/'.repeat(257),context,now),null);
});
test('resolved paths feed both the core and DaSiWa metadata savers unchanged',()=>{
 const prefix=outputPrefix(defaultOutputNaming,context,now)!;
 const intent={recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:'',negativePrompt:'',checkpoint:context.model,seed:42,width:512,height:512,steps:1,cfg:1,sampler:'euler',scheduler:'normal',outputPrefix:prefix};
 const allow={nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage'],checkpoints:[context.model],samplers:['euler'],schedulers:['normal']};
 for(const nodes of [allow.nodes,[...allow.nodes,'DaSiWa_MetadataImageSaver','DaSiWa_MetadataConfig']]) assert.equal(compileRecipe(intent,{...allow,nodes}).graph['7'].inputs.filename_prefix,prefix);
});
