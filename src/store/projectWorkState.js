// État de travail du projet, hors React : ce qu'une installation, une mutation
// et une annulation font de la valeur courante, dans les deux modes d'authoring.
//
// La discrimination de mode est ici et nulle part ailleurs dans le store. Un
// projet Libre traverse le normaliseur hiérarchique comme avant ; un projet
// avancé ne le traverse **jamais** — son document vit dans le payload, et
// `normalizeBaseProject` reconstruit un littéral qui en perdrait le bloc entier.
// L'enveloppe avancée est revalidée à la place : une mutation qui la casse est
// refusée au même endroit qu'un fichier mal formé, pas découverte à l'écriture.

import { isAdvancedProject, readProjectEnvelope } from './projectModel/envelope.js';
import { readMediaBindings, resolveMediaBindingStatuses } from './projectModel/mediaBindings.js';
import { getProjectMenuDepthDiagnostic, MAX_MENU_DEPTH } from './projectModel/menuDepth.js';
import { normalizeProjectData } from './projectModel/schema.js';

export { isAdvancedProject };

export const MAX_HISTORY_SIZE = 50;

// La profondeur de Dossiers ne qualifie pas un graphe d'auteur : un projet
// avancé n'a pas d'arbre, et sa validité est celle de son payload. Mesurer
// `rootEntries: []` rendrait « autorisé » pour la mauvaise raison.
const ADVANCED_DEPTH_DIAGNOSTIC = Object.freeze({
  allowed: true,
  code: null,
  maxDepth: MAX_MENU_DEPTH,
  attemptedDepth: 0,
  observedDepth: 0,
  path: [],
  authoringMode: 'advanced',
});

// Installation, remplacement et mutation passent tous par ici. Le projet avancé
// est rendu **tel quel** : la valeur installée est l'objet fourni, ce qui laisse
// les gardes de fraîcheur comparer des identités et n'invente aucun champ.
export function normalizeWorkProject(data) {
  if (!isAdvancedProject(data)) return normalizeProjectData(data);
  readProjectEnvelope(data);
  return data;
}

export function workProjectDepthDiagnostic(project) {
  return isAdvancedProject(project)
    ? ADVANCED_DEPTH_DIAGNOSTIC
    : getProjectMenuDepthDiagnostic(project);
}

// Garde-fou en une seule fonction : aucun composant hiérarchique ne monte sur
// un projet avancé et aucun exporteur Libre ne le qualifie. Le type de projet
// qu'ils lisent est `null`, exactement comme avant qu'un type ne soit choisi.
export function hierarchicalProjectType(project) {
  return isAdvancedProject(project) ? null : (project?.projectType ?? null);
}

// Les trois écrans que le shell peut monter. `hierarchicalProjectType` répond à
// « quel arbre Libre monter ? » et rend donc `null` pour l'avancé ; cette
// fonction-ci répond à « quel espace de travail monter ? », et c'est elle que
// le shell interroge.
//
// La distinction est le tout du garde-fou : rendre un type hiérarchique pour un
// projet avancé rouvrirait les panneaux, la validation et la génération Libre
// sur un document qui n'a pas d'arbre. Renvoyer l'avancé à l'accueil parce que
// ce type est `null` était l'autre moitié du défaut : un projet ouvert n'est
// pas une absence de projet.
export const WORKSPACE_MODE_HOME = null;
export const WORKSPACE_MODE_HIERARCHICAL = 'hierarchical';
export const WORKSPACE_MODE_ADVANCED = 'advanced';

export function authoringWorkspaceMode(project) {
  if (isAdvancedProject(project)) return WORKSPACE_MODE_ADVANCED;
  return project?.projectType ? WORKSPACE_MODE_HIERARCHICAL : WORKSPACE_MODE_HOME;
}

// ── Capacités de projet ──────────────────────────────────────────────────────
// Trois questions distinctes, que l'application posait longtemps avec un seul
// test. Elles vivent ici, ensemble, parce que tout le châssis les lit : les
// disperser rouvrirait la confusion qu'on est en train de fermer.
//
//   « y a-t-il un projet ouvert ? »   → isProjectOpen
//   « ce projet a-t-il un arbre ? »   → hasProjectTree
//   « ce projet a-t-il un graphe ? »  → isAdvancedProject, réexporté plus haut
//
// `isProjectOpen` et `hasProjectTree` ne diffèrent que sur un projet avancé :
// il est ouvert, et il n'a pas d'arbre. C'est exactement l'écart que les sites
// confondaient en lisant `hierarchicalProjectType(...) !== null` pour savoir
// s'il y avait un projet.
//
// Les deux prédicats sont dérivés des deux fonctions ci-dessus, et non d'une
// lecture directe de `projectType` : un projet avancé porte `projectType:
// 'advanced'`, qu'aucun appelant hiérarchique ne doit voir.
export function isProjectOpen(project) {
  return authoringWorkspaceMode(project) !== WORKSPACE_MODE_HOME;
}

export function hasProjectTree(project) {
  return hierarchicalProjectType(project) !== null;
}

// Requalification des liaisons médias par l'audit disque que le shell tient
// déjà. `status` est un relevé, pas une valeur d'auteur : il n'entre ni dans
// l'historique ni dans la signature de travail. Le résultat est `null` quand
// rien n'a bougé, pour ne pas réinstaller un projet identique à chaque relevé —
// et un chemin absent du relevé garde son dernier état, « non audité » n'étant
// pas « manquant ».
export function requalifiedMediaBindings(project, statusByPath) {
  if (!isAdvancedProject(project)) return null;
  const next = resolveMediaBindingStatuses(project, statusByPath);
  if (next === project) return null;
  const before = readMediaBindings(project);
  return readMediaBindings(next).some((binding, index) => binding?.status !== before[index]?.status)
    ? next
    : null;
}

// ── État de départ ───────────────────────────────────────────────────────────
// Un travail qu'on vient de créer ou d'ouvrir depuis un pack n'a encore rien à
// perdre. Son état de départ est retenu ; tant que le projet lui est identique,
// la garde de sauvegarde ne pose aucune question. Un ajustement automatique
// (rangement initial, requalification des médias) n'est pas un geste de
// l'auteur : appliqué à un travail encore intact, il déplace l'état de départ
// au lieu de le rendre « modifié ».

export function workBaseline(project) {
  return JSON.stringify(project);
}

export function isPristineWork(baseline, project) {
  return baseline !== null && baseline === workBaseline(project);
}

export function followSystemChange(baseline, current, next) {
  return isPristineWork(baseline, current) ? workBaseline(next) : baseline;
}

// ── Historique ───────────────────────────────────────────────────────────────
// Les transitions sont pures et portent la valeur entière du projet : en mode
// avancé, annuler restaure donc le couple document + contexte de la chaîne
// précédente, sa vue et ses liaisons, sans rien redécoder.

export function pushWorkHistory(history, previous) {
  return [...history.slice(-(MAX_HISTORY_SIZE - 1)), previous];
}

export function undoWorkHistory({ history, redo, current }) {
  if (history.length === 0) return null;
  return {
    project: history[history.length - 1],
    history: history.slice(0, -1),
    redo: [...redo, current],
  };
}

// Relocalise chaque étape des deux piles. `relocate(project)` rend l'étape
// (repointée ou telle quelle), ou `null` si elle désigne un fichier qui va
// disparaître : cette étape n'est plus restaurable, ni celles qu'on n'atteint
// qu'en passant par elle — les plus anciennes pour annuler, les plus lointaines
// pour rétablir.
export function relocateWorkHistory({ history, redo, relocate }) {
  const relocateStack = (stack) => {
    const relocated = stack.map(relocate);
    const lastLost = relocated.lastIndexOf(null);
    return relocated.slice(lastLost + 1);
  };
  return { history: relocateStack(history), redo: relocateStack(redo) };
}

export function redoWorkHistory({ history, redo, current }) {
  if (redo.length === 0) return null;
  return {
    project: redo[redo.length - 1],
    history: [...history, current],
    redo: redo.slice(0, -1),
  };
}
