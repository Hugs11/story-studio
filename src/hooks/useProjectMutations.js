import { useCallback } from 'react';

// Grappe « mutations projet » extraite d'AppContent : wrappers fins qui
// adaptent les mutations du store à la signature attendue par les
// surfaces d'édition (arbre, réglages, diagramme), consommés via ProjectActionsContext.
// Déplacement pur — mêmes noms, mêmes gardes (`if (menuId)`, `typeof id === 'string'`),
// mêmes valeurs par défaut qui lisent store.selectedId AU MOMENT DE L'APPEL
// (handleUpdateMenu/handleDeleteMenu/handleUpdateItem/handleDeleteItem). Les
// `useCallback` préexistants sont conservés tels quels (pas de mémoïsation nouvelle).
//
// Périmètre volontairement étroit : aucun gestionnaire d'import (useMediaImport), de
// préférences / message de fin (useAppPreferences) ni de toolbar (resté chez l'hôte).
export function useProjectMutations({ store }) {
  const handleUpdateRoot = useCallback(({ projectName, name, rootName, endNodeName, packMetadata }) => {
    const nextProjectName = projectName ?? name;
    if (nextProjectName !== undefined || rootName !== undefined || endNodeName !== undefined || packMetadata !== undefined) {
      const nameFields = [nextProjectName, rootName, endNodeName].filter(value => value !== undefined);
      const metadataIsName = packMetadata === undefined || (
        nextProjectName !== undefined && Object.keys(packMetadata).length === 1 && packMetadata.title === nextProjectName
      );
      const historyGroup = nameFields.length === 1 && metadataIsName
        ? `name:root:${rootName !== undefined ? 'rootName' : endNodeName !== undefined ? 'endNodeName' : 'projectName'}`
        : null;
      store.setProject(p => ({
        ...p,
        ...(nextProjectName !== undefined ? { projectName: nextProjectName } : {}),
        ...(rootName !== undefined ? { rootName } : {}),
        ...(endNodeName !== undefined ? { endNodeName } : {}),
        ...(packMetadata !== undefined
          ? { packMetadata: { ...(p.packMetadata ?? {}), ...packMetadata } }
          : {}),
      }), { historyGroup });
    }
  }, [store.setProject]);

  const handleAddMenu = useCallback((parentMenuId = null) => {
    return store.addMenu(parentMenuId);
  }, [store.addMenu]);

  const handleReorder = useCallback((menuId, newItems) => {
    if (menuId == null) store.reorderRootItems(newItems);
    else store.reorderMenuItems(menuId, newItems);
  }, [store.reorderRootItems, store.reorderMenuItems]);

  const handleUpdateMenu = useCallback((fields, menuId = store.selectedId, options) => {
    if (menuId) store.updateMenu(menuId, fields, options);
  }, [store.updateMenu, store.selectedId]);

  const handleDeleteMenu = useCallback((menuId = store.selectedId) => {
    const resolvedId = typeof menuId === 'string' ? menuId : store.selectedId;
    if (resolvedId) store.deleteMenu(resolvedId);
  }, [store.deleteMenu, store.selectedId]);

  const handleSetMenuAsRoot = useCallback((menuId) => {
    store.promoteMenuToRoot(menuId);
  }, [store.promoteMenuToRoot]);

  const handleDemoteRootToMenu = useCallback(() => {
    store.demoteRootToMenu();
  }, [store.demoteRootToMenu]);

  const handleUpdateItem = useCallback((fields, itemId = store.selectedId, options) => {
    if (itemId) store.updateItem(itemId, fields, options);
  }, [store.updateItem, store.selectedId]);

  const handleBulkUpdateItems = useCallback((ids, getFields) => {
    store.bulkUpdateItems(ids, getFields);
  }, [store.bulkUpdateItems]);

  const handleBulkDeleteItems = useCallback((ids) => {
    store.bulkDeleteItems(ids);
  }, [store.bulkDeleteItems]);

  const handleDeleteItem = useCallback((itemId = store.selectedId) => {
    const resolvedId = typeof itemId === 'string' ? itemId : store.selectedId;
    if (resolvedId) store.deleteItem(resolvedId);
  }, [store.deleteItem, store.selectedId]);

  const handleReplaceStoriesWithAssembledStory = useCallback((options) => (
    store.replaceStoriesWithAssembly(options)
  ), [store.replaceStoriesWithAssembly]);

  return {
    handleUpdateRoot,
    handleAddMenu,
    handleReorder,
    handleUpdateMenu,
    handleDeleteMenu,
    handleSetMenuAsRoot,
    handleDemoteRootToMenu,
    handleUpdateItem,
    handleBulkUpdateItems,
    handleBulkDeleteItems,
    handleDeleteItem,
    handleReplaceStoriesWithAssembledStory,
  };
}
