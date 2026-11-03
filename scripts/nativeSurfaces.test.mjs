import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';
import { RELEASE_NOTES, shouldShowReleaseNotes } from '../src/config/releaseNotes.js';

const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const pickers = {
  pickImage: 'image', pickSdReferenceImage: 'referenceImage', pickAudio: 'audio',
  pickZip: 'archive', pickMultipleZip: 'archives', pickMultipleAudioOrZip: 'audioArchive',
  pickMultipleMediaFiles: 'media', pickComfyWorkflowApiJson: 'comfyApi',
  pickComfyWorkflowConfigJson: 'comfyConfig', pickFolder: 'folder',
};
// Termes techniques neutres autorisés, précisément par clé et par langue.
const neutral = { en: ['file.image.filterLabel', 'file.audio.filterLabel', 'file.comfyApi.filterLabel'], it: ['file.audio.filterLabel'] };

async function checkPickers(module) {
  const captures = [];
  const disk = await createDiskHarness({ commands: { 'plugin:dialog|open': args => {
    captures.push(args.options); return null;
  } } });
  try {
    const baseline = new Map();
    for (const language of ['fr', 'en', 'it']) {
      await i18next.changeLanguage(language);
      for (const [name, key] of Object.entries(pickers)) {
        await module[name]();
        const options = captures.at(-1);
        assert.equal(options.title, i18next.t(`native:file.${key}.title`), `${language} ${name} title`);
        if (key === 'folder') assert.equal(options.filters, undefined);
        else {
          const filterKey = `file.${key}.filterLabel`;
          assert.equal(options.filters[0].name, i18next.t(`native:${filterKey}`));
          if (language !== 'fr' && !neutral[language].includes(filterKey)) {
            assert.notEqual(options.filters[0].name, baseline.get(name).filters[0].name);
          }
        }
        if (language === 'fr') baseline.set(name, options);
        else {
          assert.notEqual(options.title, baseline.get(name).title);
          assert.deepEqual(options.filters?.map(f => f.extensions), baseline.get(name).filters?.map(f => f.extensions));
          assert.equal(options.defaultPath, baseline.get(name).defaultPath);
        }
      }
    }
    // Helpers de persistance sans dialogue : donnée d’auteur inchangée.
    module.saveLastExportDir('/Auteur/Été');
    assert.equal(module.getLastExportDir(), '/Auteur/Été');
    module.saveLastExportDir(null);
    assert.equal(module.getLastExportDir(), '/Auteur/Été');
  } finally { await disk.dispose(); }
}

test('tous les pickers : titres et filtres FR → EN → IT au moment de chaque appel', async () => {
  await i18next.init(createTestI18n().options);
  await checkPickers(await import('../src/hooks/useFileDialog.js'));
});

test('mutation : un titre français figé est détecté en anglais', async () => {
  await i18next.init(createTestI18n().options);
  let source = await readFile(new URL('../src/hooks/useFileDialog.js', import.meta.url), 'utf8');
  source = source.replace("t('native:file.image.title')", "'Choisir une image'")
    .replace('@tauri-apps/plugin-dialog', import.meta.resolve('@tauri-apps/plugin-dialog'))
    .replace('../i18n/importPresentation.js', new URL('../src/i18n/importPresentation.js', import.meta.url).href)
    .replace('../store/persistentSettings', new URL('../src/store/persistentSettings.js', import.meta.url).href);
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  await assert.rejects(checkPickers(mutant), /en pickImage title/);
});

test('NSIS et macOS : options présentes dans le schéma local, MSI par défaut', async () => {
  const config = await json('../src-tauri/tauri.conf.json');
  const schema = await json('../node_modules/@tauri-apps/cli/config.schema.json');
  assert.deepEqual(config.bundle.windows.nsis.languages, ['English', 'French', 'Italian']);
  assert.equal(config.bundle.windows.nsis.displayLanguageSelector, false);
  assert.equal(schema.definitions.NsisConfig.properties.languages.items.type, 'string');
  assert.equal(schema.definitions.NsisConfig.properties.displayLanguageSelector.type, 'boolean');
  assert.equal(schema.definitions.MacConfig.properties.files.additionalProperties.type, 'string');
  assert.equal(config.bundle.windows.wix, undefined);
  const windows = await json('../src-tauri/tauri.windows.conf.json');
  assert.equal(windows.bundle.windows?.wix, undefined);
});

test('InfoPlist.strings UTF-8 : syntaxe, parité et destinations Contents/Resources', async () => {
  const config = await json('../src-tauri/tauri.conf.json');
  const plist = await readFile(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8');
  assert.match(plist, /<key>CFBundleDevelopmentRegion<\/key>\s*<string>en<\/string>/);
  assert.match(plist, /<key>CFBundleLocalizations<\/key>\s*<array>\s*<string>en<\/string>\s*<string>fr<\/string>\s*<string>it<\/string>\s*<\/array>/);
  const expected = {
    en: 'Story Studio uses the microphone only to record stories at your request.',
    fr: 'Story Studio utilise le microphone uniquement pour enregistrer les histoires demandées par l’utilisateur.',
    it: 'Story Studio usa il microfono solo per registrare storie su tua richiesta.',
  };
  const files = {};
  for (const language of ['en', 'fr', 'it']) {
    const path = `macos/${language}.lproj/InfoPlist.strings`;
    files[`Resources/${language}.lproj/InfoPlist.strings`] = path;
    const bytes = await readFile(new URL(`../src-tauri/${path}`, import.meta.url));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.match(text, /^"NSMicrophoneUsageDescription"\s*=\s*"(?:[^"\\]|\\["\\])*";\s*$/);
    assert.equal(text.trim(), `"NSMicrophoneUsageDescription" = "${expected[language]}";`);
  }
  assert.deepEqual(config.bundle.macOS.files, files);
  assert.match(plist, new RegExp(`<key>NSMicrophoneUsageDescription</key>\\s*<string>${expected.en}</string>`));
});

test('notes : toutes les références ont trois traductions et un contexte ; pas d’historique EN/IT', async () => {
  const keys = [...RELEASE_NOTES.highlights.flat(), ...RELEASE_NOTES.fixes.flat(), ...RELEASE_NOTES.chores.flat()];
  const meta = await json('../src/locales/_meta/common.json');
  for (const language of ['fr', 'en', 'it']) {
    const catalogue = await json(`../src/locales/${language}/common.json`);
    for (const reference of keys) {
      const key = reference.replace(/^common:/, '');
      assert.ok(catalogue[key], `${language} ${key}`);
      assert.ok(meta[key]?.context, key);
    }
    assert.equal(shouldShowReleaseNotes('0.9.8', null, language), false);
    assert.equal(shouldShowReleaseNotes(RELEASE_NOTES.version, null, language), true);
    assert.equal(shouldShowReleaseNotes(RELEASE_NOTES.version, RELEASE_NOTES.version, language), false);
  }
  // Les notes embarquées sont désormais celles de la bêta, pas celles de 0.9.9.
  assert.equal(shouldShowReleaseNotes('0.9.9', null, 'fr'), false);
  for (const language of ['en', 'en-US', 'it', 'it-IT']) {
    assert.equal(shouldShowReleaseNotes(RELEASE_NOTES.version, null, language), true);
    assert.equal(shouldShowReleaseNotes('0.9.9', null, language), false);
    await i18next.changeLanguage(language);
    assert.equal(shouldShowReleaseNotes(RELEASE_NOTES.version, null), true);
    assert.equal(shouldShowReleaseNotes('0.9.9', null), false);
  }
  assert.equal(RELEASE_NOTES.changelogUrl, 'https://github.com/Hugs11/story-studio/blob/main/CHANGELOG.md');
});
