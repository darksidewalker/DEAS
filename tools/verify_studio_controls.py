"""Studio layout/reset Chromium IPC fixture; no native-webview or generation acceptance."""
import ast
import json
from datetime import datetime
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4197').rstrip('/')
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home()/'.hermes/cache/scratch'/('deas-studio-controls-'+datetime.now().strftime('%Y%m%d-%H%M%S'))
module = ast.parse((ROOT/'tools/verify_workbench.py').read_text(encoding='utf-8'))
FIXTURE = next(ast.literal_eval(n.value) for n in module.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'fixture' for t in n.targets))
EXTRA = r"""
if(command==='plugin:event|listen'||command==='plugin:event|unlisten'||command==='native_project_close_notice')return 1;
if(command==='native_project_open')return {id:'fixture-project',root:'/projects/a-very-long-project-name-to-test-layout',revision:1,draft:{positivePrompt:'project prompt',negativePrompt:'',checkpoint:'sdxl/juggernaut.safetensors',width:1024,height:1024,steps:20,cfg:5,sampler:'euler',scheduler:'normal',seed:42,denoise:0.6,pipeline:'t2i'},input:null};
if(command==='native_project_close')return null;
if(command==='native_project_save')return {id:args.projectId,root:'/projects/a-very-long-project-name-to-test-layout',revision:args.expectedRevision+1,draft:args.draft,input:null};
"""
FIXTURE = FIXTURE.replace("throw Error('Unexpected command '+command);", EXTRA+"throw Error('Unexpected command '+command);")
FIXTURE += "\nwindow.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};window.__TAURI_INTERNALS__.transformCallback=()=>1;window.__TAURI_INTERNALS__.unregisterCallback=()=>{};window.__TAURI_INTERNALS__.metadata={currentWindow:{label:'main'},currentWebview:{label:'main'}};"


def drag(page, locator, dx=0, dy=0, cancel=False):
    box = locator.bounding_box()
    page.mouse.move(box['x']+box['width']/2, box['y']+box['height']/2)
    page.mouse.down()
    page.mouse.move(box['x']+box['width']/2+dx, box['y']+box['height']/2+dy, steps=8)
    if cancel:
        page.keyboard.press('Escape')
    page.mouse.up()


def run_bounds(page):
    run, queue = [page.locator(s).bounding_box() for s in ('[data-run]', '.wb-queue')]
    assert run['x'] >= queue['x'] and run['x']+run['width'] <= queue['x']+queue['width']+1, (run, queue)
    assert run['y'] >= queue['y'] and run['y']+run['height'] <= queue['y']+queue['height']+1, (run, queue)


def quick(page, index):
    page.locator('.studio-quick > button').click()
    page.locator('.studio-quick-actions button').nth(index).click()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for locale in ['en', 'de', 'fr', 'ja', 'tr', 'zh']:
            for width in [1440, 390]:
                context = browser.new_context(viewport={'width': width, 'height': 1000})
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.add_init_script(FIXTURE+'\nlocalStorage.setItem("deas.locale.v1",'+json.dumps(locale)+');')
                page.goto(URL, wait_until='networkidle')
                page.locator('[data-node="studio"]').click()
                expect(page.locator('[data-workbench]')).to_be_visible()
                assert page.locator('.studio-quick').evaluate('e=>e.nextElementSibling.classList.contains("repo-links")')
                if locale == 'en' and width == 1440:
                    page.locator('[data-dock-tab="models"]').click()
                    page.locator('[data-run-load]').click()
                    page.locator('[data-run-checkpoint] button').first.wait_for()
                    page.locator('[data-run-positive]').fill('global controls draft')
                    left, right = [page.locator('.wb-column-handle').nth(i) for i in (0, 1)]
                    initial = page.locator('.wb-center').bounding_box()['width']
                    drag(page, left, dx=60)
                    expect(left).to_have_attribute('aria-valuenow', '332')
                    drag(page, right, dx=-40)
                    expect(right).to_have_attribute('aria-valuenow', '192')
                    assert page.locator('.wb-center').bounding_box()['width'] <= initial-99
                    drag(page, left, dx=80, cancel=True)
                    expect(left).to_have_attribute('aria-valuenow', '332')
                    drag(page, page.locator('.wb-dock-handle'), dy=-40)
                    expect(page.locator('.wb-dock-handle')).to_have_attribute('aria-valuenow', '260')
                    page.reload(wait_until='networkidle')
                    page.locator('[data-node="studio"]').click()
                    expect(left).to_have_attribute('aria-valuenow', '332')
                    expect(right).to_have_attribute('aria-valuenow', '192')
                    expect(page.locator('[data-run-positive]')).to_have_value('global controls draft')
                    quick(page, 0)
                    expect(left).to_have_attribute('aria-valuenow', '272')
                    expect(right).to_have_attribute('aria-valuenow', '152')
                    expect(page.locator('.wb-dock-handle')).to_have_attribute('aria-valuenow', '220')
                    expect(page.locator('[data-run-positive]')).to_have_value('global controls draft')
                    page.once('dialog', lambda dialog: dialog.dismiss())
                    quick(page, 1)
                    expect(page.locator('[data-run-positive]')).to_have_value('global controls draft')
                    page.once('dialog', lambda dialog: dialog.accept())
                    quick(page, 1)
                    expect(page.locator('[data-run-positive]')).to_have_value('')
                    page.locator('[data-run-positive]').fill('global controls draft')
                    page.set_viewport_size({'width': 920, 'height': 1000})
                    left.press('End')
                    assert page.locator('.wb-center').bounding_box()['width'] >= 319
                    page.set_viewport_size({'width': width, 'height': 1000})
                    quick(page, 0)
                if width < 900:
                    expect(page.locator('.wb-column-handle').first).not_to_be_visible()
                    assert page.locator('.wb-center').bounding_box()['width'] >= 300
                menu = page.locator('.project-menu')
                menu.locator('summary').click()
                page.locator('[data-project-open]').click()
                expect(page.locator('[data-run-positive]')).to_have_value('project prompt')
                run_bounds(page)
                if width > 900:
                    assert abs(page.locator('.wb-queue').bounding_box()['width']-float(page.locator('.wb-column-handle').nth(1).get_attribute('aria-valuenow'))) <= 1
                menu.press('Escape')
                page.screenshot(path=str(OUT/f'{locale}-{width}.png'), full_page=True)
                if locale == 'en' and width == 1440:
                    page.once('dialog', lambda dialog: (expect_scope(dialog), dialog.accept()))
                    quick(page, 1)
                    expect(page.locator('[data-run-positive]')).to_have_value('')
                    assert page.evaluate('JSON.parse(localStorage.getItem("deas.pref.studio.run.positive"))') == 'global controls draft'
                    menu.locator('summary').click()
                    page.locator('[data-project-close]').click()
                    expect(page.locator('[data-run-positive]')).to_have_value('global controls draft')
                assert not errors, errors
                assert not page.evaluate('__calls.some(c=>/native_job_prepare|native_job_submit|native_workbench_run|native_input_upload|native_mask_upload/.test(c.command))')
                results.append({'locale': locale, 'width': width, 'run_inside_queue': True})
                context.close()
        browser.close()
    (OUT/'results.json').write_text(json.dumps(results, indent=2)+'\n', encoding='utf-8')
    print(f'PASS: {len(results)} locale/viewport cases; pointer drag/cancel, persistence, independent header resets, project/global isolation, active-project Run bounds. Evidence: {OUT}')


def expect_scope(dialog):
    assert 'autosave' in dialog.message and 'Global Studio preferences' in dialog.message


if __name__ == '__main__':
    main()
