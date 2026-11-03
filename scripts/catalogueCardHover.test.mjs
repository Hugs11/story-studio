import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { CatalogueCard } = await import('../src/components/Catalogue/views/CatalogueCard.jsx');
const { card } = await import('./catalogueFixtures.mjs');
const { catalogueCardActivation } = await import('../src/store/catalogue/cardActivation.js');
const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];

function surface(c, view) {
  const app = runner(() => CatalogueCard({ item: { card: c, exemplars: c.exemplars }, index: 0, view: { selected: new Set(), activeId: c.id, ...view } }));
  const tree = app.render(); app.unmount();
  return { tree, button: elements(tree).find(e => e.props?.className === 'catalogue-card-simulate') };
}

test('Simulate isolates every click and activation key from selection and remembered double click', async () => {
  const c = card({ id: 'a' }); const calls = []; const clicks = { current: { id: 'previous', at: 100 } };
  const view = catalogueCardActivation({
    selection: { apply: () => calls.push('select'), setActiveId: () => calls.push('active') },
    order: ['a'], cardsById: new Map([['a', c]]), openFiche: () => calls.push('panel'),
    openModal: () => calls.push('modal'), simulate: request => calls.push(request),
    abandon: { current: null }, revision: 7, clicks, now: () => 110,
  });
  const { tree, button } = surface(c, view);
  assert.ok(button); assert.equal(button.props.tabIndex, 0);
  const dispatch = async (handler, detail, key) => {
    let stopped = false;
    const event = { detail, key, stopPropagation() { stopped = true; } };
    await handler(event);
    if (!stopped) await tree.props.onClick(event);
    assert.ok(stopped);
  };
  await dispatch(button.props.onClick, 2);
  assert.deepEqual(calls, [], 'a second click landing on Simulate after grid reflow never opens the first card');
  await dispatch(button.props.onClick, 1);
  await dispatch(button.props.onClick, 2);
  await dispatch(button.props.onDoubleClick, 2);
  for (const key of ['Enter', ' ']) await dispatch(button.props.onKeyDown, 0, key);
  assert.deepEqual(calls, [{ card: c, revision: 7 }]);
  assert.equal(clicks.current, null, 'explicit simulation clears the first click remembered before the button');
  await view.onItemClick({ detail: 2 }, 'a');
  assert.equal(calls.length, 1, 'no stale modal after simulation');
});

test('Simulate uses the shared eligibility policy and advertises the version chooser', () => {
  for (const exemplars of [[], [{ available: false }], [{ state: 'corruptArchive' }], [{ state: 'unsupportedFormat' }]]) {
    assert.equal(surface(card({ exemplars }), {}).button, undefined);
  }
  const c = card({ exemplars: [{ id: 'one' }, { id: 'two' }] });
  assert.equal(surface(c, {}).button.props['aria-haspopup'], 'dialog');
  assert.equal(surface(c, { activeId: 'other' }).button.props.tabIndex, -1);
  assert.equal(surface(card({ exemplars: [{}] }), {}).button.props['aria-haspopup'], undefined);
});


test('Edit isolates clicks and keys, clears remembered double clicks and uses the fiche editor flow', async () => {
  const c = card({ id: 'edit', exemplars: [{ id: 'one' }, { id: 'two' }] });
  const calls = []; const clicks = { current: { id: 'edit', at: 100 } };
  const view = catalogueCardActivation({ cardsById: new Map([[c.id, c]]), revision: 7,
    abandon: { current: null }, clicks, edit: request => calls.push(request) });
  const { tree } = surface(c, view);
  const button = elements(tree).find(e => e.props?.className === 'catalogue-card-edit');
  assert.equal(button.props['aria-haspopup'], 'dialog');
  const trigger = { closest: () => ({ id: 'catalogue-item-edit' }) };
  for (const [handler, detail, key] of [[button.props.onClick, 2], [button.props.onDoubleClick, 2], [button.props.onKeyDown, 0, 'Enter'], [button.props.onKeyDown, 0, ' '], [button.props.onClick, 1]]) {
    let stopped = false;
    await handler({ detail, key, currentTarget: trigger, stopPropagation() { stopped = true; } });
    assert.ok(stopped);
  }
  assert.deepEqual(calls, [{ card: c, revision: 7, returnFocusId: 'catalogue-item-edit' }]);
  assert.equal(clicks.current, null);
  for (const exemplars of [[], [{ available: false }], [{ state: 'corruptArchive' }]]) {
    assert.equal(elements(surface(card({ exemplars }), {}).tree).find(e => e.props?.className === 'catalogue-card-edit'), undefined);
  }
});

test('narrow card measures whole formats, drops duration first and exposes every format via +N', async () => {
  const { CardFormatTags } = await import('../src/components/Catalogue/views/CardFormatTags.jsx');
  const { formatTags } = await import('../src/store/catalogue/formatTag.js');
  const tags = formatTags(card({ exemplars: ['project', 'zip', 'sevenZip', 'folder'].map(format => ({ format })) }).exemplars);
  const previous = { ResizeObserver: globalThis.ResizeObserver, getComputedStyle: globalThis.getComputedStyle };
  let resize; let disconnected = false; let available = 100; let metaWidth = 170;
  globalThis.ResizeObserver = class { constructor(fn) { resize = fn; } observe() {} disconnect() { disconnected = true; } }; globalThis.requestAnimationFrame = fn => { fn(); return 1; }; globalThis.cancelAnimationFrame = () => {};
  globalThis.getComputedStyle = () => ({ columnGap: '4' });
  const calls = [];
  const app = runner(() => CardFormatTags({ tags, idPrefix: 'formats', tabIndex: 0, onActivate: (tag) => calls.push(tag.format) }));
  try {
    const tree = app.render();
    const meta = { dataset: {}, get clientWidth() { return metaWidth; }, querySelector: selector => ({ getBoundingClientRect: () => ({ width: selector.includes('details') ? 66 : 0 }) }) };
    tree.props.ref.current = { parentElement: meta, get clientWidth() { return available; } };
    const measure = elements(tree).find(e => e.props?.className === 'catalogue-card-format-measure');
    measure.props.ref.current = { querySelectorAll: () => [50, 30, 25, 60].map(width => ({ getBoundingClientRect: () => ({ width }) })), querySelector: () => ({ getBoundingClientRect: () => ({ width: 25 }) }) };
    app.flush();
    let rendered = app.render();
    assert.equal(meta.dataset.hideDuration, 'true');
    const overflow = elements(rendered).find(e => e.type === 'button');
    assert.equal(overflow.props.children[1], 3);
    assert.equal(overflow.props['aria-label'].split(' · ').length, 4);
    const tooltip = elements(rendered).find(e => e.props?.text === overflow.props['aria-label']);
    assert.ok(tooltip, 'tooltip and accessible name both list all formats');
    overflow.props.onClick({ detail: 1, stopPropagation() {} });
    assert.deepEqual(calls, [undefined], 'overflow opens exemplars without restricting to a hidden format');
    available = 220; metaWidth = 300; resize(); rendered = app.render();
    assert.equal(meta.dataset.hideDuration, 'false');
    assert.equal(elements(rendered).filter(e => e.type === 'button').length, 0, 'all four badges replace overflow after resize');
  } finally { app.unmount(); Object.assign(globalThis, previous); }
  assert.ok(disconnected);
});
