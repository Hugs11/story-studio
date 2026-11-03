// Geste utilisateur : clic sur le stylo de Langue -> l'éditeur s'ouvre -> frappe « it » (sans clic sur la pastille)
// -> la valeur devient Italien ; Entrée sur la pastille fermée remonte à l'éditeur en place, qui enregistre.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { lang: 'jsx', jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
globalThis.document = { body: { nodeType: 1 }, activeElement: null, getElementById: () => null, addEventListener() {}, removeEventListener() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 800, innerHeight: 600 };
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
const { SelectionMetadataControls } = await import('../src/components/Catalogue/selection/SelectionControls.jsx');
const { Select } = await import('../src/components/common/Select.jsx');

function elements(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(elements); return [node, ...elements(node.props?.children)]; }
const cards = [{ id: 'a', ficheRevision: 1, language: 'fr' }, { id: 'b', ficheRevision: 2, language: 'fr' }];

test('ouvrir l’éditeur de langue : la pastille porte autoFocus, la frappe « it » choisit Italien, Entrée enregistre', async () => {
  const mutations = [];
  const app = runner(() => SelectionMetadataControls({ cards, mutate: async mutation => { mutations.push(mutation); return {}; } }));
  try {
    const pencil = elements(app.render()).find(e => e.props?.id === 'catalogue-selection-pencil-language');
    pencil.props.onClick({ currentTarget: { id: pencil.props.id } });
    const shell = () => elements(app.render()).find(e => e.props?.className === 'catalogue-inline-editor');
    const field = elements(shell()).find(e => e.props?.entry?.field === 'language');
    assert.ok(field, 'l’éditeur de langue est ouvert');
    // FieldEditor est un composant : on le déplie pour atteindre la pastille réellement rendue.
    const rendered = runner(() => field.type(field.props)).render();
    const pill = elements(rendered).find(e => e.type === Select);
    assert.equal(pill.props.autoFocus, true, 'la pastille prend le focus à l’ouverture');
    assert.equal(pill.props.variant, 'pill');
    assert.match(rendered.props.className, /catalogue-field-editor--compact/, '✓ ✕ restent collés à la pastille');
    // Frappe sans cliquer la pastille : « i » puis « t » (clavier -> Select fermé).
    let value = pill.props.value;
    const select = runner(() => Select({ ...pill.props, value, onChange: next => { value = next; field.props.onChange({ value: next }); } }));
    const button = () => elements(select.render()).find(e => e.type === 'button');
    button().props.ref.current ??= { focus() {}, getBoundingClientRect: () => ({}) };
    for (const key of ['i', 't']) button().props.onKeyDown({ key, preventDefault() {}, stopPropagation() {} });
    assert.equal(value, 'it');
    // Entrée sur la pastille fermée : non retenue par le Select, enregistrée par l’éditeur en place.
    const enter = { key: 'Enter', preventDefault() {}, stopPropagation() {}, defaultPrevented: false, nativeEvent: {}, target: { tagName: 'BUTTON', getAttribute: name => name === 'role' ? 'combobox' : null } };
    button().props.onKeyDown({ ...enter, preventDefault() { enter.defaultPrevented = true; } });
    assert.equal(enter.defaultPrevented, false, 'le Select laisse passer Entrée');
    elements(app.render()).find(e => e.props?.className === 'catalogue-inline-editor').props.onKeyDown(enter);
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(mutations, [{ kind: 'bulkSetMetadata', ficheIds: ['a', 'b'], expectedFicheRevisions: { a: 1, b: 2 }, changes: { language: { state: 'defined', value: 'it' } } }], 'l’état édité du parent est celui que la pastille a produit');
  } finally { app.unmount(); }
});
