"""Prompt writing aid browser acceptance; strict local IPC fixtures, no real services.
Run: uv run --no-project --with playwright==1.64.1 python tools/verify_prompt_tools.py
"""
import json
from playwright.sync_api import expect
import verify_postprocessing as runner
import verify_workbench_collection as collection
import verify_workspace_layout as layout

FIXTURE = layout.FIXTURE + r'''
const promptInvoke=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(c,a)=>{
 if(c==='native_forge_tag_search'){
  f.calls.push({command:c,args:clone(a)});
  return [{tag:'blue eyes',category:'general',count:12},{tag:'blue hair',category:'general',count:8}];
 }
 return promptInvoke(c,a);
};
'''


def verify(browser, url, shots):
    original = collection.FIXTURE
    collection.FIXTURE += FIXTURE
    try:
        context, page, errors = collection.open_studio(browser, url, False)
    finally:
        collection.FIXTURE = original
    try:
        checks = []
        positive = page.locator('[data-run-positive]')
        negative = page.locator('[data-run-negative]')
        positive.fill('blue')
        page.wait_for_timeout(220)
        assert not page.evaluate('__collection.calls.some(c=>c.command==="native_forge_tag_search")')
        page.locator('[data-node="settings"]').click()
        page.get_by_label('Spellcheck language', exact=True).select_option('fr')
        page.get_by_role('checkbox', name='Tag autocomplete', exact=True).check()
        page.locator('[data-node="studio"]').click()
        expect(positive).to_have_attribute('lang', 'fr')
        expect(negative).to_have_attribute('spellcheck', 'true')
        positive.fill('rain, bluZZ, sky')
        positive.press('Home')
        for _ in range(9):
            positive.press('ArrowRight')
        try:
            expect(page.get_by_role('listbox')).to_be_visible()
        except AssertionError:
            print('PROMPT_DIAGNOSTICS', page.evaluate('({calls:__collection.calls,unexpected:__collection.unexpected,pref:localStorage.getItem("deas.pref.prompt.tools"),root:localStorage.getItem("deas.pref.install.root"),selection:[document.querySelector("[data-run-positive]").selectionStart,document.querySelector("[data-run-positive]").selectionEnd]})'))
            raise
        positive.press('ArrowDown')
        positive.press('Enter')
        expect(positive).to_have_value('rain, blue hair, sky')
        expect(page.locator('[data-prompt-count="positive"]')).to_have_text('20 / 16384')
        checks.append('default-off, settings sync, caret replacement and keyboard choice')
        page.locator('[data-prompt-expand="positive"]').click()
        dialog = page.get_by_role('dialog', name='Prompt', exact=True)
        enlarged = dialog.get_by_role('textbox', name='Prompt', exact=True)
        expect(enlarged).to_have_value('rain, blue hair, sky')
        expect(enlarged).to_have_attribute('lang', 'fr')
        enlarged.fill('blu')
        expect(dialog.get_by_role('listbox')).to_be_visible()
        enlarged.press('Escape')
        expect(dialog).to_be_visible()
        expect(dialog.get_by_role('listbox')).to_have_count(0)
        enlarged.press('Escape')
        expect(dialog).to_have_count(0)
        expect(positive).to_have_value('blu')
        checks.append('enlarged editor shares settings/value; first Escape dismisses suggestions only')
        page.get_by_role('button', name='Quick Settings', exact=True).click()
        page.get_by_role('button', name='Prompt spellcheck', exact=True).click()
        page.get_by_role('button', name='Tag autocomplete', exact=True).click()
        expect(positive).to_have_attribute('spellcheck', 'false')
        page.keyboard.press('Escape')
        negative.fill('negative')
        expect(page.locator('[data-prompt-count="negative"]')).to_have_text('8 / 16384')
        for locale in collection.LOCALES:
            collection.set_locale(page, locale, '[data-node="studio"]')
            for width in (320, 700, 1440):
                page.set_viewport_size({'width': width, 'height': 960})
                positive.scroll_into_view_if_needed()
                geometry = page.locator('.wb-prompt-label').evaluate_all('els=>els.map(e=>{const [label,count]=e.children;const a=label.getBoundingClientRect(),b=count.getBoundingClientRect();return {sameLine:Math.abs(a.top-b.top)<6,clear:a.right<=b.left+1,contained:e.scrollWidth<=e.clientWidth+1};})')
                assert all(g['sameLine'] and g['clear'] and g['contained'] for g in geometry), (locale, width, geometry)
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                if locale == 'en':
                    page.screenshot(path=str(shots/f'prompt-tools-{width}.png'))
                checks.append(f'{locale}:{width}:inline label/count geometry')
        expect(positive).to_have_attribute('lang', 'fr')
        collection.assert_clean(page, errors)
        assert not page.evaluate('__collection.calls.some(c=>/(_run|_submit|_start|_stop|_write|_generate)$/.test(c.command))')
        result = {'status': 'PASS', 'checks': checks, 'kind': 'Chromium, simulated local tag IPC; no native spell rendering', 'screenshots': str(shots)}
        (shots/'result.json').write_text(json.dumps(result, indent=2)+'\n')
        print(json.dumps(result, indent=2))
    finally:
        context.close()


if __name__ == '__main__':
    runner.verify = verify
    runner.main()
