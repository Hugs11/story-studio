import test from 'node:test';
import assert from 'node:assert/strict';
import i18n from 'i18next';
import { PUBLIC_LANGUAGES, DEV_LANGUAGES, AVAILABLE_LANGUAGES, resolveLanguage, loadLanguage, changeUiLanguage, getIntlLocale, updateDocumentLanguage } from '../src/i18n/language.js';
import { KEYS, hasExistingSettings, runSettingsMigrations } from '../src/store/persistentSettings.js';
import { pseudoText, pseudoResources } from '../src/i18n/pseudo.js';
import { createTestI18n } from './i18nTestSetup.mjs';

for (const language of ['fr', 'en', 'it']) {
  test(`préférence valide ${language} prioritaire`, () => {
    assert.equal(resolveLanguage({ preference: language, systemLanguage: 'de', languages: DEV_LANGUAGES }), language);
  });
}
for (const preference of [null, '', 'de', 'EN', 'pseudo', 'toString', 'constructor']) {
  test(`préférence invalide ${preference} sur installation existante → français`, () => {
    assert.equal(resolveLanguage({ preference, existingInstallation: true, systemLanguage: 'it-IT' }), 'fr');
  });
}
for (const [systemLanguage, expected] of [['fr-FR', 'fr'], ['en-US', 'en'], ['it-IT', 'it'], ['de-DE', 'en'], [undefined, 'en'], ['', 'en'], ['xx', 'en']]) {
  test(`nouvelle installation ${systemLanguage} → ${expected}`, () => {
    assert.equal(resolveLanguage({ preference: 'invalide', systemLanguage, languages: DEV_LANGUAGES }), expected);
  });
}

test('production : seules les langues publiques sont résolues', () => {
  assert.equal(resolveLanguage({ systemLanguage: 'en-US' }), 'en');
  assert.equal(resolveLanguage({ preference: 'it', systemLanguage: 'it-IT' }), 'it');
  assert.equal(resolveLanguage({ preference: 'en' }), 'en');
});

test('une ouverture publique à en conserve la détection système et la priorité des préférences', () => {
  const languages = ['fr', 'en'];
  assert.equal(resolveLanguage({ languages, systemLanguage: 'en-US' }), 'en');
  assert.equal(resolveLanguage({ languages, preference: 'en', existingInstallation: true }), 'en');
  assert.equal(resolveLanguage({ languages, systemLanguage: 'en-US', existingInstallation: true }), 'fr');
});

test('détecter la présence des réglages avant les migrations et changer à chaud sans autre écriture', async () => {
  const oldStorage = globalThis.localStorage;
  const oldDocument = globalThis.document;
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  globalThis.document = { documentElement: { lang: '' } };
  i18n.init({ lng: 'fr', initAsync: false, resources: {} });
  i18n.on('languageChanged', updateDocumentLanguage);
  try {
    assert.equal(hasExistingSettings(), false);
    assert.deepEqual(AVAILABLE_LANGUAGES, PUBLIC_LANGUAGES);
    assert.equal(loadLanguage('en-US'), 'en');
    assert.equal(values.get(KEYS.UI_LANGUAGE), 'en');
    values.clear();
    assert.equal(loadLanguage('it-IT'), 'it');
    assert.equal(values.get(KEYS.UI_LANGUAGE), 'it');
    values.set(KEYS.UI_LANGUAGE, 'it');
    assert.equal(loadLanguage('en-US'), 'it');
    assert.equal(values.get(KEYS.UI_LANGUAGE), 'it');
    await changeUiLanguage('en');
    assert.equal(i18n.language, 'en');
    assert.equal(values.get(KEYS.UI_LANGUAGE), 'en');
    await changeUiLanguage('it');
    assert.equal(i18n.language, 'it');
    assert.equal(values.get(KEYS.UI_LANGUAGE), 'it');
    values.clear();
    values.set('unknown', '1');
    assert.equal(hasExistingSettings(), false);
    runSettingsMigrations();
    assert.equal(hasExistingSettings(), true);
    const before = new Map(values);
    for (const [language, locale] of [['fr', 'fr-FR'], ['en', 'en-US'], ['it', 'it-IT']]) {
      await changeUiLanguage(language);
      assert.equal(loadLanguage(), language);
      assert.equal(i18n.language, language);
      assert.equal(getIntlLocale(), locale);
      assert.equal(document.documentElement.lang, language);
    }
    values.delete(KEYS.UI_LANGUAGE);
    assert.deepEqual(values, before);
    await changeUiLanguage('pseudo'); // Indisponible hors du développement Vite.
    assert.equal(i18n.language, 'en');
    assert.equal(values.has(KEYS.UI_LANGUAGE), false);
    updateDocumentLanguage('pseudo');
    assert.equal(document.documentElement.lang, 'fr');
  } finally {
    globalThis.localStorage = oldStorage;
    globalThis.document = oldDocument;
    i18n.off('languageChanged', updateDocumentLanguage);
  }
});

test('instances de test synchrones et isolées', async () => {
  const first = createTestI18n(), second = createTestI18n();
  assert.equal(first.isInitialized, true);
  await first.changeLanguage('it');
  assert.equal(second.language, 'fr');
});

for (const [language, labels] of [
  ['fr', ['langue disponible', 'langue disponible', 'langues disponibles', 'langues disponibles']],
  ['en', ['languages available', 'language available', 'languages available', 'languages available']],
  ['it', ['lingue disponibili', 'lingua disponibile', 'lingue disponibili', 'di lingue disponibili']],
]) {
  test(`pluriels réels ${language} : 0, 1, 2, 1 000 000`, async () => {
    const instance = createTestI18n();
    await instance.changeLanguage(language);
    [0, 1, 2, 1_000_000].forEach((count, index) => {
      assert.equal(instance.t('settings:interface.language.availableCount', { count }), `${count} ${labels[index]}`);
    });
  });
}

test('pseudo-locale accentuée, allongée et encadrée ; tokens intacts', () => {
  const source = 'Modifier les raccourcis';
  const result = pseudoText(source);
  assert.match(result, /^\[.*\]$/);
  assert.match(result, /ï/);
  assert.ok(result.length >= source.length * 1.35);
  assert.match(pseudoText('<strong>{{name}}</strong>'), /<strong>{{name}}<\/strong>/);
  assert.deepEqual(pseudoResources({ common: { label: 'Modifier' } }), { common: { label: pseudoText('Modifier') } });
});

for (const [name, preference, existingInstallation, systemLanguage, expected, persisted] of [
  ['neuve EN', null, false, 'en-GB', 'en', 'en'],
  ['neuve IT', null, false, 'it-IT', 'it', 'it'],
  ['neuve DE', null, false, 'de-DE', 'en', 'en'],
  ['existante sans préférence', null, true, 'en-GB', 'fr', 'fr'],
  ['existante avec préférence EN', 'en', true, 'it-IT', 'en', null],
  ['préférence invalide', 'invalid', true, 'en-GB', 'fr', 'fr'],
  ['préférence pseudo', 'pseudo', true, 'it-IT', 'fr', 'fr'],
]) {
  test(`ouverture FR/EN/IT : ${name}, résolution et persistance`, () => {
    const languages = ['fr', 'en', 'it'];
    const writes = [];
    const settings = {
      read: (key) => { assert.ok([KEYS.UI_LANGUAGE, KEYS.UI_LANGUAGE_ANNOUNCEMENT].includes(key)); return key === KEYS.UI_LANGUAGE ? preference : null; },
      hasExistingSettings: () => existingInstallation,
      write: (key, value) => writes.push([key, value]),
    };
    assert.equal(resolveLanguage({ preference, existingInstallation, systemLanguage, languages }), expected);
    assert.equal(loadLanguage(systemLanguage, { languages, settings }), expected);
    assert.deepEqual(writes, persisted === null ? [] : [...(existingInstallation ? [[KEYS.UI_LANGUAGE_ANNOUNCEMENT, 'pending']] : []), [KEYS.UI_LANGUAGE, persisted]]);
  });
}

test('un repli anglais ne mémorise pas une détection exclue par la liste injectée', () => {
  const writes = [];
  const settings = { read: () => null, hasExistingSettings: () => false, write: (...args) => writes.push(args) };
  assert.equal(loadLanguage('en-GB', { languages: ['fr'], settings }), 'en');
  assert.deepEqual(writes, []);
});
