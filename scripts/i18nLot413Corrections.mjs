// Lot 4.13 — corrections volontaires du français source.
//
// Les tests d’équivalence comparent le FR rendu au rendu des sources d’origine
// (`git show BASE`). Ces sources restent intactes : on applique ici, au seul côté
// BASE, les corrections décidées au lot 4.13 et listées dans son rapport. Aucune
// valeur n’est lue dans les catalogues modifiés par le lot : chaque correction est écrite
// en clair, ce qui garde le test non tautologique. Seul le catalogue `rust`, inchangé ici,
// est lu pour protéger les messages Rust de la correction typographique.

// Typographie (section B) : apostrophe typographique entre deux lettres,
// points de suspension et flèche. Les données d’auteur des bancs n’en contiennent pas.
// Les messages Rust (catalogue `rust`, hors périmètre du lot) gardent leur typographie :
// leurs fragments statiques sont masqués avant la correction typographique.
import rustFr from '../src/locales/fr/rust.json' with { type: 'json' };
const RUST_FRAGMENTS = [...new Set(Object.values(rustFr)
  .flatMap((value) => value.split(/{{[^}]+}}/))
  .filter((fragment) => fragment.includes("'") && fragment.length >= 6)),
  // Littéraux techniques hors catalogue (diagnostics de codec), cités tels quels.
  "un projet avancé porteur d'un payload d'auteur"]
  .sort((a, b) => b.length - a.length)
  .flatMap((fragment) => [fragment, fragment.replaceAll("'", '&#x27;')]);

function typography(input) {
  const kept = [];
  let text = input;
  for (const fragment of RUST_FRAGMENTS) {
    if (!text.includes(fragment)) continue;
    text = text.split(fragment).join(`\u0001${kept.length}\u0001`);
    kept.push(fragment);
  }
  return restore(text
    .replace(/(\p{L})(?:'|&#x27;|&#39;)(?=\p{L}|«)/gu, '$1’')
    // Pas dans une donnée d’auteur citée (« mon récit... »).
    .replace(/\.\.\.(?! »)/g, '…')
    .replace(/ -> /g, ' → '), kept);
}

function restore(text, kept) {
  return text.replace(/\u0001(\d+)\u0001/g, (_, index) => kept[Number(index)]);
}

// Reformulations explicites (sections A, C et D) : [texte d’origine, texte corrigé].
// L’ordre compte : les fragments les plus longs d’abord.
export const LOT_413_REPLACEMENTS = [
  ['Les fichiers sources restent dans la médiathèque. Ils pourront ensuite être retirés ou supprimés depuis l’onglet Médias.', 'Les fichiers sources restent dans l’onglet Médias. Ils pourront ensuite y être retirés ou supprimés.'],
  ['de la médiathèque', 'de l’onglet Médias'],
  ['dans la médiathèque', 'dans l’onglet Médias'],
  ['média lié au document', 'média lié au projet'],
  ['Le rendu de l’image a echoue.', 'Le rendu de l’image a échoué.'],
  ['Sidecar d’image invalide', 'Fichier de retouche de l’image invalide'],
  ['Chercher dans le workspace', 'Chercher dans le dossier de travail'],
  ['Reculer de 5s', 'Reculer de 5 s'],
  ['Avancer de 5s', 'Avancer de 5 s'],
  ['50ms', '50 ms'],
  ['Média avancé:', 'Média avancé :'],
  ['<b>0</b> reliés sur', '<b>0</b> relié sur'],
  ['0 reliés sur', '0 relié sur'],
  ['<b>0</b> / 3 prêts à appliquer', '<b>0</b> / 3 prêt à appliquer'],
  ['0 / 3 prêts à appliquer', '0 / 3 prêt à appliquer'],
  ['Retirer le tag "${tag}"', 'Retirer le tag « ${tag} »'],
  ['Ajouter le tag "${tag}"', 'Ajouter le tag « ${tag} »'],
  ["label: 'Enreg.'", "label: 'Enregistrés'"],
  ["'Stage natif'", "'Écran sans nom'"],
  ["(project?.nativeGraph, 'Racine')", "(project?.nativeGraph, 'Menu racine')"],
  ['Document avancé', 'Éditeur graphe'],
  // ai
  ['Le texte à générer est vide.', 'Il n’y a aucun texte à lire. Saisis un texte.'],
  ['Sequence de fin', 'Séquence de fin'],
  [' - image reaction Accueil', ' - image de la réaction Accueil'],
  [' - image de selection', ' - image de sélection'],
  ['Utilisées ×', 'Utilisée ×'],
  ['configurées dans les préférences', 'configurées dans les Préférences'],
  ['Ajoute des favorites dans les préférences', 'Ajoute des favorites dans les Préférences'],
  ['Le fichier est lié au document. Les écrans', 'Le fichier est lié au projet. Les Écrans'],
  ['Le fichier est lié au document, mais aucun écran', 'Le fichier est lié au projet, mais aucun Écran'],
  ['Glisser vers un placeholder image, cliquer pour prévisualiser', 'Glisse l’image vers un emplacement d’image pour l’utiliser. Clique pour la prévisualiser.'],
  ['image de couverture du menu racine', 'image de couverture du Menu racine'],
  ['Graphe natif - stage ', 'Éditeur graphe - Écran '],
  // checker
  ['média est introuvable. Pour chacun, les écrans', 'média est introuvable. Les Écrans'],
  ['Copier le log', 'Copier le journal'],
  [' pour le paquet', ' pour le pack'],
  ['Description ou changelog', 'Description ou notes de version'],
  ['</code> — écran <code>', '</code> — Écran <code>'],
  ['Exporter le log', 'Exporter le journal'],
  [/<strong>([01])<\/strong> automatiques/g, '<strong>$1</strong> automatique'],
  [/<strong>([01])<\/strong> facultatives/g, '<strong>$1</strong> facultative'],
  [/<strong>([01])<\/strong> corrections prêtes/g, '<strong>$1</strong> correction prête'],
  [/<strong>([01])<\/strong> suggestions\./g, '<strong>$1</strong> suggestion.'],
  [/\b([01]) automatique\(s\)/g, '$1 automatique'],
  [/\b(\d{2,}|[2-9]) automatique\(s\)/g, '$1 automatiques'],
  [/\b([01]) suggestion\(s\) facultative\(s\) sélectionnée\(s\)/g, '$1 suggestion facultative sélectionnée'],
  [/\b(\d{2,}|[2-9]) suggestion\(s\) facultative\(s\) sélectionnée\(s\)/g, '$1 suggestions facultatives sélectionnées'],
  ['n’a pas été produit', 'n’a pas été généré'],
  ['aucun pack n’a été produit', 'aucun pack n’a été généré'],
  [/\b([01]) étapes(?=<)/g, '$1 Écran'],
  [/\b(\d+) étapes(?=<)/g, '$1 Écrans'],
  ['les écrans qui l’utilisent', 'les Écrans qui l’utilisent'],
  ['choisis le fichier depuis l’écran concerné', 'choisis le fichier depuis l’Écran concerné'],
  ['>Étapes<', '>Écrans<'],
  ['Étapes : ', 'Écrans : '],
  ['Sérialisation du document', 'Conversion du projet pour l’export'],
  // production
  ['Ce projet ne porte pas de document d’auteur avancé : il n’y a rien à exporter.', 'Ce projet n’a pas été créé dans l’Éditeur graphe : il n’y a rien à exporter.'],
  ['Le poste de travail natif n’est pas tenu au nom de l’éditeur graphe : rien n’a été demandé au moteur.', 'Une autre opération utilise déjà le moteur de génération : rien n’a été lancé. Réessaie dans un instant.'],
  ['Les références médias du document doivent être connues avant la production.', 'Les médias du projet doivent être vérifiés avant la génération.'],
  ['La qualification du document n’a pas pu être calculée, et rien n’a été fabriqué', 'Story Studio n’a pas pu vérifier si le projet est prêt, et rien n’a été généré'],
  ['Les médias du document n’ont pas pu être vérifiés, et rien n’a été fabriqué', 'Les médias du projet n’ont pas pu être vérifiés, et rien n’a été généré'],
  ['La préparation du document a échoué', 'La préparation du projet a échoué'],
  [/le document porte ([01]) point\(s\) à corriger avant de produire le pack/g, 'le projet a $1 point à corriger avant de générer le pack'],
  [/le document porte (\d+) point\(s\) à corriger avant de produire le pack/g, 'le projet a $1 points à corriger avant de générer le pack'],
  ['Fabrication impossible — qualification d’export bloquée', 'Génération impossible — des points restent à corriger'],
  ['Fabrication impossible', 'Génération impossible'],
  ['Rien n’a été fabriqué', 'Rien n’a été généré'],
  ['Fabrication du pack en cours', 'Génération du pack en cours'],
  ['Fabrication en cours :', 'Génération en cours :'],
  ['Rattachement des médias en désaccord', 'Médias préparés différents de ceux du projet'],
  ['Qualification d’export bloquée', 'Points à corriger avant l’export'],
  ['Annuler ce rendu', 'Annuler cette génération'],
  ['Copier logs', 'Copier le journal'],
  ['Ouvrir dossier', 'Ouvrir le dossier'],
  ['File de rendu', 'File de génération'],
  ['file de rendu', 'file de génération'],
  ['Vider terminés', 'Vider les tâches terminées'],
  ['Aucun rendu en file d’attente.', 'Aucune génération en file d’attente.'],
  ['Simuler le pack produit', 'Simuler le pack généré'],
  ['Rapport de production', 'Rapport de génération'],
  ['Journal de la production', 'Journal de la génération'],
  ['Annuler la production', 'Annuler la génération'],
  ['Aucune production', 'Aucune génération'],
  ['Production en cours', 'Génération en cours'],
  ['Pack produit', 'Pack généré'],
  ['Production annulée', 'Génération annulée'],
  ['Production interrompue', 'Génération interrompue'],
  ['cette production n’en rapporte aucun', 'cette génération n’en rapporte aucun'],
  ['aucun n’empêche la production', 'aucun n’empêche la génération'],
  ['une production est encore en cours', 'une génération est encore en cours'],
  ['; retour arrière impossible : ', ' ; impossible de revenir à l’état précédent : '],
  // help
  ['(avec preview)', '(avec pré-écoute)'],
  ['(arbre, listbox, menu)', '(arbre, liste, menu)'],
  ['(listbox)', '(liste)'],
  ['Fermer un menu / popover / dialogue', 'Fermer un menu, une fenêtre contextuelle ou un dialogue'],
  // home
  ['Panneau PackNameModal pré-rempli, cohérent avec Modifier un pack.', 'Fiche du pack pré-remplie, comme pour modifier un pack existant.'],
  ['ZIP importe', 'ZIP importé'],
  ['Description changelog', 'Description notes de version'],
  ['>changelog<', '>notes de version<'],
  [/\b([01]) packs agrégés/g, '$1 pack agrégé'],
  ['Aucune image racine définie', 'Aucune image d’accueil définie'],
  ['ou définis l’image racine', 'ou définis l’image d’accueil'],
  ['Reprend l’image du menu racine', 'Reprend l’image du Menu racine'],
  // examples (textes d’histoire : quatre points relevés)
  ['Suivre les petites pattes.', 'Suivre les petites traces.'],
  ['Les petits pas mènent au chêne de Zoé.', 'Les petites traces mènent au chêne de Zoé.'],
  ['devant la trappe du cellier, gonflée par l’humidité.', 'devant la trappe du cellier, que l’humidité a fait gonfler.'],
  ['Les feuilles ne forment pas une pâte à modeler pour ce vase.', 'On ne peut pas modeler ce vase avec des feuilles.'],
  ['"Le lapin gris"', '"Le lapin gris."'],
  ['"Le phare de l’île aux brumes"', '"Le phare de l’île aux brumes."'],
  ['Chaque visite te ramène au train. Prêt à partir ?', 'Chaque visite te ramène au train. On y va ?'],
  // settings
  ['Système suit l’apparence configurée dans Windows, Linux et macOS', '« Système » suit l’apparence configurée dans Windows, Linux et macOS.'],
  ['quand on sélectionne un nœud', 'quand on sélectionne un élément'],
  ['Supprimer le message de fin<', 'Supprimer le message de fin ?<'],
  ['Ajoute un bouton ✨ Générer IA sous chaque image', 'Ajoute un bouton « Générer avec l’IA (ComfyUI) » sous chaque image'],
  ['Importer un workflow custom', 'Importer un workflow personnalisé'],
  ['Utiliser un workspace pour les nouveaux projets', 'Utiliser l’emplacement de travail pour les nouveaux projets'],
  ['Le funnel « Pack depuis YouTube »', 'Le parcours guidé « Pack depuis YouTube »'],
  ['YouTube bloquant les versions périmées, ces réglages ne servent qu’en cas de souci.', 'Comme YouTube bloque les versions périmées, ces réglages ne servent qu’en cas de problème.'],
  ['device inconnu', 'périphérique inconnu'],
  ['Ctrl+Maj+S', 'Ctrl+Shift+S'],
  ['Sections des préférences', 'Sections des Préférences'],
  // graph
  [' en X en Y.', ' en X et en Y.'],
  ['Geste refusé', 'Action refusée'],
  [/\b([01]) transition\(s\) ont conservé leur destination/g, '$1 transition a conservé sa destination'],
  [/\b(\d+) transition\(s\) ont conservé/g, '$1 transitions ont conservé'],
  [/\b([01]) raccord\(s\) ont été retirés/g, '$1 raccord a été retiré'],
  [/\b(\d+) raccord\(s\) ont été retirés/g, '$1 raccords ont été retirés'],
  [/\b([01]) raccord\(s\) ont changé/g, '$1 raccord a changé'],
  [/\b(\d+) raccord\(s\) ont changé/g, '$1 raccords ont changé'],
  [/\b([01]) raccord\(s\) vers (elle|lui) seront coupés et signalés/g, '$1 raccord vers $2 sera coupé et signalé'],
  [/\b(\d+) raccord\(s\) vers (elle|lui) seront coupés/g, '$1 raccords vers $2 seront coupés'],
  [/\b([01]) décision\(s\) d’export deviennent périmées : elles restent enregistrées comme trace, elles ne s’appliquent plus/g, '$1 décision d’export devient périmée : elle reste enregistrée comme trace, elle ne s’applique plus'],
  [/\b(\d+) décision\(s\) d’export/g, '$1 décisions d’export'],
  [/\b([01]) référence\(s\) média ne sont plus utilisées par cet écran\. Leur liaison/g, '$1 référence média n’est plus utilisée par cet Écran. Sa liaison'],
  [/\b(\d+) référence\(s\) média ne sont plus utilisées par cet écran/g, '$1 références média ne sont plus utilisées par cet Écran'],
  [/\b([01]) référence\(s\) média restent/g, '$1 référence média reste'],
  [/\b(\d+) référence\(s\) média restent/g, '$1 références média restent'],
  [/\b([01]) ancrage\(s\) mémorisé\(s\) ne désignent plus rien : ignorés, non supprimés/g, '$1 ancrage mémorisé ne désigne plus rien : ignoré, non supprimé'],
  [/\b(\d+) ancrage\(s\) mémorisé\(s\)/g, '$1 ancrages mémorisés'],
  [/\b([01]) nœuds dans cette zone/g, '$1 nœud dans cette zone'],
  [/Retirer ([01]) éléments/g, 'Retirer $1 élément'],
  [/(Voir|Masquer) les ([01]) Écran\b/g, '$1 $2 Écran'],
  [/utilisé par (\d+) écran/g, 'utilisé par $1 Écran'],
];

// `extra` : reformulations propres à un domaine (même texte d’origine, sens différent
// selon l’éditeur), appliquées avant la liste commune.
export function applyLot413(text, extra = []) {
  let out = typography(text);
  for (const [before, after] of [...extra, ...LOT_413_REPLACEMENTS]) out = before instanceof RegExp ? out.replace(before, after) : out.split(before).join(after);
  return out;
}

export const LOT_413_GRAPH = [
  ['Définir comme racine', 'Définir comme Écran d’entrée'],
  ['"Suite "', '"Suite du parcours"'],
  [/^Suite $/, 'Suite du parcours'],
  [' Nom Suite Destination finale ', ' Nom Suite du parcours Destination finale '],
];

// Valeur structurée (fixture rendue, objet de présentation).
export function applyLot413Deep(value, extra = []) {
  return value === undefined ? value : JSON.parse(applyLot413(JSON.stringify(value), extra));
}

// Éditeur par menus : « racine » y désigne le Menu racine (premier niveau).
export const LOT_413_TREE = [
  [/^Racine$/, 'Menu racine'],
  ['Menu Racine', 'Menu racine'],
  ['Sortir de la racine', 'Sortir du Menu racine'],
  ['Définir comme racine', 'Définir comme Menu racine'],
  ['Deplacer a la racine', 'Déplacer dans le Menu racine'],
  ['Deplacer ici', 'Déplacer ici'],
  [/^Deplacer$/, 'Déplacer'],
  [/^menu racine$/, 'Menu racine'],
  [/\b([01]) histoires attendent/g, '$1 histoire attend'],
  [/\b([01]) continuent automatiquement/g, '$1 continue automatiquement'],
  [/\b([01]) restent sur le message/g, '$1 reste sur le message'],
  [/afficher ses ([01]) histoires/g, 'afficher $1 histoire'],
  [/"([01])","histoires"/g, '"$1","histoire"'],
  [/Parcours de ([01]) histoires/g, 'Parcours de $1 histoire'],
  [/\b([01]) stages\b/g, '$1 Écran'],
  [/\b(\d+) stages\b/g, '$1 Écrans'],
  [/(Déplacer|Coller) ([01]) sons ici/g, '$1 $2 son ici'],
  [/Assembler ([01]) audios/g, 'Assembler $1 audio'],
  [/Supprimer ([01]) éléments/g, 'Supprimer $1 élément'],
  [/Couleur \(([01]) éléments\)/g, 'Couleur ($1 élément)'],
  ['sur cet écran de choix', 'sur cet Écran de choix'],
  ['Tant que ce Dossier reste', 'Tant que ce dossier reste'],
  ['dans ce Dossier, ou ajoute', 'dans ce dossier, ou ajoute'],
  ['Le Dossier linéaire placé seul', 'Le dossier linéaire placé seul'],
  ['aux autres Dossiers sélectionnés', 'aux autres dossiers sélectionnés'],
  ['Un Dossier ne peut pas être déplacé dans son propre sous-arbre.', 'Un dossier ne peut pas être déplacé dans son propre sous-arbre.'],
  [/\b([01]) actions\b/g, '$1 liste de choix'],
  [/\b(\d+) actions\b/g, '$1 listes de choix'],
  ['Rester sur l’écran', 'Rester sur l’Écran'],
  ['Attente sur l’écran', 'Attente sur l’Écran'],
  [/^Stage$/, 'Écran'],
  [/^stage$/, 'Écran'],
  ['Filtrer les stages', 'Filtrer les Écrans'],
  ['Stages du graphe importé', 'Écrans du graphe importé'],
  ['Image du stage', 'Image de l’Écran'],
  ['Audio du stage', 'Audio de l’Écran'],
  ['Ce pack utilise une structure interactive avec convergences et retours Accueil explicites. Les stages ci-dessous sont ceux qui seront utilisés pour le round-trip fidèle.', 'Ce pack utilise une structure interactive, avec des parcours qui se rejoignent et des retours Accueil explicites. Les Écrans ci-dessous seront conservés à l’identique lors d’un nouvel export.'],
  ['Joué à la fin de l’histoire, avant la destination auto-next', 'Ignoré tant qu’Auto-next est activé : l’histoire passe directement à la destination auto-next.'],
  ['Retour au menu d’accueil', 'Retour au menu parent'],
  ['Continuation native importée depuis', 'Suite du parcours importée depuis'],
  ['Graphe interactif natif attaché à ce pack extrait', 'Graphe interactif d’origine inclus dans ce pack extrait'],
  [' : job XTTS non ajouté', ' : impossible d’ajouter la synthèse vocale XTTS à la file'],
  ['Graphe interactif natif actif pour le round-trip.', 'Graphe interactif d’origine utilisé pour conserver le pack à l’identique lors d’un nouvel export.'],
  ['Graphe interactif natif préservé pour le round-trip.', 'Graphe interactif d’origine conservé pour réexporter le pack sans changer sa structure.'],
  ['Appuie sur le bouton Accueil du message de fin', 'Appuie sur le bouton Accueil pendant le message de fin'],
  ['Auto-next activé. Cliquer pour ouvrir', 'Auto-next activé. Clique pour ouvrir'],
  [/"([01])","stages"/g, '"$1","Écran"'],
  [/"(\d+)","stages"/g, '"$1","Écrans"'],
  [/"([01])","actions"/g, '"$1","liste de choix"'],
  [/"(\d+)","actions"/g, '"$1","listes de choix"'],
  ['"wheel","autoplay","pause","ok","home"', '"Molette","Lecture automatique","Pause","OK","Accueil"'],
  [/Le dossier et les ([01]) élément qu’il contient seront retirés du projet\. Leurs médias resteront/g, 'Le dossier sera retiré du projet avec $1 élément qu’il contient. Les médias resteront'],
  [/Le dossier et les (\d+) éléments qu’il contient seront retirés du projet\. Leurs médias resteront/g, 'Le dossier sera retiré du projet avec les $1 éléments qu’il contient. Les médias resteront'],
  [/Couleurs différentes sur ([01]) éléments — choisir pour uniformiser\./g, '$1 élément sélectionné — choisis une couleur.'],
  [/Couleurs différentes sur (\d+) éléments — choisir pour uniformiser\./g, 'Couleurs différentes sur $1 éléments — choisis-en une pour les uniformiser.'],
  [/dans l’arbre \(([01]) éléments\)/g, 'dans l’arbre ($1 élément)'],
  [/^wheel$/, 'Molette'],
  [/^autoplay$/, 'Lecture automatique'],
  [/^pause$/, 'Pause'],
  [/^ok$/, 'OK'],
  [/^home$/, 'Accueil'],
  [/(graphe natif|Audio [^:"]*|Image [^:"]*|ZIP|Titre audio): /g, '$1 : '],
  [/l’étape "([^"]*)"/g, 'l’étape « $1 »'],
  [/continuation importée "([^"]*)"/g, 'continuation importée « $1 »'],
];
