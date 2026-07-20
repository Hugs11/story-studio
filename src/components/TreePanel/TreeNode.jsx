import { memo, useEffect, useRef } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Tooltip } from '../common/Tooltip';
import {
  IconFolderClosed, IconFolderOpen, IconStory, IconArchive, IconHouse, IconMoon,
  IconReturn, IconStop, IconDiamond, IconArrowRight,
  ICON_BY_KEY,
} from './TreeIcons';
import { getTreeGuideStyleVars, getTreeIndent, resolveHoverGuide } from './treeGuides';
import './TreePanel.css';
import './TreeGuides.css';

const BADGE_ICON_BY_KIND = {
  return: <IconReturn />,
  'prompt-return': <IconReturn />,
  home: <IconHouse />,
  'home-implicit': <IconHouse />,
  'home-none': <IconHouse />,
  'end-node': <IconStop />,
  'end-night': <IconMoon />,
  'end-node-home': <IconHouse />,
  'end-night-home': <IconHouse />,
  graph: <IconDiamond />,
  continuation: <IconArrowRight />,
};

const MAX_NAVIGATION_BADGE_SLOTS = 2;

function TreeInlineNameInput({ value, onChange, onCommit, onCancel }) {
  const inputRef = useRef(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className="tree-inline-name-input"
      value={value}
      aria-label="Renommer"
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => {
        if (!cancelledRef.current) onCommit();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelledRef.current = true;
          onCancel();
        }
      }}
    />
  );
}

function TreeNodeInner({
  id,
  type,
  icon,
  label,
  level,
  selected,
  hovered,
  cut,
  isAncestor,
  isActiveScope,
  isHoverScope,
  sortable,
  dragging,
  containerDroppableId,
  navigationBadges = [],
  showNavigationBadgeColumn = false,
  expanded,
  onToggleExpand,
  childCount,
  color,
  renaming,
  renameValue,
  onStartRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onSelect,
  onContextMenu,
  onNodeHoverChange,
  hoverGuideScopeIds,
  hoverGuideLevel,
  hoverScopeEnabled,
  onHoverScope,
  isHoverGuide,
  dropTarget,
  suppressSortAnimation,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: !sortable || renaming });
  const { setNodeRef: setDropRef } = useDroppable({
    id: containerDroppableId ?? `disabled-container:${id}`,
    disabled: !containerDroppableId,
    data: {
      kind: 'container',
      containerId: type === 'root' ? null : id,
    },
  });

  const style = {
    ...(sortable
      ? {
          transform: suppressSortAnimation ? undefined : CSS.Transform.toString(transform),
          transition: suppressSortAnimation ? undefined : transition,
          opacity: cut ? 0.4 : isDragging ? 0.5 : 1,
        }
      : { opacity: cut ? 0.4 : 1 }),
    paddingLeft: `${getTreeIndent(level)}px`,
    ...getTreeGuideStyleVars({ level, hoverGuideLevel }),
    ...(color ? { '--tree-node-color': color } : {}),
  };

  const isDragActive = dragging && !isDragging;
  const showInsertBefore = isDragActive && dropTarget === 'before';
  const showInsertAfter = isDragActive && dropTarget === 'after';
  const showDropInside = isDragActive && dropTarget === 'inside';

  const insertClass = showInsertBefore ? 'insert-before' : showInsertAfter ? 'insert-after' : '';
  const hasToggle = type === 'menu';
  const visibleBadgeCount = navigationBadges.length > MAX_NAVIGATION_BADGE_SLOTS
    ? MAX_NAVIGATION_BADGE_SLOTS - 1
    : MAX_NAVIGATION_BADGE_SLOTS;
  const visibleNavigationBadges = navigationBadges.slice(0, visibleBadgeCount);
  const hiddenNavigationBadges = navigationBadges.slice(visibleBadgeCount);
  const hasHiddenNavigationBadges = hiddenNavigationBadges.length > 0;
  const hiddenNavigationBadgeTitle = hasHiddenNavigationBadges
    ? hiddenNavigationBadges.map((badge) => badge.title).join(' · ')
    : '';

  let resolvedIcon;
  if (icon) {
    const IconComp = ICON_BY_KEY[icon];
    resolvedIcon = IconComp ? <IconComp /> : icon;
  } else if (type === 'menu') {
    resolvedIcon = expanded ? <IconFolderOpen /> : <IconFolderClosed />;
  } else if (type === 'root') {
    resolvedIcon = <IconHouse />;
  } else if (type === 'story') {
    resolvedIcon = <IconStory />;
  } else if (type === 'ref') {
    resolvedIcon = <IconArrowRight />;
  } else if (type === 'zip') {
    resolvedIcon = <IconArchive />;
  } else {
    resolvedIcon = <IconMoon />;
  }

  const handlePointerHover = onHoverScope && !dragging
    ? (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const guide = resolveHoverGuide({
          clientX: e.clientX,
          itemLeft: rect.left,
          level,
          guideScopeIds: hoverGuideScopeIds,
        });
        onHoverScope(guide.scopeId, guide.level, hoverScopeEnabled);
      }
    : undefined;

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        if (containerDroppableId) setDropRef(node);
      }}
      style={style}
      {...(sortable ? { ...attributes, ...listeners } : {})}
      className={[
        'tree-item',
        `tree-item--${type}`,
        selected ? 'active' : '',
        hovered ? 'is-linked-hover' : '',
        color ? 'is-colored' : '',
        isAncestor && !selected ? 'ancestor-sel' : '',
        isActiveScope && !selected ? 'active-scope' : '',
        isHoverScope && !selected ? 'hover-scope' : '',
        isHoverGuide ? 'hover-guide' : '',
        insertClass,
        showDropInside ? 'drop-target' : '',
      ].filter(Boolean).join(' ')}
      data-tree-node-id={id}
      {...(type === 'story' || type === 'menu' || type === 'root'
        ? { 'data-media-node-id': id, 'data-media-node-type': type }
        : {})}
      onClick={(e) => onSelect(id, e)}
      onDoubleClick={(event) => {
        if (!onStartRename || event.target.closest('button, input, .badge-nav')) return;
        event.preventDefault();
        event.stopPropagation();
        onStartRename(id, type, label);
      }}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, id, type); } : undefined}
      onPointerEnter={(event) => {
        handlePointerHover?.(event);
        if (!dragging) onNodeHoverChange?.(id, true);
      }}
      onPointerMove={handlePointerHover}
      onPointerLeave={() => onNodeHoverChange?.(id, false)}
    >
      <span className="tree-depth-guides" aria-hidden="true" />
      <span className="tree-active-branch-guide" aria-hidden="true" />
      <span className="tree-hover-branch-guide" aria-hidden="true" />
      {hasToggle ? (
        <button
          className={`tree-chevron${expanded ? ' tree-chevron--expanded' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleExpand?.(id); }}
          onPointerDown={(e) => e.stopPropagation()}
          tabIndex={-1}
        />
      ) : (
        <span className="tree-chevron-spacer" />
      )}
      <div className="tree-item-body">
        <div className={`ti-badges${showNavigationBadgeColumn ? ' has-column' : ''}${navigationBadges.length === 0 ? ' is-empty' : ''}${hasHiddenNavigationBadges ? ' is-compact' : ''}`}>
          {visibleNavigationBadges.map((badge) => (
            <Tooltip key={badge.key} text={badge.title}>
              <span
                className={`badge-nav badge-nav--${badge.kind}${badge.status ? ` badge-nav--${badge.status}` : ''}`}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {BADGE_ICON_BY_KIND[badge.kind] ?? badge.label}
              </span>
            </Tooltip>
          ))}
          {hasHiddenNavigationBadges ? (
            <Tooltip text={hiddenNavigationBadgeTitle} wrap>
              <span
                className="badge-nav badge-nav--more"
                onPointerDown={(e) => e.stopPropagation()}
              >
                +{hiddenNavigationBadges.length}
              </span>
            </Tooltip>
          ) : null}
        </div>
        <span className="ti-icon">{resolvedIcon}</span>
        {renaming ? (
          <TreeInlineNameInput
            value={renameValue}
            onChange={onRenameChange}
            onCommit={onRenameCommit}
            onCancel={onRenameCancel}
          />
        ) : (
          <span className="ti-label">{label}</span>
        )}
        {type === 'zip' && <span className="badge-zip">ZIP</span>}
        {hasToggle && !expanded && childCount > 0 && (
          <span className="badge-count">{childCount}</span>
        )}
      </div>
    </div>
  );
}

export const TreeNode = memo(TreeNodeInner, (prev, next) => (
  prev.id === next.id
  && prev.type === next.type
  && prev.icon === next.icon
  && prev.label === next.label
  && prev.level === next.level
  && prev.selected === next.selected
  && prev.hovered === next.hovered
  && prev.cut === next.cut
  && prev.isAncestor === next.isAncestor
  && prev.isActiveScope === next.isActiveScope
  && prev.isHoverScope === next.isHoverScope
  && prev.isHoverGuide === next.isHoverGuide
  && prev.dragging === next.dragging
  && prev.containerDroppableId === next.containerDroppableId
  && prev.showNavigationBadgeColumn === next.showNavigationBadgeColumn
  && prev.navigationBadges === next.navigationBadges
  && prev.expanded === next.expanded
  && prev.onToggleExpand === next.onToggleExpand
  && prev.childCount === next.childCount
  && prev.color === next.color
  && prev.renaming === next.renaming
  && prev.renameValue === next.renameValue
  && prev.onStartRename === next.onStartRename
  && prev.onRenameChange === next.onRenameChange
  && prev.onRenameCommit === next.onRenameCommit
  && prev.onRenameCancel === next.onRenameCancel
  && prev.onSelect === next.onSelect
  && prev.onContextMenu === next.onContextMenu
  && prev.onNodeHoverChange === next.onNodeHoverChange
  && prev.hoverGuideScopeIds === next.hoverGuideScopeIds
  && prev.hoverGuideLevel === next.hoverGuideLevel
  && prev.hoverScopeEnabled === next.hoverScopeEnabled
  && prev.onHoverScope === next.onHoverScope
  && prev.dropTarget === next.dropTarget
  && prev.suppressSortAnimation === next.suppressSortAnimation
));
