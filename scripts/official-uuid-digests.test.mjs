import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeUuid, buildDigests, validateDigests } from './official-uuid-digests.mjs';
const a = '00000000-0000-4000-8000-00000000000a';
const b = '00000000-0000-4000-8000-00000000000b';
test('normalization follows Rust UUID forms', () => {
  for (const input of [a, a.toUpperCase(), a.replaceAll('-', ''), `{${a}}`, `urn:uuid:${a}`]) assert.equal(normalizeUuid(input), a);
  for (const input of [null, 1, '', ` ${a}`, a.replace('-', ''), `{${a.replaceAll('-', '')}}`, `urn:uuid:${a.replaceAll('-', '')}`]) assert.equal(normalizeUuid(input), null);
});
test('simulated response: hash domain, sorting, deduplication and invalid counts', () => {
  const result = buildDigests({ response: { one: { uuid: b }, two: { uuid: a.toUpperCase() }, duplicate: { uuid: a }, invalid: { uuid: 'invalid' }, missing: {} } });
  const expected = [a, b].map(uuid => createHash('sha256').update(`story-studio/official-uuid/v1:${uuid}`).digest()).sort(Buffer.compare);
  assert.deepEqual(result.bytes, Buffer.concat(expected));
  assert.equal(result.invalid, 2);
  assert.equal(validateDigests(result.bytes), 2);
  assert.deepEqual(buildDigests({ one: { uuid: a } }).bytes, expected.find(x => x.equals(createHash('sha256').update(`story-studio/official-uuid/v1:${a}`).digest())));
});
test('format: empty accepted, truncated, duplicate and descending rejected', () => {
  assert.equal(validateDigests(Buffer.alloc(0)), 0);
  assert.throws(() => validateDigests(Buffer.alloc(33)));
  assert.throws(() => validateDigests(Buffer.alloc(64)));
  assert.throws(() => validateDigests(Buffer.concat([Buffer.alloc(32, 2), Buffer.alloc(32, 1)])));
});
test('check CLI rejects unsorted file offline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'official-digests-'));
  try {
    const path = join(dir, 'test.bin');
    await writeFile(path, Buffer.concat([Buffer.alloc(32, 2), Buffer.alloc(32, 1)]));
    const result = spawnSync(process.execPath, ['scripts/official-uuid-digests.mjs', '--check', path]);
    assert.equal(result.status, 1);
    await writeFile(path, Buffer.alloc(0));
    assert.equal(spawnSync(process.execPath, ['scripts/official-uuid-digests.mjs', '--check', path]).status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fixed cross-language fingerprint vector', () => {
  assert.equal(buildDigests({ one: { uuid: a } }).bytes.toString('hex'), '412e99b765c7b817432e5828c1eabbdbcb81478589dfc3343cc9dfeb1e87cbca');
});
