// Le raccord React de la production graphe.
//
// **Ce hook ne fait pas tourner d'export.** Le travail vit dans la
// file de rendu, comme celui de l'éditeur Libre : c'est elle qui tient le poste
// natif, la progression, l'annulation, le résultat et l'historique. Ce qui reste
// ici est ce qui ne pouvait pas déménager avec lui —
//
// - **la destination**, choisie avant de bloquer l'auteur : le sélecteur est un
//   dialogue natif qui peut rester ouvert longtemps, et suspendre l'édition
//   pendant ce temps serait un verrou sans travail derrière ;
// - **la préparation**, qui bloque l'auteur, attend ses gestes en vol, puis
//   capture ce qui part. Ses règles vivent dans
//   `store/production/advancedRenderWork.js`, sans framework et sans Tauri ;
// - **le refus prononcé avant le moteur** — document à corriger, fichier absent.
//   Rien n'a été fabriqué, donc rien n'entre dans la file : ce refus se rapporte
//   là où l'auteur a posé la question, comme la chaîne Libre rapporte le sien
//   dans sa boîte de dialogue. Décision utilisateur du 16 septembre 2026 ;
// - **l'archive à relire**, tenue à côté du reste : fermer un compte rendu ne
//   ferme pas le lecteur, et une nouvelle production ne doit pas effacer
//   l'archive que l'auteur est en train d'écouter.

import { useCallback, useMemo, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

import { prepareAdvancedWork } from '../store/production/advancedRenderWork.js';
import { promoteDisplayedLayout } from '../store/advancedExport/displayedLayout.js';
import { createAdvancedViewBridge } from '../store/advancedGraphView/advancedViewBridge.js';
import { GESTURE_APPLIED } from '../store/advancedAuthoring/authoringSession.js';
import { readAuthoringPayload } from '../store/projectModel/authoring.js';
import { isReviewCurrent } from '../store/advancedExport/exportOutcome.js';
import { exportRevisionToken } from '../store/advancedExport/exportRequest.js';
import { advancedArchiveBaseName, advancedStoryTitle } from '../store/advancedExport/archiveName.js';
import { readAuthoringRevision } from '../store/projectModel/authoringRevision.js';
import { ensureExportsDir } from '../store/projectIO';
import { getLastExportDir, saveLastExportDir } from './useFileDialog';
import { KEYS, read as readSetting } from '../store/persistentSettings';
import { logger } from '../utils/logger';

// La vue de lecture sérialise chaque champ avec sa présence :
// absent, `null` ou valeur. Seule une valeur compte pour composer un nom.
function presenceValue(field) {
  return field?.presence === 'value' ? field.value : null;
}

export function useAdvancedExport({
  store,
  authoring,
  // La lecture du document telle que l'espace de travail la publie : titre et
  // version. Elle sert au **nom du fichier** produit, et à rien d'autre — le
  // document qui part reste le payload en mémoire, jamais cette vue.
  documentInfo = null,
  workspaceDirRef = null,
  pickFolder = defaultFolderPicker,
  readGraphView = (payload) => createAdvancedViewBridge().readGraphView(payload),
} = {}) {
  // Le seul état que ce hook tient encore : le refus prononcé **avant** que quoi
  // que ce soit parte au moteur.
  const [refusal, setRefusal] = useState(null);
  // L'archive à relire, tenue **à côté** du refus : les deux ne se chassent pas.
  const [review, setReview] = useState(null);
  const projectRef = useRef(store.project);
  projectRef.current = store.project;
  const epochRef = store.workEpochRef;

  // Les collaborateurs sont lus par **ref écrite pendant le rendu**, jamais
  // capturés dans les dépendances : la session d'édition rend un objet neuf à
  // chaque rendu, et une préparation qui en dépendrait serait reconstruite au
  // milieu de son propre travail.
  const collaborators = useRef(null);
  collaborators.current = { authoring, documentInfo };

  // Le témoin du document ouvert. La file le relit au retour d'un travail
  // graphe : une archive revenue après un changement de projet garde son
  // fichier, mais n'est pas présentée comme le résultat du document ouvert.
  const readTicket = useCallback(() => ({
    projectEpoch: epochRef.current,
    document: readAuthoringRevision(projectRef.current),
  }), [epochRef]);

  const resolveDefaultFolder = useCallback(async () => {
    const remembered = store.savePath ? getLastExportDir() : null;
    if (remembered) return remembered;
    const workspace = workspaceDirRef?.current
      || readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' });
    if (!workspace) return undefined;
    return (await ensureExportsDir(workspace)) || undefined;
  }, [store.savePath, workspaceDirRef]);

  const chooseFolder = useCallback(async () => {
    const folder = await pickFolder(await resolveDefaultFolder());
    if (folder) saveLastExportDir(folder);
    return folder ?? null;
  }, [pickFolder, resolveDefaultFolder]);

  /**
   * Ce qui part au moteur, capturé maintenant.
   *
   * L'auteur est suspendu ici et le reste jusqu'à ce que la file n'ait plus de
   * travail graphe. La suspension
   * n'est donc pas relâchée par ce hook en cas de succès : elle est dérivée de
   * la file, qui est la seule à savoir quand il n'y a plus rien à attendre.
   */
  const prepare = useCallback(async ({ outputFolder, options }) => {
    logger.info(`advanced:export-prepare folder='${outputFolder ?? ''}' silence=${options?.silenceMode} harmonize=${options?.harmonizeLoudness}`);
    // Ce que le graphe affiche devient la disposition d'auteur, avant que
    // l'auteur soit verrouillé : les gestes seraient refusés après.
    const promoted = await promoteDisplayedLayout({
      readProject: () => projectRef.current,
      readGraphView: (project) => readGraphView(readAuthoringPayload(project)),
      runGesture: (gesture, gestureOptions) => (
        collaborators.current.authoring.runGesture(gesture, gestureOptions)
      ),
      settle: () => collaborators.current.authoring.whenIdle(),
      applied: GESTURE_APPLIED,
      warn: (message) => logger.warn(`advanced:export-layout ${message}`),
    });
    if (promoted) projectRef.current = promoted;
    const prepared = await prepareAdvancedWork({
      readProject: () => projectRef.current,
      readTicket,
      // Le nom de l'archive : les champs de nommage viennent de l'enveloppe du
      // projet — ils ne composent que le nom du fichier et n'entrent dans aucun
      // pack —, le titre et la version du **document**, qui en est la seule
      // autorité.
      readArchiveName: () => advancedArchiveBaseName({
        packMetadata: projectRef.current?.packMetadata ?? null,
        title: presenceValue(collaborators.current.documentInfo?.metadata?.title),
        version: presenceValue(collaborators.current.documentInfo?.metadata?.version),
      }),
      // Le titre livré dans `story.json`, composé par la même règle : en
      // convention, l'archive porte l'âge comme côté Libre ; la fiche, elle,
      // garde le titre lisible du document.
      readStoryTitle: () => advancedStoryTitle({
        packMetadata: projectRef.current?.packMetadata ?? null,
        title: presenceValue(collaborators.current.documentInfo?.metadata?.title),
        version: presenceValue(collaborators.current.documentInfo?.metadata?.version),
      }),
      holdAuthoring: () => collaborators.current.authoring.hold('export'),
      releaseAuthoring: () => collaborators.current.authoring.releaseHold(),
      settleAuthoring: () => collaborators.current.authoring.whenIdle(),
      outputFolder,
      options,
    });
    return prepared;
  }, [readGraphView, readTicket]);

  // Un refus prononcé **avant** tout appel : le parcours de production a posé
  // ses questions, l'une d'elles a dit non, et le moteur n'a rien vu.
  const refuseBeforeStart = useCallback((localRefusal) => {
    logger.warn(`advanced:production-refused kind=${localRefusal?.kind ?? 'inconnu'} beforeEngine=true`);
    setRefusal(localRefusal);
    return true;
  }, []);

  const dismissRefusal = useCallback(() => setRefusal(null), []);

  // La relecture porte sur **l'archive effectivement produite**, avec la
  // révision qui l'a produite et le travail auquel elle appartenait. C'est ce
  // triplet qui permet de dire, après une nouvelle édition, que la simulation
  // n'est plus celle du document courant.
  const openReview = useCallback((produced) => {
    if (!produced?.zipPath) return;
    setReview({
      zipPath: produced.zipPath,
      revision: produced.revision ?? null,
      epoch: produced.epoch ?? null,
      at: Date.now(),
    });
  }, []);

  const closeReview = useCallback(() => setReview(null), []);

  // L'empreinte de la sortie inclut les liaisons et le nom du projet : un
  // remplacement média ou un nouveau titre de secours périme l'archive relue.
  const currentRevision = exportRevisionToken(store.project);
  const currentEpoch = epochRef.current;

  const reviewView = useMemo(() => review && {
    ...review,
    isCurrentRevision: isReviewCurrent(review, { revision: currentRevision, epoch: currentEpoch }),
  }, [review, currentRevision, currentEpoch]);

  return {
    prepare,
    chooseFolder,
    readTicket,
    refusal,
    refuseBeforeStart,
    dismissRefusal,
    review: reviewView,
    openReview,
    closeReview,
  };
}

async function defaultFolderPicker(defaultPath) {
  return openDialog({
    directory: true,
    multiple: false,
    title: 'Dossier de sortie du pack',
    defaultPath,
  });
}
