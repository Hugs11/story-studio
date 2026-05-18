// Conventions de nommage des médias workspace.
//
// Backup d'édition audio : un fichier `{stem}.original.{ext}` (ou `{stem}.original-N.{ext}`
// pour gérer les collisions) est créé en sibling du fichier édité par l'éditeur audio.
// Ces fichiers doivent être visibles dans l'Explorateur Windows mais ignorés par l'app
// (médiathèque, scans d'import, drop OS, nettoyage projet), sauf s'ils sont explicitement
// référencés par une entrée projet.

const ORIGINAL_BACKUP_RE = /\.original(?:-\d+)?\.[^.]+$/i;

/** Retire les séparateurs et préfixes UNC pour ne garder que le nom de fichier. */
function basename(path) {
  return String(path || '').replace(/\\/g, '/').replace(/.*\//, '');
}

/**
 * Renvoie `true` si le chemin/nom correspond à la convention de backup
 * `{stem}.original.{ext}` ou `{stem}.original-N.{ext}`.
 */
export function isOriginalBackup(pathOrName) {
  if (!pathOrName) return false;
  const name = basename(pathOrName);
  return ORIGINAL_BACKUP_RE.test(name);
}
