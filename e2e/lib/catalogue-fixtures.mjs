// Lecture seule des sources ; seules les copies sous le run sont indexées.
import { cpSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function filesUnder(root) {
  if (lstatSync(root).isSymbolicLink()) throw new Error(`Lien symbolique refusé dans les fixtures : ${root}`);
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Lien symbolique refusé dans les fixtures : ${path}`);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function prepareCatalogueFixtures({ corpusDir, demoDir, runDir }) {
  const destination = resolve(runDir, 'packs');
  // Un run ne doit jamais être créé dans une source : éviter la copie récursive.
  for (const source of [corpusDir, demoDir]) {
    const root = realpathSync(source);
    const rel = relative(root, resolve(runDir));
    if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) throw new Error('Le run doit être en dehors des sources de fixtures');
  }
  mkdirSync(destination, { recursive: true });
  const manifest = [];
  let index = 0;
  for (const [category, limit] of [['exemples', 4], ['synthetiques', 3], ['reels', 3]]) {
    const root = join(corpusDir, category);
    const archives = filesUnder(root).filter(path => /\.(zip|7z)$/i.test(path))
      .sort((a, b) => lstatSync(a).size - lstatSync(b).size || a.localeCompare(b, 'en'));
    if (!archives.length) throw new Error(`Aucune archive dans la catégorie ${category}`);
    // Étaler le tirage, sans choisir les énormes archives de fin de corpus.
    const pool = archives.slice(0, Math.max(limit, Math.ceil(archives.length / 2)));
    const count = Math.min(limit, pool.length);
    const chosen = Array.from({ length: count }, (_, n) => pool[Math.floor(n * pool.length / count)]);
    for (const source of chosen) {
      const name = `${String(++index).padStart(2, '0')}-${basename(source)}`;
      const target = join(destination, category, name);
      mkdirSync(join(destination, category), { recursive: true });
      cpSync(source, target, { errorOnExist: true, force: false });
      manifest.push({ category, source, copy: target });
      if (index === 1) {
        const duplicate = join(destination, category, `copie-au-nom-volontairement-long-pour-la-recette-du-catalogue-${name}`);
        cpSync(source, duplicate, { errorOnExist: true, force: false });
        manifest.push({ category, source, copy: duplicate, duplicate: true });
      }
    }
  }
  const demoFiles = filesUnder(demoDir); // Valide aussi l'absence de liens.
  for (const extension of ['.mbah', '.zip', '.7z']) {
    if (!demoFiles.some(path => extname(path).toLowerCase() === extension)) throw new Error(`Démo : format ${extension} absent`);
  }
  if (!demoFiles.some(path => ['story.json', 'ni'].includes(basename(path)))) throw new Error('Démo : pack dossier absent (story.json ou ni)');
  const demoCopy = join(destination, 'demo-quatre-formats');
  cpSync(demoDir, demoCopy, { recursive: true, errorOnExist: true, force: false });
  manifest.push({ category: 'demo', source: demoDir, copy: demoCopy });
  writeFileSync(join(runDir, 'fixtures.json'), JSON.stringify(manifest, null, 2));
  return { directory: destination, archiveCount: index, manifest };
}
