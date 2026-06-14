import { tagStyle } from './helpers';
import { Button } from '../common/Button';

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
          <Button className="media-selection-btn" onClick={onCopyAudio}>
            Copier {selectedAudioItems.length} son{selectedAudioItems.length > 1 ? 's' : ''}
          </Button>
          <Button className="media-selection-btn" onClick={onCutAudio}>
            Couper {selectedAudioItems.length} son{selectedAudioItems.length > 1 ? 's' : ''}
          </Button>
          {selectedAudioItems.length >= 2 && (
            <Button variant="primary" className="media-selection-btn" onClick={onOpenAssembly}>
              Assembler les audios
            </Button>
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
            <Button type="submit" className="media-selection-btn" disabled={!bulkTag.trim()}>
              Appliquer
            </Button>
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
      <Button className="media-selection-btn" onClick={onClear}>Effacer</Button>
    </div>
  );
}
