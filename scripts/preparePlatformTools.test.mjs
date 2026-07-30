import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  download,
  inspectExecutable,
  inspectZipArchive,
  PLATFORM_MANIFEST,
  preparePlatformTools,
} from './prepare-platform-tools.mjs';

function pe(machine) {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}

function elf(machine) {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

function macho(cpuType) {
  const bytes = Buffer.alloc(64);
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(bytes);
  bytes.writeUInt32LE(cpuType, 4);
  return bytes;
}

function centralDirectory(names, modes = []) {
  const entries = names.map((name, index) => {
    const encoded = Buffer.from(name);
    const entry = Buffer.alloc(46 + encoded.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(encoded.length, 28);
    entry.writeUInt32LE((modes[index] || 0o100644) * 0x10000, 38);
    encoded.copy(entry, 46);
    return entry;
  });
  const central = Buffer.concat(entries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([central, eocd]);
}

test('platform manifest covers only the supported desktop target pairs', () => {
  assert.deepEqual(
    Object.keys(PLATFORM_MANIFEST).sort(),
    ['darwin-arm64', 'linux-x64', 'win32-x64'],
  );
  assert.equal(PLATFORM_MANIFEST['win32-x64'].generated, false);
  assert.equal(PLATFORM_MANIFEST['linux-x64'].platformName, 'linux-x86_64');
  assert.equal(PLATFORM_MANIFEST['darwin-arm64'].platformName, 'macos-aarch64');
  for (const config of Object.values(PLATFORM_MANIFEST).filter(({ generated }) => generated)) {
    for (const tool of [config.ffmpeg, config.sevenZip]) {
      assert.match(tool.archive.url, /^https:\/\//);
      assert.doesNotMatch(tool.archive.url, /latest/i);
      assert.match(tool.archive.sha256, /^[a-f0-9]{64}$/);
      assert.match(tool.binarySha256, /^[a-f0-9]{64}$/);
    }
  }
});

test('executable inspection distinguishes PE, ELF and native Mach-O architectures', () => {
  assert.deepEqual(inspectExecutable(pe(0x8664)), {
    format: 'pe',
    architectures: ['x86_64'],
  });
  assert.deepEqual(inspectExecutable(elf(62)), {
    format: 'elf',
    architectures: ['x86_64'],
  });
  assert.deepEqual(inspectExecutable(macho(0x0100000c)), {
    format: 'macho',
    architectures: ['aarch64'],
  });
  assert.deepEqual(inspectExecutable(macho(0x01000007)).architectures, ['x86_64']);
});

test('ZIP inspection rejects traversal and links before extraction', () => {
  assert.deepEqual(inspectZipArchive(centralDirectory(['safe/tool'])), ['safe/tool']);
  assert.throws(() => inspectZipArchive(centralDirectory(['../outside'])), /unsafe/);
  assert.throws(
    () => inspectZipArchive(centralDirectory(['safe/link'], [0o120777])),
    /link or special file/,
  );
});

test('unsupported platform pairs are refused without downloading', async () => {
  await assert.rejects(
    preparePlatformTools({ platform: 'linux', architecture: 'arm64' }),
    /Unsupported platform\/architecture/,
  );
});

test('platform tool downloads retry transient failures and retain integrity checks', async () => {
  const bytes = Buffer.from('verified download');
  const spec = {
    url: 'https://files.pythonhosted.org/packages/test.bin',
    sha256: '636a193cc46913f6e164b8428da57752de7db348e95903e5f0e3c2e66a300525',
    maxBytes: 1_024,
  };
  const delays = [];
  let attempts = 0;
  const result = await download(spec, 'Test asset', {
    cacheDir: null,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
        });
      }
      if (attempts === 2) {
        return {
          ok: true,
          body: {
            async *[Symbol.asyncIterator]() {
              yield Buffer.from('partial');
              throw new TypeError('terminated', {
                cause: Object.assign(new Error('socket disconnected'), {
                  code: 'UND_ERR_SOCKET',
                }),
              });
            },
          },
          headers: new Headers(),
          url: spec.url,
        };
      }
      const response = new Response(bytes, {
        headers: { 'content-length': String(bytes.length) },
      });
      Object.defineProperty(response, 'url', { value: spec.url });
      return response;
    },
    jitterRatio: 0,
    retryDelaysMs: [10, 20],
    waitForRetry: async (delay) => delays.push(delay),
  });

  assert.deepEqual(result, bytes);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test('platform tool download failures identify the asset and network cause', async () => {
  const spec = {
    url: 'https://files.pythonhosted.org/packages/test.bin',
    sha256: '0'.repeat(64),
    maxBytes: 1_024,
  };
  let attempts = 0;

  await assert.rejects(
    download(spec, 'GPL test license', {
      cacheDir: null,
      fetchImpl: async () => {
        attempts += 1;
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('socket disconnected'), { code: 'UND_ERR_SOCKET' }),
        });
      },
      jitterRatio: 0,
      retryDelaysMs: [1, 2, 3, 4],
      waitForRetry: async () => {},
    }),
    /GPL test license download failed after 5 attempts: fetch failed — UND_ERR_SOCKET — socket disconnected/,
  );
  assert.equal(attempts, 5);
});

test('platform tool downloads do not retry integrity failures', async () => {
  const bytes = Buffer.from('tampered download');
  const spec = {
    url: 'https://files.pythonhosted.org/packages/test.bin',
    sha256: '0'.repeat(64),
    maxBytes: 1_024,
  };
  let attempts = 0;

  await assert.rejects(
    download(spec, 'Test asset', {
      cacheDir: null,
      fetchImpl: async () => {
        attempts += 1;
        const response = new Response(bytes);
        Object.defineProperty(response, 'url', { value: spec.url });
        return response;
      },
      waitForRetry: async () => {},
    }),
    /SHA-256 mismatch/,
  );
  assert.equal(attempts, 1);
});

test('the immutable GPL license is bundled and integrity-pinned', async () => {
  const license = await readFile(new URL('./assets/GPL-3.0.txt', import.meta.url));
  assert.equal(
    createHash('sha256').update(license).digest('hex'),
    '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986',
  );
  const implementation = await readFile(
    new URL('./prepare-platform-tools.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(implementation, /gnu\.org/);
});

test('the immutable GPL v2 license is bundled for the macOS FFmpeg build', async () => {
  const bytes = await readFile(new URL('./assets/GPL-2.0.txt', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643',
  );
  const implementation = await readFile(
    new URL('./prepare-platform-tools.mjs', import.meta.url),
    'utf8',
  );
  assert.match(implementation, /license: 'GPL-2\.0-or-later'/);
  assert.match(implementation, /licenseFile: 'GPL-2\.0\.txt'/);
});

test('redistributed platform tools include immutable local license texts', async () => {
  const [sevenZipLicense, appImageRuntimeLicense, windowsManifest] = await Promise.all([
    readFile(new URL('./assets/7-Zip-License.txt', import.meta.url)),
    readFile(new URL('./assets/AppImage-type2-runtime-LICENSE.txt', import.meta.url)),
    readFile(new URL('./assets/windows-platform-tools.json', import.meta.url), 'utf8'),
  ]);
  assert.equal(
    createHash('sha256').update(sevenZipLicense).digest('hex'),
    '477e15d4033026edb25d36c9f078bb0beafc9318f6505473648972a536ece263',
  );
  assert.equal(
    createHash('sha256').update(appImageRuntimeLicense).digest('hex'),
    'aa154fc9070614bbe7921f89db11efd1dba7a1f3a41685958110e2230f9c0ca1',
  );
  const manifest = JSON.parse(windowsManifest);
  assert.equal(manifest.tools.ffmpeg.version, '8.1-essentials_build-www.gyan.dev');
  assert.equal(manifest.tools.sevenZip.version, '25.01');
});
