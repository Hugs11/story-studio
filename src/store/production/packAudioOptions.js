// Ce que les réglages audio du tiroir deviennent quand ils partent au moteur.
//
// Deux choses s'assemblent ici, et elles ne vivent pas au même endroit :
//
// - **le traitement demandé** — harmoniser ou non, et lequel des trois modes de
//   silence — appartient au projet, parce que l'auteur le règle pour ce
//   pack-là ;
// - **les durées de silence** appartiennent à l'application, parce qu'elles
//   décrivent la cible de l'appareil et non l'intention d'un projet. Elles sont
//   réglées dans les préférences et rappelées dans le tiroir.
//
// La chaîne Libre faisait déjà cet assemblage, dans `projectToRustExport`. La
// chaîne graphe, elle, n'envoyait que la moitié du couple : la commande
// `export_advanced_pack` sait lire `leadingSilenceSec` et `trailingSilenceSec`
// depuis son premier jour, et le planificateur de médias les utilise, mais
// l'interface ne les lui donnait jamais. Ce module est l'endroit qui les
// donne, et c'est le seul.

import {
  getPackAudioEdgeSilenceSettings,
  readPackAudioProcessing,
} from '../../config/audioProcessing.js';

/**
 * Les options d'export d'un projet graphe, prêtes pour `buildExportRequest`.
 *
 * `edgeSilence` est injectable parce que les préférences vivent dans
 * `localStorage` : un test pur doit pouvoir dire « la préférence vaut 1,5 s »
 * sans monter de navigateur.
 */
export function advancedPackAudioOptions(
  globalOptions,
  edgeSilence = getPackAudioEdgeSilenceSettings(),
) {
  const { silenceMode, harmonizeLoudness } = readPackAudioProcessing(globalOptions);
  return {
    silenceMode,
    harmonizeLoudness,
    leadingSilenceSec: edgeSilence?.leading,
    trailingSilenceSec: edgeSilence?.trailing,
  };
}
