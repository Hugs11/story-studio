// Le retour Accueil par défaut de la Lunii.
//
// Un Écran dont le bouton Accueil est actif mais qui n'enregistre aucune
// destination Accueil (`homeTransition` absent ou `null`) n'est pas une impasse :
// la Lunii, et le simulateur avec elle, reviennent à l'Écran d'entrée du pack.
// Ce retour n'est **pas** dans le pack — c'est le comportement de l'appareil —
// mais c'est ainsi que le pack se joue, et l'auteur doit le voir.
//
// Le graphe le dessine donc comme un lien **dérivé** : calculé à la lecture,
// jamais écrit dans le document, jamais rejoué par le générateur, et d'une
// famille visuelle distincte des raccords enregistrés. Le panneau de l'Écran
// le dit de la même façon, et « Choisir une autre destination » le remplace
// par un raccord réel.
//
// Il n'y a pas de retour par défaut :
// - quand le bouton Accueil est désactivé ou non défini : l'appui ne fait rien,
//   ou on ne sait pas ce qu'il fait ;
// - sur l'Écran d'entrée lui-même : Accueil y quitte le pack ;
// - quand le document n'a pas d'Écran d'entrée unique (« À corriger »).

const DEFAULT_HOME_EDGE_SUFFIX = '::home-default';

// L'Écran d'entrée vers lequel la Lunii revient, ou `null` s'il n'est pas
// unique.
export function defaultHomeTarget(index) {
  const entry = index?.view?.entry;
  return entry?.status === 'unique' ? entry.stagePath ?? null : null;
}

// Vrai si l'Écran `entry` revient à l'entrée par le comportement de la Lunii.
function hasDefaultHomeReturn(entry, entryPath) {
  if (!entry || !entryPath || entry.path === entryPath) return false;
  const home = entry.node?.controls?.home;
  if (home?.presence !== 'value' || home.value !== true) return false;
  return entry.node?.homeTransition?.presence !== 'value';
}

// Tous les retours par défaut d'un graphe, sous la forme d'une arête dérivée.
export function defaultHomeReturns(index) {
  const entryPath = defaultHomeTarget(index);
  if (!entryPath) return [];
  return (index.entries ?? [])
    .filter((entry) => hasDefaultHomeReturn(entry, entryPath))
    .map((entry) => ({
      edgeId: `${entry.path}${DEFAULT_HOME_EDGE_SUFFIX}`,
      from: entry.path,
      to: entryPath,
    }));
}

// L'arête dérivée désignée par `edgeId`, ou `null`.
export function defaultHomeReturnOf(index, edgeId) {
  if (typeof edgeId !== 'string' || !edgeId.endsWith(DEFAULT_HOME_EDGE_SUFFIX)) return null;
  const from = edgeId.slice(0, -DEFAULT_HOME_EDGE_SUFFIX.length);
  const entryPath = defaultHomeTarget(index);
  const entry = index?.byPath.get(from) ?? null;
  return hasDefaultHomeReturn(entry, entryPath) ? { edgeId, from, to: entryPath } : null;
}
