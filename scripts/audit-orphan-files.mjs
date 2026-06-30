// Audit ponctuel : detecte les fichiers source jamais importes par un autre
// fichier (orphelins candidats). Faux positifs : points d'entree (main, App),
// fichiers charges dynamiquement, tests, fichiers CSS importes par effet de bord.
import fs from 'node:fs';
import path from 'node:path';

const exts = new Set(['.js', '.jsx']);
const entryPoints = new Set(['main.jsx', 'App.jsx']); // racine montee par index.html
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (exts.has(path.extname(e.name))) files.push(f);
  }
})('src');

const orphans = [];
for (const f of files) {
  const base = path.basename(f).replace(/\.(jsx?|mjs)$/, '');
  if (entryPoints.has(path.basename(f))) continue;
  // Cherche un import qui mentionne ce basename (avec ou sans extension)
  // Forme: from '...<base>' ou import('...<base>')
  const re = new RegExp(`['"\`][^'"\`]*/${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.jsx?)?['"\`]`);
  // Retire le fichier lui-meme du corpus de recherche
  const others = files.filter((o) => o !== f).map((o) => fs.readFileSync(o, 'utf8')).join('\n');
  if (!re.test(others)) orphans.push(f);
}

if (orphans.length === 0) {
  console.log(`OK : aucun fichier orphelin sur ${files.length} fichiers.`);
} else {
  console.log(`${orphans.length} fichier(s) orphelin(s) candidat(s) (jamais importes) :`);
  for (const o of orphans) console.log(`  ${o}`);
}
