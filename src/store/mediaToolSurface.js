// Les outils média, des deux côtés.
//
// Quatre outils — podcast, YouTube, micro, voix de synthèse — produisent un
// fichier audio. Ce que ce fichier **est** ne dépend pas de l'éditeur ouvert ;
// seuls son point d'arrivée et le voisinage qu'on lui offre en dépendent.
//
// Ce module tient ces deux règles, et rien d'autre : elles sont la seule chose
// qui diffère entre les deux éditeurs, et les écrire deux fois les ferait
// diverger comme ont divergé deux jeux de réglages audio.
//
// **Le point d'arrivée.** Côté Libre, le son produit devient une histoire dans
// le dossier visé — comportement historique, qui ne se renégocie pas. Côté
// graphe, il entre dans la bibliothèque de médias, et l'auteur le pose ensuite
// sur l'Écran de son choix par le geste de dépôt. Faire atterrir un son
// directement sur un Écran créerait une modification du document que personne
// n'a demandée ; la bibliothèque est le point d'arrivée neutre, et le dépôt
// reste un geste, annulable et historisé.
//
// **Ce que la barre montre.** Trois de ses actions visent un dossier de
// l'arbre : ajouter une histoire, créer un dossier, importer un dossier. Sur un
// document de graphe, il n'y a pas d'arbre, donc pas d'objet. Elles n'y sont
// pas montrées — ni telles quelles, ni déguisées. L'import de fichiers y prend
// la seule forme qui ait un sens : l'entrée dans la bibliothèque.

import { WORKSPACE_MODE_ADVANCED } from './projectWorkState.js';

export const MEDIA_LANDING_TREE = 'tree';
export const MEDIA_LANDING_LIBRARY = 'library';

/** Où atterrit le son produit par un outil, selon l'éditeur ouvert. */
export function mediaToolLanding(workspaceMode) {
  return workspaceMode === WORKSPACE_MODE_ADVANCED ? MEDIA_LANDING_LIBRARY : MEDIA_LANDING_TREE;
}

// Les actions de la barre. Les identifiants sont ceux que la barre peint ;
// l'ordre du côté Libre est celui d'origine, au bouton près.
export const MEDIA_TOOL_ACTIONS = Object.freeze({
  IMPORT_STORY: 'import-story',
  ADD_FOLDER: 'add-folder',
  IMPORT_FOLDER: 'import-folder',
  IMPORT_MEDIA: 'import-media',
  IMPORT_PODCAST: 'import-podcast',
  IMPORT_YOUTUBE: 'import-youtube',
  RECORD: 'record',
  GENERATE_TTS: 'generate-tts',
  SIMULATOR: 'simulator',
});

const TREE_BAR = Object.freeze([
  MEDIA_TOOL_ACTIONS.IMPORT_STORY,
  MEDIA_TOOL_ACTIONS.ADD_FOLDER,
  MEDIA_TOOL_ACTIONS.IMPORT_FOLDER,
  MEDIA_TOOL_ACTIONS.IMPORT_PODCAST,
  MEDIA_TOOL_ACTIONS.IMPORT_YOUTUBE,
  MEDIA_TOOL_ACTIONS.RECORD,
  MEDIA_TOOL_ACTIONS.GENERATE_TTS,
  MEDIA_TOOL_ACTIONS.SIMULATOR,
]);

// Côté graphe, ces actions vivent dans le L ancré au canvas. L'écoute y garde
// la même petite icône que dans le Libre ; la liste des nœuds garde sa recherche
// locale, sans recopier les outils de production de médias.
const GRAPH_BAR = Object.freeze([
  MEDIA_TOOL_ACTIONS.IMPORT_MEDIA,
  MEDIA_TOOL_ACTIONS.IMPORT_PODCAST,
  MEDIA_TOOL_ACTIONS.IMPORT_YOUTUBE,
  MEDIA_TOOL_ACTIONS.RECORD,
  MEDIA_TOOL_ACTIONS.GENERATE_TTS,
  MEDIA_TOOL_ACTIONS.SIMULATOR,
]);

/** Les actions qui ont un objet dans cet éditeur, dans leur ordre d'apparition. */
export function mediaToolActionIds(workspaceMode) {
  return workspaceMode === WORKSPACE_MODE_ADVANCED ? GRAPH_BAR : TREE_BAR;
}

/**
 * Le plan d'atterrissage d'un média produit — **une valeur, pas un effet**.
 *
 * Écrit ici une seule fois pour les quatre outils : chacun appelle son moteur à
 * sa façon, mais aucun ne décide seul où son résultat atterrit. C'est aussi ce
 * qui rend la contrainte vérifiable sans monter d'écran : un plan de graphe ne
 * porte jamais d'identifiant de dossier, donc ne peut pas créer d'Écran.
 *
 * `imagePath` est la vignette qu'un épisode ou une vidéo amène avec lui. Côté
 * Libre elle devient l'image de l'histoire créée ; côté graphe elle entre dans
 * la bibliothèque à côté de l'audio, sans être attachée à quoi que ce soit.
 */
export function planProducedMediaLanding({
  landing,
  audioPath,
  imagePath = null,
  targetMenuId = null,
}) {
  if (!audioPath) return null;
  if (landing === MEDIA_LANDING_LIBRARY) {
    return Object.freeze({
      kind: MEDIA_LANDING_LIBRARY,
      paths: Object.freeze([audioPath, imagePath].filter(Boolean)),
    });
  }
  return Object.freeze({
    kind: MEDIA_LANDING_TREE,
    menuId: targetMenuId ?? null,
    audioPath,
    imagePath: imagePath ?? null,
  });
}
