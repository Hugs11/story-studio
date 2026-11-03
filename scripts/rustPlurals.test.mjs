import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import registry from '../src/locales/_generated/rust-messages.json' with { type: 'json' };
import fr from '../src/locales/fr/rust.json' with { type: 'json' };
import en from '../src/locales/en/rust.json' with { type: 'json' };
import it from '../src/locales/it/rust.json' with { type: 'json' };
import p1 from './fixtures/rust-p1-fr.json' with { type: 'json' };
import p23 from './fixtures/rust-p2-p3-fr.json' with { type: 'json' };
import { presentUserMessage } from '../src/i18n/userMessage.js';
import { createTestI18n } from './i18nTestSetup.mjs';
import { checkCatalogues, sourceHash } from './check-i18n.mjs';

for (const language of ['fr', 'en', 'it']) {
  const engine = createTestI18n(); await engine.changeLanguage(language);
  const catalogue = { fr, en, it }[language];
  for (const entry of registry.filter(({ plural }) => plural)) {
    test(`Rust ${entry.code} : 0, 1, 2, million (${language})`, () => {
      const fixture = [...p1, ...p23].find(({ code }) => code === entry.code);
      assert.ok(fixture, `fixture manquante : ${entry.code}`);
      for (const count of [0, 1, 2, 1_000_000]) {
        const category = new Intl.PluralRules(language).select(count);
        let called;
        const result = presentUserMessage({ ...fixture, params: { ...fixture.params, [entry.plural]: String(count) } }, {
          language, t: (key, options) => { if (key === `rust:${entry.code}`) called = options; return engine.t(key, options); },
        });
        assert.equal(result.fallback, false);
        assert.equal(called.count, count);
        assert.ok(!result.message.includes('{{'));
        assert.ok(catalogue[`${entry.code}_${category}`]);
        assert.ok(!Object.hasOwn(catalogue, entry.code));
        if (language !== 'fr') assert.notEqual(catalogue[`${entry.code}_${category}`], fr[`${entry.code}_${category}`]);
      }
    });
  }
  test(`comptes indépendants et paramètre ordinal (${language})`, () => {
    const options = { language, t: engine.t.bind(engine) };
    const counts = presentUserMessage({ code: 'CHECKER_REPORT_READY_SUMMARY', params: { errorCount: 1, warningCount: 2, correctionCount: 1_000_000 } }, options).message;
    assert.equal(counts, { fr: 'Rapport prêt : 1 erreur, 2 avertissements, 1000000 corrections.', en: 'Report ready: 1 error, 2 warnings, 1000000 fixes.', it: 'Rapporto pronto: 1 errore, 2 avvertimenti, 1000000 di correzioni.' }[language]);
    const ordinal = presentUserMessage({ code: 'OPTION_ORDINAL_OUT_OF_RANGE', params: { action_id: 'A', count: 2, ordinal: 3, bound: 1 } }, options).message;
    assert.equal(ordinal, { fr: "L'ActionNode « A » porte 2 options : le rang 3 n'est pas adressable (maximum 1).", en: 'Choice list “A” has 2 choices. Position 3 can’t be selected (maximum 1).', it: 'La lista di scelte «A» contiene 2 scelte. La posizione 3 non è selezionabile (massimo 1).' }[language]);
  });
  test(`libellés techniques et composition YouTube (${language})`, () => {
    const options = { language, t: engine.t.bind(engine) };
    for (const [code, name, values] of [
      ['AUDIO_NOT_MONO', 'mode', ['stereo', 'joint stereo', 'dual channel']],
      ['CHECKER_VERDICT_CALCULATED_LOG', 'verdict', ['Valid', 'ValidWithWarnings', 'NeedsFix', 'Invalid']],
      ['CHECKER_AUDIO_SUGGESTION_STALE', 'requestedEdge', ['Leading', 'Trailing']],
      ['IMPORT_ARCHIVE_FILE_SIZE_LIMIT', 'kind', ['Asset', 'Thumbnail']],
      ['EXPORT_INTEROPERABILITY_DIMENSIONS_COUNT', 'readiness_interoperability', ['Supported', 'Prepared', 'Untested']],
      ['LABEL_SOURCE_ORIGIN_VALUE', 'payload_context_pack_identity_origin', ['SquareOneStage', 'FsEntryStage', 'RequiresGeneration', 'Generated']],
    ]) {
      const entry = registry.find((entry) => entry.code === code);
      for (const value of values) {
        const params = Object.fromEntries(entry.params.map((param) => [param, param === name ? value : 2]));
        const shown = presentUserMessage({ code, params }, options);
        assert.equal(shown.fallback, false);
        if (language === 'fr') assert.ok(!shown.message.includes(value), shown.message);
      }
    }
    const raw = 'ERROR: yt-dlp /tmp/Épisode.mp3';
    const message = presentUserMessage({ code: 'YOUTUBE_FAILURE_CONTEXT_DETAIL', params: { context: { code: 'YOUTUBE_DOWNLOAD_IMPOSSIBLE', params: {} }, output: raw } }, options);
    assert.equal(message.message, engine.t('rust:YOUTUBE_DOWNLOAD_IMPOSSIBLE') + (language === 'fr' ? ' : ' : ': ') + raw);
    const voice = presentUserMessage({ code: 'PIPER_DOWNLOAD_STARTED', params: { service: { code: 'LABEL_PIPER_VOICE_DOWNLOAD', params: {} } } }, options);
    assert.equal(voice.fallback, false);
    if (language !== 'fr') assert.ok(!voice.message.includes('de la voix'));
  });
}

function catalogueFixture() {
  const resources = { fr: { rust: { COUNT_one: '{{n}} entrée', COUNT_many: '{{n}} entrées', COUNT_other: '{{n}} entrées' } }, en: { rust: { COUNT_one: '{{n}} item', COUNT_other: '{{n}} items' } }, it: { rust: { COUNT_one: '{{n}} elemento', COUNT_many: '{{n}} elementi', COUNT_other: '{{n}} elementi' } } };
  const metadata = { rust: Object.fromEntries(Object.entries(resources.fr.rust).map(([key, source]) => [key, { context: 'Test pluriel Rust', ...Object.fromEntries(['en', 'it'].filter((language) => key in resources[language].rust).map((language) => [language, { status: 'ai', sourceHash: sourceHash(source) }])) }])) };
  return { resources, metadata, messages: [{ code: 'COUNT', params: ['n'], plural: 'n' }] };
}
test('check-i18n refuse formes absentes, clé simple, formes non déclarées, paramètre invalide et français cible', () => {
  const valid = catalogueFixture(); assert.deepEqual(checkCatalogues(valid.resources, valid.metadata, valid.messages).errors, []);
  for (const [mutate, expected] of [
    [(r) => delete r.it.rust.COUNT_many, /pluriel absent/],
    [(r) => r.en.rust.COUNT = '{{n}} item', /clé simple résiduelle/],
    [(_r, m) => delete m[0].plural, /pluriel non déclaré/],
    [(_r, m) => m[0].plural = 'unknown', /pluriel invalide/],
    [(r) => r.en.rust.COUNT_one = r.fr.rust.COUNT_one, /règle d’or/],
    [(r) => r.en.rust.COUNT_many = r.fr.rust.COUNT_many, /règle d’or/],
  ]) {
    const { resources, metadata, messages } = catalogueFixture(); mutate(resources, messages);
    assert.match(checkCatalogues(resources, metadata, messages).errors.join('\n'), expected);
  }
});
test('une fixture explicite pour chaque forme française du registre', () => {
  for (const { code, plural } of registry) if (plural) for (const category of ['one', 'many', 'other']) {
    assert.ok([...p1, ...p23].some((fixture) => fixture.code === code && fixture.source.endsWith(`forme ${category}`)), `${code}_${category}`);
  }
});
test('Piper transporte un libellé traduit et YouTube utilise un gabarit traduit', async () => {
  const piper = await readFile(new URL('../src-tauri/src/services/piper/provision.rs', import.meta.url), 'utf8');
  const youtube = await readFile(new URL('../src-tauri/src/services/youtube/error.rs', import.meta.url), 'utf8');
  assert.ok(piper.includes('codes::LABEL_PIPER_VOICE_DOWNLOAD'));
  assert.ok(!piper.includes('"de la voix"'));
  assert.ok(youtube.includes('codes::YOUTUBE_FAILURE_CONTEXT_DETAIL'));
  assert.ok(!youtube.includes('" : "'));
});


test('diagnostic importé : le nombre est dérivé des valeurs typées sans analyser ni modifier le texte historique', async () => {
  const engine = createTestI18n();
  const diagnostic = { code: 'duplicate-root-key-last-wins', params: {}, discarded: ['old', 'older'], retained: 'new', message: 'historical detail' };
  const snapshot = JSON.stringify(diagnostic);
  for (const [language, expected] of [
    ['fr', 'Clé racine dupliquée : dernière valeur retenue ("new"), 2 valeurs écartées ("old", "older").'],
    ['en', 'Duplicate top-level key: the last value was kept ("new"); 2 values were discarded ("old", "older").'],
    ['it', 'Chiave di primo livello duplicata: mantenuto l’ultimo valore ("new"), 2 valori scartati ("old", "older").'],
  ]) {
    await engine.changeLanguage(language);
    const shown = presentUserMessage(diagnostic, { t: engine.t.bind(engine), language });
    assert.equal(shown.fallback, false);
    assert.equal(shown.message, expected);
    assert.equal(JSON.stringify(diagnostic), snapshot);
  }
});
