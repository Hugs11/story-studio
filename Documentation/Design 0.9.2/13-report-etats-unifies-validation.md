# Rapport tache 13 - Etats unifies de validation

## Decision UX retenue

- Une seule categorie visible dans l'UI : **A corriger**.
- Pas de separation entre "bloquant" et "a completer" : dans l'etat actuel de l'app, les warnings comme les errors empechent la generation.
- Le clic sur une issue conserve le comportement existant : selection du noeud concerne dans l'editeur.
- Les dots de validation dans l'arbre ont ete supprimes pour eviter un second systeme de signalement concurrent. Les badges de navigation restent inchanges.

## Changements effectues

- `ValidationPill` unifie les etats `error` et `warning` en un seul etat visuel `issues`.
- La pastille affiche maintenant :
  - `Pack pret` quand aucune issue bloquante/warning n'existe ;
  - `N a corriger` quand la generation est impossible ;
  - `Verification...` pendant l'audit des fichiers.
- Le popover n'affiche plus de section "A completer" ni de tri par severite.
- Les messages de validation JS ont ete reformules en actions plus directes :
  - `Audio d'accueil a ajouter`
  - `Audio de selection a ajouter`
  - `Histoire a ajouter`
  - `Fichier ... introuvable`
- Les dots de statut de validation ont ete retires de l'arbre et les helpers associes ont ete supprimes.
- Le raccourci clavier lie a la pastille parle maintenant des "elements a corriger".
- Les tests de wording et les fixtures de validation ont ete alignes avec les nouveaux messages.

## Fichiers principaux modifies

- `src/components/layout/ValidationPill.jsx`
- `src/components/layout/ValidationPill.css`
- `src/components/TreePanel/TreePanel.jsx`
- `src/components/TreePanel/TreeNode.jsx`
- `src/components/common/Badge.jsx`
- `src/components/common/Badge.css`
- `src/store/validationMessages.js`
- `src/store/projectValidation.js`
- `src/store/keyboardShortcuts.js`
- `scripts/validationMessages.test.mjs`
- `scripts/projectValidation.test.mjs`
- `scripts/fixtures/validation-projects.json`

## Verification

- `node --test scripts/*.test.mjs` : OK, 202 tests passes.
- `npm run build` : OK.
- Relecture mecanique : plus de `StatusDot`, `status-dot`, ni d'anciens textes visibles `Tout est en ordre`, `a completer`, `Ouvrir la validation`.

## Note

Les messages Rust de validation restent proches mais pas totalement identiques aux messages JS historiques dans les fixtures de parite. Cette tache a limite les changements au wording visible cote React et aux attentes JS, sans toucher au moteur Rust.
