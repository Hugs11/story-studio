import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import react from '@vitejs/plugin-react';
import { createServer } from './viteTestServer.mjs';
import { selectionActions, selectionPanelActions } from '../src/store/catalogue/selectionActions.js';
import { selectionMenuEntries, selectionMenuKind } from '../src/store/catalogue/selectionActions.js';

const cards = Array.from({ length: 40 }, (_, index) => ({ id: String(index), favorite: index === 0 }));
const compose = (targets, options = {}, phase = 'idle') => {
  const ids = targets.map(card => card.id);
  return selectionPanelActions(targets, selectionActions(ids, targets, ids, options).actions, phase, options.busy);
};

test('selection panel preserves collective and secondary commands, bounded previews, mixed favorites and explained refusals in FR/EN/IT', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    const engine = initializeI18n('fr');
    const { FicheSelectionSummary, SelectionPanelActions, SelectionFloatingBar } = await server.ssrLoadModule('/src/components/Catalogue/fiche/SelectionPanel.jsx');
    const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
    assert.equal(render(FicheSelectionSummary, { cards: [], actions: compose([]) }), '');
    assert.equal(render(SelectionPanelActions, { actions: compose([]) }), '', 'no commands without targets');
    for (const language of ['fr', 'en', 'it']) {
      await engine.changeLanguage(language);
      const missing = cards.slice(0, 17).map(card => ({ ...card, available: false, offlineReason: 'missing' }));
      const mixed = [cards[0], missing[1]];
      for (const targets of [missing, mixed]) {
        const actions = compose(targets);
        const allMissing = targets === missing;
        assert.equal(actions.some(action => action.id === 'removeFromCatalogue' && action.enabled), allMissing);
        assert.ok(!actions.some(action => action.id === 'assemble'));
        assert.deepEqual(selectionMenuEntries(actions).map(entry => entry.action), actions);
        assert.ok(!selectionMenuEntries(actions).some(entry => entry.action.id === 'assemble'));
        for (const Component of [FicheSelectionSummary, SelectionFloatingBar]) {
          const html = render(Component, { cards: targets, actions, panelVisible: false });
          assert.equal(html.includes(engine.t('catalogue:actions.removeFromCatalogue.label')), allMissing);
          assert.doesNotMatch(html, /catalogue-selection-assemble/);
          assert.ok(!html.includes(engine.t('catalogue:selection.inline.assemble', { count: targets.length })));
        }
      }
      const html = render(FicheSelectionSummary, { cards, actions: compose(cards), onAction() {} });
      assert.equal((html.match(/catalogue-cover catalogue-cover--large/g) ?? []).length, 3, 'only three preview loaders');
      assert.match(html, /\+37/);
      // La copie de la sélection vers un dossier n'existe plus.
      assert.ok(!compose(cards).some(action => action.id === 'copySelection'));
      assert.doesNotMatch(html, /Copier vers un dossier|Copy to a folder|Copia in una cartella/i);
      assert.match(html, /class="catalogue-star"[^>]*aria-pressed="false"/);
      assert.match(html, /40/);
      const collective = render(FicheSelectionSummary, { cards, actions: [...compose(cards), { id: 'luniiSend', enabled: true }] });
      const production = collective.slice(collective.indexOf('catalogue-selection-production'), collective.indexOf('catalogue-selection-tag-list'));
      assert.match(production, /catalogue-selection-assemble/);
      assert.match(production, /catalogue-send catalogue-send--fiche/);
      assert.equal((collective.match(/catalogue-send--fiche/g) ?? []).length, 1);
      assert.equal((html.match(/<span><kbd/g) ?? []).length, 3, 'each shortcut is a separate gesture');
      assert.doesNotMatch(html, /catalogue:|\[object Object\]|<details|aria-disabled/);
      assert.match(html, /aria-haspopup="menu"/);
      assert.match(html, { fr: /Assembler ces 40 packs/, en: /Assemble these 40 packs/, it: /Assembla questi 40 pack/ }[language]);
      assert.doesNotMatch(html, /Crée un nouveau projet|Create a new project|Crea un nuovo progetto/);
      assert.match(html, { fr: /réunis dans un nouveau pack\. Les originaux restent intacts\./, en: /combined into a new pack/, it: /riuniti in un nuovo pack/ }[language]);
      assert.ok(html.indexOf('catalogue-selection-assemble') < html.indexOf('catalogue-selection-tag-list'));
      assert.equal(render(SelectionFloatingBar, { panelVisible: true, cards, actions: compose(cards) }), '');
      assert.equal(render(SelectionFloatingBar, { panelVisible: false, cards: cards.slice(0, 1), actions: compose(cards) }), '');
      const floating = render(SelectionFloatingBar, { panelVisible: false, cards, actions: compose(cards) });
      assert.match(floating, /catalogue-selection-floating/);
      assert.match(floating, /aria-pressed="mixed"/);
      assert.doesNotMatch(floating, /<span title=/);
      for (const favorite of [false, true]) {
        const uniform = cards.map(card => ({ ...card, favorite }));
        const bar = render(SelectionFloatingBar, { panelVisible: false, cards: uniform, actions: compose(uniform) });
        assert.match(bar, new RegExp(`aria-pressed="${favorite}"`));
      }
      assert.match(html, /aria-label="(?:Ajouter une étiquette|Add a tag|Aggiungi un’etichetta)"/);
      assert.ok(!compose(cards).some(action => action.id === 'removeFromCatalogue'));
      assert.equal((floating.match(/<svg/g) ?? []).length, 5, 'clear and four commands each have an icon');
      const four = render(FicheSelectionSummary, { cards: cards.slice(0, 4), actions: compose(cards) });
      assert.equal((four.match(/catalogue-cover catalogue-cover--large/g) ?? []).length, 4);
      const tagged = render(FicheSelectionSummary, { cards: [{ id: 'a', tagIds: ['all', 'some'] }, { id: 'b', tagIds: ['all'] }], tags: [{ id: 'all', label: 'Full' }, { id: 'some', label: 'Partial' }], actions: compose(cards) });
      assert.equal((tagged.match(/is-partial/g) ?? []).length, 1);
      assert.match(tagged, /1\/2/);
      const secondary = render(SelectionPanelActions, { cards: cards.slice(0, 2), actions: compose(cards.slice(0, 2)) });
      assert.equal((secondary.match(/<button/g) ?? []).length, 1, 'favorites is a single icon in the header; metadata is inline');
      const busy = render(FicheSelectionSummary, { cards, actions: compose(cards, { busy: true }, 'preparing') });
      assert.equal((busy.match(/aria-disabled="true"/g) ?? []).length, 2, 'favorite and assembly remain explained actions');
      assert.doesNotMatch(busy, /<fieldset|<legend/);
      assert.equal((busy.match(/<kbd/g) ?? []).length, 3, 'keyboard shortcuts use keycaps');
      assert.match(busy, /catalogue-selection-metadata-row/);
      assert.equal((busy.match(/aria-pressed="false"/g) ?? []).length, 7, 'six age presets and the outline favorite star');
      assert.match(busy, /aria-describedby="[^"]+"/);
      assert.match(busy, /catalogue-visually-hidden/);
      assert.doesNotMatch(busy, /catalogue:|\[object Object\]/);
      const all = render(FicheSelectionSummary, { cards: cards.map(card => ({ ...card, favorite: true })), actions: compose(cards) });
      assert.match(all, /aria-pressed="true"/);
    }
  } finally { await server.close(); }
});

test('context on a selected card uses exactly the panel actions; outside it stays a card menu', () => {
  const present = cards.slice(0, 2).map(card => ({ ...card, available: true }));
  const missing = present.map(card => ({ ...card, available: false, offlineReason: 'missing' }));
  const unplugged = missing.map(card => ({ ...card, offlineReason: 'unavailable' }));
  for (const targets of [present, missing, unplugged, [present[0], missing[1]]]) {
    const actions = compose(targets);
    assert.equal(selectionMenuKind(targets[0], targets), 'selection');
    const entries = selectionMenuEntries(actions);
    assert.deepEqual(entries.map(entry => entry.action), actions);
    assert.ok(entries.every((entry, index) => entry.action === actions[index]), 'no separate availability rules');
    assert.equal(entries.some(entry => entry.action.id === 'removeFromCatalogue'), targets === missing);
    assert.equal(entries.some(entry => entry.action.id === 'assemble'), targets === present);
    assert.ok(!entries.some(entry => ['simulate', 'edit', 'copyUuid', 'reveal'].includes(entry.action.id)));
    assert.equal(selectionMenuKind({ id: 'outside' }, targets), 'card');
    assert.equal(selectionMenuKind(targets[0], [targets[0]]), 'card');
  }
});
