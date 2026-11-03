import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { card } from './catalogueFixtures.mjs';
import { memoizePipeline } from '../src/store/catalogue/pipeline.js';
import { menuEntries } from '../src/store/catalogue/cardActions.js';
import { menuReducer, CLOSED_MENU } from '../src/store/catalogue/menuState.js';
const noop = () => {};
const view = { selected: new Set(['a']), activeId: 'a', expanded: new Set(['a']), menu: CLOSED_MENU, setActiveId: noop, onItemClick: noop, onOpenModal: noop, onItemKeyDown: noop, onCardMenu: noop, onFormatClick: noop, onExemplarMenu: noop, onToggleExpanded: noop };
test('two views, menus and read-only fiche render accessible FR/EN/IT surfaces', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    const engine = initializeI18n('fr');
    const views = [];
    for (const name of ['CardGridView','ListView']) views.push((await server.ssrLoadModule(`/src/components/Catalogue/views/${name}.jsx`))[name]);
    const { FichePanel } = await server.ssrLoadModule('/src/components/Catalogue/fiche/FicheDialog.jsx');
    const { CardContextMenu } = await server.ssrLoadModule('/src/components/Catalogue/menus/CardContextMenu.jsx');
    const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
    const cards = [card({ id: 'a', title: 'Abeille', description: '<unsafe>', referenceUnavailable: true, exemplars: [{ id: 'p', format: 'project', path: '/Packs/project.mbah' }, { id: 'z', path: '/Packs/multi.zip', member: 'ours', available: false }] }), card({ id: 'b', title: 'Zèbre' })];
    cards[0].referenceExemplarId = 'z';
    for (const language of ['fr','en','it']) {
      await engine.changeLanguage(language);
      const matching = memoizePipeline()(cards, { query: 'project.mbah', filters: { availability: 'all' } }).items;
      for (const component of views) {
        const html = render(component, { items: matching, view });
        assert.match(html, /data-exemplar-id="p"/);
        assert.match(html, /project.mbah/);
      }
      for (const count of [0,1,2]) {
        const items = memoizePipeline()(cards.slice(0, count), { filters: { availability: 'all' } }).items;
        const orders = views.map(component => {
          const html = render(component, { items, view });
          assert.match(html, /role="grid"/);
          assert.match(html, /aria-multiselectable="true"/);
          assert.doesNotMatch(html, /catalogue:|\[object Object\]|<img/);
          if (count) {
            assert.match(html, /aria-selected="true"/);
            // Lot S4 : plus de bouton « Modifier » ni de bouton texte « favoris » ; étoile en coin.
            assert.doesNotMatch(html, /id="catalogue-edit-a"/);
            assert.match(html, /class="catalogue-star"/);
            assert.match(html, /catalogue-format-tag-label/);
          }
          return [...html.matchAll(/data-card-id="([^"]+)"/g)].map(m => m[1]);
        });
        assert.deepEqual(orders, Array(2).fill(items.map(i => i.card.id)));
      }
      for (const referenceUnavailable of [false,true]) {
        const html = render(FichePanel, { card: { ...cards[0], referenceUnavailable }, onClose: noop, onFormatClick: noop });
        // FICHEA: the inspector content is nonmodal, compact and omits provenance.
        assert.match(html, /catalogue-fiche-content/);
        assert.doesNotMatch(html, /role="dialog"|aria-modal|catalogue-fiche-reference|catalogue-fiche-tag|<table|<details/);
        // FICHEC strips imported markup; a tag-only description uses the localized empty state.
        assert.doesNotMatch(html, /unsafe/);
        assert.ok(html.includes(engine.t('catalogue:fiche.description.empty')));
        assert.match(html, /catalogue-fiche-copies/);
        assert.doesNotMatch(html, /catalogue:|\[object Object\]|Non renseigné/);
      }
      for (const kind of ['card']) {
        const menu = menuReducer(CLOSED_MENU, { type: 'open', kind, scope: 'z', itemCount: 7 });
        const html = render(CardContextMenu, { menu, card: cards[0], entries: menuEntries(menu, cards[0], cards[0].exemplars), dispatch: noop, onActivate: noop, onBack: noop, tagMenu: { tags: [], targets: [cards[0]], busy: false, onMutate: noop } });
        assert.match(html, /role="menu"/);
        assert.match(html, /role="menuitem"/);
        assert.match(html, /aria-disabled="true" aria-describedby=/);
        assert.match(html, /id="catalogue-menu-item-[^"]+-reason" aria-label=/, 'FICHEB: reasons live in tooltips');
        assert.doesNotMatch(html, /catalogue:|\[object Object\]/);
        // Le sous-menu « Étiquettes » porte le chevron des sous-menus du menu Filtres, pas un glyphe dans le texte.
        assert.doesNotMatch(html, /▸/);
        assert.match(html, /aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*><span class="catalogue-menu-item-head"><svg[^>]*class="catalogue-menu-item-icon"[^>]*>.*?<\/svg><span class="catalogue-menu-item-label"[^>]*>[^<]*<\/span><svg[^>]*><path[^>]*d="m9 18 6-6-6-6"/);
        // Chaque entrée porte l'icône de la même action ailleurs dans l'app (Lucide, 16 px) ; le sous-menu d'étiquettes reste fermé tant qu'on ne l'ouvre pas.
        const entryCount = (html.match(/role="menuitem"/g) ?? []).length;
        assert.equal((html.match(/class="catalogue-menu-item-icon"/g) ?? []).length, entryCount, 'une icône devant chaque entrée');
        assert.doesNotMatch(html, /class="project-submenu"/);
        // Une raison de refus reste sur la ligne de l'entrée (jamais en 2ᵉ ligne).
        assert.doesNotMatch(html, /ⓘ/);
        assert.match(html, /<span class="catalogue-menu-item-label"[^>]*>[^<]+<\/span><span id="[^"]+-reason"[^>]*class="catalogue-menu-item-reason-mark"><svg/);
      }
    }
  } finally { await server.close(); }
});

test('browser forwards tab activity to shortcuts while keeping the same rendered results', async () => {
  const previous = globalThis.__catalogueShortcutActivity;
  const server = await createServer({ configFile: false, plugins: [{ name: 'catalogue-shortcut-activity', enforce: 'pre', transform(code, id) {
    if (id.endsWith('/useCatalogueShortcuts.js')) return 'export function useCatalogueShortcuts(handlers, options) { globalThis.__catalogueShortcutActivity = options.active; }';
  } }, react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    initializeI18n('fr');
    const { CatalogueBrowser } = await server.ssrLoadModule('/src/components/Catalogue/CatalogueBrowser.jsx');
    const cards = [card({ id: 'a', title: 'Abeille' })];
    // Lot S4 : le retrait d'un pack hors ligne demande sa confirmation par la boîte de dialogue commune.
    const { ErrorDialogProvider } = await server.ssrLoadModule('/src/components/common/Dialog.jsx');
    const render = active => renderToStaticMarkup(React.createElement(ErrorDialogProvider, null, React.createElement(CatalogueBrowser, { active, cards, revision: 7, api: {}, onAnnounce: noop, onError: noop, renderEmpty: noop })));
    const catalogue = render(true);
    assert.equal(globalThis.__catalogueShortcutActivity, true);
    assert.equal(render(false), catalogue);
    assert.equal(globalThis.__catalogueShortcutActivity, false);
    assert.equal(render(true), catalogue);
    assert.equal(globalThis.__catalogueShortcutActivity, true);
  } finally {
    globalThis.__catalogueShortcutActivity = previous;
    await server.close();
  }
});
