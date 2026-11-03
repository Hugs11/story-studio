import test from 'node:test';
import assert from 'node:assert/strict';
import { coverAddress, coverOrigin } from '../src/store/catalogue/coverAddress.js';

const signature = '0123456789abcdef'.repeat(4);
// Mêmes formes que `convertFileSrc` de Tauri pour un chemin vide.
const posix = (path, protocol) => `${protocol}://localhost/${encodeURIComponent(path)}`;
const windows = (path, protocol) => `http://${protocol}.localhost/${encodeURIComponent(path)}`;

test('the protocol origin comes from Tauri for each WebView', () => {
  assert.equal(coverOrigin(posix), 'catalogue-cover://localhost');
  assert.equal(coverOrigin(windows), 'http://catalogue-cover.localhost');
  const asked = [];
  coverOrigin((path, protocol) => { asked.push([path, protocol]); return 'x://localhost/'; });
  assert.deepEqual(asked, [['', 'catalogue-cover']]);
});

test('the address names the encoder version, the fiche and its cover signature only', () => {
  assert.equal(coverAddress('card-1', signature, posix), `catalogue-cover://localhost/v1/card-1/${signature}.jpg`);
  assert.equal(coverAddress('a/../b c', signature, windows), `http://catalogue-cover.localhost/v1/a%2F..%2Fb%20c/${signature}.jpg`);
  assert.equal(coverAddress('', signature, posix), null);
  assert.equal(coverAddress('card', '', posix), null);
  assert.equal(coverAddress('card', 'ABC', posix), null);
  assert.equal(coverAddress(null, signature, posix), null);
});
