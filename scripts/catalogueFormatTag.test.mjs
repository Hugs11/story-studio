import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTags, parentPath } from '../src/store/catalogue/formatTag.js';
import { card } from './catalogueFixtures.mjs';

test('one tag per format in fixed order, counts and recent copies first', () => {
  const c = card({ exemplars: [{ id: 'old', format: 'zip', modifiedAt: 100 }, { id: 'p', format: 'project' }, { id: 'new', format: 'zip', modifiedAt: 200 }, { format: 'folder' }, { format: 'sevenZip' }] });
  const tags = formatTags(c.exemplars);
  assert.deepEqual(tags.map(t => t.format), ['project', 'zip', 'sevenZip', 'folder']);
  assert.equal(tags[0].countLine, null);
  assert.deepEqual(tags[1].countLine, { key: 'catalogue:formatTag.count', params: { n: 2 } });
  assert.deepEqual(tags[1].exemplarIds, ['new', 'old']);
});
test('archive container mention and fully unavailable tag, mixed availability retained', () => {
  const c = card({ exemplars: [{ format: 'zip', path: '/packs/multi.zip', member: 'ours', available: false }] });
  const tag = formatTags(c.exemplars)[0];
  assert.equal(tag.archive, 'multi.zip');
  assert.equal(tag.allUnavailable, true);
  assert.deepEqual(tag.mentions.map(m => m.key), ['catalogue:formatTag.inArchive', 'catalogue:formatTag.unavailable']);
  assert.equal(tag.regenerate, false);
  assert.equal(formatTags([...c.exemplars, { ...c.exemplars[0], id: 'second', available: true }])[0].allUnavailable, false);
  assert.deepEqual(formatTags([]), []);
});
test('parent paths preserve platform separators and case', () => {
  assert.equal(parentPath('/Packs/A.zip'), '/Packs');
  assert.equal(parentPath('C:\\A.zip'), 'C:\\');
  assert.equal(parentPath('/A.zip'), '/');
  assert.equal(parentPath('C:\\Packs\\A.zip'), 'C:\\Packs');
});
