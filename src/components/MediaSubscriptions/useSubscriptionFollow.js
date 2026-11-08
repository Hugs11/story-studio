import { useCallback, useRef, useState } from 'react';
import { findProjectSubscription, getProjectFollowedSources, sameSubscriptionSource } from '../../store/mediaSubscriptionSource.js';
import { translateMedia } from '../../i18n/mediaPresentation.js';

const EMPTY_FOLLOW = Object.freeze({ enabled: false, touched: false, subscriptionId: null, state: null });

/** Préremplissage local uniquement : aucun accès réseau ni initialSource de notification. */
export function useFollowedImportSource(source, enabled = true) {
  const sources = enabled ? getProjectFollowedSources(source) : [];
  const [url, setUrl] = useState(() => sources.length === 1 ? sources[0].url : '');
  const followed = sources.find((item) => sameSubscriptionSource(item, { source, url })) ?? null;
  return { sources, url, setUrl, followed };
}

/**
 * État de la case « Suivre » des imports podcast et YouTube.
 *
 * La case reflète le suivi existant du projet ouvert quand la source chargée y
 * est déjà configurée, et retient si l'utilisateur l'a réellement modifiée :
 * seule une modification explicite change le suivi à l'import.
 */
export function useSubscriptionFollow(source, initialSource) {
  const [follow, setFollow] = useState(EMPTY_FOLLOW);
  const initialSourceRef = useRef(initialSource);
  initialSourceRef.current = initialSource;

  const toggle = useCallback((checked) => {
    setFollow((current) => ({ ...current, enabled: checked, touched: true }));
  }, []);

  const reset = useCallback(() => setFollow(EMPTY_FOLLOW), []);

  // `previousUrl` est la source chargée auparavant : changer de source oublie
  // la case, alors qu'un choix fait avant le premier chargement est conservé.
  const sourceLoaded = useCallback((url, previousUrl = '') => {
    const known = findProjectSubscription(source, url);
    const initial = initialSourceRef.current;
    if (initial && sameSubscriptionSource(initial, { source, url })) {
      setFollow({
        enabled: initial.enabled ?? Boolean(initial.subscriptionId),
        touched: false,
        subscriptionId: initial.subscriptionId ?? known?.subscriptionId ?? null,
        state: known?.state ?? null,
      });
      return;
    }
    setFollow((current) => {
      const keep = !previousUrl || previousUrl === url ? current : EMPTY_FOLLOW;
      if (!known) return { ...keep, subscriptionId: null, state: null };
      if (keep.touched && known.state !== 'active' && known.state !== 'paused') {
        return { ...keep, subscriptionId: known.subscriptionId, state: known.state };
      }
      return {
        enabled: known.state === 'active' || known.state === 'pending',
        touched: false,
        subscriptionId: known.subscriptionId,
        state: known.state,
      };
    });
  }, [source]);

  const requestFields = useCallback(() => ({
    enabled: follow.enabled,
    enabledTouched: follow.touched,
    ...(follow.subscriptionId ? { subscriptionId: follow.subscriptionId } : {}),
  }), [follow]);

  return {
    follow,
    toggle,
    reset,
    sourceLoaded,
    requestFields,
    // Sans élément choisi, valider n'a de sens que si la case a été modifiée.
    canSubmitAlone: follow.touched && (follow.enabled || Boolean(follow.subscriptionId)),
    // Libellé lu au rendu de l'appelant : clés partagées avec les imports.
    get submitLabel() {
      return follow.subscriptionId ? translateMedia('import:media.follow.save') : translateMedia('import:media.follow.enable');
    },
  };
}

/** Texte d'état sobre affiché sous la case « Suivre ». */
export function followStatusText(follow) {
  if (follow.state === 'pending' && follow.enabled) return translateMedia('import:media.follow.pending');
  if (follow.state === 'active') {
    return follow.enabled ? translateMedia('import:media.follow.active') : translateMedia('import:media.follow.pauseOnSave');
  }
  if (follow.state === 'paused') {
    return follow.enabled ? translateMedia('import:media.follow.resumeOnSave') : translateMedia('import:media.follow.paused');
  }
  return translateMedia('import:media.follow.initial');
}
