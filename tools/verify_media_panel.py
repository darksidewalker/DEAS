"""Shared Studio/Forge media panel — Chromium IPC fixtures, no backend execution."""
import ast
import json
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4198'
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home()/'.hermes/cache/scratch/deas-media-panel'
OUT.mkdir(parents=True, exist_ok=True)
module = ast.parse((ROOT/'tools/verify_workbench.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(n.value) for n in module.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'fixture' for t in n.targets))
fixture = "localStorage.setItem('deas.pref.install.root','\"/env\"');localStorage.setItem('deas.pref.backend.autostart','false');" + fixture
fixture = fixture.replace('window.__calls.push({command,args});', '''window.__calls.push({command,args});
if(command==='native_files_present') return args.paths.map(()=>true);
if(command==='native_install_plan') return {id:'fixture-plan',reopenId:'fixture-reopen',request:args.request,steps:[],warnings:[],unsupportedOptions:[],canExecute:true};
if(command==='native_install_open') return {state:'succeeded',stepId:null,logs:[],error:null};
if(command==='native_settings_read') return {};
if(command==='native_backend_status') return {state:'stopped',endpoint:null,error:null,logs:[]};
if(command==='native_backend_test') return [];
if(command==='native_llm_read') return {provider:'ollama',baseUrl:'http://127.0.0.1:11434'};
if(command==='native_forge' && args.route==='models') return {models:[{id:'fixture-llm',label:'Fixture LLM'}],errors:{},creativity:['balanced'],shot_counts:['Auto',1,2],default_shots:'Auto',durations:[5,8]};
if(command==='native_media_star_status') return {starred:false,unavailable:null};
''')
results = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for width in (1440, 768, 320):
        page = browser.new_page(viewport={'width': width, 'height': 960}, reduced_motion='reduce')
        page.add_init_script(fixture)
        page.goto(URL, wait_until='networkidle')
        for locale in ('en', 'de', 'fr', 'ja', 'tr', 'zh'):
            page.locator('[data-node="settings"]').click()
            page.locator('#language-select').select_option(locale)
            page.locator('[data-node="studio"]').click()
            studio = page.locator('[data-workbench]')
            studio.locator('[data-dock-tab="media"]').click()
            studio.locator('[data-dock-sort]').select_option('name')
            page.locator('[data-studio-tab="forge"]').click()
            forge = page.locator('.forge-media')
            expect(forge).to_be_visible()
            for selector in ('[data-dock-search]', '[data-dock-sort]', '[data-dock-type]', '[data-dock-view]', '[data-media-root="output"]', '[data-media-root="starred"]', '[data-media-root="input"]'):
                expect(forge.locator(selector)).to_be_visible()
                assert forge.locator(selector).count() == 1, (width, locale, selector)
            forge.locator('[data-dock-view]').select_option('list')
            forge.locator('[data-dock-type]').select_option('image')
            forge.locator('[data-dock-sort]').select_option('size')
            forge.locator('[data-dock-search]').fill('DEAS_0001')
            expect(forge.locator('.media-list button[data-kind="file"]').first).to_be_visible()
            assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), (width, locale, 'page overflow')
            assert forge.evaluate('e=>e.scrollWidth<=e.clientWidth'), (width, locale, 'panel overflow')
            page.locator('[data-node="studio"]').click()
            expect(studio.locator('[data-dock-sort]')).to_have_value('name')
            page.locator('[data-studio-tab="forge"]').click()
            expect(forge.locator('[data-dock-sort]')).to_have_value('size')
            expect(forge.locator('[data-dock-search]')).to_have_value('DEAS_0001')
            expect(forge.locator('[data-dock-view]')).to_have_value('list')
            if locale == 'en':
                page.screenshot(path=str(OUT/f'forge-{width}.png'), full_page=True)
            results.append({'width': width, 'locale': locale, 'panel': forge.bounding_box()})
        blocked = ('native_input_upload', 'native_job_prepare', 'native_job_submit', 'native_workbench_run', 'native_backend_start', 'native_forge_write')
        calls = page.evaluate('window.__calls')
        assert not any(c['command'] in blocked or (c['command']=='native_forge' and c.get('args',{}).get('route')!='models') for c in calls)
        page.close()
    browser.close()
(OUT/'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
print(f'PASS: {len(results)} shared media panel locale/width cases; no execution; evidence {OUT}')
