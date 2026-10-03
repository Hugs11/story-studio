// Contre-épreuve : un story.json synthétique où chaque forme vaut 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureStory } from './entree-source.mjs';

const cs = (home) => ({ wheel: true, ok: true, home, pause: true, autoplay: false });
// E : Accueil -> A1[0] = E (auto-boucle de l'entrée) ; A1 vise E (option + okTransition) ;
// S1 : auto-boucle ; S2 : Accueil actif sans destination (retour dérivé).
const story = {
  stageNodes: [
    { uuid: 'E', squareOne: true, controlSettings: cs(true), homeTransition: { actionNode: 'A1', optionIndex: 0 }, okTransition: { actionNode: 'A1', optionIndex: 0 } },
    { uuid: 'S1', squareOne: false, controlSettings: cs(true), homeTransition: { actionNode: 'A2', optionIndex: 0 }, okTransition: null },
    { uuid: 'S2', squareOne: false, controlSettings: cs(true), homeTransition: null, okTransition: null },
  ],
  actionNodes: [{ id: 'A1', options: ['E'] }, { id: 'A2', options: ['S1'] }],
};

test('chaque forme est détectée', () => {
  const m = measureStory(story);
  assert.equal(m.optionsToEntry, 1);
  assert.deepEqual(m.optionsToEntryActions, ['A1']);
  assert.equal(m.entrySelfLoop, true);
  assert.equal(m.otherSelfLoops, 1);
  assert.equal(m.derivedHomeReturns, 1);
  assert.equal(m.okTransitionToEntry, 1);
  assert.equal(m.hasEntry, 1);
  const s2 = structuredClone(story);
  s2.stageNodes[0].homeTransition = null;
  const m2 = measureStory(s2);
  assert.equal(m2.entryHomeActiveNoDest, true);
  assert.equal(m2.entrySelfLoop, false);
  assert.equal(m2.derivedHomeReturns, 1);
});
