// Les provenances d'une Action et le glisser de ses destinations.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGraphIndex } from '../src/store/advancedGraphView/graphViewModel.js';
import {
  describeActionProvenance,
  movePermutation,
} from '../src/store/advancedAuthoring/actionProvenance.js';
import { action, presence, stage } from './advancedViewFixtures.mjs';

const stagePath = (uuid) => `/stageNodes/@uuid=${uuid}#0`;
const actionPath = (id) => `/actionNodes/@id=${id}#0`;

function transition(kind, from, to, selection) {
  return {
    edgeId: `${stagePath(from)}::${kind}`,
    kind: `stage-${kind}`,
    from: stagePath(from),
    to: actionPath(to),
    optionId: null,
    ordinal: 0,
    selection,
    dangling: false,
  };
}

function indexOf(edges) {
  const stages = ['depart', 'a', 'b', 'h1', 'h2', 'h3', 'h4'];
  return buildGraphIndex({
    viewVersion: 1,
    entry: { status: 'unique', stagePath: stagePath('depart'), candidates: [stagePath('depart')] },
    counts: { stages: stages.length, actions: 1, options: 2, edges: edges.length },
    stages: stages.map((uuid) => stage(uuid, { name: presence(`Écran ${uuid}`) })),
    actions: [action('menu', ['a', 'b'])],
    edges,
    mediaRefs: [],
    groups: [],
    opaqueMembers: [],
    diagnostics: [],
  });
}

test('les arrivées par OK disent la destination sur laquelle elles tombent', () => {
  const index = indexOf([transition('ok', 'depart', 'menu', { kind: 'fixed', index: 1 })]);
  const { ok, home } = describeActionProvenance(index, actionPath('menu'));
  assert.equal(ok.length, 1);
  assert.equal(ok[0].sourcePath, stagePath('depart'));
  assert.deepEqual(
    { rank: ok[0].landing.rank, label: ok[0].landing.label },
    { rank: 1, label: 'Écran b' },
  );
  assert.deepEqual(home, { total: 0, groups: [] });
});

test('les retours HOME sont regroupés par destination d’arrivée, dans l’ordre des rangs', () => {
  const index = indexOf([
    transition('home', 'h1', 'menu', { kind: 'fixed', index: 1 }),
    transition('home', 'h2', 'menu', { kind: 'fixed', index: 0 }),
    transition('home', 'h3', 'menu', { kind: 'fixed', index: 1 }),
    transition('home', 'h4', 'menu', { kind: 'random' }),
  ]);
  const { ok, home } = describeActionProvenance(index, actionPath('menu'));
  assert.equal(ok.length, 0);
  assert.equal(home.total, 4);
  assert.deepEqual(
    home.groups.map((group) => [group.landing.rank ?? 'hasard', group.rows.length]),
    [[0, 1], [1, 2], ['hasard', 1]],
  );
  assert.equal(home.groups[1].landing.label, 'Écran b');
});

test('un nœud qui n’est pas une Action n’a pas de provenances d’Action', () => {
  const index = indexOf([]);
  assert.deepEqual(describeActionProvenance(index, stagePath('a')), { ok: [], home: { total: 0, groups: [] } });
});

test('glisser une destination décale celles qu’elle traverse, sans toucher les autres', () => {
  // A B C D : C glisse en tête → C A B D.
  assert.deepEqual(movePermutation(4, 2, 0), [1, 2, 0, 3]);
  // A B C D : A glisse en fin → B C D A.
  assert.deepEqual(movePermutation(4, 0, 3), [3, 0, 1, 2]);
  assert.deepEqual(movePermutation(3, 1, 1), [0, 1, 2]);
});
