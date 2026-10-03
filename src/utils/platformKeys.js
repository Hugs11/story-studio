// La touche de commande de la plateforme : l'adaptateur de frontière du clavier.
//
// La table des raccourcis décrit une commande par `ctrl: true`. Sous Windows et
// Linux, c'est la touche Ctrl ; sous macOS, c'est Cmd, et un Mac attend Cmd+S,
// Cmd+Z, Cmd+C. La table n'en savait rien : sur Mac, seule la touche Ctrl
// elle-même déclenchait ses raccourcis, et Cmd ne faisait rien.
//
// C'est une contrainte native réelle — la convention de modificateur du
// système —, pas un symptôme à contourner : elle est donc confinée ici, et tout
// le reste du clavier la lit par ces deux fonctions.

function platformName(nav) {
  return String(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '');
}

// Vrai sous macOS : la commande s'y tape avec Cmd.
export function commandKeyIsMeta(nav = globalThis.navigator) {
  return /mac|iphone|ipad/i.test(platformName(nav));
}

// Le libellé de la touche de commande, tel que le système l'affiche.
export function commandKeyLabel(nav = globalThis.navigator) {
  return commandKeyIsMeta(nav) ? '⌘' : 'Ctrl';
}
