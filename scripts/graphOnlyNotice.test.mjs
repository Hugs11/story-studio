// La notice « graphe seulement » : quand un pack ne s'ouvre que dans l'éditeur
// graphe, l'auteur qui ne l'a pas choisi en est informé ; celui qui ouvre depuis
// le graphe sait déjà où il est.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  graphOnlyNoticeFor,
} from '../src/components/EditPack/graphOnlyNotice.js';

const graphOnly = { status: 'landed', advanced: true, report: { authoringEditable: false } };

// Source indépendante : git show 033ca57:src/components/EditPack/graphOnlyNotice.js
const expectedNotice = 'Ce pack s’ouvre uniquement dans l’éditeur graphe : l’éditeur par menus ne sait pas représenter sa structure.';

test('le texte de la notice est celui décidé', () => {
  assert.equal(graphOnlyNoticeFor(graphOnly), expectedNotice);
});

test('pack graphe seulement ouvert depuis l’accueil ou les menus : notice', () => {
  assert.equal(graphOnlyNoticeFor(graphOnly, { openedFromGraph: false }), expectedNotice);
});

test('pack graphe seulement ouvert depuis le graphe : aucune notice', () => {
  assert.equal(graphOnlyNoticeFor(graphOnly, { openedFromGraph: true }), null);
});

test('pack compatible avec les deux éditeurs : aucune notice', () => {
  const both = { status: 'landed', advanced: true, report: { authoringEditable: true } };
  assert.equal(graphOnlyNoticeFor(both, { openedFromGraph: false }), null);
});

test('atterrissage par menus ou échec : aucune notice', () => {
  assert.equal(graphOnlyNoticeFor({ status: 'landed', advanced: false, report: { authoringEditable: false } }, {}), null);
  assert.equal(graphOnlyNoticeFor({ status: 'error', advanced: true, report: {} }, {}), null);
  assert.equal(graphOnlyNoticeFor(null, {}), null);
});
