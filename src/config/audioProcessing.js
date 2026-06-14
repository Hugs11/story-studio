// Modifier cette constante suffit pour aligner l'UI et la duree envoyee au moteur Rust.
export const PACK_AUDIO_EDGE_SILENCE_SECONDS = 0.5;

export function formatPackAudioEdgeSilence(seconds = PACK_AUDIO_EDGE_SILENCE_SECONDS) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '1 sec';
  return Number.isInteger(value) ? `${value} sec` : `${value.toLocaleString('fr-FR')} sec`;
}
