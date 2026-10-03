import test from 'node:test';
import assert from 'node:assert/strict';

import { askImportedUuidRevision } from '../src/hooks/importedUuidRevision.js';

const ORIGINAL = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function dialog(answer) {
  const calls = [];
  const show = async (options) => {
    calls.push(options);
    return answer;
  };
  return { show, calls };
}

test('keeping the original UUID leaves the draft untouched', async () => {
  const { show, calls } = dialog('keep');
  const draft = { title: 'Example', uuid: ORIGINAL, originalUuid: ORIGINAL };
  assert.equal(await askImportedUuidRevision(draft, show), draft);
  assert.equal(calls.length, 1);
});

test('renewing draws a fresh UUID', async () => {
  const { show } = dialog('renew');
  const next = await askImportedUuidRevision({ uuid: ORIGINAL, originalUuid: ORIGINAL }, show);
  assert.notEqual(next.uuid, ORIGINAL);
  assert.match(next.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('no question when the UUID is not the original one, or has no origin', async () => {
  const { show, calls } = dialog('renew');
  const changed = { uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', originalUuid: ORIGINAL };
  const unknown = { uuid: ORIGINAL, originalUuid: '' };
  assert.equal(await askImportedUuidRevision(changed, show), changed);
  assert.equal(await askImportedUuidRevision(unknown, show), unknown);
  assert.equal(calls.length, 0);
});
