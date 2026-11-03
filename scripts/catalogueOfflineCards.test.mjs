import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import react from '@vitejs/plugin-react';
import { createServer } from './viteTestServer.mjs';
import { normalizeEntry } from '../src/store/catalogue/entryModel.js';
import { offlinePresentation } from '../src/store/catalogue/offlinePresentation.js';
import { cardMenuActions } from '../src/store/catalogue/cardActions.js';
import { rawEntry } from './catalogueFixtures.mjs';

const offline = (offlineReason, path) => normalizeEntry({ ...rawEntry({ exemplars: [{ available: false, path }] }), offlineReason });
const online = () => normalizeEntry(rawEntry({ exemplars: [{ path: '/packs/a.zip' }] }));

test('offline presentation: reason, folder for an unreachable folder, last known path for a missing file', () => {
  assert.equal(offlinePresentation(online()), null);
  assert.equal(offlinePresentation(null), null);
  assert.deepEqual(offlinePresentation(offline('unavailable', '/mnt/nas/packs/a.zip')), { reason: 'unavailable', paths: ['/mnt/nas/packs'] });
  assert.deepEqual(offlinePresentation(offline('unavailable', 'D:\\Packs\\a.zip')), { reason: 'unavailable', paths: ['D:\\Packs'] });
  assert.deepEqual(offlinePresentation(offline('missing', '/mnt/nas/packs/a.zip')), { reason: 'missing', paths: ['/mnt/nas/packs/a.zip'] });
  // Un motif inconnu retombe sur « inaccessible », comme le modèle d'entrée.
  assert.equal(offlinePresentation(offline('whatever', '/p/a.zip')).reason, 'unavailable');
});

test('"Retirer du catalogue" is offered in the card menu for online and offline packs (FICHEB)', () => {
  const ids = (card) => cardMenuActions(card, card.exemplars).map((action) => action.id);
  assert.ok(ids(offline('missing', '/p/a.zip')).includes('removeFromCatalogue'));
  assert.ok(ids(offline('unavailable', '/p/a.zip')).includes('removeFromCatalogue'));
  assert.ok(ids(online()).includes('removeFromCatalogue'));
});

test('cover corner marks: star toggle without text button, offline badge with a tooltip text', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    const engine = initializeI18n('fr');
    const { CardCover } = await server.ssrLoadModule('/src/components/Catalogue/views/CardCover.jsx');
    const view = { dataBusy: false, onFavorite() {} };
    for (const language of ['fr', 'en', 'it']) {
      await engine.changeLanguage(language);
      for (const favorite of [false, true]) {
        const card = { ...online(), favorite };
        const html = renderToStaticMarkup(React.createElement(CardCover, { card, view, tabIndex: 0 }));
        assert.match(html, new RegExp(`class="catalogue-star"[^>]*aria-pressed="${favorite}"|aria-pressed="${favorite}"`));
        assert.doesNotMatch(html, /catalogue-offline-badge|catalogue-cover-frame--offline/);
        assert.doesNotMatch(html, /catalogue:|\[object Object\]/);
      }
      for (const reason of ['missing', 'unavailable']) {
        const html = renderToStaticMarkup(React.createElement(CardCover, { card: offline(reason, '/mnt/nas/a.zip'), view, tabIndex: -1 }));
        assert.match(html, /catalogue-cover-frame--offline/);
        if (reason === 'missing') {
          assert.match(html, /catalogue-cover-frame--missing/);
          assert.match(html, /catalogue-offline-badge--missing/);
          assert.ok(html.includes(`>${engine.t('catalogue:offline.missing.badge')}</span>`));
        } else {
          assert.doesNotMatch(html, /catalogue-cover-frame--missing|catalogue-offline-badge--missing/);
          assert.ok(!html.includes(`>${engine.t('catalogue:offline.missing.badge')}</span>`));
        }
        assert.match(html, /role="img" aria-label="[^"]*\/mnt\/nas/);
        assert.doesNotMatch(html, /catalogue:|\[object Object\]/);
      }
    }
    assert.match(engine.t('catalogue:offline.unavailable.label'), /.+/);
  } finally { await server.close(); }
});
