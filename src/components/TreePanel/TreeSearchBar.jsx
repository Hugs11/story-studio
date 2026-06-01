// Barre de recherche du TreePanel : input + bouton clear.
// Extraite de TreePanel.jsx pour reduire la surface du composant orchestrateur.

export function TreeSearchBar({ searchTerm, setSearchTerm, setSearchActive, inputRef }) {
  return (
    <div className="tree-search-bar">
      <span className="tree-search-icon">⌕</span>
      <input
        ref={inputRef}
        className="tree-search-input"
        type="text"
        placeholder="Rechercher…"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        onBlur={() => { if (!searchTerm) setSearchActive(false); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setSearchTerm('');
            setSearchActive(false);
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
  );
}
