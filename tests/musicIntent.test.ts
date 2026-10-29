import assert from 'node:assert/strict';
import test from 'node:test';
import {defaultAbc,defaultMusicGeneration,isMusicIntent,isMusicPipeline,musicBounds,musicMaxDuration} from '../src/lib/musicIntent.ts';

test('YuE2 settings are separate and template exact',()=>{
 assert.equal(defaultAbc.temperature,0.7);
 assert.equal(defaultAbc.maxTokens,8192);
 assert.equal(defaultMusicGeneration.temperature,1);
 assert.equal(defaultMusicGeneration.repetitionPenalty,1.2);
 assert.equal(defaultMusicGeneration.cfgScale,1);
 assert.deepEqual(musicMaxDuration,{t2m:120,cover:360,limit:900,step:0.04});
 assert.equal(isMusicIntent({recipeId:'music-generation'}),true);
 assert.equal(isMusicIntent({recipeId:'video-generation'}),false);
 assert.equal(isMusicPipeline('cover'),true);
 assert.equal(isMusicPipeline('t2i'),false);
});

test('defaults sit inside the native bounds',()=>{
 for(const [group,defaults] of [['generation',defaultMusicGeneration],['abc',defaultAbc]] as const){
  for(const [key,value] of Object.entries(defaults)){
   const [min,max,integer]=(musicBounds[group] as Record<string,readonly [number,number,boolean]>)[key];
   assert.ok(value>=min&&value<=max,`${group}.${key}`);
   if(integer)assert.ok(Number.isInteger(value),`${group}.${key} integer`);
  }
 }
});
