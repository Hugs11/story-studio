import { tagStyle } from './helpers';
import { Button } from '../common/Button';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';

export function MediaSelectionBar({
  selectedCount,
  graphMediaTarget,
  onAssignToGraph,
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
  const { t } = useMediaTranslation();
  const multiple = selectedCount > 1;
  if (!multiple && !(selectedCount === 1 && graphMediaTarget)) return null;

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
      <span className="media-selection-count">{t('media:selection.count', { count: selectedCount })}</span>
      {graphMediaTarget && (
        <Button variant="primary" className="media-selection-btn" onClick={onAssignToGraph}>
          {t('media:selection.graph.assign', { target: graphMediaTarget.label })}
        </Button>
      )}
      {multiple && selectedAudioItems.length > 0 ? (
        <>
          <Button className="media-selection-btn" onClick={onCopyAudio}>
            {t('media:selection.audio.copy', { count: selectedAudioItems.length })}
          </Button>
          <Button className="media-selection-btn" onClick={onCutAudio}>
            {t('media:selection.audio.cut', { count: selectedAudioItems.length })}
          </Button>
          {selectedAudioItems.length >= 2 && (
            <Button variant="primary" className="media-selection-btn" onClick={onOpenAssembly}>
              {t('media:selection.audio.assemble')}
            </Button>
          )}
        </>
      ) : null}
      {multiple && onAddMediaTag ? (
        <div className="media-selection-tag-wrap">
          <form className="media-selection-tag-form" onSubmit={applyBulkTag}>
            <input
              className="media-selection-tag-input"
              value={bulkTag}
              onChange={(e) => onBulkTagChange(e.target.value)}
              onFocus={() => onBulkTagOpenChange(true)}
              onBlur={() => setTimeout(() => onBulkTagOpenChange(false), 150)}
              placeholder={t('media:explorer.tags.common')}
            />
            <Button type="submit" className="media-selection-btn" disabled={!bulkTag.trim()}>
              {t('media:selection.tag.apply')}
            </Button>
          </form>
          {bulkTagOpen && allTags.length > 0 && (
            <div className="media-tag-suggestions">
              {allTags
                .filter((tag) => !bulkTag || tag.toLowerCase().includes(bulkTag.toLowerCase()))
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
      {multiple && <Button className="media-selection-btn" onClick={onClear}>{t('media:selection.clear.action')}</Button>}
    </div>
  );
}
