// Modifier cette constante suffit pour aligner l'UI et la duree envoyee au moteur Rust.
export const PACK_AUDIO_EDGE_SILENCE_SECONDS = 0.4;

export function formatPackAudioEdgeSilence(seconds = PACK_AUDIO_EDGE_SILENCE_SECONDS) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '1 s';
  return Number.isInteger(value) ? `${value} s` : `${value.toLocaleString('fr-FR')} s`;
}
