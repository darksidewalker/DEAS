import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { RunPlan } from './RunPlan';
import type { DiagnosticImageIntentV1 } from '../../lib/execution';
afterEach(cleanup);
const intent:DiagnosticImageIntentV1={recipeId:'checkpoint-text-to-image-diagnostic',version:1,checkpoint:'test.safetensors',positivePrompt:'forest',negativePrompt:'blur',seed:42,width:896,height:1152,steps:20,cfg:5,sampler:'euler',scheduler:'normal',outputPrefix:'image/42',inputImage:'source.png',denoise:0.6,inputResize:{width:896,height:1152,crop:'center'},loras:[{name:'style.safetensors',strength:0.7}],refine:{width:1792,height:2304,denoise:0.25,tiled:{tileWidth:1024,tileHeight:1024,overlap:128}}};
test('read-only ordered stages show effective image settings and no inactive video stages',()=>{
 localStorage.setItem('deas.locale.v1','en');
 const view=render(<I18nProvider><RunPlan intent={intent} pipeline="i2i" notices={['Backend validation pending']} outputRoot="/output"/></I18nProvider>);
 const plan=screen.getByRole('region',{name:'Run Plan'});
 expect([...plan.querySelectorAll('[data-plan-stage]')].map(x=>x.getAttribute('data-plan-stage'))).toEqual(['input','model','prompt','generate','refine','output']);
 for(const text of ['896 × 1152','1792 × 2304','source.png','style.safetensors','0.7','forest','/output','Backend validation pending'])expect(plan.textContent).toContain(text);
 expect(view.container.querySelector('input,select,textarea,button')).toBeNull();
 expect(view.container.querySelector('[data-plan-stage="audio"]')).toBeNull();
});
test('video family passes, audio and exact output choices are visible without image refinement',()=>{
 localStorage.setItem('deas.locale.v1','en');
 render(<I18nProvider><RunPlan pipeline="t2v" notices={[]} intent={{recipeId:'video-generation',version:1,family:'ltx-2',model:'ltx.safetensors',textEncoder:'gemma',vae:'v',seed:7,width:768,height:512,frames:121,frameRate:24,steps:8,cfg:1,sampler:'euler',scheduler:'normal',positivePrompt:'a film',negativePrompt:'',outputPrefix:'video/7',output:{codec:'H.264',container:'MP4',bitDepth:'8-bit',quality:20,audioCodec:'AAC',audioBitrate:'192k',saveFirstFrame:true,saveLastFrame:false},ltx:{passes:2,audioVae:'audio.safetensors',textProjection:'projection',spatialUpscaler:'upscale'}}}/></I18nProvider>);
 const plan=screen.getByRole('region',{name:'Run Plan'});
 for(const text of ['121','24','H.264','MP4','AAC','audio.safetensors','upscale'])expect(plan.textContent).toContain(text);
 expect(plan.querySelector('[data-plan-stage="refine"]')).toBeNull();
 expect(plan.querySelector('[data-plan-stage="audio"]')).toBeTruthy();
});

test('removing refinement removes its stage and unresolved outputs are not readiness claims',()=>{
 localStorage.setItem('deas.locale.v1','en');
 const {refine,...plain}=intent;void refine;
 const view=render(<I18nProvider><RunPlan intent={plain} pipeline="i2i" notices={['Missing mask']} inputNotes={['Mask upload pending; blur 4 px, crop margin 8 px']}/></I18nProvider>);
 expect(view.container.querySelector('[data-plan-stage="refine"]')).toBeNull();
 expect(view.container.textContent).toContain('Mask upload pending');
 expect(view.container.textContent).toContain('Unresolved / not selected');
 expect(view.container.textContent).toContain('Missing mask');
 view.rerender(<I18nProvider><RunPlan intent={null} pipeline="t2v" notices={['Missing model']}/></I18nProvider>);
 expect(screen.getByRole('status').textContent).toBe('Unresolved / not selected');
 expect(view.container.querySelector('[data-plan-stage]')).toBeNull();
});
