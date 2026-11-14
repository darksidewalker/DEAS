import {describe,it,expect} from 'vitest';
import {checkModel} from './modelCheck';
import type {LocalModel} from './models';
const model=(extra:Partial<LocalModel>={}):LocalModel=>({category:'checkpoints',name:'unknown.safetensors',path:'/models/unknown.safetensors',size:64,info:null,...extra});
describe('shared model decisions',()=>{
 it('keeps unknown checkpoints and unknown quantizations unknown, not incompatible',()=>{
  expect(checkModel(model()).compatibility).toBe('unknown');
  expect(checkModel(model({name:'future-Q99.gguf'})).compatibility).toBe('unknown');
 });
 it('keeps metadata and integrity failures independent and never lets a hash repair them',()=>{
  const result=checkModel(model({metadataError:'stale',integrity:'truncated',info:{sha256:'a'.repeat(64),size:64,fetchedAt:1,civitai:null}}));
  expect(result.identity).toBe('sha256');expect(result.compatibility).toBe('blocked');expect(result.reasons.map(r=>r.code)).toEqual(expect.arrayContaining(['metadata','integrity']));
 });
 it('preserves native header/hash conflicts',()=>{
  expect(checkModel(model({check:{identity:'sha256',compatibility:'blocked',availability:'available',evidence:['header','provider'],reasons:[{code:'conflict'}]}})).compatibility).toBe('blocked');
 });
 it('matches header components before names and cannot override broken files',()=>{
  expect(checkModel(model({component:'wrong'}),{component:['right']}).compatibility).toBe('blocked');
  expect(checkModel(model({component:'right'}),{component:['right']}).compatibility).toBe('suitable');
 });
 it('separates absent loader and file availability from compatibility',()=>{
  const result=checkModel(model({family:'sdxl'}),{family:'sdxl',available:[],loaders:[],requiredLoaders:['CheckpointLoaderSimple']});
  expect(result.compatibility).toBe('suitable');expect(result.availability).toBe('missing');expect(result.reasons.map(r=>r.code)).toEqual(expect.arrayContaining(['missingModel','missingLoader']));
 });
 it('never upgrades remote inventory or successful specialized discovery to structural verification',()=>{
  const result=checkModel(undefined,{name:'remote.gguf',remote:true,available:['remote.gguf']});
  expect(result.compatibility).toBe('unknown');expect(result.availability).toBe('available');expect(result.evidence).not.toContain('header');
  const listed=checkModel(model({path:'',family:'sdxl',check:{identity:'sha256',compatibility:'suitable',availability:'available',evidence:['header'],reasons:[]}}),{family:'sdxl'});
  expect(listed.compatibility).toBe('unknown');expect(listed.identity).toBe('unverified');expect(listed.evidence).not.toContain('header');expect(listed.reasons.map(r=>r.code)).toContain('remote');
  expect(checkModel(undefined,{specialized:{ready:true,evidence:'gguf-discovery'}}).compatibility).toBe('unknown');
  expect(checkModel(undefined,{specialized:{ready:false,reason:'runtime missing'}}).availability).toBe('missing');
 });
 it('preserves exact hash identity after rename without guessing family from hash',()=>{
  const info={sha256:'b'.repeat(64),size:64,fetchedAt:1,civitai:null};
  expect(checkModel(model({info}))).toEqual(checkModel(model({name:'renamed.safetensors',info})));
 });
});
