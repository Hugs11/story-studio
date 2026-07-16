import { useEffect, useMemo, useRef, useState } from 'react';
import { buildVisibleTreeSearchIds } from './treeSearch.js';

// Recherche dans l'arbre : filtre par nom (+ ancêtres pour garder le chemin
// visible) et prise de focus du champ déclenchée depuis l'extérieur.
export function useTreeSearch({ projectIndex, projectType, treeSearchFocusTrigger }) {
  const [searchActive, setSearchActive] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const searchInputRef = useRef(null);
  const pendingFocusRef = useRef(false);

  const visibleIds = useMemo(() => buildVisibleTreeSearchIds({
    projectIndex,
    projectType,
    searchTerm,
  }), [searchTerm, projectIndex, projectType]);

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
