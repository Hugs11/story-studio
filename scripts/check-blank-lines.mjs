#!/usr/bin/env node
// Garde-fou format : refuse les fichiers ou la pollution lignes vides
// (> THRESHOLD % de lignes vides sur un fichier > MIN_LINES lignes).
// Cause typique : un outil d'edition serialisant \n\n\n a la place de \n.
//
// Usage :
//   node scripts/check-blank-lines.mjs           -> scan defaut (src/, scripts/)
//   node scripts/check-blank-lines.mjs <files>   -> scan explicite
//
// Exit code 0 = clean, 1 = pollution detectee.

import fs from 'node:fs';
import path from 'node:path';

const THRESHOLD_PERCENT = 40;
const MIN_LINES = 50;
const DEFAULT_DIRS = ['src', 'scripts'];
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.rs', '.css']);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
}

function listFiles(args) {
  if (args.length > 0) return args.map((p) => path.resolve(p));
  const out = [];
  for (const d of DEFAULT_DIRS) {
    const abs = path.resolve(d);
    if (fs.existsSync(abs)) walk(abs, out);
  }
  return out;
}

function check(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  if (lines.length < MIN_LINES) return null;
  let blanks = 0;
  for (const line of lines) if (/^\s*$/.test(line)) blanks++;
  const ratio = Math.round((blanks * 100) / lines.length);
  if (ratio >= THRESHOLD_PERCENT) return { file, total: lines.length, blanks, ratio };
  return null;
}

const files = listFiles(process.argv.slice(2));
const offenders = [];
for (const f of files) {
  const r = check(f);
  if (r) offenders.push(r);
}

if (offenders.length === 0) {
  console.log(`check-blank-lines: OK (${files.length} fichiers scannes)`);
  process.exit(0);
}

console.error(`check-blank-lines: ${offenders.length} fichier(s) au-dela de ${THRESHOLD_PERCENT}% lignes vides :`);
for (const o of offenders) {
  console.error(`  ${o.file} : ${o.total} lignes, ${o.blanks} vides (${o.ratio}%)`);
}
console.error('\nIndice : ces fichiers ont probablement ete pollues par un outil');
console.error('  qui a serialise les sauts de ligne en double/triple. Restaurer depuis');
console.error('  git ou nettoyer manuellement avant de commiter.');
process.exit(1);
