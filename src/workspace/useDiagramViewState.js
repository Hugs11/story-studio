import { useCallback, useMemo } from 'react';
import { usePersistentState } from '../hooks/usePersistentState';
import { KEYS } from '../store/persistentSettings';
import { LEFT_PANEL_MIN_WIDTH } from '../components/structure/panelResize';

export const DIAGRAM_COLUMN_WIDTH_MIN = 340;
export const DIAGRAM_COLUMN_WIDTH_MAX = 920;
const DIAGRAM_COLUMN_WIDTH_DEFAULT = 470;
const TREE_PANEL_WIDTH_DEFAULT = 320;

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

export function getTreePanelMaxWidth() {
  if (typeof window === 'undefined') return 640;
  return Math.max(LEFT_PANEL_MIN_WIDTH, Math.round(window.innerWidth * 0.42));
}

// Codec booléen stable (défini au niveau module pour ne pas réécrire à chaque render).
const BOOL_CODEC = Object.freeze({
  decode: (value) => value === 'true',
  encode: (value) => (value ? 'true' : 'false'),
});

function widthCodec(min, max, fallback) {
  return {
    decode: (value) => clampNumber(value, min, max, fallback),
    encode: (value) => String(clampNumber(value, min, max, fallback)),
  };
}

// Modèle « 3 bascules » : trois booléens indépendants (showTree / showSettings /
// showDiagram) avec l'invariant « Réglages ou Diagramme toujours visible ». Les
// anciens « états » (ferme/colonne/plein) ne sont plus que des dérivés de lecture.
export function useDiagramViewState() {
  const treeWidthCodec = useMemo(() => ({
    decode: (value) => clampNumber(value, LEFT_PANEL_MIN_WIDTH, getTreePanelMaxWidth(), TREE_PANEL_WIDTH_DEFAULT),
    encode: (value) => String(clampNumber(value, LEFT_PANEL_MIN_WIDTH, getTreePanelMaxWidth(), TREE_PANEL_WIDTH_DEFAULT)),
  }), []);

  const [showTree, setShowTree] = usePersistentState(KEYS.DIAGRAM_SHOW_TREE, true, BOOL_CODEC);
  const [showSettings, setShowSettings] = usePersistentState(KEYS.DIAGRAM_SHOW_SETTINGS, true, BOOL_CODEC);
  const [showDiagram, setShowDiagram] = usePersistentState(KEYS.DIAGRAM_SHOW_DIAGRAM, false, BOOL_CODEC);
  const [diagramColumnWidth, setStoredDiagramColumnWidth] = usePersistentState(
    KEYS.DIAGRAM_COLUMN_WIDTH,
    DIAGRAM_COLUMN_WIDTH_DEFAULT,
    widthCodec(DIAGRAM_COLUMN_WIDTH_MIN, DIAGRAM_COLUMN_WIDTH_MAX, DIAGRAM_COLUMN_WIDTH_DEFAULT),
  );
  const [treePanelWidth, setStoredTreePanelWidth] = usePersistentState(
    KEYS.TREE_PANEL_WIDTH,
    TREE_PANEL_WIDTH_DEFAULT,
    treeWidthCodec,
  );

  // L'arbre est libre : aucune contrainte d'invariant.
  const toggleTree = useCallback(() => {
    setShowTree((current) => !current);
  }, [setShowTree]);

  // Réglages : bloqué s'il est le seul panneau central (on ne peut pas tout cacher).
  const toggleSettings = useCallback(() => {
    if (showSettings && !showDiagram) return;
    setShowSettings(!showSettings);
  }, [setShowSettings, showSettings, showDiagram]);

  // Diagramme : en « plein » (diagramme seul), l'éteindre restaure les Réglages
  // pour respecter l'invariant ; sinon bascule simple.
  const toggleDiagram = useCallback(() => {
    if (showDiagram && !showSettings) {
      setShowDiagram(false);
      setShowSettings(true);
      return;
    }
    setShowDiagram(!showDiagram);
  }, [setShowDiagram, setShowSettings, showDiagram, showSettings]);

  // Agrandir : diagramme pleine largeur (masque les Réglages).
  const maximizeDiagram = useCallback(() => {
    setShowSettings(false);
  }, [setShowSettings]);

  // Réduire : réaffiche les Réglages à côté du diagramme.
  const restoreSettings = useCallback(() => {
    setShowSettings(true);
  }, [setShowSettings]);

  // Fermer (✕) depuis l'en-tête du diagramme : garantir showDiagram=false tout en
  // préservant l'invariant.
  const closeDiagram = useCallback(() => {
    setShowDiagram(false);
    if (!showSettings) setShowSettings(true);
  }, [setShowDiagram, setShowSettings, showSettings]);

  const setDiagramColumnWidth = useCallback((width) => {
    setStoredDiagramColumnWidth(clampNumber(
      width,
      DIAGRAM_COLUMN_WIDTH_MIN,
      DIAGRAM_COLUMN_WIDTH_MAX,
      DIAGRAM_COLUMN_WIDTH_DEFAULT,
    ));
  }, [setStoredDiagramColumnWidth]);

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
    // dérivés de lecture (présentation)
    isFerme: !showDiagram,
    isColonne: showSettings && showDiagram,
    isPlein: showDiagram && !showSettings,
    treeVisible: showTree,
    // actions
    toggleTree,
    toggleSettings,
    toggleDiagram,
    maximizeDiagram,
    restoreSettings,
    closeDiagram,
    // largeurs
    diagramColumnWidth,
    setDiagramColumnWidth,
    treePanelWidth,
    setTreePanelWidth,
  };
}
