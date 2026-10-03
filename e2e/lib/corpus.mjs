// Sélection dynamique d'archives du corpus (lecture seule, jamais modifié).
// Aucun nom de pack réel n'est versionné dans `e2e/` : seuls des sous-dossiers
// de classement (catégories choisies par l'auteur, ex. « 01 - Editable ») sont
// nommés ici. Le fichier précis est toujours choisi au moment de l'exécution
// (le plus petit trouvé), jamais figé dans le code.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { requireConfig } from './config.mjs';

const ARCHIVE_RE = /\.(zip|7z)$/i;

function walk(dir) {
  const found = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (ARCHIVE_RE.test(entry.name)) found.push({ path, size: statSync(path).size });
  }
  return found;
}

function archivesUnder(subDir) {
  return walk(join(requireConfig('corpusDir'), subDir));
}

// Les `n` plus petites archives (.zip ou .7z, mélangées) sous `<corpusDir>/<subDir>`.
export function smallestArchives(subDir, n = 1) {
  const all = archivesUnder(subDir).sort((a, b) => a.size - b.size);
  if (all.length < n) {
    throw new Error(`Corpus insuffisant sous « ${subDir} » : ${all.length} archive(s) trouvée(s), ${n} demandée(s).`);
  }
  return all.slice(0, n).map((entry) => entry.path);
}

export function smallestArchive(subDir) {
  return smallestArchives(subDir, 1)[0];
}

// La plus petite archive d'une extension précise sous `subDir` (ex. '7z').
export function smallestByExt(subDir, ext) {
  const all = archivesUnder(subDir)
    .filter((entry) => entry.path.toLowerCase().endsWith(`.${ext.toLowerCase()}`))
    .sort((a, b) => a.size - b.size);
  if (!all.length) throw new Error(`Aucune archive .${ext} sous « ${subDir} ».`);
  return all[0].path;
}

/**
 * Échantillon de `n` archives sous `subDir`, réparti sur toute la gamme de
 * tailles (pas seulement les plus petites) : les archives triées par taille
 * sont prises à intervalles réguliers. `minExt` (ex. `{ ext: '7z', count: 3 }`)
 * garantit un minimum d'une extension donnée dans l'échantillon, en substituant
 * les entrées les plus proches en taille qui n'en sont pas si nécessaire.
 */
export function spreadArchives(subDir, n, { minExt } = {}) {
  const all = archivesUnder(subDir).sort((a, b) => a.size - b.size);
  if (all.length < n) {
    throw new Error(`Corpus insuffisant sous « ${subDir} » : ${all.length} archive(s) trouvée(s), ${n} demandée(s).`);
  }
  const pickIndexes = [];
  for (let i = 0; i < n; i += 1) {
    pickIndexes.push(Math.min(all.length - 1, Math.floor((i * all.length) / n)));
  }
  let picked = [...new Set(pickIndexes)].map((i) => all[i]);
  // Complète si des doublons d'index ont réduit le compte.
  let cursor = 0;
  while (picked.length < n && cursor < all.length) {
    if (!picked.includes(all[cursor])) picked.push(all[cursor]);
    cursor += 1;
  }
  if (minExt?.ext && minExt.count > 0) {
    const suffix = `.${minExt.ext.toLowerCase()}`;
    const haveCount = picked.filter((e) => e.path.toLowerCase().endsWith(suffix)).length;
    if (haveCount < minExt.count) {
      const candidates = all.filter((e) => e.path.toLowerCase().endsWith(suffix) && !picked.includes(e));
      let need = minExt.count - haveCount;
      // Retire d'abord les entrées surnuméraires d'une autre extension, en
      // gardant la répartition de tailles aussi proche que possible.
      const removable = picked.filter((e) => !e.path.toLowerCase().endsWith(suffix));
      for (const candidate of candidates) {
        if (need <= 0) break;
        if (!removable.length) break;
        // Remplace l'entrée de taille la plus proche du candidat.
        removable.sort((a, b) => Math.abs(a.size - candidate.size) - Math.abs(b.size - candidate.size));
        const victim = removable.shift();
        const idx = picked.indexOf(victim);
        picked[idx] = candidate;
        need -= 1;
      }
    }
  }
  return picked.sort((a, b) => a.size - b.size).map((e) => e.path);
}

/**
 * Toutes les archives (.zip et .7z) sous `<corpusDir>/<subDir>`, triées par
 * chemin (ordre stable d'une exécution à l'autre). Dossier absent ou vide : `[]`.
 * Chaque entrée : `{ path, size, relPath }`, `relPath` relatif à `corpusDir`
 * (séparateurs `/`) — l'identifiant d'un pack dans les relevés.
 */
export function allArchivesSorted(subDir) {
  return archivesUnder(subDir)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => ({ ...entry, relPath: corpusRelPath(entry.path) }));
}

export function corpusRelPath(path) {
  return relative(requireConfig('corpusDir'), path).split(sep).join('/');
}
