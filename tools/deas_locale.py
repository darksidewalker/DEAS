"""Language now lives in Settings: switch it there, then return to the view under test."""


def set_locale(page, locale, back=None):
    page.locator('[data-node="settings"]').click()
    page.locator('#language-select').select_option(locale)
    if back:
        page.locator(back).click()
