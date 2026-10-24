import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { assertCatalogValid, createCatalog, translate, validateLanguageManifest } from '../src/lib/i18n.ts';

const manifests = {
  '/src/languages/de/manifest.json': { id: 'de', name: 'Deutsch', kind: 'language', version: 1 },
  '/src/languages/en/manifest.json': { id: 'en', name: 'English', kind: 'language', version: 1 },
};

test('decentralized dictionaries merge by locale and resolve flat dotted keys', () => {
  const catalog = createCatalog(manifests, {
    '/src/components/setup/locales/de.json': { 'setup.title': 'Einrichtung' },
    '/src/components/setup/locales/en.json': { 'setup.title': 'Setup' },
    '/src/locales/de.json': { 'app.title': 'Studio' },
    '/src/locales/en.json': { 'app.title': 'Studio' },
  });
  assert.deepEqual(catalog.languages.map(({ id }) => id), ['de', 'en']);
  assert.equal(translate(catalog, 'de', 'setup.title'), 'Einrichtung');
  assert.equal(translate(catalog, 'en', 'setup.title'), 'Setup');
  assert.equal(translate(catalog, 'de', 'app.title'), 'Studio');
  assert.deepEqual(catalog.diagnostics, []);
});

test('fallback uses English then literal key and interpolation is exact and single-pass', () => {
  const catalog = createCatalog(manifests, {
    '/src/locales/de.json': { 'app.empty': '' },
    '/src/locales/en.json': { 'app.message': 'Hello {name}: {count}; {missing}; {constructor}', 'app.empty': 'Not empty' },
  });
  assert.equal(translate(catalog, 'de', 'app.message', { name: '{count}', count: 0 }), 'Hello {count}: 0; {missing}; {constructor}');
  assert.equal(translate(catalog, 'unknown', 'app.message', { name: '$&', count: 2 }), 'Hello $&: 2; {missing}; {constructor}');
  assert.equal(translate(catalog, 'de', 'app.empty'), '');
  assert.equal(translate(catalog, 'de', 'unknown.key'), 'unknown.key');
});

test('language manifests are data-only, bounded and reject executable or malformed fields', () => {
  assert.equal(validateLanguageManifest(manifests['/src/languages/de/manifest.json']).id, 'de');
  for (const value of [null, [], { id: '../de', name: 'Deutsch', kind: 'language', version: 1 },
    { id: 'de', name: '', kind: 'language', version: 1 },
    { id: 'de', name: 'Deutsch', kind: 'language', version: 2 },
    { id: 'de', name: 'Deutsch', kind: 'language', version: 1, script: 'evil.js' }]) {
    assert.throws(() => validateLanguageManifest(value), /manifest/i);
  }
});

test('bad dictionaries and duplicate keys are diagnosed without crashing resolution', () => {
  const catalog = createCatalog({ ...manifests,
    '/src/languages/copy/manifest.json': manifests['/src/languages/de/manifest.json'],
    '/src/languages/bad/manifest.json': { id: 'bad', name: '', kind: 'language', version: 1 },
  }, {
    '/src/a/locales/en.json': { 'app.title': 'First', 'app.bad': 42, '__proto__': 'bad' },
    '/src/b/locales/en.json': { 'app.title': 'Second', 'app.extra': 'English only' },
    '/src/a/locales/de.json': { 'app.title': 'Deutsch' },
    '/src/a/locales/fr.json': { 'app.title': 'Unregistered' },
  });
  assert.equal(translate(catalog, 'en', 'app.title'), 'First');
  assert.equal(translate(catalog, 'de', 'app.bad'), 'app.bad');
  assert.ok(catalog.diagnostics.some((message) => /Duplicate language/.test(message)));
  assert.ok(catalog.diagnostics.some((message) => /Duplicate translation/.test(message)));
  assert.ok(catalog.diagnostics.some((message) => /Invalid translation/.test(message)));
  assert.ok(catalog.diagnostics.some((message) => /Missing translation.*app.extra/.test(message)));
  assert.ok(catalog.diagnostics.some((message) => /Unregistered locale/.test(message)));
  assert.throws(() => assertCatalogValid(catalog), /Invalid localization catalog/);
});

test('all six bundled component-owned languages have strict key and placeholder parity', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../src');
  const bundledManifests: Record<string, unknown> = {};
  const bundledModules: Record<string, unknown> = {};
  const sourceFiles: string[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        const source = '/src/' + relative(root, path).replaceAll('\\', '/');
        if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) sourceFiles.push(path);
        if (/^\/src\/languages\/[^/]+\/manifest\.json$/.test(source)) {
          bundledManifests[source] = JSON.parse(readFileSync(path, 'utf8'));
        } else if (/\/locales\/[^/]+\.json$/.test(source)) {
          bundledModules[source] = JSON.parse(readFileSync(path, 'utf8'));
        }
      }
    }
  }
  visit(root);
  const catalog = createCatalog(bundledManifests, bundledModules);
  assert.deepEqual(catalog.languages.map(({ id }) => id), ['de', 'en', 'fr', 'ja', 'tr', 'zh']);
  const nativeNames: Record<string,string>={de:'Deutsch',en:'English',fr:'Français',ja:'日本語',tr:'Türkçe',zh:'中文'};
  for(const language of catalog.languages) assert.equal(language.name,nativeNames[language.id]);
  assertCatalogValid(catalog);
  const placeholders=(text:string)=>[...text.matchAll(/\{([^{}]+)\}/g)].map(match=>match[1]).sort();
  for(const {id} of catalog.languages) for(const [key,text] of Object.entries(catalog.dictionaries.en)) {
    assert.deepEqual(placeholders(catalog.dictionaries[id][key]),placeholders(text),`Placeholder mismatch ${id}:${key}`);
    assert.ok(catalog.dictionaries[id][key].trim(),`Empty translation ${id}:${key}`);
  }
  for (const path of sourceFiles) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function check(node: ts.Node) {
      const parent=node.parent;
      // Preference identifiers can also live in explicitly named key lists, not only hook arguments.
      const preferenceList=!!parent&&ts.isArrayLiteralExpression(parent)&&ts.isVariableDeclaration(parent.parent)&&ts.isIdentifier(parent.parent.name)&&/PreferenceKeys$/.test(parent.parent.name.text);
      const contextPreference=path.replaceAll('\\','/').endsWith('/lib/chat.ts')&&!!parent&&ts.isCallExpression(parent)&&ts.isIdentifier(parent.expression)&&['s','n'].includes(parent.expression.text)&&parent.arguments[0]===node;
      const preferenceKey=contextPreference||preferenceList||(!!parent&&ts.isCallExpression(parent)&&ts.isIdentifier(parent.expression)&&['usePref','readPref','writePref','forgetPref'].includes(parent.expression.text)&&parent.arguments[0]===node);
      if (ts.isStringLiteral(node) && !preferenceKey && /^(app|setup|studio|neural|installer|downloads|api|projects)\./.test(node.text)) {
        const exists=node.text.endsWith('.')?Object.keys(catalog.dictionaries.en).some(key=>key.startsWith(node.text)):Object.hasOwn(catalog.dictionaries.en,node.text);
        assert.ok(exists, `Missing referenced UI key or prefix ${node.text} in ${path}`);
      }
      if (ts.isJsxText(node)) assert.ok(!/[\p{L}\p{N}]/u.test(node.text.replaceAll('&nbsp;', ' ')), `Unreferenced JSX text in ${path}: ${node.text}`);
      if (ts.isJsxAttribute(node) && ['aria-label', 'title', 'placeholder'].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) {
        const attribute = node.name.getText(source);
        // URLs, shortcut notation and literal model-input examples are not UI prose.
        const urlExample = attribute === 'placeholder' && /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?\/?$/.test(node.initializer.text);
        const shortcut = attribute === 'title' && /^Ctrl\+[ZY]$/.test(node.initializer.text);
        const modelExample = attribute === 'placeholder' && path.replaceAll('\\', '/').endsWith('/features/forge/LayoutStudio.tsx') && node.initializer.text === 'comic, 3d render';
        assert.ok(urlExample || shortcut || modelExample, `Unreferenced ${attribute} in ${path}`);
      }
      ts.forEachChild(node, check);
    }
    check(source);
  }
});
