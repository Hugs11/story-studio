import { useEffect, useMemo, useRef, useState } from 'react';

// Recherche dans l'arbre : filtre par nom (+ ancêtres pour garder le chemin
// visible) et prise de focus du champ déclenchée depuis l'extérieur.
export function useTreeSearch({ projectIndex, projectType, treeSearchFocusTrigger }) {
  const [searchActive, setSearchActive] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const searchInputRef = useRef(null);
  const pendingFocusRef = useRef(false);

  const visibleIds = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term || projectType !== 'pack') return null;
    const matching = new Set();
    for (const flatEntry of projectIndex.flatEntries) {
      if (flatEntry.entry.name?.toLowerCase().includes(term)) {
        matching.add(flatEntry.entry.id);
      }
    }
    const visible = new Set(matching);
    for (const id of matching) {
      let parentId = projectIndex.parentMenuById.get(id);
      while (parentId != null) {
        visible.add(parentId);
        parentId = projectIndex.parentMenuById.get(parentId);
      }
    }
    return visible;
  }, [searchTerm, projectIndex, projectType]);

  useEffect(() => {
    if (treeSearchFocusTrigger > 0) {
      pendingFocusRef.current = true;
      setSearchActive(true);
    }
  }, [treeSearchFocusTrigger]);

  useEffect(() => {
    if (searchActive && pendingFocusRef.current && searchInputRef.current) {
      pendingFocusRef.current = false;
      searchInputRef.current.focus();
      searchInputRef.current.select();
    }
  }, [searchActive]);

  return { searchActive, setSearchActive, searchTerm, setSearchTerm, searchInputRef, visibleIds };
}
