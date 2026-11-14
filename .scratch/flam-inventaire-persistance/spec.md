Status: ready-for-human

# Valider l’inventaire, les choix conditionnels et la reprise durable sur FLAM

## Problem Statement

L’utilisateur veut créer des aventures personnelles originales pour des enfants d’environ dix ans et les faire jouer hors ligne sur sa FLAM physique. La narration avec Audio B et le retour à un écran de départ actif ont été confirmés sur son firmware 2.4.1. Le prototype ne conserve cependant aucun inventaire ni événement de partie et ne démontre aucune sauvegarde durable.

Une aventure ne peut donc pas encore mémoriser qu’un enfant a récupéré une clé, adapter ses choix à cet objet ou reprendre après extinction sans recréer les récompenses. Il faut valider ces comportements avant de développer leur création visuelle dans Story Studio.

## Solution

Étendre le prototype natif par une courte aventure originale : l’enfant explore un lieu, récupère une clé dans un coffre, consulte son inventaire et utilise la clé pour ouvrir une porte. Il peut revisiter les lieux sans obtenir une deuxième clé. La porte reste ouverte après consommation de la clé, y compris après reprise.

Sans clé, le choix d’ouverture apparaît désactivé avec une explication ; un autre chemin permet toujours de poursuivre l’exploration. Il n’existe ni combat, ni points de vie, ni échec du joueur. Une fin est explicitement identifiée.

Une seule partie est sauvegardée automatiquement pour cette aventure. Une réouverture propose de reprendre ; recommencer exige une action explicite. Après extinction et rallumage, reprendre retrouve la scène, les objets et les événements enregistrés. L’audio repart au début de la scène sans répéter ses effets. Cette conservation doit être démontrée sur la FLAM réelle, hors ligne.

## User Stories

1. En tant qu’enfant, je veux jouer une aventure originale sur ma FLAM sans ordinateur ni téléphone, afin de pouvoir l’emporter avec moi.
2. En tant qu’enfant, je veux écouter une narration intelligible avec le profil audio validé, afin de comprendre la situation et mes possibilités.
3. En tant qu’enfant, je veux sélectionner les actions à la molette et les confirmer par un clic, afin de jouer avec les commandes habituelles de ma FLAM.
4. En tant qu’enfant, je veux reconnaître la scène courante, afin de comprendre ma progression.
5. En tant qu’enfant, je veux découvrir un coffre contenant une clé, afin de trouver un objet utile à mon aventure.
6. En tant qu’enfant, je veux récupérer cette clé par un choix explicite, afin de comprendre que je la possède maintenant.
7. En tant qu’enfant, je veux consulter un inventaire simple, afin de savoir quels objets je détiens.
8. En tant qu’enfant, je veux voir la quantité de chaque objet, afin de savoir ce que je peux utiliser.
9. En tant qu’enfant, je veux revenir de l’inventaire à la scène courante, afin de poursuivre sans perdre ma place.
10. En tant qu’enfant, je veux retrouver le coffre vidé après récupération de la clé, afin que le monde reste cohérent lors d’une revisite.
11. En tant qu’enfant, je veux qu’un clic reçu deux fois ne m’accorde pas deux clés, afin que les commandes ne modifient pas involontairement les règles.
12. En tant qu’enfant, je veux comprendre qu’une porte fermée nécessite une clé, afin de savoir ce qu’il me reste à chercher.
13. En tant qu’enfant, je veux qu’un choix indisponible ne puisse pas être activé, afin de comprendre la relation entre mes objets et mes possibilités.
14. En tant qu’enfant, je veux pouvoir explorer ailleurs sans la clé, afin de ne pas rester bloqué dans une scène.
15. En tant qu’enfant, je veux que le choix d’ouverture devienne accessible lorsque je possède la clé, afin que mes découvertes aient une conséquence visible.
16. En tant qu’enfant, je veux utiliser la clé et constater son retrait de l’inventaire, afin de comprendre qu’un objet peut être consommé.
17. En tant qu’enfant, je veux retrouver la porte ouverte après utilisation de la clé, afin de repasser sans devoir retrouver un objet consommé.
18. En tant qu’enfant, je veux que les quantités ne deviennent jamais négatives, afin que l’inventaire reste compréhensible.
19. En tant qu’enfant, je veux atteindre une fin clairement présentée, afin de reconnaître la conclusion de mon aventure.
20. En tant qu’enfant, je veux quitter pour la bibliothèque puis reprendre ma partie, afin de faire une pause sans perdre mes découvertes.
21. En tant qu’enfant, je veux retrouver un écran de reprise actif en rouvrant l’histoire, afin de ne pas rester prisonnier de la dernière fin affichée.
22. En tant qu’enfant, je veux sauvegarder automatiquement mes choix importants, afin de ne pas gérer une commande de sauvegarde.
23. En tant qu’enfant, je veux retrouver ma clé après extinction lorsque je ne l’ai pas utilisée, afin de conserver ma progression.
24. En tant qu’enfant, je veux retrouver la porte ouverte et la clé consommée après extinction, afin de conserver les conséquences de mes actions.
25. En tant qu’enfant, je veux qu’une récompense obtenue ne réapparaisse pas après redémarrage, afin que mon aventure reste cohérente.
26. En tant qu’enfant, je veux réécouter le début de la scène reprise sans répéter ses effets, afin de me rappeler la situation sans modifier ma partie.
27. En tant qu’enfant, je veux reprendre sans connexion réseau, afin de retrouver mes progrès avec le Wi-Fi désactivé.
28. En tant qu’enfant, je veux une action explicite pour recommencer, afin de ne pas effacer accidentellement ma partie en la rouvrant.
29. En tant qu’enfant, je veux qu’une nouvelle partie rétablisse coffre plein, porte fermée et inventaire vide, afin de pouvoir explorer depuis le début.
30. En tant qu’auteur, je veux représenter objets, conditions et effets séparément, afin de préparer leur future création visuelle.
31. En tant qu’auteur, je veux vérifier que chaque scène de démonstration a un choix accessible ou une fin explicite, afin d’éviter les impasses involontaires.
32. En tant qu’auteur, je veux distinguer logique testée et sauvegarde réellement validée sur FLAM, afin de savoir ce qui fonctionne sur l’appareil cible.
33. En tant que propriétaire de la FLAM, je veux que recommencer ne touche pas aux autres aventures ni à leurs parties, afin de conserver ma bibliothèque.
34. En tant que propriétaire de la FLAM, je veux être informé d’une sauvegarde illisible ou impossible à écrire, afin de ne pas confondre perte de progression et reprise normale.
35. En tant que développeur, je veux rejouer automatiquement l’aventure avec les actions du joueur, afin de détecter les régressions de commandes, d’inventaire et de reprise.

## Implementation Decisions

- Le livrable est un second jalon expérimental du prototype Lua natif. Il n’active pas les écritures FLAM générales dans l’application et n’ajoute pas encore l’interface d’auteur.
- Conserver les acquis matériels : Audio B, une seule piste à la fois, commandes à la molette, pas de chargement pendant une lecture active et pas d’avancement narratif provoqué par un arrêt pendant le chargement.
- Étendre le runtime de l’aventure et son accueil pour distinguer reprendre et recommencer. Le retour bibliothèque laisse un écran actif ; ne pas supposer que la réouverture rappelle le démarrage du script.
- Reprendre conserve scène et état de partie. Recommencer crée explicitement un état initial pour cette aventure seulement. La présentation précise des commandes reste à choisir pendant la réalisation.
- L’état de partie exprime la scène à reprendre, les objets et quantités, les récompenses déjà accordées et les événements durables, notamment la porte ouverte. Objets graphiques, fonctions, callbacks et timers ne sont pas sauvegardés.
- Une récompense unique est identifiée indépendamment des visites et notifications de clic. Acquisition de la clé et marquage du coffre vidé forment une conséquence cohérente.
- Consommation de la clé et ouverture durable de la porte forment également une conséquence cohérente. La clé ouvre le choix initial ; l’événement « porte ouverte » permet ensuite de repasser sans nouvelle consommation.
- Réévaluer les conditions depuis l’état courant ou restauré. Montrer l’ouverture indisponible désactivée avec une explication, sans effet lorsqu’on tente de l’activer. Prévoir un chemin de retour accessible.
- Consulter puis fermer l’inventaire ne modifie ni ses quantités ni la scène de reprise. Le retour système à la bibliothèque est distinct d’un retour narratif vers une scène précédente.
- Enregistrer automatiquement un état cohérent après chaque choix ayant une conséquence durable, avant de présenter celle-ci comme sauvegardée. Un rendu, une réouverture ou une reprise d’audio ne réapplique pas les effets.
- La reprise audio se fait au début de la scène. Une fin peut être reprise comme une fin, avec des actions permettant de recommencer ou sortir ; elle ne doit pas piéger le joueur sur un écran inactif.
- Utiliser un stockage local propre à l’aventure avec une séparation étroite entre runtime et service de persistance de l’hôte. Cet accès au stockage est la seule nouvelle frontière d’environnement nécessaire à la reprise entre deux instances.
- Le mécanisme de sauvegarde du firmware est à prouver. Les API de progression documentées sont une piste, pas une preuve de conservation après extinction. Ne pas figer format ou contrat de sauvegarde de production avant cette validation.
- Une absence de sauvegarde correspond à une première partie. Une sauvegarde illisible, incompatible ou impossible à écrire doit être signalée distinctement ; ne pas prétendre avoir repris ou sauvegardé, ni effacer silencieusement une partie existante. Le mécanisme précis de récupération reste à choisir.
- Conserver l’isolement de l’aventure et les protections du transfert expérimental. Ne pas toucher aux autres histoires ou sauvegardes ni exposer les métadonnées cryptographiques.
- Adapter explicitement construction et liste des fichiers autorisés si le pack ajoute des modules ou ressources. Ne pas désactiver le contrôle du pack pour faciliter l’extension.

## Testing Decisions

- **Point d’entrée confirmé par l’utilisateur :** parcours complet via le harnais Lua existant, puis recréation du runtime avec la sauvegarde conservée. La validation sur FLAM physique est également confirmée comme obligatoire.
- Tester le comportement externe : textes et choix accessibles, quantités affichées, conséquences d’une action, possibilité de continuer, scène et état retrouvés. Ne pas tester noms des fonctions, disposition des tables internes ou nombre d’appels d’écriture.
- Exécuter le vrai runtime et ses vrais traitements d’événements. Simuler seulement les API hôtes d’affichage, audio, commandes et stockage. Ne pas réimplémenter les règles du coffre et de la porte dans le test.
- S’appuyer sur le contrôle Lua existant qui pilote molette et clic, simule l’audio et vérifie la réouverture du même module. Étendre ce même point d’entrée par un stockage conservé entre deux instances réellement distinctes.
- Parcours de référence : porte indisponible sans clé ; retour vers le coffre ; acquisition de quantité un ; inventaire consultable ; revisite sans deuxième récompense ; ouverture avec quantité zéro ; passage par la porte déjà ouverte ; fin explicite.
- Couvrir clic doublé et entrées multiples sur coffre et porte, sans quantités négatives ni duplication d’effet.
- Vérifier distinctement la réouverture du même module depuis la bibliothèque et la création d’une nouvelle instance à partir du stockage. La première seule ne prouve aucune sauvegarde durable.
- Restaurer une instance neuve avant récupération, après récupération, puis après consommation et ouverture. Vérifier les choix et l’inventaire observables, sans accéder aux tables internes pour décider du verdict.
- Vérifier qu’une reprise au début de la scène ou une réécoute ne recrée aucune récompense, ne consomme pas une seconde clé et ne referme pas la porte.
- Vérifier qu’une nouvelle partie réinitialise seulement cette aventure ; une sauvegarde d’une autre aventure servant de témoin reste inchangée.
- Injecter via le même hôte une lecture illisible et un refus d’écriture. Vérifier un résultat visible distinct d’une reprise normale ou d’une sauvegarde réussie, sans perte silencieuse de la dernière partie connue.
- Préserver les régressions existantes : arrêt pendant chargement, arrêt audio prématuré, double notification de clic et retour à un écran actif.
- Réutiliser les tests Python du transfert sur volume synthétique si construction ou installation évoluent. Ils couvrent déjà intégrité, refus de remplacement, préservation des autres histoires et annulation d’un transfert interrompu ; ne pas recréer la logique métier d’aventure en Python.
- **Acceptation matérielle :** écouter Audio B ; récupérer la clé ; consulter l’inventaire ; quitter et reprendre ; éteindre complètement puis rallumer et reprendre ; utiliser la clé ; éteindre puis rallumer et vérifier porte ouverte et clé consommée ; revisiter le coffre ; recommencer explicitement et vérifier l’état initial. Refaire la reprise avec le Wi-Fi désactivé.
- Consigner séparément résultats locaux et matériels, firmware exact, étapes et limites. Si la persistance réelle échoue, la réussite du harnais ne permet pas de terminer le ticket.

## Out of Scope

- Intégration à l’éditeur visuel de production, refonte des graphes ou formats de projet.
- Activation des transferts FLAM de production, gestion générale des mises à jour de packs et migration des sauvegardes entre versions d’aventure.
- Jets de dé et conservation de leurs résultats, classes et possibilités narratives associées : besoins confirmés pour les jalons suivants.
- Combat, points de vie, statistiques, score et échec du joueur, exclus de l’expérience souhaitée.
- Poids, équipement, boutiques ou système général de jeu de rôle.
- Plusieurs parties ou profils d’enfants par aventure, synchronisation entre appareils ou dans le cloud.
- Reprise audio à la seconde exacte, pistes simultanées, animations et mini-jeux.
- Analyse exhaustive des états d’une aventure arbitraire : ce jalon démontre l’absence d’impasse dans son parcours de référence ; l’analyse générale de l’éditeur reste future.
- Déchiffrement, copie ou modification de contenus commerciaux, récupération de clés internes et modification ou mise à jour du firmware.
- Garantie d’atomicité face à une coupure arbitraire pendant une écriture flash : documenter les capacités réelles avant de l’affirmer. Les reprises après des choix confirmés font bien partie du jalon.

## Further Notes

- Implémentation du jalon préparée en TDD ; les contrôles de parcours Lua,
  de transfert Python, de syntaxe et d’intégrité audio passent. La preuve de
  reprise après extinction sur FLAM reste obligatoire avant clôture du ticket.

- Cette spécification synthétise le cadrage validé à Q18 et le prochain jalon annoncé : un objet, un passage conditionnel, puis la conservation après extinction. Sa publication ne lance pas son implémentation.
- Références : [glossaire](../../GLOSSARY.md), [cadrage FLAM](../../docs/flam-custom-stories-design.md) et [guide du prototype](../../scripts/prototypes/flam-native/README.md).
- Audio B et retour à l’écran de départ sont confirmés sur `2.4.1-d5186dc0`. Ni inventaire ni sauvegarde durable ne sont encore prouvés.
- Le premier échec de relance provenait d’une hypothèse fausse du harnais : recréer systématiquement le runtime. Conserver les deux modèles de cycle de vie dans les contrôles.
- Le succès d’Audio B n’attribue pas le silence initial au seul nombre de canaux : en-têtes, table audio et séquencement ont également changé.
- Aucun ADR applicable n’existe. Un ADR ne sera nécessaire que pour un choix durable résultant d’un arbitrage réel ; ne pas transformer la preuve de faisabilité en architecture définitive.
- Dépôt de référence : `Treyarch/story-studio`. Publication dans le tracker Markdown local conformément aux instructions du projet, sans création de ticket GitHub ni message externe.
