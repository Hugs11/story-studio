// Noms canoniques des sous-dossiers du workspace utilisateur.
// Utiliser ces constantes au lieu de strings hardcodés pour éviter
// les drift entre fichiers (`projectIO`, hooks d'import, médiathèque, etc.).

export const FICHIERS_IMPORTES = 'fichiers-importes';
export const ENREGISTREMENTS = 'enregistrements';
export const VOIX_GENEREES = 'voix-generees';
export const IMAGES_GENEREES = 'images-generees';
export const ZIPS_EXTRAITS = 'zips-extraits';
export const EXPORTS = 'exports';
export const SAUVEGARDES = 'sauvegardes';
export const VERSIONS_SECURITE = 'versions-securite';

// Dossiers que `delete_workspace_media_file` et `isManagedProjectPath` reconnaissent
// comme « médias gérés par l'app ». `zips-extraits/` est exclu (extractions ZIP
// nettoyées via flux dédiés, pas par suppression d'asset).
export const MANAGED_PROJECT_DIRS = Object.freeze([
  FICHIERS_IMPORTES,
  ENREGISTREMENTS,
  VOIX_GENEREES,
  IMAGES_GENEREES,
  ZIPS_EXTRAITS,
  EXPORTS,
]);
