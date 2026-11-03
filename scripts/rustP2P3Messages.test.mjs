import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import fixtures from './fixtures/rust-p2-p3-fr.json' with { type: 'json' };
import { createTestI18n } from './i18nTestSetup.mjs';
import { presentUserMessage } from '../src/i18n/userMessage.js';

// Protocol lines, external output, numeric progress, or the shared English
// technical label “Thumbnail” have deliberately identical text in a language.
const NEUTRAL_CODES = new Set([
  'COMFYUI_HISTORY_HTTP_ERROR', 'COMFYUI_UPLOAD_HTTP_ERROR', 'COMFYUI_VIEW_HTTP_ERROR',
  'XTTS_GET_HEALTH_TIMEOUT_S', 'XTTS_GET_TIMEOUT_10S', 'XTTS_POST_TTS_TIMEOUT_300S',
  'UI_MESSAGE_PARTS', 'TOOL_PROCESS_OUTPUT', 'COMFYUI_PROGRESS_STEPS', 'COMFYUI_PROGRESS_COMPLETE',
  'CHECKER_LOG_ERROR', 'LABEL_PROJECT_THUMBNAIL',
]);
const french = createTestI18n();
await french.changeLanguage('fr');
const frenchOptions = { t: french.t.bind(french), language: 'fr' };
function assertTranslated(fixture, shown) {
  if (!NEUTRAL_CODES.has(fixture.code)) assert.notEqual(shown, presentUserMessage(fixture, frenchOptions).message, fixture.code);
}

for (const language of ['fr', 'en', 'it']) {
  const engine = createTestI18n();
  await engine.changeLanguage(language);
  const options = { t: engine.t.bind(engine), language };
  for (const fixture of fixtures) {
    test(`P2/P3 ${language}: ${fixture.code} (${fixture.source})`, () => {
      const shown = presentUserMessage(fixture, options);
      assert.equal(shown.fallback, false);
      assert.ok(!shown.message.includes('{{'), shown.message);
      if (language === 'fr') assert.equal(shown.message, fixture.expected);
      else assertTranslated(fixture, shown.message);
    });
  }
  test(`P2/P3 composition de libellés et sortie externe (${language})`, () => {
    const outer = fixtures.find((fixture) => fixture.code === 'PIPER_DOWNLOAD_STARTED');
    assert.ok(outer);
    const label = fixtures.find((fixture) => fixture.code === 'PIPER_VOICE_CONFIG_LABEL');
    const message = { ...outer, params: { service: label } };
    const shown = presentUserMessage(message, options);
    assert.equal(shown.fallback, false);
    assert.ok(shown.message.includes(presentUserMessage(label, options).message));
    assert.ok(!shown.message.includes('{"code"'));
    const raw = 'ERROR: ffmpeg /tmp/Épisode français.wav';
    const composed = { code: 'UI_MESSAGE_PARTS', params: { parts: { messages: [message, raw], separator: '\n', data: true } } };
    assert.equal(presentUserMessage(composed, options).message, `${shown.message}\n${raw}`);
  });
}

test('les fixtures P2/P3 couvrent toutes les nouvelles clés du registre', async () => {
  const codes = await readFile(new URL('../src-tauri/src/support/user_message/codes.rs', import.meta.url), 'utf8');
  const catalogue = JSON.parse(await readFile(new URL('../src/locales/_meta/rust.json', import.meta.url), 'utf8'));
  const covered = new Set(fixtures.map(({ code }) => code));
  for (const [code, meta] of Object.entries(catalogue)) {
    if (/_(one|many|other)$/.test(code)) continue;
    if (!/^(?:FILES|PIPER|XTTS|YOUTUBE|COMFYUI|PODCAST|PACK_READER|COMMUNITY_PACK_CHECKER) >/.test(meta.context)) continue;
    assert.ok(covered.has(code), code);
    assert.ok(codes.includes(`"${code}"`), code);
  }
});


test('la règle d’or rejette toute fixture non neutre laissée en français', () => {
  for (const fixture of fixtures) {
    if (NEUTRAL_CODES.has(fixture.code)) continue;
    assert.throws(() => assertTranslated(fixture, presentUserMessage(fixture, frenchOptions).message), { code: 'ERR_ASSERTION' });
  }
});

test('libellé MessageLabel : le rendu anglais complet aurait refusé le Deref français', async () => {
  const fixture = fixtures.find((item) => item.source.includes('régression de Deref'));
  const engine = createTestI18n(); await engine.changeLanguage('en');
  const options = { t: engine.t.bind(engine), language: 'en' };
  const shown = presentUserMessage(fixture, options).message;
  const label = presentUserMessage(fixture.params.label, options).message;
  assert.ok(label.includes('Story'));
  assert.ok(shown.startsWith(label));
  assert.ok(!shown.includes('Histoire'));
  const before = presentUserMessage({ ...fixture, params: { ...fixture.params, label: 'Histoire / Loup : audio' } }, options).message;
  assert.throws(() => assert.equal(before, shown), { code: 'ERR_ASSERTION' });
});
