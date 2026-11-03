import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
i18next.init(createTestI18n().options);
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isFreeEditorRefusal,
  presentImportError,
} from '../src/components/EditPack/importErrorPresentation.js';

test('une erreur LZMA devient un refus lisible sans exposer le cache', () => {
  const raw = 'C:\\Users\\example\\AppData\\Local\\Temp\\story-studio\\pack.7z: LzmaError(Unsupported)';
  const result = presentImportError({ code: 'IMPORT_UNSUPPORTED_COMPRESSION', params: {}, detail: raw });
  assert.match(result.message, /méthode de compression/);
  assert.doesNotMatch(result.message, /Users|LzmaError|Temp/);
  assert.equal(result.technicalDetail, raw);
});

test('un nom invalide en UTF-8 explique la variante chiffrée ou non prise en charge', () => {
  const raw = 'Audio stage 0 : Nom asset invalide : invalid utf-8 sequence';
  const result = presentImportError({ code: 'IMPORT_UNSUPPORTED_VARIANT', params: {}, detail: raw });
  assert.match(result.message, /chiffré|variante/);
  assert.doesNotMatch(result.message, /utf-8|stage 0/i);
  assert.equal(result.technicalDetail, raw);
});

test('une erreur inconnue conserve un message public stable et un détail repliable', () => {
  const result = presentImportError('backend::Reader failed at C:\\private\\pack.zip');
  assert.equal(result.message, 'Ce pack n’a pas pu être ouvert.');
  assert.match(result.technicalDetail, /backend::Reader/);
});

test('le motif brut d’un pack chiffré, remonté par la classification, devient lisible', () => {
  const raw = 'story.json non simulable par Story Studio (Audio stage 0 : Nom asset invalide : 3f2a).';
  const result = presentImportError({ code: 'IMPORT_UNSUPPORTED_VARIANT', params: {}, detail: raw }, 'unsupported');
  assert.match(result.message, /chiffré|variante/);
  assert.doesNotMatch(result.message, /story\.json|stage/i);
  assert.equal(result.technicalDetail, raw);
});

test('un verdict sans cause reconnue reste un constat de structure, pas un échec d’ouverture', () => {
  const raw = 'Lecture seule : simulation native possible, projection authoring impossible (cycle 12).';
  assert.equal(presentImportError(raw, 'readOnly').message, 'Sa structure ne peut pas être reconstruite dans un éditeur.');
  assert.equal(presentImportError(raw, 'unsupported').message, 'Sa structure n’est pas lisible par Story Studio.');
});

test('les médias absents et les contrôles incomplets ont un message propre', () => {
  assert.match(
    presentImportError({ code: 'IMPORT_MISSING_MEDIA', params: {}, detail: 'Asset(s) référencé(s) absent(s) du ZIP : assets/a.mp3' }, 'unsupported').message,
    /médias annoncés/,
  );
  assert.match(
    presentImportError({ code: "IMPORT_INCOMPLETE_CONTROLS", params: {}, detail: "Contrôles incomplets, conservés mais non interprétés : 'A' (u1)." }, 'unsupported').message,
    /réglages de boutons/,
  );
});

test('un pack que l’éditeur par menus ne sait pas reprendre renvoie vers le graphe', () => {
  const raw = 'Pack non éditable dans Story Studio : Lecture seule : projection authoring impossible (cycle 12).';
  const error = { code: 'PACK_NOT_EDITABLE', params: {}, detail: raw };
  assert.equal(isFreeEditorRefusal(error), true);
  assert.equal(isFreeEditorRefusal(JSON.stringify(error)), true);
  const result = presentImportError(error);
  // Source indépendante : git show 033ca57:src/components/EditPack/importErrorPresentation.js
  assert.equal(result.message, 'Ce pack n’est pas compatible avec l’éditeur par menus. Pour le modifier, ouvre-le dans l’éditeur graphe : Projet → Ouvrir un pack.');
  assert.match(result.message, /éditeur graphe : Projet → Ouvrir un pack/);
  assert.doesNotMatch(result.message, /extraire|extraction/i);
  assert.equal(result.technicalDetail, raw);
});

test('seul le refus de l’éditeur par menus renvoie vers le graphe', () => {
  assert.equal(isFreeEditorRefusal('Archive invalide'), false);
  assert.equal(isFreeEditorRefusal('Cette structure peut être valide pour la Lunii mais non éditable dans Story Studio.'), false);
  assert.equal(isFreeEditorRefusal(null), false);
});

test('les refus d’extraction du moteur restent traduits en phrases lisibles', () => {
  // Messages de `unreadable_zip_entry_message` (support/imported_pack.rs).
  const lzma = presentImportError({ code: "IMPORT_UNSUPPORTED_COMPRESSION", params: {}, detail: "L'archive « quiz.zip » utilise une compression (LZMA) que Story Studio ne sait pas lire. Recompressez-la en ZIP standard avant de l'ouvrir. (Détail : a/li : LzmaError)" });
  assert.equal(lzma.message, 'Cette archive utilise une méthode de compression que Story Studio ne sait pas lire.');
  const damaged = presentImportError({ code: "IMPORT_INVALID_ARCHIVE", params: {}, detail: "L'archive « pack.zip » est endommagée : le fichier a/li ne peut pas être extrait. (Détail : invalid)" });
  assert.equal(damaged.message, 'Cette archive est invalide ou endommagée.');
});
