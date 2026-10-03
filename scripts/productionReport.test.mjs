// Le rapport de production commun aux deux éditeurs.
//
// Ce que ces tests tiennent n'est pas la mise en page : c'est ce que le rapport
// **a le droit de dire**. Il normalise ce que les deux chaînes ont réellement
// en commun, n'invente aucun contrôle absent d'une chaîne, et n'aplatit aucun
// diagnostic propre à l'autre.
//
// **Il n'y a qu'une fonction et qu'un objet.** Les deux natures de
// travail vivent dans la même file ; le rapport les lit donc de la même
// description, et ce qui reste propre à l'une tient en deux branches nommées.
//
// Tout est pur : aucun React, aucun Tauri, aucun disque.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GATES_NOT_REPORTED,
  PRODUCTION_SOURCE,
  PRODUCTION_STATUS,
  PRODUCTION_STATUS_LABELS,
  renderJobReport,
} from '../src/store/production/productionReport.js';
import {
  GATE_OUTCOME,
  OBSERVATION_NOTICE,
} from '../src/store/production/productionGates.js';
import { WORK_NATURE } from '../src/store/production/renderQueueWork.js';

function job(fields = {}) {
  return {
    id: 'j1',
    nature: WORK_NATURE.FREE,
    projectName: 'Le Renard',
    outputFolder: '/sorties',
    status: 'pending',
    cancelRequested: false,
    logs: [],
    resultPath: null,
    warnings: [],
    errorMessage: null,
    ...fields,
  };
}

// Un travail de la **même** file, de l'autre nature. Rien ne le distingue d'un
// travail Libre sinon ce que sa chaîne sait dire en plus : un résumé d'archive
// et un refus typé.
function graphJob(fields = {}) {
  return job({ nature: WORK_NATURE.ADVANCED, projectName: 'Le Renard (graphe)', ...fields });
}

const freeReport = (fields) => renderJobReport(job(fields));
const graphReport = (fields) => renderJobReport(graphJob(fields));

// ── Le même vocabulaire des deux côtés ──────────────────────────────────────

test('les deux chaînes rendent les mêmes états, sous les mêmes noms', () => {
  const produced = [
    freeReport({ status: 'done', resultPath: '/sorties/pack.zip' }),
    graphReport({
      status: 'done',
      resultPath: '/sorties/pack.zip',
      result: { zipPath: '/sorties/pack.zip', warnings: [] },
    }),
  ];
  for (const report of produced) {
    assert.equal(report.status, PRODUCTION_STATUS.SUCCEEDED);
    assert.equal(report.statusLabel, PRODUCTION_STATUS_LABELS[PRODUCTION_STATUS.SUCCEEDED]);
    assert.equal(report.result.zipPath, '/sorties/pack.zip');
    assert.equal(report.result.outputFolder, '/sorties');
  }
  assert.equal(produced[0].source, PRODUCTION_SOURCE.FREE);
  assert.equal(produced[1].source, PRODUCTION_SOURCE.ADVANCED);
});

test('la progression est en cours des deux côtés, et l’annulation y est offerte', () => {
  const free = freeReport({ status: 'running', logs: ['▶ Démarrage'] });
  const graph = graphReport({ status: 'running', logs: ['▶ Démarrage'] });
  for (const report of [free, graph]) {
    assert.equal(report.status, PRODUCTION_STATUS.RUNNING);
    assert.equal(report.busy, true);
    assert.equal(report.cancel.available, true);
    assert.deepEqual(report.progress.lines, ['▶ Démarrage']);
    assert.equal(report.progress.note, "Le pack apparaîtra ici dès qu'il sera prêt.");
    assert.doesNotMatch(report.progress.note, /moteur|journal/i);
  }
});

test('une production terminée ne conserve aucun commentaire de progression', () => {
  for (const report of [
    freeReport({ status: 'done', resultPath: '/sorties/pack.zip', logs: ['Terminé'] }),
    graphReport({
      status: 'done',
      resultPath: '/sorties/pack.zip',
      result: { zipPath: '/sorties/pack.zip', warnings: [] },
      logs: ['Terminé'],
    }),
  ]) {
    assert.equal(report.progress.note, null);
  }
});

test('une annulation demandée se voit avant d’être constatée', () => {
  const free = freeReport({ status: 'running', cancelRequested: true });
  const graph = graphReport({ status: 'running', cancelRequested: true });
  for (const report of [free, graph]) {
    assert.equal(report.cancel.requested, true);
    // Demandée n'est pas obtenue : l'état reste « en cours » tant que le moteur
    // n'a pas rendu la main.
    assert.equal(report.status, PRODUCTION_STATUS.RUNNING);
  }
});

// ── Ce que le rapport n'invente pas ─────────────────────────────────────────

test('une production qui ne rapporte aucun contrôle le dit, au lieu de se taire', () => {
  // Une production antérieure au branchement des portes, ou un travail qui n'est
  // pas allé jusqu'à l'archive. Une liste vide se lirait « tout va bien ».
  const free = freeReport({ status: 'done', resultPath: '/sorties/pack.zip' });
  assert.deepEqual(free.gates.entries, []);
  assert.equal(free.gates.note, GATES_NOT_REPORTED);
  assert.equal(free.gates.observing, false);
});

test('un succès sans archive ne prétend avoir franchi aucune porte', () => {
  const graph = graphReport({
    status: 'done', resultPath: null, result: { zipPath: null, warnings: [] },
  });
  assert.deepEqual(graph.gates.entries, []);
  assert.equal(graph.gates.note, GATES_NOT_REPORTED);
});

// ── Les trois contrôles d'archive ────────────────────────────────────────────

test('la chaîne avancée porte ses trois portes comme bloquantes après publication', () => {
  // Elle refuse **avant** de publier : une archive publiée les a toutes
  // franchies. Ce n'est pas une déduction optimiste, c'est l'ordre de ses
  // étapes — la publication est postérieure à la relecture.
  const graph = graphReport({
    status: 'done',
    resultPath: '/sorties/pack.zip',
    result: { zipPath: '/sorties/pack.zip', warnings: [] },
  });
  assert.equal(graph.gates.entries.length, 3);
  assert.deepEqual(
    graph.gates.entries.map(gate => gate.gate),
    ['readiness', 'pack-identity', 'archive-review'],
  );
  assert.ok(graph.gates.entries.every(gate => gate.blocking));
  assert.ok(graph.gates.entries.every(gate => gate.outcome === GATE_OUTCOME.PASSED));
  assert.equal(graph.gates.entries[0].outcomeLabel, 'Franchie');
  // Aucune chaîne en observation ici : pas d'avis à donner sur une décision.
  assert.equal(graph.gates.observing, false);
  assert.equal(graph.gates.notice, null);
  assert.equal(graph.gates.observedRefusal, false);
});

test('la chaîne libre porte les mêmes portes, en observation et sans refuser', () => {
  const free = freeReport({
    status: 'done',
    resultPath: '/sorties/pack.zip',
    gateObservations: [
      {
        gate: 'readiness',
        label: "Readiness d'export",
        outcome: 'passed',
        blocking: false,
        reasons: [],
        note: 'interopérabilité Untested',
      },
      {
        gate: 'pack-identity',
        label: 'Identité du pack',
        outcome: 'would-refuse',
        blocking: false,
        reasons: [{
          code: 'PACK_IDENTITY',
          path: '/stageNodes[0]/uuid',
          message: "La packIdentity stable n'est pas bridge-compatible.",
        }],
        note: 'origine SquareOneStage',
      },
    ],
  });

  assert.equal(free.gates.entries.length, 2);
  assert.ok(free.gates.entries.every(gate => gate.blocking === false));
  assert.equal(free.gates.observing, true);
  assert.equal(free.gates.notice, OBSERVATION_NOTICE);
  assert.equal(free.gates.observedRefusal, true);

  // Le verdict ne se lit pas comme celui d'une porte qui décide.
  assert.equal(free.gates.entries[0].outcomeLabel, 'Rien à signaler');
  assert.equal(free.gates.entries[1].outcomeLabel, 'Aurait refusé');

  // Et surtout : la production reste un succès. Une porte en observation ne
  // change ni l'état, ni le chemin du pack produit.
  assert.equal(free.status, PRODUCTION_STATUS.SUCCEEDED);
  assert.equal(free.result.zipPath, '/sorties/pack.zip');
  assert.equal(free.problem, null);
});

test('un refus observé porte toujours son motif, sinon il n’est pas exploitable', () => {
  const free = freeReport({
    status: 'done',
    resultPath: '/sorties/pack.zip',
    gateObservations: [{
      gate: 'archive-review',
      label: "Relecture de l'archive",
      outcome: 'would-refuse',
      blocking: false,
      reasons: [{ code: 'ARCHIVE_DISAGREEMENT', path: 'assets/a.mp3', message: 'attendu X ; observé Y' }],
      note: '12 entrée(s) relue(s)',
    }],
  });
  const [gate] = free.gates.entries;
  assert.equal(gate.reasons.length, 1);
  assert.equal(gate.reasons[0].code, 'ARCHIVE_DISAGREEMENT');
  assert.equal(gate.reasons[0].path, 'assets/a.mp3');
  assert.ok(gate.reasons[0].message.length > 0);
});

test('la chaîne libre, portes activées, parle le vocabulaire d’une porte qui décide', () => {
  // Les trois portes bloquent des deux côtés. Le moteur dit `blocking: true` ;
  // l'interface ne le suppose pas.
  const free = freeReport({
    status: 'done',
    resultPath: '/sorties/pack.zip',
    gateObservations: [{
      gate: 'archive-review',
      label: "Relecture de l'archive",
      outcome: 'passed',
      blocking: true,
      reasons: [],
      note: '42 entrée(s) relue(s) et rattachée(s)',
    }],
  });

  assert.equal(free.gates.entries[0].outcomeLabel, 'Franchie');
  // Plus rien n'annonce une observation : ces portes décident.
  assert.equal(free.gates.observing, false);
  assert.equal(free.gates.notice, null);
  assert.equal(free.gates.observedRefusal, false);
});

test('un refus bloquant n’est pas rapporté comme un pack produit', () => {
  // Quand une porte arrête la production, le moteur ne rend aucun chemin : le
  // travail part en erreur avec le message de refus, et le rapport ne peut pas
  // afficher un pack qui n'existe pas.
  const free = freeReport({
    status: 'error',
    resultPath: null,
    errorMessage: "Production refusée avant publication. Aucune archive n'a été écrite dans le dossier de sortie.\n• Readiness d'export — 1 motif(s) :\n    DUPLICATE_STAGE_ID /stageNodes[1]/uuid — deux écrans portent le même identifiant",
  });

  assert.equal(free.status, PRODUCTION_STATUS.FAILED);
  assert.equal(free.result, null);
  assert.ok(free.problem.message.includes('Production refusée avant publication'));
  assert.ok(free.problem.message.includes('DUPLICATE_STAGE_ID'));
  // Aucun verdict n'est affiché : il n'y a pas d'archive à commenter.
  assert.deepEqual(free.gates.entries, []);
  assert.equal(free.gates.note, GATES_NOT_REPORTED);
});

test('un verdict inconnu ne devient jamais un franchissement', () => {
  // Une version du moteur plus récente que cette interface ne doit pas faire
  // lire « contrôle passé » sur un mot qu'elle ne connaît pas.
  const free = freeReport({
    status: 'done',
    resultPath: '/sorties/pack.zip',
    gateObservations: [{ gate: 'readiness', label: 'X', outcome: 'quelque-chose-de-neuf' }],
  });
  assert.equal(free.gates.entries[0].outcome, GATE_OUTCOME.NOT_OBSERVED);
  assert.equal(free.gates.entries[0].outcomeLabel, 'Non observée');
});

test('le journal n’est pas coupé, et le compte est celui des lignes', () => {
  // Le journal de la chaîne graphe vit dans le travail, comme celui du Libre :
  // pas de fenêtre des 400 dernières lignes, rien n'est coupé, et le compte ne
  // peut pas mentir.
  const graph = graphReport({ status: 'running', logs: ['a', 'b', 'c'] });
  assert.equal(graph.progress.count, 3);
  assert.deepEqual([...graph.progress.lines], ['a', 'b', 'c']);

  const free = freeReport({ status: 'running', logs: ['a', 'b'] });
  assert.equal(free.progress.count, 2);
});

// ── Ce que le rapport n'aplatit pas ─────────────────────────────────────────

test('une annulation n’est pas une panne, et une panne d’écriture reste une panne', () => {
  const cancelled = graphReport({
    status: 'canceled',
    refusal: { kind: 'export-cancelled', cancelled: true, residue: false, title: 'Export annulé', message: '' },
  });
  assert.equal(cancelled.status, PRODUCTION_STATUS.CANCELLED);
  // L'état suffit, des deux côtés : une annulation n'est pas un problème.
  assert.equal(cancelled.problem, null);
  assert.equal(freeReport({ status: 'canceled', errorMessage: 'Annulé' }).problem, null);

  // Le nettoyage d'un `.partial` qui échoue emprunte la branche `output-write`,
  // même quand l'auteur venait de demander l'annulation. Le présenter comme une
  // simple annulation masquerait un résidu sur le disque.
  const residue = graphReport({
    status: 'error',
    refusal: { kind: 'output-write', cancelled: false, residue: true, title: 'Écriture impossible', message: 'disque plein' },
  });
  assert.equal(residue.status, PRODUCTION_STATUS.FAILED);
  assert.equal(residue.problem.title, 'Écriture impossible');
  assert.equal(residue.problem.message, 'disque plein');
});

test('le rapport porte le titre et le message d’un refus, jamais ses listes typées', () => {
  // Les médias manquants, les collisions et les désaccords restent rendus par
  // le composant de leur chaîne. Les faire entrer ici aurait obligé à leur
  // donner une forme commune qu'ils n'ont pas.
  const graph = graphReport({
    status: 'error',
    refusal: {
      kind: 'media-unavailable',
      cancelled: false,
      title: 'Médias indisponibles',
      message: '3 références',
      entries: [{ assetRef: 'a' }],
      conflicts: [],
    },
  });
  assert.deepEqual(Object.keys(graph.problem).sort(), ['message', 'title']);
});

test('les avertissements audio accompagnent un succès, ils n’en font pas un échec', () => {
  const free = freeReport({
    status: 'done',
    resultPath: '/sorties/pack.zip',
    warnings: [{ code: 'loudness', message: 'volume corrigé' }],
  });
  assert.equal(free.status, PRODUCTION_STATUS.SUCCEEDED);
  assert.equal(free.problem, null);
  assert.equal(free.result.warnings.length, 1);
});

test('un travail en attente n’a ni résultat ni problème, et reste annulable', () => {
  const free = freeReport({ status: 'pending' });
  assert.equal(free.status, PRODUCTION_STATUS.PENDING);
  assert.equal(free.result, null);
  assert.equal(free.problem, null);
  assert.equal(free.cancel.available, true);
  assert.equal(free.busy, false);
});

test('sans travail, il n’y a pas de rapport', () => {
  assert.equal(renderJobReport(null), null);
  // Un état inconnu ne devient jamais un succès : il retombe sur « aucune
  // production », et rien n'est affirmé du dossier de sortie.
  assert.equal(graphReport({ status: 'quelque-chose-de-neuf' }).status, PRODUCTION_STATUS.IDLE);
});
