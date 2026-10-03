// Retirer plusieurs nœuds : la confirmation de Suppr sur une sélection du
// graphe, et de « Retirer… » au clic droit dans une sélection.
//
// Un seul nœud passe par le parcours qui inventorie ses références ; plusieurs
// partent par le geste de Couper, sans le presse-papier, en une étape
// d'annulation. Ce qui compte ici : que la confirmation dise ce qui part et ce
// qui restera à raccorder, qu'elle envoie ce geste-là, et que l'Écran racine
// ne parte jamais.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sampleView } from './advancedViewFixtures.mjs';

const { buildGraphIndex } = await import('../src/store/advancedGraphView/graphViewModel.js');
const { selectionRemovalImpact } = await import('../src/store/advancedAuthoring/authoringPlans.js');

const CIBLE = '/stageNodes/@uuid=cible#0';
const ISOLE = '/stageNodes/@uuid=isole#0';
const CHOIX = '/actionNodes/@id=choix#0';
const ENTRY = '/stageNodes/@uuid=entry#0';

const removal = (paths) => selectionRemovalImpact(buildGraphIndex(sampleView()), paths);

test('la confirmation dit ce qui part et ce qui restera à raccorder', () => {
  const plan = removal([CIBLE, ISOLE]);
  assert.deepEqual(plan.entries.map((entry) => entry.label.label), ['Cible', 'Isolé']);
  assert.equal(plan.counted, '2 Écrans');
  // Les deux options de « choix » visaient « Cible » : elles resteront à raccorder.
  assert.equal(plan.loose, 2);
  assert.equal(removal([CIBLE, CHOIX]).counted, '1 Écran et 1 liste de choix');
});

test('confirmer envoie le geste de Couper, sans passer par le presse-papier', () => {
  const { gesture, loose } = removal([CIBLE, CHOIX]);
  assert.equal(gesture.gesture, 'delete-subgraph');
  assert.deepEqual(gesture.subgraph.stages, ['cible']);
  assert.deepEqual(gesture.subgraph.actions, ['choix']);
  // L'Action part avec l'Écran qu'elle visait : rien entre eux n'est à
  // raccorder. Seule la transition OK de l'entrée, qui visait l'Action, reste.
  assert.deepEqual(gesture.subgraph.options, []);
  assert.equal(gesture.subgraph.transitions.length, 1);
  assert.equal(loose, 1);
});

test('l’Écran racine ne part jamais, même au milieu d’une sélection', () => {
  const plan = removal([ENTRY, ISOLE]);
  assert.equal(plan.entryIncluded, true);
  assert.equal(plan.gesture, null, 'aucun geste ne peut partir');
});

test('une sélection que l’index ne connaît plus ne retire rien', () => {
  const plan = removal(['/stageNodes/@uuid=disparu#0']);
  assert.deepEqual(plan.entries, []);
  assert.equal(plan.gesture, null);
});
