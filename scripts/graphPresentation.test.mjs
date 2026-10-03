import assert from 'node:assert/strict';
import test from 'node:test';

import {
  connectionNeighborhood,
  extendPlaybackTrace,
} from '../src/store/advancedGraphView/graphPresentation.js';

function fixture() {
  const entries = [
    { path: '/s1', kind: 'stage', label: { label: 'Départ' } },
    { path: '/a1', kind: 'action', label: { label: 'Choix' } },
    { path: '/s2', kind: 'stage', label: { label: 'Forêt' } },
    { path: '/s3', kind: 'stage', label: { label: 'Maison' } },
  ];
  const edges = [
    { edgeId: 'ok', kind: 'stage-ok', from: '/s1', to: '/a1' },
    { edgeId: 'home', kind: 'stage-home', from: '/s3', to: '/a1' },
    { edgeId: 'o0', kind: 'action-option', from: '/a1', to: '/s2', ordinal: 0 },
    { edgeId: 'o1', kind: 'action-option', from: '/a1', to: '/s2', ordinal: 1 },
    { edgeId: 'o2', kind: 'action-option', from: '/a1', to: '/s3', ordinal: 2 },
  ];
  const index = {
    entries,
    byPath: new Map(entries.map((entry) => [entry.path, entry])),
    incoming: new Map(entries.map((entry) => [entry.path, edges.filter((e) => e.to === entry.path)])),
    outgoing: new Map(entries.map((entry) => [entry.path, edges.filter((e) => e.from === entry.path)])),
  };
  return index;
}

test('un niveau depuis un Écran franchit l’Action sans fusionner les options répétées', () => {
  const seen = connectionNeighborhood(fixture(), '/s1', 1);
  assert.deepEqual(new Set(seen.nodePaths), new Set(['/s1', '/a1', '/s2', '/s3']));
  assert.deepEqual(new Set(seen.edgeIds), new Set(['ok', 'o0', 'o1', 'o2']));
});

test('un niveau ne confond pas une autre origine de l’Action avec une connexion du centre', () => {
  const seen = connectionNeighborhood(fixture(), '/s1', 1);
  assert.equal(seen.edgeIds.includes('home'), false);
  const extended = connectionNeighborhood(fixture(), '/s1', 2);
  assert.equal(extended.edgeIds.includes('home'), true);
});

test('les retours peuvent être masqués sans cacher les sorties ordinaires', () => {
  const seen = connectionNeighborhood(fixture(), '/s1', 1, { showReturns: false });
  assert.equal(seen.edgeIds.includes('home'), false);
  assert.equal(seen.edgeIds.includes('ok'), true);
});

test('la trace jouée conserve les nœuds et les deux segments exacts du passage', () => {
  const index = fixture();
  const trace = extendPlaybackTrace(index, null, '/s1', '/s2', {
    actionNodeId: '/a1', optionIdx: 1, slot: 'ok',
  });
  assert.deepEqual(new Set(trace.nodePaths), new Set(['/s1', '/a1', '/s2']));
  assert.deepEqual(new Set(trace.edgeIds), new Set(['ok', 'o1']));
});

test('un lien survolé nomme ses deux bouts et sa touche', async () => {
  const { describeEdgeEnds } = await import('../src/store/advancedGraphView/graphPresentation.js');
  const index = fixture();
  assert.deepEqual(describeEdgeEnds(index, 'ok'), { from: 'Départ', to: 'Choix', via: 'Suite du parcours', term: 'okTransition' });
  assert.deepEqual(describeEdgeEnds(index, 'home'), { from: 'Maison', to: 'Choix', via: 'Bouton Accueil', term: 'homeTransition' });
  assert.deepEqual(describeEdgeEnds(index, 'o1'), { from: 'Choix', to: 'Forêt', via: 'choix 2', term: null });
  assert.equal(describeEdgeEnds(index, 'absent'), null);
  // Un trait de suite dit quels déclencheurs l'activent, quand l'Écran les connaît.
  const on = { presence: 'value', value: true };
  const off = { presence: 'value', value: false };
  index.byPath.get('/s1').node = { controls: { presence: 'value', ok: on, autoplay: on, home: off } };
  assert.equal(describeEdgeEnds(index, 'ok').via, 'Suite du parcours, par OK ou fin du son');
  index.byPath.get('/s1').node = { controls: { presence: 'value', ok: off, autoplay: on, home: off } };
  assert.equal(describeEdgeEnds(index, 'ok').via, 'Suite du parcours, par fin du son');
});
