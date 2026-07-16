import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from '../common/Tooltip';
import { Ellipsis } from '../icons/LucideLocal';
import { useEscapeKey } from '../../hooks/useEscapeKey';

const VIEWPORT_PADDING = 8;
const MENU_GAP = 7;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function StructureActionsOverflow({ actions }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEscapeKey(open, closeAndRestoreFocus);

  useEffect(() => {
    if (actions.length === 0 && open) setOpen(false);
  }, [actions.length, open]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - menuRect.width - VIEWPORT_PADDING);
    const left = clamp(triggerRect.right - menuRect.width, VIEWPORT_PADDING, maxLeft);
    const belowTop = triggerRect.bottom + MENU_GAP;
    const aboveTop = triggerRect.top - menuRect.height - MENU_GAP;
    const top = belowTop + menuRect.height <= window.innerHeight - VIEWPORT_PADDING
      ? belowTop
      : Math.max(VIEWPORT_PADDING, aboveTop);

    setPosition({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    updatePosition();
    const firstEnabled = menuRef.current?.querySelector('button:not(:disabled)');
    firstEnabled?.focus();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      closeAndRestoreFocus();
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [closeAndRestoreFocus, open, updatePosition]);

  function handleMenuKeyDown(event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...menuRef.current.querySelectorAll('button:not(:disabled)')];
    if (buttons.length === 0) return;
    event.preventDefault();

    const currentIndex = buttons.indexOf(document.activeElement);
    if (event.key === 'Home') {
      buttons[0].focus();
      return;
    }
    if (event.key === 'End') {
      buttons.at(-1).focus();
      return;
    }

    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = currentIndex < 0
      ? (direction > 0 ? 0 : buttons.length - 1)
      : (currentIndex + direction + buttons.length) % buttons.length;
    buttons[nextIndex].focus();
  }

  if (actions.length === 0) return null;

  return (
    <>
      <Tooltip text="Plus d’actions" placement="below">
        <button
          ref={triggerRef}
          type="button"
          className={`structure-actions-btn structure-actions-overflow-trigger${open ? ' is-active' : ''}`}
          aria-label="Plus d’actions"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            if (open) closeAndRestoreFocus();
            else setOpen(true);
          }}
        >
          <Ellipsis className="structure-actions-icon" strokeWidth={2} absoluteStrokeWidth />
        </button>
      </Tooltip>

      {open ? createPortal(
        <div
          ref={menuRef}
          className="structure-actions-overflow-menu"
          role="menu"
          aria-label="Actions supplémentaires"
          onKeyDown={handleMenuKeyDown}
          style={position
            ? { left: position.left, top: position.top }
            : { left: -9999, top: -9999, visibility: 'hidden' }}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="structure-actions-overflow-item"
              role="menuitem"
              disabled={action.disabled}
              title={action.title}
              onClick={() => {
                closeAndRestoreFocus();
                action.onClick?.();
              }}
            >
              {action.icon}
              <span>{action.title}</span>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
