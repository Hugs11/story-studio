import { useCallback, useMemo } from 'react';
import { usePersistentState } from '../hooks/usePersistentState';
import { KEYS } from '../store/persistentSettings';
import {
  ADVANCED_INSPECTOR_WIDTH_DEFAULT,
  ADVANCED_INSPECTOR_WIDTH_MAX,
  ADVANCED_INSPECTOR_WIDTH_MIN,
  ADVANCED_NODE_LIST_WIDTH_DEFAULT,
  ADVANCED_NODE_LIST_WIDTH_MAX,
  ADVANCED_NODE_LIST_WIDTH_MIN,
  ADVANCED_WORKSPACE_PANEL_ORDER_CODEC,
  DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER,
  reorderAdvancedWorkspacePanels,
} from './panelLayout';

const BOOL_CODEC = Object.freeze({
  decode: (value) => value === 'true',
  encode: (value) => (value ? 'true' : 'false'),
});

function clampWidth(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function widthCodec(min, max, fallback) {
  return Object.freeze({
    decode: (value) => clampWidth(value, min, max, fallback),
    encode: (value) => String(clampWidth(value, min, max, fallback)),
  });
}

const NODE_LIST_WIDTH_CODEC = widthCodec(
  ADVANCED_NODE_LIST_WIDTH_MIN,
  ADVANCED_NODE_LIST_WIDTH_MAX,
  ADVANCED_NODE_LIST_WIDTH_DEFAULT,
);
const INSPECTOR_WIDTH_CODEC = widthCodec(
  ADVANCED_INSPECTOR_WIDTH_MIN,
  ADVANCED_INSPECTOR_WIDTH_MAX,
  ADVANCED_INSPECTOR_WIDTH_DEFAULT,
);

// Préférence locale propre à l'Éditeur graphe. Elle ne touche ni au document,
// ni au store projet, ni à l'historique d'auteur. Le graphe est volontairement
// absent des bascules : il se déplace, mais reste la surface principale.
export function useAdvancedWorkspaceViewState() {
  const [showNodeList, setShowNodeList] = usePersistentState(
    KEYS.ADVANCED_SHOW_NODE_LIST,
    true,
    BOOL_CODEC,
  );
  const [showInspector, setShowInspector] = usePersistentState(
    KEYS.ADVANCED_SHOW_INSPECTOR,
    true,
    BOOL_CODEC,
  );
  // La Vue d'ensemble, la miniature du graphe. Fermée, elle ne calcule rien.
  const [showOverview, setShowOverview] = usePersistentState(
    KEYS.ADVANCED_SHOW_OVERVIEW,
    true,
    BOOL_CODEC,
  );
  const [panelOrder, setPanelOrder] = usePersistentState(
    KEYS.ADVANCED_WORKSPACE_PANEL_ORDER,
    [...DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER],
    ADVANCED_WORKSPACE_PANEL_ORDER_CODEC,
  );
  const [nodeListPanelWidth, setStoredNodeListPanelWidth] = usePersistentState(
    KEYS.ADVANCED_NODE_LIST_PANEL_WIDTH,
    ADVANCED_NODE_LIST_WIDTH_DEFAULT,
    NODE_LIST_WIDTH_CODEC,
  );
  const [inspectorPanelWidth, setStoredInspectorPanelWidth] = usePersistentState(
    KEYS.ADVANCED_INSPECTOR_PANEL_WIDTH,
    ADVANCED_INSPECTOR_WIDTH_DEFAULT,
    INSPECTOR_WIDTH_CODEC,
  );

  const toggleNodeList = useCallback(() => {
    setShowNodeList((current) => !current);
  }, [setShowNodeList]);

  const toggleInspector = useCallback(() => {
    setShowInspector((current) => !current);
  }, [setShowInspector]);

  const toggleOverview = useCallback(() => {
    setShowOverview((current) => !current);
  }, [setShowOverview]);

  const movePanel = useCallback((activeId, overId) => {
    setPanelOrder((current) => reorderAdvancedWorkspacePanels(current, activeId, overId));
  }, [setPanelOrder]);

  const setNodeListPanelWidth = useCallback((width) => {
    setStoredNodeListPanelWidth(clampWidth(
      width,
      ADVANCED_NODE_LIST_WIDTH_MIN,
      ADVANCED_NODE_LIST_WIDTH_MAX,
      ADVANCED_NODE_LIST_WIDTH_DEFAULT,
    ));
  }, [setStoredNodeListPanelWidth]);

  const setInspectorPanelWidth = useCallback((width) => {
    setStoredInspectorPanelWidth(clampWidth(
      width,
      ADVANCED_INSPECTOR_WIDTH_MIN,
      ADVANCED_INSPECTOR_WIDTH_MAX,
      ADVANCED_INSPECTOR_WIDTH_DEFAULT,
    ));
  }, [setStoredInspectorPanelWidth]);

  // L'objet est **stable** tant qu'aucune préférence ne change. L'Éditeur
  // graphe le place dans les dépendances de ses rappels, dont l'un remonte le
  // contexte « À corriger » dans l'état de l'hôte : un objet neuf à chaque
  // rendu de l'hôte relançait ce rappel, qui redessinait l'hôte, et ainsi de
  // suite jusqu'à « Maximum update depth exceeded ».
  return useMemo(() => ({
    showGraph: true,
    showNodeList,
    showInspector,
    showOverview,
    panelOrder,
    toggleNodeList,
    toggleInspector,
    toggleOverview,
    movePanel,
    nodeListPanelWidth,
    setNodeListPanelWidth,
    inspectorPanelWidth,
    setInspectorPanelWidth,
  }), [
    showNodeList, showInspector, showOverview, panelOrder, toggleNodeList, toggleInspector,
    toggleOverview, movePanel,
    nodeListPanelWidth, setNodeListPanelWidth, inspectorPanelWidth, setInspectorPanelWidth,
  ]);
}
