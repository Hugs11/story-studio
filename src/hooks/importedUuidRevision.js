import { translateImport as t } from '../i18n/importPresentation.js';
import { shouldPromptRegenerateImportedUuid } from '../store/projectHelpers.js';
import { generateUuid } from '../utils/uuid.js';

// Nouvelle révision d'un pack repris par « Modifier un pack » : proposer, sans
// obligation, un nouvel UUID avant de générer. Le Libre et le graphe posent la
// même question, au même moment — avant le sélecteur de dossier de sortie, un
// dialogue natif qui passerait devant.
//
// Rend le brouillon, avec un UUID neuf si l'auteur le demande.
export async function askImportedUuidRevision(draft, showChoiceDialog, identityLock = null) {
  if (draft?.identityLocked || (identityLock && await identityLock(draft))) return draft;
  if (!shouldPromptRegenerateImportedUuid(draft)) return draft;
  const choice = await showChoiceDialog({
    get title() { return t('import:revision.dialog.title'); },
    get message() { return t('import:revision.dialog.message'); },
    variant: 'info',
    cancelValue: 'keep',
    actions: [
      { value: 'keep', get label() { return t('import:revision.keep.action'); }, kind: 'ghost' },
      { value: 'renew', get label() { return t('import:revision.renew.action'); }, kind: 'primary', autoFocus: true },
    ],
  });
  return choice === 'renew' ? { ...draft, uuid: generateUuid() } : draft;
}
