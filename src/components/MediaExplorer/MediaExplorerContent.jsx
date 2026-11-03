import { Package } from '../icons/LucideLocal';
import { Button } from '../common/Button';
import { COLUMNS } from './useColumnWidths';
import { MediaTile } from './MediaTile';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';

export function MediaExplorerContent({
  isEmpty,
  sortedVisible,
  visible,
  view,
  gridCols,
  visibleCols,
  sortCol,
  sortDir,
  onSortClick,
  onStartResize,
  headerRef,
  listScrollRef,
  onBackgroundClick,
  onBackgroundContextMenu,
  getMeta,
  markForProbe,
  activePopover,
  onActivate,
  onNavigate,
  mediaTags,
  tagsOf,
  allTags,
  onAddMediaTag,
  onRemoveMediaTag,
  onDeleteMedia,
  onDeleteRequest,
  selectedAudioItems,
  onOpenAssembly,
  onOpenSplitter,
  onEditImage,
  selectedIds,
  selectedItems,
  onSelectItem,
  onContextMenuSelect,
  onSelectNode,
  onRevealGraphNode,
  dropOnNode,
  onImportMedia,
  onImportStories,
  onImportMediaFolder,
}) {
  const { t } = useMediaTranslation();
  const commonTileProps = {
    view,
    getMeta,
    markForProbe,
    onActivate,
    onNavigate,
    allProjectTags: allTags,
    onAddMediaTag,
    onRemoveMediaTag,
    onDeleteRequest: onDeleteMedia ? onDeleteRequest : null,
    onAssemble: selectedAudioItems.length >= 2 ? onOpenAssembly : null,
    onSplit: onOpenSplitter,
    onEditImage,
    mediaTags,
    selectedItems,
    selectedAudioItems,
    onSelect: onSelectItem,
    onContextMenuSelect,
    onSelectNode,
    onRevealGraphNode,
    dropOnNode,
  };

  if (isEmpty) {
    return (
      <div className="media-empty">
        <Package className="media-empty-icon" strokeWidth={1.8} absoluteStrokeWidth />
        <span>{t('media:explorer.empty.title')}</span>
        <p className="media-empty-hint">{t('media:explorer.empty.hint')}</p>
        <div className="media-empty-actions">
          <Button className="media-empty-btn" onClick={onImportMedia || onImportStories}>
            {t('media:explorer.media.importAction')}
          </Button>
          {onImportMediaFolder && (
            <Button className="media-empty-btn" onClick={onImportMediaFolder}>
              {t('media:explorer.folder.importAction')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (sortedVisible.length === 0) {
    return (
      <div className="media-empty">
        <Package className="media-empty-icon" strokeWidth={1.8} absoluteStrokeWidth />
        <span>{t('media:explorer.filter.empty')}</span>
      </div>
    );
  }

  if (view === 'list') {
    return (
      <div className="media-list is-list" style={{ '--me-grid': gridCols }}>
        <div className="media-list-header" ref={headerRef}>
          <div />
          {COLUMNS.filter((c) => visibleCols.has(c.id)).map((col) => (
            <div key={col.id} className={`me-col-head${sortCol === col.id ? ' is-sorted' : ''}`}>
              <button type="button" className="me-col-sort-btn" onClick={() => onSortClick(col.id)}>
                {t(col.labelKey)}
                {sortCol === col.id && <span className="me-col-sort-icon">{sortDir === 'asc' ? '↑' : '↓'}</span>}
              </button>
              <span className="me-col-resize" onPointerDown={(e) => onStartResize(e, col.id)} />
            </div>
          ))}
          <div />
        </div>
        <div className="media-list-scroll" ref={listScrollRef} onClick={onBackgroundClick} onContextMenu={onBackgroundContextMenu}>
          {sortedVisible.map((item, idx) => (
            <MediaTile
              key={item.id}
              item={item}
              index={idx}
              isPopoverOpen={activePopover?.idx === idx}
              itemTags={tagsOf(item.path)}
              isSelected={selectedIds.has(item.id)}
              visibleCols={visibleCols}
              {...commonTileProps}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="media-list is-grid" onClick={onBackgroundClick} onContextMenu={onBackgroundContextMenu}>
      {visible.map((item, idx) => (
        <MediaTile
          key={item.id}
          item={item}
          index={idx}
          isPopoverOpen={activePopover?.idx === idx}
          itemTags={tagsOf(item.path)}
          isSelected={selectedIds.has(item.id)}
          {...commonTileProps}
        />
      ))}
    </div>
  );
}
