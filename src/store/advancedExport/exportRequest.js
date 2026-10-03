// Ce qui part à `export_advanced_pack`, et d'où ça vient.
//
// Deux règles se tiennent ici, à l'écart de React :
//
// 1. **Le payload courant en mémoire**, jamais une sauvegarde ni une readiness
//    mémorisée. L'export est associé à la révision que l'auteur regarde ; la
//    demande porte donc le document et ses liaisons **du même projet**, pris
//    ensemble.
// 2. **Les défauts du Libre.** Sans choix explicite, les silences sont
//    ajustés et les volumes harmonisés, comme dans le Libre : les deux chaînes
//    ne donnent pas deux recommandations opposées pour le même geste. Les
//    valeurs restent envoyées explicitement, alors même que le `Default` de
//    Rust vaut `off` : le choix est ainsi lisible dans le journal comme dans
//    les tests.
//
//    Conséquence assumée, et c'est elle qui se vérifie à l'oreille : un projet
//    graphe dont l'auteur ne touche à rien voit désormais ses sons mesurés et
//    ré-encodés, là où le moteur les recopiait à l'octet.
//
// La demande porte aussi le **nom de l'archive**, composé par
// `archiveName.js` — exactement comme la chaîne Libre transporte son
// `name: getExportPackName(packMetadata)`. Le vide n'est pas transmis : le
// moteur retombe alors sur le titre du document.

import { DEFAULT_PACK_AUDIO_PROCESSING, PACK_SILENCE_MODES } from '../../config/audioProcessing.js';
import { readAuthoringPayload } from '../projectModel/authoring.js';
import { authoringRevisionOf } from '../projectModel/authoringRevision.js';
import { readMediaBindings } from '../projectModel/mediaBindings.js';

// Réexport de la liste unique : les trois modes sont une propriété du pack,
// pas de cette chaîne, et une seconde copie finirait par diverger.
const SILENCE_MODES = PACK_SILENCE_MODES;

// Les défauts du tiroir, lus à la source unique plutôt que recopiés : le
// tiroir affiche `readPackAudioProcessing`, la demande envoie la même chose, et
// aucun écart ne peut s'installer entre ce qui est montré et ce qui part.
export const DEFAULT_EXPORT_AUDIO_OPTIONS = Object.freeze({
  ...DEFAULT_PACK_AUDIO_PROCESSING,
});

export class ExportRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExportRequestError';
    this.code = code;
  }
}

function normalizeAudioOptions(options) {
  const silenceMode = SILENCE_MODES.includes(options?.silenceMode)
    ? options.silenceMode
    : DEFAULT_EXPORT_AUDIO_OPTIONS.silenceMode;
  // L'absence de choix vaut le défaut commun, jamais `false` : un appelant qui
  // ne dit rien demande ce que le tiroir affiche, pas le contraire.
  const harmonizeLoudness = options?.harmonizeLoudness === undefined
    ? DEFAULT_EXPORT_AUDIO_OPTIONS.harmonizeLoudness
    : options.harmonizeLoudness === true;
  const request = { silenceMode, harmonizeLoudness };
  // Les durées ne sont transmises que là où elles s'appliquent : en mode `off`,
  // Rust les ignore, et les envoyer laisserait croire à un réglage actif.
  if (silenceMode !== 'off') {
    if (Number.isFinite(options?.leadingSilenceSec)) request.leadingSilenceSec = options.leadingSilenceSec;
    if (Number.isFinite(options?.trailingSilenceSec)) request.trailingSilenceSec = options.trailingSilenceSec;
  }
  return request;
}

function projectNameOf(projectName) {
  return typeof projectName === 'string' ? projectName.trim() : '';
}

// La demande complète, prête à passer l'IPC. Elle est construite en **un seul
// point** depuis le projet, ce qui interdit structurellement d'assembler le
// payload d'une révision avec les liaisons d'une autre.
export function buildExportRequest({
  project, outputFolder, options, archiveName = null, storyTitle = null,
} = {}) {
  const payload = readAuthoringPayload(project);
  if (payload === null) {
    throw new ExportRequestError(
      'ADVANCED_PAYLOAD_REQUIRED',
      "Ce projet ne porte pas de document d'auteur avancé : il n'y a rien à exporter.",
    );
  }
  const folder = typeof outputFolder === 'string' ? outputFolder.trim() : '';
  if (folder.length === 0) {
    throw new ExportRequestError('OUTPUT_FOLDER_REQUIRED', 'Aucun dossier de sortie choisi.');
  }
  const archive = typeof archiveName === 'string' ? archiveName.trim() : '';
  // Le titre livré dans `story.json` : le nom de convention, comme la chaîne
  // Libre l'écrit. Vide en nom libre — le moteur garde le titre du document.
  const delivered = typeof storyTitle === 'string' ? storyTitle.trim() : '';
  // Le nom du projet sert de titre de secours dans le contenu du ZIP quand le
  // document n'en porte pas. Il ne remplace jamais un titre saisi par l'auteur.
  const projectName = projectNameOf(project?.projectName);
  // La vignette catalogue est un média d'**enveloppe**, comme côté Libre : elle
  // n'est ni une référence du document ni une liaison, donc ni `payload` ni
  // `mediaBindings` ne la portent. Elle voyage comme `archiveName`, par la même
  // frontière, et son absence laisse le moteur sur son repli — l'image de
  // l'Écran d'entrée, qui était le comportement d'origine.
  const cover = typeof project?.thumbnailImage === 'string' ? project.thumbnailImage.trim() : '';
  return {
    payload,
    mediaBindings: readMediaBindings(project),
    outputFolder: folder,
    options: normalizeAudioOptions(options),
    // Omis quand il est vide, pas envoyé vide : une chaîne vide se lirait comme
    // « l'auteur a demandé un nom vide », alors qu'elle veut dire « il n'a rien
    // demandé ».
    ...(archive ? { archiveName: archive } : {}),
    ...(delivered ? { storyTitle: delivered } : {}),
    ...(projectName ? { projectName } : {}),
    ...(cover ? { coverImage: cover } : {}),
  };
}

// Le témoin de révision d'un export : payload et liaisons comparés à l'octet,
// nom du projet comparé après le même nettoyage que la demande. Il permet de
// dire plus tard
// « cette archive est celle de cette révision » sans ouvrir le payload, et donc
// de ne pas présenter une relecture comme celle du document courant après une
// nouvelle édition.
//
// Les liaisons en font partie : un remplacement média change le fichier que
// l'archive contient sans toucher au payload, et un témoin réduit au payload
// affirmait encore que l'ancien ZIP correspondait au document ouvert. Le nom du
// projet entre aussi dans la copie quand aucun titre d'auteur n'est disponible.
export function exportRequestRevision({ payload, mediaBindings, projectName } = {}) {
  const document = authoringRevisionOf({ payload, mediaBindings });
  if (document === null) return null;
  const name = projectNameOf(projectName);
  return `${document}#${name.length}:${name}`;
}

export function exportRevisionToken(project) {
  return exportRequestRevision({
    payload: readAuthoringPayload(project),
    mediaBindings: readMediaBindings(project),
    projectName: project?.projectName,
  });
}
