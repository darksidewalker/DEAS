import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { writeModelFamily, type LocalModel } from './models';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
beforeEach(()=>{ vi.mocked(invoke).mockReset(); });

it('writes and resets family declarations with the exact native contract',async()=>{
  const model:LocalModel={category:'checkpoints',name:'model.ckpt',path:'/models/checkpoints/model.ckpt',size:10,info:null,family:'anima',detectedFamily:'sdxl',familyOverride:'anima'};
  vi.mocked(invoke).mockResolvedValue(model);
  expect(await writeModelFamily(model.path,'anima')).toBe(model);
  expect(invoke).toHaveBeenLastCalledWith('native_model_family_write',{path:model.path,family:'anima'});
  await writeModelFamily(model.path,null);
  expect(invoke).toHaveBeenLastCalledWith('native_model_family_write',{path:model.path,family:null});
});

it('propagates native publication refusals without retry or provider fallback',async()=>{
  vi.mocked(invoke).mockRejectedValue(new Error('Invalid model metadata'));
  await expect(writeModelFamily('/models/checkpoints/model.safetensors','sdxl')).rejects.toThrow('Invalid model metadata');
  expect(invoke).toHaveBeenCalledTimes(1);
});
