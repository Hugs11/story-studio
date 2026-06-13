# Rapport tache 14 - Microcopies et parcours reel sur la Lunii

## Decision UX retenue

- `Pendant la lecture` devient **Pendant l'histoire**.
- `Apres la lecture` devient **A la fin de l'histoire**, selon l'amendement valide.
- Le resume de fin devient **Parcours reel sur la Lunii** pour affirmer qu'il montre le comportement genere, pas seulement la configuration brute.
- Le multi-editeur est aligne sur le nouveau vocabulaire, sans ajouter le resume complet pour garder l'ecran de modification groupée leger.

## Changements effectues

- Renommage des titres dans l'editeur d'histoire :
  - `Pendant l'histoire`
  - `A la fin de l'histoire`
- Deplacement du parcours reel plus haut dans la section de fin, avant les reglages de destination et les options avancees.
- Mise en avant visuelle du parcours :
  - titre explicite ;
  - chips plus lisibles ;
  - fleche plus visible ;
  - mention courte uniquement quand les chips ne suffisent pas, par exemple `Auto-next active`.
- Conservation de la source de verite existante : le resume continue d'utiliser `getEffectiveEndBehavior()` depuis `generatedNavigation.js`.
- Harmonisation des microcopies du multi-editeur pour eviter l'ancien couple `Pendant/Apres la lecture`.

## Fichiers modifies

- `src/components/CentralPanel/story/DuringPlaySection.jsx`
- `src/components/CentralPanel/story/AfterPlaySection.jsx`
- `src/components/CentralPanel/CentralPanel.css`
- `src/components/CentralPanel/MultiEditor.jsx`
- `src/components/CentralPanel/StoryEditor.jsx`

## Verification

- `npm run build` : OK.
- `node --test scripts/generatedNavigation.test.mjs scripts/treeNavigationBadges.test.mjs` : OK, 63 tests passes.
- Recherche de relecture : plus d'ancien texte visible `Pendant la lecture`, `Apres la lecture`, ni `Resume du parcours` dans `src/components` et `src/styles`.

## Note

La logique de navigation n'a pas ete modifiee. La tache reste une evolution de microcopies et de hierarchie visuelle autour des sorties deja produites par le resolveur.
