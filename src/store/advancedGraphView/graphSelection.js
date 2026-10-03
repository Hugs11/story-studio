// Sélection, focus et revalidation des ancrages.
//
// Deux règles portent tout le fichier :
//
// 1. Une entrée de cache qui ne désigne plus rien est **ignorée à l'affichage,
//    pas purgée**. C'est ce qui fait qu'un nœud supprimé puis restauré par undo
//    retrouve sa sélection. Le cache *connaît* le graphe, et renonce
//    quand même à purger.
// 2. **La caméra ne bouge jamais** du fait d'un undo, d'un redo ou d'un geste
//    d'auteur. Elle ne répond qu'à un geste de vue de l'auteur.

// Un clic simple sur le canvas doit piloter la même cible que la liste et
// l'inspecteur. En sélection multiple, le focus courant reste stable tant
// qu'il appartient encore à la sélection ; sinon la première cible survivante
// devient la cible d'édition. Un clic dans le vide vide aussi le focus.
export function focusAfterGraphSelection(paths, currentFocus = null) {
  if (currentFocus && paths.includes(currentFocus)) return currentFocus;
  return paths[0] ?? null;
}

// La sélection **affichée** : les entrées dont le chemin existe encore, dans
// leur ordre. Celles qui ne désignent plus rien sont ignorées, sans purge.
export function resolveSelection(index, stored) {
  const exists = (path) => index.byPath.has(path);
  const stages = (stored?.stages ?? []).filter(exists);
  const actions = (stored?.actions ?? []).filter(exists);
  return { stages, actions, ignored: countIgnored(stored, stages, actions) };
}

function countIgnored(stored, stages, actions) {
  const storedCount = (stored?.stages?.length ?? 0) + (stored?.actions?.length ?? 0);
  return storedCount - stages.length - actions.length;
}

// Politique de focus après undo, redo ou geste d'auteur — **déterministe**.
//
// Le focus reste `lastFocusedPath` s'il existe ; sinon il tombe sur la première
// entrée de sélection survivante ; sinon sur l'Écran d'entrée ; sinon sur rien.
// Plusieurs règles déterministes étaient possibles ; celle-ci est fixée, et la
// fixer vaut mieux que la choisir à chaque écran.
export function resolveFocus(index, stored, entry) {
  const candidate = stored?.lastFocusedPath;
  if (candidate && index.byPath.has(candidate)) return candidate;
  const resolved = resolveSelection(index, stored);
  const survivor = resolved.stages[0] ?? resolved.actions[0] ?? null;
  if (survivor) return survivor;
  // L'Écran d'entrée n'est un repli que s'il est unique : sur un document
  // ambigu, choisir l'un des candidats serait décider à la place de l'auteur.
  if (entry?.status === 'unique' && entry.stagePath && index.byPath.has(entry.stagePath)) {
    return entry.stagePath;
  }
  return null;
}

// Ce que le cache relu donne à la vue, une fois confronté au graphe.
//
// Le `viewport` est appliqué même quand l'empreinte du document a divergé : une
// caméra ne s'ancre à aucun nœud. Seuls les ancrages sont revalidés.
export function applyCachedView({ index, cached, entry }) {
  const stored = cached?.view ?? null;
  const resolved = resolveSelection(index, stored?.selection);
  return {
    viewport: stored?.viewport ?? null,
    viewportRejected: cached?.viewportRejected === true,
    selection: { stages: resolved.stages, actions: resolved.actions },
    ignoredAnchors: resolved.ignored,
    focus: resolveFocus(index, {
      ...stored?.selection,
      lastFocusedPath: stored?.lastFocusedPath ?? null,
    }, entry),
    // Informatif : il ne déclenche aucune purge et aucune écriture.
    documentChangedSinceWrite: cached ? cached.fingerprintMatches === false : false,
  };
}
