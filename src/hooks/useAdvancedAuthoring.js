// Le raccord React de la session d'édition avancée.
//
// Il ne contient **aucune règle** : la file, la fraîcheur et le sort d'une
// réponse périmée vivent dans `advancedAuthoring/authoringSession.js`, qui ne
// dépend pas de React et qui est éprouvé sans lui. Ce hook fait trois choses :
// donner à la session de quoi lire la dernière valeur acceptée, installer le
// projet qu'un geste rend, et exposer l'état que l'interface affiche.
//
// **Un geste accepté est une étape d'undo, et une seule.** `store.setProject`
// empile la valeur entière — payload, liaisons et contexte ensemble — parce que
// c'est ce que le store range dans l'historique. Un refus n'installe rien : le projet
// précédent reste littéralement l'objet courant, et il n'y a donc rien à
// défaire.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createAdvancedAuthoringSession,
  GESTURE_APPLIED,
  GESTURE_REFUSED,
  GESTURE_STALE,
} from '../store/advancedAuthoring/authoringSession.js';
import { applyAdvancedGesture } from '../store/projectModel/authoring.js';
import { readAuthoringRevision } from '../store/projectModel/authoringRevision.js';
import { logger } from '../utils/logger.js';

// Les deux états que l'interface a besoin de distinguer : un refus ferme les
// dialogues autrement qu'un succès, et rend au canvas la position du document ;
// seul un geste appliqué garde les places et les noms qu'il avait réservés.
// Les autres issues sont lues dans la session, qui les nomme toutes.
export { GESTURE_APPLIED, GESTURE_REFUSED };

export function useAdvancedAuthoring({ store, applyGesture = applyAdvancedGesture }) {
  // La dernière valeur **acceptée**, tenue dans une ref parce qu'un geste peut
  // partir entre l'installation et le rendu suivant : lire l'état de rendu
  // ferait alors repartir le geste d'un payload déjà remplacé.
  const projectRef = useRef(store.project);
  projectRef.current = store.project;
  const epochRef = store.workEpochRef;
  const [state, setState] = useState({
    busy: false, busyIntent: null, queuedIntent: null, refusal: null, lastReport: null, held: null,
  });

  const session = useMemo(() => createAdvancedAuthoringSession({
    readProject: () => projectRef.current,
    // Le document est identifié par sa **révision d'auteur complète** : le
    // payload dont le geste est parti, et les chemins des liaisons qui vont
    // avec. Le payload seul ne suffisait pas — remplacer le fichier derrière
    // une référence média, puis annuler ce remplacement, rend une chaîne
    // identique à l'octet, et une réponse tardive réinstallait le fichier
    // écarté avec le projet qu'elle avait capturé.
    //
    // `status` reste hors de la révision : c'est un relevé de disque, pas une
    // édition, et il n'a pas à périmer une réponse en vol.
    readTicket: () => ({
      projectEpoch: epochRef.current,
      document: readAuthoringRevision(projectRef.current),
    }),
    applyGesture: (project, gesture) => applyGesture(project, gesture),
    // Un geste marqué `history: false` modifie le projet sans ouvrir d'étape
    // d'undo : c'est le rangement posé seul à l'ouverture d'un pack sans
    // disposition, qu'un Ctrl+Z ne doit pas ré-empiler.
    commit: ({ project, intent }) => {
      projectRef.current = project;
      if (intent?.history === false) store.syncProjectWithoutHistory(project);
      else store.setProject(project);
    },
    onChange: setState,
  }), [applyGesture, epochRef, store.setProject, store.syncProjectWithoutHistory]);

  // Un changement de projet vide la file : une intention en attente désigne un
  // document qui n'est plus ouvert. Les réponses en vol, elles, se périment
  // seules par la garde d'époque.
  const epochAtMount = useRef(epochRef.current);
  useEffect(() => {
    if (epochAtMount.current === epochRef.current) return;
    epochAtMount.current = epochRef.current;
    session.reset();
  });

  const describe = useCallback((outcome, gestureName) => {
    if (outcome.status === GESTURE_REFUSED) {
      logger.warn(`advanced:gesture-refused gesture=${gestureName} code=${outcome.error?.code ?? 'inconnu'}`);
    } else if (outcome.status === GESTURE_STALE) {
      logger.info(`advanced:gesture-stale gesture=${gestureName}`);
    }
    return outcome;
  }, []);

  const runGesture = useCallback(
    async (gesture, { history = true } = {}) => describe(
      await session.run(history ? { gesture } : { gesture, history: false }),
      gesture?.gesture,
    ),
    [describe, session],
  );

  // Geste discret dont la demande est **assemblée au moment de l'envoi**, contre
  // la dernière valeur acceptée et non contre celle qui était rendue au clic.
  //
  // C'est ce dont a besoin une demande qui dépend de l'état du projet pour se
  // former — un dépôt de média choisit une référence encore libre, et la liste
  // des références change à chaque geste accepté. L'assembler au rendu la ferait
  // partir contre un document déjà remplacé.
  const runGestureFor = useCallback(
    async (name, build) => describe(await session.run({ build }), name),
    [describe, session],
  );

  // Intention continue : la fin d'un glisser. `build` relit le projet au moment
  // de l'envoi — la file ne capture jamais un payload.
  const coalesceGesture = useCallback(
    async (kind, build) => describe(await session.coalesce({ kind, build }), kind),
    [describe, session],
  );

  // Les commandes lisent la session immédiatement, sans attendre le rendu
  // qui actualise `locked` pour les boutons.
  const isLocked = useCallback(() => session.state.held !== null, [session]);

  return {
    busy: state.busy,
    queued: state.queuedIntent !== null,
    refusal: state.refusal,
    lastReport: state.lastReport,
    // Le verrou d'auteur est **distinct** de `busy` : l'un dure le temps d'un
    // geste, l'autre le temps d'un export. L'interface les dit différemment —
    // « geste en cours… » n'est pas « export en cours, édition suspendue ».
    held: state.held,
    locked: state.held !== null,
    isLocked,
    runGesture,
    runGestureFor,
    coalesceGesture,
    clearRefusal: session.clearRefusal,
    hold: session.hold,
    releaseHold: session.releaseHold,
    whenIdle: session.whenIdle,
  };
}
