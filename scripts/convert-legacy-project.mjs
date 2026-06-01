#!/usr/bin/env node
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrateProjectData, projectToSerializable } from '../src/store/projectModel.js';

function usage() {
  return [
    'Usage: node scripts/convert-legacy-project.mjs <input.mbah> [output.mbah] [--force] [--in-place] [--no-backup]',
    '',
    'Converts an old Story Studio project to the current rootEntries-only .mbah shape.',
    'By default, writes <input>.migrated.mbah and refuses to overwrite existing files.',
    '--in-place creates a timestamped .bak copy before replacing the input unless --no-backup is set.',
  ].join('\n');
}

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) flags.add(arg);
    else positional.push(arg);
  }
  if (flags.has('--help') || flags.has('-h')) {
    return { help: true };
  }
  if (positional.length < 1 || positional.length > 2) {
    throw new Error(usage());
  }
  if (flags.has('--in-place') && positional.length === 2) {
    throw new Error('--in-place cannot be combined with an explicit output path.');
  }
  return {
    inputPath: positional[0],
    outputPath: flags.has('--in-place') ? positional[0] : positional[1],
    force: flags.has('--force'),
    inPlace: flags.has('--in-place'),
    backup: !flags.has('--no-backup'),
    help: false,
  };
}

function defaultOutputPath(inputPath) {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}.migrated${parsed.ext || '.mbah'}`);
}

function backupPath(inputPath) {
  const parsed = path.parse(inputPath);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return path.join(parsed.dir, `${parsed.base}.${stamp}.bak`);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function convertLegacyProjectData(rawData, { savePath = null } = {}) {
  return projectToSerializable(migrateProjectData(rawData, { savePath }));
}

export async function convertLegacyProjectFile(options) {
  const inputPath = path.resolve(options.inputPath);
  const outputPath = path.resolve(options.outputPath || defaultOutputPath(inputPath));
  const inPlace = inputPath === outputPath;

  if (!options.force && !inPlace && await exists(outputPath)) {
    throw new Error(`Output already exists: ${outputPath}. Use --force to overwrite.`);
  }

  const raw = JSON.parse(await readFile(inputPath, 'utf8'));
  const converted = convertLegacyProjectData(raw, { savePath: inputPath });

  let backup = null;
  if (inPlace && options.backup !== false) {
    backup = backupPath(inputPath);
    await copyFile(inputPath, backup);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(converted, null, 2)}\n`, 'utf8');

  return { inputPath, outputPath, backup };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  const projectedOutput = options.outputPath || defaultOutputPath(options.inputPath);
  if (path.extname(projectedOutput).toLowerCase() !== '.mbah') {
    console.warn(
      `Warning: output "${projectedOutput}" does not have a .mbah extension. ` +
      'Story Studio expects .mbah files and may not recognise this output.',
    );
  }

  try {
    const result = await convertLegacyProjectFile(options);
    console.log(`Converted: ${result.outputPath}`);
    if (result.backup) console.log(`Backup: ${result.backup}`);
  } catch (error) {
    console.error(`Conversion failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
