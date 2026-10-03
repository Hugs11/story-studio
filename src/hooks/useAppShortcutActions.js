import { useSyncedRef } from './useSyncedRef.js';
import { WORKSPACE_MODE_ADVANCED } from '../store/projectWorkState.js';

export function resolveStructureSearchTarget({
  workspaceMode,
  projectType,
  treeVisible,
  diagramVisible,
  advancedNodeListVisible = false,
  activeSurface = null,
}) {
  if (workspaceMode === WORKSPACE_MODE_ADVANCED) {
    return advancedNodeListVisible ? 'advanced' : null;
  }
  const treeAvailable = projectType === 'pack' && treeVisible;
  if (activeSurface === 'diagram' && diagramVisible) return 'diagram';
  if (activeSurface === 'tree' && treeAvailable) return 'tree';
  if (treeAvailable) return 'tree';
  if (diagramVisible) return 'diagram';
  return null;
}

function getActiveStructureSurface() {
  if (typeof document === 'undefined') return null;
  const activeElement = document.activeElement;
  if (activeElement?.closest?.('.advanced-panel--nodes')) return 'advanced';
  if (activeElement?.closest?.('.fd-panel')) return 'diagram';
  if (activeElement?.closest?.('.structure-panel')) return 'tree';
  return null;
}

// Table d'actions des raccourcis clavier : maintient shortcutActionsRef, la
// table lue par les listeners installés par useAppShortcuts. Déplacement pur du
// bloc qui vivait dans AppContent.
// useSyncedRef écrit la ref PENDANT le rendu (pas dans un effet) : ne pas le
// remplacer par un useEffect. Les clés sont des ids d'action alignés avec les
// préférences clavier (store/keyboardShortcuts.js) : ne pas les renommer. Les
// raccourcis sauvegarder/sauvegarder sous ne passent pas par cette table, ils
// sont câblés en dur dans useAppShortcuts via saveHandlerRef/saveAsHandlerRef.
//
// `commands` est la table **gardée** par le verrou d'auteur (useAuthorCommandLock) :
// undo, redo, nouveau projet et ouvrir y sont déjà tenus pendant un export. La
// table expose aussi des disponibilités, et elles doivent dire la même chose —
// un `canUndo` brut afficherait Annuler comme disponible pendant l'écriture de
// l'archive, et la commande serait ensuite refusée sans explication.
export function useAppShortcutActions({ shortcutActionsRef, ...inputs }) {
  useSyncedRef(shortcutActionsRef, buildShortcutActions(inputs));
}

// La table elle-même, sans React : c'est elle que les listeners lisent, et c'est
// donc elle qui doit pouvoir être éprouvée — notamment qu'une commande tenue par
// le verrou d'auteur y soit tenue **et** annoncée indisponible.
export function buildShortcutActions({
  store,
  modals,
  workspaceViewState,
  setTreeSearchFocusTrigger,
  setDiagramSearchFocusTrigger,
  commands,
  handleAddStory,
  handleGenerate,
  // `projectType` sert ici à une question de forme d'arbre : seul 'pack' a une
  // recherche d'arbre. La capacité, elle, est `projectOpen` — la question que
  // ces sites voulaient poser.
  projectType,
  projectOpen,
  workspaceMode = null,
  advancedNodeListVisible = false,
  // La capacité d'arbre revient ici pour **une** question, celle de la
  // recherche de structure : « y a-t-il une surface d'arbre à chercher ? ».
  // Elle ne gouverne plus aucun affichage de châssis — c'est `projectOpen` et
  // l'inventaire qui s'en chargent.
  hasProjectTree = false,
  // La table `id → { available }` de l'inventaire de la barre. Les
  // disponibilités des commandes communes en viennent **toutes** : les
  // recalculer ici ferait diverger le clavier de la souris, et une commande
  // annoncée disponible serait ensuite refusée sans explication.
  toolbarCommands = {},
  canImportStories,
  canAddFolder,
}) {
  const availability = (id) => toolbarCommands[id]?.available === true;
  return {
    newProject: commands.newProject,
    openProject: commands.openProject,
    openPack: commands.openPack,
    importStories: handleAddStory,
    addFolder: () => store.addMenu(),
    openPackOptions: () => modals.open('packOptions'),
    openPreferences: () => modals.open('prefs'),
    toggleTree: workspaceViewState.toggleTree,
    toggleSettings: workspaceViewState.toggleSettings,
    toggleDiagram: workspaceViewState.toggleDiagram,
    generate: handleGenerate,
    focusTreeSearch: () => {
      const target = resolveStructureSearchTarget({
        workspaceMode,
        projectType,
        treeVisible: workspaceViewState.treeVisible,
        diagramVisible: workspaceViewState.showDiagram,
        advancedNodeListVisible,
        activeSurface: getActiveStructureSurface(),
      });
      if (target === 'tree' || target === 'advanced') {
        setTreeSearchFocusTrigger((n) => n + 1);
      } else if (target === 'diagram') {
        setDiagramSearchFocusTrigger((n) => n + 1);
      }
    },
    toggleValidation: () => modals.toggle('validation'),
    undo: commands.undo,
    redo: commands.redo,
    projectActionsVisible: !!projectOpen,
    // La recherche de structure vise la liste des nœuds du Graphe, ou les
    // surfaces de structure du Libre (arbre et diagramme). Un panneau masqué
    // n'intercepte pas Ctrl+F : sa commande de réouverture reste dans la barre.
    treeSearchVisible: workspaceMode === WORKSPACE_MODE_ADVANCED
      ? advancedNodeListVisible
      : hasProjectTree
        && ((projectType === 'pack' && workspaceViewState.treeVisible) || workspaceViewState.showDiagram),
    canImportStories,
    canAddFolder,
    // **Toutes** les disponibilités viennent de l'inventaire, y compris celles
    // des commandes structurelles. Une commande absente de l'éditeur courant y
    // est absente, donc indisponible : le raccourci de génération ne répond pas
    // dans le graphe, où le bouton n'existe pas, et les bascules de panneaux ne
    // répondent pas non plus — elles écriraient les préférences de panneaux du
    // Libre depuis un éditeur qui n'en a aucun.
    canGenerate: availability('generate'),
    canUndo: availability('undo'),
    canRedo: availability('redo'),
    canOpenPack: availability('openPack'),
    canOpenPackOptions: availability('openPackOptions'),
    canToggleTree: availability('toggleTree'),
    canToggleSettings: availability('toggleSettings'),
    canToggleDiagram: availability('toggleDiagram'),
    canOpenPreferences: availability('openPreferences'),
    canToggleValidation: availability('toggleValidation'),
  };
}
