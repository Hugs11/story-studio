import { Children, cloneElement, isValidElement, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './Tooltip.css';

export function Tooltip({ text, children, placement = 'below', wrap = false, className = '', style }) {
  const [pos, setPos] = useState(null);
  const timerRef = useRef(null);
  const wrapRef = useRef(null);
  const bubbleRef = useRef(null);

  function handleEnter() {
    timerRef.current = setTimeout(() => {
      if (wrapRef.current) {
        const rect = wrapRef.current.getBoundingClientRect();
        setPos({
          left: rect.left,
          top: placement === 'above' ? rect.top : rect.bottom + 8,
          anchorTop: rect.top,
          anchorX: rect.left + (rect.width / 2),
          arrowX: 16,
          placement,
        });
      }
    }, 600);
  }

  function handleLeave() {
    clearTimeout(timerRef.current);
    setPos(null);
  }

  useLayoutEffect(() => {
    if (!pos || !bubbleRef.current) return;

    const bubbleWidth = bubbleRef.current.offsetWidth;
    const bubbleHeight = bubbleRef.current.offsetHeight;
    const viewportPadding = 8;
    const maxLeft = Math.max(viewportPadding, window.innerWidth - bubbleWidth - viewportPadding);
    const nextLeft = Math.min(Math.max(pos.left, viewportPadding), maxLeft);
    const nextArrowX = Math.min(
      Math.max(pos.anchorX - nextLeft, 12),
      Math.max(12, bubbleWidth - 12),
    );
    const nextTop = pos.placement === 'above'
      ? pos.anchorTop - bubbleHeight - 8
      : pos.top;

    if (nextLeft === pos.left && nextArrowX === pos.arrowX && nextTop === pos.top) return;
    setPos((current) => (current ? { ...current, left: nextLeft, arrowX: nextArrowX, top: nextTop } : current));
  }, [pos]);

  function renderChildrenWithoutNativeTitle() {
    return Children.map(children, (child) => {
      if (!isValidElement(child) || child.props?.title === undefined) return child;
      return cloneElement(child, { title: undefined });
    });
  }

  return (
    <div className={`tooltip-wrap${className ? ` ${className}` : ''}`} style={style} ref={wrapRef} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {renderChildrenWithoutNativeTitle()}
      {pos && createPortal(
        <div
          ref={bubbleRef}
          className={`tooltip-bubble${pos.placement === 'above' ? ' is-above' : ''}${wrap ? ' is-wrap' : ''}`}
          style={{ left: pos.left, top: pos.top, '--tooltip-arrow-left': `${pos.arrowX}px` }}
        >
          {text}
        </div>,
        document.body,
      )}
    </div>
  );
}
