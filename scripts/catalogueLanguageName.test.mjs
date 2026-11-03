import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import react from '@vitejs/plugin-react';
import { createServer } from './viteTestServer.mjs';
import { card } from './catalogueFixtures.mjs';
import { CLOSED_MENU } from '../src/store/catalogue/menuState.js';
import { memoizePipeline } from '../src/store/catalogue/pipeline.js';
import { activeFilterSummary } from '../src/store/catalogue/filters.js';

const noop = () => {};
const view = { selected: new Set(), activeId: 'a', expanded: new Set(), menu: CLOSED_MENU, setActiveId: noop, onItemClick: noop, onOpenModal: noop, onItemKeyDown: noop, onCardMenu: noop, onFormatClick: noop, onExemplarMenu: noop, onToggleExpanded: noop };

test('une langue de fiche est affichée par son nom (fiche, liste, sélection), le code inconnu tel quel', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    const engine = initializeI18n('fr');
    const { languageLabel } = await server.ssrLoadModule('/src/store/catalogue/languageOptions.js');
    const { FichePanel } = await server.ssrLoadModule('/src/components/Catalogue/fiche/FicheDialog.jsx');
    const { ListView } = await server.ssrLoadModule('/src/components/Catalogue/views/ListView.jsx');
    const { SelectionMetadataControls } = await server.ssrLoadModule('/src/components/Catalogue/selection/SelectionControls.jsx');
    const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
    const cardOf = code => card({ id: 'a', title: 'Abeille', language: code, exemplars: [{ id: 'z', path: '/Packs/a.zip' }] });
    const items = code => memoizePipeline()([cardOf(code)], { filters: { availability: 'all' } }).items;
    const names = { fr: ['Français', 'French', 'Francese'], en: ['Anglais', 'English', 'Inglese'] };
    for (const [index, language] of ['fr', 'en', 'it'].entries()) {
      await engine.changeLanguage(language);
      const t = engine.t.bind(engine);
      assert.equal(languageLabel('fr', t), names.fr[index]);
      assert.equal(languageLabel('en', t), names.en[index]);
      assert.equal(languageLabel('xx', t), 'xx', 'code inconnu : affiché tel quel');
      const fiche = render(FichePanel, { card: cardOf('fr'), onClose: noop, onFormatClick: noop });
      assert.match(fiche, new RegExp(`<dd><span[^>]*>${names.fr[index]}</span>`));
      assert.doesNotMatch(fiche, />fr</);
      const list = render(ListView, { items: items('fr'), view });
      assert.match(list, new RegExp(`>${names.fr[index]}<`));
      assert.match(render(ListView, { items: items('xx'), view }), />xx</);
      const selection = render(SelectionMetadataControls, { cards: [cardOf('en'), { ...cardOf('en'), id: 'b' }], busy: false });
      assert.match(selection, new RegExp(`>${names.en[index]}<`), 'valeur commune de la sélection');
      assert.doesNotMatch(selection, />en</);
      assert.match(render(SelectionMetadataControls, { cards: [cardOf('xx')], busy: false }), />xx</);
    }
  } finally { await server.close(); }
});

test('le récapitulatif du filtre d’étiquettes porte le libellé de la famille, sans mode', () => {
  const [item] = activeFilterSummary({ tags: { ids: ['doudou'], mode: 'any' } });
  assert.deepEqual(item, { family: 'tags', key: 'catalogue:filter.tags.label', params: { values: ['doudou'] } });
});
