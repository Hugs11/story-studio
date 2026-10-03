// La seconde source du simulateur de graphe à plat.
//
// Tout est **pur** : aucun composant React n'est monté, aucun octet n'est lu,
// aucune archive n'est produite. La preuve centrale ne demande rien de
// tout cela — elle demande que **deux provenances résolvent la même
// navigation**, et deux graphes bâtis dans la même forme se comparent nœud à
// nœud.
//
// Le couple de fixtures ci-dessous décrit **un seul document**, écrit deux fois :
// une fois comme la vue le rend (le projet en cours), une fois comme l'archive
// produite le rendrait (le `story.json` que relit `load_pack_zip`). Les deux
// n'ont ni les mêmes clés — chemin d'un côté, `uuid` de l'autre — ni le même
// transport média — disque d'un côté, asset d'archive de l'autre. Ce qu'ils
// partagent est ce qui compte : l'identifiant source d'un Écran, et la
// **référence** du média qu'il désigne.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  documentFlatGraph,
  mediaRequestKey,
  packFlatGraph,
  projectedFlatGraph,
  resolveInitialStage,
  MEDIA_FROM_DISK,
  MEDIA_FROM_PACK,
  PROJECTED_MISSING_ASSET,
} from '../src/tabs/EmulatorTab/flatGraph.js';
import { startStageForEntry } from '../src/hooks/useProjectedSimulation.js';
import { resolveTransitionEntry } from '../src/store/optionSelection.js';
import { presence } from './advancedViewFixtures.mjs';

// ── Le document d'essai, écrit deux fois ─────────────────────────────────────
//
// Un carrefour aléatoire à trois options dont deux visent le **même** Écran :
// un nœud partagé, et une Action qu'aucune déduplication ne doit réduire. Une
// boucle ramène à l'entrée. Deux fichiers **homonymes** venus de deux dossiers
// portent deux références distinctes : elles ne doivent jamais fusionner.

const STAGE_PATH = (uuid) => `/stageNodes/@uuid=${uuid}#0`;
const ACTION_PATH = (id) => `/actionNodes/@id=${id}#0`;

const CONTROLS = { wheel: true, ok: true, home: true, pause: false, autoplay: false };

function viewControls(values = CONTROLS) {
  return {
    presence: 'value',
    wheel: presence(values.wheel),
    ok: presence(values.ok),
    home: presence(values.home),
    pause: presence(values.pause),
    autoplay: presence(values.autoplay),
    complete: true,
  };
}

function viewTransition(actionId, selection) {
  return {
    presence: 'value',
    actionId,
    actionPath: ACTION_PATH(actionId),
    selection,
    withinBounds: true,
    selectedOptionId: null,
    resolvedStagePath: null,
  };
}

const ABSENT_TRANSITION = {
  presence: 'absent',
  actionId: null,
  actionPath: null,
  selection: null,
  withinBounds: false,
  selectedOptionId: null,
  resolvedStagePath: null,
};

function viewStage(uuid, overrides = {}) {
  return {
    path: STAGE_PATH(uuid),
    uuid,
    occurrence: 0,
    uniqueId: true,
    name: presence(uuid),
    fallbackLabel: '',
    stageType: presence(undefined),
    squareOne: presence(undefined),
    groupId: presence(undefined),
    controls: viewControls(),
    audio: { presence: 'absent', assetRef: null },
    image: { presence: 'absent', assetRef: null },
    okTransition: ABSENT_TRANSITION,
    homeTransition: ABSENT_TRANSITION,
    sourcePosition: null,
    layout: { x: 0, y: 0, source: 'fallback', origin: null },
    provenance: { uuid: 'source-studio', name: 'source-studio', position: 'source-studio' },
    ...overrides,
  };
}

function viewAction(id, targets) {
  return {
    path: ACTION_PATH(id),
    id,
    occurrence: 0,
    uniqueId: true,
    name: presence(undefined),
    fallbackLabel: 'Action node',
    actionType: presence(undefined),
    groupId: presence(undefined),
    options: targets.map((target, ordinal) => ({
      optionId: `${ACTION_PATH(id)}/options#${ordinal}`,
      ordinal,
      target: {
        presence: target === null ? 'null' : 'value',
        stageUuid: target,
        stagePath: target === null ? null : STAGE_PATH(target),
        dangling: target === null,
      },
    })),
    sourcePosition: null,
    layout: { x: 0, y: 96, source: 'fallback', origin: null },
    provenance: { id: 'source-studio', name: 'source-studio', position: 'source-studio' },
  };
}

const RANDOM = { kind: 'random' };
const FIXED = (index) => ({ kind: 'fixed', index });

function documentView() {
  return {
    viewVersion: 1,
    documentFingerprint: 'sha256:essai',
    documentOrigin: 'imported-studio',
    defaultValueOrigin: 'source-studio',
    packIdentity: { origin: 'square-one-stage', value: 'pack-essai' },
    metadata: {
      title: presence('Le carrefour'),
      version: presence(1),
      description: presence(undefined),
      uuid: presence(undefined),
    },
    entry: { status: 'unique', stagePath: STAGE_PATH('entree'), candidates: [STAGE_PATH('entree')] },
    counts: { stages: 3, actions: 2, options: 4, edges: 6 },
    stages: [
      viewStage('entree', {
        squareOne: presence(true),
        audio: { presence: 'value', assetRef: 'aaa.mp3' },
        image: { presence: 'value', assetRef: 'bbb.png' },
        okTransition: viewTransition('carrefour', RANDOM),
      }),
      viewStage('gauche', {
        audio: { presence: 'value', assetRef: 'ccc.flac' },
        okTransition: viewTransition('retour', FIXED(0)),
        homeTransition: viewTransition('retour', FIXED(0)),
      }),
      viewStage('droite', {
        audio: { presence: 'value', assetRef: 'ddd.flac' },
        okTransition: viewTransition('retour', FIXED(0)),
      }),
    ],
    actions: [
      viewAction('carrefour', ['gauche', 'droite', 'gauche']),
      viewAction('retour', ['entree']),
    ],
    edges: [],
    mediaRefs: [
      { assetRef: 'aaa.mp3', usages: [{ nodePath: STAGE_PATH('entree'), field: 'audio' }] },
      { assetRef: 'bbb.png', usages: [{ nodePath: STAGE_PATH('entree'), field: 'image' }] },
      { assetRef: 'ccc.flac', usages: [{ nodePath: STAGE_PATH('gauche'), field: 'audio' }] },
      { assetRef: 'ddd.flac', usages: [{ nodePath: STAGE_PATH('droite'), field: 'audio' }] },
    ],
    groups: [],
    opaqueMembers: [],
    diagnostics: [],
  };
}

// Deux fichiers de **même nom** dans deux dossiers, sous deux références
// distinctes : c'est le cas que la jointure par `assetRef` doit tenir.
function documentProject() {
  return {
    authoring: {
      mediaBindings: [
        { assetRef: 'aaa.mp3', path: '/travail/intro.mp3', status: 'resolved' },
        { assetRef: 'bbb.png', path: '/travail/couverture.png', status: 'resolved' },
        { assetRef: 'ccc.flac', path: '/travail/a/voix.flac', status: 'resolved' },
        { assetRef: 'ddd.flac', path: '/travail/b/voix.flac', status: 'resolved' },
      ],
    },
  };
}

// Le même document, tel que l'archive produite le rendrait. Les Écrans y sont
// identifiés par `uuid`, les médias par leur nom d'asset — qui **est** la
// référence du dialecte, et c'est ce qui rend la comparaison possible.
function packStory() {
  const stage = (uuid, overrides) => ({
    uuid,
    name: uuid,
    controlSettings: { ...CONTROLS },
    ...overrides,
  });
  return {
    title: 'Le carrefour',
    stageNodes: [
      stage('entree', {
        squareOne: true,
        audio: 'aaa.mp3',
        image: 'bbb.png',
        okTransition: { actionNode: 'carrefour', optionIndex: -1 },
      }),
      stage('gauche', {
        audio: 'ccc.flac',
        okTransition: { actionNode: 'retour', optionIndex: 0 },
        homeTransition: { actionNode: 'retour', optionIndex: 0 },
      }),
      stage('droite', {
        audio: 'ddd.flac',
        okTransition: { actionNode: 'retour', optionIndex: 0 },
      }),
    ],
    actionNodes: [
      { id: 'carrefour', options: ['gauche', 'droite', 'gauche'] },
      { id: 'retour', options: ['entree'] },
    ],
  };
}

// ── L'outillage de parcours ──────────────────────────────────────────────────
//
// Il ne réimplémente **aucune** navigation : il appelle exactement les deux
// fonctions que le simulateur appelle — `resolveInitialStage` à l'ouverture,
// `resolveTransitionEntry` à chaque pression. C'est ce qui rend le parcours
// probant : il exerce le chemin du produit, pas une copie d'essai.

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

// L'état visible d'un Écran, dans les termes que **les deux sources partagent**.
// Le chemin disque et le nom d'asset n'en font pas partie : ils diffèrent par
// construction, et les comparer ferait échouer une simulation parfaitement
// fidèle. La référence, elle, est commune.
function observe(graph, stageId) {
  const stage = graph.stages.get(stageId);
  if (!stage) return { uuid: null };
  return {
    uuid: stage.uuid,
    audio: stage.audio?.assetRef ?? null,
    image: stage.image?.assetRef ?? null,
    ok: stage.controlSettings?.ok === true,
    home: stage.controlSettings?.home === true,
    options: stage.okTransition
      ? (graph.actions.get(stage.okTransition.actionNode)?.options ?? []).length
      : 0,
  };
}

function walk(graph, presses, drawSource) {
  const initial = resolveInitialStage(graph, { drawSource });
  let stageId = initial.stageId;
  const steps = [observe(graph, stageId)];
  for (const press of presses) {
    const stage = graph.stages.get(stageId);
    const transition = press === 'home' ? stage?.homeTransition : stage?.okTransition;
    const entry = transition
      ? resolveTransitionEntry(transition, graph.actions.get(transition.actionNode), drawSource)
      : null;
    if (entry) stageId = entry.target;
    steps.push(observe(graph, stageId));
  }
  return steps;
}

// ── La preuve centrale ───────────────────────────────────────────────────────

test('le projet en cours et le même projet exporté résolvent la même navigation', () => {
  const fromDocument = documentFlatGraph(documentView(), documentProject());
  const fromPack = packFlatGraph(packStory(), '/sortie/pack.zip');

  const presses = ['ok', 'ok', 'ok', 'ok', 'ok', 'home', 'ok', 'ok'];
  // La **même** suite de tirages des deux côtés : ce qui est comparé est la
  // résolution, pas le hasard.
  const draws = [0, 2, 1, 0, 2];

  assert.deepEqual(
    walk(fromDocument, presses, sequenceDrawSource(draws)),
    walk(fromPack, presses, sequenceDrawSource(draws)),
  );
});

// Le témoin négatif de la comparaison ci-dessus. Sans lui, un parcours qui
// n'observerait rien la satisferait tout autant : une suite de neuf `null`
// est égale à une suite de neuf `null`.
test('la comparaison des deux sources détecte une divergence', () => {
  const view = documentView();
  // Une seule option permutée dans le carrefour : la plus petite divergence de
  // navigation qu'un document puisse porter.
  view.actions[0] = viewAction('carrefour', ['droite', 'gauche', 'gauche']);
  const fromDocument = documentFlatGraph(view, documentProject());
  const fromPack = packFlatGraph(packStory(), '/sortie/pack.zip');

  const presses = ['ok', 'ok', 'ok', 'ok', 'ok', 'home', 'ok', 'ok'];
  const draws = [0, 2, 1, 0, 2];
  assert.notDeepEqual(
    walk(fromDocument, presses, sequenceDrawSource(draws)),
    walk(fromPack, presses, sequenceDrawSource(draws)),
  );

  // Et un média échangé se voit aussi : la comparaison porte sur la référence,
  // pas seulement sur l'enchaînement des Écrans.
  const swapped = documentView();
  swapped.stages[1].audio = { presence: 'value', assetRef: 'ddd.flac' };
  assert.notDeepEqual(
    walk(documentFlatGraph(swapped, documentProject()), presses, sequenceDrawSource(draws)),
    walk(fromPack, presses, sequenceDrawSource(draws)),
  );
});

test('les deux sources partent du même Écran et portent le même titre', () => {
  const fromDocument = documentFlatGraph(documentView(), documentProject());
  const fromPack = packFlatGraph(packStory(), '/sortie/pack.zip');

  assert.equal(fromDocument.stages.get(fromDocument.entryId).uuid, 'entree');
  assert.equal(fromPack.stages.get(fromPack.entryId).uuid, 'entree');
  assert.equal(fromDocument.title, fromPack.title);
  // Les clés diffèrent, et c'est voulu : le dialecte tolère deux Écrans de même
  // `uuid`, un graphe ne tolère pas deux clés identiques.
  assert.equal(fromDocument.entryId, STAGE_PATH('entree'));
  assert.equal(fromPack.entryId, 'entree');
});

test('une transition aléatoire tire à chaque entrée, et deux tirages égaux ne sont pas un échec', () => {
  const graph = documentFlatGraph(documentView(), documentProject());
  const carrefour = graph.stages.get(STAGE_PATH('entree')).okTransition;
  const action = graph.actions.get(carrefour.actionNode);

  // Deux entrées consécutives qui tombent sur la même option : le tirage a bien
  // eu lieu deux fois. C'est le compteur qui le prouve, pas la destination.
  const repeated = sequenceDrawSource([1, 1]);
  const first = resolveTransitionEntry(carrefour, action, repeated);
  const second = resolveTransitionEntry(carrefour, action, repeated);
  assert.deepEqual(first, second);
  assert.equal(repeated.drawCount(), 2);

  // Deux entrées qui tombent ailleurs : la destination change sans que rien
  // d'autre ne change.
  const varied = sequenceDrawSource([0, 1]);
  assert.equal(resolveTransitionEntry(carrefour, action, varied).target, STAGE_PATH('gauche'));
  assert.equal(resolveTransitionEntry(carrefour, action, varied).target, STAGE_PATH('droite'));
});

test('un Écran partagé par plusieurs chemins se joue depuis chacun d’eux', () => {
  const graph = documentFlatGraph(documentView(), documentProject());
  const carrefour = graph.stages.get(STAGE_PATH('entree')).okTransition;
  const action = graph.actions.get(carrefour.actionNode);

  // Deux occurrences visent le même Écran : elles restent **deux** options, à
  // deux rangs distincts. Aucune déduplication par couple source/cible.
  assert.deepEqual(action.options, [STAGE_PATH('gauche'), STAGE_PATH('droite'), STAGE_PATH('gauche')]);
  for (const draw of [0, 2]) {
    const entry = resolveTransitionEntry(carrefour, action, sequenceDrawSource([draw]));
    assert.equal(entry.index, draw);
    assert.equal(graph.stages.get(entry.target).uuid, 'gauche');
    assert.equal(graph.stages.get(entry.target).audio.assetRef, 'ccc.flac');
  }
});

// ── Les médias ───────────────────────────────────────────────────────────────

test('la jointure média est exacte : deux fichiers homonymes ne fusionnent pas', () => {
  const graph = documentFlatGraph(documentView(), documentProject());
  const gauche = graph.stages.get(STAGE_PATH('gauche'));
  const droite = graph.stages.get(STAGE_PATH('droite'));

  assert.deepEqual(gauche.audio, { kind: MEDIA_FROM_DISK, assetRef: 'ccc.flac', path: '/travail/a/voix.flac' });
  assert.deepEqual(droite.audio, { kind: MEDIA_FROM_DISK, assetRef: 'ddd.flac', path: '/travail/b/voix.flac' });
  assert.notEqual(mediaRequestKey(gauche.audio), mediaRequestKey(droite.audio));
});

test('l’archive exportée reste lue par son transport d’archive', () => {
  const graph = packFlatGraph(packStory(), '/sortie/pack.zip');
  const entree = graph.stages.get('entree');
  assert.deepEqual(entree.audio, {
    kind: MEDIA_FROM_PACK,
    assetRef: 'aaa.mp3',
    assetName: 'assets/aaa.mp3',
    zipPath: '/sortie/pack.zip',
  });
  assert.equal(entree.image.assetName, 'assets/bbb.png');
  assert.equal(mediaRequestKey(entree.audio), 'pack:/sortie/pack.zip:assets/aaa.mp3');
});

test('une référence qu’aucun fichier ne résout se joue en silence et se compte une fois', () => {
  const view = documentView();
  // Le même média manquant employé par deux Écrans : une **référence**
  // introuvable, pas deux.
  view.stages[1].audio = { presence: 'value', assetRef: 'perdu.mp3' };
  view.stages[2].audio = { presence: 'value', assetRef: 'perdu.mp3' };
  const graph = documentFlatGraph(view, documentProject());

  assert.equal(graph.stages.get(STAGE_PATH('gauche')).audio, null);
  assert.equal(graph.stages.get(STAGE_PATH('droite')).audio, null);
  assert.equal(graph.readiness.unresolvedMedia, 1);
});

test('une liaison sans chemin vaut une référence introuvable, pas un chemin vide', () => {
  const project = documentProject();
  project.authoring.mediaBindings[2] = { assetRef: 'ccc.flac', path: null, status: 'missing' };
  const graph = documentFlatGraph(documentView(), project);
  assert.equal(graph.stages.get(STAGE_PATH('gauche')).audio, null);
  assert.equal(graph.readiness.unresolvedMedia, 1);
});

// ── Ce qu'un document en cours porte, et qu'une archive ne porte pas ─────────

test('un contrôle que l’auteur n’a pas réglé ne répond pas, et il est compté', () => {
  const view = documentView();
  view.stages[1].controls = {
    presence: 'value',
    wheel: presence(undefined),
    ok: presence(undefined),
    home: presence(null),
    pause: presence(false),
    autoplay: presence(undefined),
    complete: false,
  };
  const graph = documentFlatGraph(view, documentProject());
  const gauche = graph.stages.get(STAGE_PATH('gauche'));

  // Absent, `null` et `false` ne répondent pas — mais aucun n'a été **rendu**
  // comme une valeur d'auteur : la vue les distingue toujours, et c'est le
  // compte d'inachèvement qui le dit à l'auteur.
  assert.deepEqual(gauche.controlSettings, {
    wheel: false, ok: false, home: false, pause: false, autoplay: false,
  });
  assert.equal(graph.readiness.incompleteControls, 1);
});

test('une transition vers une Action introuvable laisse le simulateur sur place', () => {
  const view = documentView();
  view.stages[1].okTransition = {
    ...viewTransition('disparue', FIXED(0)),
    actionPath: null,
    withinBounds: false,
  };
  const graph = documentFlatGraph(view, documentProject());
  const gauche = graph.stages.get(STAGE_PATH('gauche'));

  // Aucune cible de confort n'est inventée : la transition n'existe pas.
  assert.equal(gauche.okTransition, null);
  assert.equal(graph.readiness.danglingTransitions, 1);
});

test('une option pendante garde son rang et ne décale pas les suivantes', () => {
  const view = documentView();
  view.actions[0] = viewAction('carrefour', ['gauche', null, 'droite']);
  const graph = documentFlatGraph(view, documentProject());

  assert.deepEqual(
    graph.actions.get(ACTION_PATH('carrefour')).options,
    [STAGE_PATH('gauche'), null, STAGE_PATH('droite')],
  );
  // Le rang 2 désigne toujours « droite » : retirer l'option pendante aurait
  // fait pointer l'`optionIndex` d'auteur ailleurs.
  const fixed = { actionNode: ACTION_PATH('carrefour'), optionIndex: 2 };
  assert.equal(
    resolveTransitionEntry(fixed, graph.actions.get(ACTION_PATH('carrefour')), sequenceDrawSource([0])).target,
    STAGE_PATH('droite'),
  );
  // Et le rang 1 ne mène nulle part plutôt que vers l'option d'à côté.
  assert.equal(
    resolveTransitionEntry({ ...fixed, optionIndex: 1 }, graph.actions.get(ACTION_PATH('carrefour')), sequenceDrawSource([0])),
    null,
  );
});

test('un document sans entrée désignée part de l’Écran choisi par l’auteur', () => {
  const view = documentView();
  view.stages[0].squareOne = presence(undefined);
  view.entry = { status: 'missing', stagePath: null, candidates: [] };
  const graph = documentFlatGraph(view, documentProject());

  assert.equal(graph.entryId, null);
  assert.equal(resolveInitialStage(graph, {}).stageId, null);
  assert.equal(resolveInitialStage(graph, { startId: STAGE_PATH('droite') }).stageId, STAGE_PATH('droite'));
});

test('une écoute lancée sur un Écran retrouve sa liste, pour que la molette la fasse défiler', () => {
  const graph = documentFlatGraph(documentView(), documentProject());
  const { context } = resolveInitialStage(graph, { startId: STAGE_PATH('droite') });
  assert.equal(context.actionNodeId, ACTION_PATH('carrefour'));
  assert.equal(graph.actions.get(context.actionNodeId).options[context.optionIdx], STAGE_PATH('droite'));
  // « gauche » figure deux fois dans le carrefour : sa première place.
  assert.deepEqual(
    resolveInitialStage(graph, { startId: STAGE_PATH('gauche') }).context,
    { actionNodeId: ACTION_PATH('carrefour'), optionIdx: 0 },
  );
  // Un Écran qu'aucune liste ne propose part sans liste.
  const view = documentView();
  view.actions = [view.actions[0]];
  const alone = documentFlatGraph(view, documentProject());
  assert.equal(resolveInitialStage(alone, { startId: STAGE_PATH('entree') }).context, null);
});

test('plusieurs entrées concurrentes ne sont pas rabattues sur la première', () => {
  const view = documentView();
  view.stages[1].squareOne = presence(true);
  view.entry = {
    status: 'ambiguous',
    stagePath: null,
    candidates: [STAGE_PATH('entree'), STAGE_PATH('gauche')],
  };
  const graph = documentFlatGraph(view, documentProject());
  assert.equal(graph.entryId, null);
});

// ── Le simulateur reste un lecteur ───────────────────────────────────────────

test('assembler le graphe ne touche ni la vue ni le projet', () => {
  const view = documentView();
  const project = documentProject();
  const viewBefore = JSON.stringify(view);
  const projectBefore = JSON.stringify(project);

  const graph = documentFlatGraph(view, project);
  // Le graphe est bien construit : la comparaison qui suit n'est pas satisfaite
  // par une sortie vide.
  assert.equal(graph.stages.size, 3);

  assert.equal(JSON.stringify(view), viewBefore);
  assert.equal(JSON.stringify(project), projectBefore);
});

test('un projet sans document d’auteur n’a pas de graphe à jouer', () => {
  assert.equal(documentFlatGraph(null, documentProject()), null);
  // Un projet Libre n'a pas de liaisons : le graphe se bâtit quand même, et ses
  // médias sont simplement introuvables. Aucune branche par type de projet.
  const graph = documentFlatGraph(documentView(), {});
  assert.equal(graph.stages.get(STAGE_PATH('entree')).audio, null);
  assert.equal(graph.readiness.unresolvedMedia, 4);
});

test('une requête média absente n’a pas de clé, et ne relance donc aucune lecture', () => {
  assert.equal(mediaRequestKey(null), '');
  assert.equal(mediaRequestKey(undefined), '');
});

// ── Source 3 : un projet hiérarchique, projeté par le générateur ─────────────
//
// La projection vient de Rust (`project_pack_for_simulation`), qui applique le
// **vrai** générateur. Ces fixtures reproduisent sa sortie : un document du
// dialecte — la même forme qu'une archive produite — et la table qui dit où
// trouver les octets de chaque nom d'asset.
//
// Ce que ces essais prouvent n'est donc pas la navigation : elle est celle du
// générateur, éprouvée côté Rust. C'est la **jointure** — médias, silences,
// et le rattachement d'un Écran au nœud de l'arbre dont il vient.

function projectionFixture() {
  return {
    story: {
      title: 'Mon pack',
      stageNodes: [
        {
          uuid: 'cover',
          name: 'Mon pack',
          squareOne: true,
          controlSettings: { wheel: false, ok: true, home: false, pause: false, autoplay: false },
          audio: 'sim000000.mp3',
          image: 'sim000001.png',
          okTransition: { actionNode: 'racine', optionIndex: 0 },
        },
        {
          uuid: 'titre-a',
          name: 'Première',
          controlSettings: { wheel: true, ok: true, home: true, pause: false, autoplay: false },
          image: 'sim000002.png',
          okTransition: { actionNode: 'lecture-a', optionIndex: 0 },
        },
        {
          uuid: 'lecture-a',
          name: 'Première',
          controlSettings: { wheel: false, ok: false, home: true, pause: true, autoplay: false },
          audio: 'sim000003.mp3',
        },
        {
          // Le générateur produit des Écrans qui n'appartiennent à aucune
          // entrée — ici un écran noir de transition.
          uuid: 'noir',
          name: '',
          controlSettings: { wheel: false, ok: true, home: true, pause: false, autoplay: true },
        },
      ],
      actionNodes: [
        { id: 'racine', options: ['titre-a'] },
        { id: 'lecture-a', options: ['lecture-a'] },
      ],
    },
    media: [
      { assetName: 'sim000000.mp3', role: 'rootAudio', entryId: null, kind: 'disk', path: '/w/couverture.mp3' },
      { assetName: 'sim000001.png', role: 'rootImage', entryId: null, kind: 'disk', path: '/w/couverture.png' },
      { assetName: 'sim000002.png', role: 'root/Première#a/itemImage', entryId: 'a', kind: 'disk', path: '/w/a.png' },
      { assetName: 'sim000003.mp3', role: 'root/Première#a/storyAudio', entryId: 'a', kind: 'disk', path: '/w/a.mp3' },
    ],
    entryIdByStage: { 'titre-a': 'a', 'lecture-a': 'a' },
  };
}

test('un projet hiérarchique projeté se joue comme une archive', () => {
  const graph = projectedFlatGraph(projectionFixture());

  assert.equal(graph.title, 'Mon pack');
  assert.equal(graph.entryId, 'cover');
  assert.equal(graph.stages.size, 4);
  // Les médias viennent du **disque**, pas d'une archive : rien n'a été produit.
  assert.deepEqual(graph.stages.get('cover').audio, {
    kind: MEDIA_FROM_DISK,
    assetRef: 'sim000000.mp3',
    path: '/w/couverture.mp3',
  });
  // Et la navigation du générateur est jouable telle quelle.
  const entry = resolveTransitionEntry(
    graph.stages.get('cover').okTransition,
    graph.actions.get('racine'),
    sequenceDrawSource([0]),
  );
  assert.equal(entry.target, 'titre-a');
});

test('un Écran projeté désigne le nœud de l’arbre dont il vient', () => {
  const graph = projectedFlatGraph(projectionFixture());

  // Les deux Écrans d'une même histoire désignent la même entrée : c'est ce que
  // le lecteur d'arbre poussait déjà vers la sélection.
  assert.equal(graph.entryIdByStage.get('titre-a'), 'a');
  assert.equal(graph.entryIdByStage.get('lecture-a'), 'a');
  // La couverture et les Écrans de service n'appartiennent à aucune entrée :
  // ils ne déplacent pas la sélection de l'auteur.
  assert.equal(graph.entryIdByStage.get('cover'), undefined);
  assert.equal(graph.entryIdByStage.get('noir'), undefined);
});

test('l’écoute part du premier Écran de l’entrée choisie', () => {
  const graph = projectedFlatGraph(projectionFixture());
  assert.equal(startStageForEntry(graph, 'a'), 'titre-a');
  // « depuis la racine » n'est pas une entrée : l'écoute part de la couverture.
  assert.equal(startStageForEntry(graph, 'root'), null);
  assert.equal(startStageForEntry(graph, 'entree-inconnue'), null);
  assert.equal(startStageForEntry(null, 'a'), null);
});

for (const slot of ['audio', 'image']) {
  test(`un ${slot} partagé garde le suivi et le départ propres à chaque entrée`, () => {
    const projection = projectionFixture();
    for (const stage of projection.story.stageNodes.slice(1, 3)) {
      stage[slot] = slot === 'audio' ? 'sim000003.mp3' : 'sim000002.png';
      projection.story.stageNodes.push({ ...stage, uuid: `${stage.uuid}-b` });
      projection.entryIdByStage[`${stage.uuid}-b`] = 'b';
    }
    projection.story.actionNodes[0].options.push('titre-a-b');
    const graph = projectedFlatGraph(projection);
    for (const [id, stages] of [['a', ['titre-a', 'lecture-a']], ['b', ['titre-a-b', 'lecture-a-b']]]) {
      for (const stage of stages) assert.equal(graph.entryIdByStage.get(stage), id);
      assert.equal(startStageForEntry(graph, id), stages[0]);
      assert.equal(resolveInitialStage(graph, { startId: startStageForEntry(graph, id) }).stageId, stages[0]);
    }
    assert.deepEqual(graph.stages.get('titre-a')[slot], graph.stages.get('titre-a-b')[slot]);
  });
}

test('un média que l’auteur n’a pas encore posé se joue en silence et se compte', () => {
  const projection = projectionFixture();
  // Ce que Rust pose quand le générateur réclame un média absent : la place est
  // tenue, aucun fichier ne lui correspond.
  projection.story.stageNodes[2].audio = PROJECTED_MISSING_ASSET;
  const graph = projectedFlatGraph(projection);

  assert.equal(graph.stages.get('lecture-a').audio, null);
  assert.equal(graph.readiness.unresolvedMedia, 1);
  assert.equal(graph.entryIdByStage.get('lecture-a'), 'a');
});

test('un pack importé garde ses médias dans son archive', () => {
  const projection = projectionFixture();
  projection.story.stageNodes.push({
    uuid: 'importe',
    name: 'Pack repris',
    controlSettings: { wheel: false, ok: true, home: true, pause: true, autoplay: false },
    audio: 'simzip000000_abc.mp3',
  });
  projection.entryIdByStage.importe = 'z';
  projection.media.push({
    assetName: 'simzip000000_abc.mp3',
    role: 'root/Pack repris#z/zip / imported abc.mp3',
    entryId: 'z',
    kind: 'pack',
    zipPath: '/w/repris.zip',
    zipAssetName: 'assets/abc.mp3',
  });
  const graph = projectedFlatGraph(projection);

  // Les Écrans d'un pack importé sont **dépliés** dans le graphe par le
  // générateur : on y entre comme dans n'importe quelle branche, et il n'y a
  // plus d'archive à « ouvrir » en cours d'écoute.
  assert.deepEqual(graph.stages.get('importe').audio, {
    kind: MEDIA_FROM_PACK,
    assetRef: 'simzip000000_abc.mp3',
    assetName: 'assets/abc.mp3',
    zipPath: '/w/repris.zip',
  });
  assert.equal(graph.entryIdByStage.get('importe'), 'z');
});

test('projeter ne touche pas la projection reçue', () => {
  const projection = projectionFixture();
  const before = JSON.stringify(projection);
  const graph = projectedFlatGraph(projection);
  assert.equal(graph.stages.size, 4);
  assert.equal(JSON.stringify(projection), before);
});

test('une projection vide n’a pas de graphe à jouer', () => {
  assert.equal(projectedFlatGraph(null), null);
  assert.equal(projectedFlatGraph({ media: [] }), null);
});

// Un Écran sans nom s'écoute sous le même libellé « Stage N » dans le
// projet et dans l'archive produite. N suit l'ordre de l'archive : l'entrée
// d'abord, puis les autres dans l'ordre du document. Un nom d'auteur
// n'est jamais remplacé.
test('un Écran sans nom porte le même libellé dans le projet et dans l’archive', () => {
  const unnamed = { name: presence(undefined) };
  const view = documentView();
  // Le document range l'entrée en deuxième : l'archive la remontera en tête.
  view.stages = [
    viewStage('gauche', { ...unnamed, okTransition: viewTransition('retour', FIXED(0)) }),
    viewStage('entree', { ...unnamed, squareOne: presence(true), okTransition: viewTransition('carrefour', RANDOM) }),
    viewStage('droite', { okTransition: viewTransition('retour', FIXED(0)) }),
  ];
  const fromDocument = documentFlatGraph(view, documentProject());

  const story = packStory();
  const byUuid = new Map(story.stageNodes.map((node) => [node.uuid, node]));
  delete byUuid.get('entree').name;
  delete byUuid.get('gauche').name;
  story.stageNodes = ['entree', 'gauche', 'droite'].map((uuid) => byUuid.get(uuid));
  const fromPack = packFlatGraph(story, '/sortie/pack.zip');

  const names = (graph, key) => ['entree', 'gauche', 'droite']
    .map((uuid) => graph.stages.get(key(uuid)).name);
  assert.deepEqual(names(fromDocument, STAGE_PATH), ['Stage 1', 'Stage 2', 'droite']);
  assert.deepEqual(names(fromPack, (uuid) => uuid), ['Stage 1', 'Stage 2', 'droite']);
});

test('sans Écran d’entrée, un Écran sans nom est numéroté dans l’ordre du document', () => {
  const graph = packFlatGraph({
    title: 'Sans entrée',
    stageNodes: [{ uuid: 'a', name: '  ' }, { uuid: 'b', name: 'Nommé' }, { uuid: 'c' }],
    actionNodes: [],
  }, '/sortie/pack.zip');
  assert.deepEqual([...graph.stages.values()].map((stage) => stage.name), ['Stage 1', 'Nommé', 'Stage 3']);
});
