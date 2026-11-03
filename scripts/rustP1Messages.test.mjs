import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './fixtures/rust-p1-fr.json' with { type: 'json' };
import { createTestI18n } from './i18nTestSetup.mjs';
import { presentUserMessage } from '../src/i18n/userMessage.js';
// P1 neutral entries: protocol/symbol-only compositions, borrowed technical
// terms, and words legitimately shared by FR/EN or FR/IT (e.g. “origine”).
const NEUTRAL_CODES = new Set([
  'story-document-invalid', 'CONTROL_MEMBER_ABSENT', 'CONTROL_MEMBER_NULL', 'GENERATION_ASSET_DEDUPLICATED',
  'GENERATION_LOG_ARCHIVE_ISSUE', 'GENERATION_LOG_ARCHIVE_WARNING', 'GENERATION_LOG_ASSET_FAILED',
  'GENERATION_LOG_ASSET_READY', 'GENERATION_LOG_ASSET_START', 'GENERATION_LOG_AUDIO_WARNING',
  'GENERATION_LOG_GATE_NOT_OBSERVED', 'GENERATION_LOG_GATE_REASON', 'GENERATION_LOG_LINES',
  'GENERATION_LOG_MS', 'GENERATION_LOG_RESIZE_320X240', 'GENERATION_LOG_STAGING_ASSETS',
  'GENERATION_REFUSAL_GATE_REASON', 'LABEL_SOURCE_ORIGIN_VALUE', 'LABEL_NODE_ACTION', 'LABEL_NODE_MENU_KIND',
  'LABEL_NODE_STAGE', 'LABEL_NODE_STORY_KIND', 'LABEL_PROJECT_COLLECTION', 'LABEL_PROJECT_ELEMENT',
  'LABEL_PROJECT_PATH', 'VALIDATION_PROJECT_ERRORS', 'VALIDATION_PROJECT_FIELD_AUDIO',
  'VALIDATION_PROJECT_FIELD_IMAGE', 'VALIDATION_IMPORTED_ARCHIVE_INVALID',
]);
const engine = createTestI18n('fr');
for (const fixture of fixtures) {
  test(`P1 FR exact: ${fixture.code} (${fixture.source})`, () => {
    const result = presentUserMessage(fixture, { t: engine.t.bind(engine), language: 'fr' });
    assert.equal(result.fallback, false);
    assert.equal(result.message, fixture.expected);
  });
}


for (const language of ['en', 'it']) {
  const translated = createTestI18n(); await translated.changeLanguage(language);
  for (const fixture of fixtures) {
    test(`P1 règle d’or ${language}: ${fixture.code} (${fixture.source})`, () => {
      const shown = presentUserMessage(fixture, { t: translated.t.bind(translated), language });
      assert.equal(shown.fallback, false);
      assert.ok(!shown.message.includes('{{'));
      if (!NEUTRAL_CODES.has(fixture.code)) assert.notEqual(shown.message, presentUserMessage(fixture, { t: engine.t.bind(engine), language: 'fr' }).message);
    });
  }
}
