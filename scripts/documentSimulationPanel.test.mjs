// Le document avancé utilise seulement le simulateur flottant commun.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mountSurface } from './chromeBench.mjs';
import { createElement } from 'react';
import { registerHooks } from 'node:module';
// Le fichier EmulatorTab.jsx et son répertoire portent le même nom.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../../tabs/EmulatorTab') {
      return { url: new URL('../src/tabs/EmulatorTab.jsx', import.meta.url).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { LuniiShell } = await import('../src/tabs/EmulatorTab/LuniiShell.jsx');
const { FloatingSimulator } = await import('../src/components/FloatingSimulator/FloatingSimulator.jsx');

const source = readFileSync(
  new URL('../src/components/AdvancedWorkspace/DocumentSimulationPanel.jsx', import.meta.url),
  'utf8',
);
const luniiShellSource = readFileSync(
  new URL('../src/tabs/EmulatorTab/LuniiShell.jsx', import.meta.url),
  'utf8',
);

test('le simulateur affiche l’avis traduit et branche le bouton Relancer', () => {
  let restarts = 0;
  const props = { anchorId: 'root', documentStatus: 'loading', onRestart: () => { restarts += 1; } };
  const fresh = mountSurface(createElement(FloatingSimulator, props));
  assert.doesNotMatch(fresh.html, /Le projet a changé|Relancer/);
  const stale = mountSurface(createElement(FloatingSimulator, { ...props, documentStale: true }));
  assert.match(stale.html, /Le projet a changé depuis le lancement de l’écoute\./);
  assert.match(stale.html, />Relancer<\/button>/);
  const restart = stale.elements.find(element => element.type === 'button' && element.props.children === 'Relancer');
  restart.props.onClick();
  assert.equal(restarts, 1);
});

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
