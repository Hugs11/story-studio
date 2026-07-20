import { useEffect, useMemo, useRef, useState } from 'react';
import { hasVisibleEndNode } from '../../../store/generatedNavigation';
import { Search } from '../../icons/LucideLocal';
import { NodeColorFilterChips } from '../../tree/NodeColorFilterChips.jsx';
import { buildUsedNodeColors, toggleNodeColorFilter } from '../../tree/nodeColorFilter.js';
import { END_NODE_ID } from '../flowDiagramLayout';
import { filterDiagramSearchCandidates } from './diagramSearchFilter.js';

const TYPE_LABELS = {
  menu: 'Dossier',
  story: 'Histoire',
  zip: 'Pack importé',
  ref: 'Lien',
};

export function DiagramSearch({ project, projectIndex, focusTrigger, onChoose, onFilterChange }) {
  const [active, setActive] = useState(false);
  const [term, setTerm] = useState('');
  const [selectedColors, setSelectedColors] = useState(new Set());
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const pendingFocusRef = useRef(false);
  const previousFocusTriggerRef = useRef(focusTrigger);

  const candidates = useMemo(() => [
    {
      id: 'root',
      label: project.rootName || project.projectName || 'Menu racine',
      typeLabel: 'Racine',
      treeColor: project.treeColor ?? null,
    },
    ...(projectIndex.flatEntries ?? []).map(({ entry }) => ({
      id: entry.id,
      label: entry.name || TYPE_LABELS[entry.type] || entry.id,
      typeLabel: TYPE_LABELS[entry.type] || entry.type,
      treeColor: entry.treeColor ?? null,
    })),
    ...(hasVisibleEndNode(project) ? [{
      id: END_NODE_ID,
      label: project.endNodeName || 'Message de fin',
      typeLabel: 'Fin',
    }] : []),
  ], [project, projectIndex.flatEntries]);

  const usedColors = useMemo(
    () => buildUsedNodeColors(candidates.map(({ treeColor }) => treeColor)),
    [candidates],
  );

  const allResults = useMemo(
    () => filterDiagramSearchCandidates(
      candidates,
      term,
      Number.POSITIVE_INFINITY,
      selectedColors,
    ),
    [candidates, selectedColors, term],
  );
  const results = selectedColors.size > 0 ? allResults : allResults.slice(0, 12);
  const filterActive = !!term.trim() || selectedColors.size > 0;

  useEffect(() => {
    const available = new Set(usedColors.map(({ color }) => color));
    setSelectedColors((current) => {
      const next = new Set([...current].filter((color) => available.has(color)));
      return next.size === current.size ? current : next;
    });
  }, [usedColors]);

  useEffect(() => {
    onFilterChange?.({
      active: active && filterActive,
      matchingIds: new Set(allResults.map(({ id }) => id)),
    });
  }, [active, allResults, filterActive, onFilterChange]);

  useEffect(() => {
    if (previousFocusTriggerRef.current === focusTrigger) return;
    previousFocusTriggerRef.current = focusTrigger;
    pendingFocusRef.current = true;
    setActive(true);
  }, [focusTrigger]);

  useEffect(() => {
    if (active && pendingFocusRef.current && inputRef.current) {
      pendingFocusRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [active]);

  useEffect(() => {
    if (activeIndex < results.length) return;
    setActiveIndex(Math.max(0, results.length - 1));
  }, [activeIndex, results.length]);

  if (!active) return null;

  const choose = (candidate) => {
    if (!candidate) return;
    onChoose?.(candidate.id);
  };

  const closeSearch = () => {
    setActive(false);
    setTerm('');
    setSelectedColors(new Set());
  };

  return (
    <div
      className="fd-diagram-search"
      role="search"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        closeSearch();
        inputRef.current?.blur();
      }}
    >
      <div className="fd-diagram-search-field">
        <Search aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={term}
          placeholder="Rechercher un nœud…"
          aria-label="Rechercher dans le diagramme"
          onChange={(event) => {
            setTerm(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              closeSearch();
              event.currentTarget.blur();
            } else if (event.key === 'ArrowDown' && results.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % results.length);
            } else if (event.key === 'ArrowUp' && results.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + results.length) % results.length);
            } else if (event.key === 'Enter' && results.length > 0) {
              event.preventDefault();
              choose(results[activeIndex]);
            }
            event.stopPropagation();
          }}
        />
        <button
          type="button"
          className="fd-diagram-search-close"
          aria-label="Fermer la recherche"
          onClick={() => {
            closeSearch();
          }}
        >
          ×
        </button>
      </div>

      <NodeColorFilterChips
        colors={usedColors}
        selectedColors={selectedColors}
        onToggle={(color) => {
          setSelectedColors((current) => toggleNodeColorFilter(current, color));
          setActiveIndex(0);
        }}
      />

      {filterActive ? (
        <div className="fd-diagram-search-results" role="listbox" aria-label="Résultats de recherche">
          {results.length > 0 ? results.map((candidate, index) => (
            <button
              key={candidate.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`fd-diagram-search-result ${index === activeIndex ? 'is-active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setActiveIndex(index);
                choose(candidate);
              }}
            >
              <span className="fd-diagram-search-result-main">
                {candidate.treeColor ? (
                  <i
                    className="fd-diagram-search-result-color"
                    style={{ '--fd-search-result-color': candidate.treeColor }}
                    aria-hidden="true"
                  />
                ) : null}
                <span>{candidate.label}</span>
              </span>
              <small>{candidate.typeLabel}</small>
            </button>
          )) : (
            <div className="fd-diagram-search-empty">Aucun résultat</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
