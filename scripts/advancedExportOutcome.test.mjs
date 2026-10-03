// Ce que l'export dit, lu sans jamais analyser une phrase.
//
// Tout est **pur** : ni React, ni Tauri, ni disque. Ce que ces tests éprouvent
// est la lecture des retours typés de `export_advanced_pack` et de
// `assess_advanced_payload_readiness` — les sept refus, les cinq sous-types de
// préparation, la séparation blocage / qualification, et les deux pièges à ne
// pas manquer : l'annulation qui n'efface pas une panne d'écriture, et la
// couverture absente qui reste un succès.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPORT_REFUSAL,
  PREPARATION_REFUSAL,
  classifyExportRefusal,
  groupUnavailableMedia,
  isReviewCurrent,
  repairByReferenceOnly,
  summarizeExportSuccess,
} from '../src/store/advancedExport/exportOutcome.js';
import {
  READINESS_LEVEL,
  readinessDiagnosticLevel,
  summarizeReadiness,
} from '../src/store/advancedExport/exportReadiness.js';
import {
  DEFAULT_EXPORT_AUDIO_OPTIONS,
  ExportRequestError,
  buildExportRequest,
  exportRequestRevision,
  exportRevisionToken,
} from '../src/store/advancedExport/exportRequest.js';

// ── La demande ───────────────────────────────────────────────────────────────

function advancedProject({ payload = '{"payloadVersion":1}', bindings = [] } = {}) {
  return {
    schemaVersion: 4,
    authoringMode: 'advanced',
    projectType: 'advanced',
    projectName: 'pack repris',
    rootEntries: [],
    authoring: { payload, editorState: { version: 1 }, mediaBindings: bindings },
  };
}

test("la demande part du projet courant, payload et liaisons ensemble", () => {
  const bindings = [{ assetRef: 'a1.mp3', path: '/w/a1.mp3', status: 'resolved' }];
  const request = buildExportRequest({
    project: advancedProject({ payload: 'DOC-42', bindings }),
    outputFolder: '/sorties',
  });
  assert.equal(request.payload, 'DOC-42');
  assert.deepEqual(request.mediaBindings, bindings);
  assert.equal(request.outputFolder, '/sorties');
  assert.equal(request.projectName, 'pack repris');
});

test('un nom de projet vide laisse le moteur choisir « Sans titre »', () => {
  const project = { ...advancedProject(), projectName: '   ' };
  const request = buildExportRequest({ project, outputFolder: '/sorties' });
  assert.equal('projectName' in request, false);
});

test('la révision capturée correspond au projet affiché, nom compris', () => {
  const project = advancedProject({ payload: 'DOC-NOM' });
  const request = buildExportRequest({ project, outputFolder: '/sorties' });
  assert.equal(exportRequestRevision(request), exportRevisionToken(project));
});

// La vignette catalogue est un média d'enveloppe, comme côté Libre : elle ne
// passe ni par le payload ni par les liaisons, et son absence laisse le moteur
// sur son repli — l'image de l'Écran d'entrée.

test('la vignette catalogue de l’enveloppe part avec la demande', () => {
  const project = { ...advancedProject(), thumbnailImage: '/medias/cover.png' };
  const request = buildExportRequest({ project, outputFolder: '/sorties' });
  assert.equal(request.coverImage, '/medias/cover.png');
});

test('sans vignette, aucune couverture n’est transmise et le repli reste au moteur', () => {
  const request = buildExportRequest({ project: advancedProject(), outputFolder: '/sorties' });
  assert.equal('coverImage' in request, false);
});

test('une vignette vide ou blanche ne se transmet pas comme un choix', () => {
  for (const value of ['', '   ', null, undefined]) {
    const project = { ...advancedProject(), thumbnailImage: value };
    const request = buildExportRequest({ project, outputFolder: '/sorties' });
    assert.equal('coverImage' in request, false, `valeur rejetée : ${JSON.stringify(value)}`);
  }
});

// Les deux éditeurs fabriquent le même pack pour le même appareil : le défaut
// du Libre est commun. Conséquence assumée : un projet graphe dont l'auteur ne
// touche à rien voit ses sons mesurés et ré-encodés, et non recopiés.
test("sans choix d'auteur, les défauts du Libre partent au moteur", () => {
  const request = buildExportRequest({ project: advancedProject(), outputFolder: '/sorties' });
  assert.equal(request.options.silenceMode, 'normalize');
  assert.equal(request.options.harmonizeLoudness, true);
  assert.equal(DEFAULT_EXPORT_AUDIO_OPTIONS.silenceMode, 'normalize');
  assert.equal(DEFAULT_EXPORT_AUDIO_OPTIONS.harmonizeLoudness, true);
});

test('un choix explicite de ne rien faire est respecté', () => {
  const request = buildExportRequest({
    project: advancedProject(),
    outputFolder: '/sorties',
    options: { silenceMode: 'off', harmonizeLoudness: false },
  });
  assert.deepEqual(request.options, { silenceMode: 'off', harmonizeLoudness: false });
});

test("les durées de silence ne sont transmises que là où elles s'appliquent", () => {
  const off = buildExportRequest({
    project: advancedProject(),
    outputFolder: '/sorties',
    options: { silenceMode: 'off', leadingSilenceSec: 0.4, trailingSilenceSec: 0.4 },
  });
  assert.equal('leadingSilenceSec' in off.options, false);

  const added = buildExportRequest({
    project: advancedProject(),
    outputFolder: '/sorties',
    options: { silenceMode: 'add', leadingSilenceSec: 0.4, trailingSilenceSec: 0.6 },
  });
  assert.equal(added.options.leadingSilenceSec, 0.4);
  assert.equal(added.options.trailingSilenceSec, 0.6);
});

test('un mode de silence inconnu retombe sur le défaut au lieu de traverser', () => {
  const request = buildExportRequest({
    project: advancedProject(),
    outputFolder: '/sorties',
    options: { silenceMode: 'douceur' },
  });
  assert.equal(request.options.silenceMode, DEFAULT_EXPORT_AUDIO_OPTIONS.silenceMode);
});

test('un projet sans payload avancé et un dossier vide sont refusés avant tout appel', () => {
  assert.throws(
    () => buildExportRequest({ project: { projectType: 'pack', rootEntries: [] }, outputFolder: '/s' }),
    (error) => error instanceof ExportRequestError && error.code === 'ADVANCED_PAYLOAD_REQUIRED',
  );
  assert.throws(
    () => buildExportRequest({ project: advancedProject(), outputFolder: '   ' }),
    (error) => error instanceof ExportRequestError && error.code === 'OUTPUT_FOLDER_REQUIRED',
  );
});

test('le témoin de révision couvre le document ET ses liaisons, comparés à l’octet', () => {
  const lie = (path) => [{ assetRef: 'a1.mp3', path, status: 'resolved' }];

  // Deux documents identiques à l'octet rendent le même témoin ; un espace de
  // plus suffit à les séparer.
  assert.equal(
    exportRevisionToken(advancedProject({ payload: 'DOC-A' })),
    exportRevisionToken(advancedProject({ payload: 'DOC-A' })),
  );
  assert.notEqual(
    exportRevisionToken(advancedProject({ payload: 'DOC-A' })),
    exportRevisionToken(advancedProject({ payload: 'DOC-A ' })),
  );

  // Le titre de secours livré dépend du nom du projet. Le renommer périme
  // donc la relecture de l'archive précédente, même si le graphe est identique.
  assert.notEqual(
    exportRevisionToken(advancedProject({ payload: 'DOC-A' })),
    exportRevisionToken({ ...advancedProject({ payload: 'DOC-A' }), projectName: 'Autre nom' }),
  );

  // Remplacer le fichier derrière une référence ne touche ni `assetRef`
  // ni le payload. Un témoin réduit au payload affirmait encore que l'ancienne
  // archive correspondait au document ouvert.
  assert.notEqual(
    exportRevisionToken(advancedProject({ payload: 'DOC-A', bindings: lie('C:/ancien.wav') })),
    exportRevisionToken(advancedProject({ payload: 'DOC-A', bindings: lie('C:/nouveau.wav') })),
  );

  // Un relevé de disque n'est pas une révision : `status` reste dehors.
  assert.equal(
    exportRevisionToken(advancedProject({
      payload: 'DOC-A',
      bindings: [{ assetRef: 'a1.mp3', path: 'C:/ancien.wav', status: 'resolved' }],
    })),
    exportRevisionToken(advancedProject({
      payload: 'DOC-A',
      bindings: [{ assetRef: 'a1.mp3', path: 'C:/ancien.wav', status: 'missing' }],
    })),
  );

  // Un projet sans document d'auteur n'a pas de révision : deux absences ne se
  // comparent pas.
  assert.equal(exportRevisionToken({ projectType: 'pack', rootEntries: [] }), null);
});

// ── Les sept refus ───────────────────────────────────────────────────────────

test('chaque refus est lu par son kind, jamais par son message', () => {
  const decode = classifyExportRefusal({
    kind: 'payload-decode',
    error: { code: 'ADVANCED_PAYLOAD_INVALID', path: '/payload', found: 'x', expected: 'y' },
  });
  assert.equal(decode.kind, EXPORT_REFUSAL.PAYLOAD_DECODE);
  assert.equal(decode.codecError.code, 'ADVANCED_PAYLOAD_INVALID');

  const collision = classifyExportRefusal({
    kind: 'archive-name-collision',
    conflicts: [{ assetRef: 'a.mp3', archiveName: '0.mp3' }],
  });
  assert.equal(collision.conflicts.length, 1);

  const oracle = classifyExportRefusal({
    kind: 'media-oracle',
    disagreements: [{ assetRef: 'a.mp3', expected: 'x', observed: 'y' }],
  });
  assert.equal(oracle.disagreements.length, 1);
});

test('les cinq sous-types de préparation sont branchés sur preparation.error.kind', () => {
  const cases = [
    ['graph-integrity', PREPARATION_REFUSAL.GRAPH_INTEGRITY],
    ['authoring-action-required', PREPARATION_REFUSAL.AUTHORING_ACTION_REQUIRED],
    ['pack-identity', PREPARATION_REFUSAL.PACK_IDENTITY],
    ['readiness-blocked', PREPARATION_REFUSAL.READINESS_BLOCKED],
    ['standard-serialization', PREPARATION_REFUSAL.STANDARD_SERIALIZATION],
  ];
  for (const [kind, expected] of cases) {
    const refusal = classifyExportRefusal({ kind: 'preparation', error: { kind, message: 'peu importe' } });
    assert.equal(refusal.kind, EXPORT_REFUSAL.PREPARATION);
    assert.equal(refusal.preparationKind, expected);
  }
});

test("une annulation est une annulation ; un échec d'écriture reste un échec d'écriture", () => {
  const cancelled = classifyExportRefusal({ kind: 'export-cancelled' });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.residue, false);

  // La branche du nettoyage `.partial` devient `output-write`
  // exprès, pour ne pas masquer le résidu derrière une annulation.
  const residue = classifyExportRefusal({
    kind: 'output-write',
    path: '/sorties/pack.zip.partial',
    message: 'suppression impossible',
  });
  assert.equal(residue.cancelled, false);
  assert.equal(residue.residue, true);
  assert.equal(residue.path, '/sorties/pack.zip.partial');
});

test("un refus non typé est nommé comme tel, jamais rangé dans une famille de refus connue", () => {
  const untyped = classifyExportRefusal('le canal IPC a été coupé');
  assert.equal(untyped.kind, EXPORT_REFUSAL.UNTYPED);
  assert.equal(untyped.cancelled, false);
  assert.match(untyped.message, /canal IPC/);
});

// ── Médias indisponibles ─────────────────────────────────────────────────────

test('une référence partagée par plusieurs écrans est réparée une fois, tous ses usages listés', () => {
  const groups = groupUnavailableMedia([
    { assetRef: 'a.mp3', field: 'audio', stageIds: ['s1'], cause: 'not-found', detail: 'ENOENT' },
    { assetRef: 'a.mp3', field: 'audio', stageIds: ['s2', 's3'], cause: 'not-found', detail: 'ENOENT' },
    { assetRef: 'b.png', field: 'image', stageIds: ['s1'], cause: 'path-null', detail: '' },
  ]);
  assert.equal(groups.length, 2);
  const audio = groups.find((group) => group.assetRef === 'a.mp3');
  assert.deepEqual(audio.stageIds, ['s1', 's2', 's3']);
  assert.equal(audio.byReferenceOnly, false);
});

test("`path-null` et `binding-absent` se réparent par référence, sans ancien chemin", () => {
  assert.equal(repairByReferenceOnly({ cause: 'path-null' }), true);
  assert.equal(repairByReferenceOnly({ cause: 'binding-absent' }), true);
  assert.equal(repairByReferenceOnly({ cause: 'not-found' }), false);
});

// ── Le succès ────────────────────────────────────────────────────────────────

test("une archive sans couverture est un succès, et les empreintes restent hors du résumé", () => {
  const summary = summarizeExportSuccess({
    zipPath: '/sorties/pack.zip',
    hasThumbnail: false,
    conversions: [
      { assetRef: 'a.mp3', archiveName: '0.mp3', transformation: 'reencoded', outputSha256: 'ff' },
      { assetRef: 'b.png', archiveName: '1.png', transformation: 'verbatim', outputSha256: 'ee' },
      { assetRef: 'c.png', archiveName: '1.png', transformation: 'verbatim', deduplicatedWith: 'b.png' },
    ],
    warnings: ['nettoyage temporaire incomplet'],
  });
  assert.equal(summary.hasThumbnail, false);
  assert.equal(summary.assetCount, 3);
  assert.equal(summary.converted, true);
  assert.equal(summary.deduplicated, 1);
  assert.deepEqual(
    summary.transformations.map((line) => [line.transformation, line.count]),
    [['reencoded', 1], ['verbatim', 2]],
  );
  assert.deepEqual(summary.warnings, ['nettoyage temporaire incomplet']);
  // Le résumé ne porte aucune empreinte : elles restent dans `conversions`.
  assert.equal(JSON.stringify(summary.transformations).includes('ff'), false);
  assert.equal(summary.conversions[0].outputSha256, 'ff');
});

test("un export entièrement verbatim ne déclenche pas l'explication de conversion", () => {
  const summary = summarizeExportSuccess({
    zipPath: '/s/p.zip',
    conversions: [{ assetRef: 'a.mp3', archiveName: '0.mp3', transformation: 'verbatim' }],
  });
  assert.equal(summary.converted, false);
});

test("les avertissements d'harmonisation du graphe rejoignent la liste, avec leurs mesures", () => {
  const audio = {
    code: 'AUDIO_STRONG_LIMITING',
    label: 'Écran 2',
    message: "L'audio « Écran 2 » a nécessité une forte limitation pour être harmonisé ; certaines pointes peuvent sembler comprimées.",
    initialIntegratedLufs: -30,
    finalIntegratedLufs: -14.4,
    gainDb: 16,
    expectedLimitingDb: 12,
  };
  const summary = summarizeExportSuccess({
    zipPath: '/s/p.zip',
    conversions: [],
    audioWarnings: [audio],
    warnings: ['nettoyage temporaire incomplet'],
  });
  // Même forme que l'éditeur par menus : le compte rendu commun en tire le
  // message et le détail des mesures.
  assert.deepEqual(summary.warnings, [audio, 'nettoyage temporaire incomplet']);
});

// ── Readiness : blocage et qualification ─────────────────────────────────────

test('le niveau d’un diagnostic vient de sa source, et graph-integrity bloque toujours', () => {
  assert.equal(
    readinessDiagnosticLevel({ source: 'decode', severity: 'WARNING' }),
    READINESS_LEVEL.WARNING,
  );
  assert.equal(
    readinessDiagnosticLevel({ source: 'decode', severity: 'ERROR' }),
    READINESS_LEVEL.ERROR,
  );
  assert.equal(
    readinessDiagnosticLevel({ source: 'graph-integrity', code: 'GVI-001' }),
    READINESS_LEVEL.ERROR,
  );
  assert.equal(
    readinessDiagnosticLevel({ source: 'authoring', level: 'ACTION_REQUIRED' }),
    READINESS_LEVEL.ACTION_REQUIRED,
  );
  assert.equal(
    readinessDiagnosticLevel({ source: 'readiness', level: 'WARNING' }),
    READINESS_LEVEL.WARNING,
  );
});

// Cas limite : toutes les dimensions supportées, et pourtant bloqué.
test('SUPPORTED partout n’autorise pas l’export : blocage et qualification restent distincts', () => {
  const summary = summarizeReadiness({
    blocked: true,
    interoperability: 'SUPPORTED',
    dimensions: [
      { id: 'graph-topology', qualification: 'SUPPORTED', evidence: [] },
      { id: 'random-option-selection', qualification: 'SUPPORTED', evidence: [] },
    ],
    unevaluated: [],
    diagnostics: [
      {
        source: 'authoring',
        level: 'ACTION_REQUIRED',
        code: 'POSITION_OUT_OF_RANGE_ACTION_REQUIRED',
        path: '/stageNodes/0',
        message: 'décision attendue',
      },
    ],
  });
  assert.equal(summary.blocked, true);
  assert.equal(summary.interoperability, 'SUPPORTED');
  assert.equal(summary.blocking.length, 1);
  assert.equal(summary.advisory.length, 0);
});

test('UNTESTED est une limite de qualification, pas un refus', () => {
  const summary = summarizeReadiness({
    blocked: false,
    interoperability: 'UNTESTED',
    dimensions: [{ id: 'wheel-width', qualification: 'UNTESTED', evidence: [] }],
    unevaluated: [{ id: 'factory-disabled', lines: [], reason: 'aucun stage concerné' }],
    diagnostics: [
      { source: 'readiness', level: 'WARNING', code: 'ROOT_UUID_DIVERGENT', path: '/', message: 'provenance' },
    ],
  });
  assert.equal(summary.blocked, false);
  assert.equal(summary.blocking.length, 0);
  assert.equal(summary.advisory.length, 1);
  assert.equal(summary.unevaluated.length, 1);
});

// ── Le bandeau de relecture ──────────────────────────────────────────────────
//
// « Elle correspond au document actuellement ouvert » est une affirmation sur
// le **contenu** de l'archive. Un remplacement média change ses sons et ses
// images sans toucher au payload : le bandeau l'affirmait encore.

test("la relecture n'est courante que pour la révision et le travail qui l'ont produite", () => {
  const ancien = exportRevisionToken(advancedProject({
    payload: 'DOC-A',
    bindings: [{ assetRef: 'a1.mp3', path: 'C:/ancien.wav', status: 'resolved' }],
  }));
  const nouveau = exportRevisionToken(advancedProject({
    payload: 'DOC-A',
    bindings: [{ assetRef: 'a1.mp3', path: 'C:/nouveau.wav', status: 'resolved' }],
  }));
  const review = { zipPath: '/sorties/pack.zip', revision: ancien, epoch: 3 };

  assert.equal(isReviewCurrent(review, { revision: ancien, epoch: 3 }), true);

  // Le geste « Tous les usages… » : payload inchangé, chemin de liaison changé.
  assert.equal(isReviewCurrent(review, { revision: nouveau, epoch: 3 }), false,
    "l'ancien ZIP cesse d'être présenté comme celui du document ouvert");

  // Revenir en arrière rend l'archive courante à nouveau : la comparaison est
  // une valeur, pas un compteur.
  assert.equal(isReviewCurrent(review, { revision: ancien, epoch: 3 }), true);

  // Un autre travail, même révision : ce n'est pas le document ouvert.
  assert.equal(isReviewCurrent(review, { revision: ancien, epoch: 4 }), false);

  // Sans révision d'un côté ou de l'autre, la réponse est « non ».
  assert.equal(isReviewCurrent({ revision: null, epoch: 3 }, { revision: ancien, epoch: 3 }), false);
  assert.equal(isReviewCurrent(review, { revision: null, epoch: 3 }), false);
  assert.equal(isReviewCurrent(null, { revision: ancien, epoch: 3 }), false);
});
