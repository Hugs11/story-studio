// La qualification d'export du document courant, recalculée et jamais mémorisée.
//
// Un ancien verdict ne survit jamais à un geste : une readiness est dérivée du
// payload, et ce hook ne fait que trois choses : la demander quand elle est utile,
// jeter les retours qui ne concernent plus le payload courant, et dire quand
// elle est périmée plutôt que d'afficher un chiffre faux.
//
// Elle n'autorise rien. La commande d'export refait ses propres vérifications
// et reste l'autorité ; ce que ce hook rend sert à **montrer** ce qui bloque,
// pas à décider si l'export part.

import { useCallback, useEffect, useRef, useState } from 'react';

import { assessAdvancedProjectReadiness, readAuthoringPayload } from '../store/projectModel/authoring.js';
import { summarizeReadiness } from '../store/advancedExport/exportReadiness.js';
import { logger } from '../utils/logger';

const READINESS_STATUS = Object.freeze({
  IDLE: 'idle',
  PENDING: 'pending',
  READY: 'ready',
  FAILED: 'failed',
});

export function useAdvancedReadiness({
  project,
  // Tant que la qualification n'est pas regardée, elle n'est pas demandée : sur
  // le profil extrême, décoder le payload à chaque geste coûterait le prix d'un
  // geste de plus, pour un chiffre que personne ne lit.
  enabled = false,
  assess = assessAdvancedProjectReadiness,
}) {
  const payload = readAuthoringPayload(project);
  const [state, setState] = useState({
    status: READINESS_STATUS.IDLE,
    summary: null,
    error: null,
    revision: null,
  });
  const projectRef = useRef(project);
  projectRef.current = project;
  const inFlightRef = useRef(null);

  const refresh = useCallback(async () => {
    const current = projectRef.current;
    const revision = readAuthoringPayload(current);
    if (revision === null) return;
    inFlightRef.current = revision;
    setState((previous) => ({ ...previous, status: READINESS_STATUS.PENDING }));
    try {
      const readiness = await assess(current);
      // Retour périmé : le payload a changé pendant l'appel. Il est jeté sans
      // bruit, exactement comme une réponse de geste périmée — l'afficher
      // donnerait la qualification d'une révision que l'auteur a quittée.
      if (inFlightRef.current !== revision) return;
      setState({
        status: READINESS_STATUS.READY,
        summary: summarizeReadiness(readiness),
        error: null,
        revision,
      });
    } catch (error) {
      if (inFlightRef.current !== revision) return;
      logger.warn(`advanced:readiness-failed code=${error?.code ?? 'inconnu'}`);
      setState({
        status: READINESS_STATUS.FAILED,
        summary: null,
        error,
        revision,
      });
    }
  }, [assess]);

  useEffect(() => {
    if (!enabled || payload === null) return;
    refresh();
  }, [enabled, payload, refresh]);

  return {
    status: state.status,
    summary: state.summary,
    error: state.error,
    // Le témoin de fraîcheur : la readiness affichée décrit-elle encore le
    // document ouvert ? Un `true` ici n'est pas une erreur, c'est l'aveu qu'une
    // édition vient d'avoir lieu et que le chiffre est celui d'avant.
    stale: state.revision !== null && state.revision !== payload,
    refresh,
  };
}
