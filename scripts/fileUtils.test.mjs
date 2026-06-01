import test from 'node:test';
import assert from 'node:assert/strict';

import {
  basename,
  basenameNoExt,
  dirname,
  joinPath,
  normalizeWindowsPath,
  pathKey,
  stripWindowsLongPathPrefix,
} from '../src/utils/fileUtils.js';

test('pathKey strips Windows long path prefixes and compares mixed case paths', () => {
  assert.equal(pathKey('\\\\?\\C:\\Foo\\bar.MP3'), 'c:/foo/bar.mp3');
  assert.equal(pathKey('C:\\Foo\\bar.MP3'), pathKey('c:/foo/BAR.mp3'));
});

test('pathKey normalizes long UNC paths', () => {
  assert.equal(pathKey('\\\\?\\UNC\\Server\\Share\\Audio.MP3'), '//server/share/audio.mp3');
});

test('pathKey handles nullish and empty inputs', () => {
  assert.equal(pathKey(null), '');
  assert.equal(pathKey(undefined), '');
  assert.equal(pathKey(''), '');
  assert.equal(pathKey('   '), '');
});

test('stripWindowsLongPathPrefix preserves non-Windows inputs untouched', () => {
  assert.equal(stripWindowsLongPathPrefix('C:\\Foo\\bar.mp3'), 'C:\\Foo\\bar.mp3');
  assert.equal(stripWindowsLongPathPrefix('/tmp/foo.mp3'), '/tmp/foo.mp3');
  assert.equal(stripWindowsLongPathPrefix(null), '');
});

test('normalizeWindowsPath keeps web paths unchanged', () => {
  assert.equal(normalizeWindowsPath('file://C:/Foo/bar.mp3'), 'file://C:/Foo/bar.mp3');
  assert.equal(normalizeWindowsPath('http://example.test/Asset.MP3'), 'http://example.test/Asset.MP3');
  assert.equal(normalizeWindowsPath('blob:https://example.test/id'), 'blob:https://example.test/id');
  assert.equal(normalizeWindowsPath('data:audio/mp3;base64,abc'), 'data:audio/mp3;base64,abc');
});

test('normalizeWindowsPath keeps relative paths and canonicalizes local Windows separators', () => {
  assert.equal(normalizeWindowsPath('./asset.mp3'), './asset.mp3');
  assert.equal(normalizeWindowsPath('C:/Foo//bar\\baz.mp3'), 'C:\\Foo\\bar\\baz.mp3');
});

test('normalizeWindowsPath returns null on empty or nullish inputs', () => {
  assert.equal(normalizeWindowsPath(''), null);
  assert.equal(normalizeWindowsPath('   '), null);
  assert.equal(normalizeWindowsPath(null), null);
  assert.equal(normalizeWindowsPath(undefined), null);
});

test('normalizeWindowsPath collapses long UNC server paths', () => {
  assert.equal(normalizeWindowsPath('\\\\server\\share\\foo.mp3'), '\\\\server\\share\\foo.mp3');
  assert.equal(normalizeWindowsPath('\\\\server\\\\share\\\\foo.mp3'), '\\\\server\\share\\foo.mp3');
});

test('basenameNoExt extracts a filename stem', () => {
  assert.equal(basenameNoExt('C:\\Foo\\bar.MP3'), 'bar');
  assert.equal(basenameNoExt('./asset.mp3'), 'asset');
});

test('basenameNoExt removes only the last extension', () => {
  assert.equal(basenameNoExt('archive.tar.gz'), 'archive.tar');
  assert.equal(basenameNoExt('no-extension'), 'no-extension');
  assert.equal(basenameNoExt(''), '');
  assert.equal(basenameNoExt(null), '');
});

test('basename returns the last path segment', () => {
  assert.equal(basename('C:/Foo/bar.mp3'), 'bar.mp3');
  assert.equal(basename('C:\\Foo\\bar.mp3'), 'bar.mp3');
  assert.equal(basename('/tmp/foo/'), 'foo');
  assert.equal(basename('bar.mp3'), 'bar.mp3');
  assert.equal(basename(''), '');
  assert.equal(basename(null), '');
});

test('dirname returns the parent path', () => {
  assert.equal(dirname('C:/Foo/bar.mp3'), 'C:/Foo');
  assert.equal(dirname('C:\\Foo\\bar.mp3'), 'C:\\Foo');
  assert.equal(dirname('/tmp/foo/bar'), '/tmp/foo');
  assert.equal(dirname('bar.mp3'), '');
  assert.equal(dirname(''), '');
});

test('joinPath collapses redundant separators and supports mixed inputs', () => {
  assert.equal(joinPath('C:/Foo', 'bar.mp3'), 'C:/Foo/bar.mp3');
  assert.equal(joinPath('C:/Foo/', '/bar.mp3'), 'C:/Foo/bar.mp3');
  assert.equal(joinPath('C:\\Foo', 'sub', 'bar.mp3'), 'C:\\Foo/sub/bar.mp3');
  assert.equal(joinPath('C:/Foo'), 'C:/Foo');
  assert.equal(joinPath('', 'bar.mp3'), 'bar.mp3');
  assert.equal(joinPath('C:/Foo', '', 'bar.mp3'), 'C:/Foo/bar.mp3');
  assert.equal(joinPath(), '');
});
