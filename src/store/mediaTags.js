// Indexation des étiquettes de médias par chemin.
//
// Un chemin n'a pas une forme unique dans le projet : `normalizeWindowsPath`
// rend les champs médias racines — `rootAudio`, `rootImage`, `thumbnailImage`,
// `nightModeAudio` — avec des antislashs derrière une lettre de lecteur, tandis
// que la résolution d'un chemin relatif rend des `/`. Les deux désignent le même
// fichier. Sous Linux elles coïncident, ce qui rendait invisible le défaut
// qu'elles provoquent ailleurs : sous Windows, une étiquette posée sur le média
// de couverture était introuvable par un `mediaTags[chemin]` direct, et
// disparaissait donc de la vignette, du filtre et du tri de l'explorateur.
//
// `pathKey` est la comparaison de chemins du dépôt : insensible au séparateur,
// et à la casse sur les chemins Windows **seulement** — deux chemins POSIX que
// la casse sépare restent deux fichiers distincts.
//
// **Une carte héritée peut porter plusieurs alias du même fichier**, chacun avec
// ses étiquettes. Lire la première entrée et n'écrire que dans celle-là faisait
// diverger les surfaces : la vignette montrait l'union, le panneau une moitié,
// et un retrait laissait vivre l'étiquette dans l'autre alias. Lecture **et**
// mutations passent donc toutes par ce module, et elles voient toutes les mêmes
// alias. Une écriture les regroupe en une seule clé : la carte cesse d'en porter
// deux dès qu'on y touche, sans qu'aucune étiquette soit perdue.

import { pathKey } from '../utils/fileUtils.js';

// Les entrées de la carte qui désignent ce fichier, dans l'ordre d'insertion.
// La première est la clé canonique : celle qu'une écriture réemploie, pour ne
// pas fabriquer une forme de chemin que le projet n'a jamais portée.
function aliasesOf(mediaTags, key) {
  const aliases = [];
  for (const [tagPath, tags] of Object.entries(mediaTags ?? {})) {
    if (pathKey(tagPath) !== key) continue;
    aliases.push([tagPath, Array.isArray(tags) ? tags : []]);
  }
  return aliases;
}

function mergeTags(aliases, { without = null } = {}) {
  const merged = [];
  for (const [, tags] of aliases) {
    for (const tag of tags) {
      if (tag === without || merged.includes(tag)) continue;
      merged.push(tag);
    }
  }
  return merged;
}

// Réécrit la carte en plaçant `tags` sur `canonical`, à la position du premier
// alias, et en absorbant les autres. Une liste vide retire le média de la carte.
function replaceAliases(mediaTags, key, canonical, tags) {
  const next = {};
  let placed = false;
  for (const [tagPath, value] of Object.entries(mediaTags ?? {})) {
    if (pathKey(tagPath) !== key) {
      next[tagPath] = value;
      continue;
    }
    if (placed) continue;
    placed = true;
    if (tags.length > 0) next[canonical] = tags;
  }
  if (!placed && tags.length > 0) next[canonical] = tags;
  return next;
}

/**
 * Les étiquettes d'un média, quelle que soit la forme du chemin demandé, et
 * quel que soit le nombre d'alias que la carte porte pour lui. Toujours un
 * tableau, jamais `undefined`.
 */
export function mediaTagsFor(mediaTags, path) {
  if (!mediaTags || !path) return [];
  const key = pathKey(path);
  if (!key) return [];
  return mergeTags(aliasesOf(mediaTags, key));
}

/**
 * Pose une étiquette sur un média. Les alias du fichier sont regroupés sur la
 * clé déjà connue ; aucune étiquette n'est perdue au passage, et aucune seconde
 * entrée n'est ouverte sur le même fichier.
 */
export function withMediaTag(mediaTags, path, tag) {
  const source = mediaTags ?? {};
  const label = typeof tag === 'string' ? tag.trim() : '';
  if (!path || !label) return source;
  const key = pathKey(path);
  if (!key) return source;
  const aliases = aliasesOf(source, key);
  const merged = mergeTags(aliases);
  // Rien à faire : un seul alias, et l'étiquette y est déjà. La carte est
  // rendue telle quelle pour que React ne voie pas une modification.
  if (aliases.length <= 1 && merged.includes(label)) return source;
  if (!merged.includes(label)) merged.push(label);
  return replaceAliases(source, key, aliases[0]?.[0] ?? path, merged);
}

/**
 * Retire une étiquette d'un média, **de tous ses alias**. Un retrait qui n'en
 * viderait qu'un laisserait l'étiquette réapparaître à la lecture suivante.
 */
export function withoutMediaTag(mediaTags, path, tag) {
  const source = mediaTags ?? {};
  if (!path) return source;
  const key = pathKey(path);
  if (!key) return source;
  const aliases = aliasesOf(source, key);
  if (aliases.length === 0) return source;
  const merged = mergeTags(aliases, { without: tag });
  if (aliases.length === 1 && merged.length === aliases[0][1].length) return source;
  return replaceAliases(source, key, aliases[0][0], merged);
}

/**
 * L'état de chaque étiquette proposée sur une sélection de médias : posée sur
 * tous, sur une partie, sur aucun.
 *
 * C'est ce que décide le panneau d'étiquettes, sortie du composant pour être
 * éprouvable : elle lit par `mediaTagsFor`, donc tous alias confondus. Le
 * panneau montrait auparavant la première entrée seule, pendant que la vignette
 * montrait l'union — et un retrait portait alors sur autre chose que ce qui
 * était affiché.
 *
 * `fallbackTags` est ce que la ligne portait déjà quand la carte ne connaît pas
 * encore ce chemin. Il ne vaut qu'en sélection simple : une sélection multiple
 * n'a pas de ligne unique d'où le tirer.
 */
export function selectionTagStates(mediaTags, paths, tags, fallbackTags = []) {
  const targets = (paths ?? []).filter(Boolean);
  const bulk = targets.length > 1;
  const perPath = targets.map((path) => {
    const known = mediaTagsFor(mediaTags, path);
    if (known.length > 0) return known;
    return bulk ? [] : (fallbackTags ?? []);
  });
  return (tags ?? []).map((tag) => {
    const taggedCount = perPath.filter((known) => known.includes(tag)).length;
    return {
      tag,
      taggedCount,
      active: targets.length > 0 && taggedCount === targets.length,
      partial: taggedCount > 0 && taggedCount !== targets.length,
    };
  });
}

/**
 * Un lecteur préparé une fois pour une liste de médias.
 *
 * `mediaTagsFor` parcourt la carte à chaque appel : appelé par ligne d'un
 * tableau de plusieurs centaines de médias, puis à nouveau pour le filtre et
 * pour le tri, cela redevient quadratique. Le lecteur construit l'index une
 * seule fois.
 *
 * Deux clés qui désignent le même fichier sont **fusionnées** plutôt que
 * remplacées, exactement comme dans `mediaTagsFor` : les deux accès doivent
 * rendre la même chose, sans quoi la vignette et le panneau se contrediraient.
 */
export function createMediaTagLookup(mediaTags) {
  const index = new Map();
  for (const [tagPath, tags] of Object.entries(mediaTags ?? {})) {
    if (!Array.isArray(tags) || tags.length === 0) continue;
    const key = pathKey(tagPath);
    if (!key) continue;
    const merged = index.get(key);
    if (merged) for (const tag of tags) { if (!merged.includes(tag)) merged.push(tag); }
    else index.set(key, [...tags]);
  }
  return (path) => (path ? index.get(pathKey(path)) ?? [] : []);
}
