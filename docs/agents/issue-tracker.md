# Suivi des tickets : Markdown local

Les spécifications et tickets sont conservés dans `.scratch/`.
Le dépôt GitHub de référence est `Treyarch/story-studio`.
La publication sur GitHub se fait sur demande explicite.

## Conventions

- Un dossier par fonctionnalité : `.scratch/<feature>/`.
- Spécification : `.scratch/<feature>/spec.md`.
- Un fichier par ticket : `.scratch/<feature>/issues/<NN>-<slug>.md`,
  numéroté à partir de `01`.
- État de triage : ligne `Status:` en début de ticket, selon
  `docs/agents/triage-labels.md`.
- Commentaires et échanges : ajoutés en fin de fichier sous
  `## Comments`.

## Publier dans le suivi des tickets

Créer le fichier Markdown approprié sous `.scratch/<feature>/`,
en créant les dossiers nécessaires.

## Consulter un ticket

Lire le fichier indiqué. Si seul un numéro est fourni, le résoudre
dans le dossier de la fonctionnalité concernée.

## Opérations de wayfinder

- Carte : `.scratch/<effort>/map.md`, avec les sections Notes,
  Decisions-so-far et Fog.
- Tickets enfants : `.scratch/<effort>/issues/NN-<slug>.md`.
- Type : ligne `Type:` avec `research`, `prototype`, `grilling`
  ou `task`.
- Pour ce workflow, `Status:` indique `claimed` ou `resolved`
  lors de la prise en charge ou de la résolution.
- Dépendances : ligne `Blocked by: NN, NN`. Un ticket est débloqué
  quand tous les tickets référencés sont `resolved`.
- Prochain ticket : premier par numéro parmi les tickets ouverts,
  débloqués et non pris en charge.
- Prise en charge : enregistrer `Status: claimed` avant de travailler.
- Résolution : ajouter la réponse sous `## Answer`, enregistrer
  `Status: resolved`, puis ajouter un résumé et un lien dans
  Decisions-so-far de la carte.
