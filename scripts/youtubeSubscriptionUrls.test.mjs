import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { youtubeSubscriptionKind, fetchSubscriptionSnapshot } from '../src/store/mediaSubscriptionSource.js';

const examples = JSON.parse(await fs.readFile(new URL('./fixtures/youtubeSubscriptionUrls.json', import.meta.url), 'utf8'));
for (const { url, kind } of examples) {
  test(`subscription kind: ${url}`, () => assert.equal(youtubeSubscriptionKind(url), kind));
}

test('custom channel address reaches the listing IPC unchanged', async () => {
  const url = 'https://www.youtube.com/chaine-exemple';
  await fetchSubscriptionSnapshot({ source: 'youtube', url }, async (command, args) => {
    assert.equal(command, 'fetch_youtube_list');
    assert.equal(args.url, url);
    return { title: 'Chaîne exemple', videos: [{ id: 'one' }], hasNext: false };
  });
});
