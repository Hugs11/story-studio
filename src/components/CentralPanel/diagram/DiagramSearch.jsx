import { useEffect, useMemo, useRef, useState } from 'react';
import { hasVisibleEndNode } from '../../../store/generatedNavigation';
import { Search } from '../../icons/LucideLocal';
import { END_NODE_ID } from '../flowDiagramLayout';
import { filterDiagramSearchCandidates } from './diagramSearchFilter.js';

const TYPE_LABELS = {
  menu: 'Dossier',
  story: 'Histoire',
  zip: 'Pack importé',
  ref: 'Lien',
};

export function DiagramSearch({ project, projectIndex, focusTrigger, onChoose }) {
  const [active, setActive] = useState(false);
  const [term, setTerm] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const pendingFocusRef = useRef(false);
  const previousFocusTriggerRef = useRef(focusTrigger);

  const candidates = useMemo(() => [
    {
      id: 'root',
      label: project.rootName || project.projectName || 'Menu racine',
      typeLabel: 'Racine',
    },
    ...(projectIndex.flatEntries ?? []).map(({ entry }) => ({
      id: entry.id,
      label: entry.name || TYPE_LABELS[entry.type] || entry.id,
      typeLabel: TYPE_LABELS[entry.type] || entry.type,
    })),
    ...(hasVisibleEndNode(project) ? [{
      id: END_NODE_ID,
      label: project.endNodeName || 'Message de fin',
      typeLabel: 'Fin',
    }] : []),
  ], [project, projectIndex.flatEntries]);

  const results = useMemo(
    () => filterDiagramSearchCandidates(candidates, term),
    [candidates, term],
  );

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

  return (
    <div
      className="fd-diagram-search"
      role="search"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
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
              setActive(false);
              setTerm('');
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
            setActive(false);
            setTerm('');
          }}
        >
          ×
        </button>
      </div>

      {term.trim() ? (
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
              <span>{candidate.label}</span>
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
