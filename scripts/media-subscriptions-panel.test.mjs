import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';

import { runner } from './reactHookDriver.mjs';

// Seul le runtime JSX est doublé : le panneau de production est rendu tel quel.
const jsxRuntime = 'export const Fragment = "fragment"; export function jsx(type, props, key) { return { type, props, key }; } export const jsxs = jsx;';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react/jsx-runtime') {
      return { url: `data:text/javascript,${encodeURIComponent(jsxRuntime)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (url.endsWith('.jsx')) {
      const path = fileURLToPath(url);
      return {
        format: 'module', shortCircuit: true,
        source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code,
      };
    }
    return next(url, context);
  },
});

const { MediaSubscriptionsPanel } = await import('../src/components/MediaSubscriptions/MediaSubscriptionsPanel.jsx');

// Déplie aussi les sous-composants fonctionnels sans état.
function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !node.props) return [];
  if (typeof node.type === 'function') return elements(node.type(node.props));
  return [node, ...elements(node.props.children)];
}

function text(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node.type === 'function') return text(node.type(node.props));
  return text(node.props?.children);
}

function openPanel(props) {
  const hook = runner(() => MediaSubscriptionsPanel(props));
  const trigger = elements(hook.render()).find((node) => node.props['aria-controls'] === 'media-subscriptions-panel');
  trigger.props.onClick();
  return elements(hook.render());
}

const youtube = {
  id: 'yt', title: 'Chaîne', projectName: 'Story', source: 'youtube', status: 'active', enabled: true,
};

function buttons(nodes, label) {
  return nodes.filter((node) => node.type === 'button' && text(node) === label);
}

test('the panel offers a YouTube tool update, then shows its progress and readable error', () => {
  const calls = [];
  let nodes = openPanel({
    subscriptions: [youtube],
    youtubeTools: { missing: false, updating: false, error: null },
    onUpdateTools: () => calls.push('update'),
  });
  assert.ok(nodes.some((node) => node.type === 'p' && text(node) === 'L’outil YouTube peut être mis à jour.'));
  buttons(nodes, 'Mettre à jour')[0].props.onClick();
  assert.deepEqual(calls, ['update']);

  nodes = openPanel({ subscriptions: [youtube], youtubeTools: { missing: false, updating: true, error: null } });
  assert.equal(buttons(nodes, 'Mise à jour…')[0].props.disabled, true);

  nodes = openPanel({ subscriptions: [youtube], youtubeTools: { missing: true, updating: false, error: 'Mise à jour impossible : réseau.' } });
  assert.ok(nodes.some((node) => node.type === 'p' && text(node) === 'L’outil YouTube n’est pas installé.'));
  assert.equal(buttons(nodes, 'Installer').length, 1);
  assert.ok(nodes.some((node) => node.props.role === 'alert' && text(node) === 'Mise à jour impossible : réseau.'));
});

test('without a tool notice the panel shows no update line', () => {
  const nodes = openPanel({ subscriptions: [youtube], youtubeTools: null });
  assert.equal(buttons(nodes, 'Mettre à jour').length, 0);
  assert.equal(buttons(nodes, 'Installer').length, 0);
});

test('a paused follow whose project is missing shows both states and the relocation action', () => {
  const nodes = openPanel({ subscriptions: [{ ...youtube, status: 'missing', enabled: false }] });
  assert.ok(nodes.some((node) => node.type === 'span' && text(node) === 'Story · YouTube · Suspendu · Projet introuvable'));
  assert.equal(buttons(nodes, 'Retrouver le projet').length, 1);
  assert.equal(buttons(nodes, 'Reprendre').length, 1);

  const active = openPanel({ subscriptions: [{ ...youtube, status: 'missing', enabled: true }] });
  assert.ok(active.some((node) => node.type === 'span' && text(node) === 'Story · YouTube · Actif · Projet introuvable'));
});
