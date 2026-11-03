import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import i18next from 'i18next';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import fixture from './fixtures/catalogue/backup-import.json' with { type: 'json' };
import { INITIAL_IMPORT } from '../src/store/catalogue/importPreviewState.js';
const { ImportDialog } = await import('../src/components/Catalogue/backup/ImportDialog.jsx');
const { ScanSummary } = await import('../src/components/Catalogue/operations/ScanSummary.jsx');
test('import conflicts and unassociated data are accessible in FR/EN/IT', async () => {
 const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
 for (const language of ['fr', 'en', 'it']) {
  await i18next.changeLanguage(language);
  for (const phase of ['choosing', 'preview', 'preparing', 'applying', 'cancelling', 'cancelled', 'success']) {
   const state = { ...INITIAL_IMPORT, phase, preview: fixture.preview, result: fixture.result, path: '/sauvegarde é.zip' };
   const html = mountSurface(React.createElement(ImportDialog, { flow: { state, dispatch() {}, preview() {}, apply() {}, page() {}, cancel() {} }, onChoosePath() {} })).html;
   assert.match(html, /<dialog[^>]*aria-label=/); assert.match(html, /<label/); assert.match(html, /aria-live="polite" aria-atomic="true"/);
   assert.doesNotMatch(html, /catalogue:|undefined|\[object Object\]/); assert.doesNotMatch(html, /<button[^>]*\sdisabled=/);
   if (phase === 'preview') { assert.match(html, /<fieldset/); assert.match(html, /<legend/); assert.match(html, /type="radio"[^>]*checked=/); assert.match(html, /<nav aria-label=/); }
   if (['preparing', 'applying', 'cancelling'].includes(phase)) assert.match(html, /aria-disabled="true"[^>]*aria-describedby=/);
  }
  const html = mountSurface(React.createElement(ScanSummary, { snapshot: { ...fixture.receipt, operationKind: 'catalogueImport', status: 'success', result: fixture.result }, onReport() {}, onClose() {} })).html;
  assert.doesNotMatch(html, /catalogue:|undefined|\[object Object\]/); assert.ok(html.includes(i18next.t('catalogue:backupImport.resultTitle'))); assert.doesNotMatch(html, /report|Bilan du scan|Scan complet/);
 }
});

test('readable titles, metadata and correction states replace raw conflict JSON in three languages', async () => {
 const { ImportConflictRow } = await import('../src/components/Catalogue/backup/ImportConflictRow.jsx');
 const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
 for (const language of ['fr', 'en', 'it']) {
  await i18next.changeLanguage(language);
  for (const correction of ['defined', 'cleared', 'source']) {
   const conflict = { id: 'opaque-conflict', defaultChoice: 'local', target: { id: 'import-opaque', label: 'Le voyage de Luna', kind: 'corrections', key: 'title:fr' }, local: { field: 'title', language: 'fr', state: 'defined', value: 'Luna' }, incoming: { field: 'title', language: 'fr', state: correction, value: correction === 'defined' ? 'Nuovo viaggio' : null } };
   const html = mountSurface(React.createElement(ImportConflictRow, { conflict, state: INITIAL_IMPORT, dispatch() {} })).html;
   const visible = html;
   assert.match(visible, /Le voyage de Luna/);assert.match(visible, /Luna/);
   assert.doesNotMatch(visible, /title:fr|import-opaque|&quot;state&quot;|referenceBundle|\bdefined\b|\bcleared\b/);
   assert.doesNotMatch(html, /<details|<summary|&quot;state&quot;/);assert.match(html, /<legend>/);
   assert.doesNotMatch(html, /catalogue:|\[object Object\]|undefined/);
  }
 }
});

test('preview announces forgetting and its destructive scope before applying', async () => {
 const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
 await i18next.changeLanguage('fr');
 const state = { ...INITIAL_IMPORT, phase: 'preview', preview: { ...fixture.preview, forgottenCount: 600 } };
 const html = mountSurface(React.createElement(ImportDialog, { flow: { state, dispatch() {} }, onChoosePath() {} })).html;
 assert.match(html, /600 fiches/);
 assert.match(html, /efface corrections, favoris/);
 assert.match(html, /les fichiers de pack sont conservés/);
});

test('forgetting counts use plurals and disappear when nothing is forgotten (FR/EN/IT)', async () => {
 const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
 const expected = {
  fr: { 1: /Oubli proposé : 1 fiche\./, 2: /Oublis proposés : 2 fiches\./, 1000000: /Oublis proposés : 1000000 fiches\./, warning: /Un oubli efface/ },
  en: { 1: /1 card proposed for forgetting\./, 2: /2 cards proposed for forgetting\./, 1000000: /1000000 cards proposed for forgetting\./, warning: /Forgetting erases/ },
  it: { 1: /Si propone di dimenticare 1 scheda\./, 2: /Si propone di dimenticare 2 schede\./, 1000000: /Si propone di dimenticare 1000000 schede\./, warning: /Dimenticare elimina/ },
 };
 for (const language of ['fr', 'en', 'it']) {
  await i18next.changeLanguage(language);
  for (const count of [0, 1, 2, 1000000]) {
   const state = { ...INITIAL_IMPORT, phase: 'preview', preview: { ...fixture.preview, forgottenCount: count } };
   const html = mountSurface(React.createElement(ImportDialog, { flow: { state, dispatch() {} }, onChoosePath() {} })).html;
   assert.doesNotMatch(html, /catalogue:|undefined|\[object Object\]/);
   if (count === 0) {
    assert.doesNotMatch(html, expected[language].warning, `${language} 0`);
    assert.doesNotMatch(html, /Oublis? proposés? : 0|0 cards? proposed|0 schede? che/, `${language} 0`);
   } else {
    assert.match(html, expected[language][count], `${language} ${count}`);
    assert.match(html, expected[language].warning);
   }
  }
 }
});

test('an individual-choice conflict explains its own reason in three languages', async () => {
 const { ImportConflictRow } = await import('../src/components/Catalogue/backup/ImportConflictRow.jsx');
 const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
 const notices = {
  fr: { ageInterval: /âge minimum au-dessus/, forgetRefused: /source active couvre cette fiche/, reference: /référence active/ },
  en: { ageInterval: /minimum age above/, forgetRefused: /active source covers this card/, reference: /active reference/ },
  it: { ageInterval: /età minima sopra/, forgetRefused: /sorgente attiva copre questa scheda/, reference: /riferimento attivo/ },
 };
 for (const language of ['fr', 'en', 'it']) {
  await i18next.changeLanguage(language);
  for (const [kind, reason, key] of [['ageRange', 'ageInterval', 'ageInterval'], ['forgotten', 'forgetRefused', 'forgetRefused'], ['referenceBundle', undefined, 'reference']]) {
   const conflict = { id: `c-${kind}`, defaultChoice: 'local', target: { id: 'x', label: 'Luna', kind, key: '', requiresIndividualChoice: true, individualChoiceReason: reason }, local: kind === 'forgotten' ? false : {}, incoming: kind === 'forgotten' ? true : {} };
   const html = mountSurface(React.createElement(ImportConflictRow, { conflict, state: { ...INITIAL_IMPORT, globalChoice: 'incoming' }, dispatch() {} })).html;
   const visible = html;
   for (const [other, pattern] of Object.entries(notices[language])) {
    if (other === key) assert.match(visible, pattern, `${language} ${kind}`);
    else assert.doesNotMatch(visible, pattern, `${language} ${kind} ${other}`);
   }
   assert.match(html, /value="local"|checked=""[^>]*\/?>[^<]*(Garder local|Keep local|Mantieni)/);
  }
 }
});

// FINy (REVb3 P3): official and reference values can become conflicts; the
// legend names their field instead of falling back to the details link text.
test('reference and pending Lunii value conflicts name their field in three languages', async () => {
 const { ImportConflictRow } = await import('../src/components/Catalogue/backup/ImportConflictRow.jsx');
 const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
 const expected = { fr: ['Luna : Âge maximum', 'Voir les ajouts'], en: ['Luna: Maximum age', 'View additions'], it: ['Luna: Età massima', 'Mostra aggiunte'] };
 for (const language of ['fr', 'en', 'it']) {
  await i18next.changeLanguage(language);
  for (const kind of ['referenceValues', 'pendingLuniiValue']) {
   const row = { field: 'ageMax', language: 'fr', value: 6 };
   const conflict = { id: `c-${kind}`, defaultChoice: 'local', target: { id: 'x', label: 'Luna', kind, key: 'ageMax:fr' }, local: null, incoming: row };
   const html = mountSurface(React.createElement(ImportConflictRow, { conflict, state: INITIAL_IMPORT, dispatch() {} })).html;
   const legend = html.match(/<legend>([\s\S]*?)<\/legend>/)[1];
   assert.ok(legend.includes(expected[language][0]), `${language} ${kind}: ${legend}`);
   assert.ok(!legend.includes(expected[language][1]), `${language} ${kind}: ${legend}`);
  }
 }
});
