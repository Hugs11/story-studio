import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberFileTitles, rememberRemovalTitle, namedFileSnapshot, operationView, operationReducer, INITIAL_OPERATIONS } from '../src/store/catalogue/operationView.js';
import { createTestI18n } from './i18nTestSetup.mjs';

const snapshot = (overrides = {}) => ({ operationId: 'trash', sequence: 3, operationKind: 'trash', status: 'success', outcomes: { updated: 1 }, ...overrides });
const page = items => ({ items, cursor: null });

test('le titre effectif de la fiche est conservé avant son retrait ; repli titre puis nom puis chemin sensible à la casse', () => {
  const titles = new Map();
  rememberFileTitles(titles, [
    { displayTitle: 'Titre corrigé', title: 'Ancien', exemplars: [{ path: '/Packs/A.zip', name: 'Fichier' }] },
    { title: 'Titre source', exemplars: [{ path: '/Packs/a.zip', name: 'Fichier' }] },
    { title: ' ', exemplars: [{ path: 'C:\\Packs\\B.zip', name: 'Exemplaire' }] },
    { exemplars: [{ path: 'C:\\Packs\\C.zip' }] },
  ]);
  rememberFileTitles(titles, []);
  assert.deepEqual([...titles.values()], ['Titre corrigé', 'Titre source', 'Exemplaire', 'C.zip']);
});

test('un seul pack : réutilisation de trash.trashed en FR/EN/IT ; suppression définitive nommée aussi', async () => {
  const engine = createTestI18n();
  for (const operationKind of ['trash', 'deletePermanently']) {
    const named = await namedFileSnapshot(snapshot({ operationKind }), { getOperation: async () => page([{ path: '/a.zip', outcome: 'updated' }]) }, new Map([['/a.zip', 'Lune']]));
    const line = operationView(named).lines[0];
    assert.equal(line.key, operationKind === 'trash' ? 'catalogue:trash.trashed' : 'catalogue:trash.deleted');
    assert.deepEqual(line.params, { name: 'Lune' });
    for (const lng of ['fr', 'en', 'it']) assert.match(engine.t(line.key, { ...line.params, lng }), /Lune/);
  }
});

test('plusieurs fiches dans la même archive : la notification nomme celle choisie ; repli sur fileName', async () => {
  rememberRemovalTitle('selected', { displayTitle: 'Pack choisi' }, { path: '/archive.zip' });
  rememberRemovalTitle('untitled', {}, { path: '/archive.zip', fileName: 'Nom exemplaire' });
  const api = { getOperation: async () => page([{ path: '/archive.zip', outcome: 'updated' }]) };
  for (const [requestId, expected] of [['selected', 'Pack choisi'], ['untitled', 'Nom exemplaire']]) {
    const named = await namedFileSnapshot(snapshot({ requestId }), api, new Map([['/archive.zip', 'Autre fiche de la même archive']]));
    assert.deepEqual(named.fileNames, [expected]);
  }
});

test('opération partielle paginée : seuls trois titres réussis, nombre restant exact, erreurs conservées', async () => {
  const cursors = [];
  const api = { getOperation: async (_id, options) => {
    cursors.push(options.cursor);
    return options.cursor === null ? { items: [{ path: '/échec.zip', outcome: 'error' }, { path: '/A.zip', outcome: 'updated' }], cursor: 'suite' }
      : page(['B', 'C', 'D'].map(name => ({ path: `C:\\Packs\\${name}.zip`, outcome: 'updated' })));
  } };
  const named = await namedFileSnapshot(snapshot({ status: 'partial', outcomes: { updated: 8, error: 2 } }), api, new Map([['/A.zip', 'Titre A']]));
  const view = operationView(named);
  const result = view.lines.find(line => line.key === 'catalogue:operation.trashed');
  assert.deepEqual(cursors, [null, 'suite']);
  assert.deepEqual(result.names, ['Titre A', 'B.zip', 'C.zip']); assert.equal(result.remaining, 5);
  assert.equal(result.params.count, 8); assert.equal(view.hasIssues, true);
  assert.equal(view.lines.find(line => line.key === 'catalogue:operation.errors').params.count, 2);
});

test('les pluriels de packs et du reste couvrent 1, 2 et un million dans les trois langues', () => {
  const engine = createTestI18n();
  for (const lng of ['fr', 'en', 'it']) for (const count of [1, 2, 1_000_000]) {
    for (const key of ['catalogue:operation.trashed', 'catalogue:operation.deleted', 'catalogue:operation.moreNames']) {
      const text = engine.t(key, { count, lng });
      assert.ok(!text.includes('catalogue:') && text.includes(String(count)));
    }
  }
});

test('enrichir une même séquence conserve ses compteurs ; une séquence ancienne ne peut rien enrichir', () => {
  const raw = snapshot();
  const state = operationReducer(INITIAL_OPERATIONS, { type: 'snapshot', snapshot: raw });
  const next = operationReducer(state, { type: 'snapshot', snapshot: { ...raw, outcomes: { updated: 999 }, fileNames: ['Lune'] } });
  assert.deepEqual(next.items.trash.outcomes, { updated: 1 });
  assert.deepEqual(next.items.trash.fileNames, ['Lune']);
  assert.equal(operationReducer(state, { type: 'snapshot', snapshot: { ...raw, sequence: 2, fileNames: ['Ancien'] } }), state);
});
