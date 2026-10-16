import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
 if(c==='native_auth_status')return [{providerId:'huggingface',configured:false,persisted:false}];
 if(c==='native_auth_set'||c==='native_auth_remove')return {providerId:'huggingface',configured:c==='native_auth_set',persisted:false};
 return {state:c==='native_download_cancel'?'cancelled':'running',completed:0,total:1,bytesDownloaded:12,error:null};
});});
afterEach(()=>{cleanup();vi.resetAllMocks();vi.useRealTimers();});
async function open(){mount();click('Optional downloads');await screen.findByRole('option',{name:'Fixture provider'});}
async function browse(){await open();fireEvent.change(screen.getByLabelText('Curated source'),{target:{value:'curated'}});click('Browse resources');await screen.findByLabelText('Remote file');}
async function prepare(){await browse();fireEvent.click(screen.getByLabelText('Remote file'));click('Choose existing parent folder');await screen.findByText('/parent');fireEvent.change(screen.getByLabelText('New subfolder'),{target:{value:'new'}});click('Prepare native download plan');await screen.findByLabelText('I authorize only this exact optional download plan.');}
it('uses exact nested IPC and metadata-only auth contracts',async()=>{
 const request={providerId:'fixture',scope:'index' as const,locator:'source',authenticated:false};await browseDownloads(request);expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request});
 const plan={providerId:'fixture',resources:[resource],parentPath:'/parent',folderName:'new',authenticated:false};await planDownloads(plan);expect(invoke).toHaveBeenLastCalledWith('native_download_plan',{request:plan});
 await setAuthToken('huggingface','private',false);expect(invoke).toHaveBeenLastCalledWith('native_auth_set',{providerId:'huggingface',token:'private',persist:false});await removeAuthToken('huggingface');expect(invoke).toHaveBeenLastCalledWith('native_auth_remove',{providerId:'huggingface'});
});
it('loads catalog only on explicit opening; browses curated sources and pagination explicitly',async()=>{
 mount();expect(invoke).not.toHaveBeenCalled();click('Optional downloads');await screen.findByRole('option',{name:'Curated index'});expect(vi.mocked(invoke).mock.calls).toEqual([['native_download_catalog']]);
 fireEvent.change(screen.getByLabelText('Curated source'),{target:{value:'curated'}});click('Browse resources');await screen.findByLabelText('Remote file');expect(screen.getByText('Installed model')).toBeTruthy();expect(screen.queryByLabelText('Installed model')).toBeNull();click('Browse next page');await act(async()=>{});expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:{providerId:'fixture',scope:'index',locator:'https://example.invalid/index',authenticated:false,nsfw:false,cursor:'page2'}});
});
it('discloses native plan, requires separate consent, locks edits and shows only real progress',async()=>{
 await prepare();const consent=screen.getByLabelText('I authorize only this exact optional download plan.') as HTMLInputElement;expect(consent.checked).toBe(false);click('Start confirmed download');expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_download_start')).toBe(false);fireEvent.click(consent);click('Start confirmed download');await screen.findByText('Running');expect(invoke).toHaveBeenCalledWith('native_download_start',{planId:'immutable',confirmed:true});expect((screen.getByLabelText('New subfolder') as HTMLInputElement).disabled).toBe(true);expect(screen.getByText('12')).toBeTruthy();click('Cancel download');await screen.findByText('Cancelled');
});
it('invalidates plan and consent on meaning edits',async()=>{await prepare();fireEvent.click(screen.getByLabelText('I authorize only this exact optional download plan.'));fireEvent.change(screen.getByLabelText('New subfolder'),{target:{value:'changed'}});expect(screen.queryByLabelText('I authorize only this exact optional download plan.')).toBeNull();});
it('uses masked session tokens by default, clears on success and never displays native secret errors',async()=>{
 mount(true);click('Provider authorization');const input=screen.getByLabelText('Token') as HTMLInputElement;expect(input.type).toBe('password');fireEvent.change(input,{target:{value:'PRIVATE'}});click('Save token');await screen.findByText('Token configured; account not verified.');expect(invoke).toHaveBeenCalledWith('native_auth_set',{providerId:'huggingface',token:'PRIVATE',persist:false});expect(input.value).toBe('');expect(JSON.stringify(localStorage)).not.toContain('PRIVATE');vi.mocked(invoke).mockRejectedValueOnce('PRIVATE');fireEvent.change(input,{target:{value:'PRIVATE'}});click('Save token');await screen.findByRole('alert');expect(document.body.textContent).not.toContain('PRIVATE');click('Remove token');await act(async()=>{});expect(invoke).toHaveBeenCalledWith('native_auth_remove',{providerId:'huggingface'});
});
it('discards stale browse results after an edit and serializes duplicate actions',async()=>{
 await open();let resolve!:(value:unknown)=>void;
 vi.mocked(invoke).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}) as never);
 fireEvent.change(screen.getByLabelText('Source locator'),{target:{value:'first'}});click('Browse resources');click('Browse resources');
 fireEvent.change(screen.getByLabelText('Source locator'),{target:{value:'second'}});
 await act(async()=>resolve({resources:[resource],nextCursor:null,warnings:[]}));
 expect(screen.queryByLabelText('Remote file')).toBeNull();expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_download_browse')).toHaveLength(1);
});
it('refreshes auth metadata only, makes persistence explicit and clears token on unmount',async()=>{
 const view=mount(true);click('Provider authorization');click('Refresh authorization status');await act(async()=>{});expect(invoke).toHaveBeenCalledWith('native_auth_status');
 const input=screen.getByLabelText('Token') as HTMLInputElement;fireEvent.change(input,{target:{value:'PRIVATE'}});fireEvent.click(screen.getByLabelText('Persist in OS credential store (optional)'));click('Save token');await act(async()=>{});expect(invoke).toHaveBeenCalledWith('native_auth_set',{providerId:'huggingface',token:'PRIVATE',persist:true});
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
 cleanup();const active=render(<I18nProvider><DownloadPanel authRevision={0}/></I18nProvider>);click('Optional downloads');await screen.findByLabelText('Provider');fireEvent.change(screen.getByLabelText('Source locator'),{target:{value:'source'}});click('Browse resources');await screen.findByLabelText('Remote file');fireEvent.click(screen.getByLabelText('Remote file'));click('Choose existing parent folder');await screen.findByText('/parent');fireEvent.change(screen.getByLabelText('New subfolder'),{target:{value:'new'}});click('Prepare native download plan');await screen.findByLabelText('I authorize only this exact optional download plan.');
 active.rerender(<I18nProvider><DownloadPanel authRevision={1}/></I18nProvider>);expect(screen.queryByLabelText('I authorize only this exact optional download plan.')).toBeNull();
});
it('locks meaning edits while native start is unresolved',async()=>{
 await prepare();let resolve!:(value:unknown)=>void;vi.mocked(invoke).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}) as never);
 fireEvent.click(screen.getByLabelText('I authorize only this exact optional download plan.'));click('Start confirmed download');
 expect((screen.getByLabelText('New subfolder') as HTMLInputElement).disabled).toBe(true);
 await act(async()=>resolve({state:'running',completed:0,total:1,bytesDownloaded:0,error:null}));
});
it('turns user repository listings into explicit repository browsing',async()=>{
 await open();vi.mocked(invoke).mockResolvedValueOnce({resources:[{id:'repo',label:'Owner/repo',kind:'repo',downloadable:false,locator:'models:Owner/repo'}],nextCursor:null,warnings:[]});fireEvent.change(screen.getByLabelText('Source locator'),{target:{value:'Owner'}});click('Browse resources');await screen.findByRole('button',{name:'Select repository: Owner/repo'});click('Select repository: Owner/repo');expect((screen.getByLabelText('Source locator') as HTMLInputElement).value).toBe('models:Owner/repo');expect((screen.getByLabelText('Browse mode') as HTMLSelectElement).value).toBe('repo');expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:{providerId:'fixture',scope:'repo',locator:'models:Owner/repo',authenticated:false,nsfw:false}});
});
it('imports data-only catalogs explicitly and adopts returned provider entries without browsing',async()=>{
 await open();const text='version = 1\nentries = []';
 vi.mocked(invoke).mockResolvedValueOnce({...catalog,entries:[...catalog.entries,{...catalog.entries[0],id:'extra',label:'Added entry'}]});
 fireEvent.change(screen.getByLabelText('TOML catalog data'),{target:{value:text}});click('Validate and extend catalog');await screen.findByRole('option',{name:'Added entry'});
 expect(invoke).toHaveBeenLastCalledWith('native_download_import_catalog',{text});expect((screen.getByLabelText('TOML catalog data') as HTMLTextAreaElement).value).toBe('');expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_download_browse')).toBe(false);
});
it('restores saved tokens only through an explicit action and displays metadata',async()=>{
 mount(true);click('Provider authorization');expect(invoke).not.toHaveBeenCalled();vi.mocked(invoke).mockResolvedValueOnce({providerId:'huggingface',configured:true,persisted:true});click('Explicitly restore saved token');await screen.findByText(/Token configured; account not verified/);expect(invoke).toHaveBeenLastCalledWith('native_auth_restore',{providerId:'huggingface'});expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('');
});
it('labels unavailable browser transport without IPC',()=>{vi.mocked(isTauri).mockReturnValue(false);mount();click('Optional downloads');expect(screen.getByText(/Browser preview/)).toBeTruthy();expect(invoke).not.toHaveBeenCalled();});
it('shows catalog categories as cards with previews, opens an entry on click and targets the managed ComfyUI folder',async()=>{
 const entries=[{id:'lora-a',label:'Lora A',providerId:'fixture',scope:'index',locator:'https://example.invalid/a.json',kind:'model',target:'loras',preview:'https://image.civitai.com/a.jpeg'},{id:'wf',label:'Workflow W',providerId:'fixture',scope:'index',locator:'https://example.invalid/w.json',kind:'workflow',target:'workflows'},{id:'ckpt',label:'Image checkpoint',providerId:'fixture',scope:'index',locator:'https://example.invalid/c.json',kind:'model',target:'checkpoints',media:'image',auth:true},{id:'wan',label:'Video model',providerId:'fixture',scope:'index',locator:'https://example.invalid/v.json',kind:'model',target:'diffusion_models',media:'video'}];
 vi.mocked(invoke).mockImplementation(async(c,a)=>c==='native_download_catalog'?{...catalog,providers:[...catalog.providers,{id:'civitai',kind:'civitai',label:'CivitAI',origin:'https://civitai.com',scopes:['user','model','search'],anonymousNotice:''}],entries}:c==='native_download_browse'?((a as {request:{scope:string}}).request.scope==='search'?{resources:[{id:'civitai:7',label:'Found · v1',kind:'repo',downloadable:false,locator:'7',category:'checkpoints',preview:'https://image.civitai.com/f.jpeg'}],nextCursor:null,warnings:[]}:{resources:[{...resource,preview:'https://image.civitai.com/r.jpeg'}],nextCursor:null,warnings:[]}):c==='native_download_plan'?{id:'p',target:(a as {request:{parentPath:string}}).request.parentPath,resources:[resource],totalKnownBytes:23,unknownSizeCount:0,warnings:[],canExecute:true}:{state:'idle',completed:0,total:0,bytesDownloaded:0,error:null});
 render(<I18nProvider><DownloadPanel installTarget="/env"/></I18nProvider>);click('Optional downloads');
 const tabs=await screen.findAllByRole('tab');expect(tabs.map(t=>t.textContent)).toEqual(['Models','LoRAs','Workflows']);expect(tabs[0].getAttribute('aria-selected')).toBe('true');
 expect(screen.getByRole('button',{name:/Image checkpoint/})).toBeTruthy();expect(screen.getByText('Login / API key needed')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Video'}));expect(screen.queryByRole('button',{name:/Image checkpoint/})).toBeNull();expect(screen.getByRole('button',{name:/Video model/})).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'All'}));
 fireEvent.click(screen.getByRole('button',{name:/Image checkpoint/}));await screen.findByText('/env/ComfyUI/models/checkpoints');expect((screen.getByLabelText('Access mode') as HTMLSelectElement).value).toBe('true');
 fireEvent.click(screen.getByRole('tab',{name:'LoRAs'}));
 expect(document.querySelector('.download-card img')).toBeTruthy();expect(screen.queryByRole('button',{name:'Workflow W'})).toBeNull();expect(screen.queryByRole('button',{name:/Image checkpoint/})).toBeNull();
 fireEvent.click(screen.getByRole('tab',{name:'Workflows'}));expect(screen.getByRole('button',{name:'Workflow W'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Workflow W'}));await screen.findByLabelText('Remote file');
 expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:{providerId:'fixture',scope:'index',locator:'https://example.invalid/w.json',authenticated:true,nsfw:false}});
 expect(document.querySelector('.download-resource img')).toBeTruthy();expect(screen.getByText('/env/ComfyUI/user/default/workflows')).toBeTruthy();
 fireEvent.click(screen.getByLabelText('Remote file'));click('Prepare native download plan');await screen.findByLabelText('I authorize only this exact optional download plan.');
 expect(invoke).toHaveBeenLastCalledWith('native_download_plan',{request:{providerId:'fixture',resources:[expect.objectContaining({id:'file'})],parentPath:'/env/ComfyUI/user/default/workflows',folderName:'',authenticated:true}});
 fireEvent.change(screen.getByLabelText('Search CivitAI'),{target:{value:'found'}});click('Search');await screen.findByRole('button',{name:'Select repository: Found · v1'});
 expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:{providerId:'civitai',scope:'search',locator:'found',authenticated:true,nsfw:false}});
 click('Select repository: Found · v1');await screen.findByLabelText('Remote file');expect(screen.getByText('/env/ComfyUI/models/checkpoints')).toBeTruthy();
 expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:{providerId:'civitai',scope:'model',locator:'7',authenticated:true,nsfw:false}});
});
it('keeps only one bubble panel open when switching between authorization and downloads',async()=>{
 render(<I18nProvider><DownloadWorkspace/></I18nProvider>);
 click('Provider authorization');expect(screen.getByLabelText('Token')).toBeTruthy();
 click('Optional downloads');await screen.findAllByRole('tab');expect(screen.queryByLabelText('Token')).toBeNull();
 click('Provider authorization');expect(screen.getByLabelText('Token')).toBeTruthy();expect(screen.queryByRole('tab')).toBeNull();
 click('Provider authorization');expect(screen.getByLabelText('Token')).toBeTruthy();
});
it('hides adult entries until the NSFW switch is confirmed and sends the flag to native browsing',async()=>{
 const entries=[{id:'sfw',label:'Safe model',providerId:'fixture',scope:'index',locator:'https://example.invalid/s.json',kind:'model',target:'checkpoints'},{id:'adult',label:'Adult model',providerId:'fixture',scope:'index',locator:'https://example.invalid/a.json',kind:'model',target:'checkpoints',nsfw:true}];
 vi.mocked(invoke).mockImplementation(async c=>c==='native_download_catalog'?{...catalog,entries}:{resources:[{...resource,nsfw:true},{...resource,id:'safe',label:'Safe file'}],nextCursor:null,warnings:[]});
 mount();click('Optional downloads');await screen.findByRole('button',{name:/Safe model/});expect(screen.queryByRole('button',{name:/Adult model/})).toBeNull();
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);fireEvent.click(screen.getByRole('switch'));expect(screen.queryByRole('button',{name:/Adult model/})).toBeNull();
 confirm.mockReturnValue(true);fireEvent.click(screen.getByRole('switch'));expect(screen.getByRole('button',{name:/Adult model/})).toBeTruthy();expect(screen.getByText('+NSFW (18+)')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/Adult model/}));await screen.findByLabelText('Remote file');
 expect(invoke).toHaveBeenLastCalledWith('native_download_browse',{request:{providerId:'fixture',scope:'index',locator:'https://example.invalid/a.json',authenticated:false,nsfw:true}});
 fireEvent.click(screen.getByRole('switch'));expect(screen.queryByLabelText('Remote file')).toBeNull();expect(confirm).toHaveBeenCalledTimes(2);confirm.mockRestore();
});
it('opens the fixed provider token page natively without sending any URL',async()=>{
 mount(true);click('Provider authorization');fireEvent.change(screen.getByLabelText('Provider'),{target:{value:'civitai'}});click('Open token page in browser');await act(async()=>{});
 expect(invoke).toHaveBeenCalledWith('native_open_token_page',{providerId:'civitai'});
});
