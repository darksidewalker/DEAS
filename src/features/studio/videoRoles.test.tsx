import { expect, test } from 'vitest';
import builtin from '../../families/builtin.json';
import { videoRoleBlock, videoRolePipeline, type VideoRoles } from './videoRoles';
import type { MediaItem } from '../../lib/media';
const image:MediaItem={name:'frame.png',path:'/input/frame.png',src:'asset://frame',media:'image'};
const video:MediaItem={name:'clip.mp4',path:'/input/clip.mp4',src:'asset://clip',media:'video'};
const empty={first:false,last:false,source:false,references:0};
const capability=(family:string)=>builtin.find(f=>f.id===family)!.video as VideoRoles;
test.each([
 ['minimax-h3',['first','last','both','reference']],
 ['minimax-h3-hyperflow',['first','last','both','reference']],
 ['ltx-2',['first','last','both','reference','source']],
 ['wan',['first','last','both']],
])('family %s declares exactly the proven roles', (family,roles)=>expect(capability(family).roles).toEqual(roles));
test.each([
 [empty,'t2v'],[{...empty,first:true},'i2v'],[{...empty,last:true},'i2v'],
 [{...empty,first:true,last:true},'i2v'],[{...empty,references:1},'ref2v'],
 [{...empty,source:true},'v2v'],[{...empty,source:true,first:true,last:true,references:8},'v2v'],
])('explicit roles %j retain the legacy intent pipeline %s',(state,mode)=>expect(videoRolePipeline(state)).toBe(mode));
test('H3 never silently replaces references with keyframes (including RefMods)',()=>{
 const cap=capability('minimax-h3');
 expect(videoRoleBlock(cap,'reference',image,{...empty,first:true})).toBe('studio.run.video.roles.mixing');
 for(const role of ['first','last','both'] as const)expect(videoRoleBlock(cap,role,image,{...empty,references:1})).toBe('studio.run.video.roles.mixing');
 expect(videoRoleBlock(cap,'source',video,empty)).toBe('studio.run.pipe.noRecipe');
 expect(empty).toEqual({first:false,last:false,source:false,references:0});
});
test('LTX allows source + guides + frames but caps guides at eight',()=>{
 const cap=capability('ltx-2'),state={...empty,first:true,last:true,source:true,references:7};
 expect(videoRoleBlock(cap,'reference',image,state)).toBe('');
 expect(videoRoleBlock(cap,'reference',image,{...state,references:8})).toBe('studio.run.video.refFull');
 expect(videoRoleBlock(cap,'source',video,state)).toBe('');
});
test('missing files, mismatched media and unsupported family roles are explained',()=>{
 const cap=capability('wan');
 expect(videoRoleBlock(cap,'first',null,empty)).toBe('studio.run.video.roles.pick');
 expect(videoRoleBlock(cap,'first',video,empty)).toBe('studio.run.video.roles.media');
 expect(videoRoleBlock(cap,'reference',image,empty)).toBe('studio.run.pipe.noRecipe');
 expect(cap.lastAlone).toBe(false);
});
