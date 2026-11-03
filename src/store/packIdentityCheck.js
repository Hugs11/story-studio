import { presentUserMessage } from '../i18n/userMessage.js';
import { translateChecker } from '../i18n/checkerPresentation.js';
// Le seul contrôle posé sur l'UUID choisi dans la fiche du pack : les passerelles
// savent-elles le lire ? La règle est tenue par Rust (`check_pack_identity`),
// celle-là même que l'export applique : une saisie acceptée ici n'est jamais
// refusée au moment de produire. Aucun avertissement d'une autre nature.
//
// `invoke` est reçu en paramètre pour que la décision se teste sans Tauri.

// Le refus garde l'erreur d'origine (`{ error }`), ou `null` si l'UUID convient.
// La phrase est composée à l'affichage, dans la langue active.
export async function checkPackIdentity(value, invoke, currentUuid = '', officialProvenance = 'unknown') {
  try {
    await invoke('check_pack_identity', { value: String(value ?? ''), currentUuid: String(currentUuid ?? ''), officialProvenance });
    return null;
  } catch (error) {
    return { error };
  }
}

export function presentIdentityRefusal(error) {
  const reason = presentUserMessage(error).message.trim()
    || translateChecker('checker:identity.refusal.unchecked');
  return translateChecker('checker:identity.refusal.message', { reason });
}

// Rend le motif du refus, prêt à afficher, ou `null` si l'UUID convient.
export async function packIdentityRefusal(value, invoke, currentUuid = '', officialProvenance = 'unknown') {
  const refusal = await checkPackIdentity(value, invoke, currentUuid, officialProvenance);
  return refusal ? presentIdentityRefusal(refusal.error) : null;
}
