import { expect, test } from 'vitest';
import { activePost, activeWildcards, changedOptions, postCategoryFunctions, postCategoryOrder } from './dockBadges';
import { defaultOptions } from './OptionsPanel';
import { defaultTve } from './TvePostControls';
import { defaultWildcard } from '../../lib/wildcard';

test('options count only fields that differ from defaults; absent older fields are default',()=>{
 expect(changedOptions(defaultOptions)).toEqual([]);
 expect(changedOptions({attention:'',vae:'full',tile:512,cache:'',threshold:0.05,compile:''})).toEqual([]);
 expect(changedOptions({...defaultOptions,vae:'tiled',cache:'EasyCache',output:{...defaultOptions.output!}})).toEqual(['vae','cache']);
});
test('wildcards count the switch and authored rules, never automatic seed/reroll/picks',()=>{
 expect(activeWildcards(false,{...defaultWildcard,style:'Natural Language'})).toEqual([]);
 expect(activeWildcards(true,{...defaultWildcard,seed:9,reroll:3,selection_state:{a:{enabled:true,weight:1}}})).toEqual(['enabled']);
 expect(activeWildcards(true,{...defaultWildcard,style:'Natural Language',token_budget:300})).toEqual(['enabled','style','token_budget']);
});
test('post counts the stages that run for the current pipeline',()=>{
 const base={video:false,audio:false,latent:false,tve:defaultTve,refine:false,sam:false,audioMode:'off'};
 expect(activePost(base)).toEqual([]);
 expect(activePost({...base,refine:true,sam:true,latent:true,tve:{...defaultTve,frameGen:true}})).toEqual(['refine','sam']);
 expect(activePost({...base,video:true,audio:true,audioMode:'clean',latent:true,tve:{...defaultTve,upscaleModel:'x.pth',denoise:true,frameGen:true},refine:true})).toEqual(['latent','upscale','denoise','frameGen','audio']);
 expect(activePost({...base,video:true,audio:false,audioMode:'off',latent:false,tve:{...defaultTve,loop:true}})).toEqual(['loop']);
 expect(activePost({...base,video:false,audio:false,audioMode:'off',latent:false,tve:{...defaultTve,loop:true}})).toEqual([]);
 expect(activePost({...base,video:true,audio:false,audioMode:'clean'})).toEqual([]);
});
test('post category function counts match nested switches and reconcile with the dock aggregate badge',()=>{
 const h3Video={
  video:true,audio:true,audioMode:'loudness',latent:true,latentSpikeGuard:true,
  h3Video:true,samVideoCuts:true,faceRefine:true,
  derope:true,deropeKeepBackground:true,deropeDistilled:true,
  tve:{...defaultTve,loop:true,upscaleModel:'x.pth',denoise:true,rtxUpscale:true},
  refine:true,refineTiled:true,sam:true,
 };
 const byCat=postCategoryFunctions(h3Video);
 expect(byCat.audio).toEqual(['audio']);
 expect(byCat.latent).toEqual(['latent','latent.spikeGuard']);
 expect(byCat['face-analysis']).toEqual(['faceRefine','faceAnalysis.cuts']);
 expect(byCat.derope).toEqual(['derope','derope.keepBackground','derope.distilled']);
 expect(byCat.model).toEqual(['upscale']);
 expect(byCat.tve).toEqual(['loop','denoise','rtxUpscale']);
 expect(byCat.sam).toEqual([]);
 expect(byCat.refine).toEqual([]);
 expect(postCategoryOrder.flatMap(id=>byCat[id]).length).toBe(activePost(h3Video).length);

 const cutsWithoutFaceRefine={...h3Video,faceRefine:false,samVideoCuts:true};
 const cutsOnlyCat=postCategoryFunctions(cutsWithoutFaceRefine);
 expect(cutsOnlyCat['face-analysis']).toEqual([]);
 expect(activePost(cutsWithoutFaceRefine)).not.toContain('faceAnalysis.cuts');
 expect(postCategoryOrder.flatMap(id=>cutsOnlyCat[id]).length).toBe(activePost(cutsWithoutFaceRefine).length);

 const nonH3Video={...h3Video,h3Video:false,latent:false};
 const nonH3Cat=postCategoryFunctions(nonH3Video);
 expect(nonH3Cat.latent).toEqual([]);
 expect(nonH3Cat['face-analysis']).toEqual([]);
 expect(nonH3Cat.derope).toEqual([]);
 expect(postCategoryOrder.flatMap(id=>nonH3Cat[id]).length).toBe(activePost(nonH3Video).length);

 const image={...h3Video,video:false,audio:false,refine:true,refineTiled:true,sam:true};
 const imgCat=postCategoryFunctions(image);
 expect(imgCat.refine).toEqual(['refine','refine.tiled']);
 expect(imgCat.sam).toEqual(['sam']);
 expect(imgCat.latent).toEqual([]);
 expect(imgCat.derope).toEqual([]);
 expect(imgCat.tve).toEqual([]);
 expect(postCategoryOrder.flatMap(id=>imgCat[id]).length).toBe(activePost(image).length);

 const h3Image=postCategoryFunctions({...image,h3Image:true});
 expect(h3Image.refine).toEqual([]);
 expect(h3Image.sam).toEqual(['sam']);

 const music=postCategoryFunctions({...image,music:true,audio:true,audioMode:'stems'});
 expect(music.refine).toEqual([]);
 expect(music.sam).toEqual([]);
 expect(music.audio).toEqual(['audio']);
});
