import { useCallback, useMemo } from 'react';
import { usePersistentState } from '../hooks/usePersistentState';
import { KEYS } from '../store/persistentSettings';
import { LEFT_PANEL_MIN_WIDTH } from '../components/structure/panelResize';

export const DIAGRAM_VIEW_STATES = Object.freeze({
  CLOSED: 'ferme',
  COLUMN: 'colonne',
  FULL: 'plein',
});

export const DIAGRAM_LEFT_SLOTS = Object.freeze({
  TREE: 'arbre',
  SETTINGS: 'reglages',
  NONE: 'aucun',
});

export const DIAGRAM_COLUMN_WIDTH_MIN = 340;
export const DIAGRAM_COLUMN_WIDTH_MAX = 920;
const DIAGRAM_COLUMN_WIDTH_DEFAULT = 470;
export const SETTINGS_SLOT_WIDTH_MIN = 320;
export const SETTINGS_SLOT_WIDTH_MAX = 640;
const SETTINGS_SLOT_WIDTH_DEFAULT = 404;
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

function oneOf(values, fallback) {
  return {
    decode: (value) => (values.includes(value) ? value : fallback),
    encode: (value) => (values.includes(value) ? value : fallback),
  };
}

function widthCodec(min, max, fallback) {
  return {
    decode: (value) => clampNumber(value, min, max, fallback),
    encode: (value) => String(clampNumber(value, min, max, fallback)),
  };
}

const STATE_CODEC = oneOf(
  [DIAGRAM_VIEW_STATES.CLOSED, DIAGRAM_VIEW_STATES.COLUMN, DIAGRAM_VIEW_STATES.FULL],
  DIAGRAM_VIEW_STATES.CLOSED,
);
const LAST_OPEN_STATE_CODEC = oneOf(
  [DIAGRAM_VIEW_STATES.COLUMN, DIAGRAM_VIEW_STATES.FULL],
  DIAGRAM_VIEW_STATES.COLUMN,
);
const LEFT_SLOT_CODEC = oneOf(
  [DIAGRAM_LEFT_SLOTS.TREE, DIAGRAM_LEFT_SLOTS.SETTINGS, DIAGRAM_LEFT_SLOTS.NONE],
  DIAGRAM_LEFT_SLOTS.TREE,
);

export function useDiagramViewState() {
  const treeWidthCodec = useMemo(() => ({
    decode: (value) => clampNumber(value, LEFT_PANEL_MIN_WIDTH, getTreePanelMaxWidth(), TREE_PANEL_WIDTH_DEFAULT),
    encode: (value) => String(clampNumber(value, LEFT_PANEL_MIN_WIDTH, getTreePanelMaxWidth(), TREE_PANEL_WIDTH_DEFAULT)),
  }), []);

  const [state, setState] = usePersistentState(
    KEYS.DIAGRAM_VIEW_STATE,
    DIAGRAM_VIEW_STATES.CLOSED,
    STATE_CODEC,
  );
  const [lastOpenState, setLastOpenState] = usePersistentState(
    KEYS.DIAGRAM_LAST_OPEN_STATE,
    DIAGRAM_VIEW_STATES.COLUMN,
    LAST_OPEN_STATE_CODEC,
  );
  const [leftSlot, setStoredLeftSlot] = usePersistentState(
    KEYS.DIAGRAM_PLEIN_LEFT_SLOT,
    DIAGRAM_LEFT_SLOTS.TREE,
    LEFT_SLOT_CODEC,
  );
  const [diagramColumnWidth, setStoredDiagramColumnWidth] = usePersistentState(
    KEYS.DIAGRAM_COLUMN_WIDTH,
    DIAGRAM_COLUMN_WIDTH_DEFAULT,
    widthCodec(DIAGRAM_COLUMN_WIDTH_MIN, DIAGRAM_COLUMN_WIDTH_MAX, DIAGRAM_COLUMN_WIDTH_DEFAULT),
  );
  const [settingsSlotWidth, setStoredSettingsSlotWidth] = usePersistentState(
    KEYS.SETTINGS_SLOT_WIDTH,
    SETTINGS_SLOT_WIDTH_DEFAULT,
    widthCodec(SETTINGS_SLOT_WIDTH_MIN, SETTINGS_SLOT_WIDTH_MAX, SETTINGS_SLOT_WIDTH_DEFAULT),
  );
  const [treePanelWidth, setStoredTreePanelWidth] = usePersistentState(
    KEYS.TREE_PANEL_WIDTH,
    TREE_PANEL_WIDTH_DEFAULT,
    treeWidthCodec,
  );

  const setOpenState = useCallback((nextState) => {
    if (nextState !== DIAGRAM_VIEW_STATES.COLUMN && nextState !== DIAGRAM_VIEW_STATES.FULL) return;
    setState(nextState);
    setLastOpenState(nextState);
  }, [setLastOpenState, setState]);

  const toggleDiagram = useCallback(() => {
    setState((current) => {
      if (current === DIAGRAM_VIEW_STATES.CLOSED) {
        return lastOpenState === DIAGRAM_VIEW_STATES.FULL
          ? DIAGRAM_VIEW_STATES.FULL
          : DIAGRAM_VIEW_STATES.COLUMN;
      }
      return DIAGRAM_VIEW_STATES.CLOSED;
    });
  }, [lastOpenState, setState]);

  const closeDiagram = useCallback(() => {
    setState(DIAGRAM_VIEW_STATES.CLOSED);
  }, [setState]);

  const maximize = useCallback(() => {
    setOpenState(DIAGRAM_VIEW_STATES.FULL);
  }, [setOpenState]);

  const minimize = useCallback(() => {
    setOpenState(DIAGRAM_VIEW_STATES.COLUMN);
  }, [setOpenState]);

  const setLeftSlot = useCallback((slot) => {
    if (!Object.values(DIAGRAM_LEFT_SLOTS).includes(slot)) return;
    setStoredLeftSlot((current) => (current === slot ? DIAGRAM_LEFT_SLOTS.NONE : slot));
  }, [setStoredLeftSlot]);

  const forceLeftSlot = useCallback((slot) => {
    if (!Object.values(DIAGRAM_LEFT_SLOTS).includes(slot)) return;
    setStoredLeftSlot(slot);
  }, [setStoredLeftSlot]);

  const setDiagramColumnWidth = useCallback((width) => {
    setStoredDiagramColumnWidth(clampNumber(
      width,
      DIAGRAM_COLUMN_WIDTH_MIN,
      DIAGRAM_COLUMN_WIDTH_MAX,
      DIAGRAM_COLUMN_WIDTH_DEFAULT,
    ));
  }, [setStoredDiagramColumnWidth]);

  const setSettingsSlotWidth = useCallback((width) => {
    setStoredSettingsSlotWidth(clampNumber(
      width,
      SETTINGS_SLOT_WIDTH_MIN,
      SETTINGS_SLOT_WIDTH_MAX,
      SETTINGS_SLOT_WIDTH_DEFAULT,
    ));
  }, [setStoredSettingsSlotWidth]);

  const setTreePanelWidth = useCallback((width) => {
    setStoredTreePanelWidth(clampNumber(
      width,
      LEFT_PANEL_MIN_WIDTH,
      getTreePanelMaxWidth(),
      TREE_PANEL_WIDTH_DEFAULT,
    ));
  }, [setStoredTreePanelWidth]);

  return {
    state,
    lastOpenState,
    leftSlot,
    diagramOpen: state !== DIAGRAM_VIEW_STATES.CLOSED,
    treeVisible: state !== DIAGRAM_VIEW_STATES.FULL || leftSlot === DIAGRAM_LEFT_SLOTS.TREE,
    toggleDiagram,
    closeDiagram,
    maximize,
    minimize,
    setLeftSlot,
    forceLeftSlot,
    diagramColumnWidth,
    setDiagramColumnWidth,
    settingsSlotWidth,
    setSettingsSlotWidth,
    treePanelWidth,
    setTreePanelWidth,
  };
}
