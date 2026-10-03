import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { runner } from './reactHookDriver.mjs';
import { createNativeGenerationLock } from '../src/store/nativeGenerationLock.js';

register('./nodeSourceResolver.mjs', import.meta.url);
const { useAdvancedAuthoring } = await import('../src/hooks/useAdvancedAuthoring.js');
const { useAuthorCommandLock } = await import('../src/hooks/useAuthorCommandLock.js');
const { createWindowCloseHandler } = await import('../src/hooks/useWindowCloseGuard.js');

test('les vrais hooks refusent avant rendu et reprennent dès la libération', () => {
  const calls = [];
  const store = { project: {}, workEpochRef: { current: 1 }, setProject: () => {} };
  const app = runner(() => {
    const authoring = useAdvancedAuthoring({ store });
    const commands = useAuthorCommandLock({
      isLocked: authoring.isLocked,
      commands: Object.fromEntries(['undo', 'redo', 'save', 'saveAs', 'newProject', 'openProject', 'openPack', 'openRecentProject']
        .map(name => [name, () => calls.push(name)])),
    });
    return { authoring, commands };
  });
  const { authoring, commands } = app.render();
  authoring.hold('export');
  assert.equal(authoring.locked, false, 'le rendu reste volontairement ancien');
  for (const command of Object.values(commands)) assert.equal(command(), null);
  assert.deepEqual(calls, []);
  authoring.releaseHold();
  commands.undo();
  assert.deepEqual(calls, ['undo'], 'aucun nouveau rendu nécessaire');
});

function fixture(overrides = {}) {
  const calls = [];
  const lock = createNativeGenerationLock();
  let blocked = false;
  const current = {
    isCloseBlocked: () => blocked,
    askSaveBeforeLeave: async () => { calls.push('decision'); return true; },
    saveHandlerRef: { current: () => calls.push('save') },
    beforeClose: async () => { calls.push('cleanup'); },
    ...overrides,
  };
  const close = createWindowCloseHandler({
    readCurrent: () => current, lock,
    win: { destroy: async () => { calls.push('destroy'); } },
  });
  return { calls, lock, current, block: value => { blocked = value; },
    close: () => close({ preventDefault: () => calls.push('prevent') }) };
}

test('fermeture sous verrou : ni dialogue, ni save, ni nettoyage, ni destruction', async () => {
  const f = fixture(); f.block(true);
  await f.close();
  assert.deepEqual(f.calls, ['prevent']);
});

for (const choice of ['save', 'discard']) {
  test(`export démarré pendant le dialogue : ${choice} ne ferme pas la fenêtre`, async () => {
    let decide;
    const f = fixture({ askSaveBeforeLeave: () => new Promise(resolve => { decide = resolve; }) });
    const pending = f.close();
    f.block(true); decide(true); await pending;
    assert.deepEqual(f.calls, ['prevent']);
  });
}

test('projet propre : fermeture autorisée, export exclu pendant tout le nettoyage', async () => {
  const f = fixture();
  f.current.beforeClose = async () => {
    f.calls.push('cleanup');
    await Promise.resolve();
    assert.equal(f.lock.acquire({ owner: 'advanced' }), null);
    await f.close(); // Une deuxième demande n'ouvre pas un second nettoyage.
  };
  await f.close();
  assert.deepEqual(f.calls, ['prevent', 'decision', 'cleanup', 'prevent', 'destroy']);
  assert.equal(f.lock.holder, null);
});

test('annuler la décision laisse le travail intact', async () => {
  const f = fixture({ askSaveBeforeLeave: async () => false });
  await f.close();
  assert.deepEqual(f.calls, ['prevent']);
  assert.equal(f.lock.holder, null);
});

test('un travail de fond ne demande confirmation qu\'au moment de fermer', async () => {
  const f = fixture({
    confirmClose: async () => { f.calls.push('background-decision'); return false; },
  });
  await f.close();
  assert.deepEqual(f.calls, ['prevent', 'background-decision']);
});

test('quitter malgré un travail de fond poursuit la garde normale', async () => {
  const f = fixture({
    confirmClose: async () => { f.calls.push('background-decision'); return true; },
  });
  await f.close();
  assert.deepEqual(f.calls, ['prevent', 'background-decision', 'decision', 'cleanup', 'destroy']);
});

test('un travail natif déjà lancé conserve la fenêtre et ses fichiers', async () => {
  const f = fixture(); const exportPermit = f.lock.acquire({ owner: 'advanced' });
  await f.close();
  assert.deepEqual(f.calls, ['prevent', 'decision']);
  assert.equal(f.lock.holder.owner, 'advanced');
  exportPermit.release(); await f.close();
  assert.equal(f.calls.at(-1), 'destroy');
});

test('un nettoyage refusé libère la réservation et permet une nouvelle fermeture', async () => {
  const f = fixture({ beforeClose: async () => { throw new Error('cleanup failed'); } });
  await assert.rejects(f.close(), /cleanup failed/);
  assert.equal(f.lock.holder, null);
  f.current.beforeClose = async () => {};
  await f.close();
  assert.equal(f.calls.at(-1), 'destroy');
});
