function technicalText(error) {
  if (error == null) return '';
  return String(error?.message ?? error).trim();
}

/// Refus d'extraire dans l'éditeur par menus un pack qu'il ne sait pas
/// reprendre. Le moteur préfixe ce refus de façon stable ; le graphe, lui, sait
/// afficher ce pack et en récupérer les médias.
export const FREE_EDITOR_REFUSAL_MESSAGE =
  'Ce pack n’est pas compatible avec l’éditeur par menus. Pour le modifier, ouvre-le dans l’éditeur graphe : Projet → Ouvrir un pack.';

export function isFreeEditorRefusal(error) {
  return /^pack non éditable dans story studio/.test(technicalText(error).toLocaleLowerCase('fr'));
}

// Message public quand aucune cause connue n'est reconnue, selon l'endroit où
// l'erreur survient. `readOnly` et `unsupported` présentent le motif d'un
// verdict de classification, pas un échec d'ouverture.
const FALLBACK_MESSAGES = {
  open: 'Ce pack n’a pas pu être ouvert.',
  simulate: 'Le simulateur n’a pas pu ouvrir ce pack.',
  graph: 'L’Éditeur graphe n’a pas pu ouvrir ce pack.',
  readOnly: 'Sa structure ne peut pas être reconstruite dans un éditeur.',
  unsupported: 'Sa structure n’est pas lisible par Story Studio.',
};

/**
 * Sépare le message utile à l'auteur du diagnostic interne. Les erreurs Rust
 * peuvent contenir un chemin de cache, le nom d'un décodeur ou sa représentation
 * Debug : ces éléments restent consultables sans devenir le refus principal.
 */
export function presentImportError(error, context = 'open') {
  const technicalDetail = technicalText(error);
  const normalized = technicalDetail.toLocaleLowerCase('fr');

  let message;
  if (isFreeEditorRefusal(error)) {
    message = FREE_EDITOR_REFUSAL_MESSAGE;
  } else if (/lzma|compression method|unsupported compression|methode de compression|méthode de compression/.test(normalized)) {
    message = "Cette archive utilise une méthode de compression que Story Studio ne sait pas lire.";
  } else if (/invalid utf-?8|utf-?8 invalide|nom asset invalide|encrypted|chiffr/.test(normalized)) {
    message = "Ce pack semble chiffré ou utilise une variante que Story Studio ne prend pas en charge.";
  } else if (/mot de passe|password/.test(normalized)) {
    message = "Cette archive est protégée par un mot de passe et ne peut pas être ouverte.";
  } else if (/archive.*(invalid|invalide|corromp|endommag)|zip.*(invalid|invalide|corromp)/.test(normalized)) {
    message = "Cette archive est invalide ou endommagée.";
  } else if (/absent\(?s?\)? du zip/.test(normalized)) {
    message = "Des médias annoncés par le pack sont absents de l’archive.";
  } else if (/contrôles incomplets/.test(normalized)) {
    message = "Certains écrans du pack ont des réglages de boutons incomplets.";
  } else {
    message = FALLBACK_MESSAGES[context] ?? FALLBACK_MESSAGES.open;
  }

  return { message, technicalDetail };
}
