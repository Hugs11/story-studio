import { shouldPromptRegenerateImportedUuid } from '../store/projectHelpers.js';
import { generateUuid } from '../utils/uuid.js';

// Nouvelle révision d'un pack repris par « Modifier un pack » : proposer, sans
// obligation, un nouvel UUID avant de générer. Le Libre et le graphe posent la
// même question, au même moment — avant le sélecteur de dossier de sortie, un
// dialogue natif qui passerait devant.
//
// Rend le brouillon, avec un UUID neuf si l'auteur le demande.
export async function askImportedUuidRevision(draft, showChoiceDialog) {
  if (!shouldPromptRegenerateImportedUuid(draft)) return draft;
  const choice = await showChoiceDialog({
    title: "Nouvelle révision d'un pack importé",
    message: "Ce pack a un UUID d'origine. Générer un nouvel UUID pour cette version ?\n\n"
      + "Garde l'UUID d'origine seulement pour remplacer exactement la même révision.",
    variant: 'info',
    cancelValue: 'keep',
    actions: [
      { value: 'keep', label: "Garder l'UUID d'origine", kind: 'ghost' },
      { value: 'renew', label: 'Générer un nouvel UUID', kind: 'primary', autoFocus: true },
    ],
  });
  return choice === 'renew' ? { ...draft, uuid: generateUuid() } : draft;
}
