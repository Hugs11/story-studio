import { createContext, useContext } from 'react';

import { DEFAULT_SHORTCUT_LABELS } from './keyboardShortcuts.js';

// Les libellés **effectifs** des raccourcis — ceux que l'auteur a configurés,
// sinon ceux par défaut —, par identifiant de commande.
//
// Une infobulle ou une entrée de menu qui annonce une touche doit annoncer
// celle qui marche : reconfigurée dans les préférences, elle change partout à la
// fois. Fournis par `AppShell` ; sans fournisseur — un essai, le banc —, ce sont
// les libellés par défaut.
export const ShortcutLabelsContext = createContext(DEFAULT_SHORTCUT_LABELS);

export const useShortcutLabels = () => useContext(ShortcutLabelsContext) ?? DEFAULT_SHORTCUT_LABELS;
