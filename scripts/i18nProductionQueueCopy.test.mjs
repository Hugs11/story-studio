// Copie du journal d'un travail graphe refusé : exécuteur → carte → texte copié.
//
// Le refus typé du moteur devient l'erreur du travail. La copie doit relire ce
// refus dans la langue active au moment du clic, sans repasser son texte déjà
// présenté dans `presentUserMessage` comme une erreur brute (repli générique).
// L'exécuteur et la file sont les modules de production, montés par le banc de
// hooks ; seul `invoke` est doublé.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runner } from './reactHookDriver.mjs';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';

register('./nodeSourceResolver.mjs', import.meta.url);

const { useRenderQueueStore } = await import('../src/store/renderQueueStore.js');
const { useRenderQueueExecutor } = await import('../src/hooks/useRenderQueueExecutor.js');
const { JOB_STATUS, WORK_NATURE } = await import('../src/store/production/renderQueueWork.js');
const { createNativeGenerationLock } = await import('../src/store/nativeGenerationLock.js');
const { renderJobReport } = await import('../src/store/production/productionReport.js');
const { presentUserMessage } = await import('../src/i18n/userMessage.js');

// L'expression que la carte exécute au clic sur « Copier logs », lue dans le
// composant lui-même (même procédé que rustP1Consumers) : aucune règle recopiée.
const panelSource = await readFile(new URL('../src/components/RenderQueuePanel/RenderQueuePanel.jsx', import.meta.url), 'utf8');
const copyStart = panelSource.indexOf('const allText = ') + 'const allText = '.length;
const copyExpression = panelSource.slice(copyStart, panelSource.indexOf(';', copyStart));
const copyLogs = (job) => new Function('job', 'warnings', 'presentUserMessage', `return ${copyExpression}`)(job, renderJobReport(job)?.result?.warnings ?? [], presentUserMessage);

const NATIVE_ERROR = { code: 'COMFYUI_SERVICE_ERROR', params: {}, detail: '_RAW_TOOL_' };

async function failedJob({ nature, failingCommand, rejection, extra = {} }) {
  let queue = null;
  const harness = runner(() => {
    queue = useRenderQueueStore();
    useRenderQueueExecutor({
      jobs: queue.jobs,
      updateJob: queue.updateJob,
      appendLog: queue.appendLog,
      lock: createNativeGenerationLock(),
      readAdvancedTicket: () => ({ projectEpoch: 1, document: 'DOC' }),
      isRuntime: () => true,
      invoke: async (command) => {
        if (command === failingCommand) throw rejection;
        return null;
      },
      subscribeProgress: () => () => {},
      notify: () => {},
    });
  });
  harness.render();
  harness.flush();
  queue.addJob({ nature, projectName: '_AUTHOR_NAME_', outputFolder: '/_AUTHOR_FOLDER_', ...extra });
  for (let round = 0; round < 8; round += 1) {
    harness.render();
    harness.flush();
    await Promise.resolve();
    await Promise.resolve();
  }
  return queue.jobs.find((job) => job.projectName === '_AUTHOR_NAME_');
}

const refusedGraphJob = () => failedJob({
  nature: WORK_NATURE.ADVANCED,
  failingCommand: 'export_advanced_pack',
  rejection: { kind: 'output-write', message: NATIVE_ERROR, path: '/_AUTHOR_PARTIAL_' },
  extra: {
    request: { payload: 'DOC', mediaBindings: [], outputFolder: '/_AUTHOR_FOLDER_', options: {} },
    revision: 'REV-1',
    epoch: 1,
    ticketDocument: 'DOC',
    readinessSummary: { blocked: false, blocking: [] },
  },
});

const failedFreeJob = () => failedJob({
  nature: WORK_NATURE.FREE,
  failingCommand: 'generate_pack',
  rejection: { code: 'COMFYUI_SERVICE_ERROR', params: {}, detail: 'RAW' },
  extra: { projectJson: '{}' },
});

const occurrences = (text, part) => text.split(part).length - 1;

test('refus graphe : la copie du journal relit le diagnostic exact en FR → EN → IT, sans repli', async () => {
  i18next.init(createTestI18n().options);
  // Le texte est construit dans le gestionnaire du clic, pas au rendu de la carte.
  const handler = panelSource.indexOf('async function handleCopyLogs');
  assert.ok(handler > 0 && copyStart > handler && copyStart < panelSource.indexOf('navigator.clipboard.writeText', handler));
  await i18next.changeLanguage('fr');
  const job = await refusedGraphJob();
  assert.equal(job.status, JOB_STATUS.ERROR);
  assert.equal(job.refusal.kind, 'output-write');
  assert.equal(job.refusal.cancelled, false);
  assert.equal(job.refusal.path, '/_AUTHOR_PARTIAL_');
  // L'erreur du travail référence le refus : aucun texte figé n'y est copié.
assert.equal(typeof job.errorMessage, 'object');
assert.equal(job.errorMessage.productionRefusal, job.refusal);
  assert.ok(job.logs.length > 0, 'le bouton de copie est disponible');

  const copies = [];
  for (const lng of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(lng);
    const diagnostic = presentUserMessage(NATIVE_ERROR, { allowLegacyFrench: false });
    assert.equal(diagnostic.code, 'COMFYUI_SERVICE_ERROR');
    assert.equal(diagnostic.fallback, false);
    assert.equal(diagnostic.message, i18next.t('rust:COMFYUI_SERVICE_ERROR'));

    const presented = presentUserMessage(job.errorMessage);
    assert.equal(presented.message, diagnostic.message);
    assert.equal(presented.fallback, false);
    assert.equal(presented.technicalDetail, '_RAW_TOOL_');

    const copied = copyLogs(job);
    const lines = copied.split('\n');
    assert.equal(lines.at(-1), diagnostic.message, `${lng} : dernière ligne copiée`);
    assert.ok(!copied.includes(i18next.t('common:error.fallback.unexpected')), `${lng} : pas de repli générique`);
    assert.equal(lines[0], presentUserMessage(job.logs[0]).message);
    assert.ok(lines[0].includes('_AUTHOR_NAME_'));
    assert.doesNotMatch(copied, /\[object Object\]|production:[a-z]+\./);
    // Le rapport et la copie disent la même chose dans la même langue.
    assert.equal(renderJobReport(job).problem.message, diagnostic.message);
    copies.push(lines.at(-1));
  }
  assert.notEqual(copies[0], copies[1]);
  assert.notEqual(copies[0], copies[2]);
  assert.notEqual(copies[1], copies[2]);
  await i18next.changeLanguage('fr');
});

test('génération Libre rejetée : journal sans doublon, copie avec le détail brut une fois et le message dans la langue du clic', async () => {
  i18next.init(createTestI18n().options);
  await i18next.changeLanguage('fr');
  const job = await failedFreeJob();
  assert.equal(job.status, JOB_STATUS.ERROR);
  assert.equal(job.nature, WORK_NATURE.FREE);
  // L'erreur du moteur est gardée telle quelle : code, paramètres et détail.
  assert.deepEqual(job.errorMessage, { code: 'COMFYUI_SERVICE_ERROR', params: {}, detail: 'RAW' });
  // Le journal reçoit le diagnostic brut, jamais l'erreur elle-même.
  assert.ok(!job.logs.includes(job.errorMessage), 'l’erreur n’est pas journalisée comme une étape');
  assert.ok(!job.logs.some((line) => line?.code === 'COMFYUI_SERVICE_ERROR'), 'aucune ligne de journal ne porte le code de l’erreur');

  const copies = [];
  for (const lng of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(lng);
    const diagnostic = presentUserMessage({ code: 'COMFYUI_SERVICE_ERROR', params: {}, detail: 'RAW' }, { allowLegacyFrench: false });
    assert.equal(diagnostic.fallback, false);
    assert.equal(diagnostic.message, i18next.t('rust:COMFYUI_SERVICE_ERROR'));

    const shownLines = job.logs.map((line) => presentUserMessage(line).message);
    assert.equal(shownLines.filter((line) => line === 'RAW').length, 1, `${lng} : détail brut journalisé une fois`);
    assert.ok(!shownLines.includes(diagnostic.message), `${lng} : le message n’est pas recopié dans le journal`);

    const copied = copyLogs(job);
    assert.equal(occurrences(copied, 'RAW'), 1, `${lng} : détail brut copié une fois`);
    assert.equal(occurrences(copied, diagnostic.message), 1, `${lng} : message copié une fois`);
    assert.equal(copied.split('\n').at(-1), diagnostic.message, `${lng} : dernière ligne copiée dans la langue du clic`);
    assert.ok(!copied.includes(i18next.t('common:error.fallback.unexpected')), `${lng} : pas de repli générique`);
    assert.doesNotMatch(copied, /\[object Object\]|production:[a-z]+\.|rust:/);

    // Le rapport : le détail brut n'apparaît qu'une fois (journal), le problème
    // dans la langue active, et aucun volet technique ne le redouble.
    const report = renderJobReport(job);
    assert.equal(report.problem.message, diagnostic.message);
    assert.equal(report.progress.lines.filter((line) => line === 'RAW').length, 1);
    assert.equal(report.technicalDetails, undefined);
    copies.push(copied.split('\n').at(-1));
  }
  assert.notEqual(copies[0], copies[1]);
  assert.notEqual(copies[0], copies[2]);
  assert.notEqual(copies[1], copies[2]);
  await i18next.changeLanguage('fr');
});
