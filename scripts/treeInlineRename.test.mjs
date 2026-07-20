import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canInlineRenameTreeNode,
  getInlineRenameFields,
} from '../src/components/TreePanel/treeInlineRename.js';

test('inline rename is limited to folders and stories', () => {
  assert.equal(canInlineRenameTreeNode('menu'), true);
  assert.equal(canInlineRenameTreeNode('story'), true);
  assert.equal(canInlineRenameTreeNode('root'), false);
  assert.equal(canInlineRenameTreeNode('zip'), false);
  assert.equal(canInlineRenameTreeNode('ref'), false);
  assert.equal(canInlineRenameTreeNode('end-node'), false);
});

test('inline rename emits one name update only when the draft changed', () => {
  assert.equal(getInlineRenameFields('Histoire', 'Histoire'), null);
  assert.deepEqual(getInlineRenameFields('Histoire', 'Nouveau nom'), { name: 'Nouveau nom' });
  assert.deepEqual(getInlineRenameFields('Histoire', ''), { name: '' });
});
