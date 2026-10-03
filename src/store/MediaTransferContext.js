import { createContext, createElement, useContext, useMemo, useState } from 'react';

const noopDropOnNode = async () => {};
const noopNotifyCutPaste = () => {};
const noopSetActiveDropZone = () => {};
const noopSetGraphMediaTarget = () => {};
const identityPrepare = async (path) => path;

const MediaTransferContext = createContext({
  dropOnNode: noopDropOnNode,
  prepareMediaForProject: identityPrepare,
  notifyCutPaste: noopNotifyCutPaste,
  activeDropZone: null,
  setActiveDropZone: noopSetActiveDropZone,
  graphMediaTarget: null,
  setGraphMediaTarget: noopSetGraphMediaTarget,
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
  // Moitié disque d'un dépôt : la copie dans l'espace de travail quand la
  // préférence la demande. `dropOnNode` l'applique pour l'arbre ; l'éditeur
  // graphe l'applique lui aussi, avant d'assembler son geste d'auteur, pour que
  // le même dépôt range le fichier au même endroit des deux côtés.
  prepareMediaForProject = identityPrepare,
  notifyCutPaste = noopNotifyCutPaste,
  activeDropZone = null,
  setActiveDropZone = noopSetActiveDropZone,
}) {
  const [graphMediaTarget, setGraphMediaTarget] = useState(null);
  const value = useMemo(() => ({
    dropOnNode,
    prepareMediaForProject,
    notifyCutPaste,
    activeDropZone,
    setActiveDropZone,
    graphMediaTarget,
    setGraphMediaTarget,
  }), [activeDropZone, dropOnNode, graphMediaTarget, notifyCutPaste, prepareMediaForProject, setActiveDropZone]);

  return createElement(MediaTransferContext.Provider, { value }, children);
}

export function useMediaTransfer() {
  return useContext(MediaTransferContext);
}
