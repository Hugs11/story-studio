// Le document avancé utilise seulement le simulateur flottant commun.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mountSurface } from './chromeBench.mjs';
import { createElement } from 'react';
const { LuniiShell } = await import('../src/tabs/EmulatorTab/LuniiShell.jsx');

const source = readFileSync(
  new URL('../src/components/AdvancedWorkspace/DocumentSimulationPanel.jsx', import.meta.url),
  'utf8',
);
const luniiShellSource = readFileSync(
  new URL('../src/tabs/EmulatorTab/LuniiShell.jsx', import.meta.url),
  'utf8',
);

test('la simulation du graphe ne peint plus de bandeau ni de seconde commande de fermeture', () => {
  assert.doesNotMatch(source, /advanced-review-banner/);
  assert.doesNotMatch(source, /Écoute du projet en cours|Fermer l’écoute|aucune production/);
  assert.match(source, /<FloatingSimulator[\s\S]*?onClose=\{onClose\}/);
});

test('les boutons physiques évidents de la Lunii restent nommés sans tooltip', () => {
  const buttons = luniiShellSource.match(/<div className="lunii-buttons">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.doesNotMatch(buttons, /<Tooltip/);
  // Les attentes françaises portent sur le rendu, y compris après extraction i18n.
  const { html } = mountSurface(createElement(LuniiShell, { paused: false }));
  assert.match(html, /aria-label="Accueil"/);
  assert.match(html, /aria-label="Pause"/);
  assert.match(mountSurface(createElement(LuniiShell, { paused: true })).html, /aria-label="Reprendre"/);
  assert.match(html, /lunii-btn-ok[^>]*>\s*OK\s*<\/button>/);
});
