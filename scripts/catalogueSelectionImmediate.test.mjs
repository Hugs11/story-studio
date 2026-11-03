import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import { selectionTagCounts, selectionTagMutation, selectionSummary, showSelectionBar, selectionFieldValue } from '../src/store/catalogue/selectionPresentation.js';
import { AGE_PRESETS } from '../src/store/catalogue/ageFilter.js';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { SelectionMetadataControls } = await import('../src/components/Catalogue/selection/SelectionControls.jsx');
const { LanguageSelect } = await import('../src/components/Catalogue/fiche/LanguageSelect.jsx');
const { FieldEditor } = await import('../src/components/Catalogue/fiche/FieldEditor.jsx');
const { Button } = await import('../src/components/common/Button.jsx');
function elements(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(elements); return [node, ...elements(node.props?.children)]; }
const cards = [{ id: 'a', ficheRevision: 4, age: { min: 3 }, language: 'fr', tagIds: ['full', 'part'], durationSeconds: 3600 }, { id: 'b', ficheRevision: 9, age: { min: 7 }, language: 'it', tags: [{ id: 'full' }] }];
test('partial tag applies to all, full tag removes from all; known duration and minimum ages only', () => {
  const [full, part] = selectionTagCounts(cards, [{ id: 'full' }, { id: 'part' }, { id: 'none' }]);
  assert.equal(full.count, 2); assert.equal(part.count, 1);
  assert.deepEqual(selectionTagMutation(cards, part), { kind: 'changeTags', ficheIds: ['a', 'b'], addLabels: [], addTagIds: ['part'], removeTagIds: [] });
  assert.deepEqual(selectionTagMutation(cards, full), { kind: 'changeTags', ficheIds: ['a', 'b'], addLabels: [], addTagIds: [], removeTagIds: ['full'] });
  assert.deepEqual(selectionSummary(cards), { duration: 3600, min: 3, max: 7 });
  assert.deepEqual(selectionSummary([{}]), { duration: null, min: null, max: null });
});
test('floating bar needs an explicitly hidden panel and at least two targets', () => {
  for (const visible of [true, false, undefined]) for (const count of [0, 1, 2, 12]) assert.equal(showSelectionBar(visible, count), visible === false && count >= 2);
});
test('age applies immediately with fiche revisions and partial rejection is exposed; no language drop-down remains', async () => {
  const mutations = [];
  const app = runner(() => SelectionMetadataControls({ cards, mutate: async mutation => { mutations.push(mutation); return { report: { rejected: [{ ficheId: 'b' }] } }; } }));
  try {
    let tree = app.render();
    const age = elements(tree).find(e => e.type === Button && e.props.children === 5);
    age.props.onClick(); await Promise.resolve(); await Promise.resolve();
    tree = app.render();
    assert.ok(elements(tree).some(e => e.props?.role === 'alert'));
    assert.equal(elements(tree).find(e => e.type === LanguageSelect), undefined);
    assert.deepEqual(mutations, [
      { kind: 'bulkSetMetadata', ficheIds: ['a', 'b'], expectedFicheRevisions: { a: 4, b: 9 }, changes: { ageMin: { state: 'defined', value: 5 }, ageMax: { state: 'cleared' } } },
    ]);
  } finally { app.unmount(); }
});

test('information fields: common value, mixed, or missing, for the four fields', () => {
  const some = [{ language: 'fr', author: 'Ana', producer: '', bonus: 'x' }, { language: 'fr', author: 'Bob', producer: ' ', bonus: undefined }, { language: 'fr', author: 'Ana', producer: null }];
  assert.deepEqual(selectionFieldValue(some, 'language'), { kind: 'common', value: 'fr' });
  assert.deepEqual(selectionFieldValue(some, 'author'), { kind: 'mixed' });
  assert.deepEqual(selectionFieldValue(some, 'producer'), { kind: 'missing' });
  assert.deepEqual(selectionFieldValue(some, 'bonus'), { kind: 'mixed' });
});
globalThis.requestAnimationFrame ??= () => 0;
function infoRows(tree) { return elements(tree).filter(e => e.props?.className === 'catalogue-fiche-editable'); }
const infoCards = [{ id: 'a', ficheRevision: 4, language: 'fr', author: 'Ana', producer: 'P', bonus: 'B1' }, { id: 'b', ficheRevision: 9, language: 'fr', author: 'Bob', producer: 'P' }];
function mount(mutations) { return runner(() => SelectionMetadataControls({ cards: infoCards, mutate: async mutation => { mutations.push(mutation); return {}; } })); }
function openField(app, field) {
  const pencil = elements(app.render()).find(e => e.props?.id === `catalogue-selection-pencil-${field}`);
  pencil.props.onClick({ currentTarget: { id: pencil.props.id } });
  const tree = app.render();
  return { tree, editor: elements(tree).find(e => e.type === FieldEditor), shell: elements(tree).find(e => e.props?.className === 'catalogue-inline-editor') };
}
const enter = shell => shell.props.onKeyDown({ key: 'Enter', target: { tagName: 'INPUT' }, preventDefault() {}, nativeEvent: {} });
test('four information rows in the fiche style; an edit applies one batch to every selected fiche', async () => {
  const mutations = []; const app = mount(mutations);
  try {
    assert.equal(infoRows(app.render()).length, 4);
    assert.equal(elements(app.render()).filter(e => e.props?.className === 'catalogue-fiche-fields').length, 1);
    let { editor, shell } = openField(app, 'producer');
    assert.equal(editor.props.entry.value, 'P');
    editor.props.onChange({ state: 'defined', value: ' Studio ' });
    ({ shell } = { shell: elements(app.render()).find(e => e.props?.className === 'catalogue-inline-editor') });
    enter(shell); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(mutations, [{ kind: 'bulkSetMetadata', ficheIds: ['a', 'b'], expectedFicheRevisions: { a: 4, b: 9 }, changes: { producer: { state: 'defined', value: 'Studio' } } }]);
    assert.equal(elements(app.render()).find(e => e.type === FieldEditor), undefined);
  } finally { app.unmount(); }
});
test('mixed field opens empty; validating empty or unchanged applies nothing; Escape cancels', async () => {
  const mutations = []; const app = mount(mutations);
  try {
    let { editor, shell } = openField(app, 'author');
    assert.equal(editor.props.entry.value, '');
    enter(shell); await Promise.resolve();
    ({ shell } = openField(app, 'language')); enter(shell); await Promise.resolve();
    ({ shell, editor } = openField(app, 'bonus')); editor.props.onChange({ state: 'defined', value: 'zz' });
    elements(app.render()).find(e => e.props?.className === 'catalogue-inline-editor').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.equal(elements(app.render()).find(e => e.type === FieldEditor), undefined);
    assert.deepEqual(mutations, []);
    ({ editor } = openField(app, 'language'));
    editor.props.onChange({ state: 'defined', value: 'fr' });
    enter(elements(app.render()).find(e => e.props?.className === 'catalogue-inline-editor')); await Promise.resolve();
    assert.deepEqual(mutations, []);
  } finally { app.unmount(); }
});

test('the "…" age button opens the fiche age editor; the validated age applies to every fiche in one batch', async () => {
  const mutations = []; const app = mount(mutations);
  try {
    const other = () => elements(app.render()).filter(e => e.type === Button && e.props.children === '…');
    assert.equal(other().length, 1);
    assert.ok(other()[0].props['aria-label'], 'accessible name');
    assert.equal(elements(app.render()).filter(e => e.type === Button && AGE_PRESETS.includes(e.props.children)).length, AGE_PRESETS.length);
    other()[0].props.onClick();
    let tree = app.render();
    const editor = elements(tree).find(e => e.type === FieldEditor);
    assert.equal(editor.props.entry.field, 'ageMin');
    assert.equal(editor.props.entry.value, '', 'mixed ages open empty');
    assert.equal(other().length, 0, 'the buttons give way to the editor');
    editor.props.onChange({ state: 'defined', value: '11' });
    enter(elements(app.render()).find(e => e.props?.className === 'catalogue-inline-editor')); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(mutations, [{ kind: 'bulkSetMetadata', ficheIds: ['a', 'b'], expectedFicheRevisions: { a: 4, b: 9 }, changes: { ageMin: { state: 'defined', value: 11 }, ageMax: { state: 'cleared' } } }]);
    assert.equal(elements(app.render()).find(e => e.type === FieldEditor), undefined);
  } finally { app.unmount(); }
});
test('"…" age editor: empty validates nothing, Escape cancels, out-of-range is refused, a common non-preset age prefills', async () => {
  const mutations = []; const app = mount(mutations);
  const shell = () => elements(app.render()).find(e => e.props?.className === 'catalogue-inline-editor');
  const open = () => elements(app.render()).find(e => e.type === Button && e.props.children === '…').props.onClick();
  try {
    open(); enter(shell()); await Promise.resolve(); await Promise.resolve();
    open(); elements(app.render()).find(e => e.type === FieldEditor).props.onChange({ state: 'defined', value: '8' });
    shell().props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    open(); elements(app.render()).find(e => e.type === FieldEditor).props.onChange({ state: 'defined', value: '19' });
    assert.ok(elements(app.render()).find(e => e.type === FieldEditor).props.error);
    enter(shell()); await Promise.resolve();
    assert.deepEqual(mutations, []);
  } finally { app.unmount(); }
  const common = runner(() => SelectionMetadataControls({ cards: [{ id: 'a', ficheRevision: 1, age: { min: 12 } }, { id: 'b', ficheRevision: 2, age: { min: 12 } }], mutate: async () => ({}) }));
  try {
    elements(common.render()).find(e => e.type === Button && e.props.children === '…').props.onClick();
    assert.equal(elements(common.render()).find(e => e.type === FieldEditor).props.entry.value, '12');
  } finally { common.unmount(); }
});
