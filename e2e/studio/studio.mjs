// Verdict STUdio (version 0.5.4) sur une archive produite par Story Studio.
//
// Appelle le vrai code d'import de STUdio, sans son interface : lecture de
// l'archive, préparation des médias pour l'appareil, écriture au format FS,
// puis relecture du dossier FS. C'est le chemin de `LibraryService` quand
// STUdio convertit un pack pour la boîte. Aucun accès à `~\.studio`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, requireConfig } from '../lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCES = ['StudioFsConvert.java', 'StudioFsReadback.java'];

function javaTool(name) {
  const home = requireConfig('javaHome');
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return join(home, 'bin', exe);
}

function classpath(classesDir) {
  const lib = join(requireConfig('studioDir'), 'lib', '*');
  return [classesDir, lib].join(process.platform === 'win32' ? ';' : ':');
}

// Compile les deux classes une fois par poste, dans le dossier de travail.
function ensureCompiled() {
  const classesDir = join(config.workDir, 'studio-classes');
  if (SOURCES.every(source => existsSync(join(classesDir, source.replace('.java', '.class'))))) {
    return classesDir;
  }
  mkdirSync(classesDir, { recursive: true });
  const sources = SOURCES.map(source => join(HERE, source));
  const result = spawnSync(javaTool('javac'), ['-encoding', 'UTF-8', '-cp', classpath(classesDir), '-d', classesDir, ...sources], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Compilation du harnais STUdio impossible :\n${result.stderr || result.stdout}`);
  }
  return classesDir;
}

function parse(stdout) {
  const fields = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

function runJava(classesDir, mainClass, args) {
  const result = spawnSync(javaTool('java'), ['-Dfile.encoding=UTF-8', '-cp', classpath(classesDir), mainClass, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, fields: parse(result.stdout || ''), stdout: result.stdout, stderr: result.stderr };
}

// Conversion seule (`StudioFsConvert`), partagée par `studioVerdict` et par
// `convertToFsFolder` : le même chemin de code STUdio produit le dossier FS
// qu'on relit (verdict) ou qu'on donne à Story Studio en entrée (pack FS).
function convertOnce(zipPath, outDir) {
  const classesDir = ensureCompiled();
  mkdirSync(outDir, { recursive: true });
  return { classesDir, convert: runJava(classesDir, 'StudioFsConvert', [zipPath, outDir]) };
}

/**
 * Convertit une archive Story Studio en pack au format FS (dossier), par le
 * même chemin STUdio que `studioVerdict`. Sert à fabriquer un pack
 * FS à déposer dans « Modifier un pack existant ». Lève si la conversion
 * échoue.
 */
export function convertToFsFolder(zipPath, outDir) {
  const { convert } = convertOnce(zipPath, outDir);
  if (convert.fields.RESULT !== 'OK') {
    throw new Error(`Conversion FS impossible : ${(convert.stdout + convert.stderr).slice(-2000)}`);
  }
  return convert.fields.packFolder;
}

/**
 * `ok` vaut vrai si STUdio lit l'archive, la convertit au format de l'appareil
 * et relit le résultat. Les champs (`uuid`, `stageNodes`, `actionNodes`,
 * `nightMode`, `version`) servent de comparaison avec ce que Story Studio a relu.
 */
export function studioVerdict(zipPath, outDir) {
  const { classesDir, convert } = convertOnce(zipPath, outDir);
  const verdict = {
    ok: false,
    convert: convert.fields.RESULT ?? `EXIT_${convert.status}`,
    readback: null,
    uuid: convert.fields.uuid,
    version: convert.fields.version,
    nightMode: convert.fields.nightMode,
    stageNodes: Number(convert.fields.stageNodes),
    actionNodes: Number(convert.fields.actionNodes),
  };
  if (convert.fields.RESULT !== 'OK') {
    verdict.detail = (convert.stdout + convert.stderr).slice(-2000);
    return verdict;
  }
  const readback = runJava(classesDir, 'StudioFsReadback', [convert.fields.packFolder]);
  verdict.readback = readback.fields.RESULT ?? `EXIT_${readback.status}`;
  verdict.ok = readback.fields.RESULT === 'READBACK_OK'
    && readback.fields.stageNodes === convert.fields.stageNodes
    && readback.fields.actionNodes === convert.fields.actionNodes;
  if (!verdict.ok) verdict.detail = (readback.stdout + readback.stderr).slice(-2000);
  return verdict;
}

// Usage direct : node e2e/studio/studio.mjs <archive.zip>
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const zip = process.argv[2];
  console.log(JSON.stringify(studioVerdict(zip, join(config.workDir, 'studio-out', String(Date.now()))), null, 2));
}
