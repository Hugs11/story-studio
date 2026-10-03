// Le document avancé utilise seulement le simulateur flottant commun.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
  assert.match(buttons, /aria-label="Accueil"/);
  assert.match(buttons, /aria-label=\{paused \? 'Reprendre' : 'Pause'\}/);
  assert.match(buttons, /lunii-btn-ok[^>]*>\s*OK\s*<\/button>/);
});
