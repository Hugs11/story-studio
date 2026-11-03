import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { card } from './catalogueFixtures.mjs';
import { CLOSED_CHOICE, choiceItems, choiceReducer } from '../src/store/catalogue/exemplarChoice.js';
import { simulationAvailability } from '../src/store/catalogue/simulationAvailability.js';

const noop = () => {};

test('choice box, preparation, failure and fiche action render accessible FR/EN/IT surfaces', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    const engine = initializeI18n('fr');
    const { ExemplarChoicePanel } = await server.ssrLoadModule('/src/components/Catalogue/open/ExemplarChoiceDialog.jsx');
    const { SimulatorNotice } = await server.ssrLoadModule('/src/components/Catalogue/open/CatalogueSimulator.jsx');
    const { FichePanel } = await server.ssrLoadModule('/src/components/Catalogue/fiche/FicheDialog.jsx');
    const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
    const c = card({ id: 'c', title: 'Lune <b>', exemplars: [
      { id: 'zip', path: '/Packs/Lune.zip' },
      { id: 'project', format: 'project', path: '/Packs/Lune.mbah', projectType: 'pack' },
      { id: 'gone', path: '/Packs/Lune-ancien.zip', available: false },
    ] });
    const items = choiceItems(c.exemplars, simulationAvailability);
    const choice = choiceReducer(CLOSED_CHOICE, { type: 'open', cardId: 'c', command: 'simulate', revision: 1, items });
    const exemplar = c.exemplars[0];
    for (const language of ['fr', 'en', 'it']) {
      await engine.changeLanguage(language);
      const box = render(ExemplarChoicePanel, { choice, card: c, items, dispatch: noop, onChoose: noop, onCancel: noop });
      assert.match(box, /role="dialog" aria-modal="true" aria-labelledby="catalogue-choice-title"/);
      assert.match(box, /role="listbox"/);
      assert.equal((box.match(/role="option"/g) ?? []).length, 3, 'every copy is listed');
      assert.match(box, /aria-activedescendant="catalogue-choice-option-[^"]+"/);
      assert.match(box, /aria-disabled="true" aria-describedby="catalogue-choice-option-gone-reason"/);
      assert.match(box, /id="catalogue-choice-option-gone-reason"/);
      assert.match(box, /Lune &lt;b&gt;/);
      // FICHEA: compact identities replace filenames and full folders.
      assert.doesNotMatch(box, /Lune-ancien\.zip|\/Packs/);
      assert.match(box, /catalogue-choice-option-label/);
      assert.doesNotMatch(box, /catalogue:[a-z]+\.|\[object Object\]|undefined/);

      const source = { name: 'Lune.zip', format: 'ZIP' };
      const preparing = render(SimulatorNotice, { state: { status: 'preparing', target: { exemplar } }, source, onClose: noop, onRelaunch: noop, onChooseAgain: noop });
      assert.match(preparing, /role="dialog" aria-modal="true" aria-labelledby="catalogue-simulator-title" aria-busy="true"/);
      assert.match(preparing, /role="status"/);
      assert.match(preparing, /Lune\.zip/);
      assert.equal((preparing.match(/<button/g) ?? []).length, 1, 'cancel only');
      assert.doesNotMatch(preparing, /catalogue:[a-z]+\.|\[object Object\]|undefined/);

      for (const [error, retry, buttons] of [
        [{ code: 'CATALOG_CONSULTATION_EXPIRED', params: {} }, 'relaunch', 2],
        [{ code: 'CATALOG_TARGET_REVISION_CHANGED', params: { path: '/Packs/Lune.zip' } }, 'choose', 2],
        [{ code: 'CATALOG_SIMULATION_UNSUPPORTED', params: { path: '/Packs/Lune.zip' } }, null, 1],
      ]) {
        const failed = render(SimulatorNotice, { state: { status: 'failed', error, retry, target: { exemplar } }, source, onClose: noop, onRelaunch: noop, onChooseAgain: noop });
        assert.match(failed, /role="alert"/);
        assert.doesNotMatch(failed, /aria-busy/);
        assert.equal((failed.match(/<button/g) ?? []).length, buttons, `${error.code}`);
        assert.doesNotMatch(failed, /catalogue:[a-z]+\.|rust:[A-Z]|\[object Object\]|undefined/);
      }

      const enabled = render(FichePanel, { card: c, onSimulate: noop });
      assert.match(enabled, /role="group"/);
      assert.match(enabled, /aria-haspopup="dialog"/, 'two suitable copies: choice');
      assert.doesNotMatch(enabled, /id="catalogue-fiche-simulate"[^>]*aria-disabled/);
      const lone = card({ exemplars: [{ id: 'x', available: false }] });
      const disabled = render(FichePanel, { card: lone, onSimulate: noop });
      // FICHEA: an unavailable action is hidden instead of explaining itself.
      assert.doesNotMatch(disabled, /id="catalogue-fiche-simulate"|catalogue-fiche-simulate-reason/);
      assert.doesNotMatch(disabled + enabled, /catalogue:[a-z]+\.|\[object Object\]/);
    }
  } finally {
    await server.close();
  }
});
