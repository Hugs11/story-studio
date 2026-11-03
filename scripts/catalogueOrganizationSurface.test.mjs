import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { selectionActions } from '../src/store/catalogue/selectionActions.js';
const noop = () => {};
test('organization surfaces FR/EN/IT: 0/1/N selection, pressed star, mixed membership, tags and D74', async () => {
 const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
 try {
  const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
  const component = async path => (await server.ssrLoadModule(`/src/components/Catalogue/${path}.jsx`))[path.split('/').at(-1)];
  const { FicheSelectionSummary } = await server.ssrLoadModule('/src/components/Catalogue/fiche/SelectionPanel.jsx'); const FavoriteButton = await component('FavoriteButton');
  const TagInput = await component('tags/TagInput'); const TagSubmenu = await component('tags/TagSubmenu');
  const render = (Component, props) => {
   const html = renderToStaticMarkup(React.createElement(Component, props));
   assert.doesNotMatch(html, /catalogue:|\[object Object\]/); return html;
  };
  const tags = [{ id: 't', label: '<Lune>', revision: 1, count: 3, countUnreferenced: 1 }, { id: 'u', label: 'Soleil', revision: 1, count: 2, countUnreferenced: 0 }];
  for (const language of ['fr', 'en', 'it']) {
   await engine.changeLanguage(language);
   for (const count of [0, 1, 40]) {
    const targets = Array.from({ length: count }, (_, i) => ({ id: String(i) }));
    const html = render(FicheSelectionSummary, { cards: targets, actions: selectionActions(targets.map(card => card.id), targets, targets.map(card => card.id), {}).actions, onAction: noop, onClear: noop });
    // Le panneau de sélection garde les commandes collectives dans les trois langues.
    if (!count) assert.equal(html, '');
    else {
      assert.match(html, new RegExp(String(count))); assert.doesNotMatch(html, /<details|<summary/);
      assert.match(html, /aria-haspopup="menu"/); assert.doesNotMatch(html, /Tout s|Select all|Seleziona tutto/);
      // Les actions de données restent disponibles, y compris âge/langue et copie.
      assert.doesNotMatch(html, /aria-disabled/);
    }
   }
   for (const favorite of [false, true]) {
    const html = render(FavoriteButton, { favorite, busy: true }); assert.match(html, new RegExp(`aria-pressed="${favorite}"`)); assert.match(html, /aria-describedby=/); assert.match(html, favorite ? /★/ : /☆/);
   }
   const input = render(TagInput, { tags, busy: false, onAdd: noop }); assert.match(input, /role="combobox"/); assert.match(input, /role="listbox"/); assert.match(input, /role="option"/); assert.match(input, /aria-expanded="false"/);
   const html = render(TagSubmenu, { tags, targets: [], filterValue: { ids: ['t'], mode: 'any' }, onFilterChange: noop,  onClose: noop, position: { x: 0, y: 0 } });
   assert.match(html, /role="menuitemcheckbox" aria-checked="true"/);
   assert.match(html, /role="menuitemcheckbox" aria-checked="false"/);
   assert.doesNotMatch(html, /role="switch"/);
  }
 } finally { await server.close(); }
});
