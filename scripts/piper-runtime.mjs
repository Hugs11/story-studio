import { createHash } from 'node:crypto';
import {
  access,
  readFile,
  readdir,
  stat,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { arch as hostArch, platform as hostPlatform } from 'node:os';
import {
  basename,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateExecutable } from './native-executable.mjs';
import {
  PIPER_COMMIT,
  PIPER_VERSION,
  selectPiperTarget,
} from './piper-runtime-manifest.mjs';

const MAX_COMMAND_OUTPUT = 8 * 1024 * 1024;
const EXPECTED_LICENSES = [
  'eSpeak-NG-Apache-2.0.txt',
  'eSpeak-NG-BSD-2-Clause.txt',
  'eSpeak-NG-GPL-3.0.txt',
  'eSpeak-NG-UCD.txt',
  'ONNX-Runtime-LICENSE.txt',
  'ONNX-Runtime-ThirdPartyNotices.txt',
  'Piper-GPL-3.0.txt',
];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT,
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function relativePosix(root, path) {
  return relative(root, path).split(sep).join('/');
}

async function inventoryRegularFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Piper runtime contains a symbolic link: ${relativePosix(root, path)}`);
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(relativePosix(root, path));
      } else {
        throw new Error(`Piper runtime contains a special file: ${relativePosix(root, path)}`);
      }
    }
  }
  await visit(root);
  return files.sort();
}

export function expectedPiperRootEntries(target) {
  return [
    ...target.runtimeFiles.map(({ output }) => output),
    'espeak-ng-data',
    'licenses',
    'piper-runtime.json',
  ].sort();
}

async function validateRootEntries(runtimeDir, target) {
  const actual = (await readdir(runtimeDir)).sort();
  const expected = expectedPiperRootEntries(target);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Unexpected Piper runtime layout. Expected ${expected.join(', ')}, `
      + `found ${actual.join(', ')}.`,
    );
  }
}

function rejectDeveloperPaths(output, forbiddenPaths) {
  const normalized = output.replaceAll('\\', '/');
  for (const path of forbiddenPaths.filter(Boolean)) {
    const marker = path.replaceAll('\\', '/');
    if (normalized.includes(marker)) {
      throw new Error(`Piper loader metadata contains a build path: ${marker}`);
    }
  }
  if (/\/opt\/homebrew|\/usr\/local\/Cellar/.test(normalized)) {
    throw new Error('Piper runtime depends on a Homebrew/developer path.');
  }
}

function validateLinuxDependencies(runtimeDir, target, forbiddenPaths) {
  for (const { output } of target.runtimeFiles) {
    const path = join(runtimeDir, output);
    const dynamic = run('readelf', ['-d', path]);
    rejectDeveloperPaths(dynamic, forbiddenPaths);
    if (output === target.executable || output === 'libpiper.so') {
      if (!dynamic.includes('$ORIGIN')) {
        throw new Error(`${output} does not use an $ORIGIN runtime search path.`);
      }
      const dependencies = run('ldd', [path]);
      if (/not found/i.test(dependencies)) {
        throw new Error(`${output} has an unresolved dynamic dependency.`);
      }
      rejectDeveloperPaths(dependencies, forbiddenPaths);
    }
  }
}

function validateMacDependencies(runtimeDir, target, forbiddenPaths) {
  for (const { output } of target.runtimeFiles) {
    const path = join(runtimeDir, output);
    const dependencies = run('otool', ['-L', path]);
    const loadCommands = run('otool', ['-l', path]);
    rejectDeveloperPaths(`${dependencies}\n${loadCommands}`, forbiddenPaths);
    if (output === target.executable || output === 'libpiper.dylib') {
      if (!loadCommands.includes('@loader_path')) {
        throw new Error(`${output} does not use an @loader_path runtime search path.`);
      }
    }
  }
}

export async function validatePiperRuntime(
  runtimePath,
  {
    platform = hostPlatform(),
    architecture = hostArch(),
    checkDynamic = true,
    forbiddenPaths = [],
  } = {},
) {
  const runtimeDir = resolve(runtimePath);
  const { key, target } = selectPiperTarget(platform, architecture);
  const runtimeMetadata = await stat(runtimeDir);
  if (!runtimeMetadata.isDirectory()) throw new Error('Piper runtime is not a directory.');
  await validateRootEntries(runtimeDir, target);

  const inventory = await inventoryRegularFiles(runtimeDir);
  const manifestPath = join(runtimeDir, 'piper-runtime.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    manifest.schemaVersion !== 1
    || manifest.piper?.version !== PIPER_VERSION
    || manifest.piper?.commit !== PIPER_COMMIT
    || manifest.target?.key !== key
    || manifest.target?.platformName !== target.platformName
  ) {
    throw new Error('Piper runtime manifest identity mismatch.');
  }

  const manifestFiles = manifest.runtimeFiles || {};
  for (const { output } of target.runtimeFiles) {
    const path = join(runtimeDir, output);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`${output} is not a regular file.`);
    const bytes = await readFile(path);
    validateExecutable(bytes, target);
    const actualHash = sha256(bytes);
    if (manifestFiles[output]?.sha256 !== actualHash) {
      throw new Error(`${output} SHA-256 does not match piper-runtime.json.`);
    }
  }

  const licenses = (await readdir(join(runtimeDir, 'licenses'))).sort();
  const expectedLicenses = [...EXPECTED_LICENSES].sort();
  if (JSON.stringify(licenses) !== JSON.stringify(expectedLicenses)) {
    throw new Error('Piper runtime license inventory mismatch.');
  }
  for (const license of EXPECTED_LICENSES) {
    const metadata = await stat(join(runtimeDir, 'licenses', license));
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error(`Piper runtime license is missing or empty: ${license}`);
    }
  }

  const espeakFiles = inventory.filter((path) => path.startsWith('espeak-ng-data/'));
  if (!espeakFiles.includes('espeak-ng-data/phondata') || espeakFiles.length < 100) {
    throw new Error('Piper runtime has incomplete espeak-ng-data.');
  }

  const executablePath = join(runtimeDir, target.executable);
  if (platform !== 'win32') {
    await access(executablePath, constants.X_OK);
  }
  const version = run(executablePath, ['--version'], { cwd: runtimeDir }).trim();
  if (!version.split(/\r?\n/).includes(PIPER_VERSION)) {
    throw new Error(`Unexpected Piper runtime version: ${version}`);
  }

  if (checkDynamic) {
    if (platform === 'linux') {
      validateLinuxDependencies(runtimeDir, target, forbiddenPaths);
    } else if (platform === 'darwin') {
      validateMacDependencies(runtimeDir, target, forbiddenPaths);
    }
  }

  return {
    key,
    target,
    manifest,
    inventory,
    executable: basename(executablePath),
  };
}
