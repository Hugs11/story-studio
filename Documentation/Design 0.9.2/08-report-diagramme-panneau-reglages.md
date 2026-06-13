# Rapport tache 08 - Diagramme et panneau de reglages

## Decision UX retenue

La proposition initiale de split-view n'a pas ete appliquee.

Apres analyse et discussion, le comportement actuel est conserve :

- le panneau reste en overlay ;
- l'utilisateur peut pan, zoomer et recadrer rapidement le diagramme a la souris ;
- la largeur du panneau reste redimensionnable via les poignees existantes ;
- l'app conserve deja cette largeur en memoire.

Le split-view aurait retire le masquage, mais au prix d'un canvas plus etroit. A 1280 px, un panneau lateral force le diagramme vers les modes compact/minimal, ce qui degrade la lecture et ajoute des sauts de camera potentiels avec l'ouverture auto.

## Changements effectues

- Correction du header du panneau de reglages.
- Le titre affiche maintenant le nom reel du noeud.
- Le sous-titre affiche le type du noeud seulement s'il apporte une information distincte :
  - `Histoire`
  - `Dossier`
  - `Archive ZIP`
  - `Message de fin`
  - `Pack`
- Si le titre et le type sont identiques, le sous-titre disparait pour eviter le doublon.
- Pour le message de fin, le titre reprend le nom configure du projet quand il existe.

## Fichier modifie

- `src/components/CentralPanel/FlowDiagram.jsx`

## Verification

- `npm run build` : OK.

## Note

Aucun changement de layout, de largeur de panneau, de zoom, de pan, de focus branche, d'affichage des retours, de DnD ou de logique de diagramme n'a ete effectue.
