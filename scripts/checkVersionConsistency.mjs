import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_PATHS = Object.freeze({
  packageJson: 'package.json',
  packageLock: 'package-lock.json',
  cargoToml: 'src-tauri/Cargo.toml',
  cargoLock: 'src-tauri/Cargo.lock',
  tauriConfig: 'src-tauri/tauri.conf.json',
});

export const VERSION_SOURCE_LABELS = Object.freeze([
  'package.json',
  'package-lock.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock (story-studio)',
  'src-tauri/tauri.conf.json',
]);

async function readRequiredFile(rootDir, relativePath) {
  try {
    return await readFile(path.join(rootDir, relativePath), 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${relativePath}: ${error.message}`, { cause: error });
  }
}

function parseJson(text, relativePath) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${relativePath}: ${error.message}`, { cause: error });
  }
}

function requireVersion(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing or invalid version in ${label}.`);
  }
  return value.trim();
}

function findTomlStringField(text, field) {
  const expression = new RegExp(
    `^\\s*${field}\\s*=\\s*(["'])([^"']+)\\1\\s*(?:#.*)?$`,
    'm',
  );
  return text.match(expression)?.[2] ?? null;
}

function readCargoManifestVersion(text) {
  const lines = text.split(/\r?\n/);
  let packageStart = -1;
  let packageEnd = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const section = lines[index].match(/^\s*\[([^[\]]+)\]\s*(?:#.*)?$/);
    if (!section) continue;

    if (packageStart >= 0) {
      packageEnd = index;
      break;
    }
    if (section[1].trim() === 'package') {
      packageStart = index + 1;
    }
  }

  if (packageStart < 0) {
    throw new Error('Missing [package] section in src-tauri/Cargo.toml.');
  }

  const packageSection = lines.slice(packageStart, packageEnd).join('\n');
  return requireVersion(
    findTomlStringField(packageSection, 'version'),
    'src-tauri/Cargo.toml [package].version',
  );
}

function readCargoLockVersion(text) {
  const packageBlocks = text
    .split(/^\s*\[\[package\]\]\s*(?:#.*)?$/m)
    .slice(1);
  const storyStudioBlocks = packageBlocks.filter(
    (block) => findTomlStringField(block, 'name') === 'story-studio',
  );

  if (storyStudioBlocks.length === 0) {
    throw new Error('Missing story-studio package entry in src-tauri/Cargo.lock.');
  }
  if (storyStudioBlocks.length > 1) {
    throw new Error('Multiple story-studio package entries found in src-tauri/Cargo.lock.');
  }

  return requireVersion(
    findTomlStringField(storyStudioBlocks[0], 'version'),
    'src-tauri/Cargo.lock story-studio.version',
  );
}

function readPackageLockVersion(packageLock) {
  const documentVersion = requireVersion(
    packageLock?.version,
    'package-lock.json.version',
  );
  const rootPackageVersion = requireVersion(
    packageLock?.packages?.['']?.version,
    'package-lock.json packages[""].version',
  );

  if (documentVersion !== rootPackageVersion) {
    throw new Error([
      'package-lock.json contains inconsistent root versions:',
      `- version: ${documentVersion}`,
      `- packages[""].version: ${rootPackageVersion}`,
    ].join('\n'));
  }

  return rootPackageVersion;
}

export function assertVersionConsistency(sources) {
  const missingSources = VERSION_SOURCE_LABELS.filter((label) => (
    typeof sources?.[label] !== 'string' || sources[label].trim() === ''
  ));
  if (missingSources.length > 0) {
    throw new Error(`Missing or invalid version source(s): ${missingSources.join(', ')}.`);
  }

  const expectedVersion = sources['package.json'];
  const mismatches = VERSION_SOURCE_LABELS.filter(
    (label) => sources[label] !== expectedVersion,
  );
  if (mismatches.length > 0) {
    const values = VERSION_SOURCE_LABELS
      .map((label) => `- ${label}: ${sources[label]}`)
      .join('\n');
    throw new Error([
      `Version mismatch: package.json is the source of truth (${expectedVersion}).`,
      'Values read:',
      values,
    ].join('\n'));
  }

  return expectedVersion;
}

export async function readVersionSources(rootDir = REPO_ROOT) {
  const [
    packageJsonText,
    packageLockText,
    cargoTomlText,
    cargoLockText,
    tauriConfigText,
  ] = await Promise.all([
    readRequiredFile(rootDir, SOURCE_PATHS.packageJson),
    readRequiredFile(rootDir, SOURCE_PATHS.packageLock),
    readRequiredFile(rootDir, SOURCE_PATHS.cargoToml),
    readRequiredFile(rootDir, SOURCE_PATHS.cargoLock),
    readRequiredFile(rootDir, SOURCE_PATHS.tauriConfig),
  ]);

  const packageJson = parseJson(packageJsonText, SOURCE_PATHS.packageJson);
  const packageLock = parseJson(packageLockText, SOURCE_PATHS.packageLock);
  const tauriConfig = parseJson(tauriConfigText, SOURCE_PATHS.tauriConfig);

  return {
    'package.json': requireVersion(packageJson.version, 'package.json.version'),
    'package-lock.json': readPackageLockVersion(packageLock),
    'src-tauri/Cargo.toml': readCargoManifestVersion(cargoTomlText),
    'src-tauri/Cargo.lock (story-studio)': readCargoLockVersion(cargoLockText),
    'src-tauri/tauri.conf.json': requireVersion(
      tauriConfig.version,
      'src-tauri/tauri.conf.json version',
    ),
  };
}

export async function checkVersionConsistency(rootDir = REPO_ROOT) {
  const sources = await readVersionSources(rootDir);
  return {
    sources,
    version: assertVersionConsistency(sources),
  };
}

const cliPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (cliPath === import.meta.url) {
  try {
    const { version } = await checkVersionConsistency();
    console.log(`Version consistency OK: ${version} (${VERSION_SOURCE_LABELS.length} sources).`);
  } catch (error) {
    console.error(`Version consistency check failed.\n${error.message}`);
    process.exitCode = 1;
  }
}
