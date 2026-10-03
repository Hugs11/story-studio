// Liaison entre une référence d'asset du dialecte avancé et un fichier disque.
//
// `assetRef` (« a1b2c3.mp3 ») appartient au payload d'auteur, que JavaScript
// n'ouvre jamais : c'est une chaîne opaque, jamais un chemin, et le code JavaScript ne la
// réécrit dans aucun cas. Seul `path` est relativisé, résolu ou re-pointé.
// `status` est le dernier état connu du disque, redérivé à chaque audit ; il
// n'autorise jamais à supprimer une liaison, un média manquant restant lié.

import { stripWindowsLongPathPrefix } from '../../utils/fileUtils.js';

export const MEDIA_BINDING_RESOLVED = 'resolved';
export const MEDIA_BINDING_MISSING = 'missing';
const MEDIA_BINDING_SCOPE = 'advanced-asset';

const BINDING_KEYS = new Set(['assetRef', 'path', 'status']);
const BINDING_STATUSES = new Set([MEDIA_BINDING_RESOLVED, MEDIA_BINDING_MISSING]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasPath = (value) => typeof value === 'string' && value.trim().length > 0;

// Liste déclarée du projet. Un projet Libre n'en a pas : le tableau vide laisse
// tous les consommateurs communs inchangés.
export function readMediaBindings(project) {
  const bindings = project?.authoring?.mediaBindings;
  return Array.isArray(bindings) ? bindings : [];
}

export function mediaBindingLabel(binding) {
  const reference = hasPath(binding?.assetRef) ? binding.assetRef : 'référence inconnue';
  return `Média avancé: ${reference}`;
}

// Index par `assetRef`, l'unique identité d'une liaison. La comparaison est
// exacte : deux références ne fusionnent jamais parce que leurs fichiers
// portent le même nom, ni ne se séparent parce que leurs chemins ont bougé.
export function mediaBindingsByAssetRef(project) {
  const byAssetRef = new Map();
  for (const binding of readMediaBindings(project)) {
    if (isObject(binding) && hasPath(binding.assetRef)) byAssetRef.set(binding.assetRef, binding);
  }
  return byAssetRef;
}

// Branche `advanced-asset` de `walkProjectMediaReferences`. Une liaison est
// déjà la forme `{ obj, key, path, label, scope }` : les consommateurs mutent
// `binding.path` sans connaître le mode du projet.
export function* walkMediaBindingReferences(project) {
  for (const binding of readMediaBindings(project)) {
    if (!isObject(binding) || !hasPath(binding.path)) continue;
    yield {
      obj: binding,
      key: 'path',
      path: binding.path,
      label: mediaBindingLabel(binding),
      scope: MEDIA_BINDING_SCOPE,
    };
  }
}

function existenceForPath(path, statusByPath) {
  if (!isObject(statusByPath)) return undefined;
  if (Object.hasOwn(statusByPath, path)) return statusByPath[path];
  const stripped = stripWindowsLongPathPrefix(path);
  return Object.hasOwn(statusByPath, stripped) ? statusByPath[stripped] : undefined;
}

// Recalcule `status` à partir d'un audit disque, sans jamais retirer ni
// réordonner une liaison. Un chemin absent du relevé garde son dernier état
// connu : « non audité » n'est pas « manquant ».
export function resolveMediaBindingStatuses(project, statusByPath = {}) {
  if (readMediaBindings(project).length === 0) return project;
  const next = structuredClone(project);
  for (const binding of readMediaBindings(next)) {
    if (!isObject(binding)) continue;
    if (!hasPath(binding.path)) {
      binding.status = MEDIA_BINDING_MISSING;
      continue;
    }
    const exists = existenceForPath(binding.path, statusByPath);
    if (exists === undefined) continue;
    binding.status = exists ? MEDIA_BINDING_RESOLVED : MEDIA_BINDING_MISSING;
  }
  return next;
}

// Porte de forme de `authoring.mediaBindings`, rendue comme une liste de
// `{ code, path, found, expected }`. Ce module ne jette pas : `envelope.js`
// convertit en `ProjectFormatError`, ce qui évite un cycle d'imports.
export function mediaBindingViolations(bindings) {
  const violations = [];
  const at = (index, field) => `/authoring/mediaBindings/${index}${field ? `/${field}` : ''}`;
  const push = (code, path, found, expected) => violations.push({ code, path, found, expected });
  const seenAssetRefs = new Map();

  bindings.forEach((binding, index) => {
    if (!isObject(binding)) {
      push('INVALID_MEDIA_BINDING', at(index), Array.isArray(binding) ? 'tableau' : String(binding), 'objet de liaison');
      return;
    }
    for (const key of Object.keys(binding)) {
      if (!BINDING_KEYS.has(key)) push('INVALID_MEDIA_BINDING', at(index, key), 'champ inconnu', 'assetRef, path ou status');
    }
    if (!hasPath(binding.assetRef)) {
      push('INVALID_MEDIA_BINDING', at(index, 'assetRef'), String(binding.assetRef), 'référence de dialecte non vide');
    } else if (seenAssetRefs.has(binding.assetRef)) {
      push('DUPLICATE_MEDIA_BINDING', at(index, 'assetRef'), `déjà lié en ${at(seenAssetRefs.get(binding.assetRef))}`, 'une liaison par référence');
    } else {
      seenAssetRefs.set(binding.assetRef, index);
    }
    if (!Object.hasOwn(binding, 'path')) {
      push('INVALID_MEDIA_BINDING', at(index, 'path'), 'absent', 'chemin disque ou null explicite');
    } else if (binding.path !== null && !hasPath(binding.path)) {
      push('INVALID_MEDIA_BINDING', at(index, 'path'), typeof binding.path, 'chemin non vide ou null');
    }
    if (!BINDING_STATUSES.has(binding.status)) {
      push('INVALID_MEDIA_BINDING', at(index, 'status'), String(binding.status), 'resolved ou missing');
    } else if (binding.status === MEDIA_BINDING_RESOLVED && !hasPath(binding.path)) {
      push('INVALID_MEDIA_BINDING', at(index, 'status'), 'resolved sans chemin', 'missing tant que le fichier est inconnu');
    }
  });

  return violations;
}
