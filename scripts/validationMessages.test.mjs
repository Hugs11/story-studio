import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VALIDATION_MESSAGES,
  brokenField,
  emptyTarget,
  missingField,
  missingTarget,
} from '../src/store/validationMessages.js';

const EM_DASH = '—';

test('missingField formats a short action with an em-dash', () => {
  assert.equal(missingField('Menu racine', 'audio intro'), `Menu racine ${EM_DASH} Audio d'accueil à ajouter`);
});

test('missingField keeps the feminine option accepted for callers', () => {
  assert.equal(missingField('X', 'image', { feminine: true }), `X ${EM_DASH} Image à ajouter`);
});

test('brokenField formats a concise missing file message', () => {
  assert.equal(brokenField('X', 'audio'), `X ${EM_DASH} Fichier audio introuvable`);
});

test('missingTarget renders the target kind after "destination"', () => {
  assert.equal(missingTarget('X', 'dossier'), `X ${EM_DASH} destination dossier introuvable`);
});

test('emptyTarget renders the target kind after "destination"', () => {
  assert.equal(emptyTarget('X', 'de retour'), `X ${EM_DASH} destination de retour vide`);
});

test('VALIDATION_MESSAGES.duplicateId quotes the count and the offending id with an em-dash', () => {
  assert.equal(
    VALIDATION_MESSAGES.duplicateId(3, 'abc'),
    `Identifiant dupliqué ${EM_DASH} 3 éléments partagent l'id abc`,
  );
});

test('VALIDATION_MESSAGES.emptyMenu uses the em-dash separator', () => {
  assert.equal(
    VALIDATION_MESSAGES.emptyMenu('Menu / Sous-menu'),
    `Menu / Sous-menu ${EM_DASH} Histoire à ajouter`,
  );
});
