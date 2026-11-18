"""Library Catalog/Installed parity: synthetic IPC, no provider or filesystem actions."""
import json
from playwright.sync_api import expect
import verify_postprocessing as runner
import verify_workspace_layout as layout

FIXTURE = layout.FIXTURE + r'''
window.__catalogCalls=[];
const catalogBaseInvoke=window.__TAURI_INTERNALS__.invoke;
const entries=Array.from({length:76},(_,i)=>({id:'catalog-'+i,label:'Catalog '+String(i).padStart(2,'0'),providerId:'civitai',scope:'model',locator:String(i+1),kind:'model',target:i<72?'loras':'checkpoints',base:i%2?'SDXL':'Anima',media:i%2?'video':'image'}));
entries.push({id:'civitai-creator-fixture',label:'Fixture creator',providerId:'civitai',scope:'user',locator:'FixtureCreator',kind:'model',target:'other'});
const liveModels=[{id:'live-a',label:'Creator Alpha',kind:'repo',locator:'1001',downloadable:false,category:'loras',base:'Anima'},{id:'live-b',label:'Creator Beta',kind:'repo',locator:'1002',downloadable:false,category:'checkpoints',base:'SDXL'}];
window.__TAURI_INTERNALS__.invoke=async(c,a)=>{
 window.__catalogCalls.push({c,a});
 if(c==='native_download_catalog')return {version:1,providers:[{id:'civitai',kind:'civitai',label:'CivitAI',origin:'https://civitai.com',scopes:['user','model','search'],anonymousNotice:''}],entries};
 if(c==='native_download_browse')return {resources:['user','search'].includes(a.request.scope)?structuredClone(liveModels):[{id:'weight',label:'weight.safetensors',kind:'file',locator:'weight.safetensors',url:'https://civitai.com/api/download/models/1001',downloadable:true,size:123}],nextCursor:null,warnings:[]};
 if(c==='native_models_scan')return [{category:'loras',name:'Styles/local.safetensors',path:'/fixture/models/loras/Styles/local.safetensors',size:123,info:null,family:'sdxl'}];
 if(c==='native_model_scan_status')return {id:'',root:'',state:'idle',scope:'all',total:0,completed:0,remaining:0,failed:0,file:''};
 if(c==='native_files_present')return a.paths.map(()=>false);
 return catalogBaseInvoke(c,a);
};
'''


def centered(page):
    shapes=page.locator('.library-card-art .library-placeholder').all()
    assert shapes
    for shape in shapes[:3]:
        geometry=shape.evaluate('el=>{const r=el.getBoundingClientRect(),s=el.querySelector("svg").getBoundingClientRect();return {display:getComputedStyle(el).display,dx:s.x+s.width/2-r.x-r.width/2,dy:s.y+s.height/2-r.y-r.height/2};}')
        assert geometry['display']=='flex' and abs(geometry['dx'])<1 and abs(geometry['dy'])<1,geometry


def verify(browser,url,shots):
    context=browser.new_context(viewport={'width':1600,'height':1000})
    context.add_init_script(layout.collection.FIXTURE.replace('__MIXED__','false')+FIXTURE)
    context.route('**/*',lambda route:route.continue_() if route.request.url.startswith(url) else route.abort())
    page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    checks=[]
    try:
        page.goto(url,wait_until='domcontentloaded',timeout=30000)
        layout.collection.set_locale(page,'en','[data-node="studio"]')
        page.locator('[data-node="optional-downloads"]').click()
        expect(page.locator('[data-library-tab]')).to_have_text(['Installed','Catalog'])
        page.locator('[data-library-tab="catalog"]').click()
        page.get_by_role('tab',name='LoRAs',exact=True).click()
        catalog=page.locator('[data-catalog-gallery]')
        expect(catalog.locator('.library-card')).to_have_count(60)
        centered(page);checks.append('bounded Installed-style Catalog cards with centered placeholders')
        page.get_by_label('Base model',exact=True).select_option('Anima')
        expect(catalog.locator('.library-card')).to_have_count(36)
        page.get_by_label('Base model',exact=True).select_option('')
        page.get_by_role('button',name='List view',exact=True).click();centered(page)
        page.get_by_role('button',name='Grid view',exact=True).click()
        catalog.locator('.library-star').first.click()
        catalog.locator('.catalog-details').first.click()
        dialog=page.get_by_role('dialog',name='Model details',exact=True)
        expect(dialog).to_be_visible();assert dialog.evaluate('e=>e.matches(":modal")')
        dialog.get_by_label('Personal notes',exact=True).fill('Catalog note only')
        dialog.get_by_label('Edit model tags',exact=True).fill('catalog-tag')
        dialog.get_by_label('Edit model tags',exact=True).press('Tab')
        dialog.get_by_role('button',name='Close model details',exact=True).click()
        catalog.get_by_role('button',name='Favorites',exact=True).click()
        expect(catalog.locator('.library-card')).to_have_count(1)
        assert page.evaluate('localStorage.getItem("deas.pref.library.local.organization")') is None
        checks.append('catalog favorites/tags/notes persist separately without local model organization writes')
        # Return to all groups using the existing root tree entry.
        catalog.get_by_role('treeitem').first.click()
        page.get_by_label('Search catalog & CivitAI',exact=True).fill('Catalog note only')
        expect(catalog.locator('.library-card')).to_have_count(1)
        page.get_by_label('Search catalog & CivitAI',exact=True).fill('')
        for width in [1600,1280,960,640,320]:
            page.set_viewport_size({'width':width,'height':1000})
            controls=page.locator('[data-catalog-actions]')
            assert controls.evaluate('el=>{const boxes=[...el.querySelectorAll("select,input,button.download-start-all")].map(n=>n.getBoundingClientRect());return boxes.every(b=>b.width>0&&b.x>=0&&b.right<=innerWidth+1)&&boxes.every((a,i)=>boxes.every((b,j)=>i===j||a.right<=b.left+1||b.right<=a.left+1||a.bottom<=b.top+1||b.bottom<=a.top+1));}')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            if width>=1280:
                assert controls.evaluate('el=>{const b=[...el.querySelectorAll("select,input,button.download-start-all")].map(n=>n.getBoundingClientRect().bottom);return Math.max(...b)-Math.min(...b)<3;}')
            if width in [1600,960,320]:page.screenshot(path=str(shots/f'catalog-{width}.png'))
            checks.append(f'{width}:source/search/download alignment and no clipping')
        page.set_viewport_size({'width':1600,'height':1000})
        page.get_by_label('Catalog source',exact=True).select_option('civitai-creator-fixture')
        page.get_by_role('button',name='Creator Alpha',exact=True).click()
        file=page.get_by_role('checkbox',name='weight.safetensors',exact=True)
        expect(file).to_be_visible();expect(page.get_by_role('button',name='Creator Beta',exact=True)).to_be_visible()
        file.check();expect(page.get_by_role('button',name='Download all (1)',exact=True)).to_be_enabled()
        checks.append('creator cards retain gallery while files enter the unchanged download basket')
        page.get_by_label('Catalog source',exact=True).select_option('')
        page.get_by_label('Search catalog & CivitAI',exact=True).fill('provider-tag')
        page.locator('[data-catalog-actions]').get_by_role('button',name='Search',exact=True).click()
        expect(page.get_by_role('button',name='Creator Alpha',exact=True)).to_be_visible()
        expect(page.get_by_label('Catalog source',exact=True)).to_have_value('search://')
        page.get_by_label('Catalog source',exact=True).select_option('')
        expect(catalog.locator('.library-card')).to_have_count(60)
        expect(page.get_by_label('Search catalog & CivitAI',exact=True)).to_have_value('')
        checks.append('provider query matches remain visible and returning to bundled source clears discovery without another request')
        page.locator('[data-library-tab="installed"]').click()
        expect(page.get_by_role('button',name='Styles/local.safetensors',exact=True)).to_be_visible();centered(page)
        expect(page.locator('[data-installed-gallery] [role="alert"]')).to_have_count(0)
        page.screenshot(path=str(shots/'installed-placeholder.png'))
        for locale in ['en','de','fr','ja','tr','zh']:
            page.set_viewport_size({'width':1600,'height':1000})
            layout.collection.set_locale(page,locale,'[data-node="optional-downloads"]')
            page.locator('[data-library-tab="catalog"]').click()
            for width in [1600,1280,960,640,320]:
                page.set_viewport_size({'width':width,'height':1000})
                catalog=page.locator('[data-catalog-gallery]')
                expect(catalog.locator('.library-card').first).to_be_attached()
                geometry=catalog.evaluate('el=>{const body=el.querySelector(".library-body"),side=el.querySelector(".library-sidebar");return {body:body.clientHeight,side:side.clientHeight,overflow:body.scrollWidth-body.clientWidth};}')
                assert geometry['body']>=160 and geometry['side']>=100 and geometry['overflow']<=1,(locale,width,geometry)
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),(locale,width)
                assert page.locator('[data-catalog-actions]').evaluate('el=>{const boxes=[...el.querySelectorAll("select,input,button.download-start-all")].map(n=>n.getBoundingClientRect());return boxes.every(b=>b.width>0&&b.x>=0&&b.right<=innerWidth+1)&&boxes.every((a,i)=>boxes.every((b,j)=>i===j||a.right<=b.left+1||b.right<=a.left+1||a.bottom<=b.top+1||b.bottom<=a.top+1));}'),(locale,width)
                catalog.locator('[data-catalog-reset]').scroll_into_view_if_needed()
                catalog.locator('[data-catalog-layout-mode="list"]').click()
                card=catalog.locator('.library-card-main').first
                card.scroll_into_view_if_needed()
                expect(card).to_be_in_viewport(ratio=0.99)
                last=catalog.locator('.library-card-main').last
                last.scroll_into_view_if_needed()
                expect(last).to_be_in_viewport(ratio=0.99)
                if width==320:page.screenshot(path=str(shots/f'catalog-{locale}-{width}-usable.png'))
                catalog.locator('[data-catalog-layout-mode="grid"]').click()
                checks.append(f'{locale}/{width}:usable filter and card panes, list reachability and no horizontal clipping')
        calls=page.evaluate('__catalogCalls')
        browses=[call['a']['request'] for call in calls if call['c']=='native_download_browse']
        assert [request['scope'] for request in browses]==['user','model','search'],browses
        assert all(request['providerId']=='civitai' for request in browses),browses
        assert not [c for c in calls if c['c'] in ['native_download_start','native_download_plan','native_model_scan_start','native_model_family_write','native_backend_start']]
        assert not errors,errors
        result={'status':'PASS','checks':checks,'kind':'Chromium with synthetic catalog/model data and strict simulated IPC; no native/provider operations','screenshots':str(shots)}
        (shots/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
    except Exception:
        page.screenshot(path=str(shots/'failure.png'))
        (shots/'failure.html').write_text(page.content())
        print('FAILURE_ARTIFACTS',shots)
        print('SELECTS',page.locator('select').evaluate_all('(es)=>es.map(e=>({label:e.closest("label")?.textContent,aria:e.getAttribute("aria-label"),html:e.outerHTML.slice(0,350)}))'))
        raise
    finally:context.close()

if __name__=='__main__':
    runner.verify=verify
    runner.main()
