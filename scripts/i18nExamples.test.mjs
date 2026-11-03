import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { BASE, sources } from './i18nExamplesSourceFixture.mjs';
import { applyLot413 } from './i18nLot413Corrections.mjs';
import { checkCatalogues, EXAMPLES_NEUTRAL_KEYS, sourceHash } from './check-i18n.mjs';
import fr from '../src/locales/fr/examples.json' with { type: 'json' };
import en from '../src/locales/en/examples.json' with { type: 'json' };
import it from '../src/locales/it/examples.json' with { type: 'json' };
import meta from '../src/locales/_meta/examples.json' with { type: 'json' };
import { ADVANCED_EXAMPLES, createAdvancedExample } from '../src/store/advancedExamples/catalog.js';
import { exampleMediaPlan, exampleVoicePlan, generateExampleMedia, EXAMPLE_PIPER_VOICES } from '../src/store/advancedExamples/media.js';
import { exampleInsertionAnchor, initialRootUuid, prepareExampleInsertion } from '../src/store/advancedExamples/transaction.js';
import { presentStoredError, presentUserMessage } from '../src/i18n/userMessage.js';
import { exampleContentLanguage, exampleSpeechLanguage } from '../src/i18n/examplesPresentation.js';

i18next.init(createTestI18n().options);
const resources = { fr: { examples: fr }, en: { examples: en }, it: { examples: it } };
const IDS = ['garden-quiz', 'castle-quiz', 'grey-rabbit', 'lighthouse', 'explorer-train'];
const PLURAL = /_(one|many|other)$/;

// Les modules d'origine (BASE) sont importés tels quels depuis la fixture
// indépendante : aucune équivalence n'est déduite du nouveau catalogue.
async function originalModules() {
  const directory = await mkdtemp(join(tmpdir(), 'story-studio-examples-base-'));
  await mkdir(join(directory, 'advancedExamples'));
  for (const name of ['catalog', 'exampleBuilder', 'quizExamples', 'storyExamples', 'trainExample', 'media']) {
    await writeFile(join(directory, 'advancedExamples', `${name}.js`), sources[`src/store/advancedExamples/${name}.js`]);
  }
  const load = (name) => import(pathToFileURL(join(directory, 'advancedExamples', `${name}.js`)).href);
  return { catalog: await load('catalog'), media: await load('media'), close: () => rm(directory, { recursive: true, force: true }) };
}
const withoutPresentation = ({ language, titleKey, descriptionKey, ...example }) => {
  assert.ok(['fr', 'en', 'it', 'pseudo'].includes(language));
  assert.match(titleKey, /^examples:[a-z]+\.example\.title$/);
  assert.match(descriptionKey, /^examples:[a-z]+\.example\.description$/);
  return example;
};
// Topologie seule : identifiant, rangs, contrôles, positions, intentions médias.
const topology = (example) => ({
  id: example.id, entryRank: example.entryRank, transitions: example.transitions,
  stages: example.stages.map(({ name: _name, ...stage }) => stage),
  actions: example.actions.map(({ name: _name, ...action }) => action),
});
const names = (example) => [example.title, example.description, ...example.stages.map((s) => s.name), ...example.actions.map((a) => a.name)];

test('exemples : catalogues, métadonnées, formes neutres nominatives et fuite FR détectée par mutation', () => {
  assert.equal(BASE, '68a303312a393191f714b465232bf25dc4707876');
  assert.deepEqual(checkCatalogues(resources, { examples: meta }), { errors: [], warnings: [] });
  const bases = new Set(Object.keys(fr).map((key) => key.replace(PLURAL, '')));
  assert.equal(bases.size, 352);
  assert.equal(Object.keys(fr).length, 366);
  assert.equal(Object.keys(en).length, 359);
  assert.equal(Object.keys(it).length, 366);
  for (const language of ['en', 'it']) {
    const catalogue = resources[language].examples;
    for (const [key, value] of Object.entries(catalogue)) {
      assert.doesNotMatch(key, /_zero$/);
      assert.equal(meta[key][language].sourceHash, sourceHash(fr[key]));
      assert.equal(meta[key][language].status, 'ai-reviewed');
      if (EXAMPLES_NEUTRAL_KEYS[language].has(key)) assert.match(value, /^(?:\{\{\w+\}\}|[\s·.])+$/u, `${language}:${key} neutre = paramètres et ponctuation`);
      else assert.notEqual(value, fr[key], `${language}:${key}`);
    }
    // Vraie fuite FR (phrase de récit) : rejetée par le contrôle réel, sans filtre lexical.
    for (const key of ['garden.tunnels.question', 'dialog.voice.install', 'error.media.item']) {
      const mutated = structuredClone(resources);
      mutated[language].examples[key] = fr[key];
      assert.ok(checkCatalogues(mutated, { examples: meta }).errors.some((error) => error.includes(`${language}/examples:${key} règle d’or`)), key);
    }
  }
  for (const [key, entry] of Object.entries(meta)) {
    assert.ok(entry.context.length > 60, `${key} : contexte précis`);
    if (entry.maxLength !== undefined) assert.ok(Number.isInteger(entry.maxLength) && entry.maxLength > 0);
  }
  for (const key of ['menu.trigger.label', 'dialog.confirm.create', 'dialog.confirm.add', 'dialog.media.stop', 'dialog.voice.install', 'dialog.voice.skipAudio', 'dialog.images.label', 'dialog.audio.label']) {
    assert.ok(meta[key].maxLength > 0, `${key} : bouton ou libellé court borné`);
  }
});

test('exemples : pluriels CLDR 0, 1, 2 et 1 000 000 dans les trois langues, sans _zero', async () => {
  const families = [...new Set(Object.keys(fr).filter((key) => PLURAL.test(key)).map((key) => key.replace(PLURAL, '')))];
  assert.deepEqual(families.sort(), ['count.choiceLists.label', 'count.screens.label', 'dialog.audio.count', 'dialog.gaps.summary', 'dialog.images.count', 'dialog.result.audios', 'dialog.result.images']);
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const rules = new Intl.PluralRules(language);
    for (const family of families) {
      for (const count of [0, 1, 2, 1000000]) {
        const expected = resources[language].examples[`${family}_${rules.select(count)}`]
          .replaceAll('{{count}}', count).replaceAll('{{engine}}', 'Piper').replaceAll('{{withoutAudio}}', 3);
        assert.equal(i18next.t(`examples:${family}`, { count, engine: 'Piper', withoutAudio: 3 }), expected, `${language}:${family}:${count}`);
      }
    }
  }
  // CLDR : en français et en italien, 1 000 000 prend la forme « many », 0 la forme « one » en FR.
  assert.equal(new Intl.PluralRules('fr').select(0), 'one');
  assert.equal(new Intl.PluralRules('it').select(1000000), 'many');
  await i18next.changeLanguage('fr');
});

test('exemples FR : contenu, topologie et métadonnées identiques aux cinq exemples de BASE', async () => {
  const base = await originalModules();
  try {
    assert.deepEqual(ADVANCED_EXAMPLES.map(({ id }) => id), base.catalog.ADVANCED_EXAMPLES.map(({ id }) => id));
    for (const [rank, entry] of ADVANCED_EXAMPLES.entries()) {
      const original = base.catalog.ADVANCED_EXAMPLES[rank];
      for (const field of ['id', 'title', 'description', 'stageCount', 'actionCount']) assert.equal(entry[field], original[field], `${entry.id}.${field}`);
      const created = createAdvancedExample(entry.id, 'fr');
      assert.deepEqual(withoutPresentation(created), JSON.parse(applyLot413(JSON.stringify(base.catalog.createAdvancedExample(entry.id)))));
      assert.deepEqual(createAdvancedExample(entry.id), created, 'langue par défaut : français, comme avant');
      assert.equal(created.language, 'fr');
    }
    // Ancien et nouveau plan média identiques (le plan ne dépend que des intentions).
    for (const id of IDS) {
      assert.deepEqual(exampleMediaPlan(createAdvancedExample(id)), JSON.parse(applyLot413(JSON.stringify(base.media.exampleMediaPlan(base.catalog.createAdvancedExample(id))))));
    }
  } finally { await base.close(); }
});

test('exemples EN/IT : même topologie, noms entièrement traduits, contraintes des scénarios conservées', async () => {
  for (const id of IDS) {
    const source = createAdvancedExample(id, 'fr');
    for (const language of ['en', 'it']) {
      const example = createAdvancedExample(id, language);
      assert.equal(example.language, language);
      assert.deepEqual(topology(example), topology(source), `${id}/${language} : topologie identique`);
      assert.equal(example.titleKey, source.titleKey);
      const localized = names(example);
      names(source).forEach((name, rank) => assert.notEqual(localized[rank], name, `${id}/${language} : « ${name} » non traduit`));
      assert.equal(new Set(example.actions.map((action) => action.name)).size, example.actions.length, `${id}/${language} : listes uniques`);
      for (const node of [...example.stages, ...example.actions]) {
        assert.ok(node.name.trim().length > 0 && node.name.length <= 150, node.name);
        assert.doesNotMatch(node.name, /\{\{|\}\}|examples:|^(?:Stage|Action node|Écran|Screen|Schermata) \d+$/u);
      }
      assert.ok(example.stages[1].name.length <= 90, `${id}/${language} : menu court`);
      assert.notEqual(example.stages[1].name, example.stages[0].name);
    }
    // Un exemple déjà créé ne change jamais de langue : la langue globale est sans effet.
    const english = createAdvancedExample(id, 'en');
    const frozen = JSON.stringify(english);
    for (const language of ['it', 'fr']) await i18next.changeLanguage(language);
    assert.equal(JSON.stringify(english), frozen);
    assert.deepEqual(createAdvancedExample(id, 'en'), english, 'résolution indépendante de la langue de l’interface');
  }
  assert.equal(exampleContentLanguage('en-US'), 'en');
  assert.equal(exampleContentLanguage('de'), 'fr');
  assert.equal(exampleSpeechLanguage('pseudo'), 'fr');
  const pseudo = createAdvancedExample('garden-quiz', 'pseudo');
  assert.ok(pseudo.stages.every((stage) => stage.name.startsWith('[')));
  assert.deepEqual(topology(pseudo), topology(createAdvancedExample('garden-quiz')));
  await i18next.changeLanguage('fr');
});

test('exemples : métadonnées du menu relues dans la langue active, jamais figées au chargement', async () => {
  const garden = ADVANCED_EXAMPLES[0];
  const tables = JSON.stringify(ADVANCED_EXAMPLES.map(({ id, titleKey, descriptionKey, stageCount, actionCount }) => [id, titleKey, descriptionKey, stageCount, actionCount]));
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    assert.equal(garden.title, resources[language].examples['garden.example.title']);
    assert.equal(garden.description, resources[language].examples['garden.example.description']);
    assert.equal(JSON.stringify(ADVANCED_EXAMPLES.map(({ id, titleKey, descriptionKey, stageCount, actionCount }) => [id, titleKey, descriptionKey, stageCount, actionCount])), tables);
  }
  await i18next.changeLanguage('fr');
});

test('squelette : reconnu en FR/EN/IT et forme historique, titres provisoires remplacés, noms d’auteur conservés', async () => {
  const value = (v) => ({ presence: 'value', value: v });
  const root = (name) => ({ uuid: 'root', squareOne: value(true), name: value(name),
    controls: { presence: 'value', wheel: value(false), ok: value(true), home: value(false), pause: value(false), autoplay: value(false) },
    personalColor: null, audio: { presence: 'null' }, image: { presence: 'null' } });
  for (const name of ['Écran 1', 'Screen 1', 'Schermata 1', ' Screen 1 ']) assert.equal(initialRootUuid({ stages: [root(name)], actions: [] }), 'root', name);
  for (const name of ['Screen 2', 'Écran 1 bis', 'My first screen', 'Ecran 1']) assert.equal(initialRootUuid({ stages: [root(name)], actions: [] }), null, name);
  const example = createAdvancedExample('lighthouse', 'it');
  for (const [title, replaced] of [['New audiobook', true], ['Nuovo audiolibro', true], ['nouveau pack', true], ['', true], ['Il mio faro', false]]) {
    const calls = [];
    const outcome = await prepareExampleInsertion({ projectName: 'Nuovo progetto' }, example, {
      readView: async () => ({ stages: [root('Screen 1')], actions: [], metadata: { title: title ? value(title) : { presence: 'null' } } }),
      applyGesture: async (project, gesture) => {
        calls.push(gesture);
        return { project, report: gesture.gesture === 'paste-subgraph' ? { construction: { stages: example.stages.map((_, r) => `s${r}`), actions: example.actions.map((_, r) => `a${r}`) } } : {} };
      },
    });
    assert.equal(outcome.report.example.replacedInitialRoot, true);
    const metadata = calls.find((gesture) => gesture.gesture === 'set-document-metadata');
    if (replaced) {
      assert.deepEqual(metadata.update, { title: { form: 'set', value: example.title } });
      assert.equal(outcome.project.projectName, example.title);
    } else {
      assert.equal(metadata, undefined, 'un titre d’auteur n’est jamais réécrit');
      assert.equal(outcome.project.projectName, 'Il mio faro');
    }
    assert.ok(calls[0].subgraph.stages.every((stage, rank) => stage.name === example.stages[rank].name), 'noms écrits dans la langue capturée');
  }
});

test('refus de place : présenté par sa clé dans la langue courante, code et paramètres conservés', async () => {
  let refusal = null;
  try {
    exampleInsertionAnchor({ stages: [{ layout: { x: -32768, y: -32768 } }, { layout: { x: 32767, y: 32767 } }], actions: [] }, createAdvancedExample('garden-quiz'));
  } catch (error) { refusal = error; }
  assert.equal(refusal.code, 'EXAMPLE_POSITION_UNAVAILABLE');
  const base = sources['src/store/advancedExamples/transaction.js'];
  assert.ok(base.includes(`new Error('${fr['error.position.unavailable']}')`), 'FR identique à BASE');
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const presented = presentUserMessage(refusal, { language });
    assert.equal(presented.message, resources[language].examples['error.position.unavailable']);
    assert.equal(presented.fallback, false);
    assert.equal(presentStoredError(refusal), presented.message);
    assert.doesNotMatch(presented.message, /\[object Object\]|EXAMPLE_POSITION_UNAVAILABLE/);
  }
  await i18next.changeLanguage('fr');
});

test('médias : progression et erreurs en descripteurs, FR identique au module de BASE, EN/IT relus à la lecture', async () => {
  const base = await originalModules();
  try {
    const example = { stages: [
      { name: 'Le départ', mediaIntent: { image: true, audio: true } },
      { name: 'La forêt', mediaIntent: { image: true, audio: true } },
      { name: 'La rivière', mediaIntent: { image: true, audio: false } },
    ] };
    const run = async (module) => {
      const labels = [];
      let count = 0;
      const result = await module.generateExampleMedia({
        plan: module.exampleMediaPlan(example, ['a', 'b', 'c']), images: true, audios: true, isCurrent: () => true,
        onProgress: ({ label }) => labels.push(label),
        generateImage: async () => { count += 1; if (count === 1) throw new Error('Disque indisponible'); return count === 2 ? null : 'image.png'; },
        assignImage: async () => ({ status: 'refused' }),
        queueAudio: async ({ stageUuid }) => { if (stageUuid === 'b') throw { code: 'PIPER_GENERATION_TEXT_EMPTY', params: {}, detail: '_RAW_' }; },
      });
      return { labels, result };
    };
    const original = await run(base.media);
    const current = await run({ exampleMediaPlan, generateExampleMedia });
    assert.equal(current.result.errors.length, 4);
    assert.deepEqual(current.labels.map((label) => (label ? presentStoredError(label) : '')), original.labels);
    assert.deepEqual(current.result.errors.map((error) => presentStoredError(error)), original.result.errors.map((error) => presentStoredError(error)));
    assert.ok(current.labels.every((label) => label === null || label.key?.startsWith('examples:progress.')));
    for (const language of ['en', 'it']) {
      await i18next.changeLanguage(language);
      const presented = current.result.errors.map((error) => presentStoredError(error));
      assert.equal(presented[1], i18next.t('examples:error.media.item', { name: 'La forêt', error: i18next.t('examples:error.image.missing') }));
      assert.equal(presented[2], i18next.t('examples:error.media.item', { name: 'La rivière', error: i18next.t('examples:error.image.refused') }));
      for (const text of presented) assert.doesNotMatch(text, /\[object Object\]|Aucun fichier|ne peut plus recevoir| : |PIPER_|_RAW_/);
      assert.equal(presented[3], i18next.t('examples:error.media.item', { name: 'La forêt', error: i18next.t('rust:PIPER_GENERATION_TEXT_EMPTY') }));
      assert.equal(presentStoredError(current.labels[0]), i18next.t('examples:progress.image.item', { name: 'Le départ' }));
    }
  } finally { await base.close(); await i18next.changeLanguage('fr'); }
});

test('voix de l’exemple : langue capturée, voix compatible conservée, voix adaptée pour l’exemple seulement', () => {
  const piper = (piperVoice) => Object.freeze({ backend: 'piper', piperVoice });
  const catalogue = [
    { id: 'fr_FR-siwis-medium', language: 'fr_FR', installed: true },
    { id: 'en_GB-jenny_dioco-medium', language: 'en_GB', installed: true },
    { id: 'en_US-kristin-medium', language: 'en_US', installed: false },
    { id: 'it_IT-serena-medium', language: 'it_IT', installed: true },
  ];
  assert.deepEqual(EXAMPLE_PIPER_VOICES, { fr: 'fr_FR-siwis-medium', en: 'en_US-kristin-medium', it: 'it_IT-serena-medium' });
  assert.deepEqual(exampleVoicePlan({ settings: piper('fr_FR-siwis-medium'), language: 'fr', voices: catalogue }),
    { backend: 'piper', language: 'fr', voice: 'fr_FR-siwis-medium', adapted: false, status: 'ready' });
  assert.deepEqual(exampleVoicePlan({ settings: piper('en_GB-jenny_dioco-medium'), language: 'en', voices: catalogue }),
    { backend: 'piper', language: 'en', voice: 'en_GB-jenny_dioco-medium', adapted: false, status: 'ready' }, 'voix choisie de la bonne langue conservée');
  assert.deepEqual(exampleVoicePlan({ settings: piper('fr_FR-siwis-medium'), language: 'en', voices: catalogue }),
    { backend: 'piper', language: 'en', voice: 'en_US-kristin-medium', adapted: true, status: 'missing' });
  assert.deepEqual(exampleVoicePlan({ settings: piper('fr_FR-siwis-medium'), language: 'it', voices: catalogue }),
    { backend: 'piper', language: 'it', voice: 'it_IT-serena-medium', adapted: true, status: 'ready' });
  assert.equal(exampleVoicePlan({ settings: piper('it_IT-serena-medium'), language: 'fr', voices: catalogue }).voice, 'fr_FR-siwis-medium', 'défaut FR du catalogue');
  assert.equal(exampleVoicePlan({ settings: piper('fr_FR-siwis-medium'), language: 'en', voices: undefined }).status, 'checking');
  assert.equal(exampleVoicePlan({ settings: piper('fr_FR-siwis-medium'), language: 'en', voices: false }).status, 'missing', 'catalogue illisible : choix explicite requis');
  assert.equal(exampleVoicePlan({ settings: piper('fr_FR-siwis-medium'), language: 'en', voices: null }).status, 'ready', 'hors Tauri : rien à télécharger');
  assert.deepEqual(exampleVoicePlan({ settings: { backend: 'xtts', enabled: true, favoriteVoices: ['Mamie'] }, language: 'it', voices: catalogue }),
    { backend: 'xtts', language: 'it', voice: 'Mamie', adapted: false, status: 'ready' }, 'XTTS : langue de l’exemple, référence choisie');
  assert.equal(exampleVoicePlan({ settings: { backend: 'xtts', enabled: false }, language: 'en', voices: null }).status, 'unavailable', 'XTTS absent (macOS) : pas d’audio proposé');
  assert.equal(exampleVoicePlan({ settings: piper('fr_FR-siwis-medium'), language: 'pseudo', voices: catalogue }).language, 'fr');
});
