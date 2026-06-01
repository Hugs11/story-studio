// Audit ponctuel : detecte les identifiants importes mais jamais utilises
// dans le corps du fichier (dead imports laisses apres refactor).
// Cible les fichiers passes en argument ou un range git.
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
let files;
if (args.length > 0 && !args[0].startsWith('range:')) {
  files = args;
} else {
  const range = args[0]?.startsWith('range:') ? args[0].slice(6) : 'HEAD~1..HEAD';
  files = execSync(`git diff --name-only ${range}`)
    .toString()
    .split('\n')
    .filter((f) => /\.(js|jsx)$/.test(f) && (f.startsWith('src/') || f.startsWith('scripts/')));
}

let problems = 0;
let scanned = 0;
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  scanned += 1;
  const raw = fs.readFileSync(f, 'utf8');

  // Collecte les imports avec leur position de fin (pour delimiter le "corps")
  const importNames = [];
  const importRe = /import\s+(?:{([^}]+)}|(\w+)|\*\s+as\s+(\w+))(?:\s*,\s*{([^}]+)})?\s+from\s+['"][^'"]+['"]/g;
  let lastImportEnd = 0;
  let m;
  while ((m = importRe.exec(raw))) {
    lastImportEnd = m.index + m[0].length;
    for (const g of [m[1], m[4]]) {
      if (!g) continue;
      for (const p of g.split(',')) {
        const name = p.trim().replace(/.*\bas\s+/, '').trim();
        if (name) importNames.push(name);
      }
    }
    if (m[2]) importNames.push(m[2]);
    if (m[3]) importNames.push(m[3]);
  }

  // Compte les occurrences du nom dans TOUT le fichier. La declaration
  // d'import compte pour 1. Si total <= 1, le nom n'est jamais reference
  // ailleurs -> import mort. (lastImportEnd garde pour compat mais inutilise.)
  void lastImportEnd;
  const unused = importNames.filter((name) => {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const count = (raw.match(re) || []).length;
    return count <= 1;
  });
  if (unused.length) {
    console.log(`${f} :: imports inutilises = ${unused.join(', ')}`);
    problems += 1;
  }
}
console.log(problems === 0
  ? `OK : aucun import inutilise sur ${scanned} fichiers`
  : `${problems} fichier(s) avec imports inutilises`);
