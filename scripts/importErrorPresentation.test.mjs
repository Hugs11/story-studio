import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FREE_EDITOR_REFUSAL_MESSAGE,
  isFreeEditorRefusal,
  presentImportError,
} from '../src/components/EditPack/importErrorPresentation.js';

test('une erreur LZMA devient un refus lisible sans exposer le cache', () => {
  const raw = 'C:\\Users\\hugs\\AppData\\Local\\Temp\\story-studio\\pack.7z: LzmaError(Unsupported)';
  const result = presentImportError(new Error(raw));
  assert.match(result.message, /méthode de compression/);
  assert.doesNotMatch(result.message, /Users|LzmaError|Temp/);
  assert.equal(result.technicalDetail, raw);
});

test('un nom invalide en UTF-8 explique la variante chiffrée ou non prise en charge', () => {
  const raw = 'Audio stage 0 : Nom asset invalide : invalid utf-8 sequence';
  const result = presentImportError(raw);
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
  const result = presentImportError(raw, 'unsupported');
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
    presentImportError('Asset(s) référencé(s) absent(s) du ZIP : assets/a.mp3', 'unsupported').message,
    /médias annoncés/,
  );
  assert.match(
    presentImportError("Contrôles incomplets, conservés mais non interprétés : 'A' (u1).", 'unsupported').message,
    /réglages de boutons/,
  );
});

test('un pack que l’éditeur par menus ne sait pas reprendre renvoie vers le graphe', () => {
  const raw = 'Pack non éditable dans Story Studio : Lecture seule : projection authoring impossible (cycle 12).';
  assert.equal(isFreeEditorRefusal(raw), true);
  assert.equal(isFreeEditorRefusal(new Error(raw)), true);
  const result = presentImportError(raw);
  assert.equal(result.message, FREE_EDITOR_REFUSAL_MESSAGE);
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
  const lzma = presentImportError("L'archive « quiz.zip » utilise une compression (LZMA) que Story Studio ne sait pas lire. Recompressez-la en ZIP standard avant de l'ouvrir. (Détail : a/li : LzmaError)");
  assert.equal(lzma.message, 'Cette archive utilise une méthode de compression que Story Studio ne sait pas lire.');
  const damaged = presentImportError("L'archive « pack.zip » est endommagée : le fichier a/li ne peut pas être extrait. (Détail : invalid)");
  assert.equal(damaged.message, 'Cette archive est invalide ou endommagée.');
});
