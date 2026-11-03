import test from 'node:test';
import assert from 'node:assert/strict';
import { ADVANCED_EXAMPLES, createAdvancedExample } from '../src/store/advancedExamples/catalog.js';
import { packFlatGraph, resolveInitialStage } from '../src/tabs/EmulatorTab/flatGraph.js';
import { resolveTransitionEntry } from '../src/store/optionSelection.js';

// Interprétation de la description déclarative seulement, sans se substituer
// au collage natif. Le harness advancedExamplesNative.mjs valide séparément
// les vrais DTO et copies d'export ; ici on exerce les parcours de lecture.
function describedGraph(example) {
  const stages = example.stages.map((stage, rank) => ({
    uuid: `stage-${rank}`, name: stage.name, squareOne: rank === example.entryRank,
    controlSettings: stage.controls,
  }));
  const actions = example.actions.map((action, rank) => ({
    id: `action-${rank}`, options: action.options.map((option) => `stage-${option.stage}`),
  }));
  for (const transition of example.transitions) {
    stages[transition.stage][`${transition.slot}Transition`] = {
      actionNode: actions[transition.action].id, optionIndex: transition.optionIndex,
    };
  }
  return packFlatGraph({ title: example.title, stageNodes: stages, actionNodes: actions }, null);
}

function destinations(graph, stage, slot = 'ok') {
  const transition = stage[`${slot}Transition`];
  if (!transition) return [];
  const action = graph.actions.get(transition.actionNode);
  const first = resolveTransitionEntry(transition, action, () => 0);
  assert(first, `Transition de ${stage.name} résoluble`);
  // Après entrée dans une Action, tourner la molette expose chaque option de
  // cette Action ; cela reste la même liste, même si l'Écran est partagé.
  return action.options.map((target) => graph.stages.get(target));
}

for (const metadata of ADVANCED_EXAMPLES) {
  test(`${metadata.title}: l’entrée, les roues et les retours forment une aventure jouable`, () => {
    const example = createAdvancedExample(metadata.id);
    const graph = describedGraph(example);
    const initial = resolveInitialStage(graph);
    assert.equal(initial.stageId, graph.entryId);
    assert.equal(initial.context, null);
    const entry = graph.stages.get(initial.stageId);
    assert.equal(entry.controlSettings.home, false);
    const reached = new Set([entry.id]);
    const queue = [entry];
    while (queue.length) {
      const current = queue.shift();
      const next = destinations(graph, current);
      for (const target of next) {
        assert(target, `${current.name}: aucune destination manquante`);
        assert.notEqual(target.id, graph.entryId, 'l’entrée ne devient jamais destination');
        if (current.controlSettings.ok || current.controlSettings.autoplay) {
          if (!reached.has(target.id)) { reached.add(target.id); queue.push(target); }
        }
      }
    }
    assert.equal(reached.size, graph.stages.size, 'tous les Écrans sont accessibles depuis le début');
    for (const current of graph.stages.values()) {
      if (current.controlSettings.autoplay) {
        assert(example.stages[Number(current.id.slice(6))].mediaIntent.audio, 'autoplay possède une intention audio');
        assert(current.okTransition, 'la fin audio poursuit l’aventure');
      }
      for (const target of destinations(graph, current, 'home')) {
        assert.notEqual(target.id, current.id, 'Accueil ne revient pas sur son propre Écran');
        assert.notEqual(target.id, graph.entryId, 'Accueil emploie le menu intermédiaire');
      }
      assert(current.name.trim());
      assert(!/sans titre|^[a-f\d]{8}-/i.test(current.name));
    }
  });
}

test('les quiz et défis permettent de réécouter chaque question après erreur et retrouver le menu après réussite', () => {
  for (const metadata of ADVANCED_EXAMPLES.filter((entry) => entry.id.includes('quiz') || entry.id === 'explorer-train')) {
    const example = createAdvancedExample(metadata.id);
    const graph = describedGraph(example);
    // Un retour de quiz est l'Écran atteint par OK depuis une réponse d'une
    // liste « Réponses… ».
    const answers = example.actions.filter((action) => action.name.startsWith('Réponses'))
      .flatMap((action) => action.options.map(({ stage }) => stage));
    const feedback = answers.map((answer) => {
      const transition = example.transitions.find((candidate) => candidate.stage === answer && candidate.slot === 'ok');
      return { rank: example.actions[transition.action].options[0].stage };
    });
    const answerCount = metadata.id === 'explorer-train' ? 2 : 3;
    assert(feedback.length >= 10, 'plusieurs questions et plusieurs réponses commentées');
    let retries = 0;
    let successes = 0;
    for (const stage of feedback) {
      const next = destinations(graph, graph.stages.get(`stage-${stage.rank}`));
      if (graph.stages.get(`stage-${stage.rank}`).okTransition.actionNode === graph.stages.get('stage-1').okTransition.actionNode) {
        successes += 1;
        assert.equal(graph.stages.get(`stage-${stage.rank}`).okTransition.actionNode,
          graph.stages.get('stage-1').okTransition.actionNode, 'réussite : retour à la roue des sujets');
      } else {
        retries += 1;
        assert.equal(next.length, 1, 'une erreur fait réécouter une question unique');
        assert.equal(next[0].controlSettings.autoplay, true, 'la question est relue avant les réponses');
        const answers = destinations(graph, next[0]);
        assert.equal(answers.length, answerCount);
        assert(answers.every((target) => target.controlSettings.wheel));
        assert(answers.some((target) => destinations(graph, target).some((result) => result.id === `stage-${stage.rank}`)),
          'la question réécoutée est celle de cette erreur');
      }
    }
    assert(successes >= 4);
    assert.equal(retries, successes * (answerCount - 1));
  }
});

test('le catalogue contient des grands choix et de vraies convergences de chemins', () => {
  const examples = ADVANCED_EXAMPLES.map(({ id }) => createAdvancedExample(id));
  assert(examples.some((example) => example.actions.some((action) => action.options.length >= 7)), 'une grande roue complète');
  assert(examples.some((example) => {
    const incoming = new Map();
    example.actions.forEach((action) => action.options.forEach(({ stage }) => {
      incoming.set(stage, (incoming.get(stage) ?? 0) + 1);
    }));
    return [...incoming].some(([rank, count]) => rank > 1 && count >= 2);
  }), 'une scène narrative est partagée par plusieurs chemins');
});
