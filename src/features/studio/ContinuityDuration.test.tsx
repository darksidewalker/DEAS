import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { VideoIntentV1 } from '../../lib/videoIntent';
import { GenerationMetadata } from './GenerationMetadata';
import { RunPlan } from './RunPlan';
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>false}));
afterEach(cleanup);
const intent:VideoIntentV1={recipeId:'video-generation',version:1,family:'minimax-h3',positivePrompt:'turn',negativePrompt:'',model:'h3',textEncoder:'encoder',vae:'vae',seed:7,width:1024,height:768,frames:158,frameRate:24,steps:4,cfg:1,sampler:'euler',scheduler:'simple',outputPrefix:'video/test',output:{codec:'Auto',container:'Auto',bitDepth:'Auto',quality:20,audioCodec:'Auto',audioBitrate:'192k',saveFirstFrame:false,saveLastFrame:false},h3:{mode:'REF2VA',audioVae:'audio',shiftVideo:10,shiftAudio:3,references:[],media:[],continuity:{session:'s',sourceId:'parent',capture:true,action:'turn',outputMode:'segment',durationSeconds:6}}};
test.each(['metadata','plan'])('%s labels authored continuation seconds without presenting new-take frames as rendered frames',kind=>{
 localStorage.setItem('deas.locale.v1','en');
 const view=render(<I18nProvider>{kind==='plan'?<RunPlan intent={intent} pipeline="ref2v" notices={[]}/>:<GenerationMetadata job={{id:'cont',baseUrl:'http://backend/',promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false,intent}}/>}</I18nProvider>);
 const seconds=[...view.container.querySelectorAll('dt')].find(e=>e.textContent==='Seconds');
 expect(seconds?.nextElementSibling?.textContent).toBe('6');
 expect([...view.container.querySelectorAll('dt')].some(e=>e.textContent==='Frames'||e.textContent==='Frame interval duration (seconds)')).toBe(false);
 expect(view.container.textContent).not.toContain('158 frames');
});
