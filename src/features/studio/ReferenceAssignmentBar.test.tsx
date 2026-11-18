import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReferenceAssignmentBar } from './ReferenceAssignmentBar';
import { revealTarget } from '../../lib/search';
vi.mock('../../i18n/I18nProvider',()=>({useI18n:()=>({t:(key:string)=>key})}));
vi.mock('./ReferenceThumbnail',()=>({ReferenceThumbnail:()=>null}));
afterEach(cleanup);

it.each(['first','last','both'])('search selects the compact %s role without assigning media',role=>{
 const assign=vi.fn();
 render(<ReferenceAssignmentBar selected={{name:'frame.png',path:'/input/frame.png',src:'asset:/frame.png',media:'image'}} actions={['first','last','both','reference'].map(id=>({id,label:id,assign}))}/>);
 let result;act(()=>{result=revealTarget(`[data-video-role="${role}"]`);});
 expect(result).toEqual({state:'revealed'});
 expect(document.querySelector('select')?.value).toBe(role);
 expect(document.querySelector(`[data-video-role="${role}"]`)?.classList.contains('search-flash')).toBe(true);
 expect(assign).not.toHaveBeenCalled();
});

it('search does not claim a compact role that is unavailable for this family',()=>{
 render(<ReferenceAssignmentBar selected={null} actions={[{id:'reference',label:'reference',assign:vi.fn()}]}/>);
 expect(revealTarget('[data-video-role="source"]')).toEqual({state:'missing'});
 expect(document.querySelector('select')?.value).toBe('reference');
});
