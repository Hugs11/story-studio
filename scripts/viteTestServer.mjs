import fs, { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createViteServer } from 'vite';

// Vite's optimizer cancellation can return before its writes finish. Let Node
// retry transient ENOTEMPTY/EBUSY/EPERM errors; a persistent failure still rejects.
const removeCache = (cacheDir) => fs.rm(cacheDir, {
  recursive: true, force: true, maxRetries: 5, retryDelay: 100,
});

// Each server owns its optimizer cache, including concurrent fixture servers.
export async function createServer(options = {}) {
  // SSR fixtures do not use browser dependency pre-bundling. Short-lived servers
  // can crash the native dependency scanner even when their cache is retained.
  // Apply this after plugin configuration: React adds optimizeDeps.include entries,
  // so noDiscovery/include in the initial options alone does not disable optimization.
  options = {
    ...options,
    plugins: [...(options.plugins ?? []), {
      name: 'story-studio-test-no-dep-optimization',
      configEnvironment: {
        order: 'post',
        handler(_name, config) {
          config.optimizeDeps = { ...config.optimizeDeps, noDiscovery: true, include: [] };
        },
      },
    }],
  };
  if (options.cacheDir) return createViteServer(options);
  const cacheDir = await mkdtemp(join(tmpdir(), 'story-studio-vite-'));
  try {
    const server = await createViteServer({ ...options, cacheDir });
    const close = server.close.bind(server);
    let closing;
    server.close = () => closing ??= (async () => {
      try { await close(); }
      finally { await removeCache(cacheDir); }
    })();
    return server;
  } catch (error) {
    await removeCache(cacheDir);
    throw error;
  }
}
