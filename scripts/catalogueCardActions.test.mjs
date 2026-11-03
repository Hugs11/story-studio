import test from 'node:test';
import assert from 'node:assert/strict';
import { card } from './catalogueFixtures.mjs';
import { exemplarChoices, exemplarActions, cardMenuActions, editButton, menuEntries, revealLine, ficheOpenRequest } from '../src/store/catalogue/cardActions.js';
import { clipboardText, pathText } from '../src/store/catalogue/clipboardText.js';

test('fiche opening keeps the exact requested version, revision and focus; missing IDs never choose another version', () => {
  const c = card({ id: 'versions', exemplars: [{ id: 'old', format: 'zip' }, { id: 'new', format: 'project' }] });
  for (const exemplar of c.exemplars) {
    const request = ficheOpenRequest(c, { exemplarId: exemplar.id }, 23, `button-${exemplar.id}`);
    assert.equal(request.exemplar, exemplar);
    assert.equal(request.card, c);
    assert.equal(request.revision, 23);
    assert.equal(request.returnFocusId, `button-${exemplar.id}`);
  }
  assert.equal(ficheOpenRequest(c, { choice: true }, 24).exemplar, null, 'card-wide action still uses the shared version chooser');
  assert.throws(() => ficheOpenRequest(c, { exemplarId: 'removed' }, 23), { code: 'CATALOG_TARGET_REVISION_STALE' });
});
for (const format of ['project', 'zip', 'sevenZip', 'folder']) for (const available of [true, false]) {
  test(`${format}, available=${available}: visible opening reasons and explicit file target`, () => {
    const c = card({ title: 'Lune', exemplars: [{ format, available, path: '/Packs/Lune.mbah' }] });
    const actions = exemplarActions(c, c.exemplars[0]);
    for (const action of actions) if (['openProject', 'editPack'].includes(action.id)) {
      assert.equal(action.enabled, available);
      assert.equal(action.reasonKey, available ? null : 'catalogue:reason.action.fileUnavailable');
    }
    // « Simuler » est câblé : actif sur un exemplaire disponible, sinon
    // désactivé avec la raison définitive du fichier indisponible.
    const simulate = actions.find(a => a.id === 'simulate');
    assert.equal(simulate.enabled, available);
    assert.equal(simulate.reasonKey, available ? null : 'catalogue:reason.action.fileUnavailable');
    assert.equal(actions.find(a => a.id === 'reveal').enabled, true, 'parent fallback remains reachable');
    assert.equal(actions.find(a => a.id === 'copyUuid').reasonKey, 'catalogue:actions.reason.noUuid');
    assert.equal(editButton(c, c.exemplars).enabled, available);
    assert.equal(cardMenuActions(c, c.exemplars).find(a => a.id === 'reveal').exemplarId, c.exemplars[0].id);
  });
}
test('multiple copies require a choice, every choice retains its own target', () => {
  const c = card({ exemplars: [{ id: 'a' }, { id: 'b', available: false }] });
  assert.equal(editButton(c, c.exemplars).choice, true);
  assert.equal(cardMenuActions(c, c.exemplars).find(a => a.id === 'reveal').choice, true);
  const entries = menuEntries({ open: true, kind: 'card', step: { action: 'reveal' } }, c, c.exemplars);
  assert.equal(entries[0].back, true);
  assert.deepEqual(entries.slice(1).map(e => e.exemplar.id), c.exemplars.map(e => e.id));
  assert.equal(menuEntries({ open: false }, c, c.exemplars).length, 0);
  const choices = exemplarChoices(c, c.exemplars);
  assert.deepEqual(choices.map(e => e.exemplar.id), c.exemplars.map(e => e.id));
  assert.deepEqual(choices.map(e => e.action.enabled), [true,false]);
  assert.equal(choices[1].action.reasonKey,'catalogue:reason.action.fileUnavailable');
});
test('archive copy/reveal targets actual container; UUID/title availability', () => {
  const c = card({ title: 'Lune', exemplars: [{ path: '/Packs/multi.zip', member: 'ours', uuid: 'uuid' }] });
  assert.equal(pathText(c.exemplars[0]).text, '/Packs/multi.zip');
  assert.equal(clipboardText('copyUuid', c).text, 'uuid');
  assert.equal(clipboardText('copyTitle', c).text, 'Lune');
  assert.equal(clipboardText('copyUuid', { uuids: ['a', 'b'] }).reasonKey, 'catalogue:actions.reason.severalUuids');
  assert.equal(clipboardText('copyTitle', {}).enabled, false);
  assert.equal(pathText({}).enabled, false);
  assert.equal(exemplarActions(c, c.exemplars[0]).find(a => a.id === 'reveal').hint.params.archive, 'multi.zip');
  assert.equal(revealLine({ fallbackParentOpened: true }, '/gone').key, 'catalogue:actions.reveal.fallback');
});

test('copy title uses the displayed filename title, including a deliberately cleared title', () => {
  for (const corrections of [{}, { title: 'cleared' }]) {
    const c = { ...card({ exemplars: [{}] }), title: null, displayTitle: 'Mon histoire', corrections };
    assert.deepEqual(clipboardText('copyTitle', c), { text: 'Mon histoire', enabled: true, reasonKey: null });
    const action = cardMenuActions(c, c.exemplars).find(a => a.id === 'copyTitle');
    assert.equal(action, undefined, 'FICHEB removes copy title from the fixed card menu');
  }
});
