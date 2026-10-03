// Les entrées de l'Éditeur avancé, et elles seules.
//
// Trois portes, toutes **explicites** :
//
// 1. La carte « Éditeur graphe » acquiert un document minimal neuf.
// 2. « Modifier un pack » choisit le Graphe directement quand la projection
//    Libre n'est pas fidèle, ou après le choix de l'auteur quand les deux
//    éditeurs conviennent. Aucun projet Libre en cours n'est converti : le
//    Graphe part toujours d'une acquisition neuve, dans une session neuve.
// 3. Rouvrir un `.mbah` avancé, qui ne passe pas par ici : le codec commun
//    identifie l'enveloppe, et le shell monte l'espace avancé parce que le
//    projet **est** avancé, pas parce qu'un drapeau le lui a dit.
//
// Chaque acquisition est un appel unique — création ou import — et c'est lui
// qui tire l'identité du pack. La répéter en tirerait une seconde ; la
// sauvegarde, la relecture et l'annulation transportent celle-ci.

import { useRef } from 'react';

import { getExtractedZipsDir } from '../store/projectIO';
import {
  acquireCreatedAdvancedProject,
  acquireImportedAdvancedProject,
  prepareImportedAdvancedProject,
} from '../store/projectModel/authoring.js';
import { sanitizeImportedName } from '../store/projectStore';
import { basename } from '../utils/fileUtils';
import { logger } from '../utils/logger';

// Le dossier d'assets d'un pack avancé, sous le dossier d'extraction que Rust
// valide déjà pour l'import Libre. Le nom est assaini comme celui d'un pack
// Libre : mêmes caractères interdits, même garde de chemin côté Rust.
function advancedAssetsDir(workspaceDir, zipPath, packLabel) {
  const name = sanitizeImportedName(packLabel || zipPath, zipPath).replace(/[/\\:*?"<>|]/g, '_');
  return `${getExtractedZipsDir(workspaceDir)}/${name}`;
}

export function useAdvancedProjectEntry({
  store,
  runFunnelLanding,
  savedSnapshotRef,
  setMediaLibraryPaths,
  importedPackPendingMetaRef,
  acquire = acquireImportedAdvancedProject,
  acquireCreated = acquireCreatedAdvancedProject,
  prepareImported = prepareImportedAdvancedProject,
}) {
  // L'époque du projet installé par « Modifier un pack ». C'est la seule
  // ouverture où l'Éditeur graphe peut ranger seul un pack sans disposition :
  // rouvrir un `.mbah`, même issu d'un pack, rend les positions telles que
  // l'auteur les a laissées — empilées comprises.
  const importedEpochRef = useRef(null);

  function installAdvancedProject(project) {
    // `loadProject` fait avancer l'époque et vide l'historique : les réponses
    // en vol du projet précédent sont périmées, et le premier geste de
    // l'auteur sera la première étape d'undo de ce document.
    store.loadProject(project);
    // Une acquisition neuve n'a jamais été enregistrée, mais elle n'a encore
    // rien à perdre : tant que l'auteur n'y touche pas, la garde de sauvegarde
    // la laisse partir sans question.
    savedSnapshotRef.current = null;
    store.markPristine();
    // Les étiquettes de médias sont hors du projet : `loadProject` ne les
    // touche pas, et celles de l'ancien projet ne concernent pas celui-ci.
    store.setMediaTags({});
    setMediaLibraryPaths([]);
  }

  async function startAdvancedProject({ title = 'Nouveau pack' } = {}) {
    await runFunnelLanding('advanced', async () => {
      const acquired = await acquireCreated({ title, projectName: title });
      installAdvancedProject(acquired);
      logger.info('advanced:created');
    }, { errorLog: 'advanced:create-error', applyProjectType: false });
  }

  // Atterrissage avancé : session neuve, acquisition, installation en une fois.
  //
  // `applyProjectType: false` est la seule différence avec l'atterrissage
  // Libre, et elle compte : poser un type hiérarchique ferait monter l'espace
  // Libre le temps de l'acquisition, sur un projet qui n'a pas d'arbre.
  async function landAdvancedPack({ zipPath, packLabel }) {
    await runFunnelLanding('advanced', async (workspaceDir) => {
      const acquired = await acquire({
        packPath: zipPath,
        assetsDir: advancedAssetsDir(workspaceDir, zipPath, packLabel),
        workspaceDir,
        projectName: (packLabel || basename(zipPath) || '').replace(/\.(zip|7z)$/i, ''),
      });
      // Version d'origine + 1, comme au Libre ; bloc Story Studio préservé.
      installAdvancedProject(await prepareImported(acquired, { packPath: zipPath }));
      importedEpochRef.current = store.workEpochRef.current;
      // Comme au Libre : la première production proposera de garder ou de
      // renouveler l'UUID repris du pack.
      if (importedPackPendingMetaRef) importedPackPendingMetaRef.current = true;
      logger.info(`advanced:landed zip='${zipPath}'`);
    }, { errorLog: 'advanced:land-error', applyProjectType: false });
  }

  // Vrai seulement pendant le travail ouvert par « Modifier un pack ».
  const isFreshlyImported = (epoch) => importedEpochRef.current !== null
    && importedEpochRef.current === epoch;

  return { landAdvancedPack, startAdvancedProject, isFreshlyImported };
}
