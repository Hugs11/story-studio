import test from 'node:test';
import assert from 'node:assert/strict';
import { ADVANCED_EXAMPLES, createAdvancedExample } from '../src/store/advancedExamples/catalog.js';
import { packFlatGraph, resolveInitialStage } from '../src/tabs/EmulatorTab/flatGraph.js';
import { resolveTransitionEntry } from '../src/store/optionSelection.js';
import { exampleBuilder } from '../src/store/advancedExamples/exampleBuilder.js';

test('un choix ne peut être muet et une fin audible peut attendre OK', () => {
  const builder = exampleBuilder('test', 'Test', 'Test');
  assert.throws(() => builder.stage('Choisir', 0, 0, { role: 'choice', audio: false }), /écouté/);
  const end = builder.stage('Fin de l’histoire. Appuie sur OK pour revenir au menu.', 0, 0,
    { controls: { autoplay: false } });
  assert.equal(builder.stages[end].mediaIntent.audio, true);
  assert.equal(builder.stages[end].controls.autoplay, false);
  assert.equal(builder.stages[end].controls.ok, true);
});

// Le même dialecte que le simulateur, sans parser le payload opaque d'auteur.
function simulation(example) {
  const stageNodes = example.stages.map((stage, rank) => ({
    uuid: `screen-${rank}`, name: stage.name, squareOne: rank === example.entryRank,
    controlSettings: stage.controls, audio: null, image: null,
  }));
  const actionNodes = example.actions.map((action, rank) => ({
    id: `action-${rank}`, options: action.options.map((option) => `screen-${option.stage}`),
  }));
  example.transitions.forEach((transition) => {
    stageNodes[transition.stage][`${transition.slot}Transition`] = {
      actionNode: `action-${transition.action}`, optionIndex: transition.optionIndex,
    };
  });
  return packFlatGraph({ stageNodes, actionNodes, title: example.title }, null);
}

function transitionFor(example, stage, slot = 'ok') {
  return example.transitions.find((transition) => transition.stage === stage && transition.slot === slot);
}

test('cinq scénarios complets, métadonnées exactes et nouvelles descriptions à chaque insertion', () => {
  assert.equal(ADVANCED_EXAMPLES.length, 5);
  assert.equal(new Set(ADVANCED_EXAMPLES.map((entry) => entry.id)).size, 5);
  for (const metadata of ADVANCED_EXAMPLES) {
    const first = createAdvancedExample(metadata.id);
    const next = createAdvancedExample(metadata.id);
    assert.deepEqual(first, next);
    assert.equal(first.stages.length, metadata.stageCount);
    assert.equal(first.actions.length, metadata.actionCount);
    assert.ok(first.stages.length >= 30 && first.stages.length <= 70);
    first.stages[0].name = 'Modifié dans le projet';
    first.stages[0].mediaIntent.audio = false;
    first.actions[0].options[0].stage = -1;
    assert.deepEqual(createAdvancedExample(metadata.id), next);
  }
  assert.throws(() => createAdvancedExample('absent'), RangeError);
  assert.throws(() => createAdvancedExample('toString'), RangeError);
});

for (const metadata of ADVANCED_EXAMPLES) {
  test(`${metadata.id} : navigation fermée, entrée protégée, retours sans boucle et roues jouables`, () => {
    const example = createAdvancedExample(metadata.id);
    const graph = simulation(example);
    assert.deepEqual(resolveInitialStage(graph), { stageId: 'screen-0', context: null });
    const introduction = resolveInitialStage(graph, { skipEntry: true });
    assert.equal(introduction.stageId, 'screen-2', 'sauter le titre conserve le contexte narratif');
    assert.equal(graph.stages.get(introduction.stageId).controlSettings.autoplay, true);

    const usedSlots = new Set();
    example.transitions.forEach((transition) => {
      assert.ok(example.stages[transition.stage]);
      const action = example.actions[transition.action];
      assert.ok(action);
      assert.ok(['ok', 'home'].includes(transition.slot));
      const key = `${transition.stage}:${transition.slot}`;
      assert.ok(!usedSlots.has(key), `Une seule transition ${key}`);
      usedSlots.add(key);
      const resolved = resolveTransitionEntry(
        { optionIndex: transition.optionIndex },
        { options: action.options.map((option) => String(option.stage)) },
      );
      assert.ok(resolved);
      assert.notEqual(Number(resolved.target), transition.stage, 'Accueil et OK ne reviennent pas au même Écran');
      assert.notEqual(Number(resolved.target), example.entryRank, 'L’entrée ne devient jamais une option');
      assert.equal(example.stages[transition.stage].controls[transition.slot], true);
    });
    example.actions.forEach((action) => {
      assert.ok(action.options.length > 0);
      action.options.forEach((option, index) => {
        assert.equal(option.target, 'stage');
        assert.ok(example.stages[option.stage]);
        assert.notEqual(option.stage, example.entryRank);
        assert.equal(Number(resolveTransitionEntry({ optionIndex: index }, { options: action.options.map((target) => String(target.stage)) }).target), option.stage);
        if (action.options.length > 1) {
          assert.equal(example.stages[option.stage].mediaIntent.audio, true, 'Chaque choix de roue est audible');
          assert.equal(example.stages[option.stage].controls.wheel, true, 'Une option de roue laisse tourner vers ses voisines');
          assert.equal(example.stages[option.stage].controls.autoplay, false, 'Le choix attend une validation');
        }
      });
    });
    // Tout le scénario est atteignable depuis son entrée, y compris les choix
    // que la molette visite après le premier rang d'une liste.
    const reachable = new Set([example.entryRank]);
    const pending = [example.entryRank];
    while (pending.length) {
      const stage = pending.pop();
      for (const transition of example.transitions.filter((candidate) => candidate.stage === stage && candidate.slot === 'ok')) {
        for (const option of example.actions[transition.action].options) {
          if (!reachable.has(option.stage)) { reachable.add(option.stage); pending.push(option.stage); }
        }
      }
    }
    assert.equal(reachable.size, example.stages.length, 'Aucun Écran oublié dans la composition');
    example.stages.forEach((_, rank) => assert.ok(transitionFor(example, rank), 'Chaque Écran propose une suite ou un retour'));
  });

  test(`${metadata.id} : noms parlables, intentions médias et positions d’auteur lisibles`, () => {
    const example = createAdvancedExample(metadata.id);
    const nodes = [...example.stages, ...example.actions];
    assert.equal(new Set(example.actions.map((action) => action.name)).size, example.actions.length,
      'Chaque Action est nommée selon son sujet et sa branche');
    nodes.forEach((node) => {
      assert.ok(typeof node.name === 'string' && node.name.trim().length > 0);
      assert.ok(node.name.length <= 150, 'Le nom raconte une étape courte');
      assert.ok(!/^(?:Stage|Action node|Écran) \d+$/.test(node.name));
      assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/i.test(node.name));
      assert.ok(Number.isFinite(node.offset.x) && Number.isFinite(node.offset.y));
      assert.ok(Math.abs(node.offset.x) < 32000 && Math.abs(node.offset.y) < 32000);
    });
    example.stages.forEach((stage) => {
      assert.equal(stage.audio, null);
      assert.equal(stage.image, null);
      assert.deepEqual(Object.keys(stage.mediaIntent).sort(), ['audio', 'image']);
      assert.equal(typeof stage.mediaIntent.audio, 'boolean');
      assert.equal(typeof stage.mediaIntent.image, 'boolean');
      assert.deepEqual(Object.keys(stage.controls).sort(), ['autoplay', 'home', 'ok', 'pause', 'wheel']);
      if (!stage.mediaIntent.audio) {
        assert.equal(stage.controls.autoplay, false, 'Le silence attend OK et ne dépend pas de la fin d’un audio');
        assert.equal(stage.controls.pause, false);
      }
    });
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const a = nodes[left].offset;
        const b = nodes[right].offset;
        assert.ok(Math.abs(a.x - b.x) >= 240 || Math.abs(a.y - b.y) >= 180,
          `Les noms de « ${nodes[left].name} » et « ${nodes[right].name} » se superposent`);
      }
    }
  });
}

test('le catalogue propose des illustrations sélectives et une grande roue de onze choix audibles', () => {
  const stages = ADVANCED_EXAMPLES.flatMap(({ id }) => createAdvancedExample(id).stages);
  assert(stages.some(({ mediaIntent }) => mediaIntent.image));
  assert(stages.some(({ mediaIntent }) => !mediaIntent.image && mediaIntent.audio));
  const train = createAdvancedExample('explorer-train');
  const wheel = train.actions.find((action) => action.options.length === 11);
  assert(wheel);
  assert(wheel.options.every(({ stage }) => train.stages[stage].mediaIntent.audio));
});

test('les menus nomment le type de parcours et une introduction distincte précède le menu', () => {
  for (const { id } of ADVANCED_EXAMPLES) {
    const example = createAdvancedExample(id);
    const menu = example.stages[1];
    // Le menu est prononcé à l'enfant à chaque retour : une consigne courte
    // qui invite à tourner la roue, distincte du titre de l'entrée.
    assert.match(menu.name, /\broue\b/u);
    assert.doesNotMatch(menu.name, /—|Histoire à choix multiples|^Quiz\b/u);
    assert.notEqual(menu.name, example.stages[0].name);
    assert(menu.name.length <= 90);
    assert(!example.stages.some((stage) => /je suis (le menu|l’histoire|le choix)/iu.test(stage.name)));
    const firstAction = example.actions[transitionFor(example, 0).action];
    assert.equal(firstAction.options.length, 1);
    const introRank = firstAction.options[0].stage;
    assert.notEqual(introRank, 1, 'l’entrée donne le contexte avant le menu court');
    assert.equal(example.stages[introRank].mediaIntent.audio, true);
    assert.deepEqual(example.actions[transitionFor(example, introRank).action].options,
      [{ target: 'stage', stage: 1 }]);
    assert.equal(example.stages[introRank].controls.autoplay, true);
  }
});

test('au phare, seuls les chemins qui prennent la corde proposent de l’utiliser', () => {
  const example = createAdvancedExample('lighthouse');
  const next = (rank) => example.actions[transitionFor(example, rank).action].options.map(({ stage }) => stage);
  const take = example.stages.findIndex(({ name }) => name === 'Prendre la corde.');
  const leave = example.stages.findIndex(({ name }) => name === 'Laisser la corde à l’abri.');
  assert(take >= 0 && leave >= 0);
  const problemWith = next(next(take)[0])[0];
  const problemWithout = next(next(leave)[0])[0];
  assert.notEqual(problemWith, problemWithout, 'les scènes conservent la disponibilité de la corde');
  assert.deepEqual(next(problemWith).map((rank) => example.stages[rank].name),
    ['Tirer la trappe avec la corde.', 'Soulever la trappe avec Luc.']);
  assert.deepEqual(next(problemWithout).map((rank) => example.stages[rank].name),
    ['Soulever la trappe avec Luc.']);
});

test('les fins annonçant OK attendent cet appui et reviennent directement au menu', () => {
  let endings = 0;
  for (const { id } of ADVANCED_EXAMPLES) {
    const example = createAdvancedExample(id);
    example.stages.forEach((stage, rank) => {
      if (!/appuie sur OK/iu.test(stage.name)) return;
      endings += 1;
      assert.equal(stage.mediaIntent.audio, true);
      assert.equal(stage.controls.autoplay, false);
      assert.deepEqual(example.actions[transitionFor(example, rank).action].options,
        [{ target: 'stage', stage: 1 }], 'un seul OK mène au menu, sans pont supplémentaire');
    });
  }
  assert.equal(endings, 6);
});
