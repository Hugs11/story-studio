import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';
import { presentUserMessage, presentStoredError } from '../src/i18n/userMessage.js';

const { useImportSession } = await import('../src/hooks/useImportSession.js');
const { useCommunityPackChecker } = await import('../src/components/CommunityPackChecker/useCommunityPackChecker.js');
const { useProjectStore } = await import('../src/store/projectStore.js');
const { buildProjectIndex } = await import('../src/store/projectModel.js');
const noop = () => {};
const original = 'Le transfert a échoué : accès refusé';
const envelope = { code: 'UNEXPECTED_ERROR', params: {}, detail: original };

test('le catch du funnel agrégat conserve la cause IPC et replie le détail inconnu', async () => {
  // Exécuter le bloc de production sans monter les outils média du funnel JSX.
  const source = await readFile(new URL('../src/components/AggregatePacks/AggregatePacksFunnel.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('} catch (generationError) {') + '} catch (generationError) {'.length;
  let depth = 1; let end = start;
  // Ce bloc ne contient pas de littéral avec accolade hors des interpolations équilibrées.
  for (; depth; end++) { if (source[end] === '{') depth++; if (source[end] === '}') depth--; }
  const body = source.slice(start, end - 1);
  const run = new Function('generationError', 'presentUserMessage', 'window', 'timer', 'unlisten', 'setError', 'setTechnicalDetail', 'setPhase', 'sessionDirRef', 'invoke', `return (async () => {${body}})()`);
  for (const error of [original, envelope]) {
    let message; let detail;
    await run(error, presentUserMessage, { clearInterval: noop }, null, null, value => { message = value; }, value => { detail = value; }, noop, { current: '' }, noop);
    assert.equal(message.userMessage, error);
    assert.equal(message.codedOnly, true);
    assert.deepEqual(message.prefix, { key: 'home:aggregate.generation.errorPrefix' });
    if (typeof error === 'object') {
      assert.equal(message.userMessage.code, 'UNEXPECTED_ERROR');
      assert.deepEqual(message.userMessage.params, {});
    }
    const presented = presentUserMessage(error, { allowLegacyFrench: false });
    assert.equal(presented.code, typeof error === 'object' ? 'UNEXPECTED_ERROR' : null);
    assert.equal(presented.fallback, typeof error === 'string');
    assert.ok(!presentStoredError(message).includes(original), 'le détail du moteur est replié, pas interpolé');
    assert.equal(detail, original);
    assert.ok(!presentStoredError(message).includes('[object Object]'));
  }
});

test('handleUnpackZip présente l’erreur objet avec le préfixe FR historique', async () => {
  const disk = await createDiskHarness({ commands: { unpack_zip_to_entries: async () => { throw envelope; } } });
  try {
    let store; let imports; let dialog;
    const app = runner(() => {
      store = useProjectStore();
      imports = useImportSession({ store, projectIndex: buildProjectIndex(store.project),
        workspaceDirRef: { current: disk.workspace }, sessionModeRef: { current: 'project' },
        setUnpacking: noop, setImporting: noop, setImportNotice: noop,
        showErrorDialog: value => { dialog = value; },
      });
    });
    app.render(); store.addZip(null, '/source/pack.zip', 'Pack'); app.render();
    const zip = [...buildProjectIndex(store.project).entryById.values()].find(entry => entry.type === 'zip');
    assert.ok(zip);
    await imports.handleUnpackZip(zip.id);
    assert.equal(dialog.message, `Erreur lors de l’extraction : ${original}`);
    assert.equal(dialog.technicalDetail, original);
  } finally { await disk.dispose(); }
});

for (const [method, command] of [['analyzePath', 'analyze_community_pack'], ['fixPack', 'create_fixed_community_pack']]) {
  test(`${command} décode les erreurs String JSON sans les exposer`, async () => {
    const disk = await createDiskHarness({ commands: {
      analyze_community_pack: async () => command === 'analyze_community_pack' ? Promise.reject(JSON.stringify(envelope)) : { issues: [], technicalLog: [] },
      create_fixed_community_pack: async () => { throw JSON.stringify(envelope); },
    } });
    try {
      let checker; const app = runner(() => { checker = useCommunityPackChecker(); }); app.render();
      if (method === 'fixPack') { await checker.analyzePath('/pack.zip'); app.render(); }
      await checker[method]('/pack.zip'); app.render();
      assert.equal(checker.error, original);
      assert.equal(checker.technicalDetail, original);
      assert.ok(checker.liveLog.every(line => !line.includes('{"code"')));
    } finally { await disk.dispose(); }
  });
}
