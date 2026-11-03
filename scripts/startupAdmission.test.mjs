import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('boot gate rejects writer contention before persisting language or mounting editor', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { admitEditorStartup } = await server.ssrLoadModule('/src/store/startupAdmission.js');
    const { loadLanguage } = await server.ssrLoadModule('/src/i18n/language.js');
    assert.equal(loadLanguage('it', { persist: false, settings: {
      read: () => null, hasExistingSettings: () => false,
      write: () => assert.fail('boot dialog must not persist a language'),
    } }), 'it');
    const calls = [];
    const dependencies = {
      native: true,
      call: async name => { calls.push(name); return true; },
      language: (_, options) => { assert.equal(options.persist, false); calls.push('language'); return 'it'; },
      initialize: lang => { assert.equal(lang, 'it'); calls.push('initialize'); },
      show: async () => calls.push('dialog'),
    };
    assert.equal(await admitEditorStartup(dependencies), false);
    assert.deepEqual(calls, ['startup_blocked', 'language', 'initialize', 'dialog', 'exit_secondary_instance']);
    calls.length = 0;
    assert.equal(await admitEditorStartup({ ...dependencies, call: async name => { calls.push(name); return false; } }), true);
    assert.deepEqual(calls, ['startup_blocked']);
    calls.length = 0;
    await assert.rejects(admitEditorStartup({ ...dependencies, show: async () => { throw Error('dialog failure'); } }), /dialog failure/);
    assert.equal(calls.at(-1), 'exit_secondary_instance');
  } finally { await server.close(); }
});
