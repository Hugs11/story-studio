import test from 'node:test';
import assert from 'node:assert/strict';
import names from './fixtures/catalogue/file-names.json' with { type: 'json' };
import { parseConventionName, generateConventionName } from '../src/utils/packConvention.js';
test('filename age bounds and naming metadata roundtrip through the existing reader and writer', () => {
  for (const item of names) {
    const parsed = parseConventionName(item.name);
    assert.equal(parsed.minAge, item.min === null ? '' : String(item.min));
    assert.equal(parsed.maxAge ?? null, item.max === null ? null : String(item.max));
    for (const field of ['title', 'author', 'producer', 'bonus', 'version']) assert.equal(parsed[field], item[field]);
    assert.equal(generateConventionName(parsed), item.name.slice(0, -4));
  }
});
