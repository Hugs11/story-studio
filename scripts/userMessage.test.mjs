import test from 'node:test';
import assert from 'node:assert/strict';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { presentUserMessage } from '../src/i18n/userMessage.js';
import { readsAsCancellation } from '../src/store/production/renderQueueWork.js';
import { presentImportError, isFreeEditorRefusal } from '../src/components/EditPack/importErrorPresentation.js';
import { issueHasMeasure, isAutomaticVolumeIssue } from '../src/components/CommunityPackChecker/packCheckerIssueClassification.js';
import { formatHtmlReport } from '../src/components/CommunityPackChecker/communityPackExports.js';
import { nextDefaultNodeName } from '../src/store/advancedAuthoring/defaultNodeNames.js';
import { STAGE_KIND, ACTION_KIND } from '../src/store/advancedGraphView/graphViewModel.js';

const engine = createTestI18n();
i18next.init(engine.options);

test('coded messages translate independently of detail and preserve the original French legacy message', () => {
  for (const language of ['fr', 'en', 'it']) {
    engine.changeLanguage(language);
    const present = (detail) => presentUserMessage({ code: 'GENERATION_CANCELLED', params: {}, detail }, { t: engine.t.bind(engine), language });
    assert.equal(present('Génération annulée.').message, present('Completely changed text').message);
    assert.equal(present('technical').technicalDetail, 'technical');
    assert.equal(present('technical').fallback, false);
  }
  assert.equal(presentUserMessage({ code: 'UNKNOWN_NODE', message: 'Phrase française exacte, autre variante.' }, { language: 'fr' }).message, 'Phrase française exacte, autre variante.');
  engine.changeLanguage('en');
  assert.equal(presentUserMessage({ code: 'INVALID_PAYLOAD_JSON', path: '/', found: 'x', expected: 'y' }, { t: engine.t.bind(engine), language: 'en' }).message, 'INVALID_PAYLOAD_JSON at /: found x, expected y');
});

test('Tauri events use the same presentation contract as command errors', () => {
  const message = { code: 'GENERATION_CANCELLED', params: {}, detail: 'Raw diagnostic' };
  const options = { t: engine.t.bind(engine), language: engine.resolvedLanguage };
  assert.deepEqual(presentUserMessage({ event: 'generate-log', id: 1, payload: message }, options), presentUserMessage(message, options));
});

test('unknown codes, free strings and missing parameters give a fallback and a separate detail; each fallback warns in development', () => {
  const warnings = [];
  for (const error of ['raw French', { code: 'FUTURE_CODE', params: {}, detail: 'raw' }, { code: 'UNKNOWN_NODE', params: {}, detail: 'missing params' }]) {
    const result = presentUserMessage(error, { t: engine.t.bind(engine), language: 'en', development: true, warn: (...args) => warnings.push(args) });
    assert.equal(result.message, 'An unexpected error occurred.');
    assert.equal(result.fallback, true);
    assert.ok(result.technicalDetail);
    assert.ok(!result.message.includes(result.technicalDetail));
  }
  assert.equal(warnings.length, 3);
});

test('render cancellation and menu refusal depend only on code, never French prose', () => {
  for (const detail of ['Génération annulée.', 'Text without any cancellation word']) {
    const error = { code: 'GENERATION_CANCELLED', params: {}, detail };
    assert.equal(readsAsCancellation(error), true);
    assert.equal(readsAsCancellation(JSON.stringify(error)), true);
  }
  assert.equal(readsAsCancellation({ code: 'OUTPUT_WRITE', detail: 'Génération annulée.' }), false);
  assert.equal(readsAsCancellation('Génération annulée.'), false);
  for (const detail of ['Pack non éditable dans Story Studio', 'Completely different text']) {
    const error = { code: 'PACK_NOT_EDITABLE', params: {}, detail };
    assert.equal(isFreeEditorRefusal(error), true);
    assert.match(presentImportError(error).message, /éditeur graphe/);
  }
  assert.equal(isFreeEditorRefusal('Pack non éditable dans Story Studio'), false);
});

test('each former import recognition is invariant when the diagnostic text changes', () => {
  for (const code of ['IMPORT_UNSUPPORTED_COMPRESSION', 'IMPORT_UNSUPPORTED_VARIANT', 'IMPORT_PASSWORD_REQUIRED', 'IMPORT_INVALID_ARCHIVE', 'IMPORT_MISSING_MEDIA', 'IMPORT_INCOMPLETE_CONTROLS']) {
    assert.equal(presentImportError({ code, params: {}, detail: 'French old detail' }).message,
      presentImportError({ code, params: {}, detail: 'No French keywords here' }).message);
  }
});

test('checker classifications and exported grouping are invariant under text changes', () => {
  const measures = { CHECKER_AUDIO_FORMAT: 'format', CHECKER_AUDIO_CHANNELS: 'format', CHECKER_AUDIO_SAMPLE_RATE: 'sampleRate', CHECKER_AUDIO_CLIPPED: 'peak', CHECKER_AUDIO_VOLUME: 'volume', CHECKER_AUDIO_NEAR_MUTE: 'volume', audioLeadingSilenceTooShort: 'silenceStart', audioTrailingSilenceTooShort: 'silenceEnd', audioLeadingSilenceLong: 'silenceStart', audioTrailingSilenceLong: 'silenceEnd', CHECKER_IMAGE_FORMAT: 'imageFormat', CHECKER_IMAGE_DIMENSIONS: 'dimensions', CHECKER_IMAGE_FORMAT_DIMENSIONS: 'dimensions' };
  for (const [code, key] of Object.entries(measures)) {
    const category = key.startsWith('image') || key === 'dimensions' ? 'image' : 'audio';
    const issue = { code, category, severity: 'warning', message: 'format volume silence début fin saturation dimensions', filePath: 'assets/a', label: 'A', autoFixAvailable: true, fixDisposition: 'automatic' };
    const changed = { ...issue, message: 'Entirely different prose', technicalDetails: 'Different details', autoFixDescription: 'Changed' };
    assert.equal(issueHasMeasure(issue, key), true);
    assert.equal(issueHasMeasure(changed, key), true);
    assert.equal(issueHasMeasure({ ...changed, category: 'structure' }, key), false);
    const report = (row) => ({ issues: [row], audioItems: [], imageItems: [], technicalLog: [], verdict: 'needsFix' });
    // Group headings and summary counts are stable even though the displayed detail changes.
    const groups = (html) => [...html.matchAll(/class="group group--[^"]+/g)].map((m) => m[0]);
    assert.deepEqual(groups(formatHtmlReport(report(issue))), groups(formatHtmlReport(report(changed))));
  }
  assert.equal(isAutomaticVolumeIssue({ category: 'audio', code: 'CHECKER_AUDIO_NEAR_MUTE', message: 'Unrelated words', autoFixAvailable: true }), true);
});

test('automatic numbering combines FR/EN/IT and historical forms independent of current language', async () => {
  const index = { entries: [
    ...['Écran 2', 'Ecran 3', 'Stage 4', 'Screen 5', 'Schermata 6', 'Schermata 99 bis'].map((value) => ({ kind: STAGE_KIND, node: { name: { presence: 'value', value } } })),
    ...['Liste 2', 'Action 3', 'Action node 4', 'List 5', 'Choice list 6', 'Lista 7'].map((value) => ({ kind: ACTION_KIND, node: { name: { presence: 'value', value } } })),
  ] };
  for (const [language, stage, action] of [['fr', 'Écran 9', 'Liste 9'], ['en', 'Screen 9', 'List 9'], ['it', 'Schermata 9', 'Lista 9']]) {
    await i18next.changeLanguage(language);
    assert.equal(nextDefaultNodeName(index, STAGE_KIND, ['Schermata 8']), stage);
    assert.equal(nextDefaultNodeName(index, ACTION_KIND, ['Lista 8']), action);
  }
  await i18next.changeLanguage('fr');
});


test('le pont français conserve le détail des erreurs sans code dédié', () => {
  const detail = 'Erreur française historique : transfert interrompu';
  for (const value of [detail, { code: 'UNEXPECTED_ERROR', params: {}, detail }, JSON.stringify({ code: 'UNEXPECTED_ERROR', params: {}, detail })]) {
    const presented = presentUserMessage(value, { language: 'fr' });
    assert.equal(presented.message, detail);
    assert.equal(presented.technicalDetail, detail);
  }
  assert.equal(presentUserMessage({ code: 'INCONNU', detail }, { language: 'fr' }).fallback, true);
});
