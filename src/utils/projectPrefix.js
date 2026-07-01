export function sanitizeProjectPrefix(name) {
  return String(name || '').trim()
    .replace(/[<>:"/\\|?*\[\]+]/g, '_')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 40);
}

function stem(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.[^/.]+$/, '') || '';
}

export function getProjectFilePrefix(project, savePath = null) {
  // Pas de fallback « nouveau-projet » : en session éphémère non nommée, préfixer les
  // fichiers importés avec « nouveau-projet__ » polluait le nom du pack dérivé du nom
  // de fichier à l'extraction. Sans nom réel ni chemin de sauvegarde, on ne préfixe pas
  // (les fichiers gardent leur nom d'origine ; la promotion re-préfixera avec le vrai
  // nom de projet une fois enregistré).
  return sanitizeProjectPrefix(project?.projectName || stem(savePath));
}
