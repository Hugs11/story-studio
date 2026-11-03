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
const { CatalogueFilterBar } = await import('../src/components/Catalogue/CatalogueFilterBar.jsx');
const { filterStateReducer, initialFilterState } = await import('../src/store/catalogue/filterState.js');
const { evaluateAge } = await import('../src/store/catalogue/ageFilter.js');
const { normalizeAge } = await import('../src/store/catalogue/entryModel.js');
const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children), ...Object.values(node.props?.components ?? {}).flatMap(elements)];
function mount(age) {
  let state = filterStateReducer(initialFilterState(), { type: 'set', family: 'age', value: age });
  let closed = 0;
  const app = runner(() => CatalogueFilterBar({ family: 'age', view: { filters: state.filters, dispatch: action => { state = filterStateReducer(state, action); } }, onClose: () => closed++ }));
  const render = () => elements(app.render());
  const input = index => render().filter(e => e.type === 'input')[index];
  const change = (index, value) => input(index).props.onChange({ target: { value } });
  return { app, render, input, change, age: () => state.filters.age, closed: () => closed };
}

test('six presets apply immediately, keep the menu open and replace exact ranges', () => {
  const ui = mount({ min: 3, max: 3, hideUnknown: false });
  try {
    const buttons = ui.render().filter(e => typeof e.props?.['aria-pressed'] === 'boolean');
    assert.equal(buttons.length, 6);
    assert.equal(ui.render().filter(e => e.type === 'input').length, 2);
    assert.equal(ui.render().some(e => e.props?.className === 'catalogue-age-apply'), false);
    for (const [index, max] of [2, 3, 4, 5, 7, 9].entries()) {
      buttons[index].props.onClick();
      assert.deepEqual(ui.age(), { min: null, max, hideUnknown: false });
      assert.equal(ui.render().filter(e => e.props?.['aria-pressed'] === true).length, 1);
      assert.equal(ui.input(0).props.value, '');
      assert.equal(ui.input(1).props.value, max);
      for (const age of [2, 5, 9, 12]) assert.equal(evaluateAge(normalizeAge({ ageMin: age }), ui.age()).visible, age <= max);
    }
    assert.equal(ui.closed(), 0);
  } finally { ui.app.unmount(); }
});

test('presets preserve the existing unknown-age policy and clear removes the age filter', () => {
  const ui = mount({ min: 3, max: 7, hideUnknown: true });
  try {
    ui.render().filter(e => typeof e.props?.['aria-pressed'] === 'boolean')[4].props.onClick();
    assert.deepEqual(ui.age(), { min: null, max: 7, hideUnknown: true });
    ui.render().find(e => e.props?.variant === 'ghost').props.onClick();
    assert.deepEqual(ui.age(), { min: null, max: null, hideUnknown: false });
  } finally { ui.app.unmount(); }
});


test('precise bounds apply live, synchronize presets and retain the last valid filter on errors', () => {
  const ui = mount({ min: null, max: 5, hideUnknown: true });
  try {
    ui.change(0, '3');
    assert.deepEqual(ui.age(), { min: 3, max: 5, hideUnknown: true });
    assert.equal(ui.render().filter(e => e.props?.['aria-pressed'] === true).length, 0);
    for (const invalid of ['8', '-1', '1.5', '100']) {
      ui.change(0, invalid);
      assert.equal(ui.input(0).props.value, Number(invalid));
      assert.equal(ui.input(0).props['aria-invalid'], true);
      assert.ok(ui.render().some(e => e.props?.role === 'alert'));
      assert.deepEqual(ui.age(), { min: 3, max: 5, hideUnknown: true });
    }
    ui.change(0, '');
    assert.equal(ui.render().filter(e => e.props?.['aria-pressed'] === true).length, 1);
    assert.equal(ui.age().min, null);
    ui.change(1, ''); ui.change(0, '0');
    assert.deepEqual(ui.age(), { min: 0, max: null, hideUnknown: true });
    ui.change(1, '0');
    assert.deepEqual(ui.age(), { min: 0, max: 0, hideUnknown: true });
    ui.change(0, '8');
    ui.render().filter(e => typeof e.props?.['aria-pressed'] === 'boolean')[1].props.onClick();
    assert.equal(ui.input(0).props.value, ''); assert.equal(ui.input(1).props.value, 3);
    assert.equal(ui.render().some(e => e.props?.role === 'alert'), false);
    assert.equal(ui.closed(), 0);
  } finally { ui.app.unmount(); }
});
