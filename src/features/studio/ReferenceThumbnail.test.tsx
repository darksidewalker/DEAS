import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ReferenceThumbnail } from './ReferenceThumbnail';
import type { VideoRef } from './ReferencesPanel';
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:vi.fn(),convertFileSrc:(p:string)=>`asset://${p}`}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const reference:VideoRef={item:{name:'clip.mp4',path:'/in/clip.mp4',src:'asset://clip.mp4',media:'video'},second:0,strength:1,mediaMode:'video'};
test('native thumbnails use trim start, discard stale frames and never create a WebKit video',async()=>{
 let finish!:(path:string)=>void;
 vi.mocked(invoke).mockImplementation(async(_,args)=>(args as {seconds:number}).seconds===0?new Promise<string>(resolve=>{finish=resolve;}):'/cache/trimmed.png');
 const ui=render(<ReferenceThumbnail reference={reference}/>);
 expect(invoke).toHaveBeenCalledWith('native_media_reference_thumbnail',{path:'/in/clip.mp4',seconds:0});
 ui.rerender(<ReferenceThumbnail reference={{...reference,trimStart:2}}/>);
 await waitFor(()=>expect(screen.getByAltText('clip.mp4')).toHaveProperty('src','asset:///cache/trimmed.png'));
 await act(async()=>finish('/cache/old.png'));
 expect(screen.getByAltText('clip.mp4')).toHaveProperty('src','asset:///cache/trimmed.png');
 expect(document.querySelector('video')).toBeNull();
});
test('unavailable native thumbnail leaves the reference identifiable without starting playback',async()=>{
 vi.mocked(invoke).mockRejectedValue(new Error('thumbnail unavailable'));
 const ui=render(<ReferenceThumbnail reference={reference}/>);
 await act(async()=>{});
 expect(ui.container.textContent).toContain('▸');
 expect(document.querySelector('video')).toBeNull();
});
