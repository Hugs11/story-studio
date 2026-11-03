import test from 'node:test';
import assert from 'node:assert/strict';
import { createLuniiDeviceApi } from '../src/store/catalogue/luniiDeviceApi.js';

test('facade opts silent inspections into read-only IPC and preserves explicit inspections', async () => {
  const calls = [];
  const api = createLuniiDeviceApi({ invoke: async (command, args) => { calls.push([command, args]); return { id: args.deviceId }; } });
  assert.deepEqual(await api.inspect('d'), { id: 'd' });
  assert.deepEqual(await api.inspect('d', { readOnly: true }), { id: 'd' });
  assert.deepEqual(calls, [['lunii_device_inspect', { deviceId: 'd' }], ['lunii_device_inspect', { deviceId: 'd', readOnly: true }]]);
  await api.inspect('d', { readOnly: false });
  assert.deepEqual(calls[2], ['lunii_device_inspect', { deviceId: 'd', readOnly: false }]);
});

test('silent inspection IPC errors retain their typed user message', async () => {
  const message = { code: 'STORYTELLER_DEVICE_GONE', params: {} };
  const api = createLuniiDeviceApi({ invoke: async () => { throw message; } });
  await assert.rejects(api.inspect('d', { readOnly: true }), error => error.userMessage?.code === message.code || error.code === message.code);
});
