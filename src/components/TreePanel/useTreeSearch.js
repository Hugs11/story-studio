import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildVisibleTreeSearchIds } from './treeSearch.js';
import {
  collectProjectUsedNodeColors,
  toggleNodeColorFilter,
} from '../tree/nodeColorFilter.js';

// Recherche dans l'arbre : filtre combiné nom/couleurs (+ ancêtres pour garder
// le chemin visible) et prise de focus déclenchée depuis l'extérieur.
export function useTreeSearch({ project, projectIndex, projectType, treeSearchFocusTrigger }) {
  const [searchActive, setSearchActive] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedColors, setSelectedColors] = useState(new Set());
  const searchInputRef = useRef(null);
  const pendingFocusRef = useRef(false);

  const usedColors = useMemo(
    () => collectProjectUsedNodeColors(project, projectIndex),
    [project, projectIndex],
  );

  const visibleIds = useMemo(() => buildVisibleTreeSearchIds({
    projectIndex,
    projectType,
    searchTerm,
    selectedColors,
  }), [searchTerm, selectedColors, projectIndex, projectType]);

  useEffect(() => {
    const available = new Set(usedColors.map(({ color }) => color));
    setSelectedColors((current) => {
      const next = new Set([...current].filter((color) => available.has(color)));
      return next.size === current.size ? current : next;
    });
  }, [usedColors]);

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

  const toggleColor = useCallback((color) => {
    setSelectedColors((current) => toggleNodeColorFilter(current, color));
  }, []);

  const clearSearch = useCallback(() => {
    setSearchTerm('');
    setSelectedColors(new Set());
    setSearchActive(false);
  }, []);

  return {
    searchActive,
    setSearchActive,
    searchTerm,
    setSearchTerm,
    searchInputRef,
    visibleIds,
    usedColors,
    selectedColors,
    toggleColor,
    clearSearch,
  };
}
