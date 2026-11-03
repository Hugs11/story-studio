import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { mountSurface } from './chromeBench.mjs';
const { FicheExemplars } = await import('../src/components/Catalogue/fiche/FicheDialog.jsx');
const { ErrorDialogProvider } = await import('../src/components/common/Dialog.jsx');
const { cardMenuActions, menuEntries } = await import('../src/store/catalogue/cardActions.js');
test('inline removal has translated icon labels, shows disabled archive members and hides other ineligible copies, and no removal menu or open dialog', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  const exemplars = [
    { id: 'pack', format: 'zip', state: 'available', available: true, path: '/packs/Exact.zip' },
    { id: 'missing', format: 'zip', state: 'missing', path: '/packs/Missing.zip' },
    { id: 'unavailable', format: 'zip', state: 'unavailable', path: '/packs/Offline.zip' },
    { id: 'member', format: 'zip', state: 'available', member: 'Child.zip', path: '/packs/Bundle.zip' },
  ];
  const card = { id: 'card', exemplars };
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const html = mountSurface(React.createElement(ErrorDialogProvider, null, React.createElement(FicheExemplars, { card }))).html;
    assert.match(html, /id="catalogue-fiche-copy-pack-trash"/);
    assert.match(html, /id="catalogue-fiche-copy-member-trash"[^>]*disabled/);
    assert.doesNotMatch(html, /id="catalogue-fiche-copy-(missing)-trash"|<dialog|catalogue:|rust:|\[object Object\]/);
    // Changement voulu : seul l'exemplaire introuvable offre le retrait confirmé du catalogue.
    assert.doesNotMatch(html, /id="catalogue-fiche-copy-missing-(reveal|trash)"/);
    assert.match(html, /id="catalogue-fiche-copy-missing-remove"/);
    assert.doesNotMatch(html, /id="catalogue-fiche-copy-(pack|unavailable|member)-remove"/);
    const single = mountSurface(React.createElement(ErrorDialogProvider, null, React.createElement(FicheExemplars, { card: { id: 'single', exemplars: [exemplars[1]] } }))).html;
    assert.doesNotMatch(single, /id="catalogue-fiche-copy-missing-remove"/);
    assert.ok(!cardMenuActions(card, exemplars).some(a => a.id === 'trash'));
    assert.ok(!menuEntries({ open: true, kind: 'exemplar', scope: 'pack' }, card, exemplars).some(e => e.action.id === 'trash'));
  }
});


test('missing copy removal requires explicit confirmation and keeps the original revision', async () => {
  const { removeMissingExemplar } = await import('../src/store/catalogue/removeMissingExemplar.js');
  const { createCatalogueDataApi } = await import('../src/store/catalogue/catalogueDataApi.js');
  for (const choice of [false, null, true]) {
    const calls = [];
    const api = createCatalogueDataApi({ invoke: async (command, args) => {
      calls.push({ command, args });
      return { catalogueRevision: 14 };
    } });
    let confirmation;
    const result = await removeMissingExemplar({ card: { id: 'card' }, exemplar: { id: 'missing' }, api,
      t: key => i18next.t(key), showChoiceDialog: async options => { confirmation = options; return choice; } });
    assert.equal(confirmation.message, i18next.t('catalogue:fiche.copies.remove.confirm'));
    assert.equal(confirmation.actions[0].value, false);
    assert.equal(confirmation.actions[0].autoFocus, true);
    assert.equal(confirmation.actions[1].kind, 'danger');
    assert.equal(result, choice === true);
    assert.deepEqual(calls, [
      { command: 'catalogue_get_card', args: { ficheId: 'card' } },
      ...(choice === true ? [{ command: 'catalogue_remove_missing_exemplar', args: { exemplarId: 'missing', expectedCatalogueRevision: 14 } }] : []),
    ]);
  }
});

// Deliberate change to QZb: members stay visible; Rust supplies eligibility.
test('archive trash label names the container and shared reason includes its pack count', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  const { trashAvailability } = await import('../src/store/catalogue/trashPlan.js');
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    // Deliberate change (rule of 28 Oct.): 'nested' is no longer a refusal; the
    // engine now reports real counts ('multiple'), unreadable packs and
    // uninspectable contents, and an unknown reason still gets a text.
    for (const [enabled, reason, packCount] of [[true, null, 1], [false, 'shared', 3], [false, 'multiple', 3], [false, 'unavailable', 1], [false, 'unreadable', 1], [false, 'uninspectable', null], [false, 'mystery', 1]]) {
      const exemplar = { id: 'archive', format: 'zip', state: 'available', path: '/packs/Bundle.zip', member: 'pack', archiveRemoval: { enabled, reason, packCount } };
      const availability = trashAvailability(exemplar);
      assert.equal(availability.enabled, enabled);
      if (!enabled) {
        const text = i18next.t(availability.reasonKey, availability.reasonParams);
        assert.doesNotMatch(text, /^catalogue:|\{\{|explorateur|explorer|esplora/);
        if (['shared', 'multiple'].includes(reason)) assert.match(text, /3/);
      }
      const html = mountSurface(React.createElement(ErrorDialogProvider, null, React.createElement(FicheExemplars, { card: { id: 'card', exemplars: [exemplar] } }))).html;
      assert.match(html, /aria-label="[^"]*Bundle.zip/);
      const button = html.match(/<button[^>]*id="catalogue-fiche-copy-archive-trash"[^>]*>/)?.[0];
      assert.ok(button);
      assert.equal(/disabled=""/.test(button), !enabled);
      assert.doesNotMatch(html, /catalogue:|rust:|\[object Object\]/);
    }
  }
});

test('the opened fiche archive count replaces the catalogue decision once it answers', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  const exemplar = { id: 'archive', format: 'zip', state: 'available', path: '/packs/Bundle.zip', member: 'pack', archiveRemoval: { enabled: true, reason: null, packCount: 1 } };
  const button = archiveRemovals => mountSurface(React.createElement(ErrorDialogProvider, null, React.createElement(FicheExemplars, { card: { id: 'card', exemplars: [exemplar] }, archiveRemovals })))
    .html.match(/<button[^>]*id="catalogue-fiche-copy-archive-trash"[^>]*>/)?.[0];
  assert.doesNotMatch(button(null), /disabled=""/);
  assert.doesNotMatch(button({ other: { enabled: false, reason: 'multiple', packCount: 2 } }), /disabled=""/);
  assert.match(button({ archive: { enabled: false, reason: 'multiple', packCount: 2 } }), /disabled=""/);
});

test('a missing archive member shows no greyed trash button', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  for (const archiveRemoval of [{ enabled: false, reason: 'unavailable', packCount: 1 }, { enabled: true, reason: null, packCount: 1 }]) {
    const exemplar = { id: 'gone', format: 'zip', state: 'missing', path: '/packs/Gone.zip', member: 'pack', archiveRemoval };
    const html = mountSurface(React.createElement(ErrorDialogProvider, null, React.createElement(FicheExemplars, { card: { id: 'card', exemplars: [exemplar] } }))).html;
    assert.doesNotMatch(html, /catalogue-fiche-copy-gone-trash/);
  }
});
