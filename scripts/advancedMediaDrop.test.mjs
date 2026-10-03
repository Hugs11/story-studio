// Le dépôt d'un média sur un Écran du graphe, et le choix de sa référence.
//
// Ce que ces tests éprouvent : **un dépôt est un geste d'auteur**, et le geste
// assemblé est celui que Rust accepte. Deux règles du codec gouvernent la
// forme, et chacune a son témoin ici :
//
// - un emplacement fourni exige une référence encore **libre** ;
// - une référence déjà liée se partage **sans** chemin.
//
// La conséquence visible est la parité avec le Libre : deux histoires qui
// portent le même fichier portent le même chemin ; deux Écrans qui portent le
// même fichier partagent la même référence. Reliaison comprise.
//
// Tout est pur : ni React, ni Tauri, ni moteur d'affichage.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGraphIndex } from '../src/store/advancedGraphView/graphViewModel.js';
import {
  advancedMediaField,
  boundAssetRefForPath,
  freeAssetRef,
  planStageMediaAssignment,
  resolveGraphDropTarget,
} from '../src/store/advancedAuthoring/mediaDrop.js';
import { sampleView } from './advancedViewFixtures.mjs';

const DIR = '/projets/renard';
const COMMUN = `${DIR}/medias/commun.mp3`;
const AUTRE = `${DIR}/medias/autre.mp3`;

function advancedProject(bindings = []) {
  return {
    schemaVersion: 4,
    authoringMode: 'advanced',
    projectType: 'advanced',
    projectName: 'renard-avance',
    rootEntries: [],
    authoring: {
      payload: '{"payloadVersion":1}',
      editorState: { version: 1 },
      mediaBindings: bindings,
    },
  };
}

const bound = (assetRef, path) => ({ assetRef, path, status: 'resolved' });

test('seuls l’audio et l’image ont un emplacement sur un Écran', () => {
  assert.equal(advancedMediaField('audio'), 'audio');
  assert.equal(advancedMediaField('image'), 'image');
  // Un ZIP ou un texte n'a nulle part où aller : le refus est net, et il vaut
  // avant le relâchement — le canvas n'accepte pas la cible.
  assert.equal(advancedMediaField('zip'), null);
  assert.equal(advancedMediaField(undefined), null);
});

test('un fichier encore inconnu du projet reçoit une référence neuve et son emplacement', () => {
  const project = advancedProject();
  const plan = planStageMediaAssignment({
    project, stageUuid: 'entry', kind: 'audio', path: COMMUN,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.shared, false);
  assert.deepEqual(plan.gesture, {
    gesture: 'set-stage-media',
    stageUuid: 'entry',
    field: 'audio',
    update: { form: 'set', assetRef: 'commun.mp3', location: { path: COMMUN, present: true } },
  });
});

test('le même fichier déposé sur un second Écran partage la référence, sans chemin', () => {
  // La règle du Libre transposée : deux histoires qui portent le même fichier
  // portent le même chemin, donc une reliaison les déplace ensemble. Ici, deux
  // Écrans partagent la même référence, et `repoint-media` les déplace ensemble.
  const project = advancedProject([bound('commun.mp3', COMMUN)]);
  const plan = planStageMediaAssignment({
    project, stageUuid: 'second', kind: 'audio', path: COMMUN,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.shared, true);
  // Sans `location` : fournir un chemin pour une référence déjà liée est
  // `ASSET_REF_ALREADY_BOUND`, et fournir le chemin d'un partage serait une
  // re-pointe silencieuse de tous les autres Écrans.
  assert.deepEqual(plan.gesture.update, { form: 'set', assetRef: 'commun.mp3' });
});

test('la comparaison des chemins est celle de la médiathèque, pas une égalité de chaînes', () => {
  const project = advancedProject([bound('commun.mp3', 'C:\\Projets\\Renard\\commun.mp3')]);
  assert.equal(boundAssetRefForPath(project, 'c:/projets/renard/commun.mp3'), 'commun.mp3');
  assert.equal(boundAssetRefForPath(project, `${DIR}/medias/ailleurs.mp3`), null);
});

test('deux fichiers homonymes dans deux dossiers ne se refusent pas l’un l’autre', () => {
  // Sans désambiguïsation, le second dépôt partait avec une référence déjà
  // liée **et** un emplacement : Rust le refusait, et l'auteur ne pouvait pas
  // poser son second `voix.flac`.
  const project = advancedProject([bound('voix.flac', `${DIR}/a/voix.flac`)]);
  assert.equal(freeAssetRef(project, `${DIR}/b/voix.flac`), 'voix-2.flac');

  const plan = planStageMediaAssignment({
    project, stageUuid: 'entry', kind: 'audio', path: `${DIR}/b/voix.flac`,
  });
  assert.equal(plan.shared, false);
  assert.equal(plan.gesture.update.assetRef, 'voix-2.flac');
  assert.equal(plan.gesture.update.location.path, `${DIR}/b/voix.flac`);
});

test('la désambiguïsation continue tant que la référence est prise', () => {
  const project = advancedProject([
    bound('voix.flac', `${DIR}/a/voix.flac`),
    bound('voix-2.flac', `${DIR}/b/voix.flac`),
  ]);
  assert.equal(freeAssetRef(project, `${DIR}/c/voix.flac`), 'voix-3.flac');
});

test('une référence sans liaison ne se confond pas avec une référence libre', () => {
  // Une liaison dont le fichier manque reste une liaison : sa référence est
  // prise, et un dépôt homonyme ne doit pas tenter de la re-lier au passage.
  const project = advancedProject([{ assetRef: 'commun.mp3', path: null, status: 'missing' }]);
  assert.equal(boundAssetRefForPath(project, COMMUN), null);
  assert.equal(freeAssetRef(project, COMMUN), 'commun-2.mp3');
});

test('un projet Libre n’a pas de liaisons, et le plan reste assemblable', () => {
  const libre = { schemaVersion: 4, projectType: 'classic', rootEntries: [] };
  assert.equal(freeAssetRef(libre, AUTRE), 'autre.mp3');
  assert.equal(boundAssetRefForPath(libre, AUTRE), null);
});

test('un dépôt sans Écran, sans fichier ou de nature inconnue est refusé avant tout envoi', () => {
  const project = advancedProject();
  const noStage = planStageMediaAssignment({ project, stageUuid: '', kind: 'audio', path: COMMUN });
  assert.equal(noStage.ok, false);
  assert.equal(noStage.code, 'no-stage');

  const noPath = planStageMediaAssignment({ project, stageUuid: 'entry', kind: 'audio', path: '  ' });
  assert.equal(noPath.ok, false);
  assert.equal(noPath.code, 'no-path');

  const noField = planStageMediaAssignment({ project, stageUuid: 'entry', kind: 'zip', path: COMMUN });
  assert.equal(noField.ok, false);
  assert.equal(noField.code, 'unsupported-kind');
});

test('une image se dépose sur le champ image, pas sur l’audio', () => {
  const project = advancedProject([bound('commun.mp3', COMMUN)]);
  const plan = planStageMediaAssignment({
    project, stageUuid: 'entry', kind: 'image', path: `${DIR}/medias/couverture.png`,
  });
  assert.equal(plan.field, 'image');
  assert.equal(plan.gesture.field, 'image');
});

test('un Écran du canvas est une cible, et il est nommé avant le relâchement', () => {
  const index = buildGraphIndex(sampleView());
  const target = resolveGraphDropTarget({
    index, path: '/stageNodes/@uuid=entry#0', kind: 'audio',
  });
  assert.equal(target.uuid, 'entry');
  // Le nom est celui de l'Écran, parce que le canvas ne peut pas l'éclairer :
  // c'est le fantôme de glisser qui porte la cible.
  assert.equal(target.label, 'Entrée');
});

test('une Action n’est pas une cible : le dialecte ne lui donne aucun média', () => {
  const index = buildGraphIndex(sampleView());
  const actionPath = [...index.byPath.keys()].find((path) => path.startsWith('/actionNodes/'));
  assert.ok(actionPath, 'la vue d’essai porte au moins une Action');
  assert.equal(resolveGraphDropTarget({ index, path: actionPath, kind: 'audio' }), null);
});

test('le vide du canvas et un média sans emplacement ne désignent rien', () => {
  const index = buildGraphIndex(sampleView());
  assert.equal(resolveGraphDropTarget({ index, path: null, kind: 'audio' }), null);
  assert.equal(resolveGraphDropTarget({ index, path: '/stageNodes/@uuid=inconnu#0', kind: 'audio' }), null);
  assert.equal(resolveGraphDropTarget({ index, path: '/stageNodes/@uuid=entry#0', kind: 'zip' }), null);
});
