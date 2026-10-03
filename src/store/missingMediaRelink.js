import { basename, joinPath, pathKey } from '../utils/fileUtils.js';
import { walkProjectMediaReferences } from './projectModel/index.js';
import { readMediaBindings } from './projectModel/mediaBindings.js';
import { MANAGED_PROJECT_DIRS } from './workspaceDirs.js';

function hasPath(path) {
  return typeof path === 'string' && path.trim().length > 0;
}

function replacementForPath(path, replacements) {
  if (!hasPath(path)) return null;
  const key = pathKey(path);
  return replacements.get(key) ?? null;
}

export function mediaKindFromPath(path) {
  const ext = String(path || '').toLowerCase().replace(/^.*\./, '');
  if (['mp3', 'ogg', 'wav', 'm4a', 'webm', 'flac', 'aac'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(ext)) return 'image';
  if (['zip', '7z'].includes(ext)) return 'archive';
  return 'media';
}

export function collectMissingMedia(project, statusByPath = {}) {
  const byPath = new Map();
  for (const ref of walkProjectMediaReferences(project)) {
    if (statusByPath?.[ref.path] !== false) continue;
    const key = pathKey(ref.path);
    const current = byPath.get(key) ?? {
      path: ref.path,
      fileName: basename(ref.path) || ref.path,
      kind: mediaKindFromPath(ref.path),
      labels: [],
      count: 0,
    };
    current.count += 1;
    if (ref.label && !current.labels.includes(ref.label)) current.labels.push(ref.label);
    byPath.set(key, current);
  }
  return [...byPath.values()].sort((a, b) => a.fileName.localeCompare(b.fileName, 'fr'));
}

function normalizeReplacementMap(replacements = {}) {
  if (replacements instanceof Map) {
    return new Map(
      [...replacements.entries()]
        .filter(([, next]) => hasPath(next))
        .map(([previous, next]) => [pathKey(previous), next]),
    );
  }
  return new Map(
    Object.entries(replacements)
      .filter(([, next]) => hasPath(next))
      .map(([previous, next]) => [pathKey(previous), next]),
  );
}

export function relinkProjectMedia(project, replacements = {}) {
  const map = normalizeReplacementMap(replacements);
  if (map.size === 0) return project;
  const next = structuredClone(project);
  for (const ref of walkProjectMediaReferences(next)) {
    const replacement = replacementForPath(ref.path, map);
    if (replacement) ref.obj[ref.key] = replacement;
  }
  return next;
}

// La même reliaison, côté projet graphe, **sous forme de plan et non de
// mutation**. `relinkProjectMedia` réécrit `binding.path` dans une copie du
// projet : c'est la mutation directe que le mouvement 1 interdit pour un
// document d'auteur, et elle n'entrerait dans aucun historique. Un plan se
// convertit en gestes `repoint-media`, qui sont annulables.
//
// La correspondance se fait par **chemin**, parce que c'est ce qu'un fichier
// déplacé change, et rend l'`assetRef`, parce que c'est par elle qu'une liaison
// est adressée. Une référence citée par le document mais sans liaison n'a pas
// de chemin manquant à relier : elle n'entre pas dans un plan.
//
// Un pas par liaison touchée : une même référence employée par plusieurs Écrans
// ne produit qu'un seul pas, puisque le geste repointe la référence entière.
export function planAdvancedRelink(project, replacements = {}) {
  const map = normalizeReplacementMap(replacements);
  if (map.size === 0) return [];
  const plan = [];
  const seen = new Set();
  for (const binding of readMediaBindings(project)) {
    const assetRef = binding?.assetRef;
    if (typeof assetRef !== 'string' || assetRef === '' || seen.has(assetRef)) continue;
    const replacement = replacementForPath(binding?.path, map);
    if (!replacement) continue;
    seen.add(assetRef);
    plan.push({ assetRef, path: replacement, previousPath: binding.path });
  }
  return plan;
}

export function relinkMediaTags(mediaTags = {}, replacements = {}) {
  const map = normalizeReplacementMap(replacements);
  if (map.size === 0 || !mediaTags || typeof mediaTags !== 'object') return mediaTags ?? {};
  const next = {};
  for (const [tagPath, tags] of Object.entries(mediaTags)) {
    const replacement = replacementForPath(tagPath, map);
    const nextPath = replacement ?? tagPath;
    next[nextPath] = [...new Set([...(next[nextPath] ?? []), ...tags])];
  }
  return next;
}

export function relinkMediaLibraryPaths(paths = [], replacements = {}) {
  const map = normalizeReplacementMap(replacements);
  if (map.size === 0 || !Array.isArray(paths)) return paths ?? [];
  return paths.map((path) => replacementForPath(path, map) ?? path);
}

export function candidatePathsForRelinkRoot(missingPath, selectedRoot) {
  if (!hasPath(missingPath) || !hasPath(selectedRoot)) return [];
  const normalized = pathKey(missingPath);
  const candidates = [];
  for (const dirName of MANAGED_PROJECT_DIRS) {
    const marker = `/${dirName}/`;
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex >= 0) {
      candidates.push(joinPath(selectedRoot, normalized.slice(markerIndex + 1)));
    }
  }
  candidates.push(joinPath(selectedRoot, basename(missingPath)));
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = pathKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Lignes de la boîte « Médias introuvables » après un nouvel audit. Un fichier
// déjà relié, ou en attente d'un choix entre plusieurs correspondances, garde
// son état tant qu'il manque encore ; un fichier revenu à sa place quitte la
// liste, un fichier qui vient de disparaître y entre. Sans cela, chaque
// relecture du disque effaçait le travail de l'auteur dans la boîte.
export function refreshRelinkRows(rows = [], missingMedia = []) {
  const previousByPath = new Map(rows.map((row) => [pathKey(row.path), row]));
  return missingMedia.map((item) => {
    const previous = previousByPath.get(pathKey(item.path));
    return {
      ...item,
      status: previous?.status ?? 'missing',
      replacementPath: previous?.replacementPath ?? '',
      matches: previous?.matches ?? [],
    };
  });
}

// La règle d'ouverture de la proposition de relier, sortie du hook pour être
// éprouvable sans monter React.
//
// Elle ne demande pas d'arbre : `collectMissingMedia` parcourt aussi
// les liaisons d'un projet graphe : la proposition s'ouvre dès que la liste existe.
//
// Les trois autres conditions sont inchangées et ont chacune leur raison : sans
// chemin d'enregistrement, on n'a pas de dossier de référence pour proposer des
// candidats ; pendant un audit, la liste n'est pas encore stable ; et une liste
// déjà rejetée ne se represente pas tant qu'elle n'a pas changé.
//
// L'audit en cours ne retient que l'**ouverture** : une proposition déjà
// ouverte (`proposalOpen`) le reste pendant qu'un audit est relancé. Le retour
// d'une boîte native — choisir un dossier, un fichier — redonne le focus à la
// fenêtre, ce focus relance l'audit, et fermer alors la proposition démontait
// la boîte avec les fichiers que l'auteur venait de relier.
export function shouldProposeMissingMediaRelink({
  projectOpen = false,
  savePath = null,
  pathAuditPending = false,
  proposalOpen = false,
  missingMedia = [],
  missingMediaSignature = '',
  dismissedMissingMediaSignature = '',
} = {}) {
  return projectOpen
    && !!savePath
    && (!pathAuditPending || proposalOpen)
    && missingMedia.length > 0
    && missingMediaSignature !== dismissedMissingMediaSignature;
}

export function buildRelinkSignature(missingMedia = []) {
  return missingMedia.map((item) => pathKey(item.path)).sort().join('|');
}
