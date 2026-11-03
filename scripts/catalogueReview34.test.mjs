import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { beforeFicheAbandon, protectDraft, draftReducer } = await import('../src/store/catalogue/metadataDraft.js');
const { fieldId } = await import('../src/store/catalogue/cardModel.js');
const { LanguageSelect } = await import('../src/components/Catalogue/fiche/LanguageSelect.jsx');
const { Select } = await import('../src/components/common/Select.jsx');
const { editableFields } = await import('../src/store/catalogue/ficheEditing.js');
const { SelectionMetadataControls } = await import('../src/components/Catalogue/selection/SelectionControls.jsx');
function elements(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return [node, ...elements(node.props?.children)];
}
const find = (tree, predicate) => { const found = elements(tree).find(predicate); assert.ok(found); return found; };

test('all exemplar/card leave actions share the dialog guard', async () => {
  const browser = readFileSync(new URL('../src/components/Catalogue/CatalogueBrowser.jsx', import.meta.url), 'utf8');
  assert.match(browser, /beforeFicheAbandon\(ficheAbandon, \(\) => editor.edit/);
  assert.match(browser, /beforeFicheAbandon\(ficheAbandon, \(\) => simulation.simulate/);
  assert.match(browser, /abandonGuard=\{ficheAbandon\}/);
  for (const menu of ['exemplar', 'card']) for (const action of ['simulate', 'edit']) for (const choice of ['stay', 'save', 'discard']) {
    let saved = 0; let opened = 0;
    const draft = { original: { title: { state: 'source', value: '' } }, entries: { title: { state: 'defined', value: 'Draft' } } };
    const guard = { current: () => protectDraft(draft, { ask: async () => choice, save: async () => { saved++; return true; } }) };
    await beforeFicheAbandon(guard, () => { opened++; });
    assert.equal(opened, choice === 'stay' ? 0 : 1, `${menu}/${action}/${choice}`);
    assert.equal(saved, choice === 'save' ? 1 : 0);
  }
});

// FICHEE (29 oct.): the fiche edits its language again, chosen from a list.
test('FICHEE individual language is editable again; the selection panel has no language drop-down (volontaire : la ligne Langue la remplace)', () => {
  const field = { id: 'language', field: 'language', labelKey: 'catalogue:fiche.edit.field.language', effective: {}, correction: {}, originKey: 'catalogue:fiche.edit.origin.none' };
  const card = { fields: [field, { ...field, field: 'title' }] };
  assert.deepEqual(editableFields(card).map(field => field.field), ['title', 'language']);
  const bulk = runner(() => SelectionMetadataControls({ cards: [], mutate() {}, onClose() {} }));
  const tree = bulk.render();
  assert.equal(elements(tree).some(e => e.type === LanguageSelect), false);
  assert.equal(elements(tree).some(e => e.type === 'datalist'), false); bulk.unmount();
});

test('language handlers reserve short-code entry for Other, including a common code typed manually', () => {
  let value = 'fr'; const changes = [];
  const ui = runner(() => LanguageSelect({ value, onChange: next => { value = next; changes.push(next); } }));
  try {
    let tree = ui.render(); assert.equal(elements(tree).some(e => e.type === 'input'), false);
    find(tree, e => e.type === Select).props.onChange('it');
    tree = ui.render(); assert.equal(elements(tree).some(e => e.type === 'input'), false);
    find(tree, e => e.type === Select).props.onChange('custom');
    tree = ui.render(); find(tree, e => e.type === 'input').props.onChange({ target: { value: 'fr' } });
    tree = ui.render(); assert.equal(find(tree, e => e.type === Select).props.value, 'custom');
    assert.equal(find(tree, e => e.type === 'input').props.value, 'fr');
    find(tree, e => e.type === Select).props.onChange('en');
    assert.equal(elements(ui.render()).some(e => e.type === 'input'), false);
    assert.deepEqual(changes, ['it', '', 'fr', 'en']);
  } finally { ui.unmount(); }
});

for (const replacement of ['reload', 'conflict resolution']) {
  test(`language ${replacement} synchronizes external values without remounting or emitting edits`, () => {
    const id = fieldId({ field: 'language' });
    const card = code => ({ ficheId: 'card', fields: [{ field: 'language', correction: { state: 'defined', value: code }, effective: { value: code } }] });
    let draft = draftReducer(null, { type: 'load', card: card(replacement === 'reload' ? 'fr' : 'en') });
    if (replacement !== 'reload') draft = draftReducer(draft, { type: 'edit', id, patch: { value: 'fr' } });
    let value = draft.entries[id].value; const changes = [];
    const ui = runner(() => LanguageSelect({ value, onChange: next => { value = next; changes.push(next); } }));
    try {
      let tree = ui.render();
      assert.equal(find(tree, e => e.type === Select).props.value, 'fr');
      draft = draftReducer(draft, { type: 'load', card: card('deu') });
      if (replacement !== 'reload') {
        assert.ok(draft.conflicts[id]);
        assert.equal(draft.entries[id].value, 'fr', 'reload preserves the local conflicting draft');
        draft = draftReducer(draft, { type: 'conflict', id, keep: 'server' });
        assert.deepEqual(draft.conflicts, {});
      }
      value = draft.entries[id].value;
      tree = ui.render();
      assert.equal(find(tree, e => e.type === Select).props.value, 'custom');
      assert.equal(find(tree, e => e.type === 'input').props.value, 'deu');
      // A second render must retain the synchronization.
      tree = ui.render();
      assert.equal(find(tree, e => e.type === 'input').props.value, 'deu');
      value = 'it';
      tree = ui.render();
      assert.equal(find(tree, e => e.type === Select).props.value, 'it');
      assert.equal(elements(tree).some(e => e.type === 'input'), false);
      assert.deepEqual(changes, [], 'external replacements must not dirty the draft');
      find(tree, e => e.type === Select).props.onChange('custom');
      tree = ui.render();
      find(tree, e => e.type === 'input').props.onChange({ target: { value: 'fr' } });
      tree = ui.render();
      assert.equal(find(tree, e => e.type === Select).props.value, 'custom');
      assert.equal(find(tree, e => e.type === 'input').props.value, 'fr');
      value = 'de';
      tree = ui.render();
      assert.equal(find(tree, e => e.type === Select).props.value, 'de');
      assert.equal(elements(tree).some(e => e.type === 'input'), false);
      value = 'fr';
      tree = ui.render();
      assert.equal(find(tree, e => e.type === Select).props.value, 'fr');
      assert.equal(elements(tree).some(e => e.type === 'input'), false, 'a former local value does not resurrect custom mode');
      assert.deepEqual(changes, ['', 'fr']);
    } finally { ui.unmount(); }
  });
}
