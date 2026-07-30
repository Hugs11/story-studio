import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  verifiedDownload,
  verifiedDownloadCachePath,
  VERIFIED_DOWNLOAD_DEFAULTS,
} from './verified-download.mjs';

const ALLOWED_HOSTS = ['downloads.example.test'];

function specFor(bytes) {
  return {
    url: 'https://downloads.example.test/tool.bin',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    maxBytes: 1_024,
  };
}

function responseFor(bytes, url = 'https://downloads.example.test/tool.bin') {
  const response = new Response(bytes, {
    headers: { 'content-length': String(bytes.length) },
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

test('verified downloads use five attempts with meaningful default backoff', () => {
  assert.deepEqual(
    VERIFIED_DOWNLOAD_DEFAULTS.retryDelaysMs,
    [2_000, 5_000, 10_000, 20_000],
  );
  assert.equal(VERIFIED_DOWNLOAD_DEFAULTS.timeoutMs, 120_000);
});

test('verified download cache is rechecked and avoids a second network request', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'story-studio-download-cache-'));
  const bytes = Buffer.from('verified cached tool');
  const spec = specFor(bytes);
  let fetches = 0;
  try {
    const first = await verifiedDownload(spec, 'Test tool', {
      allowedHosts: ALLOWED_HOSTS,
      cacheDir,
      fetchImpl: async () => {
        fetches += 1;
        return responseFor(bytes);
      },
    });
    const second = await verifiedDownload(spec, 'Test tool', {
      allowedHosts: ALLOWED_HOSTS,
      cacheDir,
      fetchImpl: async () => {
        fetches += 1;
        throw new Error('network should not be used');
      },
    });
    assert.deepEqual(first, bytes);
    assert.deepEqual(second, bytes);
    assert.equal(fetches, 1);

    await writeFile(verifiedDownloadCachePath(spec, cacheDir), 'corrupted');
    await verifiedDownload(spec, 'Test tool', {
      allowedHosts: ALLOWED_HOSTS,
      cacheDir,
      fetchImpl: async () => {
        fetches += 1;
        return responseFor(bytes);
      },
    });
    assert.equal(fetches, 2);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('verified downloads reject untrusted redirects without retrying', async () => {
  const bytes = Buffer.from('redirected tool');
  let attempts = 0;
  await assert.rejects(
    verifiedDownload(specFor(bytes), 'Test tool', {
      allowedHosts: ALLOWED_HOSTS,
      fetchImpl: async () => {
        attempts += 1;
        return responseFor(bytes, 'https://untrusted.example.test/tool.bin');
      },
      waitForRetry: async () => {},
    }),
    /redirected URL host is not allowed/,
  );
  assert.equal(attempts, 1);
});

test('verified downloads retry explicit network error codes', async () => {
  const bytes = Buffer.from('eventual response');
  const delays = [];
  let attempts = 0;
  const result = await verifiedDownload(specFor(bytes), 'Test tool', {
    allowedHosts: ALLOWED_HOSTS,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('network unreachable'), { code: 'ENETUNREACH' });
      }
      return responseFor(bytes);
    },
    jitterRatio: 0,
    retryDelaysMs: [25],
    waitForRetry: async (delay) => delays.push(delay),
  });
  assert.deepEqual(result, bytes);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [25]);
});
