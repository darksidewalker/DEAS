# Data-only UX language plugins

## Bundled language set

The selector displays each native name with its ISO 639-1 code: **Deutsch (de), English (en), Français (fr), 日本語 (ja), Türkçe (tr), 中文 (zh)**. Chinese uses Simplified Chinese UI translations under the generic language code `zh`; Japanese uses its native script. Selector suffixes are derived from stable locale IDs rather than translated text. No transliteration is used for the native names.

## Layout

Each language declares its identity in `src/languages/<locale>/manifest.json`:

```json
{"id":"de","name":"Deutsch","kind":"language","version":1}
```

A manifest accepts only these fields. Executable entrypoints, scripts and unknown fields are rejected. Languages are bundled data plugins, not arbitrary executable extensions. A downloadable language-pack installation UI is not implemented yet.

Each owning UI module keeps its texts beside its code:

- `src/locales/{de,en,fr,ja,tr,zh}.json`: application chrome.
- `src/components/setup/locales/{de,en,fr,ja,tr,zh}.json`: setup menus, choices, notices and installer step labels.
- `src/components/neural/locales/{de,en,fr,ja,tr,zh}.json`: graph labels and Suggested legend.
- `src/features/studio/locales/{de,en,fr,ja,tr,zh}.json`: creative workspace and feature metadata.
- `src/features/downloads/locales/{de,en,fr,ja,tr,zh}.json`: separate optional resource/authentication plugins.

Files are flat string-only dictionaries, with namespaced keys such as `setup.prepare`. Keep backend enum values, feature IDs, references, paths, saved choices and graph IDs language-independent.

## Referencing

Components use `useI18n()` and render `t('setup.prepare')` rather than literal menu text. Parameter values use `t('studio.closeNamed', {name: featureName})`. Interpolation is exact and single-pass; strings are rendered through React, not HTML injection.

The provider discovers bundled manifests and module-owned dictionaries through Vite eager JSON globs. The pure resolver is independent of Vite/browser globals for Node tests. German is the default; only a validated locale ID is persisted under `deas.locale.v1`. Storage denial does not prevent switching languages. `document.documentElement.lang` follows the selected language.

Fallback order is requested language, English, then the original key. Duplicate/invalid entries generate diagnostics; bundled dictionaries must pass strict global key parity tests. Do not rely on fallback to ship incomplete bundled translations.

## Adding a language or module

1. Add the data-only language manifest.
2. Add its dictionary to every owning module's `locales` folder.
3. Translate all keys, retaining interpolation parameters and stable IDs.
4. Run `npm run typecheck`, `npm test` and `npm run build`.
5. Switch language on an existing setup draft and ensure feature selections and native plan meaning do not change.

Adding a module requires matching dictionaries for every bundled language and stable namespaced references. Do not copy app-wide dictionaries into each module or add a second translation resolver.

## Technical output boundary

All static user-facing UI text, accessibility labels, menu choices and metadata are referenced. Native raw logs, exception details, paths and exact JSON plans remain technical output beneath translated headings. They are not rewritten or fabricated. Native diagnostic-code localization is a follow-up; do not claim raw backend output is fully translated.

## Regression checks

`tests/i18n.test.ts` validates all six bundled manifests/native names, dictionary shape, duplicates, fallback, nonempty text, interpolation-placeholder parity and global key parity. It also audits production TypeScript/JSX for missing literal resource keys, unreferenced text and literal accessibility labels/placeholders. Symbol-only visual marks are exempt. Dynamic keys require explicit model/UI tests, not an assumption that the static audit covers them.

`tools/verify_ui.py` checks DE/EN switching, preserved choices and draft persistence at five viewport widths, without making backend requests or installing anything. `tools/verify_languages.py` exercises all six languages at those widths, asserting native selector names/ISO suffixes, selected-choice preservation, locale persistence, translated optional-download controls, browser fail-closed behavior and no horizontal overflow. It does not contact provider/backend services. Translation correctness still benefits from native-speaker review.
