// Le retour Accueil par défaut de la Lunii : dérivé à la lecture, dessiné dans
// une famille à part, jamais écrit dans le document.

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGraphIndex } from '../src/store/advancedGraphView/graphViewModel.js';
import {
  defaultHomeReturnOf,
  defaultHomeReturns,
} from '../src/store/advancedGraphView/defaultHomeReturns.js';
import { describeEdgeEnds } from '../src/store/advancedGraphView/graphPresentation.js';
import {
  EDGE_KINDS,
  EDGE_VISIBILITY_GROUPS,
  toEngineElements,
} from '../src/components/AdvancedGraphCanvas/engines/engineContract.js';
import { action, presence, stage } from './advancedViewFixtures.mjs';

const path = (uuid) => `/stageNodes/@uuid=${uuid}#0`;

function controls(home) {
  return {
    presence: 'value',
    wheel: presence(false),
    ok: presence(true),
    home: presence(home),
    pause: presence(false),
    autoplay: presence(false),
    complete: home !== undefined && home !== null,
  };
}

const explicitHome = {
  presence: 'value', actionId: 'menu', actionPath: '/actionNodes/@id=menu#0',
  selection: { kind: 'fixed', index: 0 }, withinBounds: true, selectedOptionId: null, resolvedStagePath: null,
};

function graph({ entry = { status: 'unique', stagePath: path('racine') } } = {}) {
  const stages = [
    stage('racine', { name: presence('Racine'), squareOne: presence(true), controls: controls(true) }),
    // Accueil actif, sans destination : la Lunii revient à la racine.
    stage('histoire', { name: presence('Histoire'), controls: controls(true) }),
    // Accueil actif, destination nulle (forme STUdio) : même retour.
    stage('nulle', {
      name: presence('Nulle'),
      controls: controls(true),
      homeTransition: { ...explicitHome, presence: 'null', actionId: null, actionPath: null },
    }),
    // Accueil désactivé : l'appui ne fait rien.
    stage('eteint', { name: presence('Éteint'), controls: controls(false) }),
    // Accueil non défini : on ne sait pas.
    stage('flou', { name: presence('Flou') }),
    // Destination enregistrée : c'est elle qui compte.
    stage('raccorde', { name: presence('Raccordé'), controls: controls(true), homeTransition: explicitHome }),
  ];
  return buildGraphIndex({
    viewVersion: 1,
    entry,
    counts: { stages: stages.length, actions: 1, options: 1, edges: 0 },
    stages,
    actions: [action('menu', ['racine'])],
    edges: [],
    mediaRefs: [],
    groups: [],
    opaqueMembers: [],
    diagnostics: [],
  });
}

test('seuls les Écrans à Accueil actif et sans destination reviennent à l’entrée', () => {
  const returns = defaultHomeReturns(graph());
  assert.deepEqual(returns.map((edge) => edge.from), [path('histoire'), path('nulle')]);
  assert.ok(returns.every((edge) => edge.to === path('racine')));
});

test('sans Écran d’entrée unique, la Lunii ne sait pas où revenir : aucun retour dérivé', () => {
  assert.deepEqual(defaultHomeReturns(graph({ entry: { status: 'missing', stagePath: null } })), []);
  assert.deepEqual(defaultHomeReturns(graph({ entry: { status: 'ambiguous', stagePath: null } })), []);
});

test('le canvas dessine le retour dans sa propre famille, sans le mêler aux arêtes du document', () => {
  const index = graph();
  const { edges } = toEngineElements(index);
  const derived = edges.filter((edge) => edge.kind === EDGE_KINDS.STAGE_HOME_DEFAULT);
  assert.equal(derived.length, 2);
  assert.ok(derived.every((edge) => edge.derived === true
    && edge.visibilityGroup === EDGE_VISIBILITY_GROUPS.DEVICE_RETURNS
    && edge.target === path('racine')));
  assert.equal(index.view.edges.length, 0, 'le DTO reste intact');
});

test('au survol, le retour dit qu’il vient de la Lunii', () => {
  const index = graph();
  const [edge] = defaultHomeReturns(index);
  assert.deepEqual(describeEdgeEnds(index, edge.edgeId), {
    from: 'Histoire',
    to: 'Racine',
    via: 'Bouton Accueil',
    term: 'retour par défaut de la Lunii, hors du pack',
  });
  assert.equal(defaultHomeReturnOf(index, `${path('eteint')}::home-default`), null,
    'un identifiant forgé pour un Écran sans retour ne désigne rien');
});
