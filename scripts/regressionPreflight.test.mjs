import assert from 'node:assert/strict';
import test from 'node:test';
import { EXTERNAL_SUITES, suiteReadiness } from './regression-preflight.mjs';

test('chaque suite externe publie une commande de reprise exacte', () => {
  assert.ok(EXTERNAL_SUITES.length >= 10);
  for (const suite of EXTERNAL_SUITES) {
    assert.ok(suite.id);
    assert.match(suite.command, /^cargo test /);
    assert.match(suite.command, /--ignored/);
  }
});

test('une suite demandée reste rouge tant que sa fixture manque', () => {
  const suite = EXTERNAL_SUITES.find(({ id }) => id === 'import-archive');
  assert.deepEqual(suiteReadiness(suite, {}), {
    ready: false,
    missing: ['STORY_STUDIO_PACK_ARCHIVE'],
  });
});

test('les alternatives de fidélité acceptent fichier ou dossier sans exposer leur valeur', () => {
  const suite = EXTERNAL_SUITES.find(({ id }) => id === 'fidelity');
  const secretPath = 'C:/private/do-not-print.zip';
  const readiness = suiteReadiness(suite, { LUNII_FIDELITY_PACK: secretPath });
  assert.deepEqual(readiness, { ready: true, missing: [] });
  assert.equal(JSON.stringify(readiness).includes(secretPath), false);
});

test('la baseline externe expose séparément import et juge de fidélité', () => {
  const baselineSuites = EXTERNAL_SUITES.filter(({ allOf }) => (
    allOf?.includes('STORY_STUDIO_BASELINE_DIR')
  ));
  assert.deepEqual(
    baselineSuites.map(({ id }) => id),
    ['baseline-import', 'baseline-judge'],
  );
  assert.ok(baselineSuites.every(({ command }) => command.includes('--ignored')));
});
