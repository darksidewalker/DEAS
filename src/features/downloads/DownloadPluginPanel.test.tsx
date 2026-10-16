import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { DownloadPanel, AuthPanel } from './DownloadPluginPanel';
import { DownloadWorkspace } from './DownloadWorkspace';
import { browseDownloads, planDownloads, setAuthToken, removeAuthToken } from '../../lib/downloads';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn(()=>true)}));
const resource={id:'file',label:'Remote file',kind:'file',url:'https://example.invalid/file',downloadable:true,size:23};
const catalog={version:1,providers:[{id:'fixture',label:'Fixture provider',kind:'http',origin:'https://example.invalid',scopes:['index','repo'],anonymousNotice:'Fixture limits'}],entries:[{id:'curated',label:'Curated index',providerId:'fixture',scope:'index',locator:'https://example.invalid/index',kind:'file',target:'models'}]};
const mount=(auth=false)=>render(<I18nProvider>{auth?<AuthPanel/>:<DownloadPanel/>}</I18nProvider>);
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name}));
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockImplementation(async c=>{
 if(c==='native_download_catalog')return catalog;
 if(c==='native_download_browse')return {resources:[resource,{id:'installed',label:'Installed model',kind:'model',downloadable:false}],nextCursor:'page2',warnings:['Bounded listing']};
 if(c==='native_pick_directory')return '/parent';
 if(c==='native_download_plan')return {id:'immutable',target:'/parent/new',resources:[resource],totalKnownBytes:23,unknownSizeCount:0,warnings:[],canExecute:true};
 if(c==='native_auth_verify')return {providerId:'huggingface',status:'unavailable'};
 if(c==='native_auth_status')return [{providerId:'huggingface',configured:false,persisted:false}];
 if(c==='native_auth_set'||c==='native_auth_remove')return {providerId:'huggingface',configured:c==='native_auth_set',persisted:false};
 return {state:c==='native_download_cancel'?'cancelled':'running',completed:0,total:1,bytesDownloaded:12,error:null};
});});
afterEach(()=>{cleanup();vi.resetAllMocks();vi.useRealTimers();});
async function open(){mount();click('Library');await screen.findByRole('option',{name:'Fixture provider'});}
async function browse(){await open();fireEvent.change(screen.getByLabelText('Curated source'),{target:{value:'curated'}});click('Browse resources');await screen.findByLabelText('Remote file');}
async function prepare(){await browse();fireEvent.click(screen.getByLabelText('Remote file'));click('Choose existing parent folder');await screen.findByText('/parent');fireEvent.change(screen.getByLabelText('New subfolder'),{target:{value:'new'}});click('Prepare native download plan');await screen.findByLabelText('I authorize only this exact optional download plan.');}
it('uses exact nested IPC and metadata-only auth contracts',async()=>{
 const request={providerId:'fixture',scope:'index' as const,locator:'source',authenticated:false};await browseDownloads(request);expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request});
 const plan={providerId:'fixture',resources:[resource],parentPath:'/parent',folderName:'new',authenticated:false};await planDownloads(plan);expect(invoke).toHaveBeenLastCalledWith('native_download_plan',{request:plan});
 await setAuthToken('huggingface','private',false);expect(invoke).toHaveBeenLastCalledWith('native_auth_set',{providerId:'huggingface',token:'private',persist:false});await removeAuthToken('huggingface');expect(invoke).toHaveBeenLastCalledWith('native_auth_remove',{providerId:'huggingface'});
});
it('loads catalog only on explicit opening; browses curated sources and pagination explicitly',async()=>{
 mount();expect(invoke).not.toHaveBeenCalled();click('Library');await screen.findByRole('option',{name:'Curated index'});expect(vi.mocked(invoke).mock.calls).toEqual([['native_download_catalog']]);
 fireEvent.change(screen.getByLabelText('Curated source'),{target:{value:'curated'}});click('Browse resources');await screen.findByLabelText('Remote file');expect(screen.getByText('Installed model')).toBeTruthy();expect(screen.queryByLabelText('Installed model')).toBeNull();click('Browse next page');await act(async()=>{});expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:{providerId:'fixture',scope:'index',locator:'https://example.invalid/index',authenticated:false,nsfw:true,cursor:'page2'}});
});
it('discloses native plan, requires separate consent, locks edits and shows only real progress',async()=>{
 await prepare();const consent=screen.getByLabelText('I authorize only this exact optional download plan.') as HTMLInputElement;expect(consent.checked).toBe(false);click('Start confirmed download');expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_download_start')).toBe(false);fireEvent.click(consent);click('Start confirmed download');await screen.findByText('Running');expect(invoke).toHaveBeenCalledWith('native_download_start',{planId:'immutable',confirmed:true});expect((screen.getByLabelText('New subfolder') as HTMLInputElement).disabled).toBe(true);expect(screen.getByText('12')).toBeTruthy();click('Cancel download');await screen.findByText('Cancelled');
});
it('invalidates plan and consent on meaning edits',async()=>{await prepare();fireEvent.click(screen.getByLabelText('I authorize only this exact optional download plan.'));fireEvent.change(screen.getByLabelText('New subfolder'),{target:{value:'changed'}});expect(screen.queryByLabelText('I authorize only this exact optional download plan.')).toBeNull();});
it('supports masked session-only tokens, clears on success and never displays native secret errors',async()=>{
 mount(true);click('Provider authorization');await act(async()=>{});fireEvent.click(screen.getByLabelText('Persist in OS credential store (optional)'));const input=screen.getByLabelText('Token') as HTMLInputElement;expect(input.type).toBe('password');fireEvent.change(input,{target:{value:'PRIVATE'}});click('Save token');await screen.findByText('Token check unavailable; try again');expect(invoke).toHaveBeenCalledWith('native_auth_set',{providerId:'huggingface',token:'PRIVATE',persist:false});expect(input.value).toBe('');expect(JSON.stringify(localStorage)).not.toContain('PRIVATE');vi.mocked(invoke).mockRejectedValueOnce('PRIVATE');fireEvent.change(input,{target:{value:'PRIVATE'}});click('Save token');await screen.findByRole('alert');expect(document.body.textContent).not.toContain('PRIVATE');click('Remove token');await act(async()=>{});expect(invoke).toHaveBeenCalledWith('native_auth_remove',{providerId:'huggingface'});
});
it('discards stale browse results after an edit and serializes duplicate actions',async()=>{
 await open();let resolve!:(value:unknown)=>void;
 vi.mocked(invoke).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}) as never);
 fireEvent.change(screen.getByLabelText('Source locator'),{target:{value:'first'}});click('Browse resources');click('Browse resources');
 fireEvent.change(screen.getByLabelText('Source locator'),{target:{value:'second'}});
 await act(async()=>resolve([]));
 expect(screen.queryByLabelText('Remote file')).toBeNull();expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_download_browse')).toHaveLength(1);
});
it('refreshes auth metadata only, makes persistence explicit and clears token on unmount',async()=>{
 const view=mount(true);click('Provider authorization');click('Refresh authorization status');await act(async()=>{});expect(invoke).toHaveBeenCalledWith('native_auth_status');
 const input=screen.getByLabelText('Token') as HTMLInputElement;fireEvent.change(input,{target:{value:'PRIVATE'}});expect((screen.getByLabelText('Persist in OS credential store (optional)') as HTMLInputElement).checked).toBe(true);click('Save token');await act(async()=>{});expect(invoke).toHaveBeenCalledWith('native_auth_set',{providerId:'huggingface',token:'PRIVATE',persist:true});
 fireEvent.change(input,{target:{value:'PRIVATE'}});view.unmount();expect(input.value).toBe('');
});
it('cancels polling timers and ignores an in-flight poll after unmount',async()=>{
 await prepare();fireEvent.click(screen.getByLabelText('I authorize only this exact optional download plan.'));click('Start confirmed download');await screen.findByText('Running');
 vi.useFakeTimers();let resolve!:(value:unknown)=>void;vi.mocked(invoke).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}) as never);
 // Explicit status refresh exercises the same lifecycle guard as timed polling.
 click('Refresh download status');cleanup();await act(async()=>resolve({state:'succeeded',completed:1,total:1,bytesDownloaded:23,error:null}));await act(async()=>vi.advanceTimersByTimeAsync(5000));
 expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_download_status')).toHaveLength(1);
});
it('invalidates a prepared authenticated plan when parent reports credential changes',async()=>{
 await prepare();const view=render(<I18nProvider><DownloadPanel authRevision={0}/></I18nProvider>);view.rerender(<I18nProvider><DownloadPanel authRevision={1}/></I18nProvider>);view.unmount();
 // Exercise the same mounted panel with a fresh prepared fixture.
 cleanup();const active=render(<I18nProvider><DownloadPanel authRevision={0}/></I18nProvider>);click('Library');await screen.findByLabelText('Provider');fireEvent.change(screen.getByLabelText('Source locator'),{target:{value:'source'}});click('Browse resources');await screen.findByLabelText('Remote file');fireEvent.click(screen.getByLabelText('Remote file'));click('Choose existing parent folder');await screen.findByText('/parent');fireEvent.change(screen.getByLabelText('New subfolder'),{target:{value:'new'}});click('Prepare native download plan');await screen.findByLabelText('I authorize only this exact optional download plan.');
 active.rerender(<I18nProvider><DownloadPanel authRevision={1}/></I18nProvider>);expect(screen.queryByLabelText('I authorize only this exact optional download plan.')).toBeNull();
});
it('locks meaning edits while native start is unresolved',async()=>{
 await prepare();let resolve!:(value:unknown)=>void;vi.mocked(invoke).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}) as never);
 fireEvent.click(screen.getByLabelText('I authorize only this exact optional download plan.'));click('Start confirmed download');
 expect((screen.getByLabelText('New subfolder') as HTMLInputElement).disabled).toBe(true);
 await act(async()=>resolve({state:'running',completed:0,total:1,bytesDownloaded:0,error:null}));
});
it('turns user repository listings into explicit repository browsing',async()=>{
 await open();vi.mocked(invoke).mockResolvedValueOnce([]).mockResolvedValueOnce({resources:[{id:'repo',label:'Owner/repo',kind:'repo',downloadable:false,locator:'models:Owner/repo'}],nextCursor:null,warnings:[]});fireEvent.change(screen.getByLabelText('Source locator'),{target:{value:'Owner'}});click('Browse resources');await screen.findByRole('button',{name:'Select repository: Owner/repo'});click('Select repository: Owner/repo');await act(async()=>{});expect((screen.getByLabelText('Source locator') as HTMLInputElement).value).toBe('models:Owner/repo');expect((screen.getByLabelText('Browse mode') as HTMLSelectElement).value).toBe('repo');expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:{providerId:'fixture',scope:'repo',locator:'models:Owner/repo',authenticated:false,nsfw:true}});
});
it('imports data-only catalogs explicitly and adopts returned provider entries without browsing',async()=>{
 await open();const text='version = 1\nentries = []';
 vi.mocked(invoke).mockResolvedValueOnce({...catalog,entries:[...catalog.entries,{...catalog.entries[0],id:'extra',label:'Added entry'}]});
 fireEvent.change(screen.getByLabelText('TOML catalog data'),{target:{value:text}});click('Validate and extend catalog');await screen.findByRole('option',{name:'Added entry'});
 expect(invoke).toHaveBeenLastCalledWith('native_download_import_catalog',{text});expect((screen.getByLabelText('TOML catalog data') as HTMLTextAreaElement).value).toBe('');expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_download_browse')).toBe(false);
});
it('loads metadata automatically and retains explicit restore for retries',async()=>{
 mount(true);click('Provider authorization');await act(async()=>{});expect(invoke).toHaveBeenCalledWith('native_auth_status');vi.mocked(invoke).mockResolvedValueOnce({providerId:'huggingface',configured:true,persisted:true});click('Explicitly restore saved token');await screen.findByText(/Token check unavailable; try again/);expect(invoke).toHaveBeenCalledWith('native_auth_restore',{providerId:'huggingface'});expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('');
});
it('labels unavailable browser transport without IPC',()=>{vi.mocked(isTauri).mockReturnValue(false);mount();click('Library');expect(screen.getByText(/Browser preview/)).toBeTruthy();expect(invoke).not.toHaveBeenCalled();});
it('shows catalog categories as cards with previews, opens an entry on click and targets the managed ComfyUI folder',async()=>{
 const entries=[{id:'lora-a',label:'Lora A',providerId:'fixture',scope:'index',locator:'https://example.invalid/a.json',kind:'model',target:'loras',preview:'https://image.civitai.com/a.jpeg'},{id:'wf',label:'Workflow W',providerId:'fixture',scope:'index',locator:'https://example.invalid/w.json',kind:'workflow',target:'workflows'},{id:'ckpt',label:'Image checkpoint',providerId:'fixture',scope:'index',locator:'https://example.invalid/c.json',kind:'model',target:'checkpoints',media:'image',auth:true},{id:'wan',label:'Video model',providerId:'fixture',scope:'index',locator:'https://example.invalid/v.json',kind:'model',target:'diffusion_models',media:'video'}];
 vi.mocked(invoke).mockImplementation(async(c,a)=>c==='native_auth_status'?[{providerId:'fixture',configured:true,persisted:true},{providerId:'civitai',configured:true,persisted:true}]:c==='native_download_catalog'?{...catalog,providers:[...catalog.providers,{id:'civitai',kind:'civitai',label:'CivitAI',origin:'https://civitai.com',scopes:['user','model','search'],anonymousNotice:''}],entries}:c==='native_download_browse'?((a as {request:{scope:string}}).request.scope==='search'?{resources:[{id:'civitai:7',label:'Found · v1',kind:'repo',downloadable:false,locator:'7',category:'checkpoints',preview:'https://image.civitai.com/f.jpeg'}],nextCursor:null,warnings:[]}:{resources:[{...resource,preview:'https://image.civitai.com/r.jpeg'}],nextCursor:null,warnings:[]}):c==='native_download_plan'?{id:'p',target:(a as {request:{parentPath:string}}).request.parentPath,resources:[resource],totalKnownBytes:23,unknownSizeCount:0,warnings:[],canExecute:true}:{state:'idle',completed:0,total:0,bytesDownloaded:0,error:null});
 render(<I18nProvider><DownloadPanel installTarget="/env"/></I18nProvider>);click('Library');
 const tabs=await screen.findAllByRole('tab');expect(tabs.map(t=>t.textContent)).toEqual(['Models','LoRAs','Workflows']);expect(tabs[0].getAttribute('aria-selected')).toBe('true');
 expect(screen.getByRole('button',{name:/Image checkpoint/})).toBeTruthy();expect(screen.getByText('Login / API key needed')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Video'}));expect(screen.queryByRole('button',{name:/Image checkpoint/})).toBeNull();expect(screen.getByRole('button',{name:/Video model/})).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'All'}));
 fireEvent.click(screen.getByRole('button',{name:/Image checkpoint/}));await screen.findByText('/env/ComfyUI/models/checkpoints');await screen.findByLabelText('Remote file');expect((screen.getByLabelText('Access mode') as HTMLSelectElement).value).toBe('true');
 fireEvent.click(screen.getByRole('tab',{name:'LoRAs'}));
 expect(document.querySelector('.download-card img')).toBeTruthy();expect(screen.queryByRole('button',{name:'Workflow W'})).toBeNull();expect(screen.queryByRole('button',{name:/Image checkpoint/})).toBeNull();
 fireEvent.click(screen.getByRole('tab',{name:'Workflows'}));expect(screen.getByRole('button',{name:'Workflow W'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Workflow W'}));await screen.findByLabelText('Remote file');
 expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:{providerId:'fixture',scope:'index',locator:'https://example.invalid/w.json',authenticated:true,nsfw:true}});
 expect(document.querySelector('.download-resource img')).toBeTruthy();expect(screen.getByText('/env/ComfyUI/user/default/workflows')).toBeTruthy();
 fireEvent.click(screen.getByLabelText('Remote file'));click('Prepare native download plan');await screen.findByLabelText('I authorize only this exact optional download plan.');
 expect(invoke).toHaveBeenLastCalledWith('native_download_plan',{request:{providerId:'fixture',resources:[expect.objectContaining({id:'file'})],parentPath:'/env/ComfyUI/user/default/workflows',folderName:'',authenticated:true}});
 fireEvent.change(screen.getByLabelText('Search CivitAI'),{target:{value:'found'}});click('Search');await screen.findByRole('button',{name:'Select repository: Found · v1'});
 expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:{providerId:'civitai',scope:'search',locator:'found',authenticated:true,nsfw:true}});
 click('Select repository: Found · v1');await screen.findByLabelText('Remote file');expect(screen.getByText('/env/ComfyUI/models/checkpoints')).toBeTruthy();
 expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:{providerId:'civitai',scope:'model',locator:'7',authenticated:true,nsfw:true}});
});
it('mounts exactly the panel for the active top tab',async()=>{
 const view=render(<I18nProvider><DownloadWorkspace view="auth"/></I18nProvider>);expect(screen.getByLabelText('Token')).toBeTruthy();expect(screen.queryByRole('tab')).toBeNull();
 view.rerender(<I18nProvider><DownloadWorkspace view="downloads"/></I18nProvider>);await screen.findAllByRole('tab');expect(screen.queryByLabelText('Token')).toBeNull();
 view.rerender(<I18nProvider><DownloadWorkspace view={null}/></I18nProvider>);expect(screen.queryByRole('tab')).toBeNull();
});
it('lists adult entries blurred until the NSFW switch is confirmed and always browses everything natively',async()=>{
 const entries=[{id:'sfw',label:'Safe model',providerId:'fixture',scope:'index',locator:'https://example.invalid/s.json',kind:'model',target:'checkpoints',preview:'https://example.invalid/s.png'},{id:'adult',label:'Adult model',providerId:'fixture',scope:'index',locator:'https://example.invalid/a.json',kind:'model',target:'checkpoints',nsfw:true,preview:'https://example.invalid/a.png'}];
 vi.mocked(invoke).mockImplementation(async c=>c==='native_auth_status'?[]:c==='native_download_catalog'?{...catalog,entries}:{resources:[{...resource,nsfw:true},{...resource,id:'safe',label:'Safe file'}],nextCursor:null,warnings:[]});
 const blurred=(name:RegExp)=>screen.getByRole('button',{name}).querySelector('img')!.classList.contains('is-blurred');
 mount();click('Library');await screen.findByRole('button',{name:/Safe model/});expect(blurred(/Adult model/)).toBe(true);expect(blurred(/Safe model/)).toBe(false);
 fireEvent.click(screen.getByRole('switch'));expect(screen.getByRole('alertdialog')).toBeTruthy();click('Keep SFW');expect(screen.queryByRole('alertdialog')).toBeNull();expect(blurred(/Adult model/)).toBe(true);
 fireEvent.click(screen.getByRole('switch'));click('I am 18+, show it');expect(blurred(/Adult model/)).toBe(false);expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
 fireEvent.click(screen.getByRole('button',{name:/Adult model/}));await screen.findByLabelText('Remote file');
 expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:{providerId:'fixture',scope:'index',locator:'https://example.invalid/a.json',authenticated:false,nsfw:true}});
 fireEvent.click(screen.getByRole('switch'));expect(screen.queryByRole('alertdialog')).toBeNull();expect(screen.getByLabelText('Remote file')).toBeTruthy();expect(blurred(/Adult model/)).toBe(true);
});
it('filters catalog cards and listed files by base model family',async()=>{
 const entries=[{id:'wan',label:'Wan model',providerId:'fixture',scope:'index',locator:'https://example.invalid/w.json',kind:'model',target:'checkpoints',base:'Wan 2.2'},{id:'ltx',label:'LTX model',providerId:'fixture',scope:'index',locator:'https://example.invalid/l.json',kind:'model',target:'checkpoints',base:'LTX 2.3'}];
 vi.mocked(invoke).mockImplementation(async c=>c==='native_auth_status'?[]:c==='native_download_catalog'?{...catalog,entries}:{resources:[{...resource,base:'Wan 2.2'},{...resource,id:'l',label:'LTX file',base:'LTX 2.3'}],nextCursor:null,warnings:[]});
 mount();click('Library');await screen.findByRole('button',{name:/Wan model/});
 const group=screen.getByRole('group',{name:'Base model'});expect([...group.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['All','LTX 2.3','Wan 2.2']);
 fireEvent.click(screen.getByRole('button',{name:'LTX 2.3'}));expect(screen.queryByRole('button',{name:/Wan model/})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/LTX model/}));await screen.findByLabelText('LTX file');expect(screen.queryByLabelText('Remote file')).toBeNull();
});
it('shows every provider as a button with its saved-token state and opens the clicked one',async()=>{
 vi.mocked(invoke).mockImplementation(async c=>c==='native_auth_status'?[{providerId:'civitai',configured:true,persisted:true}]:c==='native_auth_verify'?{providerId:'civitai',status:'verified'}:null);
 mount(true);click('Provider authorization');
 const group=await screen.findByRole('group',{name:'Provider'});await screen.findByRole('button',{name:'CivitAI Token saved'});
 expect([...group.querySelectorAll('button')].map(b=>[b.textContent,b.getAttribute('aria-pressed')])).toEqual([['Hugging FaceNo token','true'],['✓ CivitAIToken saved','false'],['GitHubNo token','false']]);
 fireEvent.click(screen.getByRole('button',{name:'CivitAI Token saved'}));expect(screen.getByRole('button',{name:'CivitAI Token saved'}).getAttribute('aria-pressed')).toBe('true');expect(screen.getByText('https://civitai.com',{exact:false})).toBeTruthy();
});
it('opens the fixed provider token page natively without sending any URL',async()=>{
 mount(true);click('Provider authorization');fireEvent.click(screen.getByRole('button',{name:/^CivitAI/}));click('Open token page in browser');await act(async()=>{});
 expect(invoke).toHaveBeenCalledWith('native_open_token_page',{providerId:'civitai'});
});
it('sorts catalog cards and files newest first, then by name, with missing dates last',async()=>{
 const entries=[{...catalog.entries[0],id:'old',label:'Alpha',publishedAt:'2025-01-01T00:00:00Z'},{...catalog.entries[0],id:'new',label:'Zulu',publishedAt:'2026-01-01T00:00:00Z'},{...catalog.entries[0],id:'unknown',label:'Beta',publishedAt:undefined}];
 vi.mocked(invoke).mockImplementation(async c=>c==='native_auth_status'?[]:c==='native_download_catalog'?{...catalog,entries}:{resources:entries.map(e=>({...resource,id:e.id,label:e.label,publishedAt:e.publishedAt})),nextCursor:null,warnings:[]});
 mount();click('Library');await screen.findByRole('button',{name:'Zulu'});
 const cards=()=>[...document.querySelectorAll('.download-card')].map(e=>e.textContent);
 expect(cards()).toEqual(['Zulu','Alpha','Beta']);
 click('Zulu');await screen.findByLabelText('Zulu');
 const rows=()=>[...document.querySelectorAll('.download-resource label')].map(e=>e.textContent);
 expect(rows()).toEqual(['Zulu','Alpha','Beta']);
 const sort=screen.getByRole('group',{name:'Sort by'});const sortButton=(name:string)=>[...sort.querySelectorAll('button')].find(b=>b.textContent?.startsWith(name))!;
 expect(sortButton('Newest').getAttribute('aria-pressed')).toBe('true');expect(sortButton('Newest').textContent).toBe('Newest ↓');
 fireEvent.click(sortButton('Newest'));expect(sortButton('Newest').textContent).toBe('Newest ↑');expect(cards()).toEqual(['Alpha','Zulu','Beta']);
 fireEvent.click(sortButton('Name'));expect(sortButton('Name').getAttribute('aria-pressed')).toBe('true');expect(sortButton('Newest').getAttribute('aria-pressed')).toBe('false');
 expect(cards()).toEqual(['Alpha','Beta','Zulu']);expect(rows()).toEqual(['Alpha','Beta','Zulu']);
 fireEvent.click(sortButton('Name'));expect(sortButton('Name').textContent).toBe('Name ↓');expect(cards()).toEqual(['Zulu','Beta','Alpha']);
 expect((screen.getByLabelText('Zulu') as HTMLInputElement).checked).toBe(false);
});
it('shows loading and a browse failure inside the clicked card picker',async()=>{
 let fail!:(e:unknown)=>void;vi.mocked(invoke).mockImplementation(async c=>c==='native_download_catalog'?catalog:c==='native_auth_status'?[]:c==='native_download_browse'?new Promise((_,reject)=>{fail=reject;}):{state:'idle',completed:0,total:0,bytesDownloaded:0,error:null});
 mount();click('Library');fireEvent.click(await screen.findByRole('button',{name:'Curated index'}));await waitFor(()=>expect(fail).toBeTypeOf('function'));
 expect(document.querySelector('.download-cards .download-picker [role="status"]')).toBeTruthy();
 await act(async()=>fail('Unsupported CivitAI file selector query'));
 expect(document.querySelector('.download-cards .download-picker [role="alert"]')?.textContent).toMatch(/Could not load the files/);expect(screen.getAllByRole('alert')).toHaveLength(1);
});
it('opens the file picker under the clicked card with one version selected at a time',async()=>{
 vi.mocked(invoke).mockImplementation(async c=>c==='native_auth_status'?[]:c==='native_download_catalog'?catalog:{resources:[{...resource,id:'a',label:'model-fp8.safetensors',variant:'fp8 · pruned · ≈13.5 GB',version:'v2',publishedAt:'2026-02-01T00:00:00Z'},{...resource,id:'b',label:'model-fp16.safetensors',version:'v2',publishedAt:'2026-02-01T00:00:00Z'},{...resource,id:'c',label:'model-old.safetensors',version:'v1',publishedAt:'2025-01-01T00:00:00Z'}],nextCursor:null,warnings:[]});
 mount();click('Library');fireEvent.click(await screen.findByRole('button',{name:'Curated index'}));await screen.findByLabelText(/model-fp8\.safetensors/);expect(screen.getByText('fp8 · pruned · ≈13.5 GB')).toBeTruthy();
 expect(document.querySelector('.download-cards .download-picker')).toBeTruthy();
 const group=screen.getByRole('group',{name:'Version'});expect([...group.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['v2','v1']);
 expect(screen.getByRole('button',{name:'v2'}).getAttribute('aria-pressed')).toBe('true');expect(screen.queryByLabelText('model-old.safetensors')).toBeNull();
 fireEvent.click(screen.getByLabelText(/model-fp8\.safetensors/));fireEvent.click(screen.getByRole('button',{name:'v1'}));
 expect(screen.getByLabelText('model-old.safetensors')).toBeTruthy();expect(screen.queryByLabelText(/model-fp8\.safetensors/)).toBeNull();expect(screen.getByText('1 resources selected')).toBeTruthy();
});
it('marks files that already exist in the destination as local and keeps them unselectable',async()=>{
 vi.mocked(invoke).mockImplementation(async c=>c==='native_auth_status'?[]:c==='native_download_catalog'?catalog:c==='native_download_browse'?{resources:[{...resource,locator:'have.safetensors'},{...resource,id:'new',label:'New file',locator:'new.safetensors'}],nextCursor:null,warnings:[]}:c==='native_files_present'?[true,false]:{state:'idle',completed:0,total:0,bytesDownloaded:0,error:null});
 render(<I18nProvider><DownloadPanel installTarget="/env" modelsDir="/models"/></I18nProvider>);click('Library');
 fireEvent.click(await screen.findByRole('button',{name:'Curated index'}));await screen.findByLabelText('New file');
 await screen.findByText(/already local/);expect(screen.queryByLabelText('Remote file')).toBeNull();
 expect(invoke).toHaveBeenCalledWith('native_files_present',{paths:['/models/models/have.safetensors','/models/models/new.safetensors']});
});

it('shows already restored authorization on open without returning a token',async()=>{
 vi.mocked(invoke).mockResolvedValueOnce([{providerId:'huggingface',configured:true,persisted:true}]);
 mount(true);click('Provider authorization');await screen.findByText(/Token check unavailable; try again/);
 expect(invoke).toHaveBeenCalledWith('native_auth_status');expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('');
 expect((screen.getByLabelText('Persist in OS credential store (optional)') as HTMLInputElement).checked).toBe(true);
});
it('automatically uses the matching configured token for browse and plan but respects anonymous choice',async()=>{
 await open();const original=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation((c,a)=>c==='native_auth_status'?Promise.resolve([{providerId:'fixture',configured:true,persisted:true}]):original(c,a));
 fireEvent.change(screen.getByLabelText('Source locator'),{target:{value:'source'}});click('Browse resources');await screen.findByLabelText('Remote file');
 expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:{providerId:'fixture',scope:'index',locator:'source',authenticated:true,nsfw:true}});
 fireEvent.click(screen.getByLabelText('Remote file'));click('Choose existing parent folder');await screen.findByText('/parent');click('Prepare native download plan');await screen.findByLabelText('I authorize only this exact optional download plan.');
 expect(invoke).toHaveBeenLastCalledWith('native_download_plan',{request:expect.objectContaining({authenticated:true})});
 fireEvent.change(screen.getByLabelText('Access mode'),{target:{value:'false'}});click('Browse resources');await screen.findByLabelText('Remote file');
 expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:expect.objectContaining({authenticated:false})});
});
it('returns from Installed VAE to a valid catalog tab and preserves valid remembered choices',async()=>{
 const entries=[{...catalog.entries[0],target:'checkpoints'},{...catalog.entries[0],id:'lora',label:'Catalog LoRA',target:'loras'}];
 vi.mocked(invoke).mockImplementation(async c=>c==='native_download_catalog'?{...catalog,entries}:c==='native_models_scan'?[{category:'vae',name:'v.pt',path:'/env/ComfyUI/models/vae/v.pt',size:3,info:null},{category:'loras',name:'a.pt',path:'/env/ComfyUI/models/loras/a.pt',size:3,info:null}]:[]);
 localStorage.setItem('deas.pref.library.category',JSON.stringify('loras'));
 render(<I18nProvider><DownloadPanel embedded installTarget="/env"/></I18nProvider>);
 expect((await screen.findByRole('tab',{name:'LoRAs'})).getAttribute('aria-selected')).toBe('true');
 click('Installed');fireEvent.click(await screen.findByRole('tab',{name:'VAE'}));click('Catalog');
 expect(screen.getByRole('tab',{name:'Models'}).getAttribute('aria-selected')).toBe('true');
 expect(screen.getByRole('button',{name:'Curated index'})).toBeTruthy();
 fireEvent.click(screen.getByRole('tab',{name:'LoRAs'}));click('Installed');await screen.findByRole('button',{name:'a.pt'});click('Catalog');
 expect(screen.getByRole('tab',{name:'LoRAs'}).getAttribute('aria-selected')).toBe('true');
 expect(screen.getByRole('button',{name:'Catalog LoRA'})).toBeTruthy();
});
it('lists installed models per folder and fetches CivitAI metadata by hash on request',async()=>{
 const local={category:'loras',name:'Krea2/slime.safetensors',path:'/env/ComfyUI/models/loras/Krea2/slime.safetensors',size:2147483648,info:null};
 const fetched={...local,info:{sha256:'ab12',size:2147483648,fetchedAt:1,civitai:{modelId:1,versionId:2,name:'True Slime Girls',version:'Krea2 v1.0',modelType:'LORA',category:'loras',base:'Krea 2',nsfw:false,trainedWords:['D4S1W4_SL1ME'],preview:'https://image.civitai.com/x/width=450/1.jpeg',settings:{sampler:'Euler a',steps:30,cfgScale:4.5,size:'896x1152'}}}};
 vi.mocked(invoke).mockImplementation(async(c,a)=>{
  if(c==='native_download_catalog')return catalog;
  if(c==='native_models_scan'){expect(a).toEqual({root:'/env/ComfyUI/models'});return [local,{...local,category:'vae',name:'v.pt',path:'/env/ComfyUI/models/vae/v.pt'}];}
  if(c==='native_model_info'){expect(a).toEqual({path:local.path,authenticated:false});return fetched;}
  if(c==='native_auth_status')return [{providerId:'civitai',configured:false,persisted:false}];
  throw new Error(`unexpected ${c}`);
 });
 render(<I18nProvider><DownloadPanel embedded installTarget="/env"/></I18nProvider>);
 await screen.findByRole('tab',{name:'Models'});
 expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_models_scan')).toBe(false); // scanned only when the installed view opens
 click('Installed');
 expect((await screen.findByRole('tab',{name:'LoRAs'})).getAttribute('aria-selected')).toBe('true');
 expect(screen.getByRole('tab',{name:'VAE'})).toBeTruthy();
 fireEvent.click(await screen.findByRole('button',{name:'Krea2/slime.safetensors'}));
 expect(screen.getByText('not hashed yet')).toBeTruthy();
 click('Fetch CivitAI metadata');
 expect(await screen.findByText('D4S1W4_SL1ME')).toBeTruthy();
 expect(screen.getByText('True Slime Girls · Krea2 v1.0 · Krea 2')).toBeTruthy();
 expect(screen.getByText('Euler a · 30 steps · CFG 4.5 · 896x1152')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Refresh metadata'})).toBeTruthy();
 expect(document.querySelector('img.download-preview')?.getAttribute('src')).toBe(fetched.info.civitai.preview);
});
