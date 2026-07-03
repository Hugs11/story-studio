import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampStepIndex,
  nextStepIndex,
  prevStepIndex,
  isLastStep,
  deriveStepStatus,
  stepCounterLabel,
  canContinue,
} from '../src/components/funnels/funnelNavigation.js';

test('clampStepIndex borne dans [0, count-1] et gère les valeurs invalides', () => {
  assert.equal(clampStepIndex(3, 5), 3);
  assert.equal(clampStepIndex(-2, 5), 0);
  assert.equal(clampStepIndex(99, 5), 4);
  assert.equal(clampStepIndex(2.7, 5), 2);
  assert.equal(clampStepIndex(NaN, 5), 0);
  assert.equal(clampStepIndex(0, 0), 0);
});

test('nextStepIndex et prevStepIndex restent bornés', () => {
  assert.equal(nextStepIndex(0, 5), 1);
  assert.equal(nextStepIndex(4, 5), 4);
  assert.equal(prevStepIndex(2, 5), 1);
  assert.equal(prevStepIndex(0, 5), 0);
});

test('isLastStep ne vaut que pour la dernière étape', () => {
  assert.equal(isLastStep(4, 5), true);
  assert.equal(isLastStep(3, 5), false);
  assert.equal(isLastStep(0, 0), false);
});

test('deriveStepStatus distingue done / current / todo', () => {
  assert.equal(deriveStepStatus(0, 2), 'done');
  assert.equal(deriveStepStatus(2, 2), 'current');
  assert.equal(deriveStepStatus(3, 2), 'todo');
});

test('deriveStepStatus signale les erreurs via Set ou tableau', () => {
  assert.equal(deriveStepStatus(1, 2, new Set([1])), 'error');
  assert.equal(deriveStepStatus(2, 2, [2]), 'error');
  // Une étape à venir reste « todo » même listée en erreur.
  assert.equal(deriveStepStatus(4, 2, [4]), 'todo');
});

test('stepCounterLabel est 1-indexé et vide si pas d’étapes', () => {
  assert.equal(stepCounterLabel(0, 5), 'Étape 1 / 5');
  assert.equal(stepCounterLabel(4, 5), 'Étape 5 / 5');
  assert.equal(stepCounterLabel(0, 0), '');
});

test('canContinue : bool, null = libre, string non vide = bloquant', () => {
  assert.equal(canContinue(true), true);
  assert.equal(canContinue(false), false);
  assert.equal(canContinue(null), true);
  assert.equal(canContinue(undefined), true);
  assert.equal(canContinue(''), true);
  assert.equal(canContinue('   '), true);
  assert.equal(canContinue('Choisis au moins un pack'), false);
});
