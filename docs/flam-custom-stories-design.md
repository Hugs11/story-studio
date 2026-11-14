# Création d’aventures personnelles pour FLAM

Statut : cadrage validé par l’utilisateur à Q18. Lecture du prototype natif avec Audio B et retour à l’écran de départ confirmés sur la FLAM 2.4.1 de l’utilisateur. Aucune architecture de production retenue.

## Objectif confirmé

Créer dans Story Studio ses propres scénarios, dialogues et règles, avec les aventures Donjons & Dragons achetées comme référence pour l’expérience de jeu.

Le public visé est constitué d’enfants d’environ dix ans. L’utilisateur a précisé à Q13 qu’il n’y a ni notion d’échec ni points de vie. Cette précision remplace les exemples et règles antérieurs fondés sur un test réussite/échec ou des soins.

Le critère de réussite est de transférer une création sur la FLAM physique, puis d’y jouer hors ligne sans ordinateur ni téléphone. Ces deux points ont été confirmés par l’utilisateur le 14 novembre 2026 (Q1 et Q2).

Terme retenu : [aventure personnelle](../GLOSSARY.md).

Q3, Q4 et Q5 ont ensuite été confirmées :

- L’expérience cible comprend un état de partie mémorisé, des choix conditionnels, des objets conservés et des jets de dé. Les règles précises restent à définir.
- L’auteur doit pouvoir créer visuellement dans Story Studio et configurer conditions et effets sans écrire du Lua. Du code peut servir aux expérimentations techniques.
- La première étape sera une aventure originale minimale, avec un audio, deux choix et une fin, réellement jouable sur la FLAM physique. Les mécaniques avancées et leur interface viendront après cette preuve de faisabilité.

Ces confirmations ont été reprises dans la validation finale à Q18, suivie du lancement du premier prototype.

Le « oui » suivant de l’utilisateur est retenu comme confirmation des recommandations Q6 à Q8 :

- Première version : classe narrative choisie au départ, inventaire et événements mémorisés. Les classes n’ont pas de statistiques chiffrées ; les quantités d’objets sont conservées (précision Q16).
- Jet de dé : résultat de 1 à 20 déclenché par le joueur sans choisir le résultat. Il sélectionne une péripétie qui permet de poursuivre l’aventure, sans bonus, seuil de réussite ni échec (précision Q15).
- Une seule partie sauvegardée automatiquement par aventure. La reprise conserve la progression, le personnage, les objets et les résultats des jets déjà effectués. Recommencer exige une commande explicite ; un redémarrage ne doit pas permettre de rejouer un jet déjà effectué.

Q9 à Q11 sont confirmées :

- L’inventaire gère des quantités et la consommation d’objets. L’exemple de potion restaurant des points de vie est retiré après Q13 ; la consommation reste applicable aux objets narratifs. La première version n’inclut pas de gestion d’équipement ni de poids.
- Les récompenses sont uniques par partie par défaut, avec répétition possible si l’auteur l’indique explicitement. Une revisite ne remplit pas un coffre déjà vidé.
- La première version reprend au début de la scène en cours, avec les choix, objets et résultats de jets déjà enregistrés conservés. Réécouter l’audio n’applique pas à nouveau les effets déjà accomplis. La reprise à la seconde exacte est différée.

Q12 et Q14 sont confirmées :

- L’auteur peut masquer un choix indisponible ou l’afficher désactivé avec une explication. Par défaut, il est affiché désactivé ; le masquage permet de préserver les secrets.
- Une scène contient un texte, une image facultative et une piste audio à la fois. Les choix se font à la molette. La première version n’inclut pas d’animations ni de mini-jeux.

Q15 à Q17 sont confirmées :

- Le dé sélectionne des suites narratives différentes qui permettent toutes de poursuivre l’aventure. Il n’y a ni bonus ni seuil de réussite dans la première version.
- Les classes ouvrent des possibilités narratives particulières, sans statistiques, combat ni score. Objets, quantités et événements mémorisés restent présents.
- Un chemin conditionnel inaccessible ne doit pas créer d’impasse involontaire. L’enfant doit pouvoir explorer ailleurs ou trouver une autre solution. L’éditeur devra signaler une scène sans choix accessible, sauf si elle est explicitement définie comme une fin.

La sauvegarde et la détection des impasses sont des besoins confirmés ; ni la faisabilité matérielle de la sauvegarde ni la portée de l’analyse des conditions ne sont encore validées. Une garantie exhaustive sur tous les parcours n’est pas démontrée.

## Arbre de décisions

- Résultat : création et jeu hors ligne sur FLAM physique — confirmé.
  - Mécaniques : état mémorisé, choix conditionnels, objets et jets de dé — confirmé.
    - Personnage : classe narrative sans statistiques, inventaire et événements — confirmé.
      - Quantités et consommation des objets, sans équipement ni poids en première version — confirmé.
      - Récompenses uniques par partie par défaut, répétables sur indication explicite de l’auteur — confirmé.
      - Choix indisponibles désactivés avec explication par défaut, masquables par l’auteur — confirmé.
      - Aventures pour enfants d’environ dix ans, sans échec ni points de vie — confirmé.
      - Autre chemin disponible et signalement des scènes bloquantes hors fins explicites — confirmé ; portée technique de l’analyse à valider.
    - Dé à vingt faces déclenché par le joueur ; péripéties sans échec, bonus ni seuil — confirmé.
    - Une sauvegarde automatique par aventure ; conservation des jets déjà effectués — confirmé.
      - Reprise au début de la scène, sans réapplication des effets déjà accomplis — confirmé.
  - Expérience de création : visuelle, sans Lua obligatoire — confirmé.
    - Disposition détaillée et représentation dans l’éditeur — explicitement différées après la validation technique.
    - Texte, image facultative, une piste audio à la fois et choix à la molette ; sans animations ni mini-jeux en première version — confirmé.
  - Ordre de validation : aventure minimale sur appareil avant mécaniques avancées et interface — confirmé.
    - Création d’un contenu Lua natif minimal réellement jouable sur FLAM — lecture avec Audio B et retour à l’écran de départ confirmés par l’utilisateur.
    - Format, transfert et métadonnées de l’appareil — piste documentée, à vérifier sur l’appareil exact.

## Prochain jalon proposé pour validation finale

Le premier prototype est une preuve de lecture Lua native sur la FLAM de l’utilisateur : une courte aventure entièrement originale, avec un audio, deux choix à la molette et une fin qui distingue le choix effectué.

Critères de validation : titre lisible dans la bibliothèque, audio complet, deux branches sélectionnables, fin correcte, retour à la bibliothèque et deux relances, puis lecture hors ligne après extinction. Il ne prétendra pas valider les sauvegardes, l’inventaire ou les dés.

Les expériences suivantes testeront séparément l’état de partie, les effets uniques, les tirages narratifs et la reprise durable. L’intégration à l’éditeur visuel viendra après ces validations. Les choix de format de projet, de runtime, d’interface détaillée et de mise à jour des aventures seront traités à ce moment ; ils ne sont pas implicitement arrêtés par ce cadrage.

Q18 a confirmé ce périmètre et le lancement du premier prototype. Aucun ADR n’est nécessaire avant qu’une décision d’architecture durable ait réellement été prise.

### Résultat de préparation du premier prototype

[Le passage des lucioles](../scripts/prototypes/flam-native/README.md) est une création originale avec une narration française d’environ 16 secondes et deux fins textuelles. Le code expérimental est séparé du transfert de production. Il ne réutilise pas le framework Lua tiers ni les contenus commerciaux.

La FLAM connectée annonce `2.4.1-d5186dc0`. Le pack a été installé avec relecture des fichiers et déchiffrement des scripts vérifié côté hôte. Les fichiers racine des histoires existantes et les métadonnées de l’appareil ont été comparés avant et après et sont inchangés. La liste et le cache ont été sauvegardés localement avant ajout du prototype et invalidation du cache.

Vérifications locales réussies : quatre tests de transfert sur volume synthétique, parcours des deux branches sur hôte Lua factice, syntaxe Lua et Python, intégrité ZIP et décodage audio intégral. Ces contrôles seuls ne démontraient pas la lecture sur le firmware réel ; ils ont été suivis des essais utilisateur décrits ci-dessous.

Premier essai matériel rapporté : clic sonore sans narration et réouverture sur la même fin. Le test Lua initial supposait à tort une nouvelle exécution de `setup()` à la relance ; le test corrigé reproduit maintenant le maintien du même module. La version de diagnostic 2 remet l’écran de départ avant la sortie et attend un clic pour relancer la narration. Elle compare un profil stéréo au MP3 mono original conservé intact et affiche les états audio.

**Retour utilisateur sur la version 2 : « tout fonctionne correctement avec audio B et le retour à l’écran ».** La lecture native et le retour à un départ actif sont donc confirmés sur cet appareil. Le profil B (stéréo avec en-têtes ID3/Xing) reste la référence du prototype. La comparaison ne permet pas d’isoler la cause technique du silence initial. L’inventaire, les dés, la sauvegarde durable et un essai explicitement Wi-Fi désactivé ne sont pas validés par ce retour.

### Deuxième jalon : inventaire et reprise

Le prototype **La clé des lucioles** implémente le coffre à récompense unique,
la quantité de clés, la porte conditionnelle et sa conservation après
consommation. Il dispose d’une identité différente du premier prototype, qui
reste intact. La spécification et le ticket sont conservés dans le suivi local
de la fonctionnalité « flam-inventaire-persistance ».

Le même point d’entrée Lua vérifie le parcours complet, la réouverture du module
et une nouvelle instance avec sauvegarde simulée conservée. Il couvre également
les refus de lecture/écriture, une sauvegarde incompatible, une écriture sans
effet et la confirmation d’un nouveau départ. Les modules de contenu, de rendu
et de stockage restent séparés ; aucun format de production n’est fixé.

La conservation via les API natives de progression est implémentée avec
relecture, mais **la reprise après extinction n’est pas encore prouvée sur
FLAM**. Le [guide du prototype](../scripts/prototypes/flam-native/README.md)
décrit le parcours de validation. Le ticket doit rester ouvert en attente du
résultat matériel, même si les contrôles locaux passent.

## Faits et limites connus

Le support FLAM du dépôt est actuellement en lecture seule : voir [le support existant](flam-support.md). La création d’une aventure jouable sur FLAM n’est pas démontrée par la lecture de sa bibliothèque.

Les fiches officielles D&D annoncent un personnage, des classes influençant les actions possibles, un dé à vingt faces et des récompenses. Elles ne donnent pas les règles internes ni une spécification du format : [Sur les Chemins de Faerûn](https://lunii.com/fr-fr/products/donjons-dragons-faerun), [Dans les bas-fonds d’Eauprofonde](https://lunii.com/fr-fr/products/donjons-et-dragons-dans-les-bas-fonds-deauprofonde).

Le support officiel décrit une reprise de progression et des chemins explorables. Les conditions exactes applicables à une création personnelle restent à vérifier : [fonctionnement des livres audio FLAM](https://support.lunii.com/hc/fr/articles/14116576815773-Comment-fonctionnent-les-livres-audio-FLAM).

La recherche de récupération des histoires existantes reste une piste d’étude, dont la nécessité pour créer de nouvelles aventures n’est pas encore établie : [note de recherche](flam-recovery-research.md).

### Piste native pour les créations originales

Une voie communautaire documentée permet de produire des aventures Lua natives originales à partir des métadonnées du propre appareil, sans déchiffrer une histoire commerciale ni récupérer la clé interne de la puce. Des auteurs rapportent des lectures réussies sur firmware stock 2.4.2 : [expériences matérielles](https://github.com/o-daneel/Flam.RE/issues/1), [recette figée au commit 2fb9033](https://github.com/Yariminal/flam-re/blob/2fb9033fb6566c010f6b34858242276dec2db7e8/docs/fw2-key-wrap.md).

Ces résultats rapportés ont servi de piste. La lecture de notre création native sur la FLAM 2.4.1 est maintenant confirmée par le retour utilisateur sur la version 2. Le déchiffrement des histoires achetées n’a pas été nécessaire pour réaliser cette création originale.

Le format Lua natif (`main.lsf`, modules, ressources) est distinct du format à index (`ni/li/ri/si`). Un essai à index ne suffira pas à valider le moteur nécessaire aux mécaniques envisagées.

Le premier essai proposé reste une création originale avec UUID neuf, un court audio, deux choix et une fin. Il devra vérifier les deux branches, le retour à la bibliothèque, deux relances, puis une lecture hors ligne après extinction. Sauvegarde et hasard feront l’objet d’essais séparés après cette validation.

Les exemples publics montrent un inventaire de session et un appel à `math.random`, sans démontrer la conservation de l’inventaire ni la stabilité des résultats après extinction. Les auteurs signalent aussi des difficultés de relance après certaines écritures d’état : [limites du runtime](https://github.com/scarlaty/flam-player/blob/71385ff7812987e54fe843cd62c952d1246afd89/skills/flam-homebrew/references/device-pitfalls.md). Les souhaits de Q6 à Q8 sont confirmés, mais leur faisabilité matérielle reste à valider.

Avant toute réutilisation du code des exemples, il faudra examiner sa licence, figer les révisions et limiter les dépendances nécessaires. Aucun choix de runtime ni de recette de transfert n’est encore adopté.

## Décisions d’architecture

Aucune à ce stade. Un ADR sera rédigé lorsqu’un choix durable résultera d’un arbitrage explicite.
