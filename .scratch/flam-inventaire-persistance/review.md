# Revue du jalon inventaire et reprise

Diff initial : `69f1820...4e3ec3f`. Deux revues indépendantes, en lecture seule.
Les corrections ci-dessous sont suivies de tests au point d’entrée convenu ;
aucune nouvelle revue déléguée n’a été sollicitée pour ces corrections ciblées.

## Standards

Aucune violation documentée. Deux jugements de conception P3 :

- Paramètres de conversion Audio B dupliqués dans le constructeur de pack.
- Validation des règles coffre/clé/porte dans le contrôleur alors que le contenu
  était séparé dans le module de scènes.

Corrections : un seul encodeur stéréo commun ; état initial et validation
regroupés avec les règles de l’aventure. Les parcours restent inchangés.

## Spec

- **P1 — Annulation après écriture incertaine.** Une écriture pouvait réussir,
  puis sa relecture échouer. Annuler conservait l’ancien état affiché, sans
  restaurer la sauvegarde déjà modifiée. Reproduction : recommencer après avoir
  acquis la clé, faire échouer la relecture, annuler ; la nouvelle instance
  retrouvait la partie réinitialisée malgré l’inventaire encore affiché à un.
- **P2 — Narration arrêtée après une seconde acceptée comme terminée.** Le seuil
  réduit à une seconde ne détectait plus une interruption des narrations longues.
- Observation préexistante : un callback d’une ancienne lecture pouvait terminer
  une narration démarrée après retour à la bibliothèque.
- Couverture partielle discutée : les transitions normales n’utilisaient pas les
  narrations de scènes, réservées à la reprise.

Corrections et vérifications :

- L’écriture est réconciliée par relecture : état attendu confirmé, ancien état
  confirmé, ou incertitude explicitement affichée. Une incertitude n’offre pas
  d’annulation trompeuse ; elle impose la relecture avant de reprendre.
- La fin audio dépend de la durée du lecteur, avec tolérance d’une seconde ;
  une seconde sur seize produit maintenant une erreur visible.
- Un identifiant invalide les callbacks périmés. Leur injection après reprise ne
  fait plus avancer la nouvelle narration.
- Une transition vers une scène joue sa narration avant ses choix ; le retour
  depuis l’inventaire n’en redéclenche pas une inutilement.

Les tests de reproduction ont été exécutés en échec puis après correction.
Le harnais Lua complet, les tests Python et les compilations syntaxiques passent.
La sauvegarde matérielle reste à confirmer par l’utilisateur ; le ticket n’est
pas clôturé sur la seule réussite de ces contrôles locaux.
