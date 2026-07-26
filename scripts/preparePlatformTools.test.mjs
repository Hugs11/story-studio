import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
