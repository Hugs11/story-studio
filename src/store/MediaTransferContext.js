import { createContext, createElement, useContext, useMemo } from 'react';

const noopDropOnNode = async () => {};
const noopNotifyCutPaste = () => {};
const noopSetActiveDropZone = () => {};

const MediaTransferContext = createContext({
  dropOnNode: noopDropOnNode,
  notifyCutPaste: noopNotifyCutPaste,
  activeDropZone: null,
  setActiveDropZone: noopSetActiveDropZone,
});

/**
 * @typedef {Object} MediaDropNodePayload
 * @property {string} nodeId
 * @property {'root'|'menu'|'story'} nodeType
 * @property {string=} path
 * @property {string[]=} paths
 * @property {'audio'|'image'} kind
 * @property {'copy'|'cut'=} clipboardMode
 */

export function MediaTransferProvider({
  children,
  dropOnNode = noopDropOnNode,
  notifyCutPaste = noopNotifyCutPaste,
  activeDropZone = null,
  setActiveDropZone = noopSetActiveDropZone,
}) {
  const value = useMemo(() => ({
    dropOnNode,
    notifyCutPaste,
    activeDropZone,
    setActiveDropZone,
  }), [activeDropZone, dropOnNode, notifyCutPaste, setActiveDropZone]);

  return createElement(MediaTransferContext.Provider, { value }, children);
}

export function useMediaTransfer() {
  return useContext(MediaTransferContext);
}
