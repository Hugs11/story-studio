// Un seul parcours pour fabriquer le pack.
//
// Ce que ces tests gardent, c'est **l'ordre des étapes et le moment du refus**,
// pas le contenu des contrôles. Le parcours ne change aucune règle de vérification :
// il déplace la question. Deux propriétés le portent —
//
//   1. un document qui bloque n'atteint jamais le sélecteur de dossier ;
//   2. les trois options audio, **durées comprises**, atteignent réellement la
//      demande qui part au moteur.
//
// La seconde est celle que l'interface ne tenait pas : la commande
// `export_advanced_pack` sait lire `leadingSilenceSec` et `trailingSilenceSec`
// depuis son premier jour, et le tiroir ne les lui donnait jamais. La preuve se
// prend donc sur la demande transmise, jamais sur l'affichage.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVANCED_PRODUCTION,
  advancedProductionBlockage,
  documentBlockage,
  emptyPackBlockage,
  mediaBlockage,
  runAdvancedProduction,
} from '../src/store/production/advancedProduction.js';
import { advancedPackAudioOptions } from '../src/store/production/packAudioOptions.js';
import { buildExportRequest } from '../src/store/advancedExport/exportRequest.js';
import { EXPORT_REFUSAL, PREPARATION_REFUSAL } from '../src/store/advancedExport/exportOutcome.js';
import { readPackAudioProcessing } from '../src/config/audioProcessing.js';

const HEALTHY = { blocked: false, blocking: [], advisory: [], diagnostics: [] };

const BLOCKED = {
  blocked: true,
  blocking: [
    {
      code: 'READY-001',
      path: '/stages/3',
      message: 'Cet écran ne porte aucun son.',
      level: 'ACTION_REQUIRED',
      levelLabel: 'décision requise',
      blocking: true,
    },
  ],
  advisory: [],
  diagnostics: [],
};

function graphProject({ bindings = [], globalOptions = undefined } = {}) {
  return {
    schemaVersion: 4,
    authoringMode: 'advanced',
    projectType: 'advanced',
    projectName: 'graphe',
    rootEntries: [],
    ...(globalOptions ? { globalOptions } : {}),
    authoring: { payload: 'DOC', editorState: { version: 1 }, mediaBindings: bindings },
  };
}

// ── Ce qui bloque, et d'où ça vient ─────────────────────────────────────────

test('un document qualifié bloqué rend un refus qui nomme ce qui bloque et où', () => {
  const refusal = documentBlockage(BLOCKED);
  assert.equal(refusal.kind, EXPORT_REFUSAL.PREPARATION);
  assert.equal(refusal.preparationKind, PREPARATION_REFUSAL.READINESS_BLOCKED);
  assert.equal(refusal.beforeEngine, true);
  assert.equal(refusal.diagnostics.length, 1);
  assert.match(refusal.diagnostics[0], /READY-001/);
  assert.match(refusal.diagnostics[0], /\/stages\/3/);
  assert.match(refusal.diagnostics[0], /ne porte aucun son/);
});

test('seul `blocked` décide : des avis non bloquants ne refusent rien', () => {
  const advisory = {
    blocked: false,
    blocking: [],
    advisory: [{ code: 'INFO-1', path: '/', message: 'juste un avis', level: 'WARNING' }],
  };
  assert.equal(documentBlockage(advisory), null);
});

// La qualification du graphe ne touche jamais au disque. C'est l'écart avec la
// liste « à corriger » du Libre, qui pose les deux questions, et c'est pour
// cela que la seconde est posée ici.
test('un média lié mais absent du disque refuse, comme côté Libre', () => {
  const refusal = mediaBlockage(graphProject({
    bindings: [
      { assetRef: 'a1.mp3', path: '/medias/a1.mp3', status: 'resolved' },
      { assetRef: 'b2.mp3', path: '/medias/b2.mp3', status: 'missing' },
    ],
  }), ['a1.mp3', 'b2.mp3']);
  assert.equal(refusal.kind, EXPORT_REFUSAL.MEDIA_UNAVAILABLE);
  assert.deepEqual(refusal.entries, [
    { assetRef: 'b2.mp3', cause: 'not-found', lastKnownPath: '/medias/b2.mp3', stageIds: [] },
  ]);
});

test('une liaison sans chemin se répare par sa référence, et le refus le dit', () => {
  const refusal = mediaBlockage(graphProject({
    bindings: [{ assetRef: 'c3.png', path: '', status: 'resolved' }],
  }), ['c3.png']);
  assert.equal(refusal.entries[0].cause, 'path-null');
  assert.equal(refusal.entries[0].lastKnownPath, null);
});

test('des médias tous présents ne bloquent rien', () => {
  assert.equal(mediaBlockage(graphProject({
    bindings: [{ assetRef: 'a1.mp3', path: '/medias/a1.mp3', status: 'resolved' }],
  }), ['a1.mp3']), null);
});

test('seules les références encore utilisées bloquent, y compris sans liaison', () => {
  const project = graphProject({ bindings: [
    { assetRef: 'ancien.mp3', path: '/perdu.mp3', status: 'missing' },
    { assetRef: 'actuel.mp3', path: '/actuel.mp3', status: 'resolved' },
  ] });
  assert.equal(mediaBlockage(project, ['actuel.mp3']), null);
  assert.deepEqual(mediaBlockage(project, ['nouveau.mp3']).entries, [
    { assetRef: 'nouveau.mp3', cause: 'binding-absent', lastKnownPath: null, stageIds: [] },
  ]);
});

test('le document est interrogé avant les fichiers', () => {
  // Un document illisible rend l'inventaire des médias sans objet, et c'est
  // aussi l'ordre dans lequel le moteur pose les mêmes questions.
  const refusal = advancedProductionBlockage({
    readinessSummary: BLOCKED,
    project: graphProject({ bindings: [{ assetRef: 'b2.mp3', path: '/x', status: 'missing' }] }),
    referencedAssetRefs: ['b2.mp3'],
  });
  assert.equal(refusal.preparationKind, PREPARATION_REFUSAL.READINESS_BLOCKED);
});

// ── L'ordre des quatre étapes ───────────────────────────────────────────────

// Un document sain référence au moins un média présent : un pack sans aucun
// média est refusé à la même étape que les autres blocages.
const PRESENT = [{ assetRef: 'a1.mp3', path: '/medias/a1.mp3', status: 'resolved' }];

function journey({ readiness = HEALTHY, project = graphProject({ bindings: PRESENT }), referencedAssetRefs = ['a1.mp3'], assessThrows = null } = {}) {
  const trace = [];
  const refusals = [];
  return {
    trace,
    refusals,
    run: () => runAdvancedProduction({
      readProject: () => project,
      assessReadiness: async () => {
        trace.push('assess');
        if (assessThrows) throw assessThrows;
        return readiness;
      },
      readReferencedMedia: async () => referencedAssetRefs,
      chooseFolder: async () => {
        trace.push('chooseFolder');
        return '/sorties';
      },
      start: async (request) => {
        trace.push('start');
        return request;
      },
      refuse: (refusal) => {
        trace.push('refuse');
        refusals.push(refusal);
      },
      options: { silenceMode: 'normalize', harmonizeLoudness: true },
    }),
  };
}

test('un document sain traverse ce qui bloque, puis la destination, puis part', async () => {
  const run = journey();
  const result = await run.run();
  assert.equal(result.outcome, ADVANCED_PRODUCTION.STARTED);
  assert.deepEqual(run.trace, ['assess', 'chooseFolder', 'start']);
  assert.deepEqual(run.refusals, []);
});

test('un document bloqué ne démarre aucun travail, et ne demande aucun dossier', async () => {
  const run = journey({ readiness: BLOCKED });
  const result = await run.run();
  assert.equal(result.outcome, ADVANCED_PRODUCTION.REFUSED);
  // C'est la propriété centrale : le refus arrive **avant** l'effort et avant
  // la destination, et non après le choix du dossier.
  assert.deepEqual(run.trace, ['assess', 'refuse']);
  assert.equal(run.refusals[0].preparationKind, PREPARATION_REFUSAL.READINESS_BLOCKED);
});

test('un média manquant arrête au même endroit qu’un document bloqué', async () => {
  const run = journey({
    project: graphProject({ bindings: [{ assetRef: 'b2.mp3', path: '/x.mp3', status: 'missing' }] }),
    referencedAssetRefs: ['b2.mp3'],
  });
  const result = await run.run();
  assert.equal(result.outcome, ADVANCED_PRODUCTION.REFUSED);
  assert.deepEqual(run.trace, ['assess', 'refuse']);
  assert.equal(run.refusals[0].kind, EXPORT_REFUSAL.MEDIA_UNAVAILABLE);
});

test('la vérification au départ suit les références du document courant', async () => {
  const project = graphProject({ bindings: [
    { assetRef: 'ancien.mp3', path: '/perdu.mp3', status: 'missing' },
    ...PRESENT,
  ] });
  const trace = [];
  const result = await runAdvancedProduction({
    readProject: () => project,
    assessReadiness: async (snapshot) => {
      assert.equal(snapshot, project);
      trace.push('assess');
      return HEALTHY;
    },
    readReferencedMedia: async (snapshot) => {
      assert.equal(snapshot, project);
      trace.push('mediaRefs');
      return ['a1.mp3'];
    },
    chooseFolder: async () => {
      trace.push('chooseFolder');
      return '/sorties';
    },
    start: async () => {
      trace.push('start');
    },
    refuse: () => trace.push('refuse'),
    options: {},
  });
  assert.equal(result.outcome, ADVANCED_PRODUCTION.STARTED);
  assert.deepEqual(trace, ['assess', 'mediaRefs', 'chooseFolder', 'start']);
});

test('une lecture impossible des médias refuse avant le choix du dossier', async () => {
  const trace = [];
  const result = await runAdvancedProduction({
    readProject: () => graphProject(),
    assessReadiness: async () => HEALTHY,
    readReferencedMedia: async () => { throw new Error('lecture impossible'); },
    chooseFolder: async () => { trace.push('chooseFolder'); },
    start: async () => { trace.push('start'); },
    refuse: () => trace.push('refuse'),
    options: {},
  });
  assert.equal(result.outcome, ADVANCED_PRODUCTION.REFUSED);
  assert.deepEqual(trace, ['refuse']);
});

test('un inventaire média absent ne vaut jamais zéro média', async () => {
  const trace = [];
  const result = await runAdvancedProduction({
    readProject: () => graphProject(),
    assessReadiness: async () => HEALTHY,
    chooseFolder: async () => trace.push('chooseFolder'),
    start: async () => trace.push('start'),
    refuse: () => trace.push('refuse'),
    options: {},
  });
  assert.equal(result.outcome, ADVANCED_PRODUCTION.REFUSED);
  assert.deepEqual(trace, ['refuse']);
});

test('abandonner au sélecteur de dossier ne lance rien et ne refuse rien', async () => {
  const trace = [];
  const result = await runAdvancedProduction({
    readProject: () => graphProject({ bindings: PRESENT }),
    assessReadiness: async () => HEALTHY,
    readReferencedMedia: async () => ['a1.mp3'],
    chooseFolder: async () => null,
    start: async () => trace.push('start'),
    refuse: () => trace.push('refuse'),
    options: {},
  });
  assert.equal(result.outcome, ADVANCED_PRODUCTION.CANCELLED);
  assert.deepEqual(trace, []);
});

test('une qualification qui ne peut pas être calculée n’est pas un franchissement', async () => {
  const run = journey({ assessThrows: new Error('IPC coupée') });
  const result = await run.run();
  assert.equal(result.outcome, ADVANCED_PRODUCTION.REFUSED);
  assert.deepEqual(run.trace, ['assess', 'refuse']);
  assert.equal(run.refusals[0].kind, EXPORT_REFUSAL.REQUEST);
  assert.match(run.refusals[0].message, /IPC coupée/);
});

// ── Les trois options, et les deux durées ───────────────────────────────────

test('les défauts pré-cochés sont les mêmes des deux côtés, y compris sans réglage', () => {
  // Un projet graphe ne porte rien tant que l'auteur n'a touché à rien ;
  // l'absence vaut le défaut, elle ne vaut pas « ne rien faire ».
  assert.deepEqual(readPackAudioProcessing(undefined), { silenceMode: 'normalize', harmonizeLoudness: true });
  assert.deepEqual(readPackAudioProcessing({}), { silenceMode: 'normalize', harmonizeLoudness: true });
  // Un choix explicite est respecté, dans les deux sens.
  assert.deepEqual(
    readPackAudioProcessing({ silenceMode: 'off', harmonizeLoudness: false }),
    { silenceMode: 'off', harmonizeLoudness: false },
  );
});

test('les deux durées atteignent la demande qui part au moteur', () => {
  const options = advancedPackAudioOptions(
    { silenceMode: 'normalize', harmonizeLoudness: true },
    { leading: 1.5, trailing: 0.8 },
  );
  const request = buildExportRequest({
    project: graphProject(),
    outputFolder: '/sorties',
    options,
  });
  assert.equal(request.options.silenceMode, 'normalize');
  assert.equal(request.options.harmonizeLoudness, true);
  assert.equal(request.options.leadingSilenceSec, 1.5);
  assert.equal(request.options.trailingSilenceSec, 0.8);
});

test('changer la durée dans les préférences change ce qui part', () => {
  const before = advancedPackAudioOptions({ silenceMode: 'add' }, { leading: 0.4, trailing: 0.4 });
  const after = advancedPackAudioOptions({ silenceMode: 'add' }, { leading: 2, trailing: 3 });
  assert.equal(
    buildExportRequest({ project: graphProject(), outputFolder: '/s', options: before })
      .options.leadingSilenceSec,
    0.4,
  );
  const sent = buildExportRequest({ project: graphProject(), outputFolder: '/s', options: after }).options;
  assert.equal(sent.leadingSilenceSec, 2);
  assert.equal(sent.trailingSilenceSec, 3);
});

test('en mode « ne rien faire », les durées ne sont pas transmises', () => {
  const options = advancedPackAudioOptions(
    { silenceMode: 'off', harmonizeLoudness: false },
    { leading: 1.5, trailing: 0.8 },
  );
  const sent = buildExportRequest({ project: graphProject(), outputFolder: '/s', options }).options;
  assert.deepEqual(sent, { silenceMode: 'off', harmonizeLoudness: false });
});

test('auto-next ne part jamais au moteur depuis le graphe', () => {
  // L'option n'existe que dans le constructeur d'arbre ; rien de ce qui part
  // par cette chaîne ne peut la porter, même si le projet l'a gardée en
  // mémoire d'un autre éditeur.
  const options = advancedPackAudioOptions({ silenceMode: 'normalize', autoNext: true });
  assert.equal('autoNext' in options, false);
  const sent = buildExportRequest({ project: graphProject(), outputFolder: '/s', options }).options;
  assert.equal('autoNext' in sent, false);
});

// Un pack dont aucun Écran ne porte de média ne joue rien, et STUdio refuse son
// archive. Il est refusé avant le dossier, au même endroit qu'un média manquant.
test('un pack sans aucun média est refusé avant le choix du dossier', async () => {
  const run = journey({ project: graphProject(), referencedAssetRefs: [] });
  const result = await run.run();
  assert.equal(result.outcome, ADVANCED_PRODUCTION.REFUSED);
  assert.deepEqual(run.trace, ['assess', 'refuse']);
  assert.equal(run.refusals[0].kind, EXPORT_REFUSAL.REQUEST);
  assert.match(run.refusals[0].message, /aucun son ni aucune image/);
  assert.equal(run.refusals[0].beforeEngine, true);
});

test('un seul média suffit à franchir cette étape', () => {
  assert.equal(emptyPackBlockage(['a1.mp3']), null);
  assert.notEqual(emptyPackBlockage([]), null);
  // Un inventaire illisible n'est pas « zéro média » : il a son propre refus.
  assert.equal(emptyPackBlockage(undefined), null);
});

test('le document bloqué passe avant le pack sans média', () => {
  const refusal = advancedProductionBlockage({
    readinessSummary: BLOCKED,
    project: graphProject(),
    referencedAssetRefs: [],
  });
  assert.equal(refusal.preparationKind, PREPARATION_REFUSAL.READINESS_BLOCKED);
});
