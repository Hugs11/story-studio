import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'espree';
import i18next from 'i18next';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { presentUserMessage, presentTechnicalMessage, presentStoredError, userMessageTransport } from '../src/i18n/userMessage.js';
import { presentCheckerReport } from '../src/i18n/checkerMessages.js';
import { presentImportWarning } from '../src/i18n/importWarnings.js';
const { useXttsJobs } = await import('../src/hooks/useXttsJobs.js');
const { useCommunityPackChecker } = await import('../src/components/CommunityPackChecker/useCommunityPackChecker.js');
const { formatTechnicalLog, formatReadableReport, formatHtmlReport, formatDiagnosticJson } = await import('../src/components/CommunityPackChecker/communityPackExports.js');
const resources = createTestI18n().options.resources;
i18next.init({ lng: 'fr', resources, initAsync: false, keySeparator: false, interpolation: { escapeValue: false } });
const envelope = { code: 'FILES_INVALID_LEVEL_MEASUREMENT', params: {}, detail: 'mesure de niveau invalide' };
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const surfaces = [
  'src/tabs/EmulatorTab/FlatSimulator.jsx', 'src/App.jsx', 'src/components/SDQueuePanel/SDQueuePanel.jsx', 'src/hooks/useSDJobs.js', 'src/hooks/useProjectLoading.js',
  'src/hooks/useMediaSubscriptions.js', 'src/hooks/useProjectLifecycle.js', 'src/hooks/useSessionMediaTriage.js',
  'src/hooks/useWorkSession.js', 'src/hooks/useAppPreferences.js', 'src/hooks/useSaveProgress.js',
  'src/hooks/useImportSession.js', 'src/store/projectIO.js', 'src/store/mediaLibrary.js',
  'src/store/advancedExamples/media.js', 'src/utils/youtubeErrors.js',
  'src/tabs/OptionsTab/AiImagesSection.jsx', 'src/tabs/OptionsTab/YoutubeSection.jsx',
  'src/tabs/OptionsTab/usePiperVoiceOptions.js', 'src/tabs/OptionsTab/useXttsVoiceOptions.js',
  'src/components/AudioEditorModal/AudioEditorModal.jsx', 'src/components/MediaExplorer/MediaExplorerImpl.jsx',
  'src/components/GenerateVoiceModal/GenerateVoiceModal.jsx', 'src/components/PodcastImport/PodcastImportFunnel.jsx',
  'src/components/PodcastImport/PodcastImportModal.jsx', 'src/components/SDGenerateModal/SDGenerateModal.jsx',
  'src/components/YoutubeImport/YoutubeImportFunnel.jsx', 'src/components/RecordModal/RecordModal.jsx',
  'src/components/AudioAssemblyModal/AudioAssemblyModal.jsx', 'src/components/AudioSplitterModal/AudioSplitterModal.jsx',
  'src/components/AggregatePacks/AggregatePacksFunnel.jsx', 'src/components/CommunityPackChecker/useCommunityPackChecker.js',
];
function visit(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (node.type) fn(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach((item) => visit(item, fn));
    else if (child && typeof child === 'object') visit(child, fn);
  }
}

for (const language of ['fr', 'en', 'it']) {
  test(`P2/P3 toutes les expressions de présentation des surfaces concernées (${language})`, async () => {
    await i18next.changeLanguage(language);
    const expected = presentUserMessage(envelope).message;
    for (const path of surfaces) {
      const source = await read(path);
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } });
      let checked = 0;
      visit(ast, (node) => {
        if (node.type === 'ObjectExpression' && node.properties.some((property) => property.key?.name === 'userMessage' && property.value.type === 'Identifier')) {
          const variable = node.properties.find((property) => property.key?.name === 'userMessage').value.name;
          // Context fragments and author paths are stable data. Execute the
          // original value retained by this producer through the same renderer.
          const stored = { userMessage: envelope };
          assert.equal(presentStoredError(stored), expected, `${path}: ${variable}`);
          checked++;
        }
        if (node.type === 'CallExpression' && node.callee.name === 'showErrorDialog') {
          const message = node.arguments[0]?.properties?.find((property) => property.key?.name === 'message')?.value;
          if (message?.type === 'Identifier') {
            const retained = new Function(message.name, `return (${source.slice(message.start, message.end)});`)(envelope);
            assert.equal(presentStoredError(retained), expected, path);
            checked++;
          }
        }
        if (node.type !== 'CallExpression' || !['presentUserMessage', 'presentStoredError', 'userMessageTransport'].includes(node.callee.name) || node.arguments.length !== 1) return;
        const arg = node.arguments[0];
        // Execute the actual source expression with a typed error injected at
        // the boundary; JSX components don't require mounting media tools.
        if (arg.type !== 'Identifier' && !(arg.type === 'MemberExpression' && arg.object.type === 'Identifier' && !arg.computed)) return;
        const variable = arg.type === 'Identifier' ? arg.name : arg.object.name;
        const field = arg.type === 'MemberExpression' ? arg.property.name : null;
        const expression = source.slice(node.start, node.end);
        const run = new Function(variable, node.callee.name, `return (${expression})${node.callee.name === 'presentUserMessage' ? '.message' : ''};`);
        for (const value of [envelope, JSON.stringify(envelope)]) {
          const helpers = { presentUserMessage, presentStoredError, userMessageTransport };
          assert.equal(presentStoredError(run(field ? { [field]: value } : value, helpers[node.callee.name])), expected, path);
        }
        checked++;
      });
      assert.ok(checked > 0, `no error presentation exercised: ${path}`);
      assert.doesNotMatch(source, /(?:setError|setImportError|message:)[^\n]*\$\{(?:e|err|error)\}/, path);
    }
  });
  test(`Piper et XTTS : véritable catch de la file de jobs (${language})`, async () => {
    await i18next.changeLanguage(language);
    const expected = presentUserMessage(envelope).message;
    for (const backend of ['piper', 'xtts']) {
      const disk = await createDiskHarness({ commands: { [`${backend}_generate_audio`]: async () => { throw envelope; } } });
      try {
        const updates = [];
        const hook = runner(() => useXttsJobs({ jobs: [{ id: 'job', status: 'pending', settings: { backend }, request: {} }], updateJob: (id, fields) => updates.push({ id, ...fields }) }, () => assert.fail('generation refused')));
        hook.render(); hook.flush(); await new Promise((resolve) => setImmediate(resolve));
        assert.equal(updates.at(-1).status, 'error');
        assert.equal(updates.at(-1).errorMessage, JSON.stringify(envelope));
        assert.equal(presentUserMessage(updates.at(-1).errorMessage).message, expected);
        hook.unmount();
      } finally { await disk.dispose(); }
    }
  });
  test(`checker : rapport, journal, exports et données d'auteur (${language})`, async () => {
    await i18next.changeLanguage(language);
    const expected = presentUserMessage(envelope).message;
    const raw = 'ERROR yt-dlp: /tmp/Épisode français.wav';
    const report = { issues: [{ category: 'audio', code: 'CHECKER_AUDIO_VOLUME', severity: 'warning', label: 'Mon histoire française', message: JSON.stringify(envelope), fixDisposition: 'none' }], audioItems: [], imageItems: [], technicalLog: [envelope, raw], structure: {}, summary: {}, verdict: 'invalid' };
    const shown = presentCheckerReport(report);
    assert.equal(shown.issues[0].message, expected);
    assert.equal(shown.issues[0].label, report.issues[0].label);
    assert.equal(shown.issues[0].code, report.issues[0].code);
    assert.deepEqual(shown.technicalLog, [expected, raw]);
    assert.deepEqual(report.technicalLog, [envelope, raw], 'presentation never mutates stored values');
    for (const render of [formatTechnicalLog, formatReadableReport, formatHtmlReport, formatDiagnosticJson]) {
      const output = render(report);
      assert.ok(output.includes(expected), render.name);
      assert.ok(!output.includes('{"code"'), render.name);
    }
    let finishAnalysis;
    const pendingReport = new Promise((resolve) => { finishAnalysis = resolve; });
    const disk = await createDiskHarness({ commands: { analyze_community_pack: async () => pendingReport, 'plugin:event|listen': () => 1, 'plugin:event|unlisten': () => null } });
    const previousTransform = window.__TAURI_INTERNALS__.transformCallback;
    const previousPlugin = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
    let listener;
    window.__TAURI_INTERNALS__.transformCallback = (callback) => { listener = callback; return 1; };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    try {
      let checker; const hook = runner(() => { checker = useCommunityPackChecker(); }); hook.render(); hook.flush();
      const pending = checker.analyzePath('/pack.zip'); hook.render(); hook.flush();
      listener({ payload: envelope }); hook.render();
      assert.equal(checker.liveLog.at(-1), expected);
      finishAnalysis(report); await pending; hook.render();
      assert.equal(checker.report.issues[0].message, expected);
      hook.unmount();
      window.__TAURI_INTERNALS__.transformCallback = previousTransform;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = previousPlugin;
    } finally { await disk.dispose(); }
  });
  test(`avertissements persistés : présentation sans changer les données (${language})`, async () => {
    await i18next.changeLanguage(language);
    const warning = { entryName: 'Mon histoire', field: 'returnAfterPlay', targetStageId: 'fin', targetStageName: 'Ma fin', message: 'Mon histoire — destination de retour apres lecture vers « Ma fin » non modelisee.' };
    const snapshot = JSON.stringify(warning);
    const output = presentImportWarning(warning);
    if (language === 'fr') assert.equal(output, 'Mon histoire — destination de retour après lecture vers « Ma fin » non modélisée.');
    else assert.ok(!output.includes('destination de retour apres lecture'));
    assert.ok(output.includes('Mon histoire')); assert.ok(output.includes('Ma fin'));
    assert.equal(JSON.stringify(warning), snapshot);
    assert.equal(presentTechnicalMessage('donnée auteur française'), 'donnée auteur française');
  });
}

for (const [path, event] of [
  ['src/components/GenerateVoiceModal/GenerateVoiceModal.jsx', 'piper-log'],
  ['src/tabs/OptionsTab/usePiperVoiceOptions.js', 'piper-log'],
  ['src/tabs/OptionsTab/useXttsVoiceOptions.js', 'xtts-log'],
  ['src/components/YoutubeImport/YoutubeImportFunnel.jsx', 'youtube-log'],
  ['src/tabs/OptionsTab/YoutubeSection.jsx', 'youtube-log'],
  ['src/hooks/useSDJobs.js', 'comfyui-progress'],
]) {
  test(`${event} : le véritable callback conserve l'enveloppe pour un rendu dans la langue active (${path})`, async () => {
    const source = await read(path);
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } });
    let callback;
    visit(ast, (node) => {
      if (node.type === 'CallExpression' && node.callee.name === 'listen' && node.arguments[0]?.value === event) callback = node.arguments[1];
    });
    assert.ok(callback, path);
    let stored;
    const setter = (value) => { stored = typeof value === 'function' ? value({ state: 'loading' }) : value; };
    const context = { cancelled: false, disposed: false, setStatusMessage: setter, setLogMessage: setter,
      setPiperProvision: setter, setYtDlpUpdate: setter, setXttsLogs: (value) => { stored = value([]).at(-1); }, sdStore: { updateJob: (_id, fields) => { stored = fields.progressLabel; } }, logger: { warn() { assert.fail('no progress error'); } } };
    const run = new Function(...Object.keys(context), `return (${source.slice(callback.start, callback.end)});`)(...Object.values(context));
    run({ payload: event === 'comfyui-progress' ? { jobId: 'job', progress: 0.5, progressLabel: JSON.stringify(envelope) } : envelope });
    const value = stored?.message ?? stored;
    assert.deepEqual(value, event === 'comfyui-progress' ? JSON.stringify(envelope) : envelope);
    for (const language of ['fr', 'en', 'it']) {
      await i18next.changeLanguage(language);
      assert.equal(presentTechnicalMessage(value), presentUserMessage(envelope).message);
    }
  });
}

test('import : les raisons codées gardent le refus historique et un détail lisible', async () => {
  const { presentImportError } = await import('../src/components/EditPack/importErrorPresentation.js');
  await i18next.changeLanguage('fr');
  const reason = JSON.stringify(envelope);
  const shown = presentImportError({ code: 'IMPORT_INCOMPLETE_CONTROLS', params: {}, detail: reason });
  assert.equal(shown.message, presentUserMessage({ code: 'IMPORT_INCOMPLETE_CONTROLS', params: {} }).message);
  assert.equal(shown.technicalDetail, envelope.detail);
  assert.ok(!shown.technicalDetail.includes('{"code"'));
});

test('import : l’enveloppe IPC est affichée puis retirée des avertissements persistés', async () => {
  const { useProjectStore } = await import('../src/store/projectStore.js');
  const { useImportSession } = await import('../src/hooks/useImportSession.js');
  const { buildProjectIndex } = await import('../src/store/projectModel.js');
  await i18next.changeLanguage('fr');
  const warning = { entryId: 'story', entryName: 'Mon histoire', field: 'returnAfterPlay', targetStageId: 'end', targetStageName: 'Ma fin',
    message: 'Mon histoire — destination de retour apres lecture vers « Ma fin » non modelisee.',
    userMessage: { code: 'IMPORT_TRANSITION_UNMODELED_WITH_TARGET', params: { label: 'Mon histoire', detail: { code: 'IMPORT_LABEL_AFTER_PLAY', params: {} }, target: 'Ma fin' } } };
  const disk = await createDiskHarness({ commands: { unpack_zip_to_entries: async () => ({ rootId: 'root', advancedTransitionsDetected: true, entries: [{ id: 'story', type: 'story', name: 'Mon histoire' }], unresolvedTransitions: [warning] }) } });
  try {
    let store; let imports; let notice;
    const hook = runner(() => {
      store = useProjectStore();
      imports = useImportSession({ store, projectIndex: buildProjectIndex(store.project), workspaceDirRef: { current: disk.workspace }, sessionModeRef: { current: 'project' },
        setUnpacking() {}, setImporting() {}, setImportNotice: (value) => { notice = value; }, showErrorDialog: (error) => assert.fail(error.message) });
    });
    hook.render(); store.addZip(null, '/source/pack.zip', 'Pack'); hook.render();
    const zip = [...buildProjectIndex(store.project).entryById.values()].find((entry) => entry.type === 'zip');
    await imports.handleUnpackZip(zip.id); hook.render();
    assert.ok(presentStoredError(notice).includes('Mon histoire — destination de retour après lecture vers « Ma fin » non modélisée.'));
    assert.equal(store.project.importWarnings[0].message, warning.message);
    assert.equal(Object.hasOwn(store.project.importWarnings[0], 'userMessage'), false);
    hook.unmount();
  } finally { await disk.dispose(); }
});

test('avertissements historiques : données conservées, accents et guillemets corrigés au rendu FR', async () => {
  await i18next.changeLanguage('fr');
  for (const [warning, expected] of [
    [{ entryName: '', field: 'returnAfterPlay', targetStageId: null, message: 'Entree importee — destination de retour apres lecture non modelisee.' }, 'Entrée importée — destination de retour après lecture non modélisée.'],
    [{ entryName: '', field: 'returnAfterPlay', targetStageId: null, message: ' — destination de retour apres lecture non modelisee.' }, ' — destination de retour après lecture non modélisée.'],
    [{ entryName: 'Mon histoire', field: 'returnAfterPlay', targetStageId: '', message: 'Mon histoire — destination de retour apres lecture vers «  » non modelisee.' }, 'Mon histoire — destination de retour après lecture vers «  » non modélisée.'],
    [{ entryName: 'Mon histoire', field: 'afterPlaybackSequence.okTarget', targetStageId: 'end', targetStageName: 'Ma fin', message: "Mon histoire — destination OK de l'etape « Écran « étrange » » vers « Ma fin » non modelisee." }, "Mon histoire — destination OK de l'étape « Écran « étrange » » vers « Ma fin » non modélisée."],
    [{ entryName: 'Mon histoire', field: 'afterPlaybackHomeStep.homeTarget', targetStageId: null, message: "Mon histoire — destination Home de l'etape Â« Écran « étrange » Â» non modelisee." }, "Mon histoire — destination Home de l'étape « Écran « étrange » » non modélisée."],
  ]) {
    const snapshot = JSON.stringify(warning);
    assert.equal(presentImportWarning(warning), expected);
    assert.equal(JSON.stringify(warning), snapshot);
  }
});


test('détails du vérificateur : libellé inconnu imbriqué traduit dans les exports', async () => {
  const unknown = { code: 'LABEL_IMAGE_FORMAT_UNKNOWN', params: {} };
  const details = [
    { code: 'CHECKER_AUDIO_SAMPLERATE_UNEXPECTED', params: { sampleRate: unknown } },
    { code: 'CHECKER_AUDIO_CHANNELS_UNEXPECTED', params: { channels: unknown } },
  ];
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const shown = presentCheckerReport({ issues: details.map((detail) => ({ technicalDetails: JSON.stringify(detail) })) });
    for (let index = 0; index < details.length; index++) {
      assert.equal(shown.issues[index].technicalDetails, presentUserMessage(details[index]).message);
      assert.ok(!shown.issues[index].technicalDetails.includes('{"code"'));
      if (language !== 'fr') assert.doesNotMatch(shown.issues[index].technicalDetails, /Détecté|Attendu|inconnu/);
    }
    if (language === 'fr') assert.deepEqual(shown.issues.map((issue) => issue.technicalDetails), ['Détecté : inconnu. Attendu : 44.1 kHz.', 'Détecté : inconnu. Attendu : mono.']);
  }
});

test('détails d’archive : refus historique conservé, contexte traduit et sortie externe brute', async () => {
  const { presentImportError } = await import('../src/components/EditPack/importErrorPresentation.js');
  const detail = { code: 'FILES_ARCHIVE_COMPRESSION_UNSUPPORTED', params: { archive: 'Pack français.zip', method: 'LZMA', entryName: 'story.json', error: 'external IO failure' } };
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const shown = presentImportError({ code: 'IMPORT_UNSUPPORTED_COMPRESSION', params: {}, detail: JSON.stringify(detail) });
    assert.equal(shown.technicalDetail, presentUserMessage(detail).message);
    assert.ok(shown.technicalDetail.includes('Pack français.zip'));
    assert.ok(shown.technicalDetail.includes('external IO failure'));
    if (language !== 'fr') assert.doesNotMatch(shown.technicalDetail, /Recompressez|Détail :|utilise une compression/);
  }
});

test('erreurs retenues : le même état suit fr → en → it sans nouveau catch', async () => {
  const stored = { userMessage: envelope, prefix: 'Contexte : ' };
  const snapshot = JSON.stringify(stored);
  const outputs = [];
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const shown = presentStoredError(stored);
    assert.equal(shown, `Contexte : ${presentUserMessage(envelope).message}`);
    outputs.push(shown);
  }
  assert.equal(new Set(outputs).size, 3);
  assert.equal(JSON.stringify(stored), snapshot);
});

test('les écrans P2/P3 ne figent plus une traduction dans setError', async () => {
  for (const path of surfaces) {
    assert.doesNotMatch(await read(path), /setError\(\s*(?:presentUserMessage\([^)]*\)\.message|presented\.message)/, path);
  }
});

test('checker : une erreur IPC déjà reçue et son journal suivent la langue à chaud', async () => {
  const disk = await createDiskHarness({ commands: { analyze_community_pack: async () => { throw envelope; } } });
  try {
    let checker;
    const hook = runner(() => { checker = useCommunityPackChecker(); });
    await i18next.changeLanguage('fr');
    hook.render();
    await checker.analyzePath('/pack.zip');
    for (const language of ['fr', 'en', 'it']) {
      await i18next.changeLanguage(language);
      hook.render();
      const expected = presentUserMessage(envelope).message;
      assert.equal(checker.error, expected);
      // Lot 4.9 (exception nominative, règle d'or) : le préfixe du journal suit la
      // langue ; l'attente FR reste textuellement celle d'origine.
      if (language === 'fr') assert.equal(checker.liveLog.at(-1), `Analyse interrompue : ${expected}`);
      else assert.equal(checker.liveLog.at(-1), i18next.t('checker:log.analysis.interrupted', { lng: language, message: expected }));
      if (language !== 'fr') assert.doesNotMatch(checker.liveLog.at(-1), /Analyse interrompue/);
      assert.equal(checker.technicalDetail, envelope.detail);
    }
    hook.unmount();
  } finally { await disk.dispose(); }
});
