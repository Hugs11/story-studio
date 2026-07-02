// Tri des médias de session à la promotion « Enregistrer comme projet » (plan 22, D51).
//
// À la promotion d'une session éphémère, seuls les médias référencés par les
// nœuds sont transférés vers le workspace (`transferProjectFilesToProject`),
// puis le dossier de session est supprimé. Les fichiers présents uniquement
// dans la bibliothèque (`mediaLibraryPaths`) — variantes IA non retenues,
// imports non affectés — seraient perdus. Ce module (logique pure, testée dans
// scripts/sessionMediaTriage.test.mjs) détecte ces orphelins et applique le
// choix de l'utilisateur ; la copie disque reste côté appelant.

import { basename, pathKey } from '../utils/fileUtils.js';
import { walkProjectMediaReferences } from './projectModel/index.js';

function normalizedDirPrefix(dir) {
  const key = pathKey(dir ?? '').replace(/\/+$/, '');
  return key ? `${key}/` : null;
}

function isInsideDir(path, dirPrefix) {
  return !!dirPrefix && pathKey(path ?? '').startsWith(dirPrefix);
}

/**
 * Liste les médias qui vivent dans le dossier de session sans être référencés
 * par un nœud du projet (après transfert éventuel). Candidats : entrées de la
 * bibliothèque ET clés de tags. `excludeKeys` (Map/Set de pathKey) écarte les
 * chemins déjà copiés par le transfert : ils ne sont pas orphelins, seulement
 * à re-pointer. Retourne des `{ path, filename }` dédupliqués.
 */
export function collectSessionOnlyMedia({ project, mediaLibraryPaths, mediaTags = null, sessionDir, excludeKeys = null }) {
  const dirPrefix = normalizedDirPrefix(sessionDir);
  if (!dirPrefix) return [];

  const referenced = new Set();
  for (const ref of walkProjectMediaReferences(project)) {
    referenced.add(pathKey(ref.path));
  }

  const seen = new Set();
  const orphans = [];
  const candidates = [...(mediaLibraryPaths ?? []), ...Object.keys(mediaTags ?? {})];
  for (const path of candidates) {
    if (typeof path !== 'string' || !path.trim()) continue;
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isInsideDir(path, dirPrefix)) continue;
    if (referenced.has(key)) continue;
    if (excludeKeys?.has(key)) continue;
    orphans.push({ path, filename: basename(path) || path });
  }
  return orphans;
}

/**
 * Applique le résultat du tri à la bibliothèque et aux tags :
 * - `replacements` : Map clé normalisée (pathKey) → nouveau chemin copié ;
 * - `droppedPaths` : chemins abandonnés (retirés de la bibliothèque, tags perdus).
 * Les entrées non concernées sont conservées telles quelles.
 */
export function applySessionMediaTriage({ mediaLibraryPaths, mediaTags, replacements, droppedPaths }) {
  const dropped = new Set((droppedPaths ?? []).map((path) => pathKey(path)));
  const replaceByKey = replacements instanceof Map ? replacements : new Map();

  const nextPaths = [];
  const seen = new Set();
  for (const path of mediaLibraryPaths ?? []) {
    if (typeof path !== 'string' || !path.trim()) continue;
    const key = pathKey(path);
    if (dropped.has(key)) continue;
    const nextPath = replaceByKey.get(key) ?? path;
    const nextKey = pathKey(nextPath);
    if (seen.has(nextKey)) continue;
    seen.add(nextKey);
    nextPaths.push(nextPath);
  }

  const nextTags = {};
  for (const [path, tagList] of Object.entries(mediaTags ?? {})) {
    if (!Array.isArray(tagList) || tagList.length === 0) continue;
    const key = pathKey(path);
    if (dropped.has(key)) continue;
    nextTags[replaceByKey.get(key) ?? path] = tagList;
  }

  return { mediaLibraryPaths: nextPaths, mediaTags: nextTags };
}
