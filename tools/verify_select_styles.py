"""Verify shared dropdown CSS in Chromium; no app/backend execution.
Run: uv run --no-project --with playwright python tools/verify_select_styles.py
"""
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
# Real selector contexts, including compound rules that previously overrode the shared skin.
CONTEXTS = {
    'settings': '<div class="wb-settings"><label class="wb-field">{}</label></div>',
    'forge': '<label class="forge-field">{}</label>',
    'forge-cast': '<label class="forge-field forge-cast-pick">{}</label>',
    'forge-reference': '<div class="forge-refcard-body"><label class="forge-field">{}</label></div>',
    'forge-layout': '<div class="forge-layout-inspector"><label class="forge-field">{}</label></div>',
    'chat': '<div class="chat-model"><label class="forge-field">{}</label></div>',
    'library': '<div class="download-controls"><label>{}</label></div>',
    'library-source': '<div class="download-controls"><label class="download-source">{}</label></div>',
    'wildcards': '<div class="wildcard-toolbar"><label>{}</label></div>',
    'presets': '<div class="preset-controls"><label>{}</label></div>',
    'options-post': '<label class="wb-option">{}</label>',
    'options-grid': '<div class="wb-option"><div class="wb-option-grid"><label>{}</label></div></div>',
    'backend': '<div class="aio-setup"><div class="backend-panels"><label class="startup-field">{}</label></div></div>',
    'installer': '<div class="aio-setup"><div class="aio-auto-review"><div class="aio-auto-fields">{}</div></div></div>',
    'media': '<div class="media-depth">{}</div>',
    'references': '<div class="wb-ref">{}</div>',
    'future-tab': '<div>{}</div>',
}
PROPS = ['height', 'fontSize', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
         'borderRadius', 'borderTopColor', 'backgroundColor', 'backgroundImage', 'color',
         'appearance', 'lineHeight', 'textTransform', 'letterSpacing']
read_style = '(el, props) => Object.fromEntries(props.map(k => [k, getComputedStyle(el)[k]]))'
base = (ROOT/'src/styles.css').read_text()
themes = (ROOT/'src/themes.css').read_text()
features = '\n'.join(p.read_text() for p in sorted((ROOT/'src').rglob('*.css')) if p.name not in ('styles.css', 'themes.css'))
ids = ['default'] + re.findall(r':root\[data-theme="([^"]+)"\]', themes)
html = ''.join('<section style="min-width:0;max-width:280px"><h3>'+name+'</h3>'+wrapper.format(
    '<select aria-label="'+name+'"><option>Model / preset</option><option disabled>Unavailable</option><option>Other</option></select>')+'</section>' for name, wrapper in CONTEXTS.items())
cases = 0
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    # Check both import orders: lazy-loaded feature CSS must not change the skin.
    for css in (base + themes + features, features + base + themes):
        page.set_content('<style>'+css+'</style><main style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;padding:12px">'+html+'</main>')
        for width in (360, 1280):
            page.set_viewport_size({'width': width, 'height': 960})
            for theme in ids:
                page.evaluate('(id)=>document.documentElement.dataset.theme=id', theme)
                page.mouse.move(0, 0)
                reference = page.get_by_label('future-tab').evaluate(read_style, PROPS)
                for name in CONTEXTS:
                    control = page.get_by_label(name, exact=True)
                    actual = control.evaluate(read_style, PROPS)
                    assert actual == reference, (width, theme, name, actual, reference)
                    assert actual['appearance'] == 'none', (theme, name, 'native appearance')
                    assert actual['paddingRight'] != '0px' and actual['backgroundImage'] != 'none'
                    assert control.evaluate('el=>el.getBoundingClientRect().right<=el.closest("section").getBoundingClientRect().right+1'), (theme, name, 'overflow')
                    cases += 1
        # Theme changes reach fields, options and the arrow without remounting.
        for theme in ('alluring-abyss', 'android-white'):
            page.evaluate('(id)=>document.documentElement.dataset.theme=id', theme)
            control = page.get_by_label('future-tab')
            option = control.locator('option').first
            assert option.evaluate('(el)=>getComputedStyle(el).backgroundColor') == control.evaluate('(el)=>getComputedStyle(el).backgroundColor')
            control.focus()
            assert control.evaluate('(el)=>el.matches(":focus-visible") && getComputedStyle(el).outlineStyle!=="none"')
            control.press('ArrowDown')
            control.press('Enter')
            assert control.input_value() == 'Other'
            page.mouse.move(0, 0)
            control.hover()
            assert control.evaluate('(el)=>getComputedStyle(el).borderTopColor') == page.evaluate('()=>{const el=document.createElement("span");el.style.color="var(--blue)";document.body.append(el);const color=getComputedStyle(el).color;el.remove();return color;}')
            control.evaluate('(el)=>el.disabled=true')
            assert control.is_disabled()
            assert control.evaluate('(el)=>getComputedStyle(el).cursor') == 'not-allowed'
            control.evaluate('(el)=>el.disabled=false')
        page.emulate_media(forced_colors='active')
        assert page.get_by_label('future-tab').evaluate('(el)=>getComputedStyle(el).appearance') == 'auto'
        page.emulate_media(forced_colors='none')
    browser.close()
print(f'PASS: {cases} dropdown context/theme/width/import-order cases; keyboard selection, focus, disabled and forced-colour checks.')
