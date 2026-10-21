import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {I18nProvider} from '../../i18n/I18nProvider';
import {hasLlmConfiguration,llmSetupEvent} from '../../lib/llm';
import {ForgeButton} from './ForgeButton';
import {PromptForge} from './PromptForge';
import {PeopleDetector} from '../studio/PeopleDetector';
import App from '../../App';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:()=>false,convertFileSrc:(p:string)=>p}));
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}));
const redirected=vi.fn();
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');window.addEventListener(llmSetupEvent,redirected);vi.mocked(invoke).mockImplementation(async c=>{if(c==='native_llm_read')return {provider:'local',baseUrl:''};if(c==='native_llm_models')return {models:[],warnings:[]};throw Error('Unexpected '+c);});});
afterEach(()=>{cleanup();window.removeEventListener(llmSetupEvent,redirected);vi.resetAllMocks();});
const wrap=(children:React.ReactNode)=>render(<I18nProvider>{children}</I18nProvider>);
test.each(['forge','inline','continuity','people','wildcard-llm'])('%s redirects missing local model without Forge computation or media reads',async entry=>{
 if(entry==='forge')wrap(<PromptForge endpoint="http://localhost:7801" root="/env" onSend={vi.fn()}/>);
 else if(entry==='people')wrap(<PeopleDetector endpoint="http://localhost:7801" root="/env" reference={{kind:'image',path:'private.png'}} onApply={vi.fn()}/>);
 else {wrap(<ForgeButton endpoint="http://localhost:7801" root="/env" dialect="MiniMax H3" value="keep draft" onApply={vi.fn()} {...(entry==='wildcard-llm'?{onWildcards:vi.fn(),wildcard:{style:'Booru',seed:1,reroll:0,token_budget:200,auto_reroll:false,selection_state:{}}}: {})} {...(entry==='continuity'?{h3:{mode:'T2VA',duration:5,canvas:{width:1024,height:576},references:[],easy:false}}:{})}/>);fireEvent.click(screen.getByRole('button',{name:'Prompt Forge'}));if(entry==='wildcard-llm')fireEvent.click(screen.getByRole('button',{name:'LLM · Prompt Forge'}));}
 await waitFor(()=>expect(redirected).toHaveBeenCalledOnce());
 expect(vi.mocked(invoke).mock.calls.map(([c])=>c)).toEqual(['native_llm_read','native_llm_models']);
 if(entry==='inline'||entry==='continuity')expect(screen.getByRole('textbox',{name:'Idea or prompt to enhance'})).toHaveProperty('value','keep draft');
});
test('rootless people helper requests setup without IPC',async()=>{
 wrap(<PeopleDetector endpoint="http://localhost:7801" reference={{kind:'image',path:'private.png'}} onApply={vi.fn()}/>);
 await waitFor(()=>expect(redirected).toHaveBeenCalledOnce());expect(invoke).not.toHaveBeenCalled();
});
test('configured local models pass the shared check without inference',async()=>{
 vi.mocked(invoke).mockImplementation(async c=>c==='native_llm_read'?{provider:'local',baseUrl:''}:{models:[{provider:'local',id:'local.gguf',name:'Local'}],warnings:[]});
 expect(await hasLlmConfiguration('/env')).toBe(true);
 expect(vi.mocked(invoke).mock.calls.map(([c])=>c)).toEqual(['native_llm_read','native_llm_models']);expect(redirected).not.toHaveBeenCalled();
});
test('no environment opens Backend LLM guidance and returning keeps the Studio draft mounted',async()=>{
 wrap(<App/>);fireEvent.click(screen.getByRole('tab',{name:'Studio'}));
 fireEvent.click(screen.getByRole('tab',{name:'Prompt Forge'}));
 await waitFor(()=>expect(screen.getByRole('tab',{name:'LLM backend'}).getAttribute('aria-selected')).toBe('true'));
 expect(screen.getByRole('tab',{name:'Backend'}).getAttribute('aria-selected')).toBe('true');
 expect(screen.getByText(/Your draft has been kept/)).toBeTruthy();
 expect(invoke).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('tab',{name:'Studio'}));
 fireEvent.click(screen.getByRole('tab',{name:'Prompt Forge'}));
 await waitFor(()=>expect(redirected).toHaveBeenCalledTimes(2));
});
test('configured remote is not probed by readiness and transport failure does not redirect',async()=>{
 vi.mocked(invoke).mockImplementation(async c=>{if(c==='native_llm_read')return {provider:'openai',baseUrl:'https://example.invalid/v1'};if(c==='native_forge')throw Error('503 configured service unavailable');throw Error('Unexpected '+c);});
 expect(await hasLlmConfiguration('/env')).toBe(true);expect(invoke).toHaveBeenCalledTimes(1);
 wrap(<ForgeButton endpoint="http://localhost:7801" root="/env" dialect="Anima" value="private draft" onApply={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Prompt Forge'}));
 await screen.findByRole('alert');expect(redirected).not.toHaveBeenCalled();
 expect(screen.getByRole('textbox',{name:'Idea or prompt to enhance'})).toHaveProperty('value','private draft');
 expect(vi.mocked(invoke).mock.calls.some(([c,a])=>c==='native_forge'&&(a as {route:string}).route!=='models')).toBe(false);
});
test('model discovery diagnostics are not missing configuration',async()=>{
 vi.mocked(invoke).mockImplementation(async c=>c==='native_llm_read'?{provider:'local',baseUrl:''}:{models:[],warnings:['Cannot read model folder']});
 await expect(hasLlmConfiguration('/env')).rejects.toThrow('Cannot read model folder');expect(redirected).not.toHaveBeenCalled();
});
test('Forge brief, result and negative drafts survive setup redirect and recovery',async()=>{
 let configured=true;
 vi.mocked(invoke).mockImplementation(async c=>{
  if(c==='native_llm_read')return configured?{provider:'ollama',baseUrl:'http://localhost:11434'}:{provider:'local',baseUrl:''};
  if(c==='native_llm_models')return {models:[],warnings:[]};
  if(c==='native_forge')return {models:[{id:'m',label:'Configured model'}],errors:{},creativity:[],shot_counts:['Auto'],default_shots:'Auto'};
  if(c==='native_media_list')return {path:'',parent:null,entries:[],truncated:false};
  throw Error('Unexpected '+c);
 });
 wrap(<PromptForge endpoint="http://localhost:7801" root="/env" onSend={vi.fn()}/>);
 await screen.findByRole('option',{name:'Configured model'});
 for(const [name,value] of [['Idea or prompt to enhance','keep idea'],['Result','keep edited result'],['Negative prompt (optional)','keep negative']])fireEvent.change(screen.getByRole('textbox',{name}),{target:{value}});
 configured=false;act(()=>window.dispatchEvent(new Event('deas:llm-changed')));
 await waitFor(()=>expect(redirected).toHaveBeenCalledOnce());
 configured=true;act(()=>window.dispatchEvent(new Event('deas:llm-changed')));
 await screen.findByRole('option',{name:'Configured model'});
 for(const [name,value] of [['Idea or prompt to enhance','keep idea'],['Result','keep edited result'],['Negative prompt (optional)','keep negative']])expect(screen.getByRole('textbox',{name})).toHaveProperty('value',value);
 expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_forge').every(([,a])=>(a as {route:string}).route==='models')).toBe(true);
});
test.each(['readiness','models','changed-origin'])('leaving retained Forge suppresses late %s redirects until reactivation',async phase=>{
 let finish!:(value:unknown)=>void;
 const deferred=new Promise(done=>{finish=done;});
 vi.mocked(invoke).mockImplementation(async c=>{
  if(c==='native_llm_read')return phase==='models'?{provider:'ollama',baseUrl:'http://localhost:11434'}:deferred;
  if(c==='native_llm_models')return {models:[],warnings:[]};
  if(c==='native_forge')return deferred;
  throw Error('Unexpected '+c);
 });
 const content=(active:boolean,root='/env')=><I18nProvider><PromptForge active={active} endpoint="http://localhost:7801" root={root} onSend={vi.fn()}/></I18nProvider>;
 const view=render(content(true));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith(phase==='models'?'native_forge':'native_llm_read',expect.anything()));
 fireEvent.change(screen.getByRole('textbox',{name:'Idea or prompt to enhance'}),{target:{value:'retained idea'}});
 view.rerender(content(false,phase==='changed-origin'?'/other':'/env'));
 act(()=>window.dispatchEvent(new Event('deas:forge-open')));
 await act(async()=>finish(phase==='models'?{models:[],errors:{},creativity:[]}:{provider:'local',baseUrl:''}));
 expect(redirected).not.toHaveBeenCalled();
 expect(screen.getByRole('textbox',{name:'Idea or prompt to enhance'})).toHaveProperty('value','retained idea');
 view.rerender(content(true,phase==='changed-origin'?'/other':'/env'));
 await waitFor(()=>expect(redirected).toHaveBeenCalledOnce());
});

test('inactive retained Forge does not check or redirect on configuration change',async()=>{
 wrap(<PromptForge active={false} endpoint="http://localhost:7801" root="/env" onSend={vi.fn()}/>);
 act(()=>window.dispatchEvent(new Event('deas:llm-changed')));await act(async()=>{});
 expect(invoke).not.toHaveBeenCalled();expect(redirected).not.toHaveBeenCalled();
});
