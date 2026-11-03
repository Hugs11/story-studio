import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { mountSurface } from './chromeBench.mjs';
import page from './fixtures/catalogue/duplicates-page.json' with { type: 'json' };
const { DuplicateResults, DuplicateDialog } = await import('../src/components/Catalogue/files/DuplicateResults.jsx');
const { CheckerEntry } = await import('../src/components/Catalogue/files/CheckerEntry.jsx');
test('diagnostics and single-source checker chooser expose paths, reasons and translations', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  const cards = [{ id: 'f', exemplars: [{ id: 'pack-a', path: '/packs/First.zip', format: 'zip', state: 'available' }, { id: 'project', path: '/projects/Project.mbah', format: 'project', state: 'available' }] }];
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const results = mountSurface(React.createElement(DuplicateResults, { results: page, cards })).html;
    assert.match(results, /First.zip/); assert.match(results, /0123456789abcdef/); assert.doesNotMatch(results, /catalogue:|rust:|\[object Object\]/);
    const dialog = mountSurface(React.createElement(DuplicateDialog, { cards, onClose() {} })).html;
    assert.match(dialog, /<dialog/); assert.doesNotMatch(dialog, /catalogue:/);
    const chooser = mountSurface(React.createElement(CheckerEntry, { card: cards[0], onClose() {} })).html;
    assert.match(chooser, /aria-disabled="true"/); assert.match(chooser, /aria-describedby/);
    assert.match(chooser, /First.zip/); assert.match(chooser, /Project.mbah/); assert.doesNotMatch(chooser, /catalogue:/);
  }
});

test('FICHEA keeps checker diagnostics out of the fiche action group', async () => {
  const { FichePanel } = await import('../src/components/Catalogue/fiche/FicheDialog.jsx');
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    for (const exemplars of [[], [{ id: 'p', format: 'project', state: 'available' }], [{ id: 'z', format: 'zip', state: 'missing' }]]) {
      const html = mountSurface(React.createElement(FichePanel, { card: { id: 'f', exemplars }, onCheck() {} })).html;
      assert.doesNotMatch(html, /fiche-checker-reason|Vérifier pour la Lunii/);
    }
  }
});
