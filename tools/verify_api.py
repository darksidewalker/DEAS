"""Read-only API-panel browser acceptance; no backend requests or mock success."""
from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright
from deas_locale import set_locale

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:1420'
root = Path(__file__).resolve().parents[1]
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for width in (1440, 1024, 768, 390, 320):
        page = browser.new_page(viewport={'width': width, 'height': 960}, reduced_motion='reduce')
        errors, backend_requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: backend_requests.append(request.url) if request.url.startswith(('http://127.0.0.1:7801', 'http://127.0.0.1:8189')) else None)
        page.goto(url, wait_until='networkidle')
        set_locale(page, 'en')
        page.locator('[data-node="studio"]').click()
        page.locator('[data-studio-tab="map"]').click()
        page.locator('.run-plan-diagnostics > summary').click()
        page.get_by_role('button', name='Engine', exact=True).click()
        panel = page.locator('[data-api-negotiation]')
        assert panel.get_by_role('button', name='Check execution API', exact=True).count() == 1
        assert not backend_requests
        panel.get_by_role('button', name='Check execution API', exact=True).click()
        panel.get_by_role('alert').wait_for()
        assert 'desktop app' in panel.get_by_role('alert').inner_text()
        assert not panel.get_by_text('Classic API', exact=True).count()
        page.get_by_label('Backend URL', exact=True).fill('http://127.0.0.1:8189')
        assert panel.get_by_role('alert').count() == 0
        set_locale(page, 'de', '[data-node="studio"]')
        assert panel.get_by_role('button', name='Ausführungs-API prüfen', exact=True).count() == 1
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        assert not backend_requests and not errors
        page.mouse.move(0, 0)
        page.evaluate('document.activeElement?.blur()')
        if width in (1440, 320):
            page.screenshot(path=str(root / 'assets' / f'deas-api-{width}.png'), full_page=True)
        results.append({'width': width, 'explicitAction': True, 'browserFailsClosed': True, 'endpointInvalidation': True, 'localized': True, 'noBackendRequests': True})
        page.close()
    browser.close()
print(json.dumps(results, indent=2))
