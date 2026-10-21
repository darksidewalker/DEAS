"""Dependency warning/Run-gate Chromium IPC fixtures; no native or model acceptance."""
import ast
import json
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4199'
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home()/'.hermes/cache/scratch/deas-dependency-warnings'
module = ast.parse((ROOT/'tools/verify_workbench.py').read_text())
FIXTURE = next(ast.literal_eval(n.value) for n in module.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'fixture' for t in n.targets))
FIXTURE = FIXTURE.replace("throw Error('Unexpected command '+command);", "if(command==='native_media_star_status')return {starred:false,unavailable:'fixture'};throw Error('Unexpected command '+command);")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for locale in ['en', 'de', 'fr', 'ja', 'tr', 'zh']:
            labels = json.loads((ROOT/f'src/features/studio/locales/{locale}.json').read_text())
            context = browser.new_context(viewport={'width': 1440, 'height': 960})
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            # Only initialize once: reload must restore the user's corrected preferences.
            page.add_init_script(FIXTURE + '\n' + """
if(!localStorage.getItem('dependency-fixture-initialized')){
 localStorage.setItem('dependency-fixture-initialized','1');
 localStorage.setItem('deas.locale.v1',LOCALE);
 localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify('missing.safetensors'));
 localStorage.setItem('deas.pref.studio.run.sampler',JSON.stringify('missing-sampler'));
}
""".replace('LOCALE', json.dumps(locale)))
            page.goto(URL, wait_until='networkidle')
            page.locator('[data-node="studio"]').click()
            page.locator('[data-dock-tab="models"]').click()
            page.locator('[data-run-load]').click()
            warning = page.locator('.wb-stage-warning')
            expect(warning).to_contain_text('missing.safetensors')
            expect(warning).to_contain_text('missing-sampler')
            expect(page.locator('[data-run]')).to_be_disabled()
            page.get_by_role('button', name='sdxl/juggernaut.safetensors', exact=True).click()
            expect(warning).not_to_contain_text('missing.safetensors')
            expect(warning).to_contain_text('missing-sampler')
            expect(page.locator('[data-run]')).to_be_disabled()
            page.get_by_role('combobox', name=labels['studio.recipe.sampler'], exact=True).select_option('euler')
            expect(warning).to_have_count(0)
            expect(page.locator('[data-run]')).to_be_enabled()
            page.reload(wait_until='networkidle')
            page.locator('[data-node="studio"]').click()
            page.locator('[data-dock-tab="models"]').click()
            page.locator('[data-run-load]').click()
            expect(warning).to_have_count(0)
            expect(page.locator('[data-run]')).to_be_enabled()
            page.locator('[data-run]').click()
            page.wait_for_function("__calls.some(c=>c.command==='native_job_submit')")
            assert page.evaluate("__calls.find(c=>c.command==='native_job_prepare').args.intent.checkpoint") == 'sdxl/juggernaut.safetensors'
            assert not errors, errors
            results.append({'locale': locale, 'warning_cleared': True, 'reload_retained': True, 'fixture_submit': True})
            context.close()
        browser.close()
    (OUT/'results.json').write_text(json.dumps(results, indent=2)+'\n')
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
