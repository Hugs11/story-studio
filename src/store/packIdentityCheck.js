// Le seul contrôle posé sur l'UUID choisi dans la fiche du pack : les passerelles
// savent-elles le lire ? La règle est tenue par Rust (`check_pack_identity`),
// celle-là même que l'export applique : une saisie acceptée ici n'est jamais
// refusée au moment de produire. Aucun avertissement d'une autre nature.
//
// `invoke` est reçu en paramètre pour que la décision se teste sans Tauri.

// Rend le motif du refus, prêt à afficher, ou `null` si l'UUID convient.
export async function packIdentityRefusal(value, invoke) {
  try {
    await invoke('check_pack_identity', { value: String(value ?? '') });
    return null;
  } catch (error) {
    const reason = String(error?.message ?? error ?? '').trim()
      || "L'UUID du pack n'a pas pu être vérifié.";
    return `${reason} En saisir un autre, ou en générer un nouveau.`;
  }
}
