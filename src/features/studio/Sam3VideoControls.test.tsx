import {useState} from 'react';
import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {I18nProvider} from '../../i18n/I18nProvider';
import {revealTarget,searchIndex} from '../../lib/search';
import {Sam3VideoControls,type FaceRefineSettings,type Sam3VideoSettings} from './Sam3VideoControls';
const value:Sam3VideoSettings={cuts:false,sceneThreshold:0.3,checkpoint:'SAM3/sam3.1.safetensors',threshold:0.5,maxObjects:4,detectInterval:1,startSeconds:0,durationSeconds:2};
const refineValue:FaceRefineSettings={auto:false,denoise:0.35,cropFactor:2.5,feather:6,prompt:''};
afterEach(()=>{cleanup();localStorage.clear();});
test.each(['en','de','fr','ja','tr','zh'])('H3 face analysis controls are translated and dock-scoped searchable without computation (%s)',locale=>{
 localStorage.setItem('deas.locale.v1',locale);const analyze=vi.fn();const refineRun=vi.fn();
 function Controls(){const [settings,setSettings]=useState(value);const [r,setR]=useState(refineValue);return <Sam3VideoControls value={settings} onChange={setSettings} models={[value.checkpoint]} sourceName="selected.mp4" unavailable="" busy={false} onAnalyze={analyze} refine={{value:r,onChange:setR,unavailable:'',autoUnavailable:'',onRefine:refineRun}}/>;}
 render(<I18nProvider><input data-sam-video="startSeconds"/><section className="wb-post"><Controls/></section></I18nProvider>);
 const group=screen.getByRole('group');expect(group.textContent).not.toContain('studio.samVideo.');expect(group.textContent).toContain('selected.mp4');
 const entries=searchIndex.filter(entry=>entry.section==='studio.samVideo.title');expect(entries).toHaveLength(16);
 for(const entry of entries){expect(entry.dockTab).toBe('post');expect(entry.target.startsWith('.wb-post ')).toBe(true);expect(document.querySelector(entry.target)).not.toBeNull();}
 const start=entries.find(entry=>entry.label==='studio.samVideo.startSeconds')!;
 expect(revealTarget(start.target).state).toBe('revealed');
 expect(document.querySelector('.wb-post [data-sam-video="startSeconds"]')?.classList.contains('search-flash')).toBe(true);
 fireEvent.change(document.querySelector('.wb-post [data-sam-video="startSeconds"]')!,{target:{value:'1'}});
 const cuts=group.querySelector<HTMLInputElement>('[data-sam-video="cuts"]')!;
 const scene=group.querySelector<HTMLInputElement>('[data-sam-video="sceneThreshold"]')!;
 expect(cuts.checked).toBe(false);expect(scene.disabled).toBe(true);expect(scene.value).toBe('0.3');
 fireEvent.click(cuts);expect(scene.disabled).toBe(false);fireEvent.change(scene,{target:{value:'0.4'}});fireEvent.click(cuts);expect(scene.disabled).toBe(true);
 expect(analyze).not.toHaveBeenCalled();expect(group.querySelector('[data-sam="enabled"]')).toBeNull();
 // Editing refinement settings never computes; only the explicit buttons do.
 const auto=group.querySelector<HTMLInputElement>('[data-face-refine="auto"]')!;expect(auto.checked).toBe(false);fireEvent.click(auto);expect(auto.checked).toBe(true);
 fireEvent.change(group.querySelector('[data-face-refine="denoise"]')!,{target:{value:'0.5'}});expect(group.querySelector<HTMLInputElement>('[data-face-refine="denoise"]')!.value).toBe('0.5');
 // Minimum face size: a preference saved before it existed shows 0 (refine every face).
 const minFace=group.querySelector<HTMLInputElement>('[data-face-refine="minFace"]')!;expect(minFace.value).toBe('0');
 fireEvent.change(minFace,{target:{value:'96'}});expect(minFace.value).toBe('96');
 expect(refineRun).not.toHaveBeenCalled();
 fireEvent.click(group.querySelector('[data-sam-video="analyze"]')!);expect(analyze).toHaveBeenCalledOnce();
 fireEvent.click(group.querySelector('[data-face-refine="run"]')!);expect(refineRun).toHaveBeenCalledOnce();
});
test('H3 face analysis and refinement display concrete native blockers and stay inert',()=>{
 localStorage.setItem('deas.locale.v1','en');const analyze=vi.fn();
 render(<I18nProvider><Sam3VideoControls value={value} onChange={vi.fn()} models={[]} sourceName="source.mp4" unavailable="Native desktop execution required" busy={false} onAnalyze={analyze}/></I18nProvider>);
 expect(screen.getByRole('status').textContent).toBe('Native desktop execution required');
 const button=screen.getByRole('button',{name:'Analyze face masks'});expect(button).toHaveProperty('disabled',true);fireEvent.click(button);expect(analyze).not.toHaveBeenCalled();
 expect(screen.queryByRole('button',{name:/refine/i})).toBeNull();
 cleanup();const refineRun=vi.fn();
 render(<I18nProvider><Sam3VideoControls value={value} onChange={vi.fn()} models={[]} sourceName="source.mp4" unavailable="" busy={false} onAnalyze={analyze} refine={{value:refineValue,onChange:vi.fn(),unavailable:'Choose the H3 model first',autoUnavailable:'Unavailable with latent upscale',onRefine:refineRun}}/></I18nProvider>);
 const refine=screen.getByRole('button',{name:'Refine faces'});expect(refine).toHaveProperty('disabled',true);fireEvent.click(refine);expect(refineRun).not.toHaveBeenCalled();
 expect(screen.getByText('Choose the H3 model first')).toBeTruthy();
 const auto=screen.getByRole('checkbox',{name:'Refine faces after H3 generation'}) as HTMLInputElement;expect(auto.disabled).toBe(true);expect(screen.getByText('Unavailable with latent upscale')).toBeTruthy();
});
