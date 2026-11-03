import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import i18next from 'i18next';
import { readFile } from 'node:fs/promises';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import fixture from './fixtures/catalogue/backup-export.json' with { type: 'json' };
import { INITIAL_EXPORT } from '../src/store/catalogue/backupExportState.js';
const { ExportDialog } = await import('../src/components/Catalogue/backup/ExportDialog.jsx');
const { CatalogueBackupExport } = await import('../src/components/Catalogue/backup/CatalogueBackupExport.jsx');

test('export summary, conflict, progress and result remain accessible in FR/EN/IT', async () => {
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    for (const phase of ['choosing', 'planned', 'running', 'cancelling', 'cancelled', 'success', 'failed']) {
      const state = { ...INITIAL_EXPORT, phase, path: '/exports/Très long chemin/sauvegarde.zip', plan: { ...fixture.plan, conflicts: ['destinationExists'] }, result: fixture.result };
      const html = mountSurface(React.createElement(ExportDialog, { flow: { state, dispatch() {}, preview() {}, start() {}, cancel() {} }, onChoosePath() {} })).html;
      assert.doesNotMatch(html, /catalogue:|undefined|\[object Object\]/);
      assert.doesNotMatch(html, /sauvegardes de fichiers|file backups|copie di sicurezza dei file/);
      assert.match(html, /<dialog[^>]*aria-label=/);
      assert.match(html, /<label/); assert.match(html, /type="checkbox"/);
      assert.match(html, /aria-live="polite" aria-atomic="true"/);
      assert.match(html, /aria-disabled="true"[^>]*aria-describedby=/);
      assert.doesNotMatch(html, /<button[^>]*\sdisabled=/);
      if (phase === 'success') assert.match(html, /aaaaaaaaaaaaaaaa/);
    }
    const action = mountSurface(React.createElement(CatalogueBackupExport, { revision: 7 })).html;
    assert.match(action, /<button type="button"/); assert.doesNotMatch(action, /catalogue:/);
  }
});
test('command lives in catalogue preferences and retains native keyboard dialogue containment', async () => {
  const screen = await readFile(new URL('../src/components/Catalogue/CatalogueScreen.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(screen, /CatalogueBackup(?:Export|Import)/);
  const preferences = await readFile(new URL('../src/tabs/OptionsTab/CatalogueSection.jsx', import.meta.url), 'utf8');
  assert.match(preferences, /<CatalogueBackupExport[^\n]*revision={entries.revision}/);
  assert.match(preferences, /<CatalogueBackupImport[^\n]*revision={entries.revision} candidates={entries.cards}/);
  assert.match(screen, /<CatalogueChrome/);
  const containment = await readFile(new URL('../src/components/common/ContentDialog.jsx', import.meta.url), 'utf8');
  assert.match(containment, /dialog.showModal\(\)/); assert.match(containment, /previous.focus\(\)/);
  const adapter = await readFile(new URL('../src/store/catalogue/catalogueBackupApi.js', import.meta.url), 'utf8');
  assert.match(adapter, /toCatalogueError\(error\)/);
});

test('common operation summary exposes the verified backup result', async () => {
  const { ScanSummary } = await import('../src/components/Catalogue/operations/ScanSummary.jsx');
  const { shouldAnnounce } = await import('../src/store/catalogue/operationView.js');
  const snapshot = { ...fixture.receipt, status: 'success', scanComplete: true, result: fixture.result };
  assert.equal(shouldAnnounce(snapshot), true);
  const html = mountSurface(React.createElement(ScanSummary, { snapshot, onReport() {}, onClose() {} })).html;
  assert.match(html, /\/exports\/catalogue.zip/); assert.match(html, /aaaaaaaaaaaaaaaa/);
  assert.doesNotMatch(html, /catalogue:|undefined|\[object Object\]/);
});

test('export result says verified and counts missing Lunii covers with plurals (FR/EN/IT)', async () => {
  const { BackupExportSummary } = await import('../src/components/Catalogue/backup/BackupExportSummary.jsx');
  const engine = createTestI18n(); await i18next.init({ ...engine.options, resources: engine.options.resources });
  const expected = {
    fr: { verified: /Sauvegarde vérifiée et exportée/, missing: /jaquette/, 1: /1 jaquette Lunii indisponible est conservée comme référence\./, 2: /2 jaquettes Lunii indisponibles sont conservées/, 1000000: /1000000 jaquettes Lunii indisponibles/ },
    en: { verified: /Backup verified and exported/, missing: /cover/, 1: /1 unavailable Lunii cover is kept as a reference\./, 2: /2 unavailable Lunii covers are kept/, 1000000: /1000000 unavailable Lunii covers/ },
    it: { verified: /Backup verificato ed esportato/, missing: /copertin/, 1: /1 copertina Lunii non disponibile è conservata come riferimento\./, 2: /2 copertine Lunii non disponibili sono conservate/, 1000000: /1000000 copertine Lunii non disponibili/ },
  };
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    for (const missing of [undefined, 0, 1, 2, 1000000]) {
      const result = missing === undefined ? fixture.result : { ...fixture.result, missingLuniiImages: missing };
      const html = mountSurface(React.createElement(BackupExportSummary, { result })).html;
      assert.doesNotMatch(html, /catalogue:|undefined|\[object Object\]/);
      assert.match(html, expected[language].verified);
      if (!missing) assert.doesNotMatch(html, expected[language].missing, `${language} ${missing}`);
      else assert.match(html, expected[language][missing], `${language} ${missing}`);
    }
  }
});
