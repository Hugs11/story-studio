// Barre de recherche du TreePanel : input + bouton clear.
// Extraite de TreePanel.jsx pour reduire la surface du composant orchestrateur.

import { Search } from '../icons/LucideLocal';
import { NodeColorFilterChips } from '../tree/NodeColorFilterChips.jsx';

export function TreeSearchBar({
  searchTerm,
  setSearchTerm,
  setSearchActive,
  inputRef,
  usedColors,
  selectedColors,
  onToggleColor,
  onClearSearch,
}) {
  return (
    <div
      className="tree-search-controls"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)
          && !searchTerm
          && selectedColors.size === 0) {
          setSearchActive(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClearSearch();
        inputRef.current?.blur();
      }}
    >
      <div className="tree-search-bar">
        <span className="tree-search-icon" aria-hidden="true">
          <Search size={13} strokeWidth={2} />
        </span>
        <input
          ref={inputRef}
          className="tree-search-input"
          type="text"
          placeholder="Rechercher…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onClearSearch();
              inputRef.current?.blur();
            }
            e.stopPropagation();
          }}
        />
        {searchTerm ? (
          <button
            type="button"
            className="tree-search-clear"
            onClick={() => { setSearchTerm(''); inputRef.current?.focus(); }}
          >
            ×
          </button>
        ) : null}
      </div>
      <NodeColorFilterChips
        colors={usedColors}
        selectedColors={selectedColors}
        onToggle={onToggleColor}
      />
    </div>
  );
}
