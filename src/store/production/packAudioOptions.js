// Ce que les réglages audio de la fiche du pack deviennent quand ils partent au moteur.
//
// Deux choses s'assemblent ici, et elles n'ont pas la même source :
//
// - **le traitement demandé** — harmoniser ou non, et lequel des trois modes de
//   silence — appartient au projet, parce que l'auteur le règle pour ce
//   pack-là ;
// - **les durées de silence** héritent des préférences de l'application, mais
//   un pack peut porter ses propres valeurs. La fiche enregistre ces
//   dérogations dans `globalOptions`; ce module résout les valeurs effectives.
//
// La chaîne Libre assemble ces valeurs dans `projectToRustExport`. La chaîne
// graphe, elle, n'envoyait que la moitié du couple : la commande
// `export_advanced_pack` sait lire `leadingSilenceSec` et `trailingSilenceSec`
// depuis son premier jour, et le planificateur de médias les utilise, mais
// l'interface ne les lui donnait jamais. Ce module est l'endroit qui les
// donne, et c'est le seul.

import {
  getPackAudioEdgeSilenceSettings,
  readPackAudioProcessing,
  resolvePackAudioEdgeSilence,
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
  const resolvedEdgeSilence = resolvePackAudioEdgeSilence(globalOptions, edgeSilence);
  return {
    silenceMode,
    harmonizeLoudness,
    leadingSilenceSec: resolvedEdgeSilence.leading,
    trailingSilenceSec: resolvedEdgeSilence.trailing,
  };
}
