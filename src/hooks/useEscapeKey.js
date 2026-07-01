import { useEffect, useRef } from 'react';

// Pile partagée des surfaces qui écoutent Escape : seule la surface la plus
// récemment enregistrée (le sommet = la modale la plus imbriquée) reçoit la
// touche. Évite qu'un Escape ferme une modale située SOUS un dialogue, quel
// que soit l'ordre de ré-exécution des effets React.
const escapeStack = [];

function handleWindowKeyDown(event) {
  if (event.key !== 'Escape') return;
  if (event.defaultPrevented) return;
  const top = escapeStack[escapeStack.length - 1];
  if (!top) return;
  event.preventDefault();
  top.handler(event);
}

export function useEscapeKey(enabled, handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const hasHandler = typeof handler === 'function';

  useEffect(() => {
    if (!enabled || !hasHandler) return undefined;

    const entry = { handler: (event) => handlerRef.current?.(event) };
    escapeStack.push(entry);
    if (escapeStack.length === 1) {
      window.addEventListener('keydown', handleWindowKeyDown);
    }

    return () => {
      const index = escapeStack.indexOf(entry);
      if (index >= 0) escapeStack.splice(index, 1);
      if (escapeStack.length === 0) {
        window.removeEventListener('keydown', handleWindowKeyDown);
      }
    };
  }, [enabled, hasHandler]);
}
