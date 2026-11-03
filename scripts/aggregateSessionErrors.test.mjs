import test from 'node:test';
import assert from 'node:assert/strict';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { presentUserMessage } from '../src/i18n/userMessage.js';
import errors from './fixtures/catalogue/session-errors.json' with { type: 'json' };
const engine = createTestI18n();
await i18next.init({...engine.options, resources:engine.options.resources});
for (const language of ['fr','en','it']) {
  test(`${language}: session marker and registry errors have translated messages and separate technical causes`, async () => {
    await i18next.changeLanguage(language);
    for (const error of errors) {
      const presented = presentUserMessage(JSON.stringify(error));
      assert.equal(presented.message, i18next.t(`rust:${error.code}`, { error: error.params.error }));
      assert.ok(presented.technicalDetail.includes(error.detail));
      assert.doesNotMatch(presented.message, /\[object Object\]|rust:|FILES_SESSION_/);
    }
  });
}
