import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
const options = { configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } };

for (const explicitCache of [false, true]) {
  test(`SSR fixtures disable native dependency optimization after React configuration (${explicitCache ? 'explicit' : 'owned'} cache)`, async () => {
    const cacheDir = explicitCache ? await mkdtemp(join(tmpdir(), 'story-studio-explicit-cache-')) : undefined;
    let server;
    try {
      server = await createServer({
        ...options, cacheDir, plugins: [react()],
        optimizeDeps: { noDiscovery: false, include: ['react'] },
      });
      for (const environment of Object.values(server.environments)) {
        assert.equal(environment.config.optimizeDeps.noDiscovery, true);
        assert.deepEqual(environment.config.optimizeDeps.include, []);
        assert.equal(environment.depsOptimizer, undefined, `${environment.name} has no background optimizer`);
      }
      const { createUrlCache } = await server.ssrLoadModule('/src/tabs/EmulatorTab/useUrlCache.js');
      const cache = createUrlCache();
      assert.equal(cache.set('image', 'blob:fixture'), 'blob:fixture');
      assert.equal(cache.get('image'), 'blob:fixture');
      cache.revokeAll();
    } finally {
      try { await server?.close(); }
      finally { if (cacheDir) await rm(cacheDir, { recursive: true, force: true }); }
    }
  });
}

test('concurrent Vite fixture servers own distinct caches and release only their own directory', async () => {
  const servers = await Promise.all([createServer(options), createServer(options)]);
  try {
    const [a, b] = servers;
    assert.notEqual(a.config.cacheDir, b.config.cacheDir);
    await Promise.all(servers.map(server => access(server.config.cacheDir)));
    await Promise.all([a.close(), a.close()]);
    await assert.rejects(access(a.config.cacheDir), { code: 'ENOENT' });
    await access(b.config.cacheDir);
    assert.equal((await b.pluginContainer.resolveId('react')).id.includes('react'), true);
  } finally {
    await Promise.all(servers.map(server => server.close()));
  }
  await Promise.all(servers.map(server => assert.rejects(access(server.config.cacheDir), { code: 'ENOENT' })));
});

test('an explicitly supplied Vite cache remains owned by the caller', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'story-studio-explicit-cache-'));
  try {
    const server = await createServer({ ...options, cacheDir });
    assert.equal(normalize(server.config.cacheDir), normalize(cacheDir));
    await server.close();
    await access(cacheDir);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

const removalOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

test('owned cache removal waits for Vite close and requests bounded filesystem retries', async (t) => {
  let closed = false;
  const server = await createServer({
    ...options,
    plugins: [{ name: 'observe-close', closeBundle() { closed = true; } }],
  });
  const remove = t.mock.method(fs, 'rm', async (path, settings) => {
    assert.equal(closed, true);
    assert.equal(normalize(path), normalize(server.config.cacheDir));
    assert.deepEqual(settings, removalOptions);
    return rm(path, settings);
  });
  try {
    const closing = server.close();
    assert.equal(server.close(), closing, 'concurrent closes share cleanup');
    await closing;
    assert.equal(remove.mock.callCount(), 1);
    await assert.rejects(access(server.config.cacheDir), { code: 'ENOENT' });
  } finally {
    remove.mock.restore();
    try { await server.close(); }
    finally { await rm(server.config.cacheDir, { recursive: true, force: true }); }
  }
});

test('failed Vite creation also removes its owned cache with bounded retries', async (t) => {
  const failure = new Error('fixture configuration failed');
  let cacheDir;
  const remove = t.mock.method(fs, 'rm', async (path, settings) => {
    assert.equal(normalize(path), normalize(cacheDir));
    assert.deepEqual(settings, removalOptions);
    return rm(path, settings);
  });
  try {
    await assert.rejects(createServer({
      ...options,
      plugins: [{ name: 'reject-config', configResolved(config) {
        cacheDir = config.cacheDir;
        throw failure;
      } }],
    }), error => error === failure);
    assert.equal(remove.mock.callCount(), 1);
    await assert.rejects(access(cacheDir), { code: 'ENOENT' });
  } finally {
    remove.mock.restore();
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
  }
});

for (const code of ['ENOTEMPTY', 'EBUSY', 'EPERM']) {
  test(`persistent ${code} from filesystem cleanup still rejects close`, async (t) => {
    const server = await createServer(options);
    const failure = Object.assign(new Error('filesystem retries exhausted'), { code });
    // Model fs.rm rejecting after its own retry budget; no timing race required.
    const remove = t.mock.method(fs, 'rm', async (path, settings) => {
      assert.equal(normalize(path), normalize(server.config.cacheDir));
      assert.deepEqual(settings, removalOptions);
      throw failure;
    });
    try {
      await assert.rejects(server.close(), error => error === failure);
      await assert.rejects(server.close(), error => error === failure);
      assert.equal(remove.mock.callCount(), 1, 'failed cleanup is not silently retried by close');
    } finally {
      remove.mock.restore();
      await rm(server.config.cacheDir, { recursive: true, force: true });
    }
  });
}
