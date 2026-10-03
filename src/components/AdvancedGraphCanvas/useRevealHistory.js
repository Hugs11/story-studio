// Le raccord React de l'historique des révélations.
//
// Il ne contient **aucune règle** : la déduplication, la coupure de la suite,
// l'écart des cibles disparues et la mémorisation du cadrage vivent dans
// `advancedGraphView/revealHistory.js`, qui ne dépend pas de React et qui est
// éprouvé sans lui. Ce hook fait trois choses, et pas une de plus : enregistrer
// une révélation volontaire, restaurer une visite, et écarter ce qui a disparu.
//
// Il existe comme hook — et non recopié dans chaque surface — parce que
// l'atelier **et** le banc de recette le montent tous deux. C'est ce qui permet
// à la recette d'exercer, dans WebKitGTK, exactement le code que l'application
// exécute : un adaptateur propre au banc aurait prouvé le banc.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  canGoBack,
  canGoForward,
  createRevealHistory,
  goBack,
  goForward,
  pruneMissing,
  recordVisit,
} from '../../store/advancedGraphView/revealHistory.js';

export function useRevealHistory({ index, viewport, focusPath, selectPath = null }) {
  const [history, setHistory] = useState(createRevealHistory);

  // Les cibles disparues sont écartées à chaque révision du document : un
  // Précédent ne doit jamais mener à un nœud retiré. Un changement de projet
  // remonte l'index à zéro, et l'historique repart vide — il n'a pas à garder
  // les chemins d'un document fermé.
  useEffect(() => {
    if (!index) {
      setHistory(createRevealHistory());
      return;
    }
    setHistory((current) => pruneMissing(current, (path) => index.byPath.has(path)));
  }, [index]);

  // Le tri entre ce qui s'enregistre et ce qui ne s'enregistre pas n'a pas
  // demandé de nouveau signal : la liste le portait déjà. Un parcours aux
  // flèches demande le cadrage avec `center: false` — il change le descendant
  // actif sans déplacer la caméra —, tandis qu'un résultat validé, un clic sur
  // un résultat et les liens de l'inspecteur le demandent avec `center: true`.
  // Seuls ces derniers sont des révélations volontaires.
  // Le cadrage est **lu** au moment de la visite, pas capturé en dépendance.
  // Sans cette référence, chaque panoramique donnerait une nouvelle identité
  // aux fonctions ci-dessous ; et `noteVisit` figure dans les dépendances du
  // montage du canvas, qui se remonterait alors à chaque déplacement de la
  // caméra.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const revealPath = useCallback((path, options) => {
    if (options?.center !== false) {
      setHistory((current) => recordVisit(current, path, viewportRef.current));
    }
    focusPath(path, options);
  }, [focusPath]);

  // Enregistrer une visite **sans rien cadrer**.
  //
  // C'est ce dont a besoin une sélection faite sur le canvas : l'auteur
  // regarde déjà le nœud qu'il vient de cliquer, et le recentrer sous son
  // curseur serait un déplacement qu'il n'a pas demandé. Seul le passage par
  // un panneau — une recherche, la liste, un lien de l'inspecteur — a une
  // caméra à déplacer, et c'est `revealPath` qui s'en charge.
  const noteVisit = useCallback((path) => {
    setHistory((current) => recordVisit(current, path, viewportRef.current));
  }, []);

  // Un déplacement n'est **pas** réenregistré : un Précédent qui s'empilerait
  // comme une nouvelle visite rendrait Suivant inatteignable. La sélection
  // posée ici passe par le moteur sans repartir en événement — l'adaptateur
  // garde une synchronisation en cours, et ne renvoie pas ce qu'il vient de
  // recevoir.
  //
  // Le nœud est **sélectionné**, pas seulement cadré. Cadrer sans
  // sélectionner laissait la liste et l'inspecteur suivre le pas-à-pas
  // pendant que la carte du graphe restait allumée sur le dernier nœud
  // cliqué : deux surfaces disaient alors deux nœuds différents.
  const goToVisit = useCallback((moved) => {
    if (!moved.visit) return;
    setHistory(moved.history);
    // `if-needed` : la caméra ne bouge que si le nœud rejoint est sorti de
    // l'écran. Le cadrage mémorisé sur la visite n'est donc pas rejoué —
    // revenir à 11 % de zoom parce qu'on y était alors surprendrait plus qu'il
    // n'aiderait. Ce qui compte est de retrouver le nœud, pas la caméra.
    if (selectPath) {
      selectPath(moved.visit.path);
      // `selectPath` porte déjà le focus : le redemander le poserait deux fois.
      focusPath(moved.visit.path, { center: 'if-needed', updateFocus: false });
      return;
    }
    focusPath(moved.visit.path, { center: 'if-needed' });
  }, [focusPath, selectPath]);

  const commands = useMemo(() => ({
    canBack: canGoBack(history),
    canForward: canGoForward(history),
    onBack: () => goToVisit(goBack(history)),
    onForward: () => goToVisit(goForward(history)),
  }), [history, goToVisit]);

  return { revealPath, noteVisit, history: commands };
}
