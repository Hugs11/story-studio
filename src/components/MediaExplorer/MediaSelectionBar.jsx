import { tagStyle } from './helpers';

export function MediaSelectionBar({
  selectedCount,
  selectedAudioItems,
  onCopyAudio,
  onCutAudio,
  onOpenAssembly,
  onAddMediaTag,
  bulkTag,
  onBulkTagChange,
  bulkTagOpen,
  onBulkTagOpenChange,
  allTags,
  visibleSelectedItems,
  onClear,
}) {
  if (selectedCount <= 1) return null;

  function applyBulkTag(e) {
    e.preventDefault();
    const tag = bulkTag.trim();
    if (!tag || selectedCount === 0 || !onAddMediaTag) return;
    for (const item of visibleSelectedItems) {
      onAddMediaTag(item.path, tag);
    }
    onBulkTagChange('');
  }

  return (
    <div className="media-selection-bar">
      <span className="media-selection-count">{selectedCount} sélectionné{selectedCount > 1 ? 's' : ''}</span>
      {selectedAudioItems.length > 0 ? (
        <>
          <button className="btn media-selection-btn" type="button" onClick={onCopyAudio}>
            Copier {selectedAudioItems.length} son{selectedAudioItems.length > 1 ? 's' : ''}
          </button>
          <button className="btn media-selection-btn" type="button" onClick={onCutAudio}>
            Couper {selectedAudioItems.length} son{selectedAudioItems.length > 1 ? 's' : ''}
          </button>
          {selectedAudioItems.length >= 2 && (
            <button className="btn btn-primary media-selection-btn" type="button" onClick={onOpenAssembly}>
              Assembler les audios
            </button>
          )}
        </>
      ) : null}
      {onAddMediaTag ? (
        <div className="media-selection-tag-wrap">
          <form className="media-selection-tag-form" onSubmit={applyBulkTag}>
            <input
              className="media-selection-tag-input"
              value={bulkTag}
              onChange={(e) => onBulkTagChange(e.target.value)}
              onFocus={() => onBulkTagOpenChange(true)}
              onBlur={() => setTimeout(() => onBulkTagOpenChange(false), 150)}
              placeholder="+ Tag commun"
            />
            <button className="btn media-selection-btn" type="submit" disabled={!bulkTag.trim()}>
              Appliquer
            </button>
          </form>
          {bulkTagOpen && allTags.length > 0 && (
            <div className="media-tag-suggestions">
              {allTags
                .filter((t) => !bulkTag || t.toLowerCase().includes(bulkTag.toLowerCase()))
                .map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="media-tag-suggestion-item"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      for (const item of visibleSelectedItems) onAddMediaTag(item.path, tag);
                      onBulkTagChange('');
                      onBulkTagOpenChange(false);
                    }}
                  >
                    <span className="me-tag-chip" style={tagStyle(tag)}>{tag}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      ) : null}
      <button className="btn media-selection-btn" type="button" onClick={onClear}>Effacer</button>
    </div>
  );
}
