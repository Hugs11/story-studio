// Source unique des types MIME par extension, partagee par tous les chargeurs
// de medias (useLocalFile, useUrlCache, diagramme). Avant centralisation, 3
// maps quasi-identiques cohabitaient (dette de duplication).
//
// Le superset (images + audio) ne gene pas les consommateurs qui ne traitent
// que des images : un type audio n'est jamais demande pour une cover.
export const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  webm: 'audio/webm',
};
