import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
// Compile production JSX; the existing hook driver supplies state and explicit
// rerenders. No DOM, synthetic component logic or alternative event handlers.
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { TagInput } = await import('../src/components/Catalogue/tags/TagInput.jsx');
function elements(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return [node, ...elements(node.props?.children)];
}
const find = (tree, predicate) => { const element = elements(tree).find(predicate); assert.ok(element, 'expected control exists'); return element; };
const input = tree => find(tree, element => element.type === 'input');
const button = (tree, label) => find(tree, element => element.type === 'button' && element.props.children === label);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
for (const kind of ['tag']) for (const scenario of ['newDraft', 'unchanged', 'editedBack', 'failure']) {
  test(`${kind}: deferred success preserves later edits (${scenario})`, async () => {
    const wait = deferred(); const calls = []; let busy = false;
    const submit = patch => { calls.push(patch); return wait.promise; };
    const hook = runner(() => TagInput({ tags: [], busy, onAdd: submit }));
    try {
      let tree = hook.render(); input(tree).props.onChange({ target: { value: 'A' } });
      tree = hook.render(); const pending = button(tree, 'Créer et ajouter').props.onClick();
      assert.deepEqual(calls, [{ addTagIds: [], addLabels: ['A'] }]);
      busy = true; tree = hook.render();
      if (scenario !== 'unchanged') { input(tree).props.onChange({ target: { value: 'B' } }); tree = hook.render(); }
      if (scenario === 'editedBack') { input(tree).props.onChange({ target: { value: 'A' } }); tree = hook.render(); }
      wait.resolve(scenario !== 'failure'); await pending; await Promise.resolve();
      tree = hook.render();
      assert.equal(input(tree).props.value, scenario === 'unchanged' ? '' : scenario === 'editedBack' ? 'A' : 'B');
      if (kind === 'tag' && scenario === 'newDraft') assert.equal(input(tree).props['aria-expanded'], true, 'new draft suggestions remain open');
    } finally { hook.unmount(); }
  });
}
