# Importer la bibliothèque FLAM vers la bibliothèque locale

## Problem Statement

Les utilisateurs peuvent consulter les histoires d’un FLAM connecté, mais ne peuvent pas en conserver une copie dans leur bibliothèque locale. Ils souhaitent préserver ce contenu sur leur ordinateur et consulter son inventaire après déconnexion, sans modifier les fichiers de l’appareil.

## Solution

Permettre de copier une sélection d’histoires ou toute la bibliothèque FLAM dans l’espace de travail configuré. Conserver chaque dossier et ses fichiers d’origine inchangés, avec un fichier de métadonnées placé à côté. Les copies restent identifiables et consultables après déconnexion et après un nouveau scan. Cette première version permet la conservation et la consultation des titres et métadonnées, sans lecture ni édition.

## User Stories

1. En tant qu’utilisateur, je veux importer une histoire sélectionnée pour en conserver une copie locale.
2. En tant qu’utilisateur, je veux importer plusieurs histoires sélectionnées pour choisir le contenu à conserver.
3. En tant qu’utilisateur, je veux une action « Copier tout » pour conserver toute la bibliothèque FLAM.
4. En tant qu’utilisateur, je veux inclure les histoires masquées dans la copie complète pour ne pas les oublier.
5. En tant qu’utilisateur, je veux reconnaître les histoires masquées dans la sélection pour comprendre ce que je copie.
6. En tant qu’utilisateur, je veux retrouver les copies dans ma bibliothèque locale pour consulter mon contenu au même endroit.
7. En tant qu’utilisateur, je veux consulter mes copies après déconnexion du FLAM pour ne plus dépendre de sa présence.
8. En tant qu’utilisateur, je veux conserver les dossiers d’origine pour éviter un archivage ZIP non souhaité.
9. En tant qu’utilisateur, je veux conserver tous les fichiers de chaque histoire, y compris key, pour disposer d’une copie complète.
10. En tant qu’utilisateur, je veux préserver le titre disponible pour reconnaître mes histoires.
11. En tant qu’utilisateur, je veux préserver l’UUID pour conserver l’identité d’origine.
12. En tant qu’utilisateur, je veux préserver le statut masqué d’origine pour retrouver cette information localement.
13. En tant qu’utilisateur, je veux que les métadonnées ajoutées restent à côté du dossier pour ne pas modifier ses fichiers.
14. En tant qu’utilisateur, je veux retrouver les copies et leurs métadonnées après un nouveau scan pour ne pas dépendre du catalogue en mémoire.
15. En tant qu’utilisateur, je veux identifier clairement les copies FLAM pour comprendre leur nature.
16. En tant qu’utilisateur, je veux voir que la lecture et l’édition sont indisponibles pour connaître les possibilités réelles de cette version.
17. En tant qu’utilisateur, je veux que l’import laisse le FLAM inchangé pour continuer à l’utiliser normalement.
18. En tant qu’utilisateur, je veux que mes copies restent indépendantes des changements ultérieurs sur FLAM pour maîtriser leur conservation.
19. En tant qu’utilisateur, je veux ignorer les UUID FLAM déjà importés pour éviter les doublons et les écrasements.
20. En tant qu’utilisateur de plusieurs FLAM, je veux reconnaître un UUID déjà importé depuis un autre appareil pour éviter une copie répétée.
21. En tant qu’utilisateur, je veux conserver deux histoires de titres identiques et d’UUID différents pour ne perdre aucun contenu.
22. En tant qu’utilisateur, je veux qu’une autre version ayant le même UUID soit signalée comme déjà présente pour éviter une mise à jour implicite.
23. En tant qu’utilisateur, je veux annuler l’import pour interrompre l’opération lorsque nécessaire.
24. En tant qu’utilisateur, je veux conserver les imports terminés après annulation pour ne pas recommencer inutilement.
25. En tant qu’utilisateur, je veux que les copies partielles restent absentes du catalogue pour ne pas les confondre avec des copies terminées.
26. En tant qu’utilisateur, je veux poursuivre le lot après un échec isolé pour récupérer les autres histoires.
27. En tant qu’utilisateur, je veux que la déconnexion arrête le lot et indique les histoires non traitées pour savoir ce qu’il reste à copier.
28. En tant qu’utilisateur, je veux un bilan des réussites, doublons ignorés, échecs et histoires non traitées pour comprendre le résultat.
29. En tant qu’utilisateur, je veux relancer un import interrompu en ignorant les copies terminées pour achever la copie sans écrasement.

## Implementation Decisions

- Réutiliser l’inventaire FLAM existant pour la sélection et la copie complète, histoires masquées comprises. Le cache fournit uniquement les titres disponibles ; il ne définit pas la liste des histoires.
- Copier les dossiers natifs Lua et à index reconnus par l’inventaire, avec tous leurs fichiers ordinaires et leur arborescence interne. Ne pas déchiffrer, convertir, renommer les fichiers internes ou créer une archive.
- Conserver les copies dans l’espace de travail local configuré. Placer le fichier de métadonnées à côté de chaque dossier, jamais dans celui-ci. Préserver l’UUID, le titre disponible et le statut masqué d’origine.
- Identifier et versionner les métadonnées pour permettre leur reconnaissance au scan. Leur nom et leur représentation exacte relèvent de l’implémentation.
- Adapter l’analyse, la persistance et la présentation du catalogue pour reconnaître les copies FLAM et retrouver leurs métadonnées après un nouveau scan. Ne pas les présenter comme des projets éditables ou jouables.
- Détecter les doublons parmi les copies FLAM par UUID, indépendamment de l’appareil, du titre et de la version. Ne pas confondre cette identité avec celle d’un projet ou d’un autre format. Ignorer les copies déjà présentes et les signaler sans écrasement.
- Préserver tout contenu local existant en cas de collision de destination.
- Adapter le chemin d’acquisition et la file d’opérations existants avec un import brut propre à FLAM. Ne pas rediriger FLAM vers la reconstruction du format Lunii.
- Distinguer l’import par lecture de l’interdiction d’écriture sur l’appareil. Conserver les refus de transfert vers FLAM, suppression, renommage, réorganisation, masquage et réparation.
- Préparer les fichiers dans une zone temporaire locale. Ne rendre l’histoire disponible qu’une fois le dossier et ses métadonnées prêts ; les scans et observateurs doivent ignorer les états intermédiaires.
- Réutiliser les mécanismes de publication sans écrasement et de déclaration des écritures au catalogue, en tenant compte des différences entre fichiers et dossiers.
- Réutiliser les protections existantes contre les liens symboliques, points de réanalyse et sorties de racine. Un chemin non sûr ou une copie incomplète produit un échec sans publication partielle.
- Permettre l’annulation pendant la copie ; conserver les histoires terminées et écarter la copie partielle courante.
- Poursuivre après un échec isolé tant que FLAM reste connecté. Arrêter le lot après déconnexion et signaler les histoires non traitées.
- Produire un bilan distinguant réussites, doublons ignorés, échecs et histoires non traitées. Une relance reprend au niveau des histoires, sans reprise au milieu d’un fichier.
- Mettre à jour les actions et textes du panneau FLAM pour annoncer l’import disponible, via les mécanismes de traduction existants.
- Ne pas lire ni copier les secrets des métadonnées globales de l’appareil pour cet import. Le fichier key de chaque histoire est conservé dans sa copie, sans exposer son contenu dans les messages ou journaux.

## Testing Decisions

Périmètre proposé à l’utilisateur ; confirmation des points de test en attente.

- Privilégier un point d’entrée principal au niveau de l’acquisition : importer depuis un FLAM synthétique vers un espace de travail temporaire, puis observer les fichiers et le catalogue via les interfaces existantes. Tester les comportements externes plutôt que les fonctions internes ou la forme des appels.
- Prendre pour précédents les tests d’acquisition existants, qui vérifient déjà le catalogue, la préservation de l’appareil, les déconnexions et l’absence de résidus après annulation.
- Réutiliser les fixtures FLAM pour les deux formats d’histoires, les entrées visibles et masquées, les titres optionnels et les inventaires incomplets. Aucun secret réel ni appareil physique n’est nécessaire.
- Comparer les octets et l’arborescence source avant et après import, puis ceux des fichiers copiés, y compris key et les ressources non interprétées. Vérifier l’absence de ZIP et la présence des métadonnées hors du dossier.
- Vérifier qu’un nouveau scan après déconnexion retrouve la copie et ses métadonnées sans dépendre de l’état en mémoire de l’import.
- Couvrir les doublons entre appareils, une version différente au même UUID, les titres identiques avec UUID différents et les collisions sans écrasement.
- Couvrir l’annulation, la déconnexion pendant copie, la conservation des imports terminés, l’absence de copie partielle consultable et la relance.
- Couvrir la poursuite après un échec isolé et le classement de chaque histoire dans le bilan.
- Compléter uniquement avec les tests existants du panneau et de la file d’opérations pour la sélection, « Copier tout », les histoires masquées, l’annulation, le bilan et les refus d’écriture maintenus.
- Réutiliser les possibilités existantes d’injection d’échecs. Si un point supplémentaire est nécessaire, le placer à la frontière des entrées/sorties plutôt que rendre publics des détails internes.

## Out of Scope

- Lecture audio et exécution des scénarios FLAM.
- Édition, conversion et déchiffrement des histoires.
- Recherche de clés, accès au compte Lunii et appels au service officiel.
- Transfert, restauration ou modification de contenu sur FLAM.
- Synchronisation automatique, remplacement d’une copie existante et gestion de plusieurs versions du même UUID.
- ZIP ou autre modification du conditionnement d’origine.
- Copie complète de l’appareil, de ses métadonnées globales, des parties ou de dossiers hors des histoires listées.
- Garantie de portabilité ou de restauration sur un autre appareil.

## Further Notes

Le comportement fonctionnel a été confirmé à l’issue de l’entretien. La conservation brute n’implique aucune capacité de lecture, d’édition ou de restauration.

Employer les termes « bibliothèque FLAM », « bibliothèque locale » et « import depuis FLAM » du glossaire. Aucune ADR existante ne contraint cette zone ; aucune nouvelle ADR n’est nécessaire pour ces choix réversibles.

Le suivi du projet est local en Markdown. Aucune publication GitHub ni implémentation du produit n’est incluse dans cette étape. Publier le ticket avec Status: ready-for-agent après confirmation du périmètre de test demandé par le skill to-spec.
