import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUNDLE_CHILD_STATUS,
  canContinueWithChild,
  describeChildVerdict,
  formatChildSize,
  inspectionProgressRatio,
  isChildSelectable,
  selectableChildren,
} from '../src/components/EditPack/bundleChildren.js';

function child(overrides = {}) {
  return {
    childId: 'a'.repeat(64),
    displayName: 'Un pack',
    sizeBytes: 1024,
    status: BUNDLE_CHILD_STATUS.editable,
    reason: '',
    selectable: true,
    ...overrides,
  };
}

test('Continuer reste inactif tant qu\'aucun pack n\'est choisi', () => {
  const children = [child()];
  assert.equal(canContinueWithChild(children, null), false);
  assert.equal(canContinueWithChild(children, ''), false);
  assert.equal(canContinueWithChild(children, children[0].childId), true);
});

test('un pack illisible est montré mais ne peut pas être choisi', () => {
  const broken = child({
    childId: 'b'.repeat(64),
    status: BUNDLE_CHILD_STATUS.error,
    reason: 'ZIP invalide',
    selectable: false,
  });
  assert.equal(isChildSelectable(broken), false);
  assert.equal(canContinueWithChild([broken], broken.childId), false);
  assert.deepEqual(selectableChildren([child(), broken]).length, 1);
});

test('un pack en lecture seule reste choisissable : le funnel lui offre la simulation', () => {
  const readOnly = child({
    status: BUNDLE_CHILD_STATUS.readOnly,
    reason: 'Projection Libre non fidèle.',
  });
  assert.equal(isChildSelectable(readOnly), true);
  assert.equal(canContinueWithChild([readOnly], readOnly.childId), true);
  const verdict = describeChildVerdict(readOnly);
  assert.equal(verdict.label, 'Lecture seule');
  assert.equal(verdict.reason, 'Sa structure ne peut pas être reconstruite dans un éditeur.');
  assert.equal(verdict.technicalDetail, 'Projection Libre non fidèle.');
});

test('le motif brut d’un enfant chiffré n’est pas le message affiché', () => {
  const raw = 'story.json non simulable par Story Studio (Audio stage 0 : Nom asset invalide).';
  const verdict = describeChildVerdict(child({ status: BUNDLE_CHILD_STATUS.unsupported, reason: raw }));
  assert.match(verdict.reason, /chiffré|variante/);
  assert.equal(verdict.technicalDetail, raw);
});

test('un verdict éditable n\'affiche pas de raison : il n\'y a rien à expliquer', () => {
  const verdict = describeChildVerdict(child({ reason: 'projection fidèle' }));
  assert.equal(verdict.label, 'Modifiable');
  assert.equal(verdict.reason, '');
});

test('une sélection qui n\'est plus dans la liste n\'ouvre rien', () => {
  const children = [child({ childId: 'c'.repeat(64) })];
  assert.equal(canContinueWithChild(children, 'd'.repeat(64)), false);
  assert.equal(canContinueWithChild([], 'c'.repeat(64)), false);
});

test('les tailles se lisent sans unité trompeuse', () => {
  assert.equal(formatChildSize(0), '0 o');
  assert.equal(formatChildSize(512), '512 o');
  assert.equal(formatChildSize(1024), '1.0 Ko');
  assert.equal(formatChildSize(41 * 1024 * 1024), '41 Mo');
  assert.equal(formatChildSize(1.5 * 1024 * 1024 * 1024), '1.5 Go');
  assert.equal(formatChildSize(undefined), '');
  assert.equal(formatChildSize(-1), '');
});

test('l\'avancement de l\'examen reste borné, y compris sur un évènement aberrant', () => {
  assert.equal(inspectionProgressRatio(0, 13), 0);
  assert.equal(inspectionProgressRatio(13, 13), 1);
  assert.equal(inspectionProgressRatio(99, 13), 1);
  assert.equal(inspectionProgressRatio(-4, 13), 0);
  assert.equal(inspectionProgressRatio(1, 0), null);
  assert.equal(inspectionProgressRatio(1, undefined), null);
});
