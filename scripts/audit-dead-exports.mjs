// Audit ponctuel : detecte les exports (function/const/class) jamais
// importes ailleurs dans src/ ou scripts/. Signale les "dead exports"
// candidats. Faux positifs possibles : points d'entree, exports utilises
// uniquement par des tests, ou API publique volontaire.
import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'scripts'];
const exts = new Set(['.js', '.jsx', '.mjs']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (exts.has(path.extname(e.name))) out.push(full);
  }
}

const files = [];
for (const r of roots) if (fs.existsSync(r)) walk(r, files);

// Index : nom exporte -> fichier
const exportsByName = new Map();
const exportRe = /export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g;
const namedReexportRe = /export\s+{([^}]+)}/g;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = exportRe.exec(src))) {
    const name = m[1];
    if (!exportsByName.has(name)) exportsByName.set(name, []);
    exportsByName.get(name).push(f);
  }
  while ((m = namedReexportRe.exec(src))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && /^\w+$/.test(name)) {
        if (!exportsByName.has(name)) exportsByName.set(name, []);
        exportsByName.get(name).push(f);
      }
    }
  }
}

// Pour chaque nom, compter les usages (import OU reference) hors de son fichier
const allSrc = files.map((f) => ({ f, src: fs.readFileSync(f, 'utf8') }));

const dead = [];
for (const [name, declFiles] of exportsByName) {
  let usedElsewhere = false;
  for (const { f, src } of allSrc) {
    if (declFiles.includes(f)) {
      // meme fichier : ignore (un export peut etre utilise localement, c'est ok)
      continue;
    }
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(src)) { usedElsewhere = true; break; }
  }
  if (!usedElsewhere) dead.push({ name, files: declFiles });
}

dead.sort((a, b) => a.files[0].localeCompare(b.files[0]));
if (dead.length === 0) {
  console.log('OK : aucun dead export detecte.');
} else {
  console.log(`${dead.length} dead export(s) candidat(s) (jamais importes hors de leur fichier) :`);
  for (const d of dead) {
    console.log(`  ${d.name}  <-  ${d.files.join(', ')}`);
  }
}
