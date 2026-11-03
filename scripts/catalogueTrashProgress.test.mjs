import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as ProgressReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'ProgressReact.createElement', pragmaFrag: 'ProgressReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { ExemplarTrashButton } = await import('../src/components/Catalogue/fiche/ExemplarTrashButton.jsx');
const { toCatalogueError } = await import('../src/store/catalogue/catalogueApi.js');
function elements(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(elements); return [node, ...elements(node.props?.children)]; }
const find = (tree, predicate) => { const element = elements(tree).find(predicate); assert.ok(element, 'expected control exists'); return element; };

test('CORB inline progress: spinner while planning, confirming and running, row busy, then normal state and error on failure', async () => {
  let clock = 0; let expanded = false; const busy = []; let releasePlan; let releaseStart;
  const trash = { planId: 'trash', action: 'trash', targets: [{ sourceToken: 'same' }] };
  const filesApi = {
    plan: () => new Promise(resolve => { releasePlan = () => resolve(trash); }),
    releasePlan: async () => {},
    confirmRemoval: async (planId, stage) => ({ planId, stage, token: stage, targetToken: 'same' }),
    start: () => new Promise((_, reject) => { releaseStart = () => reject(toCatalogueError({ code: 'CATALOG_FILE_SOURCE_CHANGED' })); }),
  };
  const services = { now: () => clock, filesApi, dataApi: { getCard: async () => ({ id: 'c', catalogueRevision: 1 }) } };
  const original = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const app = runner(() => ExemplarTrashButton({ card: { id: 'c' }, exemplar: { id: 'e' }, expanded, onExpand: id => { expanded = id !== null; }, onBusy: value => busy.push(value), onDone() {}, services }));
  const render = () => { app.render(); app.flush(); return app.render(); };
  const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  const button = tree => find(tree, e => e.props?.id === 'catalogue-fiche-copy-e-trash');
  const spinner = tree => elements(tree).some(e => e.props?.className === 'catalogue-exemplar-trash-spinner');
  const status = tree => elements(tree).find(e => e.props?.role === 'status')?.props.children;
  try {
    let tree = render();
    assert.equal(spinner(tree), false);
    button(tree).props.onClick({ detail: 2, stopPropagation() {} }); tree = render();
    assert.equal(spinner(tree), true); assert.equal(status(tree), 'Préparation…');
    assert.equal(button(tree).props['aria-label'], 'Préparation…');
    await settle(); releasePlan(); await settle(); tree = render();
    assert.equal(spinner(tree), false); assert.equal(button(tree).props['aria-label'], 'Mettre à la corbeille');
    clock = 400; button(tree).props.onClick({ detail: 2, stopPropagation() {} }); tree = render();
    assert.equal(spinner(tree), true); assert.equal(status(tree), 'Mise à la corbeille…');
    assert.equal(busy.at(-1), true, 'row is told to grey out as soon as the confirmation click lands');
    await settle(); tree = render();
    assert.equal(spinner(tree), true, 'still running while start is pending'); assert.equal(busy.at(-1), true);
    releaseStart(); await settle(); tree = render();
    assert.equal(spinner(tree), false);
    assert.ok(find(tree, e => e.props?.role === 'alert').props.children, 'error is shown on the line');
    assert.equal(busy.at(-1), false, 'row returns to its normal state after failure');
  } finally { app.unmount(); globalThis.document = original; }
});

// Plan long sur un gros ZIP : le repli automatique ne doit pas courir pendant « Préparation… ».
function trashHarness({ plan, start = async () => ({}) }) {
  let clock = 0; let expanded = false; const failures = []; let collapses = 0;
  const trash = { planId: 'trash', action: 'trash', targets: [{ sourceToken: 'same' }] };
  const filesApi = { plan, releasePlan: async () => {}, confirmRemoval: async (planId, stage) => ({ planId, stage, token: stage, targetToken: 'same' }), start };
  const services = { now: () => clock, filesApi, dataApi: { getCard: async () => ({ id: 'c', catalogueRevision: 1 }) } };
  const onExpand = id => { if (id === null) collapses++; expanded = id !== null; }; // stable, comme `setExpanded`
  const app = runner(() => ExemplarTrashButton({ card: { id: 'c' }, exemplar: { id: 'e' }, expanded, onExpand, onBusy() {}, onDone() {}, onFailed: error => failures.push(error), services }));
  const render = () => { app.render(); app.flush(); return app.render(); };
  const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  const button = tree => find(tree, e => e.props?.id === 'catalogue-fiche-copy-e-trash');
  return { app, render, settle, button, trash, failures, setClock: value => { clock = value; }, isExpanded: () => expanded, collapses: () => collapses };
}

test('CORB le clic souris confirme sans transférer le focus à la ligne parente', async () => {
  const original = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const launches = [];
  const h = trashHarness({ plan: async () => h.trash, start: (...args) => { launches.push(args); return new Promise(() => {}); } });
  try {
    let tree = h.render();
    h.button(tree).props.onClick({ stopPropagation() {} }); await h.settle(); tree = h.render();
    h.setClock(1000);
    let defaultPrevented = false;
    h.button(tree).props.onMouseDown?.({ button: 0, currentTarget: { tagName: 'BUTTON', focus() {} }, preventDefault() { defaultPrevented = true; } });
    // Dans WebKit, le défaut de mousedown sur le bouton focalise le LI tabulable.
    // Ce blur arrive avant mouseup/click et replie alors la confirmation.
    if (!defaultPrevented) tree.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: {} });
    tree = h.render();
    assert.equal(h.isExpanded(), true, 'la confirmation reste armée entre mousedown et click');
    h.button(tree).props.onClick({ stopPropagation() {} }); await h.settle(); tree = h.render();
    assert.equal(launches.length, 1, 'une seule opération est lancée');
    assert.equal(launches[0][0], 'trash');
    assert.deepEqual(launches[0][1].removalConfirmations, ['trash']);
    assert.equal(h.button(tree).props['aria-label'], 'Mise à la corbeille…');
  } finally { h.app.unmount(); globalThis.document = original; }
});

test('CORB le focus interne garde la confirmation et Tab vers un autre contrôle la replie', async () => {
  const original = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const h = trashHarness({ plan: async () => h.trash });
  try {
    let tree = h.render();
    h.button(tree).props.onClick({ stopPropagation() {} }); await h.settle(); tree = h.render();
    tree.props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} });
    assert.equal(h.isExpanded(), true);
    tree.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: {} });
    h.render();
    assert.equal(h.isExpanded(), false);
  } finally { h.app.unmount(); globalThis.document = original; }
});

for (const gesture of ['outside', 'Escape']) {
  test(`CORB ${gesture} annule toujours la confirmation`, async () => {
    const original = globalThis.document;
    const listeners = new Map();
    globalThis.document = { addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) };
    const h = trashHarness({ plan: async () => h.trash });
    try {
      let tree = h.render();
      h.button(tree).props.onClick({ stopPropagation() {} }); await h.settle(); tree = h.render();
      assert.equal(h.isExpanded(), true);
      if (gesture === 'outside') {
        tree.props.ref.current = { contains: () => false };
        listeners.get('pointerdown')({ target: {} });
      } else {
        listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
      }
      h.render();
      assert.equal(h.isExpanded(), false);
    } finally { h.app.unmount(); globalThis.document = original; }
  });
}

test('CORB-FX1 le repli de 4 s ne court pas pendant la préparation du plan, il démarre à la confirmation', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  let releasePlan; const h = trashHarness({ plan: () => new Promise(resolve => { releasePlan = () => resolve(h.trash); }) });
  try {
    let tree = h.render();
    h.button(tree).props.onClick({ stopPropagation() {} }); await h.settle(); tree = h.render();
    assert.equal(h.button(tree).props['aria-label'], 'Préparation…');
    mock.timers.tick(30000); tree = h.render();
    assert.equal(h.isExpanded(), true, 'toujours déroulé après un plan plus long que le délai de repli');
    assert.equal(h.button(tree).props['aria-label'], 'Préparation…');
    releasePlan(); await h.settle(); tree = h.render();
    assert.equal(h.button(tree).props['aria-label'], 'Mettre à la corbeille');
    mock.timers.tick(3900); h.render();
    assert.equal(h.isExpanded(), true);
    mock.timers.tick(200); h.render();
    assert.equal(h.isExpanded(), false, 'le repli reprend une fois la confirmation affichée');
  } finally { h.app.unmount(); globalThis.document = original; mock.timers.reset(); }
});

test('CORB-FX1 une erreur de plan reste affichée sans repli et est signalée une fois au catalogue', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const h = trashHarness({ plan: async () => { throw toCatalogueError({ code: 'CATALOG_FILE_SOURCE_CHANGED' }); } });
  try {
    let tree = h.render();
    h.button(tree).props.onClick({ stopPropagation() {} }); await h.settle(); tree = h.render();
    assert.ok(find(tree, e => e.props?.role === 'alert').props.children, 'erreur affichée');
    mock.timers.tick(60000); tree = h.render();
    assert.equal(h.isExpanded(), true);
    assert.ok(find(tree, e => e.props?.role === 'alert').props.children, 'erreur toujours affichée');
    assert.equal(h.failures.length, 1);
  } finally { h.app.unmount(); globalThis.document = original; mock.timers.reset(); }
});
