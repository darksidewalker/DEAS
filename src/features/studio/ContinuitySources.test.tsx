import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import { readH3Session } from '../../lib/jobs';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ContinuitySources } from './ContinuitySources';

vi.mock('@tauri-apps/api/core',()=>({isTauri:vi.fn(),invoke:vi.fn()}));
vi.mock('../../lib/jobs',()=>({readH3Session:vi.fn()}));
beforeEach(()=>{vi.resetAllMocks();vi.mocked(isTauri).mockReturnValue(true);localStorage.setItem('deas.locale.v1','en');});
afterEach(cleanup);
const mount=(sourceId?:string)=>{
 const props={endpoint:'http://backend',session:'active-session',sourceId,running:false,onSelect:vi.fn()};
 const view=render(<I18nProvider><ContinuitySources {...props}/></I18nProvider>);
 return {...view,props};
};
const clip=(clipId:string,frames:number|null=5)=>({clipId,frames,parent:null,completed:0,export:null});
const load=()=>screen.getByRole('button');
const clickLoad=async()=>{await act(async()=>{fireEvent.click(load());});};

test('explicit load displays only returned IDs without choosing latest or clearing a missing saved source',async()=>{
 vi.mocked(readH3Session).mockResolvedValue({latestId:'newest',clips:[clip('newest'),clip('older')]});
 const {props}=mount('saved-missing');
 await clickLoad();
 expect(readH3Session).toHaveBeenCalledExactlyOnceWith('http://backend','active-session');
 expect([...select().options].map(o=>o.value)).toEqual(['','saved-missing','newest','older']);
 expect(select().value).toBe('saved-missing');
 expect(props.onSelect).not.toHaveBeenCalled();
});

test('loading never automatically selects latest when there is no saved source',async()=>{
 vi.mocked(readH3Session).mockResolvedValue({latestId:'newest',clips:[clip('newest')]});
 const {props}=mount();await clickLoad();
 expect(select().value).toBe('');expect(props.onSelect).not.toHaveBeenCalled();
});
const select=()=>screen.getByRole('combobox') as HTMLSelectElement;

test('choosing a source and New first take only emit explicit callbacks',async()=>{
 vi.mocked(readH3Session).mockResolvedValue({latestId:'newest',clips:[clip('newest')]});
 const {props,rerender}=mount('saved');await clickLoad();
 fireEvent.change(select(),{target:{value:'newest'}});
 expect(props.onSelect).toHaveBeenCalledExactlyOnceWith('newest');
 expect(select().value).toBe('saved');
 rerender(<I18nProvider><ContinuitySources {...props} sourceId="newest"/></I18nProvider>);
 fireEvent.change(select(),{target:{value:'newest'}});
 expect(props.onSelect).toHaveBeenCalledTimes(1);
 fireEvent.change(select(),{target:{value:''}});
 expect(props.onSelect).toHaveBeenLastCalledWith(undefined);
 expect(readH3Session).toHaveBeenCalledTimes(1);
});

test('running locks load and selection including forced changes',()=>{
 const {props,rerender}=mount('saved');
 rerender(<I18nProvider><ContinuitySources {...props} running/></I18nProvider>);
 expect((load() as HTMLButtonElement).disabled).toBe(true);expect(select().disabled).toBe(true);
 fireEvent.click(load());fireEvent.change(select(),{target:{value:''}});
 expect(readH3Session).not.toHaveBeenCalled();expect(props.onSelect).not.toHaveBeenCalled();
});

test.each([undefined,''])('load requires an endpoint (%s)',endpoint=>{
 const {props,rerender}=mount();rerender(<I18nProvider><ContinuitySources {...props} endpoint={endpoint}/></I18nProvider>);
 expect((load() as HTMLButtonElement).disabled).toBe(true);fireEvent.click(load());expect(readH3Session).not.toHaveBeenCalled();
});
test('load requires native capability',()=>{
 vi.mocked(isTauri).mockReturnValue(false);mount();
 expect((load() as HTMLButtonElement).disabled).toBe(true);fireEvent.click(load());expect(readH3Session).not.toHaveBeenCalled();
});

test('filters malformed IDs and clips without at least five finite integer frames without normalizing',async()=>{
 const valid=['A','0','_-','MiXeD_1-2','a'.repeat(80)];
 const badIds=['','a/b','a b',' a','a ','a\n','é','a'.repeat(81)];
 const malformed=[null,{}, {clipId:42,frames:5},...badIds.map(id=>clip(id)),...[null,0,4,5.5,NaN,Infinity,-5].map((n,i)=>clip(`bad-${i}`,n)),{clipId:'string-frames',frames:'5'}];
 vi.mocked(readH3Session).mockResolvedValue({latestId:'bad-0',clips:[...valid.map(id=>clip(id)),...malformed] as Awaited<ReturnType<typeof readH3Session>>['clips']});
 const {props}=mount();await clickLoad();
 expect([...select().options].map(o=>o.value)).toEqual(['',...valid]);expect(props.onSelect).not.toHaveBeenCalled();
 // Even a forced DOM option must not bypass the eligible list.
 select().add(new Option('forged','forged'));fireEvent.change(select(),{target:{value:'forged'}});
 expect(props.onSelect).not.toHaveBeenCalled();
});

test('caps returned candidates at 200 and removes duplicate IDs',async()=>{
 const clips=Array.from({length:201},(_,i)=>clip(`clip-${i}`));clips[1]=clip('clip-0');
 vi.mocked(readH3Session).mockResolvedValue({latestId:null,clips});mount();await clickLoad();
 expect(select().options).toHaveLength(200);
 expect(screen.queryByRole('option',{name:'clip-200'})).toBeNull();
});

const deferred=()=>{
 let resolve!:(value:Awaited<ReturnType<typeof readH3Session>>)=>void;
 let reject!:(error:Error)=>void;
 const promise=new Promise<Awaited<ReturnType<typeof readH3Session>>>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
};

test('loading locks both controls and forced selection until the explicit request finishes',async()=>{
 const request=deferred();vi.mocked(readH3Session).mockReturnValue(request.promise);
 const {props}=mount('saved');const idleLabel=load().textContent;fireEvent.click(load());
 expect((load() as HTMLButtonElement).disabled).toBe(true);expect(select().disabled).toBe(true);
 expect(load().textContent).not.toBe(idleLabel);
 fireEvent.click(load());fireEvent.change(select(),{target:{value:''}});
 expect(readH3Session).toHaveBeenCalledTimes(1);expect(props.onSelect).not.toHaveBeenCalled();
 await act(async()=>request.resolve({latestId:null,clips:[]}));
 expect((load() as HTMLButtonElement).disabled).toBe(false);expect(select().disabled).toBe(false);
 expect(screen.getByRole('status')).toBeTruthy();expect(select().value).toBe('saved');
});

test('rejection shows only a fixed inline error and never retries or clears a saved source',async()=>{
 vi.mocked(readH3Session).mockRejectedValue(new Error('http://secret:password@private/path?token=TOPSECRET'));
 const {props}=mount('saved');await clickLoad();
 expect(screen.getByRole('alert').textContent).not.toMatch(/secret|password|private|TOPSECRET/);
 expect(screen.getByRole('alert').textContent).toBeTruthy();
 expect(select().value).toBe('saved');expect((load() as HTMLButtonElement).disabled).toBe(false);
 expect(readH3Session).toHaveBeenCalledTimes(1);expect(props.onSelect).not.toHaveBeenCalled();
 vi.mocked(readH3Session).mockResolvedValue({latestId:null,clips:[clip('fresh')]});await clickLoad();
 expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByRole('option',{name:'fresh'})).toBeTruthy();
});

test.each(['session','endpoint','running'] as const)('invalidates delayed success on %s changes without touching the response or unlocking a newer load',async change=>{
 const old=deferred(),fresh=deferred();vi.mocked(readH3Session).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
 const {props,rerender}=mount('saved');fireEvent.click(load());
 const next={...props,...(change==='session'?{session:'other-session'}:change==='endpoint'?{endpoint:'http://other'}:{running:true})};
 rerender(<I18nProvider><ContinuitySources {...next}/></I18nProvider>);
 if(change==='running')rerender(<I18nProvider><ContinuitySources {...next} running={false}/></I18nProvider>);
 expect((load() as HTMLButtonElement).disabled).toBe(false);expect(readH3Session).toHaveBeenCalledTimes(1);
 fireEvent.click(load());
 const inspect=vi.fn();
 await act(async()=>old.resolve({latestId:'stale',get clips(){inspect();return [clip('stale')];}}));
 expect(inspect).not.toHaveBeenCalled();expect((load() as HTMLButtonElement).disabled).toBe(true);
 expect(screen.queryByRole('option',{name:'stale'})).toBeNull();expect(props.onSelect).not.toHaveBeenCalled();
 await act(async()=>fresh.resolve({latestId:'fresh',clips:[clip('fresh')]}));
 expect(screen.getByRole('option',{name:'fresh'})).toBeTruthy();expect(select().value).toBe('saved');
 expect((load() as HTMLButtonElement).disabled).toBe(false);
});

test.each(['session','endpoint','running'] as const)('ignores delayed errors after %s changes and preserves a newer successful list',async change=>{
 const old=deferred();vi.mocked(readH3Session).mockReturnValueOnce(old.promise).mockResolvedValueOnce({latestId:null,clips:[clip('fresh')]});
 const {props,rerender}=mount();fireEvent.click(load());
 const next={...props,...(change==='session'?{session:'other-session'}:change==='endpoint'?{endpoint:'http://other'}:{running:true})};
 rerender(<I18nProvider><ContinuitySources {...next}/></I18nProvider>);
 if(change==='running')rerender(<I18nProvider><ContinuitySources {...next} running={false}/></I18nProvider>);
 await clickLoad();
 await act(async()=>old.reject(new Error('stale secret')));
 expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByRole('option',{name:'fresh'})).toBeTruthy();
 expect(props.onSelect).not.toHaveBeenCalled();
});

test.each(['success','error'])('unmount invalidates a delayed %s without inspecting it or emitting callbacks',async outcome=>{
 const old=deferred();vi.mocked(readH3Session).mockReturnValueOnce(old.promise);
 const {props,unmount}=mount('saved');fireEvent.click(load());unmount();
 const inspect=vi.fn();
 await act(async()=>{if(outcome==='success')old.resolve({latestId:null,get clips(){inspect();return [clip('stale')];}});else old.reject(new Error('stale secret'));});
 expect(inspect).not.toHaveBeenCalled();expect(props.onSelect).not.toHaveBeenCalled();
});

test('session and endpoint changes clear loaded candidates and require another explicit load',async()=>{
 vi.mocked(readH3Session).mockResolvedValue({latestId:null,clips:[clip('old')]});
 const {props,rerender}=mount('saved');await clickLoad();
 rerender(<I18nProvider><ContinuitySources {...props} session="other"/></I18nProvider>);
 expect([...select().options].map(o=>o.value)).toEqual(['','saved']);expect(readH3Session).toHaveBeenCalledTimes(1);
 await clickLoad();
 rerender(<I18nProvider><ContinuitySources {...props} session="other" endpoint="http://other"/></I18nProvider>);
 expect([...select().options].map(o=>o.value)).toEqual(['','saved']);expect(readH3Session).toHaveBeenCalledTimes(2);
});

test('does not read automatically and displays a saved ID literally before loading',()=>{
 const {props}=mount('Saved_ID-1');
 expect(readH3Session).not.toHaveBeenCalled();
 expect(select().value).toBe('Saved_ID-1');
 expect(screen.getByRole('option',{name:'Saved_ID-1'})).toBeTruthy();
 expect(load().hasAttribute('data-cont-load-sources')).toBe(true);
 expect(select().hasAttribute('data-cont-source')).toBe(true);
 expect(props.onSelect).not.toHaveBeenCalled();
});
