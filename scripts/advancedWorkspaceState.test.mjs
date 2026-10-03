// L'état de l'espace de travail avancé.
//
// Tout est **pur** : aucun moteur d'affichage, aucun React, aucun Tauri. Ce que
// ces tests éprouvent est ce qu'un dialogue doit savoir **avant** d'envoyer un
// geste — quelles références entrantes existent, quelles décisions le retrait
// exige, quels écrans un remplacement global toucherait, et quelle résolution
// mène réellement à une commande.
//
// Rust reste l'autorité : ces calculs le précèdent, ils ne le doublent pas.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKSPACE_MODE_ADVANCED,
  WORKSPACE_MODE_HIERARCHICAL,
  WORKSPACE_MODE_HOME,
  authoringWorkspaceMode,
  hierarchicalProjectType,
} from '../src/store/projectWorkState.js';
import { buildGraphIndex } from '../src/store/advancedGraphView/graphViewModel.js';
import {
  actionRemovalImpact,
  describeReferences,
  incomingOptionsForStage,
  incomingTransitionsForAction,
  optionRemovalImpact,
  remainingOptionsAfterRemoval,
  selectionSurvivesRemoval,
  stageRemovalImpact,
  subgraphRemovalPlan,
} from '../src/store/advancedAuthoring/authoringPlans.js';
import {
  buildMediaUsageIndex,
  missingMediaRefs,
} from '../src/store/advancedAuthoring/mediaUsage.js';
import {
  RESOLUTION_FORM,
  RESOLUTION_GESTURE,
  RESOLUTION_REVEAL,
  buildAdvancedBlockingIssues,
  groupDiagnosticsByNode,
  resolutionsForDiagnostic,
} from '../src/store/advancedAuthoring/diagnosticResolutions.js';
import { action, presence, sampleView, stage } from './advancedViewFixtures.mjs';

// ── Le mode d'espace de travail ──────────────────────────────────────────────

const advancedProject = {
  schemaVersion: 4,
  authoringMode: 'advanced',
  projectType: 'advanced',
  projectName: 'pack repris',
  rootEntries: [],
  authoring: { payload: '{"payloadVersion":1}', editorState: { version: 1 }, mediaBindings: [] },
};

test('un projet avancé ouvert monte son espace, et n\'expose toujours aucun type hiérarchique', () => {
  assert.equal(authoringWorkspaceMode(advancedProject), WORKSPACE_MODE_ADVANCED);
  // Le garde-fou est intact : c'est **parce que** ce type reste nul que
  // l'arbre, la validation et la génération Libre ne montent pas.
  assert.equal(hierarchicalProjectType(advancedProject), null);
});

test('l\'absence de projet et un projet Libre restent distincts de l\'avancé', () => {
  assert.equal(authoringWorkspaceMode({ projectType: null, rootEntries: [] }), WORKSPACE_MODE_HOME);
  assert.equal(authoringWorkspaceMode({ projectType: 'pack', rootEntries: [] }), WORKSPACE_MODE_HIERARCHICAL);
  assert.equal(authoringWorkspaceMode(undefined), WORKSPACE_MODE_HOME);
});

// ── Une vue avec une roue partagée ───────────────────────────────────────────

// Deux Écrans désignent la même Action : l'un par OK avec une occurrence fixe,
// l'autre par HOME en aléatoire. La roue porte deux occurrences vers la **même**
// cible, délibérément : aucune déduplication n'est possible.
function sharedWheelView() {
  const entry = stage('entry', {
    name: presence('Entrée'),
    squareOne: presence(true),
    okTransition: {
      presence: 'value',
      actionId: 'roue',
      actionPath: '/actionNodes/@id=roue#0',
      selection: { kind: 'fixed', index: 2 },
      withinBounds: true,
      selectedOptionId: '/actionNodes/@id=roue#0/options#2',
      resolvedStagePath: '/stageNodes/@uuid=cible#0',
    },
  });
  const second = stage('second', {
    name: presence('Second'),
    homeTransition: {
      presence: 'value',
      actionId: 'roue',
      actionPath: '/actionNodes/@id=roue#0',
      selection: { kind: 'random' },
      withinBounds: true,
      selectedOptionId: null,
      resolvedStagePath: null,
    },
  });
  const cible = stage('cible', { name: presence('Cible') });
  const autre = stage('autre', { name: presence('Autre') });
  const roue = action('roue', ['cible', 'autre', 'cible', null], { name: presence('Roue') });

  const optionEdge = (ordinal, target) => ({
    edgeId: `${roue.path}/options#${ordinal}`,
    kind: 'action-option',
    from: roue.path,
    to: target,
    optionId: `${roue.path}/options#${ordinal}`,
    ordinal,
    selection: null,
    dangling: false,
  });

  return {
    viewVersion: 1,
    documentFingerprint: 'sha256:roue',
    documentOrigin: 'imported-studio',
    defaultValueOrigin: 'source-studio',
    packIdentity: { origin: 'square-one-stage', value: 'pack-roue' },
    entry: { status: 'unique', stagePath: entry.path, candidates: [entry.path] },
    counts: { stages: 4, actions: 1, options: 4, edges: 5 },
    stages: [entry, second, cible, autre],
    actions: [roue],
    edges: [
      { edgeId: `${entry.path}::ok`, kind: 'stage-ok', from: entry.path, to: roue.path, optionId: null, ordinal: null, selection: { kind: 'fixed', index: 2 }, dangling: false },
      { edgeId: `${second.path}::home`, kind: 'stage-home', from: second.path, to: roue.path, optionId: null, ordinal: null, selection: { kind: 'random' }, dangling: false },
      optionEdge(0, cible.path),
      optionEdge(1, autre.path),
      optionEdge(2, cible.path),
    ],
    mediaRefs: [],
    groups: [],
    opaqueMembers: [],
    diagnostics: [],
  };
}

// ── Références entrantes ─────────────────────────────────────────────────────

test('deux occurrences vers le même Écran restent deux lignes distinctes', () => {
  const index = buildGraphIndex(sharedWheelView());
  const rows = incomingOptionsForStage(index, '/stageNodes/@uuid=cible#0');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.ordinal), [0, 2]);
  // L'identifiant d'Action vient du DTO, jamais d'un découpage de chemin.
  assert.deepEqual(new Set(rows.map((row) => row.actionId)), new Set(['roue']));
});

test('les deux emplacements de chaque Écran sont parcourus, pas seulement OK', () => {
  const index = buildGraphIndex(sharedWheelView());
  const rows = incomingTransitionsForAction(index, '/actionNodes/@id=roue#0');
  assert.deepEqual(rows.map((row) => [row.stageUuid, row.slot]), [['entry', 'ok'], ['second', 'home']]);
  assert.deepEqual(rows[0].selection, { kind: 'fixed', index: 2 });
  assert.deepEqual(rows[1].selection, { kind: 'random' });
});

// ── Survie d'une sélection à un retrait ──────────────────────────────────────

test('une sélection fixe ne glisse jamais sur sa voisine', () => {
  // Le rang retiré : la destination disparaît, une décision est exigée.
  assert.equal(selectionSurvivesRemoval({ kind: 'fixed', index: 2 }, 2, 3), false);
  // Un rang avant : il ne bouge pas.
  assert.equal(selectionSurvivesRemoval({ kind: 'fixed', index: 1 }, 2, 3), true);
  // Un rang après : il recule d'un cran et reste dans les bornes.
  assert.equal(selectionSurvivesRemoval({ kind: 'fixed', index: 3 }, 2, 3), true);
});

test('une sélection aléatoire survit tant qu\'une option reste', () => {
  assert.equal(selectionSurvivesRemoval({ kind: 'random' }, 0, 1), true);
  assert.equal(selectionSurvivesRemoval({ kind: 'random' }, 0, 0), false);
});

test('une sélection déjà hors bornes exige une décision elle aussi', () => {
  assert.equal(selectionSurvivesRemoval({ kind: 'fixed', index: 9 }, 0, 3), false);
});

test('le retrait d\'un rang n\'exige de décision que des transitions qu\'il prive', () => {
  const index = buildGraphIndex(sharedWheelView());
  const impact = optionRemovalImpact(index, '/actionNodes/@id=roue#0', 2);
  assert.equal(impact.remaining, 3);
  // `Fixed(2)` perd sa destination ; `Random` survit, la roue n'est pas vidée.
  assert.deepEqual(impact.decisions.map((row) => [row.stageUuid, row.slot]), [['entry', 'ok']]);
});

test('vider une roue force aussi les transitions aléatoires à être décidées', () => {
  const view = sharedWheelView();
  // Une roue d'une seule option, que le retrait viderait.
  view.actions[0].options = view.actions[0].options.slice(0, 1);
  const index = buildGraphIndex(view);
  const impact = optionRemovalImpact(index, '/actionNodes/@id=roue#0', 0);
  assert.equal(impact.remaining, 0);
  assert.deepEqual(
    impact.decisions.map((row) => row.slot).sort(),
    ['home', 'ok'],
  );
});

test('la roue résultante est celle où l\'auteur choisira un rang', () => {
  const index = buildGraphIndex(sharedWheelView());
  const options = index.byPath.get('/actionNodes/@id=roue#0').node.options;
  const remaining = remainingOptionsAfterRemoval(options, 1);
  // Trois options restent, réindexées de 0 à 2 : c'est dans **celle-là** que
  // `optionIndex` s'exprime, jamais dans la roue d'avant.
  assert.deepEqual(remaining.map((option) => option.remainingIndex), [0, 1, 2]);
  assert.deepEqual(remaining.map((option) => option.ordinal), [0, 2, 3]);
});

// ── Plans de retrait ─────────────────────────────────────────────────────────

test('retirer un Écran inventorie ses occurrences entrantes avant tout geste', () => {
  const index = buildGraphIndex(sharedWheelView());
  const impact = stageRemovalImpact(index, '/stageNodes/@uuid=cible#0');
  assert.deepEqual(impact.occurrences.map((row) => row.ordinal), [0, 2]);
  // Aucune résolution choisie : aucun retrait d'occurrence, donc aucune
  // sélection privée de destination.
  assert.deepEqual(impact.decisions, []);
});

test('retargeter une occurrence n\'ampute aucune roue, la retirer si', () => {
  const index = buildGraphIndex(sharedWheelView());
  const retargeted = stageRemovalImpact(index, '/stageNodes/@uuid=cible#0', {
    '/actionNodes/@id=roue#0/options#0': { form: 'retarget' },
    '/actionNodes/@id=roue#0/options#2': { form: 'retarget' },
  });
  assert.deepEqual(retargeted.decisions, []);

  const removed = stageRemovalImpact(index, '/stageNodes/@uuid=cible#0', {
    '/actionNodes/@id=roue#0/options#0': { form: 'remove' },
    '/actionNodes/@id=roue#0/options#2': { form: 'remove' },
  });
  // Deux retraits laissent deux options : `Fixed(2)` perd sa destination.
  assert.deepEqual(removed.decisions.map((row) => [row.stageUuid, row.slot]), [['entry', 'ok']]);
  assert.equal(removed.decisions[0].remaining, 2);
});

test('plusieurs retraits conservent une sélection vers un rang qui se décale', () => {
  const view = sharedWheelView();
  view.edges[0].selection = { kind: 'fixed', index: 3 };
  const index = buildGraphIndex(view);
  const impact = stageRemovalImpact(index, '/stageNodes/@uuid=cible#0', {
    '/actionNodes/@id=roue#0/options#0': { form: 'remove' },
    '/actionNodes/@id=roue#0/options#2': { form: 'remove' },
  });
  assert.deepEqual(impact.decisions, []);
});

test('retirer une Action nomme chaque transition entrante séparément', () => {
  const index = buildGraphIndex(sharedWheelView());
  const impact = actionRemovalImpact(index, '/actionNodes/@id=roue#0');
  assert.deepEqual(
    impact.transitions.map((row) => [row.stageUuid, row.slot]),
    [['entry', 'ok'], ['second', 'home']],
  );
});

test('l\'inventaire d\'un refus est relu contre la vue, jamais découpé d\'un message', () => {
  const index = buildGraphIndex(sharedWheelView());
  const described = describeReferences(index, [
    '/actionNodes/@id=roue#0/options#2',
    '/actionNodes/@id=inconnue#0/options#0',
  ]);
  assert.equal(described[0].actionId, 'roue');
  assert.equal(described[0].ordinal, 2);
  // Une référence que la vue ne retrouve pas est **montrée**, pas escamotée.
  assert.equal(described[1].unresolved, true);
  assert.equal(described[1].path, '/actionNodes/@id=inconnue#0/options#0');
});

// ── Médias ───────────────────────────────────────────────────────────────────

test('la jointure par assetRef distingue « lié », « manquant » et « sans liaison »', () => {
  const view = sampleView();
  const project = {
    authoring: {
      mediaBindings: [{ assetRef: 'commun.mp3', path: '/m/commun.mp3', status: 'missing' }],
    },
  };
  const usage = buildMediaUsageIndex(project, view);
  const commun = usage.get('commun.mp3');
  assert.equal(commun.bound, true);
  assert.equal(commun.missing, true);
  assert.equal(commun.path, '/m/commun.mp3');
  assert.equal(commun.usages.length, 2);

  const orphanBinding = buildMediaUsageIndex({
    authoring: { mediaBindings: [{ assetRef: 'oublie.mp3', path: '/m/oublie.mp3', status: 'resolved' }] },
  }, view).get('oublie.mp3');
  // Une liaison que le document ne cite plus reste connue : la masquer
  // laisserait croire qu'elle a été effacée.
  assert.equal(orphanBinding.unreferenced, true);
  assert.deepEqual(orphanBinding.usages, []);
  assert.deepEqual(missingMediaRefs(buildMediaUsageIndex({
    authoring: { mediaBindings: [{ assetRef: 'oublie.mp3', path: '/m/oublie.mp3', status: 'missing' }] },
  }, view)).map((row) => row.assetRef), ['commun.mp3']);
});

test('une référence citée sans liaison n\'est pas rendue comme résolue', () => {
  const usage = buildMediaUsageIndex({ authoring: { mediaBindings: [] } }, sampleView());
  const commun = usage.get('commun.mp3');
  assert.equal(commun.bound, false);
  assert.equal(commun.status, null);
  assert.deepEqual(missingMediaRefs(usage).map((row) => row.assetRef), ['commun.mp3']);
});

// ── Résolutions de diagnostics ───────────────────────────────────────────────

function diagnosticView(overrides) {
  return {
    family: 'authoring',
    level: 'ACTION_REQUIRED',
    severity: null,
    code: 'X',
    path: '/stageNodes/@uuid=entry#0',
    nodePath: '/stageNodes/@uuid=entry#0',
    message: '',
    resolutions: [],
    ...overrides,
  };
}

test('compléter les contrôles ouvre un formulaire, jamais un geste qui devine cinq valeurs', () => {
  const view = sampleView();
  const index = buildGraphIndex(view);
  const [resolution] = resolutionsForDiagnostic({
    diagnostic: view.diagnostics[0],
    view,
    index,
  });
  assert.equal(resolution.nature, RESOLUTION_FORM);
  assert.equal(resolution.form, 'controls');
});

// Un pack malformé à zéro ou deux racines s'ouvre dans le graphe (l'intégrité
// ne bloque qu'à la production), et le retrait d'une racine est refusé : sans
// cette réparation, rien ne permettait de le corriger. Rust n'émet aucune
// résolution pour les codes d'intégrité ; celle-ci est offerte ici, et
// seulement ici — le graphe n'a plus de commande permanente de racine.
test('un compte de racines faux offre de choisir l’Écran racine', () => {
  const view = sampleView();
  const index = buildGraphIndex(view);
  const offered = resolutionsForDiagnostic({
    diagnostic: diagnosticView({
      family: 'graph-integrity',
      level: null,
      severity: 'error',
      code: 'SQUARE_ONE_COUNT',
      path: '/stageNodes',
      nodePath: null,
    }),
    view,
    index,
  });
  assert.deepEqual(offered.map(({ nature, form, label }) => ({ nature, form, label })), [
    { nature: RESOLUTION_FORM, form: 'square-one', label: 'Choisir l’Écran racine…' },
  ]);
});

test('sans Écran à choisir, aucune racine n’est proposée', () => {
  const view = { ...sampleView(), stages: [] };
  const offered = resolutionsForDiagnostic({
    diagnostic: diagnosticView({ code: 'SQUARE_ONE_COUNT', path: '/stageNodes', nodePath: null }),
    view,
    index: buildGraphIndex(view),
  });
  assert.deepEqual(offered, []);
});

test('une disposition de position devient un geste prêt à partir', () => {
  const view = sampleView();
  const index = buildGraphIndex(view);
  const offered = resolutionsForDiagnostic({
    diagnostic: diagnosticView({
      code: 'POSITION_OUT_OF_RANGE_ACTION_REQUIRED',
      path: '/stageNodes/@uuid=entry#0/position',
      resolutions: ['scale-position-to-short-range', 'omit-position'],
    }),
    view,
    index,
  });
  assert.deepEqual(offered.map((row) => row.nature), [RESOLUTION_GESTURE, RESOLUTION_GESTURE]);
  assert.deepEqual(offered[0].gesture, {
    gesture: 'set-position-export-disposition',
    node: { kind: 'stage', id: 'entry' },
    disposition: 'scale-to-short-range',
  });
  assert.equal(offered[1].gesture.disposition, 'omit-explicitly');
});

// Règles de navigation de STUdio (`port_rules.rs`) : Accueil qui revient sur
// l'Écran se corrige d'un geste, qui rend le retour Lunii par défaut.
test('un Accueil qui ramène l’Écran sur lui-même se corrige en retirant sa destination', () => {
  const view = sampleView();
  const index = buildGraphIndex(view);
  const offered = resolutionsForDiagnostic({
    diagnostic: diagnosticView({
      code: 'HOME_LOOPS_TO_SELF',
      path: '/stageNodes/@uuid=cible#0/homeTransition',
      nodePath: '/stageNodes/@uuid=cible#0',
      resolutions: ['clear-home-transition'],
    }),
    view,
    index,
  });
  assert.deepEqual(offered.map((row) => row.nature), [RESOLUTION_GESTURE]);
  assert.deepEqual(offered[0].gesture, {
    gesture: 'set-stage-transition',
    stageUuid: 'cible',
    slot: 'home',
    update: { form: 'null' },
  });
});

test('Accueil actif sans destination sur l’Écran d’entrée se corrige en le désactivant', () => {
  const view = sampleView();
  const index = buildGraphIndex(view);
  const offered = resolutionsForDiagnostic({
    diagnostic: diagnosticView({
      code: 'HOME_LOOPS_TO_SELF',
      path: '/stageNodes/@uuid=entry#0/controlSettings/home',
      resolutions: ['disable-home'],
    }),
    view,
    index,
  });
  assert.deepEqual(offered[0].gesture, {
    gesture: 'set-stage-controls',
    stageUuid: 'entry',
    update: { form: 'members', members: { home: { form: 'set', value: false } } },
  });
});

// Fins dangereuses : la réparation pose la fin validée sur l'appareil, sans
// jamais inventer de destination OK.
test('OK sans destination se répare en une fin, Accueil activé', () => {
  const view = sampleView();
  const index = buildGraphIndex(view);
  const offered = resolutionsForDiagnostic({
    diagnostic: diagnosticView({
      code: 'OK_WITHOUT_USABLE_DESTINATION',
      path: '/stageNodes/@uuid=cible#0/okTransition',
      nodePath: '/stageNodes/@uuid=cible#0',
      resolutions: ['make-ending'],
    }),
    view,
    index,
  });
  assert.deepEqual(offered.map((row) => [row.nature, row.label]), [[RESOLUTION_GESTURE, 'En faire une fin']]);
  assert.deepEqual(offered[0].gesture, {
    gesture: 'set-stage-controls',
    stageUuid: 'cible',
    update: {
      form: 'members',
      members: {
        ok: { form: 'set', value: false },
        autoplay: { form: 'set', value: false },
        home: { form: 'set', value: true },
      },
    },
  });
});

test('un Écran sans sortie se répare en activant Accueil', () => {
  const view = sampleView();
  const index = buildGraphIndex(view);
  const offered = resolutionsForDiagnostic({
    diagnostic: diagnosticView({
      code: 'NO_USABLE_EXIT',
      path: '/stageNodes/@uuid=cible#0/controlSettings',
      nodePath: '/stageNodes/@uuid=cible#0',
      resolutions: ['enable-home'],
    }),
    view,
    index,
  });
  assert.deepEqual(offered.map((row) => [row.nature, row.label]), [[RESOLUTION_GESTURE, 'Activer Accueil']]);
  assert.deepEqual(offered[0].gesture, {
    gesture: 'set-stage-controls',
    stageUuid: 'cible',
    update: { form: 'members', members: { home: { form: 'set', value: true } } },
  });
});

test('les règles de navigation bloquantes ont leur texte dans « À corriger »', () => {
  for (const code of ['HOME_LOOPS_TO_SELF', 'OK_LOOPS_TO_SELF', 'ENTRY_STAGE_AS_OPTION', 'OK_WITHOUT_USABLE_DESTINATION', 'NO_USABLE_EXIT']) {
    const [issue] = buildAdvancedBlockingIssues({
      summary: { blocking: [{ source: 'authoring', code, path: '/stageNodes/@uuid=entry#0' }] },
    });
    assert.equal(issue.category, 'Navigation bloquante', code);
  }
});

test('les destinations OK manquantes et les impasses expliquent une réparation utilisable', () => {
  const issues = buildAdvancedBlockingIssues({ summary: { blocking: [
    { source: 'authoring', code: 'OK_WITHOUT_USABLE_DESTINATION', path: '/stageNodes/@uuid=cible#0/okTransition' },
    { source: 'authoring', code: 'NO_USABLE_EXIT', path: '/stageNodes/@uuid=cible#0/controlSettings' },
  ] } });
  assert.match(issues[0].message, /OK|automatique/);
  assert.match(issues[0].message, /destination/);
  assert.match(issues[1].message, /molette/);
});

test('deux occurrences d\'un même membre opaque donnent deux décisions adressables', () => {
  const view = sampleView();
  view.opaqueMembers = [
    { path: '/stageNodes/@uuid=entry#0', nodePath: '/stageNodes/@uuid=entry#0', scope: 'stage', key: 'duration', sourceOccurrence: 0, kind: 'unknown', origin: 'source-studio', valuePreview: '1', truncated: false, disposition: null, dispositionStale: false },
    { path: '/stageNodes/@uuid=entry#0', nodePath: '/stageNodes/@uuid=entry#0', scope: 'stage', key: 'duration', sourceOccurrence: 1, kind: 'unknown', origin: 'source-studio', valuePreview: '2', truncated: false, disposition: null, dispositionStale: false },
  ];
  const index = buildGraphIndex(view);
  const offered = resolutionsForDiagnostic({
    diagnostic: diagnosticView({
      code: 'OPAQUE_EXTENSION_DISPOSITION_REQUIRED',
      // Le chemin tel que Rust le compose : porteur, puis clé.
      path: '/stageNodes/@uuid=entry#0/duration',
      resolutions: ['remove-opaque-explicitly'],
    }),
    view,
    index,
  });
  // Sans `sourceOccurrence`, l'interface poserait la décision sur la première
  // occurrence à la place de celle que l'auteur regarde.
  assert.deepEqual(offered.map((row) => row.gesture.member.sourceOccurrence), [0, 1]);
  assert.equal(offered[0].gesture.disposition, 'remove-explicitly');
});

test('une résolution dont la cible ne se retrouve pas dans la vue n\'est pas offerte', () => {
  const view = sampleView();
  const index = buildGraphIndex(view);
  const offered = resolutionsForDiagnostic({
    diagnostic: diagnosticView({
      code: 'ENRICHED_GROUP_INCOHERENT',
      resolutions: ['flatten-known-group'],
    }),
    view,
    index,
  });
  // Aucun groupe ne porte ce nœud : pas de bouton mort.
  assert.deepEqual(offered, []);
});

test('aplatir un groupe connu est offert comme geste destructeur nommé', () => {
  const view = sampleView();
  view.stages[0].groupId = presence('g-1');
  view.groups = [{ groupId: 'g-1', kind: 'story', stagePaths: [view.stages[0].path], actionPaths: [] }];
  const index = buildGraphIndex(view);
  const offered = resolutionsForDiagnostic({
    diagnostic: diagnosticView({
      code: 'ENRICHED_GROUP_INCOHERENT',
      resolutions: ['repair-known-group', 'flatten-known-group'],
    }),
    view,
    index,
  });
  assert.equal(offered[0].nature, RESOLUTION_REVEAL);
  assert.equal(offered[1].nature, RESOLUTION_GESTURE);
  assert.equal(offered[1].destructive, true);
  assert.deepEqual(offered[1].gesture, { gesture: 'flatten-known-group', groupId: 'g-1' });
});

test('raccorder ou retirer une Action orpheline est un formulaire, pas un geste imposé', () => {
  const view = sharedWheelView();
  const index = buildGraphIndex(view);
  const [resolution] = resolutionsForDiagnostic({
    diagnostic: diagnosticView({
      code: 'ORPHAN_ACTION_AUTHORED_CONTENT',
      path: '/actionNodes/@id=roue#0',
      nodePath: '/actionNodes/@id=roue#0',
      resolutions: ['connect-or-remove-orphan'],
    }),
    view,
    index,
  });
  assert.equal(resolution.nature, RESOLUTION_FORM);
  assert.equal(resolution.form, 'orphan-action');
});

test('les diagnostics sans nœud restent visibles dans leur propre groupe', () => {
  const { byNode, documentWide } = groupDiagnosticsByNode([
    diagnosticView({ code: 'A' }),
    diagnosticView({ code: 'B', nodePath: null, path: '/' }),
  ]);
  assert.equal(byNode.get('/stageNodes/@uuid=entry#0').length, 1);
  assert.deepEqual(documentWide.map((row) => row.code), ['B']);
});

test('les erreurs de nœud identifient leur Écran ou leur liste sans attribuer une erreur du pack', () => {
  const index = { byPath: new Map([
    ['/stage', { kind: 'stage', label: { label: 'La forêt' } }],
    ['/action', { kind: 'action', label: { label: 'Les chemins' } }],
  ]) };
  const diagnostics = ['/stage', '/action'].map((nodePath) => diagnosticView({
    code: 'CONTROL_SETTINGS_INCOMPLETE', path: nodePath, nodePath,
  }));
  const issues = buildAdvancedBlockingIssues({ index, diagnostics, summary: { blocking: [
    ...diagnostics.map(({ code, path }) => ({ source: 'authoring', code, path })),
    { source: 'graph-integrity', code: 'SQUARE_ONE_COUNT', path: '/' },
  ] } });
  assert.deepEqual(issues.map((issue) => issue.nodeLabel), [
    'Écran « La forêt »', 'Liste de choix « Les chemins »', null,
  ]);
});

test('la pastille avancée ne retient que les diagnostics qui bloquent réellement', () => {
  const diagnostic = diagnosticView({
    code: 'OPTION_TARGET_NULL',
    path: '/actionNodes/@id=roue#0/options/0',
    nodePath: '/actionNodes/@id=roue#0',
  });
  const issues = buildAdvancedBlockingIssues({
    summary: {
      blocking: [{
        source: 'graph-integrity',
        code: 'OPTION_TARGET_NULL',
        path: diagnostic.path,
      }],
      advisory: [{ code: 'POSITION_FRACTIONAL', path: '/ignored' }],
    },
    diagnostics: [diagnostic],
  });
  assert.deepEqual(issues.map(({ category, message, nodePath }) => ({ category, message, nodePath })), [{
    category: 'Erreur de structure',
    message: 'Un choix de cette liste attend son Écran.',
    nodePath: '/actionNodes/@id=roue#0',
  }]);
});

test('un média utilisé mais absent bloque la pastille, une ancienne liaison inutilisée non', () => {
  const usage = new Map([
    ['audio-1', {
      assetRef: 'audio-1', missing: true, bound: true,
      usages: [{ nodePath: '/stageNodes/@uuid=entry#0', field: 'audio' }],
    }],
    ['ancien', { assetRef: 'ancien', missing: true, bound: true, usages: [], unreferenced: true }],
  ]);
  const index = { byPath: new Map([[
    '/stageNodes/@uuid=entry#0',
    { label: { label: 'Accueil' } },
  ]]) };
  const issues = buildAdvancedBlockingIssues({ summary: { blocking: [] }, usage, index });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].category, 'Média manquant');
  assert.equal(issues[0].message, 'Ajoutez le fichier audio de « Accueil ».');
  assert.equal(issues[0].nodePath, '/stageNodes/@uuid=entry#0');
});

test('un échec de vérification reste un blocage visible au lieu de produire un faux état prêt', () => {
  const issues = buildAdvancedBlockingIssues({
    summary: null,
    readinessError: new Error('transport indisponible'),
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].category, 'Erreur de document');
});

// ── Un refus avant la première lecture de vue ────────────────────────────────

// Le banc d'export a fait tomber l'espace de travail entier sur ce cas : un
// geste refusé au tout premier instant d'une session, alors que la vue n'est pas
// encore lue. L'inventaire du refus est ce qui doit alors s'afficher ; le faire
// planter est le pire moment possible.
test("l'inventaire d'un refus survit à l'absence d'index de vue", () => {
  const rows = describeReferences(null, ['/actionNodes/0/options/2', '/actionNodes/0/options/3']);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.unresolved === true && row.optionId === null));
  assert.deepEqual(rows.map((row) => row.path), [
    '/actionNodes/0/options/2',
    '/actionNodes/0/options/3',
  ]);
});

// --- Le plan d'une coupe -----------------------------------------------------

test('la coupe ne décide que du sort des références qui lui survivent', () => {
  const index = buildGraphIndex(sharedWheelView());
  // On coupe la Roue **et** la Cible. Les deux occupations de rang de la Roue
  // qui désignent la Cible partent avec la Roue : elles n'ont rien à décider.
  // Les deux transitions qui visent la Roue, elles, viennent d'Écrans qui
  // restent, et passent donc explicitement à `null`.
  const plan = subgraphRemovalPlan(index, [
    '/actionNodes/@id=roue#0',
    '/stageNodes/@uuid=cible#0',
  ]);
  assert.deepEqual(plan.actions, ['roue']);
  assert.deepEqual(plan.stages, ['cible']);
  assert.deepEqual(plan.options, [], 'les occurrences portées par la Roue coupée ne survivent pas');
  assert.deepEqual(plan.transitions, [
    { stageUuid: 'entry', slot: 'ok', update: { form: 'null' } },
    { stageUuid: 'second', slot: 'home', update: { form: 'null' } },
  ]);
});

test('couper la seule Cible laisse ses occupations de rang à décider', () => {
  const index = buildGraphIndex(sharedWheelView());
  const plan = subgraphRemovalPlan(index, ['/stageNodes/@uuid=cible#0']);
  // Deux occurrences distinctes désignent la Cible : leur rang fait leur
  // identité, et elles ne fusionnent pas.
  assert.deepEqual(plan.options, [
    { actionId: 'roue', ordinal: 0, resolution: { form: 'null' } },
    { actionId: 'roue', ordinal: 2, resolution: { form: 'null' } },
  ]);
  assert.deepEqual(plan.transitions, []);
});

test('une coupe sans cible exploitable ne produit aucun plan', () => {
  const index = buildGraphIndex(sharedWheelView());
  assert.equal(subgraphRemovalPlan(index, []), null);
  assert.equal(subgraphRemovalPlan(index, ['/nulle/part']), null);
  assert.equal(subgraphRemovalPlan(null, ['/stageNodes/@uuid=cible#0']), null);
});

test('un membre opaque de la racine offre ses décisions, sur le chemin que Rust compose', () => {
  const view = sampleView();
  // Forme réelle : le porteur est la racine `/`, la clé est à part, et le
  // diagnostic porte `/storyStudioMetadata`.
  view.opaqueMembers = [
    { path: '/', nodePath: null, scope: 'root', key: 'storyStudioMetadata', sourceOccurrence: 0, kind: 'unknown-extension', origin: 'source-studio', valuePreview: '{}', truncated: false, disposition: null, dispositionStale: false },
  ];
  const index = buildGraphIndex(view);
  const offered = resolutionsForDiagnostic({
    diagnostic: diagnosticView({
      code: 'OPAQUE_EXTENSION_DISPOSITION_REQUIRED',
      path: '/storyStudioMetadata',
      nodePath: null,
      resolutions: ['preserve-opaque-untested', 'remove-opaque-explicitly', 'promote-opaque-after-proof'],
    }),
    view,
    index,
  });
  assert.deepEqual(offered.map((row) => row.gesture.disposition), [
    'preserve-untested',
    'remove-explicitly',
    'promote-after-proof',
  ]);
  assert.equal(offered[0].gesture.member.key, 'storyStudioMetadata');
});
