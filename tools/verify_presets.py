"""Studio preset browser IPC fixture; no real filesystem persistence or generation."""
import ast
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright
from deas_locale import set_locale

root = Path(__file__).resolve().parents[1]
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:1432'
output = Path(sys.argv[2]) if len(sys.argv) > 2 else root / 'assets'
output.mkdir(parents=True, exist_ok=True)
fixture = next(ast.literal_eval(n.value) for n in ast.parse((root / 'tools/verify_workbench.py').read_text()).body
               if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'fixture' for t in n.targets))
fixture = fixture.replace("window.__calls.push({command,args});", """window.__calls.push({command,args});
if(command==='native_presets_read')return JSON.parse(localStorage.getItem('fixture.presets')||'[]');
if(command==='native_presets_write'){localStorage.setItem('fixture.presets',JSON.stringify(args.presets));return;}
""")
with sync_playwright() as p:
    browser = p.chromium.launch()
    for locale in ('en', 'de', 'fr', 'ja', 'tr', 'zh'):
        for width in (1440, 320):
            page = browser.new_page(viewport={'width': width, 'height': 960}, reduced_motion='reduce')
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(fixture)
            page.goto(url, wait_until='networkidle')
            set_locale(page, locale)
            page.locator('[data-node="studio"]').click()
            page.locator('[data-studio-tab="generate"]').click()
            page.locator('[data-run-positive]').fill('Custom settings — 猫')
            page.locator('[data-dock-tab="presets"]').click()
            panel = page.locator('.presets')
            panel.locator('input').fill('Custom — 猫')
            panel.locator('button').nth(1).click()
            page.wait_for_function("JSON.parse(localStorage.getItem('fixture.presets')||'[]').length===1")
            page.locator('[data-run-positive]').fill('Changed')
            panel.locator('button').nth(0).click()
            assert page.locator('[data-run-positive]').input_value() == 'Custom settings — 猫'
            page.reload(wait_until='networkidle')
            page.locator('[data-node="studio"]').click()
            page.locator('[data-studio-tab="generate"]').click()
            page.locator('[data-dock-tab="presets"]').click()
            panel.locator('select').select_option('Custom — 猫')
            page.locator('[data-run-positive]').fill('After reload')
            panel.locator('button').nth(0).click()
            assert page.locator('[data-run-positive]').input_value() == 'Custom settings — 猫'
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (locale, width, 'page overflow')
            assert panel.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1'), (locale, width, 'panel overflow')
            assert page.locator('[data-dock-tab="wildcards"]').count() == 1
            assert page.evaluate("__calls.filter(x=>['native_job_prepare','native_job_submit','native_workbench_run','native_job_upload_input'].includes(x.command)).length") == 0
            assert not errors, errors
            if locale == 'en':
                page.screenshot(path=str(output / f'deas-presets-fixture-{width}.png'))
            page.close()
    browser.close()
print('PASS: save/load/reload, independent Wildcards tab, no execution and no overflow in six locales at 1440/320px (mocked IPC).')
