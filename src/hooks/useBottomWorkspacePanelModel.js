import { useEffect, useMemo } from 'react';
import {
  EDITOR_LAYOUT_SCOPE,
  editorLayoutKeys,
} from '../store/persistentSettings';
import { collectMediaLibrary } from '../store/mediaLibrary';
import { usePersistentState } from './usePersistentState';

// Codec booléen privé du panneau bas (`bottomPanelOpen`). Copie locale : il n'y a
// pas de raison de partager un helper tant qu'un seul consommateur l'utilise.
const BOOL_CODEC = { decode: (raw) => raw === 'true', encode: (value) => String(!!value) };

// Modèle du panneau de travail bas et de la bottombar : état ouvert/onglet
// actif (persistés), ouverture automatique depuis la file de rendu, compteurs
// médias/IA. Déplacement pur du haut d'AppContent.
//
// Ordre d'appel critique dans l'hôte : `setOpen`/`setActiveTab` sont passés à
// `useAiGeneration` (ouverture de la file IA) — ce hook doit donc être appelé
// AVANT `useAiGeneration`. `mediaLibraryPaths` vient de `useMediaLibraryPaths`,
// qui doit précéder. `mediaLibraryCountRef` est fournie par l'hôte (consommée par
// useWorkSession/useAutosave) : le hook la synchronise à chaque rendu.
//
// Fidélité de persistance : `bottomPanelOpen` via le codec booléen ci-dessus,
// `bottomPanelTab` en string brute, sans codec (comportement historique).
// Ne pas ajouter de mémoïsation — seul le `useMemo` déjà présent
// (`mediaLibraryCount`) est déplacé tel quel.
export function useBottomWorkspacePanelModel({
  editorScope,
  project,
  pathAudit,
  sdJobs,
  xttsJobs,
  sdPendingCount,
  xttsPendingCount,
  sdHasResults,
  xttsHasResults,
  mediaLibraryPaths,
  advancedMediaUsages = null,
  mediaLibraryCountRef,
  renderQueue,
}) {
  const freeKeys = editorLayoutKeys(EDITOR_LAYOUT_SCOPE.FREE);
  const advancedKeys = editorLayoutKeys(EDITOR_LAYOUT_SCOPE.ADVANCED);
  const [freeOpen, setFreeOpen] = usePersistentState(
    freeKeys.bottomPanelOpen,
    false,
    BOOL_CODEC,
  );
  const [freeActiveTab, setFreeActiveTab] = usePersistentState(
    freeKeys.bottomPanelTab,
    'media',
  );
  const [advancedOpen, setAdvancedOpen] = usePersistentState(
    advancedKeys.bottomPanelOpen,
    false,
    BOOL_CODEC,
  );
  const [advancedActiveTab, setAdvancedActiveTab] = usePersistentState(
    advancedKeys.bottomPanelTab,
    'media',
  );
  const advanced = editorScope === EDITOR_LAYOUT_SCOPE.ADVANCED;
  const open = advanced ? advancedOpen : freeOpen;
  const setOpen = advanced ? setAdvancedOpen : setFreeOpen;
  const activeTab = advanced ? advancedActiveTab : freeActiveTab;
  const setActiveTab = advanced ? setAdvancedActiveTab : setFreeActiveTab;
  const layoutKeys = advanced ? advancedKeys : freeKeys;

  const aiQueueActiveCount = sdPendingCount + xttsPendingCount;
  const aiQueueHasResults = sdHasResults || xttsHasResults;

  useEffect(() => {
    if (renderQueue.panelOpen) {
      setOpen(true);
      setActiveTab('queue');
      renderQueue.setPanelOpen(false);
    }
  }, [renderQueue.panelOpen, renderQueue.setPanelOpen]);

  const mediaLibraryCount = useMemo(
    () => collectMediaLibrary({
      project, statusByPath: pathAudit, sdJobs, xttsJobs,
      extraPaths: mediaLibraryPaths, advancedUsages: advancedMediaUsages,
    }).length,
    [project, pathAudit, sdJobs, xttsJobs, mediaLibraryPaths, advancedMediaUsages],
  );
  mediaLibraryCountRef.current = mediaLibraryCount;

  const openTab = (tab) => {
    setActiveTab(tab);
    setOpen(true);
  };
  const close = () => setOpen(false);

  return {
    editorScope,
    heightKey: layoutKeys.bottomPanelHeight,
    open,
    activeTab,
    setOpen,
    setActiveTab,
    openTab,
    close,
    mediaLibraryCount,
    aiQueueActiveCount,
    aiQueueHasResults,
  };
}
