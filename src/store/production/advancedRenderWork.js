// Le travail graphe, préparé puis exécuté par la file de rendu.
//
// Ce module remplace la session d'export de l'Éditeur avancé. Il ne perd aucune
// de ses règles : il les rend à leur lieu naturel maintenant que le travail vit
// dans la file.
//
// 1. **Un seul travail natif.** Le poste est pris par la file, pour les deux
//    natures. Ici, il n'est plus acquis — il est **vérifié** : `runAdvancedWork`
//    refuse de parler au moteur si le poste n'est pas tenu au nom du graphe.
//    Une garde plutôt qu'une prise, parce qu'il n'y a plus qu'un ordonnanceur.
// 2. **Les gestes en attente d'abord.** L'auteur est bloqué, puis on attend que
//    ce qui est en vol soit revenu, et **seulement ensuite** on capture payload
//    et liaisons. Capturer avant reviendrait à fabriquer une révision que
//    l'auteur a déjà quittée.
// 3. **Les mutations sont bloquées, la vue reste libre.** Le verrou d'auteur
//    n'est pas un verrou d'écran : panoramique, zoom, sélection et relecture
//    continuent. Il est pris **au clic** et rendu quand la file n'a plus de
//    travail graphe.
// 4. **Le retour de la commande décide.** Aucune ligne de progression ne
//    conclut : « la progression textuelle ne décide jamais du succès ».
// 5. **Aucun résultat affecté au mauvais projet.** Le ticket de document est
//    capturé à la demande et relu à l'arrivée ; une archive revenue après un
//    changement de projet — ou après une mutation de la **même** époque — est
//    rendue avec son fichier, mais **attribuée à la révision qui l'a demandée**.
// 6. **Une annulation demandée avant le départ est tenue.** Elle n'a plus besoin
//    d'être codée ici : un travail annulé pendant qu'il attend son tour passe à
//    « annulé » sans jamais démarrer, et la file le fait pour les deux natures.
//
// Ce qui a disparu, et pourquoi. La session collectait sa propre progression sur
// `generate-log` ; la file l'écoute déjà pour le travail en cours, et deux
// abonnements auraient écrit deux fois la même chose. Elle savait aussi se
// déclarer « bloquée par un autre travail » ; la file, elle, laisse simplement
// le travail en attente — c'est la contrainte du lot, et elle vaut dans les deux
// sens.

import {
  GENERATION_OWNER_ADVANCED,
} from '../nativeGenerationLock.js';
import {
  EXPORT_REFUSAL,
  classifyExportRefusal,
  summarizeExportSuccess,
} from '../advancedExport/exportOutcome.js';
import { buildExportRequest, ExportRequestError, exportRequestRevision } from '../advancedExport/exportRequest.js';

export const EXPORT_OWNERSHIP = Object.freeze({
  CURRENT: 'current',
  OTHER_REVISION: 'other-revision',
});

export const ADVANCED_WORK = Object.freeze({
  PREPARED: 'prepared',
  REFUSED: 'refused',
  SUCCEEDED: 'succeeded',
});

// La forme commune d'un refus, identique à celle que `classifyExportRefusal`
// rend : le rapport n'a qu'un seul branchement à connaître.
function localRefusal(fields) {
  return {
    kind: EXPORT_REFUSAL.REQUEST,
    preparationKind: null,
    title: 'Export impossible',
    message: '',
    code: null,
    cancelled: false,
    residue: false,
    entries: [],
    conflicts: [],
    disagreements: [],
    diagnostics: [],
    integrityErrors: [],
    path: null,
    codecError: null,
    beforeEngine: true,
    ...fields,
  };
}

/**
 * Ce qui part au moteur, capturé au moment où l'auteur le demande.
 *
 * Le verrou d'auteur est pris **avant** l'attente : sans cela, un geste parti
 * pendant qu'on attend les précédents ferait dériver la révision entre le moment
 * où l'auteur a demandé son pack et celui où il est capturé.
 *
 * Il n'est **pas** rendu ici en cas de succès : il est rendu par la file, quand
 * plus aucun travail graphe n'y est actif. En cas de refus, il l'est
 * immédiatement — rien ne va être fabriqué, et laisser l'auteur suspendu serait
 * un verrou sans travail derrière.
 */
export async function prepareAdvancedWork({
  readProject,
  readTicket,
  readArchiveName = () => null,
  readStoryTitle = () => null,
  holdAuthoring = () => {},
  releaseAuthoring = () => {},
  settleAuthoring = async () => {},
  outputFolder,
  options,
} = {}) {
  holdAuthoring();
  try {
    await settleAuthoring();

    let request;
    try {
      request = buildExportRequest({
        project: readProject(),
        outputFolder,
        options,
        archiveName: readArchiveName(),
        storyTitle: readStoryTitle(),
      });
    } catch (error) {
      releaseAuthoring();
      return {
        outcome: ADVANCED_WORK.REFUSED,
        refusal: error instanceof ExportRequestError
          ? localRefusal({ message: error.message, code: error.code })
          : classifyExportRefusal(error),
      };
    }

    const ticket = readTicket();
    return {
      outcome: ADVANCED_WORK.PREPARED,
      request,
      // La révision est celle de la **source d'export** : payload, liaisons et
      // nom du projet qui peut fournir le titre du ZIP. La révision d'auteur
      // du ticket reste distincte pour gouverner les gestes du graphe.
      revision: exportRequestRevision(request),
      epoch: ticket?.projectEpoch ?? null,
      ticketDocument: ticket?.document ?? null,
    };
  } catch (error) {
    releaseAuthoring();
    return {
      outcome: ADVANCED_WORK.REFUSED,
      refusal: localRefusal({
        message: `La préparation du document a échoué : ${String(error?.message ?? error)}`,
      }),
    };
  }
}

/**
 * L'archive, ou le refus qui l'a empêchée.
 *
 * Appelée par l'exécuteur de la file, **le poste natif déjà pris**. La garde
 * n'est pas décorative : c'est le seul endroit d'où part `export_advanced_pack`,
 * et un appel hors poste mêlerait sa progression à celle d'une génération Libre
 * et partagerait son annulation.
 */
export async function runAdvancedWork({
  job,
  invokeExport,
  readTicket = () => ({ projectEpoch: null, document: null }),
  lock = null,
} = {}) {
  if (lock && lock.holder?.owner !== GENERATION_OWNER_ADVANCED) {
    return {
      outcome: ADVANCED_WORK.REFUSED,
      refusal: localRefusal({
        message: "Le poste de travail natif n'est pas tenu au nom de l'éditeur graphe :"
          + " rien n'a été demandé au moteur.",
      }),
    };
  }

  try {
    const raw = await invokeExport(job.request);
    // Le ticket est relu **après** le retour : une archive revenue alors que
    // l'auteur a changé de projet garde son fichier, mais n'est pas présentée
    // comme le résultat du document ouvert. L'époque ne suffit pas — une
    // mutation de la même époque laisse le travail identique et la révision,
    // elle, a changé.
    const now = readTicket();
    const ownership = now?.projectEpoch === job.epoch && now?.document === job.ticketDocument
      ? EXPORT_OWNERSHIP.CURRENT
      : EXPORT_OWNERSHIP.OTHER_REVISION;
    return {
      outcome: ADVANCED_WORK.SUCCEEDED,
      result: { ...summarizeExportSuccess(raw), revision: job.revision, epoch: job.epoch, raw },
      ownership,
    };
  } catch (error) {
    return { outcome: ADVANCED_WORK.REFUSED, refusal: classifyExportRefusal(error) };
  }
}
