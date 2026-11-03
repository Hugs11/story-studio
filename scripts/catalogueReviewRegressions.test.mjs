import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { focusCatalogueSearch } from '../src/store/catalogue/searchFocus.js';
import { filterScanAdditions, loadScanAdditions } from '../src/store/catalogue/scanAdditions.js';
import { filterStateReducer, initialFilterState } from '../src/store/catalogue/filterState.js';

test('workspace object properties all reach WorkspaceView through AppShell', () => {
  const ast = path => parse(readFileSync(path, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
  const visit = (node, fn) => {
    if (!node || typeof node !== 'object') return;
    if (node.type) fn(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, fn));
      else if (value && typeof value === 'object') visit(value, fn);
    }
  };
  const keys = new Set();
  visit(ast('src/App.jsx'), node => {
    if (node.type === 'ObjectProperty' && node.key.name === 'workspace' && node.value.type === 'ObjectExpression') {
      for (const property of node.value.properties) keys.add(property.key.name);
    }
  });
  assert.ok(keys.size > 20);
  let forwarded;
  visit(ast('src/components/AppShell.jsx'), node => {
    if (node.type !== 'JSXOpeningElement' || node.name.name !== 'WorkspaceView') return;
    forwarded = new Set();
    for (const attr of node.attributes) {
      if (attr.type === 'JSXSpreadAttribute' && attr.argument.name === 'workspace') { forwarded = new Set(keys); break; }
      const expression = attr.value?.expression;
      if (expression?.type === 'MemberExpression' && expression.object.name === 'workspace' && attr.name.name === expression.property.name) forwarded.add(expression.property.name);
    }
  });
  assert.deepEqual([...keys].filter(key => !forwarded?.has(key)), []);
});

test('search shortcut opens collapsed disclosure before scheduling focus', () => {
  const details = { open: false };
  let focused = false, frame;
  const input = { isConnected: true, closest: selector => { assert.equal(selector, 'details'); return details; }, focus: () => { assert.equal(details.open, true); focused = true; } };
  focusCatalogueSearch(input, callback => { frame = callback; });
  assert.equal(details.open, true);
  assert.equal(focused, false);
  frame();
  assert.equal(focused, true);
  const browser = readFileSync('src/components/Catalogue/CatalogueBrowser.jsx', 'utf8');
  assert.match(browser, /search: \(\) => focusCatalogueSearch\(searchRef.current\)/);
});

test('additions retain report targets while listAllEntries is delayed', async () => {
  const report = await loadScanAdditions({ getOperation: async () => ({ items: [{ path: '/new.zip', outcome: 'indexedNew' }], cursor: null }) }, 'scan');
  const state = filterStateReducer(initialFilterState(), { type: 'additions', report });
  let release;
  const api = { listAllEntries: () => new Promise(resolve => { release = resolve; }) };
  const pending = api.listAllEntries();
  assert.deepEqual(filterScanAdditions([], state.additions), []);
  release([{ id: 'new', exemplars: [{ path: '/new.zip' }] }]);
  assert.deepEqual(filterScanAdditions(await pending, state.additions).map(card => card.id), ['new']);
});

test('catalogue and home receive the same project context for voice generation', () => {
  const ast = parse(readFileSync('src/App.jsx', 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
  let catalogueContext;
  let shellContext;
  function visit(node, context) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXElement') {
      const opening = node.openingElement;
      if (opening.name.type === 'JSXMemberExpression' && opening.name.object.name === 'ProjectContext' && opening.name.property.name === 'Provider') {
        context = opening.attributes.find(attr => attr.name?.name === 'value')?.value?.expression?.name;
      }
      if (opening.name.name === 'CatalogueScreen') catalogueContext = context;
    }
    if (node.type === 'ObjectProperty' && node.key.name === 'projectContextValue') shellContext = node.value.name;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, context));
      else if (value && typeof value === 'object') visit(value, context);
    }
  }
  visit(ast);
  assert.equal(shellContext, 'projectContextValue');
  assert.equal(catalogueContext, shellContext);
});

test('native startup keeps plugin registration and shared cleanup in their guarded adapters', () => {
  const source = readFileSync('src-tauri/src/lib.rs', 'utf8');
  const region = (start, end) => {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing startup boundary: ${start}`);
    return source.slice(from, to);
  };
  const logging = region('fn prepare_logging', 'fn initialize_resources');
  const builder = region('fn startup_builder', '/// Shared setup ordering');
  const nativeWriter = region('impl StartupWriterWork for NativeStartupWriter', 'fn writer_startup');
  assert.match(builder, /builder\s*\.plugin\(single_instance\)/);
  assert.doesNotMatch(builder, /log_plugin_builder|prepare_logging|tauri_plugin_log|build_log_plugin/);
  // Runtime tests exercise the shared orchestration. These boundaries also catch
  // a direct native call reintroduced in run(), outside that orchestration.
  assert.doesNotMatch(source.replace(logging, '').replace(builder, ''), /\.plugin\(/);
  const outsideWriter = source.replace(nativeWriter, '');
  assert.doesNotMatch(outsideWriter, /services::catalogue::(?:open::clean_at_startup|start_watching)\(/);
  assert.doesNotMatch(outsideWriter, /spawn\(cleanup_temp_images\)|move \|\| cleanup_application_cache\(/);
});
