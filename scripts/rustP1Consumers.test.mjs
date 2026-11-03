import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import i18next from 'i18next';
import { runner } from './reactHookDriver.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { presentUserMessage, presentTechnicalMessage, presentStoredError } from '../src/i18n/userMessage.js';
import { packIdentityRefusal } from '../src/store/packIdentityCheck.js';
import { decodeProjectFile } from '../src/store/projectModel/codec.js';
import { createAdvancedProject } from '../src/store/projectModel/authoring.js';
import { createGraphCopyFlow } from '../src/hooks/graphCopyFlow.js';
import { renderJobReport } from '../src/store/production/productionReport.js';
import { freeProductionGates, advancedProductionGates } from '../src/store/production/productionGates.js';
import { summarizeReadiness } from '../src/store/advancedExport/exportReadiness.js';
import { classifyExportRefusal } from '../src/store/advancedExport/exportOutcome.js';
import { prepareAdvancedWork } from '../src/store/production/advancedRenderWork.js';
import { runAdvancedProduction } from '../src/store/production/advancedProduction.js';
const { useProjectedSimulation } = await import('../src/hooks/useProjectedSimulation.js');
const { normalizeProjectData } = await import('../src/store/projectModel/schema.js');
const resources = createTestI18n().options.resources;
i18next.init({ lng: 'fr', resources, initAsync: false, keySeparator: false, interpolation: { escapeValue: false } });
const coded = { code: 'PACK_IDENTITY_UNREADABLE', params: { identity: 'id-test' }, detail: 'raw tool output' };
const noop = () => {};
const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
for (const language of ['fr', 'en', 'it']) {
  test(`P1 consommateurs réels en ${language}`, async () => {
    await i18next.changeLanguage(language);
    const expected = presentUserMessage(coded).message;
    assert.ok(!expected.includes('[object Object]'));
    assert.ok(!expected.includes('{"code"'));
    const mixed = { code: 'VALIDATION_PROJECT_ERRORS', params: { errors: { messages: [coded, 'Ancienne erreur fichier non convertie'], separator: '\n' } } };
    const mixedShown = presentUserMessage(mixed);
    assert.ok(mixedShown.message.startsWith(expected));
    assert.ok(mixedShown.technicalDetail.includes('Ancienne erreur fichier non convertie'));
    assert.equal(mixedShown.message.includes('Ancienne erreur fichier non convertie'), language === 'fr');
    // Champ identité et refus avant écriture de copie.
    const identity = await packIdentityRefusal('id-test', async () => { throw JSON.stringify(coded); });
    assert.ok(identity.startsWith(expected));
    let dialog;
    const flow = createGraphCopyFlow({ currentProject: () => ({ projectType: 'pack' }), currentSavePath: () => '/project.mbah',
      choose: async () => 'copy', confirmLeaveOriginal: async () => true, fileExists: async () => false,
      buildCopy: async () => { throw coded; }, showError: (value) => { dialog = value; },
      writeNewFile: () => assert.fail('écriture sur refus'), openCopy: () => assert.fail('ouverture sur refus') });
    assert.equal(await flow.continueInGraph(), false);
    assert.equal(dialog.message, expected);
    // Porte de relecture : le défaut sans found n'est jamais [object Object].
    const advanced = createAdvancedProject({ payload: '{}' });
    await assert.rejects(decodeProjectFile(JSON.stringify(advanced), { validateAdvancedPayload: async () => { throw coded; } }), (error) => {
      assert.equal(error.found, expected); assert.ok(!error.message.includes('[object Object]')); return true;
    });
    // Exemple d’auteur : exécution des deux expressions de refus du hook.
    const exampleSource = await source('src/hooks/useAdvancedExamples.js');
    assert.ok(exampleSource.includes('error: outcome.error'));
    assert.ok(exampleSource.includes('update({ error })'));
    // Lot 4.12 : le hook garde la valeur ; le dialogue la présente à l'affichage
    // (même présentateur, détail technique replié), dans la langue courante.
    const exampleDialogSource = await source('src/components/AdvancedWorkspace/ExampleDialog.jsx');
    assert.ok(exampleDialogSource.includes('<UserMessage value={state.error} />'));
    assert.equal(presentUserMessage(coded).message, expected);
    const retainedError = new Function('error', 'return { error };')(coded);
    assert.equal(presentStoredError(retainedError.error), expected);
    // Simulateur : vraie chaîne Promise/catch du hook.
    const projectStory = async () => { throw JSON.stringify(coded); };
    const hook = runner(() => useProjectedSimulation({ project: normalizeProjectData({}), launch: {}, projectStory }));
    hook.render(); hook.flush(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hook.render().error, expected); hook.unmount();
    // Readiness/portes/export et refus avant production conservent leurs décisions.
    const summary = summarizeReadiness({ blocked: true, diagnostics: [{ source: 'authoring', level: 'ACTION_REQUIRED', ...coded }] });
    assert.equal(summary.diagnostics[0].message, expected);
    const gate = freeProductionGates([{ gate: 'readiness', blocking: true, outcome: 'would-refuse', label: JSON.stringify(coded), note: JSON.stringify(coded), reasons: [coded] }])[0];
    assert.equal(gate.label, expected); assert.equal(gate.note, expected); assert.equal(gate.reasons[0].message, expected);
    const advancedGates = advancedProductionGates(true);
    assert.deepEqual(advancedGates.map((value) => value.gate), ['readiness', 'pack-identity', 'archive-review']);
    assert.equal(advancedGates[0].label, presentUserMessage({ code: 'LABEL_EXPORT_READINESS_VALUE', params: {} }).message);
    assert.equal(advancedGates[0].note, presentUserMessage({ code: 'GENERATION_GATE_PUBLICATION_FOLLOWS', params: {} }).message);

    assert.equal(classifyExportRefusal({ kind: 'output-write', path: '/pack.zip', message: JSON.stringify(coded) }).message, expected);
    assert.equal(classifyExportRefusal({ kind: 'preparation', error: { kind: 'pack-identity', message: JSON.stringify(coded) } }).message, expected);
    let refusal;
    await runAdvancedProduction({ readProject: () => ({}), assessReadiness: async () => { throw coded; }, refuse: (value) => { refusal = value; } });
    assert.ok(refusal.message.endsWith(expected));
    const prepared = await prepareAdvancedWork({ settleAuthoring: async () => { throw coded; } });
    assert.ok(prepared.refusal.message.endsWith(expected));
    const workspaceSource = await source('src/components/AdvancedWorkspace/AdvancedWorkspace.jsx');
    assert.ok(workspaceSource.includes('<UserMessage value={view.error} />'));
    assert.ok(!workspaceSource.includes('String(view.error)'));
    // L'événement garde son objet, la présentation est recalculée au rendu du rapport.
    const subscriptionSource = await source('src/hooks/useRenderQueueExecutor.js');
    const body = subscriptionSource.slice(subscriptionSource.indexOf('function defaultProgressSubscription'), subscriptionSource.indexOf('export function useRenderQueueExecutor'));
    let listener; let line;
    const subscribe = new Function('listen', 'releaseTauriListener', `${body}; return defaultProgressSubscription;`)(async (event, callback) => { assert.equal(event, 'generate-log'); listener = callback; return noop; }, noop);
    const dispose = subscribe((value) => { line = value; }); listener({ payload: coded }); assert.equal(line, coded); dispose();
    const job = { status: 'error', logs: [line, JSON.stringify(coded)], errorMessage: coded };
    const report = renderJobReport(job);
    assert.deepEqual(report.progress.lines, [expected, expected]); assert.equal(report.problem.message, expected);
    // Avertissement commun : exécution de la fonction utilisée par le composant JSX.
    const warningsSource = await source('src/components/production/ProductionReport.jsx');
    const warningBody = warningsSource.slice(warningsSource.indexOf('function warningMessage'), warningsSource.indexOf('function warningDetails'));
    const warning = new Function('presentUserMessage', `${warningBody}; return warningMessage;`)(presentUserMessage);
    assert.equal(warning(coded), expected);
    // Exécuter les expressions de rendu, dont les champs qui contiennent aussi des preuves stables.
    const copySource = await source('src/components/RenderQueuePanel/RenderQueuePanel.jsx');
    const copyExpression = copySource.slice(copySource.indexOf('const allText = ') + 'const allText = '.length, copySource.indexOf(';', copySource.indexOf('const allText = ')));
    const copyText = new Function('job', 'warnings', 'presentUserMessage', `return ${copyExpression}`)(job, [coded], presentUserMessage);
    assert.equal(copyText, [expected, expected, expected, expected].join('\n'));
    for (const [path, variable, fields, fn] of [
      ['src/components/AggregatePacks/AggregatePacksFunnel.jsx', 'warning', ['warning'], presentUserMessage],
      ['src/components/AdvancedWorkspace/ExportReport.jsx', 'disagreement', ['disagreement.expected', 'disagreement.observed'], presentTechnicalMessage],
    ]) {
      const code = await source(path);
      for (const field of fields) {
        const name = fn === presentTechnicalMessage ? 'presentTechnicalMessage' : 'presentUserMessage';
        const expression = `${name}(${field}).message`;
        const actualExpression = fn === presentTechnicalMessage ? `${name}(${field})` : expression;
        assert.ok(code.includes(actualExpression), path);
        const render = new Function(variable, name, `return ${actualExpression}`);
        assert.equal(render(variable === 'disagreement' ? { expected: coded, observed: JSON.stringify(coded) } : coded, fn), expected);
        if (variable === 'disagreement') assert.equal(render({ expected: 'abcd-sha256', observed: '/tmp/media.wav' }, fn), field.endsWith('expected') ? 'abcd-sha256' : '/tmp/media.wav');
      }
    }
  });
}

for (const language of ['fr', 'en', 'it']) {
  test(`les libellés P1 imbriqués sont traduits sans traduire les noms d’auteur (${language})`, async () => {
    await i18next.changeLanguage(language);
    const authoredName = 'Mon titre français';
    const value = { code: 'VALIDATION_FIELD_MISSING_MASCULINE', params: { label: { code: 'LABEL_PROJECT_MENU_AUDIO', params: { context: { code: 'LABEL_PROJECT_PATH', params: { context: { code: 'LABEL_PROJECT_ROOT', params: {} }, name: authoredName } } } } } };
    const result = presentUserMessage(value);
    assert.equal(result.fallback, false);
    assert.ok(result.message.includes(authoredName));
    assert.equal(result.message, {
      fr: 'Racine / Mon titre français : audio menu manquant.',
      en: 'Missing: Top menu / Mon titre français: menu audio.',
      it: 'Elemento mancante: Menu iniziale / Mon titre français: audio del menu.',
    }[language]);
    const { getProjectValidationIssues } = await import('../src/store/projectValidation.js');
    const issues = getProjectValidationIssues({ projectType: 'pack', rootEntries: [{ id: 'author', type: 'story', name: authoredName }] });
    assert.ok(issues.some((issue) => issue.text.includes(authoredName)));
    const rootIssue = issues.find((issue) => issue.id === 'root' && issue.text.includes({ fr: "Audio d'accueil", en: 'Intro audio', it: 'Audio di benvenuto' }[language]));
    assert.ok(rootIssue, JSON.stringify(issues));
    assert.ok(rootIssue.text.includes({ fr: 'Menu racine', en: 'Top menu', it: 'Menu iniziale' }[language]));
    assert.ok(issues.every((issue) => !issue.text.includes('[object Object]') && !issue.text.includes('{"code"')));
    const expectedEntry = presentTechnicalMessage({ code: 'EXPORT_ARCHIVE_ENTRY_EXPECTED', params: { name: 'image.jpg' } });
    assert.equal(expectedEntry, { fr: "l'entrée 'image.jpg'", en: "the file entry “image.jpg”", it: "la voce «image.jpg»" }[language]);
    const gate = freeProductionGates([{ gate: 'pack-identity', outcome: 'would-refuse', note: { code: 'EXPORT_IDENTITY_EXPECTED_LABEL', params: { expected: 'pack-id' } } }])[0];
    assert.equal(gate.note, { fr: 'identité attendue « pack-id »', en: "expected ID “pack-id”", it: "identificativo atteso «pack-id»" }[language]);
  });
}

