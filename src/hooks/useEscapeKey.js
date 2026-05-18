import { useEffect } from 'react';

export function useEscapeKey(enabled, handler) {
  useEffect(() => {
    if (!enabled || !handler) return undefined;

    function handleKeyDown(event) {
      if (event.key !== 'Escape') return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      handler(event);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, handler]);
}
