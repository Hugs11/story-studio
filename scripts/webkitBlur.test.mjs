import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import React from 'react';
import { runner } from './reactHookDriver.mjs';
import { focusButtonOnMouseDown } from '../src/components/common/mouseFocus.js';

registerHooks({ resolve(specifier, context, next) {
  return next(specifier.endsWith('/LucideLocal') ? `${specifier}.jsx` : specifier, context);
}, load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import React from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { inlineEditShell } = await import('../src/components/Catalogue/fiche/inlineEditShell.jsx');
const { TagInput } = await import('../src/components/Catalogue/tags/TagInput.jsx');
const { FieldEditor } = await import('../src/components/Catalogue/fiche/FieldEditor.jsx');
const { TreeSearchBar } = await import('../src/components/TreePanel/TreeSearchBar.jsx');
const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
const find = (tree, predicate) => { const result = elements(tree).find(predicate); assert.ok(result, 'control exists'); return result; };
const key = (name, tagName = 'INPUT') => ({ key: name, target: { tagName }, preventDefault() {}, stopPropagation() {} });

// Exercise the actual split-menu JSX and handlers without mounting the graph
// engine, project services and canvas. No product handler is duplicated here.
const workspace = readFileSync(new URL('../src/components/AdvancedWorkspace/AdvancedWorkspace.jsx', import.meta.url), 'utf8');
const begin = workspace.lastIndexOf('<div', workspace.indexOf('className="advanced-create-stage-split"'));
const end = workspace.indexOf('\n            <CommandButton', workspace.indexOf('className="advanced-create-stage-menu__item"'));
const splitJSX = workspace.slice(begin, end).trim();
const splitCode = transformSync('split.jsx', `const render = () => (${splitJSX});`, { jsx: { runtime: 'classic' } }).code;
function splitMenu({ stageDefaultsMenu = true, setStageDefaultsMenu, setDialog }) {
  const noop = () => {};
  return new Function('React', 'focusButtonOnMouseDown', 'stageDefaultsMenu', 'setStageDefaultsMenu', 'setDialog', 't', 'CommandButton', 'headerCommand', 'creationBlocked', 'shortcutLabels', 'Fullscreen', 'createStageAt', 'viewCenter', 'ChevronDown', `${splitCode}; return render();`)(
    React, focusButtonOnMouseDown, stageDefaultsMenu, setStageDefaultsMenu, setDialog, value => value, 'button', noop, false, {}, 'svg', noop, noop, 'svg');
}

// Browser default model: primary mousedown transfers focus before click. On
// WebKit that destination can be an outside ancestor or null, so the click
// target may disappear. preventDefault cancels only this default transfer;
// explicit focus() still emits a blur with an internal relatedTarget.
function mouseClick({ boundary, control, blur = boundary.props.onBlur, relatedTarget, alive = () => true, beforeClick }) {
  let prevented = false;
  const button = { tagName: 'BUTTON', disabled: control.props.disabled,
    contains: target => target === button,
    focus() { blur?.({ currentTarget: { contains: target => target === button }, relatedTarget: button }); } };
  const event = { button: 0, target: { closest: () => button }, currentTarget: { contains: target => target === button }, get defaultPrevented() { return prevented; }, preventDefault() { prevented = true; } };
  boundary.props.onMouseDownCapture?.(event);
  control.props.onMouseDown?.({ ...event, currentTarget: button });
  boundary.props.onMouseDown?.(event);
  if (!prevented) blur?.({ currentTarget: { contains: () => false }, relatedTarget });
  beforeClick?.();
  if (alive()) control.props.onClick();
}

for (const destination of [null, { tagName: 'LI', tabIndex: 0 }]) {
  test(`WebKit empty tree/graph search: scope click survives blur (${destination ? 'ancestor' : 'null'})`, () => {
    let searching = true; const scopes = [];
    const app = runner(() => TreeSearchBar({ searchTerm: '', selectedColors: new Set(), usedColors: [], inputRef: { current: null },
      setSearchActive: value => { searching = value; }, children: React.createElement('button', { onClick: () => scopes.push('stages') }) }));
    try {
      const tree = app.render();
      mouseClick({ boundary: tree, control: find(tree, el => el.type === 'button'), relatedTarget: destination, alive: () => searching });
      assert.equal(searching, true);
      assert.deepEqual(scopes, ['stages']);
    } finally { app.unmount(); }
  });

  test(`WebKit split menu: internal click survives blur destination ${destination ? 'ancestor' : 'null'}`, () => {
    let open = true; const dialogs = [];
    const tree = splitMenu({ setStageDefaultsMenu: value => { open = value; }, setDialog: value => dialogs.push(value) });
    mouseClick({ boundary: tree, control: find(tree, el => el.props?.role === 'menuitem'), relatedTarget: destination, alive: () => open });
    assert.deepEqual(dialogs, [{ kind: 'new-stage-defaults' }]);
    assert.equal(open, null);
  });

  for (const action of ['save', 'cancel', 'field']) test(`WebKit inline ${action}: no premature save (${destination ? 'ancestor' : 'null'})`, () => {
    const calls = []; let editing = true;
    const tree = inlineEditShell({ t: value => value, onSave() { calls.push('save'); editing = false; }, onCancel() { calls.push('cancel'); editing = false; },
      children: React.createElement('button', { onClick() { calls.push('field'); } }) });
    const control = action === 'field' ? find(tree, el => el.type === 'button')
      : find(tree, el => el.props?.['aria-label'] === (action === 'save' ? 'catalogue:fiche.edit.save' : 'catalogue:fiche.inline.cancel'));
    mouseClick({ boundary: tree, control, relatedTarget: destination, alive: () => editing,
      beforeClick: () => assert.deepEqual(calls, [], 'no save or action after mousedown/blur and before click') });
    assert.deepEqual(calls, [action]);
  });

  test(`WebKit tag suggestion survives both blur handlers (${destination ? 'ancestor' : 'null'})`, () => {
    const calls = [];
    const app = runner(() => TagInput({ tags: [{ id: 'tag', label: 'Alpha' }], busy: false, onAdd: value => { calls.push(value); return false; } }));
    try {
      let tree = app.render();
      find(tree, el => el.type === 'input').props.onFocus(); tree = app.render();
      const control = find(tree, el => el.type === 'button' && el.props.children === 'Alpha');
      const input = find(tree, el => el.type === 'input');
      mouseClick({ boundary: tree, control, relatedTarget: destination, alive: () => find(app.render(), el => el.type === 'input').props['aria-expanded'],
        blur(event) { input.props.onBlur({ ...event, currentTarget: { parentElement: event.currentTarget } }); tree.props.onBlur(event); } });
      assert.deepEqual(calls, [{ addTagIds: ['tag'], addLabels: [] }]);
    } finally { app.unmount(); }
  });
}

test('inline guards: internal Tab, outside Tab/null, Escape, Enter and multiline', () => {
  const calls = [];
  const tree = inlineEditShell({ t: value => value, onSave: () => calls.push('save'), onCancel: () => calls.push('cancel') });
  tree.props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} });
  tree.props.onKeyDown(key('Tab'));
  assert.deepEqual(calls, []);
  for (const relatedTarget of [{}, null]) tree.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget });
  tree.props.onKeyDown(key('Escape'));
  tree.props.onKeyDown(key('Enter'));
  tree.props.onKeyDown(key('Enter', 'TEXTAREA'));
  tree.props.onKeyDown({ ...key('Enter', 'TEXTAREA'), ctrlKey: true });
  tree.props.onKeyDown({ ...key('Enter'), nativeEvent: { isComposing: true } });
  assert.deepEqual(calls, ['save', 'save', 'cancel', 'save', 'save']);
});

test('split guards: internal focus, outside/null, Escape and keyboard click', () => {
  let open = true; let focused = 0; const dialogs = [];
  const tree = splitMenu({ setStageDefaultsMenu: value => { open = value; }, setDialog: value => dialogs.push(value) });
  tree.props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} }); assert.equal(open, true);
  for (const relatedTarget of [{}, null]) { open = true; tree.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget }); assert.equal(open, null); }
  open = true;
  tree.props.onKeyDown({ key: 'Escape', currentTarget: { querySelector: () => ({ focus() { focused++; } }) } });
  assert.equal(open, null); assert.equal(focused, 1);
  find(tree, el => el.props?.role === 'menuitem').props.onClick();
  assert.equal(dialogs.length, 1);
});

test('tag guards: internal focus, outside/null, Escape and Enter', () => {
  const calls = [];
  const app = runner(() => TagInput({ tags: [], busy: false, onAdd: value => { calls.push(value); return false; } }));
  try {
    const input = () => find(app.render(), el => el.type === 'input');
    input().props.onFocus();
    app.render().props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} }); assert.equal(input().props['aria-expanded'], true);
    for (const relatedTarget of [{}, null]) { input().props.onFocus(); app.render().props.onBlur({ currentTarget: { contains: () => false }, relatedTarget }); assert.equal(input().props['aria-expanded'], false); }
    input().props.onFocus(); input().props.onKeyDown(key('Escape')); assert.equal(input().props['aria-expanded'], false);
    input().props.onChange({ target: { value: 'New' } }); input().props.onKeyDown(key('Enter'));
    assert.deepEqual(calls, [{ addTagIds: [], addLabels: ['New'] }]);
  } finally { app.unmount(); }
});

test('shared mouse guard leaves inputs, selection, disabled buttons and secondary clicks alone', () => {
  const control = { tagName: 'BUTTON', focus() { assert.fail('must not focus'); } };
  const event = { button: 0, target: { closest: () => null }, currentTarget: { contains: () => true }, preventDefault() { assert.fail('must keep native default'); } };
  focusButtonOnMouseDown(event);
  focusButtonOnMouseDown({ ...event, defaultPrevented: true, target: { closest: () => control } });
  for (const button of [1, 2]) focusButtonOnMouseDown({ ...event, button, target: { closest: () => control } });
  focusButtonOnMouseDown({ ...event, target: { closest: () => ({ ...control, disabled: true }) } });
});

test('tree search guards: internal Tab, outside/null, active filters, Escape and Enter', () => {
  const calls = []; let blurred = 0;
  const app = runner(() => TreeSearchBar({ searchTerm: '', selectedColors: new Set(), usedColors: [],
    inputRef: { current: { blur() { blurred++; } } }, setSearchActive: value => calls.push(value), onClearSearch: () => calls.push('clear') }));
  try {
    const tree = app.render();
    tree.props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} });
    tree.props.onKeyDown(key('Tab')); tree.props.onKeyDown(key('Enter')); assert.deepEqual(calls, []);
    for (const relatedTarget of [{}, null]) tree.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget });
    tree.props.onKeyDown(key('Escape'));
    assert.deepEqual(calls, [false, false, 'clear']); assert.equal(blurred, 1);
    for (const props of [{ searchTerm: 'query', selectedColors: new Set() }, { searchTerm: '', selectedColors: new Set(['red']) }]) {
      const filtered = runner(() => TreeSearchBar({ ...props, usedColors: [], setSearchActive() { assert.fail('active filters keep search open'); } }));
      try { filtered.render().props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); } finally { filtered.unmount(); }
    }
  } finally { app.unmount(); }
});

test('shared mouse guard focuses a combobox button for subsequent keyboard navigation', () => {
  const calls = [];
  const control = { tagName: 'BUTTON', focus: options => calls.push(options) };
  focusButtonOnMouseDown({ button: 0, currentTarget: { contains: () => true }, target: { closest: () => control }, preventDefault: () => calls.push('prevent') });
  assert.deepEqual(calls, ['prevent', { preventScroll: true }]);
});

test('age steppers and conflict choices are covered by the shared inline boundary', () => {
  const calls = [];
  const app = runner(() => FieldEditor({ field: { id: 'age', labelKey: 'catalogue:fiche.edit.age' }, entry: { field: 'ageMin', state: 'defined', value: '4' }, onChange: value => calls.push(value), onResolve: value => calls.push(value), conflict: { theirs: { state: 'defined', value: '5' } } }));
  try {
    const fields = app.render();
    for (const control of elements(fields).filter(el => el.props?.onClick)) {
      const boundary = inlineEditShell({ t: value => value, onSave() { assert.fail('field button must not save on blur'); }, onCancel() {}, children: fields });
      mouseClick({ boundary, control, relatedTarget: null });
    }
    assert.equal(calls.length, 4);
  } finally { app.unmount(); }
});
