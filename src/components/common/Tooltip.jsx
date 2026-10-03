import { Children, cloneElement, isValidElement, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './Tooltip.css';

// `asChild` : la bulle se branche sur l'enfant (un seul élément DOM) au lieu
// de l'envelopper dans un bloc — pour un élément positionné en absolu, dans
// une grille ou visé par un sélecteur `parent > enfant`, que l'enveloppe
// déplacerait.
// `whenTruncated` : la bulle ne s'ouvre que si le texte de l'élément est coupé
// à l'écran — un nom entier n'a pas à être répété.
export function Tooltip({
  text, children, placement = 'below', wrap = false, className = '', style, disabled = false,
  asChild = false, whenTruncated = false,
}) {
  const [pos, setPos] = useState(null);
  const timerRef = useRef(null);
  const wrapRef = useRef(null);
  const bubbleRef = useRef(null);

  function handleEnter() {
    if (disabled) return;
    const anchor = wrapRef.current;
    if (whenTruncated && anchor && anchor.scrollWidth <= anchor.clientWidth) return;
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
    if (!disabled) return;
    clearTimeout(timerRef.current);
    setPos(null);
  }, [disabled]);

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

  const bubble = !disabled && pos && createPortal(
    <div
      ref={bubbleRef}
      className={`tooltip-bubble${pos.placement === 'above' ? ' is-above' : ''}${wrap ? ' is-wrap' : ''}`}
      style={{ left: pos.left, top: pos.top, '--tooltip-arrow-left': `${pos.arrowX}px` }}
    >
      {text}
    </div>,
    document.body,
  );

  if (asChild) {
    const child = Children.only(children);
    const childRef = child.props.ref;
    return (
      <>
        {cloneElement(child, {
          title: undefined,
          ref: (node) => {
            wrapRef.current = node;
            if (typeof childRef === 'function') childRef(node);
            else if (childRef) childRef.current = node;
          },
          onMouseEnter: (event) => { child.props.onMouseEnter?.(event); handleEnter(); },
          onMouseLeave: (event) => { child.props.onMouseLeave?.(event); handleLeave(); },
          onFocus: (event) => { child.props.onFocus?.(event); if (event.currentTarget.matches(':focus-visible')) handleEnter(); },
          onBlur: (event) => { child.props.onBlur?.(event); handleLeave(); },
        })}
        {bubble}
      </>
    );
  }

  return (
    <div className={`tooltip-wrap${className ? ` ${className}` : ''}`} style={style} ref={wrapRef} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {renderChildrenWithoutNativeTitle()}
      {bubble}
    </div>
  );
}
