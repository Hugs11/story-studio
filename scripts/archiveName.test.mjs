// Le nom du fichier produit par l'éditeur graphe.
//
// Sont prouvés : le nom attendu pour un titre donné, la version saisie
// retrouvée dans le nom, et la non-régression du nom de la chaîne Libre.
//
// Tout est pur : aucun React, aucun Tauri, aucun disque.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHIVE_NAMING_CONVENTION,
  ARCHIVE_NAMING_FREE,
  advancedArchiveBaseName,
  archiveNamingFields,
} from '../src/store/advancedExport/archiveName.js';
import { getExportPackName } from '../src/utils/packConvention.js';
import { buildExportRequest } from '../src/store/advancedExport/exportRequest.js';

const advancedProject = (packMetadata = null) => ({
  schemaVersion: 4,
  authoringMode: 'advanced',
  projectType: 'advanced',
  projectName: 'pack',
  rootEntries: [],
  ...(packMetadata ? { packMetadata } : {}),
  authoring: { payload: 'DOC', editorState: { version: 1 }, mediaBindings: [] },
});

// ── Le défaut ne pose rien que l'auteur n'ait saisi ─────────────────────────

test('sans réglage, le nom est le titre — exactement ce que la production faisait avant', () => {
  assert.equal(advancedArchiveBaseName({ title: 'Le Renard' }), 'Le Renard');
  assert.equal(advancedArchiveBaseName({ packMetadata: {}, title: 'Le Renard' }), 'Le Renard');
  // Et surtout : aucun « 3+ » n'apparaît. L'âge minimum n'existe pas dans le
  // document du graphe ; le poser par défaut sur le fichier en ferait une
  // valeur d'auteur que personne n'a saisie.
  assert.doesNotMatch(advancedArchiveBaseName({ title: 'Le Renard' }), /3\+/);
});

test('sans titre ni nom libre, rien n’est composé : le moteur nommera lui-même', () => {
  assert.equal(advancedArchiveBaseName({ title: '' }), '');
  assert.equal(advancedArchiveBaseName({}), '');
});

// ── Les quatre combinaisons que l'auteur doit pouvoir atteindre ─────────────

test('convention et version : le nom porte le numéro saisi', () => {
  const name = advancedArchiveBaseName({
    packMetadata: { namingMode: ARCHIVE_NAMING_CONVENTION, minAge: '6', author: 'Ésope' },
    title: 'Le Renard',
    version: 2,
  });
  assert.equal(name, '6+]Le_Renard[by_Ésope_V2');
});

test('convention sans version : le nom n’en porte aucune', () => {
  const name = advancedArchiveBaseName({
    packMetadata: { namingMode: ARCHIVE_NAMING_CONVENTION, minAge: '6', author: 'Ésope' },
    title: 'Le Renard',
    version: 1,
  });
  assert.equal(name, '6+]Le_Renard[by_Ésope');
});

test('nom libre et version : le nom reste celui que l’auteur a écrit', () => {
  // La version entre dans le **pack** dans les deux modes ; elle n'entre dans
  // le **nom** que si l'auteur a choisi la convention. C'est le sens du choix.
  const name = advancedArchiveBaseName({
    packMetadata: { namingMode: ARCHIVE_NAMING_FREE, legacyExportName: 'renard-final' },
    title: 'Le Renard',
    version: 2,
  });
  assert.equal(name, 'renard-final');
});

test('nom libre laissé vide : le titre reprend la main', () => {
  const name = advancedArchiveBaseName({
    packMetadata: { namingMode: ARCHIVE_NAMING_FREE, legacyExportName: '   ' },
    title: 'Le Renard',
    version: 3,
  });
  assert.equal(name, 'Le Renard');
});

// ── La version vient du document, jamais de l'enveloppe ─────────────────────

test('la version du nom est celle du document, pas une copie d’enveloppe', () => {
  // Une version traînant dans l'enveloppe ne doit pas nommer le fichier : le
  // document en est la seule autorité, et le fichier annoncerait sinon une
  // version que le pack ne porte pas.
  const name = advancedArchiveBaseName({
    packMetadata: { namingMode: ARCHIVE_NAMING_CONVENTION, minAge: '3', version: 9 },
    title: 'Le Renard',
    version: 2,
  });
  assert.equal(name, '3+]Le_Renard_V2');
});

test('le titre du nom est celui du document, pas une copie d’enveloppe', () => {
  const name = advancedArchiveBaseName({
    packMetadata: { namingMode: ARCHIVE_NAMING_CONVENTION, minAge: '3', title: 'Ancien titre' },
    title: 'Le Renard',
    version: 1,
  });
  assert.equal(name, '3+]Le_Renard');
});

// ── Ce que l'enveloppe a le droit de porter ─────────────────────────────────

test('seuls les champs du nommage sont retenus de l’enveloppe', () => {
  const fields = archiveNamingFields({
    minAge: '6', author: 'Ésope', producer: 'RTL', bonus: '8 chapitres',
    namingMode: ARCHIVE_NAMING_CONVENTION, legacyExportName: 'x',
    // Ceux-là appartiennent au document et ne doivent jamais être recopiés.
    title: 'Le Renard', version: 4, description: 'changelog', uuid: 'ID',
  });
  assert.deepEqual(Object.keys(fields).sort(), [
    'author', 'bonus', 'legacyExportName', 'minAge', 'namingMode', 'producer',
  ]);
});

test('un mode inconnu retombe sur le nom libre, jamais sur la convention', () => {
  // Retomber sur la convention poserait un âge minimum sur le fichier d'un
  // auteur qui n'a rien demandé.
  assert.equal(archiveNamingFields({ namingMode: 'n’importe quoi' }).namingMode, ARCHIVE_NAMING_FREE);
  assert.equal(archiveNamingFields({}).namingMode, ARCHIVE_NAMING_FREE);
});

// ── La demande qui part au moteur ───────────────────────────────────────────

test('le nom composé part dans la demande, et le vide n’y part pas', () => {
  const withName = buildExportRequest({
    project: advancedProject(),
    outputFolder: '/sorties',
    archiveName: '6+]Le_Renard[by_Ésope_V2',
  });
  assert.equal(withName.archiveName, '6+]Le_Renard[by_Ésope_V2');

  // Sans nom, la clé est absente : une chaîne vide se lirait « l'auteur a
  // demandé un nom vide », alors qu'elle veut dire « il n'a rien demandé ». Le
  // moteur retombe alors sur le titre du document.
  const without = buildExportRequest({ project: advancedProject(), outputFolder: '/sorties' });
  assert.equal('archiveName' in without, false);
  const blank = buildExportRequest({
    project: advancedProject(), outputFolder: '/sorties', archiveName: '   ',
  });
  assert.equal('archiveName' in blank, false);
});

// ── La chaîne Libre ne bouge pas ────────────────────────────────────────────

test('le nom de la chaîne libre est celui qu’il était', () => {
  const metadata = {
    title: 'Le Renard', author: 'Ésope', version: 2, minAge: '6',
    producer: '', bonus: '', namingMode: 'convention', legacyExportName: '',
  };
  assert.equal(getExportPackName(metadata), '6+]Le_Renard[by_Ésope_V2');
  assert.equal(
    getExportPackName({ ...metadata, namingMode: 'legacy', legacyExportName: 'ancien-nom' }),
    'ancien-nom',
  );
});

test('a graph title that repeats the age does not double it in the file name', () => {
  assert.equal(
    advancedArchiveBaseName({
      packMetadata: { namingMode: 'convention', minAge: '3' },
      title: '3+ Example-graphe',
      version: 3,
    }),
    '3+]Example-graphe_V3',
  );
});
