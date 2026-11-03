import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installMountedDom, click } from './treeMountedDom.mjs';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { Select } = await import('../src/components/common/Select.jsx');

// Vrai React monté dans le DOM minimal : mesure le coût de rendu de 500 options (ouverture et déplacement
// clavier), sans virtualisation. Le DOM minimal n'a pas de mise en page : le chiffre borne le travail de React,
// pas la peinture du navigateur.
test('500 options : ouverture et déplacement clavier sans à-coup, sans virtualisation', async t => {
  const dom = installMountedDom();
  const { document } = dom;
  const walk = (node, visit) => { visit(node); node.childNodes.forEach(child => walk(child, visit)); };
  document.getElementById = id => { let found = null; walk(document.body, node => { if (node.attributes?.id === id) found = node; }); return found; };
  // Pas de mise en page ici : des dimensions fixes évitent les NaN dans le calcul de placement.
  const createElement = document.createElement.bind(document);
  document.createElement = name => Object.assign(createElement(name), { offsetWidth: 200, offsetHeight: 28, offsetTop: 0, scrollHeight: 400, clientHeight: 300, scrollTop: 0, getBoundingClientRect: () => ({ left: 10, top: 10, bottom: 44, width: 200, height: 34 }) });
  Object.assign(globalThis.window, { innerWidth: 800, innerHeight: 600 });
  const attr = (node, name) => node.nodeType === 1 && node.attributes[name] !== undefined;
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  const options = Array.from({ length: 500 }, (_, i) => ({ value: `n${i}`, label: `Nœud ${i} — étape numéro ${i}`, group: `Scène ${Math.floor(i / 50)}` }));
  let value = 'n250';
  const App = () => React.createElement(Select, { value, options, 'aria-label': 'Cible', onChange: next => { value = next; } });
  try {
    await act(async () => root.render(React.createElement(App)));
    const trigger = host.querySelector('button');
    assert.equal(trigger.getAttribute('role'), 'combobox');
    const timings = [];
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      await act(async () => click(trigger));
      timings.push(performance.now() - start);
      const rows = []; walk(document.body, node => { if (node.nodeType === 1 && node.getAttribute('role') === 'option') rows.push(node); });
      assert.equal(rows.length, 500);
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(trigger.getAttribute('aria-activedescendant'), rows[250].getAttribute('id'));
      assert.equal(rows[250].getAttribute('aria-selected'), 'true');
      await act(async () => click(trigger));
      assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    }
    const median = [...timings].sort((a, b) => a - b)[2];
    // Déplacement clavier : recalcul de la liste ouverte.
    await act(async () => click(trigger));
    const moves = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await act(async () => trigger.dispatchEvent({ type: 'keydown', key: 'ArrowDown', bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }));
      moves.push(performance.now() - start);
    }
    const moveMedian = [...moves].sort((a, b) => a - b)[10];
    assert.equal(trigger.getAttribute('aria-activedescendant'), document.getElementById(trigger.getAttribute('aria-activedescendant')).getAttribute('id'));
    t.diagnostic(`500 options : ouverture médiane ${median.toFixed(1)} ms (min ${Math.min(...timings).toFixed(1)}, max ${Math.max(...timings).toFixed(1)}) ; ↓ médiane ${moveMedian.toFixed(1)} ms`);
    assert.ok(median < 300, `ouverture ${median} ms`);
    assert.ok(attr(trigger, 'aria-activedescendant'));
  } finally { await act(async () => root.unmount()); dom.restore(); }
});
