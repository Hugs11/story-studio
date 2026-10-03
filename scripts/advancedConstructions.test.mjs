import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAdvancedGesture } from '../src/store/projectModel/authoring.js';

test('la création de constructions est indisponible avant tout appel natif', async () => {
  let called = false;
  await assert.rejects(applyAdvancedGesture(null, { gesture: 'create-construction' }, {
    invokeCommand: async () => { called = true; },
  }), /constructions dérivées.*indisponible/i);
  assert.equal(called, false);
});
import { buildConstructionGesture, NARRATIVE_CONTROLS, CHOICE_CONTROLS } from '../src/store/advancedAuthoring/constructions.js';
const index = { byPath: new Map([
  ['entry-path', { kind: 'stage', node: { uuid: 'entry', uniqueId: true } }],
  ['target-path', { kind: 'stage', node: { uuid: 'target', uniqueId: true } }],
  ['duplicate-path', { kind: 'stage', node: { uuid: 'target', uniqueId: false } }],
]) };
function draft(change = {}) {
  return { kind: 'scene', name: ' Île ', items: [], controls: NARRATIVE_CONTROLS, optionControls: CHOICE_CONTROLS,
    question: false, sourcePath: null, destinationPath: null, trigger: 'autoplay', ...change };
}
test('une scène non raccordée reste une seule demande avec les cinq contrôles explicites', () => {
  const result = buildConstructionGesture(index, draft());
  assert.equal(result.gesture, 'create-construction');
  assert.equal(result.construction.source, null);
  assert.equal(result.construction.destination, null);
  assert.equal(result.construction.name, 'Île');
  assert.deepEqual(result.construction.controls, NARRATIVE_CONTROLS);
});
test('le choix préserve les propositions ordonnées vers une même cible', () => {
  const result = buildConstructionGesture(index, draft({ kind: 'choice', question: true,
    items: [{ name: 'Forêt', targetPath: 'target-path' }, { name: 'Plage', targetPath: 'target-path' }],
    sourcePath: 'entry-path', trigger: 'ok' })).construction;
  assert.deepEqual(result.items, [{ name: 'Forêt', target: 'target' }, { name: 'Plage', target: 'target' }]);
  assert.deepEqual(result.source, { stageUuid: 'entry', slot: 'ok', controls: { form: 'members', members: { ok: { form: 'set', value: true } } } });
});
test('fin audio et OK partagent le slot, HOME reste distinct, sans écraser les autres contrôles', () => {
  for (const trigger of ['autoplay', 'ok', 'home']) {
    const { source } = buildConstructionGesture(index, draft({ trigger, sourcePath: 'entry-path' })).construction;
    assert.equal(source.slot, trigger === 'home' ? 'home' : 'ok');
    assert.deepEqual(Object.keys(source.controls.members), [trigger]);
  }
});
test('le hasard exige une arrivée et admet des destinations existantes sans nom nouveau', () => {
  const random = draft({ kind: 'random', items: [{ name: '', targetPath: 'target-path' }, { name: 'Hibou', targetPath: null }] });
  assert.throws(() => buildConstructionGesture(index, random), /Écran/);
  const result = buildConstructionGesture(index, { ...random, sourcePath: 'entry-path' });
  assert.equal(result.construction.items[0].target, 'target');
  assert.equal(result.construction.items[1].target, null);
});
test('les cibles disparues ou ambiguës bloquent la demande au lieu de la rediriger', () => {
  for (const destinationPath of ['missing', 'duplicate-path']) {
    assert.throws(() => buildConstructionGesture(index, draft({ destinationPath })), /identifiant unique/);
  }
});
test('la séquence garde son ordre et ne recycle pas les destinations du formulaire Choix', () => {
  const result = buildConstructionGesture(index, draft({ kind: 'sequence', question: true,
    items: [{ name: 'A', targetPath: 'target-path' }, { name: 'B', targetPath: null }] })).construction;
  assert.deepEqual(result.items, [{ name: 'A', target: null }, { name: 'B', target: null }]);
  assert.equal(result.question, false);
});
