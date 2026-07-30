#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  arch as hostArch,
  platform as hostPlatform,
  tmpdir,
} from 'node:os';
import {
  dirname,
  join,
  posix,
  resolve,
  sep,
  win32,
} from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ESPEAK_COMMIT,
  ONNXRUNTIME_VERSION,
  PIPER_BUILD_INPUTS,
  PIPER_COMMIT,
  PIPER_TARGETS,
  PIPER_VERSION,
  PIPER_VOICES_VERSION,
  SONIC_COMMIT,
  selectPiperTarget,
} from './piper-runtime-manifest.mjs';
import {
  sha256,
  validatePiperRuntime,
} from './piper-runtime.mjs';
import {
  verifiedDownload,
  verifiedDownloadCachePath,
} from './verified-download.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const TOOLS_ROOT = join(REPO_ROOT, 'src-tauri', 'tools');
const PATCH_PATH = join(SCRIPT_DIR, 'patches', 'piper-1.6.0-story-studio.patch');
const NOTICES_PATH = join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md');
const DOWNLOAD_CACHE = join(TOOLS_ROOT, '.download-cache');
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;

export function piperBuildRoot({
  repositoryRoot = REPO_ROOT,
  platform = hostPlatform(),
  temporaryRoot = platform === 'win32' ? tmpdir() : '/tmp',
} = {}) {
  const repositoryKey = createHash('sha256')
    .update(resolve(repositoryRoot))
    .digest('hex')
    .slice(0, 8);
  // eSpeak NG uses a fixed 160-byte data path buffer on POSIX while compiling
  // phonemes. Keep intermediates short even when the repository path is long.
  const joinForTarget = platform === 'win32' ? win32.join : posix.join;
  return joinForTarget(temporaryRoot, `story-studio-piper-${repositoryKey}`);
}

function cmakePath(path) {
  return sep === '\\' ? path.replaceAll('\\', '/') : path;
}

function relatedTool(command, sibling) {
  if (!command.includes('/') && !command.includes('\\')) return sibling;
  const extension = command.toLowerCase().endsWith('.exe') ? '.exe' : '';
  return join(dirname(command), `${sibling}${extension}`);
}

function run(command, args, {
  capture = false,
  cwd,
  env,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout).trim() : '';
    throw new Error(
      `${command} failed with exit code ${result.status}${detail ? `: ${detail}` : ''}.`,
    );
  }
  return capture ? result.stdout : '';
}

function isAllowedDownloadHost(hostname) {
  return [
    'codeload.github.com',
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
  ].includes(hostname)
    || hostname === 'huggingface.co'
    || hostname.endsWith('.huggingface.co')
    || hostname.endsWith('.hf.co');
}

async function cachedDownload(spec) {
  await verifiedDownload(spec, spec.filename, {
    allowedHosts: isAllowedDownloadHost,
    cacheDir: DOWNLOAD_CACHE,
    timeoutMs: 180_000,
    userAgent: 'Story-Studio-Piper-runtime-builder',
  });
  return verifiedDownloadCachePath(spec, DOWNLOAD_CACHE);
}

async function validatePublicNotices(target) {
  const notices = await readFile(NOTICES_PATH, 'utf8');
  const required = [
    PIPER_BUILD_INPUTS.piper.url,
    PIPER_BUILD_INPUTS.piper.sha256,
    PIPER_BUILD_INPUTS.espeak.url,
    PIPER_BUILD_INPUTS.espeak.sha256,
    PIPER_BUILD_INPUTS.sonic.url,
    PIPER_BUILD_INPUTS.sonic.sha256,
    target.onnxruntime.url,
    target.onnxruntime.sha256,
    'scripts/patches/piper-1.6.0-story-studio.patch',
  ];
  for (const marker of required) {
    if (!notices.includes(marker)) {
      throw new Error(`THIRD_PARTY_NOTICES.md is missing ${marker}.`);
    }
  }
}

export function assertSafeArchiveEntries(entries, expectedRoot) {
  if (!entries.length || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('Archive entry count is invalid.');
  }
  for (const name of entries) {
    if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/')) {
      throw new Error(`Archive path is unsafe: ${JSON.stringify(name)}`);
    }
    const cleanName = name.endsWith('/') ? name.slice(0, -1) : name;
    const normalized = posix.normalize(cleanName);
    if (
      normalized === '..'
      || normalized.startsWith('../')
      || normalized !== cleanName
      || (normalized !== expectedRoot && !normalized.startsWith(`${expectedRoot}/`))
    ) {
      throw new Error(`Archive path is unsafe: ${JSON.stringify(name)}`);
    }
  }
}

async function extractVerifiedArchive(cmake, archivePath, spec, destination) {
  const listing = run(cmake, ['-E', 'tar', 'tf', archivePath], { capture: true });
  const entries = listing.split(/\r?\n/).filter(Boolean);
  assertSafeArchiveEntries(entries, spec.rootDirectory);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run(cmake, ['-E', 'tar', 'xf', archivePath], { cwd: destination });
  const root = join(destination, spec.rootDirectory);
  const metadata = await stat(root);
  if (!metadata.isDirectory()) {
    throw new Error(`${spec.filename} did not extract its expected root directory.`);
  }
  return root;
}

async function copyRuntimeFiles(installDir, staging, target) {
  for (const { installed, output } of target.runtimeFiles) {
    const source = join(installDir, installed);
    const metadata = await stat(source);
    if (!metadata.isFile()) throw new Error(`Installed Piper file is missing: ${installed}`);
    await copyFile(source, join(staging, output));
  }
  await cp(join(installDir, 'espeak-ng-data'), join(staging, 'espeak-ng-data'), {
    recursive: true,
    errorOnExist: true,
  });
  if (target.format !== 'pe') {
    await chmod(join(staging, target.executable), 0o755);
  }
}

async function copyLicenses(staging, piperSource, espeakSource, onnxSource) {
  const licenses = join(staging, 'licenses');
  await mkdir(licenses, { recursive: true });
  const files = [
    [join(piperSource, 'COPYING'), 'Piper-GPL-3.0.txt'],
    [join(espeakSource, 'COPYING'), 'eSpeak-NG-GPL-3.0.txt'],
    [join(espeakSource, 'COPYING.APACHE'), 'eSpeak-NG-Apache-2.0.txt'],
    [join(espeakSource, 'COPYING.BSD2'), 'eSpeak-NG-BSD-2-Clause.txt'],
    [join(espeakSource, 'COPYING.UCD'), 'eSpeak-NG-UCD.txt'],
    [join(onnxSource, 'LICENSE'), 'ONNX-Runtime-LICENSE.txt'],
    [
      join(onnxSource, 'ThirdPartyNotices.txt'),
      'ONNX-Runtime-ThirdPartyNotices.txt',
    ],
  ];
  for (const [source, output] of files) {
    await copyFile(source, join(licenses, output));
  }
}

async function hashRuntimeFiles(staging, target) {
  const hashes = {};
  for (const { output } of target.runtimeFiles) {
    const bytes = await readFile(join(staging, output));
    hashes[output] = { sha256: sha256(bytes), bytes: bytes.length };
  }
  return hashes;
}

async function activateRuntime(staging, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const old = join(TOOLS_ROOT, `.piper-runtime-old-${randomUUID()}`);
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
}

async function prepareSources(cmake, workspace, target) {
  const artifacts = {
    piper: PIPER_BUILD_INPUTS.piper,
    espeak: PIPER_BUILD_INPUTS.espeak,
    sonic: PIPER_BUILD_INPUTS.sonic,
    googletest: PIPER_BUILD_INPUTS.googletest,
    onnxruntime: target.onnxruntime,
  };
  const downloaded = {};
  for (const [name, spec] of Object.entries(artifacts)) {
    downloaded[name] = await cachedDownload(spec);
  }
  const testModel = await cachedDownload(PIPER_BUILD_INPUTS.testModel);
  const testModelConfig = await cachedDownload(PIPER_BUILD_INPUTS.testModelConfig);

  const sourcesRoot = join(workspace, 'sources');
  const piperSource = await extractVerifiedArchive(
    cmake,
    downloaded.piper,
    artifacts.piper,
    join(sourcesRoot, 'piper'),
  );
  const espeakSource = await extractVerifiedArchive(
    cmake,
    downloaded.espeak,
    artifacts.espeak,
    join(sourcesRoot, 'espeak'),
  );
  const googletestSource = await extractVerifiedArchive(
    cmake,
    downloaded.googletest,
    artifacts.googletest,
    join(sourcesRoot, 'googletest'),
  );
  const sonicSource = await extractVerifiedArchive(
    cmake,
    downloaded.sonic,
    artifacts.sonic,
    join(sourcesRoot, 'sonic'),
  );
  const onnxSource = await extractVerifiedArchive(
    cmake,
    downloaded.onnxruntime,
    artifacts.onnxruntime,
    join(sourcesRoot, 'onnxruntime'),
  );

  const modelDir = join(workspace, 'test-model');
  await mkdir(modelDir, { recursive: true });
  await copyFile(testModel, join(modelDir, 'model.onnx'));
  await copyFile(testModelConfig, join(modelDir, 'model.onnx.json'));

  const isolatedGitEnvironment = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: dirname(piperSource),
  };
  run(process.env.PIPER_GIT || 'git', [
    'apply',
    '--no-index',
    '--check',
    '--unidiff-zero',
    '--recount',
    '--whitespace=error-all',
    PATCH_PATH,
  ], { cwd: piperSource, env: isolatedGitEnvironment });
  run(process.env.PIPER_GIT || 'git', [
    'apply',
    '--no-index',
    '--unidiff-zero',
    '--recount',
    '--whitespace=error-all',
    PATCH_PATH,
  ], { cwd: piperSource, env: isolatedGitEnvironment });

  const patchedCmake = await readFile(join(piperSource, 'libpiper', 'CMakeLists.txt'), 'utf8');
  const patchedWav = await readFile(
    join(piperSource, 'libpiper', 'src', 'main', 'utils', 'wavfile.cpp'),
    'utf8',
  );
  if (
    !patchedCmake.includes('PIPER_ESPEAK_SOURCE_DIR')
    || !patchedCmake.includes('PIPER_SONIC_SOURCE_DIR')
    || !patchedWav.includes('normalizeAudioSamples')
  ) {
    throw new Error('Piper Story Studio patch was not applied completely.');
  }

  return {
    piperSource,
    espeakSource,
    sonicSource,
    googletestSource,
    onnxSource,
    modelDir,
  };
}

async function writeRuntimeManifest(staging, key, target, runtimeFiles) {
  const patchBytes = await readFile(PATCH_PATH);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    piper: {
      version: PIPER_VERSION,
      commit: PIPER_COMMIT,
      license: 'GPL-3.0-or-later',
      source: {
        url: PIPER_BUILD_INPUTS.piper.url,
        sha256: PIPER_BUILD_INPUTS.piper.sha256,
      },
      patch: {
        path: 'scripts/patches/piper-1.6.0-story-studio.patch',
        sha256: sha256(patchBytes),
        purpose: 'Offline dependency injection and normalized C++ CLI WAV output',
      },
    },
    dependencies: {
      espeakNg: {
        commit: ESPEAK_COMMIT,
        url: PIPER_BUILD_INPUTS.espeak.url,
        sha256: PIPER_BUILD_INPUTS.espeak.sha256,
        license: 'GPL-3.0-or-later with additional bundled-data licenses',
      },
      sonic: {
        commit: SONIC_COMMIT,
        url: PIPER_BUILD_INPUTS.sonic.url,
        sha256: PIPER_BUILD_INPUTS.sonic.sha256,
        usage: 'eSpeak NG build input only; runtime integration disabled',
      },
      onnxRuntime: {
        version: ONNXRUNTIME_VERSION,
        url: target.onnxruntime.url,
        sha256: target.onnxruntime.sha256,
        license: 'MIT',
      },
      googletest: {
        version: '1.17.0',
        url: PIPER_BUILD_INPUTS.googletest.url,
        sha256: PIPER_BUILD_INPUTS.googletest.sha256,
        usage: 'build tests only',
      },
      testVoice: {
        version: PIPER_VOICES_VERSION,
        modelUrl: PIPER_BUILD_INPUTS.testModel.url,
        modelSha256: PIPER_BUILD_INPUTS.testModel.sha256,
        configUrl: PIPER_BUILD_INPUTS.testModelConfig.url,
        configSha256: PIPER_BUILD_INPUTS.testModelConfig.sha256,
        usage: 'build tests only; not distributed',
      },
    },
    target: {
      key,
      platformName: target.platformName,
      format: target.format,
      architectures: target.architectures,
    },
    runtimeFiles,
  };
  await writeFile(
    join(staging, 'piper-runtime.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export async function buildPiperRuntime({
  platform = hostPlatform(),
  architecture = hostArch(),
} = {}) {
  const { key, target } = selectPiperTarget(platform, architecture);
  const cmake = process.env.PIPER_CMAKE || 'cmake';
  const ctest = process.env.PIPER_CTEST || relatedTool(cmake, 'ctest');
  const workspace = join(piperBuildRoot(), target.platformName);
  const buildDir = join(workspace, 'build');
  const installDir = join(workspace, 'install');
  const staging = join(TOOLS_ROOT, `.piper runtime installing-${randomUUID()}`);
  const destination = join(TOOLS_ROOT, target.platformName, 'piper');

  await validatePublicNotices(target);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const sources = await prepareSources(cmake, workspace, target);
  const configureArgs = [
    '-S',
    cmakePath(join(sources.piperSource, 'libpiper')),
    '-B',
    cmakePath(buildDir),
    '-G',
    target.generator,
    ...target.generatorArgs,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_INSTALL_PREFIX=${cmakePath(installDir)}`,
    '-DCMAKE_INSTALL_BINDIR=.',
    '-DCMAKE_INSTALL_LIBDIR=.',
    '-DPIPER_BUILD_TESTS=ON',
    '-DFETCHCONTENT_FULLY_DISCONNECTED=ON',
    `-DPIPER_ESPEAK_SOURCE_DIR=${cmakePath(sources.espeakSource)}`,
    `-DPIPER_SONIC_SOURCE_DIR=${cmakePath(sources.sonicSource)}`,
    `-DONNXRUNTIME_DIR=${cmakePath(sources.onnxSource)}`,
    `-DFETCHCONTENT_SOURCE_DIR_GOOGLETEST=${cmakePath(sources.googletestSource)}`,
    `-DPIPER_TEST_MODEL_DIR=${cmakePath(sources.modelDir)}`,
  ];
  if (target.installRpath) {
    configureArgs.push(`-DCMAKE_INSTALL_RPATH=${target.installRpath}`);
  }

  process.stdout.write(`Configuring Piper ${PIPER_VERSION} for ${target.platformName}…\n`);
  run(cmake, configureArgs);
  run(cmake, ['--build', buildDir, '--config', 'Release', '--parallel']);
  run(ctest, [
    '--test-dir',
    buildDir,
    '-C',
    'Release',
    '--output-on-failure',
  ]);
  run(cmake, ['--install', buildDir, '--config', 'Release']);

  await mkdir(staging, { recursive: true });
  try {
    await copyRuntimeFiles(installDir, staging, target);
    await copyLicenses(
      staging,
      sources.piperSource,
      sources.espeakSource,
      sources.onnxSource,
    );
    const runtimeFiles = await hashRuntimeFiles(staging, target);
    await writeRuntimeManifest(staging, key, target, runtimeFiles);
    await validatePiperRuntime(staging, {
      platform,
      architecture,
      forbiddenPaths: [
        sources.piperSource,
        sources.espeakSource,
        sources.sonicSource,
        sources.onnxSource,
        buildDir,
        installDir,
      ],
    });
    await activateRuntime(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  await validatePiperRuntime(destination, {
    platform,
    architecture,
    forbiddenPaths: [
      sources.piperSource,
      sources.espeakSource,
      sources.sonicSource,
      sources.onnxSource,
      buildDir,
      installDir,
    ],
  });
  process.stdout.write(`Prepared Piper runtime in ${destination}.\n`);
  return destination;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  buildPiperRuntime().catch((error) => {
    process.stderr.write(`Piper runtime build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export { PIPER_TARGETS };
