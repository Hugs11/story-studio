#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { arch as hostArch, platform as hostPlatform } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  inspectExecutable,
  validateExecutable,
} from './native-executable.mjs';
import { validatePiperRuntime } from './piper-runtime.mjs';
import { verifiedDownload } from './verified-download.mjs';

export { inspectExecutable };

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const TOOLS_ROOT = join(REPO_ROOT, 'src-tauri', 'tools');
const NOTICES_PATH = join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md');
const DOWNLOAD_CACHE = join(TOOLS_ROOT, '.download-cache');
const GPL2_LICENSE_PATH = join(SCRIPT_DIR, 'assets', 'GPL-2.0.txt');
const GPL_LICENSE_PATH = join(SCRIPT_DIR, 'assets', 'GPL-3.0.txt');
const MAX_ARCHIVE_ENTRIES = 4096;
const MAX_COMMAND_OUTPUT = 256 * 1024 * 1024;

const GPL_LICENSE = {
  sha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986',
  maxBytes: 64 * 1024,
};
const GPL2_LICENSE = {
  sha256: '8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643',
  maxBytes: 32 * 1024,
};

export const PLATFORM_MANIFEST = {
  'win32-x64': {
    platformName: 'windows-x86_64',
    generated: false,
    tools: [
      {
        name: 'ffmpeg',
        path: 'ffmpeg.exe',
        format: 'pe',
        architectures: ['x86_64'],
        sha256: '1a65d5b0b10d8d9a81d2824a3538046a40ed3607c906b335a166add87613f705',
        versionPattern: /ffmpeg version 8\.1/,
      },
      {
        name: '7-Zip',
        path: '7z.exe',
        format: 'pe',
        // Le binaire console historique 25.01 est x86 et reste compatible x64.
        architectures: ['x86'],
        sha256: '26817725650583d99ca3e617a618dd75c0f71bd316b5761780b7361f5f824cad',
        versionPattern: /7-Zip.*25\.01/s,
      },
    ],
  },
  'linux-x64': {
    platformName: 'linux-x86_64',
    generated: true,
    ffmpeg: {
      archive: {
        url: 'https://files.pythonhosted.org/packages/a0/2d/43c8522a2038e9d0e7dbdf3a61195ecc31ca576fb1527a528c877e87d973/imageio_ffmpeg-0.6.0-py3-none-manylinux2014_x86_64.whl',
        sha256: 'c7e46fcec401dd990405049d2e2f475e2b397779df2519b544b8aab515195282',
        maxBytes: 40 * 1024 * 1024,
        type: 'zip',
      },
      member: 'imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2',
      licenseMember: 'imageio_ffmpeg-0.6.0.dist-info/LICENSE',
      binarySha256: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
      version: '7.0.2-static',
      license: 'GPL-3.0-or-later',
      licenseFile: 'GPL-3.0.txt',
      format: 'elf',
      architectures: ['x86_64'],
      provenance: 'imageio-ffmpeg 0.6.0 wheel; binary built by johnvansickle.com',
    },
    sevenZip: {
      archive: {
        url: 'https://www.7-zip.org/a/7z2501-linux-x64.tar.xz',
        sha256: '4ca3b7c6f2f67866b92622818b58233dc70367be2f36b498eb0bdeaaa44b53f4',
        maxBytes: 4 * 1024 * 1024,
        type: 'tar.xz',
      },
      member: '7zz',
      licenseMember: 'License.txt',
      binarySha256: 'a1860fdf0d6ec395e0e277e5222e9aa488747db4aa5c87d1ec879a0916ba0b2f',
      version: '25.01',
      format: 'elf',
      architectures: ['x86_64'],
    },
  },
  'darwin-arm64': {
    platformName: 'macos-aarch64',
    generated: true,
    ffmpeg: {
      archive: {
        url: 'https://files.pythonhosted.org/packages/40/5c/f3d8a657d362cc93b81aab8feda487317da5b5d31c0e1fdfd5e986e55d17/imageio_ffmpeg-0.6.0-py3-none-macosx_11_0_arm64.whl',
        sha256: 'b1ae3173414b5fc5f538a726c4e48ea97edc0d2cdc11f103afee655c463fa742',
        maxBytes: 32 * 1024 * 1024,
        type: 'zip',
      },
      member: 'imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1',
      licenseMember: 'imageio_ffmpeg-0.6.0.dist-info/LICENSE',
      binarySha256: '6d175a4743ca50256e89a8cdd731100f9cee33bd79aeea46894d209410dc6617',
      version: '7.1',
      license: 'GPL-2.0-or-later',
      licenseFile: 'GPL-2.0.txt',
      format: 'macho',
      architectures: ['aarch64'],
      provenance: 'imageio-ffmpeg 0.6.0 wheel; native Apple Silicon build from osxexperts.net',
    },
    sevenZip: {
      archive: {
        url: 'https://www.7-zip.org/a/7z2501-mac.tar.xz',
        sha256: '26aa75bc262bb10bf0805617b95569c3035c2c590a99f7db55c7e9607b2685e0',
        maxBytes: 8 * 1024 * 1024,
        type: 'tar.xz',
      },
      member: '7zz',
      licenseMember: 'License.txt',
      binarySha256: '5c2fd36f00a66f7787dcf1badd977d44a02b50063fe5678e1f19ff64797432ed',
      version: '25.01',
      format: 'macho',
      architectures: ['aarch64'],
    },
  },
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertSafeArchivePath(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/')) {
    throw new Error(`Archive path is unsafe: ${JSON.stringify(name)}`);
  }
  const cleanName = name.endsWith('/') ? name.slice(0, -1) : name;
  const normalized = posix.normalize(cleanName);
  if (
    normalized === '..'
    || normalized.startsWith('../')
    || normalized !== cleanName
  ) {
    throw new Error(`Archive path is unsafe: ${JSON.stringify(name)}`);
  }
}

export function inspectZipArchive(bytes) {
  const minimumEocd = 22;
  const start = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - minimumEocd; offset >= start; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP archive has no valid end record.');

  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('ZIP archive has too many entries.');
  if (centralOffset + centralSize > bytes.length) throw new Error('ZIP central directory is truncated.');

  const names = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('ZIP central directory entry is invalid.');
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize) throw new Error('ZIP central directory is truncated.');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assertSafeArchivePath(name);
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0o170000;
    if (fileType && ![0o040000, 0o100000].includes(fileType)) {
      throw new Error(`ZIP archive contains a link or special file: ${name}`);
    }
    names.push(name);
    offset = next;
  }
  return names;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding === 'buffer' ? null : (options.encoding ?? 'utf8'),
    maxBuffer: options.maxBuffer ?? MAX_COMMAND_OUTPUT,
    cwd: options.cwd,
    env: options.env,
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`${command} failed (${result.status}): ${stderr}`);
  }
  return result.stdout;
}

export async function download(spec, label, options = {}) {
  const allowedHosts = [
    'files.pythonhosted.org',
    'www.7-zip.org',
    'd.7-zip.org',
  ];
  return verifiedDownload(spec, label, {
    allowedHosts,
    cacheDir: DOWNLOAD_CACHE,
    userAgent: 'Story-Studio-platform-tools',
    ...options,
  });
}

async function readBundledGplLicense() {
  const bytes = await readFile(GPL_LICENSE_PATH);
  if (!bytes.length || bytes.length > GPL_LICENSE.maxBytes) {
    throw new Error('Bundled GPL v3 license has an invalid size.');
  }
  if (sha256(bytes) !== GPL_LICENSE.sha256) {
    throw new Error('Bundled GPL v3 license SHA-256 mismatch.');
  }
  return bytes;
}

async function readBundledGpl2License() {
  const bytes = await readFile(GPL2_LICENSE_PATH);
  if (!bytes.length || bytes.length > GPL2_LICENSE.maxBytes) {
    throw new Error('Bundled GPL v2 license has an invalid size.');
  }
  if (sha256(bytes) !== GPL2_LICENSE.sha256) {
    throw new Error('Bundled GPL v2 license SHA-256 mismatch.');
  }
  return bytes;
}

async function withArchive(bytes, archiveSpec, action) {
  const tempDir = join(TOOLS_ROOT, `.prepare-${randomUUID()}`);
  const extension = archiveSpec.type === 'zip' ? 'zip' : 'tar.xz';
  const archivePath = join(tempDir, `archive.${extension}`);
  await mkdir(tempDir, { recursive: true });
  try {
    await writeFile(archivePath, bytes);
    return await action(archivePath, bytes);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function inspectTarArchive(archivePath) {
  const namesOutput = run('tar', ['-tJf', archivePath]);
  const verboseOutput = run('tar', ['-tJvf', archivePath]);
  const names = namesOutput.split(/\r?\n/).filter(Boolean);
  const verboseLines = verboseOutput.split(/\r?\n/).filter(Boolean);
  if (names.length > MAX_ARCHIVE_ENTRIES || names.length !== verboseLines.length) {
    throw new Error('tar archive entry count is invalid.');
  }
  names.forEach(assertSafeArchivePath);
  for (const line of verboseLines) {
    if (!['-', 'd'].includes(line[0])) {
      throw new Error('tar archive contains a link or special file.');
    }
  }
  return names;
}

function extractMember(archivePath, archiveType, member, archiveBytes) {
  assertSafeArchivePath(member);
  if (archiveType === 'zip') {
    const names = inspectZipArchive(archiveBytes);
    if (!names.includes(member)) throw new Error(`ZIP archive is missing ${member}.`);
    return run('unzip', ['-p', archivePath, member], { encoding: 'buffer' });
  }
  const names = inspectTarArchive(archivePath);
  if (!names.includes(member)) throw new Error(`tar archive is missing ${member}.`);
  return run('tar', ['-xJOf', archivePath, member], { encoding: 'buffer' });
}

async function preserveExistingPiperRuntime(
  destination,
  staging,
  platform,
  architecture,
) {
  const existing = join(destination, 'piper');
  try {
    const metadata = await stat(existing);
    if (!metadata.isDirectory()) throw new Error('Existing Piper runtime is not a directory.');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  await validatePiperRuntime(existing, { platform, architecture });
  await cp(existing, join(staging, 'piper'), {
    recursive: true,
    errorOnExist: true,
  });
  return true;
}

async function validateOptionalPiperRuntime(platformName, platform, architecture) {
  const runtime = join(TOOLS_ROOT, platformName, 'piper');
  try {
    await validatePiperRuntime(runtime, { platform, architecture });
    process.stdout.write(`Validated existing Piper runtime in ${runtime}.\n`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function prepareGeneratedPlatform(config, platform, architecture) {
  const destination = join(TOOLS_ROOT, config.platformName);
  const staging = join(TOOLS_ROOT, `.${config.platformName}-installing-${randomUUID()}`);
  await mkdir(join(staging, 'licenses'), { recursive: true });

  try {
    const [ffmpegArchive, sevenZipArchive, gplLicense] = await Promise.all([
      download(config.ffmpeg.archive, 'FFmpeg'),
      download(config.sevenZip.archive, '7-Zip'),
      config.ffmpeg.licenseFile === 'GPL-2.0.txt'
        ? readBundledGpl2License()
        : readBundledGplLicense(),
    ]);

    const ffmpegFiles = await withArchive(
      ffmpegArchive,
      config.ffmpeg.archive,
      async (archivePath, archiveBytes) => ({
        binary: extractMember(
          archivePath,
          config.ffmpeg.archive.type,
          config.ffmpeg.member,
          archiveBytes,
        ),
        license: extractMember(
          archivePath,
          config.ffmpeg.archive.type,
          config.ffmpeg.licenseMember,
          archiveBytes,
        ),
      }),
    );
    const sevenZipFiles = await withArchive(
      sevenZipArchive,
      config.sevenZip.archive,
      async (archivePath, archiveBytes) => ({
        binary: extractMember(
          archivePath,
          config.sevenZip.archive.type,
          config.sevenZip.member,
          archiveBytes,
        ),
        license: extractMember(
          archivePath,
          config.sevenZip.archive.type,
          config.sevenZip.licenseMember,
          archiveBytes,
        ),
      }),
    );

    if (sha256(ffmpegFiles.binary) !== config.ffmpeg.binarySha256) {
      throw new Error('Extracted FFmpeg binary SHA-256 mismatch.');
    }
    if (sha256(sevenZipFiles.binary) !== config.sevenZip.binarySha256) {
      throw new Error('Extracted 7-Zip binary SHA-256 mismatch.');
    }
    validateExecutable(ffmpegFiles.binary, config.ffmpeg);
    validateExecutable(sevenZipFiles.binary, config.sevenZip);

    const ffmpegPath = join(staging, 'ffmpeg');
    const sevenZipPath = join(staging, '7zz');
    await writeFile(ffmpegPath, ffmpegFiles.binary);
    await writeFile(sevenZipPath, sevenZipFiles.binary);
    await writeFile(join(staging, 'licenses', config.ffmpeg.licenseFile), gplLicense);
    await writeFile(
      join(staging, 'licenses', 'imageio-ffmpeg-LICENSE.txt'),
      ffmpegFiles.license,
    );
    await writeFile(join(staging, 'licenses', '7-Zip-License.txt'), sevenZipFiles.license);
    await chmod(ffmpegPath, 0o755);
    await chmod(sevenZipPath, 0o755);

    validateFfmpegRuntime(ffmpegPath, config.ffmpeg.version);
    validateSevenZipRuntime(sevenZipPath, config.sevenZip.version);
    if (hostPlatform() === 'darwin') {
      validateMacDependencies(ffmpegPath);
      validateMacDependencies(sevenZipPath);
    }

    const manifest = {
      platform: config.platformName,
      generatedAt: new Date().toISOString(),
      tools: {
        ffmpeg: {
          version: config.ffmpeg.version,
          provenance: config.ffmpeg.provenance,
          archiveUrl: config.ffmpeg.archive.url,
          archiveSha256: config.ffmpeg.archive.sha256,
          binarySha256: config.ffmpeg.binarySha256,
          license: config.ffmpeg.license,
        },
        sevenZip: {
          version: config.sevenZip.version,
          provenance: 'Official 7-Zip console archive',
          archiveUrl: config.sevenZip.archive.url,
          archiveSha256: config.sevenZip.archive.sha256,
          binarySha256: config.sevenZip.binarySha256,
          license: 'LGPL-2.1-or-later AND BSD-3-Clause AND LicenseRef-unRAR-restriction',
        },
      },
    };
    await writeFile(
      join(staging, 'platform-tools.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const preservedPiper = await preserveExistingPiperRuntime(
      destination,
      staging,
      platform,
      architecture,
    );

    const old = join(TOOLS_ROOT, `.${config.platformName}-old-${randomUUID()}`);
    let hadDestination = false;
    try {
      await rename(destination, old);
      hadDestination = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (hadDestination) await rename(old, destination);
      throw error;
    }
    if (hadDestination) await rm(old, { recursive: true, force: true });
    process.stdout.write(`Prepared ${config.platformName} tools in ${destination}.\n`);
    if (preservedPiper) process.stdout.write('Preserved validated Piper runtime.\n');
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function validateFfmpegRuntime(path, expectedVersion) {
  const version = run(path, ['-version']);
  if (!version.includes(`ffmpeg version ${expectedVersion}`)) {
    throw new Error(`Unexpected FFmpeg version: ${version.split(/\r?\n/, 1)[0]}`);
  }
  const encoders = run(path, ['-hide_banner', '-encoders']);
  if (!/\blibmp3lame\b/.test(encoders) || !/^\s*A.*\baac\b/m.test(encoders)) {
    throw new Error('FFmpeg is missing required MP3/AAC encoders.');
  }
  const demuxers = run(path, ['-hide_banner', '-demuxers']);
  for (const demuxer of ['wav', 'mp3', 'ogg', 'mov,mp4,m4a']) {
    if (!demuxers.includes(demuxer)) throw new Error(`FFmpeg is missing ${demuxer} demuxing.`);
  }
}

function validateSevenZipRuntime(path, expectedVersion) {
  const output = run(path, ['i']);
  if (!output.includes(`7-Zip (z) ${expectedVersion}`)) {
    throw new Error('Unexpected 7-Zip version.');
  }
}

function validateMacDependencies(path) {
  const output = run('otool', ['-L', path]);
  if (/\/opt\/homebrew|\/usr\/local|Cellar/.test(output)) {
    throw new Error(`${path} depends on a developer/Homebrew path.`);
  }
}

async function validateTrackedWindows(config) {
  for (const tool of config.tools) {
    const path = join(TOOLS_ROOT, tool.path);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`${tool.path} is not a regular file.`);
    const bytes = await readFile(path);
    if (sha256(bytes) !== tool.sha256) throw new Error(`${tool.path} SHA-256 mismatch.`);
    validateExecutable(bytes, tool);
    const output = tool.name === 'ffmpeg'
      ? run(path, ['-version'])
      : run(path, ['i']);
    if (!tool.versionPattern.test(output)) throw new Error(`${tool.path} version mismatch.`);
  }
  process.stdout.write('Validated historical Windows tools.\n');
}

async function validateNotices(config) {
  const notices = await readFile(NOTICES_PATH, 'utf8');
  const required = config.generated
    ? [
        config.ffmpeg.archive.url,
        config.ffmpeg.archive.sha256,
        config.sevenZip.archive.url,
        config.sevenZip.archive.sha256,
      ]
    : config.tools.flatMap((tool) => [tool.path, tool.sha256]);
  for (const marker of required) {
    if (!notices.includes(marker)) {
      throw new Error(`THIRD_PARTY_NOTICES.md is missing ${marker}.`);
    }
  }
}

export async function preparePlatformTools({
  platform = hostPlatform(),
  architecture = hostArch(),
} = {}) {
  const key = `${platform}-${architecture}`;
  const config = PLATFORM_MANIFEST[key];
  if (!config) {
    throw new Error(
      `Unsupported platform/architecture: ${platform}/${architecture}. `
      + 'Supported: win32/x64, linux/x64, darwin/arm64.',
    );
  }
  await validateNotices(config);
  if (config.generated) await prepareGeneratedPlatform(config, platform, architecture);
  else {
    await validateTrackedWindows(config);
    await validateOptionalPiperRuntime(
      config.platformName,
      platform,
      architecture,
    );
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  preparePlatformTools().catch((error) => {
    process.stderr.write(`Platform tool preparation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
