import { useTreeTranslation } from '../../i18n/useTreeTranslation.jsx';
import { translateTree as t } from '../../i18n/treePresentation.js';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Toggle } from '../common/Toggle';
import { Tooltip } from '../common/Tooltip';
import { Eye } from '../icons/LucideLocal';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import './TreeDisplayPopover.css';

const OPTIONS = [
  {
    key: 'badges',
    label: "tree:display.badges.label",
    help: "tree:display.badges.help",
  },
  {
    key: 'guides',
    label: "tree:display.guides.label",
    help: "tree:display.guides.help",
  },
];

export function TreeDisplayPopover({
  open,
  onOpenChange,
  showNavigationBadges,
  onShowNavigationBadgesChange,
  showGuides,
  onShowGuidesChange,
}) {
  useTreeTranslation();
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const [position, setPosition] = useState(null);

  const closeAndRestoreFocus = useCallback(() => {
    onOpenChange?.(false);
    triggerRef.current?.focus();
  }, [onOpenChange]);

  useEscapeKey(open, closeAndRestoreFocus);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const triggerRect = trigger.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportPadding = 8;
    const maxLeft = Math.max(viewportPadding, window.innerWidth - popoverRect.width - viewportPadding);
    const left = Math.max(viewportPadding, Math.min(triggerRect.right - popoverRect.width, maxLeft));
    const belowTop = triggerRect.bottom + 10;
    const aboveTop = triggerRect.top - popoverRect.height - 10;
    const isAbove = belowTop + popoverRect.height > window.innerHeight - viewportPadding;
    const top = isAbove ? Math.max(viewportPadding, aboveTop) : belowTop;
    const arrowLeft = Math.max(12, Math.min(triggerRect.left + (triggerRect.width / 2) - left, popoverRect.width - 12));

    setPosition({ left, top, arrowLeft, isAbove });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(event) {
      if (wrapRef.current?.contains(event.target) || popoverRef.current?.contains(event.target)) return;
      closeAndRestoreFocus();
    }

    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [closeAndRestoreFocus, open, updatePosition]);

  function updateOption(key, value) {
    if (key === 'badges') onShowNavigationBadgesChange?.(value);
    if (key === 'guides') onShowGuidesChange?.(value);
  }

  function getValue(key) {
    return key === 'badges' ? showNavigationBadges : showGuides;
  }

  return (
    <div className={`tree-display-wrap${open ? ' is-open' : ''}`} ref={wrapRef}>
      <Tooltip text={t("tree:display.tree.title")} placement="below">
        <button
          ref={triggerRef}
          type="button"
          className={`tree-display-trigger${open ? ' is-active' : ''}`}
          aria-label={t("tree:display.tree.title")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => onOpenChange?.(!open)}
        >
          <Eye className="tree-display-trigger-icon" strokeWidth={2.15} absoluteStrokeWidth />
        </button>
      </Tooltip>

      {open ? createPortal(
        <div
          ref={popoverRef}
          className={`tree-display-popover${position?.isAbove ? ' is-above' : ''}`}
          role="dialog"
          aria-label={t("tree:display.tree.title")}
          style={position
            ? {
              left: position.left,
              top: position.top,
              '--tree-display-arrow-left': `${position.arrowLeft}px`,
            }
            : { left: -9999, top: -9999, visibility: 'hidden' }}
        >
          <div className="tree-display-head">
            <span className="tree-display-title">{t("tree:display.options.title")}</span>
            <span className="tree-display-subtitle">{t("tree:display.options.description")}</span>
          </div>

          <div className="tree-display-section">
            {OPTIONS.map(({ key, label, help }) => (
              <Tooltip key={key} text={t(help)} wrap className="tree-display-row-tip">
                <div className="tree-display-row">
                  <span className="tree-display-label">{t(label)}</span>
                  <Toggle
                    on={!!getValue(key)}
                    onChange={(value) => updateOption(key, value)}
                    ariaLabel={t('tree:display.option.aria', { label: { key: label }, help: { key: help } })}
                  />
                </div>
              </Tooltip>
            ))}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
