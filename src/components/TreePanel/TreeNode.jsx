import { memo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { StatusDot } from '../common/Badge';
import { Tooltip } from '../common/Tooltip';
import {
  IconFolderClosed, IconFolderOpen, IconStory, IconArchive, IconHouse, IconMoon, IconStop,
  IconReturn, IconSquareFilled, IconDiamond, IconArrowRight,
  ICON_BY_KEY,
} from './TreeIcons';
import './TreePanel.css';

const BADGE_ICON_BY_KIND = {
  return: <IconReturn />,
  'prompt-return': <IconReturn />,
  home: <IconHouse />,
  'home-none': <IconHouse />,
  'end-node': <IconSquareFilled />,
  'end-night': <IconMoon />,
  'end-node-home': <IconHouse />,
  'end-night-home': <IconHouse />,
  'prompt-home': <IconHouse />,
  'prompt-home-none': <IconHouse />,
  graph: <IconDiamond />,
  continuation: <IconArrowRight />,
};

const MAX_VISIBLE_NAVIGATION_BADGES = 2;

function getTreeIndent(level) {
  const safeLevel = Math.max(level, 0);
  return 6 + Math.min(safeLevel, 6) * 12;
}

function TreeNodeInner({
  id,
  type,
  icon,
  label,
  level,
  selected,
  cut,
  isAncestor,
  status,
  sortable,
  dragging,
  containerDroppableId,
  navigationBadges = [],
  expanded,
  onToggleExpand,
  childCount,
  color,
  onSelect,
  onContextMenu,
  dropInfo,
  suppressSortAnimation,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: !sortable });
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
    ...(color ? { '--tree-node-color': color } : {}),
  };

  const isDragActive = dragging && !isDragging;
  const isMyTarget = isDragActive && (
    dropInfo?.targetId === id ||
    (type === 'root' && dropInfo?.targetId === null && dropInfo?.isContainer)
  );

  const showInsertBefore = !!(isMyTarget && !dropInfo.isContainer && dropInfo.position === 'before');
  const showInsertAfter = !!(isMyTarget && !dropInfo.isContainer && dropInfo.position === 'after');
  const showDropInside = !!(isMyTarget && dropInfo.position === 'inside' &&
    (dropInfo.isContainer || type === 'menu' || type === 'root'));

  const insertClass = showInsertBefore ? 'insert-before' : showInsertAfter ? 'insert-after' : '';
  const hasToggle = type === 'menu';
  const visibleNavigationBadges = navigationBadges.slice(0, MAX_VISIBLE_NAVIGATION_BADGES);
  const hiddenNavigationBadges = navigationBadges.slice(MAX_VISIBLE_NAVIGATION_BADGES);
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
  } else if (type === 'zip') {
    resolvedIcon = <IconArchive />;
  } else {
    resolvedIcon = <IconMoon />;
  }

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
        selected ? 'active' : '',
        color ? 'is-colored' : '',
        isAncestor && !selected ? 'ancestor-sel' : '',
        insertClass,
        showDropInside ? 'drop-target' : '',
      ].filter(Boolean).join(' ')}
      {...(type === 'story' || type === 'menu' || type === 'root'
        ? { 'data-media-node-id': id, 'data-media-node-type': type }
        : {})}
      onClick={(e) => onSelect(id, e)}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, id, type); } : undefined}
    >
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
        <div
          className={`ti-badges${hasHiddenNavigationBadges ? ' is-compact' : ''}`}
          style={navigationBadges.length === 0 && type !== 'story' && type !== 'end-node' ? { width: 0 } : undefined}
        >
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
        <span className="ti-label">{label}</span>
        {type === 'zip' && <span className="badge-zip">ZIP</span>}
        {hasToggle && !expanded && childCount > 0 && (
          <span className="badge-count">{childCount}</span>
        )}
        {status && <StatusDot status={status} />}
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
  && prev.cut === next.cut
  && prev.isAncestor === next.isAncestor
  && prev.status === next.status
  && prev.dragging === next.dragging
  && prev.containerDroppableId === next.containerDroppableId
  && prev.navigationBadges === next.navigationBadges
  && prev.expanded === next.expanded
  && prev.onToggleExpand === next.onToggleExpand
  && prev.childCount === next.childCount
  && prev.color === next.color
  && prev.onSelect === next.onSelect
  && prev.onContextMenu === next.onContextMenu
  && prev.dropInfo === next.dropInfo
  && prev.suppressSortAnimation === next.suppressSortAnimation
));
