import test from 'node:test';
import assert from 'node:assert/strict';
import { createLuniiDeviceApi, luniiCoverAddress } from '../src/store/catalogue/luniiDeviceApi.js';
import { createTestI18n } from './i18nTestSetup.mjs';
import { presentCatalogueError } from '../src/store/catalogue/catalogueApi.js';

test('Lunii commands use opaque handles and revision-checked catalogue selections', async () => {
  const calls = [];
  const api = createLuniiDeviceApi({ invoke: async (name, args) => { calls.push([name, args]); return { ok: true }; } });
  const selection = [{ exemplarId: 'entry', expectedRevision: 2 }];
  await api.list(); await api.open('d'); await api.inspect('d');
  await api.send({ deviceId: 'd', selection, position: 1, requestId: 'r' });
  await api.cancel('op'); await api.remove('d', ['a', 'b']); await api.reorder('d', ['b', 'a']);
  await api.hide('d', 'a', true); await api.hide('d', 'a', false);
  await api.nameStory('d', 'a', 'Conte'); await api.rename('d', 'Salon');
  await api.repair('d'); await api.restore('d');
  await api.orphan({ deviceId: 'd', key: 'folder', restore: false });
  await api.repatriate('d', 'a', 'repatriate-attempt', '/workspace', '3+]Conte'); await api.eject('d');
  assert.equal(calls.length, 16);
  assert.deepEqual(calls[14], ['lunii_device_repatriate', { deviceId: 'd', key: 'a', requestId: 'repatriate-attempt', workspaceDir: '/workspace', archiveName: '3+]Conte' }]);
  assert.deepEqual(calls[3], ['lunii_device_send', {
    deviceId: 'd', selection, position: 1, requestId: 'r', audioEdgeSilence: { leading: 0.4, trailing: 0.4 },
  }]);
  assert.deepEqual(calls[13], ['lunii_device_orphan', { deviceId: 'd', key: 'folder', restore: false, knownUuid: null }]);
  assert.ok(calls.every(([, args]) => !args || !('path' in args)));
});

test('device events can be released; covers are opaque and reject paths', async () => {
  let handler; let released = false;
  const api = createLuniiDeviceApi({ listen: async (name, listener) => { assert.equal(name, 'lunii-devices-changed'); handler = listener; return () => { released = true; }; } });
  let devices;
  const stop = await api.onDevicesChanged(value => { devices = value; });
  handler({ payload: [{ id: 'd', state: 'detected' }] });
  assert.equal(devices[0].state, 'detected'); stop(); assert.equal(released, true);
  assert.equal(luniiCoverAddress('/abcd/1234', (_, scheme) => `${scheme}://localhost/`), 'lunii-cover://localhost/abcd/1234');
  assert.equal(luniiCoverAddress('/tmp/../../secret'), null);
});

test('catalogue events are forwarded and released through the Lunii facade', async () => {
  let handler; let released = 0; let received;
  const api = createLuniiDeviceApi({ listen: async (name, listener) => {
    assert.equal(name, 'catalogue-changed'); handler = listener;
    return () => { released++; };
  } });
  const stop = await api.onCatalogueChanged(value => { received = value; });
  handler({ payload: { catalogueRevision: 42 } });
  assert.deepEqual(received, { catalogueRevision: 42 });
  await stop(); assert.equal(released, 1);
});

for (const [code, params] of [
  ['STORYTELLER_STORY_DUPLICATE', { position: 3 }],
  ['STORYTELLER_STORY_DUPLICATE', { position: null }],
  ['STORYTELLER_NO_SPACE_UNKNOWN', {}],
  ['STORYTELLER_NO_SPACE', { missingBytes: 42 }],
  ['STORYTELLER_REPATRIATE_REFUSED', { cause: { code: 'STORYTELLER_STORY_INCOMPLETE', params: {} } }],
  ['STORYTELLER_ALREADY_IN_CATALOGUE', {}],
  ['STORYTELLER_PROJECT_INCOMPLETE', { cause: { code: 'STORYTELLER_PROJECT_INVALID', params: {} } }],
  ...['STORYTELLER_SEND_CANCELLED', 'STORYTELLER_DEVICE_BUSY', 'STORYTELLER_SEND_DISCONNECTED', 'STORYTELLER_STORY_HIDDEN', 'STORYTELLER_STORY_MISSING', 'STORYTELLER_STORY_INCOMPLETE', 'STORYTELLER_DEVICE_CHANGED', 'STORYTELLER_INVALID_ORDER'].map(code => [code, {}]),
]) {
  test(`${code}: typed errors remain presentable`, async () => {
    const api = createLuniiDeviceApi({ invoke: async () => { throw { code, params, detail: null }; } });
    await assert.rejects(api.inspect('d'), error => {
      assert.equal(error.code, code);
      const instance = createTestI18n();
      for (const language of ['fr', 'en', 'it']) {
        const rendered = presentCatalogueError(error, { t: instance.getFixedT(language), language });
        assert.equal(rendered.fallback, false);
        assert.doesNotMatch(rendered.message, /\[object Object\]|undefined|rust:/);
        if (code === 'STORYTELLER_STORY_DUPLICATE' && params.position === null) assert.doesNotMatch(rendered.message, /position|null/);
        if (params.position) assert.match(rendered.message, /3/);
        if (params.missingBytes) assert.match(rendered.message, /42/);
      }
      return true;
    });
  });
}

test('every STORYTELLER facade code renders its translated message and typed parameters in all languages', async () => {
  const { readFile } = await import('node:fs/promises');
  const messages = JSON.parse(await readFile(new URL('../src/locales/fr/rust.json', import.meta.url), 'utf8'));
  const instance = createTestI18n();
  for (const code of Object.keys(messages).filter(code => code.startsWith('STORYTELLER_'))) {
    const api = createLuniiDeviceApi({ invoke: async () => { throw { code, params: { position: 3, missingBytes: 42, screen: 'La girafe', cause: { code: 'STORYTELLER_STORY_INCOMPLETE', params: {} } } }; } });
    await assert.rejects(api.inspect('d'), error => {
      for (const language of ['fr', 'en', 'it']) {
        const value = presentCatalogueError(error, { t: instance.getFixedT(language), language });
        assert.equal(value.fallback, false, `${code}/${language}`);
        assert.doesNotMatch(value.message, /\[object Object\]|undefined|rust:|\{\{/);
        if (/_UNREADABLE$/.test(code) && code !== 'STORYTELLER_STORY_UNREADABLE') assert.match(value.message, /La girafe/, `${code}/${language}`);
      }
      return true;
    });
  }
});

for (const deviceFault of [true, false]) {
  test(`Lunii IPC retains deviceFault=${deviceFault} on the error and its message envelope`, async () => {
    const envelope = { code: 'STORYTELLER_WRITE_FAILED', params: {}, deviceFault };
    const api = createLuniiDeviceApi({ invoke: async () => { throw JSON.stringify(envelope); } });
    await assert.rejects(api.remove('d', ['a']), error => {
      assert.equal(error.deviceFault, deviceFault);
      assert.deepEqual(error.userMessage, envelope);
      assert.ok(presentCatalogueError(error).message);
      return true;
    });
  });
}
