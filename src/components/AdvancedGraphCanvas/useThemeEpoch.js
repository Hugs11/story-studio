// Le signal « le thème vient de changer », pour les surfaces qui ne peuvent pas
// se contenter de la cascade CSS.
//
// Le canvas est peint : ses couleurs sont copiées dans la feuille de style du
// moteur au montage, et aucune bascule `data-theme` ne les met à jour toute
// seule. Ce compteur donne aux adaptateurs le seul moment où ils doivent
// relire leur palette.
//
// Deux sources, parce que `applyThemePreference` en emploie deux : l'attribut
// `data-theme` de la racine pour un choix explicite, et la requête média du
// système pour le mode « Système ».

import { useEffect, useState } from 'react';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function useThemeEpoch() {
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const bump = () => setEpoch((value) => value + 1);
    const root = document.documentElement;
    const view = document.defaultView;

    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(bump)
      : null;
    observer?.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    const media = typeof view?.matchMedia === 'function' ? view.matchMedia(DARK_QUERY) : null;
    if (media?.addEventListener) media.addEventListener('change', bump);
    else media?.addListener?.(bump);

    return () => {
      observer?.disconnect();
      if (media?.removeEventListener) media.removeEventListener('change', bump);
      else media?.removeListener?.(bump);
    };
  }, []);

  return epoch;
}
