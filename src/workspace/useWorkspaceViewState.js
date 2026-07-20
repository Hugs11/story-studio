import { useCallback } from 'react';
import { usePersistentState } from '../hooks/usePersistentState';
import { KEYS } from '../store/persistentSettings';
import { LEFT_PANEL_MIN_WIDTH, TREE_PANEL_MAX_WIDTH } from '../components/structure/panelResize';
import {
  DEFAULT_WORKSPACE_PANEL_ORDER,
  reorderWorkspacePanels,
  WORKSPACE_PANEL_ORDER_CODEC,
} from './panelLayout';

export const SETTINGS_PANEL_WIDTH_MIN = 400;
export const SETTINGS_PANEL_WIDTH_MAX = 900;
export const SETTINGS_PANEL_WIDTH_DEFAULT = 800;
export const TREE_PANEL_WIDTH_DEFAULT = 320;

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

export function getTreePanelMaxWidth() {
  return TREE_PANEL_MAX_WIDTH;
}

// Codec booléen stable (défini au niveau module pour ne pas réécrire à chaque rendu).
const BOOL_CODEC = Object.freeze({
  decode: (value) => value === 'true',
  encode: (value) => (value ? 'true' : 'false'),
});

function widthCodec(min, max, fallback) {
  return Object.freeze({
    decode: (value) => clampNumber(value, min, max, fallback),
    encode: (value) => String(clampNumber(value, min, max, fallback)),
  });
}

const SETTINGS_PANEL_WIDTH_CODEC = widthCodec(
  SETTINGS_PANEL_WIDTH_MIN,
  SETTINGS_PANEL_WIDTH_MAX,
  SETTINGS_PANEL_WIDTH_DEFAULT,
);
const TREE_PANEL_WIDTH_CODEC = widthCodec(
  LEFT_PANEL_MIN_WIDTH,
  getTreePanelMaxWidth(),
  TREE_PANEL_WIDTH_DEFAULT,
);

// Modèle « 3 bascules » : trois booléens indépendants. Les anciens états de vue
// sont des dérivés de lecture ; les trois panneaux peuvent être masqués.
export function useWorkspaceViewState() {
  const [showTree, setShowTree] = usePersistentState(KEYS.DIAGRAM_SHOW_TREE, true, BOOL_CODEC);
  const [showSettings, setShowSettings] = usePersistentState(KEYS.DIAGRAM_SHOW_SETTINGS, true, BOOL_CODEC);
  const [showDiagram, setShowDiagram] = usePersistentState(KEYS.DIAGRAM_SHOW_DIAGRAM, false, BOOL_CODEC);
  const [panelOrder, setPanelOrder] = usePersistentState(
    KEYS.WORKSPACE_PANEL_ORDER,
    [...DEFAULT_WORKSPACE_PANEL_ORDER],
    WORKSPACE_PANEL_ORDER_CODEC,
  );
  const [settingsPanelWidth, setStoredSettingsPanelWidth] = usePersistentState(
    KEYS.SETTINGS_PANEL_WIDTH,
    SETTINGS_PANEL_WIDTH_DEFAULT,
    SETTINGS_PANEL_WIDTH_CODEC,
  );
  const [treePanelWidth, setStoredTreePanelWidth] = usePersistentState(
    KEYS.TREE_PANEL_WIDTH,
    TREE_PANEL_WIDTH_DEFAULT,
    TREE_PANEL_WIDTH_CODEC,
  );

  // L'arbre est libre : aucune contrainte d'invariant.
  const toggleTree = useCallback(() => {
    setShowTree((current) => !current);
  }, [setShowTree]);

  const toggleSettings = useCallback(() => {
    setShowSettings(!showSettings);
  }, [setShowSettings, showSettings]);

  const toggleDiagram = useCallback(() => {
    setShowDiagram(!showDiagram);
  }, [setShowDiagram, showDiagram]);

  // Réaffiche les Réglages quand une action du diagramme doit ouvrir l'éditeur.
  const restoreSettings = useCallback(() => {
    setShowSettings(true);
  }, [setShowSettings]);

  const closeDiagram = useCallback(() => {
    setShowDiagram(false);
  }, [setShowDiagram]);

  const movePanel = useCallback((activeId, overId) => {
    setPanelOrder((current) => reorderWorkspacePanels(current, activeId, overId));
  }, [setPanelOrder]);

  const setSettingsPanelWidth = useCallback((width) => {
    setStoredSettingsPanelWidth(clampNumber(
      width,
      SETTINGS_PANEL_WIDTH_MIN,
      SETTINGS_PANEL_WIDTH_MAX,
      SETTINGS_PANEL_WIDTH_DEFAULT,
    ));
  }, [setStoredSettingsPanelWidth]);

  const setTreePanelWidth = useCallback((width) => {
    setStoredTreePanelWidth(clampNumber(
      width,
      LEFT_PANEL_MIN_WIDTH,
      getTreePanelMaxWidth(),
      TREE_PANEL_WIDTH_DEFAULT,
    ));
  }, [setStoredTreePanelWidth]);

  return {
    // bascules
    showTree,
    showSettings,
    showDiagram,
    panelOrder,
    // dérivé de lecture : le diagramme est seul quand Réglages est masqué.
    isPlein: showDiagram && !showSettings,
    treeVisible: showTree,
    // actions
    toggleTree,
    toggleSettings,
    toggleDiagram,
    restoreSettings,
    closeDiagram,
    movePanel,
    // largeurs
    settingsPanelWidth,
    setSettingsPanelWidth,
    treePanelWidth,
    setTreePanelWidth,
  };
}
