import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  CONSULTATION_EXPIRED,
  consultationReducer,
  consultationVisible,
  IDLE_CONSULTATION,
  tokenToClose,
} from '../store/catalogue/consultationLifecycle.js';
import { toCatalogueError } from '../store/catalogue/catalogueApi.js';
import { consultationFlatGraph } from '../tabs/EmulatorTab/flatGraph.js';
import { createConsultationMediaLoader } from '../tabs/EmulatorTab/flatMedia.js';
import { loadProjectFromPath } from '../store/projectIO.js';
import { projectToRustExport } from '../store/projectModel/schema.js';
import { readMediaBindings } from '../store/projectModel/mediaBindings.js';
import { isAdvancedProject } from '../store/projectModel/envelope.js';

/**
 * Un projet lu en lecture seule par le chargeur de projets existant (seul à
 * connaître ses normalisations historiques et la résolution de ses chemins de
 * médias, repli sur l'espace de travail compris), hors de tout store. Projet
 * par menus : mis dans la forme que lit le générateur. Projet graphe : ses
 * liaisons de médias résolues, le graphe étant relu par le moteur. Rien n'est
 * écrit, aucune session ni identité n'est créée : le résultat ne sert qu'à la
 * projection d'écoute, et le moteur ne sert que les fichiers du dossier du
 * projet, de l'espace de travail, ou nommés par le fichier projet lui-même
 * (qu'il relit).
 */
async function readCatalogueProject(path) {
  const { data } = await loadProjectFromPath(path);
  return JSON.stringify(isAdvancedProject(data)
    ? { authoring: { mediaBindings: readMediaBindings(data) } }
    : projectToRustExport(data));
}

/**
 * Simulation d'un exemplaire depuis le catalogue, dans une consultation
 * isolée : aucun projet, aucune session de travail, aucune reprise. Une seule
 * consultation à la fois ; elle est refermée côté moteur à la fermeture, à
 * l'échec, au remplacement par un autre lancement, au départ du catalogue et
 * au démontage. Les URL de ses médias sont les siennes et sont révoquées avec
 * elle.
 *
 * @param {{api: object, active?: boolean, readProject?: Function,
 *   onClosed?: Function, onCleanupFailed?: Function}} options
 */
export function useCatalogueConsultation({ api, active = true, readProject = readCatalogueProject, onClosed = null, onCleanupFailed = null }) {
  const [state, dispatch] = useReducer(consultationReducer, IDLE_CONSULTATION);
  const current = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const loader = useRef(null);
  const callbacks = useRef({ onClosed, onCleanupFailed });
  callbacks.current = { onClosed, onCleanupFailed };

  const disposeLoader = useCallback(() => {
    loader.current?.dispose();
    loader.current = null;
  }, []);

  const release = useCallback((token) => {
    if (!token) return Promise.resolve();
    return api.closeConsultation(token)
      .then((closed) => {
        if (closed.cleanupFailed && closed.cleanup) callbacks.current.onCleanupFailed?.(toCatalogueError(closed.cleanup));
      })
      .catch(() => { /* Fermeture idempotente : un nouvel essai aura lieu au prochain lancement. */ });
  }, [api]);

  const launch = useCallback(async (target, origin = null) => {
    const previous = current.current ?? tokenToClose(stateRef.current);
    disposeLoader();
    const token = crypto.randomUUID();
    current.current = token;
    dispatch({ type: 'launch', token, target, origin });
    if (previous) void release(previous);
    try {
      const { exemplar } = target;
      const projectJson = exemplar.format === 'project'
        ? await readProject(exemplar.path)
        : null;
      if (current.current !== token) return;
      const handle = await api.openConsultation({
        consultationId: token,
        exemplarId: exemplar.id,
        expectedRevision: target.expectedRevision,
        projectJson,
      });
      // Résultat d'un lancement fermé ou remplacé : refusé et nettoyé.
      if (current.current !== token) {
        void release(token);
        return;
      }
      const media = createConsultationMediaLoader({
        mediaTypes: handle.mediaTypes,
        readAsset: ({ mediaId }) => api.readConsultationAsset({ consultationId: token, mediaId }),
        onFailure: (error) => {
          if (error?.code === CONSULTATION_EXPIRED && current.current === token) dispatch({ type: 'expired', token });
        },
      });
      loader.current = media;
      dispatch({ type: 'prepared', token, handle: { ...handle, flatGraph: consultationFlatGraph(handle), media } });
    } catch (error) {
      if (current.current === token) dispatch({ type: 'failed', token, error });
    }
  }, [api, readProject, disposeLoader, release]);

  const close = useCallback(({ restore = true } = {}) => {
    const snapshot = stateRef.current;
    const token = current.current ?? tokenToClose(snapshot);
    current.current = null;
    disposeLoader();
    if (!consultationVisible(snapshot) && !token) return;
    dispatch({ type: 'close' });
    if (restore) callbacks.current.onClosed?.(snapshot.origin);
    void release(token).then(() => dispatch({ type: 'closed', token }));
  }, [disposeLoader, release]);

  const relaunch = useCallback(() => {
    const { target, origin } = stateRef.current;
    if (target) void launch(target, origin);
  }, [launch]);

  // Départ du catalogue (onglet Sources, écran quitté) ou démontage : fermer.
  useEffect(() => { if (!active) close({ restore: false }); }, [active, close]);
  useEffect(() => () => {
    const token = current.current;
    current.current = null;
    loader.current?.dispose();
    if (token) void api.closeConsultation(token).catch(() => {});
  }, [api]);

  return { state, visible: consultationVisible(state), launch, close, relaunch };
}
