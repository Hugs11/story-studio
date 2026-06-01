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

test('missingField default (masculine) uses an em-dash and "manquant"', () => {
  assert.equal(missingField('Menu racine', 'audio intro'), `Menu racine ${EM_DASH} audio intro manquant`);
});

test('missingField with { feminine: true } uses "manquante"', () => {
  assert.equal(missingField('X', 'image', { feminine: true }), `X ${EM_DASH} image manquante`);
});

test('brokenField formats with em-dash and "introuvable ou inaccessible"', () => {
  assert.equal(brokenField('X', 'audio'), `X ${EM_DASH} audio introuvable ou inaccessible`);
});

test('missingTarget renders the target kind after "destination"', () => {
  assert.equal(missingTarget('X', 'dossier'), `X ${EM_DASH} destination dossier introuvable`);
});

test('emptyTarget renders the target kind after "destination"', () => {
  assert.equal(emptyTarget('X', 'de retour'), `X ${EM_DASH} destination de retour vide ou non jouable`);
});

test('VALIDATION_MESSAGES.duplicateId quotes the count and the offending id with an em-dash', () => {
  assert.equal(
    VALIDATION_MESSAGES.duplicateId(3, 'abc'),
    `Identifiant duplique ${EM_DASH} 3 elements partagent l'id abc`,
  );
});

test('VALIDATION_MESSAGES.emptyMenu uses the em-dash separator', () => {
  assert.equal(
    VALIDATION_MESSAGES.emptyMenu('Menu / Sous-menu'),
    `Menu / Sous-menu ${EM_DASH} collection vide`,
  );
});
