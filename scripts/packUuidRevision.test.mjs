import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldPromptRegenerateImportedUuid } from '../src/store/projectHelpers.js';

test('prompts while the imported UUID is unchanged', () => {
  assert.equal(shouldPromptRegenerateImportedUuid({
    uuid: '11111111-2222-4333-8444-555555555555',
    originalUuid: '11111111-2222-4333-8444-555555555555',
  }), true);
});

test('does not prompt after the UUID was regenerated', () => {
  assert.equal(shouldPromptRegenerateImportedUuid({
    uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    originalUuid: '11111111-2222-4333-8444-555555555555',
  }), false);
});

test('does not guess that the current UUID is original when its origin is unknown', () => {
  assert.equal(shouldPromptRegenerateImportedUuid({
    uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    originalUuid: '',
  }), false);
});
