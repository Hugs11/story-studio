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
const { Plus } = await import('../src/components/icons/LucideLocal.jsx');
const { TagMenuEntries, TagSubmenu } = await import('../src/components/Catalogue/tags/TagSubmenu.jsx');
const { CardTags } = await import('../src/components/Catalogue/tags/CardTags.jsx');
const { CardTagIndicator, fittingTagCount } = await import('../src/components/Catalogue/tags/CardTagIndicator.jsx');
const { FicheSelectionSummary } = await import('../src/components/Catalogue/fiche/SelectionPanel.jsx');
const { CardContextMenu } = await import('../src/components/Catalogue/menus/CardContextMenu.jsx');
const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
const find = (tree, predicate) => { const result = elements(tree).find(predicate); assert.ok(result); return result; };
const tags = [{ id: 'a', label: 'Été' }, { id: 'b', label: 'Bêta' }, { id: 'c', label: 'Contes' }];
const targets = [{ id: '1', tagIds: ['a', 'b'] }, { id: '2', tagIds: ['a'] }];
const key = value => ({ key: value, preventDefault() {}, stopPropagation() {} });
function setup(extra = {}) {
  const mutations = []; const closed = [];
  const hook = runner(() => TagMenuEntries({ tags, targets, busy: false, onMutate: async mutation => { mutations.push(mutation); return true; }, ...extra }));
  return { hook, mutations, closed };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const newEntry = tree => find(tree, e => e.props?.role === 'menuitem');
async function typeAndSubmit(hook, text, expected = 'Enter') {
  newEntry(hook.render()).props.onClick(); hook.render(); hook.flush();
  const tree = hook.render();
  const field = find(tree, e => e.type === 'input');
  field.props.onChange({ target: { value: text } });
  const typed = find(hook.render(), e => e.type === 'input');
  typed.props.onKeyDown({ key: expected, preventDefault() {}, stopPropagation() {} });
  await settle();
}
test('submenu: three states and grouped add/remove, no search field', async () => {
  const { hook, mutations } = setup();
  try {
    const tree = hook.render(); const rows = elements(tree).filter(e => e.props?.role === 'menuitemcheckbox');
    assert.deepEqual(rows.map(e => e.props['aria-checked']), [true, 'mixed', false]);
    assert.ok(!elements(tree).some(e => e.type === 'input'), 'pas de champ de recherche : la saisie n’apparaît qu’avec « Nouvelle étiquette… »');
    for (const row of rows) { row.props.onClick(); await Promise.resolve(); await Promise.resolve(); }
    assert.deepEqual(mutations.map(m => [m.ficheIds, m.addTagIds, m.removeTagIds]), [[['1','2'], [], ['a']], [['1','2'], ['b'], []], [['1','2'], ['c'], []]]);
  } finally { hook.unmount(); }
});
test('submenu: « Nouvelle étiquette… » ouvre une saisie, Entrée crée et coche, Échap annule', async () => {
  const { hook, mutations } = setup();
  try {
    const entry = newEntry(hook.render());
    assert.equal(entry.props.children[0].type, Plus);
    entry.props.onClick(); hook.render(); hook.flush();
    let field = find(hook.render(), e => e.type === 'input');
    field.props.onChange({ target: { value: ' Nouveau ' } });
    field = find(hook.render(), e => e.type === 'input');
    let stopped = 0;
    field.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped++; } });
    assert.equal(stopped, 1, 'Échap annule la saisie sans fermer le sous-menu');
    assert.ok(!elements(hook.render()).some(e => e.type === 'input'));
    assert.equal(mutations.length, 0);
    await typeAndSubmit(hook, ' Nouveau ');
    assert.deepEqual(mutations[0], { kind: 'changeTags', ficheIds: ['1', '2'], addLabels: ['Nouveau'], addTagIds: [], removeTagIds: [] });
    assert.ok(!elements(hook.render()).some(e => e.type === 'input'), 'la saisie se referme après la création');
  } finally { hook.unmount(); }
});
test('submenu: un libellé déjà connu réutilise l’étiquette (casse et accents ignorés)', async () => {
  const { hook, mutations } = setup();
  try {
    await typeAndSubmit(hook, 'BETA');
    assert.deepEqual(mutations[0], { kind: 'changeTags', ficheIds: ['1', '2'], addLabels: [], addTagIds: ['b'], removeTagIds: [] });
    mutations.length = 0;
  } finally { hook.unmount(); }
  const alreadyEverywhere = setup({ targets: [{ id: '1', tagIds: ['a'] }] });
  try { await typeAndSubmit(alreadyEverywhere.hook, 'ÉTÉ'); assert.equal(alreadyEverywhere.mutations.length, 0, 'déjà sur toutes les cibles : rien à faire'); } finally { alreadyEverywhere.hook.unmount(); }
});
test('submenu: la création attend le résultat, reste ouverte en cas d’échec et peut être relancée', async () => {
  let finish; let attempts = 0;
  const { hook } = setup({ onMutate: () => { attempts++; return new Promise(resolve => { finish = resolve; }); } });
  try {
    newEntry(hook.render()).props.onClick(); hook.render(); hook.flush();
    find(hook.render(), e => e.type === 'input').props.onChange({ target: { value: 'Nouvelle étiquette' } });
    const submit = () => find(hook.render(), e => e.type === 'input').props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
    submit(); submit();
    assert.equal(attempts, 1, 'a pending creation cannot be submitted twice');
    finish(false);
    await settle();
    assert.equal(find(hook.render(), e => e.type === 'input').props.value, 'Nouvelle étiquette', 'a refused mutation keeps the field and its text');
    submit();
    assert.equal(attempts, 2);
    finish({ affectedCardIds: ['1', '2'] });
    await settle();
    assert.ok(!elements(hook.render()).some(e => e.type === 'input'));
  } finally { hook.unmount(); }
});
test('submenu ignores activation while busy', () => {
  const { hook, mutations } = setup({ busy: true });
  const tree = hook.render();
  newEntry(tree).props.onClick(); assert.ok(!elements(hook.render()).some(e => e.type === 'input'));
  elements(tree).filter(e => e.props?.role === 'menuitemcheckbox').forEach(e => { assert.equal(e.props['aria-disabled'], true); e.props.onClick(); });
  assert.equal(mutations.length, 0); hook.unmount();
});
test('frame: arrows go through the shared menu navigation, Escape closes and restores the anchor', () => {
  let restored = 0; let closed = 0; const previous = { document: globalThis.document };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const hook = runner(() => TagSubmenu({ tags, targets, busy: false, position: { x: 10, y: 10 }, onMutate: async () => true, onClose: () => closed++, trigger: { isConnected: true, focus() { restored++; } } }));
  try {
    const tree = hook.render(); hook.flush();
    assert.equal(tree.props.role, 'menu');
    assert.equal(find(tree, e => e.type?.name === 'TagMenuEntries').props.tags, tags);
    let stopped = 0; tree.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped++; } });
    assert.equal(closed, 1); assert.equal(stopped, 1);
    hook.unmount(); assert.equal(restored, 1);
  } finally { hook.unmount(); globalThis.document = previous.document; }
});
test('card badges: two labels and overflow, click filters without selecting', () => {
  const filtered = []; let stopped = false;
  const hook = runner(() => CardTags({ tags, onFilter: id => filtered.push(id) }));
  try {
    const tree = hook.render(); const buttons = elements(tree).filter(e => e.type === 'button');
    assert.equal(buttons.length, 2); buttons[0].props.onClick({ stopPropagation() { stopped = true; } });
    assert.deepEqual(filtered, ['a']); assert.ok(stopped);
    const labels = elements(tree).filter(e => e.props?.whenTruncated);
    assert.deepEqual(labels.map(e => e.props.text), ['Été', 'Bêta']);
    const tooltip = find(tree, e => e.props?.text === 'Été · Bêta · Contes');
    assert.equal(tooltip.props.children.props.children, '+1');
  } finally { hook.unmount(); }
  const empty = runner(() => CardTags({ tags: [], onFilter() {} })); assert.equal(empty.render(), null); empty.unmount();
});
test('selection button opens labels popover; context entry declares submenu', () => {
  let opened = false;
  const hook = runner(() => FicheSelectionSummary({ cards: [{ id: '1' }, { id: '2' }], actions: [{ id: 'tags', enabled: true }], onTags() { opened = true; } }));
  const tree = hook.render();
  const tags = find(tree, e => e.type?.name === 'SelectionTags');
  const tagUI = runner(() => tags.type(tags.props));
  find(tagUI.render(), e => e.props?.['aria-haspopup'] === 'menu').props.onClick({}); assert.ok(opened); tagUI.unmount(); hook.unmount();
  const context = runner(() => CardContextMenu({ menu: {}, card: { title: 'Pack' }, entries: [{ key: 'tags', action: { id: 'tags', enabled: true } }] }));
  assert.equal(context.render().props.entries[0].submenu, true); context.unmount();
});


function measureIndicator(app, available = 25) {
  const previous = { ResizeObserver: globalThis.ResizeObserver, getComputedStyle: globalThis.getComputedStyle };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} }; globalThis.requestAnimationFrame = fn => { fn(); return 1; }; globalThis.cancelAnimationFrame = () => {};
  globalThis.getComputedStyle = () => ({ columnGap: '4px' });
  const tree = app.render();
  tree.props.ref.current = { clientWidth: available };
  find(tree, e => e.props?.className === 'catalogue-card-tag-measure').props.ref.current = {
    querySelectorAll: () => tags.map(() => ({ getBoundingClientRect: () => ({ width: 40 }) })),
    querySelector: () => ({ getBoundingClientRect: () => ({ width: 25 }) }),
  };
  app.flush();
  return () => { globalThis.ResizeObserver = previous.ResizeObserver; globalThis.getComputedStyle = previous.getComputedStyle; };
}

test('tag fitting uses available pixels, complete labels and reserved overflow space', () => {
  assert.equal(fittingTagCount([40, 40], 84, 25), 2);
  assert.equal(fittingTagCount([40, 40], 80, 25), 1);
  assert.equal(fittingTagCount([100], 80, 25), 0);
  assert.equal(fittingTagCount([40, 40, 40], 110, 25), 1);
  assert.equal(fittingTagCount([40, 40, 40], 128, 25), 3);
});

test('card indicator: absent without tags, one full-name accessible filter, overflow opens a count menu', () => {
  const filtered = [];
  const empty = runner(() => CardTagIndicator({ tags: [], onFilter() {} }));
  try { assert.equal(empty.render(), null); } finally { empty.unmount(); }
  const single = runner(() => CardTagIndicator({ tags: [tags[0]], onFilter: id => filtered.push(id), tabIndex: -1 }));
  try {
    const tree = single.render(); const button = find(tree, e => e.type === 'button');
    assert.equal(button.props.children, 'Été');
    assert.equal(button.props['aria-label'], 'Été');
    assert.equal(button.props['aria-haspopup'], undefined);
    assert.equal(button.props.tabIndex, -1);
    assert.ok(find(tree, e => e.props?.whenTruncated));
    let stopped = 0; button.props.onClick({ detail: 1, stopPropagation() { stopped++; } });
    button.props.onClick({ detail: 2, stopPropagation() { stopped++; } });
    assert.equal(stopped, 2); assert.deepEqual(filtered, ['a']);
  } finally { single.unmount(); }
  const many = runner(() => CardTagIndicator({ tags, onFilter: id => filtered.push(id) }));
  const previousFrame = globalThis.requestAnimationFrame; globalThis.requestAnimationFrame = fn => fn();
  const restoreMeasure = measureIndicator(many);
  try {
    let tree = many.render(); let trigger = find(tree, e => e.type === 'button');
    assert.equal(trigger.props['aria-haspopup'], 'menu');
    assert.equal(trigger.props['aria-expanded'], false);
    trigger.props.onClick({ detail: 1, stopPropagation() {} });
    tree = many.render(); trigger = find(tree, e => e.type === 'button');
    assert.equal(trigger.props['aria-expanded'], true);
    const menu = find(tree, e => e.props?.role === 'menu');
    assert.equal(menu.props.id, trigger.props['aria-controls']);
    const items = elements(menu).filter(e => e.props?.role === 'menuitem');
    assert.deepEqual(items.map(e => e.props.children), ['Été', 'Bêta', 'Contes']);
    items[1].props.onClick(); tree = many.render();
    assert.deepEqual(filtered, ['a', 'b']);
    assert.equal(find(tree, e => e.type === 'button').props['aria-expanded'], false);
    assert.ok(!elements(tree).some(e => e.props?.role === 'menu'));
  } finally { many.unmount(); restoreMeasure(); globalThis.requestAnimationFrame = previousFrame; }
});

test('card tag menu closes with Escape and restores its trigger without filtering', () => {
  let restored = 0; const filtered = [];
  const previousFrame = globalThis.requestAnimationFrame; globalThis.requestAnimationFrame = fn => fn();
  const app = runner(() => CardTagIndicator({ tags, onFilter: id => filtered.push(id) }));
  const restoreMeasure = measureIndicator(app);
  try {
    let tree = app.render(); const trigger = find(tree, e => e.type === 'button');
    trigger.props.ref.current = { isConnected: true, focus() { restored++; } };
    trigger.props.onKeyDown(key('ArrowDown')); tree = app.render();
    const menu = find(tree, e => e.props?.role === 'menu');
    menu.props.onKeyDown(key('Escape')); tree = app.render();
    assert.equal(restored, 1); assert.deepEqual(filtered, []);
    assert.equal(find(tree, e => e.type === 'button').props['aria-expanded'], false);
  } finally { app.unmount(); restoreMeasure(); globalThis.requestAnimationFrame = previousFrame; }
});

test('PF-F entries keep applied labels checked with Already added; « Nouvelle étiquette… » comes first with Plus', () => {
  const { hook } = setup();
  try {
    const tree = hook.render();
    const applied = find(tree, e => e.props?.role === 'menuitemcheckbox' && e.props['aria-checked'] === true);
    assert.ok(find(applied, e => e.props?.children === 'déjà ajoutée'));
    const roles = elements(tree).filter(e => ['menuitem', 'menuitemcheckbox'].includes(e.props?.role)).map(e => e.props.role);
    assert.deepEqual(roles, ['menuitem', 'menuitemcheckbox', 'menuitemcheckbox', 'menuitemcheckbox']);
    assert.ok(elements(tree).some(e => e.props?.role === 'separator'));
  } finally { hook.unmount(); }
});

test('floating selection tags stay above the bar, including a short viewport', () => {
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { innerWidth: 800, innerHeight: 600 };
  const position = { x: 700, y: 180 };
  const hook = runner(() => TagSubmenu({ tags, targets, busy: false, onMutate: async () => true, onClose() {}, placement: 'above', position }));
  try {
    let tree = hook.render();
    assert.equal(tree.props.style.maxHeight, 172);
    tree.props.ref.current = { getBoundingClientRect: () => ({ width: 288, height: 172 }), querySelector: () => null };
    hook.flush();
    tree = hook.render();
    assert.equal(tree.props.style.top, 8);
    assert.equal(tree.props.style.left, 504);
    assert.equal(tree.props.style.top + 172, position.y, 'menu bottom keeps the gap above the bar');
  } finally {
    hook.unmount();
    globalThis.document = previous.document;
    globalThis.window = previous.window;
  }
});
