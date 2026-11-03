import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { runner } from './reactHookDriver.mjs';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { checkCatalogues, sourceHash } from './check-i18n.mjs';
import metadata from '../src/locales/_meta/home.json' with { type: 'json' };
import { presentStoredError, presentUserMessage } from '../src/i18n/userMessage.js';
register('./nodeSourceResolver.mjs', import.meta.url);
const { useProjectStore } = await import('../src/store/projectStore.js');
const { defaultMetadataForPacks, buildAggregateProject } = await import('../src/components/AggregatePacks/aggregateProject.js');
const { isFallbackProjectName, suggestProjectName } = await import('../src/store/projectSaveName.js');
const { stepCounterLabel } = await import('../src/components/funnels/funnelNavigation.js');
const { sanitizeProjectFolder, normalizeProjectStorage } = await import('../src/store/projectStorage.js');
const resources = createTestI18n().options.resources;
i18next.init({ lng: 'fr', resources, initAsync: false, keySeparator: false, interpolation: { escapeValue: false } });

const names = [
  ['fr', 'Menu racine', 'Message de fin', 'Mes histoires du soir', 'Projet sans titre', 'Nouvelle histoire'],
  ['en', 'Top menu', 'End message', 'My bedtime stories', 'Untitled project', 'New story'],
  ['it', 'Menu iniziale', 'Messaggio finale', 'Le mie storie della sera', 'Progetto senza titolo', 'Nuova storia'],
];
test('noms capturés à la création, noms auteur et rangement historiques inchangés, pas de dirty/undo au changement de langue', async () => {
  for (const [language, root, end, aggregate, untitled, story] of names) {
    await i18next.changeLanguage(language);
    const hook = runner(() => useProjectStore());
    try {
      let store = hook.render();
      store.setProjectType('pack'); store.markPristine(); store = hook.render();
      assert.equal(store.project.rootName, root); assert.equal(store.project.endNodeName, end);
      assert.equal(suggestProjectName({ projectName: '', rootName: '', projectType: 'pack' }), untitled);
      const metadata = defaultMetadataForPacks([], 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
      assert.equal(metadata.title, aggregate);
      const built = buildAggregateProject({ packs: [], metadata, rootAudio: '', rootImage: '' });
      const before = JSON.stringify(store.project); const undo = store.readHistoryMark();
      for (const next of ['fr', 'en', 'it']) {
        await i18next.changeLanguage(next); store = hook.render();
        assert.equal(JSON.stringify(store.project), before); assert.equal(store.readHistoryMark(), undo); assert.equal(store.isPristine(), true);
        assert.equal(metadata.title, aggregate); assert.equal(built.projectName, aggregate);
      }
      await i18next.changeLanguage(language); store.addStory(null, null); store = hook.render();
      assert.equal(store.project.rootEntries[0].name, story);
      for (const provisional of ['Nouveau projet', 'New project', 'Nuovo progetto', 'Projet sans titre', 'Untitled project', 'Progetto senza titolo']) assert.equal(isFallbackProjectName(provisional), true);
      assert.equal(isFallbackProjectName('Mon récit auteur'), false);
      assert.equal(suggestProjectName({ projectType: 'pack', rootName: root, projectName: 'Titre auteur' }), 'Titre auteur');
      assert.equal(sanitizeProjectFolder(''), 'Projet sans titre');
    } finally { hook.unmount(); }
  }
});

test('pluriels réels 0, 1, 2 et un million ; hash et mutation FR détectée sans filtre lexical', async () => {
  const catalogues = Object.fromEntries(['fr', 'en', 'it'].map((language) => [language, { home: resources[language].home }]));
  assert.deepEqual(checkCatalogues(catalogues, { home: metadata }).errors, []);
  for (const [key, value] of Object.entries(resources.fr.home)) {
    assert.equal(metadata[key].en?.sourceHash ?? metadata[key].it.sourceHash, sourceHash(value));
    assert.equal(metadata[key].en?.status ?? metadata[key].it.status, 'ai-reviewed');
  }
  const bases = [...new Set(Object.keys(resources.fr.home).filter((key) => key.endsWith('_one')).map((key) => key.slice(0, -4)))];
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    for (const count of [0, 1, 2, 1_000_000]) for (const base of bases) {
      const rendered = i18next.t(`home:${base}`, { count });
      assert.ok(rendered.includes(String(count)), `${language}/${base}/${count}`);
      assert.doesNotMatch(rendered, /home:|{{/);
      const category = new Intl.PluralRules(language).select(count);
      assert.equal(rendered, resources[language].home[`${base}_${category}`].replace('{{count}}', String(count)));
    }
  }
  for (const language of ['en', 'it']) {
    const mutated = structuredClone(catalogues);
    mutated[language].home['modeSelector.graph.description'] = mutated.fr.home['modeSelector.graph.description'];
    assert.ok(checkCatalogues(mutated, { home: metadata }).errors.some((error) => error.includes(`${language}/home:modeSelector.graph.description règle d’or`)));
  }
});

test('dialogue déjà stocké : causes IPC, paramètres et contexte traduits à chaud sans objet brut', async () => {
  const cause = { code: 'PACK_IDENTITY_UNREADABLE', params: { identity: 'id-author' }, detail: 'RAW_TOOL_DETAIL' };
  const stored = { userMessage: cause, suffix: { key: 'home:packName.uuid.refusalSuffix' } };
  const ignored = { userMessage: cause, prefix: { key: 'home:aggregate.packs.ignoredPrefix', params: { name: 'author.zip' } } };
  const copy = structuredClone(cause);
  const seen = [];
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const presented = presentUserMessage(cause);
    assert.equal(presented.code, 'PACK_IDENTITY_UNREADABLE'); assert.equal(presented.fallback, false);
    assert.equal(presented.technicalDetail, 'RAW_TOOL_DETAIL'); assert.ok(presented.message.includes('id-author'));
    const rendered = presentStoredError(stored); seen.push(rendered);
    assert.doesNotMatch(rendered, /\[object Object\]|home:|RAW_TOOL_DETAIL|PACK_IDENTITY_UNREADABLE/);
    assert.ok(presentStoredError(ignored).includes('author.zip'));
    assert.notEqual(presented.code, 'UNEXPECTED_ERROR');
    assert.equal(stepCounterLabel(1, 4), ['Étape 2 / 4', 'Step 2 / 4', 'Passaggio 2 / 4'][['fr', 'en', 'it'].indexOf(language)]);
  }
  assert.equal(new Set(seen).size, 3); assert.deepEqual(cause, copy);
});

test('une erreur de rangement déjà levée conserve son message dédié après FR → EN → IT', async () => {
  await i18next.changeLanguage('fr');
  let error;
  try { normalizeProjectStorage(null); } catch (cause) { error = cause; }
  assert.ok(error instanceof Error);
  assert.equal(error.key, 'home:project.storage.invalid'); assert.deepEqual(error.params, {});
  assert.equal(error.message, 'Descripteur de rangement du projet invalide.');
  for (const [language, expected] of [['fr', 'Descripteur de rangement du projet invalide.'], ['en', 'The project’s storage information is invalid.'], ['it', 'Le informazioni sulla cartella del progetto non sono valide.']]) {
    await i18next.changeLanguage(language);
    assert.equal(presentStoredError(error), expected);
    assert.equal(presentUserMessage(error).fallback, false);
    assert.doesNotMatch(presentStoredError(error), /unexpected|UNEXPECTED_ERROR|\[object Object\]/);
  }
});

test('changer la langue depuis l’accueil capture les noms au choix du mode, pas au montage', async () => {
  await i18next.changeLanguage('fr');
  const hook = runner(() => useProjectStore());
  try {
    let store = hook.render();
    const before = JSON.stringify(store.project);
    await i18next.changeLanguage('it'); store = hook.render();
    assert.equal(JSON.stringify(store.project), before);
    store.setProjectType('pack'); store = hook.render();
    assert.equal(store.project.rootName, 'Menu iniziale'); assert.equal(store.project.endNodeName, 'Messaggio finale');
    const historical = { ...store.project, projectType: null, rootName: 'Menu racine', endNodeName: 'Message de fin' };
    store.loadProject(historical); store = hook.render();
    await i18next.changeLanguage('en'); store.setProjectType('pack'); store = hook.render();
    assert.equal(store.project.rootName, 'Menu racine'); assert.equal(store.project.endNodeName, 'Message de fin');
  } finally { hook.unmount(); }
});

test('erreur IPC inconnue : phrase générique traduite et détail séparé, jamais le JSON brut', async () => {
  assert.equal(resources.fr.common['project.saveAs.fallbackLabel'], 'Enregistrer sous…');
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const unknown = { code: 'UNKNOWN_HOME_FIXTURE', params: {}, detail: 'RAW_TOOL_DETAIL' };
    const presented = presentUserMessage(unknown, { allowLegacyFrench: false });
    assert.equal(presented.code, 'UNKNOWN_HOME_FIXTURE'); assert.equal(presented.fallback, true);
    assert.equal(presented.technicalDetail, 'RAW_TOOL_DETAIL');
    const rendered = presentStoredError({ userMessage: unknown, codedOnly: true });
    assert.equal(rendered, resources[language].common['error.fallback.unexpected']);
    assert.doesNotMatch(rendered, /UNKNOWN_HOME_FIXTURE|RAW_TOOL_DETAIL|\[object Object\]/);
  }
});


test('catalogues home plats compatibles avec keySeparator false dans le runtime', async () => {
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    for (const [key, value] of Object.entries(resources[language].home)) {
      assert.equal(typeof value, 'string', `${language}/${key} doit être une entrée plate`);
      assert.equal(i18next.exists(`home:${key}`, { fallbackLng: false }), true, `${language}/${key} doit être résolu sans repli FR`);
    }
  }
});
