import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  OPTION_SELECTION,
  RANDOM_OPTION_INDEX,
  createOptionDrawSource,
  optionSelectionCandidates,
  optionSelectionIsWithinBounds,
  optionSelectionToDialectIndex,
  parseOptionSelection,
  resolveTransitionEntry,
  selectInitialOption,
} from '../src/store/optionSelection.js';
import { packFlatGraph, resolveInitialStage } from '../src/tabs/EmulatorTab/flatGraph.js';

// Une source déterministe qui rejoue une séquence et compte ses tirages.
function sequenceDrawSource(draws) {
  let cursor = 0;
  const source = (optionCount) => {
    const draw = draws[cursor % draws.length] % optionCount;
    cursor += 1;
    return draw;
  };
  source.drawCount = () => cursor;
  return source;
}

test('the random sentinel survives a dialect roundtrip', () => {
  const selection = parseOptionSelection(-1);
  assert.deepEqual(selection, { kind: OPTION_SELECTION.RANDOM });
  assert.equal(optionSelectionToDialectIndex(selection), RANDOM_OPTION_INDEX);
});

test('a fixed index survives a dialect roundtrip', () => {
  for (const index of [0, 1, 7, 99]) {
    const selection = parseOptionSelection(index);
    assert.deepEqual(selection, { kind: OPTION_SELECTION.FIXED, index });
    assert.equal(optionSelectionToDialectIndex(selection), index);
  }
});

test('random and fixed zero stay distinct selections', () => {
  assert.notDeepEqual(parseOptionSelection(-1), parseOptionSelection(0));
});

test('a value below minus one is not a selection of the dialect', () => {
  for (const raw of [-2, -1000]) {
    assert.equal(parseOptionSelection(raw), null);
  }
  assert.equal(parseOptionSelection(1.5), null);
  assert.equal(parseOptionSelection('0'), null);
  assert.equal(parseOptionSelection(undefined), null);
});

test('candidates describe every reachable option without drawing', () => {
  assert.deepEqual(optionSelectionCandidates(parseOptionSelection(-1), 3), [0, 1, 2]);
  assert.deepEqual(optionSelectionCandidates(parseOptionSelection(1), 3), [1]);
  assert.deepEqual(optionSelectionCandidates(parseOptionSelection(3), 3), []);
  assert.deepEqual(optionSelectionCandidates(parseOptionSelection(-1), 0), []);
});

test('bounds follow GVI-009 without any maximum option count', () => {
  assert.equal(optionSelectionIsWithinBounds(parseOptionSelection(-1), 1), true);
  assert.equal(optionSelectionIsWithinBounds(parseOptionSelection(-1), 0), false);
  assert.equal(optionSelectionIsWithinBounds(parseOptionSelection(0), 0), false);
  assert.equal(optionSelectionIsWithinBounds(parseOptionSelection(100), 101), true);
});

test('a random selection draws once per entry', () => {
  const source = sequenceDrawSource([2, 0, 1]);
  const selection = parseOptionSelection(-1);
  assert.equal(selectInitialOption(selection, 3, source), 2);
  assert.equal(selectInitialOption(selection, 3, source), 0);
  assert.equal(selectInitialOption(selection, 3, source), 1);
  assert.equal(source.drawCount(), 3);
});

test('a fixed selection never draws', () => {
  const source = sequenceDrawSource([2]);
  assert.equal(selectInitialOption(parseOptionSelection(1), 3, source), 1);
  assert.equal(source.drawCount(), 0);
});

test('a single option action resolves to that option for both selections', () => {
  const source = sequenceDrawSource([7]);
  assert.equal(selectInitialOption(parseOptionSelection(-1), 1, source), 0);
  assert.equal(selectInitialOption(parseOptionSelection(0), 1, source), 0);
});

test('an unselectable selection yields nothing instead of option zero', () => {
  const source = sequenceDrawSource([0]);
  assert.equal(selectInitialOption(parseOptionSelection(-1), 0, source), null);
  assert.equal(selectInitialOption(parseOptionSelection(4), 2, source), null);
  assert.equal(source.drawCount(), 0);
});

test('the default draw source stays inside the option bounds', () => {
  for (const value of [0, 0.4999, 0.5, 0.999999, 1]) {
    const draw = createOptionDrawSource(() => value)(2);
    assert.ok(draw >= 0 && draw < 2, `tirage hors bornes pour ${value}`);
  }
});

test('a random transition reaches a different destination on each entry', () => {
  const action = { id: 'choice', options: ['left', 'right'] };
  const source = sequenceDrawSource([1, 0]);
  assert.deepEqual(
    resolveTransitionEntry({ actionNode: 'choice', optionIndex: -1 }, action, source),
    { index: 1, target: 'right' },
  );
  assert.deepEqual(
    resolveTransitionEntry({ actionNode: 'choice', optionIndex: -1 }, action, source),
    { index: 0, target: 'left' },
  );
});

test('a random transition never falls back to option zero on an empty action', () => {
  const source = sequenceDrawSource([0]);
  assert.equal(
    resolveTransitionEntry({ actionNode: 'empty', optionIndex: -1 }, { options: [] }, source),
    null,
  );
});

test('a null option target is not resolved into a destination', () => {
  const source = sequenceDrawSource([1]);
  assert.equal(
    resolveTransitionEntry(
      { actionNode: 'choice', optionIndex: 1 },
      { options: ['left', null] },
      source,
    ),
    null,
  );
});

test('an out of range fixed selection resolves to nothing rather than the last option', () => {
  const source = sequenceDrawSource([0]);
  assert.equal(
    resolveTransitionEntry(
      { actionNode: 'choice', optionIndex: 5 },
      { options: ['left', 'right'] },
      source,
    ),
    null,
  );
});

// Exécute l'entrée réelle et l'avance autoplay réelle, sans React ni audio.
// La séquence [1, 0] révèle tout tirage consommé puis abandonné à l'ouverture.
//
// Le calcul de l'Écran de départ est `resolveInitialStage`, appelé ici tel
// quel. L'avance autoplay, elle, vit dans le composant et reste lue dans sa
// source — c'est ce qui prouve que **le simulateur** consulte le tirage à
// chaque entrée, pas seulement qu'une fonction de tirage existe quelque part.
test('project simulator enters a random autoplay action exactly once', () => {
  const source = fs.readFileSync(new URL('../src/tabs/EmulatorTab/FlatSimulator.jsx', import.meta.url), 'utf8');
  const advanceBlock = source.slice(source.indexOf('    function advance() {'), source.indexOf('\n    // Pas d\'audio'));
  assert.ok(advanceBlock.includes('resolveTransitionEntry'));
  assert.ok(advanceBlock.includes('optionDrawRef.current'));
  const stage = (uuid, autoplay, actionNode, optionIndex = 0) => ({ uuid, squareOne: uuid === 'root',
    controlSettings: { wheel:false, ok:true, home:false, pause:false, autoplay },
    okTransition: actionNode ? { actionNode, optionIndex } : null });
  const story = {stageNodes:[stage('root',false,'start'),stage('intermediate',true,'random',-1),
    stage('terminal',false,null),stage('autoplay-target',true,null)],
    actionNodes:[{id:'start',options:['intermediate']},{id:'random',options:['terminal','autoplay-target']}]};
  let draws = 0;
  const observedDraws = [];
  const optionDrawRef = { current: () => { const draw = [1,0][draws++]; observedDraws.push(draw); return draw; } };

  const graph = packFlatGraph(story, null);
  const initial = resolveInitialStage(graph, { skipEntry: true, drawSource: optionDrawRef.current });
  // L'ouverture atteint la liste d'histoires sans consommer de tirage : le saut
  // de confort ne traverse qu'une sélection fixe.
  assert.deepEqual({ stageId: initial.stageId, draws }, { stageId: 'intermediate', draws: 0 });

  let currentStageId = initial.stageId;
  let context = initial.context;
  const setStageId = value => {currentStageId=value;};
  const setContext = value => {context=value;};
  const advance = new Function('mountedRef','t','graph','resolveTransitionEntry','optionDrawRef','setStageId','setContext',
    advanceBlock+'\nreturn advance;')({current:true},graph.stages.get(currentStageId).okTransition,
      graph,resolveTransitionEntry,optionDrawRef,setStageId,setContext);
  advance();

  assert.equal(currentStageId, 'autoplay-target');
  assert.deepEqual(context, { actionNodeId: 'random', optionIdx: 1, slot: 'ok' });
  assert.deepEqual(observedDraws, [1]);
});
