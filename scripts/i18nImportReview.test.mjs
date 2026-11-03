import test from 'node:test';
import assert from 'node:assert/strict';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { readProjectEnvelope } from '../src/store/projectModel/envelope.js';
import { decodeProjectFile, encodeProjectFile } from '../src/store/projectModel/codec.js';
import { presentUserMessage, presentStoredError, presentTechnicalMessage } from '../src/i18n/userMessage.js';
import { presentImportError } from '../src/components/EditPack/importErrorPresentation.js';
import { importPresentationError } from '../src/i18n/importPresentation.js';
import { youtubeImportFailure, youtubeImportFailureRef, youtubeBlockedNoticeRef } from '../src/utils/youtubeErrors.js';

const initialize = () => i18next.init(createTestI18n().options);
function caught(fn) { try { fn(); } catch (error) { return error; } assert.fail('a refusal is required'); }
const advanced = () => ({ schemaVersion: 4, authoringMode: 'advanced', projectType: 'advanced', rootEntries: [], authoring: { payload: '{}', mediaBindings: [] } });

test('revue 2 : refus de format, codes et paramètres non vides traduits sans fallback', async () => {
  initialize();
  const shape = caught(() => readProjectEnvelope(null, { fileName: 'Auteur.mbah' }));
  const contradictory = caught(() => readProjectEnvelope({ authoringMode: 'free', authoring: {} }));
  const invalidMode = caught(() => readProjectEnvelope({ authoringMode: { raw: 'evidence' } }));
  assert.equal(invalidMode.code, 'INVALID_AUTHORING_MODE');
  assert.equal(invalidMode.found, '{"raw":"evidence"}');
  const invalid = await decodeProjectFile('{', { fileName: 'Auteur.mbah' }).catch(e => e);
  assert.equal(shape.code, 'INVALID_PROJECT_SHAPE');
  assert.equal(shape.params.path, '/');
  assert.deepEqual(shape.params.expected, { key: 'import:format.value.jsonObject' });
  assert.equal(shape.found, 'object');
  assert.equal(shape.expected, 'objet JSON');
  // Attendu indépendant : ancienne phrase technique source, devenue refus public précis.
  assert.equal(presentUserMessage(shape).message, 'Auteur.mbah — / : trouvé object, attendu objet JSON (INVALID_PROJECT_SHAPE)');
  assert.equal(contradictory.code, 'CONTRADICTORY_PROJECT_ENVELOPE');
  assert.notEqual(contradictory.code, 'INVALID_PROJECT_JSON');
  assert.equal(invalid.code, 'INVALID_PROJECT_JSON');
  assert.deepEqual(invalid.params.expected, { key: 'import:format.value.completeJson' });
  const raw = advanced();
  const before = JSON.stringify(raw);
  const cause = { code: 'UNSUPPORTED_PAYLOAD_VERSION', params: { path: '/payloadVersion', found: '2', expected: '1' }, detail: 'RAW_VALIDATION' };
  const rejection = await decodeProjectFile(JSON.stringify(raw), { fileName: 'Auteur.mbah', validateAdvancedPayload: async () => { throw cause; } }).catch(e => e);
  assert.equal(rejection.code, cause.code);
  assert.equal(presentUserMessage(rejection).technicalDetail, 'RAW_VALIDATION');
  assert.equal(rejection.cause, cause);
  assert.equal(rejection.params.path, '/payloadVersion');
  assert.equal(rejection.params.found, '2');
  assert.equal(rejection.params.expected, '1');
  assert.notEqual(rejection.code, 'PAYLOAD_VALIDATION_FAILED');
  const retainedParams = JSON.stringify([shape.params, contradictory.params, invalid.params, rejection.params]);
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    for (const error of [shape, contradictory, invalid, rejection, invalidMode]) {
      const shown = presentUserMessage(error);
      assert.equal(shown.fallback, false, error.code);
      if (!error.cause) {
        assert.equal(shown.technicalDetail, shown.message);
        assert.equal(error.message, shown.message);
      }
      assert.equal(shown.code, error.code);
      assert.doesNotMatch(shown.message, /\[object Object\]|import:/);
    }
    if (language !== 'fr') assert.doesNotMatch(presentUserMessage(contradictory).message, /contenu avancé|bloc absent|trouvé|attendu/);
    assert.equal(JSON.stringify(raw), before);
    assert.equal(JSON.stringify([shape.params, contradictory.params, invalid.params, rejection.params]), retainedParams);
  }
  await i18next.changeLanguage('fr');
});

test('revue 4 : erreurs locales et causes imbriquées gardent refs/params et refusent les codes étrangers', async () => {
  initialize();
  const local = importPresentationError('import:project.file.exists', { name: 'Auteur.mbah' }, { code: 'IMPORT_PROJECT_FILE_EXISTS', detail: 'RAW_FS' });
  const changed = { key: 'import:media.follow.projectChanged', params: {} };
  const batchResult = { firstError: { code: 'blocked', params: {}, detail: 'RAW_YTDLP' }, firstErrorCode: 'blocked' };
  const batch = importPresentationError(youtubeImportFailureRef(batchResult, { key: 'import:youtube.import.failure' }), {}, { code: 'IMPORT_MEDIA_BATCH_FAILED', detail: 'RAW_YTDLP' });
  const snapshot = JSON.stringify([local.params, batch.presentationRef, batchResult]);
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    for (const error of [local, batch, changed]) {
      const presented = presentUserMessage(error);
      assert.equal(presented.fallback, false);
      assert.equal(presentImportError(error).message, presented.message);
      assert.doesNotMatch(presented.message, /RAW_FS|RAW_YTDLP|\[object Object\]|import:/);
    }
    assert.equal(local.params.name, 'Auteur.mbah');
    assert.equal(presentUserMessage(local).code, 'IMPORT_PROJECT_FILE_EXISTS');
    assert.notEqual(presentUserMessage(local).code, 'IMPORT_INVALID_ARCHIVE');
    assert.equal(batch.presentationRef.params.reason.userMessage.code, 'blocked');
    assert.deepEqual(batch.presentationRef.params.reason.userMessage.params, {});
    assert.equal(presentUserMessage(batch).technicalDetail, 'RAW_YTDLP');
    if (language !== 'fr') assert.doesNotMatch(presentStoredError(batch), /demande une vérification|n'a pu être importée/);
    // Même un appel hérité qui n'a gardé que le code réinterprète la cause par ce code.
    const legacy = youtubeImportFailure({ firstError: 'Une ancienne phrase française', firstErrorCode: 'blocked' }, i18next.t('import:youtube.import.failure'));
    assert.doesNotMatch(legacy, /Une ancienne phrase française/);
    assert.equal(JSON.stringify([local.params, batch.presentationRef, batchResult]), snapshot);
  }
  const invalidCode = presentUserMessage({ code: 'NOT_A_REAL_IMPORT_CODE', params: { name: 'Auteur' }, detail: 'RAW' });
  assert.equal(invalidCode.fallback, true);
  assert.notEqual(invalidCode.code, 'IMPORT_PROJECT_FILE_EXISTS');
  await i18next.changeLanguage('fr');
});

test('revue 3 : mêmes notices, recherche et lignes de sauvegarde relues à chaud', async () => {
  initialize();
  const notice = { parts: [{ key: 'import:pack.transitions.notice' }, { key: 'import:pack.autoNext.notice' }], separator: '\n\n' };
  const search = { key: 'import:youtube.search.progress', params: { page: 3 } };
  const lines = [{ key: 'import:project.save.progress' }, { key: 'import:project.media.copy', params: { done: 2, total: 7 } }, { key: 'import:project.save.done' }];
  const blocked = youtubeBlockedNoticeRef({ total: 3, imported: 1, skipped: 2, blocked: true });
  const signature = JSON.stringify([notice, search, lines, blocked]);
  const outputs = [];
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    outputs.push([presentStoredError(notice), presentTechnicalMessage(search), lines.map(line => presentStoredError(line)).join('|'), presentStoredError(blocked)]);
    assert.equal(JSON.stringify([notice, search, lines, blocked]), signature);
  }
  assert.equal(outputs[0][2], 'Enregistrement du projet…|Copie média 2/7|Projet enregistré');
  assert.equal(outputs[1][2], 'Saving the project…|Copying media 2/7|Project saved');
  assert.equal(outputs[2][2], 'Salvataggio del progetto…|Copia dei media 2/7|Progetto salvato');
  for (let i = 0; i < 4; i++) { assert.notEqual(outputs[0][i], outputs[1][i]); assert.notEqual(outputs[0][i], outputs[2][i]); }
  await i18next.changeLanguage('fr');
});

test('revue 2 : liaisons invalides, texte applicatif traduisible et données techniques conservées', async () => {
  initialize();
  const raw = advanced();
  raw.authoring.mediaBindings = [{ assetRef: 'a.mp3', path: null, status: 'resolved' }];
  const before = JSON.stringify(raw);
  const error = caught(() => readProjectEnvelope(raw));
  assert.equal(error.code, 'INVALID_MEDIA_BINDING');
  assert.equal(error.params.path, '/authoring/mediaBindings/0/status');
  assert.deepEqual(error.params.found, { key: 'import:format.value.resolvedWithoutPath' });
  assert.deepEqual(error.params.expected, { key: 'import:format.value.missingUntilKnown' });
  assert.equal(error.found, 'resolved sans chemin');
  for (const lang of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(lang);
    assert.equal(presentUserMessage(error).fallback, false);
    assert.doesNotMatch(presentUserMessage(error).message, /\[object Object\]/);
    if (lang !== 'fr') assert.doesNotMatch(presentUserMessage(error).message, /sans chemin|fichier est inconnu/);
    assert.equal(JSON.stringify(raw), before);
  }
  // L'écriture d'un projet valide ne dépend pas de la langue.
  raw.authoring.mediaBindings = [];
  const file = encodeProjectFile(raw);
  await i18next.changeLanguage('fr');
  assert.equal(encodeProjectFile(raw), file);
});

test('nouveaux libellés FR du codec/noms comparés aux sources git indépendantes de la base de revue', async () => {
  const { default: fixture } = await import('./fixtures/import-review-fr-sources.json', { with: { type: 'json' } });
  const { default: catalogue } = await import('../src/locales/fr/import.json', { with: { type: 'json' } });
  assert.equal(fixture.base, '4b853adffc0a439ec98ce9f123807f4c2e9d0b5b');
  const originals = Object.values(fixture.sources).join('\n');
  for (const [key, value] of Object.entries(catalogue)) {
    if (!key.startsWith('format.value.') || key === 'format.value.boundAt') continue;
    assert.ok(originals.includes(`'${value}'`), `${key} : source d’origine indépendante`);
  }
  assert.ok(fixture.sources['src/store/projectModel/envelope.js'].includes('${fileName} — ${path} : trouvé ${found}, attendu ${expected} (${code})'));
  assert.equal(catalogue['format.error.message'], '{{fileName}} — {{path}} : trouvé {{found}}, attendu {{expected}} ({{code}})');
  assert.ok(fixture.sources['src/store/projectModel/mediaBindings.js'].includes('`déjà lié en ${at(seenAssetRefs.get(binding.assetRef))}`'));
  assert.equal(catalogue['format.value.boundAt'], 'déjà lié en {{path}}');
  assert.ok(fixture.sources['src-tauri/src/commands/files.rs'].includes('"Dossier importé"'));
  assert.equal(catalogue['names.folder.fallback'], 'Dossier importé');
  assert.ok(fixture.sources['src-tauri/src/services/youtube/metadata.rs'].includes('"Vidéo"'));
  assert.equal(catalogue['names.video.fallback'], 'Vidéo');
});

test('revue complémentaire : diagnostics locaux homonymes et repli IPC imbriqué', async () => {
  await initialize();
  const cases = [
    { bindings: [{ assetRef: 'a.mp3', path: null, status: 'missing' }, { assetRef: 'a.mp3', path: null, status: 'missing' }], code: 'DUPLICATE_MEDIA_BINDING', path: '/authoring/mediaBindings/1/assetRef', found: 'déjà lié en /authoring/mediaBindings/0', expected: 'une liaison par référence' },
    { bindings: [{ assetRef: 'a.mp3', path: null, status: 'resolved' }], code: 'INVALID_MEDIA_BINDING', path: '/authoring/mediaBindings/0/status', found: 'resolved sans chemin', expected: 'missing tant que le fichier est inconnu' },
    { payload: 42, code: 'INVALID_AUTHORING_PAYLOAD', path: '/authoring/payload', found: 'number', expected: 'chaîne JSON opaque' },
  ];
  for (const item of cases) {
    const project = advanced();
    if (item.bindings) project.authoring.mediaBindings = item.bindings;
    if ('payload' in item) project.authoring.payload = item.payload;
    const snapshot = JSON.stringify(project);
    const error = caught(() => readProjectEnvelope(project, { fileName: 'Auteur.mbah' }));
    assert.equal(error.code, item.code);
    assert.equal(error.params.path, item.path);
    assert.equal(error.found, item.found);
    assert.equal(error.expected, item.expected);
    for (const language of ['fr', 'en', 'it']) {
      await i18next.changeLanguage(language);
      const shown = presentUserMessage(error);
      assert.equal(shown.fallback, false);
      assert.equal(shown.code, item.code);
      assert.ok(shown.message.includes(item.path));
      assert.equal(shown.technicalDetail, shown.message);
      assert.equal(error.message, shown.message);
      assert.doesNotMatch(shown.message, /référence de dialecte vide|empty dialect reference|riferimento di dialetto vuoto|erreur inattendue|unexpected error|errore imprevisto/);
      if (language === 'fr') assert.equal(shown.message, `Auteur.mbah — ${item.path} : trouvé ${item.found}, attendu ${item.expected} (${item.code})`);
      else {
        const labels = language === 'en'
          ? [['already bound at /authoring/mediaBindings/0', 'one binding per reference'], ['resolved without a path', 'missing until the file is known'], ['number', 'opaque JSON string']]
          : [['già associato in /authoring/mediaBindings/0', 'un’associazione per riferimento'], ['resolved senza percorso', 'missing finché il file non è noto'], ['number', 'stringa JSON opaca']];
        const [found, expected] = labels[cases.indexOf(item)];
        assert.equal(shown.message, language === 'en'
          ? `Auteur.mbah — ${item.path}: found ${found}, expected ${expected} (${item.code})`
          : `Auteur.mbah — ${item.path}: trovato ${found}, atteso ${expected} (${item.code})`);
      }
      assert.equal(JSON.stringify(project), snapshot);
    }
  }
  const cause = { code: 'DUPLICATE_MEDIA_BINDING', params: {}, detail: 'RAW' };
  const refusal = await decodeProjectFile(JSON.stringify(advanced()), { validateAdvancedPayload: async () => { throw cause; } }).catch(e => e);
  assert.equal(refusal.cause, cause);
  assert.equal(presentUserMessage(refusal).fallback, true);
  const composite = importPresentationError('import:pack.extraction.message', { reason: { userMessage: cause, codedOnly: true } });
  assert.equal(presentUserMessage(composite).fallback, true);
  const validCause = { code: 'DUPLICATE_MEDIA_BINDING', params: { assetRef: 'a.mp3' }, detail: 'RAW' };
  const validRefusal = await decodeProjectFile(JSON.stringify(advanced()), { validateAdvancedPayload: async () => { throw validCause; } }).catch(e => e);
  assert.equal(validRefusal.cause, validCause);
  assert.equal(validRefusal.presentationRef.userMessage, validCause);
  assert.deepEqual(validRefusal.presentationRef.userMessage.params, { assetRef: 'a.mp3' });
  assert.equal(presentUserMessage(validRefusal).fallback, false);
  assert.equal(presentUserMessage(validRefusal).message, presentUserMessage(validCause, { allowLegacyFrench: false }).message);
  await i18next.changeLanguage('fr');
});
