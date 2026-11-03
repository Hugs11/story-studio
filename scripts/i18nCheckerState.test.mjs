// Lot 4.9 — état du vérificateur : journal en direct, ligne de correction, notices
// et erreurs gardés comme références, relus dans la langue active (vrai hook).
import test from 'node:test';
import assert from 'node:assert/strict';
import i18next from 'i18next';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { presentUserMessage } from '../src/i18n/userMessage.js';
import fr from '../src/locales/fr/checker.json' with { type: 'json' };
import en from '../src/locales/en/checker.json' with { type: 'json' };
import it from '../src/locales/it/checker.json' with { type: 'json' };
const { useCommunityPackChecker } = await import('../src/components/CommunityPackChecker/useCommunityPackChecker.js');
const { formatTechnicalLog, formatDiagnosticJson } = await import('../src/components/CommunityPackChecker/communityPackExports.js');

i18next.init({ ...createTestI18n().options, lng: 'fr' });
const catalogues = { fr, en, it };
const envelope = { code: 'FILES_INVALID_LEVEL_MEASUREMENT', params: {}, detail: '_RAW_DETAIL_' };
const report = { packName: '_AUTHOR_PACK_', issues: [], audioItems: [], imageItems: [], technicalLog: ['_RAW_RUST_LINE_'] };

test('Vérificateur : journal, ligne de correction et notices suivent la langue, sans muter le rapport', async () => {
  let analyses = 0;
  const disk = await createDiskHarness({ commands: {
    analyze_community_pack: async () => { analyses += 1; return structuredClone(report); },
    create_fixed_community_pack: async () => ({ fixedZipPath: '/_AUTHOR_OUT_.zip', automaticCorrectionsApplied: 1, optionalAudioSilencesFixed: 1000000 }),
  } });
  try {
    await i18next.changeLanguage('fr');
    let checker;
    const hook = runner(() => { checker = useCommunityPackChecker(); });
    hook.render();
    await checker.analyzePath('/_AUTHOR_PACK_.zip'); hook.render();
    // Progression : « ... » → « … » (exception nominative du brief), FR sinon identique.
    assert.deepEqual(checker.liveLog, ['Analyse du pack demandée…', '_RAW_RUST_LINE_', 'Analyse terminée.']);
    await checker.fixPack(null, { outputDir: '/_AUTHOR_DIR_' }); hook.render();
    assert.equal(analyses, 2);
    assert.deepEqual(checker.liveLog, ['Correction du pack demandée…', 'ZIP corrigé créé : /_AUTHOR_OUT_.zip', 'Réanalyse automatique du ZIP corrigé…', 'Analyse du ZIP corrigé…', '_RAW_RUST_LINE_', 'Analyse terminée.']);
    const stored = JSON.stringify({ ...checker.report, technicalLog: checker.report.technicalLog.length });
    // Le presse-papiers absent du banc donne le chemin d'erreur, gardé en référence.
    await checker.copyLog(); hook.render();
    const seen = [];
    for (const language of ['fr', 'en', 'it']) {
      await i18next.changeLanguage(language); hook.render();
      const t = (key, params = {}) => catalogues[language][key].replace(/{{(\w+)}}/g, (_, name) => params[name]);
      const plural = (key, count) => catalogues[language][`${key}_${new Intl.PluralRules(language).select(count)}`].replace('{{count}}', count);
      const correction = t('log.fix.applied', { automatic: plural('log.fix.automaticCount', 1), optional: plural('log.fix.optionalCount', 1000000) });
      assert.equal(formatTechnicalLog(checker.report), `_RAW_RUST_LINE_\n${correction}`);
      assert.equal(JSON.parse(formatDiagnosticJson(checker.report)).technicalLog.at(-1), correction);
      assert.equal(checker.error, t('log.copy.failed'));
      assert.equal(checker.liveLog[1], t('log.fix.created', { path: '/_AUTHOR_OUT_.zip' }));
      assert.ok(checker.liveLog.every((line) => typeof line === 'string' && !line.includes('checker:') && !line.includes('[object Object]')));
      seen.push([formatTechnicalLog(checker.report), checker.error, checker.liveLog.join('\n')]);
    }
    assert.match(seen[0][0], /\[OK\] Correction appliquée : 1 automatique, 1000000 suggestions facultatives sélectionnées\./);
    for (let i = 0; i < 3; i++) { assert.notEqual(seen[0][i], seen[1][i]); assert.notEqual(seen[0][i], seen[2][i]); }
    assert.equal(JSON.stringify({ ...checker.report, technicalLog: checker.report.technicalLog.length }), stored, 'langue sans effet sur les données du rapport');
    hook.unmount();
  } finally { await disk.dispose(); await i18next.changeLanguage('fr'); }
});

test('Vérificateur : échec de correction présenté par code et paramètres, détail brut conservé', async () => {
  const disk = await createDiskHarness({ commands: {
    analyze_community_pack: async () => structuredClone(report),
    create_fixed_community_pack: async () => { throw envelope; },
  } });
  try {
    let checker;
    const hook = runner(() => { checker = useCommunityPackChecker(); });
    hook.render();
    await checker.analyzePath('/_AUTHOR_PACK_.zip'); hook.render();
    await checker.fixPack(null, { outputDir: '/_AUTHOR_DIR_' }); hook.render();
    for (const language of ['fr', 'en', 'it']) {
      await i18next.changeLanguage(language); hook.render();
      const shown = presentUserMessage(envelope);
      assert.equal(shown.code, envelope.code); assert.notEqual(shown.code, 'UNEXPECTED_ERROR'); assert.equal(shown.fallback, false);
      assert.equal(checker.error, shown.message);
      assert.equal(checker.technicalDetail, '_RAW_DETAIL_');
      assert.equal(checker.liveLog.at(-1), catalogues[language]['log.fix.interrupted'].replace('{{message}}', shown.message));
      assert.ok(!checker.liveLog.at(-1).includes('_RAW_DETAIL_'), 'détail brut replié, jamais dans la phrase');
    }
    hook.unmount();
  } finally { await disk.dispose(); await i18next.changeLanguage('fr'); }
});
