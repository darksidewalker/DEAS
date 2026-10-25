"""Compact navigation / preview / frame reset. Browser IPC fixtures, not native generation."""
import ast
import base64
import json
from pathlib import Path
import struct
import sys
import zlib
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4187'
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home()/'.hermes/cache/scratch/deas-workspace-ux'
OUT.mkdir(parents=True, exist_ok=True)
# Reuse the existing read-only browser IPC fixture, without executing its suite.
module = ast.parse((ROOT/'tools/verify_workbench.py').read_text())
fixture = next(ast.literal_eval(n.value) for n in module.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'fixture' for t in n.targets))
def chunk(kind, data):
    return struct.pack('>I', len(data))+kind+data+struct.pack('>I', zlib.crc32(kind+data))
png = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('>IIBBBBB', 1024, 640, 8, 2, 0, 0, 0))+chunk(b'IDAT', zlib.compress((b'\0'+b'\x58\x88\xa0'*1024)*640))+chunk(b'IEND', b'')
fixture = fixture.replace(fixture.split("const png='")[1].split("';")[0], 'data:image/png;base64,'+base64.b64encode(png).decode())
results = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for width in (1440, 1024, 768, 390, 320):
        page = browser.new_page(viewport={'width': width, 'height': 960}, reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(fixture)
        page.goto(URL, wait_until='networkidle')
        page.locator('[data-node="studio"]').click()
        for locale in ('de', 'en', 'fr', 'ja', 'tr', 'zh'):
            page.locator('[data-node="settings"]').click()
            page.locator('#language-select').select_option(locale)
            page.locator('[data-node="studio"]').click()
            assert page.locator('.aio-tabs > button').count() == 7
            assert page.locator('.studio-tabs').count() == 0
            assert page.locator('.aio-setup-header').count() == 0
            assert page.locator('.aio-tabs [data-node="settings"]').is_visible()
            assert page.locator('.aio-tabs [data-node="logs"]').is_visible()
            assert not page.locator('[data-node="setup:aio"]').count()
            assert page.locator('.wordmark').count() == 0
            assert page.locator('.footer').evaluate("e=>getComputedStyle(e).position") == 'fixed'
            assert page.locator('.footer').evaluate("e=>getComputedStyle(e).backgroundColor") == 'rgba(0, 0, 0, 0)'
            assert page.locator('.footer-version').evaluate("e=>getComputedStyle(e).backgroundColor") == 'rgba(0, 0, 0, 0)'
            version_style = page.locator('.footer-version').evaluate("e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {appearance:s.appearance,border:s.borderTopWidth,shadow:s.boxShadow,font:s.fontSize,width:r.width,height:r.height}}")
            assert version_style['appearance'] == 'none' and version_style['border'] == '0px' and version_style['shadow'] == 'none', (width, locale, version_style)
            assert version_style['font'] == '9px' and version_style['height'] <= 14 and version_style['width'] < 150, (width, locale, version_style)
            assert page.locator('.footer-version').inner_text().startswith('DEAS v')
            assert page.locator('.studio-shell').evaluate("e=>getComputedStyle(e).paddingLeft") == '3px'
            assert page.locator('.studio-shell').evaluate("e=>getComputedStyle(e).paddingRight") == '3px'
            assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), (width, locale, 'overflow')
            if width >= 1024:
                assert not page.evaluate('document.documentElement.scrollHeight > innerHeight+1'), (width, locale, 'vertical overflow')
                box = page.locator('[data-workbench]').bounding_box()
                assert 956 <= box['y']+box['height'] <= 958, (width, locale, 'unused bottom', box)
            results.append({'width': width, 'locale': locale, 'stage': page.locator('.wb-stage').bounding_box()})
        page.locator('[data-node="settings"]').click()
        page.locator('#language-select').select_option('en')
        page.locator('[data-node="studio"]').click()
        if width == 1440:
            page.screenshot(path=str(OUT/'studio.png'), full_page=True)
            page.locator('[data-dock-tab="models"]').click()
            page.locator('[data-run-load]').click()
            page.locator('[data-run-checkpoint] button').first.wait_for()
            page.locator('[data-dock-tab="media"]').click()
            page.locator('.media-list button[data-kind="file"]').first.click()
            expect(page.locator('[data-browsed-preview]')).to_be_visible()
            assert page.locator('[data-editor-viewport]').count() == 0
            assert not page.evaluate("__calls.some(c=>c.command==='native_job_prepare'||c.command==='native_job_submit'||c.command==='native_workbench_run')")
            page.screenshot(path=str(OUT/'preview.png'), full_page=True)
            page.locator('[data-browsed-preview] img').click()
            viewer = page.get_by_role('dialog', name='DEAS_0001.png', exact=True)
            expect(viewer).to_be_visible()
            image = viewer.locator('img')
            page.wait_for_function("()=>{const e=document.querySelector('.wb-viewer img'),b=document.querySelector('.wb-viewer-box').getBoundingClientRect(),r=e.getBoundingClientRect();return r.width<=b.width+1&&r.height<=b.height+1&&(Math.abs(r.width-b.width)<1||Math.abs(r.height-b.height)<1);}")
            assert viewer.locator('.wb-viewer-box').evaluate("e=>getComputedStyle(e).backgroundImage") == 'none'
            assert viewer.evaluate("e=>{const c=getComputedStyle(e).backgroundColor,a=Number(c.slice(c.lastIndexOf(',')+1,-1));return a>0&&a<1;}")
            page.screenshot(path=str(OUT/'viewer-edge-fit.png'))
            before = image.evaluate('e=>e.style.transform')
            viewer.locator('.wb-viewer-box').hover()
            page.mouse.wheel(0, -250)
            expect(image).not_to_have_css('transform', 'none')
            page.wait_for_function('(old)=>document.querySelector(".wb-viewer img").style.transform!==old', arg=before)
            viewer.get_by_role('button', name='Fit', exact=True).click()
            viewer.locator('.wb-viewer-box').click(position={'x': 1, 'y': 1})
            expect(viewer).not_to_be_visible()
            page.locator('[data-browsed-preview] [data-edit="inpaint"]').click()
            base = page.locator('[data-layer="base"]')
            base.wait_for()
            page.get_by_role('button', name='Select', exact=True).click()
            base.focus()
            base.press('ArrowLeft')
            assert base.evaluate('e=>e.style.left') == '-8px'
            assert page.locator('[data-source-frame]').evaluate('e=>getComputedStyle(e).outlineStyle') == 'dashed'
            page.screenshot(path=str(OUT/'frame-moved.png'), full_page=True)
            page.locator('[data-image-restore]').click()
            assert base.evaluate('e=>[e.style.left,e.style.top,e.style.width,e.style.height]') == ['0px','0px','1024px','640px']
            page.screenshot(path=str(OUT/'frame-restored.png'), full_page=True)
            page.locator('[data-node="settings"]').click()
            expect(page.get_by_role('region', name='Provider authorization', exact=True)).to_be_visible()
            assert page.get_by_role('button', name='Provider authorization', exact=True).count() == 0
            assert page.get_by_role('button', name='Settings', exact=True).count() == 0
            assert page.get_by_role('button', name='AiO installer', exact=True).count() == 0
            expect(page.locator('.backend-overview')).to_be_visible()
            page.screenshot(path=str(OUT/'backend-inline.png'), full_page=True)
        assert not errors, errors
        page.close()
    reopen_module = ast.parse((ROOT/'tools/verify_reopen.py').read_text())
    reopen = next(ast.literal_eval(n.value) for n in reopen_module.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'fixture' for t in n.targets))
    reopen = reopen.replace("throw Error('Unexpected IPC '+c);", "if(c==='native_auth_status')return ['huggingface','civitai','github'].map(providerId=>({providerId,configured:true,persisted:true}));if(c==='native_auth_verify')return {providerId:a.providerId,status:'unavailable'};if(c==='native_repo_stars')return {count:0,starred:null};throw Error('Unexpected IPC '+c);")
    reopen = reopen.replace("if(c==='native_backend_start')window.__RUNNING__=true;", "if(c==='native_backend_start'){window.__RUNNING__=true;window.__FOOTER_STATE__='starting';}")
    reopen = reopen.replace("state:window.__RUNNING__?'running':'stopped'", "state:window.__RUNNING__?window.__FOOTER_STATE__:'stopped'")
    page = browser.new_page(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
    page.add_init_script(reopen)
    page.goto(URL, wait_until='networkidle')
    page.wait_for_function("__CALLS__.some(c=>c.command==='native_backend_start')")
    page.locator('[data-node="settings"]').click()
    expect(page.get_by_role('region', name='Owned backend', exact=True)).to_be_visible()
    expect(page.locator('[data-backend-installed]')).to_have_class('is-set')
    expect(page.locator('[data-provider-configured]')).to_have_count(3)
    # Configured marks must not masquerade as successful identity verification.
    expect(page.locator('.auth-verified')).to_have_count(0)
    notice = page.locator('[data-backend-notice]')
    expect(notice).to_have_text('Backend starting…')
    page.wait_for_timeout(3200)
    expect(notice).to_have_text('Backend starting…')
    page.emulate_media(reduced_motion='no-preference')
    page.evaluate("window.__FOOTER_STATE__='running'")
    expect(notice).to_have_class('footer-backend is-ready')
    expect(notice).to_contain_text('✓')
    assert notice.evaluate("e=>getComputedStyle(e).animationName") == 'backend-ready-glow'
    assert notice.evaluate("e=>getComputedStyle(e).animationIterationCount") == '1'
    page.wait_for_function("()=>Number(getComputedStyle(document.querySelector('[data-backend-notice]')).opacity)>.8")
    page.screenshot(path=str(OUT/'backend-ready.png'), full_page=True)
    expect(notice).to_have_count(0, timeout=5000)
    page.screenshot(path=str(OUT/'backend-installed.png'), full_page=True)
    # Retain each real panel's draft, with one shared frame and no writes on selection.
    calls_before = page.evaluate('__CALLS__.length')
    page.locator('[data-backend-panel="startup"]').click()
    page.get_by_role('button', name='Compatibility', exact=True).click()
    page.locator('[data-backend-panel="llm"]').click()
    page.get_by_role('combobox', name='Provider', exact=True).select_option('openai')
    page.get_by_role('textbox', name='Endpoint URL', exact=True).fill('https://draft.invalid/v1')
    page.locator('[data-backend-panel="auth"]').click()
    page.get_by_label('Token', exact=True).fill('draft-only-not-a-credential')
    for width in (1440, 1024, 768, 390, 320):
        page.set_viewport_size({'width': width, 'height': 960})
        for locale in ('de', 'en', 'fr', 'ja', 'tr', 'zh'):
            page.locator('#language-select').select_option(locale)
            styles = []
            for name in ('startup', 'llm', 'auth'):
                page.locator('[data-backend-panel="'+name+'"]').click()
                pane = page.get_by_role('tabpanel')
                expect(pane).to_have_count(1)
                menu_box = page.locator('.backend-panel-menu').bounding_box()
                pane_box = pane.bounding_box()
                if width <= 480:
                    assert menu_box['y']+menu_box['height'] <= pane_box['y'], (width, locale, name, 'menu not above narrow pane')
                else:
                    assert menu_box['x']+menu_box['width'] <= pane_box['x'], (width, locale, name, 'menu not left')
                assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), (width, locale, name, 'overflow')
                assert pane.evaluate('e=>e.scrollWidth<=e.clientWidth'), (width, locale, name, 'clipped panel')
                styles.append(pane.evaluate("e=>{const s=getComputedStyle(e),h=getComputedStyle(e.querySelector('h3'));return [s.padding,s.backgroundColor,s.borderRadius,s.borderColor,h.fontSize];}"))
                if width == 1440 and locale == 'en':
                    page.screenshot(path=str(OUT/('backend-'+name+'.png')), full_page=True)
            assert styles[0] == styles[1] == styles[2], (width, locale, 'different pane styling', styles)
    page.locator('#language-select').select_option('en')
    page.locator('[data-backend-panel="startup"]').click()
    expect(page.get_by_role('button', name='Compatibility', exact=True)).to_have_attribute('aria-pressed', 'true')
    page.locator('[data-backend-panel="llm"]').click()
    expect(page.get_by_role('textbox', name='Endpoint URL', exact=True)).to_have_value('https://draft.invalid/v1')
    page.locator('[data-backend-panel="auth"]').click()
    expect(page.get_by_label('Token', exact=True)).to_have_value('draft-only-not-a-credential')
    blocked = ['native_startup_write', 'native_llm_write', 'native_llm_generate', 'native_auth_set', 'native_auth_remove', 'native_auth_restore', 'native_backend_start', 'native_backend_stop', 'native_backend_restart', 'native_install_start']
    assert not any(c['command'] in blocked for c in page.evaluate('__CALLS__')[calls_before:]), 'selection must not execute/save'
    page.close()
    for pending in (False, True):
        page = browser.new_page(viewport={'width': 1440, 'height': 960}, reduced_motion='reduce')
        updates = json.dumps({'app': 'v999.0.0' if pending else None, 'comfy': False, 'nodepack': False})
        page.add_init_script(fixture.replace('window.__calls.push({command,args});', 'window.__calls.push({command,args});' + "if(command==='native_update_check') return " + updates + ';'))
        page.goto(URL, wait_until='networkidle')
        page.locator('[data-node="studio"]').click()
        version = page.locator('.footer-version')
        assert version.evaluate("e=>e.classList.contains('is-update')") == pending
        style = version.evaluate("e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {appearance:s.appearance,border:s.borderTopWidth,background:s.backgroundColor,height:r.height,width:r.width}}")
        assert style['appearance'] == 'none' and style['border'] == '0px' and style['background'] == 'rgba(0, 0, 0, 0)' and style['height'] <= 14 and style['width'] < 150, (pending, style)
        version.click()
        expect(page.locator('[data-node="settings"]')).to_have_attribute('aria-selected', 'true')
        expect(page.get_by_role('alertdialog')).to_be_visible()
        assert not any(c['command'] in ('native_app_update', 'native_app_restart', 'native_install_update') for c in page.evaluate('window.__calls'))
        page.close()
    browser.close()
(OUT/'results.json').write_text(json.dumps(results, indent=2))
print(f'PASS: 30 locale/width layouts, 30 three-panel sidebar layouts, retained drafts, transparent footer/start notice, edge-fit backdrop/zoom and frame restore; evidence {OUT}')
