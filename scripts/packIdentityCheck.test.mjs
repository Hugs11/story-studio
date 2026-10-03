import test from 'node:test';
import assert from 'node:assert/strict';

import { packIdentityRefusal } from '../src/store/packIdentityCheck.js';

function bridge(refusal = null) {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (refusal) throw refusal;
  };
  return { invoke, calls };
}

test('a readable UUID passes and asks the shared Rust rule', async () => {
  const { invoke, calls } = bridge();
  assert.equal(await packIdentityRefusal('0A1B2C3D4E5F4A6B8C7D9E0F1A2B3C4D', invoke), null);
  assert.deepEqual(calls, [{ command: 'check_pack_identity', args: { value: '0A1B2C3D4E5F4A6B8C7D9E0F1A2B3C4D' } }]);
});

test('a refused UUID says why and what to do', async () => {
  const { invoke } = bridge("L'UUID du pack « {x} » n'est pas lisible par STUdio et Lunii.QT.");
  assert.equal(
    await packIdentityRefusal('{x}', invoke),
    "L'UUID du pack « {x} » n'est pas lisible par STUdio et Lunii.QT. En saisir un autre, ou en générer un nouveau.",
  );
});

test('an empty UUID is sent as an empty string, never as undefined', async () => {
  const { invoke, calls } = bridge("L'UUID du pack est vide.");
  assert.match(await packIdentityRefusal(undefined, invoke), /est vide/);
  assert.equal(calls[0].args.value, '');
});
