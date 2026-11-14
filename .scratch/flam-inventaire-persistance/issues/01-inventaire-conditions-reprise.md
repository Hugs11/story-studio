Status: ready-for-human
Type: task

# Valider l’inventaire, les choix conditionnels et la reprise durable sur FLAM

## Spécification

Réaliser le prochain jalon expérimental décrit dans la [spécification complète](../spec.md).

Le point d’entrée de test est confirmé par l’utilisateur : aventure complète dans
le harnais Lua existant, reprise du même module puis recréation à partir d’une
sauvegarde conservée. La preuve sur la FLAM physique reste obligatoire.

## Résultat attendu

- Récupérer une clé, consulter sa quantité et l’utiliser pour ouvrir une porte.
- Ne pas redonner la récompense ; conserver la porte ouverte après consommation ;
  ne pas introduire d’impasse involontaire.
- Sauvegarder automatiquement une partie ; distinguer reprendre et recommencer.
- Retrouver inventaire, scène et événements après extinction et rallumage réels,
  hors ligne et sans répétition des effets.
- Conserver narration Audio B, commandes, retour à un écran actif, autres histoires
  et leurs sauvegardes.

## Critère de clôture

Consigner les résultats locaux et matériels séparément. Aucun verdict local ne
remplace la confirmation de persistance sur appareil. Documenter un blocage de
sauvegarde matérielle sans le masquer par une simple conservation en mémoire.

## Comments

- Implémentation locale prête : inventaire, coffre unique, porte conservée après
  consommation et accueil reprendre/recommencer. Le pack possède une nouvelle
  identité et conserve le premier prototype fonctionnel.
- Validation locale : parcours complet au harnais Lua, nouvelles instances avec
  sauvegarde conservée, erreurs de stockage et régressions audio ; quatre tests
  Python du transfert ; syntaxe Lua/Python ; quatre narrations stéréo décodées.
- Suite JavaScript complète : 8 714 tests réussis sur 8 715. Le test existant
  « refus traversent les vrais lifecycle et runFunnelLanding » échoue aussi
  isolément, sur des appels supplémentaires de journalisation. Aucun fichier
  JavaScript de cette suite n’est modifié par le jalon.
- En attente de la validation humaine : parcourir l’aventure, conserver la clé
  après extinction, la consommer, vérifier la porte ouverte après une nouvelle
  extinction et recommencer explicitement. Aucune clôture sur la seule relecture
  de sauvegarde dans le runtime simulé.

- Implémentation prise en charge : TDD au point d’entrée de l’aventure complète,
  revue Standards/Spec et commit sur la branche courante. La clôture reste
  conditionnée par la validation de la sauvegarde sur l’appareil.

- Synthèse de la conversation et du cadrage validé, sans nouvel entretien produit.
- Points de test confirmés lors de la rédaction.
- Publication dans le tracker local, sans création de ticket GitHub.
